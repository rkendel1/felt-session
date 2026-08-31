import { createHash } from "node:crypto";
import type { DurableTimer } from "./store";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type SessionKernelTimerRecord,
} from "./feltdb-decision-store";

type VersionedTimer = SessionKernelTimerRecord & { __version: number };

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function timerRecordId(sessionId: string, timerId: string): string {
  return kernelRecordId("timers", `${sessionId}:${timerId}`);
}

function durable(record: SessionKernelTimerRecord): DurableTimer {
  return {
    sessionId: record.sessionId,
    timerId: record.timerId,
    kind: record.kind,
    dueAt: record.dueAt,
    token: record.token,
    payload: record.payload,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.deadLetteredAt === undefined ? {} : { deadLetteredAt: record.deadLetteredAt }),
    createdAt: record.createdAt,
  };
}

export function nextFeltDbTimerFailure(
  record: SessionKernelTimerRecord,
  error: string,
  maxAttempts: number,
  now: number,
): SessionKernelTimerRecord {
  const attempts = record.attempts + 1;
  const dead = attempts >= maxAttempts;
  const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
  return {
    ...record,
    attempts,
    nextAttemptAt: now + delay,
    lastError: error.slice(0, 2_000),
    ...(dead ? { status: "dead_letter", deadLetteredAt: now } : {}),
  };
}

/** Managed FeltDB timer scheduling, due-work, cancellation, and failure state. */
export class FeltDbTimerStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  private record(sessionId: string, timerId: string): Promise<VersionedTimer | undefined> {
    return this.decisions.record(KERNEL_COLLECTIONS.timers, timerRecordId(sessionId, timerId));
  }

  async timer(sessionId: string, timerId: string): Promise<DurableTimer | undefined> {
    const record = await this.record(sessionId, timerId);
    return record ? durable(record) : undefined;
  }

  async due(now = Date.now(), limit = 100): Promise<DurableTimer[]> {
    return (await this.decisions.dueTimers(now, limit)).map(durable);
  }

  async schedule(
    commandId: string,
    timer: Omit<DurableTimer, "token" | "attempts" | "nextAttemptAt" | "lastError" | "deadLetteredAt" | "createdAt">,
    now = Date.now(),
  ): Promise<void> {
    const [head, prior] = await Promise.all([
      this.decisions.head(timer.sessionId),
      this.record(timer.sessionId, timer.timerId),
    ]);
    if (!head) throw new Error(`Session ${timer.sessionId} has no FeltDB authority`);
    const id = timerRecordId(timer.sessionId, timer.timerId);
    const next: SessionKernelTimerRecord = {
      schemaVersion: 1,
      recordId: id,
      sessionId: timer.sessionId,
      decisionEpoch: head.decisionEpoch,
      timerId: timer.timerId,
      kind: timer.kind,
      dueAt: timer.dueAt,
      token: crypto.randomUUID(),
      payload: timer.payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: timer.dueAt,
      createdAt: now,
    };
    await this.decisions.commitDecision({
      transactionId: `opensession:kernel:timer:schedule:${timer.sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "timer_schedule",
      inputHash: digest(timer),
      observedHead: head,
      changeKind: "timer_scheduled",
      changePayload: { timerId: timer.timerId, kind: timer.kind, dueAt: timer.dueAt },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.timers,
        id,
        value: next,
        ...(prior ? { ifVersion: prior.__version } : { requireAbsent: true }),
      }],
      result: null,
      now,
    });
  }

  async cancel(commandId: string, sessionId: string, timerId: string, now = Date.now()): Promise<void> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.record(sessionId, timerId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!prior) return;
    await this.decisions.commitDecision({
      transactionId: `opensession:kernel:timer:cancel:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "timer_cancel",
      inputHash: digest({ sessionId, timerId }),
      observedHead: head,
      changeKind: "timer_cancelled",
      changePayload: { timerId },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.timers,
        id: prior.recordId,
        ifVersion: prior.__version,
      }],
      result: null,
      now,
    });
  }

  async fail(
    commandId: string,
    sessionId: string,
    timerId: string,
    token: string,
    error: string,
    maxAttempts: number,
    now = Date.now(),
  ): Promise<{ updated: boolean; deadLetteredNow: boolean }> {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
      throw new Error("Invalid timer attempt limit");
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.record(sessionId, timerId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!prior || prior.token !== token) return { updated: false, deadLetteredNow: false };
    const { __version: _, ...current } = prior;
    const next = nextFeltDbTimerFailure(current, error, maxAttempts, now);
    const result = { updated: true, deadLetteredNow: next.status === "dead_letter" };
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:timer:fail:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "timer_fail",
      inputHash: digest({ sessionId, timerId, token, error, maxAttempts }),
      observedHead: head,
      changeKind: "timer_failed",
      changePayload: { timerId, attempts: next.attempts, deadLettered: result.deadLetteredNow },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.timers,
        id: prior.recordId,
        value: next,
        ifVersion: prior.__version,
      }],
      result,
      now,
    });
  }
}
