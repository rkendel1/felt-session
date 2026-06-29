import { $ } from "bun";
import { existsSync } from "fs";
import type { UnifiedSession } from "./types";

const TELLA_FUSION = "/home/ubuntu/projects/tella-fusion";
const WORKTREES_DIR = "/home/ubuntu/worktrees";

// Projects a session can run against. Worktrees live at
// <WORKTREES_DIR>/<wtPrefix>-<branch>; defaultBranch is the base they branch
// from. tella-fusion is the default for every existing caller.
export interface Project {
  id: string;
  repo: string;
  wtPrefix: string;
  defaultBranch: string;
  // When true, code sessions run directly in the main checkout on the default
  // branch instead of an isolated worktree. Backstage is self-hosting — the live
  // server runs `bun --hot` from its main checkout, so editing there is the only
  // way a change is testable without a second instance. Sessions share one tree
  // and commit straight to the default branch (see "Backstage dev workflow" in
  // CLAUDE.md: add → commit → push, never reset/discard the shared repo).
  sharedCheckout?: boolean;
}

export const PROJECTS: Record<string, Project> = {
  "tella-fusion": { id: "tella-fusion", repo: TELLA_FUSION, wtPrefix: "tella-fusion", defaultBranch: "main" },
  backstage: { id: "backstage", repo: "/home/ubuntu/projects/tella-backstage", wtPrefix: "backstage", defaultBranch: "master", sharedCheckout: true },
};

export function getProject(id?: string): Project {
  return (id && PROJECTS[id]) || PROJECTS["tella-fusion"];
}

/** Infer the project that owns a checkout/worktree path. */
export function projectForPath(p: string): Project {
  for (const proj of Object.values(PROJECTS)) {
    if (p === proj.repo || p.startsWith(`${WORKTREES_DIR}/${proj.wtPrefix}-`)) return proj;
  }
  return PROJECTS["tella-fusion"];
}

// Serialize git operations that mutate the shared repo's worktrees. Concurrent
// `git worktree add` race on `.git/config` ("could not lock config file") when two
// runs create worktrees at once — e.g. two loops triggered together, or a loop plus
// a PR action. This in-process mutex runs them one at a time.
let gitOpChain: Promise<unknown> = Promise.resolve();
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitOpChain.then(fn, fn);
  gitOpChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
}

/**
 * Seed the webapp's gitignored `.env.local` from the main checkout into a fresh
 * worktree. It carries the WorkOS/AWS config AND the dev-auth bypass
 * (DEV_AUTH_*), so a session can run `just dev` and browser/CDP-test the webapp
 * fully authenticated — no WorkOS login, no per-worktree `vercel env pull`.
 * Best-effort and idempotent: only copies when the source exists and the
 * destination doesn't.
 */
async function seedWebappEnv(webappDir: string): Promise<void> {
  const src = `${TELLA_FUSION}/packages/core/webapp/.env.local`;
  const dest = `${webappDir}/.env.local`;
  try {
    if (existsSync(src) && !existsSync(dest)) {
      await Bun.write(dest, Bun.file(src));
      console.log(`[worktree] seeded .env.local into ${webappDir}`);
    }
  } catch (e) {
    console.warn(`[worktree] failed to seed .env.local into ${webappDir}:`, e);
  }
}

export async function listWorktrees(projectId?: string): Promise<WorktreeInfo[]> {
  const project = getProject(projectId);
  const prefix = `${WORKTREES_DIR}/${project.wtPrefix}-`;
  try {
    const result = await $`git -C ${project.repo} worktree list --porcelain`.text();
    const worktrees: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of result.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch refs/heads/".length);
      } else if (line === "") {
        if (currentPath && currentBranch && currentPath.startsWith(prefix)) {
          worktrees.push({ branch: currentBranch, path: currentPath });
        }
        currentPath = "";
        currentBranch = "";
      }
    }

    return worktrees;
  } catch (e) {
    console.error("Failed to list worktrees:", e);
    return [];
  }
}

export async function removeWorktree(branch: string, projectId?: string): Promise<void> {
  const project = getProject(projectId);
  try {
    const wtPath = `${WORKTREES_DIR}/${project.wtPrefix}-${branch}`;
    // Use the wt delete script for tella-fusion when available, otherwise plain
    // git worktree remove (the wt script is tella-fusion-specific).
    if (project.id === "tella-fusion" && (await Bun.file("/home/ubuntu/bin/wt").exists())) {
      await $`/home/ubuntu/bin/wt delete ${branch}`.quiet();
    } else {
      await $`git -C ${project.repo} worktree remove ${wtPath} --force`.quiet();
    }
  } catch (e) {
    console.error(`Failed to remove worktree for ${branch}:`, e);
    // Don't throw — session deletion should still succeed
  }
}

// No uncommitted/untracked changes, and every commit reachable from some
// remote ref (covers both pushed branches and branches merged to origin/main).
// Stale remote refs err on the safe side: recently-pushed work looks unpushed.
async function isWorktreeClean(wtPath: string, branch: string): Promise<boolean> {
  const status = await $`git -C ${wtPath} status --porcelain`.text();
  if (status.trim() !== "") return false;
  const unpushed =
    await $`git -C ${wtPath} rev-list ${branch} --not --remotes --count`.text();
  return unpushed.trim() === "0";
}

/**
 * Remove worktrees of archived sessions idle for more than `days` days.
 * A worktree survives the sweep if any session sharing its branch is still
 * live (running, unarchived, or recently active), or if it has uncommitted
 * changes or commits that exist on no remote ref — WIP is never deleted.
 * Returns the branches whose worktrees were removed.
 */
