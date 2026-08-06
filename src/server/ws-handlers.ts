/**
 * The UI WebSocket: watch/unwatch sessions, live prompts and queue control,
 * question answers, terminals, collaborative notes — plus the
 * create_session flow. Extracted verbatim from opensession.ts; sandbox
 * transport sockets are delegated to run-ws.ts before any of this runs.
 */

import type { WebSocketHandler } from "bun";
import type { WSClientData } from "./ws-hub";
import { type StreamEvent, cancelAgentRun, interruptAndSteerAgentRun, isAgentSessionBusy, markSessionStarting, runAgent, steerAgentRun, stopAgentRunTurn, unmarkSessionStarting } from "./agent-runner";
import { isLocalSessionUpgradeInProgress } from "./session-transfer-state";
import { audit } from "./audit";
import { makeAskHandler, pendingAsks } from "./asks";
import { mentionedUsers } from "./people";
import { sendPushToUser } from "./push";
import { getAccountById } from "./claude-accounts";
import { getCodexAccountById } from "./codex-accounts";
import { startWatching, stopAllWatchesForClient, transcriptRev } from "./file-watcher";
import { buildForkHandoffNote } from "./fork-handoff";
import { ensureGeneratedTitle } from "./generated-titles";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { interactiveMcpServers } from "./interactive-mcp";
import { INIT_WIRE_CLAMP_BYTES, clampEntriesForWire, parseTranscriptAsync, parseTranscriptTail, parseTranscriptWindow } from "./jsonl-parser";
import { accountProviderForModel, interactiveDefaultModel, interactiveFallbackModel, modelLabel, providerFor, resolveModel } from "./models";
import { applyNoteUpdate, getNoteState, isValidNoteId } from "./notes";
import { appendOpencodeTranscript, clearTranscriptStoreDegraded, transcriptLineRunnerNotice } from "./opencode-transcript";
import { wrapContext } from "./prompt-context";
import { deleteQueuedPrompt, persistQueues, promptQueues, queueWithIds, recordSteer, reorderQueuedPrompt, requeueSteerReceipts, steeredReceipts, stoppedSessions, updateQueuedPrompt } from "./queue-state";
import { transitionRunState } from "./run-state";
import { abortTurnAndDrain, attachSessionWatchersToEngineTranscript, drainQueue, enqueuePrompt, foldSessionUsage, interruptQueuedPrompt, maybeLaunchSandboxedRun, runSessionPrompt, runSessionPromptAndDrain, sessionMentionsNote, steerQueuedPrompt, watchExternalRunAndDrain } from "./run-session";
import { sandboxWsClose, sandboxWsMessage, sandboxWsOpen } from "./run-ws";
import { nodeWsClose, nodeWsMessage, nodeWsOpen } from "./node-ws";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { type Sandbox, hasRemoteWorkspace } from "./sandbox";
import { isRemoteSandboxProvider, resolveRequestedSandbox, sandboxConfig, sandboxesEnabled } from "./sandbox/config";
import { SESSION_EFFORTS, findSession, invalidateSessionsCache, maybePersistEffort, maybePersistFastMode, recordRunOutcome, touchNativeSession, updateSessionFile } from "./session-cache";
import { buildBranchNote, buildPlanFirstNote, memoryNoteFor, workspaceOwningWorktree } from "./session-repos";
import { engineSessionPatch, engineUserTexts, mergedSessionTranscript, mergedSessionTranscriptAsync, v2MirrorFiles, v2TranscriptHasDrift } from "./sessions";
import { handleSlashCommand } from "./slash-commands";
import { maybeRecapOnReturn } from "./recap";
import { resizeTerminal, startSessionTerminal, stopAllTerminals, stopTerminal, writeTerminal } from "./terminals";
import { subscribeTranscript } from "./transcript-bus";
import { resumeSessionFeed } from "./session-feed";
import { type SeqEntry, transcriptStore } from "./transcript-store";
import { startTranscriptWatch } from "./transcript-watch";
import { type NativeSessionFile, type SessionUsage } from "./types";
import { shouldPersistModelSwitch } from "./run-events";
import { MAX_UPLOAD_BYTES, WS_MAX_PAYLOAD_BYTES, asDataUrlList, parseImageDataUrls, stageFileAttachments, withUploadsNote } from "./uploads";
import { type Workspace, createWorkspace, getWorkspace, updateWorkspace } from "./workspaces";
import { ownedWorktree } from "./session-workspace";
import { resolvePlainWorkspace } from "./workspace-resolve";
import { createWorktree, createWorktreeForExistingBranch, ensureAskCheckout, ensureScratchDir, getRepo, listWorktrees, repoForPath, resolveUniqueBranch, sharedCheckoutForNewSessions, worktreeHeadBranch, worktreePathFor } from "./worktree";
import { sanitizeBranchSlug } from "./suggest-branch";
import { BOOT_ID, allClients, b64decode, b64encode, broadcastToNote, broadcastToSession, joinNote, joinSession, leaveNote, leaveSession, preparingWorkspaces, revalidateLocalClients, setClientAway } from "./ws-hub";
import { randomUUIDv7 } from "bun";
import { userMatchesAny } from "./shared/user-mappings";
import { existsSync, readFileSync, statSync, watch } from "fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	cloudWebSocketClientClosed,
	routeCloudWebSocketMessage,
	verifiedCloudIdentity,
} from "./cloud-proxy";
import { isLocalProfile, setLocalProfileIdentity } from "./profile";
import { newSessionId } from "./paths";
import {
	closeCloudProxyProtocol,
	handleCloudProxyProtocolMessage,
} from "./cloud-proxy-protocol";

// Who likely triggered the restart that booted THIS process — read once from
// the marker the previous process wrote in gracefulShutdown, and only trusted
// when the shutdown was recent (a stale marker from days ago means this boot
// wasn't that restart). Parked on globalThis so hot reloads keep the value.
function lastRestartBy(): string {
	const g = globalThis as any;
	if (g.__lastRestartBy === undefined) {
		g.__lastRestartBy = "";
		try {
			const d = JSON.parse(
				readFileSync(join(homedir(), ".opensession-last-restart.json"), "utf8"),
			);
			if (d?.by && Date.now() - Date.parse(d.at) < 10 * 60_000)
				g.__lastRestartBy = String(d.by);
		} catch {}
	}
	return g.__lastRestartBy;
}

/**
 * The non-transcript half of the watch handshake — pending question, queue +
 * steer receipts, running status. Sent on both watch paths: the full-snapshot
 * one AND the sinceOffset resume (these are cheap and idempotent; the client
 * replaces rather than merges them).
 */
function sendWatchExtras(
	ws: any,
	sessionId: string,
	session: NonNullable<ReturnType<typeof findSession>>,
): void {
	const pendingAsk = pendingAsks.get(sessionId);
	if (pendingAsk) {
		ws.send(
			JSON.stringify({
				type: "ask_question",
				sessionId,
				questionId: pendingAsk.questionId,
				questions: pendingAsk.questions,
			}),
		);
	}

	// Older in-memory rows may lack ids; assign and persist them before
	// sending so edit/delete/steer actions can address the same row.
	const queuedPrompts = queueWithIds(promptQueues.get(sessionId));
	const steeredPrompts = queueWithIds(steeredReceipts.get(sessionId));
	if (queuedPrompts.length > 0) promptQueues.set(sessionId, queuedPrompts);
	if (steeredPrompts.length > 0) steeredReceipts.set(sessionId, steeredPrompts);
	if (queuedPrompts.length > 0 || steeredPrompts.length > 0) persistQueues();
	ws.send(
		JSON.stringify({
			type: "queue_update",
			sessionId,
			queued: queuedPrompts,
			steered: steeredPrompts,
		}),
	);

	ws.send(
		JSON.stringify({
			type: "session_status",
			sessionId,
			isRunning:
				session.isRunning ||
				isAgentSessionBusy(
					session.claudeSessionId,
					session.codexThreadId,
					session.id,
				),
		}),
	);

	// The transcript snapshot above is authoritative. Replay the bounded live
	// phase after it, or send an active snapshot when the cursor cannot resume.
	if (ws.data?.supportsFeed) {
		const { frames, snapshot } = resumeSessionFeed(
			sessionId,
			ws.data.sinceFeedSeq,
			ws.data.feedEpoch,
		);
		for (const frame of frames) ws.send(JSON.stringify(frame));
		ws.send(JSON.stringify(snapshot));
	}
}

// ── Transcript v2 serve path (docs/transcripts.md §4) ──────────────
// Capability-gated: the client sends `supportsSeq: true` on watch. Eligible
// watches are served from the owned transcript store and fed live by the
// in-process bus — no mirror file-watcher polling. The legacy offset/rev
// watch below stays as the serve path for external CLI/tmux sessions and as
// the code-level fallback whenever the v2 serve refuses or throws (the env
// kill switch was retired with the mirror writes, 2026-07-23).

// Per-socket bus unsubscribe handles. Parked on globalThis so a hot reload
// can still tear down subscriptions made by the previous module instance
// (same reason file-watcher parks its watch map).
const v2Unsubs: Map<unknown, () => void> = ((globalThis as any)
	.__osTranscriptV2Unsubs ??= new Map());

/**
 * The ONE v2 teardown helper — called from all three paths that end a
 * socket's view of a session (mirroring stopAllWatchesForClient's contract):
 * watch-switch (re-watch of a different session on the same socket), unwatch,
 * and close. Releases the bus subscription and clears the v2 mark so the
 * rotation re-watch (run-session.ts) treats the socket as legacy again.
 */
function releaseTranscriptV2(ws: any): void {
	const unsub = v2Unsubs.get(ws);
	if (unsub) {
		v2Unsubs.delete(ws);
		try {
			unsub();
		} catch {}
	}
	if (ws?.data?.transcriptV2) ws.data.transcriptV2 = false;
}

/** Legacy transcripts above this mirror-file size import in the background
 *  (this watch serves legacy) instead of blocking the watch handshake — the
 *  §4 "import timeout → legacy + queued background import" behavior, applied
 *  proactively by size since the import itself is synchronous. */
