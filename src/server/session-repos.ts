/**
 * Session ↔ repo derivations: which repos a session spans, the per-run
 * system-prompt notes built from that (branch discipline, multi-repo map,
 * memory), PR-target resolution, and the attach/switch-primary repo
 * operations behind the RepoBar + opensession-repos tools.
 */

import {
	createWorktree,
	canonicalPath,
	getRepo,
	listWorktrees,
	prepareAttachedWorktree,
	repoForPath,
	REPOS,
	sharedCheckoutForNewSessions,
	worktreeHasWork,
} from "./worktree";
import { hasRemoteWorkspace } from "./sandbox";
import {
	findWorkspaceByWorktree,
	getWorkspace,
	restampWorkspaceWorktree,
	type Workspace,
} from "./workspaces";
import { sessionPrBranch } from "./session-pr-target";
import {
	renderSessionMemoryNote,
	sessionMemoryScopes,
} from "./session-memory";
import { DESK_NOTE } from "./desk";
import { personalPromptNoteFor } from "./personal-prompts";
import {
	findSession,
	getCachedSessions,
	touchNativeSession,
} from "./session-cache";
import type { AttachedRepo, LinkedPr, StackedOn, UnifiedSession } from "./types";
import { defaultRepo } from "./config";

export interface SessionRepoContext {
	repo: string;
	dir: string;
	branch?: string;
	primary: boolean;
}

type SessionRepoCarrier = Pick<
	UnifiedSession,
	"repo" | "worktreeDir" | "branch" | "attachedRepos" | "mode"
>;

/**
 * Resolve a repo worktree carried by a session.
 *
 * Child sessions and workflow agents used to inherit only `worktreeDir`, which
 * is the primary repo. That made an attached-repo review start in the primary
 * checkout and then hit ask-mode's external-directory deny when its prompt
 * referenced the attached worktree. An explicit repo wins; otherwise a prompt
 * that names exactly one carried worktree selects it; ambiguous/no hint keeps
 * the primary for backwards compatibility.
 */
export function resolveSessionRepoContext(
	session: SessionRepoCarrier,
	repoId?: string,
	hint?: string,
): SessionRepoContext | null {
	const primaryRepo =
		session.repo ||
		(session.worktreeDir && session.mode !== "scratch"
			? repoForPath(session.worktreeDir).id
			: defaultRepo().id);
	const contexts: SessionRepoContext[] = [
		...(session.worktreeDir
			? [{
					repo: primaryRepo,
					dir: session.worktreeDir,
					...(session.branch ? { branch: session.branch } : {}),
					primary: true,
				}]
			: []),
		...(session.attachedRepos || []).map((attached) => ({
			repo: attached.repo,
			dir: attached.dir,
			branch: attached.branch,
			primary: false,
		})),
	];

	if (repoId) return contexts.find((context) => context.repo === repoId) || null;

	if (hint) {
		const mentioned = contexts.filter(
			(context) =>
				hint.includes(context.dir) ||
				hint.includes(`@${context.repo}:`),
		);
		if (mentioned.length === 1) return mentioned[0];
	}

	return contexts.find((context) => context.primary) || null;
}

/**
 * Branch discipline for interactive code sessions in isolated worktrees. Sessions
 * in one workspace share a single worktree + branch, so each agent must treat
 * that branch as THE branch — sibling commits included. Without this, each
 * sibling session decided the extra commits on the shared branch weren't its own
 * and cherry-picked onto a fresh branch, producing one PR per session instead of
 * one per workspace (tella-fusion PRs #4529–#4531).
 */
