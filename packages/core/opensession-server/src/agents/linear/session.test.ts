import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  deleteSessionFile,
  loadSessionInfo,
  saveSessionInfo,
} from "./session";

function testDb() {
  return createFeltDB({ namespace: crypto.randomUUID(), memory: true });
}

describe("managed Linear sessions", () => {
  test("merges partial saves without losing another writer's fields", async () => {
    const db = testDb();
    await saveSessionInfo("linear-test", {
      issueIdentifier: "ENG-1",
      issueTitle: "Managed state",
      piSessionId: "pi-session",
      model: "pi/anthropic/claude-opus-5",
    }, db);
    await saveSessionInfo("linear-test", { phase: "working" }, db);

    const stored = await loadSessionInfo("linear-test", db);
    expect(stored?.issueIdentifier).toBe("ENG-1");
    expect(stored?.piSessionId).toBe("pi-session");
    expect(stored?.phase).toBe("working");
  });

  test("tombstones deleted sessions", async () => {
    const db = testDb();
    await saveSessionInfo("linear-deleted", { issueIdentifier: "ENG-2" }, db);
    await deleteSessionFile("linear-deleted", db);
    expect(await loadSessionInfo("linear-deleted", db)).toBeNull();
  });
});