const V2_SYNC_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** Session ids with a background import scheduled (dedupe). */
const v2BgImports: Set<string> = ((globalThis as any).__osTranscriptV2BgImports ??=
	new Set());

/**
 * §4 snapshot clamp: v2 store rows are wire-bounded at 32KB, but the legacy
 * transcript-open payload clamps entries to INIT_WIRE_CLAMP_BYTES (8KB — the
 * e4e2340a slow-transcript fix; the UI eagerly renders ~6KB per bubble and
 * fetches the full entry on "Show more" anyway), so v2 init/history/backlog
 * pages go through the same budget. Same markers as clampEntriesForWire,
 * except an already-store-stripped entry keeps its original contentLength
 * (the true pre-strip length) instead of the 32KB form's. Live
 * transcript_append frames keep the fatter store forms, same as legacy
 * appends.
 */
function clampV2InitEntries(entries: SeqEntry[]): SeqEntry[] {
	if (!entries.some((e) => (e.content?.length ?? 0) > INIT_WIRE_CLAMP_BYTES))
		return entries;
	return entries.map((e) =>
		(e.content?.length ?? 0) <= INIT_WIRE_CLAMP_BYTES
			? e
			: {
					...e,
					content: e.content.slice(0, INIT_WIRE_CLAMP_BYTES),
					contentClamped: true,
					contentLength: e.contentLength ?? e.content.length,
				},
	);
}

/** Legacy (re-)import for a session (same routine as §3's import-first
 *  gate): merged cross-engine history → importLegacyTranscript (which marks
 *  the session imported; empty history marks 'live-only'). Watermark = the
 *  TOTAL size of the §8 drift candidate set (session transcript file + oc
 *  mirror — the exact set v2TranscriptHasDrift compares against; measuring
 *  only transcriptPath would leave opencode sessions permanently
 *  grown-beyond-watermark). Also the drift RE-import: idempotent upserts, and
 *  a completed import releases the failure-side store-degraded marker. */
function v2ImportSession(
	session: NonNullable<ReturnType<typeof findSession>>,
): void {
	// Deliberately id-less ref: guarantees the legacy merge — an id-carrying
	// ref would route mergedSessionTranscript back into the v2 store path,
	// which on a drift re-import is exactly what we're refreshing.
	const entries = mergedSessionTranscript({
		transcriptPath: session.transcriptPath ?? null,
		opencodeSessionId: session.opencodeSessionId,
		claudeSessionId: session.claudeSessionId ?? null,
	});
	v2FinishImport(session, entries);
}

/** v2ImportSession for the background queue: the merge parse yields to the
 *  event loop (mergedSessionTranscriptAsync), so a multi-MB legacy transcript
 *  — exactly what gets routed here by the sync-import size ceiling — no
 *  longer wedges the server for the duration of the parse. */
async function v2ImportSessionAsync(
	session: NonNullable<ReturnType<typeof findSession>>,
): Promise<void> {
	const entries = await mergedSessionTranscriptAsync({
		transcriptPath: session.transcriptPath ?? null,
		opencodeSessionId: session.opencodeSessionId,
		claudeSessionId: session.claudeSessionId ?? null,
	});
	v2FinishImport(session, entries);
}

function v2FinishImport(
	session: NonNullable<ReturnType<typeof findSession>>,
	entries: ReturnType<typeof mergedSessionTranscript>,
): void {
	let watermark: number | null = null;
	try {
		const files = v2MirrorFiles(session);
		if (files.length) watermark = files.reduce((sum, f) => sum + f.size, 0);
	} catch {}
	transcriptStore().importLegacyTranscript(
		session.id,
		entries,
		entries.length ? "merged" : "live-only",
		watermark,
	);
	clearTranscriptStoreDegraded(
		session.id,
		session.opencodeSessionId,
		session.claudeSessionId,
	);
}

/** Queue an off-handshake import. `reimport` = the session is already
 *  imported but drifted (serveTranscriptV2's §8 check) — run the import even
 *  though needsImport is false; without it only never-imported sessions load. */
function v2QueueBackgroundImport(sessionId: string, reimport = false): void {
	if (v2BgImports.has(sessionId)) return;
	v2BgImports.add(sessionId);
	setTimeout(async () => {
		try {
			const session = findSession(sessionId);
			if (session && (reimport || transcriptStore().needsImport(sessionId)))
				await v2ImportSessionAsync(session);
		} catch (e) {
			console.warn(`[ws] v2 background import failed for ${sessionId}:`, e);
		} finally {
			v2BgImports.delete(sessionId);
		}
	}, 0);
}

/**
 * Serve a watch from the v2 store + bus. Returns true when the watch was
 * fully served (caller sends the watch extras and stops); false = not
 * eligible / import deferred / flag off — fall through to the untouched
 * legacy path.
 */
function serveTranscriptV2(
	ws: any,
	sessionId: string,
	session: NonNullable<ReturnType<typeof findSession>>,
	msg: any,
): boolean {
	if (msg.supportsSeq !== true) return false;
	// Plain loop runs don't thread a unified session id to the runner (§3), so
	// their store rows would be forever partial — refuse v2, keep legacy.
	// (Linear runs DO since transcriptSessionId landed; they lazy-import here
	// like any other session, and appends from runs started before the
	// enabling restart degrade safely via the §8 store-degraded/drift path.)
	if (sessionId.startsWith("plain-")) return false;
	// Externally-owned runs (CLI/tmux: running via PID but not in our
	// activeRuns — session-control's observe-only signal) write only their
	// transcript file. The file-watcher feeds parsed appends into the store
	// (file-watcher.ts feedTranscriptStore), but that feed only runs while
	// some legacy watch exists — a v2-only viewer set would have no feeder,
	// so v2 here would render silently stale mid-run. The refusal stays until
	// a socket-independent feed lifecycle exists — the one remaining step of
	// mirror retirement (design doc §11); mirror writes themselves are gone.
	if (
		session.isRunning &&
		!isAgentSessionBusy(session.claudeSessionId, session.codexThreadId, session.id)
	)
		return false;

	let store: ReturnType<typeof transcriptStore>;
	try {
		store = transcriptStore();
		if (store.needsImport(sessionId)) {
			// Lazy import: small legacy transcripts import synchronously inside
			// the watch; big ones import in the background and THIS watch serves
			// legacy (the next one upgrades). The ceiling measures the WHOLE §8
			// candidate set (session transcript file + oc mirror) — transcriptPath
			// alone undercounts opencode sessions, whose history mostly lives in
			// the mirror.
			let mirrorSize = 0;
			try {
				for (const f of v2MirrorFiles(session)) mirrorSize += f.size;
			} catch {}
			if (mirrorSize > V2_SYNC_IMPORT_MAX_BYTES) {
				v2QueueBackgroundImport(sessionId);
				return false;
			}
			v2ImportSession(session);
		} else if (v2TranscriptHasDrift(store, sessionId, session)) {
			// Imported but stale (§8): the mirror grew in a way the store can't
			// explain — external CLI/tmux runs while we were idle, unmapped oc
			// ids, failed store appends, kill-switch windows — or the failure-side
			// store-degraded flag is set. The bus never fires for those entries,
			// so serving v2 would render silently stale. Queue the background
			// re-import (idempotent upserts; clears the flag) and fall through to
			// the legacy file-watcher path for THIS watch — live external appends
			// keep streaming; the next watch upgrades to v2.
			v2QueueBackgroundImport(sessionId, true);
			return false;
		}
	} catch (e) {
		console.warn(`[ws] v2 import failed for ${sessionId} — legacy path:`, e);
		return false;
	}

	// From here this socket is a v2 viewer for this session. The extracted
	// protocol subscribes BEFORE reading and treats bus events as wake-ups for
	// durable changeSeq reconciliation, closing both handshake and reconnect
	// rewrite gaps.
	ws.data.transcriptV2 = true;
	try {
		const watch = startTranscriptWatch({
			sessionId,
			store,
			socket: ws,
			subscribe: subscribeTranscript,
			isCurrent: () =>
				ws.data?.watchingSessionId === sessionId && !!ws.data?.transcriptV2,
			...(msg.supportsChangeSeq === true && typeof msg.sinceChangeSeq === "number"
				? { sinceChangeSeq: msg.sinceChangeSeq }
				: {}),
			clampSnapshot: clampV2InitEntries,
			formatAppend: (frame, event) =>
				ws.data?.supportsFeed && event?.feed
					? { ...event.feed, event: frame }
					: frame,
		});
		v2Unsubs.set(ws, () => watch.unsubscribe());
	} catch (error) {
		ws.data.transcriptV2 = false;
		throw error;
	}
	return true;
}

