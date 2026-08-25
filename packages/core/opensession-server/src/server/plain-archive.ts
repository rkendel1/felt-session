/**
 * Auto-archive opensession sessions when their Plain ticket reaches DONE.
 * Two paths: the Plain webhook (status transition events) and a periodic
 * sweep as a safety net in case the webhook subscription misses them.
 */
import { executeSessionProjection } from "./session-projection-executor";
import { readdirSync, readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { plainApiUrl } from "./config";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";
import { invalidateSessionsCache } from "./session-cache";
import type { NativeSessionFile } from "./types";

const HOME = homeDir();
const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

function activePlainSessions(): Array<{ path: string; data: NativeSessionFile }> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: Array<{ path: string; data: NativeSessionFile }> = [];
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const path = `${SESSIONS_DIR}/${file}`;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as NativeSessionFile;
      if (data.plainThreadId && !data.archived) out.push({ path, data });
    } catch {}
  }
  return out;
}

/**
 * Clear the file-level `archived` flag on a opensession session (set by the Plain
 * done-ticket path above). Manual unarchive only clears the archive registry, so
 * without this a Plain-archived session would stay archived and never return to
 * "My sessions". No-op for non-opensession sessions (no session file). Returns true
 * if a flag was cleared.
 */
export function clearSessionFileArchive(id: string): boolean {
  const path = `${SESSIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  try {
    return executeSessionProjection(id, "plain_archive_clear", () => {
      const data = JSON.parse(readFileSync(path, "utf-8")) as NativeSessionFile;
      if (!data.archived && !data.archivedAt) return false;
      const { archived, archivedAt, archivedReason, ...rest } = data;
      writeJsonAtomic(path, rest);
      return true;
    });
  } catch {
    return false;
  }
}

/** Mark every session tied to this thread as archived. Returns count. */
export function archiveSessionsForThread(threadId: string): number {
  let archived = 0;
  for (const { path, data } of activePlainSessions()) {
    if (data.plainThreadId !== threadId) continue;
    executeSessionProjection(data.id, "plain_archive_set", () =>
      writeJsonAtomic(path, {
        ...data,
        archived: true,
        archivedAt: new Date().toISOString(),
        archivedReason: "plain",
      }),
    );
    archived++;
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
      if (status === "DONE") archived += archiveSessionsForThread(threadId);
    }
    if (archived > 0) {
      console.log(`[plain-archive] Archived ${archived} session(s) for done tickets`);
      onChange?.();
    }
  };

  sweepInterval = setInterval(() => void sweep(), 15 * 60 * 1000);
  setTimeout(() => void sweep(), 60 * 1000); // first pass shortly after boot
  console.log("[plain-archive] Sweep started (15m interval)");
}
