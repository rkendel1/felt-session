/**
 * Sandbox provider CONFORMANCE suite (the sandbox rollout plan, Phase 3.3) —
 * the verify.ts checks parameterized over providers. Run MANUALLY:
 *
 *   bun run deploy/sandbox/conformance.ts [docker-socket] [docker-ws] [daytona] [e2b] [box] [modal] [lambda-microvm]
 *
 * (no args = the full matrix). Per entry: ensure/reuse, exec argv+stderr
 * semantics, workspace git (bind worktree for docker, in-sandbox volume-style
 * clone for remote), ports() shape, a real launchRun round-trip + steer +
 * cancel (cheapest Claude model, only when an account pool exists — and for
 * remote entries only when the sandbox can actually reach this host's
 * dial-back listener), get() reattach, destroy.
 *
 * - docker-socket / docker-ws ALWAYS run (docker is the self-host default —
 *   this host must keep them fully green).
 * - daytona / e2b run ONLY when credentials are configured — the suite lifts
 *   them from the LIVE ~/.opensession-sandbox.json provider blocks (or
 *   DAYTONA_API_KEY / E2B_API_KEY). Without credentials the section prints
 *   `SKIPPED: no credentials` and does NOT fake success; a key-holder gets
 *   the full matrix. Remote entries create at most ONE smallest-size sandbox
 *   each, sbxtest-labeled, and destroy it; the section ends by listing the
 *   provider's sandboxes to prove nothing was left behind.
 * - Remote workspaces clone github.com/octocat/Hello-World (tiny, public);
 *   the runner bundle clones THIS repo's origin, so a private origin needs
 *   `cloneCredential` — the suite auto-wires a GitHub token from
 *   GITHUB_API_TOKEN or ~/.slack-agent.env when present.
 *
 * Everything is sbxtest-prefixed; the run journal, sandbox config, chat-store
 * dir AND repo-registry config are redirected to a scratch dir BEFORE any
 * src/server import, so nothing here touches the live server's config,
 * active-runs.json, or ~/.opensession-sessions (state files, sandbox-runs, and the
 * disable-* kill switches all resolve under the scratch dir). API keys are
 * read from the live config file but only ever written into the scratch
 * config — never logged.
 */

const SCRATCH = `${process.env.HOME || homedir()}/.sandbox-conformance-scratch`;
process.env.OPENSESSION_RUN_JOURNAL = `${SCRATCH}/active-runs.json`;
process.env.OPENSESSION_SANDBOX_CONFIG = `${SCRATCH}/sandbox-config.json`;
// Provider state files + sandbox-runs dirs land under OPENSESSION_SESSIONS_DIR —
// point it at the scratch dir so sbxtest state never lands in the live store.
process.env.OPENSESSION_SESSIONS_DIR = `${SCRATCH}/sessions`;
// The repo registry is config-driven (REPOS is a read-only Proxy over
// configuredRepos() — worktree.ts/config.ts): scratch repos are registered
// through a scratch ~/.opensession/config.json written below, same pattern as
// verify.ts. The live box has no config.json, so this only ADDS the scratch
// repos over the built-in defaults.
process.env.OPENSESSION_CONFIG = `${SCRATCH}/opensession-config.json`;

import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";

const { getSandboxProvider } = await import("../../src/server/sandbox/index");
const runWs = await import("../../src/server/run-ws");
const { hostRunBusy } = await import("../../src/server/host-registry");
const { OPENSESSION_SESSIONS_DIR } = await import("../../src/server/paths");
const { statePath } = await import("../../src/server/paths");
// The orphan-snapshot sweep (docker.ts, piggybacked on the idle sweep) reads
// session/state files through the — now scratch-redirected — chats dir, so it
// would see every LIVE session as gone. Arm its once-an-hour throttle up
// front so it never runs inside this suite.
(globalThis as unknown as { __sandboxSnapOrphanSweepAt?: number }).__sandboxSnapOrphanSweepAt =
  Date.now();
type RunHostSpec = import("../../src/runner-host/protocol").RunHostSpec;
type Sandbox = import("../../src/server/sandbox/provider").Sandbox;
type PortMap = import("../../src/server/sandbox/provider").PortMap;

const RUN_TS = Date.now().toString(36);
const HOME = process.env.HOME || homedir();

// ── result plumbing ───────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];
let section = "";

