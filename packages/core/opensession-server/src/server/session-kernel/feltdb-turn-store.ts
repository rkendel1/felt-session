import { createHash } from "node:crypto";
import type { DurableTurnState } from "./store";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";

type StoredTurn = DurableTurnState & {
  schemaVersion: 1;
  sessionId: string;
  __version: number;
};

type Cancel = NonNullable<DurableTurnState["cancel"]>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function turnId(sessionId: string): string {
  return kernelRecordId("turn", sessionId);
}

function state(record: StoredTurn | undefined): DurableTurnState {
  if (!record) return { revision: 0, updatedAt: 0 };
  const { schemaVersion: _, sessionId: __, __version: ___, ...value } = record;
  return value;
}

export function decideFeltDbTurnCancelBegin(
  head: VersionedSessionDecisionHead,
  prior: Cancel | undefined,
  input: { cancelId: string; runGeneration: number },
): {
  result: "execute" | "retry" | "adopt_confirmed" | "settled" | "missing";
  next?: Cancel;
} {
  if (!prior || prior.cancelId !== input.cancelId) return { result: "missing" };
  if (prior.phase === "settled") return { result: "settled" };
  if (prior.runGeneration !== input.runGeneration || head.run.generation !== input.runGeneration)
    return { result: "adopt_confirmed" };
  if (prior.phase === "executing") return { result: "retry" };
  return { result: "execute", next: { ...prior, phase: "executing" } };
}

/** Managed FeltDB turn cancellation phase state. */
export class FeltDbTurnStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  private record(sessionId: string): Promise<StoredTurn | undefined> {
    return this.decisions.record(KERNEL_COLLECTIONS.turns, turnId(sessionId));
  }

  async snapshot(sessionId: string): Promise<DurableTurnState> {
    return state(await this.record(sessionId));
  }

  private commitCancel<Result>(input: {
    commandId: string;
    operationKind: string;
    inputHash: string;
    head: VersionedSessionDecisionHead;
    prior: StoredTurn;
    cancel: Cancel;
    result: Result;
    now: number;
  }): Promise<Result> {
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:turn:${input.head.sessionId}:${input.operationKind}:${input.commandId}`,
      operationId: input.commandId,
      operationKind: input.operationKind,
      inputHash: input.inputHash,
      observedHead: input.head,
      changeKind: "turn_cancel_updated",
      changePayload: input.cancel,
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.turns,
        id: turnId(input.head.sessionId),
        value: {
          schemaVersion: 1,
          sessionId: input.head.sessionId,
          revision: input.prior.revision + 1,
          cancel: input.cancel,
          updatedAt: input.now,
        },
        ifVersion: input.prior.__version,
      }],
      result: input.result,
      now: input.now,
    });
  }

  async beginCancelEffect(
    commandId: string,
    input: { sessionId: string; cancelId: string; runGeneration: number },
    now = Date.now(),
  ): Promise<"execute" | "retry" | "adopt_confirmed" | "settled" | "missing"> {
    const [head, prior] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const decision = decideFeltDbTurnCancelBegin(head, prior?.cancel, input);
    if (!decision.next || !prior) return decision.result;
    return this.commitCancel({
      commandId,
      operationKind: "turn_cancel_begin",
      inputHash: digest(input),
      head,
      prior,
      cancel: decision.next,
      result: decision.result,
      now,
    });
  }

  async settleCancel(
    commandId: string,
    input: {
      sessionId: string;
      cancelId: string;
      outcome: "confirmed" | "not_aborted";
    },
    now = Date.now(),
  ): Promise<boolean> {
    const [head, prior] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    if (!prior?.cancel || prior.cancel.cancelId !== input.cancelId) return false;
    if (prior.cancel.phase === "settled") return true;
    return this.commitCancel({
      commandId,
      operationKind: "turn_cancel_settle",
      inputHash: digest(input),
      head,
      prior,
      cancel: { ...prior.cancel, phase: "settled", outcome: input.outcome },
      result: true,
      now,
    });
  }
}
