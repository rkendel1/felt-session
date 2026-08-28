/**
 * FeltDB-backed Transcript Store
 *
 * Phase 4 implementation: Provides FeltDB persistence for transcript events.
 * During the migration phase, this is used for dual-write validation.
 * Events are stored as immutable documents in FeltDB collections.
 *
 * This is a write-once, append-only store optimized for session transcript persistence.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { TranscriptEntry, SeqEntry } from "./types";
import type { AppendResult } from "./transcript-store";

interface StoredTranscriptEvent {
  id: string; // key: `${sessionId}_${seq}`
  sessionId: string;
  seq: number;
  uuid: string;
  ts: number;
  kind: string;
  data: string; // serialized TranscriptEntry
  fullRef?: number;
  changeSeq: number;
}

interface StoredSessionMetadata {
  id: string; // sessionId
  sessionId: string;
  nextSeq: number;
  nextChangeSeq: number;
  resetChangeSeq: number;
  importedAt?: number;
  importSrc?: string;
  importWatermark?: number;
}

const EVENTS_COLLECTION = "transcript_events";
const METADATA_COLLECTION = "transcript_sessions";
const BLOBS_COLLECTION = "transcript_blobs";
const OUTLINE_COLLECTION = "transcript_outline";

/**
 * FeltDB-backed transcript store for Phase 4 migration.
 * Handles append-only event storage and session metadata.
 */
export class FeltDBTranscriptStore {
  private db: ReturnType<typeof createFeltDB> | null = null;
  private initialized = false;

  constructor(public readonly dbPath: string) {}

  /**
   * Lazy initialization of FeltDB store.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    if (!this.dbPath || this.dbPath === ":memory:") {
      throw new Error("FeltDB transcript store requires a filesystem path");
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
        namespace: "transcripts",
      });
      this.initialized = true;
    } catch (error) {
      console.error(
        "[feltdb-transcript-store] Failed to initialize FeltDB:",
        error
      );
      this.initialized = true; // Mark as initialized even on error to avoid retries
      throw error;
    }
  }

  /**
   * Append transcript events to FeltDB.
   * Returns the seq range of appended entries.
   */
  async appendTranscriptEvents(
    sessionId: string,
    entries: TranscriptEntry[]
  ): Promise<AppendResult | null> {
    if (!sessionId || !entries || entries.length === 0) return null;

    this.ensureInitialized();
    if (!this.db) return null;

    try {
      const sessionKey = sessionId;
      const metadata = await this.getSessionMetadata(sessionId);

      let nextSeq = metadata?.nextSeq ?? 1;
      let nextChangeSeq = metadata?.nextChangeSeq ?? 1;
      const insertedEntries: { seq: number; uuid: string }[] = [];
      const updatedEntries: { seq: number; uuid: string }[] = [];

      await this.db.transaction(async (tx) => {
        for (const entry of entries) {
          if (!entry.id) continue;

          // Check if entry already exists (upsert semantics)
          const existingKey = `${sessionId}_${entry.id}`;
          const existing = await tx
            .collection<StoredTranscriptEvent>(EVENTS_COLLECTION)
            .get(existingKey);

          const stored: StoredTranscriptEvent = {
            id: existingKey,
            sessionId,
            seq: existing?.seq ?? nextSeq,
            uuid: entry.id,
            ts: entry.timestamp
              ? new Date(entry.timestamp).getTime()
              : Date.now(),
            kind: entry.type || "unknown",
            data: JSON.stringify(entry),
            changeSeq: nextChangeSeq,
          };

          if (existing) {
            // Update existing entry
            updatedEntries.push({ seq: existing.seq, uuid: entry.id });
          } else {
            // New entry
            insertedEntries.push({ seq: nextSeq, uuid: entry.id });
            nextSeq++;
          }

          await tx
            .collection<StoredTranscriptEvent>(EVENTS_COLLECTION)
            .set(existingKey, stored);
        }

        // Update session metadata
        nextChangeSeq++;
        const updatedMetadata: StoredSessionMetadata = {
          id: sessionKey,
          sessionId,
          nextSeq,
          nextChangeSeq,
          resetChangeSeq: metadata?.resetChangeSeq ?? 0,
          importedAt: metadata?.importedAt,
          importSrc: metadata?.importSrc,
          importWatermark: metadata?.importWatermark,
        };

        await tx
          .collection<StoredSessionMetadata>(METADATA_COLLECTION)
          .set(sessionKey, updatedMetadata);
      });

      const allAffected = [...insertedEntries, ...updatedEntries];
      if (allAffected.length === 0) return null;

      const seqs = allAffected.map((e) => e.seq).sort((a, b) => a - b);
      return {
        firstSeq: seqs[0],
        lastSeq: seqs[seqs.length - 1],
        inserted: insertedEntries.length,
        updated: updatedEntries.length,
      };
    } catch (error) {
      console.error("[feltdb-transcript-store] Append failed:", error);
      throw error;
    }
  }

