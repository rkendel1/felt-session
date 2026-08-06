/**
 * In-process Anthropic provider for the pi engine — the meridian trick
 * (blocked passthrough tools over the first-party @anthropic-ai/claude-agent-sdk)
 * implemented as a pi-ai NATIVE provider instead of the loopback HTTP bridge.
 * pi-runner registers it via `runtime.registerNativeProvider` when
 * `~/.opensession-pi.json` has `anthropicTransport: "inprocess"` (the
 * default; "bridge" keeps the pre-2026-08 loopback path as rollback), so
 * `pi/anthropic/*` turns reach opencode/meridian's level: native token-level
 * streaming (SDK partial message events → pi text/thinking deltas), no
 * end-of-request replay assembly, and no stop-nudging — the PreToolUse block
 * reason invites the model to call every OTHER tool it needs in the same
 * turn instead of ordering it to stop.
 *
 * How a stream call maps onto the SDK (the anthropic-bridge.ts recipe, HTTP
 * hop removed — the shared helpers are imported from there so the two stay
 * one implementation):
 *  - pi hands `streamSimple(model, context, options)` the FULL pi-side
 *    conversation each turn. Messages convert to the bridge's Anthropic wire
 *    shape (piMessagesToAnthropic) and the bridge's session store logic
 *    decides continuation vs replay (planSdkTurn): history strictly grew past
 *    what the SDK session has seen → resume with only the new tail flattened
 *    (tool results unwrap to raw output text); anything else (first turn,
 *    edited/compacted history, or the designated walk moving to a DIFFERENT
 *    account — SDK sessions live in per-account isolated config dirs, so a
 *    cross-account resume cannot work) → fresh SDK session with a full flat
 *    replay.
 *    The pi→SDK session map is keyed by the stream option `sessionId` (the
 *    pi session id on agent turns — pi's compaction/branch-summary one-shots
 *    deliberately carry a fresh uuid per request and so take the stateless
 *    full-replay path instead of contaminating the conversation's SDK
 *    session), unified id as fallback, parked on globalThis: hot reloads
 *    keep it, a real restart just replays — correct, only slower.
 *  - The request's tools become no-op SDK-MCP passthrough tools; a PreToolUse
 *    hook captures {id, name, input} and blocks with
 *    PI_PASSTHROUGH_BLOCK_REASON. Captured calls stream out as pi toolcall
 *    events as they are captured; the final `done` carries reason "toolUse"
 *    when any exist, else "stop". maxTurns is generous (8), and
 *    error_max_turns WITH captures is a success (the bridge's fix): the
 *    captures are the whole point — return them and let pi execute.
 *  - Text/thinking stream token-level via `includePartialMessages` stream
 *    events; if the CLI ever yields no stream events, whole assistant
 *    messages fall back to one delta per text block on arrival — still
 *    strictly better than end-of-request replay.
 *  - Abort: the pi stream's AbortSignal drives the SDK's abortController
 *    (claude-direct's pattern); an abort ends the stream with reason
 *    "aborted", which runPi's user-cancel path swallows quietly.
 *
 * Containment (all enforced here, not in prompts):
 *  - Account pick mirrors opencode/meridian: pickBridgeAccount (exported by
 *    the bridge) draws from the general claude-accounts pool with the run
 *    user's personal-first routing, honoring run-level pins (accountId/
 *    accountStrict/usageCredits). An opencode bridgeAccountIds designation,
 *    when set, still contains serving to exactly those ids (legacy override).
 *    Building the provider throws bridgeDesignationError()'s exact message
 *    when the engine is disabled or no account exists, so the run fails as
 *    early and as clearly as the bridge path did.
 *  - Usage-limit-shaped SDK failures markExhausted the picked account and
 *    surface with their original message, which isPiUsageLimitShape's
 *    anthropic arm already classifies (isClaudeUsageLimitError shapes, 429,
 *    "no designated bridge account"); the per-account rolling hourly cap
 *    (admitBridgeRequest — shared counter with the bridge) refuses with a
 *    429-worded error for the same reason.
 *  - Audit parity with the bridge (this replaces its per-request audit for pi
 *    traffic): `pi_anthropic_request` in/out with summarizeText, unified
 *    session attribution, account, tokens, duration — never raw text dumps,
 *    never tokens/secrets.
 *  - Env hygiene: the SDK subprocess env is PATH/HOME/LANG +
 *    CLAUDE_CODE_OAUTH_TOKEN + an ISOLATED per-account CLAUDE_CONFIG_DIR
 *    under stateDir("pi")/claude-cfg (claude-direct's stricter pattern — the
 *    subprocess can never fall back to host ~/.claude credentials), cwd is
 *    the bridge's empty BRIDGE_CWD (every tool is a blocked passthrough, no
 *    worktree must ever be visible), and the SDK's own built-ins are
 *    disallowed (DISALLOWED_BUILTINS + the block-everything hook backstop).
 *
 * Known approximations (bridge parity, documented): `temperature`/`maxTokens`
 * /`timeoutMs` and pi's `reasoning` thinking level are ignored (the SDK does
 * not expose them); thinking blocks stream out but are dropped from replay
 * (signatures cannot round-trip through flat text); images in replayed
 * history are dropped.
 *
 * pi-ai is not a direct dependency (only @earendil-works/pi-coding-agent is),
 * so the Provider surface is structurally typed: types derive from
 * ModelRuntime's own signatures and the one cast lives in
 * buildPiAnthropicProvider. Returning a plain async generator from stream()
 * is contract-safe — ModelRuntime wraps every provider stream in pi-ai's
 * lazyStream, which forwards any AsyncIterable<AssistantMessageEvent> into a
 * real event stream and converts generator throws into terminal error events.
 */

