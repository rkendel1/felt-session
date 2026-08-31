import { describe, expect, test } from "bun:test";
import { decideFeltDbTurnCancelBegin } from "./feltdb-turn-store";
import type { VersionedSessionDecisionHead } from "./feltdb-decision-store";

const head = {
  run: { generation: 4 },
} as VersionedSessionDecisionHead;

describe("managed FeltDB turn cancellation", () => {
  test("advances a prepared cancel to executing", () => {
    expect(decideFeltDbTurnCancelBegin(head, {
      cancelId: "cancel-a",
      phase: "prepared",
      runId: "run-a",
      runGeneration: 4,
      requeueIds: [],
      source: "user",
    }, { cancelId: "cancel-a", runGeneration: 4 })).toMatchObject({
      result: "execute",
      next: { phase: "executing" },
    });
  });

  test("adopts confirmation after the run generation changes", () => {
    expect(decideFeltDbTurnCancelBegin(head, {
      cancelId: "cancel-a",
      phase: "prepared",
      runId: "run-a",
      runGeneration: 3,
      requeueIds: [],
      source: "user",
    }, { cancelId: "cancel-a", runGeneration: 3 })).toEqual({
      result: "adopt_confirmed",
    });
  });
});
