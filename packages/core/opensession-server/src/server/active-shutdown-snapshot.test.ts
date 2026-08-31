import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initializeManagedActiveShutdownSnapshot,
  readActiveShutdownSnapshot,
} from "./run-session";

describe("managed active shutdown snapshot", () => {
  test("imports and removes the former JSON snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-active-shutdown-"));
    const legacyPath = join(dir, "active-at-shutdown.json");
    writeFileSync(legacyPath, JSON.stringify([{
      runKey: "run-1",
      osSessionId: "os-session-1",
      cwd: "/workspace",
      startedAt: "2026-08-31T20:00:00.000Z",
    }]));
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });

    await initializeManagedActiveShutdownSnapshot(db, legacyPath);

    expect(readActiveShutdownSnapshot()).toEqual([{
      runKey: "run-1",
      osSessionId: "os-session-1",
      cwd: "/workspace",
      startedAt: "2026-08-31T20:00:00.000Z",
    }]);
    expect(existsSync(legacyPath)).toBe(false);
    expect(await db.collection("opensession_active_shutdown_snapshot").get("active")).toMatchObject({
      records: [{ runKey: "run-1", osSessionId: "os-session-1" }],
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
