/**
 * Transcript v2 store (docs/transcripts.md §1, §1a) — the owned
 * per-session sequence-numbered event log in ONE SQLite (WAL) DB:
 * `<OPENSESSION_SESSIONS_DIR>/transcripts.db`.
 *
 * Row unit is the parsed TranscriptEntry; `uuid` = `entry.id` (§1a — NOT the
 * mirror line uuid). seq is 1-based and dense per session, assigned ONLY to
 * genuinely-inserted rows inside a BEGIN IMMEDIATE transaction; a re-append
 * of a known (session_id, uuid) is an upsert that updates data/full_ref/ts
 * but keeps the ORIGINAL seq (streamed-rewrite "last wins" semantics — the
 * client already upserts by entry id). A (session_id, seq) PK conflict is a
 * bug and surfaces as a thrown SQLite error — never OR IGNORE.
 *
 * Write-time bounding: `data` is hard-bounded to <= 32 KB (bytes of the
 * serialized JSON). Oversized entries store their full JSON in
 * transcript_blobs (full_ref) and a stripped wire form in `data`:
 * byte-truncated content with the contentClamped/contentLength markers the
 * legacy clampEntriesForWire path uses, toolInput replaced by a
 * `{toolName, byteSize, keys}` summary, and each images[] data-URL replaced
 * by an `"os-blob:<uuid>/<i>"` marker the UI resolves via the /entry route
 * (getFullEntry).
 *
 * Import-first gate (§3): `appendTranscriptEvents` accepts an optional
 * `ensureImported(sessionId)` hook. When the session has never been imported
 * (`needsImport`), the hook runs SYNCHRONOUSLY before the first live seq is
 * assigned — the wiring layer implements it as
 * mergedSessionTranscript → importLegacyTranscript → (markImported happens
 * inside importLegacyTranscript). If the hook returns without importing (or
 * no hook is given), the session is marked 'live-only' so the gate is a
 * one-time cost. If the hook THROWS, the append is aborted and the error
 * propagates — the wiring layer catches, warns, and marks the session
 * store-degraded (live appends must never precede history import).
 *
 * Post-commit hooks (§4a): every committed append publishes the affected
 * entries (with seqs) on transcript-bus, and invokes the optional
 * steer-receipt append hook (setAppendHook — same contract as
 * file-watcher.ts's setTranscriptAppendListener). Both are wrapped so they
 * can never throw back into the append path. Imports publish one reconciliation
 * wake only after all chunks commit; authoritative replacements publish reset.
 *
 * Live-safety: nothing here opens the DB at import time — the singleton
 * (`transcriptStore()`) is lazy, and handle + prepared statements park on
 * `globalThis.__osTranscriptStore` (pattern: session-index.ts:58) so hot
 * reloads reuse the open connection. transcripts.db has exactly ONE writer:
 * the live server process (invariant 8) — tests construct `new
 * TranscriptStore(tempPath)` directly and must never call transcriptStore().
 */

import { executeSessionProjection } from "./session-projection-executor";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname } from "path";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import {
  publishTranscript,
  type SeqEntry,
  type TranscriptBusEvent,
} from "./transcript-bus";
import type { TranscriptEntry } from "./types";
import { sanitizeTranscriptMediaEntry } from "./transcript-media";
import { classifyEntry, dropContextInjections } from "@tellahq/opensession-protocol/notices";
import type {
  TranscriptIndexEntry,
  TranscriptIndexRole,
} from "@tellahq/opensession-protocol/session";

export type { SeqEntry, TranscriptBusEvent };

/** Hard byte bound for the wire-ready `data` column. */
export const TRANSCRIPT_DATA_MAX_BYTES = 32 * 1024;

export type TranscriptImportSrc = "mirror" | "merged" | "live-only";

export interface TranscriptOutline {
  entries: TranscriptIndexEntry[];
  firstSeq: number;
  lastSeq: number;
  lastChangeSeq: number;
  epoch: number;
}

export interface TranscriptRangePage extends TranscriptPage {
  /** Last raw seq covered, including a corrupt or hidden row. */
  coveredThroughSeq: number;
  complete: boolean;
}

export interface TranscriptPage {
  /** Entries in ascending seq order, each annotated with its seq. */
  entries: SeqEntry[];
  /** seq of entries[0]; 0 when the page is empty. */
  firstSeq: number;
  /** seq of entries[entries.length-1]; 0 when the page is empty. */
  lastSeq: number;
}

export interface AppendResult {
  /** Lowest affected seq (an upsert keeps its original seq, so this can be
   *  far below lastSeq). */
  firstSeq: number;
  /** Highest affected seq. */
  lastSeq: number;
  /** Rows genuinely inserted (got a fresh seq). */
  inserted: number;
  /** Rows that hit the (session_id, uuid) index and were updated in place —
   *  the caller's "republish happened" flag. */
  updated: number;
}

export interface AppendOpts {
  /**
   * Import-first gate hook (§3): called synchronously when the session has
   * never been imported, BEFORE any live seq is assigned. Implementations
   * should run the legacy import (importLegacyTranscript marks the session
   * imported); a fresh session with no legacy transcript may simply return —
   * the store then marks it 'live-only'. A throw aborts this append.
   */
  ensureImported?: (sessionId: string) => void;
}

export interface TranscriptImportInfo {
  importedAt: number;
  src: TranscriptImportSrc | string;
  watermark: number | null;
}

/**
 * What counts as CONVERSATION when sizing an opening window (readTailWindow).
 *
 * Deliberately not `system`: the biggest system rows are the per-turn context
 * injections (memory, standing instructions), which every client drops on the
 * way in (dropContextInjections), so counting them would satisfy the message
 * floor with rows nobody ever sees.
 */
const TAIL_WINDOW_MESSAGE_KINDS = new Set(["user", "assistant"]);

