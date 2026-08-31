import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  addPushSubscription,
  getVapidPublicKey,
  initializeManagedPush,
  listPushSubscriptions,
  removePushSubscription,
  sendPushToUser,
} from "./push";

describe("managed Web Push authority", () => {
  test("persists VAPID identity, subscriptions, deletion, and dedupe in FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedPush(db);
    const publicKey = getVapidPublicKey();
    expect(publicKey.length).toBeGreaterThan(20);

    const endpoint = "https://push.example.test/device-one";
    expect(await addPushSubscription({
      user: "Randy",
      subscription: { endpoint, keys: { p256dh: "p256dh", auth: "auth" } },
      userAgent: "test",
    })).toEqual({ ok: true });
    expect(listPushSubscriptions("Randy").map((record) => record.endpoint)).toEqual([endpoint]);

    await sendPushToUser("Nobody", { title: "Question" }, { dedupeKey: "ask:one" });
    const dedupeId = `push_dedupe_${createHash("sha256").update("ask:one").digest("hex")}`;
    expect(await db.collection("opensession_push_dedupe").get(dedupeId)).not.toBeNull();

    expect(await removePushSubscription(endpoint)).toBe(true);
    await initializeManagedPush(db);
    expect(getVapidPublicKey()).toBe(publicKey);
    expect(listPushSubscriptions()).toEqual([]);
  });
});
