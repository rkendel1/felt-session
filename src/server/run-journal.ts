/**
 * Crash/restart run journal — every in-flight run is recorded on disk;
 * entries that survive a process restart are interrupted runs, which
 * agent-runner.resumeInterruptedRuns resumes on boot. All engines journal
 * through these functions.
 */
import type { McpScope } from "./runner-shared";
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { } from "./paths";
import { transitionRunState } from "./run-state";
import { writeJsonAtomic } from "./shared/atomic-write";

// Overridable so a detached run host (src/runner-host/host.ts) journals to its
// own per-host file instead of read-modify-writing the shared journal from
// multiple processes concurrently.
let ACTIVE_RUNS_PATH =
  process.env.OPENSESSION_RUN_JOURNAL ||
  `${OPENSESSION_SESSIONS_DIR}/active-runs.json`;

/**
 * Test seam (bun tests only): repoint the journal file AFTER this module has
 * been evaluated — mirrors paths.ts's __setSessionsDirForTest. ES module
 * bindings are live, so callers that reach this module's functions through
 * ANOTHER already-cached module (e.g. agent-runner.ts's bare import of this
 * file) pick the new value up regardless of which file imported it first.
 * Returns the previous value so afterAll can restore it.
 */
export function __setActiveRunsPathForTest(path: string): string {
  const prev = ACTIVE_RUNS_PATH;
  ACTIVE_RUNS_PATH = path;
  return prev;
}

export interface ActiveRunRecord {
  runKey: string;
  osSessionId?: string;
  claudeSessionId?: string; // engine session id (name kept for on-disk compat)
  prompt?: string; // original prompt — lets a run interrupted before it got an engine session be re-run from scratch (safe: no session id ⇒ no model output ⇒ no side effects yet)
  promptEntryId?: string; // uuid of the prompt's user transcript line — a boot re-run reuses it so the store upserts instead of duplicating the bubble
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  // Per-run MCP scope, preserved across resume. Optional for back-compat:
  // records journaled before McpScope omitted it to mean "all".
  mcpServers?: McpScope;
  user?: string; // per-run user, preserved across resume (gates per-user MCP servers)
  deniedTools?: Record<string, string>; // per-run tool denials, preserved across resume
  confirmTools?: Record<string, string>; // per-run human-confirmed tools, preserved across resume
  aws?: boolean; // whether to inject AWS creds, preserved across resume
  model?: string; // effective model driving the journaled attempt
  selectedModel?: string; // user selection when model is a transient per-turn fallback
  transientFallback?: boolean; // model must not replace selectedModel in session state
  effort?: string; // reasoning effort, preserved across resume
  fastMode?: boolean; // OpenAI priority service tier, preserved across resume
  accountId?: string; // pinned provider account, preserved across resume
  accountStrict?: boolean; // hard pin: never rotate into the pool (automation cost cap)
  usageCredits?: boolean; // may run on accounts spending usage-credits past their limits
  fallbackModel?: string; // usage-limit fallback policy, preserved across resume
  /** Pool key of the opencode server hosting this run — lets resume-after-
   *  restart REATTACH to a detached server that survived (adoption via the
   *  opencode-detach registry) instead of re-prompting a fresh one. */
  serverKey?: string;
  /** Sandbox the run executes in (the sandbox rollout plan Phase 1+); absent = host process */
  sandboxId?: string;
  /** Provider owning sandboxId, so resume-after-restart can reattach via provider.get() */
  sandboxProvider?: string;
  kind?: string;
  startedAt: string;
  /** Stamped when a boot sweep hands the record to resumeInterruptedRuns. The
   *  record stays journaled until its resume outcome re-registers (journalSet)
   *  or clears it — a restart that kills the sweep mid-reattach leaves the
   *  claim behind, and the next boot re-takes it (claims from a dead process
   *  are void). Only ever set on the on-disk copy. */
  claimedAt?: string;
}

