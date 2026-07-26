import { chmodSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { existsSync } from "fs";
import {
	slackIdToFirstName,
	githubLoginToPersonKey,
	githubLoginFor,
} from "./shared/user-mappings";
import { isArchivedId, getArchiveReason } from "./archive";
import { getTitleOverride } from "./title-overrides";
import { getStatusOverride } from "./status-overrides";
import { getReviewRequest } from "./review-requests";
import { getGeneratedTitle } from "./generated-titles";
import { findCodexRollout } from "./codex-accounts";
import { providerFor } from "./models";
import { parseTranscript, parseTranscriptAsync } from "./jsonl-parser";
import { type SeqEntry, type TranscriptStore, transcriptStore } from "./transcript-store";
import {
  isOpencodeSessionId,
  readOpencodeTranscript,
  existingOpencodeTranscriptPath,
  isTranscriptStoreDegraded,
  clearTranscriptStoreDegraded,
} from "./opencode-transcript";
import { configuredRepos, defaultRepo } from "./config";
import { isLockHeld, readPrState } from "../agents/github/state";
import { ghRateLimited, noteGhRateLimited, isGhRateLimitMsg, botGhToken } from "./github-limit";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import { writeJsonAtomic } from "./shared/atomic-write";
import type {
  UnifiedSession,
  SlackSessionFile,
  LinearSessionFile,
  CLISessionFile,
  BackstageSessionFile,
  SessionPrRef,
  TranscriptEntry,
} from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const SLACK_SESSIONS_DIR = `${HOME}/.slack-sessions`;
const LINEAR_SESSIONS_DIR = `${HOME}/.linear-sessions`;
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
const SESSIONS_DIR = OPENSESSION_CHATS_DIR;
const CLAUDE_PROJECTS_DIR = `${HOME}/.claude/projects`;

const SKIP_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
  "prompt-queues.json",
  "active-at-shutdown.json",
  "active-runs.json",
  "processed-events.json",
]);

function resolveSlackUser(userId: string): string {
  // Could be a Slack user ID (e.g. UT41L6GCC) or already a display name
  const mapped = slackIdToFirstName(userId);
  if (mapped) return mapped;
  // Extract first name from "Firstname Lastname" format
  if (userId.includes(" ")) return userId.split(" ")[0];
  return userId;
}

export function getTranscriptPath(
  worktreeDir: string,
  sessionId: string
): string {
  const hash = worktreeDir.replaceAll("/", "-").replace(/^-/, "");
  return `${CLAUDE_PROJECTS_DIR}/-${hash}/${sessionId}.jsonl`;
}

export function getEngineTranscriptPath(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "opencode"
): string | null {
  if (provider === "codex") {
    return findCodexRollout(engineSessionId)?.path || null;
  }
  // OpenCode's own storage is SQLite (no tailable file), but the opencode
  // runner persists a claude-shape jsonl per session precisely so the watcher
  // and reload paths work unchanged. Null until the session's first persisted
  // run (the runner creates the file before yielding init).
  if (provider === "opencode") return existingOpencodeTranscriptPath(engineSessionId);
  return getTranscriptPath(worktreeDir, engineSessionId);
}

/**
 * A session's engine transcript as entries, whatever the engine: claude jsonl
 * and codex rollouts parse from their transcript file; opencode reads straight
 * out of OpenCode's SQLite store. This is the source for cross-engine handoff
 * notes (buildEngineSwitchHandoffNote) in BOTH directions — including the
 * previously-stubbed opencode→claude/codex direction.
 */
export function readEngineTranscript(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "opencode"
): TranscriptEntry[] {
  if (provider === "opencode") return readOpencodeTranscript(engineSessionId);
  const path = getEngineTranscriptPath(worktreeDir, engineSessionId, provider);
  return path ? parseTranscript(path) : [];
}

/** readEngineTranscript with the file parse yielding to the event loop —
 *  identical output. The opencode SQLite read stays sync (bounded pages). */
export async function readEngineTranscriptAsync(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "opencode"
): Promise<TranscriptEntry[]> {
  if (provider === "opencode") return readOpencodeTranscript(engineSessionId);
  const path = getEngineTranscriptPath(worktreeDir, engineSessionId, provider);
  return path ? parseTranscriptAsync(path) : [];
}

/** What mergedSessionTranscript needs from a session. `id` (the unified
 *  session id) is optional and only consulted by the flag-gated transcript v2
 *  read path — callers passing a full UnifiedSession opt in automatically;
 *  id-less refs (the import routines' deliberately id-less ones) always take
 *  the legacy merge. */
type TranscriptSessionRef = Pick<
  UnifiedSession,
  "transcriptPath" | "opencodeSessionId" | "claudeSessionId"
> & { id?: string };

/**
 * Full UI transcript for a session that may span engines: the claude/codex
 * transcript file (turns before a migration to opencode, or the whole history
 * for single-engine sessions) merged with the opencode store's entries (turns
 * after), ordered by timestamp. Also covers legacy session files where the
 * opencode id rides the claude slot (pre-`opencodeSessionId` runs) — those
 * previously rendered as an empty transcript after a reload.
 *
 * Transcript v2 (docs/transcript-v2-design.md §8): when the session's history
 * has been imported into the owned transcript store and the legacy files show
 * no unexplained growth beyond the import watermark, this serves the store's
 * entries (bounded wire forms — the /entry/:id route resolves full content).
 * On drift it triggers a re-import (upserts make that idempotent) and serves
 * legacy for that call. Id-less refs (the import routines') and any store
 * failure take the legacy merge below — the code-level fallback that replaced
 * the retired env kill switch.
 */
