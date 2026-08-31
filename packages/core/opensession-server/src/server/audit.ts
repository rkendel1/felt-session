import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { stateDir } from "./paths";
import { managedFeltDb } from "./managed-feltdb";

// Structured audit events live in managed FeltDB. Legacy daily JSONL files are
// imported once during boot and then removed.

const AUDIT_DIR = stateDir("audit");

const RETENTION_DAYS = 400;
const AUDIT_COLLECTION = "opensession_audit_events";
const AUDIT_DAYS_COLLECTION = "opensession_audit_days";
const AUDIT_MIGRATION = "audit-jsonl-to-managed-feltdb-v1";
type AuditRecord = { id: string; date: string; timeMs: number; order: number; event: Record<string, unknown> };
type AuditDay = { id: string; latestTimeMs: number };
let auditDb: StateFirstDB | undefined;
const pendingAuditWrites = new Set<Promise<unknown>>();

function legacyAuditFiles(dir = AUDIT_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
    .map((file) => `${dir}/${file}`);
}

function legacyRecord(path: string, index: number, line: string): AuditRecord | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const fileDate = path.match(/audit-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1];
    const timeMs = Date.parse(String(event.time || ""));
    const date = fileDate;
    if (!date) return null;
    return {
      id: `legacy-${createHash("sha256").update(`${path}:${index}:${line}`).digest("hex")}`,
      date,
      timeMs: Number.isFinite(timeMs) ? timeMs : Date.parse(`${date}T00:00:00Z`) + index,
      order: (Number.isFinite(timeMs) ? timeMs : Date.parse(`${date}T00:00:00Z`)) * 1000 + index % 1000,
      event,
    };
  } catch {
    return null;
  }
}

