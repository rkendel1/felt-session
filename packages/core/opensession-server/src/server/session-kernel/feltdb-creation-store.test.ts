import { describe, expect, test } from "bun:test";
import { decideFeltDbCreationEvent } from "./feltdb-creation-store";
import type { VersionedSessionDecisionHead } from "./feltdb-decision-store";

const head: VersionedSessionDecisionHead = {
  schemaVersion: 1,
  sessionId: "session-a",
  authority: { owner: "worker", epoch: 1, lifecycle: "active" },
  lease: { leaseId: "lease", epoch: 1, expiresAt: 10_000 },
  decisionEpoch: 1,
  changeSeq: 8,
  run: { state: "idle", since: new Date(0).toISOString(), generation: 0 },
  migratedAt: 0,
  migrationId: "migration-a",
  updatedAt: 0,
  __version: 1,
};

describe("managed FeltDB creation decisions", () => {
  test("plans a new session and allocates the shared journal sequence", () => {
    expect(decideFeltDbCreationEvent(head, undefined, {
      sessionId: "session-a",
      identity: "identity-a",
      event: "plan",
      planPatch: { branch: "main" },
    }, 1_000)).toMatchObject({
      next: { state: "planned", generation: 1, changeSeq: 9, setupPlan: { branch: "main" } },
      nextRun: { since: new Date(1_000).toISOString() },
      result: { accepted: true },
    });
  });

  test("admits physical work in the same decision", () => {
    const decision = decideFeltDbCreationEvent(head, {
      identity: "identity-a",
      state: "planned",
      generation: 1,
      completedEffectIds: [],
      changeSeq: 8,
      updatedAt: 1,
    }, {
      sessionId: "session-a",
      identity: "identity-a",
      event: "preparation_started",
      nextEffectId: "prepare-a",
      effect: {
        effectKey: "prepare-a",
        kind: "creation_branch_prepare",
        payload: {
          creationIdentity: "identity-a",
          creationGeneration: 1,
          project: "p",
          worktreePath: "/tmp/w",
          branch: "b",
          isolated: true,
          mode: "adopt_or_create",
        },
      },
    });
    expect(decision).toMatchObject({
      next: { state: "preparing", currentEffectId: "prepare-a" },
      effects: [{ effectKey: "prepare-a", kind: "creation_branch_prepare" }],
    });
  });

  test("rejects a mismatched effect without writing", () => {
    expect(decideFeltDbCreationEvent(head, {
      identity: "identity-a",
      state: "preparing",
      generation: 1,
      currentEffectId: "prepare-a",
      completedEffectIds: [],
      changeSeq: 8,
      updatedAt: 1,
    }, {
      sessionId: "session-a",
      identity: "identity-a",
      event: "failed",
      effectId: "prepare-b",
    })).toMatchObject({ result: { accepted: false, reason: "stale_effect" } });
  });
});