export function mergedSessionTranscript(
  session: TranscriptSessionRef
): TranscriptEntry[] {
  if (
    session.id &&
    // Plain loop runs don't thread a unified session id to the runner (§3) —
    // their store rows would be forever partial; they stay fully legacy.
    // (Linear runs thread transcriptSessionId, so linear- sessions are
    // v2-eligible like everything else.)
    !session.id.startsWith("plain-")
  ) {
    try {
      const served = v2StoreTranscript(session.id, session);
      if (served) return served;
    } catch (e) {
      console.warn(
        `[sessions] transcript v2 read failed for ${session.id} — legacy path:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return legacyMergedSessionTranscript(session);
}

/**
 * mergedSessionTranscript for bulk/background paths (legacy v2 imports, the
 * session-index sweep): identical output, but the big JSONL parses go through
 * parseTranscriptAsync so a fat transcript yields to the event loop instead
 * of wedging it. The v2 store read stays sync (bounded SQLite pages).
 */
export async function mergedSessionTranscriptAsync(
  session: TranscriptSessionRef
): Promise<TranscriptEntry[]> {
  if (session.id && !session.id.startsWith("plain-")) {
    try {
      const served = v2StoreTranscript(session.id, session);
      if (served) return served;
    } catch (e) {
      console.warn(
        `[sessions] transcript v2 read failed for ${session.id} — legacy path:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  const fileEntries = session.transcriptPath
    ? await parseTranscriptAsync(session.transcriptPath)
    : [];
  const ocId = legacyOcId(session);
  if (!ocId) return fileEntries;
  const ocPath = existingOpencodeTranscriptPath(ocId);
  if (ocPath && ocPath === session.transcriptPath) return fileEntries;
  const ocEntries = ocPath
    ? await parseTranscriptAsync(ocPath)
    : readOpencodeTranscript(ocId);
  return mergeLegacyEntries(fileEntries, ocEntries);
}

/** The pre-v2 merge (transcript file(s) + opencode store), unchanged. */
function legacyMergedSessionTranscript(
  session: TranscriptSessionRef
): TranscriptEntry[] {
  const fileEntries = session.transcriptPath
    ? parseTranscript(session.transcriptPath)
    : [];
  const ocId = legacyOcId(session);
  if (!ocId) return fileEntries;
  // Prefer the persisted claude-shape file (it is seeded/backfilled to be
  // self-contained); fall back to reading OpenCode's SQLite store for legacy
  // sessions whose next run hasn't backfilled a file yet.
  const ocPath = existingOpencodeTranscriptPath(ocId);
  if (ocPath && ocPath === session.transcriptPath) return fileEntries;
  const ocEntries = ocPath ? parseTranscript(ocPath) : readOpencodeTranscript(ocId);
  return mergeLegacyEntries(fileEntries, ocEntries);
}

function legacyOcId(session: TranscriptSessionRef): string | null {
  return (
    session.opencodeSessionId ||
    (isOpencodeSessionId(session.claudeSessionId) ? session.claudeSessionId : null)
  );
}

function mergeLegacyEntries(
  fileEntries: TranscriptEntry[],
  ocEntries: TranscriptEntry[]
): TranscriptEntry[] {
  if (!ocEntries.length) return fileEntries;
  if (!fileEntries.length) return ocEntries;
  // A seeded opencode file repeats the prior engine's entries (same ids) —
  // dedupe by id, keeping the first occurrence, then order by time.
  const seen = new Set<string>();
  const merged = [...fileEntries, ...ocEntries].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return merged.sort((a, b) =>
    (a.timestamp || "").localeCompare(b.timestamp || "")
  );
}

// ── Transcript v2 read path (docs/transcript-v2-design.md §8) ───────────────
// Only reached when the caller passed a session id; transcriptStore() is
// never touched otherwise (its DB open is lazy).

/** The legacy transcript files for this session (same candidate set as the
 *  import watermark: the session transcript file + the oc mirror). Since the
 *  2026-07-23 mirror retirement only EXTERNAL-writer files (claude/codex CLI
 *  transcriptPath) still grow — oc mirrors are a frozen archive whose
 *  constant size keeps pre-retirement watermarks coherent, which is why they
 *  stay in the set. Exported for the sibling §8 consumers — ws-handlers'
 *  serveTranscriptV2 (sync-import ceiling + import watermark) and
 *  opencode-transcript's importLegacyIntoStore (import watermark) — so every
 *  watermark covers the exact set this module drifts against. */
export function v2MirrorFiles(
  session: TranscriptSessionRef
): { path: string; size: number }[] {
  const candidates: string[] = [];
  if (session.transcriptPath) candidates.push(session.transcriptPath);
  const ocId =
    session.opencodeSessionId ||
    (isOpencodeSessionId(session.claudeSessionId) ? session.claudeSessionId : null);
  if (ocId) {
    const ocPath = existingOpencodeTranscriptPath(ocId);
    if (ocPath && !candidates.includes(ocPath)) candidates.push(ocPath);
  }
  const files: { path: string; size: number }[] = [];
  for (const path of candidates) {
    try {
      files.push({ path, size: statSync(path).size });
    } catch {
      // missing candidate — nothing to drift against from it
    }
  }
  return files;
}

/**
 * Every stored entry for the session, ascending seq (paged readSince),
 * hydrated to FULL forms: rows whose 32KB-bounded `data` is a stripped wire
 * form resolve their original entry from transcript_blobs via getFullEntry
 * (which falls back to the row's own data, so non-stripped entries round-trip
 * unchanged). This feeds FTS distill / get_session / the HTTP transcript
 * route — not the WS hot path — and legacy served those consumers unstripped
 * content; wire-level clamping stays the serializers' job
 * (clampEntriesForWire at the send sites).
 */
function v2ReadAll(store: TranscriptStore, sessionId: string): TranscriptEntry[] {
  const PAGE = 2000;
  const out: SeqEntry[] = [];
  let since = 0;
  for (;;) {
    const page = store.readSince(sessionId, since, PAGE);
    if (!page.entries.length) break;
    for (const e of page.entries) {
      const full = store.getFullEntry(sessionId, e.id);
      out.push(full ? { ...full, seq: e.seq, changeSeq: e.changeSeq } : e);
    }
    since = page.entries[page.entries.length - 1].seq;
    if (page.entries.length < PAGE) break;
  }
  return out;
}

/**
 * §8 staleness decision, shared by the store read path below and ws-handlers'
 * serveTranscriptV2. True = the store can't be trusted for this session:
 * either the failure-side store-degraded flag is set (a store append failed
 * or was skipped — with mirror writes retired that flag is the ONLY signal
 * for owned-session gaps), or a legacy candidate file grew beyond the import
 * watermark — which, with oc mirrors frozen since the 2026-07-23 retirement,
 * means an EXTERNAL writer (claude/codex CLI transcriptPath) appended, or a
 * pre-retirement watermark gap that one idempotent re-import settles. The
 * dual-write tail probe that used to classify growth as "explained" was
 * deleted with the mirror writes; every unexplained-growth case now re-imports
 * (idempotent upserts keep original seqs), which also refreshes the watermark
 * so growth costs once per burst, not per read. Callers react to drift with a
 * full re-import + clearTranscriptStoreDegraded.
 */
export function v2TranscriptHasDrift(
  store: TranscriptStore,
  sessionId: string,
  session: TranscriptSessionRef
): boolean {
  if (
    isTranscriptStoreDegraded(
      sessionId,
      session.opencodeSessionId,
      session.claudeSessionId
    )
  )
    return true;
  const files = v2MirrorFiles(session);
  // No legacy files at all (every post-retirement session) → nothing to
  // drift against; the store is the only source.
  if (!files.length) return false;
  const info = store.getImportInfo(sessionId);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  return !(info?.watermark != null && totalSize <= info.watermark);
}

/**
 * §8 store-serve decision: entries from the store when imported and
 * drift-free; null → caller falls back to legacy; on drift this re-imports
 * (idempotent upserts) and returns the legacy merge for this call directly.
 */
function v2StoreTranscript(
  sessionId: string,
  session: TranscriptSessionRef
): TranscriptEntry[] | null {
  const store = transcriptStore();
  if (!store.hasImported(sessionId)) return null;
  if (!v2TranscriptHasDrift(store, sessionId, session))
    return v2ReadAll(store, sessionId);
  // Drift (§8): re-import (upserts keep original seqs, making this safe to
  // repeat) and serve legacy for THIS call. Watermark = candidate-set size
  // measured BEFORE the legacy parse — lines appended during the parse then
  // read as growth next time instead of being silently covered.
  const totalSize = v2MirrorFiles(session).reduce((sum, f) => sum + f.size, 0);
  const legacy = legacyMergedSessionTranscript(session);
  try {
    store.importLegacyTranscript(
      sessionId,
      legacy,
      store.getImportInfo(sessionId)?.src || "merged",
      totalSize
    );
    // The full re-import restored every entry the store had missed — release
    // the failure-side marker (no-op for ids that never carried it).
    clearTranscriptStoreDegraded(
      sessionId,
      session.opencodeSessionId,
      session.claudeSessionId
    );
  } catch (e) {
    console.warn(
      `[sessions] transcript v2 drift re-import failed for ${sessionId}:`,
      e instanceof Error ? e.message : e
    );
  }
  return legacy;
}

/**
 * User texts already in a session's engine history, for
 * requeueSteerReceipts: a steer that shows up here landed durably (noReply
 * history append), so putting it back into the prompt queue on cancel would
 * deliver it twice.
 *
 * Store-first (mirror retirement prep): every caller holds a full
 * UnifiedSession, so `id` rides along and mergedSessionTranscript serves the
 * v2 store when the session is imported and drift-free — user entries come
 * back as FULL forms there (v2ReadAll hydrates clamped rows via getFullEntry,
 * so the exact-text dedup match still holds). Not imported / drifted /
 * flag-off / any error all land on the legacy merge exactly as before; `id`
 * stays optional so old callers (and runner closures pre-restart) keep
 * working unchanged.
 */
export function engineUserTexts(session: {
	id?: string;
	transcriptPath?: string | null;
	opencodeSessionId?: string | null;
	claudeSessionId?: string | null;
}): string[] {
	try {
		return mergedSessionTranscript({
			id: session.id,
			transcriptPath: session.transcriptPath ?? null,
			opencodeSessionId: session.opencodeSessionId ?? undefined,
			claudeSessionId: session.claudeSessionId ?? null,
		})
			.filter((e) => e.type === "user")
			.map((e) => e.content.trim());
	} catch {
		return [];
	}
}

export function engineSessionPatch(
  provider: "claude" | "codex" | "opencode",
  engineSessionId: string
): Partial<BackstageSessionFile> {
  if (provider === "codex") return { codexThreadId: engineSessionId || undefined };
  // OpenCode ids get their own slot (readers prefer it) AND still mirror into
  // the claude slot, the historical ride every pre-existing code path — and
  // any not-yet-reloaded closure during a hot-reload window — reads and
  // writes. Readers recognize the ride by the `ses_` id shape. The mirror is
  // transitional: dropping it requires no `ses_…`-riding session files and no
  // pre-opencodeSessionId code paths left.
  if (provider === "opencode")
    return {
      opencodeSessionId: engineSessionId || undefined,
      claudeSessionId: engineSessionId || undefined,
    };
  return { claudeSessionId: engineSessionId || undefined };
}

function sessionEngineKeys(session: UnifiedSession): string[] {
  return [
    session.claudeSessionId ? `claude:${session.claudeSessionId}` : null,
    session.codexThreadId ? `codex:${session.codexThreadId}` : null,
    session.opencodeSessionId ? `opencode:${session.opencodeSessionId}` : null,
  ].filter((key): key is string => !!key);
}

function findTranscriptPath(
  worktreeDir: string | null,
  sessionId: string | null
): string | null {
  if (!sessionId) return null;
  // Legacy files where an opencode id rides the claude slot: there is no
  // claude jsonl for a `ses_…` id — skip the (project-dir-wide) scan.
  if (isOpencodeSessionId(sessionId)) return null;
  if (worktreeDir) {
    const path = getTranscriptPath(worktreeDir, sessionId);
    if (existsSync(path)) return path;
  }
  // Fallback: check common CWD paths the agents use
  const fallbacks = [
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu-projects-tella-fusion/${sessionId}.jsonl`,
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu/${sessionId}.jsonl`,
  ];
  for (const path of fallbacks) {
    if (existsSync(path)) return path;
  }
  // Last resort: the recorded worktreeDir can drift from the cwd the run
  // actually used (e.g. a session migrated between repos), so the hashed
  // path above misses even though Claude did write a transcript. The session
  // id is globally unique, so scan every project folder for <id>.jsonl and
  // take the match. Only reached when the direct lookups all fail.
  return findTranscriptBySessionId(sessionId);
}

// Reverse index of every Claude transcript: session id → its .jsonl path,
// built by walking each project dir ONCE. Without it, the last-resort lookup
// below did an uncached readdir of ~1200 project dirs + an existsSync per dir
// FOR EVERY session that missed the direct path (e.g. the ~575 slack sessions
// with no worktreeDir) — ~600k stat() calls, ~1.4s, on every sessions rebuild.
// That rebuild runs on every cache miss (and every "+ new tab", which nulls the
// cache), so it was the dominant cost of a slow new-tab. Building the index is
// ~16ms and turns each miss into an O(1) map hit. Memoized with a short TTL so a
// burst of rebuilds shares one index while newly-written transcripts still show
// up within a couple seconds.
let transcriptIndexCache: { map: Map<string, string>; ts: number } | null = null;
const TRANSCRIPT_INDEX_TTL = 2000;
function transcriptIndex(): Map<string, string> {
  if (transcriptIndexCache && Date.now() - transcriptIndexCache.ts < TRANSCRIPT_INDEX_TTL)
    return transcriptIndexCache.map;
  const map = new Map<string, string>();
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    projectDirs = [];
  }
  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = readdirSync(`${CLAUDE_PROJECTS_DIR}/${dir}`);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      const id = e.slice(0, -".jsonl".length);
      // First dir wins — matches the old top-down readdir scan order.
      if (!map.has(id)) map.set(id, `${CLAUDE_PROJECTS_DIR}/${dir}/${e}`);
    }
  }
  transcriptIndexCache = { map, ts: Date.now() };
  return map;
}