function ok(name: string, cond: boolean, detail = ""): void {
  const label = `[${section}] ${name}`;
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sh(cmd: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

// ── credentials (never logged) ────────────────────────────────────────────────

function liveSandboxFileConfig(): any {
  for (const path of [`${HOME}/.opensession-sandbox.json`, `${HOME}/.opensession-sandbox.json`]) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {}
  }
  return {};
}
const liveCfg = liveSandboxFileConfig();
const daytonaKey: string = liveCfg?.daytona?.apiKey || process.env.DAYTONA_API_KEY || "";
const e2bKey: string = liveCfg?.e2b?.apiKey || process.env.E2B_API_KEY || "";
const boxKey: string = liveCfg?.box?.apiKey || process.env.BOX_API_KEY || "";
const boxApiUrl: string = liveCfg?.box?.apiUrl || "https://ascii.dev/api/box/v1";
const modalTokenId: string = liveCfg?.modal?.tokenId || process.env.MODAL_TOKEN_ID || "";
const modalTokenSecret: string =
  liveCfg?.modal?.tokenSecret || process.env.MODAL_TOKEN_SECRET || "";
const modalProfileAvailable = existsSync(process.env.MODAL_CONFIG_PATH || `${HOME}/.modal.toml`);
const lambdaMicrovmImage: string = liveCfg?.awsLambdaMicrovm?.imageIdentifier || "";

function githubToken(): string {
  if (process.env.GITHUB_API_TOKEN) return process.env.GITHUB_API_TOKEN;
  try {
    const m = readFileSync(`${HOME}/.slack-agent.env`, "utf-8").match(/^GITHUB_API_TOKEN=(\S+)/m);
    return m?.[1] || "";
  } catch {
    return "";
  }
}

// ── account pool gate (real model runs) ───────────────────────────────────────

let hasAccounts = false;
try {
  const store = JSON.parse(
    readFileSync(
      process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH ||
        statePath(".opensession-claude-accounts.json"),
      "utf-8",
    ),
  );
  hasAccounts = Array.isArray(store.accounts) && store.accounts.length > 0;
} catch {}

// ── scratch repos ─────────────────────────────────────────────────────────────
// Local repo + worktree for the docker (bind) entries; a public GitHub repo
// registration for remote volume-style clones.

const MAIN = `${SCRATCH}/main-repo`;
const WT = `${SCRATCH}/wt-conf`;
const BARE = `${SCRATCH}/origin.git`;
const PUB_REPO_ID = "sbxpub";
const PUB_BRANCH = `sbxtest-conf-${RUN_TS}`;

mkdirSync(SCRATCH, { recursive: true });
for (const p of [MAIN, WT, BARE]) rmSync(p, { recursive: true, force: true });
mkdirSync(MAIN, { recursive: true });
for (const c of [
  ["git", "init", "-q", "-b", "main"],
  ["git", "config", "user.email", "sbxtest@opensession.local"],
  ["git", "config", "user.name", "Sandbox Conformance"],
]) await sh(c, MAIN);
await Bun.write(`${MAIN}/README.md`, "sandbox conformance scratch repo\n");
await sh(["git", "add", "README.md"], MAIN);
await sh(["git", "commit", "-q", "-m", "init"], MAIN);
await sh(["git", "clone", "-q", "--bare", MAIN, BARE]);
await sh(["git", "remote", "add", "origin", BARE], MAIN);
await sh(["git", "worktree", "add", "-q", WT, "-b", "sbxtest-conf-branch"], MAIN);
// Register the scratch repos through the config-driven registry (REPOS is a
// read-only Proxy now; OPENSESSION_CONFIG points at this scratch file — same
// pattern as verify.ts). sbxpub is the remote workspace source: tiny public
// repo whose `repo` path has no git checkout, so remoteCloneUrl falls through
// to ghRepo's https URL.
await Bun.write(
  process.env.OPENSESSION_CONFIG!,
  JSON.stringify({
    repos: {
      sbxtest: { repo: MAIN, wtPrefix: "sbxtest", defaultBranch: "main", ghRepo: "sbxtest/sbxtest" },
      [PUB_REPO_ID]: {
        repo: `${SCRATCH}/no-local-checkout`,
        wtPrefix: PUB_REPO_ID,
        defaultBranch: "master",
        ghRepo: "octocat/Hello-World",
      },
    },
  }),
);

// ── shared dial-back WS server (docker-ws + remote entries) ──────────────────

// Overrides for hosts where the public IP doesn't accept inbound connections
// (typical cloud security groups): pin the listener port and front it with any
// websocket-capable tunnel (cloudflared quick tunnel, tailscale funnel, …) or
// — the permanent setup — the publicIngress Caddy path routes (docs/
// self-hosting-sandboxes.md), which forward ONLY /run-ws/*,
// /rpc-ws and /ingress-health; the remote probe uses the last one.
//   SBX_CONF_LISTEN_PORT=3860 SBX_CONF_PUBLIC_BASE=wss://sessions.example.com \
//     bun run deploy/sandbox/conformance.ts daytona
const LISTEN_PORT = parseInt(process.env.SBX_CONF_LISTEN_PORT || "0", 10) || 0;
const PUBLIC_BASE = (process.env.SBX_CONF_PUBLIC_BASE || "").replace(/\/+$/, "");

const wsSrv = Bun.serve({
  port: LISTEN_PORT,
  hostname: "0.0.0.0",
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/ping") return new Response("pong");
    if (path === "/ingress-health") return new Response("ok"); // public-ingress parity
    return runWs.handleSandboxWsUpgrade(req, server, path) ?? undefined;
  },
  websocket: {
    open(ws) {
      runWs.sandboxWsOpen(ws);
    },
    message(ws, m) {
      runWs.sandboxWsMessage(ws, m as any);
    },
    close(ws) {
      runWs.sandboxWsClose(ws);
    },
  },
});
const bridgeGw =
  (await sh(["docker", "network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"])).out.trim() ||
  "172.17.0.1";
