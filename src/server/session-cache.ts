/**
 * The short-TTL unified-session cache and the small helpers that read/write a
 * session's file through it. Everything that used to flip `sessionsCache = null`
 * in opensession.ts now calls invalidateSessionsCache().
 */

import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { getAllSessions } from "./sessions";
import { activeRunRecords } from "./run-journal";
import { getRunState, transitionRunState, type RunState } from "./run-state";
import { isAgentSessionBusy } from "./agent-runner";
import { audit } from "./audit";
import { SESSION_EFFORTS as MODEL_EFFORTS } from "./models";
import { writeJsonAtomic } from "./shared/atomic-write";
import type { UnifiedSession, NativeSessionFile } from "./types";

export const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

const g = globalThis as any;

// Cache sessions with short TTL
let sessionsCache: { data: UnifiedSession[]; ts: number } | null = null;
// The UI polls every 5s and live run changes also arrive over WebSocket. Keep
// the expensive multi-thousand-file fallback scan out of every poll wave;
// in-process mutations invalidate this cache immediately.
const CACHE_TTL = 10_000;

/** Drop the cached list so the next getCachedSessions() re-reads from disk. */
export function invalidateSessionsCache(): void {
	sessionsCache = null;
}

export function getCachedSessions(): UnifiedSession[] {
	if (sessionsCache && Date.now() - sessionsCache.ts < CACHE_TTL) {
		return sessionsCache.data;
	}
	const data = getAllSessions();
	// Earliest run-start per session id, from the run journal — feeds the "in
	// progress" elapsed ticker and survives a page refresh (a session can carry
	// its bks id and its engine session id across records; key on both).
	const runStarts = new Map<string, string>();
	for (const r of activeRunRecords()) {
		if (!r.startedAt) continue;
		for (const key of [r.osSessionId, r.claudeSessionId]) {
			if (!key) continue;
			const prev = runStarts.get(key);
			if (!prev || r.startedAt < prev) runStarts.set(key, r.startedAt);
		}
	}
	// Sessions driven from the web UI run in-process; surface those too
	for (const s of data) {
		if (
			!s.isRunning &&
			isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id)
		) {
			s.isRunning = true;
		}
		if (s.isRunning) {
			s.runStartedAt =
				runStarts.get(s.id) ||
				(s.claudeSessionId ? runStarts.get(s.claudeSessionId) : undefined) ||
				(s.codexThreadId ? runStarts.get(s.codexThreadId) : undefined);
		}
		const rs = getRunState(s.id);
		if (rs !== "idle") s.runState = rs;
		checkRunStateWedge(s.id, rs, s.isRunning);
	}
	sessionsCache = { data, ts: Date.now() };
	return data;
}

/**
 * Return the last session snapshot without triggering a synchronous disk scan.
 * Hot-path autocomplete can safely omit optional session suggestions until the
 * normal sessions refresh repopulates this cache.
 */
export function peekCachedSessions(): UnifiedSession[] {
	return sessionsCache?.data ?? [];
}

// ── Run-state readers ─────────────────────────────────────────────────────────

/** FSM states in which a session's run is still in flight or pending recovery. */
const UNSETTLED_STATES: ReadonlySet<RunState> = new Set([
	"preparing",
	"starting",
	"running",
	"ask_blocked",
	"interrupted",
	"reattaching",
] satisfies RunState[]);

/**
 * A run is SETTLED only when nothing more will happen without new input: the
 * state machine is at rest (idle/stopped/failed), the engine layer isn't busy
 * (covers rotation/fallback/auto-continue windows the FSM sees as a plain
 * turn_end→prompt gap), and no queued prompt is waiting to drain. This is the
 * "don't trust turn_end alone" rule: retries, reattaches, and queued
 * continuations all follow an apparent turn end.
 */
export function isRunSettled(sessionId: string): boolean {
	const session = findSession(sessionId);
	const id = session?.id || sessionId;
	if (UNSETTLED_STATES.has(getRunState(id))) return false;
	if (
		isAgentSessionBusy(session?.claudeSessionId, session?.codexThreadId, id)
	) {
		return false;
	}
	// promptQueues lives in queue-state.ts, which imports SESSIONS_DIR from
	// this module — importing it back would be a TDZ-crashing cycle. The map
	// is parked on globalThis (hot-reload survival), so read it there.
	const queues = g.__promptQueues as Map<string, unknown[]> | undefined;
	if ((queues?.get(id)?.length ?? 0) > 0) return false;
	return true;
}

// FSM-vs-engine wedge detector: the state machine says a run is in flight but
// the engine layer has been idle (or the inverse) for a sustained window.
// That divergence is exactly the zombie/orphan class — surface it as an audit
// event (grep run_state_wedge) instead of letting it hide until a human asks
// why a session is stuck. Piggybacks on the 2s session-cache refresh; one
// event per session per wedge episode.
const WEDGE_AFTER_MS = 3 * 60 * 1000;
const wedgeSince: Map<string, number> = (g.__runStateWedgeSince ??= new Map());
const wedgeReported: Set<string> = (g.__runStateWedgeReported ??= new Set());

