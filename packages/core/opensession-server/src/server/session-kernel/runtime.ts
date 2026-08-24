/** Runtime wake-ups for durable timers and outbox effects. */
import {
	passivateIdleSessionKernels,
	sessionKernel,
	sessionKernelRuntimeWork,
	sessionKernelStore,
	maintainSessionKernel,
} from "./kernel";
import type { DurableOutboxItem, DurableTimer } from "./store";
import {
	executeSessionEffect,
	registeredSessionEffectKinds,
} from "./effect-executors";
import { legacyGatewayEffect } from "./lifecycle-protocol";
import { pruneCreatePlans } from "../session-create-plan";
import {
  CreationEffectIndeterminateError,
  ensureCreationEffectExecutors,
} from "./creation-effect-executors";
import { audit } from "../audit";

type TimerHandler = (timer: DurableTimer) => void | Promise<void>;

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
	activeTimers?: Set<string>;
	activeOutbox?: Set<number>;
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
	await sessionKernel(timer.sessionId).dispatchLegacy(
		legacyGatewayEffect("timer_fired", {
			requestId: `timer:${timer.timerId}:${timer.token}`,
			payload: {
				timerId: timer.timerId,
				kind: timer.kind,
				dueAt: timer.dueAt,
				payload: timer.payload,
			},
			source: "timer",
			replaySafe: true,
			retryFailures: true,
		}),
		() => handler(timer),
	);
	sessionKernelStore().settleTimerSuccess(timer.sessionId, timer.timerId, timer.token);
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
		const work = await sessionKernelRuntimeWork(timerKinds, effectKinds);
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
					const settled = sessionKernelStore().noteTimerFailure(
						timer.sessionId,
						timer.timerId,
						message,
						20,
						timer.token,
					);
					if (settled.deadLetteredNow)
						audit({ msg: "session_kernel_dead_lettered", kind: "timer", session_id: timer.sessionId, timer_id: timer.timerId, error: message });
					console.error(
						`[session-kernel] timer ${timer.kind}/${timer.timerId} failed:`,
						error,
					);
				}
				)
				.finally(() => activeTimers.delete(key));
		}
		const activeOutbox = (runtime.activeOutbox ??= new Set());
		for (const item of work.outbox) {
			if (activeOutbox.size >= 8) break;
			if (activeOutbox.has(item.id)) continue;
			activeOutbox.add(item.id);
			void executeSessionEffect(item)
				.then((executed) => {
					if (executed) sessionKernelStore().ackOutbox(item.id);
				})
				.catch((error) => {
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
				.finally(() => activeOutbox.delete(item.id));
		}
		passivateIdleSessionKernels();
		if (!runtime.lastCompactAt || Date.now() - runtime.lastCompactAt > 60 * 60_000) {
			await maintainSessionKernel();
			pruneCreatePlans(sessionKernelStore());
			runtime.lastCompactAt = Date.now();
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
		(runtime.activeOutbox?.size || 0) > 0
	) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(5);
	}
	return true;
}
