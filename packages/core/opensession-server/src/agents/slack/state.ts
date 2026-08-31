/**
 * Shared mutable state for the Slack agent.
 *
 * Centralized here so multiple modules (handlers, queue, worktree-channels,
 * github-reviews, index) can read/write without circular imports.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { managedFeltDb } from "../../server/managed-feltdb";
import type { StateFirstDB } from "@feltdb/core";
import { configuredPaths, defaultRepo } from "../../server/config";
import { statePath } from "../../server/paths";
import type { SlackSessionFile } from "../../server/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Slack loop's in-memory view of a session: the on-disk record with the
 *  fields the loop always has narrowed to required. One type, so a field can't
 *  exist in memory but not in the write path (repoId used to). */
export interface SlackSession extends SlackSessionFile {
  channel: string;
  threadTs: string;
  userId: string;
  claudeSessionId: string | null;
  worktreeDir: string | null;
  branch: string | null;
  createdAt: string;
  lastActivity: string;
}

export interface PendingAnswer {
  resolve: (answer: string) => void;
  messageTs: string;
  channel: string;
  threadTs: string;
  sessionKey: string;
  timeoutId: ReturnType<typeof setTimeout>;
  questionText: string;
  header: string;
}

/** Sentinel returned to handleAskUserQuestion when the user cancels mid-modal. */
export const CANCELLED_ANSWER = "__CANCELLED__";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// statePath, not $HOME directly: with OPENSESSION_STATE_DIR set (dev/demo
// instances) this store isolates like every other one, so a second instance
// can neither read nor patch the live loop's session files. Unset ⇒ $HOME.
export const SESSION_DIR = statePath(".slack-sessions");
// Config-driven: the repos registry and paths in the instance config file.
export const DEFAULT_CWD = defaultRepo().repo;
export const MCP_CONFIG_PATH = configuredPaths().mcpConfig;
export const GITHUB_REPO = defaultRepo().ghRepo;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

// Parked on globalThis: the engine-id sync (server/agent-session-sync.ts)
// writes into this map from outside the Slack loop, and a hot reload must not
// fork the loop's copy from the writer's.
export const activeSessions: Map<string, SlackSession> = ((globalThis as any)
	.__slackActiveSessions ??= new Map());
export const persistedSlackSessions: Map<string, SlackSession> = ((globalThis as any)
  .__slackPersistedSessions ??= new Map());
export const pendingAnswers = new Map<string, PendingAnswer>();

// Inbound Slack event dedup, persisted across restarts. Slack retries a delivery
// when it didn't get a 200 — which, since we ack every event immediately, means
// we were down/erroring when it first arrived. The old in-memory-only Set meant a
// retry landing after a restart was either blindly dropped (event lost forever) or
// reprocessed (duplicate handling). Persisting eventId -> expiry lets us drop only
// events we truly handled and process the ones we missed. 5-min TTL matches Slack's
// retry window.
const PROCESSED_EVENTS_STORE = `${SESSION_DIR}/processed-events.json`;
const PROCESSED_EVENT_TTL_MS = 5 * 60 * 1000;
const processedEventExpiry = new Map<string, number>();
const PROCESSED_EVENTS_COLLECTION = "opensession_slack_processed_events";
const PROCESSED_EVENTS_MIGRATION = "slack-processed-events-json-to-managed-feltdb-v1";
type ProcessedEvent = { id: string; eventId: string; expiresAt: number; __version?: number };

function feltId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
}

