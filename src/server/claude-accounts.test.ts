import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the module at a temp store BEFORE it loads (env is read at import).
const dir = mkdtempSync(join(tmpdir(), "claude-accounts-test-"));
const storePath = join(dir, "accounts.json");
process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = storePath;

const mkAccount = (id: string, owner?: string) => ({
  id,
  name: id,
  token: `sk-ant-oat01-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(owner ? { owner } : {}),
});

writeFileSync(
  storePath,
  JSON.stringify({
    accounts: [
      mkAccount("fresh"),
      mkAccount("maxed"),
      mkAccount("personal", "Alex"),
      mkAccount("blind-personal", "Jaap"),
    ],
  })
);

const usage = (
  fiveHourPct: number,
  extra?: { enabled: boolean; usedCredits: number; monthlyLimit: number }
) => ({
  fetchedAt: new Date().toISOString(),
  fiveHour: { utilization: fiveHourPct, resetsAt: null },
  sevenDay: null,
  extraUsage: extra ?? null,
});

let accounts: typeof import("./claude-accounts");

beforeAll(async () => {
  accounts = await import("./claude-accounts");
});

describe("pickAccount usage-credits policy", () => {
  test("skips a maxed account by default, even with credit headroom", () => {
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 0, monthlyLimit: 100_000 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]))?.id).toBeUndefined();
  });

  test("allowExtraUsage picks a maxed account with credit headroom", () => {
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)?.id).toBe("maxed");
  });

  test("prefers subscription capacity over credits when both are available", () => {
    expect(accounts.pickAccount(undefined, undefined, undefined, true)?.id).toBe("fresh");
  });

  test("no headroom when extra usage is off or the monthly cap is spent", () => {
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: false, usedCredits: 0, monthlyLimit: 100_000 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();

    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 100_001, monthlyLimit: 100_000 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();

    // A zero monthly cap fails closed — this gate exists to bound spend.
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 0, monthlyLimit: 0 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();
  });

  test("getUsableAccountById honors allowExtraUsage the same way", () => {
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 50_000, monthlyLimit: 100_000 })
    );
    expect(accounts.getUsableAccountById("maxed")).toBeUndefined();
    expect(accounts.getUsableAccountById("maxed", undefined, true)?.id).toBe("maxed");
  });

  test("getAccountById returns records regardless of usability", () => {
    expect(accounts.getAccountById("maxed")?.id).toBe("maxed");
    expect(accounts.getAccountById("nope")).toBeUndefined();
  });

  test("does not preemptively sideline accounts from inferred Meridian usage", () => {
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest("maxed", {
      ...usage(100),
      scopedLimits: [{ label: "Fable", utilization: 100, resetsAt: null }],
      source: "meridian",
    });
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, "claude-fable-5")?.id).toBe(
      "maxed"
    );
    accounts.__setUsageCacheForTest("maxed", usage(100));
  });

  test("allows a blind personal account for a singleton Fable requirement", () => {
    expect(
      accounts.pickAccount(undefined, "Jaap", ["claude-fable-5"])?.id
    ).toBe("blind-personal");
  });

  test("requires capacity for every model in a preset", () => {
    accounts.__setUsageCacheForTest("fresh", {
      ...usage(20),
      scopedLimits: [
        { label: "Opus", utilization: 20, resetsAt: null },
        { label: "Fable", utilization: 100, resetsAt: null },
      ],
    });
    expect(
      accounts.pickAccount(new Set(["maxed"]), undefined, "claude-opus-5")?.id
    ).toBe("fresh");
    expect(
      accounts.pickAccount(
        new Set(["maxed"]),
        undefined,
        ["claude-opus-5", "claude-fable-5"]
      )
    ).toBeUndefined();
    accounts.__setUsageCacheForTest("fresh", usage(20));
    expect(
      accounts.pickAccount(
        new Set(["maxed"]),
        undefined,
        ["claude-opus-5", "claude-fable-5"]
      )
    ).toBeUndefined();
    accounts.__setUsageCacheForTest("fresh", usage(50));
  });

  test("personal accounts stay off-limits to userless (automation) picks", () => {
    accounts.__setUsageCacheForTest("personal", usage(0));
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: false, usedCredits: 0, monthlyLimit: 0 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();
  });
});

describe("dry-pool backpressure", () => {
  const maxedWindow = (resetsAt: string | null) => ({
    fetchedAt: new Date().toISOString(),
    fiveHour: { utilization: 100, resetsAt },
    sevenDay: null,
    extraUsage: null,
  });

  test("a maxed account whose cached window already reset counts as usable", () => {
    // Window rolled 1 minute ago but the cache still says 100% — the stale
    // cache must not sideline the account until the next hourly poll.
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest(
      "maxed",
      maxedWindow(new Date(Date.now() - 60_000).toISOString())
    );
    expect(accounts.pickAccount(new Set(["fresh"]))?.id).toBe("maxed");
    // A window that resets in the future still sidelines it.
    accounts.__setUsageCacheForTest(
      "maxed",
      maxedWindow(new Date(Date.now() + 60_000).toISOString())
    );
    expect(accounts.pickAccount(new Set(["fresh"]))).toBeUndefined();
  });

  test("earliestPoolReset reports the sidelined window's reset", () => {
    const resetAt = Date.now() + 5 * 60_000;
    accounts.__setUsageCacheForTest("fresh", maxedWindow(new Date(resetAt).toISOString()));
    accounts.__setUsageCacheForTest("maxed", maxedWindow(new Date(resetAt + 60_000).toISOString()));
    const earliest = accounts.earliestPoolReset();
    expect(earliest).not.toBeNull();
    expect(Math.abs((earliest as number) - resetAt)).toBeLessThan(1000);
  });

  test("earliestPoolReset is now-ish when something is usable", () => {
    accounts.__setUsageCacheForTest("fresh", usage(10));
    const earliest = accounts.earliestPoolReset();
    expect(earliest).not.toBeNull();
    expect((earliest as number) - Date.now()).toBeLessThan(1000);
  });

  test("waitForUsableAccount returns immediately once pick succeeds", async () => {
    accounts.__setUsageCacheForTest("fresh", usage(10));
    const picked = await accounts.waitForUsableAccount({
      pick: () => accounts.pickAccount() ?? null,
      maxWaitMs: 5_000,
      pollMs: 10,
    });
    expect(picked?.id).toBe("fresh");
  });

  test("waitForUsableAccount fails fast when the earliest reset is beyond the budget", async () => {
    const far = new Date(Date.now() + 60 * 60_000).toISOString();
    accounts.__setUsageCacheForTest("fresh", maxedWindow(far));
    accounts.__setUsageCacheForTest("maxed", maxedWindow(far));
    const t0 = Date.now();
    const picked = await accounts.waitForUsableAccount({
      pick: () => accounts.pickAccount() ?? null,
      maxWaitMs: 1_000,
      pollMs: 10,
    });
    expect(picked).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("waitForUsableAccount picks up an account freed while waiting", async () => {
    const soon = new Date(Date.now() + 150).toISOString();
    accounts.__setUsageCacheForTest("fresh", maxedWindow(soon));
    accounts.__setUsageCacheForTest("maxed", maxedWindow(soon));
    const picked = await accounts.waitForUsableAccount({
      pick: () => accounts.pickAccount() ?? null,
      maxWaitMs: 5_000,
      pollMs: 50,
    });
    expect(picked).not.toBeNull();
  });
});

describe("refreshUsageIfNearLimit", () => {
  const agedUsage = (fiveHourPct: number, ageMs: number) => ({
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
    fiveHour: { utilization: fiveHourPct, resetsAt: null },
    sevenDay: null,
    extraUsage: null,
  });
  const min = 60_000;
  let refreshed: string[] = [];
  const arm = () => {
    refreshed = [];
    accounts.__setNearLimitRefresherForTest(async (a) => {
      refreshed.push(a.id);
      return null;
    });
  };

  test("leaves low-utilization accounts alone regardless of cache age", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(50, 55 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(false);
    expect(refreshed).toEqual([]);
  });

  test("refreshes a near-limit account with a stale snapshot", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(92, 6 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(true);
    expect(refreshed).toEqual(["fresh"]);
  });

  test("cooldown: no second refresh right after the first", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(92, 6 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(true);
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(false);
    expect(refreshed).toEqual(["fresh"]);
  });

  test("trusts a recent snapshot even when near the limit", async () => {
    arm();
    accounts.__setUsageCacheForTest("fresh", agedUsage(92, 1 * min));
    expect(await accounts.refreshUsageIfNearLimit("fresh")).toBe(false);
    expect(refreshed).toEqual([]);
  });

  test("lower tier: 75%+ refreshes only once the snapshot is older", async () => {
    arm();
    accounts.__setUsageCacheForTest("maxed", agedUsage(78, 10 * min));
    expect(await accounts.refreshUsageIfNearLimit("maxed")).toBe(false);
    accounts.__setUsageCacheForTest("maxed", agedUsage(78, 25 * min));
    expect(await accounts.refreshUsageIfNearLimit("maxed")).toBe(true);
    expect(refreshed).toEqual(["maxed"]);
  });

  test("unknown account or empty cache refreshes nothing", async () => {
    arm();
    expect(await accounts.refreshUsageIfNearLimit("nope")).toBe(false);
    expect(refreshed).toEqual([]);
  });
});
