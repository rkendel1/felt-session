/**
 * Unit tests for the warm-on-typing prewarm pool's state machine
 * (src/server/sandbox/prewarm.ts): request/reuse, atomic claim, signature
 * mismatch (runner pin AND provider create-shape), TTL + restart reaping,
 * capacity caps, and the per-user rate limit.
 *
 * No real provider is touched: a fake PrewarmAdapter is injected via the
 * test seam, and its fake RemoteDriver answers the two exec probes the real
 * bootstrap path makes (dial-back curl check → "no curl" skip; bootstrap
 * marker read → the current signature, short-circuiting the install).
 * Config goes through a scratch OPENSESSION_SANDBOX_CONFIG; state files land
 * under a scratch sessions dir via __setSessionsDirForTest.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setSessionsDirForTest } from "../paths";
import { sandboxesEnabled } from "./config";
import {
  claimPrewarm,
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  prewarmRateLimited,
  requestPrewarm,
  sweepPrewarms,
  _prewarmPoolForTest,
  _resetPrewarmForTest,
  _setPrewarmAdapterForTest,
  _stopPrewarmSweepForTest,
  type PrewarmAdapter,
} from "./prewarm";

let scratch: string;
let prevSessionsDir: string;
let prevEnvConfig: string | undefined;
let prevDaytonaKey: string | undefined;
const cfgPath = () => join(scratch, "sandbox.json");
const prewarmDir = () => join(scratch, "sessions", "sandbox-prewarm");

// The kill-switch file lives under the LIVE sessions dir (module-load constant
// in config.ts) — on a box with the switch on, requestPrewarm legitimately
// answers "disabled"; skip the behavioral tests rather than fight it.
const killSwitch = !sandboxesEnabled();

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bks-prewarm-"));
  mkdirSync(join(scratch, "sessions"), { recursive: true });
  prevSessionsDir = __setSessionsDirForTest(join(scratch, "sessions"));
  prevEnvConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
  prevDaytonaKey = process.env.DAYTONA_API_KEY;
  process.env.OPENSESSION_SANDBOX_CONFIG = cfgPath();
  delete process.env.DAYTONA_API_KEY;
});

afterAll(() => {
  _stopPrewarmSweepForTest();
  _resetPrewarmForTest();
  __setSessionsDirForTest(prevSessionsDir);
  if (prevEnvConfig === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = prevEnvConfig;
  if (prevDaytonaKey !== undefined) process.env.DAYTONA_API_KEY = prevDaytonaKey;
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  _resetPrewarmForTest();
  rmSync(prewarmDir(), { recursive: true, force: true });
  writeConfig({});
});

afterEach(() => {
  _stopPrewarmSweepForTest();
  _resetPrewarmForTest();
});

function writeConfig(overrides: Record<string, unknown>): void {
  writeFileSync(
    cfgPath(),
    JSON.stringify({
      provider: "daytona",
      daytona: { apiKey: "test-key", snapshot: "snap-A" },
      runnerSha: "sha-A",
      prewarm: { ttlMinutes: 10, maxLive: 2 },
      ...overrides,
    }),
  );
}

/** Fake adapter whose driver satisfies the real dial-back + bootstrap-marker
 *  probes. `gate` (when provided) holds create() open so bootstrapping-state
 *  concurrency can be asserted. */
function makeFakeAdapter(opts: { markerAnswer?: string; gate?: Promise<void> } = {}) {
  const created: string[] = [];
  const destroyed: string[] = [];
  let n = 0;
  const adapter: PrewarmAdapter = {
    async create() {
      if (opts.gate) await opts.gate;
      const id = `pw-${++n}`;
      created.push(id);
      return {
        sandboxId: id,
        driver: {
          async exec(cmd: string) {
            if (cmd.includes(".bks-bootstrapped")) {
              return { exitCode: 0, stdout: opts.markerAnswer ?? "sha-A", stderr: "" };
            }
            return { exitCode: 0, stdout: "__OPENSESSION_NO_CURL__", stderr: "" };
          },
          async execBackground() {},
          async writeFile() {},
          async ensureStarted() {},
        },
      };
    },
    async destroy(id: string) {
      destroyed.push(id);
    },
    async listPrewarmed() {
      return [];
    },
  };
  _setPrewarmAdapterForTest("daytona", adapter);
  return { adapter, created, destroyed };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(cond()).toBe(true);
}

const readyEntry = () => _prewarmPoolForTest().get("daytona:tella-fusion");

