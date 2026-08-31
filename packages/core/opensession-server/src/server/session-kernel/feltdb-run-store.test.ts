import { describe, expect, test } from "bun:test";
import { decideFeltDbRunEvent } from "./feltdb-run-store";
import type { VersionedSessionDecisionHead } from "./feltdb-decision-store";

function head(state = "idle"): VersionedSessionDecisionHead {
  return {
    schemaVersion: 1,
    sessionId: "session-a",
    authority: { owner: "worker", epoch: 1, lifecycle: "active" },
    lease: { leaseId: "lease", epoch: 1, expiresAt: 10_000 },
    decisionEpoch: 1,
    changeSeq: 4,
    run: { state, since: new Date(0).toISOString(), generation: 2 },
    migratedAt: 0,
    migrationId: "migration-a",
    updatedAt: 0,
    __version: 1,
  };
}

describe("managed FeltDB run decisions", () => {
  test("allocates the next journal sequence in the accepted result", () => {
    const decision = decideFeltDbRunEvent(
      head(),
      { sessionId: "session-a", event: "prompt", runKey: "run-a" },
      undefined,
      1_000,
    );
    expect(decision).toMatchObject({
      nextRun: { state: "starting", currentRunId: "run-a", generation: 3 },
      result: { accepted: true, state: { changeSeq: 5 } },
    });
  });

  test("rejects a canceled dispatch without advancing the head", () => {
    const decision = decideFeltDbRunEvent(
      head(),
      { sessionId: "session-a", event: "run_registered", runKey: "run-a" },
      {
        cancelId: "cancel-a",
        phase: "settled",
        runId: "run-a",
        runGeneration: 2,
        requeueIds: [],
        source: "test",
      },
    );
    expect(decision.nextRun).toBeUndefined();
    expect(decision.result).toMatchObject({ accepted: false, reason: "stale_run" });
  });

  test("rejects invalid transitions without advancing the head", () => {
    const decision = decideFeltDbRunEvent(
      head(),
      { sessionId: "session-a", event: "turn_end" },
      undefined,
    );
    expect(decision.nextRun).toBeUndefined();
    expect(decision.result).toMatchObject({ accepted: false, reason: "invalid_transition" });
  });
});
