/**
 * Pi engine runner — pi.dev's coding agent (`@earendil-works/pi-coding-agent`)
 * as a second engine beside opencode, driven IN-PROCESS through the SDK (the
 * claude-direct precedent, not the opencode server-pool one). Model ids are
 * `pi/<provider>/<model>`; served providers are `pi/anthropic/*` (the
 * loopback Anthropic bridge) and `pi/openai/*` (the ChatGPT-subscription
 * codex pool).
 *
 * Containment / policy parity (the research-policy 14-point checklist):
 *  - Config gate, not an env flag: every turn refuses unless
 *    `~/.opensession-pi.json` has `enabled: true` (pi-config.ts; read fresh
 *    per run). Kind gate copies opencodeGateReason semantics — deny by
 *    default on journal kind, kind-less runs refused, denials audited
 *    (`pi_gate_denied`). The one escape is the module-internal smoke bypass
 *    (kind "pi-smoke", armed only inside runPiSmokeTurn — never reachable
 *    from request/automation data).
 *  - Auth/billing: Anthropic traffic runs on the designated bridge accounts
 *    (opencode's bridgeAccountIds, falling back to pi.json's bridgeAccounts —
 *    never the pool) over one of two config-gated transports
 *    (pi-config `anthropicTransport`): "inprocess" (the default) registers a
 *    NATIVE pi-ai provider (pi-anthropic-provider.ts) that drives the Claude
 *    Agent SDK in this process — token-level streaming, per-unified-session
 *    SDK-session continuation, `pi_anthropic_request` audit, usage-limit
 *    markExhausted — while "bridge" keeps the pre-2026-08 loopback path as
 *    rollback: `ensureAnthropicBridge` + provider "anthropic" re-registered
 *    with the bridge baseUrl + per-boot key via setRuntimeApiKey, account
 *    selection inside the bridge, and a stable `x-opencode-session` header
 *    for session affinity + audit attribution. OpenAI traffic rides pi's
 *    native `openai-codex`
 *    provider (chatgpt.com backend, pi's own headers/transport — no custom
 *    headers) on the SAME ChatGPT-subscription codex pool as opencode/openai:
 *    pickOpenaiAccount → buildSeededOpenaiAuth (access-token-only + the
 *    deliberately-invalid placeholder refresh, the rotation-hazard fix
 *    documented in opencode-openai-auth.ts) seeded into the run's in-memory
 *    credential store under "openai-codex". NEVER
 *    setRuntimeApiKey("openai-codex", …): the provider is oauth-only, so a
 *    runtime api-key override is ignored for auth resolution and would only
 *    mask the seeded oauth credential. A usage-limit terminal sidelines the
 *    picked codex account via markCodexExhausted — sideline state SHARED
 *    with the opencode engine, same per-(account, model) keys. Either
 *    provider's 429/529/usage-limit shapes surface with
 *    `usageLimitExhausted: true` so agent-runner's fallback walk engages.
 *  - Local-tool containment (CRITICAL): pi runs in-process, so its built-in
 *    tools would execute with the SERVER env (bash, and the rg/fd children
 *    grep/find spawn env-inheriting) and unrestricted filesystem reach
 *    (read/grep resolve absolute paths as-is — /proc/self/environ included).
 *    NO built-in is ever reachable: every local tool the model sees is a
 *    same-name custom override (customs are set into pi's registry after
 *    built-ins — verified in 0.83.0 _refreshToolRegistry). The custom `bash`
 *    Bun.spawns in its own process group with a minimal explicit env
 *    (PATH/HOME/LANG + git identity + the per-user GitHub token on eligible
 *    interactive runs + the AWS pointer env when `opts.aws`); read/ls/find/
 *    edit/write wrap pi's own tool factories with guarded fs operations, and
 *    grep keeps pi's schema but re-implements execute so rg spawns with that
 *    same minimal env. All fs tools realpath-contain every path to opts.cwd
 *    (symlink escapes resolved through the nearest existing ancestor, so
 *    not-yet-created write targets are contained too; /proc, /sys and /dev
 *    rejected outright). Containment is cwd-only by design — ask mode
 *    (read/grep/find/ls + MCP, no bash) is therefore genuinely workspace-
 *    bound; code mode's bash remains fs-unconfined like opencode's (that is
 *    how attached-repo worktrees are reached) but never sees the server env.
 *  - Deny/confirm sets are enforced by REMOVAL: `opencodeRunPolicy` computes
 *    the strip-set (same `<server>_<tool>` id convention), and the MCP bridge
 *    (pi-mcp-bridge.ts) drops denied ids BEFORE registration — the model
 *    never sees them. Ask mode is actually read-only: tools are
 *    read/grep/find/ls + MCP only (no bash/edit/write — deliberate
 *    conservative v0, same stance claude-direct documents). Unattended
 *    code-mode bash is additionally screened per command through the org
 *    command policy (`bashAskPolicyReply`).
 *  - Isolation from ~/.pi: in-memory credential store, `modelsPath: null`,
 *    server-owned agentDir under stateDir("pi"), SettingsManager.inMemory,
 *    DefaultResourceLoader with extensions/skills/templates/themes disabled
 *    and the run instructions (`buildRunInstructions` — engine-neutral
 *    policy text) appended via systemPromptOverride. Context-file discovery
 *    is bounded to the workspace via agentsFilesOverride: pi's default walks
 *    every ancestor up to / (plus the agentDir global) — an out-of-workspace
 *    instruction-persistence channel — so only cwd-level AGENTS.md/CLAUDE.md
 *    survive the filter (opencode parity). Sessions persist under
 *    stateDir("pi")/sessions/<unified id>/ as pi-native jsonl; resume scans
 *    that dir for the header id (`piSessionId`). Resume-miss with store
 *    history (pi buffers a session's jsonl until its first ASSISTANT message,
 *    so a first turn that died pre-output journaled an id with no file) is
 *    bridged with a same-engine-restart handoff note prepended to the prompt.
 *  - Journal: two-stage like opencode (pre-engine record with the prompt, an
 *    upgrade with claudeSessionId=<piSessionId> once the session exists) but
 *    NEVER a serverKey — in-process runs don't survive a restart, so boot
 *    always takes the continuation re-prompt path. `journalClear` only on a
 *    reached terminal or user cancel; consumer teardown mid-turn keeps the
 *    record (and aborts the orphaned in-process turn — nothing to reattach).
 *  - Transcript: the claude-direct recipe — recordBksSessionFor BEFORE any
 *    engine-keyed append, early user line under the unified id with a stable
 *    uuid (engine writes upsert the same row), all writes best-effort.
 *    Content persistence rides `message_end` (assistant text + tool calls,
 *    tool results, delivered steers) and `compaction_end` (summary + its
 *    summarization usage folded into TurnUsage) — NOT `entry_appended`,
 *    which in 0.83.0 fires only for extension custom entries (never for
 *    messages; with noExtensions it never fires at all). Error-stopped
 *    assistant attempts are skipped: auto-retry replays them and the
 *    terminal error already carries the failure text.
 *  - Steer contract: accept = enqueue + audit `steer_queued`; the transcript
 *    user line is written only at DELIVERY (the steer's user `message_end`),
 *    so an undelivered steer keeps its run-session receipt as the recovery
 *    affordance (opencode's failed-POST semantics). steerPiRun stops
 *    accepting the moment prompt() settles, and steers that slipped into the
 *    queue after the agent loop's final poll are drained through a bounded
 *    `agent.continue()` before the done terminal.
 *  - Exactly ONE terminal event per turn; `agent_settled`/prompt() completion
 *    is the end-of-run signal (never agent_end, which can precede retries).
 *    A user cancel ends QUIETLY — no terminal error event, the generator
 *    just returns (opencode-runner's MessageAbortedError exemption) — so
 *    run-session records no failure, keeps no spurious "Needs input" state
 *    and never pings a parent about a worker a human deliberately stopped.
 *  - Auto-retry surfacing: pi's agent-level retries (3x, 2s base backoff;
 *    provider-level retries default to zero in 0.83.0) are made visible with
 *    a runner_notice per attempt, and retries on usage-limit-shaped errors
 *    (bridge 429/529 — the pool cannot serve) are aborted via abortRetry()
 *    so the terminal surfaces immediately and the fallback walk engages.
 *  - Audit: `pi_turn` family (in with summarizeText(prompt), out with
 *    ok/duration/pi_session_id/tokens-or-error, first-call-wins closer with a
 *    cancelled/abandoned finally backstop) + `pi_gate_denied`.
 *
 * Documented v1 gaps: `seedTranscriptEntries` is ignored (cross-engine
 * handoffs put the note in the prompt; the store already holds unified
 * history — same as the other non-opencode runners); reattach is null by
 * design; no turn wall-clock deadline (cancel works; the smoke harness caps
 * itself); no account rotation inside a turn (anthropic: the bridge owns
 * accounts; openai: a usage-limit terminal sidelines the picked codex
 * account but the turn never re-picks — one terminal error, then the
 * model-fallback walk takes over); pi/openai serves ChatGPT-subscription
 * ("home") codex accounts only — kind "api_key" is refused with a clear
 * error (pi's openai-codex provider is oauth-only; API-key billing stays on
 * opencode/openai); no fast-mode/priority-tier variants on pi (0.83.0 has no
 * serviceTier plumbing; supportsOpenaiFastMode already excludes pi ids) and
 * effort "none" approximates to the model default (pi has no "off"-below
 * ThinkingLevel for it); the guarded find/grep are near-parity, not
 * byte-identical, with pi's fd/rg built-ins (find uses a glob walk with
 * node_modules/.git ignores instead of fd's .gitignore semantics).
 */

import {
  mkdirSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  constants as fsConstants,
} from "fs";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "fs/promises";
import { basename, dirname, join, resolve, sep } from "path";
import type {
  AgentSession,
  AgentSessionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stateDir } from "./paths";
