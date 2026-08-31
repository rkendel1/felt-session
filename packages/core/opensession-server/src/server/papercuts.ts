/**
 * Papercuts — a cross-session friction log. Any run (interactive session,
 * Slack, automation) can log a one-or-two-sentence papercut in the moment via
 * the opensession-papercuts in-process MCP server: a tool call that missed and
 * had to be retried, a flaky command, a stale cache, a misleading error, an
 * undocumented gotcha. None are blocking on their own — logged together they
 * show where a repo and its tooling need sanding down.
 *
 * Storage: managed FeltDB records tagged with repo/session/model/run kind. Every
 * entry is ALSO emitted as a `papercut` audit event, so the nightly audit
 * digest (/api/audit/digest → the Dreaming automation) sees the day's
 * papercuts with no extra plumbing.
 *
 * Config (Settings → Papercuts): managed FeltDB singleton
 *   { "repos": { "<repoId>": { "enabled": false } } }
 * Per-repo, default ON — a repo that opts out neither carries the tool nor
 * gets the "log papercuts" nudge in its runs. Read fresh per call.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { audit } from "./audit";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";
import { REPOS } from "./worktree";

const PAPERCUTS_DIR = stateDir("papercuts");
const ENTRY_COLLECTION = "opensession_papercuts";
const CONFIG_COLLECTION = "opensession_papercuts_config";
const CONFIG_ID = "config";
const MIGRATION = "papercuts-jsonl-to-managed-feltdb-v1";
let papercutsDb: StateFirstDB | undefined;
let entries: PapercutEntry[] = [];
let config: PapercutsConfigFile = {};

export interface PapercutEntry {
  ts: string;
  message: string;
  /** Registered repo id the friction belongs to (undefined = opensession/general). */
  repo?: string;
  sessionId?: string;
  model?: string;
  /** Journal-style run kind: prompt, slack, automation, … */
  runKind?: string;
  /** Who was driving: a user, or "<name> (automation)". */
  by?: string;
}

const MAX_MESSAGE_CHARS = 1000;

export async function logPapercut(entry: Omit<PapercutEntry, "ts">): Promise<PapercutEntry> {
  const message = (entry.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) throw new Error("papercut message is empty");
  const full: PapercutEntry = { ...entry, message, ts: new Date().toISOString() };
  const db = papercutsDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<PapercutEntry>(ENTRY_COLLECTION).set(crypto.randomUUID(), full);
  }, { transactionId: `opensession:papercut:add:${crypto.randomUUID()}` });
  entries.push(full);
  // Mirror into the audit log so buildAuditDigest (and through it the nightly
  // Dreaming automation) picks papercuts up alongside errors and tool stats.
  audit({
    kind: "papercut",
    session_id: entry.sessionId,
    run_kind: entry.runKind,
    repo: entry.repo,
    model: entry.model,
    by: entry.by,
    message,
  });
  return full;
}

/** Recent papercuts, newest first. Scans at most `days` daily files back. */
export function listPapercuts(opts?: {
  repo?: string;
  days?: number;
  limit?: number;
}): PapercutEntry[] {
  const days = Math.min(120, Math.max(1, opts?.days || 14));
  const limit = Math.min(1000, Math.max(1, opts?.limit || 200));
  const cutoff = Date.now() - days * 86_400_000;
  return entries
    .filter((entry) => Date.parse(entry.ts) >= cutoff && (!opts?.repo || entry.repo === opts.repo))
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
    .slice(0, limit)
    .map((entry) => structuredClone(entry));
}

// ── Per-repo config ──────────────────────────────────────────────────────────

interface PapercutsConfigFile {
  repos?: Record<string, { enabled?: boolean }>;
}

function readConfig(): PapercutsConfigFile {
  return structuredClone(config);
}

/** Default ON: only an explicit `enabled: false` turns a repo off, and an
 *  unknown/undefined repo (session-only sessions) always logs. */
export function papercutsEnabledForRepo(repoId: string | undefined): boolean {
  if (!repoId) return true;
  return readConfig().repos?.[repoId]?.enabled !== false;
}

/** Every registered repo with its effective toggle (for the Settings panel). */
export function papercutsRepoConfigs(): Array<{ repoId: string; enabled: boolean }> {
  return Object.values(REPOS).map((p) => ({
    repoId: p.id,
    enabled: papercutsEnabledForRepo(p.id),
  }));
}

export async function setPapercutsEnabled(repoId: string, enabled: boolean): Promise<void> {
  if (!REPOS[repoId]) throw new Error(`unknown repo "${repoId}"`);
  const cfg = readConfig();
  cfg.repos = { ...cfg.repos, [repoId]: { ...cfg.repos?.[repoId], enabled } };
  const db = papercutsDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<PapercutsConfigFile>(CONFIG_COLLECTION).set(CONFIG_ID, cfg);
  }, { transactionId: `opensession:papercuts-config:put:${crypto.randomUUID()}` });
  config = cfg;
}

export async function initializeManagedPapercuts(
  db: StateFirstDB = papercutsDb ?? managedFeltDb(),
): Promise<void> {
  papercutsDb = db;
  if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
    let legacyConfig: PapercutsConfigFile = {};
    try { legacyConfig = JSON.parse(readFileSync(`${PAPERCUTS_DIR}/config.json`, "utf8")); } catch {}
    const legacyEntries: Array<{ id: string; entry: PapercutEntry }> = [];
    if (existsSync(PAPERCUTS_DIR)) for (const name of readdirSync(PAPERCUTS_DIR)) {
      if (!/^papercuts-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const path = `${PAPERCUTS_DIR}/${name}`;
      for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as PapercutEntry;
          const id = createHash("sha256").update(`${name}\n${index}\n${line}`).digest("hex");
          legacyEntries.push({ id, entry });
        } catch {}
      }
    }
    for (const legacy of legacyEntries) await db.transaction((tx) => {
      tx.collection<PapercutEntry>(ENTRY_COLLECTION).set(legacy.id, legacy.entry);
    }, { transactionId: `opensession:papercut:migrate:${legacy.id}` });
    await db.transaction((tx) => {
      tx.collection<PapercutsConfigFile>(CONFIG_COLLECTION).set(CONFIG_ID, legacyConfig);
      tx.collection("opensession_migrations").set(MIGRATION,
        { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
  }
  if (existsSync(PAPERCUTS_DIR)) {
    for (const name of readdirSync(PAPERCUTS_DIR)) {
      if (name === "config.json" || /^papercuts-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) {
        unlinkSync(`${PAPERCUTS_DIR}/${name}`);
      }
    }
    if (readdirSync(PAPERCUTS_DIR).length === 0) rmdirSync(PAPERCUTS_DIR);
  }
  entries = await db.collection<PapercutEntry>(ENTRY_COLLECTION).all();
  config = await db.collection<PapercutsConfigFile>(CONFIG_COLLECTION).get(CONFIG_ID) ?? {};
}
