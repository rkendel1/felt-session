/**
 * Read an OpenCode engine session's transcript out of OpenCode's own storage
 * (the ~/.local/share/opencode/opencode.db SQLite database — the pinned
 * opencode versions migrated session/message/part storage from per-file JSON
 * to SQLite) and map it onto our TranscriptEntry shape.
 *
 * This is the missing half of cross-engine handoff for the opencode engine:
 * claude↔codex handoffs read the other engine's transcript file
 * (getEngineTranscriptPath → parseTranscript), but opencode has no transcript
 * *file* to tail — sessions live in SQLite. So instead of a path this module
 * reads entries directly; sessions.ts's readEngineTranscript /
 * mergedSessionTranscript dispatch here for provider "opencode".
 *
 * Read-only by construction ({ readonly: true } + WAL allows concurrent
 * readers), opened per call and closed immediately — never holds the live
 * `opencode serve` processes' database open. Every failure path (missing db,
 * schema drift after an opencode upgrade, corrupt rows) degrades to [] so a
 * transcript read can never take a prompt path down.
 */
import { envAlias } from "./rename-compat";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { Database } from "bun:sqlite";
import type { TranscriptEntry } from "./types";
import type { ImageInput } from "./run-events";
import { stripContext } from "./prompt-context";
import { extractAssistantVideos, parseJsonlLines } from "./jsonl-parser";
import { transcriptStore } from "./transcript-store";

const HOME = process.env.HOME || "/home/ubuntu";

/** The opencode SQLite store for the HOME opencode-runner passes through. */
export let OPENCODE_DB_PATH =
  envAlias("OPENSESSION_OPENCODE_DB", "BACKSTAGE_OPENCODE_DB") ||
  `${HOME}/.local/share/opencode/opencode.db`;

/**
 * Test seam (bun tests only): repoint the sqlite store AFTER this module has
 * been evaluated — mirrors paths.ts's __setChatsDirForTest. ES module
 * bindings are live, so consumers that reference OPENCODE_DB_PATH (including
 * ones that bare-imported this module before the test set env vars) pick the
 * new value up regardless of import order. Returns the previous value so
 * afterAll can restore it.
 */
export function __setOpencodeDbPathForTest(path: string): string {
  const prev = OPENCODE_DB_PATH;
  OPENCODE_DB_PATH = path;
  return prev;
}

// ── Per-server DB sharding: locating a session's database ────────────────────
//
// Since the 2026-07-17 storage review, each `opencode serve` process gets its
// own SQLite file via the (official) OPENCODE_DB env var — per-session servers
// one DB per session, shared servers one DB per (account × user). That means
// "which file holds engine session ses_X?" is no longer a constant. The runner
// records the answer in a small JSON map the moment it creates/uses a session
// (recordOpencodeDbFor); readers resolve through it (resolveOpencodeDbFor) and
// fall back to probing the legacy candidates — the main DB, the per-account
// openai DBs (which the old constant never covered), and recent shard DBs.

/** ocSessionId → absolute DB path, written by the runner, read by resolvers. */
const OPENCODE_DB_MAP_PATH =
  envAlias("OPENSESSION_OPENCODE_DB_MAP", "BACKSTAGE_OPENCODE_DB_MAP") ||
  `${HOME}/.opensession-chats/opencode/db-map.json`;

const OPENAI_DATA_ROOT = `${HOME}/.opensession-opencode/openai-data`;
const SHARD_DB_DIR = `${HOME}/.opensession-chats/opencode/db`;

