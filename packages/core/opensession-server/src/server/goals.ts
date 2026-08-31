/**
 * Goals: long-running, stateful agent missions.
 *
 * Unlike an Automation — which fires a *fresh, amnesiac* session on a cron tick
 * (automations.ts) — a Goal is a single managed session pursued over days/weeks.
 * It carries context across wakes (the engine session is resumed each time, so
 * the SDK compacts rather than forgets), paces itself (each wake sets its own
 * next wake), pauses for human sign-off, and stops when its success condition is
 * met. The mission is just a prompt string — nothing domain-specific lives here.
 *
 * This module is the pure data layer: the managed FeltDB store + validation. The runner
 * (which drives the session) and the ticker live in opensession.ts next to the
 * session loop ticker, because they need the interactive MCP wiring; the two MCP
 * surfaces (opensession-goals management + opensession-goal-self self-cadence) live in
 * src/agents/slack/goal-tools.ts.
 */
import { randomUUIDv7 } from "bun";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { stateDir } from "./paths";
import { managedFeltDb } from "./managed-feltdb";

const GOALS_DIR = stateDir("goals");
const GOALS_COLLECTION = "opensession_goals";
const LEDGERS_COLLECTION = "opensession_goal_ledgers";
const GOALS_MIGRATION = "goals-files-to-managed-feltdb-v1";

export type GoalStatus = "active" | "paused" | "done" | "failed";

export interface Goal {
  id: string;
  name: string;
  /** The mission prompt — the whole point of the goal, restated every wake. */
  mission: string;
  status: GoalStatus;
  /** "ask" = read-only research/measure; "code" = persistent worktree + can open PRs. */
  mode: "ask" | "code";
  /** Repo id for code-mode worktrees (key in worktree.ts REPOS). Defaults to the instance default repo. */
  repo?: string;
  /** Open Session session this goal drives (context continuity). Set on first wake. */
  osSessionId?: string;
  /** Engine (Claude/Codex) session id to resume each wake. Set on first wake. */
  engineSessionId?: string;
  /** Persistent worktree path for code mode — stable cwd so resume keeps working. */
  worktreePath?: string;
  /** Branch the persistent worktree was created on (for revive-after-cleanup). */
  branch?: string;
  /** ISO8601 — the ticker wakes this goal at/after this instant. */
  nextWakeAt: string;
  /** Floor on self-scheduled cadence, so a buggy run can't hot-loop. */
  minWakeMinutes: number;
  /** Hard safety cap on total wakes; auto-pauses on hit. Unset = no cap. */
  maxWakes?: number;
  wakeCount: number;
  lastRunAt?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  /** Agent-updated free text, e.g. "week 2: shipping roundup". */
  phase?: string;
  /** Set when status=paused — what/who it's blocked on. */
  pauseReason?: string;
  doneReason?: string;
  model?: string;
  fallbackModel?: string;
  /** External MCP server allowlist for this goal's runs (least privilege). */
  mcpServers?: string[];
  createdBy: string;
  createdAt: string;
  /** FeltDB authority version, carried internally for guarded writes. */
  __version?: number;
}

interface GoalLedger {
  id: string;
  goalId: string;
  text: string;
  __version?: number;
}

let goalsDb: StateFirstDB | undefined;
const goals = new Map<string, Goal>();

