import type { Collection, StateFirstDB } from "@feltdb/core";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import type { NativeSessionFile } from "./types";

const COLLECTION = "opensession_sessions";
const MIGRATIONS = "opensession_migrations";
const MIGRATION_ID = "native-session-json-to-managed-feltdb-v1";
const NON_SESSION_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
  "prompt-queues.json",
  "active-at-shutdown.json",
  "active-runs.json",
  "processed-events.json",
]);

type StoredNativeSession = {
  id: string;
  payload: NativeSessionFile;
  updatedAt: number;
  __version?: number;
};

let db: StateFirstDB | undefined;
let records: Collection<StoredNativeSession> | undefined;
const cache = new Map<string, NativeSessionFile>();

function candidateFiles(): string[] {
  if (!existsSync(OPENSESSION_SESSIONS_DIR)) return [];
  return readdirSync(OPENSESSION_SESSIONS_DIR)
    .filter((name) => name.endsWith(".json") && !NON_SESSION_FILES.has(name))
    .filter((name) => {
      try {
        const value = JSON.parse(readFileSync(`${OPENSESSION_SESSIONS_DIR}/${name}`, "utf8"));
        const stem = basename(name, ".json");
        return !!value && typeof value === "object" &&
          (value.id === stem || /^(?:os|bks|slack|linear)-/.test(stem));
      } catch { return false; }
    });
}

function authority(): { db: StateFirstDB; records: Collection<StoredNativeSession> } {
  if (!db || !records) throw new Error("Managed native sessions have not been initialized");
  return { db, records };
}

export async function initializeManagedNativeSessions(database: StateFirstDB): Promise<void> {
  db = database;
  records = database.collection<StoredNativeSession>(COLLECTION);
  cache.clear();
  for (const record of await records.all()) cache.set(record.id, record.payload);

  const receipt = await database.collection<{ id: string }>(MIGRATIONS).get(MIGRATION_ID);
  const files = candidateFiles();
  if (!receipt) {
    for (const name of files) {
      const id = basename(name, ".json");
      if (cache.has(id)) continue;
      const payload = JSON.parse(
        readFileSync(`${OPENSESSION_SESSIONS_DIR}/${name}`, "utf8"),
      ) as NativeSessionFile;
      await database.transaction((tx) => {
        tx.collection<StoredNativeSession>(COLLECTION).set(id, {
          id,
          payload,
          updatedAt: Date.now(),
        }, { requireAbsent: true });
      }, { transactionId: `opensession:migration:${MIGRATION_ID}:${id}` });
      cache.set(id, payload);
    }
    for (const name of files) {
      const id = basename(name, ".json");
      if (!await records.get(id))
        throw new Error(`Managed native-session migration did not verify ${id}`);
    }
    await database.transaction((tx) => {
      tx.collection(MIGRATIONS).set(MIGRATION_ID, {
        id: MIGRATION_ID,
        completedAt: Date.now(),
        migrated: files.length,
      }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION_ID}:complete` });
  }
  for (const name of files) {
    const id = basename(name, ".json");
    if (!await records.get(id))
      throw new Error(`Refusing to remove unverified native-session source ${id}`);
    unlinkSync(`${OPENSESSION_SESSIONS_DIR}/${name}`);
  }
}

export function nativeSessionMetadata(id: string): NativeSessionFile | undefined {
  const value = cache.get(id);
  return value ? structuredClone(value) : undefined;
}

export function nativeSessionMetadataEntries(): Array<[string, NativeSessionFile]> {
  return [...cache].map(([id, value]) => [id, structuredClone(value)]);
}

export async function updateNativeSessionMetadata(
  id: string,
  mutate: (current: NativeSessionFile) => NativeSessionFile,
): Promise<NativeSessionFile> {
  const state = authority();
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await state.records.get(id);
    const prior = current?.payload ?? ({} as NativeSessionFile);
    const next = mutate(structuredClone(prior)) ?? prior;
    const rev = (prior as { rev?: unknown }).rev;
    (next as { rev?: number }).rev = (typeof rev === "number" ? rev : 0) + 1;
    if (!current) {
      try {
        await state.db.transaction((tx) => {
          tx.collection<StoredNativeSession>(COLLECTION).set(id, {
            id, payload: next, updatedAt: Date.now(),
          }, { requireAbsent: true });
        }, { transactionId: `opensession:native-session:create:${id}:${crypto.randomUUID()}` });
        cache.set(id, next);
        return structuredClone(next);
      } catch { continue; }
    }
    if (!Number.isInteger(current.__version))
      throw new Error(`Managed native session ${id} has no authority version`);
    const result = await state.records.updateIfVersion(id, current.__version!, {
      payload: next,
      updatedAt: Date.now(),
    });
    if (result.updated) {
      cache.set(id, next);
      return structuredClone(next);
    }
  }
  throw new Error(`Managed native session ${id} remained contended`);
}

export async function deleteNativeSessionMetadata(id: string): Promise<void> {
  const state = authority();
  const current = await state.records.get(id);
  if (!current) {
    cache.delete(id);
    const legacy = `${OPENSESSION_SESSIONS_DIR}/${id}.json`;
    if (existsSync(legacy)) unlinkSync(legacy);
    return;
  }
  if (!Number.isInteger(current.__version))
    throw new Error(`Managed native session ${id} has no authority version`);
  await state.db.transaction((tx) => {
    tx.collection(COLLECTION).delete(id, { ifVersion: current.__version! });
  }, { transactionId: `opensession:native-session:delete:${id}:${crypto.randomUUID()}` });
  cache.delete(id);
}

/** In-memory seam for tests that construct session fixtures after boot. */
export function __setNativeSessionMetadataForTest(
  id: string,
  payload: NativeSessionFile | undefined,
): void {
  if (payload) cache.set(id, structuredClone(payload));
  else cache.delete(id);
}
