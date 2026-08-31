import { afterAll, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeManagedAudit } from "./audit";
import { initializeManagedPiUsage, piUsageForDates } from "./pi-usage";

const root = mkdtempSync(join(tmpdir(), "pi-usage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("imports legacy cache and derives uncached usage from managed audit", async () => {
  const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  const auditDir = join(root, "audit");
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir, { recursive: true });
  await Bun.write(join(auditDir, "audit-2026-08-20.jsonl"), [
    JSON.stringify({
      time: "2026-08-20T10:00:00Z",
      msg: "pi_turn",
      direction: "out",
      session: "os-019c-session",
      model: "pi/anthropic/claude-opus-5",
      steps: 2,
      input_tokens: 40,
      output_tokens: 6,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 8,
      total_cost_usd: 3.75,
    }),
    JSON.stringify({
      time: "2026-08-20T11:00:00Z",
      kind: "result",
      session_id: "os-019c-session",
      model: "claude-opus-5",
      output_tokens: 999,
      total_cost_usd: 999,
    }),
  ].join("\n"));
  writeFileSync(join(cacheDir, "engine-day-2026-08-19.json"), JSON.stringify({
    day: {
      byModel: [{ model: "legacy-model", requests: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 5, costUsd: 6 }],
      bySession: {},
      unpricedRequests: 0,
    },
  }));

  await initializeManagedAudit(db, auditDir);
  await initializeManagedPiUsage(db, cacheDir);

  expect(existsSync(join(cacheDir, "engine-day-2026-08-19.json"))).toBe(false);
  const usage = await piUsageForDates(["2026-08-19", "2026-08-20"]);
  expect(usage.get("2026-08-19")).toMatchObject({ requests: 1, totalTokens: 14, costUsd: 6 });
  expect(usage.get("2026-08-20")).toMatchObject({
    requests: 2,
    input: 40,
    output: 6,
    cacheRead: 60,
    cacheWrite: 8,
    totalTokens: 114,
    costUsd: 3.75,
  });
  expect(usage.get("2026-08-20")?.bySession["os-019c-session"]).toEqual({ requests: 2, output: 6 });
});