import { audit, summarizeText } from "./audit";
import { journalSet, journalClear, registerActiveRunProbe } from "./run-journal";
import { isClaudeUsageLimitError, isCodexUsageLimitError } from "./runner-shared";
import { ensureAnthropicBridge } from "./anthropic-bridge";
import { readOpencodeBridgeConfig } from "./opencode-config";
import { markCodexExhausted, type CodexAccount } from "./codex-accounts";
import {
  pickOpenaiAccount,
  buildSeededOpenaiAuth,
  maskOpenaiAccount,
  type SeededOpenaiAuth,
} from "./opencode-openai-auth";
import {
  INTERACTIVE_KINDS,
  isUnattendedKind,
  baseJournalKind,
  opencodeRunPolicy,
  readLocalInstructions,
} from "./opencode-runner";
import { buildRunInstructions } from "./run-instructions";
import { bashAskPolicyReply } from "./command-policy";
import {
  appendOpencodeTranscript,
  recordBksSessionFor,
  transcriptLineForEntry,
  transcriptLineRunnerNotice,
  transcriptLineCompactionSummary,
  transcriptLineUser,
  storeAppendUserLineEarly,
} from "./opencode-transcript";
import { transcriptStore } from "./transcript-store";
import { gitIdentityEnv } from "./shared/user-mappings";
import { githubAuthEnv, githubUserLoginForRun } from "./github-auth";
import { ensureAgentAwsCredsFile } from "./aws-creds";
import { isLocalProfile } from "./profile";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { piAnthropicTransport, piEngineEnabled } from "./pi-config";
import { buildPiAnthropicProvider } from "./pi-anthropic-provider";
import { createPiMcpBridge, type PiMcpBridge } from "./pi-mcp-bridge";
import type { TranscriptEntry } from "./types";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent, ImageInput, TurnUsage } from "./run-events";

const g = globalThis as any;

const PROVIDER = "pi" as const;
export const PI_MODEL_PREFIX = "pi/";

/** State root: server-owned agentDir, per-unified-session pi session dirs,
 *  and the smoke-turn scratch cwd. Never ~/.pi. */
export const PI_STATE_DIR = stateDir("pi");

/** Split `pi/<provider>/<model>` (model may itself contain slashes). */
export function parsePiModel(
  model: string
): { providerID: string; modelID: string } | null {
  if (!model.startsWith(PI_MODEL_PREFIX)) return null;
  const rest = model.slice(PI_MODEL_PREFIX.length);
  const sep = rest.indexOf("/");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { providerID: rest.slice(0, sep), modelID: rest.slice(sep + 1) };
}

// ── SDK loading ──────────────────────────────────────────────────────────────

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

/** The pi dep tree is large (~125 packages); Bun's first cold transpile of it
 *  can take >60s once per process. Keep the runtime import dynamic (so this
 *  module stays cheap to import) but cache the promise on globalThis and kick
 *  it in the background at boot when the engine is enabled. The cache is
 *  cleared on rejection so one transient cold-import failure (OOM during the
 *  first transpile, a deploy's bun-install window) doesn't brick the engine
 *  until restart — the next turn retries. Bun permanently caches module
 *  EVALUATION errors, so the retry rescues resolution/load-time failures,
 *  which are the transient class here. */
function loadPiSdk(): Promise<PiSdk> {
  return (g.__piSdkPromise ??= import("@earendil-works/pi-coding-agent").catch(
    (e: unknown) => {
      g.__piSdkPromise = undefined;
      throw e;
    }
  ));
}

if (process.env.NODE_ENV !== "test" && piEngineEnabled()) {
  void loadPiSdk().catch((e) =>
    console.warn("[pi-runner] pi SDK prewarm failed:", e)
  );
}

// ── Live-run registry ────────────────────────────────────────────────────────

interface PiRunHandle {
  abort: AbortController;
  /** Distinct-run identity: every alias key maps to the same handle object. */
  steer?: (text: string, images?: ImageInput[]) => void;
}

// Alias keys (runKey, unified session id, pi session id) → shared handle,
// parked on globalThis so hot reloads keep cancel/steer/isBusy working for
// in-flight turns — same pattern as the opencode runner's activeRuns.
const activeRuns: Map<string, PiRunHandle> = (g.__piActiveRuns ??= new Map());

registerActiveRunProbe((runKey) => activeRuns.has(runKey));

export function isPiSessionBusy(id: string): boolean {
  return activeRuns.has(id);
}

export function activePiRunCount(): number {
  return new Set(activeRuns.values()).size;
}

export function cancelPiRun(id: string): boolean {
  const handle = activeRuns.get(id);
  if (!handle) return false;
  handle.abort.abort();
  return true;
}

/** Native mid-turn steer: session.steer() queues the text for delivery after
 *  the current assistant step's in-flight tool calls, before the next LLM
 *  call. True = a live run accepted it; false = nothing steerable (caller
 *  queues for the next turn instead). */
export function steerPiRun(id: string, text: string, images?: ImageInput[]): boolean {
  const handle = activeRuns.get(id);
  if (!handle?.steer) return false;
  handle.steer(text, images);
  return true;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

// Armed only inside runPiSmokeTurn (a counter, so overlapping smoke calls
// can't disarm each other). The "pi-smoke" kind passes the gate only while
// armed — request/automation data can name the kind but never arm the bypass.
let smokeGateBypass = 0;

/** Non-null = the reason this run may not use the pi engine. Same deny-by-
 *  default semantics as opencodeGateReason: interactive + unattended journal
 *  kinds only, kind-less runs refused. */
export function piGateReason(opts: { journal?: { kind?: string } }): string | null {
  const base = baseJournalKind(opts.journal?.kind);
  if (base === "pi-smoke" && smokeGateBypass > 0) return null;
  if (INTERACTIVE_KINDS.has(base) || isUnattendedKind(base)) return null;
  return base
    ? `The pi engine is not available to "${base}" runs — interactive sessions and automations only.`
    : "The pi engine requires an explicit run kind (journal.kind) — " +
        "deny by default; interactive sessions and automations only.";
}

// ── Small helpers ────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Pi ImageContent from our wire shape. */
function piImages(images?: ImageInput[]): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  if (!images?.length) return undefined;
  return images.map((im) => ({ type: "image" as const, data: im.data, mimeType: im.mediaType }));
}

/** Flatten pi tool-result content to text + renderable image srcs. */
function contentToTextAndImages(content: unknown): { text: string; images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "image" && typeof b.data === "string") {
        images.push(`data:${String(b.mimeType || "image/png")};base64,${b.data}`);
      }
    }
  } else if (typeof content === "string") {
    texts.push(content);
  }
  return { text: texts.join("\n"), images };
}

/** Raw codex error codes that can surface in a pi/openai error before pi's
 *  friendly "You have hit your ChatGPT usage limit…" message is built — cheap
 *  insurance on top of isCodexUsageLimitError's message matching. Quota
 *  shapes are provider-spelled (insufficient_quota / "exceeded your current
 *  quota"), never a bare `quota` alternation: this classifier also sees
 *  non-provider throws in the catch, and infrastructure errors like
 *  "EDQUOT: disk quota exceeded" must not read as account exhaustion. The
 *  placeholder-refresh failure ("OAuth refresh failed for openai-codex")
 *  is included: pi refreshes only inside the final 5 minutes of the access
 *  token, so that failure means "this account can't serve until the codex
 *  CLI refreshes it" — dry-pool semantics. */
const CODEX_USAGE_LIMIT_CODE_SHAPES =
  /usage_limit_reached|usage_not_included|rate_limit_exceeded|insufficient_quota|usage_quota|exceeded your current quota|GoUsageLimitError|FreeUsageLimitError|OAuth refresh failed for openai-codex/i;

/** Provider-aware usage-limit classification for terminal errors — "this
 *  model's pool can't serve right now", which is exactly what
 *  usageLimitExhausted tells agent-runner's fallback walk. Anthropic runs see
 *  the loopback bridge's shapes: 429 (per-account hourly cap) and 529 (no
 *  usable designated account) plus the standard Claude limit messages. OpenAI
 *  runs match the codex classifier shared with the opencode engine
 *  (isCodexUsageLimitError) plus the raw code shapes above — never the
 *  bridge-only shapes (529/overload is transient there, not exhaustion).
 *  Exported for the classifier tests. */
export function isPiUsageLimitShape(message: string, providerID: string): boolean {
  if (providerID === "openai") {
    return (
      isCodexUsageLimitError(message) || CODEX_USAGE_LIMIT_CODE_SHAPES.test(message)
    );
  }
  if (isClaudeUsageLimitError(message, true)) return true;
  const s = message.toLowerCase();
  return (
    s.includes("overloaded_error") ||
    /\b529\b/.test(s) ||
    /\b429\b/.test(s) ||
    s.includes("no designated bridge account") ||
    // Pool-mode pickBridgeAccount: exhausted pool (not the empty-pool config
    // error, which deliberately says "no Claude accounts configured").
    s.includes("no usable claude account")
  );
}

/** First jsonl line of a pi session file (the v3 header), bounded read. */
function readSessionHeader(path: string): { type?: string; id?: string } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString("utf-8", 0, n).split("\n")[0];
    if (!firstLine) return null;
    return JSON.parse(firstLine);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Find the session jsonl whose header id matches — resume-by-piSessionId. */
function findPiSessionFile(sessionDir: string, piSessionId: string): string | null {
  try {
    const names = readdirSync(sessionDir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const name of names) {
      const path = join(sessionDir, name);
      const header = readSessionHeader(path);
      if (header?.type === "session" && header.id === piSessionId) return path;
    }
  } catch {}
  return null;
}

// ── Transcript integration (the claude-direct recipe) ────────────────────────

/** Store one batch of normalized entries under the pi session id. Requires
 *  recordBksSessionFor to have mapped pi→unified first (see runPi); system
 *  entries ride runner-notice lines. Best-effort — a transcript write must
 *  never take the run down. */
function persistEntries(
  engineSessionId: string | undefined,
  entries: TranscriptEntry[]
): void {
  if (!entries.length || !engineSessionId) return;
  try {
    const lines = entries
      .map((e) =>
        e.type === "system"
          ? transcriptLineRunnerNotice(e.content, e.id, e.timestamp)
          : transcriptLineForEntry(e)
      )
      .filter((l): l is Record<string, unknown> => !!l);
    appendOpencodeTranscript(engineSessionId, lines);
  } catch (e) {
    console.warn("[pi-runner] transcript persist failed:", e);
  }
}

