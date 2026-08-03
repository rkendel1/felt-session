/**
 * Automations: cron-scheduled Michael sessions, Devin-style.
 * Records live in ~/.opensession-automations/<id>.json; each run creates a
 * normal backstage session so it shows up in the sessions list and UI.
 */
import { randomUUIDv7 } from "bun";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { parseCron, cronMatches, nextRun } from "./cron";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { getAccountById } from "./claude-accounts";
import { runAgent } from "./agent-runner";
import { providerFor, resolveModel, DEFAULT_FALLBACK_MODEL, modelLabel } from "./models";
import { readOpencodeBridgeConfig } from "./opencode-config";
import { createWorktree, ensureAskCheckout, getRepo, listWorktrees, REPOS, worktreeHeadBranch } from "./worktree";
import { engineSessionPatch } from "./sessions";
import { updateSessionFile } from "./session-cache";
import { resolvePlainWorkspace } from "./workspace-resolve";
import type { BackstageSessionFile } from "./types";
import { stateDir } from "./rename-compat";
import { linkThreadInIndex, createSlackPostScanner } from "./slack-links";
import { createPapercutsMcpServer } from "../agents/slack/papercuts-tools";
import { createReportMcpServer } from "../agents/slack/report-tools";
import { createWorkflowsMcpServer } from "../agents/slack/workflow-tools";
import { createTurnMcpServer } from "../agents/slack/turn-tools";
import { papercutsEnabledForRepo } from "./papercuts";
import { registerSessionMcpServers, unregisterSessionMcpServers } from "./run-rpc";
import { createSessionsMcpServer } from "../agents/slack/sessions-tools";
import { createSelfImproveMcpServer } from "../agents/slack/self-improve-tools";
import { audit } from "./audit";
import { configuredIntegration, personaName } from "./config";
import { shouldPersistModelSwitch } from "./run-events";

const AUTOMATIONS_DIR = stateDir("automations");
const SESSIONS_DIR = BACKSTAGE_CHATS_DIR;

/**
 * Config for an automation that is driven by polling a Grafana Loki failure
 * signal: a generic poller (src/agents/grafana-poller) re-runs `lokiQuery` on a
 * timer, collapses the result series to one row per distinct `dedupLabel` value,
 * and fires one run of this automation per fresh failure (deduped over
 * `dedupDays`). The matched Loki labels are handed to the run as the triggering
 * event. Adding a new failure-signal investigator is therefore data — create an
 * automation with this config; no code change or restart.
 */
export interface GrafanaPollConfig {
  /** LogQL instant query. The literal token `$LOOKBACK` is replaced with `lookback`. */
  lokiQuery: string;
  /** Label whose distinct values define one failure (e.g. "story_id", "streaming_upload_id"). */
  dedupLabel: string;
  /** Slack channel id for the control card + investigation thread. */
  slackChannel: string;
  /** Human label for the card, e.g. "export failure" / "upload processing failure". */
  cardTitle: string;
  /** Range vector for the query, default "20m". */
  lookback?: string;
  /** Poll cadence in minutes, default 15. */
  pollMinutes?: number;
  /** Dedup window in days, default 7. */
  dedupDays?: number;
  /** Only fire for this namespace label, default "prod". Empty string disables the filter. */
  namespace?: string;
}

/**
 * Config for a channel-watch automation: the Slack agent fires one run per
 * top-level message posted in `channel` (thread replies don't re-trigger).
 * The bot must be a member of the channel to receive its messages — invite
 * @michael first. Runs get the channel's memory (read-only) appended to the
 * prompt, so "remember ..." facts taught interactively steer the triage.
 */
export interface SlackWatchConfig {
  /** Slack channel id (C…/G…). */
  channel: string;
}

/** One entry in an automation's run ledger (newest first, capped). */
export interface AutomationRun {
  at: string; // start time, ISO
  sessionId: string;
  trigger: "cron" | "webhook" | "manual" | "event";
  status: "running" | "ok" | "error";
  error?: string;
  durationMs?: number;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string; // 5-field cron, UTC; "" = webhook/manual only
  /**
   * One-off scheduled run: ISO8601 instant. When set, the scheduler fires this
   * automation once at/after this time and then deletes it (auto-cleanup).
   * Mutually exclusive with `schedule` (recurring cron) — setting it forces
   * `schedule` to "". Used for reminders, "run this again later", and any
   * one-time scheduled prompt (see schedule_once in admin-tools.ts).
   */
  runOnceAt?: string;
  mode: "ask" | "code";
  /**
   * Registered repo id (see worktree.ts REPOS) this automation works against.
   * Omitted = tella-fusion (the historical default). Ask mode reads the repo's
   * main checkout; code mode gets an isolated worktree — for shared-checkout
   * repos (backstage) explicitly isolated, never the live checkout.
   */
  repo?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  webhookSecret: string; // every automation is also webhook-triggerable
  eventKey?: string; // internal event subscription, e.g. "plain:thread_created"
  /**
   * MCP server allowlist for this automation's runs (least privilege).
   * Omitted = all configured servers, for automations created before this
   * existed. Prefer naming just what the automation actually uses.
   */
  mcpServers?: string[];
  /**
   * Human-set only: give this automation's runs the opensession-workflows
   * tools (run_workflow fan-outs — model-authored scripts in a contained
   * Worker, agents in ask mode). Safe for cron/introspective automations
   * whose prompt is our own text (morning support digest); NEVER set it on
   * automations triggered by untrusted event/ticket text (Plain triage,
   * channel watches) — model-authored code execution must not be steerable
   * from a ticket. See workflow-tools.ts's module doc.
   */
  workflows?: boolean;
  /**
   * Self-improving automation (human-set only — e.g. the nightly Dreaming
   * reflection). Runs (and thread-reply resumes) additionally get two scoped
   * in-process servers: opensession-sessions in `automationSelf` shape (the
   * spawn_task/task_status/cancel_task suite ONLY — no answer/send/cancel/
   * create on other sessions) and opensession-self (read own record + update
   * OWN prompt, with timestamped backup + audit event). Children it spawns
   * stay PR-gated and depth-guarded; schedule/model/mode/repo changes remain
   * human-only. See selfImproveMcpServers below.
   */
  selfImprove?: boolean;
  /**
   * If set, this automation is poll-triggered off a Grafana Loki signal by the
   * generic grafana-poller agent (one run per fresh failure). See GrafanaPollConfig.
   */
  grafanaPoll?: GrafanaPollConfig;
  /**
   * If set, this automation watches a Slack channel: one run per top-level
   * message (see SlackWatchConfig). Fired from the Slack agent's event intake.
   */
  slackWatch?: SlackWatchConfig;
  /**
   * Model TIER for new runs (claude-* / gpt-* / opencode/…; see models.ts).
   * Omitted = the automation default. Dispatch maps tiers onto the opencode
   * engine (opencodeAutomationModel) — the stored id stays the tier. Codex
   * models enforce tool denials as per-server disabled_tools (codex-runner.ts);
   * opencode strips them via its tools config (opencodeRunPolicy).
   */
  model?: string;
  /**
   * Model to switch to when the primary's whole account pool is exhausted.
   * Unset = no fallback; "none" also disables fallback.
   */
  fallbackModel?: string;
  /**
   * Pinned account in the model provider's Claude or Codex pool. By default a HARD pin:
   * runs use only that account, and when it's exhausted they fall to
   * `fallbackModel` instead of the shared pool — that makes the account's
   * limits (and its usage-credits monthly cap) this automation's cost
   * ceiling. Set `accountStrict: false` to soften it: the pinned account is
   * preferred, but an exhausted pin rotates into the shared pool like a
   * session pin does. Unset = shared-pool rotation as before.
   */
  accountId?: string;
  /** false = soft pin (pool fallback); unset/true = hard pin (cost cap). */
  accountStrict?: boolean;
  /**
   * Run this automation's sessions inside a sandbox (docs/sandboxes-plan.md).
   * Schema-only for now: create/update REJECT `sandbox: true` — automation
   * sandboxing lands in a later phase (interactive sessions dogfood first,
   * and the Phase 1 mount set carries interactive-level ambient trust that
   * untrusted automation prompts must not get).
   */
  sandbox?: boolean;
  /**
   * Allow runs to keep going on usage-credits once the account's subscription
   * limits are spent (only works on accounts with extra usage enabled at
   * claude.ai and credit headroom left). Off/unset = never intentionally
   * spend paid credits; the run rotates/falls back instead.
   */
  usageCredits?: boolean;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  lastTrigger?: "cron" | "webhook" | "manual" | "event";
  /** Run history ledger, newest first, capped at RUNS_CAP entries. */
  runs?: AutomationRun[];
}