describe("requestPrewarm", () => {
  test("unknown provider / repo / local provider → unsupported", async () => {
    makeFakeAdapter();
    expect((await requestPrewarm("docker", "tella-fusion")).state).toBe("unsupported");
    expect((await requestPrewarm("daytona", "no-such-repo")).state).toBe("unsupported");
  });

  test.skipIf(killSwitch)("starts one bootstrap, reuses it, reaches ready", async () => {
    const fake = makeFakeAdapter();
    const first = await requestPrewarm("daytona", "tella-fusion", "alex");
    expect(first.state).toBe("bootstrapping");
    // Idempotent while in flight — no second create.
    const again = await requestPrewarm("daytona", "tella-fusion", "alex");
    expect(["bootstrapping", "ready"]).toContain(again.state);
    await until(() => readyEntry()?.state === "ready");
    expect(fake.created.length).toBe(1);
    const done = await requestPrewarm("daytona", "tella-fusion", "alex");
    expect(done.state).toBe("ready");
    expect(done.sandboxId).toBe(fake.created[0]);
    // State file persisted for restart reaping.
    expect(existsSync(join(prewarmDir(), "daytona-tella-fusion.json"))).toBe(true);
  });

  test.skipIf(killSwitch)("uses a provider-specific preparation hook", async () => {
    const fake = makeFakeAdapter();
    const prepared: string[] = [];
    fake.adapter.prepare = async (_driver, repo, label) => {
      prepared.push(`${repo.id}:${label}`);
    };
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");
    expect(prepared).toEqual(["tella-fusion:daytona-prewarm"]);
  });

  test.skipIf(killSwitch)("prewarm disabled by config → disabled", async () => {
    makeFakeAdapter();
    writeConfig({ prewarm: { enabled: false } });
    expect((await requestPrewarm("daytona", "tella-fusion")).state).toBe("disabled");
  });

  test.skipIf(killSwitch)("caps: only one bootstrap in flight; maxLive total", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    makeFakeAdapter({ gate });
    expect((await requestPrewarm("daytona", "tella-fusion")).state).toBe("bootstrapping");
    // A different key while the first is still creating: at-capacity.
    expect((await requestPrewarm("daytona", "gitops")).state).toBe("at-capacity");
    open();
    await until(() => readyEntry()?.state === "ready");
    // maxLive=1: the ready one occupies the whole pool.
    writeConfig({ prewarm: { ttlMinutes: 10, maxLive: 1 } });
    expect((await requestPrewarm("daytona", "gitops")).state).toBe("at-capacity");
  });
});

describe("claimPrewarm (adoption)", () => {
  test.skipIf(killSwitch)("claims once, atomically; frees the key", async () => {
    const fake = makeFakeAdapter();
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");

    const claim = claimPrewarm("daytona", "tella-fusion", "bks-session-1");
    expect(claim?.sandboxId).toBe(fake.created[0]);
    // Second concurrent claimant loses.
    expect(claimPrewarm("daytona", "tella-fusion", "bks-session-2")).toBeNull();
    // State file renamed to the .claimed tombstone.
    expect(existsSync(join(prewarmDir(), "daytona-tella-fusion.json"))).toBe(false);
    expect(existsSync(join(prewarmDir(), "daytona-tella-fusion.json.claimed"))).toBe(true);
    // The adopted sandbox is session-owned: nothing destroyed it.
    expect(fake.destroyed).toEqual([]);
    // Key freed — a new prewarm for the same key can start.
    expect((await requestPrewarm("daytona", "tella-fusion")).state).toBe("bootstrapping");
    await until(() => fake.created.length === 2);
  });

  test.skipIf(killSwitch)("stale runner pin refuses the claim and destroys", async () => {
    const fake = makeFakeAdapter();
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");
    writeConfig({ runnerSha: "sha-B" }); // runner payload pin moved
    expect(claimPrewarm("daytona", "tella-fusion", "bks-s")).toBeNull();
    await until(() => fake.destroyed.includes(fake.created[0]));
    expect(_prewarmPoolForTest().size).toBe(0);
  });

  test.skipIf(killSwitch)("provider create-shape change (daytona snapshot) also refuses", async () => {
    const fake = makeFakeAdapter();
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");
    writeConfig({ daytona: { apiKey: "test-key", snapshot: "snap-B" } });
    expect(claimPrewarm("daytona", "tella-fusion", "bks-s")).toBeNull();
    await until(() => fake.destroyed.includes(fake.created[0]));
  });

  test.skipIf(killSwitch)("discardClaimedPrewarm destroys a claimed-but-unusable sandbox", async () => {
    const fake = makeFakeAdapter();
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");
    const claim = claimPrewarm("daytona", "tella-fusion", "bks-s")!;
    discardClaimedPrewarm("daytona", claim.sandboxId);
    await until(() => fake.destroyed.includes(claim.sandboxId));
  });
});