export async function initializeManagedGoals(
  db: StateFirstDB = goalsDb ?? managedFeltDb(),
): Promise<void> {
  goalsDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(GOALS_MIGRATION)) {
    if (existsSync(GOALS_DIR)) {
      for (const entry of readdirSync(GOALS_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = `${GOALS_DIR}/${entry.name}`;
        const legacy = JSON.parse(readFileSync(path, "utf8")) as Goal & { stateFile?: string };
        const { stateFile, __version: _, ...goal } = legacy;
        const ledgerPath = `${GOALS_DIR}/${goal.id}.ledger.md`;
        const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
        await db.transaction((tx) => {
          tx.collection<Goal>(GOALS_COLLECTION).set(goal.id, goal);
          tx.collection<GoalLedger>(LEDGERS_COLLECTION).set(goal.id, {
            id: goal.id,
            goalId: goal.id,
            text: ledgerText,
          });
        }, { transactionId: `opensession:goals:migrate:${goal.id}` });
        unlinkSync(path);
        if (existsSync(ledgerPath)) unlinkSync(ledgerPath);
      }
      try { rmdirSync(GOALS_DIR); } catch {}
    }
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(GOALS_MIGRATION, { id: GOALS_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${GOALS_MIGRATION}` });
  }
  goals.clear();
  for (const goal of await db.collection<Goal>(GOALS_COLLECTION).all()) goals.set(goal.id, goal);
}

// ── Store ────────────────────────────────────────────────────

export function listGoals(): Goal[] {
  const out = [...goals.values()].map((goal) => ({ ...goal }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getGoal(id: string): Goal | null {
  const goal = goals.get(id);
  return goal ? { ...goal } : null;
}

export async function saveGoal(g: Goal): Promise<Goal> {
  const db = goalsDb ?? managedFeltDb();
  const current = await db.collection<Goal>(GOALS_COLLECTION).get(g.id);
  const version = g.__version ?? current?.__version;
  if (current && !Number.isSafeInteger(version)) throw new Error(`Goal ${g.id} has no FeltDB authority version`);
  const { __version: _, ...stored } = g;
  await db.transaction((tx) => {
    tx.collection<Goal>(GOALS_COLLECTION).set(g.id, stored,
      current ? { ifVersion: version } : { requireAbsent: true });
  }, { transactionId: `opensession:goal:save:${g.id}:${crypto.randomUUID()}` });
  const saved = await db.collection<Goal>(GOALS_COLLECTION).get(g.id);
  if (!saved) throw new Error(`Goal ${g.id} disappeared after save`);
  goals.set(g.id, saved);
  return { ...saved };
}

export async function deleteGoal(id: string): Promise<boolean> {
  const db = goalsDb ?? managedFeltDb();
  const goal = await db.collection<Goal>(GOALS_COLLECTION).get(id);
  if (!goal || !Number.isSafeInteger(goal.__version)) return false;
  const ledger = await db.collection<GoalLedger>(LEDGERS_COLLECTION).get(id);
  await db.transaction((tx) => {
    tx.collection<Goal>(GOALS_COLLECTION).delete(id, { ifVersion: goal.__version });
    if (ledger && Number.isSafeInteger(ledger.__version))
      tx.collection<GoalLedger>(LEDGERS_COLLECTION).delete(id, { ifVersion: ledger.__version });
  }, { transactionId: `opensession:goal:delete:${id}:${goal.__version}` });
  goals.delete(id);
  return true;
}

/** Append a timestamped entry to a goal's fact ledger (its durable memory). */
export async function appendLedger(goal: Goal, text: string): Promise<void> {
  const db = goalsDb ?? managedFeltDb();
  const stamp = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await db.collection<GoalLedger>(LEDGERS_COLLECTION).get(goal.id);
    if (current && !Number.isSafeInteger(current.__version))
      throw new Error(`Goal ledger ${goal.id} has no FeltDB authority version`);
    const next: GoalLedger = {
      id: goal.id,
      goalId: goal.id,
      text: `${current?.text || ""}\n\n## ${stamp}\n\n${text.trim()}\n`,
    };
    try {
      await db.transaction((tx) => {
        tx.collection<GoalLedger>(LEDGERS_COLLECTION).set(goal.id, next,
          current ? { ifVersion: current.__version } : { requireAbsent: true });
      }, { transactionId: `opensession:goal:ledger:${goal.id}:${crypto.randomUUID()}` });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}

export async function readLedger(goalId: string): Promise<string> {
  return (await (goalsDb ?? managedFeltDb()).collection<GoalLedger>(LEDGERS_COLLECTION).get(goalId))?.text || "";
}

// ── Create / update ──────────────────────────────────────────

const MIN_WAKE_FLOOR = 5; // never allow a cadence under 5 minutes

function sanitizeMcpList(list?: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim());
}

export async function createGoal(input: {
  name: string;
  mission: string;
  mode?: "ask" | "code";
  repo?: string;
  model?: string;
  fallbackModel?: string;
  mcpServers?: string[];
  minWakeMinutes?: number;
  maxWakes?: number;
  /** ISO8601 first wake; omitted/empty = wake on the next tick. */
  firstWakeAt?: string;
  createdBy: string;
}): Promise<Goal | { error: string }> {
  if (!input.name?.trim()) return { error: "Name is required" };
  if (!input.mission?.trim()) return { error: "Mission is required" };

  let nextWakeAt = new Date().toISOString();
  if (input.firstWakeAt?.trim()) {
    const t = Date.parse(input.firstWakeAt.trim());
    if (Number.isNaN(t)) return { error: `Invalid firstWakeAt: "${input.firstWakeAt}"` };
    nextWakeAt = new Date(t).toISOString();
  }

  const id = `goal-${randomUUIDv7()}`;
  const minWakeMinutes = Math.max(
    MIN_WAKE_FLOOR,
    typeof input.minWakeMinutes === "number" && input.minWakeMinutes > 0 ? input.minWakeMinutes : 30
  );

  const g: Goal = {
    id,
    name: input.name.trim(),
    mission: input.mission.trim(),
    status: "active",
    mode: input.mode === "code" ? "code" : "ask",
    repo: input.repo?.trim() || undefined,
    nextWakeAt,
    minWakeMinutes,
    maxWakes:
      typeof input.maxWakes === "number" && input.maxWakes > 0
        ? Math.floor(input.maxWakes)
        : undefined,
    wakeCount: 0,
    model: input.model?.trim() || undefined,
    fallbackModel: input.fallbackModel?.trim() || undefined,
    mcpServers: sanitizeMcpList(input.mcpServers),
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
  };
  const ledger = `# Ledger — ${g.name}\n\n` +
      `This is the durable, authoritative record of this goal's work: baselines, ` +
      `decisions, shipped PRs and their measured effect. The agent reads it first ` +
      `every wake and appends to it last. It survives context compaction.\n\n` +
      `## Mission\n\n${g.mission}\n`;
  const db = goalsDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<Goal>(GOALS_COLLECTION).set(id, g, { requireAbsent: true });
    tx.collection<GoalLedger>(LEDGERS_COLLECTION).set(id, { id, goalId: id, text: ledger }, { requireAbsent: true });
  }, { transactionId: `opensession:goal:create:${id}` });
  const saved = await db.collection<Goal>(GOALS_COLLECTION).get(id);
  if (!saved) throw new Error(`Goal ${id} was not stored`);
  goals.set(id, saved);
  return { ...saved };
}