const publicIp = (await (async () => {
  try {
    return (await (await fetch("https://checkip.amazonaws.com", { signal: AbortSignal.timeout(5000) })).text()).trim();
  } catch {
    return "";
  }
})());
/** Base URL remote sandboxes dial back to; docker uses the bridge gateway. */
const remoteBase = PUBLIC_BASE || (publicIp ? `ws://${publicIp}:${wsSrv.port}` : "");
console.log(
  `dial-back listener on 0.0.0.0:${wsSrv.port} (bridge ${bridgeGw}, remote base ${remoteBase || "unknown"})`,
);

// ── matrix entries ────────────────────────────────────────────────────────────

interface Entry {
  name: string;
  providerId:
    | "docker"
    | "daytona"
    | "e2b"
    | "box"
    | "modal"
    | "lambda-microvm";
  /** null = run it; string = print SKIPPED reason. */
  skip: string | null;
  /** Scratch config for this entry (credentials included, never logged). */
  config: Record<string, unknown>;
  /** Session spec pieces. */
  repoId: string;
  branch?: string;
  cwd?: string;
  /** Expected ports() entry shape for the configured preview port. */
  expectPort: "hostPort" | "url" | "none";
  /** Remote = workspace exists only in-sandbox. */
  remote: boolean;
}

const PREVIEW_PORT = 18755;

const entries: Entry[] = [
  {
    name: "docker-socket",
    providerId: "docker",
    skip: null,
    config: { provider: "docker", previewPorts: [PREVIEW_PORT] },
    repoId: "sbxtest",
    cwd: WT,
    expectPort: "hostPort",
    remote: false,
  },
  {
    name: "docker-ws",
    providerId: "docker",
    skip: null,
    config: {
      provider: "docker",
      transport: "ws",
      callbackBaseUrl: `ws://${bridgeGw}:${wsSrv.port}`,
      previewPorts: [PREVIEW_PORT],
    },
    repoId: "sbxtest",
    cwd: WT,
    expectPort: "hostPort",
    remote: false,
  },
  {
    name: "daytona",
    providerId: "daytona",
    skip: daytonaKey ? null : "SKIPPED: no credentials (set daytona.apiKey in ~/.opensession-sandbox.json or DAYTONA_API_KEY)",
    config: {
      provider: "daytona",
      callbackBaseUrl: remoteBase,
      previewPorts: [8080],
      daytona: { apiKey: daytonaKey },
      // Warm-on-typing prewarm (src/server/sandbox/prewarm.ts): the section
      // prewarms BEFORE the first ensure, which must then ADOPT the warmed
      // sandbox (same id, seconds not minutes) — total sandbox count stays 1.
      prewarm: { enabled: true, ttlMinutes: 20, maxLive: 2 },
      ...(githubToken() ? { cloneCredential: { type: "https-token", token: githubToken() } } : {}),
    },
    repoId: PUB_REPO_ID,
    branch: PUB_BRANCH,
    expectPort: "url",
    remote: true,
  },
  {
    name: "e2b",
    providerId: "e2b",
    skip: e2bKey ? null : "SKIPPED: no credentials (set e2b.apiKey in ~/.opensession-sandbox.json or E2B_API_KEY)",
    config: {
      provider: "e2b",
      callbackBaseUrl: remoteBase,
      previewPorts: [8080],
      e2b: { apiKey: e2bKey },
      ...(githubToken() ? { cloneCredential: { type: "https-token", token: githubToken() } } : {}),
    },
    repoId: PUB_REPO_ID,
    branch: PUB_BRANCH,
    expectPort: "url",
    remote: true,
  },
  {
    name: "box",
    providerId: "box",
    skip: boxKey ? null : "SKIPPED: no credentials (set box.apiKey in ~/.opensession-sandbox.json or BOX_API_KEY)",
    config: {
      provider: "box",
      callbackBaseUrl: remoteBase,
      previewPorts: [8080],
      box: { apiKey: boxKey },
      ...(githubToken() ? { cloneCredential: { type: "https-token", token: githubToken() } } : {}),
    },
    repoId: PUB_REPO_ID,
    branch: PUB_BRANCH,
    expectPort: "url",
    remote: true,
  },
  {
    name: "modal",
    providerId: "modal",
    skip:
      (modalTokenId && modalTokenSecret) || modalProfileAvailable
        ? null
        : "SKIPPED: no credentials (set modal.tokenId/tokenSecret in ~/.opensession-sandbox.json or MODAL_TOKEN_ID/MODAL_TOKEN_SECRET)",
    config: {
      provider: "modal",
      callbackBaseUrl: remoteBase,
      previewPorts: [8080],
      modal: {
        ...(modalTokenId && modalTokenSecret
          ? { tokenId: modalTokenId, tokenSecret: modalTokenSecret }
          : {}),
        ...(liveCfg?.modal?.profile ? { profile: liveCfg.modal.profile } : {}),
        ...(liveCfg?.modal?.image ? { image: liveCfg.modal.image } : {}),
        ...(liveCfg?.modal?.environment ? { environment: liveCfg.modal.environment } : {}),
        publicPreviews: true,
      },
      ...(githubToken() ? { cloneCredential: { type: "https-token", token: githubToken() } } : {}),
    },
    repoId: PUB_REPO_ID,
    branch: PUB_BRANCH,
    expectPort: "url",
    remote: true,
  },
  {
    name: "lambda-microvm",
    providerId: "lambda-microvm",
    skip: lambdaMicrovmImage
      ? null
      : "SKIPPED: no image (set awsLambdaMicrovm.imageIdentifier in ~/.opensession-sandbox.json)",
    config: {
      provider: "lambda-microvm",
      callbackBaseUrl: remoteBase,
      awsLambdaMicrovm: liveCfg?.awsLambdaMicrovm || {},
      ...(githubToken() ? { cloneCredential: { type: "https-token", token: githubToken() } } : {}),
    },
    repoId: PUB_REPO_ID,
    branch: PUB_BRANCH,
    expectPort: "none",
    remote: true,
  },
];