describe("claimPrewarmOrWait (adopt a mid-bootstrap prewarm)", () => {
  test.skipIf(killSwitch)("waits for a young in-flight bootstrap, then adopts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = makeFakeAdapter({ gate });
    await requestPrewarm("daytona", "tella-fusion");
    expect(readyEntry()?.state).toBe("bootstrapping");

    const waiting = claimPrewarmOrWait("daytona", "tella-fusion", "bks-waiter");
    // Not adopted yet — the bootstrap is gated open.
    let settled = false;
    void waiting.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    release();
    const claim = await waiting;
    expect(claim?.sandboxId).toBe(fake.created[0]);
    // The waiter adopted the warming sandbox — nothing raced, nothing died.
    expect(fake.created.length).toBe(1);
    expect(fake.destroyed).toEqual([]);
  });

  test.skipIf(killSwitch)("two waiters: exactly one adopts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = makeFakeAdapter({ gate });
    await requestPrewarm("daytona", "tella-fusion");
    const a = claimPrewarmOrWait("daytona", "tella-fusion", "bks-a");
    const b = claimPrewarmOrWait("daytona", "tella-fusion", "bks-b");
    release();
    const [ca, cb] = await Promise.all([a, b]);
    const winners = [ca, cb].filter(Boolean);
    expect(winners.length).toBe(1);
    expect(winners[0]!.sandboxId).toBe(fake.created[0]);
  });

  test.skipIf(killSwitch)("does not wait on an old bootstrapping entry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    makeFakeAdapter({ gate });
    await requestPrewarm("daytona", "tella-fusion");
    const entry = readyEntry()!;
    entry.createdAt = new Date(Date.now() - 120_000).toISOString(); // stuck cold install
    const claim = await claimPrewarmOrWait("daytona", "tella-fusion", "bks-s");
    expect(claim).toBeNull(); // returned immediately — caller cold-creates
    release();
  });

  test.skipIf(killSwitch)("ready entry claims without waiting", async () => {
    const fake = makeFakeAdapter();
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");
    const claim = await claimPrewarmOrWait("daytona", "tella-fusion", "bks-s");
    expect(claim?.sandboxId).toBe(fake.created[0]);
  });
});

describe("sweepPrewarms", () => {
  test.skipIf(killSwitch)("TTL expiry destroys provider-side and clears state", async () => {
    const fake = makeFakeAdapter();
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");
    // Fresh: survives a sweep.
    await sweepPrewarms();
    expect(readyEntry()?.state).toBe("ready");
    // 11 minutes later (ttl 10): reaped, provider-side too.
    await sweepPrewarms(Date.now() + 11 * 60_000);
    expect(readyEntry()).toBeUndefined();
    await until(() => fake.destroyed.includes(fake.created[0]));
    expect(existsSync(join(prewarmDir(), "daytona-tella-fusion.json"))).toBe(false);
  });

  test.skipIf(killSwitch)("touch extends the TTL", async () => {
    makeFakeAdapter();
    await requestPrewarm("daytona", "tella-fusion");
    await until(() => readyEntry()?.state === "ready");
    // Keep typing at +9m: entry re-touched, so a sweep at +18m from ORIGINAL
    // creation is still within TTL of the last touch.
    const entry = readyEntry()!;
    entry.lastTouchedAt = new Date(Date.now() + 9 * 60_000).toISOString();
    await sweepPrewarms(Date.now() + 18 * 60_000);
    expect(readyEntry()?.state).toBe("ready");
  });

  test.skipIf(killSwitch)("restart-orphaned state files are destroyed, not adopted", async () => {
    const fake = makeFakeAdapter();
    mkdirSync(prewarmDir(), { recursive: true });
    writeFileSync(
      join(prewarmDir(), "daytona-tella-fusion.json"),
      JSON.stringify({
        key: "daytona:tella-fusion",
        provider: "daytona",
        repoId: "tella-fusion",
        state: "ready",
        signature: "sha-A|snap-A",
        sandboxId: "pw-orphan",
        createdAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
      }),
    );
    await sweepPrewarms();
    await until(() => fake.destroyed.includes("pw-orphan"));
    expect(existsSync(join(prewarmDir(), "daytona-tella-fusion.json"))).toBe(false);
  });

  test.skipIf(killSwitch)("old .claimed tombstones are unlinked WITHOUT destroying", async () => {
    const fake = makeFakeAdapter();
    mkdirSync(prewarmDir(), { recursive: true });
    const tomb = join(prewarmDir(), "daytona-tella-fusion.json.claimed");
    writeFileSync(tomb, JSON.stringify({ sandboxId: "pw-adopted", provider: "daytona" }));
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(tomb, old, old);
    await sweepPrewarms();
    expect(existsSync(tomb)).toBe(false);
    expect(fake.destroyed).toEqual([]);
  });

  test.skipIf(killSwitch)("provider orphan audit reaps untracked prewarms with our keys only", async () => {
    const { destroyed } = makeFakeAdapter();
    const listed = [
      { id: "pw-untracked", key: "daytona:tella-fusion" }, // ours → reap
      { id: "pw-foreign", key: "daytona:someone-elses-repo" }, // not our registry → skip
    ];
    _setPrewarmAdapterForTest("daytona", {
      async create() {
        throw new Error("unused");
      },
      async destroy(id: string) {
        destroyed.push(id);
      },
      async listPrewarmed() {
        return listed;
      },
    });
    await sweepPrewarms();
    await until(() => destroyed.includes("pw-untracked"));
    expect(destroyed).not.toContain("pw-foreign");
  });
});

describe("prewarmRateLimited", () => {
  test("allows 6/min then limits", () => {
    for (let i = 0; i < 6; i++) expect(prewarmRateLimited("kent")).toBe(false);
    expect(prewarmRateLimited("kent")).toBe(true);
    // Other users unaffected.
    expect(prewarmRateLimited("grant")).toBe(false);
  });
});
