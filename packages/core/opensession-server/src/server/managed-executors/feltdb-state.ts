/**
 * FeltDB-backed Executor State Store.
 *
 * Durably tracks the lifecycle and state of managed executors,
 * enabling recovery after process restart.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ExecutorStateConflictError,
  type ExecutorAuditEntry,
  type ExecutorRecord,
  type ExecutorStateStore,
} from "./state";

interface StoredExecutorRow {
  id: string;
  executorId: string;
  sessionId: string;
  provider: string;
  resourceId: string;
  workspaceId: string;
  resourceGeneration: number;
  instanceGeneration: number;
  lifecycle: string;
  projectRevision: string;
  projectBaseCommit: string;
  projectDurableDelta: string;
  createdAtMs: number;
  updatedAtMs: number;
  error: string | null;
}

interface StoredAuditRow {
  id: string;
  executorId: string;
  generation: number;
  action: string;
  operatorId: string;
  reason: string;
  atMs: number;
}

interface StoredClaimRow {
  id: string;
  executorId: string;
  generation: number;
  instanceId: string;
}

const EXECUTOR_COLLECTION = "executor_state";
const AUDIT_COLLECTION = "executor_audit";
const CLAIMS_COLLECTION = "executor_instance_claims";

/**
 * FeltDB-backed executor state store.
 * Durably tracks the lifecycle and state of managed executors.
 */
export class FeltDbExecutorStateStore implements ExecutorStateStore {
  readonly #db: ReturnType<typeof createFeltDB>;
  #closed = false;
  #sessionIndex = new Map<string, string>();

