import { createHash } from "node:crypto";
import {
  FeltDbSessionDecisionStore,
  type SessionKernelOutboxRecord,
  type VersionedSessionKernelOutboxRecord,
} from "./feltdb-decision-store";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function nextFeltDbOutboxFailure(
  record: VersionedSessionKernelOutboxRecord,
  error: string,
  maxAttempts: number,
  now: number,
): {
  next: SessionKernelOutboxRecord;
  result: { updated: true; deadLetteredNow: boolean };
} {
  const attempts = record.attempts + 1;
  const deadLetteredNow = attempts >= maxAttempts;
  const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
  const { __version: _, ...current } = record;
  return {
    next: {
      ...current,
      attempts,
      nextAttemptAt: now + delay,
      lastError: error.slice(0, 2_000),
      ...(deadLetteredNow ? { status: "dead_letter", deadLetteredAt: now } : {}),
    },
    result: { updated: true, deadLetteredNow },
  };
}

/** Stable-ID managed FeltDB outbox lifecycle. */
export class FeltDbOutboxStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  due(now = Date.now(), limit = 100): Promise<SessionKernelOutboxRecord[]> {
    return this.decisions.dueOutbox(now, limit);
  }

  async acknowledge(commandId: string, sessionId: string, recordId: string): Promise<void> {
    const [head, record] = await Promise.all([
      this.decisions.head(sessionId),
      this.decisions.outboxRecord(recordId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!record) return;
    await this.decisions.commitOutboxMutation({
      transactionId: `opensession:kernel:outbox:ack:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "outbox_ack",
      inputHash: digest({ sessionId, recordId }),
      observedHead: head,
      observedRecord: record,
      result: null,
    });
  }

  async defer(
    commandId: string,
    sessionId: string,
    recordId: string,
    delayMs = 250,
    now = Date.now(),
  ): Promise<void> {
    const [head, record] = await Promise.all([
      this.decisions.head(sessionId),
      this.decisions.outboxRecord(recordId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!record || record.status !== "pending") return;
    const delay = Number.isFinite(delayMs) ? Math.max(1, delayMs) : 250;
    const { __version: _, ...current } = record;
    await this.decisions.commitOutboxMutation({
      transactionId: `opensession:kernel:outbox:defer:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "outbox_defer",
      inputHash: digest({ sessionId, recordId, delayMs }),
      observedHead: head,
      observedRecord: record,
      nextRecord: { ...current, nextAttemptAt: now + delay },
      result: null,
    });
  }

  async fail(
    commandId: string,
    sessionId: string,
    recordId: string,
    error: string,
    maxAttempts = 20,
    now = Date.now(),
  ): Promise<{ updated: boolean; deadLetteredNow: boolean }> {
    const [head, record] = await Promise.all([
      this.decisions.head(sessionId),
      this.decisions.outboxRecord(recordId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!record) return { updated: false, deadLetteredNow: false };
    const { next, result } = nextFeltDbOutboxFailure(record, error, maxAttempts, now);
    return this.decisions.commitOutboxMutation({
      transactionId: `opensession:kernel:outbox:fail:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "outbox_fail",
      inputHash: digest({ sessionId, recordId, error, maxAttempts }),
      observedHead: head,
      observedRecord: record,
      nextRecord: next,
      result,
    });
  }
}
