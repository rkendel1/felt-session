/**
 * Channel-scoped memory for the Slack agent.
 *
 * Scopes (mirrors Slack's visibility model):
 *   - Public channel  -> the shared `workspace` store (read + write). Anything
 *     remembered in a public channel is visible workspace-wide.
 *   - Private channel -> an isolated `channel-<id>` store (read + write), PLUS
 *     read-only visibility of the workspace store.
 *   - DM              -> an isolated `user-<id>` store (read + write), PLUS
 *     read-only visibility of the workspace store.
 *
 * Memory is both (a) auto-injected into the system prompt each run so the agent
 * "just knows" the channel's facts, and (b) managed conversationally via the
 * remember / list_memory / forget admin tools.
 */

import { existsSync } from "fs";
import { join } from "path";
import { unlinkSync } from "fs";
import { stateDir } from "../../server/paths";

export const MEMORY_DIR = stateDir("memory");

// Test seam: the snapshot harness (src/server/testing/) redirects the store so
// a recorded fixture can never embed the team's real memories, and so a run's
// injected memory note is fixture data rather than whatever this box happens
// to remember. Resolved per call; MEMORY_DIR itself stays the default.
let memoryDirOverride: string | null = null;

/**
 * Directory backing the scope stores.
 *
 * Resolution order: a test override, isolated state, then the live store.
 */
export function memoryDir(): string {
  if (memoryDirOverride) return memoryDirOverride;
  return process.env.OPENSESSION_STATE_DIR ? stateDir("memory") : MEMORY_DIR;
}

/** JSON roots eligible for a v2 import. */
export function memoryImportDirs(): string[] {
  return [memoryDir()];
}

const MEMORY_V2_DIRTY_MARKER = ".memory-v2-dirty";

export function markMemoryImportDirty(): void {
  throw new Error("Legacy memory writes are disabled; managed FeltDB is authoritative");
}

export function memoryImportIsDirty(sourceDirs: string[]): boolean {
  return sourceDirs.some((directory) => existsSync(join(directory, MEMORY_V2_DIRTY_MARKER)));
}

export function clearMemoryImportDirty(sourceDirs: string[]): void {
  for (const directory of sourceDirs) {
    try {
      unlinkSync(join(directory, MEMORY_V2_DIRTY_MARKER));
    } catch {}
  }
}

/** Point the memory store at another directory; returns the previous value. */
export function __setMemoryDirForTest(dir: string | null): string | null {
  const prev = memoryDirOverride;
  memoryDirOverride = dir;
  return prev;
}

export interface MemoryEntry {
  id: string;
  text: string;
  by: string;
  at: string;
  /** Ids this entry replaces. Set when a fact is corrected rather than added:
   *  the model already writes "CORRECTION to memory X" in the prose, so this
   *  is that same relation in a form the store can act on. */
  supersedes?: string[];
  /** Id of the entry that replaced this one. */
  supersededBy?: string;
  /** When this entry stopped being injected. Archived entries stay in the
   *  file — recoverable, and reachable through search — but cost no prompt. */
  archivedAt?: string;
}

/** Superseded entries are history, not standing context. */
export function isArchivedMemory(entry: MemoryEntry): boolean {
  return !!entry.archivedAt;
}

/** The entries that still count as current. */
export function activeMemories(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => !isArchivedMemory(e));
}

export interface MemoryContext {
  channel: string;
  userId: string;
  isDM: boolean;
  /** Private (non-DM) channel. Ignored when isDM is true. */
  isPrivate: boolean;
}

/** Where this context reads from / writes to. */
function resolveScopes(ctx: MemoryContext): {
  writable: string;
  sharedReadonly: string | null;
} {
  if (ctx.isDM) return { writable: `user-${ctx.userId}`, sharedReadonly: "workspace" };
  if (ctx.isPrivate)
    return { writable: `channel-${ctx.channel}`, sharedReadonly: "workspace" };
  return { writable: "workspace", sharedReadonly: null };
}

/** Exported for session-memory.ts (repo/user/team scopes share this store). */
export async function loadScope(scope: string): Promise<MemoryEntry[]> {
  const { store } = await (await import("../../server/memory-v2/runtime")).ensureMemoryV2Ready();
  const entries: MemoryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = store.list({ scopeKeys: [scope], states: ["active", "archived", "superseded", "expired"] },
      { cursor, limit: 100 });
    entries.push(...page.items.map((record) => ({
      id: record.id,
      text: record.details || record.summary,
      by: record.source.actor || record.source.type,
      at: record.createdAt,
      supersedes: record.supersedes.length ? record.supersedes : undefined,
      supersededBy: record.supersededBy,
      archivedAt: record.state === "active" ? undefined : record.updatedAt,
    })));
    cursor = page.nextCursor;
  } while (cursor);
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

