import { describe, expect, test } from "bun:test";
import { nextFeltDbOutboxFailure } from "./feltdb-outbox-store";

describe("managed FeltDB outbox lifecycle", () => {
  test("dead-letters at the retry boundary while retaining stable identity", () => {
    const transition = nextFeltDbOutboxFailure({
      schemaVersion: 1,
      recordId: "effect_stable",
      effectId: "session:notify:key",
      effectKey: "key",
      sessionId: "session",
      decisionEpoch: 1,
      kind: "notify",
      status: "pending",
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: 0,
      __version: 3,
    }, "failed", 2, 1_000);
    expect(transition).toMatchObject({
      next: {
        recordId: "effect_stable",
        attempts: 2,
        status: "dead_letter",
        deadLetteredAt: 1_000,
      },
      result: { updated: true, deadLetteredNow: true },
    });
    expect(transition.next).not.toHaveProperty("__version");
  });
});
