/**
 * Archive state for sessions of ALL sources. Slack/Linear session files are
 * owned by their agents (read-only for opensession), so archived-ness lives in
 * a backstage-owned registry keyed by unified session id.
 */
import { ManagedValueRegistry } from "./managed-value-registry";
import type { StateFirstDB } from "@feltdb/core";
import { unpinEverywhere } from "./pins";
import type { UnifiedSession } from "./types";
import { setIndexedSessionArchived } from "./session-list-store";

/** Why a session ended up archived — drives the "Auto-archived" filter. */
export type ArchiveReason = "manual" | "idle" | "auto";

interface Entry {
  at: string;
  reason: ArchiveReason;
}

// Registry entries were originally a bare ISO timestamp (implicitly manual).
// Old entries are upgraded to the object shape lazily on next write; reads
// treat a bare string as `{ reason: "manual" }` so existing data keeps working.
type RawEntry = string | Entry;

const registry = new ManagedValueRegistry<RawEntry>("opensession_archive_registry");
export function initializeManagedArchive(db?: StateFirstDB): Promise<void> {
  return registry.initialize(db);
}

function toEntry(raw: RawEntry): Entry {
  return typeof raw === "string" ? { at: raw, reason: "manual" } : raw;
}

export function isArchivedId(id: string): boolean {
  return registry.has(id);
}

/**
 * Drop every pin made stale by archiving `justArchived`: the sessions' own ids
 * and alias ids, plus each `workspace:<id>` pin whose workspace now has no live
 * session left. Pass the full current session list so the "last live session" test
 * can see siblings — call this AFTER the archive registry is written so the
 * just-archived sessions read back as archived. Centralizes what the manual,
 * idle-sweep, and Plain-ticket archive paths all need; `setArchived` still handles the
 * lone plain-id case for callers that don't have the full list.
 */
export async function unpinArchivedSessions(
  justArchived: UnifiedSession[],
  allSessions: UnifiedSession[],
): Promise<void> {
  if (!justArchived.length) return;
  const dead = (s: UnifiedSession) => s.archived || isArchivedId(s.id);
  const keys: string[] = [];
  const workspaceIds = new Set<string>();
  for (const s of justArchived) {
    keys.push(s.id, ...(s.aliasIds || []));
    if (s.workspaceId) workspaceIds.add(s.workspaceId);
  }
  // A workspace pin is stale only once none of its sessions are live anymore —
  // else archiving one session would yank a still-active workspace off Pinned.
  for (const pid of workspaceIds) {
    if (!allSessions.some((s) => s.workspaceId === pid && !dead(s)))
      keys.push(`workspace:${pid}`);
  }
  await unpinEverywhere(keys);
}

export function getArchiveReason(id: string): ArchiveReason | null {
  const raw = registry.get(id);
  return raw ? toEntry(raw).reason : null;
}

export async function setArchived(
  id: string,
  archived: boolean,
  reason: ArchiveReason = "manual",
): Promise<void> {
  await registry.set(id, archived ? { at: new Date().toISOString(), reason } : undefined);
  await setIndexedSessionArchived(id, archived, archived ? reason : undefined);
  // Archived work shouldn't stay pinned (for anyone) — it would resurface in
  // the Pinned band on unarchive. Callers that know more keys (alias ids, the
  // workspace pin) drop those on top of this.
  if (archived) {
    await unpinEverywhere([id]);
  }
}

/** Archive everything idle for more than `days` days. Returns count. */
export async function archiveOlderThan(sessions: UnifiedSession[], days: number): Promise<number> {
  const cutoff = Date.now() - days * 86_400_000;
  let archived = 0;
  const now = new Date().toISOString();

  const justArchived: UnifiedSession[] = [];
  for (const s of sessions) {
    if (s.archived || s.isRunning) continue;
    if (registry.has(s.id)) continue;
    if (new Date(s.lastActivity).getTime() >= cutoff) continue;
    await registry.set(s.id, { at: now, reason: "idle" });
    justArchived.push(s);
    archived++;
  }

  if (archived > 0) {
    for (const session of justArchived)
      await setIndexedSessionArchived(session.id, true, "idle");
    // Registry is written, so isArchivedId now reflects this batch — drop the
    // stale session/alias pins and any workspace pin whose last session just went.
    await unpinArchivedSessions(justArchived, sessions);
  }
  return archived;
}
