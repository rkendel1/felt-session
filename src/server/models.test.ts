import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BEST_AVAILABLE_CODEX_MODEL,
  accountProviderForModel,
  DIAL_ORACLE_AGENTS,
  DIAL_PRESETS,
  dialPreset,
  sameBridgeDialOracle,
  ORCHESTRATOR_PRESETS,
  ORCHESTRATOR_WORKER_AGENTS,
  orchestratorPreset,
  orchestratorWorkerForBridge,
  modelPreset,
  fallbackPlan,
  fallbackTier,
  nextFallbackModel,
  markCodexModelExhausted,
  modelEfforts,
  interactiveDefaultModel,
  interactiveFallbackModel,
  KNOWN_MODELS,
  LOCAL_PROFILE_MODELS,
  localProfileDefaultModel,
  localProfileModels,
  normalizeModelEffort,
  opencodeModelLabel,
  piModelLabel,
  providerFor,
  refreshPiPickerModels,
  resolveConcreteModel,
  resolveModel,
  toOpencodeModel,
} from "./models";

const savedProfile = process.env.OPENSESSION_PROFILE;
const savedModel = process.env.OPENSESSION_MODEL;
const savedHome = process.env.HOME;
afterEach(() => {
  if (savedProfile === undefined) delete process.env.OPENSESSION_PROFILE;
  else process.env.OPENSESSION_PROFILE = savedProfile;
  if (savedModel === undefined) delete process.env.OPENSESSION_MODEL;
  else process.env.OPENSESSION_MODEL = savedModel;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe("opencodeModelLabel", () => {
  it("gives opencode ids first-class friendly names — never the engine", () => {
    expect(opencodeModelLabel("opencode/anthropic/claude-sonnet-5")).toBe("Sonnet 5");
    expect(opencodeModelLabel("opencode/anthropic/claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(opencodeModelLabel("opencode/anthropic/claude-opus-4-8")).toBe("Opus 4.8");
    expect(opencodeModelLabel("opencode/anthropic/claude-fable-5")).toBe("Fable 5");
    expect(opencodeModelLabel("opencode/openai/gpt-5.5")).toBe("GPT-5.5");
    expect(opencodeModelLabel("opencode/openai/gpt-5.4-mini")).toBe("GPT-5.4 mini");
  });

  it("prettifies slugs with no native registry entry to borrow from", () => {
    expect(opencodeModelLabel("opencode/anthropic/claude-sonnet-6")).toBe("Sonnet 6");
    expect(opencodeModelLabel("opencode/openai/gpt-6")).toBe("GPT-6");
  });
});

describe("model efforts", () => {
  it("exposes the variants supported by each configured model family", () => {
    expect(modelEfforts("opencode/openai/gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(modelEfforts("opencode/anthropic/claude-fable-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelEfforts("opencode/anthropic/claude-haiku-4-5")).toEqual([
      "high",
      "max",
    ]);
    expect(modelEfforts("opencode/meta/muse-spark-1.1")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(modelEfforts("opencode/xai/grok-4.5")).toEqual([]);
  });

  it("falls back to a supported effort when models change", () => {
    expect(normalizeModelEffort("opencode/anthropic/claude-haiku-4-5", "low")).toBe(
      "high"
    );
    expect(normalizeModelEffort("opencode/anthropic/claude-fable-5", "max")).toBe(
      "max"
    );
    expect(normalizeModelEffort("opencode/xai/grok-4.5", "high")).toBeUndefined();
  });
});

describe("toOpencodeModel", () => {
  it("maps openai/codex tiers onto the opencode engine unconditionally", () => {
    expect(toOpencodeModel("gpt-5.6-terra")).toBe("opencode/openai/gpt-5.6-terra");
    expect(toOpencodeModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("opencode/openai/gpt-5.6-sol");
  });
  it("reroutes retired 272k-window codex models to a 5.6 model in every id shape", () => {
    expect(toOpencodeModel("gpt-5.5")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("gpt-5.4")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("gpt-5.4-mini")).toBe("opencode/openai/gpt-5.6-luna");
    expect(toOpencodeModel("gpt-5.3-codex-spark")).toBe("opencode/openai/gpt-5.6-luna");
    expect(toOpencodeModel("openai/gpt-5.5")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("opencode/openai/gpt-5.5")).toBe("opencode/openai/gpt-5.6-sol");
  });
  it("passes opencode ids through untouched", () => {
    expect(toOpencodeModel("opencode/anthropic/claude-sonnet-5")).toBe(
      "opencode/anthropic/claude-sonnet-5"
    );
  });
  it("maps a bare provider/model path onto the opencode engine", () => {
    // A workflow agent({model}) override may write the provider path without the
    // engine prefix — it must reach the intended model, not degrade to default.
    expect(toOpencodeModel("openai/gpt-5.6-sol")).toBe(
      "opencode/openai/gpt-5.6-sol"
    );
    expect(resolveModel("openai/gpt-5.6-sol")?.id).toBe(
      "opencode/openai/gpt-5.6-sol"
    );
  });
  it("maps claude tiers onto the single opencode engine", () => {
    expect(toOpencodeModel("claude-fable-5")).toBe(
      "opencode/anthropic/claude-fable-5",
    );
  });
});

describe("pi engine model routing", () => {
  it("resolves explicit pi/<provider>/<model> ids to the pi provider", () => {
    const m = resolveModel("pi/anthropic/claude-opus-5");
    expect(m?.id).toBe("pi/anthropic/claude-opus-5");
    expect(m?.provider).toBe("pi");
    expect(resolveModel("PI/Anthropic/Claude-Opus-5")?.id).toBe(
      "pi/anthropic/claude-opus-5"
    );
    expect(providerFor("pi/anthropic/claude-opus-5")).toBe("pi");
  });

  it("rejects truncated pi ids instead of minting a bogus opencode passthrough", () => {
    expect(resolveModel("pi/anthropic")).toBeNull();
    expect(resolveModel("pi/")).toBeNull();
  });

  it("never maps pi ids onto the opencode engine", () => {
    expect(toOpencodeModel("pi/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5"
    );
  });

  it("draws pi/anthropic from the claude account pool (the bridge's pool)", () => {
    expect(accountProviderForModel("pi/anthropic/claude-opus-5")).toBe("claude");
  });

  it("exposes the anthropic effort variants on pi/anthropic ids", () => {
    expect(modelEfforts("pi/anthropic/claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelEfforts("pi/anthropic/claude-haiku-4-5")).toEqual(["high", "max"]);
    expect(normalizeModelEffort("pi/anthropic/claude-haiku-4-5", "low")).toBe("high");
  });

  it("labels pi ids with the engine kept visible", () => {
    expect(piModelLabel("pi/anthropic/claude-opus-5")).toBe("Pi · Claude Opus 5");
    expect(piModelLabel("pi/anthropic/claude-sonnet-6")).toBe("Pi · Sonnet 6");
  });

  it("tiers pi ids by their native model for the fallback walk", () => {
    expect(fallbackTier("pi/anthropic/claude-opus-5")).toBe(
      fallbackTier("claude-opus-5")
    );
  });

  it("resolves pi/openai ids to the pi provider on the codex pool with openai efforts", () => {
    const m = resolveModel("pi/openai/gpt-5.6-sol");
    expect(m?.id).toBe("pi/openai/gpt-5.6-sol");
    expect(m?.provider).toBe("pi");
    expect(providerFor("pi/openai/gpt-5.6-sol")).toBe("pi");
    // Account pinning draws from the codex (ChatGPT-subscription) pool, same
    // as opencode/openai.
    expect(accountProviderForModel("pi/openai/gpt-5.6-sol")).toBe("codex");
    expect(modelEfforts("pi/openai/gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(piModelLabel("pi/openai/gpt-5.6-sol")).toBe("Pi · GPT-5.6 Sol");
    expect(fallbackTier("pi/openai/gpt-5.6-sol")).toBe(fallbackTier("gpt-5.6-sol"));
  });

  it("reroutes retired codex slugs on pi ids too, preserving the engine prefix", () => {
    expect(toOpencodeModel("pi/openai/gpt-5.5")).toBe("pi/openai/gpt-5.6-sol");
    expect(toOpencodeModel("pi/openai/gpt-5.4")).toBe("pi/openai/gpt-5.6-sol");
    expect(toOpencodeModel("pi/openai/gpt-5.4-mini")).toBe("pi/openai/gpt-5.6-luna");
    expect(toOpencodeModel("pi/openai/gpt-5.3-codex-spark")).toBe(
      "pi/openai/gpt-5.6-luna"
    );
    // Non-retired and non-openai pi ids stay untouched.
    expect(toOpencodeModel("pi/openai/gpt-5.6-sol")).toBe("pi/openai/gpt-5.6-sol");
    expect(toOpencodeModel("pi/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5"
    );
  });

  it("surfaces pi/anthropic AND pi/openai picker models; other pi providers stay unadvertised", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-models-"));
    const cfg = join(dir, "pi.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        enabled: true,
        pickerModels: [
          "pi/anthropic/claude-opus-5",
          "pi/openai/gpt-5.6-sol",
          "pi/mistral/large",
        ],
      })
    );
    const prev = process.env.OPENSESSION_PI_CONFIG;
    process.env.OPENSESSION_PI_CONFIG = cfg;
    try {
      refreshPiPickerModels();
      const piIds = KNOWN_MODELS.filter((m) => m.provider === "pi").map((m) => m.id);
      expect(piIds).toContain("pi/anthropic/claude-opus-5");
      expect(piIds).toContain("pi/openai/gpt-5.6-sol");
      expect(piIds).not.toContain("pi/mistral/large");
    } finally {
      // Restore the real config and re-fold so KNOWN_MODELS reflects boot
      // state again for the rest of the process.
      if (prev === undefined) delete process.env.OPENSESSION_PI_CONFIG;
      else process.env.OPENSESSION_PI_CONFIG = prev;
      refreshPiPickerModels();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("accountProviderForModel", () => {
  it("resolves legacy, provider-path, and preset model ids to their account pool", () => {
    expect(accountProviderForModel("claude-fable-5")).toBe("claude");
    expect(accountProviderForModel("anthropic/claude-sonnet-5")).toBe("claude");
    expect(accountProviderForModel("gpt-5.6-sol")).toBe("codex");
    expect(accountProviderForModel("openai/gpt-5.5")).toBe("codex");
    expect(accountProviderForModel("dial/ultra")).toBe("claude");
    expect(accountProviderForModel("dial/high")).toBe("codex");
  });

  it("does not expose account pinning for unrelated providers", () => {
    expect(accountProviderForModel("opencode/xai/grok-4.5")).toBeUndefined();
  });
});

describe("local profile models", () => {
  it("offers only providers whose CLI credentials exist", () => {
    const home = mkdtempSync(join(tmpdir(), "local-models-"));
    mkdirSync(`${home}/.claude`, { recursive: true });
    writeFileSync(
      `${home}/.claude/.credentials.json`,
      JSON.stringify({
        claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh", expiresAt: Date.now() + 60_000 },
      }),
    );
    process.env.HOME = home;
    expect(LOCAL_PROFILE_MODELS.length).toBeGreaterThan(0);
    expect(localProfileModels().every((model) => model.id.startsWith("anthropic/"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("maps the local default straight through OpenCode and disables fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "local-models-"));
    mkdirSync(`${home}/.codex`, { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor((Date.now() + 60_000) / 1000) }),
    ).toString("base64url");
    writeFileSync(
      `${home}/.codex/auth.json`,
      JSON.stringify({ tokens: { access_token: `header.${payload}.signature` } }),
    );
    process.env.HOME = home;
    process.env.OPENSESSION_PROFILE = "local";
    process.env.OPENSESSION_MODEL = "openai/gpt-5.6-sol";
    expect(localProfileDefaultModel()).toBe("openai/gpt-5.6-sol");
    expect(interactiveDefaultModel()).toBe("opencode/openai/gpt-5.6-sol");
    expect(interactiveFallbackModel()).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects an explicit default whose CLI provider is unavailable", () => {
    const home = mkdtempSync(join(tmpdir(), "local-models-"));
    mkdirSync(`${home}/.claude`, { recursive: true });
    writeFileSync(`${home}/.claude/.credentials.json`, JSON.stringify({
      claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh", expiresAt: Date.now() + 60_000 },
    }));
    process.env.HOME = home;
    process.env.OPENSESSION_PROFILE = "local";
    process.env.OPENSESSION_MODEL = "openai/gpt-5.6-sol";
    expect(() => localProfileDefaultModel()).toThrow("CLI subscription credentials were not found");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("The Dial", () => {
  it("resolves preset ids without minting a bogus opencode/dial passthrough", () => {
    const high = resolveModel("dial/high");
    expect(high?.id).toBe("dial/high");
    expect(high?.provider).toBe("opencode");
    expect(high?.group).toBe("dial");
    expect(resolveModel("DIAL/HIGH")?.id).toBe("dial/high");
    expect(resolveModel("dial/nonsense")).toBeNull();
  });

  it("maps a dial id to its MAIN model at dispatch", () => {
    // dial/high's main model is Sol (openai) — maps regardless of bridge state.
    expect(toOpencodeModel("dial/high")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("dial/nonsense")).toBeUndefined();
  });

  it("bakes effort into the preset — no selectable efforts on dial ids", () => {
    expect(modelEfforts("dial/high")).toEqual([]);
    expect(normalizeModelEffort("dial/high", "low")).toBeUndefined();
  });

  it("looks up presets case-insensitively via dialPreset", () => {
    expect(dialPreset("dial/ultra")?.oracleAgent).toBe("oracle-sol");
    expect(dialPreset("dial/high")?.oracleAgent).toBe("oracle-fable");
    expect(dialPreset("opencode/openai/gpt-5.6-sol")).toBeUndefined();
    expect(dialPreset(undefined)).toBeUndefined();
  });

  it("wires each tier to its intended main and oracle model effort", () => {
    expect(
      DIAL_PRESETS.map(({ id, model, effort, oracleAgent }) => ({ id, model, effort, oracleAgent }))
    ).toEqual([
      {
        id: "dial/ultra",
        model: "claude-fable-5",
        effort: "high",
        oracleAgent: "oracle-sol",
      },
      {
        id: "dial/high",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        oracleAgent: "oracle-fable",
      },
      {
        id: "dial/medium",
        model: "gpt-5.6-sol",
        effort: "high",
        oracleAgent: "oracle-sol",
      },
      {
        id: "dial/low",
        model: "gpt-5.6-luna",
        effort: "high",
        oracleAgent: "oracle-sol",
      },
      {
        id: "dial/opus-fable",
        model: "claude-opus-5",
        effort: "xhigh",
        oracleAgent: "oracle-fable",
      },
    ]);
    expect(DIAL_ORACLE_AGENTS["oracle-sol"]?.variant).toBe("xhigh");
    expect(DIAL_ORACLE_AGENTS["oracle-fable"]?.variant).toBe("high");
  });

  it("defines every preset's oracle agent and a valid main model + effort", () => {
    for (const p of DIAL_PRESETS) {
      expect(DIAL_ORACLE_AGENTS[p.oracleAgent]).toBeDefined();
      // The preset's effort must be one its main model actually supports
      // (modelEfforts infers the provider from bare claude-*/gpt-* slugs).
      expect(modelEfforts(p.model)).toContain(p.effort);
      expect(resolveModel(p.model)).not.toBeNull();
    }
  });
});

describe("The Orchestrator", () => {
  it("resolves preset ids without minting a bogus opencode/orchestrator passthrough", () => {
    const fable = resolveModel("orchestrator/fable");
    expect(fable?.id).toBe("orchestrator/fable");
    expect(fable?.provider).toBe("opencode");
    expect(fable?.group).toBe("orchestrator");
    expect(resolveModel("ORCHESTRATOR/FABLE")?.id).toBe("orchestrator/fable");
    expect(resolveModel("orchestrator/nonsense")).toBeNull();
  });

  it("maps an orchestrator id to its MAIN model at dispatch", () => {
    expect(toOpencodeModel("orchestrator/sol")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("orchestrator/nonsense")).toBeUndefined();
  });

  it("bakes effort into the preset — no selectable efforts on orchestrator ids", () => {
    expect(modelEfforts("orchestrator/fable")).toEqual([]);
    expect(normalizeModelEffort("orchestrator/fable", "low")).toBeUndefined();
  });

  it("looks up presets case-insensitively and via the shared modelPreset guard", () => {
    expect(orchestratorPreset("orchestrator/fable")?.model).toBe("claude-fable-5");
    expect(orchestratorPreset("opencode/anthropic/claude-fable-5")).toBeUndefined();
    expect(orchestratorPreset(undefined)).toBeUndefined();
    expect(modelPreset("orchestrator/sol")?.id).toBe("orchestrator/sol");
    expect(modelPreset("dial/high")?.id).toBe("dial/high");
    expect(modelPreset("claude-fable-5")).toBeUndefined();
  });

  it("defines every preset's workers on both bridges with valid models + efforts", () => {
    for (const p of ORCHESTRATOR_PRESETS) {
      expect(modelEfforts(p.model)).toContain(p.effort);
      expect(resolveModel(p.model)).not.toBeNull();
      for (const name of p.workerAgents) {
        const w = ORCHESTRATOR_WORKER_AGENTS[name];
        expect(w).toBeDefined();
        // A server carries ONE bridge's auth: every worker NAME must resolve
        // on both subscription bridges, to a model that supports its variant.
        for (const bridge of ["anthropic", "openai"]) {
          const b = orchestratorWorkerForBridge(name, bridge, new Set());
          expect(b).toBeDefined();
          expect(b!.model.startsWith(`${bridge}/`)).toBe(true);
          expect(modelEfforts(b!.model)).toContain(b!.variant);
        }
      }
    }
    // Unknown/third-party bridges keep the oracle status quo: fall back to a
    // defined backing instead of undefined.
    expect(orchestratorWorkerForBridge("worker", "xai")).toBeDefined();
    expect(orchestratorWorkerForBridge("no-such-worker", "anthropic")).toBeUndefined();
  });

  it("keeps every worker strictly cheaper than its preset's main (tier or effort)", () => {
    // With the 272k codex models retired the openai bridge has no cheaper
    // model TIER — its cheap workers are the same-tier 5.6 siblings
    // (Terra/Luna) at a LOWER effort variant.
    const effortRank: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
    for (const p of ORCHESTRATOR_PRESETS) {
      // Workers resolve on the MAIN model's bridge in prod — that's the only
      // pairing the cheapness invariant is about.
      const mainProviderID = p.model.startsWith("claude-") ? "anthropic" : "openai";
      for (const name of p.workerAgents) {
        const b = orchestratorWorkerForBridge(name, mainProviderID)!;
        // fallbackTier keys off native slugs — strip the bridge prefix.
        const workerTier = fallbackTier(b.model.split("/").pop());
        const mainTier = fallbackTier(p.model);
        const cheaper =
          workerTier < mainTier ||
          (workerTier === mainTier && effortRank[b.variant] < effortRank[p.effort]);
        expect(cheaper).toBe(true);
      }
    }
  });
});

describe("fallback graph (nextFallbackModel)", () => {
  // Sol is openai → always maps regardless of the anthropic bridge flag; the
  // claude ids adapt to bridge state via toOpencodeModel so the assertions hold
  // whether the bridge is on or off.
  const sol = "opencode/openai/gpt-5.6-sol";
  const terra = "opencode/openai/gpt-5.6-terra";
  const luna = "opencode/openai/gpt-5.6-luna";
  const opus = toOpencodeModel("claude-opus-5")!;
  const fable = toOpencodeModel("claude-fable-5")!;
  const sonnet = toOpencodeModel("claude-sonnet-5")!;

  it("keeps equal-or-smarter switches automatic, downgrades ask (configured policy)", () => {
    // Fable → Sol: equal tier, automatic.
    expect(nextFallbackModel(fable, new Set([fable]), "claude-opus-5")).toEqual({
      id: sol,
      mode: "auto",
    });
    // Fable, Sol gone → Terra: same-tier 5.6 sibling, automatic.
    expect(
      nextFallbackModel(fable, new Set([fable, sol]), "claude-opus-5")
    ).toEqual({ id: terra, mode: "auto" });
    // Fable + all 5.6 siblings gone → Opus: downgrade, ASK.
    expect(
      nextFallbackModel(fable, new Set([fable, sol, terra, luna]), "claude-opus-5")
    ).toEqual({ id: opus, mode: "ask" });
    // Opus → Sol: upgrade-ish, automatic.
    expect(nextFallbackModel(opus, new Set([opus]), "claude-opus-5")).toEqual({
      id: sol,
      mode: "auto",
    });
    // Opus + every 5.6 gone → Sonnet next (5.5/5.4/spark are retired, no
    // longer destinations): downgrade, ASK.
    expect(
      nextFallbackModel(opus, new Set([opus, sol, terra, luna]), "claude-opus-5")
    ).toEqual({ id: sonnet, mode: "ask" });
    // Sol → Terra: same-tier sibling, automatic.
    expect(nextFallbackModel(sol, new Set([sol]), "claude-opus-5")).toEqual({
      id: terra,
      mode: "auto",
    });
    // Sol + siblings gone → Opus: downgrade, ASK.
    expect(
      nextFallbackModel(sol, new Set([sol, terra, luna]), "claude-opus-5")
    ).toEqual({ id: opus, mode: "ask" });
  });

  it("never routes back into Fable (scarce weekly-scoped credit pool)", () => {
    const plan = fallbackPlan("claude-opus-5", "claude-opus-5");
    expect(plan.map((h) => h.id)).not.toContain(fable);
  });

  it("returns no plan when no fallback is configured / disabled", () => {
    expect(fallbackPlan("claude-fable-5", undefined)).toEqual([]);
    expect(fallbackPlan("claude-fable-5", "none")).toEqual([]);
  });

  it("Fable's plan leads with the automatic Sol hop; the drop to Opus is ask-gated", () => {
    const plan = fallbackPlan("claude-fable-5", "claude-opus-5");
    expect(plan.length).toBeGreaterThan(0);
    // First hop off Fable is the equal-tier Sol, taken automatically.
    expect(plan[0]).toEqual({ id: sol, mode: "auto" });
    // Dropping down to Opus is a downgrade → always ask (each hop's mode is
    // re-evaluated against the model it leaves, so lateral moves lower in the
    // chain can be auto again — that's intended).
    expect(plan.find((h) => h.id === opus)?.mode).toBe("ask");
    // The single-engine fallback graph always emits OpenCode ids.
    for (const hop of plan) expect(hop.id.startsWith("opencode/")).toBe(true);
  });

  it("tiers Fable/Sol above Opus above Sonnet", () => {
    expect(fallbackTier("claude-fable-5")).toBeGreaterThan(fallbackTier("claude-opus-5"));
    expect(fallbackTier(sol)).toBeGreaterThan(fallbackTier("claude-opus-5"));
    expect(fallbackTier("claude-opus-5")).toBeGreaterThan(fallbackTier("claude-sonnet-5"));
  });
});

describe("sameBridgeDialOracle", () => {
  it("keeps same-bridge oracles and substitutes cross-bridge ones", () => {
    // dial/medium: sol main, sol oracle — same bridge, unchanged.
    expect(sameBridgeDialOracle("oracle-sol", "openai")).toBe("oracle-sol");
    // dial/high: sol main (openai server), fable oracle → Terra substitute.
    expect(sameBridgeDialOracle("oracle-fable", "openai")).toBe("oracle-terra");
    // dial/ultra: fable main (anthropic server), sol oracle → Opus substitute.
    expect(sameBridgeDialOracle("oracle-sol", "anthropic")).toBe("oracle-opus");
    // Fable oracle on an anthropic server stays.
    expect(sameBridgeDialOracle("oracle-fable", "anthropic")).toBe("oracle-fable");
    // Unknown provider or agent: status quo.
    expect(sameBridgeDialOracle("oracle-sol", "google")).toBe("oracle-sol");
    expect(sameBridgeDialOracle("nonexistent", "openai")).toBe("nonexistent");
  });
});

describe("alias table (pinned)", () => {
  // PINNED: what users get when they type these. A change here silently
  // redirects /model shortcuts and default-codex dispatch — deliberate only
  // (last deliberate change: codex/gpt → 5.6-sol).
  it("resolves the load-bearing aliases", () => {
    expect(resolveModel("codex")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("gpt")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("sol")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("best")?.id).toBe("codex-best-available");
    expect(resolveModel("opus")?.id).toBe("claude-opus-5");
    expect(resolveModel("opus4.8")?.id).toBe("claude-opus-4-8");
    expect(resolveModel("fable")?.id).toBe("claude-fable-5");
  });
});

describe("resolveConcreteModel", () => {
  it("resolves best available codex to the strongest usable codex model", () => {
    expect(resolveConcreteModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("gpt-5.6-sol");
  });

  it("skips codex models marked exhausted", () => {
    markCodexModelExhausted("gpt-5.6-sol");

    // 5.5/5.4/spark are retired — the step-downs are the 5.6 siblings.
    expect(resolveConcreteModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("gpt-5.6-terra");
  });
});