function checkRunStateWedge(
	sessionId: string,
	state: RunState,
	engineBusy: boolean,
): void {
	const fsmActive =
		state === "running" || state === "starting" || state === "ask_blocked";
	// ask_blocked idles the engine legitimately (the turn is parked on a
	// question card) — only a busy-engine-while-FSM-idle or an idle-engine
	// while the FSM believes a turn is RUNNING counts as divergence.
	const diverged =
		state === "ask_blocked"
			? false
			: fsmActive !== engineBusy;
	if (!diverged) {
		wedgeSince.delete(sessionId);
		wedgeReported.delete(sessionId);
		return;
	}
	const since = wedgeSince.get(sessionId);
	if (!since) {
		wedgeSince.set(sessionId, Date.now());
		return;
	}
	if (Date.now() - since < WEDGE_AFTER_MS || wedgeReported.has(sessionId))
		return;
	wedgeReported.add(sessionId);
	console.warn(
		`[run-state] wedge: session ${sessionId} FSM=${state} engineBusy=${engineBusy} for ${Math.round((Date.now() - since) / 1000)}s`,
	);
	audit({
		msg: "run_state_wedge",
		session_id: sessionId,
		run_state: state,
		engine_busy: engineBusy,
		diverged_for_ms: Date.now() - since,
	});
}

export function findSession(sessionId: string): UnifiedSession | undefined {
	return getCachedSessions().find((s) => s.id === sessionId);
}

/** Canonical id followed by every historical alias for this session. Asset
 * stores and other id-keyed sidecars use this to survive session deduping. */
export function sessionIdsFor(
	sessionId: string,
	sessions: UnifiedSession[] = getCachedSessions(),
): string[] {
	const session = sessions.find(
		(s) => s.id === sessionId || s.aliasIds?.includes(sessionId),
	);
	return session
		? [...new Set([session.id, ...(session.aliasIds || [])])]
		: [sessionId];
}

// ── Serialized session-file writes ────────────────────────────────────────────
// Every session-file writer goes through updateSessionFile: fresh read →
// field-scoped mutator → atomic write, serialized per session id by a
// promise-chain mutex (parked on globalThis so hot reloads keep in-flight
// chains). This replaces the blind full-object rebuilds that let concurrent
// writers clobber each other's fields (docs/transcripts.md §6).
// Each write bumps a `rev` counter on the file — readers ignore it; it exists
// so lost updates are observable.

/** Receives the fresh on-disk session file ({} as the type when the file
 *  doesn't exist yet — create-if-absent) and returns the object to write.
 *  Sites overlay ONLY the fields they own; unknown/foreign fields survive. */
export type SessionFileMutator = (
	data: NativeSessionFile,
) => NativeSessionFile;

const sessionFileLocks: Map<string, Promise<void>> = (g.__osSessionFileLocks ??=
	new Map());

export function updateSessionFile(
	sessionId: string,
	mutator: SessionFileMutator,
): Promise<void> {
	const write = () => {
		const path = `${SESSIONS_DIR}/${sessionId}.json`;
		const current: NativeSessionFile = existsSync(path)
			? JSON.parse(readFileSync(path, "utf-8"))
			: ({} as NativeSessionFile);
		const next = mutator(current) ?? current;
		const rev = (current as { rev?: unknown }).rev;
		(next as { rev?: number }).rev = (typeof rev === "number" ? rev : 0) + 1;
		writeJsonAtomic(path, next);
		sessionsCache = null;
	};
	const prev = sessionFileLocks.get(sessionId);
	let done: Promise<void>;
	if (!prev) {
		// Uncontended fast path: run synchronously so read-after-write callers
		// (`persist(); findSession(id)`) keep today's visibility.
		try {
			write();
			done = Promise.resolve();
		} catch (e) {
			done = Promise.reject(e);
		}
	} else {
		done = prev.then(write);
	}
	// The stored chain link never rejects, so one failed write can't poison
	// (or double-report through) the writes queued behind it.
	const settled = done.catch(() => {});
	sessionFileLocks.set(sessionId, settled);
	void settled.finally(() => {
		if (sessionFileLocks.get(sessionId) === settled)
			sessionFileLocks.delete(sessionId);
	});
	return done;
}

export function touchNativeSession(
	bksId: string,
	patch: Partial<NativeSessionFile>,
): void {
	updateSessionFile(bksId, (data) => ({
		...data,
		...patch,
		lastActivity: new Date().toISOString(),
	})).catch((e) => {
		console.error(`Failed to update opensession session ${bksId}:`, e);
	});
}

