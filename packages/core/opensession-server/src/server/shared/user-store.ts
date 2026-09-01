import { createHash } from "node:crypto";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "../managed-feltdb";

function canonicalName(identity: string): string {
  const normalized = identity.trim() || "Anonymous";
  const cleaned = normalized.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const hash = createHash("sha256").update(normalized.toLocaleLowerCase()).digest("hex").slice(0, 16);
  return `${cleaned || "Anonymous"}-${hash}`;
}
type StoredUserState<T = unknown> = {
  id: string;
  store: string;
  userKey: string;
  value: T;
  extra?: Record<string, unknown>;
  updatedAt: number;
};

export interface UserStore<T> {
  get(user: string): T;
  set(user: string, value: unknown): Promise<T>;
  entries(): IterableIterator<[string, T]>;
  setByKey(userKey: string, value: unknown): Promise<T>;
}

type ManagedUserStore = {
  name: string;
  initialize(db: StateFirstDB): Promise<void>;
  copy(from: string, to: string): Promise<boolean>;
};
const stores = new Set<ManagedUserStore>();
const COLLECTION = "opensession_user_state";

export const NAME_KEYED_STORES = [
  "drafts", "hides", "lanes", "pins", "reads", "settlements", "snoozes",
  "tab-colors", "ui-prefs",
] as const;

export async function initializeManagedUserStores(db: StateFirstDB = managedFeltDb()): Promise<void> {
  for (const store of stores) await store.initialize(db);
}

export async function renameUserState(from: string, to: string): Promise<string[]> {
  const a = from.trim();
  const b = to.trim();
  if (!a || !b || canonicalName(a) === canonicalName(b)) return [];
  const carried: string[] = [];
  for (const store of stores)
    if ((NAME_KEYED_STORES as readonly string[]).includes(store.name) && await store.copy(a, b)) carried.push(store.name);
  return carried;
}

function storageId(name: string, userKey: string): string {
  return `user_state_${createHash("sha256").update(`${name}:${userKey}`).digest("hex")}`;
}

export function userStore<T>(options: {
  name: string;
  field: string;
  clean: (raw: unknown) => T;
  identity?: (user: string) => string | null;
  extra?: () => Record<string, unknown>;
}): UserStore<T> {
  const { name, clean, extra } = options;
  const identity = options.identity ?? ((user: string) => user ?? "");
  const values = new Map<string, T>();
  let authority: StateFirstDB | undefined;
  const persist = async (userKey: string, raw: unknown): Promise<T> => {
    const value = clean(raw);
    const db = authority ?? managedFeltDb();
    const id = storageId(name, userKey);
    await db.transaction((tx) => {
      tx.collection<StoredUserState<T>>(COLLECTION).set(id, {
        id, store: name, userKey, value, extra: extra?.(), updatedAt: Date.now(),
      });
    }, { transactionId: `opensession:user-state:${name}:${userKey}:${crypto.randomUUID()}` });
    values.set(userKey, value);
    return value;
  };

  const managed: ManagedUserStore = {
    name,
    async initialize(db) {
      authority = db;
      const loaded = db.runtime().runtime === "remote" ? await queryStore<T>(db, name) :
        (await db.collection<StoredUserState<T>>(COLLECTION).all()).filter((record) => record.store === name);
      values.clear();
      for (const record of loaded) values.set(record.userKey, clean(record.value));
    },
    async copy(from, to) {
      const source = canonicalName(from);
      const target = canonicalName(to);
      if (!values.has(source) || values.has(target)) return false;
      await persist(target, values.get(source));
      return true;
    },
  };
  stores.add(managed);

  return {
    get(user) {
      const id = identity(user);
      if (id === null) return clean(undefined);
      return values.get(canonicalName(id)) ?? clean(undefined);
    },
    async set(user, value) {
      const id = identity(user);
      return id === null ? clean(undefined) : persist(canonicalName(id), value);
    },
    entries: () => values.entries(),
    setByKey: persist,
  };
}

async function queryStore<T>(db: StateFirstDB, name: string): Promise<StoredUserState<T>[]> {
  const loaded: StoredUserState<T>[] = [];
  let cursor: string | undefined;
  do {
    const page = await db.query<StoredUserState<T>>({
      collection: COLLECTION,
      where: [{ field: "store", eq: name }],
      orderBy: [{ field: "updatedAt", direction: "desc" }],
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    loaded.push(...page.records);
    cursor = page.exhausted ? undefined : page.nextCursor;
    if (!page.exhausted && !cursor) throw new Error(`FeltDB user store ${name} cursor is missing`);
  } while (cursor);
  return loaded;
}
