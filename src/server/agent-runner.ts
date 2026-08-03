/**
 * Agent runner dispatcher: one entry point for "run a prompt in a session".
 * Everything executes on the opencode engine — native model ids (claude-*,
 * gpt-*) are mapped onto their opencode/<provider>/<model> form at dispatch;
 * the runner emits the shared StreamEvent shape.
 *
 * Note on session ids: `sessionId` is the engine session id (an opencode
 * session id; the field names claudeSessionId/codexThreadId survive in
 * session state for on-disk compat with pre-single-engine sessions).
 */

import { journalClear, takeInterruptedRuns } from "./run-journal";
import { transitionRunState } from "./run-state";
import type { StreamEvent, ImageInput } from "./run-events";
import {
  runOpencode,
  isOpencodeSessionBusy,
  cancelOpencodeRun,
  activeOpencodeRunCount,
  activeDetachedOpencodeRunCount,
  tryReattachOpencodeRun,
  steerOpencodeRun,
  EMPTY_COMPLETION_RESULT,
} from "./opencode-runner";
import {
  providerFor,
  nextFallbackModel,
  modelLabel,
  BEST_AVAILABLE_CODEX_MODEL,
  getDefaultModel,
  resolveConcreteModel,
  resolveModel,
  toOpencodeModel,
} from "./models";
import { isTransientRunError, TOOL_RESULT_ENVELOPE_RE } from "./runner-shared";
import {
  hostRunBusy,
  hostSteer,
  hostInterruptSteer,
  hostCancel,
} from "./host-registry";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { personaName } from "./config";
import { wrapContext } from "./prompt-context";
import {
  beginTurn,
  endTurn,
  isCheckedKind,
  isReachTool,
  recordEffect,
  turnKeyFor,
} from "./turn-outcome";
import { readEngineTranscriptAsync } from "./sessions";
import type { GitIdentity } from "./shared/user-mappings";
import type { TranscriptEntry } from "./types";

export type { StreamEvent };

export interface RunAgentOpts {
  prompt: string;
  /** Engine session id to resume (claude session id or codex thread id). */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  /** MCP OAuth identity override: the session CREATOR — shared sessions run
   *  MCP calls as their creator so teammates see the same objects (their own
   *  grant is the fallback, then the workspace grant). TODO(sandbox): the
   *  sandboxed-run path doesn't thread this yet. */
  mcpGrantUser?: string;
  /** Model id; decides the backend. Omitted = default Claude model. */
  model?: string;
  /** User-selected model retained while a transient fallback drives this turn. */
  selectedModel?: string;
  /** Internal recovery marker: the effective model is only a per-turn fallback. */
  transientFallback?: boolean;
  /** OpenCode reasoning variant for this run; unset = the model default. */
  effort?: string;
  /** Use OpenAI's priority service tier when this is a ChatGPT OAuth Codex run. */
  fastMode?: boolean;
  mcpServers?: string[];
  /**
   * In-process SDK MCP servers (opensession-sessions / opensession-admin) for trusted
   * interactive runs only — never automations. Claude receives them directly;
   * Codex receives stdio proxy configs that forward to the same in-process
   * servers through Backstage's run RPC socket.
   */
  inProcessMcp?: Record<string, unknown>;
  /**
   * The model loop is running outside its coding sandbox. Strip OpenCode's
   * built-in local bash/read/write/edit/search tools so the run can only touch
   * the workspace through the session-scoped remote-workspace MCP server.
   */
  disableLocalWorkspaceTools?: boolean;
  /**
   * System-prompt note describing the session's repos (primary + attached) and
   * their worktree paths, so the agent works in the right isolated checkout for
   * cross-repo sessions. Claude receives it as system context; Codex via the
   * developer_instructions config channel.
   */
  reposNote?: string;
  /** Images attached to the opening message. */
  images?: ImageInput[];
  /**
   * Stable uuid for the prompt's user transcript line. Callers that persist
   * the user line at intake (run-session) — and boot re-runs of journaled
   * runs — pass it so the runner's own transcript write upserts the same
   * entry instead of duplicating the bubble.
   */
  promptEntryId?: string;
  /**
   * Prior-engine transcript entries accompanying a cross-engine handoff (the
   * same entries the handoff note was built from). The opencode runner seeds a
   * freshly-created session's persisted transcript file with them, so the UI
   * transcript stays continuous across the engine switch. Other runners ignore
   * this (their engines own their transcript files).
   */
  seedTranscriptEntries?: TranscriptEntry[];
  /** Fork the resumed session into a new id (optionally from `resumeSessionAt`). Claude only. */
  forkSession?: boolean;
  resumeSessionAt?: string;
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  aws?: boolean;
  /** Git identity for commits this run makes, attributing them to the prompt's author. */
  author?: GitIdentity | null;
  /**
   * The run's user (prompt author / UI user). Gates per-user MCP servers
   * (mcp-config.json `allowedUsers`) — e.g. `brex` is limited to Michiel + Grant.
   * Omitted = anonymous, which sees only unrestricted servers.
   */
  user?: string;
  /**
   * Model to switch to when the primary model dies on usage limits with no
   * account left in its pool (claude-runner/codex-runner rotate their own
   * account pools first — this fires only once a whole pool is exhausted).
   * Cross-provider fallback starts a fresh native engine session. The previous
   * engine's internal history cannot carry over, so the runner injects a recent
   * transcript handoff when one is available; cwd/worktree state carries over.
   */
  fallbackModel?: string;
  /**
   * Pinned account in the active model provider's Claude or Codex pool. The
   * provider runner prefers it and falls back to the pool on exhaustion.
   * Journaled for resume.
   */
  accountId?: string;
  /**
   * Hard accountId pin (automation cost cap): the run only ever uses that
   * account — an exhausted pin kills the run with usageLimitExhausted so the
   * fallback-model chain takes over instead of the shared pool.
   */
  accountStrict?: boolean;
  /**
   * Allow runs to keep going on accounts billing usage-credits past their
   * subscription limits (extra usage enabled with credit headroom). Off =
   * never intentionally spend paid credits. Claude only.
   */
  usageCredits?: boolean;
  journal?: { bksSessionId?: string; kind?: string };
  /**
   * Unified session id (e.g. `linear-<branch>`) for the transcript-v2 oc→
   * unified map ONLY (opencode-transcript.ts recordBksSessionFor) — lets loop
   * runs whose journal is deliberately kind-only (no crash journal; the loop
   * re-drives its own turns) still key their store appends on their unified
   * session. Never journaled, never used for resume/run-state/MCP identity —
   * runs that journal a bksSessionId don't need this (it wins when both are
   * set, since they must agree anyway).
   */
  transcriptSessionId?: string;
  onAskUser?: (input: Record<string, unknown>) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}