export function buildBranchNote(session: {
	mode?: "ask" | "code" | "scratch";
	branch?: string | null;
	worktreeDir?: string | null;
}): string | undefined {
	if (session.mode === "ask" || !session.branch || !session.worktreeDir)
		return undefined;
	const repo = repoForPath(session.worktreeDir);
	// Shared-checkout repos (opensession) and main-checkout cwds have their own
	// rules; this note is for isolated per-branch worktrees only.
	if (
		sharedCheckoutForNewSessions(repo) ||
		canonicalPath(session.worktreeDir) === canonicalPath(repo.repo)
	)
		return undefined;
	return [
		"## Branch discipline (shared worktree)",
		`You are working in \`${session.worktreeDir}\` on branch \`${session.branch}\`. Other sessions in this workspace share this exact worktree and branch — commits you don't recognize are their work, not noise.`,
		`Stay on \`${session.branch}\`: never create or switch branches, and never rebase away, reset, or cherry-pick around sibling commits. Commit your changes on this branch and push with \`git push origin ${session.branch}\`.`,
		`This workspace keeps ONE pull request: if an open PR for \`${session.branch}\` already exists, pushing updates it — do not open another. Only run \`gh pr create\` when the branch has no open PR. Never merge.`,
		"Only deviate from this (separate branch or separate PR) when the user explicitly asks for it.",
	].join("\n");
}

/**
 * System-prompt note for a session whose worktree was branched off ANOTHER session's
 * branch rather than the trunk (the "stacked worktree" session mode). Its diff is
 * only reviewable against that branch, so its PR must target it — and GitHub's
 * stacked PRs (public preview, 2026-07-30) then give the pair a real stack:
 * each layer reviewed on its own diff, lower layers rebased automatically as
 * they merge. See pr-stack.ts for the read/link surface behind the UI.
 */
export function buildStackNote(session: {
	mode?: "ask" | "code" | "scratch";
	branch?: string | null;
	stackedOn?: StackedOn;
}): string | undefined {
	const base = session.stackedOn?.branch;
	if (!base || session.mode !== "code" || !session.branch) return undefined;
	return [
		"## Stacked branch",
		`This branch was cut from \`${base}\` (another session's branch), not from the trunk — its commits sit ON TOP of that work, and a diff against the trunk would show both.`,
		`Open your PR against that branch: \`gh pr create --base ${base}\`. Never retarget it at the default branch, and never merge \`${base}\` into this branch to "catch up" — it moves under you as its own PR updates.`,
		`Once both PRs exist, register them as a GitHub stack so each is reviewed on its own diff and the bases rebase themselves as layers merge: \`gh stack link <base-PR-url> <your-PR-url>\` (bottom first, run from this worktree). If that reports \`unknown command "stack"\`, don't retry or try to install it — just say so; the PR's base is what matters, and the Stack card in the PR tab links it in one click.`,
		"Never merge either PR — the human merges the stack.",
	].join("\n");
}

/**
 * System-prompt note describing a session's repos when it spans more than one.
 * Lists the primary worktree + every attached repo with its path/branch and how
 * `@<project>:path` mentions resolve. Returns undefined for single-repo sessions
 * so the prompt stays clean.
 */
