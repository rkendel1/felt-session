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
  type KernelActorClientCallRequest,
  type KernelActorServiceCall,
  type KernelActorResponse,
} from "./actor-protocol";
import { isDeliveryReadRequest } from "./delivery-protocol";
import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import { isReadReducer, sessionActorReducerRoute } from "./actor-routing";
import { READ_METHODS, sessionKernelStoreRoute } from "./store-routing";
import { assertTranscriptActorRequest } from "./transcript-protocol";
import { ConditionalConflictError } from "@feltdb/core";
import { createHash } from "node:crypto";
import {
  openFeltDbKernelChangeStore,
  type FeltDbKernelChangeStore,
} from "./feltdb-change-store";
import {
  openFeltDbSessionDecisionStore,
  type FeltDbSessionDecisionStore,
} from "./feltdb-decision-store";
import { FeltDbTranscriptStore } from "./feltdb-transcript-store";
import { FeltDbAgentHostStore } from "./feltdb-agent-host-store";
import { FeltDbRunStore } from "./feltdb-run-store";
import { FeltDbCreationStore } from "./feltdb-creation-store";
import { FeltDbAskStore } from "./feltdb-ask-store";
import { FeltDbCommandStore } from "./feltdb-command-store";
import { FeltDbDeliveryStore } from "./feltdb-delivery-store";
import { FeltDbReducerStore } from "./feltdb-reducer-store";
import { FeltDbTimerExecutionStore, FeltDbTimerStore } from "./feltdb-timer-store";
import { FeltDbTurnStore } from "./feltdb-turn-store";
import { FeltDbOutboxStore } from "./feltdb-outbox-store";

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