/** The engine call signature runOnModel dispatches to — what a test fake
 *  must implement (the INNER contract: emit init → chunks/tools → one
 *  terminal done/error; runAgent's fallback walk wraps it). */
export type EngineRunner = (
  opts: RunAgentOpts,
  model: string
) => AsyncGenerator<StreamEvent>;

// Test seam: lets a deterministic fake engine stand in for runOpencode so the
// consumer stack (runAgent's fallback walk, runSessionPrompt's event loop,
// queue drain, run-state transitions) is testable without spending model
// tokens or touching a live engine. Never set outside tests — parked on a
// plain module local, NOT globalThis, so a hot reload always clears it.
let engineForTest: EngineRunner | null = null;
export function __setEngineForTest(fn: EngineRunner | null): void {
  engineForTest = fn;
}

function runOnModel(opts: RunAgentOpts, model: string | undefined): AsyncGenerator<StreamEvent> {
  // Single engine: map native ids (claude-*, gpt-*, codex-best-available)
  // onto their opencode form; explicit opencode/<provider>/<model> ids pass
  // through. Anything that still doesn't parse as an opencode id gets the
  // runner's clear error (e.g. anthropic bridge disabled).
  const requested = model || getDefaultModel();
  const mapped = toOpencodeModel(requested) || requested;
  if (engineForTest) return engineForTest(opts, mapped);
  return runOpencode(opts, mapped);
}

/**
 * Watch a run's event stream for whether it ever reached anybody, and settle
 * the verdict when it ends (src/server/turn-outcome.ts). Only unattended kinds
 * carry a ledger; for everything else this is two branch predictions per run.
 */
export async function* runAgent(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
  const key = isCheckedKind(opts.journal?.kind)
    ? turnKeyFor({ bksSessionId: opts.journal?.bksSessionId })
    : undefined;
  if (!key) {
    yield* runAgentInner(opts);
    return;
  }
  beginTurn({
    key,
    kind: opts.journal?.kind || "unknown",
    sessionId: opts.journal?.bksSessionId,
  });
  try {
    for await (const event of runAgentInner(opts)) {
      if (event.type === "tool_use" && isReachTool(event.toolName)) {
        recordEffect(key, event.toolName!);
      }
      yield event;
    }
  } finally {
    // `finally`, not after the loop: a consumer that breaks out early (a
    // cancel, a steer) still closes the ledger, so a later run reusing the
    // same session id starts clean instead of inheriting stale effects.
    endTurn(key, { model: opts.model, by: opts.user });
  }
}

