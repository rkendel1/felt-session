import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
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
  recoveryError,
  type DurableCommandLedger,
  type LedgerCommandIdentity,
  type LedgerRecord,
  type LedgerScope,
  type LedgerTerminalTransition,
} from "./ledger";

const SCHEMA_VERSION = 2;

type StoredRow = {
  receipt_id: unknown;
  command_kind: unknown;
  command_key: unknown;
  executor_id: unknown;
  root_id: unknown;
  session_id: unknown;
  run_id: unknown;
  generation: unknown;
  request_id: unknown;
  operation_digest: unknown;
  state: unknown;
  accepted_at: unknown;
  completed_at: unknown;
  payload: unknown;
  ordinal: unknown;
};

export interface SQLiteCommandLedgerOptions {
  dbPath: string;
  capacity?: number;
  busyTimeoutMs?: number;
  maxRecordBytes?: number;
  maxStringBytes?: number;
  maxEvents?: number;
}
type Limits = LedgerLimits;

export function openSQLiteCommandLedger(
  options: SQLiteCommandLedgerOptions,
): SQLiteCommandLedger {
  return SQLiteCommandLedger.open(options);
}

export class SQLiteCommandLedger implements DurableCommandLedger {
  readonly #db: Database;
  readonly #capacity: number;
  readonly #limits: Limits;
  #closed = false;

  private constructor(db: Database, capacity: number, limits: Limits) {
    this.#db = db;
    this.#capacity = capacity;
    this.#limits = limits;
  }

