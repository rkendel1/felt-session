import type { AskActorRequest } from "./ask-protocol";
import type { DeliveryActorRequest } from "./delivery-protocol";
import { FeltDbAskStore } from "./feltdb-ask-store";
import { FeltDbCommandStore } from "./feltdb-command-store";
import { FeltDbDeliveryStore } from "./feltdb-delivery-store";
import type { GatewayCommandRequest } from "./gateway-command-protocol";
import { DESTINATION_IDEMPOTENT_GATEWAY_OPERATIONS } from "./gateway-command-protocol";
import type { TimerActorRequest } from "./timer-protocol";
import type { TurnActorRequest } from "./turn-protocol";
import { FeltDbTimerExecutionStore, FeltDbTimerStore } from "./feltdb-timer-store";
import { FeltDbTurnStore } from "./feltdb-turn-store";
import { FeltDbRunStore } from "./feltdb-run-store";

function mayRecover(record: { status: string; replaySafe: boolean; retryable?: boolean; error?: string }) {
  return record.status === "processing" ||
    (record.status === "indeterminate" && record.error === "actor restarted after execution began") ||
    (record.status === "failed" && record.replaySafe && record.retryable === true &&
      ["actor restarted before acknowledgement", "actor restarted before execution admission"]
        .includes(record.error ?? ""));
}

/** Managed reducer adapters that preserve the actor wire contract. */
export class FeltDbReducerStore {
  constructor(
    private readonly asks: FeltDbAskStore,
    private readonly delivery: FeltDbDeliveryStore,
    private readonly commands: FeltDbCommandStore,
    private readonly timers: FeltDbTimerStore,
    private readonly timerExecutions: FeltDbTimerExecutionStore,
    private readonly turns: FeltDbTurnStore,
    private readonly runs: FeltDbRunStore,
  ) {}

  async ask(commandId: string, request: Exclude<AskActorRequest, { op: "entries" | "clear" }>) {
    if (request.op === "snapshot") return this.asks.snapshot(request.sessionId);
    if (request.op === "set") return this.asks.set(commandId, request.sessionId, request.value);
    if (request.op === "answer")
      return this.asks.answer(
        commandId,
        request.sessionId,
        request.questionId,
        request.answers,
        request.answeredVia,
      );
    return this.asks.delete(commandId, request.sessionId);
  }

  private async requestCommand(
    commandId: string,
    input: { sessionId: string; requestId: string; type: string; payload?: unknown },
  ) {
    const record = await this.commands.accept(commandId, { ...input, replaySafe: true });
    if (record.status === "completed")
      return { status: "completed" as const, result: record.result, duplicate: true as const };
    if (record.status === "processing") return { status: "in_progress" as const };
    if (
      record.status === "indeterminate" ||
      (record.status === "failed" && (!record.retryable || !record.replaySafe))
    ) throw new Error(record.error || `${input.type} command failed`);
    await this.commands.markProcessing(`${commandId}:processing`, input.sessionId, input.requestId);
    return { status: "execute" as const };
  }

  private async completeCommand(
    commandId: string,
    input: { sessionId: string; requestId: string; type: string; result: unknown },
  ) {
    const record = await this.commands.command(input.sessionId, input.requestId);
    if (!record || record.type !== input.type) throw new Error(`${input.type} command receipt is missing`);
    if (record.status === "completed") return record.result;
    if (!mayRecover(record)) throw new Error(record.error || `${input.type} command failed`);
    await this.commands.complete(commandId, input.sessionId, input.requestId, input.result);
    return input.result;
  }

  private async failCommand(
    commandId: string,
    input: { sessionId: string; requestId: string; type: string; error: string },
  ) {
    const record = await this.commands.command(input.sessionId, input.requestId);
    if (!record || record.type !== input.type) throw new Error(`${input.type} command receipt is missing`);
    if (record.status === "completed") return;
    await this.commands.fail(commandId, input.sessionId, input.requestId, input.error, false);
  }

