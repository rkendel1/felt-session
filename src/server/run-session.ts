/**
 * Driving a session turn: runSessionPrompt(Inner) and everything that feeds it —
 * the queue-coupled delivery ops (enqueue/steer/interrupt/drain), the sandbox
 * run launch, restart resume (journal snapshot + drained-session wake-up),
 * transcript watcher attachment, usage folding, auto-push, and the /loop ticker.
 *
 * Queue STATE lives in queue-state.ts; WS fan-out in ws-hub.ts; the session
 * cache in session-cache.ts.
 */

import { randomUUIDv7 } from "bun";
import { existsSync, readFileSync } from "fs";
import {
	runAgent,
	isAgentSessionBusy,
	markSessionStarting,
	unmarkSessionStarting,
	cancelAgentRun,
	steerAgentRun,
	interruptAgentRun,
	stopAgentRunTurn,
	engineFamily,
	interruptAndSteerAgentRun,
	RESUME_CONTINUATION_PROMPT,
	type StreamEvent,
} from "./agent-runner";
import { syncAgentSessionEngine } from "./agent-session-sync";
import {
	automationDeniedTools,
	automationMcpServersByName,
	selfImproveMcpForSession,
} from "./automations";
import { defaultRepo } from "./config";
import { isLocalProfile } from "./profile";
import {
	buildChatContextNote,
	buildEngineSwitchHandoffNote,
} from "./fork-handoff";
import { getGitStatus, gitPush } from "./git-status";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { parseTranscriptAsync } from "./jsonl-parser";
import {
	contextWindowFor,
	modelPreset,
	interactiveFallbackModel,
	modelLabel,
	providerFor,
} from "./models";
import {
	appendOpencodeTranscript,
	isOpencodeSessionId,
	storeAppendUserLineEarly,
	transcriptLineRunnerNotice,
	transcriptLineUser,
} from "./opencode-transcript";
import { wrapContext, stripContext } from "./prompt-context";
import { activeRunRecords, type ActiveRunRecord } from "./run-journal";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import { createSlackPostScanner, linkThreadInIndex } from "./slack-links";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import {
	engineSessionPatch,
	engineUserTexts,
	getEngineTranscriptPath,
	mergedSessionTranscript,
	mergedSessionTranscriptAsync,
	readEngineTranscriptAsync,
} from "./sessions";
import {
	getSandboxProvider,
	hasRemoteWorkspace,
	workspaceExecFor,
} from "./sandbox";
import {
	isRemoteSandboxProvider,
	isRunnableSandboxProvider,
	sandboxesEnabled,
	sandboxProviderConfigured,
} from "./sandbox/config";
import { getTitleOverride } from "./title-overrides";
import { ensureGeneratedTitle } from "./generated-titles";
import { gitIdentityFor } from "./shared/user-mappings";
import { writeFileAtomic, writeJsonAtomic } from "./shared/atomic-write";
import { startWatching } from "./file-watcher";
import { ensureAskCheckout, getRepo, isSharedCheckoutDir, repoForPath, reviveWorktree, worktreeHeadBranch } from "./worktree";
import { createGoalSelfMcpServer } from "../agents/slack/goal-tools";
import { sendSlackMessage } from "../agents/slack/slack-api";
import type { RunHostSpec } from "../runner-host/protocol";
import type { ImageInput, TurnUsage } from "./run-events";
import type {
	SessionUsage,
	TranscriptEntry,
	UnifiedSession,
} from "./types";
import {
	findSession,
	getCachedSessions,
	invalidateSessionsCache,
	recordRunOutcome,
	touchBackstageSession,
	SESSIONS_DIR,
} from "./session-cache";
import { broadcastToSession, sessionWatchers } from "./ws-hub";
import {
	broadcastQueue,
	clearSteerReceipts,
	isGitHubQueueItem,
	persistQueues,
	promptQueues,
	queuedPromptIndex,
	queueItem,
	QUEUE_STORE,
	recordSteer,
	requeueSteerReceipts,
	steerDelivered,
	steeredReceipts,
	stoppedSessions,
	type QueueItem,
} from "./queue-state";
import {
	parseImageDataUrls,
	stageFileAttachments,
	withUploadsNote,
} from "./uploads";
import { buildSessionNote } from "./session-repos";
import { interactiveMcpServers } from "./interactive-mcp";
import { makeAskHandler } from "./asks";
import { audit } from "./audit";
import {
	announcesNextAction,
	AUTO_CONTINUE_PROMPT,
	AUTO_CONTINUE_USER,
	INTERRUPT_STEER_NOTE,
} from "./auto-continue";
import { selectQueueBatch } from "./queue-hold";

const g = globalThis as any;

// Sessions whose last turn already got an announce-then-stop auto-continue —
// one consecutive WORKLESS nudge max, so a model that announces-and-stops twice
// in a row parks for the human instead of looping. Cleared when a human prompt
// arrives or a turn does real (tool-calling) work — which also means that while
// the agent keeps genuinely working through announced steps, queued messages
// stay held behind fresh auto-continues (the queue-hold in the run-end handler)
// until a turn ends without announcing more work.
const autoContinueNudged: Set<string> = (g.__autoContinueNudged ??= new Set());

// Sessions whose current queue head was delivered by aborting the running
// turn (busy-send interrupt). The next drain consumes the mark and appends
// INTERRUPT_STEER_NOTE so the model treats the delivery as a mid-task steer
// instead of a fresh turn it can acknowledge-and-park on. Timestamped so a
// mark whose drain never happens (user Stop) expires instead of mislabeling
// a much later, unrelated prompt.
const interruptDrainMarks: Map<string, number> = (g.__interruptDrainMarks ??=
	new Map());
const INTERRUPT_DRAIN_MARK_TTL_MS = 5 * 60_000;

function consumeInterruptDrainMark(sessionId: string): boolean {
	const at = interruptDrainMarks.get(sessionId);
	if (at === undefined) return false;
	interruptDrainMarks.delete(sessionId);
	return Date.now() - at < INTERRUPT_DRAIN_MARK_TTL_MS;
}

// When an interrupt targets a SPECIFIC queued item (the queue chip's send/▲
// button) rather than a fresh compose-send, only that one item should be
// delivered by the abort-driven drain — the rest of the queue stays put and
// drains at the next natural stopping point. Keyed by item id; timestamped so a
// marker whose drain never happens (e.g. the user hits Stop before it fires)
// expires instead of solo-delivering a stale item much later.
const interruptSoloItems: Map<string, { id: string; at: number }> =
	(g.__interruptSoloItems ??= new Map());

function consumeInterruptSoloItem(sessionId: string): string | undefined {
	const mark = interruptSoloItems.get(sessionId);
	if (!mark) return undefined;
	interruptSoloItems.delete(sessionId);
	if (Date.now() - mark.at >= INTERRUPT_DRAIN_MARK_TTL_MS) return undefined;
	return mark.id;
}

// One "queue held" notice per hold engagement (not one per watcher tick);
// cleared whenever a drain actually delivers a batch.
const queueHoldNotified: Set<string> = (g.__queueHoldNotified ??= new Set());

/**
 * Child worker runs (spawn_task / create_session with a parent link) keep the
 * parent session "logically working" past its own turn end: the worker's
 * report arrives as the parent's next turn, so a queued human message
 * delivered in the gap would land mid-task. The drain holds `hold`-tagged
 * items while any child run is busy; the queue chip's steer button is the
 * explicit deliver-sooner escape hatch.
 */
export function runningChildCount(sessionId: string): number {
	let n = 0;
	for (const s of getCachedSessions()) {
		if (s.parentSessionId !== sessionId || s.archived) continue;
		if (isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id)) n++;
	}
	return n;
}

/** Append a message to a session's drainable queue and persist + broadcast.
 *  `front` puts it ahead of everything already queued — used by the run-end
 *  queue-hold so its auto-continue delivers before the user's queued messages. */
export function enqueuePrompt(
	sessionId: string,
	item: QueueItem,
	opts?: { front?: boolean },
): void {
	const queue = promptQueues.get(sessionId) || [];
	if (opts?.front) queue.unshift(queueItem(item));
	else queue.push(queueItem(item));
	promptQueues.set(sessionId, queue);
	persistQueues();
	broadcastQueue(sessionId);
	// Queueing is a delivery promise, not just a UI state. Arm the idle watcher
	// here so every queued message drains after the current run, even if a caller
	// forgets to do that explicitly or the session becomes idle between checks.
	watchExternalRunAndDrain(sessionId);
}

