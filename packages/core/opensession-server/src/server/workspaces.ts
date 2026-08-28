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

import { canonicalRepoId, defaultRepo } from "./config";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { randomUUID } from "crypto";
import type { AttachedRepo, ExternalRef } from "./types";
import type { SessionEffort } from "./models";
import { stateDir } from "./paths";
import { managedFeltDb } from "./managed-feltdb";
import type { StateFirstDB } from "@feltdb/core";
import { ManagedOpenSessionState, type ManagedRecord } from "./managed-state";

/** Resolved per call, not pinned at module load: statePath reads
 *  OPENSESSION_STATE_DIR at call time so tests can repoint it, and bun runs
 *  every test file in one process, so a module-load pin here would belong to
 *  whichever file imported workspaces first; test fixtures then leak into
 *  the live store (they did, 2026-08-15). */
function workspacesDir(): string {
  return stateDir("workspaces");
}

/** A workspace-owned model combination. The lead owns the conversation; the
 * supporting models are available to it as focused worker sessions. */
export interface WorkspaceModelPreset {
  id: string;
  label: string;
  /** Picker section, so workspaces can make their own families. */
  group?: string;
  instructions?: string;
  lead: { model: string; effort?: SessionEffort };
  supporting?: Array<{ model: string; effort?: SessionEffort; role?: string }>;
}

export interface WorkspaceModelSettings {
  presets?: WorkspaceModelPreset[];
}

/** A composer, not a document store. Mirrors MAX_DRAFT_LENGTH in drafts.ts. */
const MAX_DRAFT_LENGTH = 32_000;

/** An unsent composer prompt parked on a workspace before any session exists. */
export interface WorkspaceDraft {
  text: string;
  /** ISO time of the keystroke this text came from (client clock). */
  updatedAt: string;
  by?: string;
  /** While truthy, applying a draft update also renames the workspace to the
   *  draft's first line (see updateWorkspace); a manual rename sets this false
   *  and stops the follow for life. */
  autoName?: boolean;
}

/** Seeded into every new workspace. These are ordinary presets, not runtime
 * feature flags: removing one removes it, and new combinations use this shape. */
