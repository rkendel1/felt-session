import type { StateFirstDB } from "@feltdb/core";
import { createHash } from "node:crypto";
import { extractMemoryQueryTerms, rankMemoryRecords } from "./retrieval";
import {
  DuplicateMemoryError,
  MemoryNotFoundError,
  cleanDetails,
  memoryFingerprint,
  normalizeTags,
  pageLimit,
  prepareCreate,
  uniqueStrings,
  validateKindExpiry,
  validateOptionalDate,
  validateSource,
  validateSummary,
} from "./store";
import { MEMORY_KINDS, MEMORY_STATES, MEMORY_TIERS, type CreateMemoryInput,
  type MemoryFilters, type MemoryPage, type MemoryRecord, type MemorySearchOptions,
  type MemoryState, type MemoryStats, type PageOptions, type RelatedCandidate,
  type UpdateMemoryInput } from "./types";
import type { LegacySqliteMemorySnapshot } from "./store";

const RECORDS = "opensession_memory_records";
const ALIASES = "opensession_memory_legacy_aliases";
const META = "opensession_memory_meta";

interface LegacyAlias {
  id: string;
  sourceKey: string;
  legacyId: string;
  memoryId: string;
  importedAt: string;
  rawJson?: string;
  sourcePresent: boolean;
  recordOwned: boolean;
}

interface MetaRecord { id: string; value: string; updatedAt: string }

const clone = <T>(value: T): T => structuredClone(value);
const aliasId = (sourceKey: string, legacyId: string) =>
  createHash("sha256").update(sourceKey).update("\0").update(legacyId).digest("hex");

function validEnum<T extends string>(value: T, values: readonly T[], label: string): T {
  if (!values.includes(value)) throw new Error(`Invalid ${label}: ${String(value)}.`);
  return value;
}

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value?: string): any {
  if (!value) return undefined;
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return undefined; }
}

