import { SessionKernelStore } from "./store";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_EXECUTIONS_PER_SESSION,
  SESSION_KERNEL_MAX_EXECUTIONS_TOTAL,
  type KernelActorAsyncRequest,
  type KernelActorAsyncResponse,
  type KernelActorSyncRequest,
} from "./actor-protocol";
import { isDeliveryReadRequest } from "./delivery-protocol";

export function startSessionKernelActorWorker(): void {
  const store = new SessionKernelStore();
  type Execution = {
    executionId: string;
    sessionId: string;
    requestId: string;
    type: string;
  };
  const executions = new Map<string, Execution>();
  const executingRequests = new Map<string, string>();
  const executionsPerSession = new Map<string, number>();

  const requestKey = (sessionId: string, requestId: string) =>
    `${sessionId}\u0000${requestId}`;

  function post(message: KernelActorAsyncResponse): void {
    self.postMessage(message);
  }

  function executionFor(executionId: string): Execution {
    const execution = executions.get(executionId);
    if (!execution)
      throw new Error("Session kernel execution is no longer active");
    return execution;
  }

  function releaseExecution(execution: Execution): void {
    executions.delete(execution.executionId);
    executingRequests.delete(
      requestKey(execution.sessionId, execution.requestId),
    );
    const remaining = (executionsPerSession.get(execution.sessionId) ?? 1) - 1;
    if (remaining > 0) executionsPerSession.set(execution.sessionId, remaining);
    else executionsPerSession.delete(execution.sessionId);
  }

  function beginSync(
    sessionId: string,
    command: {
      requestId: string;
      type: string;
      payload?: unknown;
      replaySafe?: boolean;
    },
  ) {
    if (store.isTombstoned(sessionId))
      throw new Error(`Session ${sessionId} was deleted`);
    const persisted = store.acceptCommand({
      sessionId,
      requestId: command.requestId,
      type: command.type,
      payload: command.payload,
      replaySafe: command.replaySafe,
    });
    if (persisted.status === "completed")
      return { duplicate: true, result: persisted.result };
    if (
      (persisted.status === "failed" &&
        (!persisted.retryable || !persisted.replaySafe)) ||
      persisted.status === "indeterminate"
    )
      throw new Error(
        persisted.error || "Session command outcome is indeterminate",
      );
    const key = requestKey(sessionId, command.requestId);
    if (executingRequests.has(key))
      throw new Error("Session command is already executing");
    if (
      (executionsPerSession.get(sessionId) ?? 0) >=
        SESSION_KERNEL_MAX_EXECUTIONS_PER_SESSION ||
      executions.size >= SESSION_KERNEL_MAX_EXECUTIONS_TOTAL
    ) throw new Error("Session effect executor is full");
    const execution: Execution = {
      executionId: crypto.randomUUID(),
      sessionId,
      requestId: command.requestId,
      type: command.type,
    };
    executions.set(execution.executionId, execution);
    executingRequests.set(key, execution.executionId);
    executionsPerSession.set(
      sessionId,
      (executionsPerSession.get(sessionId) ?? 0) + 1,
    );
    store.markProcessing(sessionId, command.requestId);
    return { duplicate: false, executionId: execution.executionId };
  }

  function completeSync(
    executionId: string,
    result: unknown,
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
  ) {
    const execution = executionFor(executionId);
    if (!store.isTombstoned(execution.sessionId))
      store.completeCommandDecision({
        sessionId: execution.sessionId,
        requestId: execution.requestId,
        type: execution.type,
        result,
        effects,
      });
    releaseExecution(execution);
  }

  function failSync(executionId: string, error: string) {
    const execution = executionFor(executionId);
    store.failCommand(execution.sessionId, execution.requestId, error);
    releaseExecution(execution);
  }

  function syncStore(request: KernelActorSyncRequest): void {
    const control = new Int32Array(request.control);
    const output = new Uint8Array(request.output);
    try {
      let result: unknown;
      if (request.t === "reduce") {
        const command = request.command;
        if (command.kind === "creation_event")
          result = store.applyCreationEvent(command.decision);
        else if (command.kind === "run_event")
          result = store.applyRunEvent(command.decision);
        else if (command.kind === "delivery") {
          const delivery = command.request;
          if (delivery.op === "snapshot")
            result = store.deliverySnapshot(delivery.sessionId);
          else if (delivery.op === "entries")
            result = store.deliveryEntries(delivery.slot);
          else if (delivery.op === "request_submit_command")
            result = store.requestSubmitPromptCommand(delivery);
          else if (delivery.op === "complete_submit_command")
            result = store.completeSubmitPromptCommand(delivery);
          else if (delivery.op === "fail_submit_command")
            result = store.failSubmitPromptCommand(delivery);
          else if (delivery.op === "set")
            result = store.setDeliverySlot(
              delivery.sessionId,
              delivery.slot,
              delivery.value,
            );
          else if (delivery.op === "delete")
            result = store.deleteDeliverySlot(delivery.sessionId, delivery.slot);
          else if (delivery.op === "clear_slot")
            result = store.clearDeliverySlot(delivery.slot);
          else if (delivery.op === "prepare_steer")
            result = store.prepareSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.item,
            );
          else if (delivery.op === "accept_steer")
            result = store.acceptSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
            );
          else if (delivery.op === "reject_steer")
            result = store.rejectSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
            );
          else if (delivery.op === "settle_pending_steers")
            result = store.settlePendingSteers();
          else if (delivery.op === "requeue_steers")
            result = store.requeueSteerDeliveries(
              delivery.sessionId,
              delivery.items,
            );
          else if (delivery.op === "prepare_interrupt")
            result = store.prepareDeliveryInterrupt(delivery);
          else if (delivery.op === "begin_interrupt_effect")
            result = store.beginDeliveryInterruptEffect(delivery);
          else if (delivery.op === "settle_interrupt")
            result = store.settleDeliveryInterrupt(delivery);
          else if (delivery.op === "claim_next_dispatch")
            result = store.claimNextDeliveryDispatch(delivery);
          else if (delivery.op === "claim_dispatch")
            result = store.claimDeliveryDispatch(delivery);
          else if (delivery.op === "ack_dispatch")
            result = store.ackDeliveryDispatch(
              delivery.sessionId,
              delivery.promptEntryId,
            );
          else
            result = store.failDeliveryDispatch(
              delivery.sessionId,
              delivery.promptEntryId,
            );
          if (!isDeliveryReadRequest(delivery))
            result = {
              result,
              ...("sessionId" in delivery
                ? { revision: store.deliverySnapshot(delivery.sessionId).revision }
                : {}),
            };
        } else if (command.kind === "gateway") {
          const gateway = command.request;
          if (gateway.op === "request")
            result = store.requestGatewayCommand(gateway);
          else if (gateway.op === "complete")
            result = store.completeGatewayCommand(gateway);
          else result = store.failGatewayCommand(gateway);
        } else if (command.kind === "turn") {
          const turn = command.request;
          if (turn.op === "snapshot") result = store.turnSnapshot(turn.sessionId);
          else if (turn.op === "request_cancel_command")
            result = store.requestTurnCancelCommand(turn);
          else if (turn.op === "complete_cancel_command")
            result = store.completeTurnCancelCommand(turn);
          else if (turn.op === "fail_cancel_command")
            result = store.failTurnCancelCommand(turn);
          else if (turn.op === "prepare_cancel")
            result = store.prepareTurnCancel(turn);
          else if (turn.op === "begin_cancel_effect")
            result = store.beginTurnCancelEffect(turn);
          else if (turn.op === "settle_cancel")
            result = store.settleTurnCancel(turn);
          else if (turn.op === "prepare_outcome_projection")
            result = store.prepareTurnOutcomeProjection(turn);
          else if (turn.op === "begin_outcome_projection")
            result = store.beginTurnOutcomeProjection(turn);
          else result = store.settleTurnOutcomeProjection(turn);
        } else if (command.kind === "timer") {
          const timer = command.request;
          if (timer.op === "begin") result = store.beginTimerExecution(timer);
          else if (timer.op === "complete")
            result = store.completeTimerExecution(timer);
          else if (timer.op === "fail") result = store.failTimerExecution(timer);
          else result = store.recordTimerRuntimeFailure(timer);
        } else {
          const ask = command.request;
          if (ask.op === "snapshot") result = store.askSnapshot(ask.sessionId);
          else if (ask.op === "entries") result = store.askEntries();
          else if (ask.op === "set")
            result = store.setAskRecord(ask.sessionId, ask.value);
          else if (ask.op === "answer")
            result = store.answerAskRecord(
              ask.sessionId,
              ask.questionId,
              ask.answers,
              ask.answeredVia,
            );
          else if (ask.op === "delete")
            result = store.deleteAskRecord(ask.sessionId);
          else result = store.clearAskRecords();
        }
      } else if (request.method === "$beginSync")
        result = beginSync(request.args[0] as string, request.args[1] as any);
      else if (request.method === "$completeSync")
        result = completeSync(
          request.args[0] as string,
          request.args[1],
          request.args[2] as any,
        );
      else if (request.method === "$failSync")
        result = failSync(request.args[0] as string, request.args[1] as string);
      else {
        const method = (
          store as unknown as Record<string, (...args: unknown[]) => unknown>
        )[request.method];
        if (typeof method !== "function")
          throw new Error(`Unknown store method ${request.method}`);
        result = method.apply(store, request.args);
      }
      const bytes = new TextEncoder().encode(
        JSON.stringify({ ok: true, result }),
      );
      if (bytes.length > output.length) {
        // Large read-only snapshots retry with an exactly-sized buffer. Mutating
        // calls are never retried by the client, so this signal cannot repeat a
        // committed reduction.
        Atomics.store(control, 1, bytes.length);
        Atomics.store(control, 0, 2);
      } else {
        output.set(bytes);
        Atomics.store(control, 1, bytes.length);
        Atomics.store(control, 0, 1);
      }
    } catch (error) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      output.set(bytes.subarray(0, output.length));
      Atomics.store(control, 1, Math.min(bytes.length, output.length));
      Atomics.store(control, 0, -1);
    }
    Atomics.notify(control, 0);
  }

  self.onmessage = (
    event: MessageEvent<KernelActorAsyncRequest | KernelActorSyncRequest>,
  ) => {
    const request = event.data;
    if (request.t === "store" || request.t === "reduce") {
      syncStore(request);
      return;
    }
    if (request.t === "hello") {
      if (request.version !== SESSION_KERNEL_ACTOR_VERSION)
        post({
          t: "error",
          rpcId: request.rpcId,
          error: "Unsupported kernel actor version",
        });
      else
        post({
          t: "ready",
          rpcId: request.rpcId,
          version: SESSION_KERNEL_ACTOR_VERSION,
        });
      return;
    }
    if (request.t === "acknowledge") {
      store.acknowledgeCommand(request.sessionId, request.requestId);
      post({ t: "acknowledge_result", rpcId: request.rpcId });
    } else if (request.t === "stats") {
      post({ t: "stats_result", rpcId: request.rpcId, stats: store.stats() });
    } else if (request.t === "maintain") {
      const pending = store.maintain();
      post({ t: "maintain_result", rpcId: request.rpcId, pending });
    } else if (request.t === "runtime_work") {
      post({
        t: "runtime_work_result",
        rpcId: request.rpcId,
        timers: store.dueTimers(request.now, request.limit, request.timerKinds),
        outbox: store.pendingOutbox(
          request.now,
          request.limit,
          request.effectKinds,
        ),
      });
    }
  };
}

if (import.meta.main) startSessionKernelActorWorker();