  async deliveryRequest(commandId: string, request: DeliveryActorRequest): Promise<unknown> {
    if (request.op === "snapshot") return this.delivery.snapshot(request.sessionId);
    if (request.op === "request_submit_command")
      return this.requestCommand(commandId, {
        sessionId: request.sessionId,
        requestId: request.requestId,
        type: "submit_prompt",
        payload: request.identity,
      });
    if (request.op === "complete_submit_command")
      return this.completeCommand(commandId, { ...request, type: "submit_prompt" });
    if (request.op === "fail_submit_command")
      return this.failCommand(commandId, { ...request, type: "submit_prompt" });
    if (request.op === "set")
      return this.delivery.setSlot(commandId, request.sessionId, request.slot, request.value);
    if (request.op === "enqueue")
      return this.delivery.enqueue(commandId, request.sessionId, request.item, request.front);
    if (request.op === "promote_queued")
      return this.delivery.promoteQueued(
        commandId, request.sessionId, request.itemId, request.promptEntryId, request.item,
      );
    if (request.op === "delete")
      return this.delivery.deleteSlot(commandId, request.sessionId, request.slot);
    if (request.op === "prepare_steer")
      return this.delivery.prepareSteer(
        commandId, request.sessionId, request.itemId, request.target, request.item,
      );
    if (request.op === "accept_steer" || request.op === "reject_steer")
      return this.delivery.settleSteer(
        commandId,
        request.sessionId,
        request.itemId,
        request.target,
        request.op === "accept_steer",
      );
    if (request.op === "requeue_steers")
      return this.delivery.requeueSteers(commandId, request.sessionId, request.items);
    if (request.op === "prepare_interrupt")
      return this.delivery.prepareInterrupt(commandId, request);
    if (request.op === "begin_interrupt_effect")
      return this.delivery.beginInterruptEffect(commandId, request);
    if (request.op === "settle_interrupt")
      return this.delivery.settleInterrupt(commandId, request);
    if (request.op === "claim_next_dispatch")
      return this.delivery.claimNextDispatch(commandId, request);
    if (request.op === "claim_dispatch")
      return this.delivery.claimDispatch(commandId, request);
    if (request.op === "ack_dispatch" || request.op === "fail_dispatch")
      return this.delivery.settleDispatch(
        commandId,
        request.sessionId,
        request.promptEntryId,
        request.op === "ack_dispatch",
      );
    throw new Error(`Global delivery operation ${request.op} requires a managed projection`);
  }

  async gateway(commandId: string, request: GatewayCommandRequest): Promise<unknown> {
    if (request.op === "request") {
      const record = await this.commands.accept(commandId, {
        sessionId: request.sessionId,
        requestId: request.requestId,
        type: request.operation,
        payload: request.identity,
        replaySafe: DESTINATION_IDEMPOTENT_GATEWAY_OPERATIONS.has(request.operation),
      });
      if (record.status === "completed")
        return { status: "completed", result: record.result, duplicate: true };
      if (record.status === "processing") return { status: "in_progress" };
      if (record.status === "indeterminate" ||
          (record.status === "failed" && (!record.retryable || !record.replaySafe)))
        throw new Error(record.error || "Gateway command failed");
      await this.commands.markProcessing(`${commandId}:processing`, request.sessionId, request.requestId);
      return { status: "execute" };
    }
    const record = await this.commands.command(request.sessionId, request.requestId);
    if (!record || record.type !== request.operation)
      throw new Error("Gateway command receipt is missing");
    if (record.status === "completed") return request.op === "complete" ? record.result : undefined;
    if (!mayRecover(record)) throw new Error(record.error || "Gateway command is not executing");
    if (request.op === "complete") {
      await this.commands.complete(commandId, request.sessionId, request.requestId, request.result);
      return request.result;
    }
    await this.commands.fail(
      commandId,
      request.sessionId,
      request.requestId,
      request.error,
      request.retryable,
    );
  }

  async timer(commandId: string, request: TimerActorRequest): Promise<unknown> {
    if (request.op === "schedule")
      return this.timers.schedule(commandId, request);
    if (request.op === "cancel")
      return this.timers.cancel(commandId, request.sessionId, request.timerId);
    if (request.op === "begin") return this.timerExecutions.begin(commandId, request);
    if (request.op === "complete") return this.timerExecutions.complete(commandId, request);
    if (request.op === "fail") return this.timerExecutions.fail(commandId, request);
    const current = await this.timers.timer(request.sessionId, request.timerId);
    if (!current || current.token !== request.token)
      return { updated: false, deadLetteredNow: false };
    if (current.attempts !== request.observedAttempts)
      return { updated: false, deadLetteredNow: current.deadLetteredAt !== undefined };
    return this.timers.fail(
      commandId,
      request.sessionId,
      request.timerId,
      request.token,
      request.error,
      request.maxAttempts,
    );
  }

