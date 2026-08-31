import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { isNativeSessionId, stateDir } from "./paths";
import { readAuditDayEvents } from "./audit";
import { managedFeltDb } from "./managed-feltdb";

export interface PiModelUsage {
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface PiUsageDay {
  byModel: PiModelUsage[];
  bySession: Record<string, { requests: number; output: number }>;
  sessionAttribution: "measured" | "unmeasured";
  coverage: { pi: "measured" | "unmeasured" };
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  requests: number;
  unpricedRequests: number;
  unmeasured: boolean;
}

interface MutableUsage {
  byModel: Map<string, PiModelUsage>;
  bySession: Map<string, { requests: number; output: number }>;
}

type StoredUsageDay = { id: string; day: PiUsageDay; computedAt: number };

const CACHE_DIR = () => stateDir("analytics-cache");
const USAGE_COLLECTION = "opensession_pi_usage_days";
const USAGE_MIGRATION = "pi-usage-json-cache-to-managed-feltdb-v1";
export const PI_USAGE_CUTOVER_MS = Date.parse("2026-08-19T13:35:30Z");
const VOLATILE_TTL_MS = 60_000;
const volatile = new Map<string, { at: number; day: PiUsageDay }>();
let usageDb: StateFirstDB | undefined;

function emptyMutable(): MutableUsage {
  return { byModel: new Map(), bySession: new Map() };
}

function emptyDay(unmeasured = false): PiUsageDay {
  return {
    byModel: [],
    bySession: {},
    sessionAttribution: unmeasured ? "unmeasured" : "measured",
    coverage: { pi: unmeasured ? "unmeasured" : "measured" },
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    requests: 0,
    unpricedRequests: 0,
    unmeasured,
  };
}

function finishDay(value: MutableUsage): PiUsageDay {
  const day = emptyDay();
  day.byModel = [...value.byModel.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.cacheRead + b.input - (a.cacheRead + a.input),
  );
  day.bySession = Object.fromEntries(value.bySession);
  for (const usage of day.byModel) {
    day.requests += usage.requests;
    day.input += usage.input;
    day.output += usage.output;
    day.cacheRead += usage.cacheRead;
    day.cacheWrite += usage.cacheWrite;
    day.costUsd += usage.costUsd;
    if (!usage.costUsd) day.unpricedRequests += usage.requests;
  }
  day.totalTokens = day.input + day.output + day.cacheRead + day.cacheWrite;
  return day;
}

function normalizeDay(value: unknown): PiUsageDay | null {
  const raw = value as Partial<PiUsageDay> | null;
  if (!raw || !Array.isArray(raw.byModel)) return null;
  const bucket = emptyMutable();
  for (const item of raw.byModel) {
    const usage = item as Partial<PiModelUsage>;
    const model = String(usage.model || "unknown");
    bucket.byModel.set(model, {
      model,
      requests: Number(usage.requests) || 0,
      input: Number(usage.input) || 0,
      output: Number(usage.output) || 0,
      cacheRead: Number(usage.cacheRead) || 0,
      cacheWrite: Number(usage.cacheWrite) || 0,
      costUsd: Number(usage.costUsd) || 0,
    });
  }
  for (const [session, usage] of Object.entries(raw.bySession || {})) {
    bucket.bySession.set(session, {
      requests: Number(usage.requests) || 0,
      output: Number(usage.output) || 0,
    });
  }
  const day = finishDay(bucket);
  day.unpricedRequests = Number(raw.unpricedRequests) || 0;
  if (raw.unmeasured) {
    day.unmeasured = true;
    day.coverage.pi = "unmeasured";
    day.sessionAttribution = "unmeasured";
  }
  return day;
}

function legacyCacheFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^(?:engine-day-|pi-day-v\d+-)\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .sort((a, b) => Number(a.startsWith("pi-day")) - Number(b.startsWith("pi-day")))
    .map((file) => `${dir}/${file}`);
}