import { mkdirSync } from "fs";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stateDir } from "./paths";
import { audit, summarizeText } from "./audit";
import {
  BRIDGE_CWD,
  DISALLOWED_BUILTINS,
  PASSTHROUGH_MCP,
  PASSTHROUGH_PREFIX,
  admitBridgeRequest,
  bridgeDesignationError,
  flattenMessageText,
  jsonSchemaToZodShape,
  pickBridgeAccount,
  replayConversation,
  type AnthropicMessage,
  type ContentBlock,
} from "./anthropic-bridge";
import { markExhausted, type ClaudeAccount } from "./claude-accounts";
import { CLAUDE_CODE_BIN, isClaudeUsageLimitError } from "./runner-shared";

const g = globalThis as any;

// ── Types (derived from the SDK so pi-ai never becomes a value import) ───────

/** The pi-ai Provider shape registerNativeProvider accepts. */
export type PiNativeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0];
/** The pi-ai Model shape the runtime resolves and streams with. */
export type PiCatalogModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** Minimal structural view of pi's Message union — only the fields the
 *  converter reads (pi-ai is type-only reachable; these are its stable wire
 *  shapes). */
export interface PiWireMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | Array<Record<string, any>>;
  toolCallId?: string;
  [key: string]: unknown;
}

interface PiToolShape {
  name: string;
  description: string;
  parameters?: unknown;
}

interface PiStreamContext {
  systemPrompt?: string;
  messages: PiWireMessage[];
  tools?: PiToolShape[];
}

interface PiStreamCallOptions {
  signal?: AbortSignal;
  sessionId?: string;
  [key: string]: unknown;
}

interface PiUsageShape {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface PiAssistantMessageShape {
  role: "assistant";
  content: Array<Record<string, any>>;
  api: string;
  provider: string;
  model: string;
  usage: PiUsageShape;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

type PiStreamEvent =
  | { type: "start"; partial: PiAssistantMessageShape }
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial: PiAssistantMessageShape }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial: PiAssistantMessageShape }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: PiAssistantMessageShape }
  | { type: "toolcall_end"; contentIndex: number; toolCall: Record<string, any>; partial: PiAssistantMessageShape }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: PiAssistantMessageShape }
  | { type: "error"; reason: "aborted" | "error"; error: PiAssistantMessageShape };

