#!/usr/bin/env bun
/**
 * Offline schema-23 placement migration.
 *
 * The gateway and actor service must both be stopped. Each session cutover is
 * independently crash-safe, so rerunning resumes from the remaining central
 * rows without dual-writing or revisiting published placements.
 */
import { SessionKernelStoreHost } from "../packages/core/opensession-server/src/server/session-kernel/store-host";

const batchSize = 10;
const host = new SessionKernelStoreHost();
let migrated = 0;
const startedAt = performance.now();
try {
  while (true) {
    const count = host.migrateLegacySessions(batchSize);
    migrated += count;
    if (count === 0) break;
    if (migrated % 100 === 0)
      console.log(`[session-kernel-migration] migrated ${migrated} sessions`);
  }
  const remaining = host.central.legacySessionIds(1);
  if (remaining.length > 0)
    throw new Error(`Legacy session migration stopped before ${remaining[0]}`);
  console.log(
    `[session-kernel-migration] complete: ${migrated} session(s) in ${Math.round(performance.now() - startedAt)}ms`,
  );
} finally {
  host.close();
}