const wanted = process.argv.slice(2);
const selected = entries.filter((e) => !wanted.length || wanted.includes(e.name));

// ── the parameterized checks ──────────────────────────────────────────────────

async function runEntry(entry: Entry): Promise<void> {
  section = entry.name;
  console.log(`\n══ ${entry.name} ══`);
  if (entry.skip) {
    console.log(`  ${entry.skip}`);
    return;
  }
  await Bun.write(process.env.OPENSESSION_SANDBOX_CONFIG!, JSON.stringify(entry.config));
  const provider = getSandboxProvider(entry.providerId);
  const sessionId = `sbxtest-conf-${entry.name}-${RUN_TS}`;
  const spec = {
    sessionId,
    repo: entry.repoId,
    branch: entry.branch,
    cwd: entry.cwd,
    mode: "code" as const,
  };

  // 0. warm-on-typing prewarm (remote entries with prewarm.enabled): request
  //    a prewarm the way the typing route does, wait for ready, and expect
  //    the ensure below to ADOPT it — an adopted ensure only does the
  //    dial-back probe + marker check + workspace clone (seconds), never the
  //    cold runner bootstrap (minutes).
  let prewarmedId = "";
  if (entry.remote && (entry.config as any).prewarm?.enabled) {
    const { requestPrewarm } = await import("../../src/server/sandbox/prewarm");
    const tP = Date.now();
    let st = await requestPrewarm(entry.providerId, entry.repoId, "sbxtest");
    ok("prewarm request accepted", st.state === "bootstrapping" || st.state === "ready", st.state);
    const deadline = Date.now() + 900_000;
    while (st.state === "bootstrapping" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      st = await requestPrewarm(entry.providerId, entry.repoId, "sbxtest");
    }
    ok(
      "prewarm reached ready",
      st.state === "ready" && !!st.sandboxId,
      `${st.state} in ${((Date.now() - tP) / 1000).toFixed(0)}s`,
    );
    prewarmedId = st.sandboxId || "";
  }

  let sandbox: Sandbox | null = null;
  try {
    // 1. ensure / reuse
    const t0 = Date.now();
    sandbox = await provider.ensure(spec);
    const ensureMs = Date.now() - t0;
    ok("ensure() created the sandbox", !!sandbox.id, `${sandbox.id} in ${(ensureMs / 1000).toFixed(1)}s`);
    if (prewarmedId) {
      ok(
        "ensure() adopted the prewarmed sandbox",
        sandbox.id === prewarmedId,
        `ensure ${sandbox.id} vs prewarm ${prewarmedId}`,
      );
      ok(
        "adopted ensure skipped the cold bootstrap",
        sandbox.id === prewarmedId && ensureMs < 90_000,
        `${(ensureMs / 1000).toFixed(1)}s`,
      );
    }
    ok("status() is running", (await sandbox.status()) === "running");
    const t1 = Date.now();
    const again = await provider.ensure(spec);
    ok("ensure() is idempotent (reuse)", again.id === sandbox.id, `${((Date.now() - t1) / 1000).toFixed(1)}s`);

    // 2. exec — argv semantics, exit codes, stderr separation
    const argv = await sandbox.exec(["printf", "%s", "a b$c'd"]);
    ok("exec preserves argv words (quoting)", argv.exitCode === 0 && argv.stdout === "a b$c'd", JSON.stringify(argv.stdout));
    const code = await sandbox.exec(["sh", "-c", "exit 7"]);
    ok("exec surfaces the real exit code", code.exitCode === 7, String(code.exitCode));
    const streams = await sandbox.exec(["sh", "-c", "echo up; echo down >&2"]);
    ok(
      "exec separates stdout from stderr",
      streams.stdout.includes("up") && !streams.stdout.includes("down") && streams.stderr.includes("down"),
      JSON.stringify({ out: streams.stdout.trim(), err: streams.stderr.trim() }),
    );
    const envd = await sandbox.exec(["sh", "-c", "printf %s \"$SBX_CONF\""], { env: { SBX_CONF: "e1" } });
    ok("exec threads env", envd.stdout === "e1", JSON.stringify(envd.stdout));

    // 3. workspace git
    const status = await sandbox.exec(["git", "status", "--porcelain"]);
    ok("git works in the workspace", status.exitCode === 0, status.stderr.trim().slice(0, 120));
    const branch = await sandbox.exec(["git", "branch", "--show-current"]);
    const expectBranch = entry.branch || "sbxtest-conf-branch";
    ok("workspace is on the session branch", branch.stdout.trim() === expectBranch, branch.stdout.trim());
    await sandbox.exec(["sh", "-c", "echo conf > sbx-conf-file.txt"]);
    const dirty = await sandbox.exec(["git", "status", "--porcelain"]);
    ok("workspace edits are visible to git", dirty.stdout.includes("sbx-conf-file.txt"));
    if (entry.remote) {
      ok("no host dir was created (volume-style workspace)", !existsSync(sandbox.cwd), sandbox.cwd);
    }

    // 4. ports() shape
    const ports: PortMap = await sandbox.ports();
    const portEntry = ports[entry.expectPort === "url" ? 8080 : PREVIEW_PORT];
    if (entry.expectPort === "hostPort") {
      ok("ports() maps to a numeric host port", typeof portEntry === "number" && portEntry > 0, JSON.stringify(ports));
    } else if (entry.expectPort === "url") {
      ok(
        "ports() maps to a preview url",
        typeof portEntry === "object" && !!portEntry?.url?.startsWith("http"),
        typeof portEntry === "object" ? portEntry?.url : JSON.stringify(ports),
      );
    }

    // 5. dial-back reachability (remote entries must reach this listener for
    //    launchRun; docker reaches it via the bridge gateway).
    // Remote entries probe /ingress-health — the path a publicIngress front
    // (Caddy/tunnel) actually forwards; /ping only exists on direct listeners.
    const probeUrl = entry.remote
      ? remoteBase && `${remoteBase.replace(/^ws(s?):\/\//, "http$1://")}/ingress-health`
      : `http://${bridgeGw}:${wsSrv.port}/ping`;
    let reachable = false;
    if (probeUrl) {
      const probe = await sandbox.exec([
        "sh", "-c", `curl -s -m 8 ${probeUrl} || echo UNREACHABLE`,
      ]);
      reachable = probe.stdout.includes("pong") || /\bok\b/.test(probe.stdout);
      if (entry.remote && !reachable) {
        // Environment property, not an adapter defect: e.g. Daytona Tier 1/2
        // orgs restrict sandbox egress to an allowlist, so no callbackBaseUrl
        // can be reached from inside. Reported loudly (launchRun stays
        // UNCERTIFIED below) but doesn't fail the matrix — a Tier-3/self-
        // hosted operator with real egress gets the full launchRun checks.
        console.warn(
          `  ! dial-back listener NOT reachable from the sandbox (${probe.stdout.trim().slice(0, 80)})` +
            ` — launchRun cannot be certified in this environment; fix egress/callbackBaseUrl`,
        );
      } else {
        ok(`dial-back listener reachable from the sandbox`, reachable, probe.stdout.trim().slice(0, 60));
      }
    } else {
      console.log("  (no public IP/base — skipping reachability probe)");
    }

    // 6. launchRun round-trip + steer + cancel (cheapest model; gated)
    const wsTransport = entry.remote || entry.config.transport === "ws";
    if (!hasAccounts) {
      console.log("  (dry-run: no account pool — skipping launchRun checks)");
    } else if (wsTransport && !reachable) {
      console.log("  (skipping launchRun: sandbox cannot reach the dial-back listener)");
      // Runner-payload smoke: prove the bootstrapped payload actually RUNS —
      // HOST_ENTRY loads its full module graph (agent-runner and friends from
      // the in-sandbox bun install) and reaches its "dialing" state. This
      // certifies everything about launchRun except the provider's egress
      // (e.g. Daytona Tier-1/2 sandboxes cannot reach arbitrary hosts).
      if (entry.remote) {
        const { HOST_ENTRY, HOST_SPEC_NAME } = await import("../../src/runner-host/protocol");
        const smokeDir = `/home/ubuntu/.bks-runs/smoke-${RUN_TS}`;
        const smokeSpec = {
          hostId: `rh-smoke-${RUN_TS}`,
          osSessionId: sessionId,
          prompt: "smoke",
          // Deliberately nonexistent: the run itself must die instantly (no
          // model call happens without a valid workspace) — the check only
          // cares that the payload BOOTS and reaches the transport.
          cwd: "/nonexistent-bks-smoke",
        };
        const boot = await sandbox.exec([
          "sh", "-c",
          `mkdir -p ${smokeDir} && cat > ${smokeDir}/${HOST_SPEC_NAME} <<'EOF'\n${JSON.stringify(smokeSpec)}\nEOF\n` +
            `env HOME=/home/ubuntu OPENSESSION_RUN_WS_URL=ws://127.0.0.1:9/dead OPENSESSION_RUN_WS_TOKEN=smoke ` +
            `OPENSESSION_RUN_JOURNAL=${smokeDir}/journal.json nohup /home/ubuntu/.bun/bin/bun run ${HOST_ENTRY} ` +
            `${smokeDir}/${HOST_SPEC_NAME} > ${smokeDir}/host.log 2>&1 & echo started`,
        ]);
        let smokeLog = "";
        const smokeDeadline = Date.now() + 90_000;
        while (Date.now() < smokeDeadline && !/dialing/.test(smokeLog)) {
          await new Promise((r) => setTimeout(r, 3000));
          smokeLog = (await sandbox.exec(["cat", `${smokeDir}/host.log`])).stdout;
        }
        ok(
          "runner payload boots in-sandbox (HOST_ENTRY reaches its dialing state)",
          boot.exitCode === 0 && /dialing ws:/.test(smokeLog),
          smokeLog.split("\n").slice(-2).join(" | ").slice(0, 160),
        );
        await sandbox.exec(["sh", "-c", "pkill -f runner-host/host.ts || true"]);
      }
    } else {
      const runSpec: RunHostSpec = {
        hostId: `rh-conf-${entry.name}-${RUN_TS}`,
        osSessionId: sessionId,
        prompt: "Reply with exactly: OK",
        cwd: sandbox.cwd,
        mode: "ask",
        model: "claude-haiku-4-5",
        mcpServers: [],
        journalKind: "sandbox-conformance",
      };
      // REGRESSION (2026-07-09 launch→attach stalls, bks-019f46e9/bks-019f4729):
      // the launch's attach chain must never wait behind another long-running
      // exec on the provider — start one concurrently (same client instance +
      // HTTP lanes as a prewarm bootstrap's `bun install`; a second paid
      // sandbox is not created for cost discipline) and require the EAGER
      // launch (spec write → host exec → dial-back → consumer attach) to
      // finish inside 10s. The long exec is abandoned; the remote process
      // dies with the destroy below.
      let longExec: Promise<unknown> | null = null;
      if (entry.remote) {
        longExec = sandbox
          .exec(["sh", "-c", "sleep 90; echo long-exec-done"])
          .catch(() => {});
      }
      const t2 = Date.now();
      let handle: import("../../src/server/sandbox/provider").RunHandle;
      try {
        handle = sandbox.launchRunEager
          ? await sandbox.launchRunEager(runSpec, {})
          : sandbox.launchRun(runSpec, {});
      } catch (e) {
        ok("launch attached (eager)", false, String(e).slice(0, 160));
        throw e;
      }
      if (entry.remote) {
        const attachMs = Date.now() - t2;
        ok(
          "launch attaches during a concurrent long exec (<10s)",
          !!sandbox.launchRunEager && attachMs < 10_000,
          `${attachMs}ms`,
        );
        void longExec;
      }
      const events: string[] = [];
      let text = "";
      let sawInit = false;
      const consume = (async () => {
        for await (const ev of handle.events()) {
          events.push(ev.type);
          if (ev.type === "init") sawInit = true;
          if (ev.type === "text_chunk") text += ev.text || "";
          if (ev.type === "done" || ev.type === "error") return ev;
        }
        return null;
      })();
      const result = await Promise.race([
        consume,
        new Promise<null>((r) => setTimeout(() => r(null), 240_000)),
      ]);
      if (!result) handle.cancel();
      ok("launchRun streamed init", sawInit, events.slice(0, 6).join(","));
      ok(
        "launchRun finished with done",
        result?.type === "done",
        result
          ? `${result.type}: ${String(result.result || result.content || "").slice(0, 120)} (${((Date.now() - t2) / 1000).toFixed(1)}s)`
          : "timed out after 240s",
      );
      ok("model replied", /\bOK\b/i.test(text) || /\bOK\b/i.test(String(result?.result || "")), JSON.stringify(text.slice(0, 60)));

      // steer + cancel on a second short run
      const cancelSpec: RunHostSpec = {
        ...runSpec,
        hostId: `rh-conf-cancel-${entry.name}-${RUN_TS}`,
        prompt: "Count from 1 to 400, one number per line. Do not stop early.",
      };
      const cHandle = sandbox.launchRun(cancelSpec, {});
      let cInit = false;
      const cConsume = (async () => {
        for await (const ev of cHandle.events()) {
          if (ev.type === "init") cInit = true;
        }
      })();
      const cDeadline = Date.now() + 90_000;
      while (!cInit && Date.now() < cDeadline) await new Promise((r) => setTimeout(r, 500));
      ok("second run started (for steer/cancel)", cInit);

      // WS transport resilience: kill the dialed-in connection server-side
      // mid-run. The host must redial (≤5s backoff), replay the disconnect
      // window (seq/ack — ws-buffer.ts), and the handle must reattach so
      // steer/cancel below still land. Replay-exactly-once semantics are
      // unit-tested in src/server/zz-run-ws.test.ts; this proves the live
      // wiring end-to-end on a real run.
      if (wsTransport) {
        ok("ws connection dropped server-side (mid-run)", runWs.dropRunWsConnection(cancelSpec.hostId));
        let redialed = false;
        const wsDeadline = Date.now() + 30_000;
        while (!redialed && Date.now() < wsDeadline) {
          await new Promise((r) => setTimeout(r, 500));
          redialed = runWs.hasLiveRunWsConnection(cancelSpec.hostId);
        }
        ok("host redialed after the drop", redialed);
      }

      // The handle reconnects on its own cadence (2s polls) after a ws drop —
      // retry the steer until it lands instead of asserting the first attempt.
      let steered = cHandle.steer("Nudge: you may stop early.");
      const steerDeadline = Date.now() + 30_000;
      while (!steered && Date.now() < steerDeadline) {
        await new Promise((r) => setTimeout(r, 1000));
        steered = cHandle.steer("Nudge: you may stop early.");
      }
      ok("steer delivered", steered);
      ok("cancel delivered", cHandle.cancel());
      const cEnded = await Promise.race([
        cConsume.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 90_000)),
      ]);
      ok("cancelled run's stream terminated", cEnded === true);
      ok("session not busy after cancel", !hostRunBusy(sessionId));
    }

    // 7. get() reattach
    const got = await provider.get(sandbox.id);
    ok("get() reattaches by id", got !== null && got.cwd === sandbox.cwd, got?.cwd);
  } finally {
    // 8. destroy — always, even on failures above (paid remote compute).
    if (sandbox) {
      await provider.destroy(sandbox.id);
      const gone = (await (await provider.get(sandbox.id))?.status()?.catch(() => "gone")) ?? "gone";
      ok("destroy() removed the sandbox", gone === "gone", String(gone));
      ok(
        "provider state file removed",
        !existsSync(`${OPENSESSION_SESSIONS_DIR}/sandboxes/${entry.providerId}-${sandbox.id}.json`) &&
          !existsSync(`${OPENSESSION_SESSIONS_DIR}/sandboxes/${sandbox.id}.json`),
      );
    }
  }
}

