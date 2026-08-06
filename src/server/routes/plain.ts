/**
 * Plain (support) routes: triage session hand-off, thread timelines, the Support queue, replies/notes and thread mutations. Human-gated — agent runs never see these as tools.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { listAutomations, runAutomation } from "../automations";
import { findSession, getCachedSessions, invalidateSessionsCache } from "../session-cache";
import { type Workspace } from "../workspaces";

// Land a Plain thread in a triage session: reuse the most recent live
// (non-archived) session already linked to the thread, else kick off the
// "Plain ticket triage" automation with the same context the webhook event
// carries and wait (up to 2 min) for its session to boot. Shared by the
// /plain-triage redirect (Plain support cards) and the JSON API behind the
// Support view's "Triage this ticket" button.
async function resolvePlainTriageSession(
	threadId: string,
): Promise<string | null> {
	const existing = getCachedSessions()
		.filter((s) => s.plainThreadId === threadId && !s.archived)
		.sort(
			(a, b) =>
				new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
		)[0];
	if (existing) return existing.id;

	const automation = listAutomations().find(
		(a) => a.eventKey === "plain:thread_created",
	);
	if (!automation) return null;

	// Build the same payload shape the webhook event carries
	let payload: Record<string, unknown> = { threadId };
	try {
		const { getThreadWithMessages } = await import("../../agents/plain/api");
		const thread = await getThreadWithMessages(threadId);
		payload = {
			threadId,
			title: thread?.title || null,
			previewText: thread?.previewText || thread?.description || null,
			status: thread?.status || null,
			customer: {
				email: thread?.customer?.email?.email || null,
				fullName: thread?.customer?.fullName || null,
			},
		};
	} catch (e) {
		console.error(`[plain-triage] Thread lookup failed for ${threadId}:`, e);
	}

	return new Promise<string | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), 120_000);
		void runAutomation(
			automation,
			(id) => {
				invalidateSessionsCache();
				clearTimeout(timer);
				resolve(id);
			},
			{
				trigger: "event",
				eventContext: JSON.stringify(payload, null, 2),
			},
		);
	});
}

// The Support sidebar's TODO-thread list, cached briefly so a click-through
// of tickets doesn't hammer Plain's API (every open browser polls this).
let plainTodoCache: { data: unknown[]; ts: number } | null = null;
const PLAIN_TODO_TTL = 30_000;
// Workspace users + label types for the Support UI's Assign/Labels menus —
// near-static, so cached long and shared by every open browser.
let plainUsersCache: { data: unknown[]; ts: number } | null = null;
let plainLabelTypesCache: { data: unknown[]; ts: number } | null = null;
const PLAIN_META_TTL = 5 * 60_000;

export async function handlePlainRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Land the user in a Plain triage session for a thread. If one already
	// exists for this thread, jump straight to it; otherwise start a fresh
	// triage run with the same context the automation gets on thread_created.
	// Linked from the Plain support cards.
	const plainTriageMatch = path.match(
		/^\/plain-triage\/([^/]+)$/,
	);
	if (plainTriageMatch && req.method === "GET") {
		const threadId = decodeURIComponent(plainTriageMatch[1]);
		const sessionId = await resolvePlainTriageSession(threadId);
		return new Response(null, {
			status: 302,
			headers: {
				Location: sessionId
					? `${publicPrefix}/session/${sessionId}`
					: `${publicPrefix}/`,
			},
		});
	}

	// Serve one of a thread's attachments (customer screenshots, mostly).
	// Plain hands out signed URLs that expire in ~3 minutes, so we mint one
	// per request and stream the bytes back rather than leaking a URL that
	// would be dead by the time the image is rendered. Cached hard by the
	// browser — attachment bytes are immutable once uploaded.
	const plainAttachmentMatch = path.match(
		/^\/api\/plain\/attachments\/([^/]+)$/,
	);
	if (plainAttachmentMatch && req.method === "GET") {
		const attachmentId = decodeURIComponent(plainAttachmentMatch[1]);
		try {
			const { getAttachmentDownloadUrl } =
				await import("../../agents/plain/api");
			const link = await getAttachmentDownloadUrl(attachmentId);
			if (!link)
				return Response.json({ error: "Not found" }, { status: 404 });

			const upstream = await fetch(link.url);
			if (!upstream.ok || !upstream.body)
				return Response.json(
					{ error: `Attachment fetch failed (${upstream.status})` },
					{ status: 502 },
				);
			// `inline` so images render in the timeline; the filename still
			// drives Save-as. Quotes escaped so a quirky name can't break out.
			const safeName = link.fileName.replace(/["\\]/g, "");
			return new Response(upstream.body, {
				headers: {
					"Content-Type": link.mimeType,
					"Content-Disposition": `inline; filename="${safeName}"`,
					"Cache-Control": "private, max-age=86400",
				},
			});
		} catch (e: any) {
			console.error(`[plain-attachment] ${attachmentId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Attachment fetch failed" },
				{ status: 502 },
			);
		}
	}

	// The conversation timeline for a session's linked Plain thread,
	// flattened for the session viewer's read-only Plain sidebar.
	const plainThreadMatch = path.match(
		/^\/api\/sessions\/(.+)\/plain\/thread$/,
	);
	if (plainThreadMatch && req.method === "GET") {
		const sessionId = decodeURIComponent(plainThreadMatch[1]);
		const session = findSession(sessionId);
		const threadId = session?.plainThreadId;
		if (!threadId)
			return Response.json(
				{ error: "No linked Plain thread" },
				{ status: 400 },
			);
		try {
			const { getThreadWithMessages, normalizePlainThread } =
				await import("../../agents/plain/api");
			const thread = await getThreadWithMessages(threadId);
			if (!thread)
				return Response.json(
					{ error: "Thread not found" },
					{ status: 404 },
				);
			return Response.json({ thread: normalizePlainThread(thread) });
		} catch (e: any) {
			console.error(`[plain-thread] Lookup failed for ${threadId}:`, e);
			return Response.json(
				{ error: e?.message || "Plain lookup failed" },
				{ status: 502 },
			);
		}
	}

	// The Support sidebar's ticket queue: every TODO Plain thread, newest
	// status change first (Plain's own Todo-inbox ordering). Cached ~30s.
	if (path === "/api/plain/threads" && req.method === "GET") {
		if (plainTodoCache && Date.now() - plainTodoCache.ts < PLAIN_TODO_TTL)
			return Response.json({ threads: plainTodoCache.data });
		try {
			const { listTodoThreads } = await import("../../agents/plain/api");
			const threads = await listTodoThreads(100);
			plainTodoCache = { data: threads, ts: Date.now() };
			return Response.json({ threads });
		} catch (e: any) {
			console.error("[plain-threads] List failed:", e);
			return Response.json(
				{ error: e?.message || "Plain lookup failed" },
				{ status: 502 },
			);
		}
	}

	// A thread's conversation timeline by thread id — the session-less
	// Support preview reads this (no session exists for the ticket yet).
	const plainThreadByIdMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)$/,
	);
	if (plainThreadByIdMatch && req.method === "GET") {
		const threadId = decodeURIComponent(plainThreadByIdMatch[1]);
		try {
			const { getThreadWithMessages, normalizePlainThread } =
				await import("../../agents/plain/api");
			const thread = await getThreadWithMessages(threadId);
			if (!thread)
				return Response.json(
					{ error: "Thread not found" },
					{ status: 404 },
				);
			return Response.json({ thread: normalizePlainThread(thread) });
		} catch (e: any) {
			console.error(`[plain-thread] Lookup failed for ${threadId}:`, e);
			return Response.json(
				{ error: e?.message || "Plain lookup failed" },
				{ status: 502 },
			);
		}
	}

	// Human reply into a Plain thread from the Support preview / a
	// session's Plain tab: a customer-facing reply (email/chat, sent as
	// the Plain machine user) or an internal note. This is the human gate
	// itself — agent runs never get this path as a tool; automation runs
	// are denied Plain thread writes at the tool layer.
	const plainReplyMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)\/reply$/,
	);
	if (plainReplyMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainReplyMatch[1]);
		const body = (await req.json().catch(() => null)) as {
			text?: string;
			kind?: string;
			user?: string;
		} | null;
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		const kind = body?.kind === "note" ? "note" : "reply";
		if (!text)
			return Response.json({ error: "Empty message" }, { status: 400 });
		// Plain's API can only impersonate customers, not workspace users, so
		// everything lands as the bot machine user — carry the human's
		// name in the message instead: replies get their first name as an
		// email-style sign-off (unless they already signed), notes get an
		// author prefix.
		const senderName = requestUser(ctx, body?.user);
		const firstName = senderName.split(/\s+/)[0] || "";
		try {
			const { getThreadWithMessages, postNote, sendCustomerReply } =
				await import("../../agents/plain/api");
			if (kind === "note") {
				// Notes need the customer id; the thread lookup carries it.
				const thread = await getThreadWithMessages(threadId);
				const customerId = thread?.customer?.id;
				if (!customerId) throw new Error("Thread has no customer");
				const noteText = firstName
					? `**${senderName} (via Open Session):**\n\n${text}`
					: text;
				const ok = await postNote(threadId, customerId, noteText);
				if (!ok) throw new Error("Plain rejected the note");
			} else {
				const alreadySigned =
					firstName &&
					new RegExp(
						`${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
						"i",
					).test(text.trimEnd());
				const replyText =
					firstName && !alreadySigned
						? `${text.trimEnd()}\n\n${firstName}`
						: text;
				// Their own Plain grant (My accounts → Connect) sends the reply
				// AS THEM; without one (or if Plain rejects the token) the
				// workspace machine user sends it, name carried in the sign-off.
				const { mcpUserGrantToken } = await import("../mcp-oauth");
				const grantToken = senderName
					? mcpUserGrantToken("plain", senderName)
					: undefined;
				const res = await sendCustomerReply(
					threadId,
					"",
					replyText,
					grantToken,
				);
				if (!res.ok) throw new Error("Plain rejected the reply");
				console.log(
					`[plain-reply] ${senderName || "someone"} sent a reply to ${threadId} (as ${res.sentAs})`,
				);
				return Response.json({ ok: true, sentAs: res.sentAs });
			}
			console.log(
				`[plain-reply] ${requestUser(ctx, body?.user) || "someone"} sent a ${kind} to ${threadId}`,
			);
			return Response.json({ ok: true });
		} catch (e: any) {
			console.error(`[plain-reply] ${kind} to ${threadId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Plain write failed" },
				{ status: 502 },
			);
		}
	}

	// Quick status change on a Plain thread from the Support UI: Done
	// closes it, Todo (re)opens/unsnoozes it, Snoozed parks it. Human-gated
	// like the reply route — agent runs never see these paths as tools.
	const plainStatusMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)\/status$/,
	);
	if (plainStatusMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainStatusMatch[1]);
		const body = (await req.json().catch(() => null)) as {
			status?: string;
			durationSeconds?: number;
			user?: string;
		} | null;
		const status = body?.status;
		if (status !== "todo" && status !== "done" && status !== "snoozed")
			return Response.json(
				{ error: "status must be todo, done or snoozed" },
				{ status: 400 },
			);
		try {
			const { setThreadStatus } = await import("../../agents/plain/api");
			await setThreadStatus(
				threadId,
				status,
				typeof body?.durationSeconds === "number"
					? body.durationSeconds
					: undefined,
			);
			plainTodoCache = null; // the queue changed — next poll refetches
			// The sidebar band reads the feeds layer now — bust that cache too.
			try {
				(await import("../feeds")).invalidateFeedCache("plain");
			} catch {}
			console.log(
				`[plain-status] ${requestUser(ctx, body?.user) || "someone"} marked ${threadId} ${status}`,
			);
			return Response.json({ ok: true, status });
		} catch (e: any) {
			console.error(`[plain-status] ${status} on ${threadId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Plain write failed" },
				{ status: 502 },
			);
		}
	}

	// Change a thread's priority (0 = Urgent … 3 = Low).
	const plainPriorityMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)\/priority$/,
	);
	if (plainPriorityMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainPriorityMatch[1]);
		const body = (await req.json().catch(() => null)) as {
			priority?: number;
			user?: string;
		} | null;
		const priority = body?.priority;
		if (
			typeof priority !== "number" ||
			![0, 1, 2, 3].includes(priority)
		)
			return Response.json(
				{ error: "priority must be 0 (Urgent) … 3 (Low)" },
				{ status: 400 },
			);
		try {
			const { setThreadPriority } = await import(
				"../../agents/plain/api"
			);
			await setThreadPriority(threadId, priority);
			plainTodoCache = null;
			console.log(
				`[plain-priority] ${requestUser(ctx, body?.user) || "someone"} set ${threadId} priority ${priority}`,
			);
			return Response.json({ ok: true, priority });
		} catch (e: any) {
			console.error(`[plain-priority] on ${threadId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Plain write failed" },
				{ status: 502 },
			);
		}
	}

	// Mark the customer behind a thread as spam (or undo). Spam lives on
	// the customer in Plain — all their threads get filtered — so marking
	// also closes this thread to get it out of the Todo queue right away.
	const plainSpamMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)\/spam$/,
	);
	if (plainSpamMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainSpamMatch[1]);
		const body = (await req.json().catch(() => null)) as {
			spam?: boolean;
			user?: string;
		} | null;
		const spam = body?.spam !== false;
		try {
			const { getThreadWithMessages, setCustomerSpam, setThreadStatus } =
				await import("../../agents/plain/api");
			const thread = await getThreadWithMessages(threadId);
			const customerId = thread?.customer?.id;
			if (!customerId)
				return Response.json(
					{ error: "Thread has no customer" },
					{ status: 404 },
				);
			await setCustomerSpam(customerId, spam);
			// Plain closes the customer's threads itself on spam-mark (and
			// reopens on unmark) — this explicit close is a best-effort
			// belt-and-braces, so "already in the requested status" is fine.
			let closedThread = false;
			if (spam && thread?.status !== "DONE") {
				closedThread = await setThreadStatus(threadId, "done")
					.then(() => true)
					.catch((e) => {
						if (!/already in the requested status/i.test(e?.message || ""))
							console.error(
								`[plain-spam] Close after spam-mark failed for ${threadId}:`,
								e,
							);
						return false;
					});
			}
			plainTodoCache = null;
			console.log(
				`[plain-spam] ${requestUser(ctx, body?.user) || "someone"} ${spam ? "marked" : "unmarked"} customer ${customerId} (thread ${threadId}) as spam`,
			);
			return Response.json({ ok: true, spam, closedThread });
		} catch (e: any) {
			console.error(`[plain-spam] on ${threadId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Plain write failed" },
				{ status: 502 },
			);
		}
	}

	// Workspace users for the Assign menu (alias accounts filtered out).
	if (path === "/api/plain/users" && req.method === "GET") {
		if (plainUsersCache && Date.now() - plainUsersCache.ts < PLAIN_META_TTL)
			return Response.json({ users: plainUsersCache.data });
		try {
			const { listWorkspaceUsers } = await import(
				"../../agents/plain/api"
			);
			const users = await listWorkspaceUsers();
			plainUsersCache = { data: users, ts: Date.now() };
			return Response.json({ users });
		} catch (e: any) {
			console.error("[plain-users] List failed:", e);
			return Response.json(
				{ error: e?.message || "Plain lookup failed" },
				{ status: 502 },
			);
		}
	}

	// Active label types for the Labels menu.
	if (path === "/api/plain/label-types" && req.method === "GET") {
		if (
			plainLabelTypesCache &&
			Date.now() - plainLabelTypesCache.ts < PLAIN_META_TTL
		)
			return Response.json({ labelTypes: plainLabelTypesCache.data });
		try {
			const { listLabelTypes } = await import("../../agents/plain/api");
			const labelTypes = await listLabelTypes();
			plainLabelTypesCache = { data: labelTypes, ts: Date.now() };
			return Response.json({ labelTypes });
		} catch (e: any) {
			console.error("[plain-label-types] List failed:", e);
			return Response.json(
				{ error: e?.message || "Plain lookup failed" },
				{ status: 502 },
			);
		}
	}

	// Assign a thread to a teammate (or unassign with userId: null).
	const plainAssignMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)\/assign$/,
	);
	if (plainAssignMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainAssignMatch[1]);
		const body = (await req.json().catch(() => null)) as {
			userId?: string | null;
			user?: string;
		} | null;
		const userId =
			typeof body?.userId === "string" && body.userId ? body.userId : null;
		try {
			const { assignThreadToUser } = await import(
				"../../agents/plain/api"
			);
			await assignThreadToUser(threadId, userId);
			console.log(
				`[plain-assign] ${requestUser(ctx, body?.user) || "someone"} ${
					userId ? `assigned ${threadId} to ${userId}` : `unassigned ${threadId}`
				}`,
			);
			return Response.json({ ok: true, userId });
		} catch (e: any) {
			console.error(`[plain-assign] on ${threadId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Plain write failed" },
				{ status: 502 },
			);
		}
	}

	// Toggle labels on a thread: adds take label-type ids, removes take the
	// thread's label instance ids.
	const plainLabelsMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)\/labels$/,
	);
	if (plainLabelsMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainLabelsMatch[1]);
		const body = (await req.json().catch(() => null)) as {
			addLabelTypeIds?: string[];
			removeLabelIds?: string[];
			user?: string;
		} | null;
		const add = Array.isArray(body?.addLabelTypeIds)
			? body.addLabelTypeIds.filter((x) => typeof x === "string" && x)
			: [];
		const remove = Array.isArray(body?.removeLabelIds)
			? body.removeLabelIds.filter((x) => typeof x === "string" && x)
			: [];
		if (!add.length && !remove.length)
			return Response.json(
				{ error: "Nothing to change" },
				{ status: 400 },
			);
		try {
			const { changeThreadLabels } = await import(
				"../../agents/plain/api"
			);
			await changeThreadLabels(threadId, add, remove);
			plainTodoCache = null; // labels show on the queue rows
			console.log(
				`[plain-labels] ${requestUser(ctx, body?.user) || "someone"} changed labels on ${threadId} (+${add.length} −${remove.length})`,
			);
			return Response.json({ ok: true });
		} catch (e: any) {
			console.error(`[plain-labels] on ${threadId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Plain write failed" },
				{ status: 502 },
			);
		}
	}

	// Rename a thread.
	const plainTitleMatch = path.match(
		/^\/api\/plain\/threads\/([^/]+)\/title$/,
	);
	if (plainTitleMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainTitleMatch[1]);
		const body = (await req.json().catch(() => null)) as {
			title?: string;
			user?: string;
		} | null;
		const title = typeof body?.title === "string" ? body.title.trim() : "";
		if (!title)
			return Response.json({ error: "Empty title" }, { status: 400 });
		try {
			const { setThreadTitle } = await import("../../agents/plain/api");
			await setThreadTitle(threadId, title.slice(0, 200));
			plainTodoCache = null; // titles show in the queue
			console.log(
				`[plain-title] ${requestUser(ctx, body?.user) || "someone"} renamed ${threadId}`,
			);
			return Response.json({ ok: true });
		} catch (e: any) {
			console.error(`[plain-title] on ${threadId} failed:`, e);
			return Response.json(
				{ error: e?.message || "Plain write failed" },
				{ status: 502 },
			);
		}
	}

	// JSON twin of the /backstage/plain-triage/<id> redirect: the Support
	// preview's "Triage this ticket" button. Reuses a live session linked to
	// the thread, else starts the triage automation and waits for its
	// session to boot (~15-60s — the client shows a progress state).
	const plainTriageApiMatch = path.match(
		/^\/api\/plain\/triage\/([^/]+)$/,
	);
	if (plainTriageApiMatch && req.method === "POST") {
		const threadId = decodeURIComponent(plainTriageApiMatch[1]);
		const sessionId = await resolvePlainTriageSession(threadId);
		if (!sessionId)
			return Response.json(
				{ error: "Failed to start a triage session" },
				{ status: 502 },
			);
		return Response.json({ sessionId });
	}

	return undefined;
}
