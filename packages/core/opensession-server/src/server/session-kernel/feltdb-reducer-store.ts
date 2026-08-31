import type { AskActorRequest } from "./ask-protocol";
import type { DeliveryActorRequest } from "./delivery-protocol";
import { FeltDbAskStore } from "./feltdb-ask-store";
import { FeltDbCommandStore } from "./feltdb-command-store";
import { FeltDbDeliveryStore } from "./feltdb-delivery-store";

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
}
