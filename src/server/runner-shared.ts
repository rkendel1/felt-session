/**
 * Engine-neutral runner infrastructure shared across the engine and agents:
 *
 * - filterMcpServers: per-run MCP resolution (allowlist + per-user
 *   `allowedUsers` gating, strips our metadata before the config reaches an
 *   engine).
 * - STRIPE_CONFIRM_TOOLS: the money-moving Stripe tool catalog (confirm-listed
 *   in interactive runs, denied/stripped in unattended ones).
 * - isClaudeUsageLimitError / isCodexUsageLimitError: provider usage-limit
 *   detection driving account rotation and model fallback.
 * - CLAUDE_CODE_BIN: the Claude Code CLI path (the Meridian bridge's motor).
 */
import { readMcpConfig, withDynamicCredentials } from "./connections";
import { userMatchesAny } from "./shared/user-mappings";
import { configuredPaths } from "./config";

/** Claude Code CLI binary the Meridian bridge / anthropic-bridge spawn.
 *  OPENSESSION_CLAUDE_BIN env → config `paths.claudeBin` → this VPS's path. */
export const CLAUDE_CODE_BIN = configuredPaths().claudeBin;

/** Moved to the protocol package; re-exported for existing import sites. */
export type { McpScope } from "@tellahq/opensession-protocol/runner";
import type { McpScope } from "@tellahq/opensession-protocol/runner";

/**
 * Resolve the MCP servers for a run: all configured, or just the allowlist,
 * minus any server whose per-user `allowedUsers` list excludes `user`. The
 * `allowedUsers` field is stripped from every entry before it reaches an
 * engine (it's our metadata, not MCP config).
 */
export function filterMcpServers(
  scope: McpScope,
  user?: string,
  /** OAuth grant identities in priority order (default: [user]). The
   *  allowedUsers VISIBILITY gate below always uses `user` (the prompter) —
   *  that's least-privilege, not identity preference. */
  grantUsers?: Array<string | undefined>,
): Record<string, unknown> {
  const all = withDynamicCredentials(
    readMcpConfig().mcpServers,
    grantUsers ?? user,
  );
  const out: Record<string, unknown> = {};
  const allowlist = scope === "all" ? undefined : scope;
  const names = allowlist ?? Object.keys(all);
  for (const name of names) {
    const cfg = all[name] as any;
    if (!cfg) {
      if (allowlist) console.warn(`[runner] MCP allowlist names unknown server "${name}" — skipping`);
      continue;
    }
    const { allowedUsers, oauthUrl, ...entry } = cfg;
    if (Array.isArray(allowedUsers) && allowedUsers.length) {
      // Cleared when the prompter OR the session creator (grantUsers[0]) is
      // on the list — anyone with access to a cleared person's session can
      // use it there (per-session invites = future).
      const gateUsers = [user, ...(grantUsers || [])].filter(
        (u): u is string => !!u,
      );
      if (!gateUsers.some((u) => userMatchesAny(u, allowedUsers))) continue;
    }
    out[name] = entry;
  }
  return out;
}

/**
 * Money-moving Stripe tools: interactive Open Session runs drop the whole
 * server fail-closed (no per-call approval bridge on the opencode engine);
 * unattended runs strip these from the tool list with propose-it-in-your-
 * output guidance. The raw-API tools are included because they can hit any
 * endpoint the restricted key allows, including refunds and cancels.
 *
 * Keep this list in sync with mcp.stripe.com's live catalog: verified
 * 2026-07-09 the server now exposes `stripe_api_write` (mutating raw API
 * call — the successor of `stripe_api_execute`) plus read-only
 * `stripe_api_read`/`stripe_api_search`/`stripe_api_details`, and no longer
 * ships cancel/update_subscription as named tools. The superseded names stay
 * listed (a deny/confirm entry for a tool that doesn't exist is harmless; a
 * missing entry for one that does is a hole).
 */
