/** Runtime wake-ups for durable timers and outbox effects. */
import {
	passivateIdleSessionKernels,
	sessionKernel,
	sessionKernelRuntimeWork,
	sessionKernelStore,
	maintainSessionKernel,
	sessionTimer,
} from "./kernel";
import type { DurableOutboxItem, DurableTimer } from "./store";
import {
	executeSessionEffect,
	registeredSessionEffectKinds,
  SessionEffectDeferredError,
} from "./effect-executors";
import { pruneCreatePlans } from "../session-create-plan";
import {
  CreationEffectIndeterminateError,
  ensureCreationEffectExecutors,
} from "./creation-effect-executors";
import { audit } from "../audit";

type TimerHandler = (timer: DurableTimer) => void | Promise<void>;

class SessionTimerExecutionError extends Error {
	constructor(
		readonly cause: unknown,
		readonly deadLetteredNow: boolean,
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "SessionTimerExecutionError";
	}
}

function timerRuntimeFailure(
	timer: DurableTimer,
	error: unknown,
): SessionTimerExecutionError {
	let deadLetteredNow = false;
	try {
		deadLetteredNow = sessionTimer({
			op: "record_runtime_failure",
			sessionId: timer.sessionId,
			timerId: timer.timerId,
			token: timer.token,
			error: error instanceof Error ? error.message : String(error),
			maxAttempts: 20,
			observedAttempts: timer.attempts,
		}).deadLetteredNow;
	} catch {
		// The actor is the only timer writer. If it is unavailable, preserve the
		// original failure and let the next actor-owned runtime pass retry.
	}
	return new SessionTimerExecutionError(error, deadLetteredNow);
}

function failDeadCreationEffect(
	item: DurableOutboxItem,
	error: string,
): void {
	if (!item.kind.startsWith("creation_")) return;
	const payload = item.payload as
		| { creationIdentity?: unknown; creationGeneration?: unknown }
		| undefined;
	if (
		typeof payload?.creationIdentity !== "string" ||
		payload.creationIdentity.length === 0 ||
		!Number.isSafeInteger(payload.creationGeneration)
	)
		return;
	const result = sessionKernel(item.sessionId).applyCreationEvent({
		identity: payload.creationIdentity,
		event: "failed",
		effectId: item.effectKey,
		detail: { effectKind: item.kind, error },
	});
	if (!result.accepted && result.reason !== "stale_effect")
		throw new Error(
			`Creation effect ${item.effectId} failure was rejected: ${result.reason || "unknown"}`,
		);
}
type RuntimeState = {
	timerHandlers: Map<string, TimerHandler>;
	handle?: ReturnType<typeof setInterval>;
	draining?: boolean;
	lastCompactAt?: number;
	maintenancePending?: boolean;
	activeTimers?: Set<string>;
	activeOutbox?: Set<number>;
	activeOpeningOutbox?: Set<number>;
};

const globalRuntime = globalThis as typeof globalThis & {
	__opensessionSessionKernelRuntime?: RuntimeState;
};
const runtime: RuntimeState = (globalRuntime.__opensessionSessionKernelRuntime ??= {
	timerHandlers: new Map(),
});

export function registerSessionTimerHandler(
	kind: string,
	handler: TimerHandler,
): () => void {
	runtime.timerHandlers.set(kind, handler);
	return () => {
		if (runtime.timerHandlers.get(kind) === handler)
			runtime.timerHandlers.delete(kind);
	};
}

export async function fireSessionTimer(timer: DurableTimer): Promise<boolean> {
	const handler = runtime.timerHandlers.get(timer.kind);
	if (!handler) return false;
	let decision: "execute" | "completed" | "missing";
	try {
		decision = sessionTimer({
			op: "begin",
			sessionId: timer.sessionId,
			timerId: timer.timerId,
			token: timer.token,
		});
	} catch (error) {
		throw timerRuntimeFailure(timer, error);
	}
	if (decision === "missing") return false;
	if (decision === "completed") return true;
	try {
		await handler(timer);
	} catch (error) {
		try {
			const settled = sessionTimer({
				op: "fail",
				sessionId: timer.sessionId,
				timerId: timer.timerId,
				token: timer.token,
				error: error instanceof Error ? error.message : String(error),
				maxAttempts: 20,
			});
			throw new SessionTimerExecutionError(error, settled.deadLetteredNow);
		} catch (settlementError) {
			if (settlementError instanceof SessionTimerExecutionError)
				throw settlementError;
			throw timerRuntimeFailure(timer, settlementError);
		}
	}
	try {
		sessionTimer({
			op: "complete",
			sessionId: timer.sessionId,
			timerId: timer.timerId,
			token: timer.token,
		});
	} catch (error) {
		throw timerRuntimeFailure(timer, error);
	}
	return true;
}

export async function fireStoredSessionTimer(
	sessionId: string,
	timerId: string,
): Promise<boolean> {
	const timer = sessionKernelStore().timer(sessionId, timerId);
	return timer ? fireSessionTimer(timer) : false;
}

