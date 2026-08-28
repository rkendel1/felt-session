/**
 * Ledger record codec and validation.
 *
 * Provides encoding and validation for DurableCommandLedger records.
 * A record rejected by this validator is rejected by all backends, and
 * a record read back from storage has been through the same checks as when
 * it was written. The rules here describe LedgerRecord itself and carry
 * no assumptions about how a backend lays records out on disk.
 */
import {
  decodeExecutorOperation,
  isExecutorOutcomeCompatible,
  type ExecutorOperationOutcome,
  type ExecutorReceipt,
  type ExecutorStreamEvent,
} from "@tellahq/opensession-protocol/executor";
import {
  operationDigest,
  type LedgerRecord,
  type LedgerScope,
} from "./ledger";

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export const DIGEST_RE = /^[a-f0-9]{64}$/;
const STATES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const ERROR_CODES = new Set([
  "invalid_request",
  "invalid_grant",
  "stale_generation",
  "deadline_exceeded",
  "not_found",
  "conflict",
  "cancelled",
  "operation_failed",
  "executor_busy",
  "unsupported",
]);
const encoder = new TextEncoder();

/** Byte and cardinality ceilings applied to every stored record. */
export interface LedgerLimits {
  maxRecordBytes: number;
  maxStringBytes: number;
  maxEvents: number;
}

export const DEFAULT_LEDGER_LIMITS: LedgerLimits = {
  maxRecordBytes: 8 * 1024 * 1024,
  maxStringBytes: 256 * 1024,
  maxEvents: 4_096,
};

/** Validate then serialize, so nothing invalid can reach a backend. */
export function encodeRecord(
  record: LedgerRecord,
  limits: LedgerLimits,
): string {
  validateRecord(record, limits);
  const encoded = JSON.stringify(record);
  if (encoder.encode(encoded).byteLength > limits.maxRecordBytes)
    throw new Error("ledger record exceeds byte limit");
  return encoded;
}

/** Parse then validate, so a corrupted or tampered payload cannot be served. */
export function decodeRecord(
  payload: string,
  limits: LedgerLimits,
): LedgerRecord {
  if (encoder.encode(payload).byteLength > limits.maxRecordBytes)
    throw new Error("persisted ledger record exceeds byte limit");
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("malformed ledger JSON");
  }
  validateRecord(value, limits);
  return value as LedgerRecord;
}

