import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";

type StoredValue<T> = {
  id: string;
  value: T;
  state: "active" | "deleted";
  updatedAt: number;
  __version?: number;
};

export class ManagedValueRegistry<T> {
  private readonly values = new Map<string, T>();
  private db: StateFirstDB | undefined;

  constructor(
    private readonly collectionName: string,
    private readonly migrationId: string,
    private readonly legacyPath: string,
  ) {}

  get(id: string): T | undefined { return this.values.get(id); }
  has(id: string): boolean { return this.values.has(id); }
  entries(): IterableIterator<[string, T]> { return this.values.entries(); }

  async initialize(authority: StateFirstDB = managedFeltDb()): Promise<void> {
    this.db = authority;
    const migrations = authority.collection<{ id: string }>("opensession_migrations");
    if (!await migrations.get(this.migrationId)) {
      let legacy: Record<string, T> = {};
      try {
        if (existsSync(this.legacyPath)) legacy = JSON.parse(readFileSync(this.legacyPath, "utf8"));
      } catch {}
      for (const [id, value] of Object.entries(legacy)) await this.write(id, value, false);
      await authority.transaction((tx) => {
        tx.collection("opensession_migrations").set(
          this.migrationId,
          { id: this.migrationId, completedAt: Date.now() },
          { requireAbsent: true },
        );
      }, { transactionId: `opensession:migration:${this.migrationId}` });
      if (existsSync(this.legacyPath)) unlinkSync(this.legacyPath);
    }
    const records = authority.runtime().runtime === "remote"
      ? await this.queryAll(authority)
      : (await authority.collection<StoredValue<T>>(this.collectionName).all())
          .filter((record) => record.state === "active");
    this.values.clear();
    for (const record of records) this.values.set(record.id, record.value);
  }

  async set(id: string, value: T | undefined): Promise<void> {
    await this.write(id, value, true);
  }

  private async write(id: string, value: T | undefined, updateCache: boolean): Promise<void> {
    const authority = this.db ?? managedFeltDb();
    const record: StoredValue<T> = {
      id,
      value: value as T,
      state: value === undefined ? "deleted" : "active",
      updatedAt: Date.now(),
    };
    await authority.transaction((tx) => {
      tx.collection<StoredValue<T>>(this.collectionName).set(id, record);
    }, { transactionId: `opensession:registry:${this.collectionName}:${id}:${crypto.randomUUID()}` });
    if (updateCache) {
      if (value === undefined) this.values.delete(id);
      else this.values.set(id, value);
    }
  }

  private async queryAll(authority: StateFirstDB): Promise<StoredValue<T>[]> {
    const records: StoredValue<T>[] = [];
    let cursor: string | undefined;
    do {
      const page = await authority.query<StoredValue<T>>({
        collection: this.collectionName,
        where: [{ field: "state", eq: "active" }],
        orderBy: [{ field: "updatedAt", direction: "desc" }],
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      records.push(...page.records);
      cursor = page.exhausted ? undefined : page.nextCursor;
      if (!page.exhausted && !cursor) throw new Error(`FeltDB ${this.collectionName} cursor is missing`);
    } while (cursor);
    return records;
  }
}
