/**
 * One logical owner for a session.
 *
 * The production kernel actor serializes commands and owns durable state for
 * exactly one session. This facade executes gateway effects only while holding
 * that actor's lease; it does not let engines or WebSockets become owners.
 */
import { audit } from "../audit";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	SessionKernelActorError,
	type SessionKernelActorClient,
} from "./actor-client";
import {
	SessionKernelStore,
	type SessionKernelStoreApi,
	type DurableCommandRecord,
	type DurableRunState,
	type DurableTimer,
} from "./store";

export interface SessionCommand<TPayload = unknown> {
	requestId: string;
	type: string;
	payload?: TPayload;
	source?: string;
	/** Physical work may be safely re-entered after actor loss because it adopts stable effects. */
	replaySafe?: boolean;
	/** Retry handler failures regardless of message classification (timers/outbox-style policy). */
	retryFailures?: boolean;
}

export interface SessionCommandResult<TResult = unknown> {
	result: TResult;
	duplicate: boolean;
}

export function isRetryableSessionCommandError(error: unknown): boolean {
	if (error instanceof SessionKernelActorError) return error.retryable;
	const message = error instanceof Error ? error.message : String(error);
	return /session kernel actor|sqlite_busy|database is locked|timed out|server restart/i.test(message);
}

type CommandHandler<TResult> = (kernel: SessionKernel,) => TResult | Promise<TResult>;

type GlobalKernelState = {
	store?: SessionKernelStoreApi;
	actor?: SessionKernelActorClient;
	kernels?: Map<string, SessionKernel>;
};

const globalState = globalThis as typeof globalThis & {
	__opensessionSessionKernel?: GlobalKernelState;
};
const state = (globalState.__opensessionSessionKernel ??= {});
type StagedEffect = { kind: string; payload: unknown; effectKey: string };
type CommandContext = {
	sessionId: string;
	requestId: string;
	effects: StagedEffect[];
};
const commandContext = new AsyncLocalStorage<CommandContext>();

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
	return previous instanceof SessionKernelStore ? previous : undefined;
}

export function installSessionKernelActor(
	actor: SessionKernelActorClient | undefined,
): SessionKernelActorClient | undefined {
	const previous = state.actor;
	state.actor = actor;
	if (actor) state.store = actor.store;
	state.kernels?.clear();
	return previous;
}

export class SessionKernel {
	private tail: Promise<void> = Promise.resolve();
	private queued = 0;
	private readonly inFlight = new Map<string, Promise<SessionCommandResult<unknown>>>();
	private readonly activeCommandIds = new Set<string>();
	private readonly runtime = new Map<string, unknown>();
	private lastUsedAt = Date.now();

	constructor(readonly sessionId: string) {}

	get isIdle(): boolean {
		return ( this.queued === 0 && this.inFlight.size === 0 && this.runtime.size === 0
		);
	}

	get idleSince(): number {
		return this.lastUsedAt;
	}

