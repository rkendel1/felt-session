/**
 * Offline, one-session Session Kernel migration into managed FeltDB.
 *
 * The caller must stop and drain the actor and hold its migration placement
 * claim before calling this module. This code deliberately accepts one exact
 * actor database path and never discovers or scans session databases.
 */
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type { AtomicTransactionOperationRequest } from "@feltdb/core";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type SessionDecisionHead,
} from "./feltdb-decision-store";
import { SESSION_KERNEL_SCHEMA_VERSION } from "./store";

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

type TablePlan = {
  table: string;
  collection: string;
  keys: readonly string[];
  orderBy: string;
};

const TABLES: readonly TablePlan[] = [
  { table: "session_kernel_quarantine", collection: KERNEL_COLLECTIONS.quarantine, keys: ["session_id"], orderBy: "session_id" },
  { table: "session_kernel_creation", collection: KERNEL_COLLECTIONS.creation, keys: ["session_id"], orderBy: "session_id" },
  { table: "session_kernel_asks", collection: KERNEL_COLLECTIONS.asks, keys: ["session_id"], orderBy: "session_id" },
  { table: "session_kernel_delivery", collection: KERNEL_COLLECTIONS.delivery, keys: ["session_id"], orderBy: "session_id" },
  { table: "session_kernel_turn", collection: KERNEL_COLLECTIONS.turns, keys: ["session_id"], orderBy: "session_id" },
  { table: "session_kernel_turn_projections", collection: KERNEL_COLLECTIONS.turnProjections, keys: ["session_id", "projection_id"], orderBy: "projection_id" },
  { table: "session_kernel_agent_host_plan", collection: KERNEL_COLLECTIONS.agentHostPlans, keys: ["session_id"], orderBy: "session_id" },
  { table: "session_kernel_agent_host_supervision", collection: KERNEL_COLLECTIONS.agentHostSupervision, keys: ["session_id", "supervisor_epoch"], orderBy: "supervisor_epoch" },
  { table: "session_kernel_agent_operations", collection: KERNEL_COLLECTIONS.agentOperations, keys: ["session_id", "operation_id"], orderBy: "operation_sequence" },
  { table: "session_kernel_agent_operation_cancellations", collection: KERNEL_COLLECTIONS.agentOperationCancellations, keys: ["session_id", "operation_id"], orderBy: "operation_id" },
  { table: "session_kernel_agent_operation_high_water", collection: KERNEL_COLLECTIONS.agentOperationHighWater, keys: ["session_id"], orderBy: "session_id" },
  { table: "session_kernel_commands", collection: KERNEL_COLLECTIONS.commands, keys: ["session_id", "request_id"], orderBy: "request_id" },
  { table: "session_kernel_changes", collection: KERNEL_COLLECTIONS.changes, keys: ["session_id", "change_seq"], orderBy: "change_seq" },
  { table: "session_kernel_timers", collection: KERNEL_COLLECTIONS.timers, keys: ["session_id", "timer_id"], orderBy: "timer_id" },
  { table: "session_kernel_outbox", collection: KERNEL_COLLECTIONS.outbox, keys: ["session_id", "effect_id"], orderBy: "id" },
] as const;

const JSON_COLUMNS = new Set([
  "completed_effects", "setup_plan", "opening_plan", "record", "queued",
  "dispatch", "interrupt", "steered", "pending_steers", "cancel", "payload", "result",
  "terminal_entry_ids", "terminal_request", "receipt", "identity", "intent",
  "envelope", "authority", "authority_bytes",
]);

export type FeltDbKernelMigrationResult = {
  sessionId: string;
  migrationId: string;
  importedRecords: number;
  importedBatches: number;
  contentHash: string;
  headVersion: number;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeRow(row: SqlRow): Record<string, unknown> {
  const decoded: Record<string, unknown> = { schemaVersion: 1 };
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && JSON_COLUMNS.has(key) && typeof value === "string") {
      try {
        decoded[key] = JSON.parse(value);
        continue;
      } catch {
        throw new Error(`Session Kernel migration found invalid structured value in ${key}`);
      }
    }
    decoded[key] = value;
  }
  return decoded;
}

function recordId(plan: TablePlan, row: SqlRow): string {
  const identity = plan.keys.map((key) => {
    const value = row[key];
    if (value === undefined || value === null || value === "")
      throw new Error(`${plan.table} has no ${key} identity`);
    return String(value);
  }).join(":");
  return kernelRecordId(plan.table.replace("session_kernel_", ""), identity);
}

function sourceRun(db: Database, sessionId: string): {
  run: SessionDecisionHead["run"];
  changeSeq: number;
} {
  const rows = db.query(`
    SELECT run_state, run_since, last_event, generation, current_run_id, change_seq
    FROM session_kernel_state WHERE session_id = ?
  `).all(sessionId) as Array<{
    run_state: string;
    run_since: string;
    last_event: string | null;
    generation: number;
    current_run_id: string | null;
    change_seq: number;
  }>;
  if (rows.length > 1) throw new Error(`Session ${sessionId} has duplicate run state`);
  const row = rows[0];
  return row ? {
    run: {
      state: row.run_state,
      since: row.run_since,
      ...(row.last_event === null ? {} : { lastEvent: row.last_event }),
      generation: Number(row.generation),
      ...(row.current_run_id === null ? {} : { currentRunId: row.current_run_id }),
    },
    changeSeq: Number(row.change_seq),
  } : {
    run: { state: "idle", since: new Date(0).toISOString(), generation: 0 },
    changeSeq: 0,
  };
}

