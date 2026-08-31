import { beforeAll, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { initializeManagedAutomationInputs } from "./automation-inputs";
import { initializeManagedAutomationOutputs } from "./automation-outputs";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  initializeManagedAutomations,
  listAutomations,
  updateAutomation,
} from "./automations";

beforeAll(async () => {
  const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await initializeManagedAutomationInputs(db);
  await initializeManagedAutomationOutputs(db);
  await initializeManagedAutomations(db);
});

describe("managed automation definitions", () => {
  test("creates, updates, lists, and deletes through FeltDB", async () => {
    const created = await createAutomation({
      name: "Managed test",
      prompt: "Inspect the managed automation store.",
      schedule: "",
      mode: "ask",
      createdBy: "Test",
    });
    expect("error" in created).toBe(false);
    if ("error" in created) return;
    expect(getAutomation(created.id)?.name).toBe("Managed test");
    expect(listAutomations().some((entry) => entry.id === created.id)).toBe(true);

    const updated = await updateAutomation(created.id, { enabled: false });
    expect("error" in updated).toBe(false);
    expect(getAutomation(created.id)?.enabled).toBe(false);

    expect(await deleteAutomation(created.id)).toBe(true);
    expect(getAutomation(created.id)).toBeNull();
  });
});
