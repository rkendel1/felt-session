import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  flushTimerPoisonWrites,
  initializeManagedTimerPoisonState,
  noteTimerPoisonExit,
} from "./timer-poison-state";

describe("managed timer poison guard", () => {
  test("hydrates the managed guard and halts after three recent exits", async () => {
    const now = new Date("2026-08-31T20:00:00.000Z");
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await db.transaction((tx) => {
      tx.collection("opensession_timer_poison_state").set("guard", {
        id: "guard",
        exits: [
          "2026-08-31T19:40:00.000Z",
          "2026-08-31T19:50:00.000Z",
          "2026-08-31T19:55:00.000Z",
        ],
      });
    });

    await initializeManagedTimerPoisonState(db);
    const result = noteTimerPoisonExit(now);

    expect(result.halted).toBe(true);
    expect(result.exits).toHaveLength(3);
  });

  test("persists a new exit in FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedTimerPoisonState(db);

    expect(noteTimerPoisonExit(new Date("2026-08-31T20:00:00.000Z")).halted).toBe(false);
    await flushTimerPoisonWrites();

    expect(await db.collection("opensession_timer_poison_state").get("guard")).toMatchObject({
      exits: ["2026-08-31T20:00:00.000Z"],
    });
  });
});