// ── leftovers audit (remote providers — paid compute must be zero after) ─────

async function auditDaytonaLeftovers(): Promise<void> {
  if (!daytonaKey) return;
  section = "daytona";
  try {
    const { Daytona } = await import("@daytonaio/sdk");
    const client = new Daytona({ apiKey: daytonaKey });
    const listLeftovers = async (): Promise<Array<{ id: string; state: string }>> => {
      const out: Array<{ id: string; state: string }> = [];
      for await (const s of client.list({ labels: { "opensession.sandbox": "1" } } as any)) {
        // Deletion is async server-side — a sandbox mid-teardown still lists
        // with its labels (and even state "started") for a few seconds.
        const state = String((s as any).state || "");
        if (/destroy|delet/i.test(state)) continue;
        // ONLY sbxtest-labeled sandboxes count as suite leftovers. The API
        // key may be the LIVE org's: real sessions' sandboxes carry the same
        // opensession.sandbox=1 label, and reaping those here would destroy a
        // live session's workspace out from under it. Prewarm sandboxes
        // (opensession.prewarm=1) have no session label — the suite's carry a
        // prewarm key whose repo id is sbx-prefixed (sbxpub); the live
        // pool's (daytona:tella-fusion, …) are equally off-limits here.
        const labels = (s as any).labels || {};
        const session = String(labels["opensession.session"] || "");
        const prewarmRepo = String(labels["opensession.prewarm.key"] || "").split(":")[1] || "";
        if (!session.startsWith("sbxtest-") && !prewarmRepo.startsWith("sbx")) continue;
        out.push({ id: (s as any).id, state });
      }
      return out;
    };
    let leftovers = await listLeftovers();
    if (leftovers.length) {
      // Give in-flight deletions a moment to propagate before flagging.
      await new Promise((r) => setTimeout(r, 15_000));
      leftovers = await listLeftovers();
    }
    ok(
      "no backstage-labeled daytona sandboxes left behind",
      leftovers.length === 0,
      leftovers.map((l) => `${l.id}(${l.state})`).join(",") || "none",
    );
    for (const { id } of leftovers) {
      console.warn(`  cleaning up leftover daytona sandbox ${id}`);
      try {
        const sbx = await client.get(id);
        await client.delete(sbx, 120);
      } catch (e) {
        console.warn(`  cleanup of ${id} failed:`, String(e).slice(0, 200));
      }
    }
  } catch (e) {
    ok("daytona leftovers audit ran", false, String(e).slice(0, 200));
  }
}