export interface AutomationWithNext extends Automation {
  nextRunAt: string | null;
}

mkdirSync(AUTOMATIONS_DIR, { recursive: true });

// ── Store ────────────────────────────────────────────────────

export function listAutomations(): AutomationWithNext[] {
  const out: AutomationWithNext[] = [];
  for (const file of readdirSync(AUTOMATIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const a = JSON.parse(readFileSync(`${AUTOMATIONS_DIR}/${file}`, "utf-8")) as Automation;
      out.push({
        ...a,
        nextRunAt: !a.enabled
          ? null
          : a.runOnceAt
            ? a.runOnceAt
            : a.schedule
              ? nextRun(a.schedule)?.toISOString() || null
              : null,
      });
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getAutomation(id: string): Automation | null {
  const path = `${AUTOMATIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function saveAutomation(a: Automation): void {
  writeJsonAtomic(`${AUTOMATIONS_DIR}/${a.id}.json`, a);
}

function sanitizeMcpList(list?: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const names = list.filter((s): s is string => typeof s === "string" && !!s.trim());
  // [] is meaningful: no MCP servers at all
  return names.map((s) => s.trim());
}

function sanitizeGrafanaPoll(cfg?: unknown): GrafanaPollConfig | { error: string } | undefined {
  if (cfg === undefined || cfg === null) return undefined;
  if (typeof cfg !== "object") return { error: "grafanaPoll must be an object" };
  const c = cfg as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const lokiQuery = str(c.lokiQuery);
  const dedupLabel = str(c.dedupLabel);
  const slackChannel = str(c.slackChannel);
  const cardTitle = str(c.cardTitle);
  if (!lokiQuery || !dedupLabel || !slackChannel || !cardTitle) {
    return { error: "grafanaPoll requires lokiQuery, dedupLabel, slackChannel, and cardTitle" };
  }
  const out: GrafanaPollConfig = { lokiQuery, dedupLabel, slackChannel, cardTitle };
  if (str(c.lookback)) out.lookback = str(c.lookback);
  if (typeof c.namespace === "string") out.namespace = c.namespace.trim(); // "" = no filter
  if (typeof c.pollMinutes === "number" && c.pollMinutes > 0) out.pollMinutes = c.pollMinutes;
  if (typeof c.dedupDays === "number" && c.dedupDays > 0) out.dedupDays = c.dedupDays;
  return out;
}

function sanitizeSlackWatch(cfg?: unknown): SlackWatchConfig | { error: string } | undefined {
  if (cfg === undefined || cfg === null) return undefined;
  if (typeof cfg !== "object") return { error: "slackWatch must be an object" };
  const channel = typeof (cfg as any).channel === "string" ? (cfg as any).channel.trim() : "";
  if (!channel) return undefined; // {channel: ""} = clear the watch
  if (!/^[CG][A-Z0-9]{6,}$/i.test(channel)) {
    return { error: `slackWatch.channel must be a Slack channel id (C…), got "${channel}"` };
  }
  return { channel: channel.toUpperCase() };
}

/** Validate + normalize a one-off ISO8601 instant. "" / nullish → undefined
 *  (no one-off). Past times are allowed (they fire on the next tick). */
function sanitizeRunOnceAt(v?: unknown): string | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "runOnceAt must be an ISO8601 string" };
  const t = Date.parse(v.trim());
  if (Number.isNaN(t)) return { error: `Invalid date/time: "${v}"` };
  return new Date(t).toISOString();
}

function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** Validate a pinned claude-accounts id; ""/nullish clears the pin. */
function sanitizeAccountId(v?: unknown): string | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "accountId must be a string" };
  const id = v.trim();
  if (!id) return undefined;
  if (!getAccountById(id)) return { error: `Unknown Claude account id "${id}"` };
  return id;
}

function sanitizeModel(model?: unknown, allowNone = false): string | { error: string } | undefined {
  if (typeof model !== "string" || !model.trim()) return undefined;
  if (allowNone && model.trim().toLowerCase() === "none") return "none";
  const resolved = resolveModel(model);
  if (!resolved) return { error: `Unknown model "${model}"` };
  return resolved.id;
}

function sanitizeRepo(repo?: unknown): string | { error: string } | undefined {
  if (typeof repo !== "string" || !repo.trim()) return undefined;
  const id = repo.trim();
  if (!(id in REPOS)) {
    return { error: `Unknown repo "${id}" — registered: ${Object.keys(REPOS).join(", ")}` };
  }
  return id;
}

export function createAutomation(input: {
  name: string;
  prompt: string;
  schedule: string;
  /** One-off ISO8601 instant; when set, `schedule` is ignored (forced to ""). */
  runOnceAt?: string;
  mode: "ask" | "code";
  createdBy: string;
  /** Defaults to true. Seeded automations pass false so an operator reads the
   * prompt before it runs — see recipes/README.md. */
  enabled?: boolean;
  eventKey?: string;
  mcpServers?: string[];
  repo?: string;
  selfImprove?: boolean;
  workflows?: boolean;
  model?: string;
  fallbackModel?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  sandbox?: boolean;
  grafanaPoll?: GrafanaPollConfig;
  slackWatch?: SlackWatchConfig;
}): Automation | { error: string } {
  if (!input.name.trim()) return { error: "Name is required" };
  if (!input.prompt.trim()) return { error: "Prompt is required" };
  if (input.sandbox === true) {
    return { error: "automation sandboxing lands in a later phase — remove `sandbox` (interactive sessions only for now)" };
  }
  const runOnceAt = sanitizeRunOnceAt(input.runOnceAt);
  if (runOnceAt && typeof runOnceAt === "object") return runOnceAt;
  // A one-off and a recurring cron are mutually exclusive — the one-off wins.
  const schedule = runOnceAt ? "" : (input.schedule || "").trim();
  if (schedule && !parseCron(schedule)) {
    return { error: `Invalid cron expression: "${schedule}"` };
  }
  const repo = sanitizeRepo(input.repo);
  if (repo && typeof repo === "object") return repo;
  const model = sanitizeModel(input.model);
  if (model && typeof model === "object") return model;
  const fallbackModel = sanitizeModel(input.fallbackModel, true);
  if (fallbackModel && typeof fallbackModel === "object") return fallbackModel;
  const accountId = sanitizeAccountId(input.accountId);
  if (accountId && typeof accountId === "object") return accountId;
  const grafanaPoll = sanitizeGrafanaPoll(input.grafanaPoll);
  if (grafanaPoll && "error" in grafanaPoll) return grafanaPoll;
  const slackWatch = sanitizeSlackWatch(input.slackWatch);
  if (slackWatch && "error" in slackWatch) return slackWatch;

  const a: Automation = {
    id: `auto-${randomUUIDv7()}`,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    schedule,
    runOnceAt,
    mode: input.mode === "code" ? "code" : "ask",
    // Only an explicit false opts out; every existing caller omits this and
    // keeps the old always-enabled behaviour.
    enabled: input.enabled !== false,
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
    webhookSecret: generateSecret(),
    eventKey: (input.eventKey || "").trim() || undefined,
    mcpServers: sanitizeMcpList(input.mcpServers),
    repo,
    selfImprove: input.selfImprove === true || undefined,
    workflows: input.workflows === true || undefined,
    model,
    fallbackModel,
    accountId,
    // Only false is worth storing — unset/true both mean the hard-pin default.
    accountStrict: input.accountStrict === false ? false : undefined,
    usageCredits: input.usageCredits === true || undefined,
    grafanaPoll,
    slackWatch,
  };
  saveAutomation(a);
  return a;
}

/** Create deployment-provided automations once. Source ships no company-
 * specific routines; instances opt in with `integrations.seeds.automations`. */
export function ensureConfiguredAutomations(): void {
  const raw = configuredIntegration("seeds").automations;
  if (!Array.isArray(raw)) return;
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    const eventKey = typeof value.eventKey === "string" ? value.eventKey.trim() : "";
    if (!name || !prompt) continue;
    if (
      listAutomations().some(
        (automation) =>
          (eventKey && automation.eventKey === eventKey) ||
          (!eventKey && automation.name === name),
      )
    ) continue;
    const result = createAutomation({
      ...(value as any),
      name,
      prompt,
      eventKey: eventKey || undefined,
      schedule: typeof value.schedule === "string" ? value.schedule : "",
      mode: value.mode === "code" ? "code" : "ask",
      enabled: value.enabled !== false,
      createdBy:
        typeof value.createdBy === "string"
          ? value.createdBy
          : `${personaName()} (config seed)`,
    });
    if ("error" in result) {
      console.warn(`[automations] Config seed "${name}" skipped: ${result.error}`);
    } else {
      console.log(`[automations] Seeded configured automation "${name}"`);
    }
  }
}

export function updateAutomation(
  id: string,
  patch: Partial<Pick<Automation, "name" | "prompt" | "schedule" | "runOnceAt" | "mode" | "enabled" | "eventKey" | "mcpServers" | "repo" | "selfImprove" | "workflows" | "model" | "fallbackModel" | "accountId" | "accountStrict" | "usageCredits" | "sandbox" | "grafanaPoll" | "slackWatch">>
): Automation | { error: string } {
  const a = getAutomation(id);
  if (!a) return { error: "Automation not found" };
  if (patch.sandbox === true) {
    return { error: "automation sandboxing lands in a later phase — remove `sandbox` (interactive sessions only for now)" };
  }
  if (patch.schedule !== undefined && patch.schedule.trim() && !parseCron(patch.schedule)) {
    return { error: `Invalid cron expression: "${patch.schedule}"` };
  }
  const next = { ...a, ...patch };
  if ("runOnceAt" in patch) {
    const runOnceAt = sanitizeRunOnceAt(patch.runOnceAt);
    if (runOnceAt && typeof runOnceAt === "object") return runOnceAt;
    next.runOnceAt = runOnceAt;
    if (runOnceAt) next.schedule = ""; // one-off and cron are mutually exclusive
  }
  if ("mcpServers" in patch) next.mcpServers = sanitizeMcpList(patch.mcpServers);
  if ("repo" in patch) {
    const repo = sanitizeRepo(patch.repo);
    if (repo && typeof repo === "object") return repo;
    next.repo = repo;
  }
  if ("selfImprove" in patch) next.selfImprove = patch.selfImprove === true || undefined;
  if ("workflows" in patch) next.workflows = patch.workflows === true || undefined;
  if ("grafanaPoll" in patch) {
    const grafanaPoll = sanitizeGrafanaPoll(patch.grafanaPoll);
    if (grafanaPoll && "error" in grafanaPoll) return grafanaPoll;
    next.grafanaPoll = grafanaPoll;
  }
  if ("slackWatch" in patch) {
    const slackWatch = sanitizeSlackWatch(patch.slackWatch);
    if (slackWatch && "error" in slackWatch) return slackWatch;
    next.slackWatch = slackWatch;
  }
  if ("model" in patch) {
    const model = sanitizeModel(patch.model);
    if (model && typeof model === "object") return model;
    next.model = model;
  }
  if ("fallbackModel" in patch) {
    const fallbackModel = sanitizeModel(patch.fallbackModel, true);
    if (fallbackModel && typeof fallbackModel === "object") return fallbackModel;
    next.fallbackModel = fallbackModel;
  }
  if ("accountId" in patch) {
    const accountId = sanitizeAccountId(patch.accountId);
    if (accountId && typeof accountId === "object") return accountId;
    next.accountId = accountId;
  }
  if ("accountStrict" in patch) {
    next.accountStrict = patch.accountStrict === false ? false : undefined;
  }
  if ("usageCredits" in patch) {
    next.usageCredits = patch.usageCredits === true || undefined;
  }
  // Backfill secrets for automations created before webhook support
  if (!next.webhookSecret) next.webhookSecret = generateSecret();
  saveAutomation(next);
  return next;
}

/**
 * Prompt self-update for selfImprove automations (the opensession-self MCP's
 * write path). Own record only; a timestamped backup lands next to the record
 * and an audit event records the reason, so a bad self-edit is one `cp` from
 * undone. Length floor guards against self-lobotomy (a degenerate rewrite
 * that drops the prompt's structure and guardrails).
 */
export function updateAutomationPromptSelf(
  id: string,
  newPrompt: string,
  reason: string
): { ok: true; backupPath: string } | { ok: false; error: string } {
  const a = getAutomation(id);
  if (!a) return { ok: false, error: "Automation not found." };
  const prompt = (newPrompt || "").trim();
  if (prompt.length < 500) {
    return {
      ok: false,
      error: `Refused: new prompt is ${prompt.length} chars — a full replacement this short would drop the prompt's structure/guardrails. Pass the COMPLETE prompt.`,
    };
  }
  if (!reason?.trim()) return { ok: false, error: "A one-line reason is required (audited)." };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const backupPath = `${AUTOMATIONS_DIR}/${id}.json.bak.self-${stamp}`;
  writeJsonAtomic(backupPath, a);
  const res = updateAutomation(id, { prompt });
  if ("error" in res) return { ok: false, error: res.error };
  audit({
    msg: "automation_self_update",
    automation_id: id,
    automation_name: a.name,
    reason: reason.trim().slice(0, 500),
    prompt_bytes_before: Buffer.byteLength(a.prompt, "utf8"),
    prompt_bytes_after: Buffer.byteLength(prompt, "utf8"),
    backup: backupPath,
  });
  return { ok: true, backupPath };
}

/**
 * The two scoped in-process servers a selfImprove automation run gets (see
 * the Automation.selfImprove doc). Used by runAutomation for scheduled/manual
 * runs AND — via selfImproveMcpForSession — by the interactive-resume paths
 * (run-session.ts, interactive-mcp.ts's run-rpc fallback builder), so a Slack
 * thread reply reaches a session with the same tools the nightly run had.
 */
export function selfImproveMcpServers(
  a: Automation,
  sessionId: string
): Record<string, unknown> {
  return {
    "opensession-sessions": createSessionsMcpServer({
      createdBy: `${a.name} (automation)`,
      isAdmin: false,
      automationSelf: true,
      currentSessionId: sessionId,
    }),
    "opensession-self": createSelfImproveMcpServer({
      automationName: a.name,
      getOwn: () => {
        const cur = getAutomation(a.id);
        if (!cur) return null;
        const { name, prompt, schedule, mode, repo, model, mcpServers } = cur;
        return { name, prompt, schedule, mode, repo, model, mcpServers };
      },
      updateOwnPrompt: (p, reason) => updateAutomationPromptSelf(a.id, p, reason),
    }),
  };
}

/** selfImproveMcpServers for a session file (automation resolved by the name
 *  stamped on the session) — undefined unless that automation has the flag. */
export function selfImproveMcpForSession(
  session: { automation?: string },
  sessionId: string
): Record<string, unknown> | undefined {
  if (!session.automation) return undefined;
  const a = listAutomations().find((x) => x.name === session.automation);
  if (!a?.selfImprove) return undefined;
  return selfImproveMcpServers(a, sessionId);
}

/** The automation-bar servers rebuilt for run-rpc's FALLBACK path. A real
 *  restart mid-run wipes the per-run registration (globalThis parking only
 *  survives hot reloads) while the reattached engine turn keeps calling its
 *  stdio proxies — so rebuild opensession-report (every run) and
 *  opensession-workflows (human-set `workflows` flag only) from the automation
 *  record, exactly the set runAutomation registers at dispatch. Never the
 *  admin/sessions siblings. */
export function automationRunMcpForSession(
  session: { automation?: string; worktreeDir?: string | null },
  sessionId: string
): Record<string, unknown> | undefined {
  if (!session.automation) return undefined;
  const a = listAutomations().find((x) => x.name === session.automation);
  if (!a) return undefined;
  const servers: Record<string, unknown> = {
    "opensession-report": createReportMcpServer({
      automationId: a.id,
      automationName: a.name,
      sessionId,
    }),
  };
  if (a.workflows) {
    const cwd = session.worktreeDir || getRepo(a.repo).repo;
    servers["opensession-workflows"] = createWorkflowsMcpServer({
      sessionId,
      user: `${a.name} (automation)`,
      workspace: (requestedRepo) =>
        !requestedRepo || requestedRepo === a.repo
          ? { cwd, repo: a.repo }
          : undefined,
      // A script's mcp.* surface is the automation's own least-privilege one —
      // it must never be a way around the allowlist or the denied writes.
      mcpAllowlist: a.mcpServers,
      deniedTools: AUTOMATION_DENIED_TOOLS,
    });
  }
  return servers;
}

export function deleteAutomation(id: string): boolean {
  const path = `${AUTOMATIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ── Runner ───────────────────────────────────────────────────

const runningCounts = new Map<string, number>();

const RUNS_CAP = 50;

/** Prepend a run-ledger entry (plus the legacy lastRun* mirror fields) on a
 *  fresh read of the automation — event/webhook runs can overlap, so never
 *  write ledger updates from a stale copy. */
function recordRunStart(id: string, run: AutomationRun): void {
  const fresh = getAutomation(id);
  if (!fresh) return;
  saveAutomation({
    ...fresh,
    lastRunAt: run.at,
    lastRunSessionId: run.sessionId,
    lastRunStatus: "running",
    lastRunError: undefined,
    lastTrigger: run.trigger,
    runs: [run, ...(fresh.runs || [])].slice(0, RUNS_CAP),
  });
}

/** Settle the ledger entry for `sessionId` (matched by id, not position, so
 *  overlapping runs settle independently). */
function settleRun(id: string, sessionId: string, patch: Pick<AutomationRun, "status" | "error" | "durationMs">): void {
  const fresh = getAutomation(id);
  if (!fresh) return;
  saveAutomation({
    ...fresh,
    ...(fresh.lastRunSessionId === sessionId
      ? { lastRunStatus: patch.status, lastRunError: patch.error }
      : {}),
    runs: (fresh.runs || []).map((r) => (r.sessionId === sessionId ? { ...r, ...patch } : r)),
  });
}

// Automation runs are headless and often driven by untrusted text (e.g.
// customer ticket content), so they must stay read-only toward the customer:
// no replying to or changing the state of a Plain thread. Enforced at the
// tool-permission layer — prompt instructions alone don't constrain a run.
const PLAIN_WRITE_DENIAL =
  "This tool isn't available in automation runs — they are read-only toward the " +
  "customer thread. Put your suggested reply or status change in the internal " +
  "note (mcp__plain__create_note) for a human to act on instead.";
// WorkOS lookups (get_*/list_*) are fine for investigation, but its MCP also
// exposes destructive identity tools — creating/deleting users and orgs,
// revoking sessions, password resets, and especially impersonation URLs (login
// as the customer). Untrusted ticket text must never reach those, so deny the
// write/destructive subset at the tool layer and keep the read tools.
const WORKOS_WRITE_DENIAL =
  "This tool isn't available in automation runs — they get read-only WorkOS " +
  "access for investigation. Use get_*/list_* to look up the user/org; if a " +
  "change is needed, recommend it in the note for a human to do.";
const AUTOMATION_DENIED_TOOLS: Record<string, string> = {
  // Plain: read + internal note only, never customer-facing or state-changing
  mcp__plain__reply_to_thread: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_done: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_todo: PLAIN_WRITE_DENIAL,
  mcp__plain__snooze_thread: PLAIN_WRITE_DENIAL,
  // WorkOS: read-only — no identity mutation or impersonation from a run
  mcp__workos__create_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__create_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__create_user: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_user: WORKOS_WRITE_DENIAL,
  mcp__workos__update_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__update_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__update_user: WORKOS_WRITE_DENIAL,
  mcp__workos__revoke_invitation: WORKOS_WRITE_DENIAL,
  mcp__workos__revoke_session: WORKOS_WRITE_DENIAL,
  mcp__workos__send_invitation: WORKOS_WRITE_DENIAL,
  mcp__workos__send_password_reset_email: WORKOS_WRITE_DENIAL,
  mcp__workos__send_verification_email: WORKOS_WRITE_DENIAL,
  mcp__workos__get_impersonation_url: WORKOS_WRITE_DENIAL,
};

/** Tool-permission denials applied to every automation run (and to interactive
 *  resumes of automation-owned sessions). Read-only toward customers/identity. */
export function automationDeniedTools(): Record<string, string> {
  return AUTOMATION_DENIED_TOOLS;
}

/** MCP allowlist for an automation, resolved by its display name (as stored on
 *  a session's `automation` field). Returns undefined if not found. */
export function automationMcpServersByName(name: string): string[] | undefined {
  return listAutomations().find((a) => a.name === name)?.mcpServers;
}

/** Default engine+model for automations (Michiel 2026-07-09: automations run
 *  on the opencode engine; 2026-07-22: model-less automations default to Sol
 *  on the codex pool — research-class automations pin claude-fable-5
 *  explicitly instead of relying on this). */
export const DEFAULT_OPENCODE_AUTOMATION_MODEL = "opencode/openai/gpt-5.6-sol";

/**
 * Map an automation's configured model (or a router's modelOverride) onto the
 * opencode engine, tier-preserving: claude-sonnet-4-6 →
 * opencode/anthropic/claude-sonnet-4-6, gpt-5.5 → opencode/openai/gpt-5.5,
 * unset → DEFAULT_OPENCODE_AUTOMATION_MODEL. Automations keep their stored
 * tier ids; the flip to opencode happens here at dispatch, so it covers every
 * automation (and future ones) uniformly.
 *
 * Fail-safe: when the Anthropic bridge is disabled (~/.backstage-opencode.json)
 * claude tiers keep their original id and run on the claude engine as before —
 * a config toggle must degrade automations to the old engine, not break them.
 * The least-privilege deny-set is enforced on every engine either way
 * (canUseTool / disabled_tools / opencodeRunPolicy).
 */
export function opencodeAutomationModel(model?: string): string | undefined {
  const m = (model || "").trim();
  if (m.startsWith("opencode/")) return m;
  // The openai path keys off codex accounts, not the bridge flag — always map.
  if (m.startsWith("gpt-")) return `opencode/openai/${m}`;
  // The default is Sol (openai path), so it applies regardless of the
  // anthropic bridge flag — the bridge fail-safe below only concerns claude-*.
  if (!m) return DEFAULT_OPENCODE_AUTOMATION_MODEL;
  if (readOpencodeBridgeConfig()?.enabled !== true) return model;
  if (m.startsWith("claude-")) return `opencode/anthropic/${m}`;
  return model; // unknown shapes (codex-*, custom ids) keep their engine
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "automation";
}

export function isAutomationRunning(id: string): boolean {
  return (runningCounts.get(id) || 0) > 0;
}

export async function runAutomation(
  automation: Automation,
  onSessionCreated?: (sessionId: string) => void,
  options?: {
    trigger?: "cron" | "webhook" | "manual" | "event";
    eventContext?: string;
    /**
     * Pre-generated backstage session id. Lets a caller post UI/Slack controls
     * that reference the session (e.g. an Open-in-Backstage link and a Stop
     * button) before the run starts, instead of waiting for onSessionCreated.
     */
    bksSessionId?: string;
    /**
     * Model for THIS run only, beating the automation's configured model —
     * e.g. the Plain ticket router downgrading a basic ticket to a cheaper
     * model. Callers pass an already-resolved model id.
     */
    modelOverride?: string;
  }
): Promise<void> {
  const trigger = options?.trigger || "manual";
  // Cron/manual runs don't stack; event/webhook runs are per-event, so they may overlap
  const concurrent = trigger === "event" || trigger === "webhook";
  if (!concurrent && isAutomationRunning(automation.id)) {
    console.log(`[automations] "${automation.name}" still running, skipping`);
    return;
  }
  runningCounts.set(automation.id, (runningCounts.get(automation.id) || 0) + 1);

  const startedAt = new Date();
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", " ");
  const bksId = options?.bksSessionId || `bks-${randomUUIDv7()}`;

  try {
    // The automation's repo (instance default when omitted). Ask mode reads the repo's
    // pinned ask checkout (default branch — never the mutable main checkout);
    // code mode gets an isolated worktree — `isolated` matters for
    // shared-checkout repos (backstage), where an unattended run must never
    // work in the live checkout: it ships a PR and a human merges.
    const repo = getRepo(automation.repo);
    let cwd = "";
    let branch = "";
    if (automation.mode === "code") {
      branch = `auto-${slugify(automation.name)}-${startedAt
        .toISOString()
        .slice(0, 16)
        .replace(/[-T:]/g, "")}`;
      const worktrees = await listWorktrees(repo.id);
      cwd =
        worktrees.find((w) => w.branch === branch)?.path ||
        (await createWorktree(branch, repo.id, { isolated: true }));
    } else {
      cwd = await ensureAskCheckout(repo.id);
    }

    recordRunStart(automation.id, {
      at: startedAt.toISOString(),
      sessionId: bksId,
      trigger,
      status: "running",
    });

    let prompt = automation.prompt;
    // Tell the run which model it's executing as, so a prompt that wants to
    // record it (e.g. Plain triage stamps the model on its note) can quote an
    // accurate name instead of guessing. This is the model the run STARTS on;
    // a mid-run usage-limit fallback can swap it (tracked in modelHistory), so
    // word it as "started on".
    {
      const runModelForPrompt = opencodeAutomationModel(
        options?.modelOverride || automation.model,
      );
      const displayModel = (runModelForPrompt || "").replace(
        /^opencode\/[^/]+\//,
        "",
      );
      if (displayModel)
        prompt += `\n\n## Model\n\nThis run started on the \`${displayModel}\` model.`;
    }
    if (options?.eventContext) {
      const source =
        trigger !== "event"
          ? "a webhook"
          : automation.slackWatch
            ? `a new message in the Slack channel this automation watches (<#${automation.slackWatch.channel}>)`
            : `an internal event (${automation.eventKey})`;
      prompt += `\n\n## Triggering event\n\nThis run was triggered by ${source}. Event payload:\n\n\`\`\`\n${options.eventContext.slice(0, 10_000)}\n\`\`\``;
    }

    // Channel-watch runs get the channel's memory (facts taught via
    // remember/forget in interactive Slack sessions) as standing context.
    // Read-only here — automation runs don't get the memory tools.
    if (automation.slackWatch) {
      try {
        const { renderMemoryForPrompt } = await import("../agents/slack/memory");
        prompt += await renderMemoryForPrompt({
          channel: automation.slackWatch.channel,
          userId: "",
          isDM: false,
          isPrivate: true, // per-channel scope + read-only workspace view
        });
      } catch {}
    }

    // Repo + team memory (taught via opensession-memory in interactive
    // sessions) as standing context. Read-only — automation runs never get
    // the memory write tools (untrusted event text must not be able to plant
    // standing context). Channel-watch runs already carry the workspace store
    // via the channel memory above, so skip the team scope for them.
    try {
      const { renderSessionMemoryNote, sessionMemoryScopes } = await import(
        "./session-memory"
      );
      const note = await renderSessionMemoryNote(
        sessionMemoryScopes({
          repos: [getRepo(automation.repo).id],
          includeTeam: !automation.slackWatch,
        })
      );
      if (note) prompt += `\n\n${note}`;
    } catch {}

    // Tie the session to its Plain thread (if the event carries one) so it
    // can be archived when the ticket is done, and use the ticket's
    // title as the session title
    let plainThreadId: string | undefined;
    let eventTitle: string | undefined;
    if (options?.eventContext) {
      try {
        const parsed = JSON.parse(options.eventContext);
        if (typeof parsed.threadId === "string") plainThreadId = parsed.threadId;
        if (typeof parsed.title === "string" && parsed.title.trim()) {
          eventTitle = parsed.title.trim().slice(0, 100);
        }
      } catch {}
    }
    // File ticket-triggered sessions under the ticket's ONE workspace so they
    // show up as chat tabs there (adopt-don't-duplicate; workspace-resolve.ts).
    let ticketWorkspaceId: string | undefined;
    if (plainThreadId) {
      try {
        ticketWorkspaceId = resolvePlainWorkspace({
          threadId: plainThreadId,
          title: eventTitle,
          createdBy: `${automation.name} (automation)`,
        }).workspace.id;
      } catch {}
    }

    // Automations dispatch on the opencode engine (tier-preserving mapping;
    // see opencodeAutomationModel). The effective model/provider can change
    // mid-run (usage-limit fallback), so track them from the runner's
    // init/done events for persistence.
    const runModel = opencodeAutomationModel(options?.modelOverride || automation.model);
    let effectiveModel = runModel;
    let selectedModel = runModel;
    let effectiveProvider = providerFor(effectiveModel);
    const modelHistory: NonNullable<BackstageSessionFile["modelHistory"]> = [];
    // Slack messages this run posts (via the slack MCP, or via bash+curl
    // announcing a SLACK_MSG_POSTED marker) — captured from the tool stream so
    // a human reply in one of those threads routes back to THIS session
    // (thread index in slack-links.ts) instead of starting a new one. The same
    // scanner runs in recordRecoveredRunEvent (run-session.ts) so posts made
    // after a restart-reattach are captured too.
    const slackThreads: Array<{ channel: string; threadTs: string }> = [];
    const slackPostScan = createSlackPostScanner();
    const linkSlackThread = (
      engineSessionId: string,
      channel?: string,
      threadTs?: string,
    ) => {
      if (!channel || !threadTs) return;
      if (slackThreads.some((t) => t.channel === channel && t.threadTs === threadTs))
        return;
      slackThreads.push({ channel, threadTs });
      // Live-link + persist immediately so a fast reply routes even while
      // the run is still going (fire-and-forget: the per-session write chain
      // orders it against the init/final persists).
      linkThreadInIndex(bksId, channel, threadTs);
      persistSession(engineSessionId).catch((e) =>
        console.error(`[automations] session persist failed for ${bksId}:`, e)
      );
    };
    // Field-scoped write: creation fields are create-if-absent defaults (an
    // existing file — e.g. one an interactive thread-reply resume already
    // wrote to — wins); this run only owns the engine-id/model fields, the
    // HEAD-synced branch, and the Slack threads it posted. Serialized via
    // updateSessionFile.
    const persistSession = (engineSessionId: string) =>
      updateSessionFile(bksId, (data) => {
        // Widen to Partial: the file may not exist yet (create-if-absent).
        const existing: Partial<BackstageSessionFile> = data;
        return {
          id: bksId,
          claudeSessionId: "",
          worktreeDir: cwd,
          createdBy: `${automation.name} (automation)`,
          createdAt: startedAt.toISOString(),
          title: eventTitle || `${automation.name} — ${stamp}`,
          mode: automation.mode,
          automation: automation.name,
          automationId: automation.id,
          // Keep the automation's account pin on the session so interactive
          // resumes of this session run on the same subscription.
          ...(automation.accountId ? { accountId: automation.accountId } : {}),
          // Keep the trigger payload so a thread reply of "retrigger" can replay
          // this exact run (same truncation as the prompt embed).
          ...(options?.eventContext
            ? { automationEvent: options.eventContext.slice(0, 10_000) }
            : {}),
          ...(plainThreadId ? { plainThreadId } : {}),
          ...(ticketWorkspaceId ? { projectId: ticketWorkspaceId } : {}),
          ...existing,
          ...(engineSessionId
            ? engineSessionPatch(effectiveProvider, engineSessionId)
            : {}),
          ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
          ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(modelHistory.length ? { modelHistory } : {}),
          // Code-mode runs can rename their auto-generated branch before opening
          // a PR — record the worktree's actual HEAD so PR lookups and the
          // review handoff keep resolving this session.
          branch: (branch && worktreeHeadBranch(cwd)) || branch,
          ...(slackThreads.length ? { slackThreads: [...slackThreads] } : {}),
          lastActivity: new Date().toISOString(),
        };
      });

    console.log(
      `[automations] Running "${automation.name}" → ${bksId}${runModel ? ` (${runModel})` : ""}${options?.modelOverride ? " [routed]" : ""}`
    );

    // In-process servers for automation runs — all held to the automation
    // bar (append-only, nothing sensitive readable, no control surface; the
    // run-rpc builder in interactive-mcp.ts fails closed so an automation
    // session can never resolve the admin/sessions siblings through the same
    // socket). Registered per run so the proxy executes THESE instances with
    // automation context.
    // - opensession-report: every run — publish_report into this automation's
    //   own Reports group (reports.ts), the Reports-view surface.
    // - opensession-papercuts: friction log; per-repo toggle in Settings.
    // - opensession-workflows: HUMAN-flagged automations only (`workflows`,
    //   e.g. the morning support digest) — see workflow-tools.ts trust notes.
    // - self-improve pair: human-set `selfImprove` flag (Dreaming).
    const reportMcp = {
      "opensession-report": createReportMcpServer({
        automationId: automation.id,
        automationName: automation.name,
        sessionId: bksId,
      }),
    };
    const papercutsMcp = papercutsEnabledForRepo(repo.id)
      ? {
          "opensession-papercuts": createPapercutsMcpServer({
            sessionId: bksId,
            runKind: "automation",
            by: `${automation.name} (automation)`,
            defaults: () => ({ repo: repo.id, model: effectiveModel }),
          }),
        }
      : undefined;
    const workflowsMcp = automation.workflows
      ? {
          "opensession-workflows": createWorkflowsMcpServer({
            sessionId: bksId,
            user: `${automation.name} (automation)`,
            workspace: (requestedRepo) =>
              !requestedRepo || requestedRepo === repo.id
                ? { cwd, repo: repo.id }
                : undefined,
            // Same scoping as the run itself: a workflow script's mcp.* calls
            // see this automation's allowlist, minus the denied writes.
            mcpAllowlist: automation.mcpServers,
            deniedTools: AUTOMATION_DENIED_TOOLS,
          }),
        }
      : undefined;
    const selfMcp = automation.selfImprove
      ? selfImproveMcpServers(automation, bksId)
      : undefined;
    const inProcessMcp = {
      ...reportMcp,
      ...(papercutsMcp || {}),
      ...(workflowsMcp || {}),
      ...(selfMcp || {}),
      // Held to the same bar as opensession-papercuts: append-only, reads
      // nothing, controls nothing. It only lets an unattended run say "I
      // looked and there was nothing to report" instead of ending on silence
      // that reads exactly like an early stop (src/server/turn-outcome.ts).
      "opensession-turn": createTurnMcpServer({ turnKey: bksId }),
    };
    registerSessionMcpServers(bksId, inProcessMcp);

    let engineSessionId = "";
    let errorMsg = "";
    for await (const event of runAgent({
      prompt,
      cwd,
      mode: automation.mode,
      model: runModel,
      mcpServers: automation.mcpServers,
      inProcessMcp,
      deniedTools: AUTOMATION_DENIED_TOOLS,
      // No onAskUser here, so confirm tools deny with "propose it for a human"
      // (codex disables them outright — codex-runner.ts; opencode strips them
      // from the tool list with the same post-in-note guidance — opencodeRunPolicy)
      confirmTools: STRIPE_CONFIRM_TOOLS,
      aws: true, // automation runs get short-lived instance-role read creds
      // Cost controls: a pinned account defaults to a HARD pin for automation
      // runs (exhaustion falls to fallbackModel, never the shared pool) unless
      // accountStrict is explicitly false (soft pin: preferred, pool backup);
      // usage-credits spend is only allowed when explicitly enabled.
      accountId: automation.accountId,
      accountStrict: !!automation.accountId && automation.accountStrict !== false,
      usageCredits: automation.usageCredits,
      // Fallback also runs on opencode (tier-preserving, same mapping as the
      // primary): a usage-limit fallback must not drop back onto the native
      // Codex/Claude SDK. "none" disables fallback; unset with no global
      // default = no fallback (never inject the automation default here).
      fallbackModel: (() => {
        if (automation.fallbackModel === "none") return undefined;
        const fb = automation.fallbackModel || DEFAULT_FALLBACK_MODEL;
        return fb ? opencodeAutomationModel(fb) : undefined;
      })(),
      journal: { bksSessionId: bksId, kind: "automation" },
    })) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || "";
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
        await persistSession(engineSessionId);
        onSessionCreated?.(bksId);
      }
      // Capture Slack posts (slack MCP calls + SLACK_MSG_POSTED markers from
      // bash-side posters like dispute_report_pdf.sh) — see
      // createSlackPostScanner in slack-links.ts.
      const slackPost = slackPostScan(event);
      if (slackPost) {
        linkSlackThread(engineSessionId, slackPost.channel, slackPost.threadTs);
      }
      if (event.type === "model_switch") {
        const to = event.toModel || "";
        if (to) {
          effectiveModel = to;
          effectiveProvider = providerFor(to);
          if (shouldPersistModelSwitch(event)) {
            selectedModel = to;
            modelHistory.push({
              model: to,
              at: new Date().toISOString(),
              by: `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`,
            });
          }
        }
      }
      if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      }
      if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }

    await persistSession(engineSessionId);

    settleRun(automation.id, bksId, {
      status: errorMsg ? "error" : "ok",
      error: errorMsg || undefined,
      durationMs: Date.now() - startedAt.getTime(),
    });
    console.log(
      `[automations] "${automation.name}" finished ${errorMsg ? `with error: ${errorMsg}` : "ok"}`
    );
  } catch (e: any) {
    console.error(`[automations] "${automation.name}" failed:`, e);
    settleRun(automation.id, bksId, {
      status: "error",
      error: e.message || String(e),
      durationMs: Date.now() - startedAt.getTime(),
    });
  } finally {
    unregisterSessionMcpServers(bksId);
    const left = (runningCounts.get(automation.id) || 1) - 1;
    if (left <= 0) runningCounts.delete(automation.id);
    else runningCounts.set(automation.id, left);
  }
}

