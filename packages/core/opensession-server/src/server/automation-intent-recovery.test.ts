import { describe, expect, test } from "bun:test";
import { automationIntentAlreadySettled } from "./automation-intent-recovery";

describe("automation intent recovery", () => {
  test("recognizes a completed durable run", () => {
    expect(
      automationIntentAlreadySettled("session-1", [
        { sessionId: "session-1", status: "error" },
      ]),
    ).toBe(true);
  });

  test("does not settle a run that still owns execution", () => {
    expect(
      automationIntentAlreadySettled("session-1", [
        { sessionId: "session-1", status: "running" },
      ]),
    ).toBe(false);
  });

  test("does not cross session identities", () => {
    expect(
      automationIntentAlreadySettled("session-1", [
        { sessionId: "session-2", status: "ok" },
      ]),
    ).toBe(false);
  });
});