async function auditE2bLeftovers(): Promise<void> {
  if (!e2bKey) return;
  section = "e2b";
  try {
    const { Sandbox } = await import("e2b");
    const listLeftovers = async (): Promise<string[]> => {
      // Same paginator dance as the adapter's findSandboxId — the SDK's list
      // return shape varies across versions.
      const paginator: any = (Sandbox as any).list({
        apiKey: e2bKey,
        query: { metadata: { opensessionSandbox: "1" } },
      });
      const infos: any[] = Array.isArray(paginator)
        ? paginator
        : typeof paginator?.nextItems === "function"
          ? await paginator.nextItems()
          : await paginator;
      // Same live-account guard as the daytona audit: only sbxtest sessions
      // are suite leftovers — never reap a real session's sandbox.
      return (infos || [])
        .filter((s: any) => String(s.metadata?.bksSession || "").startsWith("sbxtest-"))
        .map((s: any) => String(s.sandboxId || s.id || ""))
        .filter(Boolean);
    };
    let leftovers = await listLeftovers();
    if (leftovers.length) {
      // Kills are async server-side — give in-flight teardowns a moment.
      await new Promise((r) => setTimeout(r, 15_000));
      leftovers = await listLeftovers();
    }
    ok(
      "no backstage-labeled e2b sandboxes left behind",
      leftovers.length === 0,
      leftovers.join(",") || "none",
    );
    for (const id of leftovers) {
      console.warn(`  cleaning up leftover e2b sandbox ${id}`);
      try {
        await (Sandbox as any).kill(id, { apiKey: e2bKey });
      } catch (e) {
        console.warn(`  cleanup of ${id} failed:`, String(e).slice(0, 200));
      }
    }
  } catch (e) {
    ok("e2b leftovers audit ran", false, String(e).slice(0, 200));
  }
}