async function* runAgentInner(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
  const requestedModel = resolveModel(opts.model || getDefaultModel());
  const wantsBestCodex = requestedModel?.id === BEST_AVAILABLE_CODEX_MODEL;
  const primaryModel = resolveConcreteModel(opts.model);
  const preferredFallback = wantsBestCodex
    ? BEST_AVAILABLE_CODEX_MODEL
    : opts.fallbackModel;
  // No fallback configured (interactive auto-switch off, or an automation with
  // fallbackModel:"none") ⇒ run the primary and surface whatever it does.
  if (!preferredFallback || preferredFallback === "none") {
    yield* runOnModel(opts, primaryModel);
    return;
  }

  let currentOpts = {
    ...opts,
    selectedModel: opts.selectedModel ?? opts.model,
  };
  let currentModel = primaryModel;
  const exhaustedModels = new Set<string>();
  let consecutiveTransient = 0;

  for (;;) {
    let currentEngineId = currentOpts.sessionId;
    // Why this turn ended, if it did: a usage cap (pool drained) or a transient
    // infra failure. Both route into the fallback graph so the session keeps
    // going instead of dead-ending on the error — the "continue without
    // failing" goal.
    let failure: { transient: boolean; content?: string } | null = null;

    for await (const event of runOnModel(currentOpts, currentModel)) {
      if (event.type === "init") {
        currentEngineId = event.sessionId || currentEngineId;
      }
      if (event.type === "done" && event.usageLimitExhausted === true) {
        failure = { transient: false };
        break;
      }
      if (event.type === "error") {
        if (event.usageLimitExhausted === true) {
          failure = { transient: false, content: event.content };
          break;
        }
        // A non-usage error that looks like infra (server death, wedge, 5xx,
        // network, SQLite contention): the opencode runner already spent its own
        // in-attempt retry, so escalate to the next model rather than failing.
        if (isTransientRunError(event.content)) {
          failure = { transient: true, content: event.content };
          break;
        }
      }
      yield event;
    }

    if (!failure) return;

    // Two models in a row dying the TRANSIENT way is an infrastructure
    // problem (dead rpc socket, wedged bridge, network) — every further rung
    // would burn its own liveness window and fail identically, and the walk
    // would end by blaming usage for what is an outage. Stop and say what
    // actually happened. (2026-07-17 stolen-socket outage: the walk burned
    // Fable→Sol→Opus→GPT-5.5 for ~12 min per prompt, then told users the
    // models were "out of usage".)
    if (failure.transient) {
      consecutiveTransient++;
      if (consecutiveTransient >= 2) {
        yield {
          type: "error",
          content:
            `${modelLabel(currentModel)} also failed with a transient engine error — ` +
            `${consecutiveTransient} models in a row failed the same way, so this looks like ` +
            `an infrastructure problem (engine bridge, MCP socket, or network), not a model ` +
            `or usage issue. Stopping the fallback walk; retry in a minute or ping ${personaName()}. ` +
            `Last error: ${failure.content || "unknown"}`,
          provider: providerFor(currentModel),
          model: currentModel,
        };
        return;
      }
    } else {
      consecutiveTransient = 0;
    }

    const currentOc = toOpencodeModel(currentModel) || currentModel;
    exhaustedModels.add(currentOc);
    const hop = nextFallbackModel(currentOc, exhaustedModels, preferredFallback);
    if (!hop) {
      // Nothing left to try — surface the terminal error we were suppressing.
      yield {
        type: "error",
        content: failure.transient
          ? failure.content ||
            `${modelLabel(currentModel)} failed and no fallback models remain.`
          : `${modelLabel(currentModel)} is out of usage, and no fallback models remain.`,
        provider: providerFor(currentModel),
        model: currentModel,
        usageLimitExhausted: failure.transient ? undefined : true,
      };
      return;
    }

    // Downgrade to a dumber model (Fable→Opus, Opus→Sonnet, Sol→Opus): a human
    // decides. Interactive runs get an AskUserQuestion; headless runs
    // (automations, workflow sub-agents, restart resumes without an ask handler)
    // auto-proceed — stalling them would defeat "continue without failing".
    if (hop.mode === "ask") {
      const approved = await askFallbackApproval(
        opts.onAskUser,
        currentModel,
        hop.id,
        failure.transient
      );
      if (!approved) {
        // Name the real cause — a transient engine failure declined here must
        // NOT read as "out of usage" (that mislabel sent people chasing
        // billing during the 2026-07-17 infra outage).
        yield {
          type: "error",
          content: failure.transient
            ? `${modelLabel(currentModel)} hit a transient engine failure. ` +
              `Declined the fallback to ${modelLabel(hop.id)} — retry this prompt, or use /model to switch.`
            : `${modelLabel(currentModel)} is out of usage. ` +
              `Declined the fallback to ${modelLabel(hop.id)} — use /model to switch when ready.`,
          provider: providerFor(currentModel),
          model: currentModel,
          usageLimitExhausted: failure.transient ? undefined : true,
        };
        return;
      }
    }

    // Everything runs on the opencode engine, so `providerFor` reports
    // "opencode" for both sides and can't tell a same-family switch from a
    // cross-family one. The decision that matters — resume the partial session
    // vs. start fresh with a handoff — turns on the UNDERLYING provider
    // (anthropic ↔ openai): same family resumes the opencode session; a family
    // switch needs a fresh session seeded with the prior transcript.
    const fromFamily = engineFamily(currentOc);
    const toFamily = engineFamily(hop.id);
    const crossProvider = fromFamily !== toFamily;
    const reason = failure.transient ? "hit a transient failure" : "is out of usage on all accounts";
    console.warn(
      `[runner] ${currentModel} ${reason}; falling back to ${hop.id} (${hop.mode})`
    );
    const transientFallback = !!currentOpts.transientFallback || failure.transient;
    // Structured cue: usage exhaustion becomes a durable selection change;
    // transient recovery is explicitly marked as current-turn-only.
    yield {
      type: "model_switch",
      fromModel: currentModel,
      toModel: hop.id,
      switchReason: failure.transient ? "hit a transient engine error" : "out of credits",
      temporaryFallback: transientFallback,
    };

    let prompt = currentOpts.prompt;
    let handoffEntries: TranscriptEntry[] = [];
    if (crossProvider) {
      // The engine session is always an opencode session id, so read the prior
      // turn from OpenCode's store regardless of which model family produced it.
      // Gate on currentEngineId (present when resuming an existing session),
      // NOT on sawInit: an account pool that is dry *at pick time* throws
      // usageLimitExhausted BEFORE any init event, so sawInit stays false — yet
      // the resumed session on disk still holds the full history to hand off.
      // Requiring sawInit here dropped that history and started the fallback
      // model on a blank session (the "history lost after fallback" bug).
      const entries = currentEngineId
        ? await readEngineTranscriptAsync(currentOpts.cwd, currentEngineId, "opencode")
        : [];
      handoffEntries = entries;
      if (entries.length) {
        prompt =
          `${wrapContext(
            buildEngineSwitchHandoffNote({
              fromModel: currentModel,
              fromProvider: familyLabel(fromFamily),
              toProvider: familyLabel(toFamily),
              targetResuming: false,
              entries,
            })
          )}\n\n${prompt}`;
      } else {
        prompt +=
          "\n\n[Note: a previous attempt on another model was cut short and may have " +
          "left partial work in this directory — review what's already done before continuing.]";
      }
    }

    currentOpts = {
      ...currentOpts,
      prompt,
      selectedModel: transientFallback ? currentOpts.selectedModel : hop.id,
      transientFallback,
      // Account ids are provider-local. A fallback to another family must not
      // reinterpret the source provider's pin (including a strict cost cap).
      ...(crossProvider ? { accountId: undefined, accountStrict: undefined } : {}),
      // Same family can resume the partial session; a family switch starts fresh
      sessionId: crossProvider ? undefined : currentEngineId,
      // The fresh opencode session is seeded with the history the handoff covers.
      seedTranscriptEntries:
        crossProvider && handoffEntries.length ? handoffEntries : undefined,
      journal: opts.journal
        ? { ...opts.journal, kind: `${opts.journal.kind || "run"}-fallback` }
        : undefined,
    };
    currentModel = hop.id;
  }
}