function assertSource(db: Database, sessionId: string): void {
  const schemaVersion = Number(
    (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (schemaVersion !== SESSION_KERNEL_SCHEMA_VERSION)
    throw new Error(`Session ${sessionId} has Session Kernel schema ${schemaVersion}`);
  const integrity = db.query("PRAGMA quick_check").get() as Record<string, unknown>;
  if (!Object.values(integrity).includes("ok"))
    throw new Error(`Session ${sessionId} failed SQLite source integrity check`);
  const tombstone = db.query(
    "SELECT 1 AS present FROM session_kernel_tombstones WHERE session_id = ?",
  ).get(sessionId);
  if (tombstone) throw new Error(`Session ${sessionId} is tombstoned`);
  const sequence = db.query(`
    SELECT COUNT(*) AS count, MIN(change_seq) AS first_seq, MAX(change_seq) AS last_seq
    FROM session_kernel_changes WHERE session_id = ?
  `).get(sessionId) as { count: number; first_seq: number | null; last_seq: number | null };
  const expectedLast = Number(sequence.count) === 0 ? 0 : Number(sequence.count);
  if (
    (expectedLast > 0 && Number(sequence.first_seq) !== 1) ||
    Number(sequence.last_seq ?? 0) !== expectedLast
  ) throw new Error(`Session ${sessionId} has a non-dense change journal`);
}

export function encodeKernelSessionMigration(
  db: Database,
  sessionId: string,
): {
  run: SessionDecisionHead["run"];
  changeSeq: number;
  operations: AtomicTransactionOperationRequest[];
} {
  if (!sessionId) throw new Error("Session Kernel migration requires a session id");
  assertSource(db, sessionId);
  const operations: AtomicTransactionOperationRequest[] = [];
  for (const plan of TABLES) {
    const rows = db.query(
      `SELECT * FROM ${plan.table} WHERE session_id = ? ORDER BY ${plan.orderBy}`,
    ).all(sessionId) as SqlRow[];
    for (const row of rows) {
      const id = plan.table === "session_kernel_turn_projections"
        ? kernelRecordId("turn_projections", `${sessionId}:1:${row.projection_id}`)
        : recordId(plan, row);
      let value: Record<string, unknown> = decodeRow(row);
      if (plan.table === "session_kernel_changes") value = {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: 1,
        changeSeq: Number(row.change_seq),
        kind: String(row.kind),
        payload: value.payload,
        transactionId: `opensession:kernel:migrated-change:${sessionId}:${row.change_seq}`,
        createdAt: Number(row.created_at),
      };
      else if (plan.table === "session_kernel_creation") value = {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: 1,
        identity: String(row.identity),
        state: String(row.state),
        generation: Number(row.generation),
        ...(row.current_effect_id === null ? {} : { currentEffectId: String(row.current_effect_id) }),
        completedEffectIds: value.completed_effects,
        ...(row.setup_plan === null ? {} : { setupPlan: value.setup_plan }),
        ...(row.opening_plan === null ? {} : { openingPlan: value.opening_plan }),
        changeSeq: Number(row.change_seq),
        updatedAt: Number(row.updated_at),
      };
      else if (plan.table === "session_kernel_asks") value = {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: 1,
        revision: Number(row.revision),
        record: value.record,
        updatedAt: Number(row.updated_at),
      };
      else if (plan.table === "session_kernel_turn") value = {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: 1,
        revision: Number(row.revision),
        ...(row.cancel === null ? {} : { cancel: value.cancel }),
        updatedAt: Number(row.updated_at),
      };
      else if (plan.table === "session_kernel_delivery") value = {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: 1,
        revision: Number(row.revision),
        queued: value.queued,
        ...(row.dispatch === null ? {} : { dispatch: value.dispatch }),
        ...(row.interrupt === null ? {} : { interrupt: value.interrupt }),
        steered: value.steered,
        pendingSteers: value.pending_steers,
        updatedAt: Number(row.updated_at),
      };
      else if (plan.table === "session_kernel_turn_projections") value = {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: 1,
        projectionId: String(row.projection_id),
        generation: Number(row.generation),
        phase: String(row.phase),
        ...(value.payload as Record<string, unknown>),
        updatedAt: Number(row.updated_at),
      };
      else if (plan.table === "session_kernel_timers") value = {
        schemaVersion: 1,
        recordId: id,
        sessionId,
        decisionEpoch: 1,
        timerId: String(row.timer_id),
        kind: String(row.kind),
        dueAt: Number(row.due_at),
        token: String(row.token),
        payload: value.payload,
        status: row.dead_lettered_at === null ? "pending" : "dead_letter",
        attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        ...(row.last_error === null ? {} : { lastError: String(row.last_error) }),
        ...(row.dead_lettered_at === null
          ? {}
          : { deadLetteredAt: Number(row.dead_lettered_at) }),
        createdAt: Number(row.created_at),
      };
      else if (plan.table === "session_kernel_commands") value = {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: 1,
        requestId: String(row.request_id),
        type: String(row.type),
        payload: value.payload,
        payloadHash: String(row.payload_hash),
        status: String(row.status),
        replaySafe: Number(row.replay_safe) === 1,
        ...(row.retryable === null ? {} : { retryable: Number(row.retryable) === 1 }),
        ...(row.result === null ? {} : { result: value.result }),
        ...(row.result_hash === null ? {} : { resultHash: String(row.result_hash) }),
        terminalFailure: Number(row.terminal_failure) === 1,
        ...(row.acknowledged_at === null ? {} : { acknowledgedAt: Number(row.acknowledged_at) }),
        ...(row.error === null ? {} : { error: String(row.error) }),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
      else if (plan.table === "session_kernel_outbox") value = {
        schemaVersion: 1,
        recordId: id,
        effectId: String(row.effect_id),
        effectKey: String(row.effect_key),
        sessionId,
        decisionEpoch: 1,
        kind: String(row.kind),
        ...(row.kind === "turn_outcome_project" &&
          value.payload && typeof value.payload === "object" &&
          Number.isSafeInteger((value.payload as Record<string, unknown>).runGeneration)
          ? { orderingKey: Number((value.payload as Record<string, unknown>).runGeneration) }
          : {}),
        payload: value.payload,
        status: row.dead_lettered_at === null ? "pending" : "dead_letter",
        attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        ...(row.last_error === null ? {} : { lastError: String(row.last_error) }),
        ...(row.dead_lettered_at === null
          ? {}
          : { deadLetteredAt: Number(row.dead_lettered_at) }),
        createdAt: Number(row.created_at),
      };
      operations.push({
        collection: plan.collection,
        id,
        value,
        requireAbsent: true,
      });
      if (plan.table === "session_kernel_turn_projections") operations.push({
        collection: KERNEL_COLLECTIONS.turnProjectionGenerations,
        id: kernelRecordId(
          "turn_projection_generation",
          `${sessionId}:1:${row.generation}`,
        ),
        value: {
          schemaVersion: 1,
          sessionId,
          decisionEpoch: 1,
          generation: Number(row.generation),
          projectionId: String(row.projection_id),
        },
        requireAbsent: true,
      });
    }
  }
  const state = sourceRun(db, sessionId);
  const journalRows = operations.filter(
    (operation) => operation.collection === KERNEL_COLLECTIONS.changes,
  ).length;
  if (state.changeSeq !== journalRows)
    throw new Error(`Session ${sessionId} run state disagrees with its change journal`);
  return { ...state, operations };
}

export async function migrateKernelSessionToFeltDb(options: {
  sourcePath: string;
  sessionId: string;
  migrationId: string;
  owner: string;
  leaseId: string;
  leaseDurationMs: number;
  store: FeltDbSessionDecisionStore;
  batchSize?: number;
}): Promise<FeltDbKernelMigrationResult> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 250)
    throw new Error("Session Kernel migration batch size must be between 1 and 250");
  const source = new Database(options.sourcePath, { readonly: true, strict: true });
  try {
    const encoded = encodeKernelSessionMigration(source, options.sessionId);
    let manifest = await options.store.beginMigration({
      sessionId: options.sessionId,
      migrationId: options.migrationId,
    });
    for (let offset = 0; offset < encoded.operations.length; offset += batchSize) {
      const operations = encoded.operations.slice(offset, offset + batchSize);
      const batchId = String(offset / batchSize + 1).padStart(8, "0");
      const contentHash = hash(JSON.stringify(operations));
      manifest = await options.store.importMigrationBatch({
        sessionId: options.sessionId,
        migrationId: options.migrationId,
        batchId,
        recordCount: operations.length,
        contentHash,
        observedManifest: manifest,
        operations,
      });
    }
    manifest = await options.store.verifyMigration({
      observedManifest: manifest,
      expectedRecords: encoded.operations.length,
      expectedBatches: Math.ceil(encoded.operations.length / batchSize),
      expectedContentHash: manifest.contentHash,
    });
    const head = await options.store.activateSession({
      sessionId: options.sessionId,
      migrationId: options.migrationId,
      owner: options.owner,
      leaseId: options.leaseId,
      leaseDurationMs: options.leaseDurationMs,
      migrationManifestVersion: manifest.__version,
      run: encoded.run,
      changeSeq: encoded.changeSeq,
    });
    return {
      sessionId: options.sessionId,
      migrationId: options.migrationId,
      importedRecords: manifest.importedRecords,
      importedBatches: manifest.importedBatches,
      contentHash: manifest.contentHash,
      headVersion: head.__version,
    };
  } finally {
    source.close();
  }
}
