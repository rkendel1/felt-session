import { SessionKernelStore } from "./store";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_QUEUED_PER_SESSION,
  SESSION_KERNEL_MAX_QUEUED_TOTAL,
  type KernelActorAsyncRequest,
  type KernelActorAsyncResponse,
  type KernelActorSyncRequest,
} from "./actor-protocol";

export function startSessionKernelActorWorker(): void {
  const store = new SessionKernelStore();
  type Lease = {
    leaseId: string;
    sessionId: string;
    requestId: string;
    type: string;
  };
  const active = new Map<string, Lease>();
  const queues = new Map<
    string,
    Array<Extract<KernelActorAsyncRequest, { t: "begin" }>>
  >();
  let queuedTotal = 0;

  function post(message: KernelActorAsyncResponse): void {
    self.postMessage(message);
  }

  function grant(
    request: Extract<KernelActorAsyncRequest, { t: "begin" }>,
  ): void {
    try {
      if (store.isTombstoned(request.sessionId))
        throw new Error(`Session ${request.sessionId} was deleted`);
      const persisted = store.acceptCommand({
        sessionId: request.sessionId,
        requestId: request.command.requestId,
        type: request.command.type,
        payload: request.command.payload,
        replaySafe: request.command.replaySafe,
      });
      if (persisted.status === "completed") {
        post({
          t: "begin_result",
          rpcId: request.rpcId,
          duplicate: true,
          result: persisted.result,
        });
        grantNext(request.sessionId);
        return;
      }
      if (
        (persisted.status === "failed" && (!persisted.retryable || !persisted.replaySafe)) ||
        persisted.status === "indeterminate"
      ) {
        post({
          t: "begin_result",
          rpcId: request.rpcId,
          duplicate: true,
          result: {
            __sessionKernelFailure: true,
            message: persisted.error || "Session command outcome is indeterminate",
          },
        });
        grantNext(request.sessionId);
        return;
      }
      const lease: Lease = {
        leaseId: crypto.randomUUID(),
        sessionId: request.sessionId,
        requestId: request.command.requestId,
        type: request.command.type,
      };
      active.set(request.sessionId, lease);
      store.markProcessing(request.sessionId, request.command.requestId);
      post({
        t: "begin_result",
        rpcId: request.rpcId,
        duplicate: false,
        leaseId: lease.leaseId,
      });
    } catch (error) {
      post({
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
      });
      grantNext(request.sessionId);
    }
  }

  function grantNext(sessionId: string): void {
    if (active.has(sessionId)) return;
    const queue = queues.get(sessionId);
    const next = queue?.shift();
    if (next) queuedTotal -= 1;
    if (!queue?.length) queues.delete(sessionId);
    if (next) grant(next);
  }

  function begin(
    request: Extract<KernelActorAsyncRequest, { t: "begin" }>,
  ): void {
    if (active.has(request.sessionId)) {
      const queue = queues.get(request.sessionId) ?? [];
      if (
        queue.some((queued) =>
          queued.command.requestId === request.command.requestId
        )
      ) {
        post({
          t: "error",
          rpcId: request.rpcId,
          error: "Session command is already queued",
          retryable: true,
        });
        return;
      }
      if (
        queue.length >= SESSION_KERNEL_MAX_QUEUED_PER_SESSION ||
        queuedTotal >= SESSION_KERNEL_MAX_QUEUED_TOTAL
      ) {
        post({
          t: "error",
          rpcId: request.rpcId,
          error: "Session kernel mailbox is full",
          retryable: true,
        });
        return;
      }
      queue.push(request);
      queuedTotal += 1;
      queues.set(request.sessionId, queue);
      return;
    }
    grant(request);
  }

  function leaseFor(leaseId: string): Lease {
    for (const lease of active.values())
      if (lease.leaseId === leaseId) return lease;
    throw new Error("Session kernel lease is no longer active");
  }

  function finish(
    request: Extract<KernelActorAsyncRequest, { t: "complete" | "fail" }>,
  ): void {
    try {
      const lease = leaseFor(request.leaseId);
      if (request.t === "complete") {
        if (!store.isTombstoned(lease.sessionId))
          store.completeCommandDecision({
            sessionId: lease.sessionId,
            requestId: lease.requestId,
            type: lease.type,
            result: request.result,
            effects: request.effects,
          });
        post({ t: "complete_result", rpcId: request.rpcId });
      } else {
        store.failCommand(
          lease.sessionId,
          lease.requestId,
          request.error,
          request.retryable,
        );
        post({ t: "fail_result", rpcId: request.rpcId });
      }
      active.delete(lease.sessionId);
      grantNext(lease.sessionId);
    } catch (error) {
      post({
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Settlement persistence is ownership-critical. A normal RPC error would
      // leave the lease live and let the gateway continue serving ambiguously.
      queueMicrotask(() => self.close());
    }
  }

  function beginSync(
    sessionId: string,
    command: { requestId: string; type: string; payload?: unknown; replaySafe?: boolean },
  ) {
    // Compatibility writes can arrive from detached run callbacks while a
    // durable command owns the session. They still execute in this Worker, so
    // borrow its physical writer instead of trying to open a second lease (the
    // synchronous caller cannot wait for the active gateway command without
    // deadlocking that command's settlement).
    if (active.has(sessionId)) return { duplicate: false, borrowed: true };
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
      (persisted.status === "failed" && (!persisted.retryable || !persisted.replaySafe)) ||
      persisted.status === "indeterminate"
    ) throw new Error(persisted.error || "Session command outcome is indeterminate");
    const lease: Lease = {
      leaseId: crypto.randomUUID(),
      sessionId,
      requestId: command.requestId,
      type: command.type,
    };
    active.set(sessionId, lease);
    store.markProcessing(sessionId, command.requestId);
    return { duplicate: false, leaseId: lease.leaseId };
  }

  function completeSync(
    leaseId: string,
    result: unknown,
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
  ) {
    const lease = leaseFor(leaseId);
    if (!store.isTombstoned(lease.sessionId))
      store.completeCommandDecision({
        sessionId: lease.sessionId,
        requestId: lease.requestId,
        type: lease.type,
        result,
        effects,
      });
    active.delete(lease.sessionId);
    grantNext(lease.sessionId);
  }

  function failSync(leaseId: string, error: string) {
    const lease = leaseFor(leaseId);
    store.failCommand(lease.sessionId, lease.requestId, error);
    active.delete(lease.sessionId);
    grantNext(lease.sessionId);
  }

  function syncStore(request: KernelActorSyncRequest): void {
    const control = new Int32Array(request.control);
    const output = new Uint8Array(request.output);
    try {
      let result: unknown;
      if (request.method === "$beginSync")
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
      if (bytes.length > output.length)
        throw new Error("Kernel actor response exceeded buffer");
      output.set(bytes);
      Atomics.store(control, 1, bytes.length);
      Atomics.store(control, 0, 1);
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
    if (request.t === "store") {
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
        timers: store.dueTimers(
          request.now,
          request.limit,
          request.timerKinds,
        ),
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