export async function initializeManagedPiUsage(
  db: StateFirstDB = usageDb ?? managedFeltDb(),
  legacyDir = CACHE_DIR(),
): Promise<void> {
  usageDb = db;
  const files = legacyCacheFiles(legacyDir);
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(USAGE_MIGRATION)) {
    const imported = new Map<string, PiUsageDay>();
    for (const path of files) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        const date = path.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
        const day = normalizeDay(parsed?.day);
        if (date && day) imported.set(date, day);
      } catch {}
    }
    await db.transaction((tx) => {
      for (const [date, day] of imported)
        tx.collection<StoredUsageDay>(USAGE_COLLECTION).set(date, { id: date, day, computedAt: Date.now() });
      tx.collection("opensession_migrations").set(USAGE_MIGRATION,
        { id: USAGE_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${USAGE_MIGRATION}` });
  }
  for (const path of files) if (existsSync(path)) unlinkSync(path);
}

function shortModel(model: unknown): string {
  const stripped = String(model || "unknown").replace(
    /^(?:pi|claude|codex|opencode)\/[^/]+\//,
    "",
  );
  return stripped.split("/").pop() || "unknown";
}

function addEvent(bucket: MutableUsage, event: Record<string, unknown>): void {
  const requests = Number(event.steps) || 1;
  const model = shortModel(event.model);
  const usage = bucket.byModel.get(model) || {
    model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0,
  };
  usage.requests += requests;
  usage.input += Number(event.input_tokens) || 0;
  usage.output += Number(event.output_tokens) || 0;
  usage.cacheRead += Number(event.cache_read_input_tokens) || 0;
  usage.cacheWrite += Number(event.cache_creation_input_tokens) || 0;
  usage.costUsd += Number(event.total_cost_usd) || 0;
  bucket.byModel.set(model, usage);
  const session = String(event.session_id || event.bks_session_id || event.session || "");
  if (isNativeSessionId(session)) {
    const sessionUsage = bucket.bySession.get(session) || { requests: 0, output: 0 };
    sessionUsage.requests += requests;
    sessionUsage.output += Number(event.output_tokens) || 0;
    bucket.bySession.set(session, sessionUsage);
  }
}

async function deriveUsageDay(date: string): Promise<PiUsageDay> {
  const bucket = emptyMutable();
  for (const event of (await readAuditDayEvents(date)).toReversed()) {
    const time = Date.parse(String(event.time || ""));
    if (event.msg === "pi_turn" && event.direction === "out") {
      if (Number.isFinite(time) && time >= PI_USAGE_CUTOVER_MS) addEvent(bucket, event);
      continue;
    }
    if (event.kind === "result" && (!Number.isFinite(time) || time < PI_USAGE_CUTOVER_MS))
      addEvent(bucket, event);
  }
  return finishDay(bucket);
}

async function persistDay(date: string, day: PiUsageDay): Promise<void> {
  const db = usageDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<StoredUsageDay>(USAGE_COLLECTION).set(date, { id: date, day, computedAt: Date.now() });
  }, { transactionId: `opensession:pi-usage:${date}:${crypto.randomUUID()}` });
}

async function usageForDate(date: string, today: string): Promise<PiUsageDay> {
  const memory = volatile.get(date);
  if (memory && Date.now() - memory.at < VOLATILE_TTL_MS) return memory.day;
  const db = usageDb ?? managedFeltDb();
  if (date < today) {
    const stored = await db.collection<StoredUsageDay>(USAGE_COLLECTION).get(date);
    if (stored) return stored.day;
  }
  const day = await deriveUsageDay(date);
  await persistDay(date, day);
  if (date >= today) volatile.set(date, { at: Date.now(), day });
  return day;
}

export async function piUsageForDates(dates: string[]): Promise<Map<string, PiUsageDay>> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await Promise.all(dates.map(async (date) => [date, await usageForDate(date, today)] as const));
  return new Map(rows);
}