// ── Internal event bus ───────────────────────────────────────
// Agents (Plain/Slack/Linear) publish events; automations subscribe
// via their eventKey. Each event gets its own run (may overlap).

let eventSessionCallback: ((sessionId: string) => void) | undefined;

export function setEventSessionCallback(cb: (sessionId: string) => void): void {
  eventSessionCallback = cb;
}

/**
 * Re-fire the automation behind an automation-created session, replaying the
 * original triggering event payload (stored on the session file). Used by the
 * Slack handlers: a thread reply of "retrigger" under a message the run posted
 * starts a fresh run instead of steering the old session. Fire-and-forget —
 * the new run posts its own results.
 */
export function retriggerAutomationSession(
  sessionId: string,
): { ok: true; name: string } | { ok: false; reason: string } {
  let session: BackstageSessionFile;
  try {
    session = JSON.parse(
      readFileSync(`${SESSIONS_DIR}/${sessionId}.json`, "utf-8"),
    );
  } catch {
    return { ok: false, reason: `session ${sessionId} not found` };
  }
  // automationId is stamped since 2026-07-16; older sessions only carry the
  // automation's name — fall back to matching on that.
  const automation = session.automationId
    ? getAutomation(session.automationId)
    : session.automation
      ? (listAutomations().find((a) => a.name === session.automation) ?? null)
      : null;
  if (!automation) {
    return {
      ok: false,
      reason: `no automation found for session ${sessionId} (${session.automation || "not an automation session"})`,
    };
  }
  if (!automation.enabled) {
    return { ok: false, reason: `automation "${automation.name}" is disabled` };
  }
  // With a stored event payload, replay it as an event run (concurrent-safe,
  // like the original). Without one (cron/manual automations) run it plainly —
  // "manual" also gives the still-running skip guard.
  void runAutomation(automation, eventSessionCallback, {
    trigger: session.automationEvent ? "event" : "manual",
    eventContext: session.automationEvent,
  });
  return { ok: true, name: automation.name };
}

