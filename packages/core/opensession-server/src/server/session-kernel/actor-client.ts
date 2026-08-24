import type {
  LegacyGatewayEffect,
  SessionActorReducerCommand,
} from "./lifecycle-protocol";
import type {
  CreationEventDecision,
  CreationEventDecisionResult,
  DurableCommandRecord,
  DurableCreationState,
  DurableDeliveryState,
  DurableOutboxItem,
  DeliverySlot,
  DurableRunState,
  DurableTimer,
  RunEventDecision,
  RunEventDecisionResult,
  SessionKernelStoreApi,
} from "./store";
import {
  isDeliveryReadRequest,
  type DeliveryActorRequest,
  type DeliveryActorResult,
  type DeliveryMutationReply,
} from "./delivery-protocol";
import type { AskActorRequest, AskActorResult } from "./ask-protocol";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  type KernelActorAsyncRequest,
  type KernelActorAsyncResponse,
} from "./actor-protocol";

const SMALL_OUTPUT_BYTES = 256 * 1024;
const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DYNAMIC_OUTPUT_BYTES = 128 * 1024 * 1024;
const LARGE_STORE_RESPONSES = new Set([
  "changesSince",
  "creationState",
  "pendingOutbox",
  "dueTimers",
  "runStates",
]);

export class SessionKernelActorError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SessionKernelActorError";
  }
}

type Pending = {
  resolve: (value: KernelActorAsyncResponse) => void;
  reject: (error: Error) => void;
};

