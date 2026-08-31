/** Durable Slack event intake. Events commit to managed FeltDB before the
 * webhook acknowledges them, and completion remains as a dedupe receipt. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "../../server/managed-feltdb";

const COLLECTION = "opensession_slack_event_inbox";
const MIGRATIONS = "opensession_migrations";
const MIGRATION_ID = "slack-event-inbox-json-to-managed-feltdb-v1";

export type SlackEventInboxKind = "direct_message" | "mention";
export interface SlackEventInboxRecord {
  id: string;
  kind: SlackEventInboxKind;
  event: any;
  receivedAt: string;
  attempts: number;
  lastError?: string;
}
type StoredRecord = Omit<SlackEventInboxRecord, "id"> & {
  id: string;
  eventId: string;
  status: "pending" | "completed";
  updatedAt: number;
  __version?: number;
};
export interface SlackEventInboxDependencies {
  handleDirectMessage: (event: any) => Promise<void>;
  handleMention: (event: any) => Promise<void>;
  isProcessed: (id: string) => boolean;
  markProcessed: (id: string) => void;
}
export interface SlackEventInboxOptions { retryDelayMs?: number; db?: StateFirstDB }
export type SlackEventInboxEnqueueResult = "enqueued" | "pending" | "processed";

function eventId(event: any): string {
  const channel = typeof event?.channel === "string" ? event.channel : "";
  const ts = typeof event?.ts === "string" ? event.ts : "";
  if (!channel || !ts) throw new Error("Slack session event is missing channel or ts");
  return `${channel}-${ts}`;
}
function recordId(id: string): string {
  return `slack_event_${createHash("sha256").update(id).digest("hex")}`;
}
function errorText(error: unknown): string {
  return String((error as Error)?.message || error).slice(0, 500);
}

export class SlackEventInbox {
  private readonly records = new Map<string, StoredRecord>();
  private readonly inFlight = new Set<string>();
  private readonly retryDelayMs: number;
  private loadPromise: Promise<void> | undefined;
  private started = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly legacyStorePath: string,
    private readonly deps: SlackEventInboxDependencies,
    private readonly options: SlackEventInboxOptions = {},
  ) {
    this.retryDelayMs = Math.max(1_000, options.retryDelayMs ?? 60_000);
  }
  private db(): StateFirstDB { return this.options.db ?? managedFeltDb(); }

  async enqueue(kind: SlackEventInboxKind, event: any): Promise<SlackEventInboxEnqueueResult> {
    await this.ensureLoaded();
    const id = eventId(event);
    if (this.deps.isProcessed(id)) return "processed";
    if (this.records.has(id)) { this.kick(); return "pending"; }
    const key = recordId(id);
    const collection = this.db().collection<StoredRecord>(COLLECTION);
    const existing = await collection.get(key);
    if (existing?.status === "completed") return "processed";
    if (existing?.status === "pending") {
      this.records.set(id, existing);
      this.kick();
      return "pending";
    }
    const now = Date.now();
    const record: StoredRecord = {
      id: key, eventId: id, kind, event,
      receivedAt: new Date(now).toISOString(), attempts: 0,
      status: "pending", updatedAt: now,
    };
    try {
      await this.db().transaction((tx) => {
        tx.collection<StoredRecord>(COLLECTION).set(key, record, { requireAbsent: true });
      }, { transactionId: `opensession:slack-event:admit:${key}` });
    } catch (error) {
      const raced = await collection.get(key);
      if (!raced) throw error;
      if (raced.status === "completed") return "processed";
    }
    const committed = await collection.get(key);
    if (!committed || !Number.isSafeInteger(committed.__version))
      throw new Error(`Slack event ${id} has no FeltDB authority version`);
    this.records.set(id, committed);
    this.kick();
    return "enqueued";
  }

  async start(): Promise<void> {
    await this.ensureLoaded();
    this.started = true;
    await this.drain();
  }
  async initialize(): Promise<void> { await this.ensureLoaded(); }
  stop(): void {
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
  pendingCount(): number { return this.records.size; }
  inFlightCount(): number { return this.inFlight.size; }
  async drain(): Promise<void> {
    await this.ensureLoaded();
    if (!this.started) return;
    await Promise.all([...this.records.values()]
      .filter((record) => !this.inFlight.has(record.eventId))
      .map((record) => this.process(record)));
  }

  private ensureLoaded(): Promise<void> { return (this.loadPromise ??= this.load()); }
  private async load(): Promise<void> {
    const db = this.db();
    if (!await db.collection<{ id: string }>(MIGRATIONS).get(MIGRATION_ID)) {
      if (existsSync(this.legacyStorePath)) {
        const parsed = JSON.parse(readFileSync(this.legacyStorePath, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("Failed to load Slack event inbox: expected array");
        for (const value of parsed) await this.importLegacy(value);
      }
      await db.transaction((tx) => {
        tx.collection(MIGRATIONS).set(MIGRATION_ID, {
          id: MIGRATION_ID, completedAt: Date.now(),
        }, { requireAbsent: true });
      }, { transactionId: `opensession:migration:${MIGRATION_ID}` });
      if (existsSync(this.legacyStorePath)) unlinkSync(this.legacyStorePath);
    } else if (existsSync(this.legacyStorePath)) unlinkSync(this.legacyStorePath);

    if (db.runtime().runtime !== "remote") {
      for (const record of await db.collection<StoredRecord>(COLLECTION).all()) {
        if (record.status === "pending") this.rememberLoaded(record);
      }
      return;
    }
    let cursor: string | undefined;
    do {
      const page = await db.query<StoredRecord>({
        collection: COLLECTION,
        where: [{ field: "status", eq: "pending" }],
        orderBy: [{ field: "receivedAt", direction: "asc" }],
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const record of page.records) this.rememberLoaded(record);
      cursor = page.exhausted ? undefined : page.nextCursor;
      if (!page.exhausted && !cursor) throw new Error("FeltDB Slack event cursor is missing");
    } while (cursor);
  }
  private rememberLoaded(record: StoredRecord): void {
    if (!record.id || !record.eventId || !Number.isSafeInteger(record.__version))
      throw new Error("Managed Slack event inbox contains an invalid record");
    this.records.set(record.eventId, record);
  }
  private async importLegacy(value: unknown): Promise<void> {
    const legacy = value as Partial<SlackEventInboxRecord>;
    if (typeof legacy.id !== "string" ||
      (legacy.kind !== "direct_message" && legacy.kind !== "mention") ||
      !legacy.event || typeof legacy.receivedAt !== "string")
      throw new Error("Failed to load Slack event inbox: invalid record");
    const key = recordId(legacy.id);
    const stored: StoredRecord = {
      ...(legacy as SlackEventInboxRecord), id: key, eventId: legacy.id,
      attempts: Number.isFinite(legacy.attempts) ? Number(legacy.attempts) : 0,
      status: "pending", updatedAt: Date.now(),
    };
    try {
      await this.db().transaction((tx) => {
        tx.collection<StoredRecord>(COLLECTION).set(key, stored, { requireAbsent: true });
      }, { transactionId: `opensession:slack-event:migrate:${key}` });
    } catch (error) {
      if (!await this.db().collection(COLLECTION).get(key)) throw error;
    }
  }

  private kick(): void {
    if (!this.started) return;
    void this.drain().catch((error) => {
      console.error("[slack] Event inbox drain failed:", error);
      this.scheduleRetry();
    });
  }
  private async process(record: StoredRecord): Promise<void> {
    this.inFlight.add(record.eventId);
    try {
      if (this.deps.isProcessed(record.eventId)) { await this.complete(record); return; }
      if (record.kind === "direct_message") await this.deps.handleDirectMessage(record.event);
      else await this.deps.handleMention(record.event);
      this.deps.markProcessed(record.eventId);
      await this.complete(record);
    } catch (error) {
      record.attempts += 1;
      record.lastError = errorText(error);
      try { await this.updateFailure(record); }
      catch (persistError) { console.error("[slack] Failed to persist event inbox failure:", persistError); }
      console.error(`[slack] Event inbox attempt ${record.attempts} failed for ${record.eventId}:`, error);
      this.scheduleRetry();
    } finally { this.inFlight.delete(record.eventId); }
  }
  private async updateFailure(record: StoredRecord): Promise<void> {
    if (!Number.isSafeInteger(record.__version)) throw new Error(`Slack event ${record.eventId} has no version`);
    const collection = this.db().collection<StoredRecord>(COLLECTION);
    const result = await collection.updateIfVersion(record.id, record.__version!, {
      attempts: record.attempts, lastError: record.lastError, updatedAt: Date.now(),
    });
    if (!result.updated) throw new Error(`Slack event ${record.eventId} changed concurrently`);
    const refreshed = await collection.get(record.id);
    if (!refreshed || !Number.isSafeInteger(refreshed.__version))
      throw new Error(`Slack event ${record.eventId} disappeared after update`);
    this.records.set(record.eventId, refreshed);
  }
  private async complete(record: StoredRecord): Promise<void> {
    if (!Number.isSafeInteger(record.__version)) throw new Error(`Slack event ${record.eventId} has no version`);
    const collection = this.db().collection<StoredRecord>(COLLECTION);
    const result = await collection.updateIfVersion(record.id, record.__version!, {
      status: "completed", updatedAt: Date.now(),
    });
    if (!result.updated && (await collection.get(record.id))?.status !== "completed")
      throw new Error(`Slack event ${record.eventId} changed during completion`);
    this.records.delete(record.eventId);
  }
  private scheduleRetry(): void {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.kick(); }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }
}
