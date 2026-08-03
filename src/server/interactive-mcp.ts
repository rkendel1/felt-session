/**
 * In-process self-management MCP servers for INTERACTIVE Backstage sessions
 * (web UI + loops) — the same opensession-sessions / opensession-admin tools the Slack
 * agent gets, so you can list/steer sessions and manage automations/MCPs from a
 * Michael session. Built fresh per run from the prompt's author. NEVER pass
 * these to automation runs or to interactive resumes of automation-owned
 * sessions — untrusted ticket text must not reach session-control / config
 * tools. Backstage is Tailscale- and team-gated and already exposes all of this
 * through its UI, so interactive users are treated as admin.
 *
 * Sole exception: opensession-papercuts (append-only friction log, no reads of
 * anything sensitive, no control surface) also goes to automation runs — see
 * papercutsServerFor and the automation guard in the run-rpc builder below.
 */

import { createSessionsMcpServer } from "../agents/slack/sessions-tools";
import { createNodesMcpServer } from "../agents/slack/nodes-tools";
import { createAdminMcpServer } from "../agents/slack/admin-tools";
import { createHumansMcpServer } from "../agents/slack/humans-tools";
import { createKeychainMcpServer } from "../agents/slack/keychain-tools";
import { createPublishMcpServer } from "../agents/slack/publish-tools";
import { createAskUserMcpServer } from "../agents/slack/ask-tools";
import { createReposMcpServer } from "../agents/slack/repos-tools";
import { createPreviewMcpServer } from "../agents/slack/preview-tools";
import { createWalkthroughMcpServer } from "../agents/slack/walkthrough-tools";
import { createMemoryMcpServer } from "../agents/slack/memory-tools";
import { createGoalsMcpServer, createGoalSelfMcpServer } from "../agents/slack/goal-tools";
import { createPapercutsMcpServer } from "../agents/slack/papercuts-tools";
import { createTodosMcpServer } from "../agents/slack/todos-tools";
import { createSearchMcpServer } from "../agents/slack/search-tools";
import { createAssetsMcpServer } from "../agents/slack/assets-tools";
import { createWorkflowsMcpServer } from "../agents/slack/workflow-tools";
import { createNotesMcpServer } from "../agents/slack/notes-tools";
import { papercutsEnabledForRepo } from "./papercuts";
import { defaultRepo, productName } from "./config";
import { repoForPath, REPOS } from "./worktree";
import { registerInteractiveMcpBuilder, startMcpHttpServer, startRunRpcServer } from "./run-rpc";
import { automationRunMcpForSession, selfImproveMcpForSession } from "./automations";
import { findSession, touchBackstageSession } from "./session-cache";
import { attachRepo, linkPr, resolveSessionRepoContext, sessionRepoIds, switchPrimaryRepo } from "./session-repos";
import { makeAskHandler } from "./asks";
import { getSandboxProvider } from "./sandbox";
import { isRunnableSandboxProvider } from "./sandbox/config";
import { createRemoteWorkspaceMcpServer } from "./sandbox/workspace-mcp";

/** The session's primary repo id, for the papercuts toggle (undefined =
 *  chat-only session, which logs under no repo and is always enabled). */
function sessionRepoId(sessionId: string): string | undefined {
	const s = findSession(sessionId);
	if (!s) return undefined;
	return s.repo || (s.worktreeDir && s.mode !== "scratch" ? repoForPath(s.worktreeDir).id : undefined);
}

/** The papercuts server for a session, or {} when its repo opted out
 *  (Settings → Papercuts). Shared with automationMcpServers below — this is
 *  the ONE opensession-* server that is safe for automation runs (append-only
 *  friction log; see papercuts-tools.ts). */
function papercutsServerFor(
	sessionId: string,
	runKind: string,
	by?: string,
): Record<string, unknown> {
	if (!papercutsEnabledForRepo(sessionRepoId(sessionId))) return {};
	return {
		"opensession-papercuts": createPapercutsMcpServer({
			sessionId,
			runKind,
			by,
			defaults: () => {
				const s = findSession(sessionId);
				return { repo: sessionRepoId(sessionId), model: s?.model };
			},
		}),
	};
}