export function buildReposNote(session: UnifiedSession): string | undefined {
	const branchNote = [buildBranchNote(session), buildStackNote(session)]
		.filter(Boolean)
		.join("\n\n");
	const attached = session.attachedRepos || [];
	if (!attached.length) return branchNote || undefined;
	const primaryRepo =
		session.repo ||
		(session.worktreeDir && session.mode !== "scratch"
			? repoForPath(session.worktreeDir).id
			: defaultRepo().id);
	const lines = [
		"## Repos in this session",
		"This session spans multiple repos. Each is an isolated git worktree — `cd` into the right one to read or edit its files, and commit/push/open PRs in each repo independently (don't edit another repo's shared main checkout).",
		// Canonicalized for the note only — the stored worktreeDir stays literal
		// (see canonicalPath) — so a session that predates a checkout rename
		// points the agent at the path that exists today.
		`- **${primaryRepo}** (primary): ${canonicalPath(session.worktreeDir!)}${session.branch ? ` — branch \`${session.branch}\`` : ""}`,
	];
	for (const r of attached)
		lines.push(`- **${r.repo}**: ${r.dir} — branch \`${r.branch}\``);
	lines.push(
		"A file mentioned from an attached repo arrives as `@<project>:<path>` — resolve it under that repo's worktree dir above.",
	);
	return [branchNote, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Repo ids a session spans, primary first — memory scopes + repos note agree on this. */
export function sessionRepoIds(session: UnifiedSession): string[] {
	const primary =
		session.repo ||
		(session.worktreeDir && session.mode !== "scratch"
			? repoForPath(session.worktreeDir).id
			: defaultRepo().id);
	return [primary, ...(session.attachedRepos || []).map((r) => r.repo)];
}

/**
 * Plan-first gate + vertical-slice discipline for code sessions created with
 * the "Plan first" toggle. Purely instruction-layer: the approval ride's the
 * existing ask_user pause (AskCard in the UI, Slack escalation after 4 min),
 * so a plan gets a human yes/no at the cheapest moment to change course —
 * before the code exists — and implementation lands as reviewable slices.
 */
export function buildPlanFirstNote(session: {
	mode?: "ask" | "code" | "scratch";
	planFirst?: boolean;
}): string | undefined {
	if (!session.planFirst || session.mode === "ask") return undefined;
	return [
		"## Plan first (design gate)",
		"This session has the plan-first gate ON. Before creating, editing, or committing ANY file, post a short program-design doc as a normal message:",
		"- **Scope** — one paragraph: what's being built, and what's explicitly out of scope.",
		"- **File-tree diff** — files to add/change/delete, one line each.",
		"- **Key signatures** — the new/changed types and function signatures that matter.",
		"- **Call-stack sketch** — for control-flow changes, the call tree (use diff syntax when altering an existing flow).",
		"- **Slices** — number the work as vertical slices, each independently runnable and demoable (e.g. API-with-mock-data → UI against it → real wiring → persistence). Never horizontal layers (all migrations, then all services, then all UI).",
		"Then call `ask_user` with exactly one question — \"Approve this plan?\" with options Approve and Revise — and wait. On Revise, update the plan per the notes and ask again. If the question times out or is dismissed, end the turn with the plan posted; do NOT start implementing.",
		"",
		"After an explicit Approve, implement slice by slice:",
		"- Finish a slice completely (code + verify) before touching the next.",
		"- After each slice, post brief evidence it works: test/build output, a curl transcript, or a screenshot — whatever proves that slice does its job.",
		"- Commit per slice with a clear message; keep each slice's diff small enough to review in minutes.",
		"- If implementation reveals the plan was wrong, stop, post the plan delta, and `ask_user` again before continuing.",
		"",
		"If a plan was already approved earlier in this conversation, don't re-plan — continue the slice work. Re-run the gate only when the user asks for new work that changes scope. Trivial follow-ups (typo fixes, review feedback on landed slices) skip the gate.",
	].join("\n");
}

/**
 * The full per-session system-prompt note for an interactive run: repos/branch
 * discipline (buildReposNote) + the session's repo/user/team memory. Memory
 * failures never block a run — the note just goes out without it.
 */
export async function buildSessionNote(
	session: UnifiedSession,
	user?: string,
): Promise<string | undefined> {
	return (
		[
			// The standing Desk session gets its concierge charter first — role
			// discipline for the summonable overlay (see desk.ts).
			session.desk ? DESK_NOTE : "",
			buildPlanFirstNote(session),
			buildReposNote(session),
			await memoryNoteFor(user, sessionRepoIds(session)),
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** The per-user prompt sections for a run: the user's personal system prompt
 *  (Settings → Personal prompt) + repo/user/team memory (with tool guidance —
 *  callers are interactive paths only; automations pass no user and skip this).
 *  Never throws: a store failure must not block a run, the note just goes out
 *  without that piece. */
export async function memoryNoteFor(
	user: string | undefined,
	repos: string[],
): Promise<string> {
	const parts: string[] = [personalPromptNoteFor(user)];
	try {
		parts.push(
			await renderSessionMemoryNote(
				sessionMemoryScopes({ user, repos }),
				{ tools: true },
			),
		);
	} catch (e) {
		console.warn("[memory] failed to render session memory note:", e);
	}
	return parts.filter(Boolean).join("\n\n");
}

/**
 * Resolve which GitHub repo + branch a PR operation targets. With no `repo`
 * query (or the primary project's id) it's the session's primary branch; an
 * attached project id targets that repo on its attached branch. Returns null
 * when there's no branch to act on.
 */
export function resolvePrTarget(
	session: UnifiedSession,
	repoId?: string | null,
	branch?: string | null,
): { ghRepo: string; branch: string } | null {
	const primaryBranch = sessionPrBranch(session);
	const primaryRepo =
		session.repo ||
		(session.worktreeDir && session.mode !== "scratch"
			? repoForPath(session.worktreeDir).id
			: defaultRepo().id);
	// Explicit repo+branch — a linked PR, which may live on a different branch
	// of the primary repo. Only pairs the session actually lists resolve, so
	// the PR routes can't be pointed at an arbitrary branch.
	if (repoId && branch) {
		const lp = (session.linkedPrs || []).find(
			(r) => r.repo === repoId && r.branch === branch,
		);
		const att = (session.attachedRepos || []).find(
			(r) => r.repo === repoId && r.branch === branch,
		);
		// A PR discovered through its attribution footer is one of the session's
		// own, so its detail/diff/review/merge routes resolve like a linked one.
		const found = (session.prs || []).find(
			(r) => r.repo === repoId && r.branch === branch,
		);
		const isPrimary = repoId === primaryRepo && branch === primaryBranch;
		if (!lp && !att && !found && !isPrimary) return null;
		return { ghRepo: getRepo(repoId).ghRepo, branch };
	}
	if (!repoId || repoId === primaryRepo) {
		if (!primaryBranch) return null;
		return {
			ghRepo: getRepo(primaryRepo).ghRepo,
			branch: primaryBranch,
		};
	}
	const att = (session.attachedRepos || []).find(
		(r) => r.repo === repoId,
	);
	if (att) return { ghRepo: getRepo(att.repo).ghRepo, branch: att.branch };
	const lp =
		(session.linkedPrs || []).find((r) => r.repo === repoId) ||
		(session.prs || []).find((r) => r.repo === repoId);
	if (!lp) return null;
	return { ghRepo: getRepo(lp.repo).ghRepo, branch: lp.branch };
}

/**
 * The workspace that already owns this worktree, or null. Adopt-don't-duplicate:
 * every create path that's about to wrap a session in a fresh workspace checks here
 * first, so landing on an already-owned worktree joins the existing workspace
 * instead of minting a second one over it. Repo main checkouts never match —
 * they're shared by every native/ask session, so ownership is meaningless there.
 */
export function workspaceOwningWorktree(
	worktreeDir: string | null | undefined,
): Workspace | null {
	if (!worktreeDir) return null;
	const cd = canonicalPath(worktreeDir);
	if (Object.values(REPOS).some((r) => canonicalPath(r.repo) === cd)) return null;
	return findWorkspaceByWorktree(worktreeDir);
}

/**
 * Attach a secondary repo to a session: create (or reuse) an isolated worktree
 * for `repoId` and record it on the session. The attached branch defaults to
 * the session's primary branch so cross-repo work shares one branch name (and
 * the PRs line up). Re-attaching the same project just updates its entry. Only
 * code sessions on a real worktree can attach — Ask/main-checkout sessions and
 * the primary project itself are rejected.
 */
export async function attachRepo(
	sessionId: string,
	repoId: string,
	branch?: string,
): Promise<{ attached: AttachedRepo; all: AttachedRepo[] }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	if (session.mode === "ask")
		throw new Error("Can't attach a repo to an Ask (read-only) session");
	if (hasRemoteWorkspace(session))
		throw new Error(
			"This session's workspace lives inside its sandbox volume — attached repos aren't supported in volume mode yet (use a bind-mode sandbox or a plain worktree session for multi-repo work)",
		);
	if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
	if (session.repo === repoId)
		throw new Error(`${repoId} is this session's primary repo`);

	const effectiveBranch = (branch || session.branch || "").trim();
	if (!effectiveBranch) {
		throw new Error("No branch to attach on — pass a branch name");
	}

	const attached = await prepareAttachedWorktree(repoId, effectiveBranch);
	const existing = (session.attachedRepos || []).filter(
		(r) => r.repo !== repoId,
	);
	const all = [...existing, attached];
	touchNativeSession(sessionId, { attachedRepos: all });
	return { attached, all };
}

/**
 * Switch a session's PRIMARY repo — for when the wrong repo was picked at
 * creation. Clean-only by design: allowed only while the session's worktree has
 * no uncommitted changes and no commits beyond its base, so no work is ever
 * silently stranded (a session that already committed keeps its old repo). The
 * session's branch name is reused in the target repo (keeping any cross-repo
 * PRs aligned); the next prompt runs from the new worktree because
 * runSessionPrompt re-reads `cwd` from `worktreeDir` each turn.
 */
export async function switchPrimaryRepo(
	sessionId: string,
	repoId: string,
	force = false,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	if (session.mode === "ask")
		throw new Error("Ask sessions read the main checkout — nothing to switch");
	if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
	if (session.repo === repoId)
		throw new Error(`${repoId} is already this session's primary repo`);
	// A switch just repoints the session at a different worktree — the old one
	// (branch, commits, uncommitted edits) stays on disk, so nothing is ever
	// destroyed. We still block by default when there's work so the agent-facing
	// switch_repo tool can't silently abandon it; the human UI passes force=true
	// after confirming, since fixing a wrong-repo choice is exactly that case.
	if (
		!force &&
		session.worktreeDir &&
		session.branch &&
		(await worktreeHasWork(session.worktreeDir, session.branch, session.repo))
	)
		throw new Error(
			"This session already has work — switching repos is only allowed on a fresh session",
		);

	const target = getRepo(repoId);
	let wtPath: string;
	let branch: string;
	if (sharedCheckoutForNewSessions(target)) {
		// Open Session: sessions edit the live main checkout on its default branch.
		wtPath = target.repo;
		branch = target.defaultBranch;
	} else {
		branch = (session.branch || "").trim();
		if (!branch) throw new Error("Session has no branch to carry over");
		const worktrees = await listWorktrees(target.id);
		wtPath =
			worktrees.find((w) => w.branch === branch)?.path ||
			(await createWorktree(branch, target.id));
	}

	// Drop the target from attached repos if it was attached — it's the primary now.
	const attachedRepos = (session.attachedRepos || []).filter(
		(r) => r.repo !== repoId,
	);
	touchNativeSession(sessionId, {
		repo: target.id,
		worktreeDir: wtPath,
		branch,
		attachedRepos,
	});
	// The session's workspace was minted around the repo we're leaving, and its repo
	// is what the sidebar bands the row under (wsRowRepo) while its branch +
	// worktreeDir are the template a sibling session inherits. Left stamped, the row
	// files under the abandoned repo — the session's own header showing the new one —
	// and a new session in the workspace starts in a worktree the work has left.
	// Re-stamp only when this session is the workspace's sole member and the
	// workspace still points at the worktree being left: with siblings still
	// there, or on a PR/ticket workspace that deliberately names another repo,
	// the stamp isn't ours to move.
	const workspaceId = session.workspaceId;
	if (workspaceId) {
		const ws = getWorkspace(workspaceId);
		const soleMember = !getCachedSessions().some(
			(s) => s.workspaceId === workspaceId && s.id !== sessionId,
		);
		if (
			ws &&
			soleMember &&
			ws.repo === session.repo &&
			(!ws.worktreeDir || ws.worktreeDir === session.worktreeDir)
		)
			restampWorkspaceWorktree(workspaceId, {
				repo: target.id,
				// A shared-checkout repo has no per-session worktree, so the template
				// clears instead of pointing siblings at the live main checkout.
				...(sharedCheckoutForNewSessions(target) ? {} : { branch, worktreeDir: wtPath }),
			});
	}
	return { repo: target.id, branch, worktreeDir: wtPath };
}

/** `gh pr view` for one PR — resolves a number or branch to its head branch + label fields. */
async function ghPrView(
	ghRepo: string,
	selector: string,
): Promise<{ branch: string; number: number; url: string; title: string } | null> {
	try {
		const proc = Bun.spawn(
			[
				"gh", "pr", "view", selector, "--repo", ghRepo,
				"--json", "headRefName,number,url,title",
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const raw = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0 || !raw.trim()) return null;
		const pr = JSON.parse(raw);
		return {
			branch: pr.headRefName,
			number: pr.number,
			url: pr.url,
			title: pr.title || "",
		};
	} catch {
		return null;
	}
}

/**
 * Link a PR to a session, beyond the ones derived from its branch and attached
 * repos — a follow-up PR on another branch, a related PR in another repo, or
 * one opened outside the session. Accepts a GitHub PR URL, or repo id +
 * number/branch; the PR is resolved via gh so the stored link carries the head
 * branch (the key the whole PR pipeline uses) plus number/url/title for
 * labels. Re-linking an already-linked PR refreshes its entry.
 */
export async function linkPr(
	sessionId: string,
	input: { url?: string; repo?: string; number?: number; branch?: string },
): Promise<{ linked: LinkedPr; all: LinkedPr[] }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");

	let repoId = input.repo?.trim();
	let number = input.number;
	let branch = input.branch?.trim();

	if (input.url) {
		const m = input.url.match(
			/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i,
		);
		if (!m) throw new Error("Not a GitHub PR URL (…github.com/owner/repo/pull/N)");
		const ghRepo = `${m[1]}/${m[2]}`.toLowerCase();
		const match = Object.values(REPOS).find(
			(r) => r.ghRepo?.toLowerCase() === ghRepo,
		);
		if (!match)
			throw new Error(
				`${m[1]}/${m[2]} isn't a registered repo (known: ${Object.values(REPOS)
					.filter((r) => r.ghRepo)
					.map((r) => r.id)
					.join(", ")})`,
			);
		repoId = match.id;
		number = parseInt(m[3], 10);
	}

	if (!repoId) throw new Error("Pass a PR URL or a repo id");
	const repo = REPOS[repoId];
	if (!repo?.ghRepo) throw new Error(`Unknown repo "${repoId}"`);
	if (!number && !branch)
		throw new Error("Pass a PR URL, a PR number, or a branch");

	// Resolve through gh: number → head branch (required — the PR pipeline is
	// branch-keyed), branch → number/url/title (best-effort label enrichment).
	const resolved = await ghPrView(repo.ghRepo, number ? String(number) : branch!);
	if (number && !resolved)
		throw new Error(`Couldn't find PR #${number} in ${repo.ghRepo}`);
	if (resolved) {
		branch = resolved.branch;
		number = resolved.number;
	}

	const primaryRepo =
		session.repo ||
		(session.worktreeDir && session.mode !== "scratch" ? repoForPath(session.worktreeDir).id : defaultRepo().id);
	if (repoId === primaryRepo && branch === session.branch)
		throw new Error("That's this session's own PR — it's already shown");
	if (
		(session.attachedRepos || []).some(
			(r) => r.repo === repoId && r.branch === branch,
		)
	)
		throw new Error(
			`That's the attached ${repoId} repo's PR — it's already shown`,
		);

	const linked: LinkedPr = {
		repo: repoId,
		branch: branch!,
		...(number ? { number } : {}),
		...(resolved?.url ? { url: resolved.url } : {}),
		...(resolved?.title ? { title: resolved.title } : {}),
	};
	const all = [
		...(session.linkedPrs || []).filter(
			(r) => !(r.repo === repoId && r.branch === branch),
		),
		linked,
	];
	touchNativeSession(sessionId, { linkedPrs: all });
	return { linked, all };
}

/** Remove a linked PR from a session (the link only — the PR is untouched). */
export function unlinkPr(
	sessionId: string,
	repoId: string,
	branch: string,
): LinkedPr[] {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	const all = (session.linkedPrs || []).filter(
		(r) => !(r.repo === repoId && r.branch === branch),
	);
	touchNativeSession(sessionId, { linkedPrs: all });
	return all;
}
