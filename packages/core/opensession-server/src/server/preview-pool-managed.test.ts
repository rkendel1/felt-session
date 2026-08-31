import { expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeManagedPreviewPool,
  previewPoolConfig,
  setPreviewPoolConfig,
} from "./preview-pool";

test("imports preview pool config and lifecycle state into managed FeltDB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-pool-managed-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state-opensession.json");
  writeFileSync(configPath, JSON.stringify({ repos: {
    opensession: { enabled: true, backend: "microvm", running: 2 },
  } }));
  writeFileSync(statePath, JSON.stringify({
    golden: { sha: "abc", builtAt: "2026-08-31T00:00:00Z" },
    containers: {},
  }));
  const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });

  await initializeManagedPreviewPool(db, dir);

  expect(existsSync(configPath)).toBe(false);
  expect(existsSync(statePath)).toBe(false);
  expect(previewPoolConfig("opensession")).toMatchObject({
    enabled: true,
    backend: "microvm",
    running: 2,
  });
  expect(await db.collection("opensession_preview_pool_state").all()).toHaveLength(1);

  await setPreviewPoolConfig("opensession", { paused: 3 });
  expect(previewPoolConfig("opensession").paused).toBe(3);
  const stored = await db.collection<{ repos: Record<string, { paused?: number }> }>(
    "opensession_preview_pool_config",
  ).get("config");
  expect(stored?.repos.opensession.paused).toBe(3);
});
