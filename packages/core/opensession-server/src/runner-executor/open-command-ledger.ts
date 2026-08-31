/**
 * FeltDB is the sole durable command ledger authority.
 *
 * This module provides the single production entry point to create a
 * DurableCommandLedger backed by FeltDB. The ledger is required for crash
 * recovery, execution state durability, and atomic command tracking.
 */
import type { StateFirstDB } from "@feltdb/core";
import type { DurableCommandLedger } from "./ledger";
import { openFeltDbCommandLedger } from "./feltdb-ledger";

/** A ledger plus the disposal its backend needs. FeltDB closes asynchronously. */
export interface OpenCommandLedger extends DurableCommandLedger {
  close(): void | Promise<void>;
}

export interface OpenCommandLedgerOptions {
	db: StateFirstDB;
  capacity?: number;
  maxRecordBytes?: number;
  maxStringBytes?: number;
  maxEvents?: number;
}

export function openCommandLedger(
  options: OpenCommandLedgerOptions,
): OpenCommandLedger {
	return openFeltDbCommandLedger(options);
}
