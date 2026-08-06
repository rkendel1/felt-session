#!/usr/bin/env bun
/**
 * Fleet migration of opensession sessions onto the OpenCode engine.
 *
 * Dry-run by default: lists every candidate opensession session with its current
 * engine, model, last activity, and whether a transcript exists to build the
 * cross-engine handoff from — plus everything that is skipped and why.
 * Nothing is written without --execute.
 *
 *   bun scripts/migrate-sessions-to-opencode.ts                 # dry run
 *   bun scripts/migrate-sessions-to-opencode.ts --execute       # migrate listed sessions
 *     [--filter <substr>]     only sessions whose id/title/branch contains this
 *     [--model <opencode/…>]  target for non-claude sessions (default
 *                             opencode/anthropic/claude-sonnet-5); claude-*
 *                             sessions map 1:1 to opencode/anthropic/<model>
 *     [--include-archived]    also migrate archived sessions (default: skip)
 *
 * Migration = flip session.model via migrateSessionEngine (src/server/
 * migrate-engine.ts); the next prompt on each session performs the actual
 * handoff. HARD-SKIPPED, never migrated: automation-owned sessions (the
 * opencode runner deny-by-default gate refuses automation runs) and sessions
 * with an in-flight run in the shared run journal. Slack/Linear-store sessions
 * aren't touched either — this script only operates on the opensession store.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../src/server/paths";
import { providerFor } from "../src/server/models";
import { getEngineTranscriptPath } from "../src/server/sessions";
import { isOpencodeSessionId, hasOpencodeTranscript } from "../src/server/opencode-transcript";
import {
  migrateSessionEngine,
  isAutomationOwnedSession,
  sessionHasJournaledRun,
} from "../src/server/migrate-engine";
import type { NativeSessionFile } from "../src/server/types";

const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const includeArchived = argv.includes("--include-archived");
const argValue = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const filter = argValue("--filter")?.toLowerCase();
const defaultTarget = argValue("--model") || "opencode/anthropic/claude-sonnet-5";

if (providerFor(defaultTarget) !== "opencode") {
  console.error(`--model must be an opencode/<provider>/<model> id (got "${defaultTarget}")`);
  process.exit(1);
}

/** Tier-preserving mapping: claude-* models map 1:1 onto the anthropic
 *  bridge, gpt-* map 1:1 onto opencode/openai (auth keys off the codex
 *  accounts pool — opencode-openai-auth.ts), and the codex "best available"
 *  alias lands on the current best openai model. Anything else (unset
 *  models) gets the default target. */
function targetFor(model: string | undefined): string {
  if (model?.startsWith("claude-")) return `opencode/anthropic/${model}`;
  if (model?.startsWith("gpt-")) return `opencode/openai/${model}`;
  if (model?.startsWith("codex")) return "opencode/openai/gpt-5.5";
  return defaultTarget;
}

interface Row {
  id: string;
  title: string;
  engine: string;
  model: string;
  lastActivity: string;
  handoff: string;
  target?: string;
  skip?: string;
}

const SKIP_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
  "prompt-queues.json",
  "active-at-shutdown.json",
  "active-runs.json",
  "archive-registry.json",
]);

const rows: Row[] = [];
for (const file of readdirSync(OPENSESSION_SESSIONS_DIR)) {
  if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
  let data: NativeSessionFile;
  try {
    data = JSON.parse(readFileSync(`${OPENSESSION_SESSIONS_DIR}/${file}`, "utf-8"));
  } catch {
    continue;
  }
  if (!data?.id) continue;

  const provider = data.lastEngineProvider || providerFor(data.model);
  const legacyOcRide = isOpencodeSessionId(data.claudeSessionId);
  const claudePath =
    data.claudeSessionId && !legacyOcRide
      ? getEngineTranscriptPath(data.worktreeDir || "", data.claudeSessionId, "claude")
      : null;
  const codexPath = data.codexThreadId
    ? getEngineTranscriptPath(data.worktreeDir || "", data.codexThreadId, "codex")
    : null;
  const handoffSources = [
    claudePath && existsSync(claudePath) ? "claude-jsonl" : null,
    codexPath ? "codex-rollout" : null,
    (data.opencodeSessionId && hasOpencodeTranscript(data.opencodeSessionId)) ||
    (legacyOcRide && hasOpencodeTranscript(data.claudeSessionId))
      ? "opencode-store"
      : null,
  ].filter(Boolean) as string[];

  const row: Row = {
    id: data.id,
    title: (data.title || data.branch || "").slice(0, 48),
    engine: provider,
    model: data.model || "(default)",
    lastActivity: (data.lastActivity || data.createdAt || "").slice(0, 16),
    handoff: handoffSources.join("+") || "none",
  };

  if (filter) {
    const hay = `${data.id} ${data.title || ""} ${data.branch || ""}`.toLowerCase();
    if (!hay.includes(filter)) continue;
  }

  if (isAutomationOwnedSession(data)) row.skip = "automation-owned";
  else if (sessionHasJournaledRun(data.id, data)) row.skip = "active run";
  else if (provider === "opencode" || data.model?.startsWith("opencode/"))
    row.skip = "already opencode";
  else if (data.archived && !includeArchived) row.skip = "archived";
  else row.target = targetFor(data.model);

  rows.push(row);
}

rows.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

const candidates = rows.filter((r) => !r.skip);
const skipped = rows.filter((r) => r.skip);

const fmt = (r: Row) =>
  `  ${r.id}  [${r.engine}] ${r.model}  last ${r.lastActivity || "?"}  handoff:${r.handoff}` +
  (r.target ? `  → ${r.target}` : "") +
  (r.skip ? `  (SKIP: ${r.skip})` : "") +
  (r.title ? `\n      ${r.title}` : "");

console.log(`Open Session session store: ${OPENSESSION_SESSIONS_DIR}`);
console.log(`\n${candidates.length} session(s) would migrate:\n`);
for (const r of candidates) console.log(fmt(r));
console.log(`\n${skipped.length} skipped:\n`);
for (const r of skipped) console.log(fmt(r));

const byEngine = (list: Row[]) => {
  const counts: Record<string, number> = {};
  for (const r of list) counts[r.engine] = (counts[r.engine] || 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
};
const noHandoff = candidates.filter((r) => r.handoff === "none").length;
console.log(`\nCounts — candidates by engine: ${byEngine(candidates)}`);
console.log(`         skipped by engine:    ${byEngine(skipped) || "(none)"}`);
if (noHandoff) {
  console.log(
    `         ${noHandoff} candidate(s) have NO transcript for the handoff — ` +
      "they migrate but the opencode session starts without conversational context."
  );
}

if (!execute) {
  console.log("\nDry run — nothing written. Re-run with --execute to migrate the candidates above.");
  process.exit(0);
}

console.log("\nExecuting…");
let ok = 0;
let failed = 0;
for (const r of candidates) {
  const res = migrateSessionEngine(r.id, r.target!, "migrate-sessions-to-opencode");
  if (res.ok) {
    ok++;
    console.log(`  ✓ ${r.id} → ${res.to}${res.from ? ` (was ${res.from})` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${r.id}: ${res.error}`);
  }
}
console.log(`\nDone: ${ok} migrated, ${failed} failed. Each session hands off on its next prompt.`);