/** Load the persisted dedup set on boot, dropping any already-expired ids. */
export async function loadProcessedEvents(): Promise<void> {
  const db = managedFeltDb();
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(PROCESSED_EVENTS_MIGRATION)) {
    let entries: [string, number][] = [];
    if (existsSync(PROCESSED_EVENTS_STORE)) {
      try {
        entries = JSON.parse(readFileSync(PROCESSED_EVENTS_STORE, "utf-8")) as [string, number][];
        if (!Array.isArray(entries)) throw new Error("expected an array");
      } catch (error) {
        throw new Error(`Failed to migrate Slack processed events: ${error}`);
      }
    }
    const now = Date.now();
    for (const [eventId, expiresAt] of entries) {
      if (expiresAt <= now) continue;
      const id = feltId("slack_processed", eventId);
      try {
        await db.transaction((tx) => {
          tx.collection<ProcessedEvent>(PROCESSED_EVENTS_COLLECTION).set(id, {
            id, eventId, expiresAt,
          }, { requireAbsent: true });
        }, { transactionId: `opensession:slack-processed:migrate:${id}` });
      } catch (error) {
        if (!await db.collection(PROCESSED_EVENTS_COLLECTION).get(id)) throw error;
      }
    }
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(PROCESSED_EVENTS_MIGRATION, {
        id: PROCESSED_EVENTS_MIGRATION, completedAt: Date.now(),
      }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${PROCESSED_EVENTS_MIGRATION}` });
    if (existsSync(PROCESSED_EVENTS_STORE)) unlinkSync(PROCESSED_EVENTS_STORE);
  } else if (existsSync(PROCESSED_EVENTS_STORE)) {
    unlinkSync(PROCESSED_EVENTS_STORE);
  }
}

/** True if we already handled this event id (and it hasn't aged out). */
export async function isEventProcessed(id: string): Promise<boolean> {
  const exp = processedEventExpiry.get(id);
  if (exp !== undefined && exp > Date.now()) return true;
  if (exp !== undefined) {
    processedEventExpiry.delete(id);
  }
  const record = await managedFeltDb().collection<ProcessedEvent>(PROCESSED_EVENTS_COLLECTION)
    .get(feltId("slack_processed", id));
  if (!record || record.expiresAt <= Date.now()) return false;
  processedEventExpiry.set(id, record.expiresAt);
  return true;
}

/** Mark an event id handled, prune expired ids, and persist. */
export async function markEventProcessed(id: string): Promise<void> {
  const now = Date.now();
  const expiresAt = now + PROCESSED_EVENT_TTL_MS;
  const key = feltId("slack_processed", id);
  const collection = managedFeltDb().collection<ProcessedEvent>(PROCESSED_EVENTS_COLLECTION);
  let current = await collection.get(key);
  if (!current) {
    try {
      await managedFeltDb().transaction((tx) => {
        tx.collection<ProcessedEvent>(PROCESSED_EVENTS_COLLECTION).set(key, {
          id: key, eventId: id, expiresAt,
        }, { requireAbsent: true });
      }, { transactionId: `opensession:slack-processed:${key}:${expiresAt}` });
      current = await collection.get(key);
    } catch (error) {
      current = await collection.get(key);
      if (!current) throw error;
    }
  }
  for (let attempt = 0; current && current.expiresAt < expiresAt; attempt++) {
    if (!Number.isSafeInteger(current.__version))
      throw new Error(`Slack processed event ${id} has no FeltDB authority version`);
    const result = await collection.updateIfVersion(key, current.__version!, { expiresAt });
    if (result.updated) break;
    current = await collection.get(key);
    if (!current) throw new Error(`Slack processed event ${id} disappeared during update`);
    if (attempt === 4) throw new Error(`Slack processed event ${id} remained contended`);
  }
  processedEventExpiry.set(id, expiresAt);
  for (const [k, exp] of processedEventExpiry) if (exp <= now) processedEventExpiry.delete(k);
}

export let slackTeamId = "";
export let slackBotUserId = "";

export function setSlackTeamId(id: string) {
  slackTeamId = id;
}
export function setSlackBotUserId(id: string) {
  slackBotUserId = id;
}

// ---------------------------------------------------------------------------
// Session key helper
// ---------------------------------------------------------------------------

export function getSessionKey(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}-${threadTs}` : channel;
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

const SLACK_SESSIONS_COLLECTION = "opensession_slack_sessions";
const SLACK_SESSIONS_MIGRATION = "slack-session-json-to-managed-feltdb-v1";
type StoredSlackSession = {
  id: string;
  sessionKey: string;
  payload: SlackSession;
  state: "active" | "deleted";
  lastActivityMs: number;
  updatedAt: number;
  __version?: number;
};

function slackSessionId(key: string): string { return feltId("slack_session", key); }

/** Read-modify-write, not a projection. Writers outside the loop add fields
 *  such as agent-session-sync's piSessionId. Undefined in-memory fields do not
 *  overwrite durable values; an explicit null does. */
export async function saveSession(
  session: SlackSession,
  db: StateFirstDB = managedFeltDb(),
): Promise<void> {
  const key = getSessionKey(session.channel, session.threadTs);
  const id = slackSessionId(key);
  const collection = db.collection<StoredSlackSession>(SLACK_SESSIONS_COLLECTION);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await collection.get(id);
    const existing: SlackSessionFile = current?.payload ?? {};
    const patch = Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined));
    const lastActivity = new Date().toISOString();
    const payload = {
      ...existing,
      ...patch,
      codexThreadId: session.codexThreadId ?? existing.codexThreadId ?? null,
      lastActivity,
    } as SlackSession;
    const record: StoredSlackSession = {
      id, sessionKey: key, payload, state: "active",
      lastActivityMs: Date.parse(lastActivity), updatedAt: Date.now(),
    };
    if (!current) {
      try {
        await db.transaction((tx) => {
          tx.collection<StoredSlackSession>(SLACK_SESSIONS_COLLECTION)
            .set(id, record, { requireAbsent: true });
        }, { transactionId: `opensession:slack-session:create:${id}` });
        persistedSlackSessions.set(key, payload);
        return;
      } catch (error) {
        if (!await collection.get(id)) throw error;
        continue;
      }
    }
    if (!Number.isSafeInteger(current.__version))
      throw new Error(`Slack session ${key} has no FeltDB authority version`);
    const result = await collection.updateIfVersion(id, current.__version!, record);
    if (result.updated) {
      persistedSlackSessions.set(key, payload);
      return;
    }
    if (attempt === 4) throw new Error(`Slack session ${key} remained contended`);
  }
}

