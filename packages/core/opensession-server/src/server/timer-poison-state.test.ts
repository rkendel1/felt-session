import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  flushTimerPoisonWrites,
  initializeManagedTimerPoisonState,
  noteTimerPoisonExit,
} from "./timer-poison-state";

describe("managed timer poison guard", () => {
  test("imports the legacy guard and halts after three recent exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-timer-poison-"));
    const legacyPath = join(dir, "timer-poison.json");
    const now = new Date("2026-08-31T20:00:00.000Z");
    writeFileSync(legacyPath, JSON.stringify({ exits: [
      "2026-08-31T19:40:00.000Z",
      "2026-08-31T19:50:00.000Z",
      "2026-08-31T19:55:00.000Z",
    ] }));
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });

    await initializeManagedTimerPoisonState(db, legacyPath);
    const result = noteTimerPoisonExit(now);

    expect(result.halted).toBe(true);
    expect(result.exits).toHaveLength(3);
    expect(existsSync(legacyPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists a new exit in FeltDB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-timer-poison-"));
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedTimerPoisonState(db, join(dir, "missing.json"));

    expect(noteTimerPoisonExit(new Date("2026-08-31T20:00:00.000Z")).halted).toBe(false);
    await flushTimerPoisonWrites();

    expect(await db.collection("opensession_timer_poison_state").get("guard")).toMatchObject({
      exits: ["2026-08-31T20:00:00.000Z"],
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