function readDbMap(): Record<string, string> {
  try {
    if (!existsSync(OPENCODE_DB_MAP_PATH)) return {};
    const parsed = JSON.parse(readFileSync(OPENCODE_DB_MAP_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember which DB file an engine session lives in. Entries whose file is
 *  gone are pruned on write, so the map tracks the shard GC for free. */
export function recordOpencodeDbFor(ocSessionId: string, dbPath: string): void {
  if (!ocSessionId || !dbPath) return;
  try {
    const map = readDbMap();
    if (map[ocSessionId] === dbPath) return;
    map[ocSessionId] = dbPath;
    for (const [id, p] of Object.entries(map)) {
      if (!existsSync(p)) delete map[id];
    }
    mkdirSync(OPENCODE_DB_MAP_PATH.slice(0, OPENCODE_DB_MAP_PATH.lastIndexOf("/")), {
      recursive: true,
    });
    const tmp = `${OPENCODE_DB_MAP_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, OPENCODE_DB_MAP_PATH);
  } catch (e) {
    console.warn("[opencode-transcript] db-map write failed:", e);
  }
}

/** Legacy + shard DB files worth probing when the map has no answer:
 *  per-account openai DBs, then recent shard DBs (newest first, capped). */
function candidateDbPaths(): string[] {
  const out: string[] = [];
  try {
    try {
      for (const acct of readdirSync(OPENAI_DATA_ROOT)) {
        const p = `${OPENAI_DATA_ROOT}/${acct}/opencode/opencode.db`;
        if (existsSync(p)) out.push(p);
      }
    } catch {}
    try {
      const shards = readdirSync(SHARD_DB_DIR)
        .filter((f) => f.endsWith(".db"))
        .map((f) => {
          const p = `${SHARD_DB_DIR}/${f}`;
          try {
            return { p, m: statSync(p).mtimeMs };
          } catch {
            return { p, m: 0 };
          }
        })
        .sort((a, b) => b.m - a.m)
        .slice(0, 50);
      for (const s of shards) out.push(s.p);
    } catch {}
  } catch {}
  return out;
}

/** The DB file holding this engine session: map hit, else probe the main DB
 *  and the candidates (memoizing a hit back into the map). Always returns a
 *  path — the legacy main DB when nothing matches, preserving old behavior. */
export function resolveOpencodeDbFor(ocSessionId: string | null | undefined): string {
  if (!ocSessionId) return OPENCODE_DB_PATH;
  const hit = readDbMap()[ocSessionId];
  if (hit && existsSync(hit)) return hit;
  if (hasOpencodeTranscript(ocSessionId, OPENCODE_DB_PATH)) return OPENCODE_DB_PATH;
  for (const p of candidateDbPaths()) {
    if (hasOpencodeTranscript(ocSessionId, p)) {
      recordOpencodeDbFor(ocSessionId, p);
      return p;
    }
  }
  return OPENCODE_DB_PATH;
}

// ── Transcript v2 (docs/transcript-v2-design.md §3): oc id → unified id ──────
//
// The runner records which UNIFIED session (bks-*/slack-*/…) an engine
// session's transcript entries belong to (recordBksSessionFor — same
// persisted-JSON pattern as recordOpencodeDbFor above; rotation-safe: many oc
// ids map onto one unified id). Recording is UNCONDITIONAL cheap bookkeeping
// (like the db map). The three transcript writers below
// (appendOpencodeTranscript / ensureOpencodeTranscriptFile /
// backfillOpencodeTranscriptGap) write parsed entries into the owned
// transcript store, resolving the unified id through this map. Since the
// 2026-07-23 mirror retirement (§11) the store is the ONLY thing they write —
// mirror jsonl files on disk are a frozen read-only archive. Unresolvable oc
// id → the batch is skipped with a once-per-session warn + store-degraded
// mark (the §8 re-import heals from OpenCode's SQLite once mapped); no store
// failure ever throws into a runner append.

/** ocSessionId → unified session id, written by the runner call sites. */
const OPENCODE_BKS_MAP_PATH =
  envAlias("OPENSESSION_OPENCODE_BKS_MAP", "BACKSTAGE_OPENCODE_BKS_MAP") ||
  `${HOME}/.opensession-chats/opencode/bks-map.json`;

interface BksMapState {
  map: Map<string, string>;
  loaded: boolean;
  /** oc ids we already warned "no unified session mapped" for. */
  warnedUnmapped: Set<string>;
}

/** Parked on globalThis so hot reloads keep the loaded map + warn dedup. */
const bksMapState: BksMapState = ((globalThis as Record<string, unknown> & {
  __osOcBksMap?: BksMapState;
}).__osOcBksMap ??= { map: new Map(), loaded: false, warnedUnmapped: new Set() });

function bksMap(): Map<string, string> {
  if (!bksMapState.loaded) {
    bksMapState.loaded = true;
    try {
      if (existsSync(OPENCODE_BKS_MAP_PATH)) {
        const parsed = JSON.parse(readFileSync(OPENCODE_BKS_MAP_PATH, "utf-8"));
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string" && v) bksMapState.map.set(k, v);
          }
        }
      }
    } catch (e) {
      console.warn("[opencode-transcript] bks-map read failed:", e);
    }
  }
  return bksMapState.map;
}

/** Cap for the persisted bks map (db-map.json's prune-on-write pattern —
 *  without it the file is rewritten whole per new engine session and grows
 *  forever). Above the cap, mappings whose mirror file is gone are dropped
 *  first (nothing readable left to attribute), then oldest-inserted (Map /
 *  JSON object insertion order). The entry being recorded is never dropped. */
const BKS_MAP_MAX_ENTRIES = 2000;

function pruneBksMap(map: Map<string, string>, keep: string): void {
  if (map.size <= BKS_MAP_MAX_ENTRIES) return;
  for (const id of [...map.keys()]) {
    if (map.size <= BKS_MAP_MAX_ENTRIES) return;
    if (id === keep) continue;
    if (!existsSync(getOpencodeTranscriptPath(id))) map.delete(id);
  }
  for (const id of [...map.keys()]) {
    if (map.size <= BKS_MAP_MAX_ENTRIES) return;
    if (id !== keep) map.delete(id);
  }
}

/** Remember which unified session an engine session belongs to. Called from
 *  the runner (run start / rotation / reattach) and the sandbox host mirror —
 *  wherever both ids are in scope. Never throws. */
export function recordBksSessionFor(ocSessionId: string, unifiedId: string): void {
  if (!ocSessionId || !unifiedId) return;
  try {
    const map = bksMap();
    if (map.get(ocSessionId) === unifiedId) return;
    map.set(ocSessionId, unifiedId);
    pruneBksMap(map, ocSessionId);
    mkdirSync(OPENCODE_BKS_MAP_PATH.slice(0, OPENCODE_BKS_MAP_PATH.lastIndexOf("/")), {
      recursive: true,
    });
    const tmp = `${OPENCODE_BKS_MAP_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
    renameSync(tmp, OPENCODE_BKS_MAP_PATH);
  } catch (e) {
    console.warn("[opencode-transcript] bks-map write failed:", e);
  }
}

// ── v2 store-degraded flag (failure-side dirty marker, §8) ───────────────────
//
// With mirror writes retired there is no file growth to notice when a store
// append fails for an OWNED session — this flag is the ONLY signal. The
// failure side records the gap the moment it happens: a failed store append
// (or one skipped for an unresolved oc→unified mapping) flags the session
// store-degraded, and both drift checks (sessions.ts v2TranscriptHasDrift,
// consumed by the store read path AND ws-handlers' serveTranscriptV2) treat a
// set flag as unconditional drift → full re-import (idempotent upserts),
// which clears it. Keys are whichever id the failure site had — unified id
// for append failures, oc id when the mapping was unresolved — and checks
// probe both. Parked on globalThis (best-effort: a restart drops it; the
// dropped batch is then healed by the next re-import from OpenCode's SQLite),
// no sidecar persistence.

const storeDegraded: Set<string> = ((globalThis as Record<string, unknown> & {
  __osOcV2StoreDegraded?: Set<string>;
}).__osOcV2StoreDegraded ??= new Set());

/** Exported for the sibling store writers (file-watcher's watcher-feed) —
 *  any path that got entries into a mirror file but not the store must flag
 *  the session, or the §8 tail probe later masks the mid-transcript gap. */
export function markTranscriptStoreDegraded(id: string | null | undefined): void {
  if (id) storeDegraded.add(id);
}

/** True when any of the ids carries the degraded flag → unconditional drift. */
export function isTranscriptStoreDegraded(
  ...ids: (string | null | undefined)[]
): boolean {
  return ids.some((id) => !!id && storeDegraded.has(id));
}

/** A completed full re-import makes the store whole again — clear the flag
 *  (callers pass every id the session is known by; unknown ids are no-ops). */
export function clearTranscriptStoreDegraded(
  ...ids: (string | null | undefined)[]
): void {
  for (const id of ids) if (id) storeDegraded.delete(id);
}

/** oc ids whose store append/import failure already warned — a persistently
 *  failing store would otherwise warn on every append batch. */
const storeFailWarned: Set<string> = ((globalThis as Record<string, unknown> & {
  __osOcV2StoreFailWarned?: Set<string>;
}).__osOcV2StoreFailWarned ??= new Set());

function warnStoreFailureOnce(ocSessionId: string, msg: string, e: unknown): void {
  if (storeFailWarned.has(ocSessionId)) return;
  storeFailWarned.add(ocSessionId);
  console.warn(`${msg} (further warnings suppressed for this session)`, e);
}

/** The unified session id for an engine session, or null (+ one warn). */
function resolveBksSessionFor(ocSessionId: string): string | null {
  const unifiedId = bksMap().get(ocSessionId);
  if (unifiedId) return unifiedId;
  if (!bksMapState.warnedUnmapped.has(ocSessionId)) {
    bksMapState.warnedUnmapped.add(ocSessionId);
    console.warn(
      `[opencode-transcript] v2: no unified session mapped for ${ocSessionId} — entries not stored (degraded until mapped + re-imported)`
    );
  }
  return null;
}

/**
 * Import-first gate body (§3): synchronously import the session's legacy
 * history (mergedSessionTranscript over the session's transcript file(s) +
 * engine store) into the transcript store. importLegacyTranscript marks the
 * session imported itself; an empty history is marked 'live-only'.
 *
 * Cycle note: sessions.ts / session-cache.ts import THIS module, so they can
 * never be static imports here. A call-time require() is the synchronous
 * shape of the design's "lazy dynamic import()" cycle-breaker: by the time
 * any store write runs, both modules are long-evaluated, so this is a module
 * cache hit — and merely importing opencode-transcript.ts (tests, tools)
 * never pulls the sessions graph in, because the require only executes on
 * the flag-gated write path.
 */
function importLegacyIntoStore(unifiedId: string, ocSessionId: string): void {
  const sessionsMod = require("./sessions") as typeof import("./sessions");
  let session:
    | Parameters<typeof sessionsMod.mergedSessionTranscript>[0]
    | undefined;
  try {
    const cacheMod = require("./session-cache") as typeof import("./session-cache");
    session = cacheMod.findSession(unifiedId);
  } catch {}
  // Deliberately id-less ref: guarantees the legacy merge (an id-carrying ref
  // would route mergedSessionTranscript back into the v2 store path).
  const ref = session
    ? {
        transcriptPath: session.transcriptPath ?? null,
        opencodeSessionId: session.opencodeSessionId,
        claudeSessionId: session.claudeSessionId ?? null,
      }
    : {
        transcriptPath: existingOpencodeTranscriptPath(ocSessionId),
        opencodeSessionId: ocSessionId,
        claudeSessionId: null,
      };
  const entries = sessionsMod.mergedSessionTranscript(ref);
  // Watermark = TOTAL size of the §8 drift candidate set at import time (the
  // session transcript file + the oc mirror — sessions.ts v2MirrorFiles, the
  // same set the drift compare sums). Measuring only one file would make an
  // imported session look permanently grown-beyond-watermark.
  let watermark: number | null = null;
  try {
    const files = sessionsMod.v2MirrorFiles(ref);
    if (files.length) watermark = files.reduce((sum, f) => sum + f.size, 0);
  } catch {}
  transcriptStore().importLegacyTranscript(
    unifiedId,
    entries,
    entries.length ? "merged" : "live-only",
    watermark
  );
  // A full import makes the store whole — release the failure-side marker.
  clearTranscriptStoreDegraded(unifiedId, ocSessionId);
}

/** Run the import-first gate for a session without appending anything —
 *  ensure/backfill call this so run start front-loads the legacy import
 *  instead of racing it against the first live append. Never throws. */
function storeEnsureImported(ocSessionId: string): void {
  const unifiedId = resolveBksSessionFor(ocSessionId);
  if (!unifiedId) return;
  try {
    if (transcriptStore().needsImport(unifiedId)) {
      importLegacyIntoStore(unifiedId, ocSessionId);
    }
  } catch (e) {
    // No degraded mark needed here: the import failing leaves needsImport
    // true, so the v2 read/serve paths never trust the store for this
    // session; the append path retries the gate (and marks on failure).
    warnStoreFailureOnce(
      ocSessionId,
      `[opencode-transcript] v2 legacy import failed for ${ocSessionId} → ${unifiedId} (legacy readers serve until an import succeeds)`,
      e
    );
  }
}

/** The store write behind appendOpencodeTranscript — since mirror retirement
 *  the ONLY transcript write. Normalizes claude-shape lines through the
 *  shared parse path (transcriptLineForEntry-built lines → parseJsonlLines →
 *  appendTranscriptEvents), runs the import-first gate itself, and
 *  upsert-dedupes by entry id. Never throws. */
function storeAppendLines(ocSessionId: string, lines: JsonlLine[]): void {
  const unifiedId = resolveBksSessionFor(ocSessionId);
  if (!unifiedId) {
    // No unified id yet — this batch never reaches the store, and with no
    // mirror growth there is nothing else to notice it later. Flag it (by
    // the only id we have) so the §8 drift checks force a full re-import
    // from OpenCode's SQLite once the mapping resolves.
    markTranscriptStoreDegraded(ocSessionId);
    return;
  }
  try {
    const entries = parseJsonlLines(lines.map((l) => JSON.stringify(l)));
    if (!entries.length) return;
    transcriptStore().appendTranscriptEvents(unifiedId, entries, {
      ensureImported: (sid) => importLegacyIntoStore(sid, ocSessionId),
    });
  } catch (e) {
    // The batch is dropped — flag the session so the drift checks stop
    // trusting the store until a full re-import restores it from the engine
    // sources (runner notices in the batch are lost; engine turns are not —
    // they live in OpenCode's SQLite).
    markTranscriptStoreDegraded(unifiedId);
    warnStoreFailureOnce(
      ocSessionId,
      `[opencode-transcript] v2 store append failed for ${ocSessionId} (batch dropped until re-import)`,
      e
    );
  }
}

/**
 * Persist a turn's user line under a KNOWN unified session id BEFORE any
 * engine session exists (intake-time durability). A run killed while still
 * starting — account pick, server spawn: the 2026-07-24 restart window that
 * lost a session's opening prompt entirely — leaves the message durable and
 * visible this way. The line must carry a stable uuid (the caller threads it
 * through RunAgentOpts.promptEntryId): the engine-run write later upserts the
 * same (session, uuid) row in place instead of duplicating the bubble.
 * `priorOcSessionId` (a resumed session's engine id) feeds the import-first
 * gate so a never-imported legacy session backfills before this live append;
 * fresh sessions pass none and are correctly marked live-only. Never throws.
 */
export function storeAppendUserLineEarly(
  unifiedId: string,
  line: Record<string, unknown>,
  priorOcSessionId?: string | null
): void {
  if (!unifiedId) return;
  try {
    const entries = parseJsonlLines([JSON.stringify(line)]);
    if (!entries.length) return;
    transcriptStore().appendTranscriptEvents(unifiedId, entries, {
      ensureImported: priorOcSessionId
        ? (sid) => importLegacyIntoStore(sid, priorOcSessionId)
        : undefined,
    });
  } catch (e) {
    warnStoreFailureOnce(
      unifiedId,
      `[opencode-transcript] early user-line persist failed for ${unifiedId}`,
      e
    );
  }
}

/**
 * Where the runner USED to persist a claude-shape JSONL mirror per opencode
 * session, until the 2026-07-23 mirror retirement (design §11). The files
 * that exist are a FROZEN read-only archive: nothing appends to or seeds
 * them anymore, but every legacy reader (parseTranscript, the resolver scan,
 * import/re-import via mergedSessionTranscript, the §8 watermark math) keeps
 * reading them. Deliberately a directory *inside* ~/.claude/projects: the
 * transcript resolver's last-resort scan (sessions.ts findTranscriptBySessionId)
 * walks every projects subdir for `<id>.jsonl`, so the archive is discovered
 * by that existing convention with zero resolver special-cases. The dir name
 * follows the hashed -cwd- convention and corresponds to no real checkout path.
 */
export let OPENCODE_TRANSCRIPTS_DIR =
  envAlias(
    "OPENSESSION_OPENCODE_TRANSCRIPTS_DIR",
    "BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR",
  ) || `${HOME}/.claude/projects/-opencode-engine`;

/** Test seam (bun tests only): see __setOpencodeDbPathForTest above — same
 *  live-binding repoint, for the transcript mirror dir. */
export function __setOpencodeTranscriptsDirForTest(dir: string): string {
  const prev = OPENCODE_TRANSCRIPTS_DIR;
  OPENCODE_TRANSCRIPTS_DIR = dir;
  return prev;
}

export function getOpencodeTranscriptPath(ocSessionId: string): string {
  const safe = ocSessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${OPENCODE_TRANSCRIPTS_DIR}/${safe}.jsonl`;
}

/** The persisted transcript file, or null when this session has none (yet). */
export function existingOpencodeTranscriptPath(
  ocSessionId: string | null | undefined
): string | null {
  if (!ocSessionId) return null;
  const path = getOpencodeTranscriptPath(ocSessionId);
  return existsSync(path) ? path : null;
}

// ── Claude-shape JSONL line builders ─────────────────────────────────────────
// The persisted file is parsed by jsonl-parser's claude-line parser (and by
// the live file watcher), so lines mimic the minimal subset of the Claude SDK
// jsonl shape the parser reads: type/uuid/timestamp + message.content blocks.

type JsonlLine = Record<string, unknown>;

export function transcriptLineUser(
  text: string,
  id?: string,
  ts?: string,
  images?: ImageInput[]
): JsonlLine {
  return {
    type: "user",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "user",
      content: [
        { type: "text", text },
        // Pasted images ride alongside the text block in the same claude-shape
        // blocks jsonl-parser's extractImages reads — without them the mirror
        // file loses the images the run actually received (they only exist in
        // opencode's SQLite as `file` parts, which nothing renders).
        ...(images || []).map((im) => ({
          type: "image",
          source: { type: "base64", media_type: im.mediaType, data: im.data },
        })),
      ],
    },
  };
}

/** Runner operational notice ("usage limit hit; switched account and
 *  retrying") as a durable transcript line. Rides a user-role line — the only
 *  role the runner can inject without claiming the model said something — with
 *  a harness marker the jsonl parser maps to a `system` entry (same pattern as
 *  `<task-notification>`), so it renders as a system chip instead of a user
 *  bubble and never confuses pending-bubble/steer reconciliation. */
export function transcriptLineRunnerNotice(
  text: string,
  id?: string,
  ts?: string
): JsonlLine {
  return transcriptLineUser(`<runner-notice>${text}</runner-notice>`, id, ts);
}

/** Engine context-compaction summary (opencode autocompact: a synthetic user
 *  message with a `compaction` part, answered by an assistant message with
 *  `summary: true` whose text is the handoff summary). Same user-role +
 *  harness-marker pattern as runner notices; the jsonl parser maps it to a
 *  system entry with `compaction: true` so the UI renders a collapsed
 *  "context compacted" chip instead of an assistant bubble. */
export function transcriptLineCompactionSummary(
  text: string,
  id?: string,
  ts?: string
): JsonlLine {
  return transcriptLineUser(`<compaction-summary>${text}</compaction-summary>`, id, ts);
}

export function transcriptLineAssistantText(
  text: string,
  id?: string,
  ts?: string,
  model?: string
): JsonlLine {
  return {
    type: "assistant",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      // Same slot the Claude SDK uses on its assistant lines, so the shared
      // jsonl parser reads both without a special case.
      ...(model ? { model } : {}),
    },
  };
}

export function transcriptLineToolUse(
  toolUseId: string,
  name: string,
  input: unknown,
  ts?: string
): JsonlLine {
  return {
    type: "assistant",
    uuid: `${toolUseId}-use`,
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input: input ?? {} }],
    },
  };
}

export function transcriptLineToolResult(
  toolUseId: string,
  content: string,
  isError?: boolean,
  ts?: string,
  images?: string[],
): JsonlLine {
  return {
    type: "user",
    uuid: `${toolUseId}-result`,
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: images?.length
            ? [
                { type: "text", text: content },
                ...images.map((url) => ({
                  type: "image",
                  source: { type: "url", url },
                })),
              ]
            : content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

/** Map an already-parsed TranscriptEntry (any engine) back onto a claude-shape
 *  jsonl line, preserving ids so re-parsed copies upsert instead of duplicate.
 *  Since mirror retirement this is internal normalization plumbing only: the
 *  reattach gap-backfill (and the claude-direct adapter) route entries through
 *  transcriptLineForEntry → parseJsonlLines → appendTranscriptEvents so every
 *  writer shares ONE parse/identity path into the store — no file is written. */
export function transcriptLineForEntry(e: TranscriptEntry): JsonlLine | null {
  switch (e.type) {
    case "user": {
      const line = transcriptLineUser(e.content, e.id, e.timestamp);
      if (e.images?.length) {
        // Entry images are ready-to-render srcs (data: or http(s) URLs) — a
        // url-source image block round-trips both through extractImages.
        (line.message as { content: unknown[] }).content.push(
          ...e.images.map((src) => ({
            type: "image",
            source: { type: "url", url: src },
          }))
        );
      }
      return line;
    }
    case "assistant":
      return transcriptLineAssistantText(e.content, e.id, e.timestamp, e.model);
    case "tool_use":
      return transcriptLineToolUse(
        e.toolUseId || e.id,
        e.toolName || "Tool",
        e.toolInput,
        e.timestamp
      );
    case "tool_result":
      return e.toolUseId
        ? transcriptLineToolResult(e.toolUseId, e.content, e.isError, e.timestamp, e.images)
        : null;
    case "system":
      // Compaction summaries round-trip (readOpencodeTranscript emits them and
      // the reattach gap-backfill must not drop them). The parser derives the
      // entry id as `sys-<line uuid>`, so strip the prefix to keep the upsert
      // key stable. Other system entries stay derived-only.
      return e.compaction
        ? transcriptLineCompactionSummary(
            e.content,
            e.id.startsWith("sys-") ? e.id.slice(4) : e.id,
            e.timestamp
          )
        : null;
    default:
      return null;
  }
}

/** Append transcript entries for an engine session to the owned store
 *  (best-effort — a transcript write must never take the run down). `lines`
 *  are claude-shape jsonl lines (the transcriptLine* builders above); since
 *  the 2026-07-23 mirror retirement they are internal plumbing only — parsed
 *  straight into entries (parseJsonlLines) inside storeAppendLines and
 *  stored, never written to a file. Mirror jsonl files on disk are a frozen
 *  read-only archive. */
export function appendOpencodeTranscript(
  ocSessionId: string,
  lines: JsonlLine[]
): void {
  if (!lines.length) return;
  storeAppendLines(ocSessionId, lines);
}

/**
 * Run-start transcript prep: front-load the store's legacy-history import
 * (§3 import-first gate) so the first live append never races it. Mirror
 * retirement (2026-07-23): this no longer seeds a mirror jsonl file. `_seed`
 * (a cross-engine handoff's prior-engine entries) is deliberately unused —
 * the store import reads the same sources directly (the session's
 * prior-engine transcript file(s) + OpenCode's SQLite, via
 * mergedSessionTranscript); the parameter stays so pre-restart runner
 * closures and existing call sites keep the old arity.
 */
export function ensureOpencodeTranscriptFile(
  ocSessionId: string,
  _seed?: TranscriptEntry[]
): void {
  storeEnsureImported(ocSessionId);
}

/** Uuids already present in a session's persisted transcript file. */
export function opencodeTranscriptUuids(ocSessionId: string): Set<string> {
  const out = new Set<string>();
  try {
    const path = getOpencodeTranscriptPath(ocSessionId);
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid;
        if (typeof uuid === "string" && uuid) out.add(uuid);
      } catch {}
    }
  } catch {}
  return out;
}

/**
 * Append transcript lines for engine activity the live mirror missed — the
 * restart gap, where a turn kept executing inside a detached `opencode serve`
 * while no backstage process was around to pump its events (reattach path,
 * opencode-runner.tryReattachOpencodeRun). Assistant text and tool lines
 * only: their uuids are stable opencode part ids in BOTH writers (the live
 * SSE mirror and the SQLite reader), so uuid-dedup is sound; user lines are
 * written by the runner at send time with random uuids and never need
 * backfill. Returns every uuid now present, for seeding the live pump's
 * dedup sets so post-gap events don't double-append.
 */
export function backfillOpencodeTranscriptGap(ocSessionId: string): Set<string> {
  // Run the import-first gate even when there is no gap to fill (§3): the
  // restart-reattach path is the first store writer for every in-flight run
  // after a restart.
  //
  // `seen` starts from the frozen mirror file's uuids (empty for sessions
  // created after the 2026-07-23 mirror retirement): entries already in the
  // frozen archive were covered by the store import, so only SQLite entries
  // beyond them need appending. The append below is store-only; with the
  // file frozen, each reattach recomputes the same `missing` set from SQLite
  // and re-upserts it — idempotent (§1 upsert semantics), just a little
  // churn. The returned set still seeds the live pump's dedup so post-gap
  // SSE events don't double-append to the store.
  storeEnsureImported(ocSessionId);
  const seen = opencodeTranscriptUuids(ocSessionId);
  try {
    const missing: JsonlLine[] = [];
    for (const e of readOpencodeTranscript(ocSessionId)) {
      if (e.type === "user") continue;
      const line = transcriptLineForEntry(e);
      if (!line) continue;
      const uuid = String(line.uuid || "");
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      missing.push(line);
    }
    if (missing.length) {
      appendOpencodeTranscript(ocSessionId, missing);
      console.log(
        `[opencode-transcript] backfilled ${missing.length} gap line(s) for ${ocSessionId}`
      );
    }
  } catch (e) {
    console.warn(`[opencode-transcript] gap backfill failed for ${ocSessionId}:`, e);
  }
  return seen;
}

/**
 * OpenCode session ids look like `ses_0bc487ca3ffe…` — used to recognize
 * legacy session files where the opencode id rides the claude slot (runs
 * persisted before the dedicated `opencodeSessionId` field existed), and to
 * refuse resuming a Claude run on an id that was never Claude's.
 */
export function isOpencodeSessionId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("ses_");
}

interface MessageData {
  role?: string;
  time?: { created?: number };
  error?: { name?: string; data?: { message?: string } };
  // Assistant messages carry the upstream provider/model that produced them.
  providerID?: string;
  modelID?: string;
  // Autocompact summary marker on assistant messages (`summary: true`, agent/
  // mode "compaction"). NOTE: user messages carry `summary` too, as a diffs
  // OBJECT — always gate on role + `summary === true`, never truthiness.
  agent?: string;
  mode?: string;
  summary?: unknown;
}

/** An assistant message that is opencode's autocompact handoff summary (the
 *  reply to a synthetic user message bearing a `compaction` part). */
function isCompactionMessage(data: MessageData): boolean {
  return (
    data.role === "assistant" &&
    (data.summary === true || data.agent === "compaction" || data.mode === "compaction")
  );
}

interface PartData {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  // `file` parts (pasted images ride as data: URLs).
  mime?: string;
  url?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
    attachments?: Array<{
      type?: string;
      mime?: string;
      url?: string;
    }>;
  };
}

const LOCAL_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
// Leave ample room under public-ingress's 64 MiB WS ceiling for the event
// envelope and tool output. OpenCode/provider image limits are much lower in
// normal operation; this is a transport safety bound, not an expected size.
const MAX_INLINE_TOOL_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * OpenCode's Read tool persists image bytes as a base64 file attachment on the
 * tool state. Preserve that immutable snapshot rather than linking back to the
 * source path, which may be sandbox-only, outside the default worktree root, or
 * overwritten after Read completes. The transcript store externalizes large
 * entries into its blob table, so the entry itself remains bounded.
 */
export function opencodeToolResultImages(part: PartData): string[] {
  if (part.type !== "tool" || part.state?.status !== "completed") return [];
  if (part.tool !== "read" && part.tool !== "view_image") return [];
  const returnedImage = part.state.attachments?.find(
    (attachment) =>
      attachment?.type === "file" &&
      typeof attachment.mime === "string" &&
      LOCAL_IMAGE_MIMES.has(attachment.mime.toLowerCase()),
  );
  if (!returnedImage) return [];
  const mime = returnedImage.mime!.toLowerCase();
  return typeof returnedImage.url === "string" &&
    returnedImage.url.startsWith(`data:${mime};base64,`) &&
    Buffer.byteLength(returnedImage.url) <= MAX_INLINE_TOOL_IMAGE_BYTES
    ? [returnedImage.url]
    : [];
}

function toIso(ms: number | undefined, fallback: string): string {
  if (!ms || !Number.isFinite(ms)) return fallback;
  try {
    return new Date(ms).toISOString();
  } catch {
    return fallback;
  }
}

/** Does OpenCode's store know this session id? (Cheap existence probe.) */
export function hasOpencodeTranscript(
  sessionId: string | null | undefined,
  dbPath = OPENCODE_DB_PATH
): boolean {
  if (!sessionId || !existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return !!db
        .query("SELECT 1 FROM session WHERE id = ? LIMIT 1")
        .get(sessionId);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Did this session's LAST engine turn end cleanly? Reads the store directly:
 * true  = trailing message is an assistant message with `time.completed`;
 * false = trailing message is a user prompt with no assistant reply, or an
 *         assistant message that never completed — the turn died mid-flight;
 * null  = no messages / store unreadable (no signal — caller keeps its default).
 */
export function opencodeTurnLooksCompleted(
  sessionId: string | null | undefined
): boolean | null {
  if (!sessionId) return null;
  const dbPath = resolveOpencodeDbFor(sessionId);
  if (!existsSync(dbPath)) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .query(
        "SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1"
      )
      .get(sessionId) as { data: string } | null;
    if (!row) return null;
    const data = JSON.parse(row.data) as MessageData & {
      time?: { created?: number; completed?: number };
    };
    if (data.role === "user") return false;
    return typeof data.time?.completed === "number";
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * The session's transcript as TranscriptEntry[] — user/assistant text plus
 * tool_use/tool_result pairs, in message order. Synthetic parts (opencode's
 * own injected text) are skipped, and `<backstage:context>` fences (engine
 * handoffs, repos notes) are stripped from user text exactly like the claude
 * jsonl parser does, so the UI shows only what the human typed.
 */
export function readOpencodeTranscript(
  sessionId: string | null | undefined,
  dbPath?: string
): TranscriptEntry[] {
  if (!sessionId) return [];
  // No explicit path ⇒ resolve which shard/legacy DB holds this session.
  if (!dbPath) dbPath = resolveOpencodeDbFor(sessionId);
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  try {
    const messages = db
      .query(
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC"
      )
      .all(sessionId) as Array<{ id: string; data: string; time_created: number }>;
    if (!messages.length) return [];
    const parts = db
      .query(
        "SELECT id, message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC"
      )
      .all(sessionId) as Array<{
      id: string;
      message_id: string;
      data: string;
      time_created: number;
    }>;

    const partsByMessage = new Map<string, typeof parts>();
    for (const p of parts) {
      const list = partsByMessage.get(p.message_id);
      if (list) list.push(p);
      else partsByMessage.set(p.message_id, [p]);
    }

    const entries: TranscriptEntry[] = [];
    for (const m of messages) {
      let data: MessageData;
      try {
        data = JSON.parse(m.data);
      } catch {
        continue;
      }
      const role = data.role === "user" ? "user" : "assistant";
      const ts = toIso(data.time?.created ?? m.time_created, new Date(0).toISOString());
      // Reconstruct our full model id shape from opencode's provider/model pair.
      const model =
        role === "assistant" && data.providerID && data.modelID
          ? `opencode/${data.providerID}/${data.modelID}`
          : undefined;
      // Pasted images arrive as `file` parts alongside the message's text part;
      // collect their renderable srcs and hang them on the message's user entry
      // (mirrors jsonl-parser's pasted-image handling).
      const msgImages: string[] = [];
      const entriesStart = entries.length;
      for (const p of partsByMessage.get(m.id) || []) {
        let part: PartData;
        try {
          part = JSON.parse(p.data);
        } catch {
          continue;
        }
        if (part.type === "file") {
          const url = typeof part.url === "string" ? part.url : "";
          if (role === "user" && url && (part.mime || "").startsWith("image/")) {
            msgImages.push(url);
          }
          continue;
        }
        if (part.type === "text") {
          if (part.synthetic) continue;
          const text = role === "user" ? stripContext(part.text || "") : part.text || "";
          if (!text.trim()) continue;
          // Autocompact handoff summary: a system chip, not an assistant
          // bubble. `sys-` prefix matches the id the jsonl parser derives for
          // the live-written <compaction-summary> line, so both writers upsert
          // the same entry.
          if (isCompactionMessage(data)) {
            entries.push({
              id: `sys-${p.id}`,
              type: "system",
              content: text,
              timestamp: ts,
              compaction: true,
            });
            continue;
          }
          const assistant = role === "assistant" ? extractAssistantVideos(text) : undefined;
          entries.push({
            id: p.id,
            type: role,
            content: assistant?.content ?? text,
            timestamp: ts,
            ...(model ? { model } : {}),
            ...(assistant?.videos.length ? { videos: assistant.videos } : {}),
          });
        } else if (part.type === "tool") {
          const images = opencodeToolResultImages(part);
          entries.push({
            id: p.id,
            type: "tool_use",
            content: `Using ${part.tool || "tool"}`,
            timestamp: ts,
            toolName: part.tool,
            toolInput: part.state?.input,
            toolUseId: p.id,
          });
          const state = part.state;
          if (state?.status === "completed" || state?.status === "error") {
            entries.push({
              id: `tr-${p.id}`,
              type: "tool_result",
              content:
                state.status === "completed"
                  ? state.output || ""
                  : `Error: ${state.error || "tool failed"}`,
              timestamp: ts,
              toolUseId: p.id,
              ...(state.status === "error" ? { isError: true } : {}),
              ...(images.length ? { images } : {}),
            });
          }
        }
        // reasoning / step-start / step-finish / patch / snapshot parts
        // have no transcript rendering — skip.
      }
      if (msgImages.length) {
        const lastUser = [...entries.slice(entriesStart)]
          .reverse()
          .find((e) => e.type === "user");
        if (lastUser) {
          lastUser.images = [...(lastUser.images || []), ...msgImages];
        } else {
          entries.push({
            id: m.id,
            type: "user",
            content: "",
            timestamp: ts,
            images: msgImages,
          });
        }
      }
    }
    return entries;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}
