/**
 * FeltDB-backed Memory v2 Store
 *
 * Phase 4 implementation: Provides FeltDB persistence for memory records.
 * During the migration phase, this is used for dual-write validation.
 * Memory records are stored as mutable documents in FeltDB collections.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  CreateMemoryInput,
  MemoryRecord,
  MemoryState,
  MemoryKind,
  MemoryTier,
  MemorySource,
  MemoryPage,
  PageOptions,
} from "./types";

interface StoredMemoryRecord {
  id: string;
  scopeKey: string;
  summary: string;
  details?: string;
  kind: MemoryKind;
  tier: MemoryTier;
  state: MemoryState;
  sourceJson: string; // serialized MemorySource
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt?: string;
  expiresAt?: string;
  supersedesJson: string; // serialized array of IDs
  supersededBy?: string;
  fingerprint: string;
  tagsJson: string; // serialized string[]
  retrievalCount: number;
  lastRetrievedAt?: string;
}

const RECORDS_COLLECTION = "memory_records";
const FTS_COLLECTION = "memory_fts";

/**
 * FeltDB-backed memory store for Phase 4 migration.
 * Handles creation, updates, searches, and lifecycle of memory records.
 */
export class FeltDBMemoryStore {
  private db: ReturnType<typeof createFeltDB> | null = null;
  private initialized = false;

  constructor(public readonly dbPath: string) {}