export const STRIPE_CONFIRM_TOOLS: Record<string, string> = {
  mcp__stripe__create_refund: "Create a refund",
  mcp__stripe__cancel_subscription: "Cancel a subscription",
  mcp__stripe__update_subscription: "Update a subscription",
  mcp__stripe__stripe_api_execute: "Execute a raw Stripe API call",
  mcp__stripe__stripe_api_write: "Execute a mutating Stripe API call",
};

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
  // Credit-metered premium models (e.g. Fable 5) exhaust a separate per-account
  // credit pool, not the 5-hour session limit, and say so with none of the
  // "limit/reached/resets" tokens: "You're out of usage credits. Run
  // /usage-credits to keep using Fable 5 or /model to switch models." Treat it
  // as a usage limit so the run rotates to another account (each has its own
  // credit balance) and, once the pool is drained, falls back off the model.
  if (/out of (usage )?credits/.test(s) || s.includes("/usage-credits")) return true;
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

/**
 * A Claude account whose *subscription* is the fault — an expired, downgraded,
 * or billing-blocked Max plan. The bridge surfaces it as
 * "AI_APICallError: Claude Max subscription issue. Check your subscription
 * status at https://claude.ai/settings/subscription". This is NOT a usage limit
 * (no reset frees it) but it IS an account-level fault that is dead on retry, so
 * callers should sideline the account and rotate off it exactly like a usage
 * limit rather than retrying the same account into a timeout. opencode's ai-sdk
 * treats it as retryable, so if it's not caught it manifests as a long hang.
 */
export function isClaudeSubscriptionError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes("subscription issue") ||
    s.includes("check your subscription") ||
    (s.includes("claude max") && s.includes("subscription"))
  );
}

/**
 * The Meridian bridge could not start Claude Code for a run at all — the agent
 * SDK spawns the native binary and it either exited immediately ("Claude Code
 * native binary at <path> exists but failed to launch.") or was missing.
 *
 * This is a spawn-time failure on THIS box, not a verdict on the account: the
 * runs it hit were on two accounts, both
 * healthy and serving other sessions at that moment, and the binary launches
 * fine by hand. Treat it as a wedge — sideline briefly, respawn, retry — not
 * as an account-level fault.
 *
 * Worth catching because opencode's ai-sdk classes it retryable and nothing
 * else matches the string: uncaught it becomes ~13 backoff retries over ~2h16m
 * against a proxy that can't spawn, and then a turn that idles to the
 * wall-clock deadline and reports "Stopped after 3 hours".
 */
export function isClaudeBridgeLaunchError(message: string): boolean {
  const s = message.toLowerCase();
  if (!s.includes("claude code native binary")) return false;
  return s.includes("failed to launch") || s.includes("not found");
}

/**
 * Meridian's idle guard killed an upstream stream that produced zero bytes
 * ("Upstream stalled: no data for <n>ms") — the SDK daemon behind the proxy
 * accepted the request and went silent. Unlike an ordinary provider error,
 * every one of these already represents 90s+ of measured dead air on a FRESH
 * request, and opencode's retry re-enters the same wedged daemon, so a streak
 * of them can never recover on its own (2026-08-03 bks-019fc819: three of
 * these 7 min apart, 25 min of dead air until the human cancelled). The stall
 * backstop fires on a lower bar when a retry streak is made of only these.
 */
export function isUpstreamIdleStallError(message: string): boolean {
  return /upstream stalled: no data for/i.test(message);
}

export function isCodexUsageLimitError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes("rate limit") ||
    s.includes("rate_limit") ||
    s.includes("429") ||
    s.includes("usage limit") ||
    (s.includes("limit") && s.includes("reached")) ||
    s.includes("too many requests")
  );
}

/**
 * Infrastructure/transient run failures worth recovering from rather than
 * surfacing as a dead turn: a fresh server/account (opencode-runner) or the
 * next model in the fallback graph (agent-runner) usually clears them. The goal
 * is "continue without failing" — so this deliberately matches the failure
 * *shapes* our runner emits (server death, wedged bridge, network blips, 5xx,
 * SQLite write contention), NOT model output.
 *
 * Kept TIGHT on purpose. It must never match:
 *  - usage limits (their own rotation/fallback path owns those — check those
 *    classifiers first at every call site), or
 *  - a user abort / MessageAbortedError (callers already gate on
 *    `abortController.signal.aborted` before consulting this), or
 *  - a genuine tool/model error the model itself produced.
 * A false positive here spends real budget retrying / silently downgrades the
 * model, so when in doubt this returns false and the error surfaces.
 */