  constructor(path: string) {
    if (!path || path === ":memory:")
      throw new Error(
        "a filesystem FeltDB path is required for Executor State Store",
      );

    // Ensure directory exists
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    const telemetry = getTelemetryClient();
    telemetry.disable();

    this.#db = createFeltDB({
      path,
      namespace: "executor-state",
    });
  }

  async getByExecutorId(
    executorId: string,
  ): Promise<ExecutorRecord | undefined> {
    if (this.#closed) throw new Error("State store is closed");

    const record = await this.#db
      .collection<StoredExecutorRow>(EXECUTOR_COLLECTION)
      .get(executorId);

    if (!record) return undefined;

    return this.#rowToRecord(record);
  }

  async getBySessionId(sessionId: string): Promise<ExecutorRecord | undefined> {
    if (this.#closed) throw new Error("State store is closed");

    const executorId = this.#sessionIndex.get(sessionId);
    if (!executorId) return undefined;

    return this.getByExecutorId(executorId);
  }

  async insertIntent(record: ExecutorRecord): Promise<void> {
    if (this.#closed) throw new Error("State store is closed");

    // Read outside of transaction
    const existing = await this.#db
      .collection<StoredExecutorRow>(EXECUTOR_COLLECTION)
      .get(record.executorId);
    const sessionExisting = this.#sessionIndex.get(record.sessionId);

    if (existing) {
      throw new ExecutorStateConflictError(
        `Executor ${record.executorId} already exists`,
      );
    }

    if (sessionExisting) {
      throw new ExecutorStateConflictError(
        `session ${record.sessionId} already has a managedExecutor`,
      );
    }

    const row = this.#recordToRow(record);
    await this.#db.transaction((tx) => {
      tx.collection<StoredExecutorRow>(EXECUTOR_COLLECTION).set(
        record.executorId,
        row,
      );
    });
    this.#sessionIndex.set(record.sessionId, record.executorId);
  }

  async compareAndSwap(
    executorId: string,
    expectedGeneration: number,
    next: ExecutorRecord,
  ): Promise<void> {
    if (this.#closed) throw new Error("State store is closed");

    // Read outside of transaction
    const current = await this.#db
      .collection<StoredExecutorRow>(EXECUTOR_COLLECTION)
      .get(executorId);

    if (!current) {
      throw new ExecutorStateConflictError(
        `Executor ${executorId} not found`,
      );
    }

    if (current.instanceGeneration !== expectedGeneration) {
      throw new ExecutorStateConflictError(
        `Expected generation ${expectedGeneration}, got ${current.instanceGeneration}`,
      );
    }

    const row = this.#recordToRow(next);
    await this.#db.transaction((tx) => {
      tx.collection<StoredExecutorRow>(EXECUTOR_COLLECTION).set(
        executorId,
        row,
      );
    });
  }

  async delete(
    executorId: string,
    expectedGeneration: number,
  ): Promise<void> {
    if (this.#closed) throw new Error("State store is closed");

    // Read outside of transaction
    const record = await this.#db
      .collection<StoredExecutorRow>(EXECUTOR_COLLECTION)
      .get(executorId);

    if (!record) {
      throw new ExecutorStateConflictError(
        `Executor ${executorId} not found`,
      );
    }

    if (record.instanceGeneration !== expectedGeneration) {
      throw new ExecutorStateConflictError(
        `Expected generation ${expectedGeneration}, got ${record.instanceGeneration}`,
      );
    }

    await this.#db.transaction((tx) => {
      tx.collection<StoredExecutorRow>(EXECUTOR_COLLECTION).delete(executorId);
    });
    this.#sessionIndex.delete(record.sessionId);
  }

  async appendAudit(entry: ExecutorAuditEntry): Promise<void> {
    if (this.#closed) throw new Error("State store is closed");

    const key = `${entry.executorId}_${Date.now()}_${Math.random()}`;
    await this.#db.transaction((tx) => {
      const row: StoredAuditRow = {
        id: key,
        executorId: entry.executorId,
        generation: entry.generation,
        action: entry.action,
        operatorId: entry.operatorId,
        reason: entry.reason,
        atMs: entry.atMs,
      };
      tx.collection<StoredAuditRow>(AUDIT_COLLECTION).set(key, row);
    });
  }

  /**
   * Atomically proves lifecycle connectability and claims one same-generation instance.
   */
  async claimConnectableInstance(input: {
    executorId: string;
    generation: number;
    instanceId: string;
  }): Promise<boolean> {
    if (this.#closed) throw new Error("State store is closed");

    const executorId = input.executorId;
    const claimKey = `${executorId}_${input.generation}`;

    // Read outside of transaction
    const record = await this.#db
      .collection<StoredExecutorRow>(EXECUTOR_COLLECTION)
      .get(executorId);
    const existing = await this.#db
      .collection<StoredClaimRow>(CLAIMS_COLLECTION)
      .get(claimKey);

    if (
      !record ||
      record.instanceGeneration !== input.generation ||
      record.lifecycle !== "awake"
    ) {
      return false;
    }

    if (existing) {
      return existing.instanceId === input.instanceId;
    }

    await this.#db.transaction((tx) => {
      tx.collection<StoredClaimRow>(CLAIMS_COLLECTION).set(claimKey, {
        id: claimKey,
        executorId,
        generation: input.generation,
        instanceId: input.instanceId,
      });
    });

    return true;
  }

  #recordToRow(record: ExecutorRecord): StoredExecutorRow {
    return {
      id: record.executorId,
      executorId: record.executorId,
      sessionId: record.sessionId,
      provider: record.provider,
      resourceId: record.resourceId ?? "",
      workspaceId: record.workspaceId ?? "",
      resourceGeneration: record.resourceGeneration ?? 0,
      instanceGeneration: record.instanceGeneration,
      lifecycle: record.lifecycle,
      projectRevision: record.project.revision,
      projectBaseCommit: record.project.baseCommit,
      projectDurableDelta: record.project.durableDelta,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      error: record.error ?? null,
    };
  }

  #rowToRecord(row: StoredExecutorRow): ExecutorRecord {
    return {
      executorId: row.executorId,
      sessionId: row.sessionId,
      provider: row.provider as any,
      resourceId: row.resourceId || undefined,
      workspaceId: row.workspaceId || undefined,
      resourceGeneration: row.resourceGeneration || undefined,
      instanceGeneration: row.instanceGeneration,
      lifecycle: row.lifecycle as any,
      project: {
        revision: row.projectRevision,
        baseCommit: row.projectBaseCommit,
        durableDelta: row.projectDurableDelta,
      },
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
      error: row.error ?? undefined,
    };
  }

  close(): void | Promise<void> {
    this.#closed = true;
    try {
      return this.#db.close?.();
    } catch (error) {
      // Silently ignore close errors - they may occur if the DB is in an inconsistent state
      console.error("Error closing FeltDB state store:", error);
    }
  }
}