// Reasoning-effort values the composer/new-session pill can send. Model-specific
// support is exposed by /api/models and normalized by the runner before dispatch.
export const SESSION_EFFORTS = new Set<string>(MODEL_EFFORTS);

/** Persist a composer-sent effort change on a opensession session (no-op otherwise). */
export function maybePersistEffort(
	session: UnifiedSession | undefined,
	effort?: string,
): void {
	if (!session || session.source !== "opensession" || !effort) return;
	const e = effort.trim().toLowerCase();
	if (!SESSION_EFFORTS.has(e) || session.effort === e) return;
	touchNativeSession(session.id, { effort: e });
	session.effort = e; // keep the in-hand snapshot current for this turn
}

/** Persist a composer-sent OpenAI priority-tier change on a opensession session. */
export function maybePersistFastMode(
	session: UnifiedSession | undefined,
	fastMode?: boolean,
): void {
	if (
		!session ||
		session.source !== "opensession" ||
		typeof fastMode !== "boolean" ||
		session.fastMode === fastMode
	)
		return;
	touchNativeSession(session.id, { fastMode });
	session.fastMode = fastMode;
}

// Sessions whose LAST run died on a terminal failure (usage limits exhausted on
// every account, credit/API errors). Those need a human to act — the sidebar
// surfaces them as "Needs input" instead of letting them sink into the Backlog.
// Keyed by canonical session id; parked on globalThis for hot reloads.
// Open Session-owned sessions also persist the error on their session file (via
// recordRunOutcome) so the flag survives a real restart.
export const runErrors: Map<string, { message: string; at: string }> =
	(g.__runErrors ??= new Map());

/**
 * Write the terminal failure into the transcript as a system chip, so a
 * reloaded conversation explains itself instead of just stopping mid-turn.
 * Lives here because recordRunOutcome is the one choke point every failure
 * path already funnels through — the resumed-run (opensession.ts), opening-run
 * (ws-handlers/session-control-wiring) and setup-failure paths all recorded
 * `lastRunError` but wrote no transcript line, so for those the banner was the
 * only trace the run had died (bks-019fb757, 2026-07-31).
 *
 * `require` rather than a static import: opencode-transcript lazily requires
 * this module back (its own cycle-breaker), and the transcript write must be
 * synchronous so it lands before the client re-reads the transcript.
 * Never throws — a dead transcript store must not break outcome recording.
 */
function persistRunFailureNotice(
	engineSessionId: string | null | undefined,
	message: string,
	label: string,
): void {
	if (!engineSessionId) return;
	try {
		const m = require("./opencode-transcript") as typeof import("./opencode-transcript");
		m.appendOpencodeTranscript(engineSessionId, [
			m.transcriptLineRunnerNotice(`${label}: ${message}`),
		]);
	} catch {}
}

/**
 * Record how a session's run ended: an error message when it died on a terminal
 * failure, or null for a clean finish (which clears any earlier failure). The
 * enriched /api/sessions list exposes this as `lastRunError`, and a failure also
 * lands in the transcript as a system chip.
 *
 * `opts.noticePersisted` skips that chip for callers whose runner already wrote
 * a friendlier line (timeouts); `opts.engineSessionId` overrides the session
 * file's id for a run that rotated to a fresh engine session mid-turn;
 * `opts.noticeLabel` re-words it for stops that were not errors.
 */
export function recordRunOutcome(
	sessionId: string,
	errorMessage: string | null,
	opts?: {
		noticePersisted?: boolean;
		engineSessionId?: string;
		noticeLabel?: string;
	},
): void {
	const session = findSession(sessionId);
	const id = session?.id || sessionId;
	transitionRunState(id, errorMessage ? "run_failed" : "turn_end");
	if (errorMessage) {
		const entry = {
			message: errorMessage.slice(0, 500),
			at: new Date().toISOString(),
		};
		runErrors.set(id, entry);
		if (session?.source === "opensession")
			touchNativeSession(id, { lastRunError: entry });
		if (!opts?.noticePersisted)
			persistRunFailureNotice(
				opts?.engineSessionId || session?.claudeSessionId,
				errorMessage,
				opts?.noticeLabel || "Run failed",
			);
		// A worker that dies can't report back, and its parent is usually idle
		// (spawn_task returns immediately), so nothing polls either — the server
		// says it instead. Fire-and-forget, dynamic import to keep this module
		// free of the delivery/git graph. No-ops for anything without a parent.
		void import("./handoff-evidence")
			.then((m) => m.notifyParentOfFailedRun(id, entry.message))
			.catch(() => {});
	} else {
		// Only rewrite the session file when there's actually a flag to clear
		// (the in-memory map, or one persisted by a previous process).
		const had = runErrors.delete(id) || !!session?.lastRunError;
		if (had && session?.source === "opensession")
			touchNativeSession(id, { lastRunError: undefined });
	}
}