export const DEFAULT_WORKSPACE_MODEL_SETTINGS: WorkspaceModelSettings = {
  presets: [
    { id: "role-architect", label: "Architect", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as the software architect. Investigate the repository, identify constraints and risks, and produce a concrete implementation design. Do not edit code unless explicitly asked to move into implementation." },
    { id: "role-researcher", label: "Researcher", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as the research agent. Investigate the question using the available sources and tools, distinguish evidence from inference, and return findings with useful attribution. Do not turn the work into a coding task unless explicitly asked." },
    { id: "role-planner", label: "Planner", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as the planning agent. Clarify the outcome, identify dependencies and decisions, and produce an actionable plan. Planning may be the final deliverable; do not implement unless explicitly asked." },
    { id: "role-coder", label: "Coder · Ollama", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as the primary coding agent. Implement the requested change, follow repository instructions, run relevant tests, and report the completed result." },
    { id: "role-reviewer", label: "Reviewer", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as an independent code reviewer. Inspect the actual diff and surrounding behavior for correctness, regressions, security, and maintainability. Do not modify code unless explicitly asked to fix findings." },
    { id: "role-tester", label: "Tester · Ollama", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as the test engineer. Reproduce behavior, design high-value edge cases, run the relevant test suites, and report evidence. Add or change tests only when asked to implement them." },
    { id: "role-release", label: "Release", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as the release engineer. Verify the target revision, required checks, rollout procedure, health signals, and rollback path before promoting it." },
    { id: "role-github", label: "GitHub agent", group: "roles", lead: { model: "pi/ollama/qwen3-coder:latest" }, instructions: "Act as the GitHub agent. Work through the configured GitHub integration, preserve repository scope and publication policy, and manage issues, pull requests, reviews, and checks requested by the user." },
    { id: "dial-ultra", label: "Dial · Ultra", group: "dial", lead: { model: "pi/anthropic/claude-fable-5", effort: "high" }, supporting: [{ model: "pi/openai/gpt-5.6-sol", effort: "xhigh", role: "Read-only oracle" }], instructions: "Use the oracle for a second opinion on hard plans, architecture decisions, and significant reviews. Integrate its advice yourself." },
    { id: "dial-high", label: "Dial · High", group: "dial", lead: { model: "pi/openai/gpt-5.6-sol", effort: "xhigh" }, supporting: [{ model: "pi/anthropic/claude-fable-5", effort: "high", role: "Read-only oracle" }], instructions: "Use the oracle for a second opinion on hard plans, architecture decisions, and significant reviews. Integrate its advice yourself." },
    { id: "dial-medium", label: "Dial · Medium", group: "dial", lead: { model: "pi/openai/gpt-5.6-sol", effort: "high" }, supporting: [{ model: "pi/openai/gpt-5.6-sol", effort: "xhigh", role: "Read-only oracle" }], instructions: "Use the oracle for a second opinion when extra scrutiny helps." },
    { id: "dial-low", label: "Dial · Low", group: "dial", lead: { model: "pi/openai/gpt-5.6-luna", effort: "high" }, supporting: [{ model: "pi/openai/gpt-5.6-sol", effort: "xhigh", role: "Read-only oracle" }], instructions: "Use the oracle only when the task needs a second opinion." },
    { id: "opus-fable", label: "Opus 5 + Fable oracle", group: "custom", lead: { model: "pi/anthropic/claude-opus-5", effort: "xhigh" }, supporting: [{ model: "pi/anthropic/claude-fable-5", effort: "high", role: "Read-only oracle" }], instructions: "Use the oracle for a second opinion on hard plans, architecture decisions, and significant reviews. Integrate its advice yourself." },
    { id: "ultracode", label: "Ultracode", group: "custom", lead: { model: "pi/anthropic/claude-fable-5", effort: "xhigh" }, instructions: "Plan a workflow for every substantive task instead of working through it turn by turn. Fan the work out with run_workflow, have a separate agent verify each finding, and read the result back with workflow_status. Route the judgement steps (verification, ranking, synthesis) to claude-fable-5 and leave mechanical extraction on the default worker model. Keep quick questions and single edits in the conversation." },
    { id: "orchestrator-fable", label: "Orchestrator · Fable 5", group: "orchestrator", lead: { model: "pi/anthropic/claude-fable-5", effort: "high" }, supporting: [{ model: "pi/anthropic/claude-sonnet-5", effort: "medium", role: "Implementation worker" }, { model: "pi/anthropic/claude-haiku-4-5", effort: "high", role: "Fast worker" }], instructions: "Plan, review, and integrate. Delegate focused implementation work to supporting workers with self-contained briefs, then verify their results." },
    { id: "orchestrator-sol", label: "Orchestrator · Sol", group: "orchestrator", lead: { model: "pi/openai/gpt-5.6-sol", effort: "xhigh" }, supporting: [{ model: "pi/openai/gpt-5.6-terra", effort: "medium", role: "Implementation worker" }, { model: "pi/openai/gpt-5.6-luna", effort: "low", role: "Fast worker" }], instructions: "Plan, review, and integrate. Delegate focused implementation work to supporting workers with self-contained briefs, then verify their results." },
  ],
};

function copyModelSettings(settings: WorkspaceModelSettings): WorkspaceModelSettings {
  return JSON.parse(JSON.stringify(settings)) as WorkspaceModelSettings;
}

/** A workspace without its own modelSettings inherits the current defaults.
 *  Nothing materializes defaults into workspace files or list payloads; a
 *  workspace stores modelSettings only once someone saves an edit. */
export function workspaceModelSettings(workspace?: Workspace | null): WorkspaceModelSettings {
  return workspace?.modelSettings || copyModelSettings(DEFAULT_WORKSPACE_MODEL_SETTINGS);
}

export interface Workspace {
  id: string;
  name: string;
  /** Manually removed from the active workspace list, independent of sessions. */
  archived?: boolean;
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
  /** Generic feed-item linkage (videos, …) — the feeds design. */
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
  /** Workspace-specific model families and combinations. */
  modelSettings?: WorkspaceModelSettings;
  /**
   * An unsent composer prompt parked here before any session exists. Absent
   * = no draft. Never backfilled onto a workspace record (same rule as
   * modelSettings above: stamping this on every row would multiply the list
   * payload by the workspace count).
   */
  draft?: WorkspaceDraft;
}

function fileFor(id: string): string {
  return `${workspacesDir()}/${id}.json`;
}

/** Reject ids that could escape the directory; workspace ids are server-minted. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * A workspace as read from disk, with its repo ids resolved through any rename
 * (canonicalRepoId). A workspace file keeps whatever id was registered when it
 * was written, and every client groups by that id: 633 of the workspaces on
 * this instance say `backstage`, which drew the repo a second sidebar band of
 * its own. Reading through this is what keeps one repo one band, and the file
 * itself is rewritten with the current id the next time it is saved.
 *
 * Both callers hand it a freshly parsed object, so it normalizes in place.
 */
function fromDisk(p: Workspace): Workspace {
  // "auto" was briefly persisted by the retired repository picker. Treat it
  // as the registered default until the next save rewrites the repaired id.
  if (p.repo === "auto") p.repo = defaultRepo().id;
  else if (p.repo) p.repo = canonicalRepoId(p.repo);
  for (const r of p.attachedRepos || []) r.repo = canonicalRepoId(r.repo);
  return p;
}

let workspaceNameGeneration = 0;
let workspaceRecords: Map<string, Workspace> | null = null;
let workspaceSubscription: (() => void) | null = null;
let workspaceState: ManagedOpenSessionState | null = null;

function requireWorkspaceRecords(): Map<string, Workspace> {
	if (!workspaceRecords)
		throw new Error("Managed FeltDB workspace state has not been initialized");
	return workspaceRecords;
}

function replaceWorkspaceRecords(records: Array<ManagedRecord<Workspace>>): void {
	workspaceRecords = new Map(
		records.map((record) => [record.id, fromDisk(structuredClone(record.payload))]),
	);
	workspaceNameGeneration++;
}

/** Load the managed workspace projection before any request can read it. The
 * process-local map is disposable and is refreshed from the authority's event
 * stream; every mutation awaits the managed write before changing the map. */
export async function initializeManagedWorkspaces(db: StateFirstDB = managedFeltDb()): Promise<void> {
	workspaceState = new ManagedOpenSessionState(db);
	const collection = workspaceState.workspaces;
	replaceWorkspaceRecords(await collection.all());
	workspaceSubscription?.();
	workspaceSubscription = collection.subscribe((records) => replaceWorkspaceRecords(records));
}

export function listWorkspaces(): Workspace[] {
	const out = [...requireWorkspaceRecords().values()].map((workspace) => structuredClone(workspace));
  out.sort(
    (a, b) =>
      (a.order ?? (Date.parse(a.createdAt) || 0)) -
        (b.order ?? (Date.parse(b.createdAt) || 0)) || a.name.localeCompare(b.name),
  );
	return out;
}

/** Stable version for conditional workspace-list responses. */
export function workspaceListVersion(): string {
	return `managed:${workspaceNameGeneration}`;
}

/**
 * id → name for every workspace in the active workspace directory, held in
 * memory. The directory is part of the cache key because state roots can
 * change within one process in tests and dev tooling.
 *
 * The session list stamps each row with its workspace's name so a client can
 * title a workspace row before (or without) loading the workspace list. Doing
 * that from disk would mean re-reading every workspace file on each list
 * rebuild: 4,378 files and ~0.4s on this instance. The map is built once and
 * then maintained by the writers below, which are the only code that ever
 * writes a workspace file for a given state root.
 */
function workspaceNameMap(): Map<string, string> {
	return new Map([...requireWorkspaceRecords()].map(([id, workspace]) => [id, workspace.name]));
}

/** Build the cold workspace-name index without holding the event loop. */
export async function warmWorkspaceNamesAsync(): Promise<void> {
	requireWorkspaceRecords();
}

/** The workspace's display name, or null when there is no such workspace. */
export function workspaceName(id: string): string | null {
  if (!safeId(id)) return null;
  return workspaceNameMap().get(id) ?? null;
}

/** The one write path for a workspace file, so the name map stays current. */
async function saveWorkspace(workspace: Workspace): Promise<Workspace> {
	if (!workspaceState) throw new Error("Managed FeltDB workspace state has not been initialized");
	await workspaceState.putWorkspace(workspace);
	requireWorkspaceRecords().set(workspace.id, structuredClone(workspace));
	workspaceNameGeneration++;
	return workspace;
}

export function getWorkspace(id: string): Workspace | null {
  if (!safeId(id)) return null;
	const workspace = requireWorkspaceRecords().get(id);
	return workspace ? structuredClone(workspace) : null;
}

export async function createWorkspace(input: {
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
  draft?: WorkspaceDraft;
  /** Reuse a caller-supplied id (e.g. migration wrapping an orphan session). */
  id?: string;
  createdAt?: string;
}): Promise<Workspace> {
  const workspace: Workspace = {
    id: input.id || `ws-${randomUUID()}`,
    name: (input.name || "Untitled workspace").trim().slice(0, 120) || "Untitled workspace",
    repo: input.repo === "auto" ? defaultRepo().id : input.repo,
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
    ...(input.draft
      ? { draft: { ...input.draft, text: input.draft.text.slice(0, MAX_DRAFT_LENGTH) } }
      : {}),
  };
  return saveWorkspace(workspace);
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
 * The workspace already carrying `repo` + `branch`, or null. Same
 * adopt-don't-duplicate role as findWorkspaceByWorktree, one level up: the
 * Slack/Linear loops and PR automations each run the SAME branch in their own
 * worktree, so worktree ownership alone can't unite them (the split that left
 * a slack session and its PR's review session in two sidebar workspaces).
 * Callers must not pass a repo's default branch — every shared-checkout
 * session carries it, and those deliberately keep one workspace each.
 * Preference among duplicates: a key-stamped workspace (PR/ticket provenance,
 * the one resolution converges on) over unkeyed, then oldest.
 */
export function findWorkspaceByBranch(
  repo: string,
  branch: string,
): Workspace | null {
  if (!repo || !branch) return null;
  // Workspaces minted before repo stamping (and sweep-minted ones around
  // repo-less slack sessions) carry no repo field; they mean the default repo.
  const fallback = defaultRepo().id;
  const owners = listWorkspaces().filter(
    (w) => w.branch === branch && (w.repo || fallback) === repo,
  );
  if (owners.length < 2) return owners[0] || null;
  return owners.sort(
    (a, b) =>
      Number(!!b.key) - Number(!!a.key) ||
      (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
  )[0];
}

/**
 * Idempotently resolve the workspace for a stable key, creating it on first use.
 * Used to auto-group related sessions (e.g. every autofix/review/simplify session for
 * one PR) under a single workspace.
 */
export async function findOrCreateWorkspaceByKey(
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
): Promise<Workspace> {
  return findWorkspaceByKey(key) || await createWorkspace({ ...input, key });
}

/**
 * Stamp identity fields (dedupe key + PR/ticket linkage) onto an adopted
 * workspace. Deliberately separate from updateWorkspace so identity stays
 * unreachable through the HTTP PATCH route (which forwards its body into
 * updateWorkspace). Refuses to re-key an already-keyed workspace — the key is
 * permanent provenance; resolution falls back to session matching for any
 * additional PRs a workspace accrues.
 */
export async function stampWorkspaceIdentity(
  id: string,
  patch: {
    key?: string;
    prNumber?: number;
    branch?: string;
    repo?: string;
    plainThreadId?: string;
    externalRef?: ExternalRef;
  },
): Promise<Workspace | null> {
  const cur = getWorkspace(id);
  if (!cur) return null;
  if (cur.key && patch.key && cur.key !== patch.key) return cur;
  // The adopted workspace may have been minted by a session in ANOTHER repo:
  // a session working in repo A can open a PR in repo B through an attached
  // repo, and that is how a workspace ended up filed under `opensession` while
  // its branch and PR belonged to another repo. A repo that disagrees with
  // the branch beside it is worse than none: sessionPrBranch refuses to
  // inherit a branch across repos, the sidebar cannot match the PR row to the
  // workspace, and a new session here resolves the branch in the wrong repo.
  // Only when the workspace has not materialized a worktree of its own, which
  // is the point where its repo stops being a guess.
  const adoptRepo =
    patch.repo && !cur.branch && !cur.worktreeDir && cur.repo !== patch.repo;
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
    ...(adoptRepo ? { repo: patch.repo } : {}),
    ...(patch.plainThreadId && !cur.plainThreadId
      ? { plainThreadId: patch.plainThreadId }
      : {}),
    ...(addRef ? { externalRefs: addRef } : {}),
  };
  return saveWorkspace(next);
}

/**
 * Merge a partial patch into a workspace. Returns the updated record, or null.
 *
 * `draft` has its own semantics, mirroring upsertDraft in drafts.ts:
 * - `null` removes the field.
 * - An object applies only when there's no current draft, or its `updatedAt`
 *   is >= the stored one (ISO strings compare lexically). An older write is
 *   refused so a stale client can't clobber newer typing.
 * - While the applying draft's `autoName` is truthy, and the current draft
 *   (if any) hasn't been demoted to `autoName: false`, the workspace is also
 *   renamed to the draft text's first non-empty line (trimmed, sliced to 80
 *   chars; the name is left alone if that line is blank).
 * - An explicit `patch.name` (manual rename) always wins, and, when a draft
 *   exists, permanently demotes it to `autoName: false`, stopping the follow
 *   for life.
 */
export async function updateWorkspace(
  id: string,
  patch: Partial<
    Pick<Workspace, "name" | "repo" | "color" | "order" | "branch" | "worktreeDir" | "attachedRepos" | "modelSettings" | "archived">
  > & { draft?: WorkspaceDraft | null },
): Promise<Workspace | null> {
  const cur = getWorkspace(id);
  if (!cur) return null;
  const manualRename = patch.name !== undefined;

  let nextDraft: WorkspaceDraft | undefined = cur.draft;
  let draftApplied: WorkspaceDraft | undefined;
  if (patch.draft === null) {
    nextDraft = undefined;
  } else if (patch.draft !== undefined) {
    if (!cur.draft || patch.draft.updatedAt >= cur.draft.updatedAt) {
      nextDraft = { ...patch.draft, text: patch.draft.text.slice(0, MAX_DRAFT_LENGTH) };
      draftApplied = nextDraft;
    }
  }

  // A manual rename stops the auto-name follow permanently, whatever draft
  // this patch ends up carrying.
  if (manualRename && nextDraft) nextDraft = { ...nextDraft, autoName: false };

  // Name-follow: a freshly-applied draft update renames the workspace to its
  // first non-empty line, but only while autoName is truthy and hasn't
  // already been demoted, and never alongside an explicit rename, which
  // always wins and just demoted the follow above.
  let followedName: string | undefined;
  if (
    !manualRename &&
    draftApplied &&
    patch.draft &&
    patch.draft.autoName &&
    (!cur.draft || cur.draft.autoName !== false)
  ) {
    const firstLine =
      draftApplied.text.split("\n").find((l) => l.trim())?.trim() ?? "";
    if (firstLine) followedName = firstLine.slice(0, 80);
  }

  const next: Workspace = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || cur.name } : {}),
    ...(followedName ? { name: followedName } : {}),
    ...(patch.repo !== undefined
      ? { repo: patch.repo === "auto" ? defaultRepo().id : patch.repo }
      : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.order !== undefined ? { order: patch.order } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
    ...(patch.worktreeDir !== undefined ? { worktreeDir: patch.worktreeDir } : {}),
    ...(patch.attachedRepos !== undefined ? { attachedRepos: patch.attachedRepos } : {}),
    ...(patch.modelSettings !== undefined ? { modelSettings: patch.modelSettings } : {}),
    draft: nextDraft,
  };
  return saveWorkspace(next);
}

/**
 * Re-point a workspace at a different worktree — the repo-switch case, where the
 * workspace was minted around a checkout its only session has since left. Unlike
 * updateWorkspace, an omitted branch/worktreeDir CLEARS the field rather than
 * leaving it: switching into a shared-checkout repo leaves no per-session worktree
 * for a sibling session to inherit, and a stale one would send it to the abandoned
 * checkout. Identity (key, prNumber, ticket/feed refs) is untouched.
 */
export async function restampWorkspaceWorktree(
  id: string,
  next: { repo: string; branch?: string; worktreeDir?: string },
): Promise<Workspace | null> {
  const cur = getWorkspace(id);
  if (!cur) return null;
  const { branch: _b, worktreeDir: _w, ...rest } = cur;
  const updated: Workspace = {
    ...rest,
    repo: next.repo,
    ...(next.branch ? { branch: next.branch } : {}),
    ...(next.worktreeDir ? { worktreeDir: next.worktreeDir } : {}),
  };
  return saveWorkspace(updated);
}

/**
 * Remove a workspace's metadata file. The caller must handle member sessions first
 * so none retain a reference to a workspace that no longer exists.
 */
export async function deleteWorkspace(id: string): Promise<boolean> {
  if (!safeId(id)) return false;
  const records = requireWorkspaceRecords();
  if (!records.has(id)) return false;
  try {
    if (!workspaceState) throw new Error("Managed FeltDB workspace state has not been initialized");
    await workspaceState.workspaces.delete(id);
    records.delete(id);
    workspaceNameGeneration++;
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

/** Read-only legacy discovery for the explicit migration command. Production
 * reads and writes never call this function and never fall back to it. */
export function readLegacyWorkspacesForMigration(): Workspace[] {
  const dir = workspacesDir();
  if (!existsSync(dir)) return [];
  const records: Workspace[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
      if (parsed && typeof parsed.id === "string" && typeof parsed.name === "string")
        records.push(fromDisk(parsed as Workspace));
    } catch {}
  }
  return records;
}

export function __resetManagedWorkspacesForTest(): void {
  workspaceSubscription?.();
  workspaceSubscription = null;
  workspaceRecords = null;
  workspaceState = null;
  workspaceNameGeneration = 0;
}