/** Underlying engine provider family of a model id ("anthropic" / "openai"),
 *  read from its opencode mapping. Drives resume-vs-fresh on a fallback hop. */
export function engineFamily(model: string): string {
  const oc = toOpencodeModel(model) || model;
  return oc.match(/^opencode\/([^/]+)\//)?.[1] || providerFor(model);
}

/** Map an engine family to the handoff note's provider label. */
function familyLabel(family: string): "claude" | "codex" | "opencode" {
  if (family === "anthropic") return "claude";
  if (family === "openai") return "codex";
  return "opencode";
}

/**
 * Confirm a downgrade fallback with the human. Interactive runs surface an
 * AskUserQuestion card (web UI + Slack escalation); headless runs — no
 * onAskUser — auto-approve so automations and workflow sub-agents keep going
 * rather than dead-ending on the limit. Returns false only when a human is
 * present and declined (or nobody answered).
 */
async function askFallbackApproval(
  onAskUser: RunAgentOpts["onAskUser"],
  fromModel: string,
  toModel: string,
  transient: boolean
): Promise<boolean> {
  if (!onAskUser) return true;
  const reason = transient
    ? `**${modelLabel(fromModel)}** hit a transient failure`
    : `**${modelLabel(fromModel)}** is out of usage`;
  const switchLabel = `Switch to ${modelLabel(toModel)}`;
  let answer;
  try {
    answer = await onAskUser({
      questions: [
        {
          question: `${reason}. Fall back to the lighter **${modelLabel(toModel)}** to keep going?`,
          header: "Model fallback",
          options: [
            { label: switchLabel, description: "Continue this turn on the fallback model" },
            { label: "Stop here", description: "Don't switch — I'll pick a model myself" },
          ],
          multiSelect: false,
        },
      ],
    });
  } catch (e) {
    console.warn(`[runner] fallback approval ask failed for ${fromModel}→${toModel}:`, e);
    return false;
  }
  if (answer.behavior === "deny") return false; // nobody answered / timed out
  const picked = String(
    Object.values((answer.updatedInput as { answers?: Record<string, string> }).answers || {})[0] || ""
  ).toLowerCase();
  return picked.startsWith("switch") || picked.startsWith("yes");
}

// Sessions whose prompt run has started but isn't registered in the runner's
// activeRuns yet — runSessionPrompt awaits (worktree revive, title gen, upload
// staging) before the generator is first pulled, so two racing prompts could
// both pass the busy check and the loser's message got dropped as a "Session
// is busy" error. Marked synchronously before any await; parked on globalThis
// so a hot reload keeps it.
const pendingStarts: Set<string> = ((globalThis as any).__pendingSessionStarts ??=
  new Set());

/** Mark a session as starting a run (call synchronously, before any await). */
export function markSessionStarting(id: string): void {
  pendingStarts.add(id);
  transitionRunState(id, "prompt");
}

/** Clear a starting mark (call in a `finally` once the run has ended). */
export function unmarkSessionStarting(id: string): void {
  pendingStarts.delete(id);
}

/** Busy check (pass any engine/backstage session id). */
export function isAgentSessionBusy(...ids: Array<string | null | undefined>): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (pendingStarts.has(id) || isOpencodeSessionBusy(id) || hostRunBusy(id))
      return true;
  }
  return false;
}

