#!/usr/bin/env bun
/**
 * Offline fleet migration from isolated Session Kernel SQLite actors to FeltDB.
 *
 * The gateway and actor service must be stopped and remain stopped for the
 * entire run. This is intentionally the only fleet-enumerating caller: online
 * code must never walk the placement catalog or open every actor database.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  sessionKernelDbPath,
  sessionKernelSessionDbPath,
} from "../packages/core/opensession-server/src/server/session-kernel/store";
import { FeltDbSessionDecisionStore } from "../packages/core/opensession-server/src/server/session-kernel/feltdb-decision-store";
import { initializeManagedFeltDb } from "../packages/core/opensession-server/src/server/managed-feltdb";
import { migrateKernelSessionToFeltDb } from "../packages/core/opensession-server/src/server/session-kernel/feltdb-offline-migration";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
  const [key, inline] = arg.slice(2).split("=", 2);
  const value = inline ?? process.argv[++i];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
  args.set(key, value);
}

if (args.get("confirm-offline") !== "gateway-and-actor-stopped") {
  throw new Error(
    "Refusing live migration. Pass --confirm-offline gateway-and-actor-stopped only after both services are stopped",
  );
}

const centralPath = args.get("central") || sessionKernelDbPath();
const isolatedRoot = args.get("isolated-root") ||
  `${dirname(centralPath)}/session-kernel-sessions`;
const limit = args.has("limit") ? Number(args.get("limit")) : Number.MAX_SAFE_INTEGER;
if (!Number.isSafeInteger(limit) || limit < 1)
  throw new Error("--limit must be a positive safe integer");
if (!existsSync(centralPath)) throw new Error(`Session Kernel catalog does not exist: ${centralPath}`);

const catalog = new Database(centralPath, { readonly: true, strict: true });
let sessionIds: string[];
try {
  const integrity = catalog.query("PRAGMA quick_check").get() as Record<string, unknown>;
  if (!Object.values(integrity).includes("ok"))
    throw new Error("Session Kernel placement catalog failed its integrity check");
  const remainingCentral = catalog.query(`
    SELECT session_id FROM session_kernel_state state
    WHERE NOT EXISTS (
      SELECT 1 FROM session_kernel_placements placement
      WHERE placement.session_id = state.session_id
    ) LIMIT 1
  `).get() as { session_id?: string } | null;
  if (remainingCentral?.session_id)
    throw new Error(
      `Session ${remainingCentral.session_id} is still central; run scripts/migrate-session-kernel-storage.ts first`,
    );
  sessionIds = (catalog.query(`
    SELECT session_id FROM session_kernel_placements
    WHERE placement = 'isolated' ORDER BY session_id
  `).all() as Array<{ session_id: string }>).map((row) => row.session_id);
} finally {
  catalog.close();
}

const db = await initializeManagedFeltDb();
const store = new FeltDbSessionDecisionStore(db);
let migrated = 0;
let alreadyManaged = 0;
for (const sessionId of sessionIds) {
  if (await store.head(sessionId)) {
    alreadyManaged++;
    continue;
  }
  if (migrated >= limit) break;
  const sourcePath = sessionKernelSessionDbPath(sessionId, isolatedRoot);
  if (!existsSync(sourcePath))
    throw new Error(`Session ${sessionId} has no isolated actor database at ${sourcePath}`);
  const result = await migrateKernelSessionToFeltDb({
    sourcePath,
    sessionId,
    migrationId: `opensession-kernel-feltdb-v1:${sessionId}`,
    owner: "opensession-session-kernel",
    leaseId: "offline-fleet-migration-v1",
    leaseDurationMs: 365 * 24 * 60 * 60_000,
    store,
  });
  migrated++;
  console.log(
    `[kernel-feltdb] ${sessionId}: ${result.importedRecords} records in ${result.importedBatches} batches`,
  );
}

console.log(
  `[kernel-feltdb] complete: migrated=${migrated} alreadyManaged=${alreadyManaged} placements=${sessionIds.length}`,
);
