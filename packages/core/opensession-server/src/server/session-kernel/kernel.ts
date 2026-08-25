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
	legacyGatewayEffect,
	type LegacyGatewayEffect,
	type LegacyGatewayEffectOperation,
	type SessionActorEffectFor,
	type SessionActorEffectKind,
	type StagedSessionActorEffect,
} from "./lifecycle-protocol";
import type {
  DeliveryActorRequest,
  DeliveryActorResult,
} from "./delivery-protocol";
import type { TurnActorRequest, TurnActorResult } from "./turn-protocol";
import type { TimerActorRequest, TimerActorResult } from "./timer-protocol";
import { AsyncLocalStorage } from "node:async_hooks";
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

export interface SessionCommandResult<TResult = unknown> {
	result: TResult;
	duplicate: boolean;
}

export function isRetryableSessionCommandError(error: unknown): boolean {
	if (error instanceof SessionKernelActorError) return error.retryable;
	const message = error instanceof Error ? error.message : String(error);
  return /session kernel actor|sqlite_busy|database is locked|timed out|server restart/i.test(
    message,
  );
}

type CommandHandler<TResult> = (
  kernel: SessionKernel,
) => TResult | Promise<TResult>;

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
type CommandContext = {
	sessionId: string;
	requestId: string;
	effects: StagedSessionActorEffect[];
};
const commandContext = new AsyncLocalStorage<CommandContext>();

