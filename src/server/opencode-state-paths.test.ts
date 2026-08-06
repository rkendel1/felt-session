/**
 * Regression pins for the OpenCode engine's on-disk state paths after the
 * Backstage → Open Session rename.
 *
 * The invariant under test: every state path the engine touches derives from
 * the SAME rename-compat dual-read resolution — never a hardcoded
 * `~/.opensession-*` or `~/.opensession-*` literal. When one module hardcodes a
 * name while another resolves, the two disagree exactly when it hurts: the
 * docker adapter mounts `<sessions>/sandbox-runs/<id>` by the resolved name, and
 * an in-container runner resolving differently (or the image only pre-seeding
 * the other name, leaving docker to create the mount parent ROOT-owned)
 * EACCESes on `mkdir <sessions>/opencode` (live failure bks-019f4742-e65c,
 * 2026-07-09, right after the state migration renamed ~/.opensession-* to
 * ~/.opensession-*).
 *
 * These assert cross-module CONSISTENCY at whatever resolution the current
 * host has (pre-migration hosts resolve old names, migrated hosts new ones) —
 * both worlds must agree module-to-module.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";
import { stateDir } from "./paths";
import {
  MERIDIAN_CFG_ROOT,
  OPENCODE_STATE_DIR,
  shardDbPathForKey,
} from "./opencode-runner";
import { configPath } from "./opencode-config";
import { BRIDGE_CWD } from "./anthropic-bridge";
import {
  OPENAI_DATA_ROOT,
  OPENCODE_OPENAI_PLACEHOLDER_REFRESH,
  bindOpenaiAccount,
  buildOpenaiRemoteSeedUpload,
  openaiRemoteSeedDir,
  openaiSeedAuthPath,
} from "./opencode-openai-auth";
import type { CodexAccount } from "./codex-accounts";
import {
  OPENCODE_DB_PATH,
  OPENCODE_TRANSCRIPTS_DIR,
} from "./opencode-transcript";
import { containerStateDirFixups } from "./sandbox/docker";
import { REMOTE_HOME, REMOTE_OPENAI_SEED_DIR } from "./sandbox/adapters/bootstrap";

const HOME = homeDir();

describe("opencode engine state paths (rename-compat consistency)", () => {
  it("instructions/state dir lives under the resolved session store", () => {
    expect(OPENCODE_STATE_DIR).toBe(`${OPENSESSION_SESSIONS_DIR}/opencode`);
  });

  it("meridian cfg, bridge cwd and openai data share one resolved engine dir", () => {
    const engineDir = stateDir("opencode");
    expect(MERIDIAN_CFG_ROOT).toBe(`${engineDir}/meridian-cfg`);
    expect(BRIDGE_CWD).toBe(`${engineDir}/bridge-cwd`);
    expect(OPENAI_DATA_ROOT).toBe(`${engineDir}/openai-data`);
  });

  it("bridge config file resolves through the compat seam", () => {
    expect(configPath()).toBe(
      process.env.OPENSESSION_OPENCODE_CONFIG ||
        stateDir("opencode.json"),
    );
  });

  it("transcript mirror + sqlite store stay on their pinned (un-renamed) homes", () => {
    expect(OPENCODE_TRANSCRIPTS_DIR).toBe(
      process.env.OPENSESSION_OPENCODE_TRANSCRIPTS_DIR || `${HOME}/.claude/projects/-opencode-engine`,
    );
    expect(OPENCODE_DB_PATH).toBe(
      process.env.OPENSESSION_OPENCODE_DB ||
        `${HOME}/.local/share/opencode/opencode.db`,
    );
  });

  it("remote openai seed dir: env seam + one path shape on both sides", () => {
    // The launcher (bootstrap.ts) writes seeds under REMOTE_OPENAI_SEED_DIR
    // and threads that exact dir to the run host via the env seam;
    // bindOpenaiAccount reads it back through openaiRemoteSeedDir(). The two
    // sides must share the env contract and the per-account path shape —
    // never derive them independently.
    expect(openaiRemoteSeedDir()).toBe(
      process.env.OPENSESSION_OPENAI_SEED_DIR,
    );
    expect(REMOTE_OPENAI_SEED_DIR).toBe(`${REMOTE_HOME}/.opensession-openai-seeds`);
    expect(openaiSeedAuthPath(REMOTE_OPENAI_SEED_DIR, "acct-1")).toBe(
      `${REMOTE_HOME}/.opensession-openai-seeds/acct-1/auth.json`,
    );
  });

  it("docker re-owns exactly the sessions-dir mount parents the runner writes under", () => {
    // The EACCES regression: these dirs are docker-created (root) when the
    // image predates the rename — setupContainer must chown them, and they
    // must be the SAME dirs the engine derives its state paths from.
    expect(containerStateDirFixups()).toEqual([
      OPENSESSION_SESSIONS_DIR,
      `${OPENSESSION_SESSIONS_DIR}/sandbox-runs`,
    ]);
    expect(OPENCODE_STATE_DIR.startsWith(`${OPENSESSION_SESSIONS_DIR}/`)).toBe(true);
  });
});

// ── Rotation-proof remote seeding (opencode-openai-auth ↔ bootstrap) ─────────

/** Minimal JWT whose only claim is `exp` (seconds). */
function fakeJwt(expMs: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(expMs / 1000) })}.sig`;
}

describe("shard DB path derivation (pinned)", () => {
  // PINNED: shard DB paths are a pure function of the server pool key. A
  // change here orphans every existing shard DB (sessions silently lose
  // their engine history) — must be deliberate, with a migration.
  it("derives stable paths from pool keys", () => {
    const home = homeDir();
    expect(shardDbPathForKey("bks-ghpr-5024-review")).toBe(
      `${home}/.opensession-sessions/opencode/db/bks-ghpr-5024-review.db`,
    );
    expect(shardDbPathForKey("shared:openai-13fde4f9:alex")).toBe(
      `${home}/.opensession-sessions/opencode/db/shared_openai-13fde4f9_alex.db`,
    );
  });
});

describe("remote openai seed material (rotation-proof contract)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bks-openai-seed-"));
  const prevNew = process.env.OPENSESSION_OPENAI_SEED_DIR;
  const prevOld = process.env.OPENSESSION_OPENAI_SEED_DIR;
  const dataDirs: string[] = [];

  afterAll(() => {
    if (prevNew === undefined) delete process.env.OPENSESSION_OPENAI_SEED_DIR;
    else process.env.OPENSESSION_OPENAI_SEED_DIR = prevNew;
    if (prevOld === undefined) delete process.env.OPENSESSION_OPENAI_SEED_DIR;
    else process.env.OPENSESSION_OPENAI_SEED_DIR = prevOld;
    rmSync(scratch, { recursive: true, force: true });
    for (const d of dataDirs) rmSync(d, { recursive: true, force: true });
  });

  const homeAccount = (id: string, codexHome: string): CodexAccount => ({
    id,
    name: `test-${id}`,
    kind: "home",
    value: codexHome,
    createdAt: new Date().toISOString(),
  });

  it("buildOpenaiRemoteSeedUpload never lets the live refresh token leave the host", () => {
    const codexHome = join(scratch, "codex-live");
    mkdirSync(codexHome, { recursive: true });
    const liveRefresh = "rt-live-SECRET-family-token";
    writeFileSync(
      `${codexHome}/auth.json`,
      JSON.stringify({
        tokens: {
          access_token: fakeJwt(Date.now() + 3_600_000),
          refresh_token: liveRefresh,
          account_id: "acct-42",
        },
      }),
    );
    const expiredHome = join(scratch, "codex-expired");
    mkdirSync(expiredHome, { recursive: true });
    writeFileSync(
      `${expiredHome}/auth.json`,
      JSON.stringify({ tokens: { access_token: fakeJwt(Date.now() - 1000) } }),
    );
    const apiKey: CodexAccount = {
      id: "key-1",
      name: "test-key",
      kind: "api_key",
      value: "sk-test",
      createdAt: new Date().toISOString(),
    };

    const upload = buildOpenaiRemoteSeedUpload(
      [homeAccount("home-ok", codexHome), homeAccount("home-exp", expiredHome), apiKey],
    );
    // Usable home + api_key travel; the expired home account is excluded so
    // the in-sandbox pick can't land on an account that only dies there.
    expect(upload.accounts.map((a) => a.id)).toEqual(["home-ok", "key-1"]);
    expect(upload.skipped.map((s) => s.account.id)).toEqual(["home-exp"]);
    expect(upload.seeds.map((s) => s.accountId)).toEqual(["home-ok"]);
    const seed = JSON.parse(upload.seeds[0].content);
    expect(seed.openai.refresh).toBe(OPENCODE_OPENAI_PLACEHOLDER_REFRESH);
    expect(upload.seeds[0].content).not.toContain(liveRefresh);
    expect(seed.openai.accountId).toBe("acct-42");

    // bridge.openaiAccounts restriction narrows the upload, in list order.
    const restricted = buildOpenaiRemoteSeedUpload(
      [homeAccount("home-ok", codexHome), apiKey],
      ["key-1"],
    );
    expect(restricted.accounts.map((a) => a.id)).toEqual(["key-1"]);
    expect(restricted.seeds).toEqual([]);
  });

  it("bindOpenaiAccount falls back to the uploaded seed and re-stamps the placeholder refresh", () => {
    const account = homeAccount("test-seed-fallback", join(scratch, "codex-home-missing"));
    dataDirs.push(`${OPENAI_DATA_ROOT}/${account.id}`);
    const seedPath = openaiSeedAuthPath(scratch, account.id);
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(
      seedPath,
      // A hostile/corrupt seed carrying a live-looking refresh token: the
      // reader must re-stamp the placeholder, never pass it through.
      JSON.stringify({
        openai: {
          type: "oauth",
          access: fakeJwt(Date.now() + 3_600_000),
          refresh: "rt-live-should-never-survive",
          expires: Date.now() + 3_600_000,
          accountId: "acct-7",
        },
      }),
    );
    process.env.OPENSESSION_OPENAI_SEED_DIR = scratch;
    try {
      const bound = bindOpenaiAccount(account);
      if ("error" in bound) throw new Error(bound.error);
      expect(bound.mechanism).toBe("oauth-subscription-seeded-remote");
      expect(bound.extraEnv.XDG_DATA_HOME).toBe(`${OPENAI_DATA_ROOT}/${account.id}`);
      const written = JSON.parse(
        readFileSync(`${OPENAI_DATA_ROOT}/${account.id}/opencode/auth.json`, "utf-8"),
      );
      expect(written.openai.refresh).toBe(OPENCODE_OPENAI_PLACEHOLDER_REFRESH);
      expect(written.openai.accountId).toBe("acct-7");
    } finally {
      if (prevNew === undefined) delete process.env.OPENSESSION_OPENAI_SEED_DIR;
      else process.env.OPENSESSION_OPENAI_SEED_DIR = prevNew;
    }
  });

  it("expired or missing seeds fail loudly with named errors", () => {
    const account = homeAccount("test-seed-expired", join(scratch, "codex-home-missing"));
    const seedPath = openaiSeedAuthPath(scratch, account.id);
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(
      seedPath,
      JSON.stringify({
        openai: { type: "oauth", access: fakeJwt(Date.now() - 1000), expires: Date.now() - 1000 },
      }),
    );
    process.env.OPENSESSION_OPENAI_SEED_DIR = scratch;
    try {
      const expired = bindOpenaiAccount(account);
      expect("error" in expired && expired.error).toContain("expired");
      const missing = bindOpenaiAccount(
        homeAccount("test-seed-absent", join(scratch, "codex-home-missing")),
      );
      expect("error" in missing && missing.error).toContain("no uploaded seed");
    } finally {
      if (prevNew === undefined) delete process.env.OPENSESSION_OPENAI_SEED_DIR;
      else process.env.OPENSESSION_OPENAI_SEED_DIR = prevNew;
    }
  });
});
