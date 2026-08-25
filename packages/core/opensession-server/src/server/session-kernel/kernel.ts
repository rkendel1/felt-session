/**
 * One logical owner for a session.
 *
 * The production kernel actor admits commands and owns durable state for exactly
 * one session. This facade executes admitted physical effects in order, then
 * returns their fenced results. Engines and WebSockets never become owners.
 */
import { audit } from "../audit";
import type { AskActorRequest, AskActorResult } from "./ask-protocol";
import {
	type SessionActorEffectFor,
	type SessionActorEffectKind,
} from "./lifecycle-protocol";
import type {
  DeliveryActorRequest,
  DeliveryActorResult,
} from "./delivery-protocol";
import type { TurnActorRequest, TurnActorResult } from "./turn-protocol";
import type { TimerActorRequest, TimerActorResult } from "./timer-protocol";
import type { GatewayCommandRequest, GatewayCommandResult } from "./gateway-command-protocol";
import type { CoreActorRequest, CoreActorResult } from "./core-protocol";
import {
	SessionKernelActorError,
	type SessionKernelActorClient,
} from "./actor-client";
import {
	SessionKernelStore,
	type SessionKernelStoreApi,
	type CreationEventDecision,
	type CreationEventDecisionResult,
	type DurableCommandRecord,
	type DurableCreationState,
	type DurableDeliveryState,
	type DurableRunState,
	type DurableTimer,
	type RunEventDecision,
	type RunEventDecisionResult,
} from "./store";

export function isRetryableSessionCommandError(error: unknown): boolean {
	if (error instanceof SessionKernelActorError) return error.retryable;
	const message = error instanceof Error ? error.message : String(error);
  return /session kernel actor|sqlite_busy|database is locked|timed out|server restart/i.test(
    message,
  );
}

type GlobalKernelState = {
	store?: SessionKernelStoreApi;
	actor?: SessionKernelActorClient;
	kernels?: Map<string, SessionKernel>;
	deliveryProjection?: Map<string, DurableDeliveryState>;
};

const globalState = globalThis as typeof globalThis & {
	__opensessionSessionKernel?: GlobalKernelState;
};
const state = (globalState.__opensessionSessionKernel ??= {});
function compatibilityStoreForTest(
  domain: "ask" | "core" | "creation" | "delivery" | "gateway command" | "turn",
) {
	if (process.env.NODE_ENV !== "test")
		throw new Error(
			`Session ${domain} mutation requires the authoritative actor`,
		);
	return sessionKernelStore();
}

export function sessionAsk<T extends AskActorRequest>(
  request: T,
): AskActorResult<T> {
  if (state.actor) return state.actor.decideAsk(request);
  const store = compatibilityStoreForTest("ask");
  let result: unknown;
  if (request.op === "snapshot") result = store.askSnapshot(request.sessionId);
  else if (request.op === "entries") result = store.askEntries();
  else if (request.op === "set")
    result = store.setAskRecord(request.sessionId, request.value);
  else if (request.op === "answer")
    result = store.answerAskRecord(
      request.sessionId,
      request.questionId,
      request.answers,
      request.answeredVia,
    );
  else if (request.op === "delete")
    result = store.deleteAskRecord(request.sessionId);
  else result = store.clearAskRecords();
  return result as AskActorResult<T>;
}

export function sessionTurn<T extends TurnActorRequest>(
  request: T,
): TurnActorResult<T> {
  const actor = state.actor;
  if (actor) return actor.decideTurn(request);
  const store = compatibilityStoreForTest("turn");
  if (request.op === "snapshot")
    return store.turnSnapshot(request.sessionId) as TurnActorResult<T>;
  if (request.op === "request_cancel_command")
    return store.requestTurnCancelCommand(request) as TurnActorResult<T>;
  if (request.op === "complete_cancel_command")
    return store.completeTurnCancelCommand(request) as TurnActorResult<T>;
  if (request.op === "fail_cancel_command")
    return store.failTurnCancelCommand(request) as TurnActorResult<T>;
  if (request.op === "prepare_cancel")
    return store.prepareTurnCancel(request) as TurnActorResult<T>;
  if (request.op === "begin_cancel_effect")
    return store.beginTurnCancelEffect(request) as TurnActorResult<T>;
  if (request.op === "settle_cancel")
    return store.settleTurnCancel(request) as TurnActorResult<T>;
  if (request.op === "prepare_outcome_projection")
    return store.prepareTurnOutcomeProjection(request) as TurnActorResult<T>;
  if (request.op === "begin_outcome_projection")
    return store.beginTurnOutcomeProjection(request) as TurnActorResult<T>;
  return store.settleTurnOutcomeProjection(request) as TurnActorResult<T>;
}