  static open(options: SQLiteCommandLedgerOptions): SQLiteCommandLedger {
    const capacity = positiveInteger(
      options.capacity ?? 100_000,
      "ledger capacity",
    );
    const busyTimeoutMs = positiveInteger(
      options.busyTimeoutMs ?? 5_000,
      "busy timeout",
    );
    const limits = {
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
    if (!options.dbPath || options.dbPath === ":memory:")
      throw new Error(
        "a filesystem database path is required for a durable ledger",
      );
    const dbPath = resolve(options.dbPath);
    preparePrivateDatabasePath(dbPath);
    preflightSidecars(dbPath);
    const db = new Database(dbPath, { create: true, strict: true });
    try {
      chmodSync(dbPath, 0o600);
      db.exec(
        `PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`,
      );
      initializeOrValidateSchema(db);
      // Sidecars were checked before this pragma is allowed to create/open them.
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      secureDatabaseFiles(dbPath);
      return new SQLiteCommandLedger(db, capacity, limits);
    } catch (cause) {
      db.close();
      throw cause;
    }
  }

  async claim(
    identity: LedgerCommandIdentity,
    receipt: ExecutorReceipt,
  ): Promise<{ record: LedgerRecord; claimed: boolean }> {
    this.#assertOpen();
    const initial: LedgerRecord = { ...identity, receipt };
    const encoded = encodeRecord(initial, this.#limits);
    const kind = identity.idempotencyKey === undefined ? "request" : "mutation";
    const key = identity.idempotencyKey ?? identity.requestId;
    return this.#writeTransaction(() => {
      if (this.#isRetired(identity)) throw new LedgerScopeRetiredError();
      const existing = this.#selectCommand(identity, kind, key);
      if (existing) {
        const record = decodeRow(existing, this.#limits);
        if (record.operationDigest !== identity.operationDigest)
          throw new LedgerConflictError();
        return { record, claimed: false };
      }
      const collision = this.#selectReceipt(receipt.receiptId);
      if (collision) {
        decodeRow(collision, this.#limits);
        throw new LedgerConflictError(
          "receipt already belongs to another command",
        );
      }
      this.#makeRoom();
      const ordinal = (
        this.#db
          .query(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM runner_command_ledger",
          )
          .get() as { value: number }
      ).value;
      this.#db
        .query(
          `INSERT INTO runner_command_ledger
        (receipt_id, command_kind, command_key, executor_id, root_id, session_id, run_id, generation,
         request_id, operation_digest, state, accepted_at, completed_at, payload, ordinal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          receipt.receiptId,
          kind,
          key,
          identity.executorId,
          identity.rootId,
          identity.sessionId,
          identity.runId,
          identity.generation,
          identity.requestId,
          identity.operationDigest,
          receipt.state,
          receipt.acceptedAt,
          encoded,
          ordinal,
        );
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
    return this.#writeTransaction(() => {
      const row = this.#selectReceipt(receiptId);
      if (!row) throw new LedgerNotFoundError();
      const current = decodeRow(row, this.#limits);
      if (!sameScopeValues(current, scope)) throw new LedgerNotFoundError();
      if (current.receipt.state !== expected)
        throw new LedgerTransitionError(
          current.receipt.state,
          expected,
          next.state,
        );
      const updated = applyTransition(current, next);
      const encoded = encodeRecord(updated, this.#limits);
      const result = this.#db
        .query(
          `UPDATE runner_command_ledger SET state = ?, completed_at = ?, payload = ?
        WHERE receipt_id = ? AND executor_id = ? AND root_id = ? AND session_id = ? AND run_id = ? AND generation = ? AND state = ?`,
        )
        .run(
          updated.receipt.state,
          updated.receipt.completedAt ?? null,
          encoded,
          receiptId,
          scope.executorId,
          scope.rootId,
          scope.sessionId,
          scope.runId,
          scope.generation,
          expected,
        );
      if (result.changes !== 1)
        throw new LedgerTransitionError(
          current.receipt.state,
          expected,
          next.state,
        );
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
    const row = this.#db
      .query(
        `SELECT * FROM runner_command_ledger WHERE receipt_id = ? AND executor_id = ?
      AND root_id = ? AND session_id = ? AND run_id = ? AND generation = ?`,
      )
      .get(
        receiptId,
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      ) as StoredRow | null;
    return row ? decodeRow(row, this.#limits) : undefined;
  }

  async recover(): Promise<number> {
    this.#assertOpen();
    return this.#writeTransaction(() => {
      const rows = this.#db
        .query(
          "SELECT * FROM runner_command_ledger WHERE state IN ('queued', 'running') ORDER BY ordinal",
        )
        .all() as StoredRow[];
      const completedAt = new Date().toISOString();
      for (const row of rows) {
        const current = decodeRow(row, this.#limits);
        const updated = applyTransition(current, {
          state: "failed",
          completedAt,
          error: recoveryError(current.idempotencyKey !== undefined),
        });
        this.#db
          .query(
            "UPDATE runner_command_ledger SET state = 'failed', completed_at = ?, payload = ? WHERE receipt_id = ? AND state = ?",
          )
          .run(
            completedAt,
            encodeRecord(updated, this.#limits),
            current.receipt.receiptId,
            current.receipt.state,
          );
      }
      return rows.length;
    });
  }

  async retireScope(scope: LedgerScope): Promise<number> {
    this.#assertOpen();
    validateScope(scope);
    return this.#writeTransaction(() => {
      const parameters = [
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      ] as const;
      const active = this.#db
        .query(
          `SELECT COUNT(*) AS count FROM runner_command_ledger WHERE executor_id = ? AND root_id = ?
          AND session_id = ? AND run_id = ? AND generation = ? AND state IN ('queued', 'running')`,
        )
        .get(...parameters) as { count: number };
      if (active.count) throw new LedgerScopeActiveError();
      const result = this.#db
        .query(
          `DELETE FROM runner_command_ledger WHERE executor_id = ? AND root_id = ?
          AND session_id = ? AND run_id = ? AND generation = ? AND state IN ('succeeded', 'failed', 'cancelled')`,
        )
        .run(...parameters);
      this.#db
        .query(
          `INSERT OR IGNORE INTO runner_retired_scopes
          (executor_id, root_id, session_id, run_id, generation) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(...parameters);
      return result.changes;
    });
  }

  async purgeRetiredScope(scope: LedgerScope): Promise<boolean> {
    this.#assertOpen();
    validateScope(scope);
    const result = this.#db
      .query(
        `DELETE FROM runner_retired_scopes WHERE executor_id = ? AND root_id = ?
        AND session_id = ? AND run_id = ? AND generation = ?`,
      )
      .run(
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      );
    return result.changes === 1;
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error("command ledger is closed");
  }
  #isRetired(scope: LedgerScope): boolean {
    return !!this.#db
      .query(
        `SELECT 1 AS retired FROM runner_retired_scopes WHERE executor_id = ? AND root_id = ?
        AND session_id = ? AND run_id = ? AND generation = ?`,
      )
      .get(
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      );
  }
  #selectReceipt(receiptId: string): StoredRow | null {
    return this.#db
      .query("SELECT * FROM runner_command_ledger WHERE receipt_id = ?")
      .get(receiptId) as StoredRow | null;
  }
  #selectCommand(
    identity: LedgerCommandIdentity,
    kind: string,
    key: string,
  ): StoredRow | null {
    return this.#db
      .query(
        `SELECT * FROM runner_command_ledger WHERE executor_id = ? AND root_id = ?
      AND session_id = ? AND run_id = ? AND generation = ? AND command_kind = ? AND command_key = ?`,
      )
      .get(
        identity.executorId,
        identity.rootId,
        identity.sessionId,
        identity.runId,
        identity.generation,
        kind,
        key,
      ) as StoredRow | null;
  }
  #makeRoom(): void {
    const count = (
      this.#db
        .query("SELECT COUNT(*) AS count FROM runner_command_ledger")
        .get() as { count: number }
    ).count;
    if (count < this.#capacity) return;
    const reclaim = this.#db
      .query(
        `SELECT receipt_id FROM runner_command_ledger
      WHERE command_kind = 'request' AND state IN ('succeeded', 'failed', 'cancelled') ORDER BY ordinal LIMIT 1`,
      )
      .get() as { receipt_id: string } | null;
    if (!reclaim) throw new LedgerFullError();
    this.#db
      .query("DELETE FROM runner_command_ledger WHERE receipt_id = ?")
      .run(reclaim.receipt_id);
  }
  #writeTransaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw cause;
    }
  }
}