export async function initializeManagedAudit(
  db: StateFirstDB = auditDb ?? managedFeltDb(),
  legacyDir = AUDIT_DIR,
): Promise<void> {
  auditDb = db;
  const files = legacyAuditFiles(legacyDir);
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(AUDIT_MIGRATION)) {
    const days = new Map<string, number>();
    for (const path of files) {
      const records = readFileSync(path, "utf8").split("\n")
        .map((line, index) => line ? legacyRecord(path, index, line) : null)
        .filter((record): record is AuditRecord => !!record);
      for (let offset = 0; offset < records.length; offset += 250) {
        const batch = records.slice(offset, offset + 250);
        await db.transaction((tx) => {
          for (const record of batch) {
            tx.collection<AuditRecord>(AUDIT_COLLECTION).set(record.id, record);
            days.set(record.date, Math.max(days.get(record.date) || 0, record.timeMs));
          }
        }, { transactionId: `opensession:audit-import:${createHash("sha256").update(`${path}:${offset}`).digest("hex")}` });
      }
    }
    await db.transaction((tx) => {
      for (const [date, latestTimeMs] of days)
        tx.collection<AuditDay>(AUDIT_DAYS_COLLECTION).set(date, { id: date, latestTimeMs });
      tx.collection("opensession_migrations").set(AUDIT_MIGRATION,
        { id: AUDIT_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${AUDIT_MIGRATION}` });
  }
  for (const path of files) if (existsSync(path)) unlinkSync(path);
  await pruneManagedAudit();
}

async function pruneManagedAudit(): Promise<void> {
  const db = auditDb ?? managedFeltDb();
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  if (db.runtime().runtime !== "remote") {
    const expired = (await db.collection<AuditRecord>(AUDIT_COLLECTION).all())
      .filter((record) => record.timeMs < cutoff);
    if (expired.length) await db.transaction((tx) => {
      for (const record of expired) tx.collection(AUDIT_COLLECTION).delete(record.id);
    }, { transactionId: `opensession:audit-prune:${crypto.randomUUID()}` });
  } else {
  for (;;) {
    const page = await db.query<AuditRecord>({
      collection: AUDIT_COLLECTION,
      where: [{ field: "timeMs", lt: cutoff }],
      orderBy: [{ field: "timeMs", direction: "asc" }],
      limit: 500,
    });
    if (!page.records.length) break;
    await db.transaction((tx) => {
      for (const record of page.records) tx.collection(AUDIT_COLLECTION).delete(record.id);
    }, { transactionId: `opensession:audit-prune:${crypto.randomUUID()}` });
  }
  }
  for (const day of await db.collection<AuditDay>(AUDIT_DAYS_COLLECTION).all())
    if (day.latestTimeMs < cutoff) await db.collection<AuditDay>(AUDIT_DAYS_COLLECTION).delete(day.id);
}

/**
 * Emit one managed audit event. Never throws — audit failures must not
 * take down the run they're observing (they do land in journald via stderr).
 */
export function audit(event: Record<string, unknown>): void {
  try {
    // bun test shares this module with the live audit paths — keep fake-run /
    // FSM test events out of the managed production audit stream (it feeds
    // the digest and Dreaming). No test asserts on audit output today.
    if (process.env.NODE_ENV === "test") return;
    const now = new Date();
    const order = now.getTime() * 1000 + nextAuditOrdinal(now.getTime());
    const record: AuditRecord = {
      id: `audit-${now.getTime()}-${crypto.randomUUID()}`,
      date: now.toISOString().slice(0, 10),
      timeMs: now.getTime(),
      order,
      event: {
      time: now.toISOString(),
      service: "opensession",
      ...event,
      },
    };
    const db = auditDb ?? managedFeltDb();
    const write = db.transaction((tx) => {
      tx.collection<AuditRecord>(AUDIT_COLLECTION).set(record.id, record, { requireAbsent: true });
      tx.collection<AuditDay>(AUDIT_DAYS_COLLECTION).set(record.date,
        { id: record.date, latestTimeMs: record.timeMs });
    }, { transactionId: `opensession:audit:${record.id}` })
      .catch((error) => console.error("[audit] write failed:", error))
      .finally(() => pendingAuditWrites.delete(write));
    pendingAuditWrites.add(write);
  } catch (e) {
    console.error("[audit] write failed:", e);
  }
}

export async function flushAuditWrites(): Promise<void> {
  while (pendingAuditWrites.size) await Promise.allSettled([...pendingAuditWrites]);
}

let auditOrdinalMs = 0;
let auditOrdinal = 0;
function nextAuditOrdinal(timeMs: number): number {
  if (timeMs !== auditOrdinalMs) {
    auditOrdinalMs = timeMs;
    auditOrdinal = 0;
  }
  return auditOrdinal++ % 1000;
}

// Stored all-lowercase so the redactor's `.toLowerCase()` lookup catches
// camelCase and snake_case variants alike.
const SECRET_KEYS = new Set([
  "token",
  "apikey",
  "api_key",
  "password",
  "secret",
  "authorization",
  "auth",
  "bearer",
  "pat",
  "credential",
  "credentials",
]);

/** Scrub secret-shaped keys from a value before it lands in the audit log. */
export function redactArgs(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactArgs);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redactArgs(v);
    }
    return out;
  }
  return value;
}

export function digest(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export interface TextSummary {
  text_sha256: string;
  text_bytes: number;
  text_snippet: string;
}

/**
 * Bounded audit view of a potentially-large string: truncated snippet + byte
 * length + full sha256, so the log stays small but the exact body can still
 * be reconciled against the on-disk Claude session jsonl when needed.
 */
export function summarizeText(text: string | undefined, snippetBytes = 300): TextSummary {
  const s = text ?? "";
  return {
    text_sha256: createHash("sha256").update(s).digest("hex"),
    text_bytes: Buffer.byteLength(s, "utf8"),
    text_snippet: s.length > snippetBytes ? `${s.slice(0, snippetBytes)}…` : s,
  };
}

// ── Read side (the in-app audit viewer, Settings → Audit log) ──

/** Dates (YYYY-MM-DD, newest first) represented in managed audit state. */
export async function listAuditDates(): Promise<string[]> {
  await flushAuditWrites();
  const days = await (auditDb ?? managedFeltDb()).collection<AuditDay>(AUDIT_DAYS_COLLECTION).all();
  return days.map((day) => day.id).sort().reverse();
}

/** The per-turn streaming firehose — hidden by the viewer's default
 *  "significant only" filter so decisions/prompts/confirmations stand out. */
const NOISY_KINDS = new Set([
  "tool_use",
  "tool_result",
  "assistant_text",
  "assistant_thinking",
  "result",
]);

export interface AuditReadResult {
  /** Page of events, newest first. */
  events: Array<Record<string, unknown>>;
  /** Total matches for the filter (before offset/limit). */
  total: number;
  /** Distinct event types seen on this date (for the filter dropdown). */
  types: string[];
}

/** One event's display type: the runner events carry `kind`, the audited()
 *  wrapper and other emitters carry `msg`. */
function eventType(e: Record<string, unknown>): string {
  return String(e.kind || e.msg || "event");
}

export async function readAuditEvents(opts: {
  date: string;
  /** Case-insensitive substring across the raw line. */
  q?: string;
  /** Exact event type (see eventType). */
  type?: string;
  /** Substring match on session_id (old events: bks_session_id). */
  session?: string;
  /** Drop the per-turn firehose kinds (default true). */
  significantOnly?: boolean;
  offset?: number;
  limit?: number;
}): Promise<AuditReadResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    return { events: [], total: 0, types: [] };
  }
  const q = (opts.q || "").toLowerCase();
  const significantOnly = opts.significantOnly !== false;
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.min(500, Math.max(1, opts.limit || 200));

  const types = new Set<string>();
  const matches: Array<Record<string, unknown>> = [];
  for (const e of await readAuditDayEvents(opts.date)) {
    const t = eventType(e);
    types.add(t);
    if (opts.type && t !== opts.type) continue;
    if (!opts.type && significantOnly && NOISY_KINDS.has(t)) continue;
    if (opts.session && !String(e.session_id || e.bks_session_id || "").includes(opts.session)) continue;
    if (q && !JSON.stringify(e).toLowerCase().includes(q)) continue;
    matches.push(e);
  }
  return {
    events: matches.slice(offset, offset + limit),
    total: matches.length,
    types: [...types].sort(),
  };
}

/** One day's audit log rolled up into a compact, LLM-consumable shape. Built
 *  for the nightly "Dreaming" reflection automation: a busy raw day is far
 *  past what the read tool can take, so it webfetches /api/audit/digest
 *  instead of shell-processing the log. The whole digest is 50-70KB, which the
 *  engine truncates as a large tool output — callers can pass `?section=` to
 *  fetch detail sections individually. Keep the field names stable — the
 *  automation prompt names them. */
export async function buildAuditDigest(date: string): Promise<Record<string, unknown> | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const events = await readAuditDayEvents(date);
  if (!events.length) return null;
  return buildAuditDigestFromLines(date, events.toReversed().map((event) => JSON.stringify(event)).join("\n"));
}

export async function readAuditDayEvents(date: string): Promise<Array<Record<string, unknown>>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  await flushAuditWrites();
  const db = auditDb ?? managedFeltDb();
  if (db.runtime().runtime !== "remote") {
    return (await db.collection<AuditRecord>(AUDIT_COLLECTION).all())
      .filter((record) => record.date === date)
      .sort((a, b) => b.order - a.order)
      .map((record) => record.event);
  }
  const events: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = await db.query<AuditRecord>({
      collection: AUDIT_COLLECTION,
      where: [{ field: "date", eq: date }],
      orderBy: [{ field: "order", direction: "desc" }],
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    events.push(...page.records.map((record) => record.event));
    cursor = page.exhausted ? undefined : page.nextCursor;
    if (!page.exhausted && !cursor) throw new Error("FeltDB audit cursor is missing");
  } while (cursor);
  return events;
}

/** Pure digest builder used by focused mixed-format fixtures. */
export function buildAuditDigestFromLines(
  date: string,
  contents: string,
): Record<string, unknown> {
  interface SessionAgg {
    id: string;
    runKind: string;
    mode: string;
    models: Set<string>;
    firstPrompt: string;
    turns: number;
    errors: number;
    toolErrors: number;
    cancelled: number;
    permissionDecisions: number;
    durationMs: number;
    costUsd: number;
  }
  const sessions = new Map<string, SessionAgg>();
  const eventSessionId = (e: Record<string, unknown>): string =>
    String(
      e.session_id ||
        e.bks_session_id ||
        (e.msg === "pi_turn" ? e.session : "") ||
        "",
    );
  const sessionOf = (e: Record<string, unknown>): SessionAgg | null => {
    const id = eventSessionId(e);
    if (!id) return null;
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        runKind: "?",
        mode: "?",
        models: new Set(),
        firstPrompt: "",
        turns: 0,
        errors: 0,
        toolErrors: 0,
        cancelled: 0,
        permissionDecisions: 0,
        durationMs: 0,
        costUsd: 0,
      };
      sessions.set(id, s);
    }
    // Session creation and queue events often arrive before runner metadata.
    // Keep the first useful identity rather than freezing those early blanks.
    if (s.runKind === "?" && e.run_kind) s.runKind = String(e.run_kind);
    if (s.mode === "?" && e.mode) s.mode = String(e.mode);
    if (e.model) s.models.add(String(e.model));
    return s;
  };

  // Group key for recurring failures: ids and counts vary per occurrence.
  const normalize = (msg: string) =>
    msg.replace(/[0-9a-f-]{12,}/gi, "*").replace(/\d+/g, "#").slice(0, 160);

  interface ErrGroup {
    count: number;
    runKinds: Set<string>;
    sample: string;
    sampleSession: string;
  }
  const errorGroups = new Map<string, ErrGroup>();
  const toolErrorGroups = new Map<string, ErrGroup & { tool: string }>();
  const toolNameById = new Map<string, string>();
  const toolCalls = new Map<string, number>();
  const models = new Map<string, number>();
  const accountSwitches = new Map<string, number>();
  const papercuts: Array<Record<string, unknown>> = [];
  // Turn verdicts (turn-outcome.ts). A silent-drop — an unattended turn that
  // ended without reaching anyone and without declaring the silence — used to
  // reach this digest by being mirrored into the papercut log, one row per
  // occurrence: 583 identical entries, 22% of the whole papercut store,
  // crowding out the friction someone actually noticed and wrote down. The
  // events were always here; the digest just never read them. Counting them is
  // both smaller and more actionable than the rows were.
  const verdicts = { reached: 0, declared: 0, silentDrop: 0 };
  const silentDropsByRunKind = new Map<string, number>();
  const oneshots = { total: 0, failed: 0 };
  let events = 0;
  let turns = 0;
  let errors = 0;
  let toolErrors = 0;
  let cancelled = 0;
  let permissionDecisions = 0;
  let engineRetries = 0;
  let costUsd = 0;

  const parsedEvents: Array<Record<string, unknown>> = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      parsedEvents.push(JSON.parse(line));
    } catch {
      // A partially-written final line must not discard the rest of the day.
    }
  }

  interface PiLogicalTurn {
    attempts: Array<Record<string, unknown>>;
  }
  const piTurns = new Map<Record<string, unknown>, PiLogicalTurn>();
  const genericTerminalsToSkip = new Set<Record<string, unknown>>();
  const pendingPi = new Map<string, Array<Record<string, unknown>>>();
  const pendingGeneric = new Map<string, Array<Record<string, unknown>>>();

  // `pi_turn` is an attempt, not a person's turn: account retries and model
  // fallbacks each close one, and continuation/utility runs may use the same
  // shape. `session_turn_metric` is emitted once, after the outer runner walk
  // settles. Pair only session-bearing attempts with that terminal marker.
  // This excludes one-shots and lets mixed-format deployments prefer Pi's
  // logical terminal without also counting their mirrored generic terminal.
  for (const e of parsedEvents) {
    const id = eventSessionId(e);
    if (!id) continue;
    if (e.msg === "pi_turn" && e.direction === "out" && !e.kind) {
      const attempts = pendingPi.get(id) || [];
      attempts.push(e);
      pendingPi.set(id, attempts);
    }
    if ((e.kind === "result" || e.kind === "error") && pendingPi.has(id)) {
      const terminals = pendingGeneric.get(id) || [];
      terminals.push(e);
      pendingGeneric.set(id, terminals);
    }
    if (e.kind === "session_turn_metric") {
      const attempts = pendingPi.get(id) || [];
      const genericTerminals = pendingGeneric.get(id) || [];
      if (attempts.length) {
        piTurns.set(e, { attempts });
        for (const terminal of genericTerminals) genericTerminalsToSkip.add(terminal);
      }
      pendingPi.delete(id);
      pendingGeneric.delete(id);
    }
  }

  for (const e of parsedEvents) {
    events++;
    if (e.msg === "pi_oneshot") {
      oneshots.total++;
      if (e.status && e.status !== "ok") oneshots.failed++;
      continue;
    }
    if (e.msg === "pi_meridian_run" || e.msg === "pi_openai_run") {
      if (e.retry_attempt) engineRetries++;
      continue;
    }
    const s = sessionOf(e);
    const piTurn = piTurns.get(e);
    if (piTurn) {
      turns++;
      const failed = e.outcome === "failed";
      const cost = piTurn.attempts.reduce(
        (sum, attempt) => sum + (Number(attempt.total_cost_usd) || 0),
        0,
      );
      costUsd += cost;
      if (s) {
        s.turns++;
        s.durationMs += Number(e.duration_ms) || 0;
        s.costUsd += cost;
      }
      const terminalModel = [...piTurn.attempts].reverse().find((attempt) => attempt.model)?.model;
      if (terminalModel) {
        models.set(String(terminalModel), (models.get(String(terminalModel)) || 0) + 1);
      }
      if (failed) {
        errors++;
        if (s) s.errors++;
        const failedAttempt = [...piTurn.attempts]
          .reverse()
          .find((attempt) => attempt.ok === false || attempt.error);
        const raw = String(failedAttempt?.error || "Pi turn failed");
        const g = errorGroups.get(normalize(raw)) || {
          count: 0,
          runKinds: new Set<string>(),
          sample: raw.slice(0, 300),
          sampleSession: s?.id || "",
        };
        g.count++;
        g.runKinds.add(s?.runKind || "?");
        errorGroups.set(normalize(raw), g);
      }
      continue;
    }
    if (genericTerminalsToSkip.has(e)) continue;

    switch (String(e.kind || "")) {
      case "user_prompt":
        if (e.model) models.set(String(e.model), (models.get(String(e.model)) || 0) + 1);
        if (s && !s.firstPrompt) s.firstPrompt = String(e.text_snippet || "").slice(0, 200);
        break;
      case "result": {
        turns++;
        const cost = Number(e.total_cost_usd) || 0;
        costUsd += cost;
        if (s) {
          s.turns++;
          s.durationMs += Number(e.duration_ms) || 0;
          s.costUsd += cost;
        }
        break;
      }
      case "error": {
        errors++;
        if (s) s.errors++;
        const raw = String(e.error || "");
        const g = errorGroups.get(normalize(raw)) || {
          count: 0,
          runKinds: new Set<string>(),
          sample: raw.slice(0, 300),
          sampleSession: String(e.session_id || e.bks_session_id || ""),
        };
        g.count++;
        g.runKinds.add(String(e.run_kind || "?"));
        errorGroups.set(normalize(raw), g);
        break;
      }
      case "cancelled":
        cancelled++;
        if (s) s.cancelled++;
        break;
      case "tool_use":
        if (e.tool_use_id && e.tool_name) {
          toolNameById.set(String(e.tool_use_id), String(e.tool_name));
        }
        if (e.tool_name) {
          toolCalls.set(String(e.tool_name), (toolCalls.get(String(e.tool_name)) || 0) + 1);
        }
        break;
      case "tool_result": {
        if (e.is_error !== true) break;
        toolErrors++;
        if (s) s.toolErrors++;
        const tool = toolNameById.get(String(e.tool_use_id || "")) || "?";
        const snippet = String(e.text_snippet || "");
        const key = `${tool}: ${normalize(snippet)}`;
        const g = toolErrorGroups.get(key) || {
          tool,
          count: 0,
          runKinds: new Set<string>(),
          sample: snippet.slice(0, 300),
          sampleSession: String(e.session_id || e.bks_session_id || ""),
        };
        g.count++;
        g.runKinds.add(String(e.run_kind || "?"));
        toolErrorGroups.set(key, g);
        break;
      }
      case "permission_decision":
        permissionDecisions++;
        if (s) s.permissionDecisions++;
        break;
      case "account_switch": {
        const acc = String(e.account || "?");
        accountSwitches.set(acc, (accountSwitches.get(acc) || 0) + 1);
        break;
      }
      // Agent-logged friction (src/server/papercuts.ts) — surfaced verbatim so
      // the Dreaming automation can spot recurring papercuts across sessions.
      case "papercut":
        if (papercuts.length < 200) {
          papercuts.push({
            message: String(e.message || ""),
            repo: e.repo || undefined,
            runKind: e.run_kind || undefined,
            by: e.by || undefined,
            session: e.session_id || e.bks_session_id || undefined,
          });
        }
        break;
      case "turn_outcome": {
        const verdict = String(e.verdict || "");
        if (verdict === "reached") verdicts.reached++;
        else if (verdict === "declared") verdicts.declared++;
        else if (verdict === "silent-drop") {
          verdicts.silentDrop++;
          const kind = String(e.run_kind || "unknown");
          silentDropsByRunKind.set(kind, (silentDropsByRunKind.get(kind) || 0) + 1);
        }
        break;
      }
    }
  }

  const byRunKind: Record<
    string,
    { sessions: number; turns: number; errors: number; toolErrors: number; costUsd: number }
  > = {};
  for (const s of sessions.values()) {
    const k = (byRunKind[s.runKind] ||= { sessions: 0, turns: 0, errors: 0, toolErrors: 0, costUsd: 0 });
    k.sessions++;
    k.turns += s.turns;
    k.errors += s.errors;
    k.toolErrors += s.toolErrors;
    k.costUsd = +(k.costUsd + s.costUsd).toFixed(2);
  }
  // Most troubled sessions first; quiet ones fall off the capped list.
  const topSessions = [...sessions.values()]
    .sort((a, b) => b.errors + b.toolErrors - (a.errors + a.toolErrors) || b.turns - a.turns)
    .slice(0, 60)
    .map((s) => ({
      id: s.id,
      runKind: s.runKind,
      mode: s.mode,
      models: [...s.models],
      firstPrompt: s.firstPrompt,
      turns: s.turns,
      errors: s.errors,
      toolErrors: s.toolErrors,
      cancelled: s.cancelled,
      permissionDecisions: s.permissionDecisions,
      durationMs: s.durationMs,
      costUsd: +s.costUsd.toFixed(2),
    }));
  const topGroups = <T extends ErrGroup>(m: Map<string, T>) =>
    [...m.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((g) => ({ ...g, runKinds: [...g.runKinds] }));

  return {
    date,
    totals: {
      events,
      sessions: sessions.size,
      turns,
      errors,
      toolErrors,
      cancelled,
      permissionDecisions,
      engineRetries,
      papercuts: papercuts.length,
      silentDrops: verdicts.silentDrop,
      costUsd: +costUsd.toFixed(2),
    },
    // One explanation, not one per occurrence — the whole reason these stopped
    // being papercuts.
    turnVerdicts: {
      ...verdicts,
      silentDropsByRunKind: Object.fromEntries(
        [...silentDropsByRunKind.entries()].sort((a, b) => b[1] - a[1]),
      ),
      // Inlined rather than imported from turn-outcome.ts: that module already
      // imports audit(), so reading its copy back would close an import cycle.
      ...(verdicts.silentDrop
        ? {
            silentDropMeaning:
              "An unattended run ended without reaching anyone — no note, message, report " +
              "or question — and without calling finish_silently to say the quiet ending was " +
              "deliberate. Either it stopped early, or it should have declared the silence.",
          }
        : {}),
    },
    byRunKind,
    models: Object.fromEntries(models),
    errorGroups: topGroups(errorGroups),
    toolErrorGroups: topGroups(toolErrorGroups),
    topTools: [...toolCalls.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tool, count]) => ({ tool, count })),
    oneshots,
    accountSwitches: Object.fromEntries(accountSwitches),
    papercuts,
    sessions: topSessions,
    sessionsTruncated: Math.max(0, sessions.size - topSessions.length),
  };
}

/**
 * Wraps a side-effecting call with start/end audit events: redacted args on
 * both, result fingerprint + duration on completion. Results are only
 * digested, never logged verbatim (data minimization).
 */
export async function audited<T>(
  ctx: { context: string; action: string; args?: unknown },
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  const base = {
    context: ctx.context,
    action: ctx.action,
    args_digest: digest(ctx.args),
    args_redacted: redactArgs(ctx.args),
  };

  audit({ ...base, msg: "action_start" });
  try {
    const result = await fn();
    audit({
      ...base,
      msg: "action_end",
      ok: true,
      result_digest: digest(result),
      duration_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    audit({
      ...base,
      msg: "action_end",
      ok: false,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