function findTranscriptBySessionId(sessionId: string): string | null {
  return transcriptIndex().get(sessionId) ?? null;
}

/**
 * Transcript for a session that may have run on either engine: codex-model
 * sessions prefer their rollout jsonl; Claude-model sessions prefer their
 * Claude jsonl. If the preferred provider has not produced a transcript yet,
 * fall back to the other engine so mixed sessions don't appear blank after a
 * provider switch.
 */
function resolveTranscriptPath(
  claudePath: string | null,
  codexThreadId: string | null | undefined,
  model: string | null | undefined,
  opencodeSessionId?: string | null
): string | null {
  const codexPath = codexThreadId ? findCodexRollout(codexThreadId)?.path || null : null;
  const ocPath = existingOpencodeTranscriptPath(opencodeSessionId);
  // An opencode-model session's persisted file is self-contained (seeded with
  // any pre-migration history), so it wins while the session runs on opencode.
  if (ocPath && providerFor(model) === "opencode") return ocPath;
  if (codexThreadId && providerFor(model) === "codex") {
    return codexPath || claudePath || ocPath;
  }
  return claudePath || codexPath || ocPath;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    // A missing file is normal; a corrupt one makes the session silently
    // vanish from the UI, so leave a trace.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
      console.warn(`[sessions] Failed to parse ${path}:`, e);
    return null;
  }
}

function getFileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Overlay backstage-owned extras onto a slack/linear-scanned session.
 * touchBackstageSession writes fields like walkthrough/linkedPrs keyed by the
 * UNIFIED id into ~/.opensession-chats/<id>.json — for non-backstage sessions
 * that sidecar has no `id` field, so scanBackstageSessions skips it and the
 * fields silently vanished from the unified view (publish_walkthrough on a
 * Slack session kept answering "no walkthrough on session" right after
 * persisting one — tellahq/tella-mac#71, 2026-07-26).
 */
function overlaySidecarExtras(session: UnifiedSession): UnifiedSession {
  const path = `${SESSIONS_DIR}/${session.id}.json`;
  if (!existsSync(path)) return session;
  const data = readJsonSafe<BackstageSessionFile>(path);
  if (!data) return session;
  if (data.walkthrough) session.walkthrough = data.walkthrough;
  if (data.linkedPrs?.length) session.linkedPrs = data.linkedPrs;
  if (data.attachedRepos?.length) session.attachedRepos = data.attachedRepos;
  if (data.previewPath) session.previewPath = data.previewPath;
  return session;
}

function scanSlackSessions(): UnifiedSession[] {
  if (!existsSync(SLACK_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(SLACK_SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<SlackSessionFile>(
      `${SLACK_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const branch = data.branch || file.replace(".json", "");
    const startedBy = data.userId
      ? resolveSlackUser(data.userId)
      : null;

    // Use a stable ID based on filename
    const id = `slack-${file.replace(".json", "")}`;

    sessions.push(overlaySidecarExtras({
      id,
      claudeSessionId: data.claudeSessionId || null,
      source: "slack",
      branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title: branch,
      lastActivity:
        data.lastActivity ||
        data.createdAt ||
        getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      createdAt:
        data.createdAt || getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir || null, data.claudeSessionId || null),
        data.codexThreadId,
        data.model,
        // Slack session files store the opencode id in the claude slot.
        isOpencodeSessionId(data.claudeSessionId) ? data.claudeSessionId : null
      ),
      opencodeSessionId: isOpencodeSessionId(data.claudeSessionId)
        ? data.claudeSessionId || undefined
        : undefined,
      slackThread: data.channel
        ? { channel: data.channel, threadTs: data.threadTs || "" }
        : undefined,
      model: data.model,
      codexThreadId: data.codexThreadId || undefined,
    }));
  }
  return sessions;
}

function scanLinearSessions(): UnifiedSession[] {
  if (!existsSync(LINEAR_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(LINEAR_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<LinearSessionFile>(
      `${LINEAR_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const rawName =
      data.participants?.[0]?.name ||
      data.lastActiveUser?.name ||
      null;
    // Clean up email-style names (e.g. "john@tella.com" → "John")
    const startedBy = rawName?.includes("@")
      ? rawName.split("@")[0].charAt(0).toUpperCase() + rawName.split("@")[0].slice(1)
      : rawName;

    const title = data.issueIdentifier
      ? `${data.issueIdentifier}: ${data.issueTitle || data.branch}`
      : data.branch;

    const id = `linear-${data.branch}`;

    sessions.push(overlaySidecarExtras({
      id,
      claudeSessionId: data.claudeSessionId,
      source: "linear",
      branch: data.branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title,
      lastActivity:
        data.updatedAt || getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      createdAt: getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir || null, data.claudeSessionId),
        null,
        data.model,
        // Linear session files store the opencode id in the claude slot too.
        isOpencodeSessionId(data.claudeSessionId) ? data.claudeSessionId : null
      ),
      opencodeSessionId: isOpencodeSessionId(data.claudeSessionId)
        ? data.claudeSessionId || undefined
        : undefined,
      linearIssue: data.issueIdentifier
        ? {
            identifier: data.issueIdentifier,
            title: data.issueTitle || data.branch,
            url: data.issueUrl,
          }
        : undefined,
      model: data.model,
    }));
  }
  return sessions;
}

function scanBackstageSessions(): UnifiedSession[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<BackstageSessionFile>(
      `${SESSIONS_DIR}/${file}`
    );
    // Skip non-session bookkeeping files in this dir (active-runs.json,
    // prompt-queues.json, active-at-shutdown.json, …) — a real session always
    // has an id, these don't, so they'd otherwise become bogus id:undefined rows.
    if (!data || !data.id) continue;

    sessions.push({
      id: data.id,
      claudeSessionId: data.claudeSessionId,
      source: "backstage",
      branch: data.branch || null,
      worktreeDir: data.worktreeDir || null,
      startedBy: data.createdBy,
      title: data.title || data.branch || "Ask session",
      mode: data.mode,
      // Back-compat: older session files stored the repo under `project`.
      repo: data.repo ?? (data as { project?: string }).project,
      // Dual-read: the migration mirrors projectId→workspaceId; prefer the new key.
      projectId:
        (data as { workspaceId?: string | null }).workspaceId ??
        data.projectId ??
        null,
      parentSessionId: data.parentSessionId,
      sideChatOf: data.sideChatOf,
      desk: data.desk,
      spawnDepth: data.spawnDepth,
      attachedRepos: data.attachedRepos,
      linkedPrs: data.linkedPrs,
      previewPath: data.previewPath,
      walkthrough: data.walkthrough,
      automation:
        data.automation ||
        (data.createdBy?.endsWith(" (automation)")
          ? data.createdBy.slice(0, -" (automation)".length)
          : undefined),
      automationId: data.automationId,
      archived: data.archived || undefined,
      archivedReason: data.archivedReason,
      upgradedTo: data.upgradedTo,
      importedFrom: data.importedFrom,
      plainThreadId: data.plainThreadId,
      model: data.model,
      effort: data.effort,
      fastMode: data.fastMode,
      accountId: data.accountId,
      codexThreadId: data.codexThreadId,
      opencodeSessionId: data.opencodeSessionId,
      lastEngineProvider: data.lastEngineProvider,
      lastEngineModel: data.lastEngineModel,
      modelHistory: data.modelHistory,
      usage: data.usage,
      goal: data.goal,
      goalId: data.goalId,
      lastRunError: data.lastRunError,
      loop: data.loop,
      slackThreads: data.slackThreads,
      sandbox: data.sandbox,
      lastActivity: data.lastActivity,
      createdAt: data.createdAt,
      isRunning: false,
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir, data.claudeSessionId),
        data.codexThreadId,
        data.model,
        data.opencodeSessionId ||
          (isOpencodeSessionId(data.claudeSessionId) ? data.claudeSessionId : null)
      ),
    });
  }
  return sessions;
}

function getRunningPids(): Map<string, number> {
  // Map of sessionId → pid for currently running CLI sessions
  const running = new Map<string, number>();
  if (!existsSync(CLI_SESSIONS_DIR)) return running;

  for (const file of readdirSync(CLI_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<CLISessionFile>(`${CLI_SESSIONS_DIR}/${file}`);
    if (!data) continue;

    try {
      process.kill(data.pid, 0); // Check if PID is alive
      running.set(data.sessionId, data.pid);
    } catch {
      // PID is dead
    }
  }
  return running;
}

// PR cache: branch → rich PR info, refreshed every 60s. A single batched
// `gh pr list` carries everything the Reviews table renders as columns
// (diffstat, review decision, author), so the list never has to N+1 fetch per
// PR — only the detail pane does. The bulk cache carries NO CI checks: the
// statusCheckRollup bulk query cost ~111 GraphQL points per refresh (rollup
// cost scales with check runs) and alone exhausted the 5000/hr GraphQL quota
// — real checks come from the cheap per-PR detail query (pr-info.ts).
interface PrChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}
interface PrInfo {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  number: number;
  title: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  checks: PrChecksSummary;
  /** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
  mergeable: string;
  /** Person keys ("kent") of teammates with a pending review request. */
  reviewRequested: string[];
  /** Person keys whose latest submitted PR review stands (approved /
   *  changes requested / commented). Populated for open PRs only. */
  reviewedBy: string[];
  /** Assignee GitHub logins — bot-authored PRs carry the requester here. */
  assignees: string[];
}
// Repos the bulk PR cache covers — the active dev repos whose PRs the sidebar
// Open PRs section and Reviews table surface. Fusion carries 200+ open PRs, so
// limits are per-repo. Repos not listed here fall back to session-derived PR
// info only. The ghRepo target resolves through the config-driven registry
// (worktree.ts REPOS), so a config override of either repo's GitHub target
// flows through.
const PR_REPO_LIMITS = [
	{ id: "tella-fusion", openLimit: 500, recentLimit: 1000 },
	{ id: "backstage", openLimit: 100, recentLimit: 500 },
] as const;
function prRepos() {
	return PR_REPO_LIMITS.flatMap((limits) => {
		const repo = configuredRepos()[limits.id];
		return repo?.ghRepo ? [{ ...limits, ghRepo: repo.ghRepo }] : [];
	});
}

