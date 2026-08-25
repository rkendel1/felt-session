import {
  isSessionKernelCentralStoreFailure,
  isSessionKernelInfrastructureFailure,
  SessionKernelStoreHost,
} from "./store-host";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  isCriticalSettlementCommand,
  type KernelActorAsyncRequest,
  type KernelActorServiceCall,
  type KernelActorServiceResponse,
  type KernelActorSyncRequest,
} from "./actor-protocol";
import { isDeliveryReadRequest } from "./delivery-protocol";
import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import { isReadReducer, sessionActorReducerRoute } from "./actor-routing";
import { sessionKernelStoreRoute } from "./store-routing";

class SessionQuarantinedError extends Error {
  readonly code = "session_quarantined";

  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`Session ${sessionId} is quarantined: ${reason}`);
    this.name = "SessionQuarantinedError";
  }
}

function reducerSessionId(
  command: SessionActorReducerCommand,
  host: SessionKernelStoreHost,
): string | undefined {
  const route = sessionActorReducerRoute(command);
  if (route.scope === "session") return route.sessionId;
  if (route.scope === "outbox") return host.outboxSessionId(route.id);
  return undefined;
}

function routedStoreCall(
  method: string,
  args: unknown[],
  host: SessionKernelStoreHost,
): { sessionId?: string; mutation: boolean } {
  const route = sessionKernelStoreRoute(method, args);
  if (route.scope === "session")
    return { sessionId: route.sessionId, mutation: route.mutation };
  if (route.scope === "outbox")
    return { sessionId: host.outboxSessionId(route.id), mutation: route.mutation };
  return { mutation: false };
}