export async function loadSession(
  key: string,
  db: StateFirstDB = managedFeltDb(),
): Promise<SlackSession | null> {
  try {
    const stored = await db.collection<StoredSlackSession>(SLACK_SESSIONS_COLLECTION)
      .get(slackSessionId(key));
    return stored?.state === "active" ? stored.payload : null;
  } catch {
    return null;
  }
}

/** Sessions with no activity for this long aren't restored on startup. A reply
 *  in an old thread still revives its session — every handler falls back to
 *  loadSession(sessionKey) when the key isn't in activeSessions. */
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadActiveSessionsOnStartup(
  db: StateFirstDB = managedFeltDb(),
): Promise<void> {
  console.log("[slack] Loading active sessions from managed FeltDB...");
  await migrateLegacySlackSessions(db);
  const cutoff = Date.now() - STALE_SESSION_MS;
  const records: StoredSlackSession[] = [];
  if (db.runtime().runtime === "remote") {
    let cursor: string | undefined;
    do {
      const page = await db.query<StoredSlackSession>({
        collection: SLACK_SESSIONS_COLLECTION,
        where: [{ field: "state", eq: "active" }],
        orderBy: [{ field: "lastActivityMs", direction: "desc" }],
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      records.push(...page.records);
      cursor = page.exhausted ? undefined : page.nextCursor;
      if (!page.exhausted && !cursor) throw new Error("FeltDB Slack session cursor is missing");
    } while (cursor);
  } else {
    records.push(...(await db.collection<StoredSlackSession>(SLACK_SESSIONS_COLLECTION).all())
      .filter((record) => record.state === "active"));
  }
  for (const record of records) {
    persistedSlackSessions.set(record.sessionKey, record.payload);
    if (record.lastActivityMs > cutoff && record.payload.claudeSessionId) {
      activeSessions.set(record.sessionKey, record.payload);
      console.log(`[slack] Restored session: ${record.sessionKey}`);
    }
  }
}

async function migrateLegacySlackSessions(db: StateFirstDB): Promise<void> {
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (await migrations.get(SLACK_SESSIONS_MIGRATION)) return;
  const files = existsSync(SESSION_DIR)
    ? readdirSync(SESSION_DIR).filter((file) => file.endsWith(".json"))
    : [];
  for (const file of files) {
    const path = `${SESSION_DIR}/${file}`;
    let value: Partial<SlackSession>;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch { continue; }
    if (!value.channel || !value.threadTs || !value.userId) continue;
    const key = getSessionKey(value.channel, value.threadTs);
    const id = slackSessionId(key);
    let lastActivityMs = Date.parse(value.lastActivity || value.createdAt || "");
    if (!lastActivityMs) lastActivityMs = statSync(path).mtimeMs;
    const payload = {
      ...value,
      createdAt: value.createdAt || new Date(lastActivityMs).toISOString(),
      lastActivity: value.lastActivity || new Date(lastActivityMs).toISOString(),
    } as SlackSession;
    const record: StoredSlackSession = {
      id, sessionKey: key, payload, state: "active",
      lastActivityMs, updatedAt: Date.now(),
    };
    try {
      await db.transaction((tx) => {
        tx.collection<StoredSlackSession>(SLACK_SESSIONS_COLLECTION)
          .set(id, record, { requireAbsent: true });
      }, { transactionId: `opensession:slack-session:migrate:${id}` });
    } catch (error) {
      if (!await db.collection(SLACK_SESSIONS_COLLECTION).get(id)) throw error;
    }
    unlinkSync(path);
  }
  await db.transaction((tx) => {
    tx.collection("opensession_migrations").set(SLACK_SESSIONS_MIGRATION, {
      id: SLACK_SESSIONS_MIGRATION, completedAt: Date.now(),
    }, { requireAbsent: true });
  }, { transactionId: `opensession:migration:${SLACK_SESSIONS_MIGRATION}` });
}

export async function deleteSession(
  key: string,
  db: StateFirstDB = managedFeltDb(),
): Promise<boolean> {
  const id = slackSessionId(key);
  const collection = db.collection<StoredSlackSession>(SLACK_SESSIONS_COLLECTION);
  const current = await collection.get(id);
  if (!current || current.state === "deleted") return false;
  if (!Number.isSafeInteger(current.__version))
    throw new Error(`Slack session ${key} has no FeltDB authority version`);
  const result = await collection.updateIfVersion(id, current.__version!, {
    state: "deleted",
    updatedAt: Date.now(),
  });
  if (!result.updated) throw new Error(`Slack session ${key} changed during deletion`);
  persistedSlackSessions.delete(key);
  activeSessions.delete(key);
  return true;
}