export const websocketHandlers: WebSocketHandler<WSClientData> = {
	// Default is 16 MB — too small for a base64'd attachment near MAX_UPLOAD_BYTES,
	// which would otherwise drop the frame (close 1009) before staging. See above.
	maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
	open(ws) {
		// Sandbox transport sockets (run hosts / MCP proxies dialing back)
		// are not UI clients — run-ws.ts owns them entirely.
		if (sandboxWsOpen(ws)) return;
		// Execution-node channels are not UI clients either (node-ws.ts).
		if (nodeWsOpen(ws)) return;
		allClients.add(ws);
		// Hello frame: hands the client this process's bootId so a reconnect
		// can tell a real restart (bootId changed → "restarted" toast) from a
		// transient socket blip (unchanged → clear the reconnecting pill
		// silently). Clients on servers without this frame fall back to
		// polling /api/health, which also carries bootId. `restartBy` names the
		// session that likely triggered the restart (marker written by the OLD
		// process's shutdown — see gracefulShutdown) so the toast can say who.
		try {
			ws.send(
				JSON.stringify({
					type: "hello",
					bootId: BOOT_ID,
					...(lastRestartBy() ? { restartBy: lastRestartBy() } : {}),
				}),
			);
		} catch {}
		console.log("WebSocket client connected");
	},

	async message(ws, message) {
		if (sandboxWsMessage(ws, message as any)) return;
		if (nodeWsMessage(ws, message as any)) return;
		if (isLocalProfile()) {
			const identity = await verifiedCloudIdentity();
			setLocalProfileIdentity(identity);
			revalidateLocalClients(identity);
			if (!identity || ws.data.authLogin !== identity.login) {
				ws.close(4001, "Hosted GitHub session expired");
				return;
			}
		}
		let msg: any;
		try {
			msg = JSON.parse(String(message));
		} catch {
			ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
			return;
		}

		// A throw anywhere below used to escape as an unhandled rejection and
		// kill the whole process (2026-07-27: four crash-restarts from a prompt
		// message missing `content` — every in-process run died each time). One
		// malformed or unlucky message must never take down the server, so the
		// entire dispatch is fenced; the switch body keeps its indentation to
		// avoid a 1500-line re-indent in the shared checkout.
		try {
		// GitHub web sign-in active (web-auth.ts): the upgrade stamped this
		// socket with the cookie's verified identity — it overrides whatever
		// name the client claims in any message, so attribution and per-user
		// gating stop trusting self-declared users.
		if (ws.data?.authUser) msg.user = ws.data.authUser;
		if (
			await handleCloudProxyProtocolMessage(
				ws,
				msg,
				(lane, payload) => websocketHandlers.message?.(lane, payload),
				(lane) => websocketHandlers.close?.(lane, 1000, "cloud proxy lane closed"),
			)
		) {
			return;
		}
		if (routeCloudWebSocketMessage(ws, msg)) return;

		switch (msg.type) {
			case "ping": {
				// App-level liveness probe (browsers can't send WS protocol pings).
				// The client closes + reconnects a socket whose ping goes unanswered
				// — how a half-open iOS/Safari socket gets detected.
				ws.send('{"type":"pong"}');
				break;
			}

			case "away": {
				// Presence, not subscription: the tab went hidden or idle (or came
				// back). The watch stays put — the transcript must keep streaming so
				// unread counts and notifications still land — but an away socket
				// stops showing its owner's face to everyone else.
				setClientAway(ws, msg.away === true);
				// Coming back to a session whose turn finished while everyone was
				// away → drop in an away-summary system chip (recap.ts).
				const returnedTo = ws.data?.watchingSessionId;
				if (msg.away !== true && returnedTo)
					maybeRecapOnReturn(returnedTo, ws.data?.user || undefined);
				break;
			}

			case "watch": {
				const sessionId = msg.sessionId;
				const session = findSession(sessionId);
				if (!session) {
					ws.send(
						JSON.stringify({ type: "error", message: "Session not found" }),
					);
					return;
				}

				// Stop watching any previous session first
				stopAllWatchesForClient(ws);
				releaseTranscriptV2(ws);
				leaveSession(ws);

				const data = ws.data;
				data.watchingSessionId = sessionId;
				data.supportsFeed = msg.supportsFeed === true;
				data.sinceFeedSeq =
					typeof msg.sinceFeedSeq === "number" ? msg.sinceFeedSeq : undefined;
				data.feedEpoch =
					typeof msg.feedEpoch === "string" ? msg.feedEpoch : undefined;
				if (msg.user) data.user = msg.user;
				joinSession(ws, sessionId);

				// Opening a session whose last turn finished with nobody watching →
				// drop in an away-summary system chip (recap.ts). Fire-and-forget;
				// the recap arrives through the transcript bus like any append.
				maybeRecapOnReturn(sessionId, data.user || undefined);

				// Transcript v2 (flag + supportsSeq gated): eligible watches are
				// served from the owned store + bus with seq cursors — no mirror
				// file-watcher. Ineligible/flag-off falls through byte-identical.
				// The call itself is guarded: a throw anywhere in the v2 path must
				// degrade to the legacy watch, never kill the watch silently (a
				// cold-boot binding failure did exactly that on 2026-07-23 — the
				// client got no init and no error).
				let v2Served = false;
				try {
					v2Served = serveTranscriptV2(ws, sessionId, session, msg);
				} catch (e) {
					console.error(
						`[ws] transcript v2 serve threw for ${sessionId} — falling back to legacy watch:`,
						e,
					);
				}
				if (v2Served) {
					sendWatchExtras(ws, sessionId, session);
					break;
				}

				// Reconnect resume: a client that still holds this session's entries
				// re-watches with the byte cursor of the last transcript frame it
				// received (sinceOffset + sinceRev from transcript_init/append). When
				// the cursor still matches the live mirror file — same rev (the
				// transcript didn't rotate to a new engine id) and an offset the file
				// still covers — skip the full-tail transcript_init replace and let
				// the file-watcher's gap-fill replay exactly the missed entries from
				// the jsonl (the client's id-keyed upsert absorbs any overlap). The
				// jsonl IS the replay buffer: append-only, restart-proof, and it
				// covers entries written while nobody was watching. Any mismatch
				// falls through to the full snapshot below.
				const sinceOffset =
					typeof msg.sinceOffset === "number" && msg.sinceOffset > 0
						? msg.sinceOffset
						: undefined;
				if (
					sinceOffset !== undefined &&
					typeof msg.sinceRev === "string" &&
					session.transcriptPath &&
					msg.sinceRev === transcriptRev(session.transcriptPath) &&
					existsSync(session.transcriptPath) &&
					sinceOffset <= statSync(session.transcriptPath).size
				) {
					startWatching(session.transcriptPath, ws, sinceOffset, sessionId);
					sendWatchExtras(ws, sessionId, session);
					break;
				}

				// Send one bounded transcript tail so the loading state transitions to
				// a complete conversation instead of first painting a screenful and
				// prepending the rest a beat later. The tighter INIT wire clamp keeps
				// that snapshot manageable: the UI eagerly renders only
				// ~6KB of markdown per bubble and fetches the full entry on demand,
				// so the fat 32KB clamp only bought transfer time (a heavy tail hit
				// 1.7MB on the wire). `startOffset` is the pagination cursor for
				// "load earlier".
				let { entries, truncated, endOffset, startOffset } = session.transcriptPath
					? parseTranscriptTail(session.transcriptPath)
					: { entries: [], truncated: false, endOffset: 0, startOffset: 0 };
				if (!entries.length) {
					// No mirror file yet — a fresh session, or an engine-id rotation
					// whose next run hasn't seeded the new id's file. Without this the
					// thread renders blank until the next send (which seeds the file);
					// serve history via the cross-engine fallback (old transcript file
					// merged with OpenCode's SQLite store) instead. No byte cursor into
					// a file here, so no "load earlier" paging — the next run's seeded
					// file restores it.
					const merged = await mergedSessionTranscriptAsync(session);
					if (merged.length) {
						truncated = merged.length > 120;
						entries = truncated ? merged.slice(-120) : merged;
						startOffset = 0;
					}
				}
				ws.send(
					JSON.stringify({
						type: "transcript_init",
						sessionId,
						entries: clampEntriesForWire(entries, INIT_WIRE_CLAMP_BYTES),
						truncated,
						startOffset,
						// Resume cursor (see the sinceOffset branch above): where this
						// snapshot ends in the mirror file, and which file that was.
						...(session.transcriptPath
							? { endOffset, rev: transcriptRev(session.transcriptPath) }
							: {}),
					}),
				);

				// Start file watcher from where the tail parse left off — bytes
				// appended between the parse and the watch would otherwise be lost.
				if (session.transcriptPath) {
					startWatching(session.transcriptPath, ws, endOffset, sessionId);
				}

				sendWatchExtras(ws, sessionId, session);
				break;
			}

			case "unwatch": {
				// Viewer navigated away from the session (not just to another one):
				// stop streaming transcript events and clear their ghost presence.
				// Mirrors the disconnect/close cleanup; leaveSession broadcasts
				// presence to the viewers who remain.
				stopAllWatchesForClient(ws);
				releaseTranscriptV2(ws);
				leaveSession(ws);
				break;
			}

			case "load_history": {
				// "Load earlier history": one PAGE of history — the byte window just
				// before the client's earliest offset (`beforeOffset`, threaded from
				// transcript_init/transcript_history startOffset). The old behavior
				// (re-send the ENTIRE transcript) hit ~15MB wire payloads and a
				// 600-bubble render on big transcripts; it survives only as the
				// fallback for clients that don't send an offset.
				//
				// Transcript v2 seq paging: a client in seq mode pages backwards
				// with `beforeSeq` → one ~40-entry page from the store. Legacy
				// offset paging below is untouched; a store failure falls
				// through to it.
				if (typeof msg.beforeSeq === "number" && msg.beforeSeq > 0) {
					try {
						// "Jump to the start" walks the entire backlog, so it asks for
						// fatter pages: fewer round trips, and — the real cost — fewer
						// whole-transcript reconciliations per entry recovered. Capped
						// because each entry is only clamped to 8KB on the wire.
						const page = transcriptStore().readBefore(
							msg.sessionId,
							Math.floor(msg.beforeSeq),
							Math.min(Math.max(1, Math.floor(msg.limit ?? 40)), 500),
						);
						ws.send(
							JSON.stringify({
								type: "transcript_history",
								sessionId: msg.sessionId,
								// Backlog pages take the same init clamp as legacy history
								// pages (see clampV2InitEntries).
								entries: clampV2InitEntries(page.entries),
								firstSeq: page.firstSeq,
								lastSeq: page.lastSeq,
								truncated: page.firstSeq > 1,
								v2: true,
							}),
						);
						break;
					} catch (e) {
						console.warn(`[ws] v2 load_history failed for ${msg.sessionId}:`, e);
					}
				}
				const session = findSession(msg.sessionId);
				if (!session?.transcriptPath) {
					// Same no-mirror-file state as the watch fallback: serve the merged
					// cross-engine history rather than blanking the client's view.
					ws.send(
						JSON.stringify({
							type: "transcript_init",
							sessionId: msg.sessionId,
							entries: session
								? clampEntriesForWire(
										await mergedSessionTranscriptAsync(session),
									)
								: [],
							truncated: false,
						}),
					);
					return;
				}
				const before =
					typeof msg.beforeOffset === "number" && msg.beforeOffset > 0
						? msg.beforeOffset
						: null;
				if (before !== null) {
					const rev = transcriptRev(session.transcriptPath);
					let fileSize: number | null = null;
					try {
						if (existsSync(session.transcriptPath)) {
							fileSize = statSync(session.transcriptPath).size;
						}
					} catch {
						fileSize = null;
					}
					if (
						msg.beforeRev !== rev ||
						fileSize === null ||
						before > fileSize
					) {
						if (fileSize === null) {
							ws.send(
								JSON.stringify({
									type: "transcript_init",
									sessionId: msg.sessionId,
									entries: clampEntriesForWire(
										await mergedSessionTranscriptAsync(session),
									),
									truncated: false,
								}),
							);
							break;
						}
						const tail = parseTranscriptTail(session.transcriptPath);
						ws.send(
							JSON.stringify({
								type: "transcript_init",
								sessionId: msg.sessionId,
								entries: clampEntriesForWire(tail.entries, INIT_WIRE_CLAMP_BYTES),
								truncated: tail.truncated,
								startOffset: tail.startOffset,
								endOffset: tail.endOffset,
								rev,
							}),
						);
						break;
					}
					// ~40 entries per page; the 1MB soft window cap bounds the server
					// read through fat tool-result regions, but the parser still
					// guarantees ≥10 entries per page (see parseTranscriptWindow) —
					// 2-entry pages made "load earlier" feel broken and kept the
					// infinite-scroll sentinel in range, chaining loads every ~1.6s.
					const page = parseTranscriptWindow(
						session.transcriptPath,
						before,
						undefined,
						40,
						1024 * 1024,
					);
					ws.send(
						JSON.stringify({
							type: "transcript_history",
							sessionId: msg.sessionId,
							entries: clampEntriesForWire(page.entries, INIT_WIRE_CLAMP_BYTES),
							truncated: page.truncated,
							startOffset: page.startOffset,
						}),
					);
					break;
				}
				const entries = await parseTranscriptAsync(session.transcriptPath);
				ws.send(
					JSON.stringify({
						type: "transcript_init",
						sessionId: msg.sessionId,
						entries: clampEntriesForWire(entries),
						truncated: false,
					}),
				);
				break;
			}

			case "prompt": {
				const { sessionId, user } = msg;
				// Non-string content (a client bug — e.g. `text` instead of
				// `content`) used to flow all the way into the run path and crash
				// the process. Coerce, and reject a send with nothing in it.
				const content = typeof msg.content === "string" ? msg.content : "";
				const images = parseImageDataUrls(msg.images);
				const imageUrls = asDataUrlList(msg.images);
				if (
					!content.trim() &&
					!images?.length &&
					!(Array.isArray(msg.files) && msg.files.length)
				) {
					ws.send(
						JSON.stringify({ type: "error", message: "Empty prompt (no content/images/files)" }),
					);
					return;
				}
				const session = findSession(sessionId);
				if (!session) {
					ws.send(
						JSON.stringify({ type: "error", message: "Session not found" }),
					);
					return;
				}
				if (session.upgradedTo || isLocalSessionUpgradeInProgress(sessionId)) {
					ws.send(
						JSON.stringify({
							type: "error",
							message: "This session is being upgraded to the cloud. Retry the prompt in the cloud session.",
						}),
					);
					return;
				}

				// The composer's effort pill rides every send; persist a change so
				// this and future runs (queue drains, resumes) honor it.
				maybePersistEffort(session, msg.effort);
				maybePersistFastMode(session, msg.fastMode);

				// Slash commands are handled by opensession itself
				const notice = handleSlashCommand(
					session,
					String(content || "").trim(),
					user,
				);
				if (notice !== null) {
					ws.send(JSON.stringify({ type: "notice", message: notice }));
					invalidateSessionsCache();
					break;
				}

				// @People-mentions in a prompt ping the tagged teammates (roster
				// from the identity config, never the sender). Fires at send time
				// on every path — direct, queued, steer.
				{
					const promptText = String(content || "");
					if (promptText.includes("@")) {
						const preview =
							promptText.length > 140
								? `${promptText.slice(0, 139)}…`
								: promptText;
						for (const name of mentionedUsers(promptText, String(user || ""))) {
							void sendPushToUser(name, {
								title: `${user || "Someone"} mentioned you in ${session.title || "a session"}`,
								body: preview,
								url: `/session/${encodeURIComponent(sessionId)}`,
								tag: `opensession-mention-${sessionId}`,
							});
						}
					}
				}

				// Busy sends queue by default, so the user can still delete/edit or
				// manually steer the message. Settings can opt the composer into
				// steer-by-default (`busyMode: "steer"`), delivered at the next turn
				// boundary and falling back to queue when the run isn't steerable.
				if (
					isAgentSessionBusy(
						session.claudeSessionId,
						session.codexThreadId,
						session.id,
					)
				) {
					if (msg.busyMode === "queue") {
						enqueuePrompt(sessionId, {
							content,
							user,
							images: imageUrls,
							files: msg.files,
							// Queue-by-choice: held until the agent FULLY completes
							// (including running child workers), not just until the
							// next turn boundary. Steer is the deliver-sooner path.
							hold: true,
						});
						watchExternalRunAndDrain(sessionId);
						break;
					}
					const attributed = user ? `[${user}] ${content}` : content;
					// Images fold into the live run as content blocks; disk-staged
					// files can't ride the steer channel, so a send carrying files
					// falls through to the queue (its drain delivers images + files
					// together at the run's next idle point).
					const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
					if (
						msg.busyMode === "steer" &&
						!hasFiles &&
						steerAgentRun(
							[session.claudeSessionId, session.codexThreadId, session.id],
							attributed,
							images,
						)
					) {
						// The message lands in the transcript when its turn starts. Until
						// then a steer receipt is the durable visible record (survives
						// reload/leave); kept out of promptQueues so the drain never
						// re-delivers it, and cleared when the run finishes.
						recordSteer(sessionId, { content, user, images: imageUrls });
						break;
					}
					enqueuePrompt(sessionId, {
						content,
						user,
						images: imageUrls,
						files: msg.files,
					});
					watchExternalRunAndDrain(sessionId);
					break;
				}

				// Codex sessions start a fresh thread on first prompt. Open Session
				// sessions with no engine id are *fresh* sessions (a new sibling from the
				// tab strip's +): runSessionPrompt starts a new conversation. Only
				// non-opensession sources genuinely need an id to resume.
				if (
					providerFor(session.model) === "claude" &&
					!session.claudeSessionId &&
					session.source !== "opensession"
				) {
					ws.send(
						JSON.stringify({
							type: "error",
							message: "No Claude session to resume",
						}),
					);
					return;
				}

				// Sibling-session transcripts attached via the fresh-session chips.
				const contextSessions = Array.isArray(msg.contextSessions)
					? msg.contextSessions.filter(
							(id: unknown): id is string => typeof id === "string",
						)
					: undefined;
				await runSessionPromptAndDrain(
					sessionId,
					content,
					user,
					images,
					msg.files,
					contextSessions,
				);
				break;
			}

			case "interrupt_prompt": {
				// Esc-style redirect: stop the current turn, keep the session, and
				// continue right away with this message. Falls back to a normal
				// prompt (steer/queue/run) when there's nothing to interrupt.
				const { sessionId, content, user } = msg;
				const images = parseImageDataUrls(msg.images);
				const imageUrls = asDataUrlList(msg.images);
				const session = findSession(sessionId);
				if (!session) {
					ws.send(
						JSON.stringify({ type: "error", message: "Session not found" }),
					);
					return;
				}
				if (session.upgradedTo || isLocalSessionUpgradeInProgress(sessionId)) {
					ws.send(
						JSON.stringify({
							type: "error",
							message: "This session is being upgraded to the cloud. Retry the prompt in the cloud session.",
						}),
					);
					return;
				}
				maybePersistEffort(session, msg.effort);
				maybePersistFastMode(session, msg.fastMode);
				const attributed = user ? `[${user}] ${content}` : content;
				// Files can't ride the interrupt/steer content-block channel — a send
				// carrying files falls through to the queue (drain delivers images +
				// files together), so it isn't interrupted here.
				const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
				if (
					!hasFiles &&
					isAgentSessionBusy(
						session.claudeSessionId,
						session.codexThreadId,
						session.id,
					) &&
					interruptAndSteerAgentRun(
						[session.claudeSessionId, session.codexThreadId, session.id],
						attributed,
						images,
					)
				) {
					// Interrupt aborts the current turn and continues immediately, so
					// the message lands in the transcript almost at once — no steer
					// receipt ("folded in" would be wrong for an interrupt) and no system
					// notice. The sender's optimistic bubble reconciles when its real
					// turn appears; the SDK's "[Request interrupted by user]" marker is
					// filtered out in jsonl-parser.
					break;
				}
				// No in-band interrupt-and-steer (opencode runs, or a send carrying
				// files): queue the message durably, then abort the current turn so
				// the drain delivers it as the immediate next turn — esc+enter
				// semantics. If nothing is abortable either (external CLI/tmux run),
				// it stays queued for the natural stopping point, so nothing — text
				// or attachment — is lost.
				if (
					isAgentSessionBusy(
						session.claudeSessionId,
						session.codexThreadId,
						session.id,
					)
				) {
					enqueuePrompt(sessionId, {
						content,
						user,
						images: imageUrls,
						files: msg.files,
					});
					if (!abortTurnAndDrain(sessionId, session)) {
						watchExternalRunAndDrain(sessionId);
					}
					break;
				}
				await runSessionPromptAndDrain(
					sessionId,
					content,
					user,
					images,
					msg.files,
				);
				break;
			}

			case "delete_queued_prompt": {
				const { sessionId, queueId, queueIndex } = msg;
				deleteQueuedPrompt(sessionId, queueId, queueIndex);
				break;
			}

			case "update_queued_prompt": {
				const { sessionId, queueId, queueIndex, content } = msg;
				const next = String(content || "").trim();
				if (!next) {
					deleteQueuedPrompt(sessionId, queueId, queueIndex);
				} else {
					updateQueuedPrompt(sessionId, queueId, queueIndex, next);
				}
				break;
			}

			case "steer_queued_prompt": {
				const { sessionId, queueId, queueIndex } = msg;
				if (!steerQueuedPrompt(sessionId, queueId, queueIndex)) {
					ws.send(
						JSON.stringify({
							type: "notice",
							sessionId,
							message:
								"Could not steer that queued message right now. It is still queued.",
						}),
					);
				}
				break;
			}

			case "interrupt_queued_prompt": {
				const { sessionId, queueId, queueIndex } = msg;
				if (!interruptQueuedPrompt(sessionId, queueId, queueIndex)) {
					ws.send(
						JSON.stringify({
							type: "notice",
							sessionId,
							message:
								"Could not interrupt with that message right now. It is still queued.",
						}),
					);
				}
				break;
			}

			case "reorder_queued_prompt": {
				const { sessionId, order } = msg;
				if (Array.isArray(order) && order.every((x) => typeof x === "string")) {
					reorderQueuedPrompt(sessionId, order);
				}
				break;
			}

			case "cancel": {
				const data = ws.data;
				if (data.watchingSessionId) {
					const sessionId = data.watchingSessionId;
					const session = findSession(sessionId);
					// Park the queue until the user's next explicit action —
					// otherwise the drain would deliver the requeued steers into a
					// fresh run the moment the stopped one winds down.
					stoppedSessions.add(sessionId);
					if (session) {
						// Esc-style: gracefully interrupt the current turn (the run
						// winds down at the forced boundary with a clean transcript).
						// Hard cancel only for runs with no interrupt support (codex,
						// external processes); the full kill lives on session delete.
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
						// A stopped run's only trace is the runner's anonymous
						// "cancelled" turn event — record who pulled the plug (stop
						// button / Esc), or diagnosing "why did it go silent?" means
						// inferring the gesture by elimination.
						console.log(
							`[ws] run stopped on ${sessionId} by ${data.user || "unknown"} (${stopped ? "graceful" : "hard-cancel"})`,
						);
						audit({
							msg: "run_cancelled",
							session_id: sessionId,
							source: "ui_stop",
							user: data.user,
							graceful: stopped,
						});
						transitionRunState(sessionId, "cancel", {
							source: "ui_stop",
							user: data.user,
						});
						// Durable trace in the transcript too: a stopped turn otherwise
						// just goes silent mid-tool-call, and readers can't tell a
						// deliberate stop from a crash (the audit line answers it for
						// the agent, this chip answers it for everyone reading the UI).
						if (session.claudeSessionId) {
							try {
								appendOpencodeTranscript(session.claudeSessionId, [
									transcriptLineRunnerNotice(
										`Turn stopped by ${data.user || "someone"} (stop button / Esc).`,
									),
								]);
							} catch {}
						}
					}
					const requeued = requeueSteerReceipts(
						sessionId,
						session ? engineUserTexts(session) : undefined,
					);
					if (requeued > 0) {
						broadcastToSession(sessionId, {
							type: "notice",
							message: `Stopped — ${requeued} steered message${requeued === 1 ? "" : "s"} returned to the queue.`,
						});
					}
				}
				break;
			}

			case "answer_question": {
				const { sessionId, questionId, answers } = msg;
				const pending = pendingAsks.get(sessionId);
				if (pending && pending.questionId === questionId) {
					pending.resolve(
						answers && typeof answers === "object" ? answers : null,
					);
				}
				break;
			}

			// ── Interactive shell (Shell tab) — multiple PTYs per socket, one
			// per shell tab, keyed by the client's termId ("0" for legacy
			// clients that predate multi-tab shells). Outbound frames are
			// tagged with the termId so the client routes them to the right tab.
			case "term_start": {
				const termId = typeof msg.termId === "string" ? msg.termId : "0";
				// Sandbox-aware: docker/daytona sessions get the shell INSIDE
				// their sandbox; host worktree shell otherwise (terminals.ts).
				void startSessionTerminal(ws, termId, findSession(msg.sessionId), {
					cols: Number(msg.cols) || undefined,
					rows: Number(msg.rows) || undefined,
					send: (m) => {
						try {
							ws.send(JSON.stringify({ ...m, termId }));
						} catch {}
					},
				});
				break;
			}
			case "term_input": {
				if (typeof msg.data === "string")
					writeTerminal(
						ws,
						typeof msg.termId === "string" ? msg.termId : "0",
						msg.data,
					);
				break;
			}
			case "term_resize": {
				resizeTerminal(
					ws,
					typeof msg.termId === "string" ? msg.termId : "0",
					Number(msg.cols),
					Number(msg.rows),
				);
				break;
			}
			case "term_stop": {
				stopTerminal(ws, typeof msg.termId === "string" ? msg.termId : "0");
				break;
			}

			case "create_session": {
				const { prompt, user, mode } = msg;
				// Mutable: a brand-new code branch is made collision-free below (a
				// name clashing with an existing `name/...` ref — or vice versa —
				// makes `git worktree add -b` fail, killing the session).
				let branch = msg.branch;
				const images = parseImageDataUrls(msg.images);
				// Session opened from a PR row (sidebar): `branch` is the PR's
				// EXISTING head branch — check it out instead of creating a new
				// branch off origin/default.
				const fromPr =
					msg.fromPr === true && typeof branch === "string" && !!branch;

				// Fork: branch a new session off an existing one. Claude can clone the
				// real engine conversation via SDK forkSession; backends without clone
				// support get a transcript handoff in the opening prompt instead.
				const forkFrom = msg.forkFrom as
					| { sourceId?: string; messageId?: string }
					| undefined;
				const forkSource = forkFrom?.sourceId
					? findSession(forkFrom.sourceId)
					: undefined;
				if (forkFrom?.sourceId && !forkSource) {
					ws.send(
						JSON.stringify({
							type: "error",
							message: "Fork source session not found",
						}),
					);
					return;
				}
				const canFork =
					!!forkSource &&
					providerFor(forkSource.model) === "claude" &&
					!!forkSource.claudeSessionId;
				const needsForkHandoff = !!forkSource && !canFork;

				// Scratch: repo-less sessions for feed-item workspaces (Tella videos —
				// the feeds design). Full write + bash in a per-workspace scratch
				// dir, MCP tools as usual; no repo, branch, or PR flow.
				const isScratch = forkSource
					? forkSource.mode === "scratch"
					: mode === "scratch";
				const isAsk = forkSource
					? !isScratch && forkSource.mode !== "code"
					: mode === "ask";
				// Optional model pick from the UI; invalid input falls back to default.
				// A fork inherits the source's model. No pick = stamp the interactive
				// default NOW: leaving it empty would let the init event persist the
				// engine's resolved model — which for a dial default would silently
				// disengage the dial (the preset id must be what the session stores).
				const model = forkSource
					? forkSource.model
					: (msg.model ? resolveModel(String(msg.model))?.id : undefined) ||
						interactiveDefaultModel();
				// Reasoning effort from the New-session palette (forks inherit).
				const createEffort = forkSource
					? forkSource.effort
					: typeof msg.effort === "string" &&
							SESSION_EFFORTS.has(msg.effort.trim().toLowerCase())
						? msg.effort.trim().toLowerCase()
						: undefined;
				const createFastMode = forkSource?.fastMode;
				// Pinned provider account from the palette (forks inherit).
				// Soft pin: the runner prefers it and falls back to the pool when
				// it's exhausted. Mismatched, unknown, and foreign personal ids
				// are dropped rather than persisted as a pin that can never apply.
				const requestedAccountProvider = accountProviderForModel(model);
				const requestedAccount =
					typeof msg.accountId === "string" && msg.accountId
						? requestedAccountProvider === "codex"
							? getCodexAccountById(msg.accountId)
							: requestedAccountProvider === "claude"
								? getAccountById(msg.accountId)
								: undefined
						: undefined;
				const createAccountId = forkSource
					? forkSource.accountId
					: requestedAccount &&
							(!requestedAccount.owner ||
								(!!user && userMatchesAny(user, [requestedAccount.owner])))
						? msg.accountId
						: undefined;
				const createMcpServers = Array.isArray(msg.mcpServers)
					? msg.mcpServers.map(String)
					: undefined;
				// Which repo this session works in (tella-fusion by default).
				const repo = getRepo(
					typeof msg.repo === "string" ? msg.repo : undefined,
				);
				// Sandbox opt-in (the sandbox rollout plan): boolean true = the
				// config's default provider (legacy toggle behavior); a string
				// names an explicit provider (including "modal" / "lambda-microvm"),
				// validated against the current config. Forks never sandbox —
				// they share/fork the source session's engine state and cwd.
				const sandboxResolved = resolveRequestedSandbox(
					forkSource ? undefined : (msg.sandbox as boolean | string | undefined),
					repo.id,
					model,
				);
				if (!sandboxResolved.ok) {
					ws.send(
						JSON.stringify({ type: "error", message: sandboxResolved.error }),
					);
					return;
				}
				// null = host (no sandbox recorded on the session).
				const createSandboxProvider = sandboxResolved.provider;
				// Remote providers have no host mounts — always volume-style.
				const remoteSandbox = isRemoteSandboxProvider(createSandboxProvider);
				// Workspace linkage. The New modal creates a Workspace + first Session
				// together (createWorkspace); the tab/sidebar + adds a Session to an
				// existing workspace (workspaceId) that either shares the workspace's
				// worktree (default) or stacks a new one branched off it.
				const worktreeMode: "share" | "stack" | "ask" = isAsk
					? "ask"
					: msg.worktreeMode === "stack"
						? "stack"
						: "share";
				let workspace =
					typeof msg.workspaceId === "string" && msg.workspaceId
						? getWorkspace(msg.workspaceId)
						: null;
				// A ticket-linked create always lands in the ticket's ONE workspace
				// (adopt-don't-duplicate, workspace-resolve.ts) — even when the
				// client asked for a fresh workspace, a second workspace for the
				// same ticket is never right. A createWorkspace name doubles as
				// the ticket-title hint for a first-time resolve.
				const msgPlainThreadId =
					typeof msg.plainThreadId === "string" && msg.plainThreadId
						? msg.plainThreadId
						: undefined;
				if (msgPlainThreadId && !workspace) {
					try {
						workspace = resolvePlainWorkspace({
							threadId: msgPlainThreadId,
							title:
								typeof msg.createWorkspace?.name === "string"
									? msg.createWorkspace.name
									: undefined,
							createdBy: user || "Anonymous",
						}).workspace;
					} catch {}
				}
				// Whether this create made a brand-new workspace (vs. adding a session
				// to an existing one) — echoed on session_created so the client can
				// word its brief pending state accordingly.
				let createdWorkspaceNow = false;
				if (!workspace && msg.createWorkspace) {
					// A code create landing on a branch whose worktree an existing
					// workspace already owns joins that workspace (the worktree
					// lookup below would silently reuse the worktree anyway —
					// re-submitted prompt slugs and existing branches picked in the
					// unscoped palette both hit this). Only then mint a fresh one.
					if (!isAsk && !forkSource && !fromPr && !sharedCheckoutForNewSessions(repo) && branch) {
						const existingWt = (await listWorktrees(repo.id)).find(
							(w) => w.branch === branch,
						)?.path;
						workspace = workspaceOwningWorktree(existingWt);
					}
					if (!workspace) {
						createdWorkspaceNow = true;
						workspace = createWorkspace({
							name:
								(typeof msg.createWorkspace.name === "string" &&
									msg.createWorkspace.name) ||
								prompt.trim().split("\n")[0].slice(0, 80) ||
								"Workspace",
							...(isScratch ? {} : { repo: repo.id }),
							createdBy: user || "Anonymous",
						});
					}
				}
				// Set once the session has been announced to the client (early
				// session_created) — a later failure must then close out the
				// stream instead of leaving the just-opened viewer spinning.
				let announcedId: string | null = null;

				// One outlet for this run's stream events (usable only after the
				// announce sets announcedId). Everything is stamped with sessionId
				// so clients can filter, and the creator's direct send is GATED on
				// what their socket currently watches: it only covers the gap
				// between session_created and their watch landing. Once they watch
				// this session, the room broadcast reaches them; once they've
				// navigated to a DIFFERENT session, they get nothing — the old
				// unconditional ws.send kept streaming this run into whatever session
				// that socket had open (until a refresh replaced the socket).
				const emit = (m: Record<string, unknown>) => {
					if (!announcedId) return;
					const scoped = { ...m, sessionId: announcedId };
					const watching = ws.data?.watchingSessionId;
					if (!watching) {
						try {
							ws.send(JSON.stringify(scoped));
						} catch {}
					}
					broadcastToSession(announcedId, scoped, watching ? undefined : ws);
				};
				try {
					let wtPath: string;
					// Deferred worktree setup: the git fetch + worktree add +
					// bun install can take tens of seconds, so the session is
					// announced on the deterministic path first and the worktree
					// is created after session_created goes out (below).
					let needsWorktree = false;
					// Volume-mode sandbox workspace (Phase 2): no host worktree at
					// all - the sandbox provider clones it in-container on the
					// opening run below.
					let volumeWorkspace = false;
					if (forkSource) {
						// Share the source's cwd so the fork sees the same code state.
						wtPath = forkSource.worktreeDir || repo.repo;
					} else if (fromPr) {
						// From a PR row: work on the PR's existing head branch in an
						// isolated worktree (even for shared-checkout repos and ask
						// mode — the PR's code is the subject, and a PR branch must
						// never check out in the live main checkout). Reuses a
						// worktree already on that branch.
						const worktrees = await listWorktrees(repo.id);
						wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
						if (!wtPath) {
							wtPath = worktreePathFor(branch, repo.id, { isolated: true });
							needsWorktree = true;
						}
					} else if (isScratch) {
						// Scratch sessions run in a plain per-workspace scratch dir
						// (shared by the workspace's sessions so downloads persist across
						// them) — never a repo checkout (the feeds design).
						wtPath = ensureScratchDir(workspace?.id || randomUUIDv7());
					} else if (isAsk) {
						// Ask sessions read the repo's pinned ask checkout (default
						// branch, detached) — never the mutable main checkout, whose
						// parked branch is a false context clue. Instant once the
						// checkout exists; only the first-ever create pays a worktree
						// add (ensureAskCheckout).
						wtPath = await ensureAskCheckout(repo.id);
					} else if (sharedCheckoutForNewSessions(repo)) {
						// Open Session: code sessions edit the live main checkout on the
						// default branch (hot-reloads in the running server). No worktree.
						wtPath = repo.repo;
					} else if (workspace?.worktreeDir && worktreeMode === "share") {
						// Share the workspace's owned worktree (parallel sessions, one branch).
						wtPath = workspace.worktreeDir;
					} else {
						// selfDev:"worktree" only: the client may omit a branch for a
						// repo it still believes is shared-checkout — derive one so the
						// worktree path never degenerates to `<wtPrefix>-`. Scoped to
						// sharedCheckout repos so every other repo's path is untouched.
						if (!branch && repo.sharedCheckout)
							branch =
								sanitizeBranchSlug(prompt.trim().split("\n")[0]) ||
								`session-${Date.now().toString(36)}`;
						// New/stacked worktree. Stack branches off the workspace's branch
						// so stacked PRs line up; otherwise branch off origin/default.
						const worktrees = await listWorktrees(repo.id);
						wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
						if (!wtPath) {
							// A genuinely new branch: dodge ref-hierarchy collisions
							// (e.g. requested `test` while `test/foo` already exists)
							// before we bake the name into the path + session file.
							if (branch)
								branch = await resolveUniqueBranch(branch, repo.id);
							wtPath = worktreePathFor(branch, repo.id);
							// Volume-mode sandbox (the sandbox rollout plan Phase 2): the
							// workspace is cloned into a per-session volume INSIDE the
							// sandbox — skip host createWorktree entirely. The session
							// keeps the canonical path; the provider's ensure()
							// materializes it on the opening run below. Docker only in
							// volume config; remote providers (daytona/e2b) always.
							if (
								createSandboxProvider &&
								sandboxesEnabled() &&
								(remoteSandbox ||
									(createSandboxProvider === "docker" &&
										sandboxConfig().workspace === "volume"))
							) {
								volumeWorkspace = true;
							} else {
								needsWorktree = true;
							}
						}
					}
					// The layer this session stacks on, captured BEFORE the adoption
					// block below can rewrite workspace.branch to this session's own
					// branch — reading it afterwards would make a stacked session try
					// to base on itself.
					const stackBase =
						worktreeMode === "stack" && !isAsk && !isScratch
							? workspace?.branch || ""
							: "";
					// First code session materializes the workspace's owned worktree so
					// later share-mode sessions inherit it. Stacked sessions keep their own —
					// except a "stack" in a workspace with no branch yet, which has no
					// base to stack on and is really the workspace's first worktree.
					// fromPr is exempt from the shared-checkout exclusion: PR-branch
					// worktrees are isolated even for shared-checkout repos, so a PR
					// workspace on e.g. opensession still materializes.
					if (
						workspace &&
						!workspace.worktreeDir &&
						!isAsk &&
						!isScratch &&
						(!sharedCheckoutForNewSessions(repo) || fromPr) &&
						(worktreeMode !== "stack" || !workspace.branch)
					) {
						updateWorkspace(workspace.id, {
							worktreeDir: wtPath,
							...(branch ? { branch } : {}),
						});
						workspace = { ...workspace, worktreeDir: wtPath, branch };
					}
					// The branch this session actually works on (also persisted below).
					const sessionBranch = forkSource
						? forkSource.branch || ""
						: fromPr
							? branch
							: isAsk || isScratch
								? ""
								: sharedCheckoutForNewSessions(repo)
									? repo.defaultBranch
									: workspace?.worktreeDir === wtPath
										? workspace.branch || branch
										: branch;

					const bksId = newSessionId();
					const title = prompt.trim().split("\n")[0].slice(0, 80);
					// Every session lives in a workspace (session-workspace.ts). A create
					// that resolved none — no picker choice, no fork parent, no
					// explicit id — mints its own here rather than surfacing as an
					// orphan the read-side sweep has to adopt a moment later: only a
					// workspace minted on this path can be auto-named from the
					// generated title below.
					let mintedForSession = false;
					if (
						!workspace &&
						!forkSource?.workspaceId &&
						!(typeof msg.workspaceId === "string" && msg.workspaceId)
					) {
						workspace = createWorkspace({
							name: title || "Workspace",
							...(isScratch ? {} : { repo: repo.id }),
							createdBy: user || "Anonymous",
							...(sessionBranch ? { branch: sessionBranch } : {}),
							// Only an isolated worktree is owned — a shared main/ask
							// checkout is used by every other session there too.
							...(ownedWorktree(wtPath) ? { worktreeDir: wtPath } : {}),
						});
						mintedForSession = true;
					}
					// Replace the raw first-line title with a short summary in the
					// background; next sessions poll (≤5s) picks it up. An
					// auto-created workspace is named ONCE from the same generated
					// summary (it provisionally wore the raw first line) and keeps
					// that name for life — later sessions never rename it.
					// Only a workspace minted by THIS create gets auto-named — an
					// adopted pre-existing workspace keeps its own name.
					const wsAutoNamed =
						mintedForSession ||
						(createdWorkspaceNow &&
							!!workspace &&
							!!msg.createWorkspace &&
							!msg.createWorkspace.name);
					const wsToName = workspace;
					void ensureGeneratedTitle(bksId, prompt, user, model).then((t) => {
						if (!t) return;
						invalidateSessionsCache();
						if (wsAutoNamed && wsToName) {
							const cur = getWorkspace(wsToName.id);
							// Only while it still wears the provisional name — a manual
							// rename in the meantime wins.
							if (cur && cur.name === wsToName.name)
								updateWorkspace(wsToName.id, { name: t });
						}
					});
					// Non-image attachments: stage to disk, hand the agent the paths.
					let openingPrompt = withUploadsNote(
						prompt,
						stageFileAttachments(bksId, msg.files),
					);
					// @session:<id> mentions from the New-session box get the same
					// resolving footer as prompts on existing sessions (see
					// runSessionPromptInner) — this create path bypasses it.
					{
						const mentionsNote = sessionMentionsNote(openingPrompt);
						if (mentionsNote) openingPrompt += `\n\n${mentionsNote}`;
					}
					// Session opened from the Support view: link it to its Plain
					// thread (conversation tab + the sidebar's ticket→session
					// mapping) and hand the agent the ticket conversation so the
					// first message is self-contained. A session created inside a
					// ticket workspace (tab-strip "+") inherits the thread too.
					// A session created inside a feed-item workspace (PostHog dashboard, …)
					// inherits the workspace's externalRefs — that's what keeps the
					// Video tab on its sessions and joins the sidebar feed row to the
					// session — and gets the item named in its opening context.
					const inheritedRefs = workspace?.externalRefs;
					// Least privilege for feed-workspace sessions: unless the creator
					// explicitly picked servers, the session's MCP allowlist is the
					// feed's declared list (e.g. posthog → ["posthog"]) — never the full
					// mcp-config (a feed session must not see Plain/Stripe/WorkOS).
					const feedMcpServers =
						!createMcpServers?.length && inheritedRefs?.length
							? await (
									await import("./feeds")
								).feedMcpServersForRefs(inheritedRefs)
							: undefined;
					if (inheritedRefs?.length) {
						const refsContext = await (
							await import("./feeds")
						).externalRefsOpeningContext(inheritedRefs, {
							scratch: isScratch,
							// The creator's MCP grant fetches the object context
							// (e.g. the Tella video via their account).
							user,
						});
						if (refsContext)
							openingPrompt += `\n\n${wrapContext(refsContext)}`;
					}
					const plainThreadId = msgPlainThreadId || workspace?.plainThreadId;
					if (plainThreadId) {
						try {
							const { getThreadWithMessages, formatThreadContext } =
								await import("../agents/plain/api");
							const thread = await getThreadWithMessages(plainThreadId);
							openingPrompt += `\n\n${wrapContext(
								`This session was opened from a Plain support ticket. Ticket context:\n\n${formatThreadContext(thread, true)}`,
							)}`;
						} catch (e) {
							console.error(
								`[create_session] Plain thread lookup failed for ${plainThreadId}:`,
								e,
							);
							openingPrompt += `\n\n${wrapContext(
								`This session was opened from Plain support ticket ${plainThreadId} (the context lookup failed — use the plain MCP tools to fetch the thread).`,
							)}`;
						}
					}
					if (needsForkHandoff && forkSource) {
						const entries = forkSource.transcriptPath
							? await parseTranscriptAsync(forkSource.transcriptPath)
							: [];
						openingPrompt += `\n\n${wrapContext(
							buildForkHandoffNote({
								sourceId: forkSource.id,
								sourceTitle: forkSource.title,
								sourceModel: forkSource.model,
								messageId: forkFrom?.messageId,
								entries,
							}),
						)}`;
					}

					let engineSessionId = "";
					let effectiveModel = model;
					let selectedModel = model;
					let effectiveProvider = providerFor(effectiveModel);
					const modelHistory: NonNullable<
						NativeSessionFile["modelHistory"]
					> = [];
					let persisted = false;
					// Cumulative token/cost for this new session's opening run.
					let latestUsage: SessionUsage | undefined;
					// Terminal failure the opening run died on — recorded after the
					// loop so the fresh session surfaces as "Needs input".
					let runFailure: string | null = null;
					// The runner already wrote its own, friendlier transcript line.
					let failureNoticePersisted = false;
					// Actual worktree HEAD when it drifted from the recorded branch
					// (the agent switched/renamed branches during the opening turn).
					const headBranchPatch = () => {
						const head = sessionBranch ? worktreeHeadBranch(wtPath) : null;
						return head && head !== sessionBranch ? { branch: head } : {};
					};
					// Field-scoped write: creation fields are create-if-absent defaults
					// (an existing file — e.g. one touched with the engine id or a
					// materialized sandboxId while the opening run streams — wins);
					// this run only owns the engine-id/model/HEAD-sync fields it
					// actually changes. Serialized via updateSessionFile.
					const persist = () =>
						updateSessionFile(bksId, (data) => {
							// Widen to Partial: the file may not exist yet.
							const existing: Partial<NativeSessionFile> = data;
							return {
								id: bksId,
								claudeSessionId: "",
								branch: sessionBranch,
								worktreeDir: wtPath,
								// Scratch sessions are repo-less: wtPath is a plain
								// scratch dir repoForPath would throw on.
								...(isScratch ? {} : { repo: repoForPath(wtPath).id }),
								...(workspace
									? { workspaceId: workspace.id }
									: forkSource?.workspaceId
										? // A fork lands next to its source in the same workspace.
											{ workspaceId: forkSource.workspaceId }
										: typeof msg.workspaceId === "string" && msg.workspaceId
											? { workspaceId: msg.workspaceId }
											: {}),
								createdBy: user || "Anonymous",
								...(ws.data?.authLogin
									? { createdByLogin: ws.data.authLogin }
									: {}),
								createdAt: new Date().toISOString(),
								title,
								mode: (isScratch ? "scratch" : isAsk ? "ask" : "code") as
									| "ask"
									| "code"
									| "scratch",
								...(stackBase && stackBase !== sessionBranch
									? {
											stackedOn: {
												repo: repoForPath(wtPath).id,
												branch: stackBase,
											},
										}
									: {}),
								...(msg.planFirst === true && !isAsk ? { planFirst: true } : {}),
								...(createEffort ? { effort: createEffort } : {}),
								...(createFastMode ? { fastMode: true } : {}),
								...(createAccountId ? { accountId: createAccountId } : {}),
								...(plainThreadId ? { plainThreadId } : {}),
								...(inheritedRefs?.length
									? { externalRefs: inheritedRefs }
									: {}),
								...(createMcpServers && createMcpServers.length
									? { mcpServers: createMcpServers }
									: feedMcpServers?.length
										? { mcpServers: feedMcpServers }
										: {}),
								...(createSandboxProvider
									? {
											sandbox: {
												provider: createSandboxProvider,
												// Volume intent is recorded up front so the prompt
												// paths know the workspace never exists host-side
												// (hasRemoteWorkspace) even before the first ensure.
												// Remote providers are ALWAYS volume — no host mounts.
												...(volumeWorkspace || remoteSandbox
													? { workspace: "volume" as const }
													: {}),
											},
										}
									: {}),
								...existing,
								...(engineSessionId
									? engineSessionPatch(effectiveProvider, engineSessionId)
									: {}),
								// Record the engine that ran so the first later cross-provider
								// switch bridges context (see runSessionPromptInner handoff).
								...(engineSessionId
									? { lastEngineProvider: effectiveProvider }
									: {}),
								...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
								...(selectedModel ? { model: selectedModel } : {}),
								...(modelHistory.length ? { modelHistory } : {}),
								...headBranchPatch(),
								lastActivity: new Date().toISOString(),
							};
						}).then(() => {
							persisted = true;
						});

					// Persist + announce BEFORE the slow parts (worktree git work,
					// engine boot with its MCP connects) so the client drops into
					// the empty session immediately — the title fills in from the
					// background summary and the opening turn streams in when the
					// engine is up. The starting mark keeps a prompt typed in that
					// window from double-starting a run (same race as
					// runSessionPrompt).
					markSessionStarting(bksId);
					if (needsWorktree) preparingWorkspaces.add(bksId);
					try {
						await persist();
						ws.send(
							JSON.stringify({
								type: "session_created",
								id: bksId,
								...(workspace ? { workspaceId: workspace.id } : {}),
								...(createdWorkspaceNow ? { newWorkspace: true } : {}),
								...(needsWorktree ? { preparingWorkspace: true } : {}),
							}),
						);
						announcedId = bksId;
						emit({ type: "stream_start" });

						if (needsWorktree) {
							try {
								if (fromPr) {
									await createWorktreeForExistingBranch(branch, repo.id);
								} else {
									await createWorktree(
										branch,
										repo.id,
										stackBase ? { base: stackBase } : undefined,
									);
								}
								// Deps install runs in the background (worktree.ts) — say
								// so, since builds/tests may not be ready for a beat.
								emit({
									type: "notice",
									message:
										"Workspace ready — installing dependencies in the background.",
								});
							} finally {
								// Ready (or failed — the error surfaces separately): flip the
								// viewer out of "Waiting for workspace" and let the queue go.
								preparingWorkspaces.delete(bksId);
								emit({ type: "workspace_status", ready: true });
							}
						}

					// Sandbox session: route the OPENING turn through the same
					// launcher the prompt path uses (the session file was persisted
					// above, so it resolves) — bind mode included, so the first turn
					// runs in the sandbox like every later one (the worktree was
					// created above, so the bind mounts are ready; ensure() is
					// idempotent + per-session locked, and later prompts are held
					// behind markSessionStarting, so there's no double-ensure race).
					// Volume workspaces (docker volume mode / remote providers) have
					// no host dir: a failed launch errors the stream (announcedId is
					// set, so the catch below closes it out). Bind mode keeps the
					// host fallback — a failed launch runs this turn on the worktree.
					let sandboxOpeningRun: AsyncGenerator<StreamEvent> | null = null;
					if (createSandboxProvider) {
						const created = findSession(bksId);
						sandboxOpeningRun = created
							? await maybeLaunchSandboxedRun(created, {
									prompt: openingPrompt,
									cwd: wtPath,
									user,
									images,
									mcpServers: (createMcpServers?.length ? createMcpServers : feedMcpServers) ?? [],
									isAutomationSession: false,
								})
							: null;
						if (!sandboxOpeningRun && (volumeWorkspace || remoteSandbox)) {
							throw new Error(
								"Sandbox unavailable for this volume-workspace session - the opening prompt was not run. Check sandbox config/kill-switch and retry.",
							);
						}
					}

					for await (const event of sandboxOpeningRun ?? runAgent({
						prompt: openingPrompt,
						cwd: wtPath,
						mode: isScratch ? ("scratch" as const) : isAsk ? ("ask" as const) : ("code" as const),
						model,
						effort: createEffort,
						fastMode: createFastMode,
						accountId: createAccountId,
						fallbackModel: interactiveFallbackModel(model),
						// Feed workspaces default to their feed's scoped list (least
						// privilege) — same value the session file persists above.
						mcpServers: createMcpServers?.length ? createMcpServers : feedMcpServers,
						reposNote:
							[
								buildPlanFirstNote({
									mode: isScratch ? ("scratch" as const) : isAsk ? ("ask" as const) : ("code" as const),
									planFirst: msg.planFirst === true,
								}),
								buildBranchNote({
									mode: isScratch ? ("scratch" as const) : isAsk ? ("ask" as const) : ("code" as const),
									branch: sessionBranch,
									worktreeDir: wtPath,
								}),
								await memoryNoteFor(user, [repo.id]),
							]
								.filter(Boolean)
								.join("\n\n") || undefined,
						images,
						// Fork: resume the source engine session into a new branch,
						// optionally from a specific past message.
						...(canFork
							? {
									sessionId: forkSource!.claudeSessionId!,
									forkSession: true,
									resumeSessionAt: forkFrom?.messageId,
								}
							: {}),
						inProcessMcp: interactiveMcpServers(user, bksId),
						confirmTools: STRIPE_CONFIRM_TOOLS,
						aws: true, // interactive sessions keep AWS read access (via injected creds)
						user, // gate per-user MCP servers (allowedUsers) to the creator
						journal: { osSessionId: bksId, kind: "create" },
						onAskUser: makeAskHandler(bksId),
					})) {
						if (event.type === "init") {
							engineSessionId = event.sessionId || "";
							if (event.provider) effectiveProvider = event.provider;
							if (event.model) effectiveModel = event.model;
							// Session was persisted/announced before setup — just record
							// the engine id so the run is resumable while it streams.
							touchNativeSession(
								bksId,
								{
									...engineSessionPatch(
										effectiveProvider,
										engineSessionId,
									),
									...(engineSessionId
										? { lastEngineProvider: effectiveProvider }
										: {}),
									...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
								},
							);
							// The transcript file didn't exist when viewers sent their
							// watch (fresh session) — attach them now so this first turn
							// streams live instead of only appearing after a re-watch.
							if (engineSessionId) {
								attachSessionWatchersToEngineTranscript(
									bksId,
									effectiveProvider,
									wtPath,
									engineSessionId,
								);
							}
						}
						if (event.type === "model_switch") {
							const to = event.toModel || "";
							const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
							if (to) {
								effectiveModel = to;
								effectiveProvider = providerFor(to);
								if (shouldPersistModelSwitch(event)) {
									selectedModel = to;
									modelHistory.push({
										model: to,
										from: event.fromModel,
										at: new Date().toISOString(),
										by: reason,
									});
									touchNativeSession(bksId, {
										model: selectedModel,
										modelHistory,
									});
									emit({
										type: "model_changed",
										model: to,
										from: event.fromModel,
										by: reason,
									});
								} else {
									emit({
										type: "notice",
										message: `${modelLabel(event.fromModel)} ${event.switchReason || "fell back"} — using ${modelLabel(to)} for this turn only.`,
									});
								}
							}
						}
						if (event.type === "text_chunk") {
							emit({ type: "stream_text", text: event.text });
						}
						if (event.type === "tool_use") {
							const entry = {
								id: event.toolUseId || crypto.randomUUID(),
								type: "tool_use" as const,
								content: `Using ${event.toolName}`,
								timestamp: new Date().toISOString(),
								toolName: event.toolName,
								toolInput: event.toolInput,
								toolUseId: event.toolUseId,
							};
							emit({ type: "stream_tool_use", entry });
						}
						if (event.type === "tool_result") {
							const entry = {
								id: event.toolUseId
									? `tr-${event.toolUseId}`
									: crypto.randomUUID(),
								type: "tool_result" as const,
								content: event.content || "",
								timestamp: new Date().toISOString(),
								toolUseId: event.toolUseId,
								...(event.images && event.images.length > 0
									? { images: event.images }
									: {}),
								...(event.videos && event.videos.length > 0
									? { videos: event.videos }
									: {}),
							};
							emit({ type: "stream_tool_result", entry });
						}
						if (event.type === "usage_snapshot" && event.usage) {
							// Live mid-run cost/context. Snapshots are run-cumulative and
							// this is the session's only run, so the fold base is empty —
							// each snapshot recomputes the total from scratch (folding
							// onto latestUsage would double-count).
							latestUsage = foldSessionUsage(
								undefined,
								event.usage,
								effectiveModel,
							);
							emit({ type: "usage_update", usage: latestUsage });
						}
						if (event.type === "done") {
							engineSessionId = event.sessionId || engineSessionId;
							if (event.provider) effectiveProvider = event.provider;
							if (event.model) effectiveModel = event.model;
							if (event.usageLimitExhausted)
								runFailure =
									event.result || "Usage limit reached on every account";
							if (event.usage) {
								latestUsage = foldSessionUsage(
									undefined,
									event.usage,
									event.model || effectiveModel,
								);
								// emit (not a bare broadcast) so it also reaches the
								// creator's socket in the window before they watch.
								emit({ type: "usage_update", usage: latestUsage });
							}
							if (event.cacheMissWarning)
								emit({ type: "cache_warning", sessionId: bksId });
						}
						if (event.type === "error") {
							runFailure = event.content || "Run failed";
							if (event.noticePersisted) failureNoticePersisted = true;
							emit({ type: "error", message: event.content });
						}
					}

					if (!persisted) await persist();
					else
						touchNativeSession(
							bksId,
							{
								...engineSessionPatch(
									effectiveProvider,
									engineSessionId,
								),
								...(engineSessionId
									? { lastEngineProvider: effectiveProvider }
									: {}),
								...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
								...(modelHistory.length ? { modelHistory } : {}),
								// The opening turn may have switched branches in the
								// worktree (same sync as runSessionPromptInner's run-end
								// patch) — keep the record on the actual HEAD.
								...headBranchPatch(),
							},
						);
						// Persist opening-run usage regardless of which branch ran
						// above (persist() writes the base file without it).
						if (latestUsage)
							touchNativeSession(bksId, { usage: latestUsage });
					recordRunOutcome(bksId, runFailure, {
						engineSessionId,
						noticePersisted: failureNoticePersisted,
					});
					} finally {
						unmarkSessionStarting(bksId);
						// Safety net for throws before the worktree block's own finally
						// (persist/announce failures) — must never leak a session stuck
						// in "Waiting for workspace".
						preparingWorkspaces.delete(bksId);
					}

					emit({ type: "stream_done" });
					emit({ type: "session_status", isRunning: false });
					if (promptQueues.get(bksId)?.length)
						await drainQueue(bksId);
					else
						onHumanAsksSessionIdle(bksId);
				} catch (e: any) {
					// Failure after the early session_created: the client is already
					// in the session — close out the stream and surface the failure
					// there instead of leaving the viewer spinning. Before the
					// announce there's no session to scope to, so the raw error goes
					// straight back to the sender.
					if (announcedId) {
						emit({ type: "error", message: e.message || String(e) });
						emit({ type: "stream_done" });
						emit({
							type: "notice",
							message: `Session setup failed: ${e.message || String(e)}`,
						});
						emit({ type: "session_status", isRunning: false });
						// Persist the failure on the session file too — the live
						// events above are gone on reload, and a setup-failed session
						// (e.g. `git worktree add` refusing a branch name that
						// collides with an existing `name/...` ref) otherwise shows
						// as an inexplicably empty session (bks-019f472f, 2026-07-09).
						recordRunOutcome(
							announcedId,
							`Session setup failed: ${e.message || String(e)}`,
						);
					} else {
						ws.send(
							JSON.stringify({
								type: "error",
								message: e.message || String(e),
							}),
						);
					}
				}
				break;
			}
			// ── Collaborative notes (Yjs over the shared socket) ──
			case "watch_note": {
				const noteId = msg.noteId;
				if (!isValidNoteId(noteId)) {
					ws.send(
						JSON.stringify({ type: "error", message: "Invalid note id" }),
					);
					return;
				}
				// Leave any previously-watched note first (one note per client).
				leaveNote(ws);
				if (msg.user) ws.data.user = msg.user;
				ws.data.watchingNoteId = noteId;
				joinNote(ws, noteId);
				// Send the full current doc state so the client syncs immediately.
				ws.send(
					JSON.stringify({
						type: "note_state",
						noteId,
						update: b64encode(getNoteState(noteId)),
					}),
				);
				break;
			}

			case "leave_note": {
				leaveNote(ws);
				break;
			}

			case "note_update": {
				const noteId = msg.noteId;
				if (!isValidNoteId(noteId) || typeof msg.update !== "string")
					return;
				try {
					applyNoteUpdate(noteId, b64decode(msg.update));
				} catch {}
				// Relay to the other editors of this note.
				broadcastToNote(
					noteId,
					{ type: "note_update", noteId, update: msg.update },
					ws,
				);
				break;
			}

			case "note_awareness": {
				const noteId = msg.noteId;
				if (!isValidNoteId(noteId) || typeof msg.update !== "string")
					return;
				// Cursors/presence are ephemeral — relay only, never persist.
				broadcastToNote(
					noteId,
					{ type: "note_awareness", noteId, update: msg.update },
					ws,
				);
				break;
			}
		}
		} catch (e) {
			console.error(`[ws] ${msg?.type || "unknown"} handler failed:`, e);
			try {
				ws.send(
					JSON.stringify({
						type: "error",
						message: `Internal error handling "${msg?.type || "message"}" — see server log`,
					}),
				);
			} catch {}
		}
	},

	close(ws) {
		if (sandboxWsClose(ws)) return;
		if (nodeWsClose(ws)) return;
		closeCloudProxyProtocol(ws, (lane) =>
			websocketHandlers.close?.(lane, 1000, "cloud proxy disconnected"),
		);
		cloudWebSocketClientClosed(ws);
		allClients.delete(ws);
		stopAllWatchesForClient(ws);
		releaseTranscriptV2(ws);
		leaveSession(ws);
		leaveNote(ws);
		stopAllTerminals(ws); // the Shell tabs' PTYs die with their socket
		console.log("WebSocket client disconnected");
	},
};
