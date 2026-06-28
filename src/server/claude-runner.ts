import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { readMcpConfig, withDynamicCredentials } from "./connections";
import { getAgentAwsEnv } from "./aws-creds";
import { audit, summarizeText } from "./audit";
import { pickAccount, markExhausted, type ClaudeAccount } from "./claude-accounts";
import { cleanPlainToolInput } from "./shared/note-style";
import { gitIdentityEnv, type GitIdentity } from "./shared/user-mappings";
import { getDefaultModel } from "./models";

const HOME = process.env.HOME || "/home/ubuntu";
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
const CLAUDE_DIR = `${HOME}/.claude`;
const CLAUDE_CREDENTIALS_PATH = `${CLAUDE_DIR}/.credentials.json`;
const CLAUDE_ACCOUNTS_DIR = `${CLAUDE_DIR}/accounts`;
const CLAUDE_ACTIVE_ACCOUNT_PATH = `${CLAUDE_ACCOUNTS_DIR}/.active`;

export interface StreamEvent {
  type: "init" | "text_chunk" | "tool_use" | "tool_result" | "done" | "error";
  sessionId?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  content?: string;
  result?: string;
  /**
   * Renderable image sources on a tool_result (data: URLs from base64 blocks,
   * or direct urls). Forwarded to viewers so screenshots show up the moment
   * the tool returns instead of waiting for the jsonl tail to catch up.
   */
  images?: string[];
  /**
   * Renderable video sources on a tool_result, parsed from `BACKSTAGE_VIDEO:`
   * markers in the (full, pre-truncation) tool output. Forwarded so recordings
   * play the moment the tool returns, no reload needed.
   */
  videos?: string[];
  /** Which backend emitted this event (set on init/done). */
  provider?: "claude" | "codex";
  /** Effective model for the run (set on init/done). */
  model?: string;
  /**
   * Set on a terminal done/error when the run died on usage limits with no
   * account left to rotate to — the dispatcher's cue to try a fallback model.
   */
  usageLimitExhausted?: boolean;
}

// Track active runs to prevent concurrent runs on same session. Parked on
// globalThis so a `bun --hot` reload of this module keeps existing runs
// steerable/cancelable (and countable for graceful shutdown).
const activeRuns: Map<string, AbortController> = ((globalThis as any).__activeClaudeRuns ??=
  new Map());

/** Number of Claude runs this process is actively driving (for shutdown drain). */
export function activeRunCount(): number {
  return activeRuns.size;
}

// Minimal environment for the spawned Claude process. Backstage's own env
// carries every API token and webhook secret from ~/.backstage.env; the agent
// child needs none of those — MCP servers get their credentials via
// mcp-config.json's per-server `env` (or load it themselves, like the
// workos-mcp wrapper). Only pass what the child needs to launch and run.
//
// `awsEnv` (optional) carries short-lived AWS credentials minted for this run;
// see aws-creds.ts. The child can't reach IMDS (cgroup deny), so these injected
// vars are its only AWS access.
function childEnv(
  awsEnv?: Record<string, string>,
  oauthToken?: string,
  author?: GitIdentity | null
): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    MICHAEL_MODEL: process.env.MICHAEL_MODEL,
    // Attribute commits this run makes to the user who sent the prompt (empty for
    // unknown/automation authors → keeps the machine's default git identity).
    ...gitIdentityEnv(author),
    // Account-pool token (claude-accounts.ts). Beats ~/.claude/.credentials.json
    // in the CLI's auth precedence, so runs rotate accounts without touching
    // the interactive CLI's login.
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    ...awsEnv,
  };
}