function initializeOrValidateSchema(db: Database): void {
  const version = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  const userTables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const table = userTables.some(({ name }) => name === "runner_command_ledger");
  if (!table) {
    if (userTables.length)
      throw new Error("unknown existing ledger database tables");
    if (version !== 0)
      throw new Error(`unsupported ledger schema version ${version}`);
    db.exec(`CREATE TABLE runner_command_ledger (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL CHECK(command_kind IN ('request', 'mutation')),
      command_key TEXT NOT NULL, executor_id TEXT NOT NULL, root_id TEXT NOT NULL,
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
      request_id TEXT NOT NULL, operation_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      accepted_at TEXT NOT NULL, completed_at TEXT, payload TEXT NOT NULL, ordinal INTEGER NOT NULL,
      UNIQUE(executor_id, root_id, session_id, run_id, generation, command_kind, command_key)
    ) STRICT;
    CREATE TABLE runner_retired_scopes (
      executor_id TEXT NOT NULL, root_id TEXT NOT NULL, session_id TEXT NOT NULL,
      run_id TEXT NOT NULL, generation INTEGER NOT NULL,
      PRIMARY KEY(executor_id, root_id, session_id, run_id, generation)
    ) STRICT;
    PRAGMA user_version = ${SCHEMA_VERSION};`);
  } else if (version !== SCHEMA_VERSION) {
    throw new Error(
      version === 0
        ? "unversioned existing ledger table"
        : `unsupported ledger schema version ${version}`,
    );
  }
  const tableNames = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
  if (
    tableNames.length !== 2 ||
    !tableNames.includes("runner_command_ledger") ||
    !tableNames.includes("runner_retired_scopes")
  )
    throw new Error("ledger schema tables do not match version 2");
  const expected = [
    ["receipt_id", "TEXT", 1, 1],
    ["command_kind", "TEXT", 1, 0],
    ["command_key", "TEXT", 1, 0],
    ["executor_id", "TEXT", 1, 0],
    ["root_id", "TEXT", 1, 0],
    ["session_id", "TEXT", 1, 0],
    ["run_id", "TEXT", 1, 0],
    ["generation", "INTEGER", 1, 0],
    ["request_id", "TEXT", 1, 0],
    ["operation_digest", "TEXT", 1, 0],
    ["state", "TEXT", 1, 0],
    ["accepted_at", "TEXT", 1, 0],
    ["completed_at", "TEXT", 0, 0],
    ["payload", "TEXT", 1, 0],
    ["ordinal", "INTEGER", 1, 0],
  ];
  const actual = db
    .query("PRAGMA table_info(runner_command_ledger)")
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  if (
    actual.length !== expected.length ||
    actual.some((column, index) => {
      const wanted = expected[index]!;
      return (
        column.name !== wanted[0] ||
        column.type !== wanted[1] ||
        column.notnull !== wanted[2] ||
        column.pk !== wanted[3]
      );
    })
  )
    throw new Error("ledger schema columns do not match version 2");
  const retiredExpected = [
    ["executor_id", "TEXT", 1, 1],
    ["root_id", "TEXT", 1, 2],
    ["session_id", "TEXT", 1, 3],
    ["run_id", "TEXT", 1, 4],
    ["generation", "INTEGER", 1, 5],
  ];
  const retiredActual = db
    .query("PRAGMA table_info(runner_retired_scopes)")
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  if (
    retiredActual.length !== retiredExpected.length ||
    retiredActual.some((column, index) => {
      const wanted = retiredExpected[index]!;
      return (
        column.name !== wanted[0] ||
        column.type !== wanted[1] ||
        column.notnull !== wanted[2] ||
        column.pk !== wanted[3]
      );
    })
  )
    throw new Error("retired scope schema columns do not match version 2");
}

