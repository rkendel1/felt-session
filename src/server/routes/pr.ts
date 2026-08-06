/**
 * Everything pull-request: open-PR list, PR Tinder, per-session PR details/diff/comment/review/merge/close, PR agent actions, session-less PR previews.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { defaultRepo, personaName } from "../config";
import {
	cachedPrDetailsForSession,
	closePr,
	getPrDetails,
	getPrDiff,
	invalidatePrInfo,
	mergePr,
	postPrComment,
	prMetaForBranch,
	reconcilePrDetails,
	submitPrReview,
} from "../pr-info";
import { linkPrStack } from "../pr-stack";
import { closeTinderPr, commentTinderPr, deleteTinderComment, getSeenPrs, labelTinderPr, listTinderLabels, listTinderPrs, markPrSeen, markPrUnseen, reopenTinderPr } from "../pr-tinder";
import { findSession, invalidateSessionsCache } from "../session-cache";
import { getSessionControl } from "../session-control";
import { resolvePrTarget } from "../session-repos";
import {
	getOpenPrs,
	getPrReviewStatus,
	getRecentPrs,
	getRecentPrsForPerson,
	markCachedPrClosed,
	markCachedPrMerged,
	markCachedPrReviewed,
} from "../sessions";
import { githubLoginToPersonKey } from "../shared/user-mappings";
import { getRepo } from "../worktree";
import { existsSync, watch } from "fs";
import {
	githubCredentialRequiredResponse,
	githubMutationCredential,
} from "./github-credential";

function validDiffGroupingInput(body: any): {
	files: Array<{
		path: string;
		additions: number;
		deletions: number;
	}>;
	patch: string;
} | null {
	if (!Array.isArray(body?.files) || typeof body?.patch !== "string") return null;
	const files = body.files.filter(
		(file: any) =>
			typeof file?.path === "string" &&
			file.path.length <= 1000 &&
			typeof file.additions === "number" &&
			typeof file.deletions === "number",
	);
	return files.length === body.files.length ? { files, patch: body.patch } : null;
}

async function prApiResponse(
	load: () => Promise<unknown>,
	fallback?: unknown,
): Promise<Response> {
	try {
		return Response.json(await load());
	} catch (e: any) {
		if (fallback !== undefined) return Response.json(fallback);
		return Response.json(
			{ error: e?.message || "GitHub's pull request API is unavailable right now." },
			{ status: 502 },
		);
	}
}

export async function handlePrRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Every open PR in the repo, attributed to teammates via the GitHub
	// identity table — the sidebar's Open PRs section (which must include
	// PRs that have no Open Session session).
	if (path === "/api/open-prs" && req.method === "GET") {
		return Response.json({ prs: getOpenPrs() });
	}

	// GitHub's per-viewer "Viewed" file state on a PR (the review canvas
	// checkboxes). GET lists the viewer's VIEWED paths; POST marks/unmarks one
	// file. State lives on GitHub (markFileAsViewed), so it round-trips with
	// github.com's own file list. See src/server/pr-viewed.ts.
	if (path === "/api/pr-viewed-files" && req.method === "GET") {
		const repoId = url.searchParams.get("repo");
		const number = parseInt(url.searchParams.get("number") || "", 10);
		if (!Number.isFinite(number))
			return Response.json({ error: "number required" }, { status: 400 });
		const { getPrViewedFiles } = await import("../pr-viewed");
		try {
			return Response.json(
				await getPrViewedFiles(
					ctx,
					requestUser(ctx, url.searchParams.get("user")),
					(repoId ? getRepo(repoId) : defaultRepo()).ghRepo,
					number,
				),
			);
		} catch (e: any) {
			return Response.json({ error: e?.message || String(e) }, { status: 502 });
		}
	}
	if (path === "/api/pr-viewed-files" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as {
			prId?: string;
			path?: string;
			viewed?: boolean;
			user?: string;
		};
		if (!body.prId || !body.path || typeof body.viewed !== "boolean")
			return Response.json(
				{ error: "prId, path and viewed required" },
				{ status: 400 },
			);
		const { setPrFileViewed } = await import("../pr-viewed");
		try {
			await setPrFileViewed(
				ctx,
				requestUser(ctx, body.user),
				body.prId,
				body.path,
				body.viewed,
			);
			return Response.json({ ok: true });
		} catch (e: any) {
			return Response.json({ error: e?.message || String(e) }, { status: 502 });
		}
	}

	// Recent PRs across the covered repos, including merges made without an
	// Open Session workspace. Powers the root shipped-worktree index.
	if (path === "/api/recent-prs" && req.method === "GET") {
		const person = url.searchParams.get("person");
		return Response.json({ prs: person ? await getRecentPrsForPerson(person) : getRecentPrs() });
	}

	// PR Tinder: the triage deck — every open tella-fusion PR with the
	// rich card fields, the repo's labels, and which PRs this user already
	// kept (so the deck doesn't re-deal them for 14 days).
	if (path === "/api/pr-tinder" && req.method === "GET") {
		const user = requestUser(ctx, url.searchParams.get("user"));
		try {
			const [prs, labels] = await Promise.all([
				listTinderPrs(),
				listTinderLabels(),
			]);
			return Response.json({
				prs,
				labels,
				seen: user ? getSeenPrs(user) : [],
			});
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 502 },
			);
		}
	}

	// PR Tinder actions: keep (per-user, local state only), close (with an
	// optional reason comment), reopen (the close undo), comment, label.
	{
		const m = path.match(/^\/api\/pr-tinder\/(\d+)\/(\w+)$/);
		if (m && req.method === "POST") {
			const number = parseInt(m[1], 10);
			const body = await req.json().catch(() => ({}));
			const user = requestUser(ctx, body.user);
			try {
				switch (m[2]) {
					case "keep": {
						if (!user)
							return Response.json(
								{ error: "user required" },
								{ status: 400 },
							);
						markPrSeen(user, number);
						return Response.json({ ok: true });
					}
					case "unkeep": {
						if (!user)
							return Response.json(
								{ error: "user required" },
								{ status: 400 },
							);
						markPrUnseen(user, number);
						return Response.json({ ok: true });
					}
					case "close": {
						const credential = githubMutationCredential(ctx);
						if (!credential) return githubCredentialRequiredResponse();
						const r = await closeTinderPr(number, body.reason, credential);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "reopen": {
						const credential = githubMutationCredential(ctx);
						if (!credential) return githubCredentialRequiredResponse();
						const r = await reopenTinderPr(number, credential);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "comment": {
						const credential = githubMutationCredential(ctx);
						if (!credential) return githubCredentialRequiredResponse();
						const r = await commentTinderPr(number, body.body || "", credential);
						// Commenting is a triage verdict too — don't re-deal the PR.
						if ("ok" in r && user) markPrSeen(user, number);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "uncomment": {
						// Undo for a comment: delete it and put the PR back in the
						// user's deck.
						if (!body.commentId)
							return Response.json(
								{ error: "commentId required" },
								{ status: 400 },
							);
						const credential = githubMutationCredential(ctx);
						if (!credential) return githubCredentialRequiredResponse();
						const r = await deleteTinderComment(Number(body.commentId), credential);
						if ("ok" in r && user) markPrUnseen(user, number);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "labels": {
						const credential = githubMutationCredential(ctx);
						if (!credential) return githubCredentialRequiredResponse();
						const r = await labelTinderPr(number, {
							add: body.add,
							remove: body.remove,
						}, credential);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
				}
			} catch (e: any) {
				return Response.json(
					{ error: e.message || String(e) },
					{ status: 500 },
				);
			}
		}
	}

	// PR details for a session's branch (PR tab). `?repo=<project>` targets an
	// attached repo's PR; `?repo=&branch=` a linked PR (which may be another
	// branch of the primary repo); default/primary the session's own branch.
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const target = resolvePrTarget(
			session,
			url.searchParams.get("repo"),
			url.searchParams.get("branch"),
		);
		if (!target) return Response.json(null);
		const repoId =
			url.searchParams.get("repo") || session.repo || defaultRepo().id;
		const fallback = cachedPrDetailsForSession(session, repoId, target.branch);
		// The branch this session stacked on, for the panel's "link this stack"
		// action. Only for the session's OWN branch — an attached or linked PR is
		// not what this session was stacked on top of.
		const stackBase =
			session.stackedOn?.branch && target.branch === session.branch
				? session.stackedOn.branch
				: undefined;
		const withReview = <T extends { number: number; headRefOid?: string } | null>(
			details: T,
		) =>
			details
				? {
						...details,
						...(stackBase ? { stackBase } : {}),
						...getPrReviewStatus(
							details.number,
							target.ghRepo,
							details.headRefOid,
						),
					}
				: null;
		return prApiResponse(
			async () =>
				withReview(
					reconcilePrDetails(
						await getPrDetails(target.branch, target.ghRepo),
						fallback,
					),
				),
			withReview(fallback) ?? undefined,
		);
	}

	// PR diff for inline review in the PR tab
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-diff$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-diff$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const target = resolvePrTarget(
			session,
			url.searchParams.get("repo"),
			url.searchParams.get("branch"),
		);
		if (!target) return Response.json(null);
		return prApiResponse(() => getPrDiff(target.branch, target.ghRepo));
	}

	// AI-powered file categories for the PR Changes view. Kept separate from
	// the diff endpoint so loading a review never blocks on model generation.
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-diff-groups$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-diff-groups$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const target = resolvePrTarget(
			session,
			url.searchParams.get("repo"),
			url.searchParams.get("branch"),
		);
		if (!target) return Response.json({ groups: null });
		const body = await req.json().catch(() => ({}));
		const { getDiffFileGroups } = await import("../diff-groups");
		const input = validDiffGroupingInput(body);
		if (!input)
			return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
		return Response.json({
			groups: await getDiffFileGroups(target.ghRepo, input.files, input.patch),
		});
	}

	// Link a PR to the session (a follow-up PR, or one in another repo/branch).
	// Body: { url } or { repo, number } or { repo, branch }.
	if (
		path.match(/^\/api\/sessions\/(.+)\/link-pr$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/link-pr$/)![1],
		);
		const body = await req.json().catch(() => ({}));
		try {
			const { linkPr } = await import("../session-repos");
			const result = await linkPr(sessionId, {
				url: body.url,
				repo: body.repo,
				number: body.number,
				branch: body.branch,
			});
			invalidateSessionsCache(); // session.prs / linkedPrs changed
			return Response.json({ ok: true, ...result });
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 400 },
			);
		}
	}

	// Unlink a PR (drops the link only — the PR itself is untouched). POST, not
	// DELETE, so it isn't swallowed by the generic DELETE /sessions/:id route.
	if (
		path.match(/^\/api\/sessions\/(.+)\/unlink-pr$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/unlink-pr$/)![1],
		);
		const body = await req.json().catch(() => ({}));
		if (!body.repo || !body.branch)
			return Response.json(
				{ error: "repo and branch required" },
				{ status: 400 },
			);
		try {
			const { unlinkPr } = await import("../session-repos");
			const all = unlinkPr(sessionId, body.repo, body.branch);
			invalidateSessionsCache();
			return Response.json({ ok: true, all });
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 400 },
			);
		}
	}

	// AI review guide for the PR tab's Guide view — generated on first
	// request per head commit (slow: a one-shot over the whole diff),
	// cached after that. null = no PR / generation failed (UI falls back
	// to the plain diff).
	if (
		path.match(/^\/api\/sessions\/(.+)\/review-guide$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/review-guide$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const target = resolvePrTarget(
			session,
			url.searchParams.get("repo"),
			url.searchParams.get("branch"),
		);
		if (!target) return Response.json(null);
		const { getReviewGuide } = await import("../../server/review-guide");
		return prApiResponse(
			() => getReviewGuide(target.branch, target.ghRepo),
		);
	}

	// An image blob from a repo at a ref, for PR diff views — binary files have
	// no textual hunks, so the client renders the picture itself (head ref for
	// the new side, base ref for the old). Image extensions only; the repo must
	// be registered. Served through gh so private repos work.
	if (path === "/api/pr-image" && req.method === "GET") {
		const filePath = url.searchParams.get("path") || "";
		const ref = url.searchParams.get("ref") || "";
		const { imageContentType, imageHeaders } = await import("../image-mime");
		const contentType = imageContentType(filePath);
		if (!contentType || !ref)
			return new Response("path (an image) and ref required", { status: 400 });
		const repo = getRepo(url.searchParams.get("repo") || undefined);
		const proc = Bun.spawn(
			[
				"gh", "api", "-H", "Accept: application/vnd.github.raw",
				`repos/${repo.ghRepo}/contents/${encodeURIComponent(filePath).replace(/%2F/gi, "/")}?ref=${encodeURIComponent(ref)}`,
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const bytes = await new Response(proc.stdout).arrayBuffer();
		if ((await proc.exited) !== 0 || bytes.byteLength === 0)
			return new Response("Not found at that ref", { status: 404 });
		return new Response(bytes, {
			headers: imageHeaders(contentType, "private, max-age=120"),
		});
	}

	// Session-less PR preview (sidebar PR rows with no session yet): PR details
	// and diff straight from repo+branch — same pr-info helpers as the
	// session routes, minus the session lookup.
	if (path === "/api/pr-preview" && req.method === "GET") {
		const branch = url.searchParams.get("branch") || "";
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(url.searchParams.get("repo") || undefined);
		return prApiResponse(() => getPrDetails(branch, repo.ghRepo));
	}
	if (path === "/api/pr-preview-diff" && req.method === "GET") {
		const branch = url.searchParams.get("branch") || "";
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(url.searchParams.get("repo") || undefined);
		return prApiResponse(() => getPrDiff(branch, repo.ghRepo));
	}
	if (path === "/api/pr-preview-diff-groups" && req.method === "POST") {
		const repo = getRepo(url.searchParams.get("repo") || undefined);
		const body = await req.json().catch(() => ({}));
		const input = validDiffGroupingInput(body);
		if (!input)
			return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
		const { getDiffFileGroups } = await import("../diff-groups");
		return Response.json({
			groups: await getDiffFileGroups(repo.ghRepo, input.files, input.patch),
		});
	}
	// Session-less review guide for the preview's Guide tab — getReviewGuide
	// only needs branch+ghRepo (same generation/cache as the session route).
	if (path === "/api/pr-preview-guide" && req.method === "GET") {
		const branch = url.searchParams.get("branch") || "";
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(url.searchParams.get("repo") || undefined);
		const { getReviewGuide } = await import("../../server/review-guide");
		return prApiResponse(() => getReviewGuide(branch, repo.ghRepo));
	}
	if (path === "/api/pr-preview-review" && req.method === "POST") {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const body = await req.json().catch(() => null);
		const branch = body?.branch?.trim();
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(body?.repo || undefined);
		const event =
			body?.event === "APPROVE" || body?.event === "REQUEST_CHANGES"
				? body.event
				: "COMMENT";
		const comments = Array.isArray(body?.comments) ? body.comments : [];
		if (
			!comments.length &&
			!body?.summary?.trim() &&
			event !== "APPROVE"
		)
			return Response.json({ error: "Nothing to submit" }, { status: 400 });
		const user = requestUser(ctx, body?.user) || "Someone";
		const summary = body?.summary?.trim();
		const result = await submitPrReview(
			branch,
			{
				event,
				body: summary
					? `**${user}** via ${personaName()}:\n\n${summary}`
					: `Review by **${user}** via ${personaName()}.`,
				comments: comments
					.filter((c: any) => c?.text?.trim() && c?.path && c?.line)
					.map((c: any) => ({
						path: c.path,
						line: c.line,
						startLine: c.startLine,
						side: c.side,
						startSide: c.startSide,
						body: `**${user}**: ${c.text.trim()}`,
					})),
			},
			repo.ghRepo,
			credential,
		);
		if ("error" in result) return Response.json(result, { status: 502 });
		const credentialLogin = credential.principal.replace(/^user:/, "");
		const reviewer =
			githubLoginToPersonKey(credentialLogin) ||
			user.trim().split(/\s+/)[0]?.toLowerCase();
		if (reviewer) markCachedPrReviewed(repo.ghRepo, branch, reviewer, event);
		invalidateSessionsCache();
		return Response.json(result);
	}
	if (path === "/api/pr-preview-merge" && req.method === "POST") {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const body = await req.json().catch(() => ({}));
		const branch = body?.branch?.trim();
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(body?.repo || undefined);
		const method =
			body.method === "merge" || body.method === "rebase"
				? body.method
				: "squash";
		try {
			const result = await mergePr(
				branch,
				{ method, deleteBranch: !!body.deleteBranch, force: !!body.force },
				repo.ghRepo,
				credential,
			);
			if ("error" in result) return Response.json(result, { status: 502 });
			markCachedPrMerged(repo.ghRepo, branch);
			invalidateSessionsCache();
			return Response.json(result);
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 502 },
			);
		}
	}
	if (path === "/api/pr-preview-close" && req.method === "POST") {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const body = await req.json().catch(() => ({}));
		const branch = body?.branch?.trim();
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(body?.repo || undefined);
		const result = await closePr(branch, repo.ghRepo, credential);
		if ("error" in result) return Response.json(result, { status: 502 });
		markCachedPrClosed(repo.ghRepo, result.number);
		invalidateSessionsCache();
		return Response.json(result);
	}

	// Post a comment on the session's PR (inline when path+line present)
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-comment$/) &&
		req.method === "POST"
	) {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-comment$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => null);
		if (!body?.text?.trim())
			return Response.json({ error: "Empty comment" }, { status: 400 });
		const target = resolvePrTarget(session, body.repo, body.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);

		const user = requestUser(ctx, body.user) || "Someone";
		const result = await postPrComment(
			target.branch,
			{
				body: `**${user}** via ${personaName()}:\n\n${body.text.trim()}`,
				path: body.path,
				line: body.line,
				startLine: body.startLine,
				side: body.side,
				startSide: body.startSide,
			},
			target.ghRepo,
			credential,
		);
		if ("error" in result) return Response.json(result, { status: 502 });
		return Response.json(result);
	}

	// Submit a batched review (all pending inline comments + an event) on the PR.
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-review$/) &&
		req.method === "POST"
	) {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-review$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => null);
		const target = resolvePrTarget(session, body?.repo, body?.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);
		const event =
			body?.event === "APPROVE" || body?.event === "REQUEST_CHANGES"
				? body.event
				: "COMMENT";
		const comments = Array.isArray(body?.comments) ? body.comments : [];
		if (
			!comments.length &&
			!body?.summary?.trim() &&
			event !== "APPROVE"
		) {
			return Response.json({ error: "Nothing to submit" }, { status: 400 });
		}

		const user = requestUser(ctx, body?.user) || "Someone";
		const summary = body?.summary?.trim();
		const reviewBody = summary
			? `**${user}** via ${personaName()}:\n\n${summary}`
			: `Review by **${user}** via ${personaName()}.`;
		const result = await submitPrReview(
			target.branch,
			{
				event,
				body: reviewBody,
				comments: comments
					.filter((c: any) => c?.text?.trim() && c?.path && c?.line)
					.map((c: any) => ({
						path: c.path,
						line: c.line,
						startLine: c.startLine,
						side: c.side,
						startSide: c.startSide,
						body: `**${user}**: ${c.text.trim()}`,
					})),
			},
			target.ghRepo,
			credential,
		);
		if ("error" in result) return Response.json(result, { status: 502 });
		const credentialLogin = credential.principal.replace(/^user:/, "");
		const reviewer =
			githubLoginToPersonKey(credentialLogin) ||
			user.trim().split(/\s+/)[0]?.toLowerCase();
		if (reviewer) markCachedPrReviewed(target.ghRepo, target.branch, reviewer, event);
		invalidateSessionsCache(); // a review can change reviewDecision in the list
		return Response.json(result);
	}

	// Squash & merge the session's PR — human-triggered from the Reviews view.
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-merge$/) &&
		req.method === "POST"
	) {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-merge$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => ({}));
		const target = resolvePrTarget(session, body.repo, body.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);
		const method =
			body.method === "merge" || body.method === "rebase"
				? body.method
				: "squash";
		try {
			const result = await mergePr(
				target.branch,
				{ method, deleteBranch: !!body.deleteBranch, force: !!body.force },
				target.ghRepo,
				credential,
			);
			if ("error" in result) return Response.json(result, { status: 502 });
			// Patch the bulk PR cache before dropping the sessions cache: the
			// rebuild reads that cache stale-while-revalidate, so without this the
			// row stays green/open until the throttled sweep or a webhook lands.
			markCachedPrMerged(target.ghRepo, target.branch);
			invalidateSessionsCache(); // refresh prState in the sessions list
			return Response.json(result);
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 502 },
			);
		}
	}

	// Register this session's PR and the one it was stacked on as a GitHub stack.
	// The agent is told to do this itself (buildStackNote), but it skips or
	// fails often enough — and the pairing is knowable server-side — that the
	// PR panel offers it as a button.
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-stack$/) &&
		req.method === "POST"
	) {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-stack$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const stackedOn = session.stackedOn;
		if (!stackedOn?.branch)
			return Response.json(
				{ error: "This session isn't stacked on another branch" },
				{ status: 400 },
			);
		if (!session.branch || !session.worktreeDir)
			return Response.json(
				{ error: "This session has no branch to stack" },
				{ status: 400 },
			);
		// `gh stack link` reads its remote from the working directory and has no
		// --repo flag, so it must run inside the session's own worktree.
		if (!existsSync(session.worktreeDir))
			return Response.json(
				{ error: "This session's worktree is gone — nothing to link from" },
				{ status: 400 },
			);
		const ghRepo = getRepo(stackedOn.repo || session.repo).ghRepo;
		try {
			const [own, base] = await Promise.all([
				prMetaForBranch(session.branch, ghRepo, credential),
				prMetaForBranch(stackedOn.branch, ghRepo, credential),
			]);
			// Both layers must already exist as PRs: we pass URLs precisely so
			// that gh never pushes a branch or opens a PR on our behalf.
			if (!base)
				return Response.json(
					{ error: `No open PR on \`${stackedOn.branch}\` yet — open the base PR first` },
					{ status: 400 },
				);
			if (!own)
				return Response.json(
					{ error: `No PR on \`${session.branch}\` yet — open this session's PR first` },
					{ status: 400 },
				);
			const result = await linkPrStack(
				[base.url, own.url],
				session.worktreeDir,
				credential,
			);
			if ("error" in result) return Response.json(result, { status: 502 });
			// Both panels should show the stack on their next poll, not in 5 min.
			invalidatePrInfo(ghRepo, session.branch);
			invalidatePrInfo(ghRepo, stackedOn.branch);
			return Response.json({ ok: true });
		} catch (e: any) {
			return Response.json({ error: e.message || String(e) }, { status: 502 });
		}
	}

	// Close the session's PR without merging it — human-triggered from Reviews.
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-close$/) &&
		req.method === "POST"
	) {
		const credential = githubMutationCredential(ctx);
		if (!credential) return githubCredentialRequiredResponse();
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-close$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => ({}));
		const target = resolvePrTarget(session, body.repo, body.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);
		const result = await closePr(target.branch, target.ghRepo, credential);
		if ("error" in result) return Response.json(result, { status: 502 });
		markCachedPrClosed(target.ghRepo, result.number);
		invalidateSessionsCache();
		return Response.json(result);
	}

	// Fire a GitHub PR agent behavior straight from the info panel — the same
	// actions the opensession-* PR labels / Slack @mentions kick off (review,
	// auto-fix, simplify, adversarial). tella-fusion only (the agent is
	// repo-scoped), and there must be an open PR for the branch.
	if (
		path.match(/^\/api\/sessions\/(.+)\/pr-action$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/api\/sessions\/(.+)\/pr-action$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => null);
		const kind = body?.kind;
		if (!["review", "autofix", "simplify", "adversarial"].includes(kind))
			return Response.json({ error: "Unknown action" }, { status: 400 });

		const target = resolvePrTarget(session, body?.repo, body?.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);
		// Multi-repo: any repo in the config registry can host PR-agent runs.
		const { repoForFullName } = await import("../../agents/github/constants");
		if (!repoForFullName(target.ghRepo))
			return Response.json(
				{ error: `The PR agent doesn't know the repo ${target.ghRepo}` },
				{ status: 400 },
			);

		let details;
		try {
			details = await getPrDetails(target.branch, target.ghRepo);
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "GitHub's pull request API is unavailable right now." },
				{ status: 502 },
			);
		}
		if (!details?.number)
			return Response.json(
				{ error: "No open PR for this branch yet" },
				{ status: 400 },
			);

		// Auto-fix is code-writing work, not a review pass to post on the PR —
		// so it opens a live session right in this workspace (shares the worktree +
		// branch) and fixes everything there, where you can watch and steer it,
		// instead of firing a headless GitHub-labeled run. The other actions
		// (review / simplify / adversarial) stay headless and post on the PR.
		if (kind === "autofix") {
			const prompt = [
				"/pr-autofix",
				"",
				`Fix everything on PR #${details.number} (“${details.title}”) — branch \`${target.branch}\`.`,
				"Address every reviewer's open feedback and any failing CI, commit and push to the branch,",
				"and reply in each thread you address with honest attribution. Keep going until it's all handled.",
			].join("\n");
			const { id } = await getSessionControl().createSession({
				prompt,
				repo: session.repo || defaultRepo().id,
				mode: "code",
				branch: target.branch,
				parentSessionId: session.id,
				reportBack: false,
				user: requestUser(ctx, body?.user) || "Someone",
			});
			// Hand back the session itself, not just its id: createSession awaits
			// the file write, so the UI can drop the fresh session straight into its
			// list and open the real viewer instead of sitting on a "Starting a
			// new session…" placeholder until the next sessions poll catches up.
			return Response.json({
				ok: true,
				bksId: id,
				openSession: true,
				session: findSession(id) ?? null,
			});
		}

		const { triggerPrAction } = await import("../../agents/github/trigger");
		const result = await triggerPrAction(
			kind,
			details.number,
			requestUser(ctx, body?.user) || "Someone",
			undefined,
			target.ghRepo,
		);
		return Response.json({
			ok: result.ok,
			message: result.message,
			url: result.url,
			bksId: result.bksId,
			...(result.ok ? {} : { error: result.message }),
		});
	}

	return undefined;
}
