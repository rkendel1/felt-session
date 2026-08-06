/**
 * Focused pi-runner tests: the pure pieces — model-id parsing, the
 * deny-by-default run gate, the provider-aware usage-limit classifier, the
 * local-tool path containment guard (the in-process engine's security
 * invariant), the custom bash tool's exit-gated completion (wedge
 * regression), and the pi/openai account-wiring failure paths (isolated
 * codex store — every case fails before the SDK import or any network use).
 * The engine turn itself is covered by the smoke harness
 * (POST /api/admin/pi-smoke) against a live bridge, not unit tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertContainedPiPath,
  isPiUsageLimitShape,
  makeGuardedGrepExecute,
  makeGuardedToolOps,
  makePiBashTool,
  parsePiModel,
  piGateReason,
  runPi,
  runPiSmokeTurn,
} from "./pi-runner";
import { __setCodexAccountsPathForTest } from "./codex-accounts";

describe("parsePiModel", () => {
  test("splits pi/<provider>/<model>", () => {
    expect(parsePiModel("pi/anthropic/claude-opus-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5",
    });
  });

  test("model id may itself contain slashes", () => {
    expect(parsePiModel("pi/openrouter/meta/llama-3")).toEqual({
      providerID: "openrouter",
      modelID: "meta/llama-3",
    });
  });

  test("rejects non-pi ids and malformed remainders", () => {
    expect(parsePiModel("opencode/anthropic/claude-opus-5")).toBeNull();
    expect(parsePiModel("claude-opus-5")).toBeNull();
    expect(parsePiModel("pi/anthropic")).toBeNull();
    expect(parsePiModel("pi/anthropic/")).toBeNull();
    expect(parsePiModel("pi//claude-opus-5")).toBeNull();
  });
});

describe("piGateReason", () => {
  test("interactive and unattended kinds pass", () => {
    for (const kind of ["prompt", "goal", "create", "linear", "slack", "workflow"]) {
      expect(piGateReason({ journal: { kind } })).toBeNull();
    }
    for (const kind of ["automation", "plain", "action", "security-scan", "github-review"]) {
      expect(piGateReason({ journal: { kind } })).toBeNull();
    }
  });

  test("resume/rerun/fallback suffixes resolve to the base kind", () => {
    expect(piGateReason({ journal: { kind: "prompt-resume" } })).toBeNull();
    expect(piGateReason({ journal: { kind: "automation-resume-fallback" } })).toBeNull();
  });

  test("kind-less runs are refused (deny by default)", () => {
    expect(piGateReason({})).toMatch(/explicit run kind/);
    expect(piGateReason({ journal: {} })).toMatch(/explicit run kind/);
  });

  test("unknown kinds are refused by name", () => {
    expect(piGateReason({ journal: { kind: "mystery" } })).toContain('"mystery"');
  });

  test("the smoke kind is refused unless the harness armed its bypass", () => {
    // Request/automation data can NAME the kind, but only runPiSmokeTurn can
    // arm the module-scoped bypass — from out here it must stay refused.
    expect(piGateReason({ journal: { kind: "pi-smoke" } })).toContain('"pi-smoke"');
  });
});

describe("isPiUsageLimitShape (provider-aware)", () => {
  test("anthropic runs match the loopback bridge's shapes", () => {
    expect(isPiUsageLimitShape("HTTP 429 from bridge", "anthropic")).toBe(true);
    expect(isPiUsageLimitShape("upstream returned 529", "anthropic")).toBe(true);
    expect(isPiUsageLimitShape("overloaded_error", "anthropic")).toBe(true);
    expect(isPiUsageLimitShape("no designated bridge account", "anthropic")).toBe(true);
    expect(isPiUsageLimitShape("ordinary tool failure", "anthropic")).toBe(false);
  });

  test("openai runs match the shared codex classifier plus the raw code shapes", () => {
    expect(
      isPiUsageLimitShape(
        "You have hit your ChatGPT usage limit (Plus plan). Try again in ~3 hr.",
        "openai"
      )
    ).toBe(true);
    expect(isPiUsageLimitShape("usage_limit_reached", "openai")).toBe(true);
    expect(isPiUsageLimitShape("usage_not_included", "openai")).toBe(true);
    expect(isPiUsageLimitShape("rate_limit_exceeded", "openai")).toBe(true);
    expect(isPiUsageLimitShape("insufficient_quota", "openai")).toBe(true);
    expect(isPiUsageLimitShape("Too Many Requests", "openai")).toBe(true);
    expect(isPiUsageLimitShape("status 429", "openai")).toBe(true);
    // Bridge-only shapes must NOT flag openai runs (overload/529 is transient
    // there, not exhaustion).
    expect(isPiUsageLimitShape("no designated bridge account", "openai")).toBe(false);
    expect(isPiUsageLimitShape("overloaded_error", "openai")).toBe(false);
    expect(isPiUsageLimitShape("upstream returned 529", "openai")).toBe(false);
    expect(isPiUsageLimitShape("ordinary tool failure", "openai")).toBe(false);
  });
});

describe("runPi pi/openai account wiring (no engine, no network)", () => {
  // Enabled pi config + an isolated codex store: every path exercised here
  // must fail BEFORE the SDK import — a throw any later would mean a live
  // engine (or chatgpt.com) was nearly reached from a unit test.
  const dir = mkdtempSync(join(tmpdir(), "pi-openai-"));
  const cfgPath = join(dir, "pi.json");
  const storePath = join(dir, "codex-accounts.json");
  let prevCfg: string | undefined;
  let prevStore = "";
  beforeAll(() => {
    writeFileSync(cfgPath, JSON.stringify({ enabled: true, pickerModels: [] }));
    prevCfg = process.env.OPENSESSION_PI_CONFIG;
    process.env.OPENSESSION_PI_CONFIG = cfgPath;
    prevStore = __setCodexAccountsPathForTest(storePath);
  });
  afterAll(() => {
    if (prevCfg === undefined) delete process.env.OPENSESSION_PI_CONFIG;
    else process.env.OPENSESSION_PI_CONFIG = prevCfg;
    __setCodexAccountsPathForTest(prevStore);
    rmSync(dir, { recursive: true, force: true });
  });

  const collect = async (model: string, extra: Record<string, unknown> = {}) => {
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of runPi(
      // No osSessionId: journal/store writes are skipped — pure wiring test.
      { prompt: "hi", cwd: dir, mode: "ask", mcpServers: [], journal: { kind: "prompt" }, ...extra },
      model
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    return events;
  };

  test("unwired pi providers get the clear both-pools error", async () => {
    const events = await collect("pi/mistral/large");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(String(events[0].content)).toContain("pi/anthropic/*");
    expect(String(events[0].content)).toContain("pi/openai/*");
  });

  test("dry codex pool → flagged terminal so the model-fallback walk engages", async () => {
    const events = await collect("pi/openai/gpt-5.6-sol");
    const err = events.find((e) => e.type === "error")!;
    expect(err).toBeDefined();
    expect(String(err.content)).toContain("no codex accounts configured");
    // The pre-init throw's text never matches the classifier — the catch must
    // honor the thrown error's usageLimitExhausted property.
    expect(err.usageLimitExhausted).toBe(true);
  });

  test("api_key codex accounts are refused with a clear, unflagged error", async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "k1",
            name: "org-key",
            kind: "api_key",
            value: "sk-test",
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    const events = await collect("pi/openai/gpt-5.6-sol");
    const err = events.find((e) => e.type === "error")!;
    expect(err).toBeDefined();
    expect(String(err.content)).toMatch(/only API-key codex accounts are currently eligible/);
    // Wrong account kind is a configuration wall, not an exhausted pool — it
    // must not trigger the fallback walk.
    expect(err.usageLimitExhausted).toBeUndefined();
  });

  test("mixed pool: an api_key pick is excluded and the home account is retried", async () => {
    // Two accounts; whichever the HRW hash ranks first, the run must end up
    // on the home account's path — never the api_key configuration wall.
    // The home account here has no CODEX_HOME auth.json, so reaching
    // buildSeededOpenaiAuth's distinct error IS the proof the re-pick landed
    // on it.
    const codexHome = join(dir, "codex-home-mixed");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "k1",
            name: "org-key",
            kind: "api_key",
            value: "sk-test",
            createdAt: new Date().toISOString(),
          },
          {
            id: "h1",
            name: "home-acct",
            kind: "home",
            value: codexHome,
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    const events = await collect("pi/openai/gpt-5.6-sol");
    const err = events.find((e) => e.type === "error")!;
    expect(err).toBeDefined();
    // The home account's failure mode (unreadable seed), not the api_key wall.
    expect(String(err.content)).not.toMatch(/API-key/);
    expect(err.usageLimitExhausted).toBe(true);
  });

  test("explicitly pinned api_key account errors clearly instead of re-picking", async () => {
    const codexHome = join(dir, "codex-home-pin");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "k1",
            name: "org-key",
            kind: "api_key",
            value: "sk-test",
            createdAt: new Date().toISOString(),
          },
          {
            id: "h1",
            name: "home-acct",
            kind: "home",
            value: codexHome,
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    const events = await collect("pi/openai/gpt-5.6-sol", { accountId: "k1" });
    const err = events.find((e) => e.type === "error")!;
    expect(err).toBeDefined();
    // A pin is an explicit choice — surface the configuration error, never
    // silently hop to another account.
    expect(String(err.content)).toMatch(/pinned codex account .* is an API-key account/);
    expect(err.usageLimitExhausted).toBeUndefined();
  });

  test("expired ChatGPT access token → flagged terminal (dry-pool parity)", async () => {
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor((Date.now() - 60_000) / 1000) })
    ).toString("base64url");
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: `h.${payload}.s` } })
    );
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: "h1",
            name: "pool-home",
            kind: "home",
            value: codexHome,
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    const events = await collect("pi/openai/gpt-5.6-sol");
    const err = events.find((e) => e.type === "error")!;
    expect(err).toBeDefined();
    expect(String(err.content)).toContain("expired");
    expect(err.usageLimitExhausted).toBe(true);
  });
});

describe("local-tool path containment", () => {
  const ws = mkdtempSync(join(tmpdir(), "pi-guard-"));
  const realWs = realpathSync(ws);
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "inside.txt"), "needle-inside\n");
  writeFileSync(join(ws, "top.ts"), "export {};\n");
  symlinkSync("/etc", join(ws, "esc"));
  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  test("assertContainedPiPath allows workspace paths, incl. not-yet-created ones", () => {
    expect(assertContainedPiPath(join(ws, "sub", "inside.txt"), realWs)).toBe(
      join(realWs, "sub", "inside.txt")
    );
    expect(assertContainedPiPath(ws, realWs)).toBe(realWs);
    // write/edit targets that don't exist yet are contained via their
    // nearest existing ancestor
    expect(assertContainedPiPath(join(ws, "newdir", "new.txt"), realWs)).toBe(
      join(realWs, "newdir", "new.txt")
    );
  });

  test("rejects absolute escapes, /proc//sys//dev, and .. traversal", () => {
    expect(() => assertContainedPiPath("/etc/passwd", realWs)).toThrow(/outside the session workspace/);
    expect(() => assertContainedPiPath("/proc/self/environ", realWs)).toThrow(/not accessible/);
    expect(() => assertContainedPiPath("/sys/kernel", realWs)).toThrow(/not accessible/);
    expect(() => assertContainedPiPath("/dev/stdin", realWs)).toThrow(/not accessible/);
    expect(() =>
      assertContainedPiPath(join(ws, "..", "..", "..", "..", "etc", "passwd"), realWs)
    ).toThrow(/outside the session workspace|not accessible/);
  });

  test("rejects symlink escapes, existing and dangling targets", () => {
    expect(() => assertContainedPiPath(join(ws, "esc", "passwd"), realWs)).toThrow(
      /outside the session workspace|not accessible/
    );
    // non-existent path UNDER an escaping symlink still resolves out
    expect(() =>
      assertContainedPiPath(join(ws, "esc", "nope", "x.txt"), realWs)
    ).toThrow(/outside the session workspace|not accessible/);
  });

  test("guarded read/ls/write ops enforce containment; inside paths work", async () => {
    const ops = makeGuardedToolOps(ws);
    expect((await ops.read.readFile(join(ws, "sub", "inside.txt"))).toString()).toContain(
      "needle-inside"
    );
    await expect(ops.read.readFile("/etc/passwd")).rejects.toThrow(/outside/);
    await expect(ops.read.access("/proc/self/environ")).rejects.toThrow(/not accessible/);
    await expect(ops.read.readFile(join(ws, "esc", "passwd"))).rejects.toThrow(/outside/);
    expect(await ops.ls.readdir(ws)).toContain("sub");
    await expect(ops.ls.readdir("/etc")).rejects.toThrow(/outside/);
    await ops.write.mkdir(join(ws, "made"));
    await ops.write.writeFile(join(ws, "made", "ok.txt"), "ok");
    expect((await ops.read.readFile(join(ws, "made", "ok.txt"))).toString()).toBe("ok");
    await expect(ops.write.writeFile("/tmp/pi-guard-escape.txt", "x")).rejects.toThrow(
      /outside/
    );
    await expect(ops.edit.access("/etc/hosts")).rejects.toThrow(/outside/);
  });

  test("guarded find.glob walks in-process, contained, with ignores", async () => {
    const ops = makeGuardedToolOps(ws);
    const hits = await ops.find.glob("*.ts", ws, {
      ignore: ["**/node_modules/**", "**/.git/**"],
      limit: 100,
    });
    expect(hits).toContain(join(ws, "top.ts"));
    await expect(
      Promise.resolve(ops.find.glob("*", "/etc", { ignore: [], limit: 10 }))
    ).rejects.toThrow(/outside/);
  });

  test("guarded grep rejects escapes before any rg spawn", async () => {
    const ops = makeGuardedToolOps(ws);
    const grep = makeGuardedGrepExecute(ws, { PATH: process.env.PATH || "" }, ops.guard);
    await expect(grep("t", { pattern: ".", path: "/proc/self/environ" })).rejects.toThrow(
      /not accessible/
    );
    await expect(grep("t", { pattern: ".", path: "/etc" })).rejects.toThrow(/outside/);
  });

  test.skipIf(!Bun.which("rg"))("guarded grep finds matches via rg with the minimal env", async () => {
    const ops = makeGuardedToolOps(ws);
    const grep = makeGuardedGrepExecute(ws, { PATH: process.env.PATH || "" }, ops.guard);
    const res = await grep("t", { pattern: "needle-inside", path: ws });
    expect(res.content[0]?.text).toMatch(/inside\.txt:1:/);
    expect(res.content[0]?.text).toContain("needle-inside");
  });
});

describe("makePiBashTool exit-gated completion", () => {
  const env = { PATH: process.env.PATH || "/usr/bin:/bin" };
  const tool = makePiBashTool({ cwd: tmpdir(), env, gated: false, unattended: false });

  test("a background child holding stdout does not wedge the tool", async () => {
    const started = Date.now();
    const res = (await (tool as any).execute(
      "t1",
      { command: "echo hi; sleep 15 & echo bye" },
      undefined,
      undefined
    )) as { content: Array<{ text: string }> };
    // Old drain-gated flow blocked on the orphan's inherited pipe for the
    // full 15s (forever for a daemon); exit-gated returns after exit+grace.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.content[0]?.text).toContain("hi");
    expect(res.content[0]?.text).toContain("bye");
  });

  test("timeout kills the process group and reports promptly", async () => {
    const started = Date.now();
    await expect(
      (tool as any).execute("t2", { command: "sleep 60", timeout: 1 }, undefined, undefined)
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("abort kills the process group and reports promptly", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    await expect(
      (tool as any).execute("t3", { command: "sleep 60" }, ac.signal, undefined)
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});

describe("runPiSmokeTurn with the engine disabled", () => {
  test("pure dry run: config-gate error only, no bridge/SDK/store rows", async () => {
    // Force-disable regardless of the instance's real ~/.opensession-pi.json —
    // this test must never execute a live turn (OPENSESSION_PI_CONFIG is the
    // documented test seam and pi-config reads it fresh per call).
    const prev = process.env.OPENSESSION_PI_CONFIG;
    process.env.OPENSESSION_PI_CONFIG = "/nonexistent/opensession-pi-test.json";
    try {
      const res = await runPiSmokeTurn({ timeoutMs: 5_000 });
      expect(res.ok).toBe(false);
      expect(res.enabled).toBe(false);
      expect(res.dryRun).toBe(true);
      expect(res.eventTypes).toEqual(["error"]);
      expect(res.error || "").toContain("not enabled");
      expect(res.reason || "").toContain("disabled");
      expect(res.storeRows).toBe(0);
      expect(res.timedOut).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OPENSESSION_PI_CONFIG;
      else process.env.OPENSESSION_PI_CONFIG = prev;
    }
  });
});
