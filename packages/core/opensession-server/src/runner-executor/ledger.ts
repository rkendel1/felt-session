import {
  decodeExecutorId,
  decodeExecutorOperation,
  isExecutorOutcomeCompatible,
  type ExecutorErrorCode,
  ExecutorOperation,
  ExecutorOperationOutcome,
  ExecutorReceipt,
  ExecutorReceiptState,
  ExecutorStreamEvent,
} from "@tellahq/opensession-protocol/executor";

export interface LedgerScope {
  executorId: string;
  rootId: string;
  sessionId: string;
  runId: string;
  generation: number;
}

export interface LedgerCommandIdentity extends LedgerScope {
  requestId: string;
  idempotencyKey?: string;
  operationDigest: string;
  operation: ExecutorOperation;
}

export interface LedgerError {
  code: ExecutorErrorCode;
  message: string;
  /** True when a mutation may have taken effect outside the ledger. */
  ambiguous?: boolean;
}

export interface LedgerRecord extends LedgerCommandIdentity {
  receipt: ExecutorReceipt;
  outcome?: ExecutorOperationOutcome;
  events?: ExecutorStreamEvent[];
  error?: LedgerError;
}

export type LedgerTerminalTransition =
  | {
      state: "succeeded";
      completedAt: string;
      outcome: ExecutorOperationOutcome;
      events?: ExecutorStreamEvent[];
    }
  | {
      state: "failed";
      completedAt: string;
      error: LedgerError;
    }
  | {
      state: "cancelled";
      completedAt: string;
      error?: LedgerError;
    };

export interface DurableCommandLedger {
  /** Atomically creates a command or returns the stable matching claim. */
  claim(
    identity: LedgerCommandIdentity,
    receipt: ExecutorReceipt,
  ): Promise<{ record: LedgerRecord; claimed: boolean }>;
  transition(
    scope: LedgerScope,
    receiptId: string,
    expected: "queued" | "running",
    next: { state: "running" } | LedgerTerminalTransition,
  ): Promise<LedgerRecord>;
  /** Receipt identifiers are not capabilities; exact scope ownership is required. */
  get(scope: LedgerScope, receiptId: string): Promise<LedgerRecord | undefined>;
  /** Fail all work inherited from a prior process before accepting new frames. */
  recover(): Promise<number>;
  /**
   * Delete terminal history only after the control plane has acknowledged that
   * the entire scope is permanently retired. Active scopes fail closed.
   * Ingress wiring is required and must prove that acknowledgment before call.
   */
  retireScope(scope: LedgerScope): Promise<number>;
  /** Permanently forget a retired scope only after its replay horizon is gone. */
  purgeRetiredScope(scope: LedgerScope): Promise<boolean>;
}

/** FeltDB-backed reference ledger with atomic state semantics. */
export class InMemoryCommandLedger implements DurableCommandLedger {
  readonly #byReceipt = new Map<string, LedgerRecord>();
  readonly #byCommand = new Map<string, string>();
  readonly #retiredScopes = new Set<string>();
  #serial: Promise<void> = Promise.resolve();

  constructor(readonly capacity = 100_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("ledger capacity must be positive");
  }

  async claim(
    identity: LedgerCommandIdentity,
    receipt: ExecutorReceipt,
  ): Promise<{ record: LedgerRecord; claimed: boolean }> {
    return this.#exclusive(() => {
      assertClaimCoherent(identity, receipt);
      if (this.#retiredScopes.has(scopeKey(identity)))
        throw new LedgerScopeRetiredError();
      const key = commandKey(identity);
      const existingId = this.#byCommand.get(key);
      if (existingId) {
        const existing = this.#byReceipt.get(existingId)!;
        if (existing.operationDigest !== identity.operationDigest)
          throw new LedgerConflictError();
        return { record: structuredClone(existing), claimed: false };
      }
      if (this.#byReceipt.has(receipt.receiptId))
        throw new LedgerConflictError(
          "receipt already belongs to another command",
        );
      this.#makeRoom();
      const record: LedgerRecord = structuredClone({ ...identity, receipt });
      this.#byCommand.set(key, receipt.receiptId);
      this.#byReceipt.set(receipt.receiptId, record);
      return { record: structuredClone(record), claimed: true };
    });
  }

