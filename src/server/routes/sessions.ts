/**
 * Session listing, transcripts, transcript search/images, archive/title/status/review overrides, delete.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { cancelAgentRun, isAgentSessionBusy, stopAgentRunTurn } from "../agent-runner";
import { archiveOlderThan, setArchived, unpinArchivedSessions } from "../archive";
import { audit } from "../audit";
import { pendingAsks } from "../asks";
import { transcriptMatchSnippet } from "../jsonl-parser";
import { transcriptDbPath, transcriptStore } from "../transcript-store";
import { clearSessionFileArchive } from "../plain-archive";
import { editPrReviewers, isNoPrError } from "../pr-info";
import { promptQueues, requeueSteerReceipts, stoppedSessions } from "../queue-state";
import { markPrReviewNotified } from "../pr-review-notifications";
import { getReviewRequest, setReviewAccepted, setReviewRequest } from "../review-requests";
import { getSessionControl } from "../session-control";
import { suggestBranchName } from "../suggest-branch";
import { transitionRunState } from "../run-state";
import {
	findSession,
	getCachedSessions,
	invalidateSessionsCache,
	isLegacySideChat,
	runErrors,
} from "../session-cache";
import { searchIndex } from "../session-index";
import { resolvePrTarget } from "../session-repos";
import { destroySessionSandbox } from "../session-sandbox";
import {
	deleteSession,
	engineUserTexts,
	getAllSessions,
	mergedSessionTranscriptAsync,
} from "../sessions";
import { githubLoginFor } from "../shared/user-mappings";
import {
	getOpencodeSubagentTranscript,
	listSessionSubagents,
} from "../opencode-subagents";
import { isManualStatus, setStatusOverride } from "../status-overrides";
import { getSubagentTranscript } from "../subagents";
import { setTitleOverride } from "../title-overrides";
import { buildWorkspaceOverview, resolveTranscriptImage } from "../workspace-overview";
import { type Workspace, deleteWorkspace, getWorkspace } from "../workspaces";
import { removeWorktree, repoForPath } from "../worktree";
import { preparingWorkspaces } from "../ws-hub";
import { existsSync } from "fs";
import { mergedCloudSessions } from "../cloud-proxy";
import {
	githubCredentialRequiredResponse,
	githubMutationCredential,
} from "./github-credential";
import { defaultRepo } from "../config";

const SESSIONS_RESPONSE_TTL_MS = 5_000;
interface SessionsResponseSnapshot {
	text: string;
	hash: string;
	cloudUnreachable: boolean;
	expiresAt: number;
	gzip?: Blob;
}
let sessionsResponseSnapshot: SessionsResponseSnapshot | null = null;

function sessionsListResponse(
	req: Request,
	snapshot: SessionsResponseSnapshot,
): Response {
	const gzip = (req.headers.get("Accept-Encoding") || "").includes("gzip");
	const etag = `"${snapshot.hash}${gzip ? "-gzip" : ""}"`;
	const headers = new Headers({
		"Cache-Control": "private, no-cache",
		"Content-Type": "application/json; charset=utf-8",
		ETag: etag,
		Vary: "Accept-Encoding",
	});
	if (snapshot.cloudUnreachable)
		headers.set("X-OpenSession-Cloud-Unreachable", "true");
	if (gzip) headers.set("Content-Encoding", "gzip");
	if (req.headers.get("If-None-Match") === etag)
		return new Response(null, { status: 304, headers });
	if (!gzip) return new Response(snapshot.text, { headers });
	if (!snapshot.gzip) {
		snapshot.gzip = new Blob([
			Bun.gzipSync(new TextEncoder().encode(snapshot.text)),
		]);
	}
	return new Response(snapshot.gzip, { headers });
}

/**
 * List which of `files` contain `query` (case-insensitive, literal) via
 * ripgrep — the cheap first stage of transcript full-text search. rg exits 1
 * when nothing matches, which we treat as "no hits", not an error. Chunked so a
 * very long file list can't overflow the argv limit.
 */
