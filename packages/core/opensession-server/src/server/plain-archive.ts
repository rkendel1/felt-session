/**
 * Auto-archive opensession sessions when their Plain ticket reaches DONE.
 * Two paths: the Plain webhook (status transition events) and a periodic
 * sweep as a safety net in case the webhook subscription misses them.
 */
import { executeSessionProjection } from "./session-projection-executor";
import { plainApiUrl } from "./config";
import { homeDir } from "./paths";
import { invalidateSessionsCache } from "./session-cache";
import {
  nativeSessionMetadata,
  nativeSessionMetadataEntries,
  updateNativeSessionMetadata,
} from "./managed-native-sessions";
import type { NativeSessionFile } from "./types";

const HOME = homeDir();
type PlainSessionCandidate = { data: NativeSessionFile };
type SessionProjector = typeof executeSessionProjection;

function activePlainSessions(): PlainSessionCandidate[] {
  return nativeSessionMetadataEntries()
    .map(([, data]) => ({ data }))
    .filter(({ data }) => !!data.plainThreadId && !data.archived);
}

/**
 * Clear the file-level `archived` flag on a opensession session (set by the Plain
 * done-ticket path above). Manual unarchive only clears the archive registry, so
 * without this a Plain-archived session would stay archived and never return to
 * "My sessions". No-op for non-opensession sessions (no session file). Returns true
 * if a flag was cleared.
 */
export async function clearSessionFileArchive(id: string): Promise<boolean> {
  const current = nativeSessionMetadata(id);
  if (!current) return false;
  try {
    if (!current.archived && !current.archivedAt) return false;
    await executeSessionProjection(id, "plain_archive_clear", () =>
      updateNativeSessionMetadata(id, (data) => {
        const { archived: _, archivedAt: __, archivedReason: ___, ...rest } = data;
        return rest;
      }));
    return true;
  } catch {
    return false;
  }
}

/** Mark every session tied to this thread as archived. Returns count. */
export async function archiveSessionsForThread(threadId: string): Promise<number> {
  return archivePlainSessionCandidates(
    threadId,
    activePlainSessions(),
    executeSessionProjection,
  );
}

/** Archive matching files independently so one quarantined session cannot
 * abort the Plain sweep before the remaining sessions are processed. */
export async function archivePlainSessionCandidates(
  threadId: string,
  sessions: PlainSessionCandidate[],
  project: SessionProjector = executeSessionProjection,
  reportFailure: (sessionId: string, error: unknown) => void = (sessionId, error) =>
    console.warn(`[plain-archive] Could not archive session ${sessionId}:`, error),
  persist: (id: string, mutate: (data: NativeSessionFile) => NativeSessionFile) => Promise<unknown>
    = updateNativeSessionMetadata,
): Promise<number> {
  let archived = 0;
  for (const { data } of sessions) {
    if (data.plainThreadId !== threadId) continue;
    try {
      await project(data.id, "plain_archive_set", () =>
        persist(data.id, (current) => ({
          ...current,
          archived: true,
          archivedAt: new Date().toISOString(),
          archivedReason: "plain",
        })),
      );
      archived++;
    } catch (error) {
      reportFailure(data.id, error);
    }
  }
  if (archived > 0) invalidateSessionsCache();
  return archived;
}

async function fetchThreadStatus(threadId: string): Promise<string | null> {
  const key = process.env.PLAIN_API_KEY;
  if (!key) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(plainApiUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($id: ID!) { thread(threadId: $id) { status } }`,
        variables: { id: threadId },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    return json?.data?.thread?.status || null;
  } catch {
    return null;
  }
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startPlainArchiveSweep(onChange?: () => void): void {
  if (sweepInterval) return;

  const sweep = async () => {
    const sessions = activePlainSessions();
    const threadIds = [...new Set(sessions.map((s) => s.data.plainThreadId!))].slice(0, 40);
    let archived = 0;
    for (const threadId of threadIds) {
      const status = await fetchThreadStatus(threadId);
      if (status === "DONE") archived += await archiveSessionsForThread(threadId);
    }
    if (archived > 0) {
      console.log(`[plain-archive] Archived ${archived} session(s) for done tickets`);
      onChange?.();
    }
  };

  const runSweep = () => {
    void sweep().catch((error) =>
      console.error("[plain-archive] Sweep failed:", error),
    );
  };

  sweepInterval = setInterval(runSweep, 15 * 60 * 1000);
  setTimeout(runSweep, 60 * 1000); // first pass shortly after boot
  console.log("[plain-archive] Sweep started (15m interval)");
}