export function startSessionKernelActorWorker(): void {
  const host = new SessionKernelStoreHost();
  function post(message: KernelActorServiceResponse): void {
    self.postMessage(message);
  }

  function syncStore(request: KernelActorSyncRequest): void {
    const control = new Int32Array(request.control);
    const output = new Uint8Array(request.output);
    let store = host.central;
    let requestSessionId: string | undefined;
    try {
      let result: unknown;
      if (request.t === "reduce") {
        const command = request.command;
        const sessionId = reducerSessionId(command, host);
        requestSessionId = sessionId;
        if (!isReadReducer(command) && sessionId) {
          const quarantine = host.quarantinedSession(sessionId);
          if (quarantine) throw new SessionQuarantinedError(sessionId, quarantine.reason);
        }
        if (sessionId)
          store = host.storeForSession(sessionId, !isReadReducer(command));
        if (command.kind === "creation_event")
          result = store.applyCreationEvent(command.decision);
        else if (command.kind === "run_event")
          result = store.applyRunEvent(command.decision);
        else if (command.kind === "delivery") {
          const delivery = command.request;
          if (delivery.op === "snapshot")
            result = store.deliverySnapshot(delivery.sessionId);
          else if (delivery.op === "entries")
            result = host.allDeliveryEntries(delivery.slot);
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
            result = host.call("clearDeliverySlot", [delivery.slot]);
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
            result = host.call("settlePendingSteers", []);
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
        } else if (command.kind === "core") {
          const core = command.request;
          if (core.op === "enqueue_effect")
            result = store.enqueueOutbox(
              core.sessionId,
              core.kind,
              core.payload,
              core.effectKey,
            );
          else if (core.op === "ack_outbox")
            result = host.call("ackOutbox", [core.id]);
          else if (core.op === "defer_outbox")
            result = host.call("deferOutbox", [core.id]);
          else if (core.op === "fail_outbox")
            result = host.call("noteOutboxFailure", [
              core.id,
              core.error,
              core.maxAttempts,
            ]);
          else if (core.op === "clear") result = store.clearSession(core.sessionId);
          else result = store.tombstoneSession(core.sessionId);
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
          if (timer.op === "schedule") result = store.scheduleTimer(timer);
          else if (timer.op === "cancel")
            result = store.cancelTimer(timer.sessionId, timer.timerId);
          else if (timer.op === "begin") result = store.beginTimerExecution(timer);
          else if (timer.op === "complete")
            result = store.completeTimerExecution(timer);
          else if (timer.op === "fail") result = store.failTimerExecution(timer);
          else result = store.recordTimerRuntimeFailure(timer);
        } else {
          const ask = command.request;
          if (ask.op === "snapshot") result = store.askSnapshot(ask.sessionId);
          else if (ask.op === "entries") result = host.allAskEntries();
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
          else result = host.call("clearAskRecords", []);
        }
      } else {
        const route = routedStoreCall(request.method, request.args, host);
        const { sessionId } = route;
        requestSessionId = sessionId;
        if (
          route.mutation &&
          sessionId &&
          request.method !== "quarantineSession" &&
          request.method !== "releaseQuarantine"
        ) {
          const quarantine = host.quarantinedSession(sessionId);
          if (quarantine)
            throw new SessionQuarantinedError(sessionId, quarantine.reason);
        }
        result = host.call(request.method, request.args);
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
      let failStop = false;
      let responseCode: "actor_fatal" | "session_quarantined" | undefined;
      let responseSessionId: string | undefined;
      const sessionId = requestSessionId;
      const infrastructure = isSessionKernelInfrastructureFailure(error);
      const critical = request.t === "reduce" &&
        isCriticalSettlementCommand(request.command);
      if (infrastructure || critical) {
        if (
          !sessionId ||
          isSessionKernelCentralStoreFailure(error) ||
          (infrastructure && !host.isIsolated(sessionId))
        ) {
          failStop = true;
          responseCode = "actor_fatal";
        } else {
          try {
            const commandKind = request.t === "reduce"
              ? `${request.command.kind}:${"request" in request.command ? request.command.request.op : "event"}`
              : `store:${request.method}`;
            host.quarantineSession(
              sessionId,
              error instanceof Error ? error.message : String(error),
              commandKind,
              infrastructure,
            );
            responseCode = "session_quarantined";
            responseSessionId = sessionId;
          } catch {
            failStop = true;
            responseCode = "actor_fatal";
          }
        }
      } else if (error instanceof SessionQuarantinedError) {
        responseCode = error.code;
        responseSessionId = error.sessionId;
      }
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ok: false,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 8_000),
          ...(responseCode ? { code: responseCode } : {}),
          ...(responseSessionId ? { sessionId: responseSessionId } : {}),
        }),
      );
      output.set(bytes.subarray(0, output.length));
      Atomics.store(control, 1, Math.min(bytes.length, output.length));
      Atomics.store(control, 0, -1);
      if (failStop) queueMicrotask(() => self.close());
    }
    Atomics.notify(control, 0);
  }

  function serviceCall(request: KernelActorServiceCall): void {
    const outputBytes = Math.floor(request.outputBytes);
    if (outputBytes <= 0 || outputBytes > SESSION_KERNEL_MAX_RESPONSE_BYTES) {
      post({
        t: "error",
        rpcId: request.rpcId,
        error: "Invalid kernel actor response bound",
      });
      return;
    }
    const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const output = new SharedArrayBuffer(outputBytes);
    syncStore({ ...request.request, control, output } as KernelActorSyncRequest);
    const view = new Int32Array(control);
    const status = Atomics.load(view, 0) as -1 | 1 | 2;
    const length = Atomics.load(view, 1);
    post({
      t: "call_result",
      rpcId: request.rpcId,
      status,
      length,
      ...(status === 2
        ? {}
        : {
            body: new TextDecoder().decode(
              new Uint8Array(output, 0, Math.min(length, outputBytes)),
            ),
          }),
    });
  }

  self.onmessage = (
    event: MessageEvent<
      KernelActorAsyncRequest | KernelActorSyncRequest | KernelActorServiceCall
    >,
  ) => {
    const request = event.data;
    if (request.t === "call") {
      serviceCall(request);
      return;
    }
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
    try {
      if (request.t === "acknowledge") {
        const quarantine = host.quarantinedSession(request.sessionId);
        if (quarantine)
          throw new SessionQuarantinedError(request.sessionId, quarantine.reason);
        host.call("acknowledgeCommand", [request.sessionId, request.requestId]);
        post({ t: "acknowledge_result", rpcId: request.rpcId });
      } else if (request.t === "stats") {
        post({ t: "stats_result", rpcId: request.rpcId, stats: host.stats() });
      } else if (request.t === "maintain") {
        const pending = host.maintain();
        post({ t: "maintain_result", rpcId: request.rpcId, pending });
      } else if (request.t === "runtime_work") {
        post({
          t: "runtime_work_result",
          rpcId: request.rpcId,
          ...host.runtimeWork(
            request.now,
            request.timerKinds,
            request.effectKinds,
            request.limit,
          ),
        });
      }
    } catch (error) {
      const sessionId = request.t === "acknowledge" ? request.sessionId : undefined;
      const isolatedFailure =
        !!sessionId &&
        isSessionKernelInfrastructureFailure(error) &&
        host.isIsolated(sessionId);
      if (isolatedFailure) {
        try {
          host.quarantineSession(
            sessionId,
            error instanceof Error ? error.message : String(error),
            "command:acknowledge",
            true,
          );
        } catch {
          queueMicrotask(() => self.close());
        }
      } else if (!(error instanceof SessionQuarantinedError)) {
        queueMicrotask(() => self.close());
      }
      post({
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

if (import.meta.main) startSessionKernelActorWorker();