  /**
   * Read transcript entries for a session.
   */
  async readTail(
    sessionId: string,
    limit: number = 50
  ): Promise<SeqEntry[]> {
    this.ensureInitialized();
    if (!this.db) return [];

    try {
      const entries: SeqEntry[] = [];
      const metadata = await this.getSessionMetadata(sessionId);

      if (!metadata) return [];

      // Read entries in reverse order (most recent first)
      for (let seq = metadata.nextSeq - 1; seq >= 1 && entries.length < limit; seq--) {
        // Note: This is inefficient; a real implementation would maintain an index
        for (let i = 1; i <= metadata.nextSeq; i++) {
          const eventKey = `${sessionId}_${i}`;
          const event = await this.db
            .collection<StoredTranscriptEvent>(EVENTS_COLLECTION)
            .get(eventKey);

          if (event && entries.length < limit) {
            const parsed = JSON.parse(event.data) as TranscriptEntry;
            entries.push({
              ...parsed,
              seq: event.seq,
            });
          }
        }
        break;
      }

      return entries.reverse();
    } catch (error) {
      console.error("[feltdb-transcript-store] Read failed:", error);
      return [];
    }
  }

  /**
   * Get session metadata including seq tracking.
   */
  async getSessionMetadata(
    sessionId: string
  ): Promise<StoredSessionMetadata | null> {
    this.ensureInitialized();
    if (!this.db) return null;

    try {
      return await this.db
        .collection<StoredSessionMetadata>(METADATA_COLLECTION)
        .get(sessionId);
    } catch (error) {
      console.error("[feltdb-transcript-store] Metadata read failed:", error);
      return null;
    }
  }

  /**
   * Mark a session as imported.
   */
  async markImported(
    sessionId: string,
    src: string,
    watermark: number | null
  ): Promise<void> {
    this.ensureInitialized();
    if (!this.db) return;

    try {
      const metadata = (await this.getSessionMetadata(sessionId)) || {
        id: sessionId,
        sessionId,
        nextSeq: 1,
        nextChangeSeq: 1,
        resetChangeSeq: 0,
      };

      metadata.importedAt = Date.now();
      metadata.importSrc = src;
      metadata.importWatermark = watermark;

      await this.db
        .collection<StoredSessionMetadata>(METADATA_COLLECTION)
        .set(sessionId, metadata);
    } catch (error) {
      console.error("[feltdb-transcript-store] Mark imported failed:", error);
    }
  }

  /**
   * Get the last seq for a session.
   */
  async getLastSeq(sessionId: string): Promise<number> {
    const metadata = await this.getSessionMetadata(sessionId);
    return metadata ? metadata.nextSeq - 1 : 0;
  }

  /**
   * Delete all transcript data for a session.
   */
  async deleteSessionTranscript(sessionId: string): Promise<void> {
    this.ensureInitialized();
    if (!this.db) return;

    try {
      await this.db.transaction(async (tx) => {
        // Delete all events for this session
        // Note: This is inefficient; real implementation would need batch delete
        const metadata = await tx
          .collection<StoredSessionMetadata>(METADATA_COLLECTION)
          .get(sessionId);

        if (metadata) {
          for (let seq = 1; seq < metadata.nextSeq; seq++) {
            const key = `${sessionId}_${seq}`;
            await tx
              .collection<StoredTranscriptEvent>(EVENTS_COLLECTION)
              .delete(key);
          }
        }

        // Delete metadata
        await tx
          .collection<StoredSessionMetadata>(METADATA_COLLECTION)
          .delete(sessionId);
      });
    } catch (error) {
      console.error("[feltdb-transcript-store] Delete failed:", error);
    }
  }

  /**
   * Close the FeltDB store.
   */
  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        console.error("[feltdb-transcript-store] Close failed:", error);
      }
    }
    this.db = null;
    this.initialized = false;
  }
}

/**
 * Open a FeltDB-backed transcript store.
 */
export function openFeltDBTranscriptStore(
  path: string
): FeltDBTranscriptStore {
  return new FeltDBTranscriptStore(path);
}
