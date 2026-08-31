import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "../../server/managed-feltdb";
import { statePath } from "../../server/paths";

export function githubDeliveriesStore(): string {
  return statePath(".slack-sessions/github-deliveries.json");
}
const GITHUB_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GITHUB_DELIVERIES = 500;
const COLLECTION = "opensession_github_deliveries";
const MIGRATION = "github-deliveries-json-to-managed-feltdb-v1";
type DeliveryRecord = { id: string; deliveryId: string; expiresAt: number; acceptedAt: number };
const githubDeliveryExpiry: Map<string, number> = ((globalThis as any).__githubDeliveryExpiry ??= new Map());
let deliveryDb: StateFirstDB | undefined;
const recordId = (id: string) => `github_delivery_${createHash("sha256").update(id).digest("hex")}`;

function pruneGithubDeliveries(now = Date.now()): void {
  for (const [id, expiresAt] of githubDeliveryExpiry)
    if (expiresAt <= now) githubDeliveryExpiry.delete(id);
  while (githubDeliveryExpiry.size > MAX_GITHUB_DELIVERIES) {
    const oldest = githubDeliveryExpiry.keys().next().value;
    if (oldest === undefined) break;
    githubDeliveryExpiry.delete(oldest);
  }
}

export async function loadGithubDeliveries(
  db: StateFirstDB = deliveryDb ?? managedFeltDb(),
): Promise<void> {
  deliveryDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(MIGRATION)) {
    let entries: [string, number][] = [];
    try {
      if (existsSync(githubDeliveriesStore())) entries = JSON.parse(readFileSync(githubDeliveriesStore(), "utf8"));
    } catch {}
    for (const [deliveryId, expiresAt] of entries) {
      if (typeof deliveryId !== "string" || !Number.isFinite(expiresAt)) continue;
      const id = recordId(deliveryId);
      await db.transaction((tx) => {
        tx.collection<DeliveryRecord>(COLLECTION).set(id, {
          id, deliveryId, expiresAt, acceptedAt: expiresAt - GITHUB_DELIVERY_TTL_MS,
        });
      }, { transactionId: `opensession:github-delivery:migrate:${id}` });
    }
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
    if (existsSync(githubDeliveriesStore())) unlinkSync(githubDeliveriesStore());
  }
  const now = Date.now();
  const loaded = db.runtime().runtime === "remote" ? await queryDeliveries(db, now) :
    (await db.collection<DeliveryRecord>(COLLECTION).all()).filter((record) => record.expiresAt > now);
  githubDeliveryExpiry.clear();
  for (const record of loaded.sort((a, b) => a.acceptedAt - b.acceptedAt))
    githubDeliveryExpiry.set(record.deliveryId, record.expiresAt);
  pruneGithubDeliveries(now);
}

async function queryDeliveries(db: StateFirstDB, now: number): Promise<DeliveryRecord[]> {
  const loaded: DeliveryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await db.query<DeliveryRecord>({
      collection: COLLECTION,
      where: [{ field: "expiresAt", gt: now }],
      orderBy: [{ field: "expiresAt", direction: "asc" }],
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    loaded.push(...page.records);
    cursor = page.exhausted ? undefined : page.nextCursor;
    if (!page.exhausted && !cursor) throw new Error("FeltDB GitHub delivery cursor is missing");
  } while (cursor);
  return loaded;
}

export function isGithubDeliveryProcessed(id: string): boolean {
  const expiresAt = githubDeliveryExpiry.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    githubDeliveryExpiry.delete(id);
    return false;
  }
  return true;
}

export async function markGithubDeliveryProcessed(id: string): Promise<void> {
  const db = deliveryDb ?? managedFeltDb();
  const acceptedAt = Date.now();
  const expiresAt = acceptedAt + GITHUB_DELIVERY_TTL_MS;
  const key = recordId(id);
  await db.transaction((tx) => {
    tx.collection<DeliveryRecord>(COLLECTION).set(key, {
      id: key, deliveryId: id, expiresAt, acceptedAt,
    });
  }, { transactionId: `opensession:github-delivery:${key}` });
  githubDeliveryExpiry.set(id, expiresAt);
  pruneGithubDeliveries();
}

let githubWebhooksReceived = 0;
export function incrementGithubWebhooks(): void { githubWebhooksReceived++; }
export function githubWebhookCount(): number { return githubWebhooksReceived; }