async function ripgrepFiles(
	query: string,
	files: string[],
): Promise<string[]> {
	const hits = new Set<string>();
	const CHUNK = 1000;
	for (let i = 0; i < files.length; i += CHUNK) {
		const chunk = files.slice(i, i + CHUNK);
		const proc = Bun.spawn(
			["rg", "-l", "-i", "-F", "--no-messages", "--", query, ...chunk],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		for (const line of out.split("\n")) {
			const p = line.trim();
			if (p) hits.add(p);
		}
	}
	return [...hits];
}

export async function handleSessionsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Create a session. REST shape for the native iOS/macOS apps (prompting is
	// WS-only, but creation routes through the same SessionControl path the
	// opensession-sessions MCP tools use — worktree, branch, opening run and
	// all). The web UI keeps its richer create_session WS message.
	if (path === "/backstage/api/sessions" && req.method === "POST") {
		const body = (await req.json().catch(() => null)) as {
			prompt?: unknown;
			repo?: unknown;
			mode?: unknown;
			model?: unknown;
			effort?: unknown;
			fastMode?: unknown;
			images?: unknown;
			branch?: unknown;
			user?: unknown;
		} | null;
		const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
		if (!prompt) {
			return Response.json({ error: "prompt required" }, { status: 400 });
		}
		const mode =
			body?.mode === "code"
				? ("code" as const)
				: body?.mode === "scratch"
					? ("scratch" as const)
					: ("ask" as const);
		let branch = typeof body?.branch === "string" ? body.branch.trim() : "";
		if (mode === "code" && !branch) {
			branch =
				(await suggestBranchName(prompt).catch(() => null)) ||
				`session-${Date.now().toString(36)}`;
		}
		try {
			const { id } = await getSessionControl().createSession({
				prompt,
				mode,
				...(mode === "code" ? { branch } : {}),
				...(typeof body?.repo === "string" && body.repo
					? { repo: body.repo }
					: {}),
				...(typeof body?.model === "string" && body.model
					? { model: body.model }
					: {}),
				...(typeof body?.effort === "string" && body.effort
					? { effort: body.effort }
					: {}),
				...(body?.fastMode === true ? { fastMode: true } : {}),
				// Image attachments as data URLs (the native apps' create path;
				// validated/parsed by the wiring's parseImageDataUrls).
				...(Array.isArray(body?.images) && body.images.length
					? {
							images: body.images.filter(
								(u): u is string => typeof u === "string",
							),
						}
					: {}),
				user: requestUser(ctx, body?.user),
			});
			return Response.json({ id });
		} catch (e) {
			return Response.json(
				{ error: e instanceof Error ? e.message : String(e) },
				{ status: 400 },
			);
		}
	}

	// List sessions
	if (path === "/backstage/api/sessions" && req.method === "GET") {
		if (
			sessionsResponseSnapshot &&
			sessionsResponseSnapshot.expiresAt > Date.now()
		) {
			return sessionsListResponse(req, sessionsResponseSnapshot);
		}
		// Enrich with live, in-process signals that aren't on the cached session
		// objects: whether a run is blocked on a human question (pendingAsks) and
		// how many prompts are queued behind it. Drives the sidebar/tab "needs
		// input" highlight without a second round-trip.
		const enriched = getCachedSessions()
			.filter((s) => !isLegacySideChat(s))
			.map((s) => ({
				...s,
				repo: s.repo || defaultRepo().id,
				waitingForInput: pendingAsks.has(s.id),
				queuedCount: promptQueues.get(s.id)?.length || 0,
				// Worktree still being created by this session's create run — the
				// viewer shows "Waiting for workspace" and queues sends meanwhile.
				...(preparingWorkspaces.has(s.id)
					? { workspacePreparing: true }
					: {}),
				// Terminal failure of the last run (credits/limits/API) — persisted
				// on backstage session files, in-memory for slack/linear sessions.
				lastRunError: runErrors.get(s.id) || s.lastRunError,
			}));
		const { sessions, cloudUnreachable } = await mergedCloudSessions(enriched);
		const text = JSON.stringify(sessions.filter((s) => !isLegacySideChat(s)));
		sessionsResponseSnapshot = {
			text,
			hash: Bun.hash(text).toString(16),
			cloudUnreachable,
			expiresAt: Date.now() + SESSIONS_RESPONSE_TTL_MS,
		};
		return sessionsListResponse(req, sessionsResponseSnapshot);
	}

	// Deliver a follow-up prompt to an existing session. REST shape for the
	// native/extension clients (os1-ios, os1-chrome) — the web UI keeps its
	// richer WS "prompt" message (images, staged files, steer receipts). Same
	// semantics as the opensession-sessions MCP send_to_session: steers a busy
	// run by default, `busy: "queue"` waits behind it, idle starts a fresh turn.
	{
		const m = path.match(/^\/backstage\/api\/sessions\/([^/]+)\/prompt$/);
		if (m && req.method === "POST") {
			const sessionId = decodeURIComponent(m[1]);
			const body = (await req.json().catch(() => null)) as {
				content?: unknown;
				prompt?: unknown;
				user?: unknown;
				busy?: unknown;
			} | null;
			const raw =
				typeof body?.content === "string" && body.content.trim()
					? body.content
					: typeof body?.prompt === "string"
						? body.prompt
						: "";
			const content = raw.trim();
			if (!content) {
				return Response.json({ error: "content required" }, { status: 400 });
			}
			// No findSession pre-check: the 2s session cache can lag a
			// just-created session, and deliverToSession resolves the id (and
			// reports unknown ids) itself.
			const res = await getSessionControl().deliverToSession(
				sessionId,
				content,
				requestUser(ctx, body?.user),
				body?.busy === "queue" ? { busy: "queue" } : undefined,
			);
			if (res.status === "error") {
				return Response.json(
					{ ...res, error: res.message },
					{ status: /no session/i.test(res.message) ? 404 : 400 },
				);
			}
			return Response.json(res);
		}
	}

	// Get transcript for a session
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		// Engine-spanning read: the transcript file plus, for sessions with
		// opencode history, the opencode store (covers legacy opencode
		// sessions from before transcript persistence, and migrated
		// sessions whose history spans engines).
		return Response.json(await mergedSessionTranscriptAsync(session));
	}

	// One transcript entry, unclamped. The WS wire clamps giant entry contents
	// (clampEntriesForWire) — the bubble's "Show full message" fetches the real
	// thing here.
	{
		const m = path.match(
			/^\/backstage\/api\/sessions\/(.+)\/entry\/([^/]+)$/,
		);
		if (m && req.method === "GET") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json({ error: "Session not found" }, { status: 404 });
			const entryId = decodeURIComponent(m[2]);
			// Transcript v2 (docs/transcript-v2-design.md §8): the store keeps the
			// full unstripped entry (blob when the stored row was bounded) —
			// consult it first; unknown ids and store failures fall through to
			// the legacy merged-transcript scan unchanged.
			try {
				const full = transcriptStore().getFullEntry(session.id, entryId);
				// content keeps its exact legacy shape; toolInput/images are
				// additive (existing clients ignore them) — they carry the
				// unstripped fields the bounded store row summarized away.
				if (full)
					return Response.json({
						content: full.content,
						toolInput: full.toolInput,
						images: full.images,
					});
			} catch {
				// store read failed — the legacy scan below still serves the entry
			}
			const entry = (await mergedSessionTranscriptAsync(session)).find(
				(e) => e.id === entryId,
			);
			if (!entry)
				return Response.json({ error: "Entry not found" }, { status: 404 });
			return Response.json({
				content: entry.content,
				toolInput: entry.toolInput,
				images: entry.images,
			});
		}
	}

	// Workspace overview: the opening prompt + all media (screenshots,
	// videos) across the workspace's member chats — feeds the floating
	// preview panel in the session viewer. Images come back as
	// transcript-image refs (below), not inline base64.
	{
		const m = path.match(
			/^\/backstage\/api\/workspaces\/([^/]+)\/overview$/,
		);
		if (m && req.method === "GET") {
			const wsId = decodeURIComponent(m[1]);
			const chats = getCachedSessions().filter(
				(s) => s.projectId === wsId,
			);
			return Response.json(await buildWorkspaceOverview(chats));
		}
	}

	// One image out of a transcript entry, served as real bytes (decoded
	// from the base64 block) so the overview panel can lazy-load and the
	// browser can cache thumbnails instead of shipping data URLs in JSON.
	{
		const m = path.match(
			/^\/backstage\/api\/sessions\/(.+)\/transcript-image\/([^/]+)\/(\d+)$/,
		);
		if (m && req.method === "GET") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json({ error: "Session not found" }, { status: 404 });
			const entryId = decodeURIComponent(m[2]);
			const idx = parseInt(m[3], 10);
			let img = session.transcriptPath
				? await resolveTranscriptImage(session.transcriptPath, entryId, idx)
				: null;
			// Transcript v2 fallback (docs/transcript-v2-design.md §1): entries
			// >32KB are stored with images[] replaced by "os-blob:<uuid>/<i>"
			// markers; the real data-URLs live in the store's full entry. When the
			// mirror can't resolve the image, decode it from there. Guarded on the
			// DB file existing — not the flag — so images keep serving through
			// kill-switch windows.
			if (!img && existsSync(transcriptDbPath())) {
				try {
					const src = transcriptStore().getFullEntry(session.id, entryId)
						?.images?.[idx];
					if (typeof src === "string") {
						if (!src.startsWith("data:")) {
							img = { redirect: src };
						} else {
							const dm = src.match(/^data:([^;,]+);base64,(.*)$/s);
							if (dm) {
								const buf = Buffer.from(dm[2], "base64");
								img = {
									bytes: buf.buffer.slice(
										buf.byteOffset,
										buf.byteOffset + buf.byteLength,
									) as ArrayBuffer,
									contentType: dm[1],
								};
							}
						}
					}
				} catch {
					// store read failed — fall through to the 404 below
				}
			}
			if (!img)
				return Response.json({ error: "Image not found" }, { status: 404 });
			if ("redirect" in img)
				return Response.redirect(img.redirect, 302);
			return new Response(img.bytes, {
				headers: {
					"Content-Type": img.contentType,
					"Content-Length": String(img.bytes.byteLength),
					// A transcript entry never changes once written — cache hard.
					"Cache-Control": "private, max-age=86400, immutable",
				},
			});
		}
	}

	// Full-text search across session transcripts (the ⌘K palette's
	// "search in conversations"). Two-stage: a cheap ripgrep pass narrows
	// hundreds of transcripts to the few that contain the query, then we
	// parse only those (cached) to pull a clean snippet — which also drops
	// matches that only occur in transcript metadata (base64, JSON keys).
	if (path === "/backstage/api/sessions/search" && req.method === "GET") {
		const q = (url.searchParams.get("q") || "").trim();
		if (q.length < 2) return Response.json({ matches: [] });
		const byPath = new Map<string, string>(); // transcriptPath → sessionId
		for (const s of getCachedSessions()) {
			if (
				!isLegacySideChat(s) &&
				s.transcriptPath &&
				!byPath.has(s.transcriptPath) &&
				existsSync(s.transcriptPath)
			)
				byPath.set(s.transcriptPath, s.id);
		}
		const files = [...byPath.keys()];
		if (!files.length) return Response.json({ matches: [] });
		const matches: Array<{ id: string; snippet: string }> = [];
		for (const f of await ripgrepFiles(q, files)) {
			const id = byPath.get(f);
			if (!id) continue;
			const snippet = transcriptMatchSnippet(f, q);
			if (snippet) matches.push({ id, snippet });
			if (matches.length >= 50) break;
		}
		return Response.json({ matches });
	}

	// Every sub-agent this session spawned (opencode task-tool children +
	// Claude-SDK subagent layout) — feeds the Agents tab's sub-agents card.
	{
		const m = path.match(/^\/backstage\/api\/sessions\/(.+)\/subagents$/);
		if (m && req.method === "GET") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json(
					{ error: "Session not found" },
					{ status: 404 },
				);
			return Response.json({
				subagents: listSessionSubagents(session),
				sessionRunning: session.isRunning,
			});
		}
	}

	// Sub-agent (Task/Agent) conversation for a session. The agentId is either
	// a Task tool_result's `agentId` (Claude SDK layout) or an opencode child
	// session id (ses_…) from the task tool / the subagents list above.
	{
		const m = path.match(
			/^\/backstage\/api\/sessions\/(.+)\/subagent\/([^/]+)$/,
		);
		if (m && req.method === "GET") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json(
					{ error: "Session not found" },
					{ status: 404 },
				);
			const agentId = decodeURIComponent(m[2]);
			const sub =
				(session.transcriptPath
					? await getSubagentTranscript(session.transcriptPath, agentId)
					: null) ?? getOpencodeSubagentTranscript(session, agentId);
			if (!sub)
				return Response.json(
					{ error: "Sub-agent not found" },
					{ status: 404 },
				);
			return Response.json({ ...sub, sessionRunning: session.isRunning });
		}
	}

	// Bulk-archive idle sessions
	if (
		path === "/backstage/api/sessions/archive-old" &&
		req.method === "POST"
	) {
		const body = await req.json().catch(() => ({}));
		const days = Math.max(1, parseInt(body.days) || 7);
		const count = archiveOlderThan(getAllSessions(), days);
		invalidateSessionsCache();
		return Response.json({ archived: count });
	}

	// Archive / unarchive a single session
	const archiveMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/archive$/,
	);
	if (archiveMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(archiveMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = await req.json().catch(() => ({}));
		const archived = body.archived !== false;
		// Archiving means "I'm done with this" — so stop an owned in-flight
		// run rather than leaving an orphaned turn burning tokens after the
		// session already reads as archived. Only runs owned by this process
		// (busyHere) are stoppable; external/CLI runs can't be reached from
		// here. Graceful Esc-style stop (fall back to hard cancel for runs
		// with no interrupt support) keeps the transcript clean and resumable
		// on unarchive.
		let stoppedRun = false;
		if (
			archived &&
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		) {
			// Park the queue so the drain doesn't feed requeued steers into a
			// fresh run as the stopped one winds down.
			stoppedSessions.add(session.id);
			const stopped = stopAgentRunTurn([
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			]);
			if (!stopped) {
				cancelAgentRun(
					session.claudeSessionId,
					session.codexThreadId,
					session.id,
				);
			}
			audit({
				msg: "run_cancelled",
				bks_session_id: session.id,
				source: "archive",
				graceful: stopped,
			});
			transitionRunState(session.id, "cancel", { source: "archive" });
			requeueSteerReceipts(session.id, engineUserTexts(session));
			stoppedRun = true;
		}
		setArchived(sessionId, archived);
		// Plain done-tickets are archived via a file-level flag, not the
		// registry; clearing only the registry would leave them archived. On
		// unarchive, also clear the file flag so the session returns to "My
		// sessions".
		if (!archived) clearSessionFileArchive(sessionId);
		invalidateSessionsCache();
		if (archived) {
			// setArchived drops the plain id pin; also drop legacy alias-id pins,
			// and the workspace pin once its last live chat is archived (else the
			// row resurfaces in Pinned when a new chat joins the workspace).
			unpinArchivedSessions([session], getAllSessions());
		}
		return Response.json({ ok: true, stoppedRun });
	}

	// Rename a session (manual display title; empty/blank clears it back to
	// the derived title). Works for any source via the override registry.
	const titleMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/title$/,
	);
	if (titleMatch && req.method === "PUT") {
		const sessionId = decodeURIComponent(titleMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = await req.json().catch(() => ({}));
		const title =
			typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";
		setTitleOverride(sessionId, title || null);
		invalidateSessionsCache();
		return Response.json({ ok: true });
	}

	// Set (or clear) a session's manual sidebar-lane. `status` is one of the
	// lane keys (needsinput/inprogress/review/merged/pending); null/invalid
	// clears the override back to the derived lane.
	const statusMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/status$/,
	);
	if (statusMatch && req.method === "PUT") {
		const sessionId = decodeURIComponent(statusMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = await req.json().catch(() => ({}));
		const status = isManualStatus(body?.status) ? body.status : null;
		setStatusOverride(sessionId, status);
		invalidateSessionsCache();
		return Response.json({ ok: true });
	}

	// Set (or clear) a session's review request — the info panel's Reviewer
	// picker. `reviewer` is a teammate display name; null/empty clears the
	// request. Setting one pushes a "needs your review" notification to the
	// reviewer's registered devices (mirrors the needs-input ask push).
	const reviewMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/review$/,
	);
	if (reviewMatch && req.method === "PUT") {
		const sessionId = decodeURIComponent(reviewMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = await req.json().catch(() => ({}));
		const by = requestUser(ctx, body?.by).slice(0, 40);

		// Accept / reopen the current request (the reviewer signing off). Keeps
		// the reviewer assignment intact but flips it to a "Reviewed" state that
		// the asker sees in their sidebar. Distinct from setting/clearing a
		// reviewer below, so it never touches GitHub's Reviewers list.
		if (typeof body?.accept === "boolean") {
			const existing = getReviewRequest(sessionId);
			if (!existing)
				return Response.json(
					{ error: "No review request to accept" },
					{ status: 400 },
				);
			setReviewAccepted(
				sessionId,
				body.accept ? { by: by || "someone", at: new Date().toISOString() } : null,
			);
			invalidateSessionsCache();
			// Buzz whoever asked for the review that it landed (not on self-review).
			if (
				body.accept &&
				existing.by &&
				existing.by.toLowerCase() !== (by || "").toLowerCase()
			) {
				void (async () => {
					try {
						const { sendPushToUser } = await import("../../server/push");
						await sendPushToUser(existing.by, {
							title: "Review complete",
							body: `${by || "Someone"} reviewed ${session.title || sessionId}`.slice(0, 180),
							url: `/backstage/session/${encodeURIComponent(sessionId)}`,
							tag: `review-${sessionId}`,
						});
					} catch {}
				})();
			}
			return Response.json({ ok: true });
		}

		const reviewer =
			typeof body?.reviewer === "string"
				? body.reviewer.trim().slice(0, 40)
				: "";
		const prevReviewer = getReviewRequest(sessionId)?.to;
		// Mirror the request onto GitHub's own Reviewers list before committing the
		// local assignment, so an auth/API failure cannot leave the two disagreeing.
		// setting a reviewer adds them, re-assigning swaps, clearing removes.
		// Only for sessions with a branch/PR whose reviewer maps to a GitHub
		// login — a phone buzz always fires below regardless.
		const addLogin = reviewer ? githubLoginFor(reviewer) : null;
		const removeLogin =
			prevReviewer && prevReviewer !== reviewer
				? githubLoginFor(prevReviewer)
				: null;
		const target = resolvePrTarget(session, body?.repo);
		// Whether the reviewer actually reached GitHub's list — false when there
		// was no PR to mirror onto, which the push marker below depends on.
		let mirroredToGithub = false;
		if (target && (addLogin || removeLogin)) {
			const credential = githubMutationCredential(ctx);
			if (!credential) return githubCredentialRequiredResponse();
			const mirrored = await editPrReviewers(
				target.branch,
				{ add: addLogin, remove: removeLogin },
				target.ghRepo,
				credential,
			).catch((e: any) => ({ error: e?.message || String(e) }));
			// `resolvePrTarget` resolves from branch metadata alone, so it yields a
			// target for a branch that has no PR yet — asking a teammate to look at
			// a session before it has one is normal. That's an answer, not a
			// failure: there is nothing to mirror, so the local request stands on
			// its own. Every other error still blocks, so a PR that DOES exist can
			// never silently disagree with the request stored here.
			if ("error" in mirrored) {
				if (!isNoPrError(mirrored.error))
					return Response.json(mirrored, { status: 502 });
			} else mirroredToGithub = true;
		}
		setReviewRequest(
			sessionId,
			reviewer
				? { to: reviewer, by: by || "someone", at: new Date().toISOString() }
				: null,
		);
		invalidateSessionsCache();
		if (reviewer) {
			// Only suppress the watcher's own push when the request really landed on
			// GitHub; marking a skipped mirror would swallow a later genuine one.
			if (mirroredToGithub && target && addLogin)
				markPrReviewNotified(target.ghRepo, target.branch, reviewer);
			// Best-effort phone buzz — never let a push hiccup fail the request.
			void (async () => {
				try {
					const { sendPushToUser } = await import("../../server/push");
					await sendPushToUser(reviewer, {
						title: "Needs your review",
						body: `${by || "Someone"} asked you to review ${session.title || sessionId}`.slice(0, 180),
						url: `/backstage/session/${encodeURIComponent(sessionId)}`,
						tag: `review-${sessionId}`,
					});
				} catch {}
			})();
		}
		return Response.json({ ok: true });
	}

	// Delete a session (+ optional worktree cleanup)
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)$/) &&
		req.method === "DELETE"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const cleanWorktree = url.searchParams.get("worktree") === "true";
		// Purge any transcript-v2 store rows for a deleted session. Guarded on
		// the DB file existing — NOT the flag — so a kill-switch window can't
		// leave resurrectable rows behind for deterministic session ids
		// (bks-ghpr-*). Best-effort: a store hiccup must never block deletion.
		const purgeTranscriptRows = (id: string) => {
			try {
				if (existsSync(transcriptDbPath()))
					transcriptStore().deleteSessionTranscript(id);
			} catch {}
			try {
				searchIndex().remove(`session:${id}`);
			} catch {}
		};
		try {
			// Cascade-delete legacy side-chat records with their parent. They remain
			// hidden after the feature's removal, so orphaning them would leave
			// unreachable files on disk.
			for (const child of getAllSessions().filter(
				(s) => s.sideChatOf === sessionId,
			)) {
				try {
					deleteSession(child);
					destroySessionSandbox(child, "delete");
				} catch {}
				purgeTranscriptRows(child.id);
			}
			deleteSession(session);
			purgeTranscriptRows(session.id);
			invalidateSessionsCache();
			// Tear down the session's sandbox (container + engine-state volumes —
			// and in volume-workspace mode the workspace volume itself; that data
			// loss is the mode's documented contract). Best-effort and detached:
			// a docker hiccup must never block the delete.
			destroySessionSandbox(session, "delete");
			// If that was the workspace's last chat, delete the workspace too —
			// otherwise auto-wrapped 1:1 workspaces linger as undeletable empty
			// sidebar rows. PR-backed workspaces (`key`) stay: they regroup new
			// chats for the same PR.
			if (session.projectId) {
				const ws = getWorkspace(session.projectId);
				const members = getAllSessions().filter(
					(s) => s.projectId === session.projectId,
				);
				if (ws && !ws.key && members.length === 0)
					deleteWorkspace(ws.id);
			}
			if (cleanWorktree && session.worktreeDir && session.branch) {
				await removeWorktree(
					session.branch,
					repoForPath(session.worktreeDir).id,
				);
			}
			return Response.json({ ok: true });
		} catch (e: any) {
			return Response.json({ error: e.message }, { status: 500 });
		}
	}

	return undefined;
}