/**
 * How many runs this process is actively driving. Used by graceful shutdown
 * to wait for in-flight work to reach a stopping point before exiting. (Does
 * not count external CLI/tmux runs — we can't drain those.)
 */
export function activeAgentRunCount(): number {
  return activeOpencodeRunCount();
}

/** Of those, how many execute on a DETACHED engine server that survives a
 *  restart — the graceful-shutdown drain skips waiting on these (boot
 *  reattaches them via the journal instead). */
export function activeDetachedAgentRunCount(): number {
  return activeDetachedOpencodeRunCount();
}

/**
 * Steer a message into an in-flight run. Opencode runs steer in-band since
 * 2026-07-12 (steerOpencodeRun: a noReply history append the running turn
 * picks up at its next step boundary — Claude-SDK-steer semantics);
 * host-forwarded runs steer over RPC. False = nothing steerable — caller
 * should queue.
 */
export function steerAgentRun(
  ids: Array<string | null | undefined>,
  text: string,
  images?: ImageInput[]
): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (steerOpencodeRun(id, text, images)) return true;
    // Host-forward RPC is text-only: a send with images falls through
    // (caller queues it — the queue drain delivers images).
    if (!images?.length && hostSteer(id, text)) return true;
  }
  return false;
}

/**
 * Bare interrupt: no engine supports it anymore (it released a Claude run's
 * held steers at a turn boundary). Kept for caller compat — always false, so
 * callers fall back to the queue flap's other paths.
 */
export function interruptAgentRun(
  _ids: Array<string | null | undefined>
): boolean {
  return false;
}

/**
 * Esc-style stop: the opencode engine has no graceful stop-turn — callers
 * fall back to the hard cancel (cancelAgentRun aborts the turn server-side).
 */
export function stopAgentRunTurn(
  _ids: Array<string | null | undefined>
): boolean {
  return false;
}

/**
 * Esc-style redirect: abort the current turn but keep the run alive,
 * continuing immediately with the given message. Host-forwarded runs only;
 * false = caller should fall back to cancel + queue.
 */
export function interruptAndSteerAgentRun(
  ids: Array<string | null | undefined>,
  text: string,
  images?: ImageInput[]
): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (!images?.length && hostInterruptSteer(id, text)) return true;
  }
  return false;
}

