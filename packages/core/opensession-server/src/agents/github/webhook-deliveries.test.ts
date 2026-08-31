import { beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import {
  isGithubDeliveryProcessed,
  loadGithubDeliveries,
  markGithubDeliveryProcessed,
} from "./webhook-deliveries";

let db: StateFirstDB;
beforeEach(async () => {
  db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await loadGithubDeliveries(db);
});

describe("GitHub delivery replay protection", () => {
  test("persists accepted deliveries across hydration", async () => {
    const deliveryId = "github-delivery-persists";
    await markGithubDeliveryProcessed(deliveryId);
    expect(isGithubDeliveryProcessed(deliveryId)).toBe(true);
    await loadGithubDeliveries(db);
    expect(isGithubDeliveryProcessed(deliveryId)).toBe(true);
  });

  test("does not report unknown deliveries", () => {
    expect(isGithubDeliveryProcessed("unknown-delivery")).toBe(false);
  });
});