export class SessionKernelActorClient {
  private readonly pending = new Map<string, Pending>();
  private readonly executions = new Map<string, string>();
  private deadError?: Error;
  // Synchronous calls cannot overlap on the gateway thread: Atomics.wait
  // blocks until the actor finishes. Reuse their shared response buffers
  // instead of allocating and faulting 256 KiB for every map read. Session
  // list enrichment alone performs hundreds of small reads.
  private readonly syncControlBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * 2,
  );
  private readonly syncSmallOutputBuffer = new SharedArrayBuffer(
    SMALL_OUTPUT_BYTES,
  );
  private syncLargeOutputBuffer?: SharedArrayBuffer;
  readonly store: SessionKernelStoreApi;

  constructor(
    private readonly worker: Worker,
    private readonly onFatal?: (error: Error) => void,
  ) {
    worker.addEventListener("message", (event: MessageEvent) => {
      const response = event.data as KernelActorAsyncResponse;
      const pending = this.pending.get(response.rpcId);
      if (!pending) return;
      this.pending.delete(response.rpcId);
      if (response.t === "error")
        pending.reject(
          new SessionKernelActorError(response.error, response.retryable),
        );
      else pending.resolve(response);
    });
    worker.addEventListener("error", (event) => {
      this.markDead(new Error(`Session kernel actor failed: ${event.message}`));
    });
    worker.addEventListener("messageerror", () => {
      this.markDead(new Error("Session kernel actor sent an invalid message"));
    });
    (
      worker as Worker & {
        addEventListener(type: "close", listener: () => void): void;
      }
    ).addEventListener("close", () => {
        this.markDead(new Error("Session kernel actor exited"));
      });
    this.store = new RemoteStore(this);
  }

  async hello(): Promise<void> {
    const response = await this.request({
      t: "hello",
      rpcId: crypto.randomUUID(),
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    if (
      response.t !== "ready" ||
      response.version !== SESSION_KERNEL_ACTOR_VERSION
    )
      throw new Error("Session kernel actor handshake failed");
    (this.store as RemoteStore).hydrateRunStates();
  }

  async acknowledgeCommand(
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const response = await this.request({
      t: "acknowledge",
      rpcId: crypto.randomUUID(),
      sessionId,
      requestId,
    });
    if (response.t !== "acknowledge_result")
      throw new Error("Invalid kernel acknowledgement response");
  }

  async statsAsync(): Promise<ReturnType<SessionKernelStoreApi["stats"]>> {
    const response = await this.request({
      t: "stats",
      rpcId: crypto.randomUUID(),
    });
    if (response.t !== "stats_result")
      throw new Error("Invalid kernel stats response");
    return response.stats;
  }

  async maintainAsync(): Promise<void> {
    const response = await this.request({
      t: "maintain",
      rpcId: crypto.randomUUID(),
    });
    if (response.t !== "maintain_result")
      throw new Error("Invalid kernel maintenance response");
  }

  async runtimeWork(
    timerKinds: string[],
    effectKinds: string[],
    now = Date.now(),
    limit = 100,
  ): Promise<{ timers: DurableTimer[]; outbox: DurableOutboxItem[] }> {
    const response = await this.request({
      t: "runtime_work",
      rpcId: crypto.randomUUID(),
      now,
      timerKinds,
      effectKinds,
      limit,
    });
    if (response.t !== "runtime_work_result")
      throw new Error("Invalid kernel runtime work response");
    return { timers: response.timers, outbox: response.outbox };
  }

  async begin(
    sessionId: string,
    command: LegacyGatewayEffect,
  ): Promise<{ duplicate: boolean; executionId?: string; result?: unknown }> {
    const response = await this.request({
      t: "begin",
      rpcId: crypto.randomUUID(),
      sessionId,
      command,
    });
    if (response.t !== "begin_result")
      throw new Error("Invalid kernel begin response");
    const failure = response.result as
      { __sessionKernelFailure?: boolean; message?: string } | undefined;
    if (failure?.__sessionKernelFailure)
      throw new SessionKernelActorError(
        failure.message || "Session command failed",
        false,
      );
    if (response.executionId)
      this.executions.set(response.executionId, sessionId);
    return response;
  }

  async complete(
    executionId: string,
    result: unknown,
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
  ): Promise<void> {
    try {
      const response = await this.request({
        t: "complete",
        rpcId: crypto.randomUUID(),
        executionId,
        result,
        effects,
      });
      if (response.t !== "complete_result")
        throw new Error("Invalid kernel complete response");
      const sessionId = this.executions.get(executionId);
      if (sessionId) (this.store as RemoteStore).noteChange(sessionId);
      this.executions.delete(executionId);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // Once handler execution has finished, a failed completion is ambiguous.
      // Fail-stop instead of converting it into a retryable failed receipt.
      this.markDead(failure);
      throw failure;
    }
  }

  beginSync(
    sessionId: string,
    command: {
      requestId: string;
      type: string;
      payload?: unknown;
      source?: string;
      replaySafe?: boolean;
    },
  ): { duplicate: boolean; executionId?: string; result?: unknown } {
    const admission = this.callStore<{
      duplicate: boolean;
      executionId?: string;
      result?: unknown;
    }>("$beginSync", [sessionId, command]);
    if (admission.executionId)
      this.executions.set(admission.executionId, sessionId);
    return admission;
  }

  completeSync(
    executionId: string,
    result: unknown,
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
  ): void {
    try {
      this.callStore("$completeSync", [executionId, result, effects]);
      const sessionId = this.executions.get(executionId);
      if (sessionId) (this.store as RemoteStore).noteChange(sessionId);
      this.executions.delete(executionId);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.markDead(failure);
      throw failure;
    }
  }

  failSync(executionId: string, error: string): void {
    try {
      this.callStore("$failSync", [executionId, error]);
      this.executions.delete(executionId);
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      this.markDead(failure);
      throw failure;
    }
  }

  async fail(
    executionId: string,
    error: string,
    retryable = false,
  ): Promise<void> {
    if (!retryable) {
      await this.complete(
        executionId,
        { __sessionKernelFailure: true, message: error.slice(0, 2_000) },
        [],
      );
      return;
    }
    try {
      const response = await this.request({
        t: "fail",
        rpcId: crypto.randomUUID(),
        executionId,
        error,
        retryable,
      });
      if (response.t !== "fail_result")
        throw new Error("Invalid kernel failure response");
      this.executions.delete(executionId);
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      this.markDead(failure);
      throw failure;
    }
  }

  decideAsk<T extends AskActorRequest>(request: T): AskActorResult<T> {
    return this.callSync<AskActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "ask", commandId: crypto.randomUUID(), request },
      },
      `ask ${request.op}`,
      request.op === "snapshot" || request.op === "entries",
    );
  }

  decideDelivery<T extends DeliveryActorRequest>(
    request: T,
  ): DeliveryActorResult<T> {
    const response = this.callSync<
      DeliveryActorResult<T> | DeliveryMutationReply<DeliveryActorResult<T>>
    >(
      {
        t: "reduce",
        command: {
          kind: "delivery",
          commandId: crypto.randomUUID(),
          request,
        },
      },
      `delivery ${request.op}`,
      isDeliveryReadRequest(request),
    );
    return (isDeliveryReadRequest(request)
      ? response
      : (response as DeliveryMutationReply<DeliveryActorResult<T>>).result
    ) as DeliveryActorResult<T>;
  }

  decideCreationEvent(
    decision: CreationEventDecision,
  ): CreationEventDecisionResult {
    return this.callSync<CreationEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "creation_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "creation event decision",
      true,
    );
  }

  decideRunEvent(decision: RunEventDecision): RunEventDecisionResult {
    const result = this.callSync<RunEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "run_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "run event decision",
    );
    if (result.accepted)
      (this.store as RemoteStore).noteRunState(
        decision.sessionId,
        result.state,
      );
    return result;
  }

  callStore<TResult>(method: string, args: unknown[]): TResult {
    return this.callSync<TResult>(
      { t: "store", method, args },
      method,
      LARGE_STORE_RESPONSES.has(method),
    );
  }

  private callSync<TResult>(
    request:
      | { t: "store"; method: string; args: unknown[] }
      | { t: "reduce"; command: SessionActorReducerCommand },
    label: string,
    large = false,
    outputBytes = large ? LARGE_OUTPUT_BYTES : SMALL_OUTPUT_BYTES,
  ): TResult {
    if (this.deadError) throw this.deadError;
    const controlBuffer = this.syncControlBuffer;
    const outputBuffer =
      outputBytes === SMALL_OUTPUT_BYTES
        ? this.syncSmallOutputBuffer
        : outputBytes === LARGE_OUTPUT_BYTES
          ? (this.syncLargeOutputBuffer ??= new SharedArrayBuffer(
              LARGE_OUTPUT_BYTES,
            ))
          : new SharedArrayBuffer(outputBytes);
    const control = new Int32Array(controlBuffer);
    Atomics.store(control, 0, 0);
    Atomics.store(control, 1, 0);
    this.worker.postMessage({
      ...request,
      control: controlBuffer,
      output: outputBuffer,
    });
    const waited = Atomics.wait(control, 0, 0, 10_000);
    if (waited === "timed-out") {
      const error = new Error(`Session kernel actor timed out in ${label}`);
      this.markDead(error);
      throw error;
    }
    const status = Atomics.load(control, 0);
    const length = Atomics.load(control, 1);
    if (status === 2) {
      if (!large || length <= outputBytes || length > MAX_DYNAMIC_OUTPUT_BYTES) {
        const error = new Error(
          `Session kernel ${label} response requires ${length} bytes`,
        );
        this.markDead(error);
        throw error;
      }
      return this.callSync(request, label, large, length);
    }
    const text = new TextDecoder().decode(
      new Uint8Array(outputBuffer, 0, length),
    );
    const response = JSON.parse(text) as {
      ok: boolean;
      result?: TResult;
      error?: string;
    };
    if (!response.ok)
      throw new Error(response.error || `Session kernel ${label} failed`);
    return response.result as TResult;
  }

  terminate(): void {
    this.markDead(new Error("Session kernel actor stopped"), false);
    this.worker.terminate();
  }

  private request(
    request: KernelActorAsyncRequest,
  ): Promise<KernelActorAsyncResponse> {
    if (this.deadError) return Promise.reject(this.deadError);
    return new Promise((resolve, reject) => {
      // Duplicate begin requests wait for the active execution result. Worker
      // error/messageerror remains their failure signal; every other RPC is bounded.
      const timeout =
        request.t === "begin"
          ? undefined
          : setTimeout(() => {
              this.pending.delete(request.rpcId);
              const error = new Error(
                `Session kernel actor timed out handling ${request.t}`,
              );
              this.markDead(error);
              reject(error);
            }, 15_000);
      this.pending.set(request.rpcId, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.pending.delete(request.rpcId);
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.markDead(failure);
        reject(failure);
      }
    });
  }

  private markDead(error: Error, fatal = true): void {
    if (this.deadError) return;
    this.deadError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (fatal) this.onFatal?.(error);
  }
}

