import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { ManagedValueRegistry } from "./managed-value-registry";

describe("ManagedValueRegistry", () => {
  test("persists independent records and tombstones deletes", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    const collection = `registry_${crypto.randomUUID().replaceAll("-", "")}`;
    const first = new ManagedValueRegistry<string>(collection);
    await first.initialize(db);
    await first.set("one", "First");
    await first.set("two", "Second");
    await first.set("one", undefined);

    const restored = new ManagedValueRegistry<string>(collection);
    await restored.initialize(db);
    expect(restored.get("one")).toBeUndefined();
    expect(restored.get("two")).toBe("Second");
  });
});
