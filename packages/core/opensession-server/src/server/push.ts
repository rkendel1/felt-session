/** Web Push authorities backed exclusively by managed FeltDB. */
import { createHash } from "node:crypto";
import type { StateFirstDB } from "@feltdb/core";
import webpush from "web-push";
import { configuredIntegration } from "./config";
import { managedFeltDb } from "./managed-feltdb";
const VAPID_COLLECTION = "opensession_push_vapid";
const SUBS_COLLECTION = "opensession_push_subscriptions";
const DEDUPE_COLLECTION = "opensession_push_dedupe";
const DEDUPE_TTL_MS = 48 * 60 * 60 * 1000;

interface VapidKeys { publicKey: string; privateKey: string }
interface StoredVapid extends VapidKeys { id: "default" }

export interface PushSubscriptionRecord {
  user: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: string;
}
interface StoredSubscription extends PushSubscriptionRecord { id: string; __version?: number }
interface StoredDedupe { id: string; key: string; sentAt: number; __version?: number }

let authority: StateFirstDB | undefined;
let vapid: VapidKeys | null = null;
let configured = false;
const subscriptions = new Map<string, StoredSubscription>();
const sentDedupe = new Map<string, StoredDedupe>();
const recordId = (prefix: string, value: string) =>
  `${prefix}_${createHash("sha256").update(value).digest("hex")}`;

export async function initializeManagedPush(db: StateFirstDB = authority ?? managedFeltDb()): Promise<void> {
  authority = db;
  let storedVapid = await db.collection<StoredVapid>(VAPID_COLLECTION).get("default");
  if (!storedVapid) {
    const generated = webpush.generateVAPIDKeys();
    await db.transaction((tx) => {
      tx.collection<StoredVapid>(VAPID_COLLECTION).set("default", { id: "default", ...generated }, { requireAbsent: true });
    }, { transactionId: "opensession:push:vapid:create" });
    storedVapid = { id: "default", ...generated };
    console.log("[push] generated VAPID keypair in managed FeltDB");
  }
  vapid = { publicKey: storedVapid.publicKey, privateKey: storedVapid.privateKey };
  subscriptions.clear();
  for (const record of await db.collection<StoredSubscription>(SUBS_COLLECTION).all()) subscriptions.set(record.id, record);
  sentDedupe.clear();
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const record of await db.collection<StoredDedupe>(DEDUPE_COLLECTION).all())
    if (record.sentAt >= cutoff) sentDedupe.set(record.id, record);
  configureWebPush();
}

function configureWebPush(): void {
  if (configured) return;
  if (!vapid) throw new Error("Managed push authority is not initialized");
  const subject = configuredIntegration("push").vapidSubject;
  webpush.setVapidDetails(
    typeof subject === "string" && subject.trim() ? subject.trim() : "mailto:admin@example.com",
    vapid.publicKey, vapid.privateKey,
  );
  configured = true;
}

export function getVapidPublicKey(): string {
  if (!vapid) throw new Error("Managed push authority is not initialized");
  return vapid.publicKey;
}

export function listPushSubscriptions(user?: string): PushSubscriptionRecord[] {
  const all = [...subscriptions.values()];
  return user ? all.filter((subscription) => subscription.user === user) : all;
}

export async function addPushSubscription(input: {
  user: string;
  subscription: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  userAgent?: string;
}): Promise<{ ok: true } | { error: string }> {
  const { endpoint, keys } = input.subscription || {};
  if (!input.user?.trim()) return { error: "user required" };
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return { error: "subscription must carry endpoint + p256dh/auth keys" };
  const db = authority ?? managedFeltDb();
  const id = recordId("push_subscription", endpoint);
  const current = subscriptions.get(id);
  const next: StoredSubscription = {
    id, user: input.user.trim(), endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userAgent: input.userAgent?.slice(0, 200), createdAt: new Date().toISOString(),
  };
  await db.transaction((tx) => {
    tx.collection<StoredSubscription>(SUBS_COLLECTION).set(id, next,
      current && Number.isSafeInteger(current.__version) ? { ifVersion: current.__version } : { requireAbsent: true });
  }, { transactionId: `opensession:push:subscribe:${id}:${crypto.randomUUID()}` });
  subscriptions.set(id, { ...next, __version: (current?.__version ?? 0) + 1 });
  return { ok: true };
}

export async function removePushSubscription(endpoint: string): Promise<boolean> {
  const id = recordId("push_subscription", endpoint);
  const current = subscriptions.get(id);
  if (!current || !Number.isSafeInteger(current.__version)) return false;
  const db = authority ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<StoredSubscription>(SUBS_COLLECTION).delete(id, { ifVersion: current.__version });
  }, { transactionId: `opensession:push:unsubscribe:${id}:${current.__version}` });
  subscriptions.delete(id);
  return true;
}

export interface PushPayload { title: string; body?: string; url?: string; tag?: string }

async function reserveDedupe(key: string): Promise<boolean> {
  const now = Date.now();
  const id = recordId("push_dedupe", key);
  const current = sentDedupe.get(id);
  if (current && now - current.sentAt < DEDUPE_TTL_MS) return false;
  const db = authority ?? managedFeltDb();
  const next: StoredDedupe = { id, key, sentAt: now };
  await db.transaction((tx) => {
    tx.collection<StoredDedupe>(DEDUPE_COLLECTION).set(id, next,
      current && Number.isSafeInteger(current.__version) ? { ifVersion: current.__version } : { requireAbsent: true });
  }, { transactionId: `opensession:push:dedupe:${id}:${crypto.randomUUID()}` });
  sentDedupe.set(id, { ...next, __version: (current?.__version ?? 0) + 1 });
  return true;
}

export async function sendPushToUser(user: string, payload: PushPayload, opts?: { dedupeKey?: string }): Promise<void> {
  if (opts?.dedupeKey && !await reserveDedupe(opts.dedupeKey)) return;
  const subs = listPushSubscriptions(user);
  if (subs.length === 0) return;
  configureWebPush();
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, body, { TTL: 60 * 60 });
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await removePushSubscription(subscription.endpoint);
        console.log(`[push] pruned dead subscription for ${subscription.user}`);
      } else console.error(`[push] send failed for ${subscription.user}:`, error?.message || error);
    }
  }));
}