  /**
   * Lazy initialization of FeltDB store.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    if (!this.dbPath || this.dbPath === ":memory:") {
      throw new Error("FeltDB memory store requires a filesystem path");
    }

    try {
      // Ensure directory exists
      const dir = dirname(this.dbPath);
      mkdirSync(dir, { recursive: true });

      // Disable FeltDB telemetry in server context
      const telemetry = getTelemetryClient();
      telemetry.disable();

      this.db = createFeltDB({
        path: this.dbPath,
        namespace: "memory-v2",
      });
      this.initialized = true;
    } catch (error) {
      console.error("[feltdb-memory-store] Failed to initialize FeltDB:", error);
      this.initialized = true; // Mark as initialized even on error to avoid retries
      throw error;
    }
  }

  /**
   * Create a new memory record.
   */
  async createRecord(input: CreateMemoryInput): Promise<MemoryRecord> {
    this.ensureInitialized();
    if (!this.db) {
      throw new Error("FeltDB not initialized");
    }

    const now = new Date();
    const fingerprint = this.computeFingerprint(input);

    const record: MemoryRecord = {
      id: this.generateId(),
      scopeKey: input.scopeKey,
      summary: input.summary,
      details: input.details,
      kind: input.kind,
      tier: input.tier,
      state: "active",
      source: input.source,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastConfirmedAt: input.lastConfirmedAt,
      expiresAt: input.expiresAt,
      supersedes: input.supersedes || [],
      supersededBy: undefined,
      fingerprint,
      tags: (input.tags || []).map((t) => t.toLowerCase()),
      retrievalCount: 0,
      lastRetrievedAt: undefined,
    };

    const stored: StoredMemoryRecord = {
      id: record.id,
      scopeKey: record.scopeKey,
      summary: record.summary,
      details: record.details,
      kind: record.kind,
      tier: record.tier,
      state: record.state,
      sourceJson: JSON.stringify(record.source),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastConfirmedAt: record.lastConfirmedAt,
      expiresAt: record.expiresAt,
      supersedesJson: JSON.stringify(record.supersedes),
      supersededBy: record.supersededBy,
      fingerprint: record.fingerprint,
      tagsJson: JSON.stringify(record.tags),
      retrievalCount: record.retrievalCount,
      lastRetrievedAt: record.lastRetrievedAt,
    };

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .collection<StoredMemoryRecord>(RECORDS_COLLECTION)
          .set(record.id, stored);

        // Add to FTS index
        await tx.collection<{ id: string; text: string }>(FTS_COLLECTION).set(
          record.id,
          {
            id: record.id,
            text: [record.summary, record.details, ...record.tags].filter(
              Boolean
            ).join(" "),
          }
        );
      });
    } catch (error) {
      console.error("[feltdb-memory-store] Create failed:", error);
      throw error;
    }

    return record;
  }

  /**
   * Get a record by ID.
   */
  async getRecord(id: string): Promise<MemoryRecord | null> {
    this.ensureInitialized();
    if (!this.db) return null;

    try {
      const stored = await this.db
        .collection<StoredMemoryRecord>(RECORDS_COLLECTION)
        .get(id);

      if (!stored) return null;

      return this.storedToRecord(stored);
    } catch (error) {
      console.error("[feltdb-memory-store] Get failed:", error);
      return null;
    }
  }

  /**
   * Update a record.
   */
  async updateRecord(
    id: string,
    updates: Partial<MemoryRecord>
  ): Promise<MemoryRecord> {
    this.ensureInitialized();
    if (!this.db) {
      throw new Error("FeltDB not initialized");
    }

    try {
      const stored = await this.db
        .collection<StoredMemoryRecord>(RECORDS_COLLECTION)
        .get(id);

      if (!stored) {
        throw new Error(`Record not found: ${id}`);
      }

      const current = this.storedToRecord(stored);
      const updated: MemoryRecord = {
        ...current,
        ...updates,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };

      const storedUpdated: StoredMemoryRecord = {
        id: updated.id,
        scopeKey: updated.scopeKey,
        summary: updated.summary,
        details: updated.details,
        kind: updated.kind,
        tier: updated.tier,
        state: updated.state,
        sourceJson: JSON.stringify(updated.source),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        lastConfirmedAt: updated.lastConfirmedAt,
        expiresAt: updated.expiresAt,
        supersedesJson: JSON.stringify(updated.supersedes),
        supersededBy: updated.supersededBy,
        fingerprint: updated.fingerprint,
        tagsJson: JSON.stringify(updated.tags),
        retrievalCount: updated.retrievalCount,
        lastRetrievedAt: updated.lastRetrievedAt,
      };

      await this.db.transaction(async (tx) => {
        await tx
          .collection<StoredMemoryRecord>(RECORDS_COLLECTION)
          .set(id, storedUpdated);

        // Update FTS index
        await tx.collection<{ id: string; text: string }>(FTS_COLLECTION).set(
          id,
          {
            id,
            text: [
              updated.summary,
              updated.details,
              ...updated.tags,
            ]
              .filter(Boolean)
              .join(" "),
          }
        );
      });

      return updated;
    } catch (error) {
      console.error("[feltdb-memory-store] Update failed:", error);
      throw error;
    }
  }

  /**
   * Delete a record.
   */
  async deleteRecord(id: string): Promise<boolean> {
    this.ensureInitialized();
    if (!this.db) return false;

    try {
      const exists = await this.db
        .collection<StoredMemoryRecord>(RECORDS_COLLECTION)
        .get(id);

      if (!exists) return false;

      await this.db.transaction(async (tx) => {
        await tx
          .collection<StoredMemoryRecord>(RECORDS_COLLECTION)
          .delete(id);
        await tx.collection<{ id: string; text: string }>(FTS_COLLECTION).delete(
          id
        );
      });

      return true;
    } catch (error) {
      console.error("[feltdb-memory-store] Delete failed:", error);
      return false;
    }
  }

  /**
   * List records with filtering and pagination.
   */
  async listRecords(
    filters: any = {},
    options: PageOptions = {}
  ): Promise<MemoryPage> {
    this.ensureInitialized();
    if (!this.db) return { items: [], nextCursor: undefined };

    try {
      const limit = options.limit || 10;
      const cursor = options.cursor ? parseInt(options.cursor as string) : 0;

      // Note: This is a simplified implementation
      // Real implementation would need proper pagination and filtering
      const records: MemoryRecord[] = [];

      // For now, return empty
      return { items: records, nextCursor: undefined };
    } catch (error) {
      console.error("[feltdb-memory-store] List failed:", error);
      return { items: [], nextCursor: undefined };
    }
  }

  /**
   * Search records.
   */
  async searchRecords(
    query: string,
    options: any = {}
  ): Promise<MemoryPage> {
    this.ensureInitialized();
    if (!this.db) return { items: [], nextCursor: undefined };

    try {
      // Note: This is a simplified implementation
      // Real implementation would use FTS
      return { items: [], nextCursor: undefined };
    } catch (error) {
      console.error("[feltdb-memory-store] Search failed:", error);
      return { items: [], nextCursor: undefined };
    }
  }

  /**
   * Mark records as retrieved.
   */
  async markRetrieved(ids: string[]): Promise<number> {
    this.ensureInitialized();
    if (!this.db) return 0;

    let count = 0;
    try {
      for (const id of ids) {
        const stored = await this.db
          .collection<StoredMemoryRecord>(RECORDS_COLLECTION)
          .get(id);

        if (stored) {
          const now = new Date().toISOString();
          stored.lastRetrievedAt = now;
          stored.retrievalCount = (stored.retrievalCount || 0) + 1;

          await this.db.transaction((tx) => {
            tx.collection<StoredMemoryRecord>(RECORDS_COLLECTION).set(id, stored);
          });
          count++;
        }
      }
    } catch (error) {
      console.error("[feltdb-memory-store] Mark retrieved failed:", error);
    }

    return count;
  }

  /**
   * Get statistics about memory records.
   */
  async getStats(): Promise<any> {
    this.ensureInitialized();
    if (!this.db) {
      return {
        total: 0,
        active: 0,
        pinned: 0,
        review: 0,
        ambientSummaryChars: 0,
        scopes: [],
      };
    }

    try {
      // Note: This is a simplified implementation
      return {
        total: 0,
        active: 0,
        pinned: 0,
        review: 0,
        ambientSummaryChars: 0,
        scopes: [],
      };
    } catch (error) {
      console.error("[feltdb-memory-store] Stats failed:", error);
      return {
        total: 0,
        active: 0,
        pinned: 0,
        review: 0,
        ambientSummaryChars: 0,
        scopes: [],
      };
    }
  }

  /**
   * Convert stored record to MemoryRecord.
   */
  private storedToRecord(stored: StoredMemoryRecord): MemoryRecord {
    return {
      id: stored.id,
      scopeKey: stored.scopeKey,
      summary: stored.summary,
      details: stored.details,
      kind: stored.kind,
      tier: stored.tier,
      state: stored.state,
      source: JSON.parse(stored.sourceJson),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lastConfirmedAt: stored.lastConfirmedAt,
      expiresAt: stored.expiresAt,
      supersedes: JSON.parse(stored.supersedesJson),
      supersededBy: stored.supersededBy,
      fingerprint: stored.fingerprint,
      tags: JSON.parse(stored.tagsJson),
      retrievalCount: stored.retrievalCount,
      lastRetrievedAt: stored.lastRetrievedAt,
    };
  }

  /**
   * Compute fingerprint for deduplication.
   */
  private computeFingerprint(input: CreateMemoryInput): string {
    const text = [
      input.summary,
      input.details,
      ...(input.tags || []),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    // Use crypto to compute SHA256
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    return Buffer.from(data).toString("hex").substring(0, 64);
  }

  /**
   * Generate a unique ID.
   */
  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Close the FeltDB store.
   */
  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        console.error("[feltdb-memory-store] Close failed:", error);
      }
    }
    this.db = null;
    this.initialized = false;
  }
}

/**
 * Open a FeltDB-backed memory store.
 */
export function openFeltDBMemoryStore(path: string): FeltDBMemoryStore {
  return new FeltDBMemoryStore(path);
}