export function sessionTimer<T extends TimerActorRequest>(
  request: T,
): TimerActorResult<T> {
  if (state.actor) return state.actor.decideTimer(request);
  const store = compatibilityStoreForTest("turn");
  if (request.op === "schedule")
    return store.scheduleTimer(request) as TimerActorResult<T>;
  if (request.op === "cancel")
    return store.cancelTimer(request.sessionId, request.timerId) as TimerActorResult<T>;
  if (request.op === "begin")
    return store.beginTimerExecution(request) as TimerActorResult<T>;
  if (request.op === "complete")
    return store.completeTimerExecution(request) as TimerActorResult<T>;
  if (request.op === "fail")
    return store.failTimerExecution(request) as TimerActorResult<T>;
  return store.recordTimerRuntimeFailure(request) as TimerActorResult<T>;
}

export function sessionCore<T extends CoreActorRequest>(
  request: T,
): CoreActorResult<T> {
  if (state.actor) return state.actor.decideCore(request);
  const store = compatibilityStoreForTest("core");
  if (request.op === "enqueue_effect")
    return store.enqueueOutbox(
      request.sessionId,
      request.kind,
      request.payload,
      request.effectKey,
    ) as CoreActorResult<T>;
  if (request.op === "ack_outbox")
    return store.ackOutbox(request.id) as CoreActorResult<T>;
  if (request.op === "defer_outbox")
    return store.deferOutbox(request.id) as CoreActorResult<T>;
  if (request.op === "fail_outbox")
    return store.noteOutboxFailure(
      request.id,
      request.error,
      request.maxAttempts,
    ) as CoreActorResult<T>;
  if (request.op === "clear")
    return store.clearSession(request.sessionId) as CoreActorResult<T>;
  return store.tombstoneSession(request.sessionId) as CoreActorResult<T>;
}

export function sessionGatewayCommand<T extends GatewayCommandRequest>(
  request: T,
): GatewayCommandResult<T> {
  if (state.actor) return state.actor.decideGateway(request);
  const store = compatibilityStoreForTest("gateway command");
  if (request.op === "request")
    return store.requestGatewayCommand(request) as GatewayCommandResult<T>;
  if (request.op === "complete")
    return store.completeGatewayCommand(request) as GatewayCommandResult<T>;
  return store.failGatewayCommand(request) as GatewayCommandResult<T>;
}

export function sessionDelivery<T extends DeliveryActorRequest>(
  request: T,
): DeliveryActorResult<T> {
  const projection = (state.deliveryProjection ??= new Map());
  if (request.op === "snapshot") {
    const cached = projection.get(request.sessionId);
    if (cached) return cached as DeliveryActorResult<T>;
  }
  const actor = state.actor;
  let result: unknown;
  if (actor) result = actor.decideDelivery(request);
  else {
    const store = compatibilityStoreForTest("delivery");
    if (request.op === "snapshot")
      result = store.deliverySnapshot(request.sessionId);
  else if (request.op === "entries")
    result = store.deliveryEntries(request.slot);
  else if (request.op === "request_submit_command")
    result = store.requestSubmitPromptCommand(request);
  else if (request.op === "complete_submit_command")
    result = store.completeSubmitPromptCommand(request);
  else if (request.op === "fail_submit_command")
    result = store.failSubmitPromptCommand(request);
  else if (request.op === "set")
    result = store.setDeliverySlot(
      request.sessionId,
      request.slot,
      request.value,
    );
  else if (request.op === "delete")
    result = store.deleteDeliverySlot(request.sessionId, request.slot);
  else if (request.op === "clear_slot")
    result = store.clearDeliverySlot(request.slot);
  else if (request.op === "prepare_steer")
    result = store.prepareSteerDelivery(
      request.sessionId,
      request.itemId,
      request.item,
    );
  else if (request.op === "accept_steer")
    result = store.acceptSteerDelivery(request.sessionId, request.itemId);
  else if (request.op === "reject_steer")
    result = store.rejectSteerDelivery(request.sessionId, request.itemId);
  else if (request.op === "settle_pending_steers")
    result = store.settlePendingSteers();
  else if (request.op === "requeue_steers")
    result = store.requeueSteerDeliveries(request.sessionId, request.items);
  else if (request.op === "prepare_interrupt")
    result = store.prepareDeliveryInterrupt(request);
  else if (request.op === "begin_interrupt_effect")
    result = store.beginDeliveryInterruptEffect(request);
  else if (request.op === "settle_interrupt")
    result = store.settleDeliveryInterrupt(request);
  else if (request.op === "claim_next_dispatch")
    result = store.claimNextDeliveryDispatch(request);
  else if (request.op === "claim_dispatch")
    result = store.claimDeliveryDispatch(request);
  else if (request.op === "ack_dispatch")
    result = store.ackDeliveryDispatch(
      request.sessionId,
      request.promptEntryId,
    );
    else
      result = store.failDeliveryDispatch(
        request.sessionId,
        request.promptEntryId,
      );
  }
  if (request.op === "snapshot") {
    projection.set(request.sessionId, result as DurableDeliveryState);
  } else if ("sessionId" in request) {
    projection.delete(request.sessionId);
  } else if (request.op === "clear_slot" || request.op === "settle_pending_steers") {
    projection.clear();
  }
  return result as DeliveryActorResult<T>;
}

