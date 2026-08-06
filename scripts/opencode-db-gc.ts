/**
 * opencode engine-DB garbage collector (Phase 1 of the 2026-07-17 storage
 * review). opencode's EventV2 store persists the full accumulated part JSON
 * every streaming tick as durable events and never prunes them — the event
 * table reaches 84–90% of multi-GB DB files (upstream #33356, unfixed; our
 * compaction semantics follow upstream PR #36710).
 *
 * For every engine DB (legacy main, per-account openai, per-server shards):
 *   1. Compact the event log: keep only the max-seq event per aggregate,
 *      only for aggregates with no sync owner (event_sequence.owner_id IS
 *      NULL — all of ours; owner_id marks a live opencode sync client we
 *      must not compact under). Batched per-aggregate deletes so lock holds
 *      stay short against live servers.
 *   2. Checkpoint + truncate the WAL (safe on live DBs).
 *   3. VACUUM only when no process has the DB open (checked via fuser).
 *   4. Shard GC: unlink shard DBs idle > SHARD_RETENTION_DAYS. Respawns of
 *      the same server key reuse the same shard path, so recent files stay
 *      even without a live registry entry.
 *
 * Emits audit events (opencode_db_gc) into the opensession audit log and
 * warns to a Slack DM when a DB is still over the size alert threshold
 * after GC. `--dry-run` reports what would happen without touching data.
 *
 * Runs from cron (04:00 UTC daily); safe to run by hand any time:
 *   bun scripts/opencode-db-gc.ts --dry-run
 */
import { homeDir } from "../src/server/paths";
import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { appendFileSync, existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "fs";
import { configuredIntegration, personaName } from "../src/server/config";

const HOME = homeDir();
const DRY = process.argv.includes("--dry-run");
const MAIN_DB = `${HOME}/.local/share/opencode/opencode.db`;
const OPENAI_DATA_ROOT = `${HOME}/.opensession-opencode/openai-data`;
const SHARD_DIR = `${HOME}/.opensession-sessions/opencode/db`;
const MERIDIAN_SESSION_ROOT = `${HOME}/.opensession-opencode/meridian-sessions`;
const AUDIT_DIR = `${HOME}/.opensession-audit`;
const SHARD_RETENTION_DAYS = 14;
const SIZE_ALERT_BYTES = 2 * 1024 ** 3; // post-GC alert threshold
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const configuredAlertChannel = configuredIntegration("accountHealth").slackChannel;
const SLACK_CHANNEL =
  process.env.OPENSESSION_DB_GC_SLACK_CHANNEL ||
  (typeof configuredAlertChannel === "string" ? configuredAlertChannel : "");

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function audit(fields: Record<string, unknown>): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(
      `${AUDIT_DIR}/audit-${day}.jsonl`,
      JSON.stringify({ time: new Date().toISOString(), service: "opensession", msg: "opencode_db_gc", ...fields }) + "\n"
    );
  } catch {}
}