export async function sweepArchivedWorktrees(
  sessions: UnifiedSession[],
  days: number
): Promise<string[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const inUse = new Set<string>();
  const candidates = new Set<string>();

  for (const s of sessions) {
    if (!s.branch) continue;
    const sweepable =
      s.archived && !s.isRunning && new Date(s.lastActivity).getTime() < cutoff;
    if (sweepable && s.worktreeDir) candidates.add(s.branch);
    else if (!sweepable) inUse.add(s.branch);
  }

  const existing = new Map(
    (await listWorktrees()).map((w) => [w.branch, w.path])
  );
  const removed: string[] = [];

  for (const branch of candidates) {
    if (inUse.has(branch)) continue;
    const wtPath = existing.get(branch);
    if (!wtPath) continue; // worktree already gone
    try {
      if (!(await isWorktreeClean(wtPath, branch))) continue;
      await removeWorktree(branch);
      if (!existsSync(wtPath)) removed.push(branch);
    } catch (e) {
      console.error(`[worktree-sweep] Skipping ${branch}:`, e);
    }
  }

  return removed;
}

/**
 * Recreate a worktree that was cleaned up while its session lives on. Reuses
 * the local branch when it still exists (uncommitted work is gone, but the
 * branch history survives); otherwise starts the branch fresh from main. The
 * path is identical to the original, so claude session resume keeps working
 * (transcripts are keyed by cwd).
 */
export async function reviveWorktree(branch: string, projectId?: string): Promise<string> {
  const project = getProject(projectId);
  const wtPath = `${WORKTREES_DIR}/${project.wtPrefix}-${branch}`;
  if (existsSync(wtPath)) return wtPath;

  return withGitLock(async () => {
    await $`git -C ${project.repo} worktree prune`.quiet();
    const hasBranch =
      (await $`git -C ${project.repo} show-ref --verify --quiet refs/heads/${branch}`.nothrow()).exitCode === 0;
    if (hasBranch) {
      await $`git -C ${project.repo} worktree add ${wtPath} ${branch}`;
    } else {
      await $`git -C ${project.repo} fetch origin ${project.defaultBranch} --quiet`;
      await $`git -C ${project.repo} worktree add -b ${branch} ${wtPath} origin/${project.defaultBranch}`;
    }
    return wtPath;
  });
}

/**
 * Worktree checked out to an EXISTING PR head branch (not branched from main),
 * so commits/pushes land back on that PR. Uses a dedicated `-michael` path so it
 * never clobbers a human/Slack worktree on the same branch. On reuse, hard-resets
 * to the freshly fetched PR head (each fix iteration pushes before yielding, so
 * there's no un-pushed local work to lose). Push back with
 * `git push origin HEAD:<headRef>`.
 */
export async function createWorktreeForPrBranch(headRef: string): Promise<string> {
  const wtPath = `${WORKTREES_DIR}/tella-fusion-${headRef}-michael`;

  const reused = await withGitLock(async () => {
    await $`git -C ${TELLA_FUSION} fetch origin ${headRef} --quiet`;
    if (existsSync(wtPath)) {
      await $`git -C ${wtPath} fetch origin ${headRef} --quiet`.nothrow();
      await $`git -C ${wtPath} reset --hard origin/${headRef}`.quiet().nothrow();
      return true;
    }
    await $`git -C ${TELLA_FUSION} worktree prune`.quiet();
    await $`git -C ${TELLA_FUSION} worktree add ${wtPath} -B ${headRef}-michael origin/${headRef}`;
    return false;
  });
  if (reused) return wtPath;

  // Best-effort dep install so checks/builds the agent runs have deps available.
  const webappDir = `${wtPath}/packages/core/webapp`;
  await seedWebappEnv(webappDir);
  try {
    if (await Bun.file(`${webappDir}/package.json`).exists()) {
      await $`cd ${webappDir} && bun install`.quiet();
    }
  } catch (e) {
    console.warn(`[worktree] bun install failed for ${headRef} (continuing):`, e);
  }

  return wtPath;
}

export async function createWorktree(branch: string, projectId?: string): Promise<string> {
  const project = getProject(projectId);

  // Shared-checkout projects (backstage) don't get a per-session worktree: the
  // session works in the live main checkout on the default branch so its edits
  // hot-reload in the running server. No branch is created or switched — every
  // session stays on the default branch and commits there.
  if (project.sharedCheckout) return project.repo;

  const wtPath = `${WORKTREES_DIR}/${project.wtPrefix}-${branch}`;

  await withGitLock(async () => {
    await $`git -C ${project.repo} fetch origin ${project.defaultBranch} --quiet`;
    await $`git -C ${project.repo} worktree add -b ${branch} ${wtPath} origin/${project.defaultBranch}`;
  });

  // Best-effort dep install — sessions can always run `bun install` themselves.
  // tella-fusion's deps + dev-auth env live under the webapp; other projects
  // (e.g. backstage) install from the repo root.
  try {
    if (project.id === "tella-fusion") {
      const webappDir = `${wtPath}/packages/core/webapp`;
      await seedWebappEnv(webappDir);
      if (await Bun.file(`${webappDir}/package.json`).exists()) {
        await $`cd ${webappDir} && bun install`.quiet();
      }
    } else if (await Bun.file(`${wtPath}/package.json`).exists()) {
      await $`cd ${wtPath} && bun install`.quiet();
    }
  } catch (e) {
    console.warn(`[worktree] bun install failed for ${branch} (continuing):`, e);
  }

  return wtPath;
}