export function isTransientRunError(message: string | undefined | null): boolean {
  if (!message) return false;
  const s = message.toLowerCase();
  // Never treat a user/engine abort as transient — that's an intentional stop.
  if (s.includes("messageabortederror") || s.includes("aborted")) return false;
  return (
    // Network / socket
    s.includes("econnrefused") ||
    s.includes("econnreset") ||
    s.includes("etimedout") ||
    s.includes("enotfound") ||
    s.includes("epipe") ||
    s.includes("socket hang up") ||
    s.includes("socket connection") ||
    s.includes("network error") ||
    s.includes("fetch failed") ||
    s.includes("connection error") ||
    s.includes("connection closed") ||
    s.includes("connection refused") ||
    // Liveness wedge — the Meridian proxy stopped returning bytes mid-run
    s.includes("produced no output within") ||
    // Server death / boot failure
    s.includes("opencode server exited") ||
    s.includes("server exited") ||
    s.includes("server died") ||
    s.includes("failed to start opencode") ||
    s.includes("econnaborted") ||
    // HTTP 5xx / gateway / provider overload
    s.includes("bad gateway") ||
    s.includes("service unavailable") ||
    s.includes("gateway timeout") ||
    s.includes("internal server error") ||
    s.includes("overloaded_error") ||
    s.includes("overloaded") ||
    /\b50[234]\b/.test(s) ||
    // OpenCode's shared SQLite store under write contention — transient, retry
    // clears it (see the SQLite-statement-failure runbook).
    s.includes("failed to execute statement")
  );
}

/**
 * Meridian's internal tool-result envelope shape — `[your <tool> …]: <output>`.
 * That envelope is how the bridge represents tool results in the model's
 * context, so assistant TEXT should never open with it: when it does, the
 * model is reciting tool results it invented, and every value inside is
 * fabricated (2026-07-29: a dial/opus-fable turn wrote four fake
 * `tella_create_source` results — wrong bucket, wrong ids, a signature reading
 * "I_TRUNCATED_FOR_BREVITY" — two seconds after the real results landed, then
 * spent five minutes debugging its own fake URLs and blamed the MCP relay).
 * The tool name is deliberately unconstrained: MCP tool ids like
 * `tella_create_source` must match, not just the builtin set. Anchored to the
 * start of the text to stay narrow — prose that merely quotes an envelope
 * mid-answer should not trip it.
 */
export const TOOL_RESULT_ENVELOPE_RE = /^\s*\[your [a-z0-9][\w.:-]*(?:\s[^\]]*)?\]:/i;

/**
 * Second observed costume of the same confabulation (2026-07-29, ~1h after
 * the first): instead of `[your …]:` blocks, the model narrated a whole fake
 * transcript as text — raw tool-input JSON under UI-style duration chips
 * (`– 5s` on its own line, en-dash exactly as the session view renders it,
 * likely copied from a screenshot in context) plus todowrite's canonical
 * result string — for tools it never called, including an invented
 * explore-subagent report the session later had to debunk itself. Meridian's
 * async-tool protocol trains the model that results arrive as in-band text
 * ("The result will be delivered in a future turn"), which makes
 * "write them yourself" a short hop.
 *
 * Markers are chosen for precision over recall: the en-dash chip immediately
 * followed by a JSON object/array line matches the fabricated-transcript
 * rendering but not markdown bullet lists (ASCII `-`), and the todowrite
 * result sentence is emitted only by the tool. False positives cost one
 * corrective steer notice, capped per turn at the detection sites.
 */
const DURATION_CHIP_JSON_RE = /(^|\n)[–—]\s*\d+(?:\.\d+)?\s*m?s\s*\n\s*[{[]/;

/**
 * Third observed costume (2026-07-29, bks-019fad97): the model wrote a raw
 * function-call block — `<invoke name="…">` with `<parameter name="…">`
 * lines — as assistant text, invented the tool's output inline, and ended
 * the turn convinced the call was in flight. That syntax is pure harness
 * protocol and never belongs in prose; requiring BOTH tags keeps a passing
 * mention of "<invoke" in code discussion from tripping it.
 */
const INVOKE_XML_RE = /<invoke name="[^"\n]{1,120}">[\s\S]{0,2000}?<parameter name="[^"\n]{1,120}">/;

export function looksLikeFabricatedToolTranscript(text: string): boolean {
  if (!text) return false;
  return (
    TOOL_RESULT_ENVELOPE_RE.test(text) ||
    DURATION_CHIP_JSON_RE.test(text) ||
    INVOKE_XML_RE.test(text) ||
    text.includes("Todos have been modified successfully")
  );
}