/** Fields an operator (via opensession-goals) may patch. Runtime/scheduling fields
 *  (engineSessionId, wakeCount, lastRun*, worktreePath) are owned by the runner. */
export async function updateGoal(
  id: string,
  patch: Partial<
    Pick<
      Goal,
      | "name"
      | "mission"
      | "status"
      | "mode"
      | "repo"
      | "nextWakeAt"
      | "minWakeMinutes"
      | "maxWakes"
      | "model"
      | "fallbackModel"
      | "mcpServers"
      | "phase"
      | "pauseReason"
      | "doneReason"
    >
  >
): Promise<Goal | { error: string }> {
  const g = getGoal(id);
  if (!g) return { error: "Goal not found" };
  const next: Goal = { ...g, ...patch };
  if ("mcpServers" in patch) next.mcpServers = sanitizeMcpList(patch.mcpServers);
  if (typeof next.minWakeMinutes === "number") {
    next.minWakeMinutes = Math.max(MIN_WAKE_FLOOR, next.minWakeMinutes);
  }
  return saveGoal(next);
}

/** Resume a paused/done goal: mark active and (re)schedule a wake. */
export async function resumeGoal(id: string, firstWakeAt?: string): Promise<Goal | { error: string }> {
  const g = getGoal(id);
  if (!g) return { error: "Goal not found" };
  let nextWakeAt = new Date().toISOString();
  if (firstWakeAt?.trim()) {
    const t = Date.parse(firstWakeAt.trim());
    if (Number.isNaN(t)) return { error: `Invalid time: "${firstWakeAt}"` };
    nextWakeAt = new Date(t).toISOString();
  }
  const next: Goal = {
    ...g,
    status: "active",
    pauseReason: undefined,
    nextWakeAt,
  };
  return saveGoal(next);
}
