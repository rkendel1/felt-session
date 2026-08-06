/**
 * Model registry: which models sessions can run on, and which agent backend
 * ("provider") serves each one. The session's `model` field is always stored
 * as the canonical id, never an alias.
 *
 * Single engine: EVERYTHING runs on the OpenCode engine (opencode-runner.ts) —
 * the legacy Claude/Codex SDK runners are deleted. The picker only surfaces
 * opencode ids (opencodePickerModels), interactiveDefaultModel maps the
 * default onto opencode, and nextFallbackModel / opencodeAutomationModel map
 * every fallback onto opencode too (toOpencodeModel). Native ids (claude-*,
 * gpt-*) stay RESOLVABLE (resolveModel prefix passthrough) for stored session
 * state, env vars and provider bookkeeping — agent-runner maps them onto
 * their opencode form at dispatch.
 *
 * Second engine (opt-in): explicit `pi/<provider>/<model>` ids run on the pi
 * runner (pi-runner.ts) instead — they resolve to provider "pi", never map
 * onto opencode (toOpencodeModel passes them through engine-prefix-intact;
 * only the retired-codex-slug reroute applies, staying pi-prefixed), and
 * surface in the picker only via ~/.opensession-pi.json
 * (refreshPiPickerModels). Nothing defaults to pi.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  opencodePickerModels,
  opencodeOrchestratorEnabled,
  bridgeEnabled,
  opencodeProviders,
  BRIDGE_PROVIDER_IDS,
} from "./opencode-config";
import { piPickerModels } from "./pi-config";
import { stateDir } from "./paths";
import { isLocalProfile, localProfileRoot } from "./profile";
import { discoverLocalEngineCredentials } from "./local-engine-auth";

export type Provider = "claude" | "codex" | "opencode" | "pi";

export interface ModelInfo {
  id: string;
  provider: Provider;
  label: string;
  aliases: string[];
  /** Picker section override ("dial" = The Dial, "orchestrator" = The
   *  Orchestrator presets); unset = grouped by the id's upstream provider
   *  segment. */
  group?: string;
  /** One-line picker subtitle (dial/orchestrator presets only today). */
  description?: string;
}

export const SESSION_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type SessionEffort = (typeof SESSION_EFFORTS)[number];

const OPENAI_EFFORTS: SessionEffort[] = ["none", "low", "medium", "high", "xhigh"];
const CLAUDE_EFFORTS: SessionEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** OpenCode variants exposed by the configured model. Keep this aligned with
 * `opencode models <provider> --verbose`; the selected value is sent verbatim
 * as the prompt's `variant`. */