// ── Guarded local tools (the containment invariant) ──────────────────────────
//
// Pi's built-in fs tools run in-process with no path containment and their
// rg/fd children inherit process.env (the server env). We never activate the
// built-ins; the model gets same-name customTools overrides instead: pi's own
// tool factories (createReadToolDefinition & co) wrapped with the guarded
// operations below — identical schema/description/truncation behavior, ours
// only where the filesystem or a subprocess is touched.

/** Directory roots no tool may touch even when a symlink or bind mount would
 *  bring them under the workspace realpath check. /proc/self/environ is the
 *  server-env exfiltration vector that motivated the guard. */
const BLOCKED_PATH_ROOTS = ["/proc", "/sys", "/dev"];

/**
 * Realpath-based workspace containment: resolve `rawPath`, symlink-resolve it
 * through its nearest EXISTING ancestor (so not-yet-created write targets are
 * checked too — a symlinked parent can't smuggle them out), and require the
 * result to sit under `realRoot`. Throws with a model-facing message on
 * escape. Returns the fully-resolved path it validated.
 */
export function assertContainedPiPath(rawPath: string, realRoot: string): string {
  const resolved = resolve(rawPath);
  let probe = resolved;
  const pendingSuffix: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = realpathSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        real = probe;
        break;
      }
      pendingSuffix.unshift(basename(probe));
      probe = parent;
    }
  }
  const full = pendingSuffix.length ? join(real, ...pendingSuffix) : real;
  for (const blocked of BLOCKED_PATH_ROOTS) {
    if (full === blocked || full.startsWith(blocked + sep)) {
      throw new Error(`Path is not accessible to this session: ${rawPath}`);
    }
  }
  if (full !== realRoot && !full.startsWith(realRoot + sep)) {
    throw new Error(
      `Path is outside the session workspace (${rawPath}). ` +
        "Local file tools are contained to the session's working directory."
    );
  }
  return full;
}

/** Magic-byte image sniff for the guarded read tool (pi's default detector is
 *  not importable standalone; same formats: png/jpeg/gif/webp/bmp). */
function sniffImageMime(path: string): string | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(16);
      const n = readSync(fd, buf, 0, 16, 0);
      if (n < 4) return undefined;
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return "image/png";
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
      if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
      if (
        n >= 12 &&
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WEBP"
      )
        return "image/webp";
      if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The guarded operations pi's read/ls/find/edit/write factories accept —
 * every path realpath-contained to `cwd` before any fs call. `find.glob`
 * replaces the factory's default fd SUBPROCESS entirely (pi only uses fd when
 * no custom glob is provided), walking with Bun.Glob in-process instead:
 * no child, no env, `followSymlinks: false` so a symlinked dir can't be
 * traversed out of. Exported for the containment unit tests.
 */