export function steerQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
): boolean {
	const session = findSession(sessionId);
	const queue = promptQueues.get(sessionId);
	if (!session || !queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const [item] = queue.splice(index, 1);
	if (!item) return false;
	if (
		!isAgentSessionBusy(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		)
	) {
		// Idle-but-queued (typically held behind running child workers): "steer"
		// means "get this in front of the agent now" — deliver it as its own
		// turn immediately. The rest of the queue keeps its hold.
		if (queue.length > 0) promptQueues.set(sessionId, queue);
		else promptQueues.delete(sessionId);
		stoppedSessions.delete(sessionId);
		persistQueues();
		broadcastQueue(sessionId);
		const files =
			Array.isArray(item.files) && item.files.length > 0
				? item.files
				: undefined;
		void runSessionPromptAndDrain(
			sessionId,
			item.content,
			item.user,
			parseImageDataUrls(item.images || []),
			files,
		).catch((e) => {
			console.error(`[queue] Steer-deliver failed for ${sessionId}:`, e);
			enqueuePrompt(sessionId, item);
		});
		return true;
	}
	// Files can't ride a steer (the fold path is text+images only). GitHub FYI
	// items CAN steer — folding in is non-interrupting, so it's the right
	// delivery for them too (they only land in the queue when a steer at
	// delivery time found nothing steerable).
	if (Array.isArray(item.files) && item.files.length > 0) {
		queue.splice(index, 0, item);
		return false;
	}
	const attributed = item.user ? `[${item.user}] ${item.content}` : item.content;
	const images = parseImageDataUrls(item.images || []);
	if (
		!steerAgentRun(
			[session.claudeSessionId, session.codexThreadId, session.id],
			attributed,
			images,
		)
	) {
		queue.splice(index, 0, item);
		return false;
	}
	if (queue.length > 0) promptQueues.set(sessionId, queue);
	else promptQueues.delete(sessionId);
	recordSteer(sessionId, item);
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Interrupt-deliver a waiting message: abort the run's current turn so the
 * message lands right away instead of at the next natural stopping point.
 * Two cases: an already-steered receipt just needs a bare interrupt (its text
 * is in the run's steer buffer — the forced boundary releases it; pushing it
 * again would double-deliver), while a queued item is folded in through the
 * interrupt-and-steer path. False = still queued, nothing was interrupted.
 */
export function interruptQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
): boolean {
	const session = findSession(sessionId);
	if (!session) return false;
	if (queueId && (steeredReceipts.get(sessionId) || []).some((s) => s.id === queueId)) {
		// Receipt stays visible until the message lands in the transcript (the
		// usual reconcile) — dropping it here would lose it if the interrupt
		// fires between release and delivery.
		return interruptAgentRun([
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		]);
	}
	const queue = promptQueues.get(sessionId);
	if (!queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const [item] = queue.splice(index, 1);
	if (!item) return false;
	if (isGitHubQueueItem(item) || (Array.isArray(item.files) && item.files.length > 0)) {
		queue.splice(index, 0, item);
		return false;
	}
	const attributed = item.user ? `[${item.user}] ${item.content}` : item.content;
	const images = parseImageDataUrls(item.images || []);
	if (
		!isAgentSessionBusy(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		)
	) {
		queue.splice(index, 0, item);
		return false;
	}
	if (
		!interruptAndSteerAgentRun(
			[session.claudeSessionId, session.codexThreadId, session.id],
			attributed,
			images,
		)
	) {
		// No in-band interrupt-and-steer (opencode): keep the item queued — it's
		// the durable record — and abort the turn so the drain delivers it right
		// away. Mark it (by id) as the solo delivery so the drain delivers ONLY
		// this item; every other queued item stays put and drains at the next
		// natural stopping point instead of being swept into this batch. Kept at
		// its original position so the queue doesn't visibly reshuffle.
		const solo = queueItem(item);
		queue.splice(index, 0, solo);
		promptQueues.set(sessionId, queue);
		interruptSoloItems.set(sessionId, { id: solo.id!, at: Date.now() });
		persistQueues();
		broadcastQueue(sessionId);
		return abortTurnAndDrain(sessionId, session);
	}
	// No steer receipt: an interrupt delivers almost immediately, so the
	// transcript entry is the record (same treatment as a direct interrupt send).
	if (queue.length > 0) promptQueues.set(sessionId, queue);
	else promptQueues.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Restore queued + steered messages a previous process left behind (a real
 * restart/crash — hot reloads keep the in-memory maps). Drainable queue items
 * are re-armed for delivery; unconfirmed steer receipts are folded back into the
 * queue too (best-effort: we can't know whether their turn landed before the
 * crash, and silently dropping the user's message is the worse failure). Call
 * after resumeInterruptedRuns so a session being resumed reads as busy and the
 * watcher waits it out instead of starting a colliding run.
 */
export function restorePromptQueues(): void {
	if (!existsSync(QUEUE_STORE)) return;
	let data: {
		queued?: Record<string, QueueItem[]>;
		steered?: Record<string, QueueItem[]>;
	};
	try {
		data = JSON.parse(readFileSync(QUEUE_STORE, "utf-8"));
	} catch (e) {
		// Corrupt store — these are the user's queued messages, so don't just
		// drop them: fall back to the .bak persistQueues keeps of the last copy.
		console.error("[queue] Failed to read persisted queues:", e);
		try {
			data = JSON.parse(readFileSync(`${QUEUE_STORE}.bak`, "utf-8"));
			console.warn("[queue] Recovered persisted queues from .bak");
		} catch (e2) {
			console.error(
				"[queue] Backup queue store unreadable too — queued messages lost:",
				e2,
			);
			return;
		}
	}
	const merged = new Map<string, QueueItem[]>();
	for (const [id, items] of Object.entries(data.queued || {})) {
		if (items?.length) merged.set(id, [...items]);
	}
	for (const [id, items] of Object.entries(data.steered || {})) {
		if (!items?.length) continue;
		// A persisted steer receipt whose message already sits in the engine
		// history landed before the restart — re-delivering it from the queue
		// would duplicate it (same rule as requeueSteerReceipts). Plain queued
		// items above are exempt: they were never delivered anywhere.
		const session = findSession(id);
		const delivered = session ? engineUserTexts(session) : [];
		const undelivered = delivered.length
			? items.filter((item) => !steerDelivered(item, delivered))
			: items;
		if (!undelivered.length) continue;
		merged.set(id, [...(merged.get(id) || []), ...undelivered]);
	}
	steeredReceipts.clear();
	let restored = 0;
	for (const [id, items] of merged) {
		if (!findSession(id)) continue; // session no longer exists — drop
		promptQueues.set(id, items);
		restored += items.length;
		watchExternalRunAndDrain(id); // drains once idle; waits out a resumed run
	}
	persistQueues();
	if (restored > 0) {
		console.log(
			`[queue] Restored ${restored} queued message(s) from before restart`,
		);
	}
}

// ── Wake-all-active-sessions on restart ──────────────────────────────────────
// The run journal (active-runs.json) only retains runs that are STILL executing
// when the process exits. During a graceful restart the 2-min drain lets runs
// finish their current turn — which clears them from the journal — so a session
// that stopped at a turn boundary mid-task was silently NOT resumed (the user had
// to type "continue"). To fix that we snapshot every active session the moment
// SIGTERM arrives (before the drain) and, on boot, nudge any that the journal
// resume didn't already cover. Crash (no graceful shutdown) still falls back to
// the journal, so both paths are covered.
const RESUME_SNAPSHOT_PATH = `${SESSIONS_DIR}/active-at-shutdown.json`;

/** Capture the sessions with an in-flight run, for boot-time wake-up. Called at
 *  the very start of graceful shutdown, before the drain empties the journal. */
export function snapshotActiveSessions(): void {
	try {
		const records = activeRunRecords();
		if (records.length === 0) {
			if (existsSync(RESUME_SNAPSHOT_PATH))
				writeFileAtomic(RESUME_SNAPSHOT_PATH, "[]");
			return;
		}
		writeJsonAtomic(RESUME_SNAPSHOT_PATH, records, false);
		console.log(
			`[resume] Snapshotted ${records.length} active session(s) for wake-up on restart`,
		);
	} catch (e) {
		console.error("[resume] Failed to snapshot active sessions:", e);
	}
}

/** Wake sessions that were active at the last graceful shutdown but finished
 *  their turn during the drain (so they weren't in the journal to resume).
 *  `alreadyResumed` are the bksSessionIds the journal resume already handled. */
export function resumeDrainedSessions(alreadyResumed: Set<string>): void {
	let records: ActiveRunRecord[] = [];
	try {
		if (!existsSync(RESUME_SNAPSHOT_PATH)) return;
		records = JSON.parse(readFileSync(RESUME_SNAPSHOT_PATH, "utf-8"));
	} catch (e) {
		console.error("[resume] Failed to read active-session snapshot:", e);
		return;
	}
	// Consume the snapshot so the next (non-graceful) boot doesn't replay it.
	try {
		writeFileAtomic(RESUME_SNAPSHOT_PATH, "[]");
	} catch {}

	let woken = 0;
	for (const r of records) {
		const id = r.bksSessionId;
		if (!id || alreadyResumed.has(id)) continue; // journal already resumed it
		if (r.kind?.startsWith("github-")) continue; // github agent owns its recovery
		const session = findSession(id);
		// Only interactive backstage sessions — never re-trigger automations/loops,
		// which are one-shot and would re-run their whole task.
		if (!session || session.source !== "backstage" || session.automation)
			continue;
		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		)
			continue;
		if (providerFor(session.model) === "claude" && !session.claudeSessionId)
			continue;
		woken++;
		console.log(
			`[resume] Waking session ${id} that finished its turn during the drain`,
		);
		void runSessionPromptAndDrain(
			id,
			RESUME_CONTINUATION_PROMPT,
			"system (restart)",
		).catch((e) => console.error(`[resume] Wake failed for ${id}:`, e));
	}
	if (woken > 0)
		console.log(
			`[resume] Woke ${woken} drained session(s) from before restart`,
		);
}

/** Per-session Slack-post scanners for recovered (reattached/resumed) runs —
 *  see the capture block in recordRecoveredRunEvent. Cleared on done/error. */
const recoveredSlackScanners = new Map<
	string,
	ReturnType<typeof createSlackPostScanner>
>();

/**
 * A preset session (dial/orchestrator) keeps its preset id as the stored
 * model: the runner's init/done events report the preset's resolved MAIN
 * model, and persisting that would silently disengage the preset (oracle /
 * workers + effort) after the first turn. Genuine fallback switches
 * (model_switch) still overwrite — a preset that fell off its main model is
 * disengaged by design.
 */
function keepsPresetModel(session: { model?: string }): boolean {
	return !!modelPreset(session.model);
}

export function recordRecoveredRunEvent(bksSessionId: string, event: StreamEvent): void {
	const session = findSession(bksSessionId);
	if (!session) return;
	if (session.source !== "backstage") {
		// Slack/linear-source sessions: a recovered run's engine-id/model flips
		// persist into the owning agent's store, same rationale as the init/
		// model_switch handlers in runSessionPromptInner — a reattached run that
		// had fallback-minted a new engine session must not leave the session
		// file pointing at the dead one.
		if (event.type === "model_switch" && event.toModel) {
			if (syncAgentSessionEngine(session, { model: event.toModel }))
				invalidateSessionsCache();
		} else if (
			(event.type === "init" || event.type === "done") &&
			event.sessionId
		) {
			if (
				syncAgentSessionEngine(session, {
					engineSessionId: event.sessionId,
					model: keepsPresetModel(session) ? undefined : event.model || undefined,
				})
			)
				invalidateSessionsCache();
			if (session.worktreeDir)
				attachSessionWatchersToEngineTranscript(
					bksSessionId,
					event.provider || providerFor(event.model || session.model),
					session.worktreeDir,
					event.sessionId,
				);
		}
		return;
	}

	// Capture Slack posts so a reply in the posted thread routes back to this
	// session (slack-links index). runAutomation does the same for normal runs;
	// this covers runs that were REATTACHED/resumed after a restart — their
	// events no longer flow through runAutomation's loop (that's how the
	// 2026-07-16 dispute runs lost their thread links).
	{
		let scan = recoveredSlackScanners.get(bksSessionId);
		if (!scan) {
			scan = createSlackPostScanner();
			recoveredSlackScanners.set(bksSessionId, scan);
		}
		const post = scan(event);
		if (post) {
			const threads = session.slackThreads || [];
			if (
				!threads.some(
					(t) => t.channel === post.channel && t.threadTs === post.threadTs,
				)
			) {
				touchBackstageSession(bksSessionId, {
					slackThreads: [...threads, { channel: post.channel, threadTs: post.threadTs }],
				});
				linkThreadInIndex(bksSessionId, post.channel, post.threadTs);
				invalidateSessionsCache();
			}
		}
		if (event.type === "done" || event.type === "error")
			recoveredSlackScanners.delete(bksSessionId);
	}

	if (event.type === "model_switch") {
		const to = event.toModel || "";
		if (!to) return;
		const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
		touchBackstageSession(bksSessionId, {
			model: to,
			modelHistory: [
				...(session.modelHistory || []),
				{ model: to, from: event.fromModel, at: new Date().toISOString(), by: reason },
			],
		});
		invalidateSessionsCache();
		return;
	}

	if (event.type !== "init" && event.type !== "done") return;
	const engineSessionId = event.sessionId || "";
	const model = event.model || session.model;
	const provider = event.provider || providerFor(model);
	touchBackstageSession(bksSessionId, {
		...(engineSessionId ? engineSessionPatch(provider, engineSessionId) : {}),
		...(model && !keepsPresetModel(session) ? { model } : {}),
	});
	if (engineSessionId && session.worktreeDir) {
		attachSessionWatchersToEngineTranscript(
			bksSessionId,
			provider,
			session.worktreeDir,
			engineSessionId,
		);
	}
	invalidateSessionsCache();
}

/**
 * Attach every socket viewing `sessionId` to a transcript file that only came
 * into existence after they started watching — a fresh chat's first run (no
 * transcriptPath existed at watch time), or an engine-id rotation forking to a
 * new file mid-conversation. Without this the whole run is silent for viewers:
 * the sent message sticks at "sending…" and the reply vanishes at stream_done,
 * until a reload re-watches the right file. Streams from byte 0 — entry ids
 * are the jsonl line uuids, so anything the client already has upserts
 * instead of duplicating.
 */
export function attachSessionWatchersToTranscript(
	sessionId: string,
	path: string,
): void {
	const set = sessionWatchers.get(sessionId);
	if (!set) return;
	for (const ws of set) {
		// Transcript v2 viewers (ws-handlers.ts serveTranscriptV2) are fed by
		// the in-process bus — force-registering them onto the (new) mirror
		// watch would double-feed a full-file replay.
		if ((ws as any)?.data?.transcriptV2) continue;
		startWatching(path, ws, 0, sessionId);
	}
}

export function attachSessionWatchersToEngineTranscript(
	sessionId: string,
	// "opencode" resolves to no transcript path (opencode keeps its own storage);
	// those sessions stream through run events only, so this attaches nothing.
	provider: "claude" | "codex" | "opencode",
	cwd: string,
	engineSessionId: string,
	attempt = 0,
): void {
	const path = getEngineTranscriptPath(cwd, engineSessionId, provider);
	if (path) {
		attachSessionWatchersToTranscript(sessionId, path);
		return;
	}
	if (provider === "codex" && attempt < 5) {
		setTimeout(
			() =>
				attachSessionWatchersToEngineTranscript(
					sessionId,
					provider,
					cwd,
					engineSessionId,
					attempt + 1,
				),
			250,
		);
	}
}

export async function drainQueue(sessionId: string): Promise<void> {
	let queue;
	while ((queue = promptQueues.get(sessionId)) && queue.length > 0) {
		// The user pressed stop: leave the queue visible-but-parked until their
		// next explicit action instead of restarting the run they just stopped.
		if (stoppedSessions.has(sessionId)) return;
		// A racing run can own the session by the time we loop again (e.g. our
		// last batch lost the start race and got re-queued) — hand off to the
		// idle-watcher instead of busy-spinning runs that immediately bounce.
		const session = findSession(sessionId);
		if (
			session &&
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		) {
			watchExternalRunAndDrain(sessionId);
			return;
		}
		// Batch selection lives in queue-hold.ts (pure, unit-tested): a solo
		// interrupt (queue chip ▲) delivers one item, a head auto-continue
		// delivers alone, and while child worker runs are still going, human
		// composer sends (item.hold) stay parked until the agent FULLY
		// completes. Orchestration traffic (worker reports, FYIs) keeps
		// flowing so held items can't wedge the run.
		const plan = selectQueueBatch(queue, {
			soloId: consumeInterruptSoloItem(sessionId),
			interruptMark: interruptDrainMarks.has(sessionId),
			stillWorking: runningChildCount(sessionId) > 0,
		});
		if (plan.kind === "hold") {
			if (!queueHoldNotified.has(sessionId)) {
				queueHoldNotified.add(sessionId);
				broadcastToSession(sessionId, {
					type: "notice",
					sessionId,
					message: `Holding ${plan.heldCount} queued message${plan.heldCount === 1 ? "" : "s"} until the agent fully completes (worker sessions still running). Steer sends one in sooner.`,
				});
			}
			watchExternalRunAndDrain(sessionId);
			return;
		}
		queueHoldNotified.delete(sessionId);
		const batch = plan.batch;
		if (plan.rest.length > 0) promptQueues.set(sessionId, plan.rest);
		else promptQueues.delete(sessionId);
		persistQueues();
		broadcastQueue(sessionId);
		let combined = batch
			.map((m) =>
				batch.length > 1 && m.user ? `[${m.user}] ${m.content}` : m.content,
			)
			.join("\n\n");
		// Interrupt delivery (busy-send aborted the turn to land this batch):
		// append the fenced steer note so the model resumes the interrupted work
		// instead of acknowledge-and-parking. Fenced, so the transcript shows
		// only the user's text.
		if (consumeInterruptDrainMark(sessionId)) {
			combined = `${combined}\n\n${wrapContext(INTERRUPT_STEER_NOTE)}`;
		}
		// Attachments queued alongside the text ride the drained turn: images are
		// decoded to ImageInput, files handed through as staged/inline refs.
		const combinedImages = parseImageDataUrls(
			batch.flatMap((m) => m.images ?? []),
		);
		const combinedFiles = batch.flatMap((m) =>
			Array.isArray(m.files) ? m.files : [],
		);
		// A queued Slack-thread reply carries its origin thread — the turn's answer
		// mirrors back there. Last one wins if a batch somehow spans threads.
		const slackReplyTo = [...batch].reverse().find((m) => m.slackReplyTo)?.slackReplyTo;
		try {
			await runSessionPrompt(
				sessionId,
				combined,
				batch[0].user,
				combinedImages,
				combinedFiles.length ? combinedFiles : undefined,
				undefined,
				slackReplyTo,
			);
		} catch (e) {
			// The batch was already spliced out and persisted away — put it back at
			// the front of the queue so a throw doesn't lose the messages.
			const current = promptQueues.get(sessionId) || [];
			promptQueues.set(sessionId, [...batch, ...current]);
			persistQueues();
			broadcastQueue(sessionId);
			throw e;
		}
	}
}

export async function runSessionPromptAndDrain(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextChats?: string[],
	slackReplyTo?: { channel: string; threadTs: string },
): Promise<void> {
	await runSessionPrompt(sessionId, content, user, images, rawFiles, contextChats, slackReplyTo);
	await drainQueue(sessionId);
}

// Messages queued while a run we didn't start is in flight (Slack runs, CLI
// sessions in tmux, automations) have no drain loop of their own — watch the
// busy state and deliver the queue once the external run finishes.
const drainWatchers: Set<string> = (g.__drainWatchers ??= new Set());
export function watchExternalRunAndDrain(sessionId: string): void {
	if (drainWatchers.has(sessionId)) return;
	drainWatchers.add(sessionId);
	const timer = setInterval(async () => {
		const session = findSession(sessionId);
		if (!session || !(promptQueues.get(sessionId) || []).length) {
			clearInterval(timer);
			drainWatchers.delete(sessionId);
			return;
		}
		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		)
			return;
		clearInterval(timer);
		drainWatchers.delete(sessionId);
		try {
			await drainQueue(sessionId);
		} catch (e) {
			console.error(
				`[queue] Drain after external run failed for ${sessionId}:`,
				e,
			);
		}
	}, 3000);
}

/**
 * Esc+Enter for engines with no in-band interrupt-and-steer (opencode): abort
 * the run's current turn — the same abort the Esc/stop path uses — and let the
 * drain watcher deliver the queue as the immediate next turn on the same
 * engine session. The interrupting message must already be in promptQueues
 * before calling (durability: nothing is lost if the abort races a crash).
 * False = nothing abortable (external CLI/tmux run) — the message stays queued
 * for the run's natural stopping point.
 */
export function abortTurnAndDrain(
	sessionId: string,
	session: {
		claudeSessionId?: string | null;
		codexThreadId?: string | null;
		opencodeSessionId?: string | null;
		transcriptPath?: string | null;
		id: string;
	},
): boolean {
	const ids = [session.claudeSessionId, session.codexThreadId, session.id];
	const aborted = stopAgentRunTurn(ids) || cancelAgentRun(...ids);
	if (!aborted) return false;
	// The user explicitly asked for delivery now — unpark an earlier Stop, and
	// fold steer receipts the engine never got back in ahead so nothing is
	// dropped (landed steers are already in the engine history — requeueing
	// them would deliver duplicates).
	stoppedSessions.delete(sessionId);
	requeueSteerReceipts(sessionId, engineUserTexts(session));
	// The drained batch is an interrupt delivery: flag it so the drain frames
	// it as a mid-task steer (see INTERRUPT_STEER_NOTE).
	interruptDrainMarks.set(sessionId, Date.now());
	watchExternalRunAndDrain(sessionId);
	return true;
}

/**
 * Fold a completed run's usage into a session's cumulative totals. Cost and
 * token counts accumulate; context size (contextTokens/contextWindow) reflects
 * the latest turn rather than a sum — it's the current window fill, not lifetime
 * throughput. `costApproximate` sticks once any Codex run contributes a
 * table-priced (non-authoritative) figure.
 */
export function foldSessionUsage(
	prev: SessionUsage | undefined,
	turn: TurnUsage,
	model?: string | null,
): SessionUsage {
	const base: SessionUsage = prev ?? {
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		contextTokens: 0,
		contextWindow: 0,
		turns: 0,
		updatedAt: "",
	};
	return {
		costUsd: base.costUsd + (turn.costUsd || 0),
		...(base.costApproximate || turn.costApproximate
			? { costApproximate: true }
			: {}),
		inputTokens: base.inputTokens + turn.inputTokens,
		outputTokens: base.outputTokens + turn.outputTokens,
		cacheReadTokens: base.cacheReadTokens + turn.cacheReadTokens,
		cacheCreationTokens: base.cacheCreationTokens + turn.cacheCreationTokens,
		contextTokens: turn.contextTokens || base.contextTokens,
		contextWindow: contextWindowFor(model) || base.contextWindow,
		turns: base.turns + 1,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Silent auto-push: when a session's turn ends idle, publish any local commits
 * that are ahead of an already-tracked upstream. This is the real "sessions push
 * automatically" mechanism — the agent's prompt-level `git push` is best-effort
 * and silently misses whenever a turn ends between commit and push (or the
 * commits landed outside a turn), leaving the status header parked on a stale
 * "Ahead by N commits". We only touch a branch that:
 *   - is NOT the repo's default branch — never auto-push main/master (this also
 *     excludes the backstage shared checkout, which pushes master by hand), and
 *   - already has an upstream (published once, so pushing follow-up commits is
 *     the expected sync; an un-pushed branch with no PR goes via Create PR), and
 *   - is strictly ahead (behind === 0) — a diverged branch needs a human/agent
 *     to reconcile, and a plain push would be rejected anyway.
 * Never forces. A failed push is swallowed (logged) — it just leaves the Push
 * button as the visible fallback. Fire-and-forget from the turn-end path so it
 * never delays draining the queue; a `git_pushed` broadcast nudges the header to
 * refetch the instant the push lands.
 */
export async function autoPushSessionBranches(session: UnifiedSession): Promise<void> {
	const targets: Array<{ dir: string; branch: string; repoId: string }> = [];
	const primaryRepoId =
		session.repo ||
		(session.worktreeDir ? repoForPath(session.worktreeDir).id : "tella-fusion");
	if (session.worktreeDir && session.branch)
		targets.push({
			dir: session.worktreeDir,
			branch: session.branch,
			repoId: primaryRepoId,
		});
	for (const att of session.attachedRepos || [])
		if (att.dir && att.branch)
			targets.push({ dir: att.dir, branch: att.branch, repoId: att.repo });

	for (const { dir, branch, repoId } of targets) {
		// The primary dir of a volume-mode sandbox workspace exists only in the
		// container — status/push route through the session's sandbox exec.
		const isPrimary = dir === session.worktreeDir;
		const remote = isPrimary && hasRemoteWorkspace(session);
		if (!existsSync(dir) && !remote) continue;
		let repo;
		try {
			repo = getRepo(repoId);
		} catch {
			continue;
		}
		// Never auto-push the repo's mainline (covers the backstage shared master).
		if (branch === repo.defaultBranch) continue;
		const exec = isPrimary ? await workspaceExecFor(session, dir) : undefined;
		let git;
		try {
			git = await getGitStatus(dir, repo.defaultBranch, exec);
		} catch {
			continue;
		}
		if (!git.hasUpstream || git.ahead <= 0 || git.behind > 0) continue;
		const result = await gitPush(dir, branch, exec);
		if ("error" in result) {
			console.warn(
				`[auto-push] ${session.id} ${repoId}/${branch}: ${result.error}`,
			);
		} else {
			console.log(
				`[auto-push] ${session.id} ${repoId}/${branch}: pushed ${git.ahead} commit(s)`,
			);
			broadcastToSession(session.id, {
				type: "git_pushed",
				sessionId: session.id,
				repo: repoId,
			});
		}
	}
}


/**
 * Sandbox routing for runSessionPromptInner (docs/sandboxes-plan.md Phase 1;
 * generalized to every registry provider — docker/daytona/e2b). Returns the
 * run's event stream when the session opted into a sandbox at create time AND
 * the kill-switch + provider config currently allow it — otherwise null, and
 * the caller's existing in-process runAgent path runs completely unchanged
 * (sessions without a `sandbox` field can never reach any of this).
 *
 * Every failure mode falls back to null (in-process on the host): that is
 * exactly today's trust level for interactive sessions, and a session must
 * never lose a prompt to sandbox infrastructure. The exception is volume
 * workspaces (docker volume mode, and remote providers — always volume):
 * they have no host checkout, so the CALLER turns a null into a clean turn
 * error instead of a host run. Automation-owned sessions are refused
 * outright — sandboxes carry interactive-parity credentials (~/.ssh, gh,
 * account pool / scoped OAuth upload) that untrusted prompt text must not
 * reach.
 */
export async function maybeLaunchSandboxedRun(
	session: UnifiedSession,
	opts: {
		prompt: string;
		engineSessionId?: string;
		cwd: string;
		user?: string;
		images?: ImageInput[];
		mcpServers?: string[];
		isAutomationSession: boolean;
	},
): Promise<(AsyncGenerator<StreamEvent> & { freshEngine?: boolean }) | null> {
	const sbProvider = session.sandbox?.provider;
	if (!isRunnableSandboxProvider(sbProvider)) return null; // "local"/absent/unknown = host
	if (!sandboxesEnabled()) return null; // kill-switch file — instant revert
	if (!sandboxProviderConfigured(sbProvider)) {
		// Config gone / API key removed since create — same instant-revert
		// semantics as the kill switch (volume workspaces get the caller's
		// no-host-fallback turn error instead of a silent host run).
		console.warn(`[sandbox] ${session.id}: provider "${sbProvider}" is no longer configured — not sandboxing`);
		return null;
	}
	if (opts.isAutomationSession) {
		console.warn(`[sandbox] ${session.id}: automation sessions are not sandboxed in Phase 1 — running on host`);
		return null;
	}
	// Hoisted so the catch below can unregister it — a failed launch must not
	// leak the run token (spawnHostRun's error path does the same cleanup).
	let rpcToken: string | undefined;
	try {
		const provider = getSandboxProvider(sbProvider);
		const sandbox = await provider.ensure({
			sessionId: session.id,
			repo: session.repo,
			branch: session.branch || undefined,
			mode: session.mode,
			cwd: opts.cwd,
			// Bind-mode containers mount attached repos too (a changed set
			// recreates the container); volume mode rejects them in ensure().
			attachedDirs: (session.attachedRepos || [])
				.map((r) => r.dir)
				.filter(Boolean),
		});
		// Remote engine databases live inside the sandbox. A replacement VM cannot
		// resume the old engine id, even when its git workspace was safely pushed.
		const remoteSandboxReplaced =
			isRemoteSandboxProvider(sbProvider) &&
			session.sandbox?.sandboxId !== sandbox.id;
		if (
			session.source === "backstage" &&
			(session.sandbox?.sandboxId !== sandbox.id ||
				session.sandbox?.workspace !== sandbox.workspace)
		) {
			touchBackstageSession(session.id, {
				sandbox: {
					provider: sbProvider,
					sandboxId: sandbox.id,
					// Record how the workspace materialized ("volume" = it lives only
					// inside the sandbox; host existsSync guards must not gate it).
					workspace: sandbox.workspace,
				},
				...(remoteSandboxReplaced
					? {
							claudeSessionId: undefined,
							codexThreadId: undefined,
							opencodeSessionId: undefined,
						}
					: {}),
			});
		}
		// opensession-* tools reach the container as stdio proxies over the run-rpc
		// socket — same path Codex and hosted runs use. The names must match
		// what the registered InteractiveMcpBuilder can build for this session —
		// including opensession-goal-self for goal-driven sessions (the builder adds
		// it from the session's goalId, mirroring the in-process path below).
		const proxyMcpServers = [
			...Object.keys(interactiveMcpServers(opts.user, session.id)),
			...(session.goalId ? ["opensession-goal-self"] : []),
		];
		rpcToken = crypto.randomUUID();
		registerRunToken(rpcToken, { sessionId: session.id, user: opts.user });
		const spec: RunHostSpec = {
			hostId: `rh-${randomUUIDv7()}`,
			bksSessionId: session.id,
			prompt: opts.prompt,
			engineSessionId: remoteSandboxReplaced
				? undefined
				: opts.engineSessionId || undefined,
			cwd: sandbox.cwd,
			mode: session.mode,
			model: session.model,
			images: opts.images,
			mcpServers: opts.mcpServers,
			proxyMcpServers,
			rpcToken,
			reposNote: await buildSessionNote(session, opts.user),
			confirmTools: STRIPE_CONFIRM_TOOLS,
			aws: true,
			author: gitIdentityFor(opts.user),
			user: opts.user,
			fallbackModel: interactiveFallbackModel(session.model),
			effort: session.effort,
			fastMode: session.fastMode,
			accountId: session.accountId,
			journalKind: "prompt",
		};
		const runCallbacks = {
			onAskUser: makeAskHandler(session.id),
			// A steer that reached the in-container run too late must not
			// evaporate — queue it like the busy-path does.
			onSteerFailed: (text: string) => {
				enqueuePrompt(session.id, { content: text, user: opts.user });
				watchExternalRunAndDrain(session.id);
			},
		};
		// Launch EAGERLY (docker exec + socket connect awaited here) so a failure
		// is caught by this try/catch and falls back to the host run — a lazy
		// launch would only surface the failure as an error bubble mid-stream,
		// after the fallback window has closed.
		const handle = sandbox.launchRunEager
			? await sandbox.launchRunEager(spec, runCallbacks)
			: sandbox.launchRun(spec, runCallbacks);
		console.log(`[sandbox] ${session.id}: running in ${sandbox.id} (${sandbox.cwd})`);
		return Object.assign(handle.events(), {
			freshEngine: remoteSandboxReplaced || undefined,
		});
	} catch (e: any) {
		// The token was registered mid-try; the failed run will never consume it.
		unregisterRunToken(rpcToken);
		const reason = String(e?.message || e).slice(0, 200);
		// Daytona's WS dial-back is the launch step that fails when egress is
		// blocked (lower org tiers) or callbackBaseUrl isn't sandbox-reachable.
		const dialBackHint =
			sbProvider === "daytona"
				? " If the sandbox could not dial back, check callbackBaseUrl and your Daytona org tier's egress — see docs/self-hosting-sandboxes.md."
				: "";
		if (hasRemoteWorkspace(session)) {
			// Volume-mode workspaces live only inside the sandbox — there is no
			// host checkout to fall back to (the caller ends the turn with an
			// explicit error), so don't promise a host run.
			console.error(`[sandbox] ${session.id}: launch failed (volume workspace — no host fallback):`, e);
			broadcastToSession(session.id, {
				type: "notice",
				message: `Sandbox unavailable (${reason}) — this workspace lives in the sandbox and has no host fallback. Retry when the ${sbProvider} sandbox is healthy.${dialBackHint}`,
			});
		} else {
			console.error(`[sandbox] ${session.id}: launch failed — falling back to host run:`, e);
			broadcastToSession(session.id, {
				type: "notice",
				message: `Sandbox unavailable (${reason}) — running on the host this turn.`,
			});
		}
		return null;
	}
}


/** Run a prompt against an existing session, broadcasting to all watchers. */
export async function runSessionPrompt(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextChats?: string[],
	slackReplyTo?: { channel: string; threadTs: string },
): Promise<void> {
	// Any explicit new run lifts a user stop — the queue may drain again.
	stoppedSessions.delete(sessionId);
	// Synchronously reserve the session BEFORE the awaits below (worktree revive,
	// title gen, upload staging) register the run with the runner — otherwise two
	// racing prompts both pass isAgentSessionBusy and the loser's message is
	// dropped as a "Session is busy" error toast.
	markSessionStarting(sessionId);
	try {
		await runSessionPromptInner(sessionId, content, user, images, rawFiles, contextChats, slackReplyTo);
	} finally {
		unmarkSessionStarting(sessionId);
	}
}

async function runSessionPromptInner(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextChats?: string[],
	slackReplyTo?: { channel: string; threadTs: string },
): Promise<void> {
	const session = findSession(sessionId);
	if (!session) return;

	// A fresh human prompt re-arms the announce-then-stop guard (the nudge's
	// own delivery keeps the flag, capping it at one consecutive auto-continue).
	if (user !== AUTO_CONTINUE_USER) autoContinueNudged.delete(sessionId);

	// The engine session id depends on the session's model: codex models resume
	// the codex thread, claude models the claude session. A missing engine id
	// just means "first run on this provider" — a fresh thread/session starts.
	const provider = providerFor(session.model);
	let effectiveProvider = provider;
	let effectiveModel = session.model;
	// Cumulative token/cost accounting — seeded from the session's stored total,
	// folded per run, persisted + broadcast live (see the `usage_snapshot` and
	// `done` cases). `usageBase` is the total as of the last *completed* run:
	// snapshots are run-cumulative, so each fold recomputes base+run rather than
	// stacking onto the previous snapshot (which would double-count).
	let latestUsage: SessionUsage | undefined = session.usage;
	let usageBase: SessionUsage | undefined = latestUsage;
	// Opencode ids live in their own slot (with a transitional mirror in the
	// claude slot — recognizable by the ses_ shape; see engineSessionPatch).
	// A claude run never resumes a ses_-shaped id: that ride was written by an
	// opencode run, and handing it to the Claude SDK would fail the resume.
	const pendingImportedEngineId =
		session.importedFrom === "local" &&
		session.opencodeSessionId?.startsWith("ses_import_")
			? session.opencodeSessionId
			: undefined;
	const engineSessionId =
		pendingImportedEngineId ||
		(provider === "codex"
			? session.codexThreadId
			: provider === "opencode"
				? session.opencodeSessionId ||
					(isOpencodeSessionId(session.claudeSessionId)
						? session.claudeSessionId
						: undefined)
				: isOpencodeSessionId(session.claudeSessionId)
					? undefined
					: session.claudeSessionId);
	// A claude session with no engine id yet is a *fresh* chat (e.g. a new sibling
	// chat opened from the tab strip's +): its first prompt starts a new claude
	// conversation, and finalSessionId is persisted below — same as codex, which
	// already runs fresh with no thread id. (Previously this hard-errored, which
	// blocked never-run sessions from ever receiving their first message.)
	if (provider === "claude" && !engineSessionId) {
		console.log(`[prompt] ${sessionId}: first claude run (no engine id yet)`);
	}

	// Durable intake (2026-07-24, bks-019f93ea): persist the user's message to
	// the transcript store NOW — before the worktree/title/engine-spawn awaits —
	// so a process death anywhere in the run path can no longer lose it. The
	// uuid threads through to the runner (promptEntryId), whose own transcript
	// write upserts this same row (with any context decoration) instead of
	// duplicating the bubble. Sandbox runs keep their own transcript mirror
	// with its own ids — skip those to avoid a doubled user line.
	const promptEntryId = crypto.randomUUID();
	if (!session.sandbox && content?.trim()) {
		storeAppendUserLineEarly(
			sessionId,
			transcriptLineUser(content, promptEntryId, undefined, images),
			isOpencodeSessionId(engineSessionId) ? engineSessionId : undefined,
		);
	}

	// Cross-provider handoff: the session's model was switched to the other engine
	// (Fable orchestrator → gpt-5.5 executor, or back) since the last run. The
	// incoming engine has no memory of the conversation — its thread either never
	// existed or is stale — so bridge it with the recent transcript from whichever
	// engine last drove the session. Without this, a mid-session /model switch
	// across providers drops the agent into a blank continuation. (Same-provider
	// switches — opus↔sonnet, gpt-5.5↔codex — resume their own thread and need no
	// bridge.) Recorded provider is set after every run below.
	const lastProvider = session.lastEngineProvider;
	let switchHandoff: string | null = null;
	// Prior-engine entries backing the handoff note — also passed to the runner
	// so a fresh opencode session's persisted transcript is seeded with them
	// (keeps the UI transcript continuous across an engine migration).
	let switchHandoffEntries: TranscriptEntry[] = [];
	// Anthropic and OpenAI models both report provider "opencode", but they run
	// on different servers: a family switch (claude-* ↔ gpt-*) can't resume the
	// engine session and starts fresh, so it needs the same bridge as a classic
	// cross-provider switch. Detected via the model that last actually drove a
	// run (bks-019f57a0 dropped its visible history across exactly this switch,
	// 2026-07-12; sessions from before lastEngineModel existed skip this and
	// still get the runner's prior-transcript file seeding).
	const familySwitch =
		lastProvider === "opencode" &&
		provider === "opencode" &&
		!!session.lastEngineModel &&
		!!session.model &&
		engineFamily(session.lastEngineModel) !== engineFamily(session.model);
	if (lastProvider && (lastProvider !== provider || familySwitch)) {
		const prevEngineId =
			lastProvider === "codex"
				? session.codexThreadId
				: lastProvider === "opencode"
					? session.opencodeSessionId ||
						(isOpencodeSessionId(session.claudeSessionId)
							? session.claudeSessionId
							: undefined)
					: isOpencodeSessionId(session.claudeSessionId)
						? undefined
						: session.claudeSessionId;
		const prevEntries = prevEngineId
			? await readEngineTranscriptAsync(
					session.worktreeDir || defaultRepo().repo,
					prevEngineId,
					lastProvider,
				)
			: [];
		if (prevEntries.length) {
			switchHandoffEntries = prevEntries;
			// Claude coming back to a thread it already ran (engineSessionId set)
			// remembers everything up to the switch and only needs the interim
			// turns; a fresh target treats the transcript as the whole conversation.
			switchHandoff = buildEngineSwitchHandoffNote({
				// The model that last drove the session is the second-to-last
				// modelHistory entry (the last is the switch into the current model).
				fromModel:
					session.modelHistory && session.modelHistory.length >= 2
						? session.modelHistory[session.modelHistory.length - 2].model
						: undefined,
				fromProvider: lastProvider,
				toProvider: provider,
				// A family switch never resumes — the target server doesn't have the
				// session, so the incoming model needs the whole transcript.
				targetResuming: familySwitch ? false : !!engineSessionId,
				entries: prevEntries,
			});
			console.log(
				`[prompt] ${sessionId}: cross-${familySwitch ? "family" : "provider"} switch ${lastProvider}→${provider}; bridging ${prevEntries.length} transcript entries`,
			);
		}
	}
	// A local-to-cloud import deliberately carries a synthetic OpenCode id so
	// the first cloud turn attempts a resume, falls back to a fresh engine
	// session, and then persists that real id. Its history lives in transcript
	// v2 under the unified bks id, not in the retired OpenCode JSONL mirror, so
	// bridge that store history into the fresh engine's first prompt here.
	if (pendingImportedEngineId) {
		const importedEntries = await mergedSessionTranscriptAsync(session);
		if (importedEntries.length) {
			switchHandoffEntries = importedEntries;
			switchHandoff = buildEngineSwitchHandoffNote({
				fromProvider: "opencode",
				toProvider: "opencode",
				sameEngineRestart: true,
				entries: importedEntries,
			});
		}
	}

	// A cleaned-up worktree makes the SDK spawn fail with a misleading "binary
	// not found" (ENOENT on the missing cwd) — revive it first. Same path as
	// before, so resuming the claude session keeps its history. Volume-mode
	// sandbox workspaces are exempt: their dir never exists host-side — the
	// sandbox provider materializes it in-container, so reviving a host
	// worktree at the same path would shadow (and fork) the real workspace.
	// Ask chats can be minted without a worktree (sibling "+ → Ask", legacy
	// files): resolve them to the pinned ask checkout, never the mutable main
	// checkout, whose parked branch is a false context clue (ensureAskCheckout —
	// 82a296a6 covered the create paths but missed this prompt-path fallback).
	let cwd =
		session.worktreeDir ||
		(session.mode === "ask"
			? await ensureAskCheckout(session.repo)
			: defaultRepo().repo);
	if (
		session.worktreeDir &&
		!existsSync(session.worktreeDir) &&
		!hasRemoteWorkspace(session)
	) {
		const repo = session.repo
			? getRepo(session.repo)
			: repoForPath(session.worktreeDir);
		if (session.branch) {
			broadcastToSession(sessionId, {
				type: "notice",
				message: `This session's worktree was cleaned up — recreating it from branch ${session.branch}…`,
			});
			try {
				cwd = await reviveWorktree(session.branch, repo.id);
			} catch (e) {
				broadcastToSession(sessionId, {
					type: "notice",
					message: `Couldn't recreate the worktree (${e}); running in the main checkout instead.`,
				});
				cwd = repo.repo;
			}
		} else {
			broadcastToSession(sessionId, {
				type: "notice",
				message:
					"This session's worktree is gone; running in the main checkout.",
			});
			cwd = repo.repo;
		}
	}
	let prompt = content;
	// A teammate sending into someone else's idle session gets the same
	// "[Name] " attribution the steer path already applies — without it the
	// message lands bare in the transcript and the viewer credits it to the
	// session owner (startedBy). The owner's own turns stay bare (the common
	// case), automation runs pass no user, and multi-message queue drains
	// arrive pre-attributed — don't double-prefix those.
	if (
		user &&
		user !== session.startedBy &&
		!content.startsWith(`[${user}] `)
	) {
		prompt = `[${user}] ${prompt}`;
	}
	// Bridge a cross-provider engine switch (computed above) so the incoming
	// engine continues the conversation instead of starting blank. Fenced so the
	// transcript shows only the human's message — the model-switch divider already
	// marks the engine change; the handoff itself is plumbing (see prompt-context).
	if (switchHandoff) prompt = `${wrapContext(switchHandoff)}\n\n${prompt}`;
	// Sibling-chat transcripts attached from the fresh-chat "Add chat
	// transcripts" chips (contextChats), plus @-mentioned SIDE CHATS of this
	// session (sideChatIdsToInline): inline a bounded digest of each, fenced so
	// the rendered transcript shows only the human's message. UI/derived fields,
	// but skip automation sessions anyway (their prompts are untrusted text).
	// Only side chats of THIS session auto-inline; an unrelated @session mention
	// keeps its sessionMentionsNote pointer-footer behavior (below).
	const inlinedChatIds = new Set<string>();
	if (!session.automation) {
		const chatIds = [
			...new Set([
				...(contextChats ?? []),
				...sideChatIdsToInline(prompt, sessionId, findSession),
			]),
		];
		const attachedSessions = chatIds
			.filter((id) => id !== sessionId)
			.map((id) => findSession(id))
			.filter((s): s is UnifiedSession => !!s);
		const attachedChats: {
			id: string;
			title: string | undefined;
			model: string | undefined;
			entries: TranscriptEntry[];
		}[] = [];
		for (const s of attachedSessions) {
			attachedChats.push({
				id: s.id,
				title: s.title,
				model: s.model,
				// Async: an attached side-chat's transcript can be multi-MB — the
				// sync parse held the event loop for the whole read.
				entries: s.transcriptPath
					? await parseTranscriptAsync(s.transcriptPath)
					: [],
			});
		}
		for (const c of attachedChats) inlinedChatIds.add(c.id);
		if (attachedChats.length)
			prompt = `${wrapContext(buildChatContextNote(attachedChats))}\n\n${prompt}`;
	}
	// Non-image attachments: stage to disk and tell the agent where they landed.
	prompt = withUploadsNote(prompt, stageFileAttachments(sessionId, rawFiles));
	if (session.goal) {
		prompt += `\n\n[Pinned session goal — keep working toward it and note how this turn advanced it: ${session.goal}]`;
	}

	// Resuming an automation-owned session must keep that automation's scoping
	// (MCP allowlist + tool denials) — otherwise a resume would silently hand it
	// every MCP server and drop the customer/identity write denials.
	const isAutomationSession = !!session.automation;
	// No explicit allowlist → undefined, not []: an empty array is truthy, so
	// sharedOpencodeEligible would kick every follow-up prompt off the shared
	// server pool onto a dedicated server whose empty shard DB can't resume the
	// engine session — turn 2 of every UI-created session started amnesiac
	// while the seeded UI transcript looked continuous (bks-019f818d, 2026-07-20).
	const mcpServers = isAutomationSession
		? automationMcpServersByName(session.automation!)
		: (session.mcpServers && session.mcpServers.length) ? session.mcpServers : undefined;
	const deniedTools = isAutomationSession ? automationDeniedTools() : undefined;

	// @session:<id> mentions → footer resolving them for the agent's
	// opensession-sessions tools. Interactive sessions only (same gate as the tools).
	if (!isAutomationSession) {
		const mentionsNote = sessionMentionsNote(prompt, inlinedChatIds);
		if (mentionsNote) prompt += `\n\n${mentionsNote}`;
	}

	// Sidebar name: make sure this chat has a short generated summary title.
	// Covers tab-strip "New chat" chats (never named at creation — this is
	// their first prompt) and retries chats whose creation-time Haiku call
	// failed (e.g. account exhaustion), which otherwise wear the raw first
	// line of the prompt forever. Retries summarize the stored provisional
	// title (the opening prompt's first line), not this turn's message, so a
	// mid-conversation "yes, do it" never becomes the title source. Automation
	// and goal sessions carry deliberate titles; a manual rename wins anyway.
	if (
		session.source === "backstage" &&
		!isAutomationSession &&
		!session.goalId &&
		!getTitleOverride(session.id)
	) {
		const provisional = !session.title || session.title === "New chat";
		const firstLine = content.trim().split("\n")[0].slice(0, 80);
		if (provisional && firstLine)
			touchBackstageSession(session.id, { title: firstLine });
		void ensureGeneratedTitle(
			session.id,
			provisional ? content : session.title,
			user || session.startedBy || undefined,
			session.model || undefined,
		).then((t) => {
			if (t) invalidateSessionsCache();
		});
	}

	// Everyone viewing this session sees the prompt and the live run
	broadcastToSession(sessionId, {
		type: "stream_start",
		sessionId,
		by: user || "Anonymous",
	});
	broadcastToSession(sessionId, {
		type: "session_status",
		sessionId,
		isRunning: true,
	});

	// Sandbox routing (docs/sandboxes-plan.md Phase 1): a session that opted
	// into a sandbox (docker/daytona/e2b) runs this prompt inside its
	// per-session sandbox; null (the default for every session without the
	// opt-in field, plus every failure/kill-switch case) = the unchanged
	// in-process path below.
	const sandboxRun = await maybeLaunchSandboxedRun(session, {
		prompt,
		engineSessionId: engineSessionId || undefined,
		cwd,
		user,
		images,
		mcpServers,
		isAutomationSession,
	});

	// A volume-mode workspace (docker volume mode, or any remote provider)
	// exists ONLY inside its sandbox — there is no host fallback (runAgent on
	// the nonexistent host path would just ENOENT, and running in the main
	// checkout instead would be worse). End the turn with an explicit error;
	// the kill-switch/config flip that caused this is an operator action, not
	// a transient.
	if (!sandboxRun && hasRemoteWorkspace(session)) {
		const msg =
			"This session's workspace lives in its sandbox volume, but the sandbox is unavailable (disabled by config/kill-switch, or it failed to start) — the prompt was not run. Re-enable sandboxes and try again." +
			(session.sandbox?.provider === "daytona"
				? " Daytona: if the launch failed because the sandbox could not dial back, check callbackBaseUrl and your org tier's egress (docs/self-hosting-sandboxes.md)."
				: "");
		broadcastToSession(sessionId, { type: "error", sessionId, message: msg });
		recordRunOutcome(session.id, msg);
		broadcastToSession(sessionId, { type: "stream_done", sessionId });
		broadcastToSession(sessionId, {
			type: "session_status",
			sessionId,
			isRunning: false,
		});
		return;
	}

	let finalSessionId = sandboxRun?.freshEngine ? "" : engineSessionId || "";
	let endedWithError = false;
	// Terminal failure this run died on (usage limits with no account left,
	// credit/API errors) — recorded on the session after the loop so the sidebar
	// surfaces it as "Needs input"; null (a clean finish) clears an earlier one.
	let runFailure: string | null = null;
	// Accumulate the assistant reply so we can mirror it back to a Slack thread
	// the session posted to (slackReplyTo — e.g. a reply under an automation's
	// summary message lands here via deliverToSession).
	let assistantText = "";
	// Tool calls seen this run — the announce-then-stop guard below only fires
	// on turns that did no work at all.
	let toolUseCount = 0;

	for await (const event of sandboxRun ?? runAgent({
		prompt,
		promptEntryId,
		sessionId: engineSessionId || undefined,
		cwd,
		mode: session.mode,
		model: session.model,
		// Reasoning effort from the composer pill, persisted on the session.
		effort: session.effort,
		fastMode: session.fastMode,
		// Pinned subscription for this session (claude-runner prefers it, pool
		// fallback on exhaustion). Ignored by Codex models.
		accountId: session.accountId,
		// Only switch models when a fallback is explicitly configured. By default,
		// usage exhaustion stops the run so the human can choose what to do.
		fallbackModel: interactiveFallbackModel(session.model),
		images,
		// Engine switch: seed the fresh opencode session's persisted transcript
		// with the prior history (same entries the handoff note was built from)
		// so the UI transcript stays continuous. Everything dispatches onto the
		// opencode engine, so no provider gate — the picker id's provider can be
		// "codex"/"claude" (bare gpt-5.6-sol) while the run still lands on
		// opencode; the old `provider === "opencode"` guard silently dropped the
		// seed for exactly those switches.
		seedTranscriptEntries:
			switchHandoff && switchHandoffEntries.length
				? switchHandoffEntries
				: undefined,
		mcpServers,
		// Self-management tools for normal sessions; withheld from automation
		// sessions (and their interactive resumes) — same gate as deniedTools above.
		// Exception: a selfImprove automation's sessions keep their scoped pair
		// (spawn_task suite + own-prompt update) so a Slack thread reply reaches
		// a session with the same tools its nightly run had.
		// A goal-driven session also gets its own opensession-goal-self controls, so an
		// interactive turn (a human steering it in the UI) can set the next wake,
		// append to the ledger, or pause/finish — the same tools the headless wake has.
		inProcessMcp: isAutomationSession
			? selfImproveMcpForSession(session, sessionId)
			: session.goalId
				? {
						...interactiveMcpServers(user, sessionId),
						"opensession-goal-self": createGoalSelfMcpServer(session.goalId),
					}
				: interactiveMcpServers(user, sessionId),
		reposNote: isAutomationSession
			? undefined
			: await buildSessionNote(session, user),
		deniedTools,
		confirmTools: STRIPE_CONFIRM_TOOLS,
		aws: true, // sessions keep AWS read access (via injected creds)
		// Attribute any commits this turn makes to whoever sent the prompt.
		author: gitIdentityFor(user),
		// Gate per-user MCP servers (allowedUsers) to the prompt's author. Automation
		// sessions pass no user, so they never see a user-restricted server.
		user: isAutomationSession ? undefined : user,
		journal: { bksSessionId: session.id, kind: "prompt" },
		onAskUser: makeAskHandler(sessionId),
	})) {
		switch (event.type) {
			case "init":
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
				if (event.sessionId && event.sessionId !== finalSessionId) {
					finalSessionId = event.sessionId;
					// The engine session id just changed (first run of a fresh chat, or
					// a rotation fork): the run writes to a transcript file nobody is
					// watching yet. Persist + attach NOW — waiting for the run to end
					// (the old behavior) left the entire turn invisible to viewers.
					if (session.source === "backstage") {
						touchBackstageSession(session.id, {
							...engineSessionPatch(effectiveProvider, finalSessionId),
							lastEngineProvider: effectiveProvider,
							...(effectiveModel
								? {
										...(keepsPresetModel(session) ? {} : { model: effectiveModel }),
										lastEngineModel: effectiveModel,
									}
								: {}),
						});
						invalidateSessionsCache(); // new watchers must see the new transcriptPath
					} else if (
						// Slack/linear-source sessions need the same persistence, into
						// the owning agent's store — otherwise a fallback/rotation-minted
						// id lives only in the run journal, the session file keeps
						// pointing at the dead engine session (frozen transcript), and
						// queued prompts fork the stale thread (slack-can-you-try,
						// 2026-07-16).
						syncAgentSessionEngine(session, {
							engineSessionId: finalSessionId,
							model: keepsPresetModel(session) ? undefined : effectiveModel || undefined,
						})
					) {
						invalidateSessionsCache();
					}
					attachSessionWatchersToEngineTranscript(
						sessionId,
						effectiveProvider,
						cwd,
						finalSessionId,
					);
				}
				break;
			case "text_chunk":
				assistantText += event.text;
				broadcastToSession(sessionId, {
					type: "stream_text",
					sessionId,
					text: event.text,
				});
				break;
			case "model_switch": {
				// The primary model ran out of credits pool-wide and the runner
				// switched this session to a fallback (auto-switch is on). Record it
				// the same way a manual /model switch is recorded — a persisted
				// modelHistory entry (durable inline divider on reload) plus a live
				// model_changed broadcast (pill + divider now) — and move the session
				// onto the fallback so later prompts don't re-hit the exhausted model.
				const to = event.toModel || "";
				const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
				if (to) {
					effectiveModel = to;
					effectiveProvider = providerFor(to);
				}
				if (to && session.source === "backstage") {
					touchBackstageSession(session.id, {
						model: to,
						modelHistory: [
							...(session.modelHistory || []),
							{ model: to, from: event.fromModel, at: new Date().toISOString(), by: reason },
						],
					});
					invalidateSessionsCache();
				} else if (to && syncAgentSessionEngine(session, { model: to })) {
					// Keep the slack/linear store's model in step so the next turn
					// (from the loop or the UI) resumes on the fallback, not the
					// exhausted model. The new engine id follows via the init event.
					invalidateSessionsCache();
				}
				if (to)
					broadcastToSession(sessionId, {
						type: "model_changed",
						sessionId,
						model: to,
						from: event.fromModel,
						by: reason,
					});
				break;
			}
			case "tool_use":
				toolUseCount++;
				broadcastToSession(sessionId, {
					type: "stream_tool_use",
					sessionId,
					entry: {
						id: event.toolUseId || crypto.randomUUID(),
						type: "tool_use",
						content: `Using ${event.toolName}`,
						timestamp: new Date().toISOString(),
						toolName: event.toolName,
						toolInput: event.toolInput,
						toolUseId: event.toolUseId,
					},
				});
				break;
			case "tool_result":
				broadcastToSession(sessionId, {
					type: "stream_tool_result",
					sessionId,
					entry: {
						// Same id scheme as the jsonl tail so the full (untruncated)
						// transcript entry upserts over this streamed copy
						id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
						type: "tool_result",
						content: event.content || "",
						timestamp: new Date().toISOString(),
						toolUseId: event.toolUseId,
						...(event.images && event.images.length > 0
							? { images: event.images }
							: {}),
						...(event.videos && event.videos.length > 0
							? { videos: event.videos }
							: {}),
					},
				});
				break;
			case "usage_snapshot":
				// Live mid-run cost/context — same fold as `done`, recomputed from
				// the pre-run base (snapshots are cumulative for the run). Broadcast
				// only; persistence waits for the end of the run.
				if (event.usage) {
					latestUsage = foldSessionUsage(
						usageBase,
						event.usage,
						effectiveModel,
					);
					broadcastToSession(sessionId, {
						type: "usage_update",
						sessionId,
						usage: latestUsage,
					});
				}
				break;
			case "done":
				finalSessionId = event.sessionId || finalSessionId;
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
				// Dying on usage limits with no account left reports as a `done`
				// whose result is the limit notice (not an `error` event) — but it
				// still needs a human, so treat it as a failure.
				if (event.usageLimitExhausted) {
					runFailure = event.result || "Usage limit reached on every account";
					// Durable system line — the toast is stream-only and lastRunError
					// only shows on the session card; a reloaded transcript otherwise
					// just ends with no explanation (same fix as terminal errors below).
					const engineId = finalSessionId || session.claudeSessionId;
					if (engineId) {
						try {
							appendOpencodeTranscript(engineId, [
								transcriptLineRunnerNotice(`Run stopped: ${runFailure}`),
							]);
						} catch {}
					}
				}
				// Fold this run's token/cost into the session total and push it live
				// to viewers (persisted below with the rest of the session patch).
				if (event.usage) {
					latestUsage = foldSessionUsage(
						usageBase,
						event.usage,
						event.model || effectiveModel,
					);
					usageBase = latestUsage;
					broadcastToSession(sessionId, {
						type: "usage_update",
						sessionId,
						usage: latestUsage,
					});
				}
				if (event.cacheMissWarning) {
					broadcastToSession(sessionId, {
						type: "cache_warning",
						sessionId,
					});
				}
				invalidateSessionsCache();
				break;
			case "error":
				// "Session is busy" = we lost the start race to a concurrent run (the
				// pendingStarts guard closes most of that window; the runner's own
				// check is the last line). Queue the message for delivery after the
				// winning run instead of dropping it as an error toast. Return early:
				// the tail below (steer-receipt clearing, stream_done) belongs to the
				// run that actually owns the session.
				if (event.content === "Session is busy") {
					enqueuePrompt(sessionId, { content, user });
					watchExternalRunAndDrain(sessionId);
					broadcastToSession(sessionId, {
						type: "notice",
						message:
							"Session was busy — message queued; it sends when the current run finishes.",
					});
					return;
				}
				endedWithError = true;
				runFailure = event.content || "Run failed";
				// Persist the terminal failure into the transcript as a system line.
				// The broadcast below is stream-only and lastRunError only surfaces
				// on the session card — on reload the transcript just ended mid-turn
				// with no trace of why (bks-019f7911's 60-min timeout, 2026-07-19).
				// This is the choke point AFTER agent-runner's rotation/fallback walk,
				// so only the final, user-facing error lands — one line per dead run.
				// Skipped when the runner already wrote a friendlier line (timeout).
				if (!event.noticePersisted) {
					const engineId = finalSessionId || session.claudeSessionId;
					if (engineId) {
						try {
							appendOpencodeTranscript(engineId, [
								transcriptLineRunnerNotice(`Run failed: ${runFailure}`),
							]);
						} catch {}
					}
				}
				broadcastToSession(sessionId, {
					type: "error",
					sessionId,
					message: event.content,
				});
				break;
		}
	}

	// Persist activity on our own session store. Slack/linear stores stay the
	// owning agent's property, with one surgical exception: engine-id/model
	// flips sync through agent-session-sync so the file never points at a dead
	// engine session (see that module's doc).
	if (session.source === "backstage") {
		// The agent may have switched branches in its worktree during the turn
		// (e.g. renaming an auto-generated branch before opening a PR). Keep the
		// record on the actual HEAD so PR lookups, the PR tab, and the review
		// handoff keep resolving this session. Shared checkouts (a repo's main
		// or ask checkout) are exempt: no session owns their HEAD, so syncing
		// would stamp whatever branch another flow left parked there onto this
		// session (bks-019f97ec, 2026-07-25).
		const headBranch =
			session.branch && !isSharedCheckoutDir(session.worktreeDir)
				? worktreeHeadBranch(session.worktreeDir)
				: null;
		touchBackstageSession(
			session.id,
			{
				...engineSessionPatch(effectiveProvider, finalSessionId),
				lastEngineProvider: effectiveProvider,
				...(effectiveModel
					? {
							...(keepsPresetModel(session) ? {} : { model: effectiveModel }),
							lastEngineModel: effectiveModel,
						}
					: {}),
				...(latestUsage ? { usage: latestUsage } : {}),
				...(headBranch && headBranch !== session.branch
					? { branch: headBranch }
					: {}),
			},
		);
	} else if (finalSessionId) {
		syncAgentSessionEngine(session, {
			engineSessionId: finalSessionId,
			model: keepsPresetModel(session) ? undefined : effectiveModel || undefined,
		});
	}

	// A terminal failure keeps the session in the "Needs input" bucket until a
	// later run finishes cleanly (which clears it here too).
	recordRunOutcome(session.id, runFailure);

	// On a clean finish any steered messages already landed in the transcript, so
	// drop their display-only receipts. But if the run ended in error/abort (e.g.
	// a restart killed the SDK stream mid-turn), a steered message may NOT have
	// been delivered yet — keep the receipt so persistQueues/restorePromptQueues
	// can re-deliver it on the next boot instead of silently dropping it.
	if (!endedWithError) clearSteerReceipts(sessionId);

	broadcastToSession(sessionId, { type: "stream_done", sessionId });
	broadcastToSession(sessionId, {
		type: "session_status",
		sessionId,
		isRunning: false,
	});

	// Mirror Michael's reply back to Slack: a turn that came from a Slack thread
	// (a reply under a message this session posted — see slackReplyTo plumbing)
	// answers in that thread.
	if (!endedWithError && assistantText.trim() && slackReplyTo) {
		void sendSlackMessage(
			slackReplyTo.channel,
			assistantText.trim().slice(0, 38000),
			slackReplyTo.threadTs,
		).catch(() => {});
	}

	// Announce-then-stop guard: the instruction-layer fix (28731464) still lets
	// an occasional turn end cleanly on a plan sentence ("Now let me read the
	// exact code…") with zero tool calls — the session then sits idle until the
	// human types "continue" (seen 2026-07-10 bks-019f4b70, again 2026-07-12
	// bks-019f533e). When a clean, tool-less interactive turn ends on an
	// announced next action, queue ONE auto-continue; the drain watcher delivers
	// it as the next turn. Never for automation sessions, never over a user
	// Stop, one consecutive workless nudge max.
	//
	// Queue-hold: queued messages are a promise to deliver at FULL completion,
	// so when the turn ends still announcing work while something is queued,
	// the nudge fires ahead of the queue (front + solo drain) — regardless of
	// tool use — and the user's messages stay parked until a turn ends without
	// announcing more. Turns doing real work reset the nudge budget, so a
	// genuinely working agent holds the queue as long as it needs; a stalled
	// one (two workless announces in a row) lets the queue drain.
	if (toolUseCount > 0) autoContinueNudged.delete(sessionId);
	const queuedBehind = (promptQueues.get(sessionId) || []).filter(
		(m) => m.user !== AUTO_CONTINUE_USER,
	).length;
	if (
		!endedWithError &&
		!runFailure &&
		session.source === "backstage" &&
		!isAutomationSession &&
		(toolUseCount === 0 || queuedBehind > 0) &&
		!stoppedSessions.has(sessionId) &&
		!autoContinueNudged.has(sessionId) &&
		announcesNextAction(assistantText)
	) {
		autoContinueNudged.add(sessionId);
		audit({
			msg: "auto_continue_nudge",
			bks_session_id: sessionId,
			tail: assistantText.trim().slice(-200),
			...(queuedBehind > 0 ? { queued_held: queuedBehind } : {}),
		});
		broadcastToSession(sessionId, {
			type: "notice",
			message:
				queuedBehind > 0
					? `Still mid-task — auto-continuing first; ${queuedBehind} queued message${queuedBehind === 1 ? "" : "s"} deliver once the agent fully finishes.`
					: "Turn ended on an announced next step without doing it — auto-continuing.",
		});
		// Fenced so the transcript never shows it as a user bubble: the parsers
		// strip <backstage:context> from user text and skip the then-empty entry,
		// while the engine still sees the full instruction. The notice above (and
		// the audit event) are the human-visible trace.
		enqueuePrompt(
			sessionId,
			{ content: wrapContext(AUTO_CONTINUE_PROMPT), user: AUTO_CONTINUE_USER },
			{ front: true },
		);
	}

	// The session just finished a turn; if nothing's queued it's idle now, so fire
	// any "when_done" / "on_pr" human asks waiting on this session. Idempotent.
	if (!promptQueues.get(sessionId)?.length) {
		onHumanAsksSessionIdle(sessionId);
		// Publish any commits the turn left unpushed so the status header doesn't
		// linger on "Ahead by N commits" (see autoPushSessionBranches). Only on a
		// clean finish — an errored/aborted turn may be mid-work. Fire-and-forget.
		if (!endedWithError) void autoPushSessionBranches(session);
	}
}

/**
 * Expand `@session:bks-…` mentions in a prompt into a footer the agent can act
 * on with its opensession-sessions tools. The mention token itself stays in place
 * (it carries the id); the footer resolves each id to a title/state and points
 * at the tools — including slash commands over send_to_session (e.g. "/loop").
 * Interactive sessions only: automations don't get opensession-sessions.
 */
export function sessionMentionsNote(
	content: string,
	excludeIds?: Iterable<string>,
): string | null {
	// Only the human's visible message counts: fenced <backstage:context> blocks
	// (attached chat transcripts, handoffs) name sessions as @session:<id> too,
	// and those must not grow a redundant — and unfenced, so user-visible —
	// mentions footer.
	content = stripContext(content);
	// A side chat that was inlined as a digest above already carries its context;
	// skip it here so it doesn't ALSO get a pointer footer for the same id.
	const skip = new Set(excludeIds ?? []);
	const ids = [
		...new Set(
			[...content.matchAll(/@session:(bks-[0-9a-f-]+)/g)].map((m) => m[1]),
		),
	].filter((id) => !skip.has(id));
	if (!ids.length) return null;
	const lines = ids.map((id) => {
		const s = findSession(id);
		if (!s) return `- @session:${id} — (no session with this id)`;
		const busy = isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id);
		const bits = [
			s.title || "Untitled",
			s.branch ? `branch ${s.branch}` : null,
			busy ? "running" : "idle",
		].filter(Boolean);
		return `- @session:${id} — ${bits.join(" · ")}`;
	});
	return (
		`[The @session mentions above refer to other Backstage sessions:\n${lines.join("\n")}\n` +
		`Use the opensession-sessions MCP tools with these ids: get_session (state, pending question, ` +
		`transcript tail), send_to_session (a message — or a slash command handled by backstage ` +
		`itself, e.g. "/loop 15m <prompt>" to set a recurring self-prompt on the target that fires ` +
		`only while it is idle, "/loop stop" to clear it; this works on your own session id too), ` +
		`answer_session_question, cancel_session.]`
	);
}

/**
 * Side-chat recall selection (pure, unit-tested). Scans a prompt for
 * `@session:<id>` mentions and returns the deduped ids that are SIDE CHATS of
 * `sessionId` (i.e. `lookup(id)?.sideChatOf === sessionId`). Only those
 * auto-inline their transcript digest into the main thread's next turn via
 * buildChatContextNote — a plain @session mention of an unrelated session is
 * NOT selected here (it keeps the sessionMentionsNote pointer-footer behavior).
 * Uses the same mention regex as sessionMentionsNote and strips fenced context
 * blocks first so an already-inlined digest doesn't re-select itself. `lookup`
 * is findSession in production; injected for tests.
 */
export function sideChatIdsToInline(
	prompt: string,
	sessionId: string,
	lookup: (id: string) => { sideChatOf?: string } | null | undefined,
): string[] {
	const ids = [
		...new Set(
			[...stripContext(prompt).matchAll(/@session:(bks-[0-9a-f-]+)/g)].map(
				(m) => m[1],
			),
		),
	];
	return ids.filter((id) => lookup(id)?.sideChatOf === sessionId);
}

// Loop ticker: fire due session loops (skips busy/archived sessions).
// Guarded so a hot reload doesn't stack a second interval.
if (!g.__backstageBooted && !isLocalProfile()) {
	setInterval(() => {
		for (const session of getCachedSessions()) {
			const loop = session.loop;
			if (!loop || session.archived || session.source !== "backstage") continue;
			if (!session.claudeSessionId && !session.codexThreadId) continue;
			if (
				isAgentSessionBusy(
					session.claudeSessionId,
					session.codexThreadId,
					session.id,
				)
			)
				continue;
			const last = loop.lastRunAt ? new Date(loop.lastRunAt).getTime() : 0;
			if (Date.now() - last < loop.intervalMinutes * 60_000) continue;
			touchBackstageSession(session.id, {
				loop: { ...loop, lastRunAt: new Date().toISOString() },
			});
			console.log(
				`[loop] Firing loop prompt for ${session.id} (every ${loop.intervalMinutes}m)`,
			);
			void runSessionPromptAndDrain(
				session.id,
				loop.prompt,
				loop.setBy ? `${loop.setBy} (loop)` : "loop",
			).catch((e) =>
				console.error(`[loop] Loop prompt failed for ${session.id}:`, e),
			);
		}
	}, 60_000);
}
