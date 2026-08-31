import { createHash } from "node:crypto";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";

const LIVE_CAP = 200;
const TOMBSTONE_CAP = 2_000;
export const MAX_DRAFT_LENGTH = 32_000;
const COLLECTION = "opensession_drafts";

export interface StoredDraft { text: string; updatedAt: string; }
export type DraftMap = Record<string, StoredDraft>;
export interface UpsertResult { draft: StoredDraft | null; applied: boolean; }
type DraftRecord = {
  id: string; userKey: string; sessionId: string; draft: StoredDraft;
  state: "active" | "deleted"; updatedAtMs: number; __version?: number;
};

const records = new Map<string, DraftRecord>();
let draftDb: StateFirstDB | undefined;
const authority = () => draftDb ?? managedFeltDb();

function sanitizeUser(user: string): string {
  const normalized = (user || "").trim() || "Anonymous";
  const cleaned = normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const hash = createHash("sha256").update(normalized.toLocaleLowerCase()).digest("hex").slice(0, 16);
  return `${cleaned || "Anonymous"}-${hash}`;
}
function recordId(userKey: string, sessionId: string): string {
  return `draft_${createHash("sha256").update(`${userKey}:${sessionId}`).digest("hex")}`;
}
function recordsFor(user: string): DraftRecord[] {
  const key = sanitizeUser(user);
  return [...records.values()].filter((record) => record.state === "active" && record.userKey === key);
}

export function getDrafts(user: string): DraftMap {
  const visible: DraftMap = {};
  for (const record of recordsFor(user).sort((a, b) => a.updatedAtMs - b.updatedAtMs))
    if (record.draft.text.trim()) visible[record.sessionId] = record.draft;
  return visible;
}
function currentRecord(user: string, sessionId: string): DraftRecord | undefined {
  return recordsFor(user).filter((record) => record.sessionId === sessionId)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
}

export async function upsertDraft(
  user: string, sessionId: string, text: string, updatedAt: string,
): Promise<UpsertResult> {
  const current = currentRecord(user, sessionId);
  const incoming = Date.parse(updatedAt);
  const stored = current ? Date.parse(current.draft.updatedAt) : 0;
  if (current && Number.isFinite(incoming) && Number.isFinite(stored) &&
    (incoming < stored || (!current.draft.text && incoming <= stored)))
    return { draft: current.draft.text ? current.draft : null, applied: false };

  const userKey = sanitizeUser(user);
  const id = recordId(userKey, sessionId);
  const draft: StoredDraft = { text: text.slice(0, MAX_DRAFT_LENGTH), updatedAt };
  const record: DraftRecord = {
    id, userKey, sessionId, draft, state: "active",
    updatedAtMs: Number.isFinite(incoming) ? incoming : Date.now(),
  };
  await authority().transaction((tx) => {
    tx.collection<DraftRecord>(COLLECTION).set(id, record);
  }, { transactionId: `opensession:draft:${id}:${crypto.randomUUID()}` });
  const committed = await authority().collection<DraftRecord>(COLLECTION).get(id);
  if (!committed) throw new Error(`Draft ${id} did not commit`);
  records.set(id, committed);
  await enforceCap(user);
  return { draft: draft.text.trim() ? draft : null, applied: true };
}

async function enforceCap(user: string): Promise<void> {
  const all = recordsFor(user).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  const live = all.filter((record) => record.draft.text.trim()).slice(LIVE_CAP);
  const tombstones = all.filter((record) => !record.draft.text.trim()).slice(TOMBSTONE_CAP);
  for (const record of [...live, ...tombstones]) await deleteRecord(record);
}
async function deleteRecord(record: DraftRecord): Promise<void> {
  await authority().transaction((tx) => {
    tx.collection<DraftRecord>(COLLECTION).set(record.id, {
      ...record, state: "deleted", updatedAtMs: Date.now(),
    });
  }, { transactionId: `opensession:draft:delete:${record.id}:${crypto.randomUUID()}` });
  records.delete(record.id);
}
export async function purgeDraftsForSessions(ids: string[]): Promise<void> {
  const targets = new Set(ids);
  for (const record of [...records.values()])
    if (record.state === "active" && targets.has(record.sessionId)) await deleteRecord(record);
}

export async function initializeManagedDrafts(db: StateFirstDB = managedFeltDb()): Promise<void> {
  draftDb = db;
  const loaded = db.runtime().runtime === "remote" ? await queryDrafts(db) : await db.collection<DraftRecord>(COLLECTION).all();
  records.clear();
  for (const record of loaded) records.set(record.id, record);
}
async function queryDrafts(db: StateFirstDB): Promise<DraftRecord[]> {
  const loaded: DraftRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await db.query<DraftRecord>({
      collection: COLLECTION, orderBy: [{ field: "updatedAtMs", direction: "desc" }], limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    loaded.push(...page.records);
    cursor = page.exhausted ? undefined : page.nextCursor;
    if (!page.exhausted && !cursor) throw new Error("FeltDB drafts cursor is missing");
  } while (cursor);
  return loaded;
}
export function __draftUserKeyForTest(user: string): string {
  return sanitizeUser(user);
}