export interface TailWindowOpts {
  /** Never fewer than this many entries, whatever the byte ceiling says. */
  minEntries: number;
  /** Reach back until the window holds this many user/assistant entries. */
  minMessages: number;
  /** Require this many user boundaries when the window contains tool work. */
  minUserMessagesWithToolWork?: number;
  /** Hard ceiling on rows read, and on the probe query itself. */
  maxEntries: number;
  /** Estimated transfer ceiling for the extension past `minEntries`. */
  maxEstimatedBytes: number;
  /**
   * Estimate what one stored row costs after the caller's wire transforms.
   * Defaults to its stored UTF-8 size.
   */
  weigh?: (kind: string, storedBytes: number) => number;
}

/** Same contract as file-watcher.ts's AppendListener (setTranscriptAppendListener):
 *  best-effort post-commit notification with the affected entries. */
export type TranscriptAppendHook = (
  sessionId: string,
  entries: SeqEntry[]
) => void;

const g = globalThis as unknown as {
  __osTranscriptStore?: TranscriptStore;
  __osTranscriptAppendHook?: TranscriptAppendHook | null;
};

/**
 * Steer-receipt (or any) post-commit append hook (§4a). Parked on globalThis
 * so hot reloads keep it; read at call time. Pass null to clear.
 */
export function setAppendHook(fn: TranscriptAppendHook | null): void {
  g.__osTranscriptAppendHook = fn;
}

/** Default DB path, derived from the active sessions dir. */
export function transcriptDbPath(): string {
  return `${OPENSESSION_SESSIONS_DIR}/transcripts.db`;
}

/**
 * The process-wide singleton over the real transcripts.db. Lazy — importing
 * this module never opens the DB. Tests must NOT call this; they construct
 * `new TranscriptStore(tempPath)` instead (invariant 8: one writer).
 *
 * A test process that reaches this anyway gets a scratch database rather than
 * the live one. That is not politeness: a run writes to the store for reasons
 * a test never asked for (context-log records the standing context of every
 * dispatch), so "the test didn't redirect the store" quietly meant "the test
 * wrote rows into the operator's real transcripts.db" — 45 of them, under
 * fixture session ids, within a day (2026-08-16). Redirecting still works and
 * still wins; this only decides where an unredirected write lands.
 */
export function transcriptStore(): TranscriptStore {
  if (g.__osTranscriptStore) return g.__osTranscriptStore;
  const path =
    isTestRunner() && !sessionsDirRedirected()
      ? scratchTranscriptDbPath()
      : transcriptDbPath();
  return (g.__osTranscriptStore = new TranscriptStore(path));
}

function isTestRunner(): boolean {
  return (
    process.env.NODE_ENV === "test" || /\.test\.tsx?$/.test(Bun.main || "")
  );
}

/** A test that pointed the state or sessions dir at a fixture root of its own
 *  keeps it: that redirect IS the isolation, and the snapshot harness depends
 *  on this lazy singleton landing inside its root. Only a test that redirected
 *  NOTHING gets the scratch DB. */
function sessionsDirRedirected(): boolean {
  return !!(
    process.env.OPENSESSION_STATE_DIR || process.env.OPENSESSION_SESSIONS_DIR
  );
}

/** One scratch DB per test process in the OS temp dir, so parallel test
 *  processes never share a file. */
function scratchTranscriptDbPath(): string {
  return `${tmpdir()}/opensession-test-transcripts-${process.pid}.db`;
}

/**
 * Test seam (bun tests only): force-replace the singleton, unconditionally —
 * unlike transcriptStore()'s `??=`, this overwrites a singleton another test
 * file already warmed. Returns the previous value (possibly undefined) so
 * afterAll can restore it before the scratch dir backing the replacement is
 * deleted; restoring the store itself, not just path bindings, is what keeps
 * a still-live singleton from being left pointed at a removed database.
 */
export function __setTranscriptStoreForTest(
  store: TranscriptStore | undefined,
): TranscriptStore | undefined {
  const prev = g.__osTranscriptStore;
  g.__osTranscriptStore = store;
  return prev;
}


// ── Row shapes ───────────────────────────────────────────────────────────────

interface EventRow {
  seq: number;
  change_seq: number;
  data: string;
  full_ref: number | null;
}

interface SessionRow {
  next_seq: number;
  next_change_seq: number;
  reset_change_seq: number;
  imported_at: number | null;
  import_src: string | null;
  import_watermark: number | null;
}

interface WriteOutcome {
  affected: SeqEntry[];
  inserted: number;
  updated: number;
}

// ── Store ────────────────────────────────────────────────────────────────────

export class TranscriptStore {
  private db: Database;
  /** Sessions known to have imported_at set — one-time PK lookup cache (§3). */
  private importedCache = new Set<string>();
  private outlineBackfills = new Map<string, Promise<void>>();
  /** BEGIN IMMEDIATE write transaction (bun:sqlite transaction wrapper). */
  private txWrite: ((sessionId: string, entries: TranscriptEntry[]) => WriteOutcome) & {
    immediate: (sessionId: string, entries: TranscriptEntry[]) => WriteOutcome;
  };
  private txDelete: ((sessionId: string) => void) & {
    immediate: (sessionId: string) => void;
  };
  private txReplace: ((sessionId: string, entries: TranscriptEntry[]) => WriteOutcome) & {
    immediate: (sessionId: string, entries: TranscriptEntry[]) => WriteOutcome;
  };