class RemoteStore implements SessionKernelStoreApi {
  private readonly runStateCache = new Map<string, DurableRunState>();
  private statsCache?: {
    at: number;
    value: ReturnType<SessionKernelStoreApi["stats"]>;
  };
  constructor(private readonly actor: SessionKernelActorClient) {}
  hydrateRunStates(): void {
    this.runStateCache.clear();
    for (const state of this.call<
      Array<DurableRunState & { sessionId: string }>
    >("runStates"))
      this.runStateCache.set(state.sessionId, state);
  }
  noteRunState(sessionId: string, state: DurableRunState): void {
    this.runStateCache.set(sessionId, state);
  }
  noteChange(sessionId: string): void {
    const current = this.runStateCache.get(sessionId) ?? {
      state: "idle",
      since: new Date().toISOString(),
      generation: 0,
      changeSeq: 0,
    };
    this.runStateCache.set(sessionId, {
      ...current,
      changeSeq: current.changeSeq + 1,
    });
  }
  private call<T>(method: string, ...args: unknown[]): T {
    return this.actor.callStore<T>(method, args);
  }
  close(): void {}
  command(sessionId: string, requestId: string) {
    return this.call<DurableCommandRecord | undefined>(
      "command",
      sessionId,
      requestId,
    );
  }
  acceptCommand(input: {
    sessionId: string;
    requestId: string;
    type: string;
    payload?: unknown;
  }) {
    return this.call<DurableCommandRecord>("acceptCommand", input);
  }
  markProcessing(sessionId: string, requestId: string) {
    this.call("markProcessing", sessionId, requestId);
  }
  completeCommand(sessionId: string, requestId: string, result: unknown) {
    this.call("completeCommand", sessionId, requestId, result);
  }
  completeCommandDecision(
    input: Parameters<SessionKernelStoreApi["completeCommandDecision"]>[0],
  ) {
    this.call("completeCommandDecision", input);
    this.noteChange(input.sessionId);
  }
  failCommand(
    sessionId: string,
    requestId: string,
    error: string,
    retryable = false,
  ) {
    this.call("failCommand", sessionId, requestId, error, retryable);
  }
  creationState(sessionId: string): DurableCreationState | undefined {
    return this.call<DurableCreationState | undefined>(
      "creationState",
      sessionId,
    );
  }
  applyCreationEvent(input: CreationEventDecision) {
    return this.actor.decideCreationEvent(input);
  }
  runState(sessionId: string) {
    return (
      this.runStateCache.get(sessionId) ?? {
      state: "idle",
      since: new Date(0).toISOString(),
      generation: 0,
      changeSeq: 0,
      }
    );
  }
  runStates() {
    return [...this.runStateCache].map(([sessionId, state]) => ({
      sessionId,
      ...state,
    }));
  }
  appendChange(sessionId: string, kind: string, payload?: unknown) {
    const seq = this.call<number>("appendChange", sessionId, kind, payload);
    const current = this.runState(sessionId);
    this.runStateCache.set(sessionId, { ...current, changeSeq: seq });
    return seq;
  }
  changesSince(sessionId: string, after: number, limit?: number) {
    return this.call<ReturnType<SessionKernelStoreApi["changesSince"]>>(
      "changesSince",
      sessionId,
      after,
      limit,
    );
  }
  applyRunEvent(input: RunEventDecision) {
    return this.actor.decideRunEvent(input);
  }
  setRunState(input: Parameters<SessionKernelStoreApi["setRunState"]>[0]) {
    const next = this.call<DurableRunState>("setRunState", input);
    this.runStateCache.set(input.sessionId, next);
    return next;
  }
  isTombstoned(sessionId: string, now?: number) {
    return this.call<boolean>("isTombstoned", sessionId, now);
  }
  tombstoneSession(sessionId: string) {
    this.call("tombstoneSession", sessionId);
    this.runStateCache.delete(sessionId);
  }
  clearSession(sessionId: string) {
    this.call("clearSession", sessionId);
    this.runStateCache.delete(sessionId);
  }
  askMigrationComplete() {
    return this.call<boolean>("askMigrationComplete");
  }
  markAskMigrationComplete() {
    this.call("markAskMigrationComplete");
  }
  askSnapshot(sessionId: string) {
    return this.actor.decideAsk({ op: "snapshot", sessionId });
  }
  askEntries() {
    return this.actor.decideAsk({ op: "entries" });
  }
  setAskRecord(sessionId: string, value: unknown) {
    this.actor.decideAsk({ op: "set", sessionId, value });
  }
  deleteAskRecord(sessionId: string) {
    return this.actor.decideAsk({ op: "delete", sessionId });
  }
  clearAskRecords() {
    this.actor.decideAsk({ op: "clear" });
  }
  deliveryMigrationComplete() {
    return this.call<boolean>("deliveryMigrationComplete");
  }
  markDeliveryMigrationComplete() {
    this.call("markDeliveryMigrationComplete");
  }
  deliverySnapshot(sessionId: string) {
    return this.actor.decideDelivery({ op: "snapshot", sessionId });
  }
  deliveryEntries(slot: DeliverySlot) {
    return this.actor.decideDelivery({ op: "entries", slot });
  }
  setDeliverySlot(sessionId: string, slot: DeliverySlot, value: unknown) {
    this.actor.decideDelivery({ op: "set", sessionId, slot, value });
  }
  deleteDeliverySlot(sessionId: string, slot: DeliverySlot) {
    return this.actor.decideDelivery({ op: "delete", sessionId, slot });
  }
  clearDeliverySlot(slot: DeliverySlot) {
    this.actor.decideDelivery({ op: "clear_slot", slot });
  }
  prepareSteerDelivery(sessionId: string, itemId: string, item?: unknown) {
    return this.actor.decideDelivery({
      op: "prepare_steer",
      sessionId,
      itemId,
      item,
    });
  }
  acceptSteerDelivery(sessionId: string, itemId: string) {
    return this.actor.decideDelivery({ op: "accept_steer", sessionId, itemId });
  }
  rejectSteerDelivery(sessionId: string, itemId: string) {
    return this.actor.decideDelivery({ op: "reject_steer", sessionId, itemId });
  }
  settlePendingSteers() {
    return this.actor.decideDelivery({ op: "settle_pending_steers" });
  }
  requeueSteerDeliveries(sessionId: string, items: unknown[]) {
    return this.actor.decideDelivery({
      op: "requeue_steers",
      sessionId,
      items,
    });
  }
  claimNextDeliveryDispatch(
    input: Parameters<SessionKernelStoreApi["claimNextDeliveryDispatch"]>[0],
  ): ReturnType<SessionKernelStoreApi["claimNextDeliveryDispatch"]> {
    return this.actor.decideDelivery({
      op: "claim_next_dispatch",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["claimNextDeliveryDispatch"]>;
  }
  claimDeliveryDispatch(
    input: Parameters<SessionKernelStoreApi["claimDeliveryDispatch"]>[0],
  ) {
    return this.actor.decideDelivery({ op: "claim_dispatch", ...input });
  }
  ackDeliveryDispatch(sessionId: string, promptEntryId: string) {
    return this.actor.decideDelivery({
      op: "ack_dispatch",
      sessionId,
      promptEntryId,
    });
  }
  failDeliveryDispatch(sessionId: string, promptEntryId: string) {
    return this.actor.decideDelivery({
      op: "fail_dispatch",
      sessionId,
      promptEntryId,
    });
  }
  scheduleTimer(timer: Parameters<SessionKernelStoreApi["scheduleTimer"]>[0]) {
    this.call("scheduleTimer", timer);
  }
  timer(sessionId: string, timerId: string) {
    return this.call<DurableTimer | undefined>("timer", sessionId, timerId);
  }
  cancelTimer(sessionId: string, timerId: string) {
    this.call("cancelTimer", sessionId, timerId);
  }
  settleTimerSuccess(sessionId: string, timerId: string, token: string) {
    return this.call<boolean>("settleTimerSuccess", sessionId, timerId, token);
  }
  dueTimers(now?: number, limit?: number, kinds?: readonly string[]) {
    return this.call<DurableTimer[]>("dueTimers", now, limit, kinds);
  }
  enqueueOutbox(
    sessionId: string,
    kind: string,
    payload: unknown,
    effectKey?: string,
  ) {
    return this.call<number>(
      "enqueueOutbox",
      sessionId,
      kind,
      payload,
      effectKey,
    );
  }
  enqueueOutboxMany(
    sessionId: string,
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
  ) {
    return this.call<number[]>("enqueueOutboxMany", sessionId, effects);
  }
  pendingOutbox(now?: number, limit?: number, kinds?: readonly string[]) {
    return this.call<DurableOutboxItem[]>("pendingOutbox", now, limit, kinds);
  }
  stats() {
    if (this.statsCache && Date.now() - this.statsCache.at < 5_000)
      return this.statsCache.value;
    const value =
      this.call<ReturnType<SessionKernelStoreApi["stats"]>>("stats");
    this.statsCache = { at: Date.now(), value };
    return value;
  }
  acknowledgeCommand(sessionId: string, requestId: string) {
    return this.call<boolean>("acknowledgeCommand", sessionId, requestId);
  }
  compact(now?: number, retention?: number, changes?: number) {
    this.call("compact", now, retention, changes);
  }
  maintain() {
    this.call("maintain");
  }
  deadLetters(limit?: number, offset?: number) {
    return this.call<ReturnType<SessionKernelStoreApi["deadLetters"]>>(
      "deadLetters",
      limit,
      offset,
    );
  }
  discardDeadTimer(sessionId: string, timerId: string) {
    return this.call<boolean>("discardDeadTimer", sessionId, timerId);
  }
  discardDeadOutbox(id: number) {
    return this.call<boolean>("discardDeadOutbox", id);
  }
  retryDeadTimer(sessionId: string, timerId: string) {
    return this.call<boolean>("retryDeadTimer", sessionId, timerId);
  }
  retryDeadOutbox(id: number) {
    return this.call<boolean>("retryDeadOutbox", id);
  }
  retryCompatibleCreationBranchDeadLetters(
    destinations: ReadonlyArray<{ project: string; worktreePath: string }>,
    now?: number,
  ) {
    return this.call<
      Array<{
        id: number;
        sessionId: string;
        reason:
          | "shared_checkout_destination_adoptable"
          | "legacy_empty_base_branch";
      }>
    >(
      "retryCompatibleCreationBranchDeadLetters",
      destinations,
      now,
    );
  }
  ackOutbox(id: number) {
    this.call("ackOutbox", id);
  }
  noteTimerFailure(
    sessionId: string,
    timerId: string,
    error: string,
    maxAttempts?: number,
    expectedToken?: string,
  ) {
    return this.call<ReturnType<SessionKernelStoreApi["noteTimerFailure"]>>(
      "noteTimerFailure",
      sessionId,
      timerId,
      error,
      maxAttempts,
      expectedToken,
    );
  }
  noteOutboxFailure(id: number, error: string, maxAttempts?: number) {
    return this.call<ReturnType<SessionKernelStoreApi["noteOutboxFailure"]>>(
      "noteOutboxFailure",
      id,
      error,
      maxAttempts,
    );
  }
}