// ── The passthrough block wording (the no-stop-nudging change) ───────────────

/** PreToolUse block reason. Unlike the bridge's wording it never says "do not
 *  call more tools": the call is captured for client-side execution and the
 *  model is invited to emit every OTHER call it needs in the same turn, then
 *  end it — that keeps multi-tool batches one round-trip instead of nudging
 *  sequential models into max-turns. */
export const PI_PASSTHROUGH_BLOCK_REASON =
  "This tool call was captured and queued for client-side execution; its result will arrive " +
  "in the next turn. If you need other tools run in this same batch, call each OTHER tool " +
  "you need now — then end your turn. Do not retry this same call.";

/** Generous turn budget: each blocked tool call costs a turn boundary, and
 *  multi-tool batches (or models that try tools one at a time) need headroom.
 *  error_max_turns WITH captures is still a success (see the run loop). */
export const PI_SDK_MAX_TURNS = 8;

// ── pi messages → the bridge's Anthropic wire shape ──────────────────────────

/**
 * Convert pi's Message[] into the AnthropicMessage[] the bridge helpers
 * (flattenMessageText / replayConversation) understand: assistant ToolCall
 * blocks become tool_use, toolResult messages become user tool_result
 * messages, thinking blocks and images are dropped (they cannot round-trip
 * through a flat-text replay). Exported for the unit tests.
 */
export function piMessagesToAnthropic(messages: readonly PiWireMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
      } else if (Array.isArray(m.content)) {
        const blocks: ContentBlock[] = m.content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => ({ type: "text", text: b.text }));
        out.push({ role: "user", content: blocks });
      }
    } else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
          else if (b.type === "toolCall" && b.id) {
            blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments ?? {} });
          }
          // thinking: dropped — signatures cannot round-trip through flat replay.
        }
      }
      out.push({ role: "assistant", content: blocks });
    } else if (m.role === "toolResult") {
      const inner: ContentBlock[] = Array.isArray(m.content)
        ? m.content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => ({ type: "text", text: b.text }))
        : [{ type: "text", text: String(m.content ?? "") }];
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: inner }],
      });
    }
  }
  return out;
}

// ── Per-unified-session SDK session store (the bridge's continuation logic) ──

export interface PiSdkSessionState {
  sdkSessionId: string;
  /** How many pi-side messages the SDK session has already seen. */
  messageCount: number;
  /** Account whose isolated CLAUDE_CONFIG_DIR holds the SDK session. A later
   *  turn served by a DIFFERENT designated account cannot resume it (the
   *  bridge shared host ~/.claude and could; isolation trades that for
   *  never-touching-host-creds) — the caller treats an account mismatch as
   *  divergence and replays fresh. */
  accountId: string;
  lastUsedAt: number;
}

// unified session id → SDK session mapping; globalThis-parked for hot reloads
// (a real restart replays — correct, only slower). Exported for tests.
export function piSdkSessionStore(): Map<string, PiSdkSessionState> {
  return (g.__piAnthropicSdkSessions ??= new Map<string, PiSdkSessionState>());
}

export interface PiSdkTurnPlan {
  /** SDK session to resume; undefined = fresh session. */
  resume: string | undefined;
  /** Flat-text prompt: the new tail on continuation, the full replay else. */
  prompt: string;
  continuation: boolean;
}

/** The bridge's continuation decision, factored pure for tests: continuation
 *  = the history strictly grew past what the stored SDK session has seen (only
 *  the new tail is delivered); anything else — first turn, edited or
 *  compacted history — replays the whole conversation into a fresh session. */
export function planSdkTurn(
  stored: PiSdkSessionState | undefined,
  messages: AnthropicMessage[]
): PiSdkTurnPlan {
  const continuation = !!stored && messages.length > stored.messageCount;
  return continuation
    ? {
        resume: stored!.sdkSessionId,
        prompt: replayConversation(messages.slice(stored!.messageCount)),
        continuation,
      }
    : { resume: undefined, prompt: replayConversation(messages), continuation: false };
}

