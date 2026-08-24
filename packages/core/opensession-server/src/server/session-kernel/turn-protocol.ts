import type { DurableRunState, DurableTurnState } from "./store";

export type DurableRunTarget = { runId: string; generation: number };

export function targetForTurnCancel(
  cancel: DurableTurnState["cancel"],
  cancelId: string,
): DurableRunTarget | undefined {
  return cancel?.cancelId === cancelId
    ? { runId: cancel.runId, generation: cancel.runGeneration }
    : undefined;
}

export type TurnActorRequest =
  | { op: "snapshot"; sessionId: string }
  | {
      op: "prepare_cancel";
      sessionId: string;
      cancelId: string;
      expectedRunId: string;
      expectedGeneration: number;
      dispatchId: string;
      requeueIds: string[];
      source: string;
      user?: string;
    }
  | {
      op: "begin_cancel_effect";
      sessionId: string;
      cancelId: string;
      runGeneration: number;
    }
  | {
      op: "settle_cancel";
      sessionId: string;
      cancelId: string;
      outcome: "confirmed" | "not_aborted";
    };

export type TurnActorResult<T extends TurnActorRequest> =
  T extends { op: "snapshot" }
    ? DurableTurnState
    : T extends { op: "prepare_cancel" }
      ? {
          cancel: NonNullable<DurableTurnState["cancel"]>;
          runState: DurableRunState;
        }
      : T extends { op: "begin_cancel_effect" }
        ? "execute" | "retry" | "adopt_confirmed" | "settled"
        : T extends { op: "settle_cancel" }
          ? boolean
          : never;