function dbOpenByLiveProcess(path: string): boolean {
  try {
    execSync(`fuser -s ${JSON.stringify(path)} 2>/dev/null`);
    return true; // fuser exits 0 when a process holds the file
  } catch {
    return false;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function discoverDbs(): string[] {
  const dbs: string[] = [];
  if (existsSync(MAIN_DB)) dbs.push(MAIN_DB);
  try {
    for (const acct of readdirSync(OPENAI_DATA_ROOT)) {
      const p = `${OPENAI_DATA_ROOT}/${acct}/opencode/opencode.db`;
      if (existsSync(p)) dbs.push(p);
    }
  } catch {}
  try {
    for (const f of readdirSync(SHARD_DIR)) {
      if (f.endsWith(".db")) dbs.push(`${SHARD_DIR}/${f}`);
    }
  } catch {}
  return dbs;
}

function compactEvents(path: string): { deleted: number; aggregates: number } {
  // bun:sqlite quirk: an options object with `readonly: false` produces zero
  // open-flags (SQLITE_MISUSE) — write mode must say `readwrite` explicitly.
  const db = new Database(path, DRY ? { readonly: true } : { readwrite: true });
  let deleted = 0;
  let aggregates = 0;
  try {
    db.exec?.("PRAGMA busy_timeout = 10000");
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('event','event_sequence')")
      .all() as Array<{ name: string }>;
    if (tables.length < 2) return { deleted: 0, aggregates: 0 };
    // Owner-less aggregates with more than one event are compaction targets.
    const targets = db
      .query(
        `SELECT e.aggregate_id AS agg, MAX(e.seq) AS maxseq, COUNT(*) AS n
         FROM event e JOIN event_sequence s ON s.aggregate_id = e.aggregate_id
         WHERE s.owner_id IS NULL
         GROUP BY e.aggregate_id HAVING COUNT(*) > 1`
      )
      .all() as Array<{ agg: string; maxseq: number; n: number }>;
    for (const t of targets) {
      aggregates++;
      if (DRY) {
        deleted += t.n - 1;
        continue;
      }
      // One short transaction per aggregate keeps write-lock holds bounded
      // against live servers.
      const del = db.query("DELETE FROM event WHERE aggregate_id = ? AND seq < ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        del.run(t.agg, t.maxseq);
        db.exec("COMMIT");
        deleted += t.n - 1;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        log(`  ! compaction skipped for aggregate ${t.agg}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!DRY) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {}
    }
  } finally {
    db.close();
  }
  return { deleted, aggregates };
}

function vacuumIfIdle(path: string): "vacuumed" | "skipped-live" | "skipped-dry" {
  if (DRY) return "skipped-dry";
  if (dbOpenByLiveProcess(path)) return "skipped-live";
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("VACUUM");
    return "vacuumed";
  } finally {
    db.close();
  }
}

/** Per-(server key x account) Meridian session stores (MERIDIAN_SESSION_ROOT in
 *  opencode-runner.ts). One directory per server key, so `bks-*` per-session
 *  servers mint one each and never revisit it — drop the ones whose store has
 *  not been written in SHARD_RETENTION_DAYS. Losing a cold store costs nothing:
 *  a conversation that old is not resuming, and if it did, Meridian would
 *  replay it into a fresh SDK session exactly as it does for an evicted entry. */
function gcMeridianSessionStores(): number {
  let removed = 0;
  const cutoff = Date.now() - SHARD_RETENTION_DAYS * 864e5;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        // Prune the key directory once its account subdirs are gone.
        try {
          if (readdirSync(p).length === 0 && !DRY) rmdirSync(p);
        } catch {}
        continue;
      }
      if (name !== "sessions.json" || st.mtimeMs > cutoff) continue;
      try {
        if (!DRY) {
          unlinkSync(p);
          try {
            rmdirSync(dir);
          } catch {}
        }
        removed++;
        log(`  meridian store GC${DRY ? " (dry)" : ""}: ${p.slice(MERIDIAN_SESSION_ROOT.length + 1)} (idle > ${SHARD_RETENTION_DAYS}d)`);
      } catch {}
    }
  };
  try {
    walk(MERIDIAN_SESSION_ROOT);
  } catch {}
  return removed;
}

function gcShards(): number {
  let removed = 0;
  const cutoff = Date.now() - SHARD_RETENTION_DAYS * 864e5;
  try {
    for (const f of readdirSync(SHARD_DIR)) {
      if (!f.endsWith(".db")) continue;
      const p = `${SHARD_DIR}/${f}`;
      try {
        if (statSync(p).mtimeMs > cutoff) continue;
        if (dbOpenByLiveProcess(p)) continue;
        if (!DRY) {
          for (const suffix of ["", "-wal", "-shm"]) {
            try {
              unlinkSync(p + suffix);
            } catch {}
          }
        }
        removed++;
        log(`  shard GC${DRY ? " (dry)" : ""}: ${f} (idle > ${SHARD_RETENTION_DAYS}d)`);
      } catch {}
    }
  } catch {}
  return removed;
}

async function slackWarn(text: string): Promise<void> {
  if (!SLACK_TOKEN || !SLACK_CHANNEL) return;
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: SLACK_CHANNEL,
        text: `It's ${personaName()} (opencode-db-gc): ${text}`,
      }),
    });
  } catch {}
}

log(`opencode-db-gc start${DRY ? " (DRY RUN)" : ""}`);
const oversized: string[] = [];
for (const path of discoverDbs()) {
  const before = fileSize(path) + fileSize(`${path}-wal`);
  let result = { deleted: 0, aggregates: 0 };
  let vac = "error";
  try {
    result = compactEvents(path);
    vac = vacuumIfIdle(path);
  } catch (e) {
    log(`  ! ${path}: ${e instanceof Error ? e.message : e}`);
  }
  const after = fileSize(path) + fileSize(`${path}-wal`);
  log(
    `${path}: ${(before / 1e9).toFixed(2)}GB → ${(after / 1e9).toFixed(2)}GB, ` +
      `${result.deleted} events pruned across ${result.aggregates} aggregates, ${vac}`
  );
  audit({
    db: path,
    bytes_before: before,
    bytes_after: after,
    events_deleted: result.deleted,
    aggregates: result.aggregates,
    vacuum: vac,
    dry_run: DRY || undefined,
  });
  if (!DRY && after > SIZE_ALERT_BYTES) oversized.push(`${path} (${(after / 1e9).toFixed(1)}GB, ${vac})`);
}
const shardRemoved = gcShards();
const meridianStoresRemoved = gcMeridianSessionStores();
audit({
  shard_dbs_removed: shardRemoved,
  meridian_session_stores_removed: meridianStoresRemoved,
  dry_run: DRY || undefined,
});
if (oversized.length) {
  await slackWarn(
    `engine DB(s) still over ${(SIZE_ALERT_BYTES / 1e9).toFixed(0)}GB after nightly GC — ` +
      `worth a look:\n${oversized.join("\n")}`
  );
}
log("opencode-db-gc done");