/** Cancel a run; returns true if anything was cancelled. */
export function cancelAgentRun(...ids: Array<string | null | undefined>): boolean {
  let cancelled = false;
  for (const id of ids) {
    if (!id) continue;
    if (cancelOpencodeRun(id)) cancelled = true;
    if (hostCancel(id)) cancelled = true;
  }
  return cancelled;
}

/** Per-session AskUserQuestion handler, mirroring RunAgentOpts.onAskUser. */
type AskHandler = NonNullable<RunAgentOpts["onAskUser"]>;

/**
 * Resume runs that a previous process left in-flight (service restart or
 * crash). Each resumable run gets a continuation prompt against its engine
 * session, on whichever backend the journaled model belongs to.
 *
 * `askHandlerFor` re-attaches an AskUserQuestion handler (the web-UI + Slack
 * escalation handler) to interactive sessions — without it, a run that was
 * blocked on an ask comes back headless and dead-ends every question. It
 * returns undefined for sessions that should stay headless (automations).
 *
 * `inProcessMcpFor` and `reposNoteFor` rebuild trusted interactive context
 * that is deliberately not serialized into the restart journal.
 */
export function resumeInterruptedRuns(
  onResumed?: (
    bksSessionId?: string,
    terminalEvent?: StreamEvent,
  ) => void,
  askHandlerFor?: (bksSessionId: string) => AskHandler | undefined,
  inProcessMcpFor?: (bksSessionId: string, user?: string) => Record<string, unknown> | undefined,
  reposNoteFor?: (bksSessionId: string) => string | undefined,
  onEvent?: (bksSessionId: string, event: StreamEvent) => void,
): string[] {
  const interrupted = takeInterruptedRuns();
  const resumed: string[] = [];

  for (const run of interrupted) {
    // The github agent owns its own recovery (review/simplify re-trigger on the
    // next PR event; auto-fix loops are resumed by the github agent's startup
    // sweep). Resuming them generically would double-drive an auto-fix loop.
    if (run.kind?.startsWith("github-")) {
      journalClear(run.runKey);
      continue;
    }
    // Slack runs journal (their bks session id feeds the in-process MCP proxy
    // path), but the Slack queue re-delivers interrupted messages itself — a
    // generic resume would double-drive the turn with no streamer attached.
    if (run.kind?.startsWith("slack")) {
      journalClear(run.runKey);
      continue;
    }
    // Workflow fan-out agents ("workflow", plus -resume/-rerun suffixes): the
    // orchestration state (the script's Worker) died with the process — the
    // workflow store marks the run interrupted on boot, and replaying a lone
    // child agent without its script would be noise.
    if (run.kind?.startsWith("workflow")) {
      journalClear(run.runKey);
      continue;
    }
    // Sandboxed runs (docs/sandboxes-plan.md Phases 1+3): the sandbox — and
    // often the in-sandbox run host itself — outlives a backstage restart.
    // Reattach/relaunch through the provider instead of running in-process;
    // the sandbox modules are imported lazily so these paths stay completely
    // out of processes that never touch them.
    if (
      run.sandboxId &&
      (run.sandboxProvider === "docker" ||
        run.sandboxProvider === "daytona" ||
        run.sandboxProvider === "e2b" ||
        run.sandboxProvider === "box" ||
        run.sandboxProvider === "modal" ||
        run.sandboxProvider === "microvm" ||
        run.sandboxProvider === "lambda-microvm")
    ) {
      const isDocker = run.sandboxProvider === "docker";
      if (run.bksSessionId) resumed.push(run.bksSessionId);
      void (async () => {
        try {
          const resume = isDocker
            ? (await import("./sandbox/docker")).resumeDockerSandboxRun
            : (await import("./sandbox/adapters/bootstrap")).resumeRemoteSandboxRun;
          const events = await resume(run, {
            onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
          });
          if (!events) {
            console.warn(
              `[runner] Sandbox ${run.sandboxId} for interrupted run ${run.runKey} is gone — the session's next prompt recreates it`
            );
            journalClear(run.runKey);
            onResumed?.(run.bksSessionId);
            return;
          }
          for await (const event of events) {
            if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
            if (event.type === "done" || event.type === "error") {
              onResumed?.(run.bksSessionId, event);
            }
          }
        } catch (e) {
          console.error(`[runner] Sandbox resume failed for ${run.runKey}:`, e);
        }
      })();
      continue;
    }
    if (!run.claudeSessionId) {
      // No engine session id means the run died before the model produced its
      // first turn (e.g. during MCP startup) — so nothing actually ran and no
      // side effects happened. If we journaled the original prompt we can safely
      // re-run it from scratch; otherwise it's genuinely unrecoverable.
      if (!run.prompt) {
        console.warn(
          `[runner] Interrupted run ${run.runKey} (${run.kind || "unknown"}) had no engine session and no saved prompt — cannot resume`
        );
        journalClear(run.runKey);
        continue;
      }
      if (run.bksSessionId) {
        resumed.push(run.bksSessionId);
        transitionRunState(run.bksSessionId, "resume_reprompt", { run_key: run.runKey });
      }
      console.log(
        `[runner] Re-running interrupted ${run.kind || "run"} ${run.bksSessionId || run.runKey} from scratch (never got an engine session)`
      );
      void (async () => {
        try {
          // The re-run journals under its own runKey — drop the claimed
          // record now (runAgent's intake journalSet is the very next step,
          // so the unprotected window is one generator start, not the whole
          // adoption+probe phase the old wipe-on-take left open).
          journalClear(run.runKey);
          for await (const event of runAgent({
            prompt: run.prompt!,
            promptEntryId: run.promptEntryId,
            cwd: run.cwd,
            mode: run.mode,
            model: run.model,
            selectedModel: run.selectedModel,
            transientFallback: run.transientFallback,
            effort: run.effort,
            fastMode: run.fastMode,
            mcpServers: run.mcpServers,
            inProcessMcp: run.bksSessionId
              ? inProcessMcpFor?.(run.bksSessionId, run.user)
              : undefined,
            reposNote: run.bksSessionId ? reposNoteFor?.(run.bksSessionId) : undefined,
            user: run.user,
            deniedTools: run.deniedTools,
            confirmTools: run.confirmTools,
            aws: run.aws,
            fallbackModel: run.fallbackModel,
            accountId: run.accountId,
            accountStrict: run.accountStrict,
            usageCredits: run.usageCredits,
            journal: { bksSessionId: run.bksSessionId, kind: `${run.kind || "run"}-rerun` },
            onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
          })) {
            if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
            if (event.type === "done" || event.type === "error") {
              onResumed?.(run.bksSessionId, event);
            }
          }
        } catch (e) {
          console.error(`[runner] Re-run failed for ${run.runKey}:`, e);
        }
      })();
      continue;
    }
    if (run.bksSessionId) resumed.push(run.bksSessionId);
    void (async () => {
      try {
        let repairingRecoveredResult = false;
        // First choice: REATTACH — the run's detached `opencode serve`
        // survived the restart and the turn may still be executing. The
        // adopted-pool lookup + session probe live in tryReattachOpencodeRun;
        // null means the server is gone (or was a direct child) and we fall
        // back to the classic continuation re-prompt below.
        if (run.serverKey) {
          if (run.bksSessionId)
            transitionRunState(run.bksSessionId, "reattach_start", { run_key: run.runKey });
          const reattached = await tryReattachOpencodeRun(run, {
            onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
          }).catch((e) => {
            console.warn(`[runner] Reattach probe failed for ${run.runKey}:`, e);
            return null;
          });
          if (run.bksSessionId)
            transitionRunState(
              run.bksSessionId,
              reattached ? "reattach_ok" : "reattach_fail",
              { run_key: run.runKey },
            );
          if (reattached) {
            console.log(
              `[runner] Reattached ${run.kind || "run"} ${run.bksSessionId || run.runKey} to its live engine turn (server ${run.serverKey})`
            );
            for await (const event of reattached) {
              if (recoveredResultNeedsContinuation(event)) {
                repairingRecoveredResult = true;
                console.warn(
                  `[runner] Reattached turn ${run.runKey} ended without a usable final answer — continuing once`
                );
                continue;
              }
              if (event.type === "error" && isTransientRunError(event.content)) {
                repairingRecoveredResult = true;
                console.warn(
                  `[runner] Reattached turn ${run.runKey} hit a transient engine failure — continuing through the normal retry/fallback path`
                );
                continue;
              }
              if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
              if (event.type === "done" || event.type === "error") {
                onResumed?.(run.bksSessionId, event);
              }
            }
            if (!repairingRecoveredResult) return;
          }
        }
        console.log(
          repairingRecoveredResult
            ? `[runner] Repairing recovered result for ${run.bksSessionId || run.runKey}`
            : `[runner] Resuming interrupted ${run.kind || "run"} ${run.bksSessionId || run.runKey} (started ${run.startedAt}, model ${run.model || "default"})`
        );
        if (run.bksSessionId && !repairingRecoveredResult)
          transitionRunState(run.bksSessionId, "resume_reprompt", { run_key: run.runKey });
        // The continuation run journals under its own runKey — drop the
        // claimed record only now, AFTER the reattach probe settled: dying
        // mid-probe used to lose the run to the wipe-on-take (2026-07-27).
        journalClear(run.runKey);
        for await (const event of runAgent({
          prompt: repairingRecoveredResult
            ? recoveredResultContinuationPrompt(run.prompt)
            : resumeContinuationPrompt(run.prompt),
          sessionId: run.claudeSessionId,
          cwd: run.cwd,
          mode: run.mode,
          model: run.model,
          selectedModel: run.selectedModel,
          transientFallback: run.transientFallback,
          effort: run.effort,
          fastMode: run.fastMode,
          mcpServers: run.mcpServers,
          inProcessMcp: run.bksSessionId
            ? inProcessMcpFor?.(run.bksSessionId, run.user)
            : undefined,
          reposNote: run.bksSessionId ? reposNoteFor?.(run.bksSessionId) : undefined,
          user: run.user,
          deniedTools: run.deniedTools,
          confirmTools: run.confirmTools,
          aws: run.aws,
          fallbackModel: run.fallbackModel,
          accountId: run.accountId,
          accountStrict: run.accountStrict,
          usageCredits: run.usageCredits,
          journal: { bksSessionId: run.bksSessionId, kind: `${run.kind || "run"}-resume` },
          onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
        })) {
          if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
          if (event.type === "done" || event.type === "error") {
            onResumed?.(run.bksSessionId, event);
          }
        }
      } catch (e) {
        console.error(`[runner] Resume failed for ${run.runKey}:`, e);
      }
    })();
  }

  return resumed;
}

