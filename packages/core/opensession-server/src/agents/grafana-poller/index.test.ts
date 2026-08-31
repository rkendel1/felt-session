import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { __grafanaPollDedupForTest, initializeManagedGrafanaPollDedup } from ".";

describe("Grafana poll dedup", () => {
  test("atomically admits one overlapping investigation through managed FeltDB", async () => {
    await initializeManagedGrafanaPollDedup(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
    const at = new Date().toISOString();
    const record = (osSessionId: string) => ({
      dedupValue: "workflow-42",
      firstSeen: at,
      lastInvestigatedAt: at,
      osSessionId,
    });

    const claims = await Promise.all([
      __grafanaPollDedupForTest.claim("automation-1", record("session-1")),
      __grafanaPollDedupForTest.claim("automation-1", record("session-2")),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await __grafanaPollDedupForTest.recentlyInvestigated(
      "automation-1",
      "workflow-42",
      7,
    )).toBe(true);
  });
});