/** True when at least one enabled automation watches this Slack channel —
 *  cheap pre-check so the Slack intake doesn't build payloads for nothing. */
export function isChannelWatched(channelId: string): boolean {
  return listAutomations().some((a) => a.enabled && a.slackWatch?.channel === channelId);
}

/** Fire every enabled automation watching `channelId` (one run per message —
 *  these may overlap, like event runs). Returns how many fired. */
export function fireAutomationsForSlackChannel(channelId: string, payload: string): number {
  let fired = 0;
  for (const automation of listAutomations()) {
    if (!automation.enabled || automation.slackWatch?.channel !== channelId) continue;
    console.log(`[automations] Watched channel ${channelId} → "${automation.name}"`);
    void runAutomation(automation, eventSessionCallback, {
      trigger: "event",
      eventContext: payload,
    });
    fired++;
  }
  return fired;
}

export function fireAutomationsForEvent(
  eventKey: string,
  payload: string,
  opts?: { modelOverride?: string }
): number {
  let fired = 0;
  for (const automation of listAutomations()) {
    if (!automation.enabled || automation.eventKey !== eventKey) continue;
    console.log(`[automations] Event ${eventKey} → "${automation.name}"`);
    void runAutomation(automation, eventSessionCallback, {
      trigger: "event",
      eventContext: payload,
      modelOverride: opts?.modelOverride,
    });
    fired++;
  }
  return fired;
}