export function modelEfforts(model: string): SessionEffort[] {
  // Pi ids expose the same variants as their opencode siblings: our effort
  // levels map 1:1 onto pi's ThinkingLevel (pi-runner.ts).
  const id = model.replace(/^(?:opencode|pi)\//, "");
  const slash = id.indexOf("/");
  const provider =
    slash === -1
      ? id.startsWith("claude-")
        ? "anthropic"
        : id.startsWith("gpt-")
          ? "openai"
          : ""
      : id.slice(0, slash);
  const slug = slash === -1 ? id : id.slice(slash + 1);

  if (provider === "openai" && /^gpt-5\./.test(slug)) return OPENAI_EFFORTS;
  if (provider === "anthropic") {
    if (slug.startsWith("claude-haiku-4-5")) return ["high", "max"];
    if (/^claude-(?:fable|opus|sonnet)-/.test(slug)) return CLAUDE_EFFORTS;
  }
  if (provider === "cerebras" && slug === "gpt-oss-120b") return ["low", "medium", "high"];
  if (provider === "meta" && slug === "muse-spark-1.1") return OPENAI_EFFORTS;
  return [];
}

/** Preserve a supported selection, otherwise prefer High (the UI default). */
export function normalizeModelEffort(
  model: string,
  effort?: string | null
): SessionEffort | undefined {
  const supported = modelEfforts(model);
  if (!supported.length) return undefined;
  const normalized = effort?.trim().toLowerCase() as SessionEffort | undefined;
  if (normalized && supported.includes(normalized)) return normalized;
  return supported.includes("high") ? "high" : supported[0];
}

export const KNOWN_MODELS: ModelInfo[] = [
  { id: "claude-fable-5", provider: "claude", label: "Claude Fable 5", aliases: ["fable"] },
  { id: "claude-opus-5", provider: "claude", label: "Claude Opus 5", aliases: ["opus", "opus5"] },
  // Kept resolvable for old sessions' labels/pricing, but the Meridian bridge
  // collapses every *opus* id to ONE canonical version (the
  // ANTHROPIC_DEFAULT_OPUS_MODEL pin in meridianAccountEnv, now Opus 5), so a
  // 4.8 selection is served as Opus 5 — it's out of the picker config for that
  // reason.
  { id: "claude-opus-4-8", provider: "claude", label: "Claude Opus 4.8", aliases: ["opus4.8"] },
  { id: "claude-sonnet-5", provider: "claude", label: "Claude Sonnet 5", aliases: ["sonnet", "sonnet5"] },
  { id: "claude-sonnet-4-6", provider: "claude", label: "Claude Sonnet 4.6", aliases: ["sonnet4.6"] },
  { id: "claude-haiku-4-5", provider: "claude", label: "Claude Haiku 4.5", aliases: ["haiku"] },
  { id: "codex-best-available", provider: "codex", label: "Best available (Codex)", aliases: ["best", "best-available", "best-codex"] },
  { id: "gpt-5.6-sol", provider: "codex", label: "GPT-5.6 Sol", aliases: ["sol", "gpt5.6", "codex", "gpt"] },
  { id: "gpt-5.6-terra", provider: "codex", label: "GPT-5.6 Terra", aliases: ["terra"] },
  { id: "gpt-5.6-luna", provider: "codex", label: "GPT-5.6 Luna", aliases: ["luna"] },
  // Retired (operator decision: drop 5.5/5.4 and spark) but
  // kept resolvable for old sessions' labels/pricing — toOpencodeModel
  // reroutes any dispatch of them to a 5.6 model (see RETIRED_CODEX_REROUTE
  // for why: 272k backend window − 128k output reservation leaves a 144k
  // input cap, which our ~125k fixed session payload turns into a
  // compact-every-turn loop).
  { id: "gpt-5.5", provider: "codex", label: "GPT-5.5 (Codex)", aliases: ["gpt5.5"] },
  { id: "gpt-5.4", provider: "codex", label: "GPT-5.4 (Codex)", aliases: ["gpt5.4"] },
  { id: "gpt-5.4-mini", provider: "codex", label: "GPT-5.4 mini (Codex)", aliases: ["mini"] },
  { id: "gpt-5.3-codex-spark", provider: "codex", label: "GPT-5.3 Codex Spark", aliases: ["spark"] },
];

/** Provider/model ids offered when the matching local CLI subscription exists. */
export const LOCAL_PROFILE_MODELS: ModelInfo[] = [
  { id: "anthropic/claude-sonnet-5", provider: "opencode", label: "Claude Sonnet 5", aliases: [] },
  { id: "anthropic/claude-opus-5", provider: "opencode", label: "Claude Opus 5", aliases: [] },
  { id: "anthropic/claude-haiku-4-5", provider: "opencode", label: "Claude Haiku 4.5", aliases: [] },
  { id: "openai/gpt-5.6-sol", provider: "opencode", label: "GPT-5.6 Sol", aliases: [] },
];

export function localProfileModels(): ModelInfo[] {
  const providers = new Set(discoverLocalEngineCredentials().providers);
  return LOCAL_PROFILE_MODELS.filter((model) =>
    providers.has(model.id.split("/")[0] as "anthropic" | "openai"),
  );
}

export function localProfileDefaultModel(): string {
  const models = localProfileModels();
  if (!models.length) {
    throw new Error(
      "No local model subscriptions found. Log into Claude Code with `claude` and/or Codex with `codex login`.",
    );
  }
  const envRequested = process.env.OPENSESSION_MODEL;
  const requested = envRequested || loadInteractiveOverride() || loadOverride();
  if (!requested) return models[0].id;
  const native = (toOpencodeModel(requested) || requested).replace(/^opencode\//, "");
  if (models.some((model) => model.id === native)) return native;
  if (envRequested) {
    throw new Error(
      `OPENSESSION_MODEL=${envRequested} is unavailable because its CLI subscription credentials were not found`,
    );
  }
  return models[0].id;
}

// ── The Dial ──────────────────────────────────────────────────────────────
//
// Amp-style task-difficulty presets (https://ampcode.com/news/the-dial): one
// picker choice bundles the MAIN model + reasoning effort with an ORACLE — a
// different frontier model wired in as a read-only opencode subagent the main
// agent consults for plan review, architecture calls and deep debugging. The
// session stores the preset id (`dial/<tier>`) as its `model`, so tier wiring
// can change over time without touching stored sessions; everything resolves
// to concrete models at dispatch (toOpencodeModel + the runner's dial hook).

export interface DialPreset {
  /** Stored as the session's model id, e.g. "dial/high". */
  id: string;
  label: string;
  /** One-line picker subtitle, Amp-style. */
  description: string;
  /** Native id of the MAIN agent model (resolved via toOpencodeModel). */
  model: string;
  /** Reasoning effort for the main model (overrides the session's effort). */
  effort: SessionEffort;
  /** Which DIAL_ORACLE_AGENTS entry backs this tier's oracle. */
  oracleAgent: string;
  /** Picker section this preset renders under (defaults to "dial"). Lets
   * one-off personal combos (group "custom") reuse the
   *  whole dial mechanism without joining the tier ladder. */
  group?: string;
}

/**
 * The oracle subagents, keyed by opencode agent name. Defined STATICALLY in
 * every engine server config (shared servers serve many sessions with
 * different presets, so the set can't vary per run — and a stable config keeps
 * the server hash stable). Only dial runs are told about them; other sessions
 * never get oracle instructions. `variant` rides the agent config through the
 * open index signature — honored where the engine supports per-agent variants,
 * harmlessly ignored otherwise.
 */
export const DIAL_ORACLE_AGENTS: Record<
  string,
  { model: string; variant: SessionEffort; label: string; description: string }
> = {
  "oracle-fable": {
    model: "anthropic/claude-fable-5",
    variant: "high",
    label: "Claude Fable 5",
    description:
      "Oracle: senior-engineer second opinion on Claude Fable 5 — plan review, " +
      "architecture decisions, deep debugging, reviewing significant work. Read-only advisor.",
  },
  "oracle-sol": {
    model: "openai/gpt-5.6-sol",
    variant: "xhigh",
    label: "GPT-5.6 Sol",
    description:
      "Oracle: senior-engineer second opinion on GPT-5.6 Sol at extra-high reasoning — " +
      "plan review, architecture decisions, deep debugging, reviewing significant work. " +
      "Read-only advisor.",
  },
  // Same-bridge substitutes: an engine server carries ONE bridge's auth, so a
  // cross-provider oracle (dial/ultra's sol-on-anthropic, dial/high's
  // fable-on-openai) has no model in that server's catalog — the task call
  // errored loudly or no-oped silently (Dreaming 2026-07-17). Each bridge gets
  // a distinct-model alternate so premium presets keep a REAL second opinion.
  "oracle-terra": {
    model: "openai/gpt-5.6-terra",
    variant: "high",
    label: "GPT-5.6 Terra",
    description:
      "Oracle: senior-engineer second opinion on GPT-5.6 Terra at high reasoning — " +
      "plan review, architecture decisions, deep debugging, reviewing significant work. " +
      "Read-only advisor.",
  },
  "oracle-opus": {
    model: "anthropic/claude-opus-5",
    variant: "high",
    label: "Claude Opus 5",
    description:
      "Oracle: senior-engineer second opinion on Claude Opus 5 — plan review, " +
      "architecture decisions, deep debugging, reviewing significant work. Read-only advisor.",
  },
};

/**
 * The oracle agent a dial run can ACTUALLY consult on its server: the preset's
 * oracle when its provider matches the server's bridge, else the same-bridge
 * substitute (openai → Terra, anthropic → Opus). Unknown/native providers keep
 * the preset's choice (status quo).
 */
export function sameBridgeDialOracle(oracleAgent: string, mainProviderID: string): string {
  const oracle = DIAL_ORACLE_AGENTS[oracleAgent];
  if (!oracle) return oracleAgent;
  const oracleProvider = oracle.model.split("/")[0];
  if (oracleProvider === mainProviderID) return oracleAgent;
  if (mainProviderID === "openai") return "oracle-terra";
  if (mainProviderID === "anthropic") return "oracle-opus";
  return oracleAgent;
}

export const DIAL_PRESETS: DialPreset[] = [
  {
    id: "dial/ultra",
    label: "Dial · Ultra",
    description: "The most capable combo for hard, open-ended tasks — Fable 5 high with a Sol-xhigh oracle",
    model: "claude-fable-5",
    effort: "high",
    oracleAgent: "oracle-sol",
  },
  {
    id: "dial/high",
    label: "Dial · High",
    description: "Deep reasoning for hard tasks — Sol at extra-high effort with a Fable 5-high oracle",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    oracleAgent: "oracle-fable",
  },
  {
    id: "dial/medium",
    label: "Dial · Medium",
    description: "Balanced depth and speed for everyday work — Sol-high with a Sol-xhigh oracle",
    model: "gpt-5.6-sol",
    effort: "high",
    oracleAgent: "oracle-sol",
  },
  {
    id: "dial/low",
    label: "Dial · Low",
    description: "Fast edits and small tasks — Luna-high with a Sol-xhigh oracle",
    model: "gpt-5.6-luna",
    effort: "high",
    oracleAgent: "oracle-sol",
  },
  {
    id: "dial/opus-fable",
    label: "Opus 5 + Fable oracle",
    description:
      "Custom combo — Opus 5 at extra-high effort with a Fable 5-high oracle",
    model: "claude-opus-5",
    effort: "xhigh",
    oracleAgent: "oracle-fable",
    group: "custom",
  },
];

/** The dial preset behind a model id, or undefined for non-dial ids. */
export function dialPreset(model?: string | null): DialPreset | undefined {
  const id = (model || "").trim().toLowerCase();
  if (!id.startsWith("dial/")) return undefined;
  return DIAL_PRESETS.find((p) => p.id === id);
}

// ── The Orchestrator ──────────────────────────────────────────────────────
//
// The Dial reversed (Cursor's agent-swarm economics: "few moments in a large
// task genuinely require frontier intelligence" — workers burn most tokens,
// so the cheap seats go to execution): a frontier MAIN model leads — plans,
// decides, reviews, integrates — and delegates well-scoped execution subtasks
// to cheaper WORKER models wired in as opencode subagents. Same mechanics as
// the dial throughout: the session stores `orchestrator/<name>` as its model,
// everything resolves at dispatch, and only orchestrator runs are told the
// workers exist. Opt-in via opencodeOrchestratorEnabled() — the presets stay
// out of the picker by default.

export interface OrchestratorPreset {
  /** Stored as the session's model id, e.g. "orchestrator/fable". */
  id: string;
  label: string;
  /** One-line picker subtitle. */
  description: string;
  /** Native id of the MAIN (orchestrator) model (resolved via toOpencodeModel). */
  model: string;
  /** Reasoning effort for the main model (overrides the session's effort). */
  effort: SessionEffort;
  /** ORCHESTRATOR_WORKER_AGENTS names this preset delegates to. */
  workerAgents: string[];
}

/**
 * The worker subagents, keyed by opencode agent name. Like the oracles they're
 * defined STATICALLY in every engine server config (stable agent set ⇒ stable
 * config hash ⇒ server reuse) and invisible in practice to non-orchestrator
 * runs — only orchestrator runs get the instructions block naming them.
 *
 * Worker NAMES are role-based, not model-based. Each name has a same-bridge
 * fallback, while configured third-party providers can supply a universal
 * backing: `worker-fast` prefers Cerebras GPT OSS when its key is available.
 * The orchestrator's prompts and task tool list stay identical either way.
 */
export const ORCHESTRATOR_WORKER_AGENTS: Record<
  string,
  {
    label: string;
    /** Task-tool description the main model sees — when to pick this worker. */
    description: string;
    /** Per-bridge backing model + effort variant. */
    bridges: Record<string, { model: string; variant: SessionEffort; label: string }>;
  }
> = {
  worker: {
    label: "Worker",
    description:
      "Worker: executes one well-scoped implementation subtask end to end — a function, " +
      "a module, a migration step, a test file. Give it a self-contained brief (exact " +
      "files, constraints, acceptance criteria); it sees the checkout but none of your " +
      "conversation. Not for design decisions or final review.",
    bridges: {
      anthropic: { model: "anthropic/claude-sonnet-5", variant: "medium", label: "Sonnet 5" },
      // Terra medium, not 5.5/5.4: the 272k-window codex models are retired
      // (see RETIRED_CODEX_REROUTE) — the cheap codex tiers are the 5.6
      // siblings Terra/Luna, never a smaller-window model.
      openai: { model: "openai/gpt-5.6-terra", variant: "medium", label: "Terra" },
    },
  },
  "worker-fast": {
    label: "Fast worker",
    description:
      "Fast worker: quick mechanical subtasks — renames, boilerplate, repetitive sweeps, " +
      "straightforward lookups. Cheapest and fastest; escalate anything needing judgment " +
      "to the standard worker or do it yourself.",
    bridges: {
      anthropic: { model: "anthropic/claude-haiku-4-5", variant: "high", label: "Haiku 4.5" },
      openai: { model: "openai/gpt-5.6-luna", variant: "low", label: "Luna low" },
      cerebras: { model: "cerebras/gpt-oss-120b", variant: "medium", label: "GPT OSS 120B" },
    },
  },
};

/** The backing (model/variant/label) a worker NAME resolves to. A configured
 *  Cerebras provider wins for worker-fast; otherwise workers stay on the main
 *  bridge, with unknown providers falling back to Anthropic. */
export function orchestratorWorkerForBridge(
  name: string,
  mainProviderID: string,
  availableProviderIDs = new Set(
    Object.entries(opencodeProviders())
      .filter(([, config]) => !!config.apiKey)
      .map(([id]) => id)
  )
): { model: string; variant: SessionEffort; label: string } | undefined {
  const w = ORCHESTRATOR_WORKER_AGENTS[name];
  if (!w) return undefined;
  if (name === "worker-fast" && availableProviderIDs.has("cerebras")) return w.bridges.cerebras;
  return w.bridges[mainProviderID] ?? w.bridges.anthropic;
}

export const ORCHESTRATOR_PRESETS: OrchestratorPreset[] = [
  {
    id: "orchestrator/fable",
    label: "Orchestrator · Fable 5",
    description: "Fable 5 high leads planning, review, and integration",
    model: "claude-fable-5",
    effort: "high",
    workerAgents: ["worker", "worker-fast"],
  },
  {
    id: "orchestrator/sol",
    label: "Orchestrator · Sol",
    description: "Sol xhigh leads planning, review, and integration",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    workerAgents: ["worker", "worker-fast"],
  },
];

function orchestratorPickerDescription(preset: OrchestratorPreset): string {
  const mainProviderID = preset.model.startsWith("claude-") ? "anthropic" : "openai";
  const workers = preset.workerAgents.flatMap((name) => {
    const backing = orchestratorWorkerForBridge(name, mainProviderID);
    if (!backing) return [];
    const role = name === "worker-fast" ? "fast worker" : "worker";
    return [`${role}: ${backing.label} ${backing.variant}`];
  });
  return `${preset.description}; delegates to ${workers.join(" and ")}`;
}

/** The orchestrator preset behind a model id, or undefined. */
export function orchestratorPreset(model?: string | null): OrchestratorPreset | undefined {
  const id = (model || "").trim().toLowerCase();
  if (!id.startsWith("orchestrator/")) return undefined;
  return ORCHESTRATOR_PRESETS.find((p) => p.id === id);
}

/** The preset (dial or orchestrator) behind a model id. Sessions store the
 *  preset id itself, so callers that persist runner-reported models must not
 *  overwrite it — gate on this, not dialPreset, so both preset families keep
 *  their wiring across turns. */
export function modelPreset(model?: string | null): DialPreset | OrchestratorPreset | undefined {
  return dialPreset(model) ?? orchestratorPreset(model);
}

/** "claude-opus-4-8" → "Opus 4.8", "gpt-5.4-mini" → "GPT-5.4 mini". Fallback
 * prettifier for model slugs with no native registry entry to borrow from. */
function prettifyModelSlug(slug: string): string {
  if (slug === "gpt-oss-120b") return "GPT OSS 120B";
  if (slug === "gemma-4-31b") return "Gemma 4 31B";
  if (slug === "zai-glm-4.7") return "Z.ai GLM 4.7";
  if (slug.startsWith("gpt-")) {
    const m = slug.slice(4).match(/^(\d+(?:[.-]\d+)*)(?:-(.+))?$/);
    if (m) return `GPT-${m[1].replace(/-/g, ".")}${m[2] ? ` ${m[2].replace(/-/g, " ")}` : ""}`;
    return `GPT-${slug.slice(4)}`;
  }
  const words: string[] = [];
  const nums: string[] = [];
  for (const part of slug.replace(/^claude-/, "").split("-")) {
    if (/^\d/.test(part)) nums.push(part);
    else if (part) words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return [words.join(" "), nums.join(".")].filter(Boolean).join(" ") || slug;
}

/**
 * Friendly label for an opencode/<provider>/<model> id: just the model name
 * ("Sonnet 5", "GPT-5.5") — the OpenCode engine is an implementation detail,
 * never part of the display name. Borrows the native registry's label when the
 * tail matches a known model id, so opencode entries read exactly like the
 * native ones always have.
 */
export function opencodeModelLabel(id: string): string {
  const tail = id.split("/").pop() || id;
  const native = KNOWN_MODELS.find((m) => m.provider !== "opencode" && m.id === tail);
  const base = native?.label || prettifyModelSlug(tail);
  return base.replace(/^Claude\s+/i, "").replace(/\s*\(Codex\)$/i, "");
}

/**
 * Friendly label for a pi/<provider>/<model> id. Unlike opencode (an
 * implementation detail hidden from names), the engine prefix is kept — "Pi ·
 * Claude Opus 5" — so a pi entry never reads as a duplicate of the
 * opencode-served model beside it in flat lists (/model output, Settings).
 */
export function piModelLabel(id: string): string {
  const tail = id.split("/").pop() || id;
  const native = KNOWN_MODELS.find(
    (m) => m.provider !== "opencode" && m.provider !== "pi" && m.id === tail
  );
  return `Pi · ${native?.label || prettifyModelSlug(tail)}`;
}

/** The models a session can actually select — the same live set the picker and
 *  GET /api/models expose (the opencode-provider entries, refreshed from
 *  opencode's picker; the full registry as a fallback when opencode isn't
 *  configured). Used to list choices dynamically instead of hardcoding names. */
export function selectableModels(): { id: string; label: string }[] {
  const opencodeOnly = KNOWN_MODELS.filter((m) => m.provider === "opencode");
  const list = opencodeOnly.length ? opencodeOnly : KNOWN_MODELS;
  return list.map((m) => ({ id: m.id, label: m.label }));
}

// OpenCode engine models are opt-in only: `pickerModels` from
// ~/.opensession-opencode.json (and only while `enabled` is true) surface in
// the UI picker; any other opencode/<provider>/<model> id still resolves via
// the prefix passthrough in resolveModel below, it's just not advertised.
// Folded in at module load; the model-providers settings routes call
// refreshOpencodePickerModels() after any pickerModels write so the picker
// updates without a reload.
export function refreshOpencodePickerModels(): void {
  for (let i = KNOWN_MODELS.length - 1; i >= 0; i--) {
    if (KNOWN_MODELS[i].provider === "opencode") KNOWN_MODELS.splice(i, 1);
  }
  try {
    // Third-party providers only surface once they have an API key (Settings →
    // Model providers) — a keyless entry would just produce auth errors.
    // anthropic/openai ride the subscription bridges, never raw keys.
    const keyed = new Set(
      Object.entries(opencodeProviders())
        .filter(([, p]) => !!p.apiKey)
        .map(([id]) => id)
    );
    const usable = (id: string) => {
      const provider = id.split("/")[1] || "";
      return BRIDGE_PROVIDER_IDS.has(provider) || keyed.has(provider);
    };
    for (const id of opencodePickerModels()) {
      if (!usable(id)) continue;
      KNOWN_MODELS.push({
        id,
        provider: "opencode",
        label: opencodeModelLabel(id),
        aliases: [],
      });
    }
    // Dial presets surface only when their MAIN model is in the live picker
    // set (an unusable oracle degrades to a failed subagent call, not a broken
    // session, so the oracle model isn't gated). Registered as opencode
    // entries so the single-engine picker filter carries them for free.
    const tails = new Set(
      KNOWN_MODELS.filter((m) => m.provider === "opencode").map(
        (m) => m.id.split("/").pop() || ""
      )
    );
    for (const p of DIAL_PRESETS) {
      if (!tails.has(p.model)) continue;
      KNOWN_MODELS.push({
        id: p.id,
        provider: "opencode",
        label: p.label,
        aliases: [],
        group: p.group ?? "dial",
        description: p.description,
      });
    }
    // The Orchestrator presets: same main-model gating as the dial (a broken
    // worker degrades to a failed subagent call, so workers aren't gated), but
    // additionally opt-in — off by default via opencodeOrchestratorEnabled().
    if (opencodeOrchestratorEnabled()) {
      for (const p of ORCHESTRATOR_PRESETS) {
        if (!tails.has(p.model)) continue;
        KNOWN_MODELS.push({
          id: p.id,
          provider: "opencode",
          label: p.label,
          aliases: [],
          group: "orchestrator",
          description: orchestratorPickerDescription(p),
        });
      }
    }
  } catch {}
}
refreshOpencodePickerModels();

// Pi engine models are the same opt-in shape: `pickerModels` from
// ~/.opensession-pi.json surface in the UI picker only while the engine is
// enabled (piPickerModels returns [] otherwise); any other well-formed
// pi/<provider>/<model> id still resolves via resolveModel's pi/ branch, it's
// just not advertised. Folded at module load and re-folded from GET
// /api/models, next to the opencode refresh.
export function refreshPiPickerModels(): void {
  for (let i = KNOWN_MODELS.length - 1; i >= 0; i--) {
    if (KNOWN_MODELS[i].provider === "pi") KNOWN_MODELS.splice(i, 1);
  }
  try {
    for (const id of piPickerModels()) {
      // Served providers only: pi/anthropic/* (the loopback Anthropic bridge)
      // and pi/openai/* (the ChatGPT-subscription codex pool). Anything else
      // would just error at run start, so it stays unadvertised.
      if (!id.startsWith("pi/anthropic/") && !id.startsWith("pi/openai/")) continue;
      KNOWN_MODELS.push({
        id,
        provider: "pi",
        label: piModelLabel(id),
        aliases: [],
      });
    }
  } catch {}
}
refreshPiPickerModels();

/** Per-provider defaults: claude-fable-5 for Anthropic, gpt-5.6-sol for OpenAI. */
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const BEST_AVAILABLE_CODEX_MODEL = "codex-best-available";

const CODEX_MODEL_ORDER = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

/**
 * Fallback ROUTING tiers (higher = smarter). NOT an absolute capability
 * ranking — it encodes the configured rotation policy: keep a run going on
 * an equal-or-smarter model automatically, but ASK a human before dropping to a
 * dumber one. "smart→smart / medium→smart = fine (auto); smart→dumb /
 * medium→dumb = ask." Concrete edges that policy yields: Fable→Sol auto,
 * Fable→Opus ask, Opus→Sol auto, Opus→Sonnet ask, Sol→Opus ask.
 *
 * Unlisted models default to tier 1 (treated as a downgrade from any premium
 * primary, so the human is asked — the safe default).
 */
const FALLBACK_TIER: Record<string, number> = {
  "claude-fable-5": 3,
  "gpt-5.6-sol": 3,
  "gpt-5.6-terra": 3,
  "gpt-5.6-luna": 3,
  "claude-opus-5": 2,
  "claude-opus-4-8": 2,
  "gpt-5.5": 2,
  "claude-sonnet-5": 1,
  "gpt-5.4": 1,
  "claude-sonnet-4-6": 1,
  "claude-haiku-4-5": 0,
  "gpt-5.4-mini": 0,
  "gpt-5.3-codex-spark": 0,
};

/**
 * Ordered fallback DESTINATIONS, most-desirable first. A run that exhausts its
 * model walks this list for the next usable one; the per-hop auto/ask mode then
 * comes from the tier comparison (nextFallbackModel).
 *
 * Fable is deliberately ABSENT — it's a fallback *source*, never a destination:
 * its weekly-scoped credit pool is the scarce thing we're usually falling *off*
 * of, so routing another exhausted model back into it would just re-hit the cap.
 */
const FALLBACK_DESTINATIONS = [
  "gpt-5.6-sol",
  // Terra/Luna: same-tier 5.6 siblings — a per-model Sol exhaustion keeps the
  // run on the codex pool automatically before crossing to Anthropic.
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // Opus 5 supersedes 4.8 as the Anthropic destination — the bridge serves one
  // canonical Opus per server (see KNOWN_MODELS note), so listing both would
  // just walk the same exhausted pool twice.
  "claude-opus-5",
  // gpt-5.5 / gpt-5.4 / gpt-5.4-mini / spark removed 2026-07-25: retired
  // 272k-window models (RETIRED_CODEX_REROUTE) — falling back onto them would
  // land every session in the compact-every-turn loop.
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/**
 * Persisted override for the global default model, set from the Connections UI
 * (PUT /api/models/default). Lets us switch what new sessions run on without a
 * code change or restart. Resolution order: this override → OPENSESSION_MODEL env
 * (MICHAEL_MODEL accepted as a deprecated alias) →
 * DEFAULT_CLAUDE_MODEL. Stored as { model: "<id>" | null } in this file.
 */
/** Stored as { model, interactiveModel? }: `model` is the GLOBAL default every
 *  consumer of getDefaultModel() sees (Slack/Linear/Plain loops, workflows);
 *  `interactiveModel` overrides what NEW interactive sessions (the composer's
 *  preselected row) start on, without touching those loops. Dial preset ids
 *  are valid here — interactiveDefaultModel returns them unresolved so the
 *  session stores `dial/<tier>` and keeps its oracle+effort. */
const defaultModelStore = () =>
  isLocalProfile()
    ? `${localProfileRoot()}/default-model.json`
    : stateDir("default-model.json");
const FALLBACK_AUTO_STORE = stateDir("model-fallback.json");
const CODEX_MODEL_EXHAUST_MS = 60 * 60 * 1000;
const codexModelExhaustedUntil = new Map<string, number>();

// undefined = not yet loaded from disk; null = no override set.
let overrideCache: string | null | undefined;
let interactiveOverrideCache: string | null | undefined;

function loadStoredDefault(field: "model" | "interactiveModel"): string | null {
  try {
    if (existsSync(defaultModelStore())) {
      const raw = JSON.parse(readFileSync(defaultModelStore(), "utf8"));
      const id = typeof raw?.[field] === "string" ? raw[field].trim() : "";
      return id && resolveModel(id) ? resolveModel(id)!.id : null;
    }
  } catch {}
  return null;
}

function loadOverride(): string | null {
  if (overrideCache === undefined) overrideCache = loadStoredDefault("model");
  return overrideCache;
}

function loadInteractiveOverride(): string | null {
  if (interactiveOverrideCache === undefined) {
    interactiveOverrideCache = loadStoredDefault("interactiveModel");
  }
  return interactiveOverrideCache;
}

/** Read-modify-write so the two default fields never clobber each other. */
function patchDefaultModelStore(patch: Record<string, string | null>): void {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(defaultModelStore())) {
      const parsed = JSON.parse(readFileSync(defaultModelStore(), "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
    }
  } catch {}
  writeJsonAtomic(defaultModelStore(), { ...raw, ...patch });
}

/**
 * Global default when a session has no model set: UI override → OPENSESSION_MODEL
 * env → DEFAULT_CLAUDE_MODEL. Read fresh per call so UI changes take effect on
 * the next run without a restart.
 */
export function getDefaultModel(): string {
  return loadOverride() || process.env.OPENSESSION_MODEL || DEFAULT_CLAUDE_MODEL;
}

/**
 * Persist the UI-selected default model (or clear it with null to fall back to
 * env/constant). Returns the resolved default after the change; throws on an
 * unknown model id.
 */
export function setDefaultModel(input: string | null): string {
  if (input === null || input.trim() === "") {
    overrideCache = null;
    try {
      patchDefaultModelStore({ model: null });
    } catch {}
    return getDefaultModel();
  }
  const m = resolveModel(input);
  if (!m) throw new Error(`Unknown model: ${input}`);
  overrideCache = m.id;
  patchDefaultModelStore({ model: m.id });
  return m.id;
}

/**
 * Persist the default for NEW interactive sessions only (the composer's
 * preselected model) — the global default above, and everything that reads it
 * (Slack/Linear/Plain loops, workflows), stays untouched. Accepts dial preset
 * ids ("dial/medium"); null clears back to the opencode-mapped global default.
 */
export function setInteractiveDefaultModel(input: string | null): string {
  if (input === null || input.trim() === "") {
    interactiveOverrideCache = null;
    try {
      patchDefaultModelStore({ interactiveModel: null });
    } catch {}
    return interactiveDefaultModel();
  }
  const m = resolveModel(input);
  if (!m) throw new Error(`Unknown model: ${input}`);
  interactiveOverrideCache = m.id;
  patchDefaultModelStore({ interactiveModel: m.id });
  return m.id;
}

/**
 * Global fallback model when a run dies on usage limits with every account in
 * its pool exhausted (e.g. the weekly-scoped Fable cap). Defaults to Opus —
 * strong and abundant, so an interactive session keeps working instead of
 * stalling on the limit notice. Override with OPENSESSION_FALLBACK_MODEL, or
 * set it to "none" to disable the automatic fallback entirely.
 */
export const DEFAULT_FALLBACK_MODEL: string | undefined = (() => {
  const v = (process.env.OPENSESSION_FALLBACK_MODEL || "").trim().toLowerCase();
  if (v === "none") return undefined;
  return v || "claude-opus-5";
})();

/**
 * Whether interactive sessions auto-switch when they have an explicit fallback
 * model. On (the default) = use that configured fallback; off ("manual") = stop
 * on the limit notice and let the human pick the next model. Persisted so the
 * choice survives a restart; read fresh per run so a UI toggle takes effect
 * without one.
 *
 * Stored as { auto: boolean } in FALLBACK_AUTO_STORE. This toggle only governs
 * interactive sessions; it does not create a fallback model by itself.
 */
let fallbackAutoCache: boolean | undefined;

export function getModelFallbackAuto(): boolean {
  if (fallbackAutoCache !== undefined) return fallbackAutoCache;
  try {
    if (existsSync(FALLBACK_AUTO_STORE)) {
      const raw = JSON.parse(readFileSync(FALLBACK_AUTO_STORE, "utf8"));
      fallbackAutoCache = raw?.auto !== false; // default on for anything but explicit false
    } else {
      fallbackAutoCache = true;
    }
  } catch {
    fallbackAutoCache = true;
  }
  return fallbackAutoCache;
}

export function setModelFallbackAuto(auto: boolean): boolean {
  fallbackAutoCache = auto;
  try {
    writeJsonAtomic(FALLBACK_AUTO_STORE, { auto });
  } catch {}
  return auto;
}

function isCodexModelExhausted(model: string): boolean {
  const until = codexModelExhaustedUntil.get(model);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    codexModelExhaustedUntil.delete(model);
    return false;
  }
  return true;
}

export function markCodexModelExhausted(model: string): void {
  const resolved = resolveModel(model);
  if (!resolved || resolved.provider !== "codex") return;
  if (resolved.id === BEST_AVAILABLE_CODEX_MODEL) return;
  const until = Date.now() + CODEX_MODEL_EXHAUST_MS;
  codexModelExhaustedUntil.set(resolved.id, until);
  console.warn(
    `[models] ${resolved.id} marked unavailable until ${new Date(until).toISOString()}`
  );
}

export function resolveConcreteModel(
  model?: string | null,
  exclude?: Set<string>
): string {
  const resolved = model ? resolveModel(model) : resolveModel(getDefaultModel());
  if (resolved?.id !== BEST_AVAILABLE_CODEX_MODEL) {
    return resolved?.id || getDefaultModel();
  }

  for (const id of CODEX_MODEL_ORDER) {
    if (exclude?.has(id)) continue;
    if (!isCodexModelExhausted(id)) return id;
  }
  for (const id of CODEX_MODEL_ORDER) {
    if (!exclude?.has(id)) return id;
  }
  return DEFAULT_CODEX_MODEL;
}

/**
 * Fallback model for an interactive session, or undefined when no fallback is
 * explicitly configured. This no longer invents a Claude → Codex fallback.
 */
export function interactiveFallbackModel(_primaryModel?: string): string | undefined {
  if (isLocalProfile()) return undefined;
  if (!getModelFallbackAuto()) return undefined;
  return DEFAULT_FALLBACK_MODEL;
}

/**
 * Map a native/legacy model id onto its OpenCode-engine equivalent so the
 * single-engine core (interactive picker + automations + the usage-limit
 * fallback chain) always dispatches through the opencode runner:
 *
 *   gpt-5.6-sol / codex-*    → opencode/openai/<model>   (ChatGPT-sub / codex accounts)
 *   claude-*                 → opencode/anthropic/<model> (meridian/native bridge)
 *   opencode/…               → unchanged
 *
 * Fail-safe (mirrors opencodeAutomationModel): the anthropic path is gated on
 * the bridge being enabled — with it off, claude ids stay native so a config
 * toggle degrades to the direct SDK runner instead of failing. The openai path
 * keys off codex accounts (not the bridge flag), so it always maps. This is
 * *model selection*, not execution: native ids still resolve (resolveModel) and
 * still run on the Claude/Codex SDK when the direct agent loops (Slack, Linear,
 * github, Plain) dispatch them — those loops are not migrated in this pass.
 */
/** Codex models retired (operator decision: drop 5.5/5.4 and spark — the
 *  cheap 5.6 models terra and luna replace them). Their
 *  real ChatGPT-backend window is 272k, and the backend reserves the 128k
 *  output ceiling out of it → a 144k input cap. Open Session sessions carry a
 *  ~125k fixed per-turn payload (MCP tool schemas + system prompt +
 *  instructions), which sits exactly on opencode's autocompact arm point
 *  (~124k) — so every turn trips a pointless compaction (bks-019f982d: 12
 *  compactions in 5 minutes). Any dispatch of these ids — old sessions,
 *  orchestrators delegating to "cheap" workers, aliases — is served by a
 *  372k-window 5.6 model instead (spark's fast/cheap role maps to Luna); the
 *  ids stay in KNOWN_MODELS for old sessions' labels/pricing. */
const RETIRED_CODEX_REROUTE: Record<string, string> = {
  "gpt-5.5": "gpt-5.6-sol",
  "gpt-5.4": "gpt-5.6-sol",
  "gpt-5.4-mini": "gpt-5.6-luna",
  "gpt-5.3-codex-spark": "gpt-5.6-luna",
};

export function toOpencodeModel(model?: string | null): string | undefined {
  const mapped = toOpencodeModelRaw(model);
  // The retired-slug reroute covers BOTH engines' openai ids — a
  // pi/openai/gpt-5.5 would otherwise run the 272k-window model on pi
  // (compact-heavy, the exact loop the retirement exists to prevent). The
  // engine prefix is preserved: pi ids stay pi, opencode ids stay opencode.
  const m = mapped?.match(/^(opencode|pi)\/openai\/(.+)$/);
  const reroute = m && RETIRED_CODEX_REROUTE[m[2]];
  return reroute ? `${m[1]}/openai/${reroute}` : mapped;
}

function toOpencodeModelRaw(model?: string | null): string | undefined {
  const m = (model || "").trim();
  if (!m) return model ?? undefined;
  if (m.startsWith("opencode/")) return m;
  // Pi engine ids never map onto opencode — the dispatcher routes pi/ models
  // to the pi runner; passing them through untouched keeps the shared
  // bookkeeping (accountProviderForModel, the fallback walk) working on them
  // instead of minting a bogus opencode/pi/… id below.
  if (m.startsWith("pi/")) return m;
  // Dial/orchestrator presets resolve to their MAIN model here; the preset id
  // itself stays on the session (and in opts.model) so the runner can wire the
  // oracle / workers.
  if (m.toLowerCase().startsWith("dial/")) {
    const p = dialPreset(m);
    return p ? toOpencodeModel(p.model) : undefined;
  }
  if (m.toLowerCase().startsWith("orchestrator/")) {
    const p = orchestratorPreset(m);
    return p ? toOpencodeModel(p.model) : undefined;
  }
  if (m === BEST_AVAILABLE_CODEX_MODEL || m.startsWith("codex-")) {
    return `opencode/openai/${DEFAULT_CODEX_MODEL}`;
  }
  if (m.startsWith("gpt-")) return `opencode/openai/${m}`;
  // Always map claude-* (no bridgeEnabled() fail-safe anymore): opencode is
  // the only engine, so with the bridge disabled an anthropic run should die
  // on the runner's clear "bridge disabled" error instead of silently
  // degrading — there is nothing left to degrade to.
  if (m.startsWith("claude-")) return `opencode/anthropic/${m}`;
  // A bare "<provider>/<model>" (e.g. "openai/gpt-5.6-sol") written without the
  // engine prefix → opencode passthrough. Mirrors resolveModel so an id maps the
  // same whichever seam sees it first, instead of degrading to the default.
  if (m.includes("/")) return `opencode/${m}`;
  return model ?? undefined;
}

export type AccountProvider = "claude" | "codex";

/** Account pool used by a model after resolving presets and legacy ids. */
export function accountProviderForModel(
  model?: string | null
): AccountProvider | undefined {
  const requested = model || interactiveDefaultModel();
  const resolved = toOpencodeModel(requested) || requested;
  // pi/anthropic/* draws from the same claude pool as opencode/anthropic —
  // the pi runner's loopback bridge picks from the designated claude accounts.
  const upstream = resolved.match(/^(?:opencode|pi)\/([^/]+)\//)?.[1];
  if (upstream === "anthropic" || resolved.startsWith("claude-")) return "claude";
  if (upstream === "openai" || resolved.startsWith("gpt-") || resolved.startsWith("codex-")) {
    return "codex";
  }
  return undefined;
}

/**
 * Default model for interactive Open Session sessions and the picker: the global
 * default mapped onto the opencode engine (so new interactive sessions and the
 * picker's "default" row run on opencode). getDefaultModel() itself is left
 * native — the direct agent loops (Slack/Linear/Plain) still read it and run it
 * on the SDK — so this is deliberately a separate, interactive-only default.
 */
export function interactiveDefaultModel(): string {
  if (isLocalProfile()) return `opencode/${localProfileDefaultModel()}`;
  const o = loadInteractiveOverride();
  // Preset ids (dial/orchestrator) return unresolved: the session must store
  // the preset id for the runner's hook (oracle/workers + effort) to engage —
  // toOpencodeModel would collapse the preset to its bare main model.
  if (o) return modelPreset(o) ? o : toOpencodeModel(o) || o;
  return toOpencodeModel(getDefaultModel()) || getDefaultModel();
}

/** Strip the engine prefix so a mapped id ("opencode/openai/gpt-5.6-sol",
 *  "pi/anthropic/claude-opus-5") resolves to its native key for tier lookup.
 *  Native ids pass through unchanged. */
function nativeModelId(id: string | undefined | null): string {
  return (id || "").replace(/^(?:opencode|pi)\/[^/]+\//, "");
}

/** Routing tier for a model id (native or opencode-mapped). Unlisted → 1. */
export function fallbackTier(id: string | undefined | null): number {
  const t = FALLBACK_TIER[nativeModelId(id)];
  return t === undefined ? 1 : t;
}

export type FallbackMode = "auto" | "ask";
export interface FallbackHop {
  /** opencode-mapped id to run next */
  id: string;
  /** "auto" = keep going silently (equal-or-smarter); "ask" = confirm with a
   *  human first (downgrade to a dumber model). */
  mode: FallbackMode;
}

/**
 * The next model to try after `currentModel` has run out (usage-exhausted on
 * every account, or hit an unrecoverable transient failure). Walks
 * FALLBACK_DESTINATIONS (plus an explicitly-configured `preferred` first),
 * skipping the current engine model and anything already exhausted this run,
 * and orders auto-eligible (equal-or-smarter) candidates ahead of downgrades so
 * we keep the strongest usable model. Returns null when nothing is left.
 *
 * `mode` is the tier comparison against the model we're LEAVING: equal-or-higher
 * tier ⇒ "auto" (Fable→Sol, Opus→Sol), lower ⇒ "ask" (Fable→Opus, Opus→Sonnet,
 * Sol→Opus). All ids in/out are opencode-mapped.
 */
export function nextFallbackModel(
  currentModel: string,
  exhausted: Set<string>,
  preferredFallbackModel?: string
): FallbackHop | null {
  const currentOc = toOpencodeModel(currentModel) || currentModel;
  const currentTier = fallbackTier(currentOc);

  const candidates: string[] = [];
  const add = (id: string | undefined | null) => {
    if (!id) return;
    if (id === BEST_AVAILABLE_CODEX_MODEL) {
      for (const c of CODEX_MODEL_ORDER) add(c);
      return;
    }
    const oc = toOpencodeModel(id);
    if (!oc || oc === currentOc || exhausted.has(oc) || candidates.includes(oc)) return;
    if (!resolveModel(oc)) return;
    candidates.push(oc);
  };
  if (preferredFallbackModel && preferredFallbackModel !== "none") add(preferredFallbackModel);
  for (const id of FALLBACK_DESTINATIONS) add(id);
  if (!candidates.length) return null;

  // Stable sort (candidates already in preference order): auto-eligible first,
  // then by descending tier — so we always reach for the strongest model we can
  // keep going on before offering a downgrade.
  candidates.sort((a, b) => {
    const aDown = fallbackTier(a) >= currentTier ? 0 : 1;
    const bDown = fallbackTier(b) >= currentTier ? 0 : 1;
    if (aDown !== bDown) return aDown - bDown;
    return fallbackTier(b) - fallbackTier(a);
  });

  const to = candidates[0];
  return { id: to, mode: fallbackTier(to) >= currentTier ? "auto" : "ask" };
}

/**
 * The full ordered fallback plan from a primary model — repeated
 * nextFallbackModel hops until the graph is dry. Exported for tests and any
 * caller that wants to preview the chain; the live runner uses nextFallbackModel
 * directly so a hop's mode is evaluated against the model actually being left.
 */
export function fallbackPlan(
  primaryModel: string | undefined,
  preferredFallbackModel: string | undefined
): FallbackHop[] {
  if (!preferredFallbackModel || preferredFallbackModel === "none") return [];
  const exhausted = new Set<string>();
  const out: FallbackHop[] = [];
  let current = toOpencodeModel(primaryModel || getDefaultModel()) || getDefaultModel();
  for (let i = 0; i < 32; i++) {
    const hop = nextFallbackModel(current, exhausted, preferredFallbackModel);
    if (!hop) break;
    out.push(hop);
    exhausted.add(hop.id);
    current = hop.id;
  }
  return out;
}

/**
 * Resolve user input (alias or id, any case) to a model. Unknown ids that
 * carry a clear provider prefix pass through so new models work without a
 * registry bump; anything else is rejected.
 */
export function resolveModel(input: string): ModelInfo | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  for (const m of KNOWN_MODELS) {
    if (m.id === s || m.aliases.includes(s)) return m;
  }
  if (s.startsWith("claude-")) return { id: s, provider: "claude", label: s, aliases: [] };
  if (s.startsWith("gpt-") || s.startsWith("codex-")) {
    return { id: s, provider: "codex", label: s, aliases: [] };
  }
  // Preset ids resolve even when not surfaced in the picker (bridge
  // reconfigured under a stored session; orchestrator toggled off) — but never
  // through the generic slash passthrough below, which would mint a bogus
  // opencode/dial/… or opencode/orchestrator/… id.
  if (s.startsWith("dial/")) {
    const p = dialPreset(s);
    return p
      ? { id: p.id, provider: "opencode", label: p.label, aliases: [], group: "dial", description: p.description }
      : null;
  }
  if (s.startsWith("orchestrator/")) {
    const p = orchestratorPreset(s);
    return p
      ? { id: p.id, provider: "opencode", label: p.label, aliases: [], group: "orchestrator", description: p.description }
      : null;
  }
  // OpenCode engine: explicit opencode/<provider>/<model> ids pass through —
  // the only way a session lands on the opencode runner (nothing defaults to it).
  if (s.startsWith("opencode/") && s.slice("opencode/".length).includes("/")) {
    return { id: s, provider: "opencode", label: s, aliases: [] };
  }
  // Pi engine: explicit pi/<provider>/<model> ids pass through — the only way
  // a session lands on the pi runner (nothing defaults to it). A truncated
  // "pi/foo" is rejected outright rather than falling into the generic slash
  // passthrough below, which would mint a bogus opencode/pi/… id.
  if (s.startsWith("pi/")) {
    return s.slice("pi/".length).includes("/")
      ? { id: s, provider: "pi", label: s, aliases: [] }
      : null;
  }
  // A bare "<provider>/<model>" (e.g. "openai/gpt-5.6-sol", "anthropic/claude-…")
  // is an opencode engine id written without the engine prefix — a shape a
  // workflow's agent({model}) override can easily use. Normalize it to the
  // opencode form so it resolves to the intended model instead of falling
  // through to null (which silently degrades callers to the default model).
  if (s.includes("/")) {
    const id = `opencode/${s}`;
    return { id, provider: "opencode", label: id, aliases: [] };
  }
  return null;
}

/** Provider for a session's stored model (undefined/unknown → claude). */
export function providerFor(model?: string | null): Provider {
  if (!model) return resolveModel(getDefaultModel())?.provider ?? "claude";
  return resolveModel(model)?.provider ?? "claude";
}

export function modelLabel(model?: string | null): string {
  const id = model || getDefaultModel();
  const known = KNOWN_MODELS.find((m) => m.id === id)?.label;
  if (known) return known;
  // Non-picker opencode/pi ids still deserve a friendly name, not a slashed slug.
  if (id.startsWith("opencode/")) return opencodeModelLabel(id);
  if (id.startsWith("pi/")) return piModelLabel(id);
  return id;
}

// ── Context windows (for live context reporting) ────────────────────────────
//
// USD cost is returned by the engine on each completed provider message. Keep
// only context ceilings here for the live context-fill gauge.

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  // Codex/GPT — approximate.
  "gpt-5.5": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex-spark": 400_000,
};

/** Preset ids (dial/orchestrator) price/gauge as their main model; everything
 *  else passes through. */
function pricingKey(model?: string | null): string {
  const id = resolveModel(model || "")?.id || model || "";
  return modelPreset(id)?.model || id;
}

/** Context-window token ceiling for a model (0 if unknown → gauge hidden). */
export function contextWindowFor(model?: string | null): number {
  const id = pricingKey(model || getDefaultModel());
  return CONTEXT_WINDOWS[id] ?? 0;
}

/** Human list for /model help output. */
export function formatModelList(current?: string | null): string {
  const cur = current || getDefaultModel();
  return KNOWN_MODELS.map((m) => {
    const marker = m.id === cur ? "→ " : "   ";
    const aliases = m.aliases.length ? ` (${m.aliases.join(", ")})` : "";
    return `${marker}${m.id}${aliases} — ${m.label}`;
  }).join("\n");
}