// repo id → branch → PR info. Keyed per repo so the same branch name in two
// repos (multi-repo sessions share branch names) never collides.
let prCache: { data: Map<string, Map<string, PrInfo>>; ts: number } = { data: new Map(), ts: 0 };
const PR_CACHE_TTL = 60_000;
let prRefreshPromise: Promise<Set<string>> | null = null;
const prCloseState: { generation: number; closed: Map<string, number> } = ((
	globalThis as any
).__opensessionPrCloseState ??= { generation: 0, closed: new Map() });

function closeTombstoneKey(ghRepo: string, number: number): string {
	return `${ghRepo}#${number}`;
}

// The cache is also snapshotted to disk after every successful refresh and
// seeded from there on boot. Without this, a restart during a GitHub outage or
// rate-limit window boots with an empty cache that no refresh can fill, and the
// sidebar's PR queue silently vanishes (2026-07-22). ts stays 0 so the first
// access still refreshes immediately; the snapshot only serves as stale data.
const PR_CACHE_FILE = `${HOME}/.opensession-pr-cache.json`;
const PR_CACHE_VERSION = 3;
const probeEtags = new Map<string, string>(); // ghRepo → last seen ETag
const lastFullRefresh = new Map<string, number>(); // repo id → epoch ms
try {
  const parsed = JSON.parse(readFileSync(PR_CACHE_FILE, "utf8"));
  const raw: Record<string, Record<string, PrInfo>> =
    (parsed?.version === 2 || parsed?.version === PR_CACHE_VERSION) && parsed?.repos
      ? parsed.repos
      : parsed;
  prCache.data = new Map(
    Object.entries(raw).map(([repo, byBranch]) => [
      repo,
      new Map(Object.entries(byBranch)),
    ]),
  );
  // Version 2 snapshots used smaller history windows. Keep their stale rows
  // available, but skip refresh timestamps so the expanded window refills now.
  if (parsed?.version === PR_CACHE_VERSION) {
    const now = Date.now();
    for (const repo of prRepos()) {
      if (!prCache.data.has(repo.id)) continue;
      if (parsed.recentLimits?.[repo.id] !== repo.recentLimit) continue;
      const etag = parsed.probeEtags?.[repo.ghRepo];
      if (typeof etag === "string" && etag) probeEtags.set(repo.ghRepo, etag);
      const refreshedAt = parsed.lastFullRefresh?.[repo.id];
      if (
        typeof refreshedAt === "number" &&
        Number.isFinite(refreshedAt) &&
        refreshedAt > 0 &&
        refreshedAt <= now + 60_000
      ) {
        lastFullRefresh.set(repo.id, refreshedAt);
      }
    }
  }
} catch {}

function persistPrCache(data: Map<string, Map<string, PrInfo>>) {
  try {
    const obj: Record<string, Record<string, PrInfo>> = {};
    for (const [repo, byBranch] of data) obj[repo] = Object.fromEntries(byBranch);
    writeJsonAtomic(PR_CACHE_FILE, {
      version: PR_CACHE_VERSION,
      repos: obj,
      recentLimits: Object.fromEntries(prRepos().map((repo) => [repo.id, repo.recentLimit])),
      probeEtags: Object.fromEntries(probeEtags),
      lastFullRefresh: Object.fromEntries(lastFullRefresh),
    }, false);
    chmodSync(PR_CACHE_FILE, 0o600);
  } catch (e) {
    console.error("Failed to persist PR cache:", e);
  }
}

/** Keep the repo-wide PR queue coherent after a human closes a PR in OS1. */
export function markCachedPrClosed(ghRepo: string, number: number): void {
	prCloseState.generation++;
	prCloseState.closed.set(
		closeTombstoneKey(ghRepo, number),
		prCloseState.generation,
	);
	const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
	if (!repoId) return;
	const byBranch = prCache.data.get(repoId);
	if (!byBranch) return;
	for (const [branch, pr] of byBranch) {
		if (pr.number !== number) continue;
		byBranch.set(branch, {
			...pr,
			state: "CLOSED",
			updatedAt: new Date().toISOString(),
		});
		prCache.ts = Date.now();
		persistPrCache(prCache.data);
		return;
	}
}

function applyPrCloseTombstones(
	data: Map<string, Map<string, PrInfo>>,
	refreshGeneration: number,
): void {
	for (const [key, closeGeneration] of prCloseState.closed) {
		// A refresh that began after this close is authoritative. Earlier refreshes
		// retain the tombstone so their pre-close OPEN result cannot win the race.
		if (closeGeneration <= refreshGeneration) prCloseState.closed.delete(key);
	}
	for (const repo of prRepos()) {
		const byBranch = data.get(repo.id);
		if (!byBranch) continue;
		for (const [branch, pr] of byBranch) {
			if (!prCloseState.closed.has(closeTombstoneKey(repo.ghRepo, pr.number)))
				continue;
			byBranch.set(branch, { ...pr, state: "CLOSED" });
		}
	}
}

// Rate-limit backoff is shared across ALL GitHub callers (github-limit.ts):
// when any caller reports exhaustion, this refresh pauses too and keeps
// serving its stale (possibly disk-seeded) snapshot until GitHub's reset.

// ── Cheap change detection for the bulk refresh ──────────────────────────────
// Before burning the expensive GraphQL `gh pr list` calls (the notifier drives
// a refresh every minute around the clock, even with zero users), ask REST
// whether anything changed at all: a conditional GET (If-None-Match) on the
// most recently updated PR answers 304 when the repo's PR set is untouched —
// and GitHub documents that 304s on conditional requests don't count against
// the rate limit, so an idle instance polls for free. Some mutations may not
// bump a PR's updatedAt, so a full GraphQL refresh still runs at least every
// PROBE_MAX_SKIP_MS as a safety net.
// Coalesce changes in these active repos: their ETags can change many times per
// minute, while one full sweep costs hundreds of GraphQL points. REST still
// notices changes every minute, but GraphQL refreshes at most every 10m. The
// 30m maximum catches rare mutations that do not change `updated_at` at all.
const MIN_FULL_REFRESH_MS = 10 * 60_000;
const PROBE_MAX_SKIP_MS = 30 * 60_000;

