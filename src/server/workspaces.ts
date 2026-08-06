/**
 * Workspaces — containers that group sessions. A session carries a `workspaceId`
 * pointing here; every session belongs to exactly one workspace.
 *
 * NOT a project. A *project* is the level above: a source of work with its own
 * sidebar band — a registered git repo (worktree.ts REPOS) or a feed (feeds.ts,
 * e.g. Plain). A project holds many workspaces; repo-less scratch workspaces sit
 * outside those project bands. A workspace holds many sessions.
 * The full model is in CONCEPTS.md.
 *
 * A workspace can *optionally own a worktree* (repo + branch + worktreeDir,
 * plus attached repos): new sessions created in the workspace inherit that
 * worktree by default (share mode), or branch a new stacked worktree off it.
 * A workspace with no `worktreeDir` is "ask-style" / not yet materialized.
 *
 * The session still stores its own branch/worktreeDir (the source of truth for the
 * runner cwd); the workspace's worktree fields are the template a new share-mode
 * session copies, and the flag for "does this workspace own a worktree yet".
 *
 * One JSON file per workspace at `~/.opensession-workspaces/<id>.json`, ids
 * `ws-<uuid>`. Mirrors the flat-file pattern in pins.ts / models.ts.
 * Team-internal, no auth.
 */

import { homeDir } from "./paths";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { randomUUID } from "crypto";
import type { AttachedRepo, ExternalRef } from "./types";
import { stateDir } from "./paths";

const WORKSPACES_DIR = stateDir("workspaces");

export interface Workspace {
  id: string;
  name: string;
  /** Default repo for new sessions created in this workspace (repo id). */
  repo?: string;
  /** Optional swatch key for the sidebar dot (see tab-colors). */
  color?: string;
  createdBy: string;
  createdAt: string;
  /** Manual sort order in the sidebar; lower = higher. Defaults to createdAt. */
  order?: number;
  /**
   * Stable dedupe key for auto-created workspaces (e.g. `ghpr-1234` for a PR).
   * Lets a caller find-or-create idempotently. Absent for user-made workspaces.
   */
  key?: string;
  /** For PR-backed workspaces: the PR number this workspace groups. */
  prNumber?: number;
  /** For support-ticket workspaces: the Plain thread this workspace is attached to. */
  plainThreadId?: string;
  /** Generic feed-item linkage (Tella videos, …) — the feeds design. */
  externalRefs?: ExternalRef[];
  /**
   * The workspace's default branch. Present when the workspace owns a worktree
   * (share-mode sessions inherit it; stacked sessions branch off it) or for PR-backed
   * workspaces (the head branch the member sessions share).
   */
  branch?: string;
  /**
   * The shared worktree new share-mode sessions inherit. Absent = the workspace does
   * not own a worktree yet (ask-style / unmaterialized).
   */
  worktreeDir?: string;
  /** Secondary repos attached at the workspace level; new sessions copy these. */
  attachedRepos?: AttachedRepo[];
}

function ensureDir(): void {
  if (!existsSync(WORKSPACES_DIR)) mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function fileFor(id: string): string {
  return `${WORKSPACES_DIR}/${id}.json`;
}

/** Reject ids that could escape the directory; workspace ids are server-minted. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export function listWorkspaces(): Workspace[] {
  if (!existsSync(WORKSPACES_DIR)) return [];
  const out: Workspace[] = [];
  for (const file of readdirSync(WORKSPACES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(`${WORKSPACES_DIR}/${file}`, "utf8"));
      if (p && typeof p.id === "string" && typeof p.name === "string") out.push(p);
    } catch {}
  }
  out.sort(
    (a, b) =>
      (a.order ?? (Date.parse(a.createdAt) || 0)) -
        (b.order ?? (Date.parse(b.createdAt) || 0)) || a.name.localeCompare(b.name),
  );
  return out;
}

export function getWorkspace(id: string): Workspace | null {
  if (!safeId(id)) return null;
  const f = fileFor(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Workspace;
  } catch {
    return null;
  }
}

export function createWorkspace(input: {
  name: string;
  repo?: string;
  color?: string;
  createdBy: string;
  key?: string;
  prNumber?: number;
  plainThreadId?: string;
  externalRefs?: ExternalRef[];
  branch?: string;
  worktreeDir?: string;
  attachedRepos?: AttachedRepo[];
  /** Reuse a caller-supplied id (e.g. migration wrapping an orphan session). */
  id?: string;
  createdAt?: string;
}): Workspace {
  ensureDir();
  const workspace: Workspace = {
    id: input.id || `ws-${randomUUID()}`,
    name: (input.name || "Untitled workspace").trim().slice(0, 120) || "Untitled workspace",
    repo: input.repo,
    color: input.color,
    createdBy: input.createdBy || "Anonymous",
    createdAt: input.createdAt || new Date().toISOString(),
    ...(input.key ? { key: input.key } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.plainThreadId ? { plainThreadId: input.plainThreadId } : {}),
    ...(input.externalRefs && input.externalRefs.length
      ? { externalRefs: input.externalRefs }
      : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.worktreeDir ? { worktreeDir: input.worktreeDir } : {}),
    ...(input.attachedRepos && input.attachedRepos.length
      ? { attachedRepos: input.attachedRepos }
      : {}),
  };
  writeJsonAtomic(fileFor(workspace.id), workspace);
  return workspace;
}

/**
 * The workspace that owns `worktreeDir`, or null. When duplicates exist (older
 * create paths minted a second workspace over an already-owned worktree), the
 * oldest wins — it's the one the user thinks of as "the" workspace. Callers
 * must not pass a repo's main checkout: those are legitimately shared by many
 * workspaces (every opensession session, every ask session), so "ownership" is
 * meaningless there.
 */
