import { createHash } from "node:crypto";
import type { AtomicTransactionOperationRequest } from "@feltdb/core";
import type { DurableCommandRecord } from "./store";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type DecisionEffect,
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";

type StoredCommand = DurableCommandRecord & {
  schemaVersion: 1;
  __version: number;
};

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandId(sessionId: string, requestId: string): string {
  return kernelRecordId("commands", `${sessionId}:${requestId}`);
}

function withoutStorage(record: StoredCommand): DurableCommandRecord {
  const { __version: _, schemaVersion: __, ...value } = record;
  return value;
}

export function feltDbCommandResultRecord(value: unknown): {
  result: unknown;
  resultHash: string;
  terminalFailure: boolean;
} {
  const text = json(value);
  return {
    result: value ?? null,
    resultHash: sha256(text),
    terminalFailure: !!value && typeof value === "object" &&
      (value as Record<string, unknown>).__sessionKernelFailure === true,
  };
}

/** Managed FeltDB command admission and durable settlement receipts. */
export class FeltDbCommandStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  private stored(sessionId: string, requestId: string): Promise<StoredCommand | undefined> {
    return this.decisions.record(KERNEL_COLLECTIONS.commands, commandId(sessionId, requestId));
  }

  async command(sessionId: string, requestId: string): Promise<DurableCommandRecord | undefined> {
    const record = await this.stored(sessionId, requestId);
    if (!record) return undefined;
    const { schemaVersion: _, __version: __, ...value } = record;
    return value;
  }

  private async commit<Result>(input: {
    logicalId: string;
    operationKind: string;
    inputHash: string;
    head: VersionedSessionDecisionHead;
    prior?: StoredCommand;
    next: DurableCommandRecord;
    changeKind: string;
    effects?: DecisionEffect[];
    result: Result;
    now: number;
  }): Promise<Result> {
    const operation: AtomicTransactionOperationRequest = {
      collection: KERNEL_COLLECTIONS.commands,
      id: commandId(input.next.sessionId, input.next.requestId),
      value: { schemaVersion: 1, ...input.next },
      ...(input.prior ? { ifVersion: input.prior.__version } : { requireAbsent: true }),
    };
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:command:${input.next.sessionId}:${input.operationKind}:${input.logicalId}`,
      operationId: input.logicalId,
      operationKind: input.operationKind,
      inputHash: input.inputHash,
      observedHead: input.head,
      changeKind: input.changeKind,
      changePayload: { requestId: input.next.requestId },
      domainOperations: [operation],
      effects: input.effects,
      result: input.result,
      now: input.now,
    });
  }

  async accept(
    logicalId: string,
    input: {
      sessionId: string;
      requestId: string;
      type: string;
      payload?: unknown;
      replaySafe?: boolean;
    },
    now = Date.now(),
  ): Promise<DurableCommandRecord> {
    const [head, prior] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.stored(input.sessionId, input.requestId),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const payload = input.payload ?? null;
    const payloadHash = sha256(json(payload));
    if (prior) {
      if (prior.type !== input.type || prior.payloadHash !== payloadHash)
        throw new Error(`Session command id ${input.requestId} was reused with another payload`);
      if (!input.replaySafe || prior.replaySafe || prior.status === "indeterminate") {
        const { schemaVersion: _, __version: __, ...existing } = prior;
        return existing;
      }
      const next = { ...withoutStorage(prior), replaySafe: true, updatedAt: now };
      return this.commit({
        logicalId,
        operationKind: "command_admit_upgrade",
        inputHash: sha256(json(input)),
        head,
        prior,
        next,
        changeKind: `command:${input.type}`,
        result: next,
        now,
      });
    }
    const next: DurableCommandRecord = {
      sessionId: input.sessionId,
      requestId: input.requestId,
      type: input.type,
      payload,
      payloadHash,
      status: "pending",
      replaySafe: input.replaySafe === true,
      terminalFailure: false,
      createdAt: now,
      updatedAt: now,
    };
    return this.commit({
      logicalId,
      operationKind: "command_admit",
      inputHash: sha256(json(input)),
      head,
      next,
      changeKind: `command:${input.type}`,
      result: next,
      now,
    });
  }

  async markProcessing(
    logicalId: string,
    sessionId: string,
    requestId: string,
    now = Date.now(),
  ): Promise<void> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.stored(sessionId, requestId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!prior) return;
    const next: DurableCommandRecord = {
      ...withoutStorage(prior),
      status: "processing",
      payload: ["cancel_session", "websocket_command"].includes(prior.type)
        ? prior.payload
        : null,
      error: undefined,
      retryable: undefined,
      updatedAt: now,
    };
    await this.commit({
      logicalId,
      operationKind: "command_processing",
      inputHash: sha256(json({ sessionId, requestId })),
      head,
      prior,
      next,
      changeKind: `command:${prior.type}`,
      result: null,
      now,
    });
  }

  async complete(
    logicalId: string,
    sessionId: string,
    requestId: string,
    result: unknown,
    effects: DecisionEffect[] = [],
    now = Date.now(),
  ): Promise<void> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.stored(sessionId, requestId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!prior) throw new Error("Session command receipt is missing");
    const settled = feltDbCommandResultRecord(result);
    const next: DurableCommandRecord = {
      ...withoutStorage(prior),
      status: "completed",
      payload: ["cancel_session", "websocket_command"].includes(prior.type)
        ? prior.payload
        : null,
      ...settled,
      error: undefined,
      retryable: undefined,
      updatedAt: now,
    };
    await this.commit({
      logicalId,
      operationKind: "command_complete",
      inputHash: sha256(json({ sessionId, requestId, result, effects })),
      head,
      prior,
      next,
      changeKind: `command:${prior.type}`,
      effects,
      result: null,
      now,
    });
  }

  async fail(
    logicalId: string,
    sessionId: string,
    requestId: string,
    error: string,
    retryable = false,
    now = Date.now(),
  ): Promise<void> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.stored(sessionId, requestId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!prior) return;
    const next: DurableCommandRecord = {
      ...withoutStorage(prior),
      status: "failed",
      payload: ["cancel_session", "websocket_command"].includes(prior.type)
        ? prior.payload
        : null,
      error: error.slice(0, 2_000),
      retryable,
      updatedAt: now,
    };
    await this.commit({
      logicalId,
      operationKind: "command_fail",
      inputHash: sha256(json({ sessionId, requestId, error, retryable })),
      head,
      prior,
      next,
      changeKind: `command:${prior.type}`,
      result: null,
      now,
    });
  }

  async acknowledge(
    logicalId: string,
    sessionId: string,
    requestId: string,
    now = Date.now(),
  ): Promise<boolean> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.stored(sessionId, requestId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!prior || prior.status !== "completed") return false;
    if (prior.acknowledgedAt !== undefined) return true;
    const next = { ...withoutStorage(prior), acknowledgedAt: now, updatedAt: now };
    return this.commit({
      logicalId,
      operationKind: "command_acknowledge",
      inputHash: sha256(json({ sessionId, requestId })),
      head,
      prior,
      next,
      changeKind: `command:${prior.type}`,
      result: true,
      now,
    });
  }
}
