/** Persisted long-running sandbox setup operations. */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { stateDir } from "../paths";
import { managedFeltDb } from "../managed-feltdb";
import { broadcastToAll } from "../ws-hub";

const liveOperations: Set<string> = ((globalThis as any).__sandboxLiveOperations ??= new Set());
const COLLECTION = "opensession_sandbox_operations";
const MIGRATION = "sandbox-operations-json-to-managed-feltdb-v1";
let operationsDb: StateFirstDB | undefined;
let operations: SandboxOperation[] = [];
let writeQueue: Promise<void> = Promise.resolve();

export type SandboxOperationStatus = "running" | "succeeded" | "failed";

export interface SandboxOperation {
  id: string;
  kind: "qualification" | "repair" | "environment_rebuild";
  provider: string;
  repo?: string;
  status: SandboxOperationStatus;
  stage: string;
  detail?: string;
  progress?: number;
  createdAt: string;
  updatedAt: string;
  failureCode?: string;
  failureSummary?: string;
}

function storePath(): string {
  return process.env.OPENSESSION_SANDBOX_OPERATIONS_STORE || stateDir("sandbox-operations.json");
}

function readOperations(): SandboxOperation[] {
  return structuredClone(operations);
}

function persist(operation: SandboxOperation): Promise<void> {
  const all = readOperations().filter((candidate) => candidate.id !== operation.id);
  all.push(operation);
  all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const retained = all.slice(0, 100);
  const removed = all.slice(100);
  operations = retained;
  const db = operationsDb ?? managedFeltDb();
  const record = structuredClone(operation);
  const work = async () => {
    await db.transaction((tx) => {
      const collection = tx.collection<SandboxOperation>(COLLECTION);
      collection.set(record.id, record);
      for (const expired of removed) collection.delete(expired.id);
    }, { transactionId: `opensession:sandbox-operation:put:${record.id}:${crypto.randomUUID()}` });
    broadcastToAll({ type: "sandbox_operation", operation: record });
  };
  writeQueue = writeQueue.then(work, work);
  return writeQueue;
}

export async function initializeManagedSandboxOperations(db: StateFirstDB = operationsDb ?? managedFeltDb()): Promise<void> {
  operationsDb = db;
  if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
    let legacy: SandboxOperation[] = [];
    try {
      if (existsSync(storePath())) {
        const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
        if (Array.isArray(parsed?.operations)) legacy = parsed.operations;
      }
    } catch {}
    for (const operation of legacy) await db.transaction((tx) => {
      tx.collection<SandboxOperation>(COLLECTION).set(operation.id, operation);
    }, { transactionId: `opensession:sandbox-operation:migrate:${operation.id}` });
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(MIGRATION,
        { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
  }
  if (existsSync(storePath())) unlinkSync(storePath());
  operations = (await db.collection<SandboxOperation>(COLLECTION).all())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100);
}

export function listSandboxOperations(): SandboxOperation[] {
  return readOperations().map((operation) =>
    operation.status === "running" && !liveOperations.has(operation.id)
      ? {
          ...operation,
          status: "failed" as const,
          stage: "Interrupted",
          failureCode: "SERVER_RESTARTED",
          failureSummary: "The server restarted during this operation. Test again.",
        }
      : operation,
  );
}

export async function startSandboxOperation(
  input: Pick<SandboxOperation, "kind" | "provider" | "repo">,
  run: (
    update: (
      patch: Pick<SandboxOperation, "stage"> &
        Partial<Pick<SandboxOperation, "detail" | "progress">>,
    ) => void,
  ) => Promise<void>,
): Promise<SandboxOperation> {
  const now = new Date().toISOString();
  const operation: SandboxOperation = {
    id: `sandbox-operation-${crypto.randomUUID()}`,
    kind: input.kind,
    provider: input.provider,
    ...(input.repo ? { repo: input.repo } : {}),
    status: "running",
    stage: input.kind === "qualification" ? "Checking connection" : "Queued",
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  await persist(operation);
  liveOperations.add(operation.id);
  const update = (
    patch: Pick<SandboxOperation, "stage"> &
      Partial<Pick<SandboxOperation, "detail" | "progress">>,
  ) => {
    if (operation.status !== "running") return;
    const progress = patch.progress == null ? operation.progress : Math.max(0, Math.min(100, patch.progress));
    if (operation.stage === patch.stage && operation.detail === patch.detail && operation.progress === progress) return;
    operation.stage = patch.stage;
    operation.detail = patch.detail;
    operation.progress = progress;
    operation.updatedAt = new Date().toISOString();
    void persist(operation);
  };
  void run(update).then(
    async () => {
      liveOperations.delete(operation.id);
      operation.status = "succeeded";
      operation.stage = "Complete";
      operation.detail = undefined;
      operation.progress = 100;
      operation.updatedAt = new Date().toISOString();
      await persist(operation);
    },
    async (error) => {
      liveOperations.delete(operation.id);
      operation.status = "failed";
      operation.stage = "Needs attention";
      operation.detail = undefined;
      operation.updatedAt = new Date().toISOString();
      operation.failureCode =
        typeof error?.code === "string" ? error.code : "OPERATION_FAILED";
      operation.failureSummary =
        error instanceof Error ? error.message : "Sandbox operation failed";
      await persist(operation);
    },
  );
  return operation;
}