  async transition(
    scope: LedgerScope,
    receiptId: string,
    expected: "queued" | "running",
    next: { state: "running" } | LedgerTerminalTransition,
  ): Promise<LedgerRecord> {
    return this.#exclusive(() => {
      const current = this.#byReceipt.get(receiptId);
      if (!current || !sameScope(current, scope))
        throw new LedgerNotFoundError();
      if (current.receipt.state !== expected)
        throw new LedgerTransitionError(
          current.receipt.state,
          expected,
          next.state,
        );
      const updated = applyTransition(current, next);
      this.#byReceipt.set(receiptId, updated);
      return structuredClone(updated);
    });
  }

  async get(
    scope: LedgerScope,
    receiptId: string,
  ): Promise<LedgerRecord | undefined> {
    const record = this.#byReceipt.get(receiptId);
    return record && sameScope(record, scope)
      ? structuredClone(record)
      : undefined;
  }

  async recover(): Promise<number> {
    return this.#exclusive(() => {
      let count = 0;
      const completedAt = new Date().toISOString();
      for (const [receiptId, record] of this.#byReceipt) {
        if (
          record.receipt.state !== "queued" &&
          record.receipt.state !== "running"
        )
          continue;
        this.#byReceipt.set(
          receiptId,
          applyTransition(record, {
            state: "failed",
            completedAt,
            error: recoveryError(record.idempotencyKey !== undefined),
          }),
        );
        count++;
      }
      return count;
    });
  }

  async retireScope(scope: LedgerScope): Promise<number> {
    return this.#exclusive(() => {
      const scoped = [...this.#byReceipt.entries()].filter(([, record]) =>
        sameScope(record, scope),
      );
      if (scoped.some(([, record]) => !isTerminal(record.receipt.state)))
        throw new LedgerScopeActiveError();
      for (const [receiptId, record] of scoped) {
        this.#byReceipt.delete(receiptId);
        this.#byCommand.delete(commandKey(record));
      }
      this.#retiredScopes.add(scopeKey(scope));
      return scoped.length;
    });
  }

  async purgeRetiredScope(scope: LedgerScope): Promise<boolean> {
    return this.#exclusive(() => this.#retiredScopes.delete(scopeKey(scope)));
  }

  get size(): number {
    return this.#byReceipt.size;
  }

  #makeRoom(): void {
    if (this.#byReceipt.size < this.capacity) return;
    const reclaimable = [...this.#byReceipt.entries()].find(
      ([, record]) =>
        record.idempotencyKey === undefined && isTerminal(record.receipt.state),
    );
    if (!reclaimable) throw new LedgerFullError();
    const [receiptId, record] = reclaimable;
    this.#byReceipt.delete(receiptId);
    this.#byCommand.delete(commandKey(record));
  }

  async #exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.#serial;
    let release!: () => void;
    this.#serial = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

export class LedgerFullError extends Error {
  constructor() {
    super("command ledger is full");
    this.name = "LedgerFullError";
  }
}
export class LedgerConflictError extends Error {
  constructor(
    message = "idempotency key was reused for a different operation",
  ) {
    super(message);
    this.name = "LedgerConflictError";
  }
}
export class LedgerScopeRetiredError extends Error {
  constructor() {
    super("command scope was retired and cannot be replayed");
    this.name = "LedgerScopeRetiredError";
  }
}
export class LedgerScopeActiveError extends Error {
  constructor() {
    super("cannot retire a ledger scope while it has active commands");
    this.name = "LedgerScopeActiveError";
  }
}
export class LedgerNotFoundError extends Error {
  constructor() {
    super("receipt was not found in this scope");
    this.name = "LedgerNotFoundError";
  }
}
export class LedgerTransitionError extends Error {
  constructor(current: ExecutorReceiptState, expected: string, next: string) {
    super(`cannot transition ${current} as ${expected} to ${next}`);
    this.name = "LedgerTransitionError";
  }
}

