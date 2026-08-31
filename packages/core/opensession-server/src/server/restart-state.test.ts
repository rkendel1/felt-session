import { afterEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeManagedRestartState, lastRestartBy, recordRestart } from "./restart-state";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("managed restart state", () => {
  test("imports and removes the former restart marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-restart-state-"));
    scratch.push(dir);
    const legacyPath = join(dir, "last-restart.json");
    writeFileSync(legacyPath, JSON.stringify({
      by: "migration-session",
      at: new Date().toISOString(),
      signal: "SIGTERM",
    }));
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });

    await initializeManagedRestartState(db, legacyPath);

    expect(lastRestartBy()).toBe("migration-session");
    expect(existsSync(legacyPath)).toBe(false);
    expect(await db.collection("opensession_restart_state").get("latest")).toMatchObject({
      by: "migration-session",
      signal: "SIGTERM",
    });
  });

  test("records shutdown attribution only in FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    const dir = mkdtempSync(join(tmpdir(), "opensession-restart-state-"));
    scratch.push(dir);
    const legacyPath = join(dir, "marker.json");
    await initializeManagedRestartState(db, legacyPath);

    await recordRestart("active-session", "SIGINT");

    expect(lastRestartBy()).toBe("active-session");
    expect(await db.collection("opensession_restart_state").get("latest")).toMatchObject({
      by: "active-session",
      signal: "SIGINT",
    });
    expect(existsSync(legacyPath)).toBe(false);
  });
});