async function auditBoxLeftovers(): Promise<void> {
  if (!boxKey) return;
  section = "box";
  try {
    // Box has no labels — the adapter names boxes with their session id, so
    // suite leftovers are exactly the ones named sbxtest-*. Same live-account
    // guard as the other audits: never reap a real session's box.
    const res = await fetch(`${boxApiUrl}/boxes?limit=100`, {
      headers: { Authorization: `Bearer ${boxKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`list boxes: HTTP ${res.status}`);
    const listLeftovers = (boxes: Array<{ id: string; name?: string; state?: string }>) =>
      (boxes || []).filter((b) => String(b.name || "").startsWith("sbxtest-"));
    let leftovers = listLeftovers(((await res.json()) as any).boxes);
    if (leftovers.length) {
      // Deletions are async server-side — give in-flight teardowns a moment.
      await new Promise((r) => setTimeout(r, 15_000));
      const again = await fetch(`${boxApiUrl}/boxes?limit=100`, {
        headers: { Authorization: `Bearer ${boxKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      leftovers = again.ok ? listLeftovers(((await again.json()) as any).boxes) : leftovers;
    }
    ok(
      "no backstage-named boxes left behind",
      leftovers.length === 0,
      leftovers.map((l) => `${l.id}(${l.state})`).join(",") || "none",
    );
    for (const { id } of leftovers) {
      console.warn(`  cleaning up leftover box ${id}`);
      try {
        await fetch(`${boxApiUrl}/boxes/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${boxKey}` },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        console.warn(`  cleanup of ${id} failed:`, String(e).slice(0, 200));
      }
    }
  } catch (e) {
    ok("box leftovers audit ran", false, String(e).slice(0, 200));
  }
}

async function auditModalLeftovers(): Promise<void> {
  if ((!modalTokenId || !modalTokenSecret) && !modalProfileAvailable) return;
  section = "modal";
  try {
    const { ModalClient } = await import("modal");
    const client = new ModalClient({
      ...(modalTokenId && modalTokenSecret
        ? { tokenId: modalTokenId, tokenSecret: modalTokenSecret }
        : {}),
      environment: liveCfg?.modal?.environment,
    });
    const app = await client.apps.fromName(liveCfg?.modal?.app || "opensession-sandboxes", {
      createIfMissing: true,
    });
    const listLeftovers = async () => {
      const out: Array<{ id: string; session: string }> = [];
      for await (const sandbox of client.sandboxes.list({
        appId: app.appId,
        tags: { "opensession.sandbox": "1" },
      })) {
        const tags = await sandbox.getTags();
        const session = String(tags["opensession.session"] || "");
        if (session.startsWith("sbxtest-")) out.push({ id: sandbox.sandboxId, session });
      }
      return out;
    };
    let leftovers = await listLeftovers();
    if (leftovers.length) {
      await new Promise((r) => setTimeout(r, 15_000));
      leftovers = await listLeftovers();
    }
    ok(
      "no backstage-tagged modal sandboxes left behind",
      leftovers.length === 0,
      leftovers.map((l) => `${l.id}(${l.session})`).join(",") || "none",
    );
    for (const { id } of leftovers) {
      console.warn(`  cleaning up leftover modal sandbox ${id}`);
      try {
        await (await client.sandboxes.fromId(id)).terminate();
      } catch (e) {
        console.warn(`  cleanup of ${id} failed:`, String(e).slice(0, 200));
      }
    }
    client.close();
  } catch (e) {
    ok("modal leftovers audit ran", false, String(e).slice(0, 200));
  }
}

// ── run the matrix ────────────────────────────────────────────────────────────

try {
  for (const entry of selected) {
    try {
      await runEntry(entry);
    } catch (e) {
      ok("section completed without throwing", false, String(e).slice(0, 300));
    }
  }
  await auditDaytonaLeftovers();
  await auditE2bLeftovers();
  await auditBoxLeftovers();
  await auditModalLeftovers();
} finally {
  console.log("\n── cleanup ──");
  // Docker scratch containers/volumes/state for both docker entries.
  const { containerNameFor } = await import("../../src/server/sandbox/docker");
  for (const e of entries.filter((x) => x.providerId === "docker")) {
    const c = containerNameFor(`sbxtest-conf-${e.name}-${RUN_TS}`);
    await sh(["docker", "rm", "-f", c]);
    await sh(["docker", "volume", "rm", "-f", `${c}-claude`, `${c}-codex`, `${c}-ws`]);
    rmSync(`${OPENSESSION_SESSIONS_DIR}/sandboxes/${c}.json`, { force: true });
  }
  for (const e of entries) {
    rmSync(`${OPENSESSION_SESSIONS_DIR}/sandbox-runs/sbxtest-conf-${e.name}-${RUN_TS}`, {
      recursive: true,
      force: true,
    });
  }
  // (scratch repo registrations die with the scratch OPENSESSION_CONFIG below)
  for (const dir of [WT]) {
    const munged = `-${dir.replaceAll("/", "-").replace(/^-/, "")}`;
    rmSync(`${HOME}/.claude/projects/${munged}`, { recursive: true, force: true });
  }
  rmSync(SCRATCH, { recursive: true, force: true });
  wsSrv.stop(true);
  console.log("  removed scratch repos, containers, state");
}

console.log(`\n${pass} passed, ${fail} failed${fail ? `:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(fail ? 1 : 0);
