/**
 * Message queue system for the Slack agent.
 *
 * Each Slack session (channel+thread) gets its own FIFO queue.
 * Messages are committed to managed FeltDB before processing so they survive
 * restarts without a local durability authority.
 */

import { processMessage } from "./handlers";
import {
  sendSlackMessage,
  removeReaction,
  MESSAGES,
} from "./slack-api";
import { createHash } from "node:crypto";
import { managedFeltDb } from "../../server/managed-feltdb";
import type { SlackFileRef } from "./slack-api";

const QUEUE_COLLECTION = "opensession_slack_message_queue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  prompt: string;
  /** User-facing Slack text for the progress card, before prompt enrichment. */
  cardTitle?: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  userName: string;
  userId: string;
  isNewSession: boolean;
  worktreeDir?: string;
  branch?: string;
  /** Registered repo id the session works in; unset = the default repo. */
  repoId?: string;
  /**
   * File attachments on the Slack message (small refs, not bytes — the queue
   * persists to disk). processMessage downloads the images among them right
   * before the run and attaches them to the prompt as native image parts.
   */
  files?: SlackFileRef[];
  /** Stable transcript identity for this Slack message across provider retries. */
  promptEntryId?: string;
  /** Set when shutdown leaves this queue head for boot to continue. */
  restartRecovery?: boolean;
}

export interface SessionQueue {
  queue: QueuedMessage[];
  processing: boolean;
  abortController: AbortController | null;
  /** The server is restarting, so leave the current message queued for the
   * next process instead of treating its abort like a person's Stop action. */
  restartInterrupted?: boolean;
}

type DurableQueuedMessage = {
  id: string;
  sessionKey: string;
  message: QueuedMessage;
  status: "pending" | "completed";
  enqueuedAt: number;
  updatedAt: number;
  __version?: number;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const sessionQueues = new Map<string, SessionQueue>();
const durableVersions = new Map<string, number>();

function durableId(sessionKey: string, messageTs: string): string {
  return `slack_queue_${createHash("sha256")
    .update(`${sessionKey}\0${messageTs}`)
    .digest("hex")}`;
}

function queueCollection() {
  return managedFeltDb().collection<DurableQueuedMessage>(QUEUE_COLLECTION);
}

/** Deliberately distinct from an ordinary AbortError: handlers use this to
 * render a restart state rather than the misleading "Cancelled by user". */
export const RESTART_ABORT_REASON = "opensession-server-restart";

export function isRestartAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === RESTART_ABORT_REASON;
}

/** Stop driving live Slack turns during process shutdown while retaining the
 * head message in each queue. Startup reloads and continues those messages. */
export async function interruptQueuesForRestart(): Promise<number> {
  let interrupted = 0;
  const writes: Promise<void>[] = [];
  for (const [sessionKey, sq] of sessionQueues) {
    if (!sq.abortController || sq.abortController.signal.aborted) continue;
    sq.restartInterrupted = true;
    // Boot must continue the interrupted turn, not submit the person's Slack
    // message as a new turn. This marker survives with the durable queue item.
    if (sq.queue[0]) sq.queue[0].restartRecovery = true;
    sq.abortController.abort(RESTART_ABORT_REASON);
    writes.push(persistQueue(sessionKey, sq));
    interrupted++;
  }
  await Promise.all(writes);
  return interrupted;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getOrCreateQueue(sessionKey: string): SessionQueue {
  let sq = sessionQueues.get(sessionKey);
  if (!sq) {
    sq = { queue: [], processing: false, abortController: null };
    sessionQueues.set(sessionKey, sq);
  }
  return sq;
}

// ---------------------------------------------------------------------------
// Managed persistence
// ---------------------------------------------------------------------------

async function insertDurable(sessionKey: string, message: QueuedMessage): Promise<boolean> {
  const id = durableId(sessionKey, message.messageTs);
  const now = Date.now();
  const record: DurableQueuedMessage = {
    id,
    sessionKey,
    message,
    status: "pending",
    enqueuedAt: now,
    updatedAt: now,
  };
  try {
    await managedFeltDb().transaction((tx) => {
      tx.collection<DurableQueuedMessage>(QUEUE_COLLECTION).set(id, record, {
        requireAbsent: true,
      });
    }, { transactionId: `opensession:slack-queue:enqueue:${id}` });
  } catch (error) {
    if (!await queueCollection().get(id)) throw error;
  }
  const stored = await queueCollection().get(id);
  if (!stored || !Number.isSafeInteger(stored.__version))
    throw new Error(`Slack queue record ${id} has no FeltDB authority version`);
  durableVersions.set(id, stored.__version!);
  return stored.status === "pending";
}

async function persistQueue(sessionKey: string, sq: SessionQueue): Promise<void> {
  for (const message of sq.queue) {
    const id = durableId(sessionKey, message.messageTs);
    let version = durableVersions.get(id);
    let stored = version === undefined ? await queueCollection().get(id) : undefined;
    if (version === undefined && !stored) {
      await insertDurable(sessionKey, message);
      continue;
    }
    version ??= stored?.__version;
    if (!Number.isSafeInteger(version))
      throw new Error(`Slack queue record ${id} has no FeltDB authority version`);
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await queueCollection().updateIfVersion(id, version!, {
        message,
        updatedAt: Date.now(),
      });
      if (result.updated) {
        const current = await queueCollection().get(id);
        if (!current || !Number.isSafeInteger(current.__version))
          throw new Error(`Updated Slack queue record ${id} is missing`);
        durableVersions.set(id, current.__version!);
        break;
      }
      stored = await queueCollection().get(id);
      if (!stored || !Number.isSafeInteger(stored.__version))
        throw new Error(`Slack queue record ${id} disappeared during update`);
      version = stored.__version;
      if (attempt === 4) throw new Error(`Slack queue record ${id} remained contended`);
    }
  }
}

