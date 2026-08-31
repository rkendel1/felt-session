import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  getRouterConfig,
  initializeManagedPlainRouterConfig,
  setRouterConfig,
} from "./ticket-router";

describe("Plain ticket router config", () => {
  test("persists editable config in managed FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedPlainRouterConfig(db);
    expect(await setRouterConfig({ prompt: "Route carefully." })).toMatchObject({
      prompt: "Route carefully.",
      isCustom: true,
    });

    await initializeManagedPlainRouterConfig(db);
    expect(getRouterConfig()).toMatchObject({ prompt: "Route carefully.", isCustom: true });
  });
});