function decodeRow(row: StoredRow, limits: Limits): LedgerRecord {
  for (const key of [
    "receipt_id",
    "command_kind",
    "command_key",
    "executor_id",
    "root_id",
    "session_id",
    "run_id",
    "request_id",
    "operation_digest",
    "state",
    "accepted_at",
    "payload",
  ] as const)
    if (typeof row[key] !== "string") throw new Error("malformed ledger row");
  if (
    !Number.isSafeInteger(row.generation) ||
    !Number.isSafeInteger(row.ordinal) ||
    (row.completed_at !== null && typeof row.completed_at !== "string")
  )
    throw new Error("malformed ledger row");
  const record = decodeRecord(row.payload as string, limits);
  const kind = record.idempotencyKey === undefined ? "request" : "mutation";
  const key = record.idempotencyKey ?? record.requestId;
  if (
    row.receipt_id !== record.receipt.receiptId ||
    row.command_kind !== kind ||
    row.command_key !== key ||
    row.executor_id !== record.executorId ||
    row.root_id !== record.rootId ||
    row.session_id !== record.sessionId ||
    row.run_id !== record.runId ||
    row.generation !== record.generation ||
    row.request_id !== record.requestId ||
    row.operation_digest !== record.operationDigest ||
    row.state !== record.receipt.state ||
    row.accepted_at !== record.receipt.acceptedAt ||
    row.completed_at !== (record.receipt.completedAt ?? null)
  )
    throw new Error("ledger row identity mismatch");
  return structuredClone(record);
}

function preparePrivateDatabasePath(dbPath: string): void {
  const parent = dirname(dbPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = parse(parent).root;
  let current = root;
  for (const part of parent
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`unsafe ledger path component: ${current}`);
  }
  chmodSync(parent, 0o700);
  const descriptor = openSync(
    dbPath,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("ledger database path is not a regular file");
    chmodSync(dbPath, 0o600);
  } finally {
    closeSync(descriptor);
  }
}
function preflightSidecars(path: string): void {
  // SQLite does not expose a no-follow VFS here. This narrows symlink races but
  // cannot defend against a malicious same-UID process replacing files later.
  for (const file of [`${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe ledger SQLite file: ${file}`);
    const descriptor = openSync(
      file,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!fstatSync(descriptor).isFile())
        throw new Error(`unsafe ledger SQLite file: ${file}`);
    } finally {
      closeSync(descriptor);
    }
  }
}
function secureDatabaseFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe ledger SQLite file: ${file}`);
    chmodSync(file, 0o600);
  }
}
export { SQLiteCommandLedger as SqliteCommandLedger };
