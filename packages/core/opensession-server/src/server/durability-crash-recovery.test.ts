import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { openRunRecordStore } from "./run-record-store";
import type { ActiveRunRecord } from "./run-journal";

function record(runKey: string): ActiveRunRecord {
  return {
    runKey,
    osSessionId: `session-${runKey}`,
    cwd: "/workspace",
    startedAt: new Date().toISOString(),
    mcpServers: ["github"],
    terminalFailure: { type: "error", content: "interrupted", at: new Date().toISOString() },
  };
}

describe("managed FeltDB run recovery", () => {
  test("stores structured recovery state without JSON fields", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    const store = openRunRecordStore(db);
    await store.recordRun(record("one"));
    const recovered = await store.getRun("one");
    expect(recovered?.mcpServers).toEqual(["github"]);
    expect(recovered?.terminalFailure?.content).toBe("interrupted");
    expect(Object.keys(recovered || {}).some((key) => key.endsWith("Json"))).toBe(false);
  });

  test("claims and lineage clears are guarded", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    const store = openRunRecordStore(db);
    const run = record("guarded");
    await store.recordRun(run);
    await store.claimRuns([run], "2026-08-31T00:00:00.000Z");
    expect((await store.getRun(run.runKey))?.claimedAt).toBe("2026-08-31T00:00:00.000Z");
    expect(await store.clearRunIfLineage({ ...run, startedAt: "different" })).toBe(false);
    expect(await store.clearRunIfLineage(run)).toBe(true);
  });

  test("quarantine atomically removes active ownership", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    const store = openRunRecordStore(db);
    const run = record("quarantine");
    await store.recordRun(run);
    await store.quarantine([{ run, reason: "recovery_expired", notify: true }]);
    expect(await store.getRun(run.runKey)).toBeNull();
  });
});
