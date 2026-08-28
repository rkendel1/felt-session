/**
 * FeltDB-backed DurableCommandLedger.
 *
 * FeltDB is the sole durable command ledger authority. This implementation
 * described in adrs/feltdb-native-durable-substrate.md provides Mission Control's
 * complete runtime persistence layer.
 *
 * Layout — three collections:
 *   runner_command_ledger   keyed by receiptId; the validated record lives in
 *                           `payload`, with the fields queries filter on
 *                           denormalized alongside it.
 *   runner_command_index    keyed by a digest of the command key. This implements
 *                           uniqueness constraints: FeltDB has no multi-column
 *                           uniqueness, so the claim stages this record with
 *                           `requireAbsent` and lets the commit reject a double claim.
 *   runner_retired_scopes   keyed by a digest of the scope key.
 *
 * No secondary indexes are declared. FeltDB answers `find` from the same
 * in-memory cache array a hash index projects, so an index changes the constant
 * and not the shape of these bounded lookups; declaring one at open also races
 * the asynchronous restore of persisted index configs on reopen. Index tuning
 * belongs to the Phase 3 benchmark, against real command volumes.
 *
 * Telemetry is off unless an operator turns it on. Constructing a FeltDB
 * database posts an "initialize" event to feltdb.com, which neither the
 * local-first premise of the ADR nor this server's security model allows a
 * storage layer to do on its own.
 *
 * Durability comes from FeltDB's atomic transactions: every mutation that
 * touches more than one record commits as one durable snapshot, so a crash
 * leaves the whole transaction applied or none of it. Reads that decide a write
 * run under an in-process lock — the file runtime does not serialize concurrent
 * writers across processes, so this ledger expects a single owning process.
 */
import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import type { ExecutorReceipt } from "@tellahq/opensession-protocol/executor";
import {
  DEFAULT_LEDGER_LIMITS,
  decodeRecord,
  encodeRecord,
  positiveInteger,
  sameScopeValues,
  validateId,
  validateScope,
  type LedgerLimits,
} from "./ledger-codec";
import {
  LedgerConflictError,
  LedgerFullError,
  LedgerNotFoundError,
  LedgerScopeActiveError,
  LedgerScopeRetiredError,
  LedgerTransitionError,
  applyTransition,
  isTerminal,
  recoveryError,
  type DurableCommandLedger,
  type LedgerCommandIdentity,
  type LedgerRecord,
  type LedgerScope,
  type LedgerTerminalTransition,
} from "./ledger";

const COMMANDS = "runner_command_ledger";
const COMMAND_INDEX = "runner_command_index";
const RETIRED_SCOPES = "runner_retired_scopes";
const ORDINAL_SCOPE = "runner_command_ledger";
const ORDINAL_SCOPE_ID = "ordinal";

type CommandKind = "request" | "mutation";

/** The denormalized row. `payload` is the only authority; the rest is queryable index. */
interface StoredCommandRow {
  id: string;
  commandKind: CommandKind;
  commandKey: string;
  executorId: string;
  rootId: string;
  sessionId: string;
  runId: string;
  generation: number;
  requestId: string;
  operationDigest: string;
  state: string;
  acceptedAt: string;
  completedAt: string | null;
  payload: string;
  ordinal: number;
}

interface StoredCommandIndexRow {
  id: string;
  commandKey: string;
  receiptId: string;
}

interface StoredRetiredScopeRow {
  id: string;
  executorId: string;
  rootId: string;
  sessionId: string;
  runId: string;
  generation: number;
}

export interface FeltDbCommandLedgerOptions {
  /** Directory holding the durable FeltDB state. Created if absent. */
  path: string;
  /** Isolates this ledger's collections from other FeltDB users of the same directory. */
  namespace?: string;
  capacity?: number;
  maxRecordBytes?: number;
  maxStringBytes?: number;
  maxEvents?: number;
}

export function openFeltDbCommandLedger(
  options: FeltDbCommandLedgerOptions,
): FeltDbCommandLedger {
  return FeltDbCommandLedger.open(options);
}