export function sessionDeliveryProjection(sessionId: string): DurableDeliveryState {
  const projection = (state.deliveryProjection ??= new Map());
  const cached = projection.get(sessionId);
  if (cached) return cached;
  return sessionDelivery({ op: "snapshot", sessionId });
}

export function sessionKernelActorActive(): boolean {
  return !!state.actor;
}

export function sessionKernelStore(): SessionKernelStoreApi {
	return (state.store ??= new SessionKernelStore());
}

export function __setSessionKernelStoreForTest(
	store: SessionKernelStore | undefined,
): SessionKernelStore | undefined {
	const previous = state.store;
	state.store = store;
	state.actor = undefined;
	state.kernels?.clear();
	state.deliveryProjection?.clear();
	return previous instanceof SessionKernelStore ? previous : undefined;
}

export function installSessionKernelActor(
	actor: SessionKernelActorClient | undefined,
): SessionKernelActorClient | undefined {
	const previous = state.actor;
	state.actor = actor;
	if (actor) state.store = actor.store;
	state.kernels?.clear();
	state.deliveryProjection?.clear();
	return previous;
}

export class SessionKernel {
	private lastUsedAt = Date.now();

	constructor(readonly sessionId: string) {}

	get isIdle(): boolean {
		return true;
	}

	get idleSince(): number {
		return this.lastUsedAt;
	}

	private assertWritable(operation?: string): void {
		if (
			sessionKernelStore().isTombstoned(this.sessionId) &&
			operation !== "session_delete" &&
			operation !== "transcript_delete"
		)
			throw new Error(`Session ${this.sessionId} was deleted`);
	}

  applyCreationEvent(
    input: Omit<CreationEventDecision, "sessionId">,
  ): CreationEventDecisionResult {
    this.assertWritable(`creation_state:${input.event}`);
    this.touch();
    const result = state.actor
      ? state.actor.decideCreationEvent({
          sessionId: this.sessionId,
          ...input,
        })
      : compatibilityStoreForTest("creation").applyCreationEvent({
          sessionId: this.sessionId,
          ...input,
        });
    if (!result.accepted && result.reason === "stale_effect")
      audit({
        msg: "session_creation_stale_result_rejected",
        session_id: this.sessionId,
        creation_identity: input.identity,
        effect_id: input.effectId,
        current_effect_id: result.state?.currentEffectId,
        creation_generation: result.state?.generation,
        event: input.event,
      });
    return result;
  }

  creationState(): DurableCreationState | undefined {
    this.touch();
    return sessionKernelStore().creationState(this.sessionId);
  }

  applyRunEvent(
    input: Omit<RunEventDecision, "sessionId">,
  ): RunEventDecisionResult {
		this.assertWritable(`run_state:${input.event}`);
		this.touch();
    return sessionKernelStore().applyRunEvent({
      sessionId: this.sessionId,
      ...input,
    });
	}

	runState(): DurableRunState {
		this.touch();
		return sessionKernelStore().runState(this.sessionId);
	}

	isCurrentRun(runId: string, generation?: number): boolean {
		const current = this.runState();
		return (
			["running", "ask_blocked", "interrupted", "reattaching"].includes(
				current.state,
			) &&
			current.currentRunId === runId &&
			(generation === undefined || current.generation === generation)
		);
	}

	changesSince(changeSeq: number, limit = 500) {
		this.touch();
		return sessionKernelStore().changesSince(this.sessionId, changeSeq, limit);
	}

	scheduleTimer(
		timer: Omit<
			DurableTimer,
			| "sessionId"
			| "token"
			| "attempts"
			| "nextAttemptAt"
			| "lastError"
			| "deadLetteredAt"
			| "createdAt"
		>,
	): void {
    sessionTimer({ op: "schedule", sessionId: this.sessionId, ...timer });
	}