export function canonicalOperationBytes(
  operation: ExecutorOperation,
): Uint8Array {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    return value;
  };
  return new TextEncoder().encode(JSON.stringify(canonical(operation)));
}

export function operationDigest(operation: ExecutorOperation): string {
  return new Bun.CryptoHasher("sha256")
    .update(canonicalOperationBytes(operation))
    .digest("hex");
}

export function sameScope(left: LedgerScope, right: LedgerScope): boolean {
  return (
    left.executorId === right.executorId &&
    left.rootId === right.rootId &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.generation === right.generation
  );
}

export function isTerminal(state: ExecutorReceiptState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export function recoveryError(mutation: boolean): LedgerError {
  return {
    code: "operation_failed",
    message: mutation
      ? "executor restarted after accepting mutation; external effects are uncertain"
      : "executor restarted before the read completed; retry the read",
    ...(mutation ? { ambiguous: true } : {}),
  };
}

export function applyTransition(
  current: LedgerRecord,
  next: { state: "running" } | LedgerTerminalTransition,
): LedgerRecord {
  if (next.state === "running") {
    return {
      ...structuredClone(current),
      receipt: { ...current.receipt, state: "running" },
    };
  }
  const receipt: ExecutorReceipt = {
    ...current.receipt,
    state: next.state,
    completedAt: next.completedAt,
  };
  if (next.state === "succeeded") {
    if (!isExecutorOutcomeCompatible(current.operation, next.outcome))
      throw new Error("executor outcome is incompatible with operation");
    return {
      ...identityFields(current),
      receipt,
      outcome: structuredClone(next.outcome),
      ...(next.events?.length ? { events: structuredClone(next.events) } : {}),
    };
  }
  return {
    ...identityFields(current),
    receipt,
    error:
      next.state === "failed"
        ? structuredClone(next.error)
        : structuredClone(
            next.error ?? { code: "cancelled", message: "operation cancelled" },
          ),
  };
}

function identityFields(record: LedgerRecord): LedgerCommandIdentity {
  return {
    executorId: record.executorId,
    rootId: record.rootId,
    sessionId: record.sessionId,
    runId: record.runId,
    generation: record.generation,
    requestId: record.requestId,
    ...(record.idempotencyKey !== undefined
      ? { idempotencyKey: record.idempotencyKey }
      : {}),
    operationDigest: record.operationDigest,
    operation: structuredClone(record.operation),
  };
}

function scopeKey(identity: LedgerScope): string {
  return JSON.stringify([
    identity.executorId,
    identity.rootId,
    identity.sessionId,
    identity.runId,
    identity.generation,
  ]);
}

function commandKey(identity: LedgerCommandIdentity): string {
  const scope = scopeKey(identity);
  return identity.idempotencyKey === undefined
    ? `${scope}:request:${identity.requestId}`
    : `${scope}:mutation:${identity.idempotencyKey}`;
}

function assertClaimCoherent(
  identity: LedgerCommandIdentity,
  receipt: ExecutorReceipt,
): void {
  const operation = decodeExecutorOperation(identity.operation);
  const operationKey =
    operation && "idempotencyKey" in operation
      ? operation.idempotencyKey
      : undefined;
  if (
    !decodeExecutorId(identity.executorId) ||
    !decodeExecutorId(identity.rootId) ||
    !decodeExecutorId(identity.sessionId) ||
    !decodeExecutorId(identity.runId) ||
    !decodeExecutorId(identity.requestId) ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 0 ||
    !operation ||
    identity.operationDigest !== operationDigest(operation) ||
    operationKey !== identity.idempotencyKey ||
    !decodeExecutorId(receipt.receiptId) ||
    receipt.requestId !== identity.requestId ||
    receipt.idempotencyKey !== identity.idempotencyKey ||
    receipt.state !== "queued" ||
    receipt.completedAt !== undefined ||
    !isIsoDate(receipt.acceptedAt)
  )
    throw new Error("incoherent initial command claim");
}

function isIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