export class FeltDbCommandLedger implements DurableCommandLedger {
  readonly #db: ReturnType<typeof createFeltDB>;
  readonly #capacity: number;
  readonly #limits: LedgerLimits;
  #serial: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    db: ReturnType<typeof createFeltDB>,
    capacity: number,
    limits: LedgerLimits,
  ) {
    this.#db = db;
    this.#capacity = capacity;
    this.#limits = limits;
  }

  static open(options: FeltDbCommandLedgerOptions): FeltDbCommandLedger {
    const capacity = positiveInteger(
      options.capacity ?? 100_000,
      "ledger capacity",
    );
    const limits: LedgerLimits = {
      maxRecordBytes: positiveInteger(
        options.maxRecordBytes ?? DEFAULT_LEDGER_LIMITS.maxRecordBytes,
        "record byte limit",
      ),
      maxStringBytes: positiveInteger(
        options.maxStringBytes ?? DEFAULT_LEDGER_LIMITS.maxStringBytes,
        "string byte limit",
      ),
      maxEvents: positiveInteger(
        options.maxEvents ?? DEFAULT_LEDGER_LIMITS.maxEvents,
        "event limit",
      ),
    };
    if (!options.path)
      throw new Error("feltdb ledger requires a durable directory path");
    enforceLocalFirstTelemetry();
    const db = createFeltDB({
      namespace: options.namespace ?? "opensession-runner-ledger",
      path: options.path,
    });
    return new FeltDbCommandLedger(db, capacity, limits);
  }

  async claim(
    identity: LedgerCommandIdentity,
    receipt: ExecutorReceipt,
  ): Promise<{ record: LedgerRecord; claimed: boolean }> {
    this.#assertOpen();
    const initial: LedgerRecord = { ...identity, receipt };
    // Validates before anything durable happens, so a rejected claim writes nothing.
    const encoded = encodeRecord(initial, this.#limits);
    const kind: CommandKind =
      identity.idempotencyKey === undefined ? "request" : "mutation";
    const key = commandKey(identity);
    const indexId = digest(key);
    return this.#exclusive(async () => {
      if (await this.#isRetired(identity)) throw new LedgerScopeRetiredError();
      const indexed = await this.#index().get(indexId);
      if (indexed) {
        const existing = await this.#requireRow(indexed.receiptId);
        const record = this.#decodeRow(existing);
        if (record.operationDigest !== identity.operationDigest)
          throw new LedgerConflictError();
        return { record, claimed: false };
      }
      const collision = await this.#commands().get(receipt.receiptId);
      if (collision) {
        this.#decodeRow(collision);
        throw new LedgerConflictError(
          "receipt already belongs to another command",
        );
      }
      const reclaimed = await this.#reclaimable();
      const ordinal = await this.#db.allocateSequence({
        scope: ORDINAL_SCOPE,
        scopeId: ORDINAL_SCOPE_ID,
      });
      const row: StoredCommandRow = {
        id: receipt.receiptId,
        commandKind: kind,
        commandKey: key,
        executorId: identity.executorId,
        rootId: identity.rootId,
        sessionId: identity.sessionId,
        runId: identity.runId,
        generation: identity.generation,
        requestId: identity.requestId,
        operationDigest: identity.operationDigest,
        state: receipt.state,
        acceptedAt: receipt.acceptedAt,
        completedAt: receipt.completedAt ?? null,
        payload: encoded,
        ordinal,
      };
      await this.#db.transaction((tx) => {
        // Eviction and insertion commit together: a reclaimed slot can never be
        // freed without the record that takes it also landing.
        if (reclaimed) {
          tx.collection(COMMANDS).delete(reclaimed.id);
          tx.collection(COMMAND_INDEX).delete(digest(reclaimed.commandKey));
        }
        tx.collection<StoredCommandRow>(COMMANDS).set(receipt.receiptId, row);
        tx.collection<StoredCommandIndexRow>(COMMAND_INDEX).set(
          indexId,
          { id: indexId, commandKey: key, receiptId: receipt.receiptId },
          // The uniqueness constraint. A racing claim of the same command loses
          // here rather than overwriting the winner's index entry.
          { requireAbsent: true },
        );
      });
      return { record: structuredClone(initial), claimed: true };
    });
  }

  async transition(
    scope: LedgerScope,
    receiptId: string,
    expected: "queued" | "running",
    next: { state: "running" } | LedgerTerminalTransition,
  ): Promise<LedgerRecord> {
    this.#assertOpen();
    validateScope(scope);
    validateId(receiptId, "receiptId");
    return this.#exclusive(async () => {
      const row = await this.#commands().get(receiptId);
      if (!row) throw new LedgerNotFoundError();
      const current = this.#decodeRow(row);
      if (!sameScopeValues(current, scope)) throw new LedgerNotFoundError();
      if (current.receipt.state !== expected)
        throw new LedgerTransitionError(
          current.receipt.state,
          expected,
          next.state,
        );
      const updated = applyTransition(current, next);
      const encoded = encodeRecord(updated, this.#limits);
      await this.#db.transaction((tx) => {
        tx.collection<StoredCommandRow>(COMMANDS).set(receiptId, {
          ...row,
          state: updated.receipt.state,
          completedAt: updated.receipt.completedAt ?? null,
          payload: encoded,
        });
      });
      return updated;
    });
  }

  async get(
    scope: LedgerScope,
    receiptId: string,
  ): Promise<LedgerRecord | undefined> {
    this.#assertOpen();
    validateScope(scope);
    validateId(receiptId, "receiptId");
    const row = await this.#commands().get(receiptId);
    if (!row) return undefined;
    const record = this.#decodeRow(row);
    return sameScopeValues(record, scope) ? record : undefined;
  }

  async recover(): Promise<number> {
    this.#assertOpen();
    return this.#exclusive(async () => {
      const rows = [
        ...(await this.#commands().find({ state: "queued" })),
        ...(await this.#commands().find({ state: "running" })),
      ].sort((a, b) => a.ordinal - b.ordinal);
      if (!rows.length) return 0;
      const completedAt = new Date().toISOString();
      const updates = rows.map((row) => {
        const current = this.#decodeRow(row);
        const updated = applyTransition(current, {
          state: "failed",
          completedAt,
          error: recoveryError(current.idempotencyKey !== undefined),
        });
        return {
          ...row,
          state: updated.receipt.state,
          completedAt: updated.receipt.completedAt ?? null,
          payload: encodeRecord(updated, this.#limits),
        };
      });
      // One transaction: a crash mid-recovery cannot leave some inherited work
      // failed and the rest still claimable.
      await this.#db.transaction((tx) => {
        for (const row of updates)
          tx.collection<StoredCommandRow>(COMMANDS).set(row.id, row);
      });
      return rows.length;
    });
  }

  async retireScope(scope: LedgerScope): Promise<number> {
    this.#assertOpen();
    validateScope(scope);
    return this.#exclusive(async () => {
      const scoped = await this.#scopedRows(scope);
      if (scoped.some((row) => !isTerminal(this.#decodeRow(row).receipt.state)))
        throw new LedgerScopeActiveError();
      const retiredId = digest(scopeKey(scope));
      await this.#db.transaction((tx) => {
        for (const row of scoped) {
          tx.collection(COMMANDS).delete(row.id);
          tx.collection(COMMAND_INDEX).delete(digest(row.commandKey));
        }
        tx.collection<StoredRetiredScopeRow>(RETIRED_SCOPES).set(retiredId, {
          id: retiredId,
          executorId: scope.executorId,
          rootId: scope.rootId,
          sessionId: scope.sessionId,
          runId: scope.runId,
          generation: scope.generation,
        });
      });
      return scoped.length;
    });
  }

  async purgeRetiredScope(scope: LedgerScope): Promise<boolean> {
    this.#assertOpen();
    validateScope(scope);
    return this.#exclusive(async () => {
      const retiredId = digest(scopeKey(scope));
      if (!(await this.#retired().get(retiredId))) return false;
      await this.#db.transaction((tx) => {
        tx.collection(RETIRED_SCOPES).delete(retiredId);
      });
      return true;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#db.close();
  }

  #commands() {
    return this.#db.collection<StoredCommandRow>(COMMANDS);
  }
  #index() {
    return this.#db.collection<StoredCommandIndexRow>(COMMAND_INDEX);
  }
  #retired() {
    return this.#db.collection<StoredRetiredScopeRow>(RETIRED_SCOPES);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("command ledger is closed");
  }

  async #isRetired(scope: LedgerScope): Promise<boolean> {
    return !!(await this.#retired().get(digest(scopeKey(scope))));
  }

  async #requireRow(receiptId: string): Promise<StoredCommandRow> {
    const row = await this.#commands().get(receiptId);
    // The index entry and its record commit together, so a missing record here
    // means the store was modified outside this ledger.
    if (!row) throw new Error("ledger index references a missing record");
    return row;
  }

  async #scopedRows(scope: LedgerScope): Promise<StoredCommandRow[]> {
    return this.#commands().find({
      executorId: scope.executorId,
      rootId: scope.rootId,
      sessionId: scope.sessionId,
      runId: scope.runId,
      generation: scope.generation,
    });
  }

  /**
   * The record a full ledger may evict: the oldest terminal non-mutation.
   * Mutations are never reclaimed, because their idempotency key is the only
   * thing standing between a replay and a duplicated external effect.
   */
  async #reclaimable(): Promise<StoredCommandRow | undefined> {
    if ((await this.#commands().count()) < this.#capacity) return undefined;
    const candidate = (await this.#commands().find({ commandKind: "request" }))
      .filter((row) => isTerminal(this.#decodeRow(row).receipt.state))
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    if (!candidate) throw new LedgerFullError();
    return candidate;
  }

  /** Decode the payload and prove the denormalized columns still agree with it. */
  #decodeRow(row: StoredCommandRow): LedgerRecord {
    for (const key of [
      "id",
      "commandKind",
      "commandKey",
      "executorId",
      "rootId",
      "sessionId",
      "runId",
      "requestId",
      "operationDigest",
      "state",
      "acceptedAt",
      "payload",
    ] as const)
      if (typeof row[key] !== "string") throw new Error("malformed ledger row");
    if (
      !Number.isSafeInteger(row.generation) ||
      !Number.isSafeInteger(row.ordinal) ||
      (row.completedAt !== null && typeof row.completedAt !== "string")
    )
      throw new Error("malformed ledger row");
    const record = decodeRecord(row.payload, this.#limits);
    const kind = record.idempotencyKey === undefined ? "request" : "mutation";
    if (
      row.id !== record.receipt.receiptId ||
      row.commandKind !== kind ||
      row.commandKey !== commandKey(record) ||
      row.executorId !== record.executorId ||
      row.rootId !== record.rootId ||
      row.sessionId !== record.sessionId ||
      row.runId !== record.runId ||
      row.generation !== record.generation ||
      row.requestId !== record.requestId ||
      row.operationDigest !== record.operationDigest ||
      row.state !== record.receipt.state ||
      row.acceptedAt !== record.receipt.acceptedAt ||
      row.completedAt !== (record.receipt.completedAt ?? null)
    )
      throw new Error("ledger row identity mismatch");
    return structuredClone(record);
  }

  /** Serializes read-decide-write sequences, as InMemoryCommandLedger does. */
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#serial;
    let release!: () => void;
    this.#serial = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function scopeKey(scope: LedgerScope): string {
  return JSON.stringify([
    scope.executorId,
    scope.rootId,
    scope.sessionId,
    scope.runId,
    scope.generation,
  ]);
}

function commandKey(identity: LedgerCommandIdentity): string {
  const scope = scopeKey(identity);
  return identity.idempotencyKey === undefined
    ? `${scope}:request:${identity.requestId}`
    : `${scope}:mutation:${identity.idempotencyKey}`;
}

/**
 * Keep the substrate local-first.
 *
 * FeltDB emits an adoption event to feltdb.com the first time a database is
 * constructed, and schedules a timer to flush more. A command ledger is not a
 * place from which to open an outbound connection, so this defaults the
 * library's own opt-out on before the first database exists. Setting
 * FELTDB_TELEMETRY to anything else is an operator's explicit choice and is
 * left alone.
 */
function enforceLocalFirstTelemetry(): void {
  process.env.FELTDB_TELEMETRY ??= "0";
  const setting = process.env.FELTDB_TELEMETRY;
  if (setting !== "0" && setting !== "false") return;
  // Covers a client already constructed by some other FeltDB user in-process.
  getTelemetryClient().disable();
}

/** Record ids must be opaque and bounded; command and scope keys are neither. */
function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
