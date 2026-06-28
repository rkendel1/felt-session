/**
 * Per-PR state for the github agent, one JSON file per PR at
 * ~/.backstage-github/<prNumber>.json. Tracks the single review comment id, which
 * head SHAs we've already reviewed (dedup), the resumable review session, and the
 * auto-fix / simplify run state. Mirrors the grafana-poller dedup store.
 *
 * In-process locks coalesce rapid webhook bursts (force-push, stacked commits)
 * within one process; the on-disk state guards across restarts.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";

const HOME = process.env.HOME || "/home/ubuntu";
const STATE_DIR = `${HOME}/.backstage-github`;

mkdirSync(STATE_DIR, { recursive: true });

// Engine-session resume is handled via the deterministic per-PR session file
// (see run.ts `bksIdFor`), so these track only behavioral state.

export interface AutoFixState {
  active: boolean;
  iterations: number;
  worktreeDir?: string;
  lastPushedSha?: string;
  statusCommentId?: number;
  requestedBy?: string; // github login that applied the label (for commit attribution)
  startedAt: string;
}

export interface SimplifyState {
  active: boolean;
  doneSha?: string;
  requestedBy?: string;
  startedAt: string;
}

export interface GithubPrState {
  prNumber: number;
  headRef: string;
  summaryCommentId?: number;
  reviewedShas: string[];
  lastReviewedSha?: string;
  autoFix?: AutoFixState;
  simplify?: SimplifyState;
  /**
   * Set while a one-shot action (review/simplify/adversarial) is in flight; cleared
   * in its finally. If the process is killed mid-run, this persists so the github
   * agent re-runs it on startup. (Auto-fix uses its own `autoFix.active`.)
   */
  activeRun?: {
    kind: "review" | "simplify" | "adversarial";
    requestedBy: string;
    startedAt: string;
    /** The run's progress comment id — reused only on restart recovery, not on a fresh re-trigger. */
    progressCommentId?: number;
  };
  /** An in-flight @mention reply (conversational), persisted so a restart can re-run it. */
  activeMention?: {
    author: string;
    body: string;
    kind: "issue" | "review";
    replyToId?: number;
    inline?: { path: string; line?: number; diffHunk?: string };
    progressCommentId?: number;
    startedAt: string;
  };
  updatedAt: string;
}

function statePath(prNumber: number): string {
  return `${STATE_DIR}/${prNumber}.json`;
}

export function readPrState(prNumber: number): GithubPrState | null {
  const path = statePath(prNumber);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GithubPrState;
  } catch {
    return null;
  }
}

export function getOrInitPrState(prNumber: number, headRef: string): GithubPrState {
  return (
    readPrState(prNumber) || {
      prNumber,
      headRef,
      reviewedShas: [],
      updatedAt: new Date().toISOString(),
    }
  );
}

export function writePrState(state: GithubPrState): void {
  state.updatedAt = new Date().toISOString();
  // Keep the reviewed-SHA list bounded.
  if (state.reviewedShas.length > 20) state.reviewedShas = state.reviewedShas.slice(-20);
  writeFileSync(statePath(state.prNumber), JSON.stringify(state, null, 2));
}

export function updatePrState(
  prNumber: number,
  headRef: string,
  patch: (s: GithubPrState) => void
): GithubPrState {
  const s = getOrInitPrState(prNumber, headRef);
  patch(s);
  writePrState(s);
  return s;
}

/** Every PR state file (for the startup recovery sweep). */
export function listPrStates(): GithubPrState[] {
  const out: GithubPrState[] = [];
  for (const file of readdirSync(STATE_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(`${STATE_DIR}/${file}`, "utf-8")) as GithubPrState);
    } catch {}
  }
  return out;
}

// ── In-process locks ─────────────────────────────────────────
// "review" is independent (read-only, main checkout). "code" is shared by
// auto-fix AND simplify because they operate on the same PR-branch worktree —
// running them concurrently on one PR would corrupt that worktree.

// "review" is independent (read-only, main checkout). "code" is shared by
// auto-fix, simplify, AND mention replies — they all operate on the same
// PR-branch worktree, so they must not run concurrently on one PR.
const locks: Record<"review" | "code", Set<number>> = {
  review: new Set(),
  code: new Set(),
};

/** Try to claim the lock; false if already held. Release with releaseLock. */
export function claimLock(behavior: keyof typeof locks, prNumber: number): boolean {
  if (locks[behavior].has(prNumber)) return false;
  locks[behavior].add(prNumber);
  return true;
}

export function releaseLock(behavior: keyof typeof locks, prNumber: number): void {
  locks[behavior].delete(prNumber);
}

export function activeCodeLoops(): number[] {
  return locks.code.size ? [...locks.code] : [];
}
