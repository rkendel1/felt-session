import { describe, expect, test } from "bun:test";
import { isInternalKernelDispatch } from "./ws-command-bridge";

describe("recursive WebSocket command token", () => {
  test("membership checks do not retire the token before failure is consumed", () => {
    const active = new Set(["command-one"]);
    expect(isInternalKernelDispatch(active, "command-one")).toBe(true);
    expect(isInternalKernelDispatch(active, "command-one")).toBe(true);
    expect(active.has("command-one")).toBe(true);
    active.delete("command-one");
    expect(isInternalKernelDispatch(active, "command-one")).toBe(false);
  });

  test("rejects unrelated and malformed tokens", () => {
    const active = new Set(["owned"]);
    expect(isInternalKernelDispatch(active, "foreign")).toBe(false);
    expect(isInternalKernelDispatch(active, null)).toBe(false);
  });
});