// `strict` matching applies to successful results too — the CLI reports usage
// limits as a plain result text ("Claude AI usage limit reached|<ts>",
// "5-hour limit reached ∙ resets …"), with subtype "success". The looser
// heuristic only applies to error results, where false positives can't
// clobber a legitimate answer.
export function isClaudeUsageLimitError(message: string, isErrorResult: boolean): boolean {
  const s = message.toLowerCase();
  // Observed CLI phrasings: "You've hit your session limit · resets 12:50pm (UTC)",
  // "Claude AI usage limit reached|<ts>", "5-hour limit reached ∙ resets 3am"
  if (/you've hit your .{0,20}limit/.test(s)) return true;
  if (/claude (ai )?usage limit reached/.test(s)) return true;
  if (/limit (reached|hit).{0,60}resets/.test(s)) return true;
  // Short result that is just a limit notice, whatever the exact phrasing
  if (s.length < 200 && /\blimit\b/.test(s) && /\bresets\b/.test(s)) return true;
  if (!isErrorResult) return false;
  if (s.includes("rate_limit_error") || s.includes("429") || s.includes("too many requests")) return true;
  return (
    (s.includes("usage") || s.includes("rate") || s.includes("limit")) &&
    (s.includes("exceeded") || s.includes("reached"))
  );
}

function listSavedClaudeAccounts(): string[] {
  if (!existsSync(CLAUDE_ACCOUNTS_DIR)) return [];
  return readdirSync(CLAUDE_ACCOUNTS_DIR).filter((name) => {
    if (name.startsWith(".")) return false;
    return existsSync(`${CLAUDE_ACCOUNTS_DIR}/${name}/credentials.json`);
  });
}

function readActiveClaudeAccount(): string | undefined {
  try {
    return existsSync(CLAUDE_ACTIVE_ACCOUNT_PATH)
      ? readFileSync(CLAUDE_ACTIVE_ACCOUNT_PATH, "utf-8").trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function switchClaudeAccountAfterLimit(): string | undefined {
  const preferred = process.env.CLAUDE_FALLBACK_PROFILE;
  const active = readActiveClaudeAccount();
  const accounts = listSavedClaudeAccounts();
  const next = preferred && preferred !== active && accounts.includes(preferred)
    ? preferred
    : accounts.find((name) => name !== active);

  if (!next) return undefined;

  mkdirSync(`${CLAUDE_DIR}/backups`, { recursive: true });
  if (existsSync(CLAUDE_CREDENTIALS_PATH)) {
    copyFileSync(
      CLAUDE_CREDENTIALS_PATH,
      `${CLAUDE_DIR}/backups/credentials-before-auto-switch-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}.json`
    );
  }
  copyFileSync(`${CLAUDE_ACCOUNTS_DIR}/${next}/credentials.json`, CLAUDE_CREDENTIALS_PATH);
  writeFileSync(CLAUDE_ACTIVE_ACCOUNT_PATH, `${next}\n`);
  console.warn(`[runner] Claude usage limit hit on ${active || "unknown"}; switched credentials to ${next}`);
  return next;
}

/** Resolve the MCP servers for a run: all configured, or just the allowlist. */
function filterMcpServers(allowlist?: string[]): Record<string, unknown> {
  const all = withDynamicCredentials(readMcpConfig().mcpServers);
  if (!allowlist) return all;
  const out: Record<string, unknown> = {};
  for (const name of allowlist) {
    if (all[name]) out[name] = all[name];
    else console.warn(`[runner] MCP allowlist names unknown server "${name}" — skipping`);
  }
  return out;
}

// ── Crash/restart journal ────────────────────────────────────
// Every in-flight run is recorded on disk; entries that survive a process
// restart are interrupted runs, which backstage resumes on boot.

const ACTIVE_RUNS_PATH = `${HOME}/.backstage-sessions/active-runs.json`;

export interface ActiveRunRecord {
  runKey: string;
  bksSessionId?: string;
  claudeSessionId?: string; // claude session id or codex thread id, per model's provider
  cwd: string;
  mode?: "ask" | "code";
  mcpServers?: string[]; // per-run MCP allowlist, preserved across resume
  deniedTools?: Record<string, string>; // per-run tool denials, preserved across resume
  aws?: boolean; // whether to inject AWS creds, preserved across resume
  model?: string; // per-session model, preserved across resume (decides the provider)
  kind?: string;
  startedAt: string;
}

function readRunJournal(): Record<string, ActiveRunRecord> {
  try {
    return existsSync(ACTIVE_RUNS_PATH)
      ? JSON.parse(readFileSync(ACTIVE_RUNS_PATH, "utf-8"))
      : {};
  } catch {
    return {};
  }
}

function writeRunJournal(journal: Record<string, ActiveRunRecord>): void {
  try {
    require("fs").writeFileSync(ACTIVE_RUNS_PATH, JSON.stringify(journal, null, 2));
  } catch (e) {
    console.error("[runner] Failed to write run journal:", e);
  }
}

export function journalSet(record: ActiveRunRecord): void {
  const journal = readRunJournal();
  journal[record.runKey] = record;
  writeRunJournal(journal);
}

export function journalClear(runKey: string): void {
  const journal = readRunJournal();
  if (runKey in journal) {
    delete journal[runKey];
    writeRunJournal(journal);
  }
}

/** Drain interrupted runs left by a previous process (clears the journal). */
export function takeInterruptedRuns(): ActiveRunRecord[] {
  const journal = readRunJournal();
  const entries = Object.values(journal).filter(
    (r) => !activeRuns.has(r.runKey)
  );
  if (entries.length > 0) writeRunJournal({});
  return entries;
}

export function isSessionBusy(sessionId: string): boolean {
  // Check if we have an active run
  if (activeRuns.has(sessionId)) return true;

  // Check if another CLI process is running this session
  if (!existsSync(CLI_SESSIONS_DIR)) return false;
  for (const file of readdirSync(CLI_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(`${CLI_SESSIONS_DIR}/${file}`, "utf-8"));
      if (data.sessionId === sessionId) {
        try {
          process.kill(data.pid, 0);
          return true; // PID alive
        } catch {
          // PID dead
        }
      }
    } catch {}
  }
  return false;
}

export function cancelRun(sessionId: string): boolean {
  const ac = activeRuns.get(sessionId);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
}

// ── Steering ─────────────────────────────────────────────────
// In-flight runs accept extra user messages, Claude-Code style: a message
// arriving mid-turn is merged into the running turn by the SDK; one arriving
// at a turn boundary starts a fresh turn in the same run. Keyed by every id a
// caller might know (run key, engine session id, backstage session id).
const steerControllers = new Map<string, (text: string) => void>();
const interrupters = new Map<string, () => void>();

/** Deliver a message into a running query. False = no steerable run found. */
export function steerRun(sessionId: string, text: string): boolean {
  const push = steerControllers.get(sessionId);
  if (!push) return false;
  push(text);
  return true;
}

/**
 * Esc-style redirect: abort the current turn (graceful — the session and the
 * query survive) and continue immediately with the given message as the next
 * turn. False = no interruptible run found.
 */
export function interruptAndSteerRun(sessionId: string, text: string): boolean {
  const push = steerControllers.get(sessionId);
  const interrupt = interrupters.get(sessionId);
  if (!push || !interrupt) return false;
  push(text); // queue first so the interrupt's turn boundary releases it
  interrupt();
  return true;
}

/**
 * Money-moving Stripe tools: every call pauses for a human approve/deny in the
 * session UI (via onAskUser); unattended runs get a deny telling the agent to
 * propose the action instead. stripe_api_execute is included because it can
 * hit any endpoint the restricted key allows, including refunds and cancels.
 */
export const STRIPE_CONFIRM_TOOLS: Record<string, string> = {
  mcp__stripe__create_refund: "Create a refund",
  mcp__stripe__cancel_subscription: "Cancel a subscription",
  mcp__stripe__update_subscription: "Update a subscription",
  mcp__stripe__stripe_api_execute: "Execute a raw Stripe API call",
};

/** A pasted/dropped image, decoded to raw base64 (no `data:` prefix). */
export interface ImageInput {
  mediaType: string;
  data: string;
}

export async function* runClaude(opts: {
  prompt: string;
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  /** Images to attach to the opening message (vision). Claude only. */
  images?: ImageInput[];
  /**
   * Fork instead of continuing: when `sessionId` is set and `forkSession` is
   * true, the resumed conversation branches into a NEW engine session id rather
   * than appending to the original. Pair with `resumeSessionAt` to branch from a
   * specific past message (its UUID); omit to branch from the latest state.
   */
  forkSession?: boolean;
  resumeSessionAt?: string;
  /** Claude model id for this run; falls back to the global default (getDefaultModel). */
  model?: string;
  /**
   * MCP server allowlist for this run — only the named servers from
   * mcp-config.json are made available. Omitted = all configured servers
   * (interactive sessions). Automations should pass only what they use.
   */
  mcpServers?: string[];
  /**
   * In-process SDK MCP servers (createSdkMcpServer instances) to merge into this
   * run, keyed by name — e.g. michael-sessions / michael-admin for interactive
   * Backstage sessions. These run in the parent process, so ONLY pass them for
   * trusted interactive runs; never for automations (untrusted ticket text must
   * not get session-control / self-management tools). Not journaled — rebuilt
   * fresh from caller context on each run/resume.
   */
  inProcessMcp?: Record<string, unknown>;
  /**
   * Tools to hard-deny at the permission layer, mapping tool name → message
   * shown to the agent. Enforced in canUseTool, so it holds even if the
   * prompt (e.g. freeform ticket text) tries to talk the agent into it.
   */
  deniedTools?: Record<string, string>;
  /**
   * Tools that need an explicit human approve/deny per call, mapping tool
   * name → short action label. With onAskUser available the run pauses on an
   * approval card showing the exact input; without it (unattended runs) the
   * call is denied with instructions to propose the action for a human.
   */
  confirmTools?: Record<string, string>;
  /**
   * Inject short-lived AWS credentials (instance-role read scope) into the
   * child env. Off by default; the run's `aws` calls otherwise have no creds
   * since IMDS is blocked. Enable for runs that legitimately need AWS.
   */
  aws?: boolean;
  /**
   * Git identity for commits this run makes, attributing them to the prompt's
   * author. Set on the child process env (not via git config) so concurrent runs
   * in separate worktrees never race. Omitted = the machine's default identity.
   */
  author?: GitIdentity | null;
  journal?: { bksSessionId?: string; kind?: string };
  onAskUser?: (input: Record<string, unknown>) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}): AsyncGenerator<StreamEvent> {
  const { prompt, sessionId, cwd, mode, mcpServers, deniedTools, confirmTools, aws, author, journal, onAskUser } = opts;
  const model = opts.model || getDefaultModel();
  const isAsk = mode === "ask";

  // Test hook: pretend the whole Claude account pool is exhausted, so the
  // usage-limit fallback chain can be verified without burning real limits.
  // Set MICHAEL_FORCE_LIMIT=1 on a dev process only — never the service env.
  if (process.env.MICHAEL_FORCE_LIMIT === "1") {
    yield {
      type: "done",
      result: "Claude AI usage limit reached|forced-by-MICHAEL_FORCE_LIMIT",
      provider: "claude",
      model,
      usageLimitExhausted: true,
    };
    return;
  }

  if (sessionId && isSessionBusy(sessionId)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }

  const awsEnv = aws ? await getAgentAwsEnv() : undefined;

  const abortController = new AbortController();
  const runKey = sessionId || crypto.randomUUID();
  // Key the run by every id a canceller might know — the run key, the engine
  // session id (added on init below), and the backstage session id. Without
  // the bks key, a fresh run (runKey is a random UUID until the first resume)
  // can't be cancelled by callers that only hold the bks id, e.g. the Slack
  // Stop button on an automation-triggered session. Mirrors codex-runner.
  const activeKeys = new Set<string>([runKey]);
  if (journal?.bksSessionId) activeKeys.add(journal.bksSessionId);
  for (const key of activeKeys) activeRuns.set(key, abortController);
  journalSet({
    runKey,
    bksSessionId: journal?.bksSessionId,
    claudeSessionId: sessionId,
    cwd,
    mode,
    mcpServers,
    deniedTools,
    aws,
    model: opts.model,
    kind: journal?.kind,
    startedAt: new Date().toISOString(),
  });

  // Audit trail (incident-agent style): one claude_turn_event per prompt,
  // assistant block, tool call/result, and outcome. Bodies are stored as
  // sha256 + bounded snippet — the full text lives in the session jsonl.
  const turnId = crypto.randomUUID();
  let resultSessionId = sessionId || "";
  // Fork happens once, on the first attempt; after the SDK hands back the new
  // forked session id (init) we just resume that id on any rotation retry.
  let forkConsumed = false;
  const turnEvent = (fields: Record<string, unknown>) =>
    audit({
      msg: "claude_turn_event",
      turn_id: turnId,
      run_key: runKey,
      bks_session_id: journal?.bksSessionId,
      run_kind: journal?.kind,
      mode: mode || "code",
      claude_session_id: resultSessionId || undefined,
      ...fields,
    });

  turnEvent({
    direction: "in",
    kind: "user_prompt",
    cwd,
    mcp_servers: mcpServers,
    denied_tools: deniedTools ? Object.keys(deniedTools) : undefined,
    aws: aws ?? false,
    ...summarizeText(prompt),
  });

  // Steering state. Messages pushed via steerRun while this run is in flight
  // are held in steerPending and released into the query ONLY at a turn
  // boundary (when a result message lands) — the CLI ignores stream-json user
  // input delivered mid-turn (verified: the message is consumed but no new
  // turn ever starts, hanging the run). Each boundary release starts exactly
  // one more turn in the same query, so the end-of-run rule stays simple:
  // finish on a result with nothing held.
  const steerPending: string[] = [];
  let steerWake: (() => void) | null = null; // woken by releaseSteers/shutdown
  let steerReleases = 0; // boundary releases granted but not yet consumed
  let inputDone = false;
  const releaseSteers = () => {
    steerReleases++;
    steerWake?.();
  };
  const mkUserMsg = (content: string): SDKUserMessage =>
    ({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    }) as SDKUserMessage;
  // The opening message can carry pasted/dropped images as content blocks
  // (steered follow-ups stay text-only).
  const mkUserMsgWithImages = (text: string, images?: ImageInput[]): SDKUserMessage => {
    if (!images || images.length === 0) return mkUserMsg(text);
    const blocks: unknown[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const im of images) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: im.mediaType, data: im.data },
      });
    }
    return {
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  };
  const pushSteer = (text: string) => {
    turnEvent({ direction: "in", kind: "steered_prompt", ...summarizeText(text) });
    steerPending.push(text);
  };
  // Points at the live Query of the current rotation attempt; lets
  // interruptAndSteerRun stop the in-flight turn without killing the run.
  let currentInterrupt: (() => void) | null = null;
  const steerKeys = new Set<string>([runKey]);
  if (journal?.bksSessionId) steerKeys.add(journal.bksSessionId);
  const registerSteerKey = (key: string) => {
    steerKeys.add(key);
    steerControllers.set(key, pushSteer);
    interrupters.set(key, () => currentInterrupt?.());
  };
  for (const k of [...steerKeys]) registerSteerKey(k);
  // Stop accepting steers (steerRun → false; callers fall back to their queue)
  const stopAcceptingSteers = () => {
    for (const k of steerKeys) {
      steerControllers.delete(k);
      interrupters.delete(k);
    }
  };
  const mkInputStream = (initial: string) =>
    (async function* (): AsyncGenerator<SDKUserMessage> {
      yield mkUserMsgWithImages(initial, opts.images);
      while (true) {
        if (inputDone) return;
        if (steerReleases > 0) {
          steerReleases--;
          const batch = steerPending.splice(0);
          if (batch.length > 0) yield mkUserMsg(batch.join("\n\n"));
          continue;
        }
        await new Promise<void>((resolve) => (steerWake = resolve));
        steerWake = null;
      }
    })();

  try {
    // Account rotation: prefer the token pool (claude-accounts.ts); when a
    // run exhausts an account's usage, sideline it and retry on the next one
    // until the pool is empty. With no pool configured, fall back to the
    // legacy one-shot credentials-file switch (~/.claude/accounts).
    const triedAccountIds = new Set<string>();
    let account: ClaudeAccount | undefined = pickAccount(triedAccountIds);
    let legacySwitched = false;

    const rotateAfterLimit = (): string | undefined => {
      if (account) {
        triedAccountIds.add(account.id);
        markExhausted(account.id);
        const next = pickAccount(triedAccountIds);
        if (!next) return undefined;
        account = next;
        return next.name;
      }
      if (legacySwitched) return undefined;
      const next = switchClaudeAccountAfterLimit();
      if (next) legacySwitched = true;
      return next;
    };

    if (account) {
      turnEvent({ direction: "out", kind: "account_used", account: account.name });
    }

    for (;;) {
      let shouldRetryAfterSwitch = false;
      const q = query({
        prompt: mkInputStream(prompt),
        options: {
        resume: resultSessionId || sessionId || undefined,
        // Fork applies only on the first attempt (before resultSessionId is the
        // new forked id); once forked, later rotations just resume the fork.
        ...(opts.forkSession && !forkConsumed
          ? { forkSession: true as const, ...(opts.resumeSessionAt ? { resumeSessionAt: opts.resumeSessionAt } : {}) }
          : {}),
        cwd,
        model,
        allowedTools: isAsk
          ? [
              "Bash", "Read", "Grep", "Glob",
              "Task", "TaskOutput", "Agent", "WebFetch", "WebSearch",
              "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
            ]
          : [
              "Bash", "Read", "Edit", "Write", "Grep", "Glob",
              "Task", "TaskOutput", "Agent", "Workflow", "TaskStop",
              "WebFetch", "WebSearch",
              "NotebookEdit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
              "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
            ],
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          if (deniedTools && toolName in deniedTools) {
            turnEvent({
              direction: "out",
              kind: "permission_decision",
              tool_name: toolName,
              decision: "deny",
              reason: "denied_tool",
            });
            return { behavior: "deny" as const, message: deniedTools[toolName] };
          }
          if (confirmTools && toolName in confirmTools) {
            if (!onAskUser) {
              turnEvent({
                direction: "out",
                kind: "permission_decision",
                tool_name: toolName,
                decision: "deny",
                reason: "confirm_unattended",
              });
              return {
                behavior: "deny" as const,
                message:
                  `"${confirmTools[toolName]}" requires per-call human approval, and this run is unattended. ` +
                  "Post the exact action you want to take (tool name and full parameters, including amounts and IDs) " +
                  "in your internal note and ask a human to open this session and approve it.",
              };
            }
            let approved = false;
            try {
              const answer = await onAskUser({
                questions: [
                  {
                    question:
                      `Michael wants to: ${confirmTools[toolName]} (${toolName})\n\n` +
                      JSON.stringify(input, null, 2),
                    header: "Stripe",
                    options: [
                      { label: "Approve", description: "Execute this action against live Stripe" },
                      { label: "Deny", description: "Block it — Michael continues without executing" },
                    ],
                    multiSelect: false,
                  },
                ],
              });
              if (answer.behavior === "allow") {
                const answers = (answer.updatedInput as any)?.answers as
                  | Record<string, string>
                  | undefined;
                approved = Object.values(answers || {}).includes("Approve");
              }
            } catch {
              approved = false;
            }
            turnEvent({
              direction: "out",
              kind: "permission_decision",
              tool_name: toolName,
              decision: approved ? "allow" : "deny",
              reason: "human_confirmation",
            });
            if (approved) return { behavior: "allow" as const, updatedInput: input };
            return {
              behavior: "deny" as const,
              message:
                "This action was NOT executed — no human approved it (denied or timed out). " +
                "Do not retry; record the proposed action and its status in your summary.",
            };
          }
          if (toolName === "AskUserQuestion") {
            if (onAskUser) {
              try {
                const answer = await onAskUser(input);
                turnEvent({
                  direction: "out",
                  kind: "permission_decision",
                  tool_name: toolName,
                  decision: answer.behavior,
                  reason: "ask_user",
                });
                return answer;
              } catch (e: any) {
                turnEvent({
                  direction: "out",
                  kind: "permission_decision",
                  tool_name: toolName,
                  decision: "deny",
                  reason: "ask_user_failed",
                });
                return {
                  behavior: "deny" as const,
                  message: `Question UI failed (${e?.message || e}) — decide yourself and note the assumption.`,
                };
              }
            }
            // Headless runs (automations) have nobody to answer
            turnEvent({
              direction: "out",
              kind: "permission_decision",
              tool_name: toolName,
              decision: "deny",
              reason: "headless",
            });
            return {
              behavior: "deny" as const,
              message:
                "This run is headless — nobody can answer questions. Use your best judgment, note the open question and your assumption in your final output.",
            };
          }
          return { behavior: "allow" as const, updatedInput: cleanPlainToolInput(toolName, input) };
        },
        // Read per run so MCP servers added/removed in the UI apply immediately;
        // merge any in-process SDK servers (michael-sessions/-admin) on top.
        mcpServers: { ...filterMcpServers(mcpServers), ...(opts.inProcessMcp || {}) } as any,
        strictMcpConfig: true,
        env: childEnv(awsEnv, account?.token, author),
        pathToClaudeCodeExecutable: "/home/ubuntu/.local/bin/claude",
        executable: "bun",
        abortController,
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          ...(() => {
            const parts: string[] = [];
            if (isAsk) {
              parts.push(
                "You are Michael in Ask mode: answer questions about the tella-fusion codebase. " +
                  "This is a READ-ONLY session on the main checkout — never modify, create, or delete " +
                  "files, never commit, never run state-changing commands. Explore with Read/Grep/Glob " +
                  "and read-only git commands, then answer clearly and concisely."
              );
            }
            if (opts.inProcessMcp && Object.keys(opts.inProcessMcp).length) {
              parts.push(
                "## Managing Michael\nYou can see and steer your other Backstage sessions via the " +
                  "michael-sessions MCP tools (list_sessions — filter 'waiting' for sessions blocked on a " +
                  "question; get_session; send_to_session; answer_session_question; cancel_session; " +
                  "create_session) and manage your own setup via michael-admin (automations, MCP " +
                  "connections, channel memory). Use these tools when asked to inspect or steer sessions, " +
                  "or to change configuration, rather than only describing how."
              );
            }
            return parts.length ? { append: parts.join("\n\n") } : {};
          })(),
        },
        settingSources: ["user", "project"],
      },
      });
      currentInterrupt = () => {
        q.interrupt().catch((e) =>
          console.warn(`[runner] interrupt() failed (turn may have already ended):`, e?.message || e)
        );
      };

      try {
      for await (const msg of q) {
        if (abortController.signal.aborted) break;

      if (msg.type === "system" && (msg as any).subtype === "init") {
        resultSessionId = (msg as any).session_id;
        forkConsumed = true; // we now have the forked id; don't re-fork on retry
        if (resultSessionId && !steerKeys.has(resultSessionId)) {
          registerSteerKey(resultSessionId);
        }
        if (resultSessionId && !activeKeys.has(resultSessionId)) {
          activeKeys.add(resultSessionId);
          activeRuns.set(resultSessionId, abortController);
        }
        journalSet({
          runKey,
          bksSessionId: journal?.bksSessionId,
          claudeSessionId: resultSessionId,
          cwd,
          mode,
          mcpServers,
          deniedTools,
          aws,
          model: opts.model,
          kind: journal?.kind,
          startedAt: new Date().toISOString(),
        });
        yield { type: "init", sessionId: resultSessionId, provider: "claude", model };
      }

      if (msg.type === "assistant" && (msg as any).message?.content) {
        const content = (msg as any).message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              turnEvent({ direction: "out", kind: "assistant_text", ...summarizeText(block.text) });
              yield { type: "text_chunk", text: block.text };
            }
            if (block.type === "thinking" && block.thinking) {
              turnEvent({ direction: "out", kind: "assistant_thinking", ...summarizeText(block.thinking) });
            }
            if (block.type === "tool_use") {
              turnEvent({
                direction: "out",
                kind: "tool_use",
                tool_name: block.name,
                tool_use_id: block.id,
                ...summarizeText(JSON.stringify(block.input ?? {}), 500),
              });
              yield {
                type: "tool_use",
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id,
              };
            }
          }
        }
      }

      if (msg.type === "user" && (msg as any).message?.content) {
        const content = (msg as any).message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const text = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                  : "";
              // Pull image blocks out so the live stream carries them too
              // (mirrors jsonl-parser.extractImages so a streamed result and
              // the persisted one render identically).
              const images: string[] = [];
              if (Array.isArray(block.content)) {
                for (const c of block.content) {
                  if (c?.type !== "image" || !c.source) continue;
                  const s = c.source;
                  if (s.type === "base64" && s.media_type && s.data) {
                    images.push(`data:${s.media_type};base64,${s.data}`);
                  } else if (s.type === "url" && s.url) {
                    images.push(s.url);
                  }
                }
              }
              // Parse BACKSTAGE_VIDEO markers out of the FULL text (before the
              // 500-char truncation below, since the marker is usually printed
              // last) so recordings stream in without a reload. Mirrors
              // jsonl-parser.extractVideos so streamed and persisted match.
              const videos: string[] = [];
              for (const m of text.matchAll(/^\s*BACKSTAGE_VIDEO:\s*(\/\S+)\s*$/gm)) {
                videos.push(`/backstage/media?path=${encodeURIComponent(m[1])}`);
              }
              turnEvent({
                direction: "in",
                kind: "tool_result",
                tool_use_id: block.tool_use_id,
                is_error: block.is_error ?? false,
                ...summarizeText(text),
              });
              yield {
                type: "tool_result",
                toolUseId: block.tool_use_id,
                content: text.length > 500 ? text.slice(0, 500) + "..." : text,
                ...(images.length > 0 ? { images } : {}),
                ...(videos.length > 0 ? { videos } : {}),
              };
            }
          }
        }
      }

      if (msg.type === "result") {
        const rm = msg as any;
        resultSessionId = rm.session_id || resultSessionId;
        const resultText = rm.subtype === "success" ? rm.result : `Error: ${rm.errors?.join(", ") || "Unknown"}`;

        turnEvent({
          direction: "out",
          kind: "result",
          result_subtype: rm.subtype,
          is_error: rm.is_error ?? rm.subtype !== "success",
          duration_ms: rm.duration_ms,
          num_turns: rm.num_turns,
          total_cost_usd: rm.total_cost_usd,
          input_tokens: rm.usage?.input_tokens,
          output_tokens: rm.usage?.output_tokens,
          cache_read_input_tokens: rm.usage?.cache_read_input_tokens,
          cache_creation_input_tokens: rm.usage?.cache_creation_input_tokens,
          ...summarizeText(resultText),
        });

        let limitExhausted = false;
        if (isClaudeUsageLimitError(resultText, rm.subtype !== "success")) {
          const nextAccount = rotateAfterLimit();
          if (nextAccount) {
            turnEvent({ direction: "out", kind: "account_switch", account: nextAccount });
            shouldRetryAfterSwitch = true;
            yield {
              type: "text_chunk",
              text: `\n\n[runner] Claude usage limit hit; switched to ${nextAccount} and retrying.\n\n`,
            };
            break;
          }
          // No account left to rotate to — surface that so a dispatcher with a
          // fallback model can take over.
          limitExhausted = true;
        }

        // Turn boundary: release steered messages into the same query as a
        // fresh turn instead of finishing. (Skipped when the run is dying on
        // usage limits — the queued text stays in steerPending and callers'
        // queue fallback picks it up once steering deregisters.)
        if (!limitExhausted && steerPending.length > 0) {
          turnEvent({ direction: "out", kind: "steer_release", count: steerPending.length });
          releaseSteers();
          continue;
        }

        // Finishing: stop accepting steers first, then re-check — a message
        // that raced in between gets one more turn rather than being dropped.
        stopAcceptingSteers();
        if (!limitExhausted && steerPending.length > 0) {
          releaseSteers();
          continue;
        }

        yield {
          type: "done",
          sessionId: resultSessionId,
          result: resultText,
          provider: "claude",
          model,
          usageLimitExhausted: limitExhausted || undefined,
        };
        return;
      }
    }
      } catch (e: any) {
        // Usage limits can also surface as a thrown stream error (CLI process
        // exit), not just a result message — rotate and resume the session.
        if (
          !abortController.signal.aborted &&
          isClaudeUsageLimitError(e?.message || String(e), true)
        ) {
          const nextAccount = rotateAfterLimit();
          if (nextAccount) {
            turnEvent({ direction: "out", kind: "account_switch", account: nextAccount });
            yield {
              type: "text_chunk",
              text: `\n\n[runner] Claude usage limit hit; switched to ${nextAccount} and retrying.\n\n`,
            };
            continue;
          }
        }
        throw e;
      }

      if (!shouldRetryAfterSwitch) break;
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      const message = e.message || String(e);
      turnEvent({ direction: "out", kind: "error", error: message });
      yield {
        type: "error",
        content: message,
        provider: "claude",
        model,
        usageLimitExhausted: isClaudeUsageLimitError(message, true) || undefined,
      };
    }
  } finally {
    if (abortController.signal.aborted) {
      turnEvent({ direction: "out", kind: "cancelled" });
    }
    stopAcceptingSteers();
    inputDone = true;
    steerWake?.();
    for (const key of activeKeys) activeRuns.delete(key);
    journalClear(runKey);
  }
}

// resumeInterruptedRuns lives in agent-runner.ts — it routes each interrupted
// run to the right backend (Claude or Codex) based on the journaled model.