/** Same continuation prompt resumeInterruptedRuns uses — exported so the
 *  graceful-shutdown snapshot path can wake sessions that finished their turn
 *  during the drain (and so were cleared from the journal) with one consistent
 *  message. */
// Note: personaName() is read at module load (a persona rename needs a restart
// to reach this string — fine, runner internals need one anyway).
export const RESUME_CONTINUATION_PROMPT =
  `This session was interrupted by a ${personaName()} service restart mid-run. ` +
  "Review what you had already done, pick up where you left off, and finish the task. " +
  "If the work was actually complete, just post the final summary/answer.";

/**
 * Meridian can very occasionally close a post-restart turn with either no
 * final text or its internal tool-result envelope as assistant text (the
 * observed shape starts `[your bash …]:`) while still reporting a successful
 * `finish: stop`. Accepting either strands partial work without a conclusion.
 * Keep this deliberately narrow and bounded to one repair continuation.
 * The envelope shape lives in runner-shared (TOOL_RESULT_ENVELOPE_RE) and
 * covers any tool id — MCP tools included — not just the builtin set.
 */
export function recoveredResultNeedsContinuation(event: StreamEvent): boolean {
  if (event.type !== "done") return false;
  if (!event.result?.trim() || event.result === EMPTY_COMPLETION_RESULT) return true;
  return TOOL_RESULT_ENVELOPE_RE.test(event.result || "");
}