export class ManagedMemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly aliases = new Map<string, LegacyAlias>();
  private readonly meta = new Map<string, MetaRecord>();

  constructor(private readonly db: StateFirstDB) {}

  async initialize(): Promise<void> {
    this.records.clear();
    for (const record of await this.db.collection<MemoryRecord>(RECORDS).all()) this.records.set(record.id, record);
    this.aliases.clear();
    for (const alias of await this.db.collection<LegacyAlias>(ALIASES).all()) this.aliases.set(alias.id, alias);
    this.meta.clear();
    for (const value of await this.db.collection<MetaRecord>(META).all()) this.meta.set(value.id, value);
  }

  async importSqliteSnapshot(snapshot: LegacySqliteMemorySnapshot): Promise<void> {
    for (const record of snapshot.records) await this.db.transaction((tx) => {
      tx.collection<MemoryRecord>(RECORDS).set(record.id, record);
    }, { transactionId: `opensession:memory:sqlite-record:${record.id}` });
    for (const item of snapshot.aliases) {
      const id = aliasId(item.sourceKey, item.legacyId);
      const alias: LegacyAlias = { id, ...item };
      await this.db.transaction((tx) => {
        tx.collection<LegacyAlias>(ALIASES).set(id, alias);
      }, { transactionId: `opensession:memory:sqlite-alias:${id}` });
    }
    for (const item of snapshot.metadata) {
      const record: MetaRecord = { id: item.key, value: item.value, updatedAt: item.updatedAt };
      await this.db.transaction((tx) => {
        tx.collection<MetaRecord>(META).set(item.key, record);
      }, { transactionId: `opensession:memory:sqlite-meta:${Buffer.from(item.key).toString("base64url")}` });
    }
    await this.initialize();
  }

  get(id: string): MemoryRecord | null {
    const direct = this.records.get(id);
    if (direct) return clone(direct);
    const alias = [...this.aliases.values()].filter((item) => item.legacyId === id)
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
    return alias && this.records.has(alias.memoryId) ? clone(this.records.get(alias.memoryId)!) : null;
  }

  private require(id: string): MemoryRecord {
    const record = this.get(id);
    if (!record) throw new MemoryNotFoundError(id);
    return record;
  }

  private duplicate(scopeKey: string, fingerprint: string, exceptId?: string): MemoryRecord | undefined {
    return [...this.records.values()].find((record) =>
      record.scopeKey === scopeKey && record.fingerprint === fingerprint && record.id !== exceptId);
  }

  async create(input: CreateMemoryInput, now = new Date()): Promise<MemoryRecord> {
    const record = prepareCreate(input, now);
    const duplicate = this.duplicate(record.scopeKey, record.fingerprint);
    if (duplicate) throw new DuplicateMemoryError(record.scopeKey, duplicate.id);
    await this.db.transaction((tx) => {
      tx.collection<MemoryRecord>(RECORDS).set(record.id, record, { requireAbsent: true });
    }, { transactionId: `opensession:memory:create:${record.id}` });
    this.records.set(record.id, clone(record));
    return clone(record);
  }

  async update(id: string, patch: UpdateMemoryInput, now = new Date()): Promise<MemoryRecord> {
    const current = this.require(id);
    if (current.state !== "active") throw new Error("Only active memories can be updated.");
    const summary = patch.summary === undefined ? current.summary : validateSummary(patch.summary);
    const details = patch.details === undefined ? current.details : cleanDetails(patch.details);
    const kind = patch.kind === undefined ? current.kind : validEnum(patch.kind, MEMORY_KINDS, "kind");
    const tier = patch.tier === undefined ? current.tier : validEnum(patch.tier, MEMORY_TIERS, "tier");
    const source = patch.source === undefined ? current.source : validateSource(patch.source);
    const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags);
    const expiresAt = patch.expiresAt === undefined ? current.expiresAt : validateOptionalDate(patch.expiresAt);
    validateKindExpiry(kind, expiresAt);
    const fingerprint = memoryFingerprint(summary, details);
    const duplicate = this.duplicate(current.scopeKey, fingerprint, current.id);
    if (duplicate) throw new DuplicateMemoryError(current.scopeKey, duplicate.id);
    const next: MemoryRecord = { ...current, summary, details, kind, tier, source, tags, expiresAt,
      fingerprint, updatedAt: now.toISOString(),
      state: expiresAt && Date.parse(expiresAt) <= now.getTime() ? "expired" : "active" };
    await this.put(next, "update");
    return clone(next);
  }

  private async put(record: MemoryRecord, kind: string): Promise<void> {
    await this.db.transaction((tx) => { tx.collection<MemoryRecord>(RECORDS).set(record.id, record); },
      { transactionId: `opensession:memory:${kind}:${crypto.randomUUID()}` });
    this.records.set(record.id, clone(record));
  }

  async delete(id: string): Promise<boolean> {
    const record = this.get(id);
    if (!record) return false;
    await this.db.transaction((tx) => { tx.collection<MemoryRecord>(RECORDS).delete(record.id); },
      { transactionId: `opensession:memory:delete:${crypto.randomUUID()}` });
    this.records.delete(record.id);
    return true;
  }

  async archive(id: string, now = new Date(), supersededBy?: string): Promise<MemoryRecord> {
    const record = this.require(id);
    if (record.state !== "active" && record.state !== "expired")
      throw new Error("Only active or expired memories can be archived.");
    const next = { ...record, state: "archived" as const, updatedAt: now.toISOString(), supersededBy };
    await this.put(next, "archive"); return clone(next);
  }

  async restore(id: string, now = new Date()): Promise<MemoryRecord> {
    const record = this.require(id);
    if (record.state !== "archived") throw new Error("Only archived memories can be restored.");
    const state: MemoryState = record.expiresAt && Date.parse(record.expiresAt) <= now.getTime() ? "expired" : "active";
    const next = { ...record, state, supersededBy: undefined, updatedAt: now.toISOString() };
    await this.put(next, "restore"); return clone(next);
  }

  async confirm(id: string, now = new Date()): Promise<MemoryRecord> {
    const record = this.require(id);
    if (record.state !== "active") throw new Error("Only active memories can be confirmed.");
    const next = { ...record, lastConfirmedAt: now.toISOString(), updatedAt: now.toISOString() };
    await this.put(next, "confirm"); return clone(next);
  }

  async supersede(input: CreateMemoryInput & { supersedes: string[] }, now = new Date()): Promise<MemoryRecord> {
    const ids = uniqueStrings(input.supersedes).map((id) => this.require(id).id);
    if (!ids.length) throw new Error("supersede requires at least one record id.");
    const replacement = prepareCreate({ ...input, supersedes: ids }, now);
    for (const id of ids) {
      const old = this.require(id);
      if (old.scopeKey !== replacement.scopeKey) throw new Error(`Cannot supersede memory "${id}" across scopes.`);
      if (old.state !== "active") throw new Error(`Only active memories can be superseded (${id}).`);
    }
    const duplicate = this.duplicate(replacement.scopeKey, replacement.fingerprint);
    if (duplicate) throw new DuplicateMemoryError(replacement.scopeKey, duplicate.id);
    const retired = ids.map((id) => ({ ...this.require(id), state: "superseded" as const,
      supersededBy: replacement.id, updatedAt: replacement.updatedAt }));
    await this.db.transaction((tx) => {
      const collection = tx.collection<MemoryRecord>(RECORDS);
      collection.set(replacement.id, replacement, { requireAbsent: true });
      for (const record of retired) collection.set(record.id, record);
    }, { transactionId: `opensession:memory:supersede:${replacement.id}` });
    this.records.set(replacement.id, clone(replacement));
    for (const record of retired) this.records.set(record.id, record);
    return clone(replacement);
  }

  async expireDue(now = new Date()): Promise<number> {
    const due = [...this.records.values()].filter((record) => record.state === "active" && record.expiresAt &&
      Date.parse(record.expiresAt) <= now.getTime()).map((record) => ({ ...record, state: "expired" as const,
        updatedAt: now.toISOString() }));
    if (!due.length) return 0;
    await this.db.transaction((tx) => {
      const collection = tx.collection<MemoryRecord>(RECORDS);
      for (const record of due) collection.set(record.id, record);
    }, { transactionId: `opensession:memory:expire:${crypto.randomUUID()}` });
    for (const record of due) this.records.set(record.id, record);
    return due.length;
  }

  private filtered(filters: MemoryFilters): MemoryRecord[] {
    const states = filters.states ?? ["active"];
    const tags = filters.tags ? normalizeTags(filters.tags) : [];
    return [...this.records.values()].filter((record) =>
      (!filters.scopeKeys?.length || filters.scopeKeys.includes(record.scopeKey)) &&
      (!filters.kinds?.length || filters.kinds.includes(record.kind)) &&
      (!filters.tiers?.length || filters.tiers.includes(record.tier)) &&
      states.includes(record.state) &&
      tags.every((tag) => record.tags.includes(tag)) &&
      (filters.confirmed === undefined || (filters.confirmed ? !!record.lastConfirmedAt : !record.lastConfirmedAt)));
  }

  list(filters: MemoryFilters = {}, page: PageOptions = {}): MemoryPage {
    const limit = pageLimit(page.limit);
    const cursor = decodeCursor(page.cursor) as { createdAt?: string; id?: string } | undefined;
    const rows = this.filtered(filters).filter((record) => !cursor?.createdAt ||
      record.createdAt < cursor.createdAt || (record.createdAt === cursor.createdAt && record.id < (cursor.id ?? "")))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const items = rows.slice(0, limit).map(clone);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined };
  }

  search(query: string, options: MemorySearchOptions = {}): MemoryPage {
    const limit = pageLimit(options.limit);
    const offset = Number(decodeCursor(options.cursor)?.offset) || 0;
    const filtered = this.filtered(options);
    const scopes = options.scopeKeys?.length ? options.scopeKeys : [...new Set(filtered.map((record) => record.scopeKey))];
    const terms = extractMemoryQueryTerms(query);
    const ranked = rankMemoryRecords(filtered, query, { scopeKeys: scopes })
      .map((item) => item.record)
      .filter((record) => options.matchAny || terms.every((term) =>
        `${record.summary}\n${record.details ?? ""}\n${record.tags.join(" ")}`.toLocaleLowerCase().includes(term)));
    const items = ranked.slice(offset, offset + limit).map((record) => {
      const next = clone(record); if (!options.includeDetails) delete next.details; return next;
    });
    return { items, nextCursor: ranked.length > offset + limit ? encodeCursor({ offset: offset + limit }) : undefined };
  }

  findRelatedCandidates(input: Pick<CreateMemoryInput, "scopeKey" | "summary" | "details" | "tags">, limit = 5): RelatedCandidate[] {
    const fingerprint = memoryFingerprint(validateSummary(input.summary), cleanDetails(input.details));
    return rankMemoryRecords([...this.records.values()].filter((record) => record.scopeKey === input.scopeKey &&
      record.state === "active" && record.fingerprint !== fingerprint),
      [input.summary, ...(input.tags ?? [])].join(" "), { scopeKeys: [input.scopeKey] })
      .slice(0, Math.min(Math.max(limit, 1), 20)).map((item) => ({ record: clone(item.record), score: item.score }));
  }

  async markRetrieved(ids: string[], now = new Date()): Promise<number> {
    const records = uniqueStrings(ids).flatMap((id) => this.records.has(id) ? [this.records.get(id)!] : [])
      .map((record) => ({ ...record, retrievalCount: record.retrievalCount + 1, lastRetrievedAt: now.toISOString() }));
    if (!records.length) return 0;
    await this.db.transaction((tx) => {
      const collection = tx.collection<MemoryRecord>(RECORDS);
      for (const record of records) collection.set(record.id, record);
    }, { transactionId: `opensession:memory:retrieved:${crypto.randomUUID()}` });
    for (const record of records) this.records.set(record.id, record);
    return records.length;
  }

  stats(): MemoryStats {
    const byScope = new Map<string, MemoryStats["scopes"][number]>();
    for (const record of this.records.values()) {
      const scope = byScope.get(record.scopeKey) ?? { scopeKey: record.scopeKey, total: 0, active: 0,
        pinned: 0, review: 0, ambientSummaryChars: 0 };
      scope.total++;
      if (record.state === "active") {
        scope.active++;
        if (!record.lastConfirmedAt) scope.review++;
        if (record.tier === "pinned") { scope.pinned++; scope.ambientSummaryChars += record.summary.length; }
      }
      byScope.set(record.scopeKey, scope);
    }
    const scopes = [...byScope.values()].sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
    return scopes.reduce<MemoryStats>((all, scope) => ({ total: all.total + scope.total,
      active: all.active + scope.active, pinned: all.pinned + scope.pinned, review: all.review + scope.review,
      ambientSummaryChars: all.ambientSummaryChars + scope.ambientSummaryChars, scopes: all.scopes }),
      { total: 0, active: 0, pinned: 0, review: 0, ambientSummaryChars: 0, scopes });
  }

  metadata(key: string): string | null { return this.meta.get(key)?.value ?? null; }
  async setMetadata(key: string, value: string, now = new Date()): Promise<void> {
    const record = { id: key, value, updatedAt: now.toISOString() };
    await this.db.transaction((tx) => { tx.collection<MetaRecord>(META).set(key, record); },
      { transactionId: `opensession:memory:meta:${crypto.randomUUID()}` });
    this.meta.set(key, record);
  }

  legacyMapping(sourceKey: string, legacyId: string): string | null {
    return this.aliases.get(aliasId(sourceKey, legacyId))?.memoryId ?? null;
  }
  legacyRaw(legacyId: string): string | null {
    return [...this.aliases.values()].filter((item) => item.legacyId === legacyId && item.rawJson)
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0]?.rawJson ?? null;
  }

  async importLegacy(sourceKey: string, legacyId: string, input: CreateMemoryInput, state: MemoryState,
    supersededBy?: string, rawJson?: string, now = new Date()): Promise<{ record: MemoryRecord; imported: boolean }> {
    const id = aliasId(sourceKey, legacyId);
    const existingAlias = this.aliases.get(id);
    if (existingAlias && this.records.has(existingAlias.memoryId) && existingAlias.rawJson === rawJson && existingAlias.sourcePresent)
      return { record: clone(this.records.get(existingAlias.memoryId)!), imported: false };
    const prepared = { ...prepareCreate(input, now), state, supersededBy };
    const duplicate = this.duplicate(prepared.scopeKey, prepared.fingerprint, existingAlias?.memoryId);
    const record = duplicate ?? (existingAlias?.recordOwned && this.records.has(existingAlias.memoryId)
      ? { ...prepared, id: existingAlias.memoryId } : prepared);
    const alias: LegacyAlias = { id, sourceKey, legacyId, memoryId: record.id, importedAt: now.toISOString(),
      rawJson, sourcePresent: true, recordOwned: !duplicate };
    await this.db.transaction((tx) => {
      tx.collection<MemoryRecord>(RECORDS).set(record.id, record);
      tx.collection<LegacyAlias>(ALIASES).set(id, alias);
    }, { transactionId: `opensession:memory:legacy:${id}:${crypto.randomUUID()}` });
    this.records.set(record.id, clone(record)); this.aliases.set(id, alias);
    return { record: clone(record), imported: !existingAlias };
  }

  async reconcileLegacySource(sourceKey: string, presentLegacyIds: Set<string>, now = new Date()): Promise<number> {
    const removed = [...this.aliases.values()].filter((item) => item.sourceKey === sourceKey &&
      item.sourcePresent && !presentLegacyIds.has(item.legacyId));
    if (!removed.length) return 0;
    const changedRecords: MemoryRecord[] = [];
    for (const alias of removed) {
      alias.sourcePresent = false;
      const otherPresent = [...this.aliases.values()].some((item) => item.id !== alias.id &&
        item.memoryId === alias.memoryId && item.sourcePresent);
      if (!otherPresent && alias.recordOwned && this.records.has(alias.memoryId)) {
        changedRecords.push({ ...this.records.get(alias.memoryId)!, state: "archived", updatedAt: now.toISOString() });
      }
    }
    await this.db.transaction((tx) => {
      for (const alias of removed) tx.collection<LegacyAlias>(ALIASES).set(alias.id, alias);
      for (const record of changedRecords) tx.collection<MemoryRecord>(RECORDS).set(record.id, record);
    }, { transactionId: `opensession:memory:reconcile:${crypto.randomUUID()}` });
    for (const alias of removed) this.aliases.set(alias.id, clone(alias));
    for (const record of changedRecords) this.records.set(record.id, record);
    return removed.length;
  }

  async setLegacyRelations(id: string, supersedes: string[], supersededBy?: string): Promise<MemoryRecord> {
    const next = { ...this.require(id), supersedes: uniqueStrings(supersedes), supersededBy };
    await this.put(next, "legacy-relations"); return clone(next);
  }

  close(): void {}
}