async function repoPrsUnchanged(ghRepo: string): Promise<boolean> {
  const token = await botGhToken();
  if (!token) return false;
  const etag = probeEtags.get(ghRepo);
  try {
    const resp = await fetchWithTimeout(
      `https://api.github.com/repos/${ghRepo}/pulls?state=all&sort=updated&direction=desc&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      },
    );
    if (resp.status === 304) return true;
    if (resp.ok) {
      const fresh = resp.headers.get("etag");
      if (fresh) probeEtags.set(ghRepo, fresh);
    } else {
      const body = await resp.text().catch(() => "");
      if (
        (resp.status === 403 || resp.status === 429) &&
        (resp.headers.get("x-ratelimit-remaining") === "0" || isGhRateLimitMsg(body))
      ) {
        const reset = Number(resp.headers.get("x-ratelimit-reset")) * 1000;
        noteGhRateLimited("pr-cache-rest", Number.isFinite(reset) ? reset : undefined);
      }
      return false;
    }
    await resp.text().catch(() => {}); // drain so the socket frees
    return false;
  } catch {
    return false;
  }
}

// GitHub only populates a PR's `reviewDecision` when branch protection *requires*
// a review. tella-fusion has no such rule, so reviewDecision comes back "" even
// after a teammate approves — which left approved-but-unmerged PRs stuck in the
// sidebar's "Awaiting review" band forever (it clears only on APPROVED or MERGED).
// Derive an effective decision from the actual latest review per reviewer,
// matching GitHub's own precedence: any outstanding CHANGES_REQUESTED blocks,
// otherwise any APPROVED counts. COMMENTED / DISMISSED / PENDING don't decide.
// Used only as a fallback — a real reviewDecision (branch-protected repos) wins.
function deriveReviewDecision(
  latestReviews: Array<{ state?: string }> | undefined,
): string {
  let approved = false;
  for (const r of latestReviews || []) {
    const s = (r.state || "").toUpperCase();
    if (s === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (s === "APPROVED") approved = true;
  }
  return approved ? "APPROVED" : "";
}

// Stale-while-revalidate: never block the event loop on gh (it takes ~10s on
// fusion, which used to freeze every agent in the process).
function getPrsByRepo(): Map<string, Map<string, PrInfo>> {
  if (Date.now() - prCache.ts >= PR_CACHE_TTL) void refreshPrCache();
  return prCache.data;
}

async function ghJson<T>(args: string[]): Promise<T | null> {
  if (ghRateLimited()) return null;
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [raw, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) {
      if (isGhRateLimitMsg(err)) noteGhRateLimited("pr-cache");
      return null;
    }
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function refreshPrCache(): Promise<Set<string>> {
  if (prRefreshPromise) return prRefreshPromise;
  prRefreshPromise = refreshPrCacheInner().finally(() => {
    prRefreshPromise = null;
  });
  return prRefreshPromise;
}

async function refreshPrCacheInner(): Promise<Set<string>> {
  const refreshGeneration = prCloseState.generation;
  const freshRepos = new Set<string>();
  if (ghRateLimited()) {
    // Rate-limited — keep serving the stale snapshot, don't burn calls.
    prCache.ts = Date.now();
    return freshRepos;
  }
  try {
    type BulkPr = {
      headRefName: string; url: string; state: string; number: number; title: string;
      isDraft: boolean; additions: number; deletions: number; changedFiles: number;
      reviewDecision: string; author?: { login?: string; name?: string }; updatedAt: string;
      createdAt: string;
      reviewRequests?: Array<{ login?: string; name?: string; slug?: string }>;
      assignees?: Array<{ login?: string }>;
      // MERGEABLE | CONFLICTING | UNKNOWN. GitHub computes this asynchronously,
      // so a freshly-pushed PR reads UNKNOWN until the background probe lands —
      // the 60s SWR refresh picks up the real value. `mergeable` is a cheap PR
      // enum (unlike statusCheckRollup), so it's safe to add to the bulk list;
      // mergeStateStatus is NOT a `gh pr list` field (detail-only), don't add it.
      mergeable?: string;
      // Only requested on the open-PR query (see below), absent on recentAll.
      latestReviews?: Array<{ state?: string; author?: { login?: string } }>;
    };
    const FIELDS =
      "headRefName,url,state,number,title,isDraft,additions,deletions,changedFiles,reviewDecision,author,createdAt,updatedAt,reviewRequests,assignees,mergeable";

    // A session's branch is matched against open PRs, so we must see EVERY open
    // PR — not just the newest N. Fusion carries 200+ open PRs at a time, so a
    // single `--state all --limit 200` window silently drops older open ones
    // (the bug where a real PR wouldn't show on its session). Split it:
    //   - `--state open` with a generous limit → all open PRs (the live
    //     matches), carrying latestReviews so review state (an approval GitHub
    //     won't report via reviewDecision — see deriveReviewDecision) needs no
    //     third query; latestReviews is cheap (~2 GraphQL points across the
    //     full open window)
    //   - `--state all` window → recently merged/closed (Reviews "merged" view +
    //     sessions whose PR just landed)
    const next = new Map<string, Map<string, PrInfo>>();
    // Keep repos and their two queries sequential. Besides lowering burst cost,
    // this lets a rate-limit response stop the remaining sweep immediately.
    for (const repo of prRepos()) {
      // Skip both GraphQL calls entirely when the conditional REST probe says
      // nothing changed since the last full refresh (bounded by the safety-net
      // interval): an unchanged snapshot is by definition current, so the repo
      // still counts as fresh for notification consumers.
      const stale = prCache.data.get(repo.id);
      const refreshAge = Date.now() - (lastFullRefresh.get(repo.id) || 0);
      if (stale && refreshAge < PROBE_MAX_SKIP_MS) {
        if (await repoPrsUnchanged(repo.ghRepo)) {
          next.set(repo.id, stale);
          freshRepos.add(repo.id);
          continue;
        }
        if (refreshAge < MIN_FULL_REFRESH_MS) {
          next.set(repo.id, stale);
          continue;
        }
      }
      if (ghRateLimited()) {
        if (stale) next.set(repo.id, stale);
        continue;
      }
      const openPrs = await ghJson<BulkPr[]>([
        "pr", "list", "--repo", repo.ghRepo, "--state", "open",
        "--limit", String(repo.openLimit), "--json", `${FIELDS},latestReviews`,
      ]);

      if (!openPrs) {
        // The open list is authoritative. A successful recent-history query
        // cannot prove an open PR disappeared, so preserve this repo's stale
        // snapshot and do not let notification consumers compare against it.
        if (stale) next.set(repo.id, stale);
        continue;
      }
		const recentAll = await ghJson<BulkPr[]>([
			"pr", "list", "--repo", repo.ghRepo, "--state", "all",
			"--limit", String(repo.recentLimit), "--json", FIELDS,
		]);
			freshRepos.add(repo.id);
      lastFullRefresh.set(repo.id, Date.now());

      const reviewByNumber = new Map<number, string>();
      const reviewedByNumber = new Map<number, string[]>();
      for (const r of openPrs) {
        const decision = deriveReviewDecision(r.latestReviews);
        if (decision) reviewByNumber.set(r.number, decision);
        // Teammates whose latest submitted review stands (approve / changes /
        // comment) — lets the sidebar tell "you already gave your review" apart
        // from "still on you" instead of only seeing the aggregate decision.
        const people = new Set<string>();
        for (const rev of r.latestReviews || []) {
          const s = (rev.state || "").toUpperCase();
          if (s !== "APPROVED" && s !== "CHANGES_REQUESTED" && s !== "COMMENTED") continue;
          const p = githubLoginToPersonKey(rev.author?.login);
          if (p) people.add(p);
        }
        if (people.size) reviewedByNumber.set(r.number, [...people]);
      }

      const toInfo = (pr: BulkPr): PrInfo => ({
        url: pr.url,
        state: pr.state as PrInfo["state"],
        number: pr.number,
        title: pr.title || "",
        isDraft: !!pr.isDraft,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changedFiles: pr.changedFiles || 0,
        reviewDecision: pr.reviewDecision || reviewByNumber.get(pr.number) || "",
        author: pr.author?.login || pr.author?.name || "",
        createdAt: pr.createdAt || "",
        updatedAt: pr.updatedAt || "",
        // Always empty in the bulk cache (see PR_REPO_LIMITS comment) — the UI
        // treats zero checks as "no known CI blocker"; the detail pane has the
        // real rollup.
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: pr.mergeable || "UNKNOWN",
        // Individual review requests only — team requests ("Infra reviewers")
        // have no login and we can't cheaply resolve their membership.
        reviewRequested: (pr.reviewRequests || [])
          .map((r) => githubLoginToPersonKey(r.login))
          .filter((p): p is string => !!p),
        reviewedBy: reviewedByNumber.get(pr.number) || [],
        assignees: (pr.assignees || [])
          .map((a) => a.login)
          .filter((l): l is string => !!l),
      });

      // Seed with recent closed/merged (newest-first → keep the first per branch),
      // then let open PRs override: an open PR is the authoritative state for a
      // branch even if an older closed PR reused the same head ref.
      const map = new Map<string, PrInfo>();
      if (!recentAll && stale) {
        for (const [branch, pr] of stale) {
          if (pr.state !== "OPEN") map.set(branch, pr);
        }
      }
      for (const pr of recentAll || []) {
        if (!map.has(pr.headRefName)) map.set(pr.headRefName, toInfo(pr));
      }
      for (const pr of openPrs || []) {
        map.set(pr.headRefName, toInfo(pr));
      }
      next.set(repo.id, map);
    }
    // A close can land while this slow GitHub sweep is in flight. Preserve the
    // mutation over any pre-close OPEN row the sweep already fetched.
    applyPrCloseTombstones(next, refreshGeneration);
    prCache = { data: next, ts: Date.now() };
    if (freshRepos.size) persistPrCache(next);
  } catch (e) {
    console.error("Failed to fetch PRs:", e);
    prCache.ts = Date.now(); // back off on failure too
  }
  return freshRepos;
}

/**
 * Every open PR across the covered repos (prRepos() — from the same batched
 * cache the session enrichment uses), each attributed to a teammate when its
 * GitHub author maps to one via the identity table. Bot-authored PRs
 * (tella-butler — the ones Michael opens from sessions) fall back to the
 * first teammate assignee (sessions instruct the agent to `--assignee` the
 * requester); with neither, `person` is null and the frontend attributes
 * through the session that opened them. Powers the sidebar's Open PRs
 * section, which must show a person's PRs even when no Backstage session
 * exists for them — e.g. PRs opened from another tool (Conductor, local CLI)
 * under their own account.
 */
export interface OpenPrEntry {
	repo: string;
	branch: string;
	url: string;
	number: number;
	title: string;
	isDraft: boolean;
	reviewDecision: string;
	author: string;
	/** Web user-picker key ("kent"), or null when the author isn't a teammate. */
	person: string | null;
	createdAt: string;
	updatedAt: string;
	checks: PrChecksSummary;
	/** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
	mergeable: string;
	/** Person keys of teammates with a pending review request on this PR. */
	reviewRequested: string[];
	/** An automated OpenSession review is still running for this PR. */
	reviewActive: boolean;
}

export interface RecentPrEntry extends Omit<OpenPrEntry, "reviewActive"> {
	state: "OPEN" | "MERGED" | "CLOSED";
	additions: number;
	deletions: number;
}

/** The recent repo-wide PR window, including PRs created outside OpenSession. */
export function getRecentPrs(): RecentPrEntry[] {
	const out: RecentPrEntry[] = [];
	for (const [repoId, byBranch] of getPrsByRepo()) {
		for (const [branch, pr] of byBranch) {
			out.push({
				repo: repoId,
				branch,
				url: pr.url,
				number: pr.number,
				title: pr.title,
				state: pr.state,
				isDraft: pr.isDraft,
				reviewDecision: pr.reviewDecision,
				author: pr.author,
				person:
					githubLoginToPersonKey(pr.author) ??
					pr.assignees
						.map((login) => githubLoginToPersonKey(login))
						.find((person): person is string => !!person) ??
					null,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
				additions: pr.additions,
				deletions: pr.deletions,
				checks: pr.checks,
				mergeable: pr.mergeable,
				reviewRequested: pr.reviewRequested,
			});
		}
	}
	return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

const personPrCache = new Map<string, { data: RecentPrEntry[]; ts: number }>();
const PERSON_PR_CACHE_TTL = 10 * 60_000;

/** Complete PR history for one teammate, fetched on demand for Home's person view. */
export async function getRecentPrsForPerson(person: string): Promise<RecentPrEntry[]> {
	const key = person.trim().toLowerCase();
	const cached = personPrCache.get(key);
	if (cached && Date.now() - cached.ts < PERSON_PR_CACHE_TTL) return cached.data;
	const login = githubLoginFor(key);
	if (!login) return [];

	type PersonPr = {
		headRefName: string;
		url: string;
		state: "OPEN" | "MERGED" | "CLOSED";
		number: number;
		title: string;
		isDraft: boolean;
		additions: number;
		deletions: number;
		author?: { login?: string; name?: string };
		createdAt: string;
		updatedAt: string;
		assignees?: Array<{ login?: string }>;
	};
	const fields = "headRefName,url,state,number,title,isDraft,additions,deletions,author,createdAt,updatedAt,assignees";
	const out = new Map(
		getRecentPrs().filter((pr) => pr.person === key).map((pr) => [pr.url, pr]),
	);
	let complete = true;
	for (const repo of prRepos()) {
		const prs = await ghJson<PersonPr[]>([
			"pr", "list", "--repo", repo.ghRepo, "--state", "all",
			"--search", `author:${login} OR assignee:${login}`,
			"--limit", "1000", "--json", fields,
		]);
		if (!prs) {
			complete = false;
			continue;
		}
		for (const pr of prs || []) {
			const author = pr.author?.login || pr.author?.name || "";
			const assignees = (pr.assignees || []).map((entry) => entry.login || "").filter(Boolean);
			out.set(pr.url, {
				repo: repo.id,
				branch: pr.headRefName,
				url: pr.url,
				number: pr.number,
				title: pr.title,
				state: pr.state,
				isDraft: pr.isDraft,
				reviewDecision: "",
				author,
				person: githubLoginToPersonKey(author) ?? assignees.map(githubLoginToPersonKey).find(Boolean) ?? null,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
				additions: pr.additions,
				deletions: pr.deletions,
				checks: { total: 0, passed: 0, failed: 0, pending: 0 },
				mergeable: "UNKNOWN",
				reviewRequested: [],
			});
		}
	}
	const data = [...out.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
	if (complete) personPrCache.set(key, { data, ts: Date.now() });
	return data;
}

export function getOpenPrs(): OpenPrEntry[] {
	const out: OpenPrEntry[] = [];
	for (const [repoId, byBranch] of getPrsByRepo()) {
		const ghRepo = configuredRepos()[repoId]?.ghRepo;
		for (const [branch, pr] of byBranch) {
			if (pr.state !== "OPEN") continue;
			const reviewState = readPrState(pr.number, ghRepo);
			out.push({
				repo: repoId,
				branch,
				url: pr.url,
				number: pr.number,
				title: pr.title,
				isDraft: pr.isDraft,
				reviewDecision: pr.reviewDecision,
				author: pr.author,
				person:
					githubLoginToPersonKey(pr.author) ??
					pr.assignees
						.map((l) => githubLoginToPersonKey(l))
						.find((p): p is string => !!p) ??
					null,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
				checks: pr.checks,
				mergeable: pr.mergeable,
				reviewRequested: pr.reviewRequested,
				reviewActive:
					reviewState?.activeRun?.kind === "review" ||
					isLockHeld("review", pr.number, ghRepo),
			});
		}
	}
	return out.sort((a, b) =>
		(b.updatedAt || "").localeCompare(a.updatedAt || ""),
	);
}

export function getAllSessions(): UnifiedSession[] {
  const slackSessions = scanSlackSessions();
  const linearSessions = scanLinearSessions();
  const backstageSessions = scanBackstageSessions();
  const runningPids = getRunningPids();

  // Merge all sessions, deduplicating by engine id (Claude session or Codex
  // thread). Keep the one with richer data (backstage > linear > slack), and
  // preserve dropped ids as aliases for deep links.
  const byEngineId = new Map<string, UnifiedSession>();
  const allSessions: UnifiedSession[] = [];

  for (const session of [
    ...backstageSessions,
    ...linearSessions,
    ...slackSessions,
  ]) {
    const engineKeys = sessionEngineKeys(session);
    let existing: UnifiedSession | undefined;
    for (const key of engineKeys) {
      existing = byEngineId.get(key);
      if (existing) break;
    }
    if (existing) {
      if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
        existing.isRunning = true;
      }
      // Keep the dropped ID as an alias so deep links to it (e.g. the
      // Slack "Open in Backstage" button, which uses slack-<channel>-<ts>)
      // still resolve to the surviving session.
      existing.aliasIds = [...(existing.aliasIds || []), session.id];
      for (const aliasKey of engineKeys) byEngineId.set(aliasKey, existing);
      continue;
    }

    // Mark running status
    if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
      session.isRunning = true;
    }

    allSessions.push(session);
    for (const key of engineKeys) byEngineId.set(key, session);
  }

  // Enrich with PR URLs and state, matched within the session's own repo so a
  // branch name reused across repos never picks up the wrong PR. Beyond the
  // singular pr* fields (still the primary branch's PR, for the list/Reviews
  // consumers), collect EVERY PR the session spans — attached repos and
  // manually linked PRs — into session.prs for the multi-PR surfaces.
  const prsByRepo = getPrsByRepo();
  for (const session of allSessions) {
    if (session.branch) {
      const pr = prsByRepo.get(session.repo || defaultRepo().id)?.get(session.branch);
      if (pr) {
        session.prUrl = pr.url;
        session.prState = pr.state;
        session.prMergeable = pr.mergeable;
        session.prNumber = pr.number;
        session.prTitle = pr.title;
        session.prIsDraft = pr.isDraft;
        session.prAdditions = pr.additions;
        session.prDeletions = pr.deletions;
        session.prChangedFiles = pr.changedFiles;
        session.prReviewDecision = pr.reviewDecision;
        session.prReviewRequested = pr.reviewRequested;
        session.prReviewedBy = pr.reviewedBy;
        session.prAuthor = pr.author;
        session.prUpdatedAt = pr.updatedAt;
        session.prChecks = pr.checks;
      }
    }

    const targets: Array<{
      repo: string;
      branch: string;
      source: SessionPrRef["source"];
      stored?: { url?: string; number?: number; title?: string };
    }> = [];
    if (session.branch)
      targets.push({
        repo: session.repo || defaultRepo().id,
        branch: session.branch,
        source: "primary",
      });
    for (const att of session.attachedRepos || [])
      targets.push({ repo: att.repo, branch: att.branch, source: "attached" });
    for (const lp of session.linkedPrs || [])
      targets.push({ repo: lp.repo, branch: lp.branch, source: "linked", stored: lp });

    const seen = new Set<string>();
    const refs: SessionPrRef[] = [];
    for (const t of targets) {
      const key = `${t.repo}\x00${t.branch}`;
      if (seen.has(key)) continue; // a link duplicating the primary/attached pair
      seen.add(key);
      const pr = prsByRepo.get(t.repo)?.get(t.branch);
      if (pr) {
        refs.push({
          repo: t.repo,
          branch: t.branch,
          source: t.source,
          url: pr.url,
          state: pr.state,
          number: pr.number,
          title: pr.title,
          isDraft: pr.isDraft,
          reviewDecision: pr.reviewDecision,
          additions: pr.additions,
          deletions: pr.deletions,
          checks: pr.checks,
        });
      } else if (
        t.source !== "primary" &&
        (t.stored || !prsByRepo.has(t.repo))
      ) {
        // No cache hit but the target is still real: a linked PR keeps its
        // stored url/number/title as a label, and an attached repo outside the
        // bulk cache's coverage (it only polls the active dev repos) keeps a
        // bare ref — the PR routes resolve it live. A covered repo with no
        // cache entry genuinely has no PR, and a primary branch with no PR
        // stays absent, as before.
        refs.push({ repo: t.repo, branch: t.branch, source: t.source, ...t.stored });
      }
    }
    if (refs.length > 0) session.prs = refs;
  }

  // Apply the cross-source archive registry
  for (const session of allSessions) {
    if (!session.archived && isArchivedId(session.id)) {
      session.archived = true;
      session.archivedReason = getArchiveReason(session.id) || "manual";
    }
  }

  // Apply auto-generated summary titles (the short Conductor-style name),
  // keyed by unified id or merged alias id. Sits UNDER a manual rename (applied
  // next) but OVER the derived first-line title.
  for (const session of allSessions) {
    const generated =
      getGeneratedTitle(session.id) ??
      session.aliasIds?.map((a) => getGeneratedTitle(a)).find(Boolean);
    if (generated) session.title = generated;
  }

  // Apply cross-source manual title overrides (rename). Keyed by the unified id
  // or any merged alias id, so a rename sticks across the dedup in this scan.
  for (const session of allSessions) {
    const override =
      getTitleOverride(session.id) ??
      session.aliasIds?.map((a) => getTitleOverride(a)).find(Boolean);
    if (override) {
      session.title = override;
      session.titleOverridden = true;
    }
  }

  // Apply manual status-lane overrides. Keyed by unified id or any merged alias
  // id (same as the rename registry) so a pinned lane survives the dedup scan.
  for (const session of allSessions) {
    const status =
      getStatusOverride(session.id) ??
      session.aliasIds?.map((a) => getStatusOverride(a)).find(Boolean);
    if (status) session.manualStatus = status;
  }

  // Apply pending review requests (the info panel's Reviewer picker), keyed by
  // unified id or any merged alias id like the registries above.
  for (const session of allSessions) {
    const review =
      getReviewRequest(session.id) ??
      session.aliasIds?.map((a) => getReviewRequest(a)).find(Boolean);
    if (review) session.reviewRequest = review;
  }

  // Sort by lastActivity descending
  allSessions.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  return allSessions;
}

export function deleteSession(session: UnifiedSession): void {
  // Delete the session JSON file based on source
  switch (session.source) {
    case "slack": {
      // ID format: slack-{filename}
      const filename = session.id.replace(/^slack-/, "") + ".json";
      const path = `${SLACK_SESSIONS_DIR}/${filename}`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "linear": {
      // ID format: linear-{branch}
      const branch = session.id.replace(/^linear-/, "");
      const path = `${LINEAR_SESSIONS_DIR}/${branch}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "backstage": {
      const path = `${SESSIONS_DIR}/${session.id}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
  }
}