function readRunJournal(): Record<string, ActiveRunRecord> {
  try {
    return existsSync(ACTIVE_RUNS_PATH)
      ? JSON.parse(readFileSync(ACTIVE_RUNS_PATH, "utf-8"))
      : {};
  } catch {
    return {};
  }
}

function writeRunJournal(journal: Record<string, ActiveRunRecord>): void {
  try {
    writeJsonAtomic(ACTIVE_RUNS_PATH, journal);
  } catch (e) {
    console.error("[runner] Failed to write run journal:", e);
  }
}

export function journalSet(record: ActiveRunRecord): void {
  const journal = readRunJournal();
  const rejournal = record.runKey in journal;
  journal[record.runKey] = record;
  writeRunJournal(journal);
  // A fallback hop re-journals the same runKey mid-run — that's the running
  // self-edge, not a new registration, so keep the event but tag it.
  if (record.osSessionId)
    transitionRunState(record.osSessionId, "run_registered", {
      run_key: record.runKey,
      kind: record.kind,
      rejournal: rejournal || undefined,
    });
}

export function journalClear(runKey: string): void {
  const journal = readRunJournal();
  if (runKey in journal) {
    delete journal[runKey];
    writeRunJournal(journal);
  }
}

/** Snapshot of the runs currently journaled as in-flight (does not clear). */
export function activeRunRecords(): ActiveRunRecord[] {
  return Object.values(readRunJournal());
}

// Engines register a probe so takeInterruptedRuns can tell "journaled but
// still actively driven by THIS process" (a hot reload re-runs boot-ish code
// while old runs keep executing off their old closures) apart from genuinely
// interrupted runs. Parked on globalThis so a reload keeps live probes.
const activeRunProbes: Set<(runKey: string) => boolean> = ((globalThis as any)
  .__runJournalActiveProbes ??= new Set());

export function registerActiveRunProbe(probe: (runKey: string) => boolean): void {
  activeRunProbes.add(probe);
}

function isRunActiveInProcess(runKey: string): boolean {
  for (const probe of activeRunProbes) {
    try {
      if (probe(runKey)) return true;
    } catch {}
  }
  return false;
}

// runKeys this process's sweep already handed out, so a second call can't
// double-resume them. On-disk claims deliberately do NOT block a take — they
// exist so a DIFFERENT (next) process re-finds runs whose sweep died
// mid-reattach; only the process that took them must not take them twice.
const takenRunKeys: Set<string> = ((globalThis as any).__runJournalTakenKeys ??=
  new Set());

/**
 * Hand interrupted runs left by a previous process to the boot sweep. Records
 * are CLAIMED (stamped claimedAt), not cleared: until the resume outcome
 * re-registers the run (journalSet, same runKey) or clears it (journalClear),
 * the record survives on disk, so a restart that kills the sweep mid-reattach
 * (2026-07-27 13:47:45: SIGTERM 18s after boot, 7 taken runs evaporated with
 * the old wipe-on-take) hands the same runs to the next boot instead of
 * losing them. Returned records have claimedAt stripped so a reattach's
 * re-record doesn't persist a stale claim.
 */
export function takeInterruptedRuns(): ActiveRunRecord[] {
  const journal = readRunJournal();
  const entries = Object.values(journal).filter(
    (r) => !isRunActiveInProcess(r.runKey) && !takenRunKeys.has(r.runKey)
  );
  if (entries.length > 0) {
    const now = new Date().toISOString();
    for (const r of entries) {
      takenRunKeys.add(r.runKey);
      journal[r.runKey] = { ...r, claimedAt: now };
    }
    writeRunJournal(journal);
  }
  for (const r of entries) {
    if (r.osSessionId)
      transitionRunState(r.osSessionId, "boot_journal_found", {
        run_key: r.runKey,
        kind: r.kind,
      });
  }
  return entries.map(({ claimedAt: _claimed, ...r }) => r);
}