	cancelTimer(timerId: string): void {
    sessionTimer({ op: "cancel", sessionId: this.sessionId, timerId });
	}

	enqueueEffect<K extends SessionActorEffectKind>(
		kind: K,
		payload: SessionActorEffectFor<K>["payload"],
		effectKey: string = crypto.randomUUID(),
	): number {
		this.touch();
    return sessionCore({
      op: "enqueue_effect",
      sessionId: this.sessionId,
      kind,
      payload: payload as SessionActorEffectFor<SessionActorEffectKind>["payload"],
      effectKey,
    });
	}

	clear(): void {
    sessionCore({ op: "clear", sessionId: this.sessionId });
	}

	tombstone(): void {
    sessionCore({ op: "tombstone", sessionId: this.sessionId });
	}

	private touch(): void {
		this.lastUsedAt = Date.now();
	}
}

function kernels(): Map<string, SessionKernel> {
	return (state.kernels ??= new Map());
}

export function peekSessionKernel(
  sessionId: string,
): SessionKernel | undefined {
	return state.kernels?.get(sessionId);
}

export function sessionKernel(sessionId: string): SessionKernel {
	if (!sessionId) throw new Error("SessionKernel requires sessionId");
	let kernel = kernels().get(sessionId);
	if (!kernel) {
		kernel = new SessionKernel(sessionId);
		kernels().set(sessionId, kernel);
	}
	return kernel;
}

export function activeSessionKernels(): readonly SessionKernel[] {
	return [...kernels().values()];
}

export function passivateIdleSessionKernels(
	now = Date.now(),
	idleMs = 60_000,
): number {
	let count = 0;
	for (const [sessionId, kernel] of kernels()) {
		if (!kernel.isIdle || now - kernel.idleSince < idleMs) continue;
		kernels().delete(sessionId);
		count += 1;
	}
	return count;
}

export function clearSessionKernel(sessionId: string): void {
	const kernel = kernels().get(sessionId) ?? sessionKernel(sessionId);
	kernel.clear();
	kernels().delete(sessionId);
}

export function durableSessionCommand(
	sessionId: string,
	requestId: string,
): DurableCommandRecord | undefined {
	return sessionKernelStore().command(sessionId, requestId);
}

export async function acknowledgeSessionCommand(
	sessionId: string,
	requestId: string,
): Promise<void> {
	if (state.actor) {
		await state.actor.acknowledgeCommand(sessionId, requestId);
		return;
	}
	sessionKernelStore().acknowledgeCommand(sessionId, requestId);
}

export async function sessionKernelRuntimeWork(
	timerKinds: string[],
	effectKinds: string[],
	now = Date.now(),
	limit = 100,
): Promise<{
  timers: DurableTimer[];
  outbox: import("./store").DurableOutboxItem[];
}> {
	if (state.actor)
		return state.actor.runtimeWork(timerKinds, effectKinds, now, limit);
	return {
		timers: sessionKernelStore().dueTimers(now, limit, timerKinds),
		outbox: sessionKernelStore().pendingOutbox(now, limit, effectKinds),
	};
}

let healthCache: { at: number; value: Record<string, unknown> } | undefined;
let healthRefresh: Promise<Record<string, unknown>> | undefined;
export async function sessionKernelHealth(): Promise<Record<string, unknown>> {
  if (healthCache && Date.now() - healthCache.at < 5_000)
    return healthCache.value;
	if (healthRefresh) return healthRefresh;
	healthRefresh = (async () => {
		const stats = state.actor
			? await state.actor.statsAsync()
			: sessionKernelStore().stats();
		const value = {
			active: state.kernels?.size ?? 0,
			...stats,
			degraded:
				stats.deadLetteredOutbox > 0 ||
				stats.deadLetteredTimers > 0 ||
				(stats.pendingCommands > 0 &&
					stats.oldestPendingCommandAt !== undefined &&
					Date.now() - stats.oldestPendingCommandAt > 5 * 60_000),
		};
		healthCache = { at: Date.now(), value };
		return value;
  })().finally(() => {
    healthRefresh = undefined;
  });
	return healthRefresh;
}

export async function maintainSessionKernel(): Promise<boolean> {
	if (state.actor) return state.actor.maintainAsync();
	return sessionKernelStore().maintain();
}

export function tombstoneSessionKernel(sessionId: string): void {
	const kernel = state.kernels?.get(sessionId) ?? new SessionKernel(sessionId);
	kernel.tombstone();
	state.kernels?.delete(sessionId);
}