  constructor(public readonly dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_events (
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        uuid       TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        data       TEXT NOT NULL,
        full_ref   INTEGER,
        change_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_te_uuid
        ON transcript_events(session_id, uuid);
      CREATE TABLE IF NOT EXISTS transcript_outline (
        session_id       TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        uuid             TEXT NOT NULL,
        change_seq       INTEGER NOT NULL,
        ts               INTEGER NOT NULL,
        render_role      TEXT NOT NULL,
        content_length   INTEGER NOT NULL,
        review_pr_number INTEGER,
        PRIMARY KEY (session_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_to_uuid
        ON transcript_outline(session_id, uuid);
      CREATE TABLE IF NOT EXISTS transcript_blobs (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        uuid TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_uuid
        ON transcript_blobs(session_id, uuid);
      CREATE TABLE IF NOT EXISTS transcript_sessions (
        session_id  TEXT PRIMARY KEY,
        next_seq    INTEGER NOT NULL DEFAULT 1,
        next_change_seq INTEGER NOT NULL DEFAULT 1,
        reset_change_seq INTEGER NOT NULL DEFAULT 0,
        last_ts     INTEGER,
        imported_at INTEGER,
        import_src  TEXT,
        import_watermark INTEGER
      );
    `);
    this.migrateChangeSequence();
    type Tx = typeof this.txWrite;
    this.txWrite = this.db.transaction(
      (sessionId: string, entries: TranscriptEntry[]) =>
        this.writeEntriesInTx(sessionId, entries)
    ) as unknown as Tx;
    this.txDelete = this.db.transaction((sessionId: string) => {
      this.db.run("DELETE FROM transcript_events WHERE session_id = ?", [sessionId]);
      this.db.run("DELETE FROM transcript_outline WHERE session_id = ?", [sessionId]);
      this.db.run("DELETE FROM transcript_blobs WHERE session_id = ?", [sessionId]);
      this.db.run("DELETE FROM transcript_sessions WHERE session_id = ?", [sessionId]);
    }) as unknown as typeof this.txDelete;
    this.txReplace = this.db.transaction(
      (sessionId: string, entries: TranscriptEntry[]) => {
        this.db.run("DELETE FROM transcript_events WHERE session_id = ?", [sessionId]);
        this.db.run("DELETE FROM transcript_outline WHERE session_id = ?", [sessionId]);
        this.db.run("DELETE FROM transcript_blobs WHERE session_id = ?", [sessionId]);
        this.db.run(
          `INSERT INTO transcript_sessions (session_id, next_seq, next_change_seq)
           VALUES (?, 1, 1)
           ON CONFLICT(session_id) DO UPDATE SET
             next_seq = 1,
             reset_change_seq = transcript_sessions.next_change_seq,
             next_change_seq = transcript_sessions.next_change_seq + 1`,
          [sessionId]
        );
        return this.writeEntriesInTx(sessionId, entries);
      }
    ) as unknown as typeof this.txReplace;
  }

  // ── Append (live path) ─────────────────────────────────────────────────────

  /**
   * Upsert a batch of parsed entries. Returns the affected seq span, or null
   * when the batch was empty / nothing was writable (entries without an id
   * are skipped with a warn — never a throw). Runs the import-first gate
   * (see module doc / AppendOpts) before assigning any seq. Post-commit:
   * publishes the affected entries on the bus and invokes the append hook —
   * neither can throw into this path.
   */
  appendTranscriptEvents(
    sessionId: string,
    entries: TranscriptEntry[],
    opts?: AppendOpts
  ): AppendResult | null {
    return executeSessionProjection(sessionId, "transcript_append", () =>
      this.appendTranscriptEventsOwned(sessionId, entries, opts)
    );
  }

  private appendTranscriptEventsOwned(
    sessionId: string,
    entries: TranscriptEntry[],
    opts?: AppendOpts
  ): AppendResult | null {
    if (!sessionId || !entries || entries.length === 0) return null;

    // Import-first gate (§3). The hook runs synchronously; the store is
    // single-writer and sync, so nothing can interleave a live seq before it
    // completes. A throw here propagates (wiring warns + marks degraded).
    if (this.needsImport(sessionId)) {
      opts?.ensureImported?.(sessionId);
      if (this.needsImport(sessionId)) {
        this.markImported(sessionId, "live-only", null);
      }
    }

    const outcome = this.txWrite.immediate(sessionId, entries);
    if (outcome.affected.length === 0) return null;

    const firstSeq = outcome.affected[0].seq;
    const lastSeq = outcome.affected[outcome.affected.length - 1].seq;
    const result: AppendResult = {
      firstSeq: Math.min(firstSeq, lastSeq),
      lastSeq: Math.max(firstSeq, lastSeq),
      inserted: outcome.inserted,
      updated: outcome.updated,
    };
    // Affected entries keep batch order; the span must cover upsert seqs too.
    for (const e of outcome.affected) {
      if (e.seq < result.firstSeq) result.firstSeq = e.seq;
      if (e.seq > result.lastSeq) result.lastSeq = e.seq;
    }

    // Post-commit hooks — best-effort, never back into the append path.
    try {
      publishTranscript(sessionId, {
        entries: outcome.affected,
        firstSeq: result.firstSeq,
        lastSeq: result.lastSeq,
      });
    } catch (e) {
      console.warn("[transcript-store] bus publish failed:", e);
    }
    const hook = g.__osTranscriptAppendHook;
    if (hook) {
      try {
        hook(sessionId, outcome.affected);
      } catch (e) {
        console.warn("[transcript-store] append hook threw:", e);
      }
    }
    return result;
  }

  // ── Import (legacy history) ────────────────────────────────────────────────

  /**
   * Bulk-load a legacy transcript in chunked BEGIN IMMEDIATE transactions
   * (≤ 500 rows each — never one giant lock hold), then mark the session
   * imported with `src` + `watermark` (mirror file size at import time, §8
   * drift detection). Idempotent: re-import upserts by uuid and keeps seqs.
   * Publishes one post-import wake so an already-active watcher reconciles.
   */
  importLegacyTranscript(
    sessionId: string,
    entries: TranscriptEntry[],
    src: TranscriptImportSrc | string,
    watermark: number | null
  ): { inserted: number; updated: number } {
    return executeSessionProjection(sessionId, "transcript_import", () =>
      this.importLegacyTranscriptOwned(sessionId, entries, src, watermark)
    );
  }

  private importLegacyTranscriptOwned(
    sessionId: string,
    entries: TranscriptEntry[],
    src: TranscriptImportSrc | string,
    watermark: number | null
  ): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      const outcome = this.txWrite.immediate(sessionId, chunk);
      inserted += outcome.inserted;
      updated += outcome.updated;
    }
    this.markImported(sessionId, src, watermark);
    // Initial imports have no subscribers; drift re-imports can. Publishing a
    // single wake after all chunks lets active watches reconcile corrections
    // without exposing partially imported state.
    if (inserted || updated) {
      publishTranscript(sessionId, {
        entries: [],
        firstSeq: 0,
        lastSeq: this.getLastSeq(sessionId),
      });
    }
    return { inserted, updated };
  }

  /** Replace a file-backed transcript authoritatively while preserving the
   * monotonic change cursor. Used for truncation/atomic replacement only. */
  replaceTranscriptEvents(
    sessionId: string,
    entries: TranscriptEntry[]
  ): { inserted: number; updated: number } {
    return executeSessionProjection(sessionId, "transcript_replace", () =>
      this.replaceTranscriptEventsOwned(sessionId, entries)
    );
  }

  private replaceTranscriptEventsOwned(
    sessionId: string,
    entries: TranscriptEntry[]
  ): { inserted: number; updated: number } {
    const outcome = this.txReplace.immediate(sessionId, entries);
    publishTranscript(sessionId, {
      entries: outcome.affected,
      firstSeq: outcome.affected[0]?.seq ?? 0,
      lastSeq: outcome.affected[outcome.affected.length - 1]?.seq ?? 0,
      reset: true,
    });
    return { inserted: outcome.inserted, updated: outcome.updated };
  }

  /** True when the session has never been imported (one-time gate; cached). */
  needsImport(sessionId: string): boolean {
    return !this.hasImported(sessionId);
  }

  hasImported(sessionId: string): boolean {
    if (this.importedCache.has(sessionId)) return true;
    const row = this.db
      .query("SELECT imported_at FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { imported_at: number | null } | null;
    if (row?.imported_at != null) {
      this.importedCache.add(sessionId);
      return true;
    }
    return false;
  }

  markImported(
    sessionId: string,
    src: TranscriptImportSrc | string,
    watermark: number | null = null
  ): void {
    this.db.run(
      `INSERT INTO transcript_sessions (session_id, next_seq, imported_at, import_src, import_watermark)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         imported_at = excluded.imported_at,
         import_src = excluded.import_src,
         import_watermark = excluded.import_watermark`,
      [sessionId, Date.now(), src, watermark]
    );
    this.importedCache.add(sessionId);
  }

  /** imported_at/src/watermark for §8 drift detection; null if never imported. */
  getImportInfo(sessionId: string): TranscriptImportInfo | null {
    const row = this.db
      .query(
        "SELECT imported_at, import_src, import_watermark FROM transcript_sessions WHERE session_id = ?"
      )
      .get(sessionId) as SessionRow | null;
    if (!row || row.imported_at == null) return null;
    return {
      importedAt: row.imported_at,
      src: row.import_src ?? "",
      watermark: row.import_watermark ?? null,
    };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * The tail a reader should OPEN on: at least `minEntries` rows, extended
   * back until the window holds enough conversation and user-message
   * boundaries, and stopped by whichever ceiling comes first.
   *
   * Why this exists at all: a flat entry count is a bad proxy for how much
   * conversation a snapshot contains. One turn can be a thousand tool rows,
   * and the UI folds a run of consecutive tool/assistant entries into ONE
   * collapsed "Worked · N steps" block, so a 132-entry tail of such a turn
   * renders as a single fold and reads as an empty session (measured on a
   * real session: 2,256 entries, of which the last 132 held one assistant
   * message and no user message; 17 of the 60 largest sessions in the store
   * had fewer than 8 messages in that window).
   *
   * Two queries, and the first decodes no JSON: a probe over (seq, kind,
   * length(data)) walks the tail newest-first to pick the row count, then the
   * ordinary tail read materializes exactly that many. The probe is bounded by
   * `maxEntries` and rides the (session_id, seq) primary key, so it stays an
   * index scan of at most that many rows rather than a table scan.
   */
  readTailWindow(sessionId: string, opts: TailWindowOpts): TranscriptPage {
    const maxEntries = Math.max(1, Math.floor(opts.maxEntries));
    const minEntries = Math.max(
      1,
      Math.min(Math.floor(opts.minEntries), maxEntries)
    );
    const minMessages = Math.max(0, Math.floor(opts.minMessages));
    const minUserMessagesWithToolWork = Math.max(
      0,
      Math.floor(opts.minUserMessagesWithToolWork ?? 0)
    );
    const maxEstimatedBytes = Math.max(0, opts.maxEstimatedBytes);
    const weigh = opts.weigh ?? ((_kind: string, bytes: number) => bytes);
    const probe = this.db
      .query(
        `SELECT seq, kind, length(CAST(data AS BLOB)) AS bytes
         FROM transcript_events
         WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, maxEntries) as Array<{
      seq: number;
      kind: string;
      bytes: number;
    }>;

    let count = 0;
    let estimatedBytes = 0;
    let messages = 0;
    let userMessages = 0;
    let toolRows = 0;
    for (const row of probe) {
      // Tool-free assistant messages all render in place. A user boundary is
      // needed only once tool work makes the renderer fold those messages.
      const userBoundaryMet =
        toolRows === 0 || userMessages >= minUserMessagesWithToolWork;
      if (count >= minEntries && messages >= minMessages && userBoundaryMet) {
        break;
      }
      const cost = weigh(row.kind, row.bytes ?? 0);
      // The entry floor is unconditional. The byte ceiling only governs the
      // message-seeking extension past it, so a session of enormous rows still
      // opens on the same window it always did.
      if (
        count >= minEntries &&
        estimatedBytes + cost > maxEstimatedBytes
      ) {
        break;
      }
      count++;
      estimatedBytes += cost;
      if (TAIL_WINDOW_MESSAGE_KINDS.has(row.kind)) messages++;
      if (row.kind === "user") userMessages++;
      if (row.kind === "tool_use" || row.kind === "tool_result") toolRows++;
    }

    if (count === 0) return { entries: [], firstSeq: 0, lastSeq: 0 };
    return this.readTail(sessionId, count);
  }

  /** Last `limit` entries in ascending seq order. */
  readTail(sessionId: string, limit: number = 50): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, Math.max(1, limit)) as EventRow[];
    rows.reverse();
    return page(rows);
  }

  /** Entries with seq > sinceSeq, ascending, up to `limit` (resume path). */
  readSince(sessionId: string, sinceSeq: number, limit: number = 500): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
      )
      .all(sessionId, sinceSeq, Math.max(1, limit)) as EventRow[];
    return page(rows);
  }

  /** Row mutations after a synchronization cursor. Unlike readSince(seq),
   * this includes rewrites of old display-order rows. */
  readChangesSince(
    sessionId: string,
    sinceChangeSeq: number,
    limit: number = 500
  ): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND change_seq > ?
         ORDER BY change_seq ASC LIMIT ?`
      )
      .all(sessionId, sinceChangeSeq, Math.max(1, limit)) as EventRow[];
    return page(rows);
  }

  /** Entries with seq < beforeSeq — the LAST `limit` of them, ascending
   *  (history paging: walk backwards a page at a time). */
  readBefore(sessionId: string, beforeSeq: number, limit: number = 40): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, beforeSeq, Math.max(1, limit)) as EventRow[];
    rows.reverse();
    return page(rows);
  }

  /** Complete content-free outline for virtual scrolling. Existing stores
   * backfill only the session being opened, then every write maintains the
   * projection in the same transaction as its canonical row. */
  readTranscriptIndex(sessionId: string): TranscriptOutline {
    const rows = this.db
      .query(
        `SELECT uuid, seq, change_seq, ts, render_role, content_length, review_pr_number
         FROM transcript_outline WHERE session_id = ? ORDER BY seq`
      )
      .all(sessionId) as Array<{
      uuid: string;
      seq: number;
      change_seq: number;
      ts: number;
      render_role: TranscriptIndexRole;
      content_length: number;
      review_pr_number: number | null;
    }>;
    const entries = rows.map((row) => ({
      id: row.uuid,
      seq: row.seq,
      changeSeq: row.change_seq,
      timestampMs: row.ts,
      role: row.render_role,
      contentLength: row.content_length,
      ...(row.review_pr_number != null
        ? { reviewPrNumber: row.review_pr_number }
        : {}),
    }));
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries[entries.length - 1]?.seq ?? 0,
      lastChangeSeq: this.getLastChangeSeq(sessionId),
      epoch: this.getLastResetChangeSeq(sessionId),
    };
  }

  /** One bounded chunk inside an inclusive indexed span. */
  readRange(
    sessionId: string,
    firstSeq: number,
    lastSeq: number,
    afterSeq: number = firstSeq - 1,
    limit: number = 500
  ): TranscriptRangePage {
    const boundedLimit = Math.max(1, limit);
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND seq >= ? AND seq <= ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`
      )
      .all(sessionId, firstSeq, lastSeq, afterSeq, boundedLimit + 1) as EventRow[];
    const complete = rows.length <= boundedLimit;
    const shipped = complete ? rows : rows.slice(0, boundedLimit);
    const hydrated = page(shipped);
    return {
      ...hydrated,
      coveredThroughSeq: shipped[shipped.length - 1]?.seq ?? Math.max(afterSeq, firstSeq - 1),
      complete,
    };
  }

  /**
   * The full (unstripped) entry for the /entry route: blob when the stored
   * row was bounded, else the row's own data. Null when unknown.
   */
  getFullEntry(sessionId: string, uuid: string): TranscriptEntry | null {
    const blob = this.db
      .query("SELECT data FROM transcript_blobs WHERE session_id = ? AND uuid = ?")
      .get(sessionId, uuid) as { data: string } | null;
    const raw =
      blob?.data ??
      (
        this.db
          .query(
            "SELECT data FROM transcript_events WHERE session_id = ? AND uuid = ?"
          )
          .get(sessionId, uuid) as { data: string } | null
      )?.data;
    if (!raw) return null;
    try {
      return sanitizeTranscriptMediaEntry(JSON.parse(raw) as TranscriptEntry);
    } catch {
      return null;
    }
  }

  /** Highest assigned seq for the session (0 when none). */
  getLastSeq(sessionId: string): number {
    const row = this.db
      .query("SELECT next_seq FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { next_seq: number } | null;
    return row ? row.next_seq - 1 : 0;
  }

  /** Highest committed mutation cursor for the session (0 when empty). */
  getLastChangeSeq(sessionId: string): number {
    const row = this.db
      .query("SELECT next_change_seq FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { next_change_seq: number } | null;
    return row ? row.next_change_seq - 1 : 0;
  }

  /** Mutation boundary of the latest authoritative replacement. A reconnect
   * cursor older than this cannot safely merge and must receive a snapshot. */
  getLastResetChangeSeq(sessionId: string): number {
    const row = this.db
      .query("SELECT reset_change_seq FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { reset_change_seq: number } | null;
    return row?.reset_change_seq ?? 0;
  }

  // ── Delete / maintenance ──────────────────────────────────────────────────

  /** Remove every trace of a session (events + blobs + session row). */
  deleteSessionTranscript(sessionId: string): void {
    executeSessionProjection(sessionId, "transcript_delete", () => {
      this.txDelete.immediate(sessionId);
      this.importedCache.delete(sessionId);
    });
  }

  /**
   * Every session the store holds a row for, with its last write and the seq
   * high-water mark. Reads only transcript_sessions, so it stays a small-table
   * scan on a multi-GB database; the high-water is an UPPER bound on the entry
   * count (an upsert never advances it), which is enough to skip a session
   * without counting its rows.
   */
  listStoredSessions(): Array<{
    sessionId: string;
    lastTs: number | null;
    seqHighWater: number;
  }> {
    const rows = this.db
      .query("SELECT session_id, last_ts, next_seq FROM transcript_sessions")
      .all() as Array<{
      session_id: string;
      last_ts: number | null;
      next_seq: number;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      lastTs: r.last_ts ?? null,
      seqHighWater: Math.max(0, (r.next_seq ?? 1) - 1),
    }));
  }

  /** Exact event count for one session (the primary key leads on session_id). */
  countEvents(sessionId: string): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM transcript_events WHERE session_id = ?")
        .get(sessionId) as { n: number }
    ).n;
  }

  /** Cheap counters for the daily growth-metric audit line / backfill summary. */
  stats(): { sessions: number; events: number; blobs: number } {
    const count = (sql: string) =>
      (this.db.query(sql).get() as { n: number }).n;
    return {
      sessions: count("SELECT COUNT(*) AS n FROM transcript_sessions"),
      events: count("SELECT COUNT(*) AS n FROM transcript_events"),
      blobs: count("SELECT COUNT(*) AS n FROM transcript_blobs"),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The single write routine, always called inside a BEGIN IMMEDIATE
   * transaction: pre-checks the (session_id, uuid) index, updates in place
   * keeping the original seq, and assigns next_seq only to genuine inserts.
   * A (session_id, seq) PK conflict here is a bug and throws.
   */
  private writeEntriesInTx(
    sessionId: string,
    entries: TranscriptEntry[]
  ): WriteOutcome {
    const sessRow = this.db
      .query(
        "SELECT next_seq, next_change_seq FROM transcript_sessions WHERE session_id = ?"
      )
      .get(sessionId) as { next_seq: number; next_change_seq: number } | null;
    let nextSeq = sessRow?.next_seq ?? 1;
    let nextChangeSeq = sessRow?.next_change_seq ?? 1;
    if (!sessRow) {
      this.db.run(
        "INSERT INTO transcript_sessions (session_id, next_seq, next_change_seq) VALUES (?, 1, 1)",
        [sessionId]
      );
    }

    const affected: SeqEntry[] = [];
    let inserted = 0;
    let updated = 0;
    let lastTs: number | null = null;

    for (const entry of entries) {
      const uuid = entry?.id;
      if (!uuid || typeof uuid !== "string") {
        console.warn(
          `[transcript-store] skipping entry without id in ${sessionId} (type=${entry?.type})`
        );
        continue;
      }
      const ts = entryTs(entry);
      const changeSeq = nextChangeSeq++;
      lastTs = ts;
      const bounded = boundEntryForStore(entry);

      // Blob first (need its id for full_ref).
      let fullRef: number | null = null;
      if (bounded.full !== null) {
        const blobRow = this.db
          .query(
            `INSERT INTO transcript_blobs (session_id, uuid, data) VALUES (?, ?, ?)
             ON CONFLICT(session_id, uuid) DO UPDATE SET data = excluded.data
             RETURNING id`
          )
          .get(sessionId, uuid, bounded.full) as { id: number };
        fullRef = blobRow.id;
      }

      const existing = this.db
        .query(
          "SELECT seq, full_ref FROM transcript_events WHERE session_id = ? AND uuid = ?"
        )
        .get(sessionId, uuid) as { seq: number; full_ref: number | null } | null;

      if (existing) {
        // Upsert: keep ORIGINAL seq, update data/full_ref/ts (§1 semantics).
        if (existing.full_ref != null && fullRef == null) {
          // Entry shrank below the bound — drop the now-stale blob.
          this.db.run(
            "DELETE FROM transcript_blobs WHERE session_id = ? AND uuid = ?",
            [sessionId, uuid]
          );
        }
        this.db.run(
          `UPDATE transcript_events
           SET kind = ?, data = ?, full_ref = ?, ts = ?, change_seq = ?
           WHERE session_id = ? AND seq = ?`,
          [entry.type ?? "unknown", bounded.data, fullRef, ts, changeSeq, sessionId, existing.seq]
        );
        updated++;
        affected.push({ ...bounded.entry, seq: existing.seq, changeSeq });
      } else {
        const seq = nextSeq++;
        this.db.run(
          `INSERT INTO transcript_events
             (session_id, seq, uuid, ts, kind, data, full_ref, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionId,
            seq,
            uuid,
            ts,
            entry.type ?? "unknown",
            bounded.data,
            fullRef,
            changeSeq,
          ]
        );
        inserted++;
        affected.push({ ...bounded.entry, seq, changeSeq });
      }

      const seq = existing?.seq ?? nextSeq - 1;
      this.writeOutlineRow(sessionId, seq, changeSeq, ts, entry);
    }

    this.db.run(
      `UPDATE transcript_sessions
       SET next_seq = ?, next_change_seq = ?, last_ts = COALESCE(?, last_ts)
       WHERE session_id = ?`,
      [nextSeq, nextChangeSeq, lastTs, sessionId]
    );

    return { affected, inserted, updated };
  }

  private writeOutlineRow(
    sessionId: string,
    seq: number,
    changeSeq: number,
    ts: number,
    entry: TranscriptEntry
  ): void {
    const projection = transcriptOutlineProjection(entry);
    this.db.run(
      `INSERT INTO transcript_outline
         (session_id, seq, uuid, change_seq, ts, render_role, content_length, review_pr_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET
         uuid = excluded.uuid,
         change_seq = excluded.change_seq,
         ts = excluded.ts,
         render_role = excluded.render_role,
         content_length = excluded.content_length,
         review_pr_number = excluded.review_pr_number`,
      [
        sessionId,
        seq,
        entry.id,
        changeSeq,
        ts,
        projection.role,
        projection.contentLength,
        projection.reviewPrNumber ?? null,
      ]
    );
  }

  /** Backfill one session without monopolizing Bun's event loop or the sole
   * writer transaction. Concurrent viewers share the same resumable walk. */
  ensureTranscriptOutline(sessionId: string): Promise<void> {
    const existing = this.outlineBackfills.get(sessionId);
    if (existing) return existing;
    const work = this.backfillTranscriptOutline(sessionId).finally(() => {
      this.outlineBackfills.delete(sessionId);
    });
    this.outlineBackfills.set(sessionId, work);
    return work;
  }

  private async backfillTranscriptOutline(sessionId: string): Promise<void> {
    let afterSeq = 0;
    let epoch = this.getLastResetChangeSeq(sessionId);
    for (;;) {
      // The canonical event row is write-bounded to 32 KB and retains the
      // original contentLength marker plus notice/context metadata. Reading it
      // caps one slice at 3.2 MB; fetching 100 unbounded blobs would not.
      const rows = this.db
        .query(
          `SELECT e.seq, e.change_seq, e.ts, e.data, o.seq AS outline_seq
           FROM transcript_events e
           LEFT JOIN transcript_outline o
             ON o.session_id = e.session_id AND o.seq = e.seq
           WHERE e.session_id = ? AND e.seq > ?
           ORDER BY e.seq LIMIT 100`
        )
        .all(sessionId, afterSeq) as Array<{
        seq: number;
        change_seq: number;
        ts: number;
        data: string;
        outline_seq: number | null;
      }>;
      if (!rows.length) {
        const currentEpoch = this.getLastResetChangeSeq(sessionId);
        if (currentEpoch === epoch) return;
        epoch = currentEpoch;
        afterSeq = 0;
        continue;
      }
      afterSeq = rows[rows.length - 1]!.seq;
      const missing = rows.filter((row) => row.outline_seq == null);
      const parsed = missing.map((row) => {
        try {
          return {
            row,
            entry: sanitizeTranscriptMediaEntry(
              JSON.parse(row.data) as TranscriptEntry
            ),
          };
        } catch {
          return { row, entry: null };
        }
      });
      this.db.transaction(() => {
        for (const { row, entry } of parsed) {
          if (entry) {
            this.writeOutlineRow(
              sessionId,
              row.seq,
              row.change_seq,
              row.ts,
              entry
            );
          } else {
            this.db.run(
              `INSERT OR REPLACE INTO transcript_outline
                 (session_id, seq, uuid, change_seq, ts, render_role, content_length)
               SELECT session_id, seq, uuid, change_seq, ts, 'hidden', 0
               FROM transcript_events WHERE session_id = ? AND seq = ?`,
              [sessionId, row.seq]
            );
          }
        }
      }).immediate();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const currentEpoch = this.getLastResetChangeSeq(sessionId);
      if (currentEpoch !== epoch) {
        epoch = currentEpoch;
        afterSeq = 0;
      }
    }
  }

  /** Additive migration from the original seq-only store. Existing rows form
   * the baseline state, so their immutable seq is the only honest initial
   * change cursor; future mutations advance independently. */
  private migrateChangeSequence(): void {
    const eventColumns = this.db
      .query("PRAGMA table_info(transcript_events)")
      .all() as Array<{ name: string }>;
    const sessionColumns = this.db
      .query("PRAGMA table_info(transcript_sessions)")
      .all() as Array<{ name: string }>;
    const hasEventChange = eventColumns.some((c) => c.name === "change_seq");
    const hasNextChange = sessionColumns.some(
      (c) => c.name === "next_change_seq"
    );
    const hasResetChange = sessionColumns.some(
      (c) => c.name === "reset_change_seq"
    );
    this.db.transaction(() => {
      if (!hasEventChange) {
        this.db.exec(
          "ALTER TABLE transcript_events ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0"
        );
      }
      if (!hasNextChange) {
        this.db.exec(
          "ALTER TABLE transcript_sessions ADD COLUMN next_change_seq INTEGER NOT NULL DEFAULT 1"
        );
      }
      if (!hasResetChange) {
        this.db.exec(
          "ALTER TABLE transcript_sessions ADD COLUMN reset_change_seq INTEGER NOT NULL DEFAULT 0"
        );
      }
      this.db.exec("UPDATE transcript_events SET change_seq = seq WHERE change_seq = 0");
      this.db.exec(`
        UPDATE transcript_sessions
        SET next_change_seq = MAX(
          next_change_seq,
          reset_change_seq + 1,
          COALESCE(
            (SELECT MAX(change_seq) + 1 FROM transcript_events
             WHERE transcript_events.session_id = transcript_sessions.session_id),
            1
          )
        )
      `);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_te_change
        ON transcript_events(session_id, change_seq)`);
    }).immediate();
  }
}

// ── Outline projection ─────────────────────────────────────────────────────

function transcriptOutlineProjection(entry: TranscriptEntry): {
  role: TranscriptIndexRole;
  contentLength: number;
  reviewPrNumber?: number;
} {
  if (dropContextInjections([entry]).length === 0) {
    return { role: "hidden", contentLength: 0 };
  }
  const classified = classifyEntry(entry);
  let role: TranscriptIndexRole;
  let reviewPrNumber: number | undefined;
  if (classified.notice?.kind === "review-handoff") {
    role = "review_handoff";
    const match = classified.notice.title.match(/PR #(\d+)/);
    if (match) reviewPrNumber = Number(match[1]);
  } else if (classified.notice) {
    role = "notice";
  } else if (classified.type === "user") {
    role = "user";
  } else if (classified.type === "assistant") {
    role = "assistant";
  } else if (classified.type === "tool_use") {
    role = "tool_use";
  } else if (classified.type === "tool_result") {
    role = "tool_result";
  } else {
    role = "system";
  }
  return {
    role,
    contentLength: entry.contentLength ?? entry.content?.length ?? 0,
    ...(reviewPrNumber !== undefined ? { reviewPrNumber } : {}),
  };
}

// ── Bounding ───────────────────────────────────────────────────────────────

function entryTs(entry: TranscriptEntry): number {
  const t = Date.parse(entry.timestamp ?? "");
  return Number.isFinite(t) ? t : Date.now();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Byte-based write-time bounding (§1). Returns the wire-ready `data` JSON
 * (guaranteed <= TRANSCRIPT_DATA_MAX_BYTES), the full original JSON when the
 * entry had to be stripped (else null), and the parsed stripped entry (what
 * goes on the bus/wire — identical to the original when nothing changed).
 */
function boundEntryForStore(entry: TranscriptEntry): {
  data: string;
  full: string | null;
  entry: TranscriptEntry;
} {
  const raw = safeStringify(entry);
  if (!raw) {
    // Unserializable entry (should be impossible for parsed entries) — store
    // a minimal skeleton so the append never throws.
    const skeleton: TranscriptEntry = {
      id: entry.id,
      type: entry.type,
      content: "",
      timestamp: entry.timestamp,
    };
    return { data: safeStringify(skeleton), full: null, entry: skeleton };
  }
  if (Buffer.byteLength(raw) <= TRANSCRIPT_DATA_MAX_BYTES) {
    return { data: raw, full: null, entry };
  }

  const stripped = { ...entry } as TranscriptEntry & {
    toolInput?: unknown;
    contentClamped?: boolean;
    contentLength?: number;
  };

  // toolInput → small summary (full input stays readable via getFullEntry).
  if (stripped.toolInput !== undefined) {
    const tiJson = safeStringify(stripped.toolInput);
    const keys =
      stripped.toolInput &&
      typeof stripped.toolInput === "object" &&
      !Array.isArray(stripped.toolInput)
        ? Object.keys(stripped.toolInput as Record<string, unknown>).slice(0, 50)
        : [];
    stripped.toolInput = {
      toolName: entry.toolName ?? "",
      byteSize: Buffer.byteLength(tiJson),
      keys,
    };
  }

  // images[] data-URLs → os-blob markers the UI resolves via /entry.
  if (Array.isArray(stripped.images)) {
    stripped.images = stripped.images.map((src, i) =>
      typeof src === "string" && src.startsWith("data:")
        ? `os-blob:${entry.id}/${i}`
        : src
    );
  }

  // Byte-truncate content until the serialized form fits, with the same
  // markers clampEntriesForWire uses (contentLength = original char length).
  let json = safeStringify(stripped);
  let bytes = Buffer.byteLength(json);
  if (bytes > TRANSCRIPT_DATA_MAX_BYTES && typeof stripped.content === "string" && stripped.content) {
    const orig = stripped.content;
    stripped.contentClamped = true;
    stripped.contentLength = orig.length;
    let content = orig;
    // Removing N chars removes >= N bytes from the JSON, so this converges
    // in a couple of iterations; the loop cap is a belt-and-braces guard.
    for (let i = 0; i < 24; i++) {
      json = safeStringify(stripped);
      bytes = Buffer.byteLength(json);
      if (bytes <= TRANSCRIPT_DATA_MAX_BYTES) break;
      const over = bytes - TRANSCRIPT_DATA_MAX_BYTES;
      content = content.slice(0, Math.max(0, content.length - Math.max(over, 64)));
      stripped.content = content;
      if (!content) {
        json = safeStringify(stripped);
        bytes = Buffer.byteLength(json);
        break;
      }
    }
  }

  // Pathological residue (huge videos/files arrays etc.): shed them too.
  if (bytes > TRANSCRIPT_DATA_MAX_BYTES) {
    delete stripped.videos;
    delete stripped.files;
    delete stripped.images;
    delete stripped.featuredMedia;
    json = safeStringify(stripped);
    bytes = Buffer.byteLength(json);
  }
  if (bytes > TRANSCRIPT_DATA_MAX_BYTES) {
    // Last resort: minimal skeleton — still upserts/renders, full via blob.
    const skeleton: TranscriptEntry = {
      id: entry.id,
      type: entry.type,
      content: "",
      timestamp: entry.timestamp,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      contentClamped: true,
      contentLength: entry.content?.length ?? 0,
    };
    return { data: safeStringify(skeleton), full: raw, entry: skeleton };
  }

  return { data: json, full: raw, entry: stripped };
}

// ── Page hydration ───────────────────────────────────────────────────────────

function page(rows: { seq: number; change_seq: number; data: string }[]): TranscriptPage {
  const entries: SeqEntry[] = [];
  for (const r of rows) {
    try {
      entries.push({
        ...sanitizeTranscriptMediaEntry(JSON.parse(r.data) as TranscriptEntry),
        seq: r.seq,
        changeSeq: r.change_seq,
      });
    } catch {
      // A corrupt row must never take the whole page down.
      console.warn(`[transcript-store] corrupt row at seq ${r.seq} skipped`);
    }
  }
  return {
    entries,
    firstSeq: entries.length ? entries[0].seq : 0,
    lastSeq: entries.length ? entries[entries.length - 1].seq : 0,
  };
}
