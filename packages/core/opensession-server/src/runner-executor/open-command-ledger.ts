/**
 * The single place that decides which DurableCommandLedger a process runs on.
 *
 * Phase 2 of adrs/feltdb-native-durable-substrate.md ends here deliberately:
 * the FeltDB backend exists, passes the shared contract suite, and is reachable
 * by configuration, but SQLite stays the default so this phase changes no
 * behavior. Phase 3 turns this switch into a dual-write wrapper; Phase 4 changes
 * the default. Callers hold DurableCommandLedger, so neither step reaches them.
 */
import { join } from "node:path";
import type { DurableCommandLedger } from "./ledger";
import { openSQLiteCommandLedger } from "./sqlite-ledger";
import { openFeltDbCommandLedger } from "./feltdb-ledger";

export type CommandLedgerBackend = "sqlite" | "feltdb";

/** A ledger plus the disposal its backend needs. FeltDB closes asynchronously. */
export interface OpenCommandLedger extends DurableCommandLedger {
  close(): void | Promise<void>;
}

export interface OpenCommandLedgerOptions {
  /** Defaults to "sqlite" until the dual-write phase validates FeltDB. */
  backend?: CommandLedgerBackend;
  /** SQLite database file. Also anchors the default FeltDB directory. */
  dbPath: string;
  /** FeltDB state directory. Defaults to `<dbPath>.feltdb`, keeping the two
   *  backends side by side so a dual-write phase needs no new path config. */
  feltdbPath?: string;
  capacity?: number;
  busyTimeoutMs?: number;
  maxRecordBytes?: number;
  maxStringBytes?: number;
  maxEvents?: number;
}

export function commandLedgerBackend(
  value: string | undefined,
): CommandLedgerBackend {
  if (value === undefined || value === "") return "sqlite";
  if (value !== "sqlite" && value !== "feltdb")
    throw new Error(`unknown command ledger backend ${value}`);
  return value;
}

export function openCommandLedger(
  options: OpenCommandLedgerOptions,
): OpenCommandLedger {
  const {
    backend = "sqlite",
    dbPath,
    feltdbPath,
    busyTimeoutMs,
    ...limits
  } = options;
  if (backend === "feltdb")
    return openFeltDbCommandLedger({
      path: feltdbPath ?? defaultFeltDbPath(dbPath),
      ...limits,
    });
  return openSQLiteCommandLedger({
    dbPath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    ...limits,
  });
}

function defaultFeltDbPath(dbPath: string): string {
  return join(`${dbPath}.feltdb`);
}
