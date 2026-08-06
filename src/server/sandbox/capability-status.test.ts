/**
 * Unit tests for the sandbox provider-status surface (GET /api/sandbox/status
 * serves sandboxCapabilityStatus() verbatim — the route itself is a one-liner,
 * so this IS the endpoint's behavior) and for resolveRequestedSandbox, the
 * create-path validator behind the per-session provider picker.
 *
 * Config is pointed at a scratch file via OPENSESSION_SANDBOX_CONFIG (read fresh
 * per call), saved/restored so the rest of the suite never sees it. The
 * kill-switch file lives under OPENSESSION_SESSIONS_DIR; expectations read the live
 * sandboxesEnabled() instead of assuming it, so a dev box with the switch on
 * still passes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RUNNABLE_SANDBOX_PROVIDERS,
  SANDBOX_MODEL_FAMILIES,
  resolveRequestedSandbox,
  sandboxConfig,
  sandboxEnginePlacement,
  sandboxCapabilityStatus,
  sandboxModelFamilyFor,
  sandboxModelSupport,
  sandboxProviderConfigured,
  sandboxesEnabled,
} from "./config";

let scratch: string;
let prevEnvConfig: string | undefined;
let prevDaytonaKey: string | undefined;
let prevE2bKey: string | undefined;
let prevModalTokenId: string | undefined;
let prevModalTokenSecret: string | undefined;
let prevModalConfigPath: string | undefined;
const cfgPath = () => join(scratch, "sandbox.json");

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bks-sandbox-status-"));
  prevEnvConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
  prevDaytonaKey = process.env.DAYTONA_API_KEY;
  prevE2bKey = process.env.E2B_API_KEY;
  prevModalTokenId = process.env.MODAL_TOKEN_ID;
  prevModalTokenSecret = process.env.MODAL_TOKEN_SECRET;
  prevModalConfigPath = process.env.MODAL_CONFIG_PATH;
  process.env.OPENSESSION_SANDBOX_CONFIG = cfgPath();
  delete process.env.DAYTONA_API_KEY;
  delete process.env.E2B_API_KEY;
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
  process.env.MODAL_CONFIG_PATH = join(scratch, "missing-modal.toml");
});

afterEach(() => {
  try {
    unlinkSync(cfgPath());
  } catch {}
});

afterAll(() => {
  if (prevEnvConfig === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = prevEnvConfig;
  if (prevDaytonaKey !== undefined) process.env.DAYTONA_API_KEY = prevDaytonaKey;
  if (prevE2bKey !== undefined) process.env.E2B_API_KEY = prevE2bKey;
  if (prevModalTokenId !== undefined) process.env.MODAL_TOKEN_ID = prevModalTokenId;
  else delete process.env.MODAL_TOKEN_ID;
  if (prevModalTokenSecret !== undefined) process.env.MODAL_TOKEN_SECRET = prevModalTokenSecret;
  else delete process.env.MODAL_TOKEN_SECRET;
  if (prevModalConfigPath !== undefined) process.env.MODAL_CONFIG_PATH = prevModalConfigPath;
  else delete process.env.MODAL_CONFIG_PATH;
  rmSync(scratch, { recursive: true, force: true });
});

const write = (cfg: object) => writeFileSync(cfgPath(), JSON.stringify(cfg));

describe("sandboxCapabilityStatus (the /api/sandbox/status payload)", () => {
  test("no config file: disabled, everything unconfigured, default local", () => {
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(false);
    expect(s.defaultProvider).toBe("local");
    expect(s.providers.map((p) => p.id)).toEqual([
      "docker",
      "daytona",
      "e2b",
      "box",
      "modal",
      "microvm",
      "lambda-microvm",
    ]);
    expect(s.providers.every((p) => !p.configured)).toBe(true);
    expect(s.killSwitch).toBe(!sandboxesEnabled());
  });

  test("docker-only config: docker configured, remotes not", () => {
    write({ provider: "docker", image: "opensession-runner:latest" });
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(true);
    expect(s.defaultProvider).toBe("docker");
    expect(s.providers.find((p) => p.id === "docker")?.configured).toBe(true);
    expect(s.providers.find((p) => p.id === "daytona")?.configured).toBe(false);
    expect(s.providers.find((p) => p.id === "daytona")?.note).toBeUndefined();
    expect(s.providers.find((p) => p.id === "e2b")?.configured).toBe(false);
  });

  test("remote provider without a dial-back URL carries a pointed note", () => {
    write({ provider: "docker", daytona: { apiKey: "dtn_x" }, e2b: { apiKey: "e2b_x" } });
    const s = sandboxCapabilityStatus();
    const d = s.providers.find((p) => p.id === "daytona")!;
    expect(d.configured).toBe(true);
    expect(d.note).toContain("no dial-back URL configured");
    const e = s.providers.find((p) => p.id === "e2b")!;
    expect(e.configured).toBe(true);
    expect(e.note).toContain("no dial-back URL configured");
  });

  test("healthy remote provider (public ingress configured) carries no note", () => {
    write({
      provider: "docker",
      daytona: { apiKey: "dtn_x" },
      publicIngress: { enabled: true, port: 3860, publicBaseUrl: "wss://example.ts.net" },
    });
    const d = sandboxCapabilityStatus().providers.find((p) => p.id === "daytona")!;
    expect(d.configured).toBe(true);
    expect(d.note).toBeUndefined();
  });

  test("modal requires both token credentials", () => {
    write({ provider: "modal", modal: { tokenId: "ak-one-sided" } });
    expect(sandboxProviderConfigured("modal")).toBe(false);
    write({
      provider: "modal",
      modal: { tokenId: "ak-test", tokenSecret: "as-test" },
      callbackBaseUrl: "wss://os.example.ts.net",
    });
    const modal = sandboxCapabilityStatus().providers.find((p) => p.id === "modal")!;
    expect(modal.configured).toBe(true);
    expect(modal.note).toBeUndefined();
  });

  test("lambda microvm requires an image identifier", () => {
    write({ provider: "lambda-microvm", awsLambdaMicrovm: {} });
    expect(sandboxProviderConfigured("lambda-microvm")).toBe(false);
    write({
      provider: "lambda-microvm",
      awsLambdaMicrovm: { imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image/test" },
      callbackBaseUrl: "wss://os.example.ts.net",
    });
    expect(sandboxProviderConfigured("lambda-microvm")).toBe(true);
    expect(
      sandboxCapabilityStatus().providers.find((p) => p.id === "lambda-microvm")?.note,
    ).toBeUndefined();
  });

  test("lambda microvm lifecycle values are bounded", () => {
    write({
      provider: "lambda-microvm",
      awsLambdaMicrovm: {
        imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image:test",
        maximumDurationSeconds: 99_999,
        idleSuspendSeconds: 45,
        suspendedDurationSeconds: 90.8,
      },
    });
    expect(sandboxConfig().awsLambdaMicrovm).toMatchObject({
      maximumDurationSeconds: 28_800,
      idleSuspendSeconds: undefined,
      suspendedDurationSeconds: 90,
    });
  });

  test("local Firecracker microvm requires explicit config and a clean golden", () => {
    write({ provider: "microvm", firecrackerMicrovm: { enabled: false } });
    expect(sandboxProviderConfigured("microvm")).toBe(false);
    expect(
      sandboxCapabilityStatus().providers.find((p) => p.id === "microvm")
        ?.configured,
    ).toBe(false);
  });

  test("an explicit callbackBaseUrl also counts as dial-back configured", () => {
    write({
      provider: "docker",
      e2b: { apiKey: "e2b_x" },
      callbackBaseUrl: "wss://os.example.ts.net",
    });
    const e = sandboxCapabilityStatus().providers.find((p) => p.id === "e2b")!;
    expect(e.configured).toBe(true);
    expect(e.note).toBeUndefined();
  });

  test("a disabled publicIngress block does not count as dial-back configured", () => {
    write({
      provider: "docker",
      daytona: { apiKey: "dtn_x" },
      publicIngress: { enabled: false, publicBaseUrl: "wss://example.ts.net" },
    });
    const d = sandboxCapabilityStatus().providers.find((p) => p.id === "daytona")!;
    expect(d.note).toContain("no dial-back URL configured");
  });

  test("garbage config = no config", () => {
    writeFileSync(cfgPath(), "{nope");
    expect(sandboxCapabilityStatus().enabled).toBe(false);
    expect(sandboxProviderConfigured("docker")).toBe(false);
  });

  test("status carries the model-family matrix verbatim (UI's source of truth)", () => {
    expect(sandboxCapabilityStatus().modelFamilies).toBe(SANDBOX_MODEL_FAMILIES);
  });
});

describe("model-family × environment capability matrix", () => {
  test("family derivation: provider + opencode/<provider>/ prefix, first match wins", () => {
    expect(sandboxModelFamilyFor("claude-fable-5").id).toBe("claude");
    expect(sandboxModelFamilyFor("gpt-5.5").id).toBe("codex");
    expect(sandboxModelFamilyFor("codex").id).toBe("codex"); // alias resolves
    expect(sandboxModelFamilyFor("opencode/openai/gpt-5.4-mini").id).toBe("opencode-openai");
    expect(sandboxModelFamilyFor("opencode/anthropic/claude-sonnet-5").id).toBe(
      "opencode-anthropic",
    );
    expect(sandboxModelFamilyFor("opencode/google/gemini-3").id).toBe("opencode-other");
    // Both pi provider splits land on the ONE pi row (match is provider-only).
    expect(sandboxModelFamilyFor("pi/anthropic/claude-sonnet-5").id).toBe("pi");
    expect(sandboxModelFamilyFor("pi/openai/gpt-5.5").id).toBe("pi");
  });

  test("pi is enabled in every environment, engine always placed on host", () => {
    const pi = SANDBOX_MODEL_FAMILIES.find((f) => f.id === "pi")!;
    for (const [env, enabled] of Object.entries(pi.environments)) {
      expect(`${env}:${enabled}`).toBe(`${env}:true`);
    }
    for (const provider of RUNNABLE_SANDBOX_PROVIDERS) {
      // The matrix admits the combo…
      expect(sandboxModelSupport("pi/anthropic/claude-sonnet-5", provider)).toEqual({
        ok: true,
      });
      // …and placement forces variant A (engine-on-host) everywhere — the
      // in-sandbox runner-host can never run pi (host-only bridge auth,
      // in-memory MCP, host session state).
      expect(sandboxEnginePlacement("pi/anthropic/claude-sonnet-5", provider)).toBe("host");
      expect(sandboxEnginePlacement("pi/openai/gpt-5.5", provider)).toBe("host");
    }
  });

  test("host is always fine; sandboxes gate by family", () => {
    expect(sandboxModelSupport("gpt-5.5", null)).toEqual({ ok: true });
    expect(sandboxModelSupport("gpt-5.5", "local")).toEqual({ ok: true });
    expect(sandboxModelSupport("claude-fable-5", "daytona")).toEqual({ ok: true });
    expect(sandboxModelSupport("claude-fable-5", "modal")).toEqual({ ok: true });
    expect(sandboxModelSupport("claude-fable-5", "lambda-microvm")).toEqual({ ok: true });
    expect(
      sandboxModelSupport("opencode/openai/gpt-5.6-sol", "microvm"),
    ).toEqual({ ok: true });
    expect(
      sandboxModelSupport("opencode/anthropic/claude-sonnet-5", "microvm").ok,
    ).toBe(true);
    // OpenCode OpenAI/Anthropic run everywhere. Docker mounts its runner auth;
    // remote providers and MicroVMs keep it on the host.
    expect(sandboxModelSupport("opencode/openai/gpt-5.4-mini", "daytona")).toEqual({ ok: true });
    expect(sandboxModelSupport("opencode/openai/gpt-5.5", "e2b")).toEqual({ ok: true });
    expect(sandboxModelSupport("opencode/anthropic/claude-sonnet-5", "docker")).toEqual({
      ok: true,
    });
  });

  test("remote OpenAI/Claude engines stay on host; Docker keeps its runner", () => {
    expect(sandboxEnginePlacement("opencode/openai/gpt-5.6-sol", "daytona")).toBe("host");
    expect(
      sandboxEnginePlacement("opencode/anthropic/claude-sonnet-5", "modal"),
    ).toBe("host");
    expect(sandboxEnginePlacement("opencode/openai/gpt-5.6-sol", "microvm")).toBe("host");
    expect(sandboxEnginePlacement("opencode/openai/gpt-5.6-sol", "docker")).toBe("sandbox");
    expect(
      sandboxEnginePlacement("opencode/anthropic/claude-sonnet-5", "docker"),
    ).toBe("sandbox");
    expect(sandboxEnginePlacement("opencode/google/gemini-3", "docker")).toBe("host");
  });

  test("native codex stays host-only; other-provider OpenCode uses an external engine", () => {
    const codex = sandboxModelSupport("gpt-5.5", "docker");
    expect(codex.ok).toBe(false);
    if (!codex.ok) {
      expect(codex.error).toContain("GPT (Codex) models can't run in Docker");
      expect(codex.error).toContain("pick Host");
      expect(codex.error).toContain("opencode/openai");
    }
    const other = sandboxModelSupport("opencode/google/gemini-3", "daytona");
    expect(other).toEqual({ ok: true });
    expect(sandboxModelSupport("opencode/xai/grok-4.5", "modal")).toEqual({
      ok: true,
    });
  });
});

describe("resolveRequestedSandbox (create-path validation)", () => {
  test("falsy = no sandbox", () => {
    expect(resolveRequestedSandbox(undefined)).toEqual({ ok: true, provider: null });
    expect(resolveRequestedSandbox(false)).toEqual({ ok: true, provider: null });
    expect(resolveRequestedSandbox("")).toEqual({ ok: true, provider: null });
  });

  test("true = config default provider (today's boolean behavior)", () => {
    write({ provider: "docker" });
    const r = resolveRequestedSandbox(true);
    expect(r.ok).toBe(true);
    // Kill-switch-aware like effectiveSandboxProvider — on a switched-off box
    // this resolves to local, matching the boolean path's existing semantics.
    if (r.ok) expect(r.provider).toBe(sandboxesEnabled() ? "docker" : "local");
  });

  test("explicit configured provider is accepted", () => {
    write({
      provider: "docker",
      daytona: { apiKey: "dtn_x" },
      modal: { tokenId: "ak-test", tokenSecret: "as-test" },
      awsLambdaMicrovm: { imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image/test" },
    });
    expect(resolveRequestedSandbox("docker")).toEqual({ ok: true, provider: "docker" });
    expect(resolveRequestedSandbox("daytona")).toEqual({ ok: true, provider: "daytona" });
    expect(resolveRequestedSandbox("modal")).toEqual({ ok: true, provider: "modal" });
    expect(resolveRequestedSandbox("lambda-microvm")).toEqual({
      ok: true,
      provider: "lambda-microvm",
    });
    expect(resolveRequestedSandbox("DOCKER")).toEqual({ ok: true, provider: "docker" });
  });

  test("explicit unconfigured provider fails with a pointed error", () => {
    write({ provider: "docker" }); // no daytona/e2b keys
    const r = resolveRequestedSandbox("daytona");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("daytona");
    const e = resolveRequestedSandbox("e2b");
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toContain("e2b");
  });

  test("docker without any config file fails", () => {
    const r = resolveRequestedSandbox("docker");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not configured");
  });

  test("unknown provider string fails; 'local' means host", () => {
    write({ provider: "docker" });
    const r = resolveRequestedSandbox("fly");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown sandbox provider");
    expect(resolveRequestedSandbox("local")).toEqual({ ok: true, provider: null });
  });

  test("model × environment combos are enforced at create, not just in the UI", () => {
    write({ provider: "docker", daytona: { apiKey: "dtn_x" } });
    // Supported combos pass through.
    expect(resolveRequestedSandbox("daytona", undefined, "claude-fable-5")).toEqual({
      ok: true,
      provider: "daytona",
    });
    expect(
      resolveRequestedSandbox("daytona", undefined, "opencode/openai/gpt-5.4-mini"),
    ).toEqual({ ok: true, provider: "daytona" });
    // Unsupported combos fail with the matrix's message — including via the
    // boolean `sandbox: true` path (config default provider).
    const explicit = resolveRequestedSandbox("docker", undefined, "gpt-5.5");
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) expect(explicit.error).toContain("GPT (Codex) models can't run in Docker");
    const viaDefault = resolveRequestedSandbox(true, undefined, "gpt-5.5");
    if (sandboxesEnabled()) {
      expect(viaDefault.ok).toBe(false);
      if (!viaDefault.ok) expect(viaDefault.error).toContain("can't run in Docker");
    }
    // Host is always fine, whatever the model.
    expect(resolveRequestedSandbox("local", undefined, "gpt-5.5")).toEqual({
      ok: true,
      provider: null,
    });
  });

  test("pi models pass the create-gate on configured providers", () => {
    write({ provider: "docker", daytona: { apiKey: "dtn_x" } });
    expect(
      resolveRequestedSandbox("daytona", undefined, "pi/anthropic/claude-sonnet-5"),
    ).toEqual({ ok: true, provider: "daytona" });
    expect(
      resolveRequestedSandbox("docker", undefined, "pi/anthropic/claude-sonnet-5"),
    ).toEqual({ ok: true, provider: "docker" });
    // The boolean default-provider path vets the model the same way.
    const viaDefault = resolveRequestedSandbox(true, undefined, "pi/openai/gpt-5.5");
    expect(viaDefault.ok).toBe(true);
  });
});