export async function drainSessionKernelRuntime(): Promise<void> {
	if (runtime.draining) return;
	runtime.draining = true;
	try {
		const timerKinds = [...runtime.timerHandlers.keys()];
		const effectKinds = registeredSessionEffectKinds();
		const openingKind = "creation_opening_turn";
		const work = await sessionKernelRuntimeWork(
			timerKinds,
			effectKinds.filter((kind) => kind !== openingKind),
		);
		if (effectKinds.includes(openingKind)) {
			// Admit enough opening effects to project their session files immediately.
			// session-create.ts applies the smaller eight-turn engine gate only after
			// projection, so slow agent turns cannot hide later accepted sessions.
			const openings = await sessionKernelRuntimeWork([], [openingKind], Date.now(), 100);
			work.outbox.push(...openings.outbox);
		}
		const activeTimers = (runtime.activeTimers ??= new Set());
		for (const timer of work.timers) {
			if (activeTimers.size >= 8) break;
			const key = `${timer.sessionId}:${timer.timerId}:${timer.token}`;
			if (activeTimers.has(key)) continue;
			activeTimers.add(key);
			void fireSessionTimer(timer)
				.catch((error) => {
					const message =
						error instanceof Error ? error.message : String(error);
					if (
						error instanceof SessionTimerExecutionError &&
						error.deadLetteredNow
					)
						audit({ msg: "session_kernel_dead_lettered", kind: "timer", session_id: timer.sessionId, timer_id: timer.timerId, error: message });
					console.error(
						`[session-kernel] timer ${timer.kind}/${timer.timerId} failed:`,
						error instanceof SessionTimerExecutionError
							? error.cause
							: error,
					);
				}
				)
				.finally(() => activeTimers.delete(key));
		}
		const activeOutbox = (runtime.activeOutbox ??= new Set());
		const activeOpeningOutbox = (runtime.activeOpeningOutbox ??= new Set());
		for (const item of work.outbox) {
			// Opening turns can legitimately last for hours. Keep their bounded
			// execution pool separate so eight accepted openings cannot starve
			// delivery, preparation, or projection effects globally.
			const active =
				item.kind === "creation_opening_turn"
					? activeOpeningOutbox
					: activeOutbox;
			const admissionLimit = item.kind === openingKind ? 100 : 8;
			if (active.size >= admissionLimit || active.has(item.id)) continue;
			active.add(item.id);
			void executeSessionEffect(item)
				.then((executed) => {
					if (executed) sessionKernelStore().ackOutbox(item.id);
				})
				.catch((error) => {
          if (error instanceof SessionEffectDeferredError) {
            sessionKernelStore().deferOutbox(item.id);
            return;
          }
					const message =
						error instanceof Error ? error.message : String(error);
					const settled = sessionKernelStore().noteOutboxFailure(
						item.id,
						message,
						error instanceof CreationEffectIndeterminateError ? 1 : 20,
					);
					if (settled.deadLetteredNow) {
						failDeadCreationEffect(item, message);
						audit({ msg: "session_kernel_dead_lettered", kind: "outbox", session_id: item.sessionId, outbox_id: item.id, error: message });
					}
					console.error(
						`[session-kernel] outbox ${item.kind}/${item.id} failed:`,error,
					);
				}
				)
				.finally(() => active.delete(item.id));
		}
		passivateIdleSessionKernels();
		const maintenanceSweepDue =
			!runtime.lastCompactAt ||
			Date.now() - runtime.lastCompactAt > 60 * 60_000;
		if (runtime.maintenancePending || maintenanceSweepDue) {
			runtime.maintenancePending = await maintainSessionKernel();
			if (maintenanceSweepDue) {
				pruneCreatePlans(sessionKernelStore());
				runtime.lastCompactAt = Date.now();
			}
		}
	} finally {
		runtime.draining = false;
	}
}

export function startSessionKernelRuntime(intervalMs = 1_000): void {
	if (runtime.handle) return;
	ensureCreationEffectExecutors();
	runtime.handle = setInterval(() => {
		void drainSessionKernelRuntime();
	}, intervalMs);
	runtime.handle.unref?.();
	void drainSessionKernelRuntime();
}

export function stopSessionKernelRuntime(): void {
	if (runtime.handle) clearInterval(runtime.handle);
	runtime.handle = undefined;
}

/** Settle durable ownership left behind without a recoverable journal. */
export function reconcileSessionKernelOwnership(
	ownedSessionIds: ReadonlySet<string>,
): string[] {
	const unsettled = new Set([
		"preparing",
		"starting",
		"running",
		"ask_blocked",
		"interrupted",
		"reattaching",
	]);
	const settled: string[] = [];
	for (const state of sessionKernelStore().runStates()) {
		if (!unsettled.has(state.state) || ownedSessionIds.has(state.sessionId))
			continue;
		sessionKernel(state.sessionId).applyRunEvent({
			event: "boot_owner_missing",
			detail: { previousState: state.state },
		});
		settled.push(state.sessionId);
	}
	return settled;
}

export async function waitForSessionKernelRuntimeIdle(
	timeoutMs = 5_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (
		(runtime.activeTimers?.size || 0) > 0 ||
		(runtime.activeOutbox?.size || 0) > 0 ||
		(runtime.activeOpeningOutbox?.size || 0) > 0
	) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(5);
	}
	return true;
}