  async turn(commandId: string, request: TurnActorRequest): Promise<unknown> {
    if (request.op === "snapshot") return this.turns.snapshot(request.sessionId);
    if (request.op === "prepare_cancel") return this.turns.prepareCancel(commandId, request);
    if (request.op === "begin_cancel_effect")
      return this.turns.beginCancelEffect(commandId, request);
    if (request.op === "settle_cancel") return this.turns.settleCancel(commandId, request);
    if (request.op === "prepare_outcome_projection")
      return this.turns.prepareOutcomeProjection(commandId, request);
    if (request.op === "begin_outcome_projection")
      return this.turns.beginOutcomeProjection(commandId, request);
    if (request.op === "settle_outcome_projection")
      return this.turns.settleOutcomeProjection(commandId, request);
    if (request.op === "request_cancel_command") {
      const existing = await this.commands.command(request.sessionId, request.requestId);
      if (existing) {
        if (existing.type !== "cancel_session")
          throw new Error(`Session command id ${request.requestId} was reused with another operation`);
        if (existing.status === "completed")
          return { status: "completed", result: existing.result === true, duplicate: true };
        if (existing.status === "indeterminate" ||
            (existing.status === "failed" && (!existing.retryable || !existing.replaySafe)))
          throw new Error(existing.error || "Session cancel command failed");
        const payload = existing.payload as {
          targetRunId?: unknown; targetRunGeneration?: unknown;
        } | null;
        if (payload?.targetRunId === null && Number.isSafeInteger(payload.targetRunGeneration)) {
          await this.commands.complete(`${commandId}:empty`, request.sessionId, request.requestId, false);
          return { status: "completed", result: false, duplicate: true };
        }
        if (typeof payload?.targetRunId !== "string" ||
            !Number.isSafeInteger(payload.targetRunGeneration))
          throw new Error("Durable cancel command target is invalid");
        await this.commands.markProcessing(`${commandId}:processing`, request.sessionId, request.requestId);
        return {
          status: "execute",
          targetRunId: payload.targetRunId,
          targetRunGeneration: Number(payload.targetRunGeneration),
        };
      }
      const [turn, run] = await Promise.all([
        this.turns.snapshot(request.sessionId),
        this.runs.runState(request.sessionId),
      ]);
      if (!run) throw new Error(`Session ${request.sessionId} has no FeltDB authority`);
      const cancelId = `stop:${request.requestId}`;
      const replayed = turn.cancel?.cancelId === cancelId ? turn.cancel : undefined;
      const targetRunId = replayed?.runId || run.currentRunId ||
        (["starting", "preparing"].includes(run.state) ? request.fallbackRunId : null);
      const targetRunGeneration = replayed?.runGeneration ?? run.generation;
      await this.commands.accept(`${commandId}:admit`, {
        sessionId: request.sessionId,
        requestId: request.requestId,
        type: "cancel_session",
        payload: { targetRunId, targetRunGeneration },
        replaySafe: true,
      });
      if (!targetRunId) {
        await this.commands.complete(`${commandId}:empty`, request.sessionId, request.requestId, false);
        return { status: "completed", result: false, duplicate: false };
      }
      await this.commands.markProcessing(`${commandId}:processing`, request.sessionId, request.requestId);
      return { status: "execute", targetRunId, targetRunGeneration };
    }
    const record = await this.commands.command(request.sessionId, request.requestId);
    if (!record || record.type !== "cancel_session")
      throw new Error("Cancel command receipt is missing");
    if (record.status === "completed")
      return request.op === "complete_cancel_command" ? record.result === true : undefined;
    if (request.op === "fail_cancel_command")
      return this.commands.fail(commandId, request.sessionId, request.requestId, request.error, false);
    if (record.status === "indeterminate" || record.status === "failed")
      throw new Error(record.error || "Session cancel command failed");
    if (request.result) {
      const cancel = (await this.turns.snapshot(request.sessionId)).cancel;
      const payload = record.payload as {
        targetRunId?: unknown; targetRunGeneration?: unknown;
      } | null;
      if (cancel?.cancelId !== `stop:${request.requestId}` ||
          cancel.runId !== payload?.targetRunId ||
          cancel.runGeneration !== payload?.targetRunGeneration)
        throw new Error("Cancel command completed without its durable receipt");
    }
    await this.commands.complete(commandId, request.sessionId, request.requestId, request.result);
    return request.result;
  }
}