export function validateRecord(
  value: unknown,
  limits: LedgerLimits,
): asserts value is LedgerRecord {
  if (
    !plainObject(value) ||
    !onlyKeys(value, [
      "executorId",
      "rootId",
      "sessionId",
      "runId",
      "generation",
      "requestId",
      "idempotencyKey",
      "operationDigest",
      "operation",
      "receipt",
      "outcome",
      "events",
      "error",
    ])
  )
    throw new Error("invalid ledger record");
  validateScope(value as unknown as LedgerScope);
  validateId(value.requestId, "requestId");
  if (
    value.idempotencyKey !== undefined &&
    !boundedString(value.idempotencyKey, limits.maxStringBytes, true)
  )
    throw new Error("invalid idempotencyKey");
  if (
    typeof value.operationDigest !== "string" ||
    !DIGEST_RE.test(value.operationDigest)
  )
    throw new Error("invalid operation digest");
  const operation = decodeExecutorOperation(value.operation);
  if (
    !operation ||
    operationDigest(operation) !== value.operationDigest ||
    ("idempotencyKey" in operation ? operation.idempotencyKey : undefined) !==
      value.idempotencyKey
  )
    throw new Error("operation identity mismatch");
  validateReceipt(value.receipt, value.requestId, value.idempotencyKey);
  if (value.outcome !== undefined) {
    validateOutcome(value.outcome, limits);
    if (!isExecutorOutcomeCompatible(operation, value.outcome))
      throw new Error("executor outcome is incompatible with operation");
  }
  if (value.events !== undefined) {
    validateEvents(value.events, limits);
    const outcome = value.outcome as unknown;
    const streamId =
      plainObject(outcome) && typeof outcome.streamId === "string"
        ? outcome.streamId
        : undefined;
    if (!streamId || value.events.some((event) => event.streamId !== streamId))
      throw new Error("ledger event stream does not match outcome");
  }
  if (value.error !== undefined) validateError(value.error, limits);
  const state = (value.receipt as ExecutorReceipt).state;
  if (
    (state === "queued" || state === "running") &&
    (value.outcome !== undefined ||
      value.events !== undefined ||
      value.error !== undefined)
  )
    throw new Error("active record has terminal payload");
  if (
    state === "succeeded" &&
    (value.outcome === undefined || value.error !== undefined)
  )
    throw new Error("succeeded record is incoherent");
  if (
    (state === "failed" || state === "cancelled") &&
    (value.error === undefined ||
      value.outcome !== undefined ||
      value.events !== undefined)
  )
    throw new Error("failed record is incoherent");
}
function validateReceipt(
  value: unknown,
  requestId: string,
  key: string | undefined,
): asserts value is ExecutorReceipt {
  if (
    !plainObject(value) ||
    !onlyKeys(value, [
      "receiptId",
      "requestId",
      "state",
      "acceptedAt",
      "idempotencyKey",
      "completedAt",
    ])
  )
    throw new Error("invalid receipt");
  validateId(value.receiptId, "receiptId");
  const terminal =
    value.state === "succeeded" ||
    value.state === "failed" ||
    value.state === "cancelled";
  if (
    value.requestId !== requestId ||
    value.idempotencyKey !== key ||
    typeof value.state !== "string" ||
    !STATES.has(value.state) ||
    !isoDate(value.acceptedAt) ||
    terminal !== (value.completedAt !== undefined) ||
    (value.completedAt !== undefined && !isoDate(value.completedAt))
  )
    throw new Error("invalid receipt identity or fields");
}
function validateError(value: unknown, limits: LedgerLimits): void {
  if (
    !plainObject(value) ||
    !onlyKeys(value, ["code", "message", "ambiguous"]) ||
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code) ||
    !boundedString(value.message, limits.maxStringBytes, true) ||
    (value.ambiguous !== undefined && typeof value.ambiguous !== "boolean")
  )
    throw new Error("invalid ledger error");
}
function validateOutcome(
  value: unknown,
  limits: LedgerLimits,
): asserts value is ExecutorOperationOutcome {
  if (!plainObject(value) || typeof value.kind !== "string")
    throw new Error("invalid outcome");
  const id = (v: unknown) => boundedString(v, 256, true);
  if (
    value.kind === "fs.read" &&
    onlyKeys(value, ["kind", "streamId", "size", "binary"]) &&
    id(value.streamId) &&
    nonnegative(value.size) &&
    typeof value.binary === "boolean"
  )
    return;
  if (
    value.kind === "fs.list" &&
    onlyKeys(value, ["kind", "entries"]) &&
    Array.isArray(value.entries) &&
    value.entries.length <= limits.maxEvents &&
    value.entries.every(
      (e) =>
        plainObject(e) &&
        onlyKeys(e, ["path", "type", "size"]) &&
        boundedString(e.path, limits.maxStringBytes, true) &&
        ["file", "directory", "symlink"].includes(e.type as string) &&
        (e.size === undefined || nonnegative(e.size)),
    )
  )
    return;
  if (
    value.kind === "fs.stat" &&
    onlyKeys(value, ["kind", "entry"]) &&
    plainObject(value.entry) &&
    onlyKeys(value.entry, ["path", "type", "size", "modifiedAt"]) &&
    boundedString(value.entry.path, limits.maxStringBytes, true) &&
    ["file", "directory", "symlink"].includes(value.entry.type as string) &&
    nonnegative(value.entry.size) &&
    (value.entry.modifiedAt === undefined || isoDate(value.entry.modifiedAt))
  )
    return;
  if (
    value.kind === "fs.changed" &&
    onlyKeys(value, ["kind", "path"]) &&
    boundedString(value.path, limits.maxStringBytes, true)
  )
    return;
  const specs: Record<string, [string, string, string[], string]> = {
    process: [
      "processId",
      "state",
      ["starting", "running", "exited"],
      "exitCode",
    ],
    terminal: ["terminalId", "state", ["open", "closed"], ""],
    service: [
      "serviceId",
      "state",
      ["starting", "running", "stopped", "failed"],
      "",
    ],
    portal: ["portalId", "state", ["opening", "open", "closed", "failed"], ""],
  };
  const spec = specs[value.kind];
  if (spec) {
    const [idKey, stateKey, states, exitKey] = spec;
    const allowed = ["kind", idKey, stateKey];
    if (value.kind !== "portal") allowed.push("streamId");
    if (exitKey) allowed.push(exitKey);
    if (
      onlyKeys(value, allowed) &&
      id(value[idKey]) &&
      states.includes(value[stateKey] as string) &&
      (value.streamId === undefined || id(value.streamId)) &&
      (!exitKey ||
        value[exitKey] === undefined ||
        Number.isSafeInteger(value[exitKey]))
    )
      return;
  }
  throw new Error("invalid outcome");
}
function validateEvents(
  value: unknown,
  limits: LedgerLimits,
): asserts value is ExecutorStreamEvent[] {
  if (!Array.isArray(value) || value.length > limits.maxEvents)
    throw new Error("invalid ledger events");
  const sequences = new Map<string, number>();
  for (const event of value) {
    const previousSequence = plainObject(event)
      ? sequences.get(event.streamId as string)
      : undefined;
    if (
      !plainObject(event) ||
      !boundedString(event.streamId, 256, true) ||
      !nonnegative(event.sequence) ||
      (previousSequence !== undefined &&
        event.sequence !== previousSequence + 1)
    )
      throw new Error("invalid stream event sequence");
    sequences.set(event.streamId, event.sequence);
    const eof = event.eof === undefined || typeof event.eof === "boolean";
    if (
      event.kind === "text" &&
      onlyKeys(event, [
        "kind",
        "streamId",
        "sequence",
        "channel",
        "data",
        "eof",
      ]) &&
      ["stdout", "stderr", "terminal", "file"].includes(
        event.channel as string,
      ) &&
      boundedString(event.data, limits.maxStringBytes) &&
      eof
    )
      continue;
    if (
      event.kind === "exit" &&
      onlyKeys(event, ["kind", "streamId", "sequence", "exitCode", "signal"]) &&
      (event.exitCode === null || Number.isSafeInteger(event.exitCode)) &&
      (event.signal === undefined || boundedString(event.signal, 256, true))
    )
      continue;
    if (
      event.kind === "binary" &&
      onlyKeys(event, [
        "kind",
        "streamId",
        "sequence",
        "offset",
        "data",
        "metadata",
        "eof",
      ]) &&
      nonnegative(event.offset) &&
      boundedString(event.data, limits.maxStringBytes) &&
      eof &&
      validBinary(event)
    )
      continue;
    throw new Error("invalid stream event");
  }
}
function validBinary(event: Record<string, unknown>): boolean {
  const metadata = event.metadata;
  if (
    !plainObject(metadata) ||
    !onlyKeys(metadata, ["encoding", "byteLength", "mediaType", "sha256"]) ||
    metadata.encoding !== "base64" ||
    !nonnegative(metadata.byteLength) ||
    (metadata.mediaType !== undefined &&
      !boundedString(metadata.mediaType, 256, true)) ||
    (metadata.sha256 !== undefined &&
      (typeof metadata.sha256 !== "string" || !DIGEST_RE.test(metadata.sha256)))
  )
    return false;
  try {
    const decoded = Buffer.from(event.data as string, "base64");
    return (
      decoded.toString("base64") === event.data &&
      decoded.byteLength === metadata.byteLength
    );
  } catch {
    return false;
  }
}
export function validateScope(value: LedgerScope): void {
  validateId(value.executorId, "executorId");
  validateId(value.rootId, "rootId");
  validateId(value.sessionId, "sessionId");
  validateId(value.runId, "runId");
  if (!Number.isSafeInteger(value.generation) || value.generation < 0)
    throw new Error("invalid generation");
}
export function sameScopeValues(a: LedgerScope, b: LedgerScope): boolean {
  return (
    a.executorId === b.executorId &&
    a.rootId === b.rootId &&
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    a.generation === b.generation
  );
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function boundedString(
  value: unknown,
  max: number,
  nonempty = false,
): value is string {
  return (
    typeof value === "string" &&
    (!nonempty || value.length > 0) &&
    encoder.encode(value).byteLength <= max
  );
}
export function validateId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value))
    throw new Error(`invalid ${name}`);
}
function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    new Date(value).toISOString() === value
  );
}
export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