export function makeGuardedToolOps(cwd: string) {
  let realRoot: string;
  try {
    realRoot = realpathSync(cwd);
  } catch {
    realRoot = resolve(cwd);
  }
  const guard = (p: string) => assertContainedPiPath(p, realRoot);
  const exists = async (p: string) => {
    guard(p);
    try {
      await fsAccess(p, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  return {
    guard,
    read: {
      readFile: async (p: string) => {
        guard(p);
        return fsReadFile(p);
      },
      access: async (p: string) => {
        guard(p);
        await fsAccess(p, fsConstants.R_OK);
      },
      detectImageMimeType: async (p: string) => {
        guard(p);
        return sniffImageMime(p);
      },
    },
    ls: {
      exists,
      stat: async (p: string) => {
        guard(p);
        return fsStat(p);
      },
      readdir: async (p: string) => {
        guard(p);
        return fsReaddir(p);
      },
    },
    find: {
      exists,
      glob: async (
        pattern: string,
        searchPath: string,
        options: { ignore: string[]; limit: number }
      ): Promise<string[]> => {
        guard(searchPath);
        // fd (pi's default) matches bare patterns against basenames while
        // globbing relative paths — mirror that with a `**/` prefix.
        const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
        const limit = Math.max(1, options.limit || 1000);
        const ignore = (options.ignore || []).map((ig) => new Bun.Glob(ig));
        const out: string[] = [];
        const scanner = new Bun.Glob(effective);
        for await (const rel of scanner.scan({
          cwd: searchPath,
          dot: true,
          onlyFiles: false,
          followSymlinks: false,
        })) {
          if (ignore.some((ig) => ig.match(rel))) continue;
          out.push(join(searchPath, rel));
          if (out.length >= limit) break;
        }
        return out.sort();
      },
    },
    edit: {
      readFile: async (p: string) => {
        guard(p);
        return fsReadFile(p);
      },
      writeFile: async (p: string, content: string) => {
        guard(p);
        await fsWriteFile(p, content, "utf-8");
      },
      access: async (p: string) => {
        guard(p);
        await fsAccess(p, fsConstants.R_OK | fsConstants.W_OK);
      },
    },
    write: {
      writeFile: async (p: string, content: string) => {
        guard(p);
        await fsWriteFile(p, content, "utf-8");
      },
      mkdir: async (dir: string) => {
        guard(dir);
        await fsMkdir(dir, { recursive: true });
      },
    },
  };
}

const GREP_DEFAULT_LIMIT = 100;
const GREP_OUTPUT_CAP = 50 * 1024;

/**
 * Guarded grep execute: pi's grep factory hard-codes an rg spawn that
 * inherits process.env and takes an uncontained search path, so unlike the
 * other fs tools its execute is replaced wholesale (the tool keeps pi's
 * name/schema/description via the factory's definition). rg runs with the
 * run's minimal env, cwd-contained, match-capped, byte-capped. Exported for
 * the containment unit tests.
 */
export function makeGuardedGrepExecute(
  cwd: string,
  env: Record<string, string>,
  guard: (p: string) => string
) {
  return async function execute(
    _toolCallId: string,
    params: {
      pattern?: unknown;
      path?: unknown;
      glob?: unknown;
      ignoreCase?: unknown;
      literal?: unknown;
      context?: unknown;
      limit?: unknown;
    },
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
    const pattern = String(params?.pattern ?? "");
    if (!pattern) throw new Error("grep: pattern is required");
    if (signal?.aborted) throw new Error("Operation aborted");
    const rgPath = Bun.which("rg");
    if (!rgPath) throw new Error("ripgrep (rg) is not available on this host");
    const rawPath = typeof params?.path === "string" && params.path ? params.path : ".";
    const searchPath = resolve(cwd, rawPath);
    guard(searchPath);
    const st = await fsStat(searchPath).catch(() => null);
    if (!st) throw new Error(`Path not found: ${searchPath}`);
    const isDir = st.isDirectory();

    const args = ["--line-number", "--color=never", "--hidden", "--with-filename"];
    if (params?.ignoreCase) args.push("--ignore-case");
    if (params?.literal) args.push("--fixed-strings");
    if (typeof params?.glob === "string" && params.glob) args.push("--glob", params.glob);
    const ctxN = Number(params?.context);
    if (Number.isFinite(ctxN) && ctxN > 0) args.push("--context", String(Math.floor(ctxN)));
    const limit = Math.max(1, Number(params?.limit) || GREP_DEFAULT_LIMIT);
    // Directory searches run from the search root with "." so rg prints
    // workspace-relative paths (pi's output shape); file targets run from the
    // file's dir with its basename for the same reason.
    args.push("--", pattern, isDir ? "." : basename(searchPath));

    const proc = Bun.spawn([rgPath, ...args], {
      cwd: isDir ? searchPath : dirname(searchPath),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const onAbort = () => {
      try {
        proc.kill();
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let out = "";
    let stderr = "";
    let matches = 0;
    let matchLimitReached = false;
    try {
      const dec = new TextDecoder();
      // stderr drains concurrently: a stderr flood (permission errors on a
      // big tree) must not fill its pipe and block rg while stdout is open.
      const errDrain = (async () => {
        const errReader = proc.stderr.getReader();
        try {
          while (true) {
            const { done, value } = await errReader.read();
            if (done) break;
            if (value && stderr.length < 8_192) {
              stderr += dec.decode(value, { stream: true });
            }
          }
        } finally {
          errReader.releaseLock();
        }
      })();
      const reader = proc.stdout.getReader();
      try {
        let buffered = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, nl);
            buffered = buffered.slice(nl + 1);
            if (/^(.+?):(\d+):/.test(line)) {
              if (matches >= limit) continue;
              matches++;
              if (matches >= limit) matchLimitReached = true;
            } else if (matches >= limit) {
              continue;
            }
            out += `${line}\n`;
            if (matchLimitReached || out.length > GREP_OUTPUT_CAP * 2) {
              try {
                proc.kill();
              } catch {}
            }
          }
        }
        if (buffered && matches < limit) out += buffered;
      } finally {
        reader.releaseLock();
      }
      await errDrain;
      const code = await proc.exited;
      if (signal?.aborted) throw new Error("Operation aborted");
      if (code !== 0 && code !== 1 && !matchLimitReached && !matches) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    let text = out.trimEnd();
    if (!text) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
    if (text.length > GREP_OUTPUT_CAP) {
      text = `${text.slice(0, GREP_OUTPUT_CAP)}\n\n[Truncated: 50KB limit reached]`;
    }
    if (matchLimitReached) {
      text += `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`;
    }
    return { content: [{ type: "text", text }], details: undefined };
  };
}

// ── Custom bash tool (the env-hygiene invariant) ─────────────────────────────

const BASH_OUTPUT_CAP = 40_000;
const BASH_DEFAULT_TIMEOUT_S = 120;
const BASH_MAX_TIMEOUT_S = 600;

/** The custom `bash` tool: same name/schema surface as pi's built-in (so the
 *  model needs no new habits) but execution is ours — Bun.spawn with the
 *  MINIMAL env only, never the server process env. `gated` additionally
 *  screens every command through the org command policy (unattended code
 *  mode), throwing the policy message on a block. Completion is EXIT-gated,
 *  not drain-gated: a backgrounded grandchild inheriting the stdout pipe
 *  (`bun run dev &`) must never hold the tool — and with it the whole agent
 *  loop, prompt(), and cancel — open forever, so after exit the drains get a
 *  short grace and are then cancelled. The command runs in its own process
 *  group (setsid) so timeout/abort can kill the whole tree, not just bash.
 *  Exported for the wedge-regression tests. */
export function makePiBashTool(input: {
  cwd: string;
  env: Record<string, string>;
  gated: boolean;
  unattended: boolean;
  sessionId?: string;
  runKind?: string;
}): ToolDefinition<any, any, any> {
  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the session workspace. Output is merged stdout+stderr, " +
      `tail-truncated at ${BASH_OUTPUT_CAP} characters.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: {
          type: "number",
          description: `Timeout in seconds (default ${BASH_DEFAULT_TIMEOUT_S}, max ${BASH_MAX_TIMEOUT_S})`,
        },
      },
      required: ["command"],
    } as any,
    async execute(_toolCallId, params, signal, onUpdate) {
      const command = String((params as { command?: unknown })?.command ?? "");
      if (!command.trim()) throw new Error("Empty command");
      if (input.gated) {
        const reply = bashAskPolicyReply(
          { permission: "bash", metadata: { command } },
          {
            unattended: input.unattended,
            gated: true,
            sessionId: input.sessionId,
            runKind: input.runKind,
          }
        );
        if (reply !== "once") {
          throw new Error(
            "This command was blocked by the org command policy for unattended runs. " +
              "Propose the exact command in your note or summary and let a human run it."
          );
        }
      }
      const rawTimeout = Number((params as { timeout?: unknown })?.timeout);
      const timeoutS =
        Number.isFinite(rawTimeout) && rawTimeout > 0
          ? Math.min(rawTimeout, BASH_MAX_TIMEOUT_S)
          : BASH_DEFAULT_TIMEOUT_S;

      if (signal?.aborted) throw new Error("Command aborted");
      // setsid makes bash a process-group leader, so kill(-pid) reaches the
      // grandchildren a plain proc.kill() misses (bash may already be gone
      // when the timeout fires). Absent setsid (macOS), degrade to the
      // direct-child kill.
      const setsidPath = Bun.which("setsid");
      const proc = Bun.spawn(
        setsidPath
          ? [setsidPath, "/bin/bash", "-c", command]
          : ["/bin/bash", "-c", command],
        {
          cwd: input.cwd,
          env: input.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const killTree = () => {
        const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
          try {
            if (setsidPath) process.kill(-proc.pid, sig);
            else proc.kill(sig);
          } catch {}
        };
        killGroup("SIGTERM");
        // Escalate for SIGTERM-ignorers; unref'd so a dead group never holds
        // the process (or this tool's return) open.
        const escalate = setTimeout(() => killGroup("SIGKILL"), 1_500);
        (escalate as unknown as { unref?: () => void }).unref?.();
      };

      let out = "";
      let droppedChars = 0;
      let lastUpdate = 0;
      const emitPartial = () => {
        const now = Date.now();
        if (now - lastUpdate < 250) return;
        lastUpdate = now;
        onUpdate?.({ content: [{ type: "text", text: out }], details: {} });
      };
      const append = (chunk: string) => {
        out += chunk;
        if (out.length > BASH_OUTPUT_CAP) {
          droppedChars += out.length - BASH_OUTPUT_CAP;
          out = out.slice(out.length - BASH_OUTPUT_CAP);
        }
        emitPartial();
      };
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      const drain = async (stream: ReadableStream<Uint8Array> | null) => {
        if (!stream) return;
        const dec = new TextDecoder();
        const reader = stream.getReader();
        readers.push(reader);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) append(dec.decode(value, { stream: true }));
          }
        } catch {
          // reader.cancel() below lands here — captured output stands.
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      };

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutS * 1000);
      const onAbort = () => killTree();
      signal?.addEventListener("abort", onAbort, { once: true });

      let exitCode: number | null = null;
      try {
        // Exit-gated completion: the drains alone can outlive bash forever
        // when a backgrounded child inherited the pipes, so wait for exit
        // first, then give the drains a short grace to flush and cut them.
        const drains = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
        exitCode = await proc.exited;
        await Promise.race([drains, Bun.sleep(250)]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        for (const reader of readers) {
          // cancel() rejects (async) when the drain already released the
          // reader — swallow both the sync throw and the rejection.
          try {
            reader.cancel().catch(() => {});
          } catch {}
        }
      }

      const text =
        (droppedChars > 0
          ? `[output truncated: first ${droppedChars} characters dropped]\n`
          : "") + out;
      if (signal?.aborted) throw new Error("Command aborted");
      if (timedOut)
        throw new Error(`${text}\nCommand timed out after ${timeoutS}s`.trim());
      if (exitCode !== 0)
        throw new Error(`${text}\nCommand exited with code ${exitCode}`.trim());
      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: { exitCode, truncatedChars: droppedChars || undefined },
      };
    },
  };
}

// ── The turn ─────────────────────────────────────────────────────────────────

const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export async function* runPi(
  opts: RunAgentOpts,
  model: string
): AsyncGenerator<StreamEvent> {
  // Config gate first: the clearest refusal when the engine is off entirely.
  if (!piEngineEnabled()) {
    yield {
      type: "error",
      content:
        "pi engine is not enabled (~/.opensession-pi.json). Set {\"enabled\": true} there to turn it on.",
      provider: PROVIDER,
      model,
    };
    return;
  }
  const gateReason = piGateReason(opts);
  if (gateReason) {
    audit({
      msg: "pi_gate_denied",
      run_kind: opts.journal?.kind,
      session_id: opts.journal?.osSessionId,
      reason: gateReason,
    });
    yield { type: "error", content: gateReason, provider: PROVIDER, model };
    return;
  }
  const parsed = parsePiModel(model);
  if (!parsed) {
    yield {
      type: "error",
      content: `Not a pi model id: "${model}" (expected pi/<provider>/<model>)`,
      provider: PROVIDER,
      model,
    };
    return;
  }
  if (parsed.providerID !== "anthropic" && parsed.providerID !== "openai") {
    yield {
      type: "error",
      content:
        `The pi engine currently supports only pi/anthropic/* and pi/openai/* models ` +
        `(got "${model}"). Other pi providers are not wired to an account pool yet.`,
      provider: PROVIDER,
      model,
    };
    return;
  }

  const { prompt, cwd, mode, mcpServers, confirmTools, journal, user, author } = opts;
  const isAsk = mode === "ask";
  const isScratch = mode === "scratch";

  const runKey = opts.sessionId || journal?.osSessionId || crypto.randomUUID();
  if (activeRuns.has(runKey)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }
  const abort = new AbortController();
  const handle: PiRunHandle = { abort };
  const registeredKeys = new Set<string>([runKey]);
  if (journal?.osSessionId) registeredKeys.add(journal.osSessionId);
  for (const key of registeredKeys) activeRuns.set(key, handle);

  // The unified session id every transcript row keys on; kind-only loop runs
  // may pass transcriptSessionId instead (map-only, never journaled).
  const unifiedSessionId = journal?.osSessionId || opts.transcriptSessionId;

  const requestId = crypto.randomUUID();
  const started = Date.now();
  const auditBase = {
    msg: "pi_turn",
    request_id: requestId,
    run_key: runKey,
    session: journal?.osSessionId,
    run_kind: journal?.kind,
    resume: opts.sessionId,
    model,
    mode: mode || "code",
  };
  // First-call-wins run closer + finally backstop (the bridgeRunEnd pattern).
  let turnEnded = false;
  const endTurn = (fields: Record<string, unknown>) => {
    if (turnEnded) return;
    turnEnded = true;
    audit({ ...auditBase, direction: "out", duration_ms: Date.now() - started, ...fields });
  };

  let piSessionId: string | undefined;
  let reachedTerminal = false;
  let session: AgentSession | undefined;
  let mcpBridge: PiMcpBridge | undefined;
  let sawSettled = false;
  // pi/openai only: the picked codex account — visible to the catch/terminal
  // paths so a usage-limit end can sideline it (markCodexExhausted).
  let pickedOpenai: CodexAccount | undefined;

  // Everything from here on runs inside the try: a throw anywhere after the
  // registry writes above must still deregister in the finally, or the
  // session would report busy until the next restart.
  try {
    // Durability before the engine exists (the opencode two-stage): journal
    // the run with its original prompt — no engine id and NO serverKey, so a
    // death here re-runs from scratch and a restart mid-turn takes the
    // continuation re-prompt path (nothing in-process survives to reattach) —
    // and persist the user line under the unified id with a stable uuid.
    const userLine = transcriptLineUser(prompt, opts.promptEntryId, undefined, opts.images);
    if (journal?.osSessionId) {
      journalSet({
        runKey,
        osSessionId: journal.osSessionId,
        claudeSessionId: opts.sessionId || undefined,
        prompt,
        promptEntryId: String(userLine.uuid),
        cwd,
        mode,
        mcpServers,
        user,
        deniedTools: opts.deniedTools,
        confirmTools,
        aws: !!opts.aws,
        model,
        selectedModel: opts.selectedModel,
        transientFallback: opts.transientFallback,
        effort: opts.effort,
        fallbackModel: opts.fallbackModel,
        accountId: opts.accountId,
        accountStrict: opts.accountStrict,
        usageCredits: opts.usageCredits,
        kind: journal.kind,
        startedAt: new Date().toISOString(),
      });
      storeAppendUserLineEarly(journal.osSessionId, userLine, opts.sessionId);
    }

    const policy = opencodeRunPolicy({
      deniedTools: opts.deniedTools,
      confirmTools,
      journalKind: journal?.kind,
    });
    // Command-policy gate: kind-based like opencode (NOT policy.unattended) —
    // the trusted-human loops carry deniedTools but shouldn't trip the gate.
    const bashGated = isUnattendedKind(baseJournalKind(journal?.kind)) && !isAsk;
    const githubUserLogin =
      !isLocalProfile() &&
      !policy.unattended &&
      INTERACTIVE_KINDS.has(baseJournalKind(journal?.kind))
        ? githubUserLoginForRun(user || author?.name)
        : null;

    // pi/openai: pick the codex account + build the seeded credential BEFORE
    // the SDK import or any engine work — a dry/unconfigured pool must fail
    // cheap, and it must fail FLAGGED: pi has no host-auth fallthrough (the
    // deliberate ~/.pi isolation), so "no account can serve this model" is
    // always exhaustion-shaped, which is what the model-fallback walk keys on
    // (the catch below honors e.usageLimitExhausted). Same sessionKey
    // convention as opencode-runner (journal osSessionId || cwd), so HRW
    // session affinity and the per-(account, model) sideline are ONE shared
    // state across both engines.
    let seededOpenaiCredential: SeededOpenaiAuth["openai"] | undefined;
    let openaiPickReason: string | undefined;
    if (parsed.providerID === "openai") {
      const pickOut: { reason?: string } = {};
      // pi can only seed ChatGPT-subscription (kind: home) accounts — pi's
      // openai-codex provider is oauth-only, so API-key accounts have no
      // injection path. Rather than dead-ending a session whose HRW hash (or
      // designated-list order) ranks an api_key account first, re-pick with
      // that account excluded until a home account (or a real dry pool)
      // surfaces. An EXPLICIT api_key pin still errors: silently ignoring a
      // pin would mask a configuration mistake.
      const excludedApiKey = new Set<string>();
      let picked: ReturnType<typeof pickOpenaiAccount>;
      for (;;) {
        picked = pickOpenaiAccount(
          parsed.modelID,
          readOpencodeBridgeConfig()?.openaiAccounts,
          journal?.osSessionId || cwd,
          pickOut,
          user,
          opts.accountId,
          opts.accountStrict,
          excludedApiKey
        );
        if ("error" in picked || picked.kind !== "api_key") break;
        if (opts.accountId && picked.id === opts.accountId) {
          throw new Error(
            `pi/openai: pinned codex account "${picked.name}" is an API-key account, ` +
              "which the pi engine does not support — ChatGPT-subscription (kind: home) " +
              "accounts only. Use an opencode/openai/* model for API-key billing."
          );
        }
        excludedApiKey.add(picked.id);
      }
      if ("error" in picked) {
        if (excludedApiKey.size) {
          // The pool had accounts, but every eligible one was api_key: a
          // configuration boundary, NOT exhaustion — hopping models wouldn't
          // fix it, so no usageLimitExhausted.
          throw new Error(
            `pi/openai: only API-key codex accounts are currently eligible ` +
              `(${excludedApiKey.size} skipped), which the pi engine does not support — ` +
              "ChatGPT-subscription (kind: home) accounts only. Use an " +
              "opencode/openai/* model for API-key billing."
          );
        }
        const err = new Error(`pi/openai: ${picked.error}`) as Error & {
          usageLimitExhausted?: boolean;
        };
        err.usageLimitExhausted = true;
        throw err;
      }
      const built = buildSeededOpenaiAuth(picked);
      if ("error" in built) {
        // Expired/unreadable ChatGPT access token = the same condition as a
        // dry pool: this model has no account to run on right now
        // (opencode-runner's bind-failure parity).
        const err = new Error(`pi/openai: ${built.error}`) as Error & {
          usageLimitExhausted?: boolean;
        };
        err.usageLimitExhausted = true;
        throw err;
      }
      // pi's oauth layer refreshes whenever <5 minutes of validity remain —
      // and the refresh MUST fail (deliberate placeholder; CODEX_HOME owns
      // the rotating refresh family). A token entering that window is
      // therefore the same flagged condition as an expired one, just caught
      // before the turn burns work; without this, the failure surfaces as an
      // unflagged "OAuth refresh failed" and the fallback walk never engages
      // (the classifier catches the mid-turn variant of the same window).
      const msLeft = built.seeded.openai.expires - Date.now();
      if (msLeft <= 6 * 60_000) {
        const err = new Error(
          `pi/openai: codex account "${picked.name}" access token expires in ` +
            `${Math.max(1, Math.ceil(msLeft / 60_000))} min — inside pi's refresh window, ` +
            "which the placeholder refresh deliberately fails. Treated as a dry pool " +
            "until the codex CLI refreshes the token."
        ) as Error & { usageLimitExhausted?: boolean };
        err.usageLimitExhausted = true;
        throw err;
      }
      pickedOpenai = picked;
      seededOpenaiCredential = built.seeded.openai;
      openaiPickReason = pickOut.reason;
    }

    audit({
      ...auditBase,
      direction: "in",
      ...(pickedOpenai
        ? {
            account: maskOpenaiAccount(pickedOpenai),
            account_id: pickedOpenai.id.slice(0, 8),
            pick_reason: openaiPickReason,
          }
        : {}),
      ...(policy.unattended
        ? { denied_tools: policy.noteGroups.flatMap((grp) => grp.tools) }
        : {}),
      ...summarizeText(prompt),
    });

    const sdk = await loadPiSdk();

    // Full isolation from ~/.pi: in-memory credentials (structural
    // CredentialStore — pi-ai isn't a direct dep, so the tiny store is
    // inlined), no models.json, no network catalog refresh.
    const memCreds = new (class {
      private data = new Map<string, any>();
      async read(id: string) {
        return this.data.get(id);
      }
      async list() {
        return [...this.data.entries()].map(([providerId, c]) => ({
          providerId,
          type: c?.type,
        }));
      }
      async modify(id: string, fn: (c: any) => Promise<any>) {
        const next = await fn(this.data.get(id));
        if (next !== undefined) this.data.set(id, next);
        return this.data.get(id);
      }
      async delete(id: string) {
        this.data.delete(id);
      }
    })();
    // Seed the pi/openai oauth credential BEFORE the runtime consumes the
    // store. This is the whole injection: auth resolves per LLM request by
    // re-reading the stored credential, and the deliberately-invalid
    // placeholder refresh inside it means pi would attempt a refresh only in
    // the final 5 minutes of the ~10-day access token — failing LOUD instead
    // of rotating the refresh family CODEX_HOME owns. Never
    // setRuntimeApiKey("openai-codex", …): oauth-only provider, the api-key
    // override is ignored for auth and would mask the seeded credential.
    if (seededOpenaiCredential) {
      const cred = seededOpenaiCredential;
      await memCreds.modify("openai-codex", async () => cred);
    }
    const runtime = await sdk.ModelRuntime.create({
      credentials: memCreds,
      modelsPath: null,
    });
    let piModel: ReturnType<typeof runtime.getModel>;
    if (parsed.providerID === "openai") {
      // pi's builtin openai-codex provider already carries the right baseUrl
      // (chatgpt.com backend), API and catalog — our bare slugs match its
      // model ids exactly. No custom headers toward chatgpt.com: pi's own
      // defaults only (originator/UA are pi's — consistent with the
      // no-fingerprint-scrubbing policy).
      piModel = runtime.getModel("openai-codex", parsed.modelID);
      if (!piModel) {
        // Newer slug than the installed catalog — register a fallback entry
        // (zero cost: subscription-billed; the conservative codex-backend
        // window; the 5.6-family thinking map) rather than failing.
        // api/baseUrl inherit from the builtin catalog entry.
        runtime.registerProvider("openai-codex", {
          models: [
            {
              id: parsed.modelID,
              name: parsed.modelID,
              reasoning: true,
              thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            },
          ],
        });
        piModel = runtime.getModel("openai-codex", parsed.modelID);
      }
      if (!piModel) {
        throw new Error(
          `Unknown OpenAI model "${parsed.modelID}" (could not register it with pi)`
        );
      }
    } else if (piAnthropicTransport() === "inprocess") {
      // In-process native provider (the default): drives the Claude Agent
      // SDK directly inside this process — token-level streaming, no
      // loopback HTTP hop, no per-boot bridge key. Designated-account pick,
      // usage-limit sidelining, the rolling hourly cap and the
      // pi_anthropic_request audit discipline all live in
      // pi-anthropic-provider.ts; build throws the bridge's exact
      // designation error when no config designates accounts — surfaced
      // as-is by the catch below. The builtin catalog is read BEFORE
      // registration (registerNativeProvider replaces the builtin provider)
      // so ids/cost/contextWindow survive; an unknown model id gets the same
      // zero-cost fallback entry the bridge path minted.
      const provider = buildPiAnthropicProvider({
        unifiedSessionId: unifiedSessionId || runKey,
        user,
        accountId: opts.accountId,
        accountStrict: opts.accountStrict,
        usageCredits: opts.usageCredits,
        builtinModels: runtime.getModels("anthropic"),
        ensureModelId: parsed.modelID,
      });
      runtime.registerNativeProvider(provider);
      piModel = runtime.getModel("anthropic", parsed.modelID);
      if (!piModel) {
        throw new Error(`Unknown Anthropic model "${parsed.modelID}" (could not register it with pi)`);
      }
    } else {
      // Rollback transport (anthropicTransport: "bridge"): the loopback HTTP
      // bridge owns account selection and audits every request itself; we
      // only route to it legitimately. ensure* throws a clear config error
      // when the bridge is off — surfaced as-is by the catch below.
      const bridge = ensureAnthropicBridge();
      const sessionHeader = { "x-opencode-session": unifiedSessionId || runKey };
      runtime.registerProvider("anthropic", {
        baseUrl: bridge.url,
        headers: sessionHeader,
      });
      await runtime.setRuntimeApiKey("anthropic", bridge.key);
      piModel = runtime.getModel("anthropic", parsed.modelID);
      if (!piModel) {
        // Not in pi's built-in catalog — register a custom entry (zero cost:
        // subscription-billed through the bridge; the window/max are safe
        // Anthropic defaults) rather than failing on a newer model id.
        runtime.registerProvider("anthropic", {
          baseUrl: bridge.url,
          headers: sessionHeader,
          models: [
            {
              id: parsed.modelID,
              name: parsed.modelID,
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 32_000,
            },
          ],
        });
        piModel = runtime.getModel("anthropic", parsed.modelID);
      }
      if (!piModel) {
        throw new Error(`Unknown Anthropic model "${parsed.modelID}" (could not register it with pi)`);
      }
    }

    // Minimal bash env — the security invariant this engine hangs on. The
    // server env is NEVER inherited; every entry is explicit.
    const awsEnv =
      !isLocalProfile() && opts.aws ? await ensureAgentAwsCredsFile() : {};
    const bashEnv: Record<string, string> = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...gitIdentityEnv(author),
      ...(githubUserLogin ? githubAuthEnv(user || author?.name) : {}),
      ...awsEnv,
    };

    // MCP tools via the hand-rolled bridge; denied ids (policy.disables keys,
    // <server>_<tool> + the broad money-mover forms) are dropped before the
    // model ever sees them. Always closed in the finally.
    mcpBridge = await createPiMcpBridge({
      mcpServers,
      user,
      mcpGrantUser: opts.mcpGrantUser,
      deniedToolIds: new Set(Object.keys(policy.disables)),
      inProcessMcp: opts.inProcessMcp,
      onAudit: (e) =>
        audit({
          msg: "pi_mcp_call",
          request_id: requestId,
          session: journal?.osSessionId,
          server: e.server,
          tool: e.tool,
          ok: e.ok,
          ms: e.ms,
        }),
    });
    const mcpToolNames = mcpBridge.tools.map((t) => t.name);

    // Tool policy: ask mode is read-only (no bash/edit/write — conservative
    // v0); code/scratch get the read set + edit/write + the custom bash.
    // disableLocalWorkspaceTools (engine-outside-sandbox) strips all local
    // tools — pi has no sandbox mode, but fail closed if a caller passes it.
    const localTools = opts.disableLocalWorkspaceTools
      ? []
      : isAsk
        ? ["read", "grep", "find", "ls"]
        : ["read", "grep", "find", "ls", "edit", "write", "bash"];
    // Every local name in `tools` is shadowed by a guarded customTools entry
    // (same-name customs override built-ins in pi's registry), so the
    // in-process built-ins with server-env/unconstrained-path reach are never
    // activated. See the containment section above.
    const guardedOps = makeGuardedToolOps(cwd);
    const customTools: ToolDefinition<any, any, any>[] = [...mcpBridge.tools];
    for (const name of localTools) {
      switch (name) {
        case "read":
          customTools.push(
            sdk.createReadToolDefinition(cwd, {
              operations: guardedOps.read,
            }) as ToolDefinition<any, any, any>
          );
          break;
        case "grep": {
          const base = sdk.createGrepToolDefinition(cwd);
          customTools.push({
            ...base,
            execute: makeGuardedGrepExecute(cwd, bashEnv, guardedOps.guard),
          } as ToolDefinition<any, any, any>);
          break;
        }
        case "find":
          customTools.push(
            sdk.createFindToolDefinition(cwd, {
              operations: guardedOps.find,
            }) as ToolDefinition<any, any, any>
          );
          break;
        case "ls":
          customTools.push(
            sdk.createLsToolDefinition(cwd, {
              operations: guardedOps.ls,
            }) as ToolDefinition<any, any, any>
          );
          break;
        case "edit":
          customTools.push(
            sdk.createEditToolDefinition(cwd, {
              operations: guardedOps.edit,
            }) as ToolDefinition<any, any, any>
          );
          break;
        case "write":
          customTools.push(
            sdk.createWriteToolDefinition(cwd, {
              operations: guardedOps.write,
            }) as ToolDefinition<any, any, any>
          );
          break;
        case "bash":
          customTools.push(
            makePiBashTool({
              cwd,
              env: bashEnv,
              gated: bashGated,
              unattended: policy.unattended,
              sessionId: journal?.osSessionId,
              runKind: journal?.kind,
            })
          );
          break;
      }
    }

    const instructions = buildRunInstructions({
      isAsk,
      isScratch,
      reposNote: opts.reposNote,
      localInstructions: readLocalInstructions(cwd),
      inProcessMcp: opts.inProcessMcp,
      osSessionId: journal?.osSessionId,
      user,
      author,
      githubUserLogin,
      deniedToolNotes: policy.noteGroups,
      commandPolicyGated: bashGated,
    });

    const agentDir = `${PI_STATE_DIR}/agent`;
    const sessionDir = `${PI_STATE_DIR}/sessions/${sanitizeId(unifiedSessionId || runKey)}`;
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const settingsManager = sdk.SettingsManager.inMemory({});
    const workspaceRoot = resolve(cwd);
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      // Pi's context-file discovery walks every ancestor of cwd up to /
      // (plus the agentDir global) — an AGENTS.md dropped in /home/ubuntu
      // would silently join every pi system prompt on the box. Bound it to
      // the workspace: keep only cwd-level files (opencode parity).
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: agentsFiles.filter((f) => {
          const p = resolve(f.path);
          return p === workspaceRoot || p.startsWith(workspaceRoot + sep);
        }),
      }),
      systemPromptOverride: (base) =>
        base ? `${base}\n\n${instructions}` : instructions,
    });
    await loader.reload();

    // Resume: the journaled engine id is pi's session-header uuid — find its
    // jsonl in this unified session's dir. Not found (rotated dir, pruned
    // file) → fresh session; the store already holds the unified history and
    // cross-engine handoff notes ride the prompt (seedTranscriptEntries is
    // deliberately ignored, like the other non-opencode runners).
    const resumePath = opts.sessionId
      ? findPiSessionFile(sessionDir, opts.sessionId)
      : null;
    // Resume-miss bridge: pi's SessionManager buffers a session's jsonl until
    // its first ASSISTANT message, so a turn that died before any assistant
    // output (bridge 429 pre-token, instant cancel) journaled a piSessionId
    // that has NO file. Same engine ⇒ run-session builds no handoff note, and
    // a silently-fresh session would drop the model's context while the store
    // still shows the turns. Bridge it from the store ourselves.
    let resumeMissNote: string | null = null;
    if (opts.sessionId && !resumePath && unifiedSessionId) {
      try {
        const tail = transcriptStore()
          .readTail(unifiedSessionId, 200)
          // This turn's own prompt was already early-persisted — the model
          // gets it as the actual prompt, not as history.
          .entries.filter((e) => e.id !== String(userLine.uuid));
        if (tail.length) {
          resumeMissNote = buildEngineSwitchHandoffNote({
            fromModel: model,
            fromProvider: PROVIDER,
            toProvider: PROVIDER,
            sameEngineRestart: true,
            entries: tail,
            maxEntries: 200,
            maxChars: 60_000,
          });
        }
      } catch (e) {
        console.warn("[pi-runner] resume-miss handoff build failed:", e);
      }
    }
    const sessionManager = resumePath
      ? sdk.SessionManager.open(resumePath, sessionDir)
      : sdk.SessionManager.create(cwd, sessionDir);

    const thinkingLevel =
      opts.effort && THINKING_LEVELS.has(opts.effort)
        ? (opts.effort as "low" | "medium" | "high" | "xhigh" | "max")
        : undefined;

    const created = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: piModel,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      tools: [...localTools, ...mcpToolNames],
      customTools,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    piSessionId = session.sessionId;

    // Map pi→unified BEFORE any engine-keyed append (the W1 import-first gate
    // resolves through this map; unmapped appends are dropped + degraded).
    if (unifiedSessionId) recordBksSessionFor(piSessionId, unifiedSessionId);

    // Journal upgrade: the record now carries the engine id (still no
    // serverKey — boot must take the continuation re-prompt path).
    if (journal?.osSessionId) {
      journalSet({
        runKey,
        osSessionId: journal.osSessionId,
        claudeSessionId: piSessionId,
        prompt,
        promptEntryId: String(userLine.uuid),
        cwd,
        mode,
        mcpServers,
        user,
        deniedTools: opts.deniedTools,
        confirmTools,
        aws: !!opts.aws,
        model,
        selectedModel: opts.selectedModel,
        transientFallback: opts.transientFallback,
        effort: opts.effort,
        fallbackModel: opts.fallbackModel,
        accountId: opts.accountId,
        accountStrict: opts.accountStrict,
        usageCredits: opts.usageCredits,
        kind: journal.kind,
        startedAt: new Date().toISOString(),
      });
    }

    // Register the engine-id alias + the steer surface on the shared handle.
    if (!registeredKeys.has(piSessionId)) {
      registeredKeys.add(piSessionId);
      activeRuns.set(piSessionId, handle);
    }
    const liveSession = session;
    // Steer contract: accept = enqueue + receipt. The transcript user line is
    // written only when the queued message is actually DELIVERED (its user
    // message_end below) — session.steer() resolves at enqueue time, so a
    // .then() would confirm nothing, and an optimistically-persisted line
    // marks an undelivered steer as said (queue-state reconciles receipts
    // against transcript user texts, so it would never be requeued). An
    // undelivered steer keeps its run-session receipt as the recovery
    // affordance — opencode's failed-POST semantics.
    const pendingSteers: Array<{ text: string; images?: ImageInput[] }> = [];
    handle.steer = (text, images) => {
      pendingSteers.push({ text, images });
      void liveSession.steer(text, piImages(images)).catch((e) => {
        console.warn("[pi-runner] steer failed:", e);
      });
      audit({ ...auditBase, direction: "in", kind: "steer_queued", ...summarizeText(text) });
    };

    // Cancellation: our registry AbortController drives session.abort().
    const onAbort = () => {
      void liveSession.abort().catch(() => {});
    };
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", onAbort, { once: true });

    // ── Event pump: callback subscription → this generator's queue ──────────
    const queue: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (ev: StreamEvent) => {
      queue.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };

    push({ type: "init", sessionId: piSessionId, provider: PROVIDER, model });
    // Engine-keyed write of the turn's user line — same uuid as the early
    // store write, so the row upserts instead of duplicating the bubble.
    appendOpencodeTranscript(piSessionId, [userLine]);

    if (resumeMissNote) {
      const notice =
        "pi could not resume the previous engine session (it ended before any " +
        "assistant output was persisted) — continuing in a fresh one with the " +
        "recent transcript bridged into this turn's prompt.";
      push({ type: "runner_notice", text: notice });
      persistEntries(piSessionId, [
        { id: crypto.randomUUID(), type: "system", content: notice, timestamp: nowIso() },
      ]);
    }
    // What the ENGINE receives; journal/store keep the raw prompt.
    const promptForEngine = resumeMissNote
      ? `${resumeMissNote}\n\n${prompt}`
      : prompt;

    // Cumulative usage across the run (assistant messages incl. retries).
    const usageTotal: TurnUsage = {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 0,
    };
    let sawUsage = false;
    // Final assistant outcome (stopReason error/aborted → terminal error).
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;

    // Content persistence rides message_end/compaction_end. entry_appended is
    // deliberately unhandled: in 0.83.0 it fires ONLY for extension custom
    // entries (dist agent-session.js emits it solely from the extension
    // runtime's appendEntry helper) — never for messages or compactions — and
    // this runner disables extensions, so a handler would be dead code that
    // could double-persist against these paths if a future SDK widened it.
    const unsubscribe = session.subscribe((ev: AgentSessionEvent) => {
      try {
        switch (ev.type) {
          case "message_update": {
            const ame = (ev as any).assistantMessageEvent;
            if (ame?.type === "text_delta" && typeof ame.delta === "string") {
              push({ type: "text_chunk", text: ame.delta });
            }
            break;
          }
          case "tool_execution_start": {
            const t = ev as any;
            push({
              type: "tool_use",
              toolName: String(t.toolName || "tool"),
              toolInput: t.args ?? {},
              toolUseId: String(t.toolCallId),
            });
            break;
          }
          case "tool_execution_end": {
            const t = ev as any;
            const { text, images } = contentToTextAndImages(t.result?.content);
            // `content`, not `result`: stream consumers read event.content
            // (run-session's stream_tool_result). 500-char preview like
            // opencode — the full text reaches the store via the toolResult
            // message_end below and upserts over the streamed copy.
            push({
              type: "tool_result",
              toolUseId: String(t.toolCallId),
              content: text.length > 500 ? `${text.slice(0, 500)}...` : text,
              ...(images.length ? { images } : {}),
            });
            break;
          }
          case "message_end": {
            const msg = (ev as any).message;
            if (!msg) break;
            const ts = new Date(
              typeof msg.timestamp === "number" ? msg.timestamp : Date.now()
            ).toISOString();
            if (msg.role === "assistant") {
              lastStopReason = msg.stopReason;
              lastErrorMessage = msg.errorMessage;
              const u = msg.usage;
              if (u && typeof u.input === "number") {
                sawUsage = true;
                usageTotal.inputTokens += u.input || 0;
                usageTotal.outputTokens += u.output || 0;
                usageTotal.cacheReadTokens += u.cacheRead || 0;
                usageTotal.cacheCreationTokens += u.cacheWrite || 0;
                usageTotal.costUsd = (usageTotal.costUsd || 0) + (u.cost?.total || 0);
                usageTotal.contextTokens =
                  (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
                push({ type: "usage_snapshot", usage: { ...usageTotal } });
              }
              // Persist text + tool calls now (messages have no SDK id —
              // mint one per message; block ids are the model's, stable).
              // Error-stopped attempts are skipped: auto-retry replays them
              // and the terminal error carries the failure text — persisting
              // each attempt would stack duplicate partial bubbles. Aborted
              // partials DO persist (parity with pi's own jsonl).
              if (msg.stopReason !== "error") {
                const out: TranscriptEntry[] = [];
                const msgId = crypto.randomUUID();
                let textIdx = 0;
                for (const b of msg.content || []) {
                  if (!b || typeof b !== "object") continue;
                  if (b.type === "text" && b.text) {
                    out.push({
                      id: textIdx === 0 ? msgId : `${msgId}-b${textIdx}`,
                      type: "assistant",
                      content: b.text,
                      timestamp: ts,
                      model: parsed.modelID,
                    });
                    textIdx++;
                  } else if (b.type === "toolCall" && b.id) {
                    out.push({
                      id: String(b.id),
                      type: "tool_use",
                      content: "",
                      timestamp: ts,
                      toolName: String(b.name || "tool"),
                      toolInput: b.arguments ?? {},
                      toolUseId: String(b.id),
                    });
                  }
                }
                persistEntries(piSessionId, out);
              }
            } else if (msg.role === "toolResult" && msg.toolCallId) {
              const { text, images } = contentToTextAndImages(msg.content);
              persistEntries(piSessionId, [
                {
                  id: `${msg.toolCallId}-result`,
                  type: "tool_result",
                  content: text,
                  timestamp: ts,
                  toolUseId: String(msg.toolCallId),
                  ...(msg.isError ? { isError: true } : {}),
                  ...(images.length ? { images } : {}),
                },
              ]);
            } else if (msg.role === "user") {
              // A user message_end is the DELIVERY signal for a steer (the
              // agent loop emits message_start/end when it injects a queued
              // steering message; the turn's own prompt also lands here and
              // is skipped — it was persisted with its stable uuid up front).
              const { text, images } = contentToTextAndImages(msg.content);
              if (text && text !== promptForEngine && text !== prompt) {
                let idx = pendingSteers.findIndex((s) => s.text === text);
                // Skill/template expansion can rewrite a queued steer's text;
                // any user message that isn't the prompt is a delivery, so
                // fall back to the oldest pending steer but persist what was
                // actually delivered.
                if (idx === -1 && pendingSteers.length > 0) idx = 0;
                if (idx !== -1) {
                  const steer = pendingSteers.splice(idx, 1)[0];
                  audit({
                    ...auditBase,
                    direction: "in",
                    kind: "steer_injected",
                    ...summarizeText(text),
                  });
                  const srcs = images.length
                    ? images
                    : (steer.images || []).map(
                        (im) => `data:${im.mediaType};base64,${im.data}`
                      );
                  persistEntries(piSessionId, [
                    {
                      id: crypto.randomUUID(),
                      type: "user",
                      content: text,
                      timestamp: ts,
                      ...(srcs.length ? { images: srcs } : {}),
                    },
                  ]);
                }
              }
            }
            break;
          }
          case "compaction_end": {
            const ce = ev as any;
            if (!ce.aborted && ce.result?.summary) {
              try {
                appendOpencodeTranscript(piSessionId!, [
                  transcriptLineCompactionSummary(
                    String(ce.result.summary),
                    crypto.randomUUID(),
                    nowIso()
                  ),
                ]);
              } catch {}
              // The summarization LLM call is billed like any other — fold it
              // so usage_snapshot/done don't under-report on exactly the most
              // expensive turns. contextTokens is left alone: it tracks live
              // conversation context and the next assistant message_end
              // re-derives it post-compaction.
              const cu = ce.result.usage;
              if (cu && typeof cu.input === "number") {
                sawUsage = true;
                usageTotal.inputTokens += cu.input || 0;
                usageTotal.outputTokens += cu.output || 0;
                usageTotal.cacheReadTokens += cu.cacheRead || 0;
                usageTotal.cacheCreationTokens += cu.cacheWrite || 0;
                usageTotal.costUsd =
                  (usageTotal.costUsd || 0) + (cu.cost?.total || 0);
                push({ type: "usage_snapshot", usage: { ...usageTotal } });
              }
            }
            break;
          }
          case "auto_retry_start": {
            const r = ev as any;
            const errText = String(r.errorMessage || "");
            if (isPiUsageLimitShape(errText, parsed.providerID)) {
              // Usage-limit shapes mean the pool can't serve right now —
              // retrying only delays the fallback walk. abortRetry() cancels
              // the backoff sleep; the microtask matters: the SDK arms the
              // retry AbortController right AFTER emitting this event, so a
              // synchronous call would find nothing to abort.
              queueMicrotask(() => {
                try {
                  liveSession.abortRetry();
                } catch {}
              });
            } else {
              // Make the silent wait visible — pi retries transient provider
              // errors (3x, exponential from 2s) with no output in between.
              const notice = `pi auto-retry ${r.attempt}/${r.maxAttempts} in ${Math.round(
                (r.delayMs || 0) / 1000
              )}s — ${errText.slice(0, 300)}`;
              push({ type: "runner_notice", text: notice });
              persistEntries(piSessionId, [
                {
                  id: crypto.randomUUID(),
                  type: "system",
                  content: notice,
                  timestamp: nowIso(),
                },
              ]);
            }
            break;
          }
          case "agent_settled":
            sawSettled = true;
            break;
        }
      } catch (err) {
        console.warn("[pi-runner] event mapping failed:", err);
      }
    });

    // prompt() resolves after the full accepted run (steers + retries
    // included) — the authoritative end; pre-flight failures reject. A cancel
    // that landed before this point must not start the run at all —
    // session.abort() only stops a run already in flight.
    let promptOutcome: { ok: boolean; error?: unknown } | null = null;
    const settlePrompt = (outcome: { ok: boolean; error?: unknown }) => {
      promptOutcome = outcome;
      // Same tick as the outcome, BEFORE the pump wakes: steers accepted from
      // here on could only queue into a settling/soon-disposed session, so
      // steerPiRun must return false and let run-session queue them for the
      // next turn instead.
      handle.steer = undefined;
      const w = wake;
      wake = null;
      w?.();
    };
    if (abort.signal.aborted) {
      promptOutcome = { ok: true };
      handle.steer = undefined;
    } else {
      void session
        .prompt(promptForEngine, {
          images: piImages(opts.images),
          expandPromptTemplates: false,
        })
        .then(
          () => settlePrompt({ ok: true }),
          (e: unknown) => settlePrompt({ ok: false, error: e })
        );
    }

    // Tail-race drain budget: a steer accepted between the agent loop's final
    // steering poll and settlePrompt sits in the in-memory queue that
    // dispose() would discard — while steerPiRun already returned true and
    // run-session dropped the message from its own queue. Drive it through a
    // real continuation run (the same agent.continue() the SDK uses for
    // agent_end-queued messages; the constructor-lifetime event subscription
    // keeps streaming/persisting) instead of losing it.
    let steerDrains = 0;
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (promptOutcome) {
        if (
          promptOutcome.ok &&
          !abort.signal.aborted &&
          liveSession.pendingMessageCount > 0 &&
          steerDrains < 2
        ) {
          steerDrains++;
          promptOutcome = null;
          void Promise.resolve()
            .then(() => liveSession.agent.continue())
            .then(
              () => settlePrompt({ ok: true }),
              (e: unknown) => settlePrompt({ ok: false, error: e })
            );
          continue;
        }
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (queue.length) yield queue.shift()!;
    unsubscribe();
    if (pendingSteers.length > 0) {
      // Accepted but never delivered (drain budget exhausted or the run
      // failed): no transcript line was written, so on the failure paths the
      // receipt survives as the recovery affordance; on a done terminal the
      // loss is at least audited instead of silent.
      audit({
        ...auditBase,
        direction: "out",
        kind: "steer_undelivered",
        count: pendingSteers.length,
      });
    }

    // ── Terminal (at most one; user cancels end with none) ──────────────────
    const failed: { ok: boolean; error?: unknown } = promptOutcome!;
    if (abort.signal.aborted) {
      // User cancel ends QUIETLY — no terminal event, the generator just
      // returns (opencode-runner's MessageAbortedError exemption). A terminal
      // error here would take run-session's full failure path: a persisted
      // "Run failed" chip, lastRunError/Needs-input state, and a parent
      // notified its worker FAILED because a human pressed Stop. The finally
      // records the cancelled audit closer and clears the journal; the
      // already-fired session.abort() stopped the engine.
      reachedTerminal = true;
      return;
    }
    // Usage-limit terminal on a pi/openai run: sideline the picked codex
    // account BEFORE yielding, so the fallback walk's next hop (and every
    // other engine's pick) skips it — shared sideline state with opencode,
    // same per-(account, model) key.
    const sidelineOnUsageLimit = (usageLimit: boolean) => {
      if (usageLimit && pickedOpenai) {
        markCodexExhausted(pickedOpenai.id, parsed.modelID);
      }
    };
    let terminal: StreamEvent;
    if (!failed.ok) {
      const message = String((failed.error as Error)?.message || failed.error);
      const usageLimit = isPiUsageLimitShape(message, parsed.providerID);
      sidelineOnUsageLimit(usageLimit);
      terminal = {
        type: "error",
        content: `pi: ${message}`,
        provider: PROVIDER,
        model,
        ...(usageLimit ? { usageLimitExhausted: true } : {}),
      };
    } else if (lastStopReason === "error" || lastStopReason === "aborted") {
      const message = lastErrorMessage || `run ended with stopReason ${lastStopReason}`;
      const usageLimit = isPiUsageLimitShape(message, parsed.providerID);
      sidelineOnUsageLimit(usageLimit);
      terminal = {
        type: "error",
        content: `pi: ${message}`,
        provider: PROVIDER,
        model,
        ...(usageLimit ? { usageLimitExhausted: true } : {}),
      };
    } else {
      terminal = {
        type: "done",
        sessionId: piSessionId,
        result: session.getLastAssistantText() || undefined,
        provider: PROVIDER,
        model,
        ...(sawUsage ? { usage: { ...usageTotal } } : {}),
      };
    }
    reachedTerminal = true;
    endTurn({
      ok: terminal.type === "done",
      pi_session_id: piSessionId,
      saw_settled: sawSettled,
      ...(terminal.type === "done"
        ? {
            input_tokens: usageTotal.inputTokens,
            output_tokens: usageTotal.outputTokens,
            cache_read_input_tokens: usageTotal.cacheReadTokens,
            total_cost_usd: usageTotal.costUsd,
          }
        : { error: terminal.content }),
    });
    yield terminal;
  } catch (e: any) {
    if (abort.signal.aborted) {
      // A cancel that surfaced as a throw (abort mid-setup) is still a user
      // cancel — same quiet end as the terminal branch above.
      reachedTerminal = true;
      return;
    }
    const message: string = e?.message || String(e);
    // Honor the flag on pre-init throws (dry pool, expired seed): their
    // distinctive text never matches the classifier — opencode-runner's
    // catch parity.
    const usageLimit =
      e?.usageLimitExhausted === true ||
      isPiUsageLimitShape(message, parsed.providerID);
    // Sideline ONLY on provider-attributed exhaustion (the explicit flag).
    // A classifier match alone is not enough here: this catch also sees
    // non-provider throws from the run body (fs, journal, SDK init), and a
    // stray shape in one of those must not sideline a healthy account for
    // 60 min across both engines. The in-band terminal branches (provider
    // messages only) keep classifier-driven sidelines.
    if (e?.usageLimitExhausted === true && pickedOpenai) {
      markCodexExhausted(pickedOpenai.id, parsed.modelID);
    }
    reachedTerminal = true;
    endTurn({ ok: false, pi_session_id: piSessionId, error: message });
    yield {
      type: "error",
      content: `pi: ${message}`,
      provider: PROVIDER,
      model,
      ...(usageLimit ? { usageLimitExhausted: true } : {}),
    };
  } finally {
    endTurn({
      ok: false,
      pi_session_id: piSessionId,
      status: abort.signal.aborted ? "cancelled" : "abandoned",
    });
    // Consumer teardown without a terminal (hot-reload chaos, shutdown):
    // nothing survives a restart, so stop the orphaned in-process turn
    // instead of letting it burn tokens with no consumer.
    if (!reachedTerminal && session) {
      try {
        void session.abort();
      } catch {}
    }
    if (mcpBridge) {
      try {
        await mcpBridge.close();
      } catch {}
    }
    if (session) {
      try {
        session.dispose();
      } catch {}
    }
    for (const key of registeredKeys) {
      if (activeRuns.get(key) === handle) activeRuns.delete(key);
    }
    // Journal survives ONLY a mid-turn teardown (boot's continuation
    // re-prompt); a reached terminal or a user cancel clears it.
    if (journal?.osSessionId && (reachedTerminal || abort.signal.aborted)) {
      journalClear(runKey);
    }
  }
}

// ── Scripted smoke harness ───────────────────────────────────────────────────

/** Cheap + widest designated-account coverage on the bridge. */
const SMOKE_MODEL = "pi/anthropic/claude-sonnet-5";

export interface PiSmokeResult {
  /** True only for a real turn that reached `done` in time — or an explicit
   *  dryRun probe with the engine enabled. */
  ok: boolean;
  reason?: string;
  /** Throwaway unified session id (`os-test-pi-*`): never gets a session
   *  file, so it can't appear in the UI session list. */
  sessionId: string;
  text: string;
  usage?: TurnUsage;
  durationMs: number;
  enabled: boolean;
  dryRun: boolean;
  engineSessionId?: string;
  model: string;
  eventTypes: string[];
  error?: string;
  timedOut: boolean;
  /** transcript_events rows for the throwaway session after the turn — proves
   *  the store-write path end to end; 0 on dry runs. */
  storeRows: number;
}

/**
 * One tiny scripted turn against a throwaway `os-test-pi-*` session id
 * (mirrors runClaudeDirectSmokeTurn). Config-gated on piEngineEnabled() — with
 * the engine disabled this is a pure dry run: runPi yields its config-gate
 * error before touching the bridge or the SDK. The "pi-smoke" journal kind
 * passes the run gate only while the module-scoped bypass is armed here.
 * Never throws; real turns are wall-capped via cancelPiRun.
 */
export async function runPiSmokeTurn(
  opts: { dryRun?: boolean; timeoutMs?: number; prompt?: string; model?: string } = {}
): Promise<PiSmokeResult> {
  const prompt = opts.prompt || "Reply with exactly the single word: ok";
  const timeoutMs = Math.max(5_000, Math.min(opts.timeoutMs ?? 120_000, 600_000));
  // Optional model override so the smoke can exercise either provider path
  // (pi/anthropic via the bridge, pi/openai via the codex pool). A provided
  // id that doesn't parse is an explicit error, never a silent fallback —
  // an operator probing pi/openai must not read a default-model turn as
  // proof the openai path works.
  if (opts.model && !parsePiModel(opts.model)) {
    return {
      ok: false,
      enabled: piEngineEnabled(),
      dryRun: !!opts.dryRun,
      reason: `not a pi/<provider>/<model> id: ${opts.model}`,
      sessionId: "",
      model: opts.model,
      eventTypes: [],
      text: "",
      timedOut: false,
      durationMs: 0,
      storeRows: 0,
    };
  }
  const smokeModel = opts.model || SMOKE_MODEL;
  const enabled = piEngineEnabled();
  const sessionId = `os-test-pi-${Date.now().toString(36)}`;
  const started = Date.now();
  const storeRowsFor = (id: string): number => {
    try {
      return transcriptStore().getLastSeq(id);
    } catch {
      return 0;
    }
  };

  if (enabled && opts.dryRun) {
    return {
      ok: true,
      enabled,
      dryRun: true,
      reason:
        "dry run requested — engine is enabled but no turn was executed (no bridge, no SDK)",
      sessionId,
      model: smokeModel,
      eventTypes: [],
      text: "",
      timedOut: false,
      durationMs: Date.now() - started,
      storeRows: 0,
    };
  }

  const cwd = `${PI_STATE_DIR}/smoke`;
  if (enabled) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {}
  }
  const eventTypes: string[] = [];
  let text = "";
  let error: string | undefined;
  let usage: TurnUsage | undefined;
  let engineSessionId: string | undefined;
  let done = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancelPiRun(sessionId);
  }, timeoutMs);
  smokeGateBypass++;
  try {
    for await (const ev of runPi(
      {
        prompt,
        cwd,
        mode: "ask",
        mcpServers: [],
        journal: { osSessionId: sessionId, kind: "pi-smoke" },
      },
      smokeModel
    )) {
      eventTypes.push(ev.type);
      if (ev.type === "init") engineSessionId = ev.sessionId;
      if (ev.type === "text_chunk") text += ev.text || "";
      if (ev.type === "error") error = ev.content;
      if (ev.type === "done") {
        usage = ev.usage;
        done = true;
      }
    }
  } catch (e) {
    // runPi yields errors rather than throwing; belt-and-braces so the admin
    // route can never blow up off this path.
    error = String((e as Error)?.message || e);
  } finally {
    smokeGateBypass--;
    clearTimeout(timer);
  }
  return {
    ok: done && !timedOut && !error,
    enabled,
    dryRun: !enabled,
    reason: !enabled
      ? "pi engine is disabled (~/.opensession-pi.json missing or enabled:false) — the gate error below is the expected dry-run result; no bridge or SDK use happened"
      : timedOut
        ? `smoke turn exceeded the ${timeoutMs}ms wall cap and was cancelled`
        : undefined,
    sessionId,
    engineSessionId,
    model: smokeModel,
    eventTypes,
    text,
    error,
    usage,
    timedOut,
    durationMs: Date.now() - started,
    // Store rows prove the write path for REAL turns only; the disabled dry
    // path must not open the transcript store at all (a test/scratch process
    // would otherwise cold-open the live DB just to read a zero).
    storeRows: enabled ? storeRowsFor(sessionId) : 0,
  };
}
