import { describe, expect, test } from "bun:test";
import { feltDbCommandResultRecord } from "./feltdb-command-store";

describe("managed FeltDB command receipt schema", () => {
  test("retains result digest and terminal-failure evidence", () => {
    const ordinary = feltDbCommandResultRecord({ accepted: true });
    const terminal = feltDbCommandResultRecord({
      __sessionKernelFailure: true,
      error: "failed",
    });
    expect(ordinary.resultHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ordinary.terminalFailure).toBe(false);
    expect(terminal.terminalFailure).toBe(true);
    expect(terminal.resultHash).not.toBe(ordinary.resultHash);
  });
});