// ── Scheduler ────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastFiredMinute = "";

export function startScheduler(onSessionCreated?: (sessionId: string) => void): void {
  if (schedulerInterval) return;

  schedulerInterval = setInterval(() => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    if (minuteKey === lastFiredMinute) return;
    lastFiredMinute = minuteKey;

    for (const automation of listAutomations()) {
      if (!automation.enabled) continue;

      // One-off runs (reminders / "do this again later"): fire once at/after the
      // target instant, then delete. We persist a "consumed" copy (runOnceAt
      // cleared, disabled) BEFORE firing so a long-running or crashed run can
      // never double-fire on a later tick; the file is deleted once it settles.
      if (automation.runOnceAt) {
        if (Date.parse(automation.runOnceAt) <= now.getTime()) {
          saveAutomation({ ...automation, runOnceAt: undefined, enabled: false });
          void runAutomation({ ...automation, runOnceAt: undefined, enabled: false }, onSessionCreated, {
            trigger: "cron",
          }).finally(() => deleteAutomation(automation.id));
        }
        continue;
      }

      if (!automation.schedule) continue;
      if (cronMatches(automation.schedule, now)) {
        // Fire and forget — runner guards against overlap per automation
        void runAutomation(automation, onSessionCreated, { trigger: "cron" });
      }
    }
  }, 20_000);

  console.log("[automations] Scheduler started (20s tick, UTC cron)");
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

