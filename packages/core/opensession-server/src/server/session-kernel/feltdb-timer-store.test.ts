import { describe, expect, test } from "bun:test";
import { nextFeltDbTimerFailure } from "./feltdb-timer-store";

describe("managed FeltDB timer lifecycle", () => {
  test("dead-letters exactly at the configured attempt limit", () => {
    const next = nextFeltDbTimerFailure({
      schemaVersion: 1,
      recordId: "timer-a",
      sessionId: "session-a",
      decisionEpoch: 1,
      timerId: "wake",
      kind: "wake",
      dueAt: 100,
      token: "token-a",
      status: "pending",
      attempts: 2,
      nextAttemptAt: 100,
      createdAt: 50,
    }, "failed", 3, 1_000);
    expect(next).toMatchObject({
      recordId: "timer-a",
      token: "token-a",
      attempts: 3,
      status: "dead_letter",
      deadLetteredAt: 1_000,
    });
  });
});
