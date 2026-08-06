/**
 * Channel-scoped memory for the Slack agent, modelled on Claude Tag.
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

import { randomUUID } from "crypto";
import { writeJsonAtomic } from "../../server/shared/atomic-write";

export const MEMORY_DIR = `${process.env.HOME}/.michael-memory`;

export interface MemoryEntry {
  id: string;
  text: string;
  by: string;
  at: string;
}

export interface MemoryContext {
  channel: string;
  userId: string;
  isDM: boolean;
  /** Private (non-DM) channel. Ignored when isDM is true. */
  isPrivate: boolean;
}

interface ScopeStore {
  entries: MemoryEntry[];
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

function scopeFile(scope: string): string {
  return `${MEMORY_DIR}/${scope}.json`;
}

/** Exported for session-memory.ts (repo/user/team scopes share this store). */
export async function loadScope(scope: string): Promise<MemoryEntry[]> {
  try {
    const file = Bun.file(scopeFile(scope));
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as ScopeStore;
      return Array.isArray(data.entries) ? data.entries : [];
    }
  } catch (e) {
    console.warn(`[memory] failed to read scope ${scope}:`, e);
  }
  return [];
}

export async function saveScope(scope: string, entries: MemoryEntry[]): Promise<void> {
  writeJsonAtomic(scopeFile(scope), { entries });
}

/** Save a new fact to the writable store for this context. */
export async function addMemory(
  ctx: MemoryContext,
  text: string,
  by: string
): Promise<MemoryEntry> {
  const { writable } = resolveScopes(ctx);
  const entries = await loadScope(writable);
  const entry: MemoryEntry = {
    id: randomUUID().slice(0, 8),
    text: text.trim(),
    by: by || "someone",
    at: new Date().toISOString(),
  };
  entries.push(entry);
  await saveScope(writable, entries);
  return entry;
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
  const local = await loadScope(writable);
  const shared = sharedReadonly ? await loadScope(sharedReadonly) : [];
  return { local, shared, localIsWorkspace: writable === "workspace" };
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
  const entries = await loadScope(writable);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    // Help the model understand *why* a visible id can't be forgotten here.
    if (sharedReadonly) {
      const shared = await loadScope(sharedReadonly);
      if (shared.some((e) => e.id === id)) {
        return {
          ok: false,
          error:
            "That entry is workspace memory (shared from public channels) and is read-only here. " +
            "It can only be edited or forgotten from a public channel.",
        };
      }
    }
    return { ok: false, error: `No memory entry with id "${id}" in this scope.` };
  }
  const [removed] = entries.splice(idx, 1);
  await saveScope(writable, entries);
  return { ok: true, removed };
}

/** Render this context's memory for injection into the system prompt. */
export async function renderMemoryForPrompt(ctx: MemoryContext): Promise<string> {
  const { local, shared, localIsWorkspace } = await listMemory(ctx);
  if (local.length === 0 && shared.length === 0) return "";

  const lines: string[] = [
    "\n\n## Channel memory",
    "Facts remembered for this " +
      (ctx.isDM ? "DM" : localIsWorkspace ? "workspace (public channels)" : "channel") +
      ". Treat these as standing context. The user can change them via the remember/forget tools.",
  ];
  const fmt = (e: MemoryEntry) => `- [${e.id}] ${e.text}`;
  if (local.length) {
    lines.push(localIsWorkspace ? "\nWorkspace memory:" : "\nThis channel:");
    lines.push(...local.map(fmt));
  }
  if (shared.length) {
    lines.push("\nWorkspace memory (shared, read-only here):");
    lines.push(...shared.map(fmt));
  }
  return lines.join("\n");
}
