import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  appendLedger,
  createGoal,
  deleteGoal,
  getGoal,
  initializeManagedGoals,
  listGoals,
  readLedger,
  updateGoal,
} from "./goals";

describe("managed goals", () => {
  test("stores goal state and its fact ledger together in FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedGoals(db);
    const created = await createGoal({
      name: "Finish FeltDB",
      mission: "Remove every other durable authority.",
      createdBy: "test",
    });
    if ("error" in created) throw new Error(created.error);

    await Promise.all([
      appendLedger(created, "Migrated JSON stores."),
      appendLedger(created, "Audited SQLite stores."),
    ]);
    await updateGoal(created.id, { phase: "kernel cutover" });
    await initializeManagedGoals(db);

    expect(getGoal(created.id)?.phase).toBe("kernel cutover");
    expect(listGoals().map((goal) => goal.id)).toEqual([created.id]);
    const ledger = await readLedger(created.id);
    expect(ledger).toContain("Migrated JSON stores.");
    expect(ledger).toContain("Audited SQLite stores.");

    expect(await deleteGoal(created.id)).toBe(true);
    expect(await readLedger(created.id)).toBe("");
  });
});