export const MAX_PI_SDK_SESSIONS = 500;

/** Record the post-turn mapping (+1: the assistant message this turn returns
 *  will be in pi's history on the next call) and prune oldest past the cap. */
export function rememberSdkTurn(
  key: string,
  sdkSessionId: string,
  wireMessageCount: number,
  accountId: string
): void {
  const store = piSdkSessionStore();
  store.set(key, {
    sdkSessionId,
    messageCount: wireMessageCount + 1,
    accountId,
    lastUsedAt: Date.now(),
  });
  if (store.size <= MAX_PI_SDK_SESSIONS) return;
  const byAge = [...store.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [k] of byAge.slice(0, store.size - MAX_PI_SDK_SESSIONS)) store.delete(k);
}

// ── Model catalog ────────────────────────────────────────────────────────────

/**
 * The native provider's catalog: pi's builtin anthropic models passed through
 * untouched (ids, cost tables, context windows, compat — registerNativeProvider
 * REPLACES the builtin provider, so the catalog must ride along), plus a
 * zero-cost fallback entry when the run's model id is newer than the installed
 * catalog (subscription-billed; safe Anthropic defaults — the same fallback
 * registration the bridge path used). Exported for tests.
 */
export function buildPiAnthropicModels(
  builtin: readonly PiCatalogModel[],
  ensureModelId?: string
): PiCatalogModel[] {
  const models = builtin.map((m) => ({ ...m }));
  if (ensureModelId && !models.some((m) => m.id === ensureModelId)) {
    models.push({
      id: ensureModelId,
      name: ensureModelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    } as PiCatalogModel);
  }
  return models;
}

// ── Usage / cost ─────────────────────────────────────────────────────────────

function zeroUsage(): PiUsageShape {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** SDK result usage → pi Usage with cost from the model's cost table —
 *  pi-ai's calculateCost math (request-wide tiers included; the SDK reports
 *  no 1h-write split, so every cache write prices at the base write rate). */