/** RESUME_CONTINUATION_PROMPT anchored to the interrupted turn's original
 *  prompt. A resume can land in a fresh engine session with no history (e.g.
 *  reattach failed and the re-prompt rotated to another account's server) —
 *  without an anchor the model reconstructs its task from repository state
 *  and can guess wrong (2026-07-24: an amnesiac ask session found its shared
 *  checkout on a teammate's PR branch and re-did that PR's review). */
export function resumeContinuationPrompt(originalPrompt?: string | null): string {
  const p = (originalPrompt || "").trim();
  if (!p) return RESUME_CONTINUATION_PROMPT;
  const clamped = p.length > 2000 ? `${p.slice(0, 2000)}…` : p;
  return (
    `${RESUME_CONTINUATION_PROMPT}\n\n` +
    `For context, the prompt that started the interrupted turn was:\n` +
    `"""\n${clamped}\n"""\n` +
    "If you no longer see the earlier conversation, treat that prompt as the task " +
    "definition — do not infer the task from repository or checkout state."
  );
}

function recoveredResultContinuationPrompt(originalPrompt?: string | null): string {
  const p = (originalPrompt || "").trim();
  const clamped = p.length > 2000 ? `${p.slice(0, 2000)}…` : p;
  return (
    "Your reattached turn ended without giving the user a usable final answer. " +
    "Review the work already completed in this session, finish anything still needed, and provide the actual concise answer or handoff now. " +
    "Do not merely repeat the last tool output." +
    (clamped
      ? `\n\nThe prompt that started the interrupted turn was:\n"""\n${clamped}\n"""`
      : "")
  );
}