function compatibilityStoreForTest(
  domain: "ask" | "creation" | "delivery" | "turn",
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
  if (request.op === "begin")
    return store.beginTimerExecution(request) as TimerActorResult<T>;
  if (request.op === "complete")
    return store.completeTimerExecution(request) as TimerActorResult<T>;
  if (request.op === "fail")
    return store.failTimerExecution(request) as TimerActorResult<T>;
  return store.recordTimerRuntimeFailure(request) as TimerActorResult<T>;
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
	private tail: Promise<void> = Promise.resolve();
	private queued = 0;
  private readonly inFlight = new Map<
    string,
    Promise<SessionCommandResult<unknown>>
  >();
	private readonly activeCommandIds = new Set<string>();
	private lastUsedAt = Date.now();

	constructor(readonly sessionId: string) {}

	get isIdle(): boolean {
		return this.queued === 0 && this.inFlight.size === 0;
	}

	get idleSince(): number {
		return this.lastUsedAt;
	}

	private mutateSync<TResult>(
		operation: string,
		mutate: () => TResult,
		record = true,
	): TResult {
		this.assertWritable(operation);
		this.touch();
		const apply = () => {
			const result = mutate();
			if (
				record &&
				operation !== "session_delete" &&
				operation !== "transcript_delete"
			)
				this.recordChange(operation);
			return result;
		};
		if (this.ownsCurrentCommand()) return apply();
		if (state.actor) {
			const requestId = crypto.randomUUID();
			const admission = state.actor.beginSync(this.sessionId, {
				requestId,
				type: `sync:${operation}`,
				source: "compatibility",
			});
			if (admission.duplicate) return admission.result as TResult;
			if (!admission.executionId)
				throw new Error("Session kernel actor did not create a sync execution");
			const context: CommandContext = {
				sessionId: this.sessionId,
				requestId,
				effects: [],
			};
			this.activeCommandIds.add(requestId);
			try {
				const result = commandContext.run(context, apply);
				state.actor.completeSync(
					admission.executionId,
					result,
					context.effects,
				);
				return result;
			} catch (error) {
				state.actor.failSync(
					admission.executionId,
					error instanceof Error ? error.message : String(error),
				);
				throw error;
			} finally {
				this.activeCommandIds.delete(requestId);
			}
		}
		if (this.queued > 0)
			throw new Error(
				`Session mutation ${operation} raced the ${this.sessionId} mailbox`,
			);
		return apply();
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

	setRunState(input: {
		state: string;
		event: string;
		detail?: unknown;
		generation?: number;
		currentRunId?: string;
	}): DurableRunState {
		return this.mutateSync(
			`run_state:${input.event}`,
			() =>
				sessionKernelStore().setRunState({
					sessionId: this.sessionId,
					...input,
				}),
			false,
		);
	}

	registerRun(
		runId: string,
		stateName: string,
		event: string,
		detail?: unknown,
	): DurableRunState {
		return this.mutateSync(
			`register_run:${event}`,
			() => {
				const prior = sessionKernelStore().runState(this.sessionId);
				return sessionKernelStore().setRunState({
					sessionId: this.sessionId,
					state: stateName,
					event,
					detail,
					currentRunId: runId,
					generation:
						prior.currentRunId === runId
							? prior.generation
							: prior.generation + 1,
				});
			},
			false,
		);
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

	async dispatchLegacy<TResult>(
		command: LegacyGatewayEffect,
		handler: CommandHandler<TResult>,
	): Promise<SessionCommandResult<TResult>> {
		this.assertWritable();
		if (!command.commandId)
			throw new Error("Session commands require requestId");
		if (this.ownsCurrentCommand())
			throw new Error(`Nested SessionKernel dispatch for ${this.sessionId}`);
		const existingPromise = this.inFlight.get(command.commandId);
		if (existingPromise)
			return existingPromise as Promise<SessionCommandResult<TResult>>;

		if (!state.actor) {
			const persisted = sessionKernelStore().acceptCommand({
				sessionId: this.sessionId,
				requestId: command.commandId,
				type: command.operation,
				payload: command.payload,
				replaySafe: command.replaySafe,
			});
			if (persisted.status === "completed") {
				this.touch();
				const failure = persisted.result as
          { __sessionKernelFailure?: boolean; message?: string } | undefined;
				if (failure?.__sessionKernelFailure)
					throw new SessionKernelActorError(
						failure.message || "Session command failed",
						false,
					);
				return { result: persisted.result as TResult, duplicate: true };
			}
			if (
        (persisted.status === "failed" &&
          (!persisted.retryable || !persisted.replaySafe)) ||
				persisted.status === "indeterminate"
			)
				throw new SessionKernelActorError(
					persisted.error || "Session command outcome is indeterminate",
					false,
				);
		}

		this.queued += 1;
		let resolve!: (value: SessionCommandResult<TResult>) => void;
		let reject!: (error: unknown) => void;
		const resultPromise = new Promise<SessionCommandResult<TResult>>(
			(res, rej) => {
				resolve = res;
				reject = rej;
			},
		);
		this.inFlight.set(
			command.commandId,
			resultPromise as Promise<SessionCommandResult<unknown>>,
		);
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      this.activeCommandIds.delete(command.commandId);
      this.queued -= 1;
      this.inFlight.delete(command.commandId);
      this.touch();
    };

    const execute = async (executionId?: string) => {
			try {
        if (!state.actor)
					sessionKernelStore().markProcessing(
						this.sessionId,
						command.commandId,
					);
				this.activeCommandIds.add(command.commandId);
				const context: CommandContext = {
					sessionId: this.sessionId,
					requestId: command.commandId,
					effects: [],
				};
				const result = await commandContext.run(context, () => handler(this));
				if (state.actor)
          await state.actor.complete(executionId!, result, context.effects);
				else
					sessionKernelStore().completeCommandDecision({
						sessionId: this.sessionId,
						requestId: command.commandId,
						type: command.operation,
						result,
						effects: context.effects,
					});
				audit({
					msg: "session_command_completed",
					session_id: this.sessionId,
					request_id: command.commandId,
					command: command.operation,
					source: command.source,
				});
				resolve({ result, duplicate: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const retryable =
					command.replaySafe === true &&
					(command.retryFailures === true ||
						isRetryableSessionCommandError(error));
        if (state.actor && executionId) {
					try {
            await state.actor.fail(executionId, message, retryable);
					} catch (settleError) {
            console.error(
              `[session-kernel] Failed to settle ${this.sessionId}/${command.commandId}:`,
              settleError,
            );
					}
				} else if (retryable)
					sessionKernelStore().failCommand(
						this.sessionId,
						command.commandId,
						message,
						true,
					);
				else
					sessionKernelStore().completeCommandDecision({
						sessionId: this.sessionId,
						requestId: command.commandId,
						type: command.operation,
            result: {
              __sessionKernelFailure: true,
              message: message.slice(0, 2_000),
            },
						effects: [],
					});
				audit({
					msg: "session_command_failed",
					session_id: this.sessionId,
					request_id: command.commandId,
					command: command.operation,
					error: message,
				});
				reject(error);
			} finally {
        cleanup();
			}
		};

		if (state.actor) {
      void state.actor.begin(this.sessionId, command).then(
        (admission) => {
          if (admission.duplicate) {
            const failure = admission.result as
              | { __sessionKernelFailure?: boolean; message?: string }
              | undefined;
            if (failure?.__sessionKernelFailure)
              reject(
                new SessionKernelActorError(
                  failure.message || "Session command failed",
                  false,
                ),
              );
            else
              resolve({
                result: admission.result as TResult,
                duplicate: true,
              });
            cleanup();
            return;
          }
          if (!admission.executionId) {
            reject(
              new Error("Session kernel actor did not create an execution"),
            );
            cleanup();
            return;
          }
          const scheduled = this.tail.then(
            () => execute(admission.executionId),
            () => execute(admission.executionId),
          );
          this.tail = scheduled.then(
            () => {},
            () => {},
          );
        },
        (error) => {
          reject(error);
          cleanup();
        },
      );
		} else {
      const scheduled = this.tail.then(
        () => execute(),
        () => execute(),
      );
      this.tail = scheduled.then(
				() => {},
				() => {},
			);
		}
		return resultPromise;
	}

  /** Admit compatibility work, then serialize its physical gateway effect. */
	runExclusive<TResult>(
		name: Extract<
			LegacyGatewayEffectOperation,
			"session_file_updated" | "delete_session"
		>,
		operation: () => TResult | Promise<TResult>,
	): Promise<TResult> {
		this.assertWritable();
		this.touch();
		const ownedOperation = async () => {
			const result = await operation();
			this.recordChange(name);
			return result;
		};
		if (this.ownsCurrentCommand()) return ownedOperation();
		if (state.actor) {
			return this.dispatchLegacy(
				legacyGatewayEffect(name, {
					requestId: crypto.randomUUID(),
					source: "compatibility",
				}),
				operation,
			).then((accepted) => accepted.result);
		}
		this.queued += 1;
		let result: Promise<TResult>;
		if (this.queued === 1) {
			// Preserve the existing read-after-write contract: an uncontended sync
			// mutation executes before this function returns its promise.
			try {
				result = ownedOperation();
			} catch (error) {
				this.queued -= 1;
				return Promise.reject(error);
			}
		} else {
			result = this.tail.then(ownedOperation);
		}
		const settled = result.then(
			() => {},
			() => {},
		);
		this.tail = settled;
		void settled.finally(() => {
			this.queued -= 1;
			this.touch();
		});
		return result;
	}

	applySync<TResult>(operation: string, mutate: () => TResult): TResult {
		return this.mutateSync(operation, mutate);
	}

	recordChange(kind: string, payload?: unknown): number {
		this.touch();
		return sessionKernelStore().appendChange(this.sessionId, kind, payload);
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
		this.mutateSync(
			`timer_schedule:${timer.timerId}`,
			() =>
        sessionKernelStore().scheduleTimer({
          sessionId: this.sessionId,
          ...timer,
				}),
			false,
		);
	}

	cancelTimer(timerId: string): void {
		this.mutateSync(
			`timer_cancel:${timerId}`,
			() => sessionKernelStore().cancelTimer(this.sessionId, timerId),
			false,
		);
	}

	enqueueEffect<K extends SessionActorEffectKind>(
		kind: K,
		payload: SessionActorEffectFor<K>["payload"],
		effectKey: string = crypto.randomUUID(),
	): number | undefined {
		this.touch();
		const current = commandContext.getStore();
		if (
			current?.sessionId === this.sessionId &&
			this.activeCommandIds.has(current.requestId)
		) {
			current.effects.push({ kind, payload, effectKey } as StagedSessionActorEffect);
			return undefined;
		}
		if (state.actor) {
			this.mutateSync(
				`effect:${kind}`,
				() => {
					const staged = commandContext.getStore();
          if (!staged)
            throw new Error("Session effect has no actor decision context");
					staged.effects.push({ kind, payload, effectKey } as StagedSessionActorEffect);
				},
				false,
			);
			return undefined;
		}
    return sessionKernelStore().enqueueOutbox(
      this.sessionId,
      kind,
      payload,
      effectKey,
    );
	}

	ownsCurrentCommand(): boolean {
		const current = commandContext.getStore();
		return (
			current?.sessionId === this.sessionId &&
			this.activeCommandIds.has(current.requestId)
		);
	}

	clear(): void {
		this.mutateSync(
			"session_clear",
			() => sessionKernelStore().clearSession(this.sessionId),
      false,
    );
	}

	tombstone(): void {
		this.mutateSync(
			"session_delete",
			() => sessionKernelStore().tombstoneSession(this.sessionId),
      false,
    );
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

export function sessionKernelOwnsCurrentCommand(sessionId: string): boolean {
	return sessionKernel(sessionId).ownsCurrentCommand();
}

export function tombstoneSessionKernel(sessionId: string): void {
	const kernel = state.kernels?.get(sessionId) ?? new SessionKernel(sessionId);
	kernel.tombstone();
	state.kernels?.delete(sessionId);
}