export function interactiveMcpServers(
	user?: string,
	sessionId?: string,
): Record<string, unknown> {
	const createdBy = user || productName();
	return {
		"opensession-sessions": createSessionsMcpServer({
			createdBy,
			isAdmin: true,
			currentSessionId: sessionId,
		}),
		"opensession-admin": createAdminMcpServer({
			channel: "backstage",
			userId: user || "backstage",
			isDM: false,
			isPrivate: false,
			createdBy,
			isAdmin: true,
		}),
		// Run commands on machines attached with `opensession connect` — the
		// escape hatch for platform-locked work (Xcode on a Mac, MSVC on
		// Windows). Interactive-only like its siblings: a node is unsandboxed,
		// so untrusted automation text must never reach it.
		"opensession-nodes": createNodesMcpServer(),
		// Long-running goals: create/list/steer persistent, self-pacing missions.
		"opensession-goals": createGoalsMcpServer({ createdBy, isAdmin: true }),
		// Search past sessions' distilled records (session-index.ts). Read-only,
		// but transcripts can hold sensitive material — interactive-only like the
		// siblings (the automation gate in the run-rpc builder below fails closed).
		"opensession-search": createSearchMcpServer(),
		// Workspace-wide collaborative notes. Read/write/delete is interactive-only
		// because notes can contain sensitive material and persistent instructions.
		"opensession-notes": createNotesMcpServer(),
		// Human-in-the-loop: ask a teammate and fold the answer back into this
		// session. Needs the session id so the answer routes home. Withheld (like
		// the others) from automation runs — see the runSessionPrompt call site.
		...(sessionId
			? {
					"opensession-humans": createHumansMcpServer({
						sessionId,
						createdBy,
						isAdmin: true,
					}),
					// Borrow a teammate's credential for a stated purpose, with
					// their approval, through the broker (src/server/keychain.ts).
					// Interactive-only for the same reason as its sibling above:
					// an ask is a DM carrying a model-authored purpose string, and
					// untrusted ticket text must never be able to compose one.
					"opensession-keychain": createKeychainMcpServer({
						sessionId,
						user: createdBy,
					}),
					// Publish a directory as a durable internal web app that
					// outlives this session (src/server/deploys.ts). Interactive
					// only: a deploy is arbitrary code that keeps running, so
					// untrusted automation text must never reach it.
					"opensession-publish": createPublishMcpServer({
						sessionId,
						user: createdBy,
						worktreeDir: () => findSession(sessionId)?.worktreeDir || undefined,
					}),
					// Cross-repo: attach secondary repos as isolated worktrees.
					"opensession-repos": createReposMcpServer({
						sessionId,
						attach: (repo, branch) => attachRepo(sessionId, repo, branch),
						switchPrimary: (repo) => switchPrimaryRepo(sessionId, repo),
						snapshot: () => {
							const s = findSession(sessionId);
							if (!s) return null;
							return {
								primaryRepo:
									s.repo ||
									(s.worktreeDir && s.mode !== "scratch"
										? repoForPath(s.worktreeDir).id
										: defaultRepo().id),
								branch: s.branch,
								worktreeDir: s.worktreeDir,
								attached: s.attachedRepos || [],
							};
						},
						repos: () =>
							Object.values(REPOS).map((p) => ({
								id: p.id,
								defaultBranch: p.defaultBranch,
								sharedCheckout: !!p.sharedCheckout,
							})),
						linkPr: (input) => linkPr(sessionId, input),
					}),
					// Durable repo/user/team memory (stored under ~/.michael-memory,
					// shared both ways with Slack's channel memory). Write tools are
					// interactive-only — automation runs get read-only injection; see
					// memory-tools.ts for the trust model.
					"opensession-memory": createMemoryMcpServer({
						user,
						repos: () => {
							const s = findSession(sessionId);
							return s ? sessionRepoIds(s) : [];
						},
					}),
					// Preview lifecycle + deep-link: the agent can start/stop/poll its
					// own dev-server preview (warm pool claim when available) and
					// record where the change should be tested so the Preview/Preview environment
					// buttons open that route directly.
					"opensession-preview": createPreviewMcpServer({
						sessionId,
						setPreviewPath: (path) =>
							touchBackstageSession(sessionId, {
								previewPath: path || undefined,
							}),
						current: () => findSession(sessionId)?.previewPath ?? null,
						start: async () => {
							const wt = findSession(sessionId)?.worktreeDir;
							if (!wt) throw new Error("this session has no worktree to preview");
							const { startPreview } = await import("./preview");
							const s = await startPreview(wt);
							return {
								running: s.running,
								starting: s.starting,
								previewUrl: s.previewUrl,
								bootable: s.bootable,
							};
						},
						status: async () => {
							const wt = findSession(sessionId)?.worktreeDir;
							if (!wt) throw new Error("this session has no worktree to preview");
							const { getPreviewStatus } = await import("./preview");
							const s = await getPreviewStatus(wt);
							return { running: s.running, starting: s.starting, previewUrl: s.previewUrl };
						},
						stop: async () => {
							const wt = findSession(sessionId)?.worktreeDir;
							if (!wt) throw new Error("this session has no worktree to preview");
							const { stopPreview } = await import("./preview");
							const s = await stopPreview(wt);
							return { running: s.running, starting: s.starting, previewUrl: s.previewUrl };
						},
					}),
					// Publish a demo walkthrough (video + before/after + writeup) onto
					// the session's Review tab and the PR description.
					"opensession-walkthrough": createWalkthroughMcpServer({
						sessionId,
						by: createdBy,
					}),
					// AskUserQuestion for engines without a canUseTool hook (Codex):
					// blocks on the same UI question card + Slack escalation as the
					// native Claude tool. claude-runner strips this server so Claude
					// keeps using the native AskUserQuestion instead of a duplicate.
					"opensession-ask": createAskUserMcpServer({
						ask: makeAskHandler(sessionId),
					}),
					// Dynamic workflows: deterministic agent fan-out from a
					// model-authored script (Agents panel). Interactive-only like the
					// siblings — the automation fail-closed gate in the run-rpc builder
					// below withholds it from automation-owned sessions.
					// No defaultModel: agents run on WORKFLOW_DEFAULT_MODEL (Opus), NOT
					// the session's model — a fan-out shouldn't silently inherit
					// whatever the orchestrator happens to be on.
					// No mcpAllowlist/deniedTools either: a script's mcp.* calls get
					// exactly what this user's own interactive runs get (the
					// `allowedUsers` gate still applies via createdBy, and
					// confirm-gated servers are dropped wholesale in workflow-mcp.ts).
					"opensession-workflows": createWorkflowsMcpServer({
						sessionId,
						user: createdBy,
						workspace: (repo, hint) => {
							const session = findSession(sessionId);
							if (!session) return undefined;
							const context = resolveSessionRepoContext(session, repo, hint);
							if (!context) return undefined;
							return {
								cwd: context.dir,
								repo: context.repo,
								baseBranch: context.branch,
							};
						},
					}),
					// Per-session scratch assets (previewed in the Assets tab).
					// Works in Ask mode — writes land outside the checkout.
					"opensession-assets": createAssetsMcpServer({ sessionId }),
					// The user's Desk todo list — add/list/complete/drop/update.
					// Interactive-only like the siblings (the automation branch below
					// fails closed): untrusted ticket text must not write to a
					// human's list.
					"opensession-todos": createTodosMcpServer({
						sessionId,
						user: createdBy,
					}),
					// Friction log — log_papercut/list_papercuts, per-repo toggle in
					// Settings → Papercuts (dropped here when the repo opted out).
					...papercutsServerFor(sessionId, "prompt", createdBy),
				}
			: {}),
	};
}

