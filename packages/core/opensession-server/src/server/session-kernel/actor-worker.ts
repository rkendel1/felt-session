import { SessionKernelStore } from "./store";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_EXECUTIONS_PER_SESSION,
  SESSION_KERNEL_MAX_EXECUTIONS_TOTAL,
  SESSION_KERNEL_MAX_WAITERS_PER_COMMAND,
  SESSION_KERNEL_MAX_WAITERS_TOTAL,
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
    waiters: string[];
  };
  const executions = new Map<string, Execution>();
  const executingRequests = new Map<string, string>();
  let waiterTotal = 0;
  const executionsPerSession = new Map<string, number>();

  const requestKey = (sessionId: string, requestId: string) =>
    `${sessionId}\u0000${requestId}`;

  function post(message: KernelActorAsyncResponse): void {
    self.postMessage(message);
  }

  function terminalResult(
    request: Extract<KernelActorAsyncRequest, { t: "begin" }>,
    result: unknown,
  ): void {
    post({
      t: "begin_result",
      rpcId: request.rpcId,
      duplicate: true,
      result,
    });
  }

  function begin(
    request: Extract<KernelActorAsyncRequest, { t: "begin" }>,
  ): void {
    try {
      if (store.isTombstoned(request.sessionId))
        throw new Error(`Session ${request.sessionId} was deleted`);
      const key = requestKey(request.sessionId, request.command.commandId);
      const currentExecutionId = executingRequests.get(key);
      const existing = store.command(
        request.sessionId,
        request.command.commandId,
      );
      const terminal =
        existing?.status === "completed" ||
        existing?.status === "indeterminate" ||
        (existing?.status === "failed" &&
          (!existing.retryable || !existing.replaySafe));
      if (
        !terminal &&
        !currentExecutionId &&
        ((executionsPerSession.get(request.sessionId) ?? 0) >=
          SESSION_KERNEL_MAX_EXECUTIONS_PER_SESSION ||
          executions.size >= SESSION_KERNEL_MAX_EXECUTIONS_TOTAL)
      )
        throw Object.assign(new Error("Session effect executor is full"), {
          retryable: true,
        });
      const persisted = store.acceptCommand({
        sessionId: request.sessionId,
        requestId: request.command.commandId,
        type: request.command.operation,
        payload: request.command.payload,
        replaySafe: request.command.replaySafe,
      });
      if (persisted.status === "completed") {
        terminalResult(request, persisted.result);
        return;
      }
      if (
        (persisted.status === "failed" &&
          (!persisted.retryable || !persisted.replaySafe)) ||
        persisted.status === "indeterminate"
      ) {
        terminalResult(request, {
          __sessionKernelFailure: true,
          message:
            persisted.error || "Session command outcome is indeterminate",
        });
        return;
      }

      if (currentExecutionId) {
        const current = executions.get(currentExecutionId);
        if (!current) throw new Error("Session command execution was lost");
        if (
          current.waiters.length >= SESSION_KERNEL_MAX_WAITERS_PER_COMMAND ||
          waiterTotal >= SESSION_KERNEL_MAX_WAITERS_TOTAL
        )
          throw Object.assign(
            new Error("Session command waiter limit reached"),
            {
              retryable: true,
            },
          );
        current.waiters.push(request.rpcId);
        waiterTotal += 1;
        return;
      }

      const execution: Execution = {
        executionId: crypto.randomUUID(),
        sessionId: request.sessionId,
        requestId: request.command.commandId,
        type: request.command.operation,
        waiters: [],
      };
      executions.set(execution.executionId, execution);
      executingRequests.set(key, execution.executionId);
      executionsPerSession.set(
        request.sessionId,
        (executionsPerSession.get(request.sessionId) ?? 0) + 1,
      );
      store.markProcessing(request.sessionId, request.command.commandId);
      post({
        t: "begin_result",
        rpcId: request.rpcId,
        duplicate: false,
        executionId: execution.executionId,
      });
    } catch (error) {
      post({
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
        retryable:
          !!error &&
          typeof error === "object" &&
          (error as { retryable?: boolean }).retryable === true,
      });
    }
  }

  function executionFor(executionId: string): Execution {
    const execution = executions.get(executionId);
    if (!execution)
      throw new Error("Session kernel execution is no longer active");
    return execution;
  }

  function releaseExecution(
    execution: Execution,
    outcome: { result?: unknown; error?: string; retryable?: boolean } = {},
  ): void {
    executions.delete(execution.executionId);
    executingRequests.delete(
      requestKey(execution.sessionId, execution.requestId),
    );
    const remaining = (executionsPerSession.get(execution.sessionId) ?? 1) - 1;
    if (remaining > 0) executionsPerSession.set(execution.sessionId, remaining);
    else executionsPerSession.delete(execution.sessionId);
    for (const rpcId of execution.waiters) {
      waiterTotal -= 1;
      if (outcome.error !== undefined)
        post({
          t: "error",
          rpcId,
          error: outcome.error,
          retryable: outcome.retryable,
        });
      else
        post({
          t: "begin_result",
          rpcId,
          duplicate: true,
          result: outcome.result,
        });
      }
  }

  function finish(
    request: Extract<KernelActorAsyncRequest, { t: "complete" | "fail" }>,
  ): void {
    try {
      const execution = executionFor(request.executionId);
      if (request.t === "complete") {
        if (!store.isTombstoned(execution.sessionId))
          store.completeCommandDecision({
            sessionId: execution.sessionId,
            requestId: execution.requestId,
            type: execution.type,
            result: request.result,
            effects: request.effects,
          });
        post({ t: "complete_result", rpcId: request.rpcId });
        releaseExecution(execution, { result: request.result });
      } else {
        store.failCommand(
          execution.sessionId,
          execution.requestId,
          request.error,
          request.retryable,
        );
        post({ t: "fail_result", rpcId: request.rpcId });
        releaseExecution(execution, {
          error: request.error,
          retryable: request.retryable,
        });
      }
    } catch (error) {
      post({
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Settlement persistence is ownership-critical. Continuing after an
      // ambiguous result could let a stale executor commit over its successor.
      queueMicrotask(() => self.close());
    }
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
    const execution: Execution = {
      executionId: crypto.randomUUID(),
      sessionId,
      requestId: command.requestId,
      type: command.type,
      waiters: [],
    };
    executions.set(execution.executionId, execution);
    executingRequests.set(key, execution.executionId);
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
    releaseExecution(execution, { result });
  }

  function failSync(executionId: string, error: string) {
    const execution = executionFor(executionId);
    store.failCommand(execution.sessionId, execution.requestId, error);
    releaseExecution(execution, { error, retryable: false });
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
        } else {
          const ask = command.request;
          if (ask.op === "snapshot") result = store.askSnapshot(ask.sessionId);
          else if (ask.op === "entries") result = store.askEntries();
          else if (ask.op === "set")
            result = store.setAskRecord(ask.sessionId, ask.value);
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
      store.maintain();
      post({ t: "maintain_result", rpcId: request.rpcId });
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
    } else if (request.t === "begin") begin(request);
    else finish(request);
  };
}

if (import.meta.main) startSessionKernelActorWorker();