export function usageFromSdkResult(
  model: PiCatalogModel,
  sdkUsage: Record<string, number | undefined> | null | undefined
): PiUsageShape {
  const u = sdkUsage || {};
  const usage = zeroUsage();
  usage.input = u.input_tokens || 0;
  usage.output = u.output_tokens || 0;
  usage.cacheRead = u.cache_read_input_tokens || 0;
  usage.cacheWrite = u.cache_creation_input_tokens || 0;
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates: { input: number; output: number; cacheRead: number; cacheWrite: number } = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  usage.cost.input = (rates.input / 1_000_000) * usage.input;
  usage.cost.output = (rates.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (rates.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}

// ── The provider ─────────────────────────────────────────────────────────────

export interface PiAnthropicProviderOpts {
  /** Unified session id — the SDK session-store key and audit attribution. */
  unifiedSessionId: string;
  user?: string;
  /** Run-level account pin, honored only within the bridge designation. */
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  /** pi's builtin anthropic catalog (runtime.getModels("anthropic") BEFORE
   *  registration — the native provider replaces the builtin one). */
  builtinModels?: readonly PiCatalogModel[];
  /** The run's model id; appended as a zero-cost fallback when the builtin
   *  catalog lacks it. */
  ensureModelId?: string;
}

/** Per-account isolated SDK config dir — never host ~/.claude. */
function claudeConfigDirFor(accountId: string): string {
  const dir = `${stateDir("pi")}/claude-cfg/${accountId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build the native provider for one run. Throws bridgeDesignationError()'s
 * message when no config designates serving accounts (the same early, clear
 * failure ensureAnthropicBridge gave the bridge path — without starting any
 * HTTP listener). The returned object is registered with
 * runtime.registerNativeProvider under the builtin id "anthropic", replacing
 * the HTTP-bound builtin for this run's runtime only.
 */
export function buildPiAnthropicProvider(opts: PiAnthropicProviderOpts): PiNativeProvider {
  const designationError = bridgeDesignationError();
  if (designationError) throw new Error(designationError);
  const models = buildPiAnthropicModels(opts.builtinModels || [], opts.ensureModelId);
  const stream = (model: PiCatalogModel, context: PiStreamContext, options?: PiStreamCallOptions) =>
    runSdkStream(opts, model, context, options);
  const provider = {
    id: "anthropic",
    name: "Anthropic (in-process Claude Agent SDK)",
    baseUrl: "https://api.anthropic.com",
    // Always configured: accounts are picked per request from the bridge
    // designation; there is no API key. An empty ModelAuth keeps ModelRuntime's
    // prepareRequest/checkAuth satisfied without inventing a secret.
    auth: {
      apiKey: {
        name: "Open Session designated Claude accounts (in-process)",
        resolve: async () => ({ auth: {}, source: "in-process claude-agent-sdk" }),
      },
    },
    getModels: () => models,
    stream,
    // pi's agent loop calls streamSimple (reasoning level rides the options);
    // the SDK exposes no thinking-budget control, so both entry points map to
    // the same run (bridge parity — thinking level was ignored there too).
    streamSimple: stream,
  };
  return provider as unknown as PiNativeProvider;
}

// ── The SDK turn ─────────────────────────────────────────────────────────────

interface CapturedToolUse {
  id: string;
  name: string;
  input: unknown;
}

async function* runSdkStream(
  opts: PiAnthropicProviderOpts,
  model: PiCatalogModel,
  context: PiStreamContext,
  options: PiStreamCallOptions | undefined
): AsyncGenerator<PiStreamEvent> {
  const signal = options?.signal;
  const requestId = crypto.randomUUID();
  const started = Date.now();

  const partial: PiAssistantMessageShape = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  yield { type: "start", partial };

  const fail = (reason: "aborted" | "error", message: string): PiStreamEvent => ({
    type: "error",
    reason,
    error: {
      ...partial,
      stopReason: reason === "aborted" ? "aborted" : "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  });

  // Store key: the stream option sessionId is the pi session id on agent
  // turns (stable across a conversation) and a FRESH uuid on pi's
  // summarization one-shots (completeSummarization isolates routing per
  // request) — so summaries never resume, and never corrupt, the
  // conversation's SDK-session mapping. Unified id is the fallback.
  const sessionKey =
    typeof options?.sessionId === "string" && options.sessionId
      ? options.sessionId
      : opts.unifiedSessionId;
  const storeKey = `pi:${sessionKey}`;
  // Set once the turn plan exists; the catch evicts the stored mapping on a
  // failed continuation so the NEXT turn replays fresh instead of resuming a
  // dead SDK session forever (count-based divergence never triggers while
  // history keeps growing — meridian evicts on resume failure the same way).
  let plannedContinuation = false;
  const wireMessages = piMessagesToAnthropic(context.messages || []);
  const requestTools = context.tools || [];
  const system = context.systemPrompt || "";

  const auditBase = {
    msg: "pi_anthropic_request",
    request_id: requestId,
    session: opts.unifiedSessionId,
    user: opts.user,
    model: model.id,
    tools: requestTools.length,
  };

  let account: ClaudeAccount | undefined;
  const captured: CapturedToolUse[] = [];
  try {
    if (signal?.aborted) {
      yield fail("aborted", "Request aborted");
      return;
    }

    const picked = pickBridgeAccount(model.id, {
      accountId: opts.accountId,
      accountStrict: opts.accountStrict,
      usageCredits: opts.usageCredits,
      user: opts.user,
    });
    if ("error" in picked) throw new Error(picked.error);
    account = picked;

    // Continuation planning happens with the account known: a stored SDK
    // session lives in ITS account's isolated CLAUDE_CONFIG_DIR, so a turn
    // the designated walk moved to a different account treats the mapping as
    // divergence and replays fresh instead of failing a cross-dir resume.
    const stored = piSdkSessionStore().get(storeKey);
    const plan = planSdkTurn(
      stored && stored.accountId === account.id ? stored : undefined,
      wireMessages
    );
    plannedContinuation = plan.continuation;

    // Rolling per-account hourly cap — the SAME per-boot counter the bridge
    // admits against, so pi traffic and any residual bridge traffic share one
    // ceiling per designated account. "429" keeps the refusal
    // usage-limit-shaped for isPiUsageLimitShape (fallback walk engages), but
    // the tag keeps the catch from markExhausted-ing the account: the cap is
    // OUR local admission control, it frees within the hour, and the
    // exhaustion sideline is shared with the opencode bridge — a synthetic
    // refusal must never bench the account cross-engine until the 5h reset.
    const estTokens = Math.ceil((plan.prompt.length + system.length) / 4);
    const rate = admitBridgeRequest(account.id, estTokens);
    if (!rate.allowed) {
      const rateErr = new Error(
        `pi-anthropic 429: account "${account.name}" exceeded ${rate.limit} requests/hour ` +
          "(bridgeMaxRequestsPerHour)"
      );
      (rateErr as any).piLocalRateCap = true;
      throw rateErr;
    }

    audit({
      ...auditBase,
      direction: "in",
      account: account.name,
      continuation: plan.continuation,
      ...summarizeText(plan.prompt),
    });

    const passthroughTools = requestTools.map((t) =>
      tool(t.name, t.description || t.name, jsonSchemaToZodShape(t.parameters), async () => ({
        content: [{ type: "text" as const, text: "forwarded to client" }],
      }))
    );
    const mcpServers =
      passthroughTools.length > 0
        ? { [PASSTHROUGH_MCP]: createSdkMcpServer({ name: PASSTHROUGH_MCP, tools: passthroughTools }) }
        : {};

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let sdkSessionId: string | undefined;
    let sdkUsage: Record<string, number> | undefined;
    let reachedResult = false;
    // Stream-event bookkeeping: SDK content-block index (per SDK message) →
    // index into `partial.content`; -1 marks a block we deliberately skip
    // (tool_use streams are ignored — the post-hook captures are authoritative
    // and a blocked-then-retried call must not double).
    let idxMap = new Map<number, number>();
    let sawStreamContent = false;
    let emittedCaptures = 0;

    const q = query({
      prompt: plan.prompt,
      options: {
        cwd: BRIDGE_CWD,
        model: model.id,
        resume: plan.resume,
        abortController: controller,
        includePartialMessages: true,
        maxTurns: PI_SDK_MAX_TURNS,
        systemPrompt: system || " ",
        settingSources: [],
        mcpServers: mcpServers as any,
        strictMcpConfig: true,
        disallowedTools: DISALLOWED_BUILTINS,
        allowedTools: requestTools.map((t) => `${PASSTHROUGH_PREFIX}${t.name}`),
        pathToClaudeCodeExecutable: CLAUDE_CODE_BIN,
        executable: "bun" as const,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          CLAUDE_CODE_OAUTH_TOKEN: account.token,
          CLAUDE_CONFIG_DIR: claudeConfigDirFor(account.id),
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hooks: [
                async (input: any) => {
                  const name = String(input.tool_name || "");
                  const bare = name.startsWith(PASSTHROUGH_PREFIX)
                    ? name.slice(PASSTHROUGH_PREFIX.length)
                    : name;
                  captured.push({ id: input.tool_use_id, name: bare, input: input.tool_input ?? {} });
                  return { decision: "block" as const, reason: PI_PASSTHROUGH_BLOCK_REASON };
                },
              ],
            },
          ],
        },
      },
    });

    /** Emit toolcall events for captures the hook recorded since last drain.
     *  Captures happen after the model finished emitting that tool_use block,
     *  so appending at the next SDK message keeps content order coherent. */
    function* drainCaptures(): Generator<PiStreamEvent> {
      while (emittedCaptures < captured.length) {
        const c = captured[emittedCaptures++];
        const toolCall = { type: "toolCall", id: c.id, name: c.name, arguments: c.input ?? {} };
        const contentIndex = partial.content.push(toolCall) - 1;
        yield { type: "toolcall_start", contentIndex, partial };
        yield { type: "toolcall_delta", contentIndex, delta: JSON.stringify(c.input ?? {}), partial };
        yield { type: "toolcall_end", contentIndex, toolCall, partial };
      }
    }

    try {
      for await (const msg of q) {
        yield* drainCaptures();
        const m = msg as Record<string, any>;
        if (m.type === "system" && m.subtype === "init") {
          sdkSessionId = String(m.session_id || "") || sdkSessionId;
          continue;
        }
        if (m.type === "stream_event") {
          // Token-level path: raw Anthropic stream events (BetaRawMessageStreamEvent).
          // Nested (subagent) streams carry parent_tool_use_id; Task/Agent are
          // disallowed so none should occur — skip them as a double-count guard.
          if (m.parent_tool_use_id) continue;
          const ev = m.event as Record<string, any> | undefined;
          if (!ev) continue;
          if (ev.type === "message_start") {
            idxMap = new Map();
          } else if (ev.type === "content_block_start") {
            const block = ev.content_block as Record<string, any> | undefined;
            const sdkIdx = Number(ev.index);
            if (block?.type === "text") {
              sawStreamContent = true;
              const contentIndex = partial.content.push({ type: "text", text: "" }) - 1;
              idxMap.set(sdkIdx, contentIndex);
              yield { type: "text_start", contentIndex, partial };
            } else if (block?.type === "thinking") {
              sawStreamContent = true;
              const contentIndex = partial.content.push({ type: "thinking", thinking: "" }) - 1;
              idxMap.set(sdkIdx, contentIndex);
              yield { type: "thinking_start", contentIndex, partial };
            } else {
              // tool_use / redacted_thinking / anything else: not streamed —
              // tool calls arrive via the capture hook.
              idxMap.set(sdkIdx, -1);
            }
          } else if (ev.type === "content_block_delta") {
            const contentIndex = idxMap.get(Number(ev.index));
            if (contentIndex === undefined || contentIndex === -1) continue;
            const delta = ev.delta as Record<string, any> | undefined;
            const blk = partial.content[contentIndex];
            if (delta?.type === "text_delta" && typeof delta.text === "string" && blk?.type === "text") {
              blk.text += delta.text;
              yield { type: "text_delta", contentIndex, delta: delta.text, partial };
            } else if (
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string" &&
              blk?.type === "thinking"
            ) {
              blk.thinking += delta.thinking;
              yield { type: "thinking_delta", contentIndex, delta: delta.thinking, partial };
            } else if (delta?.type === "signature_delta" && blk?.type === "thinking") {
              blk.thinkingSignature = `${blk.thinkingSignature || ""}${delta.signature || ""}`;
            }
          } else if (ev.type === "content_block_stop") {
            const contentIndex = idxMap.get(Number(ev.index));
            if (contentIndex === undefined || contentIndex === -1) continue;
            const blk = partial.content[contentIndex];
            if (blk?.type === "text") {
              yield { type: "text_end", contentIndex, content: blk.text, partial };
            } else if (blk?.type === "thinking") {
              yield { type: "thinking_end", contentIndex, content: blk.thinking, partial };
            }
          }
          continue;
        }
        if (m.type === "assistant" && !sawStreamContent) {
          // Fallback (no partial stream events from the CLI): emit each text
          // block as one delta on arrival — per-message, not end-of-request.
          const blocks = m.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (!b || typeof b !== "object" || b.type !== "text" || !b.text) continue;
              const contentIndex = partial.content.push({ type: "text", text: b.text }) - 1;
              yield { type: "text_start", contentIndex, partial };
              yield { type: "text_delta", contentIndex, delta: b.text, partial };
              yield { type: "text_end", contentIndex, content: b.text, partial };
            }
          }
          continue;
        }
        if (m.type === "result") {
          sdkSessionId = String(m.session_id || "") || sdkSessionId;
          // error_max_turns WITH captures is a SUCCESS (the bridge's fix):
          // models that answer a blocked call by trying the next tool burn a
          // turn per call and can blow the cap before ending cleanly — the
          // captures are the whole point. Only a capture-less max-turns (the
          // model never called a tool) stays an error.
          const maxTurnsWithCaptures = m.subtype === "error_max_turns" && captured.length > 0;
          if ((m.is_error || m.subtype !== "success") && !maxTurnsWithCaptures) {
            const detail =
              (typeof m.result === "string" && m.result) ||
              partial.content
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("\n") ||
              (Array.isArray(m.errors) && m.errors.join(", ")) ||
              m.subtype ||
              "SDK run failed";
            throw new Error(String(detail));
          }
          sdkUsage = m.usage || undefined;
          reachedResult = true;
          break;
        }
        // Every other SDK message kind (status, hooks, task notifications,
        // user tool-result replays) is engine-internal — ignored.
      }
      yield* drainCaptures();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      // Abandonment backstop: a consumer that stops iterating this generator
      // (early .return()/throw upstream) must not leave the SDK subprocess
      // running unattended — abort it whenever the run never reached its
      // result message (a completed run's subprocess is already exiting).
      if (!reachedResult) controller.abort();
    }

    if (signal?.aborted) {
      audit({
        ...auditBase,
        direction: "out",
        ok: false,
        account: account.name,
        duration_ms: Date.now() - started,
        error: "aborted",
      });
      yield fail("aborted", "Request aborted");
      return;
    }
    if (!reachedResult) {
      // Subprocess died without a result message (claude-direct's rule): an
      // error, never a silent empty completion.
      throw new Error("SDK stream ended without a result message");
    }

    if (sdkSessionId) {
      rememberSdkTurn(storeKey, sdkSessionId, wireMessages.length, account.id);
    }

    const usage = usageFromSdkResult(model, sdkUsage);
    partial.usage = usage;
    const stopReason: "toolUse" | "stop" = captured.length ? "toolUse" : "stop";
    const message: PiAssistantMessageShape = {
      ...partial,
      stopReason,
      usage,
      timestamp: Date.now(),
    };
    audit({
      ...auditBase,
      direction: "out",
      ok: true,
      account: account.name,
      continuation: plan.continuation,
      duration_ms: Date.now() - started,
      stop_reason: stopReason,
      tool_uses: captured.length,
      sdk_session_id: sdkSessionId,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: usage.cacheRead,
      ...summarizeText(
        partial.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n")
      ),
    });
    yield { type: "done", reason: stopReason, message };
  } catch (e: any) {
    if (signal?.aborted) {
      audit({
        ...auditBase,
        direction: "out",
        ok: false,
        ...(account ? { account: account.name } : {}),
        duration_ms: Date.now() - started,
        error: "aborted",
      });
      yield fail("aborted", "Request aborted");
      return;
    }
    const message: string = e?.message || String(e);
    // A failed continuation may mean the resumed SDK session is dead (config
    // dir swept/wiped): evict the mapping so the next turn replays fresh.
    if (plannedContinuation) piSdkSessionStore().delete(storeKey);
    // Usage-limit-shaped death: sideline the picked designated account before
    // surfacing (claude-direct's markExhausted discipline); the preserved
    // message is what isPiUsageLimitShape classifies upstream. The local
    // rolling-cap refusal is exempt (tagged at the throw): it is 429-worded
    // for the classifier but is not account exhaustion.
    if (account && !e?.piLocalRateCap && isClaudeUsageLimitError(message, true)) {
      markExhausted(account.id, model.id);
    }
    audit({
      ...auditBase,
      direction: "out",
      ok: false,
      ...(account ? { account: account.name } : {}),
      duration_ms: Date.now() - started,
      error: message,
    });
    yield fail("error", message);
  }
}