export function findWorkspaceByWorktree(worktreeDir: string): Workspace | null {
  if (!worktreeDir) return null;
  const owners = listWorkspaces().filter((w) => w.worktreeDir === worktreeDir);
  if (owners.length < 2) return owners[0] || null;
  return owners.sort(
    (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
  )[0];
}

/** Find a workspace by its stable dedupe key, or null. */
export function findWorkspaceByKey(key: string): Workspace | null {
  if (!key) return null;
  return listWorkspaces().find((p) => p.key === key) || null;
}

/**
 * Idempotently resolve the workspace for a stable key, creating it on first use.
 * Used to auto-group related sessions (e.g. every autofix/review/simplify session for
 * one PR) under a single workspace.
 */
export function findOrCreateWorkspaceByKey(
  key: string,
  input: {
    name: string;
    repo?: string;
    color?: string;
    createdBy: string;
    prNumber?: number;
    plainThreadId?: string;
    branch?: string;
  },
): Workspace {
  return findWorkspaceByKey(key) || createWorkspace({ ...input, key });
}

/**
 * Stamp identity fields (dedupe key + PR/ticket linkage) onto an adopted
 * workspace. Deliberately separate from updateWorkspace so identity stays
 * unreachable through the HTTP PATCH route (which forwards its body into
 * updateWorkspace). Refuses to re-key an already-keyed workspace — the key is
 * permanent provenance; resolution falls back to session matching for any
 * additional PRs a workspace accrues.
 */
export function stampWorkspaceIdentity(
  id: string,
  patch: {
    key?: string;
    prNumber?: number;
    branch?: string;
    plainThreadId?: string;
    externalRef?: ExternalRef;
  },
): Workspace | null {
  const cur = getWorkspace(id);
  if (!cur) return null;
  if (cur.key && patch.key && cur.key !== patch.key) return cur;
  // externalRefs accrue (a workspace can carry several linked objects, like
  // PRs) — only the dedupe key is refused once present.
  const addRef =
    patch.externalRef &&
    !(cur.externalRefs || []).some(
      (r) => r.kind === patch.externalRef!.kind && r.id === patch.externalRef!.id,
    )
      ? [...(cur.externalRefs || []), patch.externalRef]
      : null;
  const next: Workspace = {
    ...cur,
    ...(patch.key && !cur.key ? { key: patch.key } : {}),
    ...(patch.prNumber !== undefined && cur.prNumber === undefined
      ? { prNumber: patch.prNumber }
      : {}),
    ...(patch.branch && !cur.branch ? { branch: patch.branch } : {}),
    ...(patch.plainThreadId && !cur.plainThreadId
      ? { plainThreadId: patch.plainThreadId }
      : {}),
    ...(addRef ? { externalRefs: addRef } : {}),
  };
  writeJsonAtomic(fileFor(id), next);
  return next;
}

/** Merge a partial patch into a workspace. Returns the updated record, or null. */
export function updateWorkspace(
  id: string,
  patch: Partial<
    Pick<Workspace, "name" | "repo" | "color" | "order" | "branch" | "worktreeDir" | "attachedRepos">
  >,
): Workspace | null {
  const cur = getWorkspace(id);
  if (!cur) return null;
  const next: Workspace = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || cur.name } : {}),
    ...(patch.repo !== undefined ? { repo: patch.repo } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.order !== undefined ? { order: patch.order } : {}),
    ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
    ...(patch.worktreeDir !== undefined ? { worktreeDir: patch.worktreeDir } : {}),
    ...(patch.attachedRepos !== undefined ? { attachedRepos: patch.attachedRepos } : {}),
  };
  writeJsonAtomic(fileFor(id), next);
  return next;
}

/**
 * Re-point a workspace at a different worktree — the repo-switch case, where the
 * workspace was minted around a checkout its only session has since left. Unlike
 * updateWorkspace, an omitted branch/worktreeDir CLEARS the field rather than
 * leaving it: switching into a shared-checkout repo leaves no per-session worktree
 * for a sibling session to inherit, and a stale one would send it to the abandoned
 * checkout. Identity (key, prNumber, ticket/feed refs) is untouched.
 */
export function restampWorkspaceWorktree(
  id: string,
  next: { repo: string; branch?: string; worktreeDir?: string },
): Workspace | null {
  const cur = getWorkspace(id);
  if (!cur) return null;
  const { branch: _b, worktreeDir: _w, ...rest } = cur;
  const updated: Workspace = {
    ...rest,
    repo: next.repo,
    ...(next.branch ? { branch: next.branch } : {}),
    ...(next.worktreeDir ? { worktreeDir: next.worktreeDir } : {}),
  };
  writeJsonAtomic(fileFor(id), updated);
  return updated;
}

/**
 * Delete a workspace. Every session belongs to exactly one workspace, so the caller
 * is responsible for re-homing member sessions first (never orphan them). This only
 * removes the workspace metadata file.
 */
export function deleteWorkspace(id: string): boolean {
  if (!safeId(id)) return false;
  const f = fileFor(id);
  if (!existsSync(f)) return false;
  try {
    rmSync(f);
    // A deleted workspace's scratch dir (scratch-mode sessions — see
    // worktree.ts ensureScratchDir) goes with it; safeId() already rules
    // out anything path-escaping.
    try {
      rmSync(`${stateDir("scratch")}/${id}`, { recursive: true, force: true });
    } catch {}
    return true;
  } catch {
    return false;
  }
}