function reducerMutatesSparseProjection(
  command: SessionActorReducerCommand,
): boolean {
  if (command.kind === "ask") return !isReadReducer(command);
  if (command.kind === "delivery") return !isDeliveryReadRequest(command.request);
  return command.kind === "core" &&
    (command.request.op === "clear" || command.request.op === "tombstone");
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
  let feltDbChanges: FeltDbKernelChangeStore | undefined;
  let feltDbDecisions: FeltDbSessionDecisionStore | undefined;
  let feltDbTranscripts: FeltDbTranscriptStore | undefined;
  let feltDbAgentHost: FeltDbAgentHostStore | undefined;
  let feltDbRuns: FeltDbRunStore | undefined;
  let feltDbCreation: FeltDbCreationStore | undefined;
  let feltDbAsks: FeltDbAskStore | undefined;
  let feltDbDeliveries: FeltDbDeliveryStore | undefined;
  let feltDbTurns: FeltDbTurnStore | undefined;
  let feltDbReducers: FeltDbReducerStore | undefined;
  let feltDbTimers: FeltDbTimerStore | undefined;
  let feltDbOutbox: FeltDbOutboxStore | undefined;
  const changeStore = (): FeltDbKernelChangeStore =>
    (feltDbChanges ??= openFeltDbKernelChangeStore());
  const decisionStore = (): FeltDbSessionDecisionStore =>
    (feltDbDecisions ??= openFeltDbSessionDecisionStore());
  const transcriptStore = (): FeltDbTranscriptStore =>
    (feltDbTranscripts ??= new FeltDbTranscriptStore(decisionStore()));
  const agentHostStore = (): FeltDbAgentHostStore =>
    (feltDbAgentHost ??= new FeltDbAgentHostStore(decisionStore()));
  const runStore = (): FeltDbRunStore =>
    (feltDbRuns ??= new FeltDbRunStore(decisionStore()));
  const creationStore = (): FeltDbCreationStore =>
    (feltDbCreation ??= new FeltDbCreationStore(decisionStore()));
  const askStore = (): FeltDbAskStore =>
    (feltDbAsks ??= new FeltDbAskStore(decisionStore()));
  const deliveryStore = (): FeltDbDeliveryStore =>
    (feltDbDeliveries ??= new FeltDbDeliveryStore(decisionStore()));
  const turnStore = (): FeltDbTurnStore =>
    (feltDbTurns ??= new FeltDbTurnStore(decisionStore()));
  const reducerStore = (): FeltDbReducerStore =>
    (feltDbReducers ??= (() => {
      const commands = new FeltDbCommandStore(decisionStore());
      const timers = timerStore();
      return new FeltDbReducerStore(
        askStore(),
        deliveryStore(),
        commands,
        timers,
        new FeltDbTimerExecutionStore(timers, commands),
        turnStore(),
        runStore(),
        outboxStore(),
        decisionStore(),
      );
    })());
  const timerStore = (): FeltDbTimerStore =>
    (feltDbTimers ??= new FeltDbTimerStore(decisionStore()));
  const outboxStore = (): FeltDbOutboxStore =>
    (feltDbOutbox ??= new FeltDbOutboxStore(decisionStore()));
  const ensureManagedHead = async (sessionId: string, create: boolean) => {
    const existing = await decisionStore().head(sessionId);
    if (existing || !create) return existing;
    const migrationId = `opensession-kernel-native-v1:${sessionId}`;
    try {
      return await decisionStore().activateSession({
        sessionId,
        migrationId,
        owner: "opensession-session-kernel",
        leaseId: "native-session-v1",
        leaseDurationMs: 10 * 365 * 24 * 60 * 60_000,
      });
    } catch (error) {
      if (!(error instanceof ConditionalConflictError)) throw error;
      const raced = await decisionStore().head(sessionId);
      if (!raced || raced.migrationId !== migrationId) throw error;
      return raced;
    }
  };
  function post(message: KernelActorResponse): void {
    // Internal worker telemetry is consumed by the parent service and stripped
    // before the actor response crosses the HTTP boundary.
    self.postMessage({ ...message, workerMetrics: host.metrics() });
  }

  async function executeCall(
    request: KernelActorServiceCall["request"],
    outputBytes: number,
  ): Promise<{ status: -1 | 1 | 2; length: number; body: string }> {
    let store = host.central;
    let requestSessionId: string | undefined;
    try {
      let result: unknown;
      if (request.t === "reduce") {
        const command = request.command;
        const sessionId = reducerSessionId(command, host);
        requestSessionId = sessionId;
        if (command.kind === "transcript")
          assertTranscriptActorRequest(command.request);
        const managedKind = command.kind === "transcript" ||
          command.kind === "run_event" || command.kind === "creation_event" ||
          (["ask", "delivery", "gateway", "timer", "turn"].includes(command.kind) &&
            !!sessionId) || command.kind === "core";
        const managedHead = managedKind && sessionId
          ? await ensureManagedHead(sessionId, !isReadReducer(command))
          : undefined;
        if (managedKind && sessionId && !managedHead)
          throw new Error(`Managed FeltDB session ${sessionId} has not been activated`);
        if (!managedHead && !isReadReducer(command) && sessionId) {
          const quarantine = host.quarantinedSession(sessionId);
          if (quarantine) throw new SessionQuarantinedError(sessionId, quarantine.reason);
        }
        if (!managedHead && sessionId)
          store = host.storeForSession(
            sessionId,
            command.kind === "transcript" ? false : !isReadReducer(command),
            reducerMutatesSparseProjection(command),
          );
        if (
          command.kind === "transcript" &&
          !managedHead &&
          !isReadReducer(command) &&
          command.request.op !== "delete" &&
          store.isTombstoned(command.request.sessionId)
        ) throw new Error(`Session ${command.request.sessionId} is tombstoned`);
        else if (command.kind === "transcript") {
          const transcript = command.request;
          if (!managedHead) result = host.transcript(transcript);
          else if (transcript.op === "agent_append_destination") {
            await agentHostStore().assertTranscriptDestinationFence(transcript);
            result = transcriptStore().appendAgentDestination(transcript);
          } else if (transcript.op === "agent_query_destination_receipt")
            result = transcriptStore().queryAgentReceipt(transcript);
          else if (transcript.op === "agent_validate_destination_receipt")
            result = transcriptStore().validateAgentReceipt(transcript);
          else {
            if (transcript.op === "append_destination")
              await agentHostStore().assertTranscriptDestinationFence(transcript);
            result = transcriptStore().applyRequest(transcript);
          }
        }
        else if (command.kind === "creation_event")
          result = managedHead
            ? creationStore().applyCreationEvent(command.commandId, command.decision)
            : store.applyCreationEvent(command.decision);
        else if (command.kind === "run_event")
          result = managedHead
            ? runStore().applyRunEvent(command.commandId, command.decision)
            : store.applyRunEvent(command.decision);
        else if (command.kind === "delivery") {
          const delivery = command.request;
          if (managedHead)
            result = await reducerStore().deliveryRequest(command.commandId, delivery);
          else if (delivery.op === "snapshot")
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
          else if (delivery.op === "enqueue")
            result = store.enqueueDelivery(
              delivery.sessionId,
              delivery.item,
              delivery.front,
            );
          else if (delivery.op === "promote_queued")
            result = store.promoteQueuedDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.promptEntryId,
              delivery.item,
            );
          else if (delivery.op === "delete")
            result = store.deleteDeliverySlot(delivery.sessionId, delivery.slot);
          else if (delivery.op === "clear_slot")
            result = host.call("clearDeliverySlot", [delivery.slot]);
          else if (delivery.op === "prepare_steer")
            result = store.prepareSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.target,
              delivery.item,
            );
          else if (delivery.op === "accept_steer")
            result = store.acceptSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.target,
            );
          else if (delivery.op === "reject_steer")
            result = store.rejectSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.target,
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
          if (!managedHead && !isDeliveryReadRequest(delivery) && "sessionId" in delivery)
            host.refreshSessionProjections(delivery.sessionId);
          if (!isDeliveryReadRequest(delivery))
            result = {
              result,
              ...("sessionId" in delivery
                ? { revision: managedHead
                    ? (await new FeltDbDeliveryStore(decisionStore())
                        .snapshot(delivery.sessionId)).revision
                    : store.deliverySnapshot(delivery.sessionId).revision }
                : {}),
            };
        } else if (command.kind === "gateway") {
          const gateway = command.request;
          if (managedHead) result = reducerStore().gateway(command.commandId, gateway);
          else if (gateway.op === "request")
            result = store.requestGatewayCommand(gateway);
          else if (gateway.op === "complete")
            result = store.completeGatewayCommand(gateway);
          else result = store.failGatewayCommand(gateway);
        } else if (command.kind === "core") {
          const core = command.request;
          if (managedHead) result = reducerStore().core(command.commandId, core);
          else if (core.op === "enqueue_effect")
            result = store.enqueueOutbox(
              core.sessionId,
              core.kind,
              core.payload,
              core.effectKey,
            );
          else if (core.op === "ack_outbox") {
            const owner =
              store.outboxSessionId(core.id) ?? host.outboxSessionId(core.id);
            // Settlements are idempotent. A timed-out acknowledgement may have
            // committed even though the caller did not receive its response;
            // in that case the effect is already absent and replay is a no-op.
            // Existing effects still retain the cross-session ownership fence.
            if (owner !== undefined && owner !== core.sessionId)
              throw new Error(`Outbox ${core.id} crossed session ownership`);
            result = store.ackOutbox(core.id);
          } else if (core.op === "defer_outbox") {
            const owner =
              store.outboxSessionId(core.id) ?? host.outboxSessionId(core.id);
            if (owner !== undefined && owner !== core.sessionId)
              throw new Error(`Outbox ${core.id} crossed session ownership`);
            result = store.deferOutbox(core.id);
          } else if (core.op === "fail_outbox") {
            const owner =
              store.outboxSessionId(core.id) ?? host.outboxSessionId(core.id);
            if (owner !== undefined && owner !== core.sessionId)
              throw new Error(`Outbox ${core.id} crossed session ownership`);
            result = store.noteOutboxFailure(
              core.id,
              core.error,
              core.maxAttempts,
            );
          } else if (core.op === "clear")
            result = store.clearSession(core.sessionId);
          else result = store.tombstoneSession(core.sessionId);
          if (!managedHead && (core.op === "clear" || core.op === "tombstone"))
            host.refreshSessionProjections(core.sessionId);
        } else if (command.kind === "turn") {
          const turn = command.request;
          if (managedHead) result = reducerStore().turn(command.commandId, turn);
          else if (turn.op === "snapshot") result = store.turnSnapshot(turn.sessionId);
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
          if (managedHead) result = reducerStore().timer(command.commandId, timer);
          else if (timer.op === "schedule") result = store.scheduleTimer(timer);
          else if (timer.op === "cancel")
            result = store.cancelTimer(timer.sessionId, timer.timerId);
          else if (timer.op === "begin") result = store.beginTimerExecution(timer);
          else if (timer.op === "complete")
            result = store.completeTimerExecution(timer);
          else if (timer.op === "fail") result = store.failTimerExecution(timer);
          else result = store.recordTimerRuntimeFailure(timer);
        } else {
          const ask = command.request;
          if (managedHead && ask.op !== "entries" && ask.op !== "clear")
            result = reducerStore().ask(command.commandId, ask);
          else if (ask.op === "snapshot") result = store.askSnapshot(ask.sessionId);
          else if (ask.op === "entries") result = host.allAskEntries();
          else if (ask.op === "set")
            result = host.call("setAskRecord", [ask.sessionId, ask.value]);
          else if (ask.op === "answer")
            result = host.call("answerAskRecord", [
              ask.sessionId,
              ask.questionId,
              ask.answers,
              ask.answeredVia,
            ]);
          else if (ask.op === "delete")
            result = host.call("deleteAskRecord", [ask.sessionId]);
          else result = host.call("clearAskRecords", []);
        }
      } else {
        const route = routedStoreCall(request.method, request.args, host);
        const { sessionId } = route;
        requestSessionId = sessionId;
        const managedHead = sessionId
          ? await ensureManagedHead(
              sessionId,
              route.mutation,
            )
          : undefined;
        if (sessionId && !managedHead)
          throw new Error(`Managed FeltDB session ${sessionId} has not been activated`);
        if (
          !managedHead &&
          route.mutation &&
          sessionId &&
          request.method !== "quarantineSession" &&
          request.method !== "releaseQuarantine"
        ) {
          const quarantine = host.quarantinedSession(sessionId);
          if (quarantine)
            throw new SessionQuarantinedError(sessionId, quarantine.reason);
        }
        if (managedHead && request.method === "command")
          result = new FeltDbCommandStore(decisionStore()).command(
            sessionId!, String(request.args[1]),
          );
        else if (managedHead && request.method === "creationState")
          result = creationStore().creationState(sessionId!);
        else if (managedHead && request.method === "runState")
          result = runStore().runState(sessionId!);
        else if (managedHead && request.method === "askSnapshot")
          result = askStore().snapshot(sessionId!);
        else if (managedHead && request.method === "deliverySnapshot")
          result = deliveryStore().snapshot(sessionId!);
        else if (managedHead && request.method === "turnSnapshot")
          result = turnStore().snapshot(sessionId!);
        else if (managedHead && request.method === "changesSince")
          result = decisionStore().changesSince(
            sessionId!,
            managedHead.decisionEpoch,
            Number(request.args[1]),
            request.args[2] === undefined ? undefined : Number(request.args[2]),
          ).then((changes) => changes.map(({ changeSeq, kind, payload, createdAt }) => ({
            changeSeq, kind, payload, createdAt,
          })));
        else if (managedHead && request.method === "isTombstoned")
          result = managedHead.authority.lifecycle === "tombstoned";
        else if (managedHead && request.method === "timer")
          result = timerStore().timer(sessionId!, String(request.args[1]));
        else if (managedHead && request.method === "acknowledgeCommand")
          result = new FeltDbCommandStore(decisionStore()).acknowledge(
            request.transactionId ?? `ack:${sessionId}:${String(request.args[1])}`,
            sessionId!,
            String(request.args[1]),
          );
        else if (managedHead && request.method === "appendChange") {
          if (!request.transactionId?.trim())
            throw new Error("FeltDB appendChange requires a logical transaction id");
          const kind = String(request.args[1] ?? "");
          result = decisionStore().commitDecision({
            transactionId: request.transactionId,
            operationId: request.transactionId,
            operationKind: "append_change",
            inputHash: createHash("sha256")
              .update(JSON.stringify(request.args)).digest("hex"),
            observedHead: managedHead,
            changeKind: kind,
            changePayload: request.args[2],
            result: managedHead.changeSeq + 1,
          });
        } else if (request.method === "appendChange") {
          const sessionId = request.args[0];
          const kind = request.args[1];
          if (!request.transactionId?.trim())
            throw new Error("FeltDB appendChange requires a logical transaction id");
          if (typeof sessionId !== "string" || !sessionId)
            throw new Error("FeltDB appendChange requires a session id");
          if (typeof kind !== "string" || !kind)
            throw new Error("FeltDB appendChange requires a change kind");
          result = changeStore().appendChange(
            request.transactionId,
            sessionId,
            kind,
            request.args[2],
          );
        } else if (request.method === "changesSince") {
          result = changeStore().changesSince(
            request.args[0] as string,
            Number(request.args[1]),
            request.args[2] === undefined ? undefined : Number(request.args[2]),
          );
        } else if (managedHead) {
          throw new Error(
            `Managed FeltDB session ${sessionId} does not implement compatibility store method ${request.method}`,
          );
        } else result = host.call(request.method, request.args);
      }
      // Store methods remain synchronous until their domain moves to FeltDB,
      // while migrated methods return promises. Awaiting both shapes here is
      // the conversion seam: the parent mailbox does not start the next turn
      // until this worker posts the committed result.
      result = await result;
      const body = JSON.stringify({ ok: true, result });
      const length = Buffer.byteLength(body);
      return { status: length > outputBytes ? 2 : 1, length, body };
    } catch (error) {
      host.recordSqliteBusy(error);
      let failStop = false;
      let responseCode:
        | "actor_fatal"
        | "conditional_conflict"
        | "session_quarantined"
        | "retryable"
        | undefined;
      let responseSessionId: string | undefined;
      const sessionId = requestSessionId;
      const infrastructure = isSessionKernelInfrastructureFailure(error);
      const critical = request.t === "reduce" &&
        isCriticalSettlementCommand(request.command);
      if (error instanceof ConditionalConflictError) {
        responseCode = "conditional_conflict";
      } else if (infrastructure || critical) {
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
      } else if (
        error &&
        typeof error === "object" &&
        "retryable" in error &&
        error.retryable === true
      ) {
        responseCode = "retryable";
      }
      const body = JSON.stringify({
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 8_000),
        ...(responseCode ? { code: responseCode } : {}),
        ...(responseSessionId ? { sessionId: responseSessionId } : {}),
        ...(error instanceof ConditionalConflictError && error.failure
          ? { failure: error.failure }
          : {}),
      });
      if (failStop) queueMicrotask(() => self.close());
      return { status: -1, length: Buffer.byteLength(body), body };
    }
  }

  async function asyncCall(request: KernelActorClientCallRequest): Promise<void> {
    const retryableRead = request.t === "reduce"
      ? isReadReducer(request.command)
      : READ_METHODS.has(request.method);
    let outputBytes = 256 * 1024;
    for (;;) {
      const result = await executeCall(request, outputBytes);
      if (
        result.status === 2 && retryableRead &&
        result.length > outputBytes &&
        result.length <= SESSION_KERNEL_MAX_RESPONSE_BYTES
      ) {
        outputBytes = result.length;
        continue;
      }
      post({
        t: "call_result",
        rpcId: request.rpcId,
        status: result.status === 2 && !retryableRead ? 1 : result.status,
        length: result.length,
        ...(result.status === 2 && retryableRead ? {} : { body: result.body }),
      });
      return;
    }
  }

  async function serviceCall(request: KernelActorServiceCall): Promise<void> {
    const outputBytes = Math.floor(request.outputBytes);
    if (outputBytes <= 0 || outputBytes > SESSION_KERNEL_MAX_RESPONSE_BYTES) {
      post({ t: "error", rpcId: request.rpcId, error: "Invalid kernel actor response bound" });
      return;
    }
    const retryableRead = request.request.t === "reduce"
      ? isReadReducer(request.request.command)
      : READ_METHODS.has(request.request.method);
    const result = await executeCall(request.request, outputBytes);
    post({
      t: "call_result",
      rpcId: request.rpcId,
      status: result.status === 2 && !retryableRead ? 1 : result.status,
      length: result.length,
      ...(result.status === 2 && retryableRead ? {} : { body: result.body }),
    });
  }

  async function managedRuntimeWork(request: Extract<KernelActorAsyncRequest, { t: "runtime_work" }>) {
    const [timers, outbox] = await Promise.all([
      timerStore().due(request.now, request.limit * 2),
      outboxStore().due(request.now, request.limit * 2),
    ]);
    return {
      timers: timers.filter((timer) => request.timerKinds.includes(timer.kind)).slice(0, request.limit),
      outbox: outbox.filter((item) => request.effectKinds.includes(item.kind)).slice(0, request.limit),
    };
  }

  self.onmessage = (
    event: MessageEvent<KernelActorAsyncRequest | KernelActorClientCallRequest | KernelActorServiceCall>,
  ) => {
    const request = event.data;
    if (request.t === "call") {
      void serviceCall(request);
      return;
    }
    if (request.t === "store" || request.t === "reduce") {
      void asyncCall(request);
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
        // Deliberately NOT fenced by quarantine: acknowledging a command only
        // stamps acknowledged_at on an already-completed receipt (monotonic,
        // idempotent, touches no semantic session state), so it cannot deepen
        // whatever ambiguity caused the quarantine. Failing it closed turned
        // every quarantined session into an endless client ack-retry loop that
        // surfaced to users as `Internal error handling "command_ack"` on
        // every reconnect for as long as the quarantine stood.
          void decisionStore().head(request.sessionId).then(async (head) => {
            if (!head)
              throw new Error(`Managed FeltDB session ${request.sessionId} has not been activated`);
            await new FeltDbCommandStore(decisionStore()).acknowledge(
              `async-ack:${request.sessionId}:${request.requestId}`,
              request.sessionId,
              request.requestId,
            );
            post({ t: "acknowledge_result", rpcId: request.rpcId });
          }).catch((error) => post({
            t: "error",
            rpcId: request.rpcId,
            error: error instanceof Error ? error.message : String(error),
          }));
      } else if (request.t === "stats") {
        post({ t: "stats_result", rpcId: request.rpcId, stats: host.stats() });
      } else if (request.t === "maintain") {
        const pending = host.maintain();
        post({ t: "maintain_result", rpcId: request.rpcId, pending });
      } else if (request.t === "runtime_work") {
        void managedRuntimeWork(request).then((work) => post({
          t: "runtime_work_result",
          rpcId: request.rpcId,
          ...work,
        })).catch((error) => {
          post({
            t: "error",
            rpcId: request.rpcId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      host.recordSqliteBusy(error);
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