export async function saveScope(scope: string, entries: MemoryEntry[]): Promise<void> {
  const { store } = await (await import("../../server/memory-v2/runtime")).ensureMemoryV2Ready();
  const desired = new Map(entries.map((entry) => [entry.id, entry]));
  const current = store.list({ scopeKeys: [scope], states: ["active", "archived", "superseded", "expired"] },
    { limit: 1000 }).items;
  for (const record of current) if (!desired.has(record.id)) await store.delete(record.id);
  for (const entry of entries) {
    const record = store.get(entry.id);
    if (!record) {
      const { legacySummary } = await import("../../server/memory-v2/legacy-import");
      const summary = legacySummary(entry.text);
      await store.create({
        id: entry.id,
        scopeKey: scope,
        summary,
        ...(summary === entry.text.trim() ? {} : { details: entry.text }),
        kind: "reference",
        tier: "pinned",
        source: { type: "agent-verified", actor: entry.by },
        createdAt: Number.isFinite(Date.parse(entry.at)) ? entry.at : new Date().toISOString(),
        supersedes: entry.supersedes,
        tags: [],
      });
      if (entry.archivedAt) await store.archive(entry.id, new Date(entry.archivedAt), entry.supersededBy);
      continue;
    }
    const { legacySummary } = await import("../../server/memory-v2/legacy-import");
    const summary = legacySummary(entry.text);
    if (record.summary !== summary || (record.details || "") !== (summary === entry.text.trim() ? "" : entry.text))
      await store.update(record.id, { summary, details: summary === entry.text.trim() ? null : entry.text,
        source: { ...record.source, actor: entry.by } });
    if (entry.archivedAt && record.state === "active")
      await store.archive(record.id, new Date(entry.archivedAt), entry.supersededBy);
    if (!entry.archivedAt && record.state === "archived") await store.restore(record.id);
  }
}

/** Save a new fact to the writable store for this context. */
export async function addMemory(
  ctx: MemoryContext,
  text: string,
  by: string
): Promise<MemoryEntry> {
  const { writable } = resolveScopes(ctx);
  {
    const { ensureMemoryV2Ready, legacySummary } = await import("../../server/memory-v2");
    const { store } = await ensureMemoryV2Ready();
    const summary = legacySummary(text);
    const record = await store.create({
      scopeKey: writable,
      summary,
      ...(summary === text.trim() ? {} : { details: text }),
      kind: "reference",
      tier: "retrievable",
      source: { type: "slack", actor: by || undefined, channelId: ctx.channel },
      tags: ["slack"],
    });
    return {
      id: record.id,
      text: record.summary,
      by: by || "someone",
      at: record.createdAt,
    };
  }
}

export interface MemoryView {
  /** Entries the agent can edit here. */
  local: MemoryEntry[];
  /** Workspace entries visible but read-only in this scope (private/DM only). */
  shared: MemoryEntry[];
  /** True when the local store IS the workspace store (public channels). */
  localIsWorkspace: boolean;
}

export async function listMemory(ctx: MemoryContext): Promise<MemoryView> {
  const { writable, sharedReadonly } = resolveScopes(ctx);
  {
    const { ensureMemoryV2Ready } = await import("../../server/memory-v2");
    const { store } = await ensureMemoryV2Ready();
    const read = (scopeKey: string): MemoryEntry[] => {
      const out: MemoryEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = store.list(
          { scopeKeys: [scopeKey], states: ["active"] },
          { cursor, limit: 100 },
        );
        out.push(...page.items.map((record) => ({
          id: record.id,
          text: record.summary,
          by: record.source.type,
          at: record.createdAt,
        })));
        cursor = page.nextCursor;
      } while (cursor && out.length < 50);
      return out.slice(0, 50);
    };
    return {
      local: read(writable),
      shared: sharedReadonly ? read(sharedReadonly) : [],
      localIsWorkspace: writable === "workspace",
    };
  }
}

export type ForgetResult =
  | { ok: true; removed: MemoryEntry }
  | { ok: false; error: string };

/** Remove an entry by id from the writable store for this context. */
export async function forgetMemory(
  ctx: MemoryContext,
  id: string
): Promise<ForgetResult> {
  const { writable, sharedReadonly } = resolveScopes(ctx);
  {
    const { ensureMemoryV2Ready } = await import("../../server/memory-v2");
    const { store } = await ensureMemoryV2Ready();
    const record = store.get(id);
    if (!record || record.scopeKey !== writable) {
      if (record && sharedReadonly && record.scopeKey === sharedReadonly) {
        return {
          ok: false,
          error:
            "That entry is workspace memory and is read-only here. Change it from a public channel or Memory settings.",
        };
      }
      return { ok: false, error: `No memory entry with id "${id}" in this scope.` };
    }
    await store.delete(id);
    return {
      ok: true,
      removed: {
        id: record.id,
        text: record.summary,
        by: record.source.type,
        at: record.createdAt,
      },
    };
  }
}

/** Render prompt-matched memory as fenced turn context. */
export async function renderMemoryForPrompt(
  ctx: MemoryContext,
  query = "",
): Promise<string> {
  {
    const { writable, sharedReadonly } = resolveScopes(ctx);
    const { retrieveMemoryForPrompt } = await import("../../server/memory-v2");
    return (
      await retrieveMemoryForPrompt(query, {
        scopeKeys: [writable, ...(sharedReadonly ? [sharedReadonly] : [])],
      })
    ).text;
  }
}
