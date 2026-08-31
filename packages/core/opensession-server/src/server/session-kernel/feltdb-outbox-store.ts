import { createHash } from "node:crypto";
import {
  FeltDbSessionDecisionStore,
  kernelRecordId,
  type SessionKernelOutboxRecord,
  type VersionedSessionKernelOutboxRecord,
} from "./feltdb-decision-store";
import type { DurableOutboxItem } from "./store";

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

  async due(now = Date.now(), limit = 100): Promise<DurableOutboxItem[]> {
    const records = await this.decisions.dueOutbox(now, Math.min(500, limit * 4));
    const heads = await Promise.all(records.map((record) => this.decisions.head(record.sessionId)));
    return records.flatMap((record, index) => {
      if (heads[index]?.decisionEpoch !== record.decisionEpoch) return [];
      return [{
        id: 0,
        recordId: record.recordId,
        effectId: record.effectId,
        effectKey: record.effectKey,
        sessionId: record.sessionId,
        kind: record.kind,
        payload: record.payload,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
        ...(record.deadLetteredAt === undefined ? {} : { deadLetteredAt: record.deadLetteredAt }),
        createdAt: record.createdAt,
      }];
    }).slice(0, limit);
  }

  async enqueue(
    commandId: string,
    sessionId: string,
    kind: string,
    payload: unknown,
    effectKey: string,
    now = Date.now(),
  ): Promise<string> {
    const head = await this.decisions.head(sessionId);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    const effectId = `${sessionId}:${kind}:${effectKey}`;
    const recordId = kernelRecordId("effect", `${sessionId}:${head.decisionEpoch}:${effectId}`);
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:outbox:enqueue:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "outbox_enqueue",
      inputHash: digest({ sessionId, kind, payload, effectKey }),
      observedHead: head,
      changeKind: "outbox_enqueued",
      changePayload: { kind, effectKey },
      effects: [{ kind, payload, effectKey }],
      result: recordId,
      now,
    });
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
