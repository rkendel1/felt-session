/**
 * FeltDB is the sole durable command ledger authority.
 *
 * This module provides the single production entry point to create a
 * DurableCommandLedger backed by FeltDB. The ledger is required for crash
 * recovery, execution state durability, and atomic command tracking.
 */
import { join } from "node:path";
import type { DurableCommandLedger } from "./ledger";
import { openFeltDbCommandLedger } from "./feltdb-ledger";

/** A ledger plus the disposal its backend needs. FeltDB closes asynchronously. */
export interface OpenCommandLedger extends DurableCommandLedger {
  close(): void | Promise<void>;
}

export interface OpenCommandLedgerOptions {
  /** FeltDB state directory. Defaults to `<dbPath>.feltdb`. */
  feltdbPath?: string;
  /** Legacy dbPath parameter kept for compatibility, but ignored. */
  dbPath?: string;
  capacity?: number;
  maxRecordBytes?: number;
  maxStringBytes?: number;
  maxEvents?: number;
}

export function openCommandLedger(
  options: OpenCommandLedgerOptions,
): OpenCommandLedger {
  const {
    dbPath,
    feltdbPath,
    ...limits
  } = options;
  const path = feltdbPath ?? defaultFeltDbPath(dbPath);
  return openFeltDbCommandLedger({
    path,
    ...limits,
  });
}

function defaultFeltDbPath(dbPath?: string): string {
  if (!dbPath) throw new Error("FeltDB path must be provided");
  return join(`${dbPath}.feltdb`);
}