// ── Webhook trigger ──────────────────────────────────────────
// POST /automations/<id>/<secret> on the public webhook server (3848,
// proxied by Caddy). The secret in the path is the only auth, so it's
// long-random and rotatable by editing the automation file.

export function getWebhookRoutes(
  onSessionCreated?: (sessionId: string) => void
): Map<string, (req: Request, url: URL) => Promise<Response>> {
  const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

  routes.set("POST /automations/*", async (req, url) => {
    const m = url.pathname.match(/^\/automations\/([^/]+)\/([^/]+)$/);
    if (!m) return Response.json({ error: "Bad path" }, { status: 400 });

    const automation = getAutomation(m[1]);
    // Same response for unknown id and bad secret — don't leak which ids exist
    if (!automation || !automation.webhookSecret || automation.webhookSecret !== m[2]) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!automation.enabled) {
      return Response.json({ ok: false, skipped: "disabled" });
    }
    if (isAutomationRunning(automation.id)) {
      return Response.json({ ok: false, skipped: "already running" });
    }

    let payload = "";
    try {
      payload = (await req.text()).slice(0, 10_000);
    } catch {}

    console.log(`[automations] Webhook trigger: "${automation.name}"`);
    void runAutomation(automation, onSessionCreated, {
      trigger: "webhook",
      eventContext: payload || "(empty body)",
    });

    return Response.json({ ok: true });
  });

  return routes;
}