async function removeDurable(sessionKey: string, message: QueuedMessage): Promise<void> {
  const id = durableId(sessionKey, message.messageTs);
  const stored = await queueCollection().get(id);
  if (!stored) {
    durableVersions.delete(id);
    return;
  }
  if (!Number.isSafeInteger(stored.__version))
    throw new Error(`Slack queue record ${id} has no FeltDB authority version`);
  const result = await queueCollection().updateIfVersion(id, stored.__version!, {
    status: "completed",
    updatedAt: Date.now(),
  });
  if (!result.updated) throw new Error(`Slack queue record ${id} changed during completion`);
  durableVersions.delete(id);
}

export async function loadQueue(): Promise<void> {
  try {
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await managedFeltDb().query<DurableQueuedMessage>({
        collection: QUEUE_COLLECTION,
        where: [{ field: "status", eq: "pending" }],
        orderBy: [{ field: "enqueuedAt", direction: "asc" }],
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const record of page.records) {
        if (!record.id || !record.sessionKey || !record.message?.messageTs)
          throw new Error("Managed Slack queue contains an invalid record");
        const sq = getOrCreateQueue(record.sessionKey);
        if (!sq.queue.some((message) => message.messageTs === record.message.messageTs)) {
          sq.queue.push(record.message);
          total++;
        }
        if (!Number.isSafeInteger(record.__version))
          throw new Error(`Slack queue record ${record.id} has no authority version`);
        durableVersions.set(record.id, record.__version!);
      }
      cursor = page.exhausted ? undefined : page.nextCursor;
      if (!page.exhausted && !cursor) throw new Error("FeltDB Slack queue cursor is missing");
    } while (cursor);
    for (const [sessionKey, sq] of sessionQueues) {
      sq.queue.sort((left, right) => left.messageTs.localeCompare(right.messageTs));
      if (!sq.processing && sq.queue.length) {
        sq.processing = true;
        void processQueue(sessionKey).catch((error) => {
          console.error(`[slack] Queue processing error for ${sessionKey}:`, error);
          sq.processing = false;
        });
      }
    }
    if (total > 0) {
      console.log(`[slack] Restored ${total} queued message(s) from managed FeltDB`);
    }
  } catch (e) {
    console.warn("[slack] Failed to load managed message queue:", e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Enqueue / process
// ---------------------------------------------------------------------------

export async function enqueueMessage(sessionKey: string, msg: QueuedMessage): Promise<void> {
  const sq = getOrCreateQueue(sessionKey);

  // Dedup: don't enqueue the same Slack message twice (by messageTs)
  if (sq.queue.some((m) => m.messageTs === msg.messageTs)) {
    console.log(
      `[slack] Skipping duplicate message ${msg.messageTs} for ${sessionKey}`
    );
    return;
  }

  // The same Slack event can cross provider boundaries or a process restart.
  // Keep one transcript uuid so every attempt addresses the original row.
  msg.promptEntryId ??= crypto.randomUUID();
  if (!await insertDurable(sessionKey, msg)) {
    console.log(`[slack] Skipping completed message ${msg.messageTs} for ${sessionKey}`);
    return;
  }
  sq.queue.push(msg);
  sq.queue.sort((left, right) => left.messageTs.localeCompare(right.messageTs));
  console.log(
    `[slack] Enqueued message for ${sessionKey} (queue length: ${sq.queue.length})`
  );

  if (!sq.processing) {
    sq.processing = true;
    processQueue(sessionKey).catch((e) => {
      console.error(`[slack] Queue processing error for ${sessionKey}:`, e);
      sq!.processing = false;
    });
  }
}

export async function processQueue(sessionKey: string): Promise<void> {
  const sq = sessionQueues.get(sessionKey);
  if (!sq) return;

  while (sq.queue.length > 0) {
    // Peek at the message — keep it in the queue until processing completes
    const msg = sq.queue[0]!;
    try {
      await processMessage(sessionKey, msg);
    } catch (e) {
      console.error(`[slack] Error processing message for ${sessionKey}:`, e);
      // Guard the error report itself — if THIS send throws, processQueue
      // aborts and the whole queue stalls until the next inbound message.
      try {
        await sendSlackMessage(msg.channel, `${MESSAGES.error} ${e}`, msg.threadTs);
      } catch (e2) {
        console.error(`[slack] Failed to report processing error for ${sessionKey}:`, e2);
      }
    }
    // A restart aborts the local streamer/runner but deliberately leaves this
    // message at the queue head. Do not let this process start it again while
    // shutdown is in progress; the next boot reloads the persisted queue.
    if (sq.restartInterrupted) {
      sq.processing = false;
      sq.abortController = null;
      await persistQueue(sessionKey, sq);
      console.log(`[slack] Preserved interrupted message for ${sessionKey} across restart`);
      return;
    }
    // Remove the message we just processed BY IDENTITY, not a blind shift().
    // A Stop/cancel clears the queue (sq.queue.length = 0); if a new message
    // arrives while this one is still processing it becomes queue[0], and a
    // blind shift() would silently drop that new message. Matching on messageTs
    // removes only what we actually handled and leaves anything new to run next.
    const doneIdx = sq.queue.findIndex((m) => m.messageTs === msg.messageTs);
    if (doneIdx !== -1) sq.queue.splice(doneIdx, 1);
    await removeDurable(sessionKey, msg);
    // Remove eyes reaction after processing each message
    await removeReaction(msg.channel, msg.messageTs, "eyes").catch(() => {});
  }

  sq.processing = false;
  sq.abortController = null;
}