	private mutateSync<TResult>(
		operation: string,
		mutate: () => TResult,
		record = true,
	): TResult {
		this. assertWritable(operation);
		this.touch();
		if (this.ownsCurrentCommand()) {
			const result = mutate();
			if (
				record &&
			operation !== "session_delete" &&
			operation !== "transcript_delete"
		)
				this.recordChange(operation);
			return result;
		}
		if (state.actor) {
			const requestId = crypto.randomUUID();
			const admission = state.actor.beginSync(this.sessionId, {
				requestId,
				type: `sync:${operation}`,
				source: "compatibility",
			});
			if (admission.duplicate) return admission.result as TResult;
			if (admission.borrowed) {
				// Detached callbacks can write while their long-lived command owns
				// the mailbox. The Worker remains the sole physical writer; effects
				// are persisted directly because there is no second decision to settle.
				const borrowed: CommandContext = {
					sessionId: this.sessionId,
					requestId,
					effects: [],
				};
				const result = commandContext.run(borrowed, mutate);
				if (
					record &&
					operation !== "session_delete" &&
					operation !== "transcript_delete"
				)
					this.recordChange(operation);
				for (const effect of borrowed.effects)
					sessionKernelStore().enqueueOutbox(
						this.sessionId,
						effect.kind,
						effect.payload,
						effect.effectKey,
					);
				return result;
			}
			if (!admission.leaseId)
			throw new Error("Session kernel actor did not grant a sync lease");
		const context: CommandContext = {
				sessionId: this.sessionId,
				requestId,
				effects:
			[],
			};
			this.activeCommandIds.add(requestId);
			try {
				const result = commandContext.run(context, mutate);
		if (
					record &&operation !== "session_delete" && operation !== "transcript_delete")
			this.recordChange(operation);
				state.actor.completeSync(admission.leaseId, result, context.effects);
				return result;
			} catch (error) {
				state.actor.failSync(
					admission.leaseId,
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
		const result = mutate();
		if (
			record &&
			operation !== "session_delete" &&
			operation !== "transcript_delete"
		)
			this.recordChange(operation);
		return result;
	}

	private assertWritable(operation?: string): void {
		if (
			sessionKernelStore().isTombstoned(this.sessionId) &&
			operation !== "session_delete" &&
			operation !== "transcript_delete"
		)
			throw new Error(`Session ${this.sessionId} was deleted`);
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

	async dispatch<TResult>(
		command: SessionCommand,
		handler: CommandHandler<TResult>,
	): Promise<SessionCommandResult<TResult>> {
		this.assertWritable();
		if (!command.requestId)
			throw new Error("Session commands require requestId");
		if (this.ownsCurrentCommand())
			throw new Error(`Nested SessionKernel dispatch for ${this.sessionId}`);
		const existingPromise = this.inFlight.get(command.requestId);
		if (existingPromise)
			return existingPromise as Promise<SessionCommandResult<TResult>>;

		if (!state.actor) {
			const persisted = sessionKernelStore().acceptCommand({
				sessionId: this.sessionId,
				requestId: command.requestId,
				type: command.type,
				payload: command.payload,
				replaySafe: command.replaySafe,
			});
			if (persisted.status === "completed") {
				this.touch();
				const failure = persisted.result as
					| { __sessionKernelFailure?: boolean; message?: string }
					| undefined;
				if (failure?.__sessionKernelFailure)
					throw new SessionKernelActorError(
						failure.message || "Session command failed",
						false,
					);
				return { result: persisted.result as TResult, duplicate: true };
			}
			if (
				(persisted.status === "failed" && (!persisted.retryable || !persisted.replaySafe)) ||
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
			command.requestId,
			resultPromise as Promise<SessionCommandResult<unknown>>,
		);

		const run = async () => {
			let actorLease: string | undefined;
			try {
				if (state.actor) {
					const admission = await state.actor.begin(this.sessionId, command);
					if (admission.duplicate) {
						resolve({ result: admission.result as TResult, duplicate: true });
						return;
					}
					actorLease = admission.leaseId;
					if (!actorLease)
						throw new Error("Session kernel actor did not grant a lease");
				} else {
					sessionKernelStore().markProcessing(
						this.sessionId,
						command.requestId,
					);
				}
				this.activeCommandIds.add(command.requestId);
				const context: CommandContext = {
					sessionId: this.sessionId,
					requestId: command.requestId,
					effects: [],
				};
				const result = await commandContext.run(context, () => handler(this));
				if (state.actor)
					await state.actor.complete(actorLease!, result, context.effects);
				else
					sessionKernelStore().completeCommandDecision({
						sessionId: this.sessionId,
						requestId: command.requestId,
						type: command.type,
						result,
						effects: context.effects,
					});
				audit({
					msg: "session_command_completed",
					session_id: this.sessionId,
					request_id: command.requestId,
					command: command.type,
					source: command.source,
				});
				resolve({ result, duplicate: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const retryable =
					command.replaySafe === true &&
					(command.retryFailures === true ||
						isRetryableSessionCommandError(error));
				if (state.actor && actorLease) {
					try {
						await state.actor.fail(
							actorLease,
							message,
							retryable,
						);
					} catch (settleError) {
						console.error(`[session-kernel] Failed to settle ${this.sessionId}/${command.requestId}:`, settleError);
					}
				} else if (retryable)
					sessionKernelStore().failCommand(
						this.sessionId,
						command.requestId,
						message,
						true,
					);
				else
					sessionKernelStore().completeCommandDecision({
						sessionId: this.sessionId,
						requestId: command.requestId,
						type: command.type,
						result: { __sessionKernelFailure: true, message: message.slice(0, 2_000) },
						effects: [],
					});
				audit({
					msg: "session_command_failed",
					session_id: this.sessionId,
					request_id: command.requestId,
					command: command.type,
					error: message,
				});
				reject(error);
			} finally {
				this.activeCommandIds.delete(command.requestId);
				this.queued -= 1;
				this.inFlight.delete(command.requestId);
				this.touch();
			}
		};
		if (state.actor) {
			// The actor mailbox is the sole production scheduler. The gateway keeps
			// only same-request promise coalescing, not a second per-session queue.
			void run();
		} else {
			this.tail = this.tail.then(run, run).then(
				() => {},
				() => {},
			);
		}
		return resultPromise;
	}

	/** Serialize compatibility writes on the same mailbox as durable commands. */
	runExclusive<TResult>(
		name: string,
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
			return this.dispatch(
				{
					requestId: crypto.randomUUID(),
					type: `exclusive:${name}`,
					source: "compatibility",
				},
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

	getRuntime<T>(key: string): T | undefined {
		this.touch();
		return this.runtime.get(key) as T | undefined;
	}

	setRuntime<T>(key: string, value: T): void {
		this.mutateSync(
			`runtime_set:${key}`,
			() => this.runtime.set(key, value),
			false,);
	}

	deleteRuntime(key: string): boolean {
		return this.mutateSync(
			`runtime_delete:${key}`,
			() => this.runtime.delete(key),
			false,
		);
	}

	runtimeEntries<T>(key: string): T | undefined {
		return this.runtime.get(key) as T | undefined;
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
		sessionKernelStore().scheduleTimer({ sessionId: this.sessionId, ...timer,
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

	enqueueEffect(
		kind: string,
		payload: unknown,
		effectKey: string = crypto.randomUUID(),
	): number | undefined {
		this.touch();
		const current = commandContext.getStore();
		if (
			current?.sessionId === this.sessionId &&
			this.activeCommandIds.has(current.requestId)
		) {
			current.effects.push({ kind, payload, effectKey });
			return undefined;
		}
		if (state.actor) {
			this.mutateSync(
				`effect:${kind}`,
				() => {
					const staged = commandContext.getStore();
					if (!staged) throw new Error("Session effect has no actor decision context");
					staged.effects.push({ kind, payload, effectKey });
				},
				false,
			);
			return undefined;
		}
		return sessionKernelStore().enqueueOutbox(this.sessionId, kind, payload, effectKey);
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
			() => {
				this.runtime.clear();
		sessionKernelStore().clearSession(this.sessionId);
			},
			false,);
	}

	tombstone(): void {
		this.mutateSync(
			"session_delete",
			() => {
				this.runtime.clear();
		sessionKernelStore().tombstoneSession(this.sessionId);
			},
			false,);
	}

	private touch(): void {
		this.lastUsedAt = Date.now();
	}
}

function kernels(): Map<string, SessionKernel> {
	return (state.kernels ??= new Map());
}

export function peekSessionKernel(sessionId: string,): SessionKernel | undefined {
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
): Promise<{ timers: DurableTimer[]; outbox: import("./store").DurableOutboxItem[] }> {
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
	if (healthCache && Date.now() - healthCache.at < 5_000) return healthCache.value;
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
	})().finally(() => { healthRefresh = undefined; });
	return healthRefresh;
}

export async function maintainSessionKernel(): Promise<void> {
	if (state.actor) await state.actor.maintainAsync();
	else sessionKernelStore().maintain();
}

export function sessionKernelOwnsCurrentCommand(sessionId: string): boolean {
	return sessionKernel(sessionId).ownsCurrentCommand();
}

export function tombstoneSessionKernel(sessionId: string): void {
	const kernel = state.kernels?.get(sessionId) ?? new SessionKernel(sessionId);
	kernel.tombstone();
	state.kernels?.delete(sessionId);
}