// Codex cannot consume Claude SDK in-process MCP servers directly. Expose the
// same interactive opensession-* tools through the run-rpc stdio proxy so Codex
// sessions can inspect/create/steer Backstage sessions too. Goal-driven
// sessions additionally get opensession-goal-self (next-wake/ledger/pause tools),
// matching what the in-process path hands them at the runAgent call sites.
registerInteractiveMcpBuilder((sessionId, user) => {
	// Automation-owned sessions run on untrusted event/ticket text. Their runs
	// only ever carry opensession-papercuts (automations.ts registers the exact
	// instances per run) — plus, for selfImprove automations only, the scoped
	// spawn/self pair — but this builder is also run-rpc's FALLBACK resolver
	// for any registered run token, so it must fail closed here rather than
	// hand session-control/admin tools to an automation that asks for them.
	const session = sessionId ? findSession(sessionId) : undefined;
	if (session?.automation) {
		return {
			...papercutsServerFor(
				sessionId,
				"automation",
				`${session.automation} (automation)`,
			),
			...(automationRunMcpForSession(session, sessionId) || {}),
			...(selfImproveMcpForSession(session, sessionId) || {}),
		};
	}
	const servers = interactiveMcpServers(user, sessionId);
	const goalId = session?.goalId;
	if (goalId)
		(servers as Record<string, unknown>)["opensession-goal-self"] =
			createGoalSelfMcpServer(goalId);
	if (session?.sandbox?.engine === "host") {
		(servers as Record<string, unknown>)["opensession-workspace"] =
			createRemoteWorkspaceMcpServer(async () => {
				const current = findSession(sessionId);
				const info = current?.sandbox;
				if (
					info?.engine !== "host" ||
					!info.sandboxId ||
					!isRunnableSandboxProvider(info.provider)
				) {
					throw new Error(
						`Remote workspace for ${sessionId} is not materialized.`,
					);
				}
				const sandbox = await getSandboxProvider(info.provider).get(info.sandboxId);
				if (!sandbox) {
					throw new Error(
						`${info.provider} sandbox ${info.sandboxId} is unavailable; retry the session after the sandbox has restarted.`,
					);
				}
				return sandbox;
			});
	}
	return servers;
});
startRunRpcServer();
startMcpHttpServer();
