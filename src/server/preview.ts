/**
 * Local dev-server ("preview") status + control for a session's worktree.
 *
 * A repository preview writes its allocated ports to `<worktree>/.ports.conf`:
 *
 *   WEBAPP_PORT=3300
 *   INSTANT_PORT=5968
 *   ...
 *
 * `next dev` binds 0.0.0.0, but the webapp can't just be opened at
 * `http://<host>:<WEBAPP_PORT>`: it needs a *secure* (HTTPS) origin to be a
 * trusted context (WebCrypto etc.), and Next dev only hydrates over an origin
 * it's been told to trust. So for each running webapp we expose a dedicated
 * HTTPS port on the tailnet host via Caddy (which already holds the ts.net
 * cert), reverse-proxying to the webapp's port. The session's worktree must
 * have been started with `ALLOWED_DEV_ORIGINS=<host>` so Next dev hydrates over
 * that origin. The preview URL is then
 * `https://<host>:<httpsPort>`.
 *
 * The bring-up itself is repo-generic: resolvePreviewBoot picks a committed
 * `.opensession/start.sh` from the target repo first (`.backstage/` pre-rename
 * fallback), then the repo's configured `previewCommand` — one chain shared by
 * host and sandboxed previews.
 */
import { $ } from "bun";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { getAgentAwsEnv } from "./aws-creds";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { sandboxConfig } from "./sandbox/config";
import {
  lookupSandboxHttpsPort,
  releaseSandboxPreviewPorts,
  sandboxHttpsPortFor,
} from "./sandbox/preview-ports";
import type { Sandbox } from "./sandbox/provider";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";
import { configuredRepos, configuredServer, type Repo } from "./config";
import { repoForPath } from "./worktree";
import {
  claimPoolPreview,
  poolClaimFor,
  poolPreviewLive,
  previewPoolEnabled,
  releasePoolPreview,
  resumePoolSyncIfNeeded,
} from "./preview-pool";
import {
  previewScopeSystemdArgs,
  previewScopeUnit,
  stopUserScope,
  systemdUserEnv,
  systemdUserScopesAvailable,
} from "./systemd-scopes";

export interface PreviewService {
  /** Friendly label, e.g. "Webapp". */
  name: string;
  /** Raw .ports.conf key, e.g. "WEBAPP_PORT". */
  key: string;
  port: number;
  running: boolean;
  pids: number[];
}

export interface PreviewStatus {
  hasPortsConf: boolean;
  /** WEBAPP_PORT, or null if the worktree has no .ports.conf yet. */
  webappPort: number | null;
  /** Whether the webapp itself is currently listening. */
  running: boolean;
  /** True while `startPreview` is bringing the dev server up (not yet listening). */
  starting: boolean;
  /** HTTPS preview URL (Caddy-fronted) when the webapp is up, else null. */
  previewUrl: string | null;
  /** Whether a bring-up mechanism exists for this worktree's repo (repo
   *  `.opensession/start.sh` → config `previewCommand`).
   *  False = the Start button can't do anything; the UI shows what to add. */
  bootable: boolean;
  services: PreviewService[];
}

/** Absolute instance preview-command directories that sandbox providers need
 *  to mount read-only at the same path. */
export function externalPreviewCommandDirs(): string[] {
  return [
    ...new Set(
      Object.values(configuredRepos())
        .map((repo) => repo.previewCommand?.trim().split(/\s+/)[0])
        .filter((command): command is string => !!command?.startsWith("/"))
        .map(dirname),
    ),
  ];
}

// ── Bring-up resolution (ONE chain, shared by host + sandbox previews) ────────
// The boot command should live IN the target repo, not in opensession: a
// committed `.opensession/start.sh` (with `.backstage/` as the pre-rename
// fallback, matching docker.ts's workspace-setup hook) beats instance config
// (`previewCommand` on the repos registry entry). Docs:
// deploy/sandbox/README.md "Previews in sandboxes".

// Repo lifecycle dirs, in precedence order.
const LIFECYCLE_DIRS = [".opensession", ".backstage"] as const;

/** What a repo's committed lifecycle directory provides. Read straight off
 *  the main checkout for Settings → Setup, which tells operators whether
 *  sessions in that repo can install deps and boot a preview on their own.
 *  Docs: docs/repo-lifecycle.md. */
export interface RepoLifecycle {
  /** The winning lifecycle dir (`.opensession`, or the `.backstage`
   *  fallback), or null when the repo commits neither. */
  dir: string | null;
  setup: boolean;
  start: boolean;
  previewJson: boolean;
}

/** Inspect `repoRoot`'s lifecycle dir. Same precedence as resolvePreviewBoot:
 *  the first dir that exists wins outright, so a leftover `.backstage/` never
 *  contributes files to an `.opensession/` repo. */
export function repoLifecycle(repoRoot: string): RepoLifecycle {
  for (const dir of LIFECYCLE_DIRS) {
    const base = `${repoRoot}/${dir}`;
    if (!existsSync(base)) continue;
    return {
      dir,
      setup: existsSync(`${base}/setup.sh`),
      start: existsSync(`${base}/start.sh`),
      previewJson: existsSync(`${base}/preview.json`),
    };
  }
  return { dir: null, setup: false, start: false, previewJson: false };
}

export interface PreviewBoot {
  kind: "repo-script" | "preview-command";
  /** `sh -c`-ready command; every path component passes assertSafePath. */
  cmd: string;
  /** `setup.sh` next to the resolved start.sh when present — the one-shot
   *  sibling hook (repo-script kind only). */
  setupScript?: string;
}

/**
 * Resolve how to bring `worktreeDir`'s dev server up. `exists` abstracts the
 * filesystem so the same chain serves host previews (fs) and sandboxed ones
 * (in-container `test -f`). Returns null when the repo has no boot mechanism
 * at all — the UI surfaces that as a disabled Start button.
 */
export async function resolvePreviewBoot(
  worktreeDir: string,
  repo: Pick<Repo, "id" | "previewCommand">,
  exists: (path: string) => Promise<boolean> | boolean,
): Promise<PreviewBoot | null> {
  for (const dir of LIFECYCLE_DIRS) {
    const startSh = `${worktreeDir}/${dir}/start.sh`;
    if (!(await exists(startSh))) continue;
    // The setup sibling comes from the SAME dir as the start script — mixing
    // dirs would pair scripts that never shipped together.
    const setupSh = `${worktreeDir}/${dir}/setup.sh`;
    return {
      kind: "repo-script",
      cmd: `bash ${assertSafePath(startSh)}`,
      setupScript: (await exists(setupSh)) ? setupSh : undefined,
    };
  }
  if (repo.previewCommand) {
    // Absolute previewCommands may not exist in this environment (e.g. a host
    // path the sandbox image doesn't carry) — fall through instead of failing.
    if (!repo.previewCommand.startsWith("/") || (await exists(repo.previewCommand))) {
      return {
        kind: "preview-command",
        cmd: `${repo.previewCommand} ${assertSafePath(worktreeDir)}`,
      };
    }
    // Once per worktree — status polls re-resolve every few seconds for
    // sandboxes that don't carry the script (e.g. remote providers).
    if (!warnedMissingPreviewCommand.has(worktreeDir)) {
      warnedMissingPreviewCommand.add(worktreeDir);
      console.warn(
        `[preview] previewCommand ${repo.previewCommand} (repo ${repo.id}) not present here — trying the fallback chain`,
      );
    }
  }
  return null;
}

const hostExists = (p: string) => existsSync(p);
const warnedMissingPreviewCommand = new Set<string>();

// Worktrees with an in-flight `startPreview` (worktreeDir -> started-at ms).
// Parked on globalThis so it survives --hot reloads. Entries are cleared when
// the webapp comes up, when the bring-up process exits, or after a TTL (so a
// crashed/never-finished start eventually stops reporting "starting").
const gStart = globalThis as unknown as {
  __previewStarting?: Map<string, number>;
  __previewStartPgids?: Map<string, number>;
};
const starting: Map<string, number> = (gStart.__previewStarting ??= new Map());
// worktreeDir -> process group of the in-flight bring-up (see startPreview's
// setsid). Lets stopPreview cancel a start whose services aren't listening yet.
const startPgids: Map<string, number> = (gStart.__previewStartPgids ??= new Map());
const START_TTL_MS = 5 * 60_000;

function isStarting(worktreeDir: string): boolean {
  const t = starting.get(worktreeDir);
  if (t == null) return false;
  if (Date.now() - t > START_TTL_MS) {
    starting.delete(worktreeDir);
    return false;
  }
  return true;
}

const SERVICE_NAMES: Record<string, string> = {
  WEBAPP_PORT: "Webapp",
  INSTANT_PORT: "Instant API",
  WEBAPP_WORKFLOW_PORT: "Workflow",
  WEBAPP_EMAILS_PREVIEW_PORT: "Emails preview",
  TEMPORAL_PORT: "Temporal",
  TEMPORAL_UI_PORT: "Temporal UI",
};

function friendly(key: string): string {
  if (SERVICE_NAMES[key]) return SERVICE_NAMES[key];
  return key
    .replace(/_PORT$/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse .ports.conf text into ordered {key, port} entries. */
function parsePortsText(text: string): { key: string; port: number }[] {
  const out: { key: string; port: number }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+_PORT)\s*=\s*(\d+)\s*$/);
    if (m) out.push({ key: m[1], port: parseInt(m[2], 10) });
  }
  return out;
}

/** Parse `<worktree>/.ports.conf` into ordered {key, port} entries. */
function readPorts(worktreeDir: string): { key: string; port: number }[] {
  const file = join(worktreeDir, ".ports.conf");
  if (!existsSync(file)) return [];
  return parsePortsText(readFileSync(file, "utf8"));
}

/**
 * PIDs with a LISTEN socket on a TCP port (empty if nothing is listening).
 * Uses `ss` rather than `lsof` — on this host lsof can't read the socket→pid
 * mapping without root, but `ss -p` can.
 */
async function listenersOnPort(port: number): Promise<number[]> {
  const raw = await $`ss -tlnpH sport = :${port}`.quiet().nothrow().text();
  const pids = new Set<number>();
  for (const m of raw.matchAll(/pid=(\d+)/g)) pids.add(parseInt(m[1], 10));
  return [...pids];
}

/** Is anything listening on the port (regardless of pid visibility)? */
async function portListening(port: number): Promise<boolean> {
  const raw = await $`ss -tlnH sport = :${port}`.quiet().nothrow().text();
  return raw.trim().length > 0;
}

async function pgidOf(pid: number): Promise<number | null> {
  const raw = await $`ps -o pgid= -p ${pid}`.quiet().nothrow().text();
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── HTTPS preview exposure via Caddy ──────────────────────────────────────────
// Caddy (admin API on localhost:2019) already terminates TLS for this machine's
// ts.net hostname. We add one reverse-proxy server per running webapp, on a
// deterministic high port, so each session gets its own secure origin.

const caddyAdmin = () => configuredServer().caddyAdmin.replace(/\/+$/, "");
const g = globalThis as unknown as {
  __previewRoutes?: Map<number, number>;
  __previewHost?: string;
};
// httpsPort -> webappPort we've already configured (survives --hot reloads).
const previewRoutes: Map<number, number> = (g.__previewRoutes ??= new Map());

/** This machine's tailnet hostname (e.g. example-host.your-tailnet.ts.net). */
export async function previewHost(): Promise<string> {
  if (g.__previewHost) return g.__previewHost;
  let host = process.env.PREVIEW_HOST || "";
  if (!host) {
    try {
      const raw = await $`tailscale status --json`.quiet().nothrow().text();
      host = (JSON.parse(raw)?.Self?.DNSName || "").replace(/\.$/, "");
    } catch {}
  }
  if (!host) host = configuredServer().previewHost;
  g.__previewHost = host;
  return host;
}

// Webapp dev ports are 3100-3999 and globally unique among running servers, so
// +6000 gives a unique, stable preview port in 9100-9999. (Preview-pool
// container host ports come from the same range so this scheme covers them.)
export function httpsPortFor(webappPort: number): number {
  return webappPort + 6000;
}

/** Add/refresh the Caddy server for this webapp (idempotent, cached). */
async function ensurePreviewRoute(httpsPort: number, webappPort: number, host: string): Promise<boolean> {
  if (previewRoutes.get(httpsPort) === webappPort) return true;
  const server = {
    listen: [`:${httpsPort}`],
    routes: [
      {
        match: [{ host: [host] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${webappPort}` }] }],
        terminal: true,
      },
    ],
  };
  const path = `${caddyAdmin()}/config/apps/http/servers/preview_${httpsPort}`;
  const put = () =>
    fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(server),
    });
  try {
    // PUT creates the key; if it already exists (e.g. Caddy kept the server
    // across a opensession restart, so our cache is cold) it 409s — drop it and
    // recreate so the route always ends up pointing at the current webapp port.
    let res = await put();
    if (res.status === 409) {
      await fetch(path, { method: "DELETE" }).catch(() => {});
      res = await put();
    }
    if (!res.ok) return false;
    previewRoutes.set(httpsPort, webappPort);
    return true;
  } catch {
    return false;
  }
}

async function removePreviewRoute(httpsPort: number): Promise<void> {
  if (!previewRoutes.has(httpsPort)) return;
  try {
    await fetch(`${caddyAdmin()}/config/apps/http/servers/preview_${httpsPort}`, { method: "DELETE" });
  } catch {}
  previewRoutes.delete(httpsPort);
}

export async function getPreviewStatus(worktreeDir: string): Promise<PreviewStatus> {
  // Pool-backed previews: claims persist on disk but sync timers don't —
  // re-attach after a process restart (cheap no-op otherwise).
  resumePoolSyncIfNeeded(worktreeDir);
  // docker-proxy listens for the container's whole life, so for a pool claim
  // "running" must mean "the dev server inside answers", not "port open".
  const poolLive = await poolPreviewLive(worktreeDir);
  // Remote-backend claims (daytona) carry their own public preview origin —
  // no host port, no Caddy route, no .ports.conf involvement at all.
  const remoteClaim = poolClaimFor(worktreeDir);
  if (remoteClaim?.previewUrl) {
    return {
      hasPortsConf: true,
      webappPort: null,
      running: poolLive === true,
      starting: poolLive !== true,
      previewUrl: poolLive === true ? remoteClaim.previewUrl : null,
      bootable: true,
      services: [
        {
          name: "Webapp",
          key: "WEBAPP_PORT",
          port: 0,
          running: poolLive === true,
          pids: [],
        },
      ],
    };
  }
  const ports = readPorts(worktreeDir);
  const services: PreviewService[] = await Promise.all(
    ports.map(async ({ key, port }) => {
      const pids = await listenersOnPort(port);
      // Root-owned listeners (docker-proxy fronting a preview-pool container)
      // show no pid to non-root `ss -p` — a listening socket counts as
      // running even when we can't see who owns it.
      const running =
        key === "WEBAPP_PORT" && poolLive != null
          ? poolLive
          : pids.length > 0 || (await portListening(port));
      return { name: friendly(key), key, port, running, pids };
    }),
  );
  const webapp = services.find((s) => s.key === "WEBAPP_PORT");

  // Keep the Caddy HTTPS exposure in sync with the webapp's state: add the
  // route while it's up (so the preview URL is live and the button opens it
  // directly), drop it once it's gone.
  let previewUrl: string | null = null;
  if (webapp?.running) {
    const httpsPort = httpsPortFor(webapp.port);
    const host = await previewHost();
    if (await ensurePreviewRoute(httpsPort, webapp.port, host)) {
      previewUrl = `https://${host}:${httpsPort}`;
    }
  } else if (webapp) {
    await removePreviewRoute(httpsPortFor(webapp.port));
  }

  // Once the webapp is listening, the bring-up is done — clear any "starting".
  if (webapp?.running) starting.delete(worktreeDir);

  return {
    hasPortsConf: ports.length > 0,
    webappPort: webapp?.port ?? null,
    running: !!webapp?.running,
    // poolLive === false: a pool claim exists but its dev server isn't
    // answering yet (big-delta claims REBOOT the container's dev tree) —
    // that IS a bring-up in progress. Without it the button saw
    // running:false starting:false right after a claim and closed its own
    // interstitial ("opens then closes itself, and then I have no tab").
    starting: !webapp?.running && (isStarting(worktreeDir) || poolLive === false),
    previewUrl,
    bootable:
      !!webapp?.running ||
      (await resolvePreviewBoot(worktreeDir, repoForPath(worktreeDir), hostExists)) != null,
    services,
  };
}

/**
 * Screenshot the running preview with headless Chrome (PNG bytes). The preview
 * origin is Caddy's tailnet cert, but Chrome runs before trust is guaranteed —
 * hence --ignore-certificate-errors; --virtual-time-budget lets the SPA settle
 * before the shot, and the whole thing is bounded by `timeout` so a wedged
 * renderer can't hold the request open.
 */
export async function capturePreviewScreenshot(
  worktreeDir: string,
  opts?: { width?: number; height?: number; status?: PreviewStatus },
): Promise<Buffer> {
  // Sandboxed sessions pass their own status (getSandboxPreviewStatus) — the
  // host status below can't see in-container listeners.
  const status = opts?.status ?? (await getPreviewStatus(worktreeDir));
  if (!status.running || !status.previewUrl) {
    throw new Error("Preview isn't running — start it first");
  }
  const out = `/tmp/backstage-preview-shot-${process.pid}-${Date.now()}.png`;
  const w = opts?.width || 1440;
  const h = opts?.height || 900;
  try {
    await $`timeout 45 google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars --ignore-certificate-errors --window-size=${w},${h} --virtual-time-budget=12000 --screenshot=${out} ${status.previewUrl}`.quiet();
    const buf = Buffer.from(await Bun.file(out).arrayBuffer());
    if (!buf.length) throw new Error("Screenshot came back empty");
    return buf;
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
}

/** Fresh `.ports.conf` body in tella-fusion dev-services.sh format (harmless
 *  for repos that ignore it — a lifecycle start.sh just reads $WEBAPP_PORT). */
function freshPortsConfText(webappPort: number, comment: string): string {
  const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
  return [
    "# Port configuration for development services",
    `# Seeded by opensession (${comment}): WEBAPP_PORT is the port the preview`,
    "# is fronted at — do not hand-edit it.",
    `WEBAPP_PORT=${webappPort}`,
    `INSTANT_PORT=${rand(5100, 5999)}`,
    `WEBAPP_WORKFLOW_PORT=${rand(6100, 6999)}`,
    `WEBAPP_EMAILS_PREVIEW_PORT=${rand(6100, 6999)}`,
    `TEMPORAL_PORT=${rand(7200, 7999)}`,
    `TEMPORAL_UI_PORT=${rand(8200, 8999)}`,
    "",
  ].join("\n");
}

/** Seed/adopt `<worktree>/.ports.conf` (host fs variant of
 *  seedSandboxPortsConf): rewrite only WEBAPP_PORT when the file exists. */
function seedHostPortsConf(worktreeDir: string, webappPort: number): void {
  const file = join(worktreeDir, ".ports.conf");
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    // The line may be absent (a pool-preview release strips it) — append
    // instead of silently replacing nothing, or the claim's port never lands.
    writeFileSync(
      file,
      /^WEBAPP_PORT=/m.test(text)
        ? text.replace(/^WEBAPP_PORT=.*$/m, `WEBAPP_PORT=${webappPort}`)
        : `WEBAPP_PORT=${webappPort}\n${text}`,
    );
  } else {
    writeFileSync(file, freshPortsConfText(webappPort, "host preview"));
  }
}

/** A webapp port for a host repo-script boot: the worktree's existing
 *  .ports.conf entry when nothing else is listening on it, else a free
 *  random port from the host webapp dev range (3100-3999). */
async function allocateHostWebappPort(worktreeDir: string): Promise<number | null> {
  // portListening, not pid-counting: preview-pool containers publish on this
  // same range via docker-proxy (root-owned, no pid visible to ss -p) — the
  // pid check once handed a session a port already serving another session's
  // pool container, so both "opened the same preview".
  const existing = readPorts(worktreeDir).find((p) => p.key === "WEBAPP_PORT")?.port;
  if (existing && !(await portListening(existing))) return existing;
  for (let i = 0; i < 20; i++) {
    const port = 3100 + Math.floor(Math.random() * 900);
    if (!(await portListening(port))) return port;
  }
  return null;
}

// One-shot lifecycle `setup.sh` stamps for HOST previews (the sandbox path
// runs setup.sh at workspace materialization instead — see sandbox/adapters).
// Stamped per worktree; "settled" once run, success or not, mirroring the
// sandbox semantics: setup never blocks or retries.
const SETUP_STAMP_DIR = join(OPENSESSION_SESSIONS_DIR, "preview-setup");
function setupStampPath(worktreeDir: string): string {
  return join(SETUP_STAMP_DIR, worktreeDir.replace(/\//g, "_") + ".done");
}

/**
 * Bring the session's dev server up if it isn't already, using the shared
 * resolution chain (repo `.opensession/start.sh` → config `previewCommand` →
 * tella-local). Bring-ups can take minutes (first build) — so we spawn the
 * command in the background and return immediately with `starting: true`;
 * callers poll `getPreviewStatus` to see it flip to `running`.
 *
 * Environment contract (same as sandbox boots): `OPENSESSION_BOOT_MODE=fresh`
 * always; repo-script boots additionally get `WEBAPP_PORT` (allocated here and
 * seeded into .ports.conf so status can see it) and `PREVIEW_URL`. The legacy
 * rungs (previewCommand/tella-local) own their .ports.conf themselves.
 *
 * AWS: the opensession service cgroup denies IMDS (IPAddressDeny in
 * opensession.service), so children spawned here can never mint instance-role
 * creds on their own — that's what silently broke the tella-fusion bring-up
 * (its `aws` preflight and prebuilt-WASM S3 install both need creds). Inject
 * the same short-lived credentials agent runs get (aws-creds.ts).
 */
export async function startPreview(worktreeDir: string): Promise<PreviewStatus> {
  const status = await getPreviewStatus(worktreeDir);
  if (status.running || status.starting) return status;

  // Warm preview pool: adopt an already-booted container when one is ready —
  // the claim syncs the worktree into it and hands back its host port; from
  // there the normal status path (listener on the port -> Caddy route) takes
  // over. Falls through to the host boot when the pool has nothing warm.
  try {
    const repo = repoForPath(worktreeDir);
    if (previewPoolEnabled(repo.id)) {
      const claim = await claimPoolPreview(repo.id, worktreeDir);
      if (claim) {
        // Remote-backend claims carry a previewUrl and no host port — the
        // status path serves them directly, no .ports.conf involvement.
        if (claim.hostPort) seedHostPortsConf(worktreeDir, claim.hostPort);
        return await getPreviewStatus(worktreeDir);
      }
    }
  } catch (e) {
    console.warn(`[preview] pool claim for ${worktreeDir} failed (falling back to host boot):`, e);
  }

  const boot = await resolvePreviewBoot(worktreeDir, repoForPath(worktreeDir), hostExists);
  if (!boot) return status; // nothing to run (status.bootable is false)

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(await getAgentAwsEnv()),
    OPENSESSION_BOOT_MODE: "fresh",
  };

  let cmd = boot.cmd;
  if (boot.kind === "repo-script") {
    const port = await allocateHostWebappPort(worktreeDir);
    if (port == null) {
      console.warn(`[preview] ${worktreeDir}: no free webapp port for the repo-script boot`);
      return status;
    }
    seedHostPortsConf(worktreeDir, port);
    env.WEBAPP_PORT = String(port);
    env.PREVIEW_URL = `https://${await previewHost()}:${httpsPortFor(port)}`;
    // One-shot sibling hook, stamped per worktree; failure never blocks the
    // start (matches the sandbox workspace-setup semantics).
    const stamp = setupStampPath(worktreeDir);
    if (boot.setupScript && !existsSync(stamp)) {
      try {
        mkdirSync(SETUP_STAMP_DIR, { recursive: true });
      } catch {}
      cmd =
        `bash ${assertSafePath(boot.setupScript)}; touch ${assertSafePath(stamp)}; ` + cmd;
    }
  }

  starting.set(worktreeDir, Date.now());
  try {
    const log = openSync(
      `/tmp/backstage-preview-${basename(worktreeDir)}.log`,
      "a",
    );
    // Prefer a resource-controlled user scope. It contains the entire preview
    // tree (Next/Turbopack, workflow, email, compilers) and survives a server
    // restart without sharing opensession.service's memory budget. `setsid`
    // remains inside it as the portable stop fallback and writes dev-pgid for
    // older previews / hosts without a reachable user manager.
    const innerCmd = [
      "setsid",
      "bash",
      "-c",
      `mkdir -p .ports && echo $$ > .ports/dev-pgid; ${cmd}`,
    ];
    const scoped = systemdUserScopesAvailable();
    const unit = previewScopeUnit(worktreeDir);
    const spawnCmd = scoped
      ? [
          "systemd-run",
          "--user",
          "--scope",
          "--collect",
          "--quiet",
          `--unit=${unit}`,
          ...previewScopeSystemdArgs(),
          "--property=TimeoutStopSec=5",
          "--",
          ...innerCmd,
        ]
      : innerCmd;
    const proc = Bun.spawn(
      spawnCmd,
      {
        cwd: worktreeDir,
        env: {
          ...(env as Record<string, string>),
          ...(scoped ? systemdUserEnv(env) : {}),
        },
        stdout: log,
        stderr: log,
        stdin: "ignore",
      },
    );
    if (!scoped) startPgids.set(worktreeDir, proc.pid);
    // Don't hold the event loop open on it, and clear the flag when it exits
    // (success flips to running via polling; failure/exit stops "starting").
    proc.unref();
    proc.exited.then(() => {
      starting.delete(worktreeDir);
      if (!scoped) startPgids.delete(worktreeDir);
      try {
        closeSync(log);
      } catch {}
    });
  } catch {
    starting.delete(worktreeDir);
    startPgids.delete(worktreeDir);
  }
  return { ...status, starting: true, bootable: true };
}

/**
 * Stop the session's dev server. We can't use `just dev-stop` — it `pkill -f
 * "next dev"` globally and would kill every other session's webapp. Instead we
 * find the process group behind this worktree's ports and signal just that
 * group, which also takes down the `while true; do next dev; done` supervisor
 * (so it doesn't respawn) without touching anything outside the worktree.
 *
 * Safety: a PID is only eligible if its cwd is inside `worktreeDir`, so the
 * opensession server (and unrelated worktrees) can never be a target.
 */
export async function stopPreview(worktreeDir: string): Promise<PreviewStatus> {
  starting.delete(worktreeDir); // a stop cancels any in-flight "starting" state
  // Pool-backed preview: the "dev server" is a claimed warm container, not a
  // host process tree — release it (stops the sync loop, destroys the
  // container) and let the normal status path report the now-empty port.
  console.log(`[preview] stop: releasing pool claim for ${worktreeDir}`);
  if (await releasePoolPreview(worktreeDir)) {
    // Strip the pool's port from .ports.conf: a later HOST fallback boot
    // would otherwise adopt the now-free port ("existing" fast path in
    // allocateHostWebappPort), and any stale tab/status pointing at the old
    // port would silently show whatever serves there next.
    const conf = join(worktreeDir, ".ports.conf");
    if (existsSync(conf)) {
      try {
        const text = readFileSync(conf, "utf8");
        writeFileSync(conf, text.replace(/^WEBAPP_PORT=.*\n?/m, ""));
      } catch {}
    }
    return getPreviewStatus(worktreeDir);
  }
  const ports = readPorts(worktreeDir);
  const pgids = new Set<number>();
  // New host previews have a deterministic transient scope, so this also
  // catches a bring-up that has not written dev-pgid or opened a port yet.
  stopUserScope(previewScopeUnit(worktreeDir));
  // An in-flight bring-up has nothing listening yet, so the port scan below
  // can't see it — kill its dedicated process group (set up via setsid in
  // startPreview) so cancelling mid-start actually stops the build/dev server.
  const startPgid = startPgids.get(worktreeDir);
  if (startPgid && startPgid > 1) pgids.add(startPgid);
  // Also pick up any PGID written to disk by ensure-up.sh — covers the agent-
  // invoked path (where startPgids has no entry) and restarted opensession
  // (in-memory map is empty after restart).
  const pgidFile = join(worktreeDir, ".ports", "dev-pgid");
  if (existsSync(pgidFile)) {
    try {
      const pgid = parseInt(readFileSync(pgidFile, "utf8").trim(), 10);
      if (!isNaN(pgid) && pgid > 1) pgids.add(pgid);
    } catch {}
  }
  for (const { port } of ports) {
    for (const pid of await listenersOnPort(port)) {
      let cwd = "";
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {}
      if (!cwd || !(cwd === worktreeDir || cwd.startsWith(worktreeDir + "/"))) continue;
      const pgid = await pgidOf(pid);
      if (pgid && pgid > 1) pgids.add(pgid);
    }
  }

  for (const pgid of pgids) {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {}
  }
  // Give it a moment to exit cleanly, then SIGKILL whatever's still around.
  await new Promise((r) => setTimeout(r, 1500));
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, 0); // throws if the group is already gone
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }
  try { unlinkSync(join(worktreeDir, ".ports", "dev-pgid")); } catch {}

  return getPreviewStatus(worktreeDir);
}

// ── Sandboxed previews (the sandbox rollout plan Phase 2 + 4A) ──────────────────
// A sandboxed session's dev server runs INSIDE its container, so the host-side
// mechanics above can't see it: `ss` can't observe container listeners, and
// signaling host process groups can't stop them. These variants keep the same
// PreviewStatus shape and reuse the identical Caddy plumbing — the only change
// is the upstream: instead of dialing the dev port directly, Caddy dials the
// container port's PUBLISHED loopback host port (docker -p at container
// create, config `previewPorts`; see docker.ts). A port that isn't published
// stays previewUrl-less — add it to previewPorts and let the container be
// recreated. Callers route here only when the session's sandbox container is
// actually running (the same active check as workspace-exec).
//
// The https route key is NAMESPACED away from host previews: host routes use
// webappPort + 6000 (9100-9999), sandbox routes use an allocated port from
// [20000, 28000) keyed by (sandboxId, containerPort) and persisted — see
// sandbox/preview-ports.ts for why deriving it from the webapp port number
// (the old TODO(sandbox-preview-collision)) could collide with host previews
// and with other sandboxes.

/** Only ever called with provider-constructed paths; mirror docker.ts's
 *  assertion so nothing surprising reaches an in-container `sh -c`. */
function assertSafePath(p: string): string {
  if (!/^[A-Za-z0-9_\/.@:-]+$/.test(p)) {
    throw new Error(`refusing unsafe path for in-container exec: ${p}`);
  }
  return p;
}

/** True when a TCP connect to 127.0.0.1:<port> succeeds INSIDE the sandbox. */
async function sandboxPortListening(sandbox: Sandbox, port: number): Promise<boolean> {
  const r = await sandbox.exec([
    "timeout", "2", "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`,
  ]);
  return r.exitCode === 0;
}

export async function getSandboxPreviewStatus(
  sandbox: Sandbox,
  worktreeDir: string,
): Promise<PreviewStatus> {
  // .ports.conf via the sandbox exec — works for bind mounts and is the only
  // way for volume-mode workspaces (no host copy).
  const conf = await sandbox.exec(["cat", ".ports.conf"]);
  const ports = conf.exitCode === 0 ? parsePortsText(conf.stdout) : [];
  const services: PreviewService[] = [];
  for (const { key, port } of ports) {
    const running = await sandboxPortListening(sandbox, port);
    // PIDs are container-internal — meaningless to the host UI; leave empty.
    services.push({ name: friendly(key), key, port, running, pids: [] });
  }
  const webapp = services.find((s) => s.key === "WEBAPP_PORT");

  let previewUrl: string | null = null;
  if (webapp?.running) {
    const entry = (await sandbox.ports())[webapp.port];
    const published = typeof entry === "number" ? entry : entry?.hostPort;
    const directUrl = typeof entry === "object" ? entry?.url : undefined;
    if (directUrl) {
      // Remote providers (daytona/e2b) hand out a URL on their own preview
      // domain — no Caddy hop needed (or possible: the upstream isn't a local
      // port). Auth caveats (e.g. Daytona's preview token for non-public
      // sandboxes) are the operator's provider-side setting.
      previewUrl = directUrl;
    } else if (published) {
      // Same Caddy route machinery as host previews, but the https port comes
      // from the sandbox allocator (stable per sandbox+container-port across
      // restarts AND collision-free by construction against host previews and
      // other sandboxes — see sandbox/preview-ports.ts). The upstream dials
      // the published loopback port, which may change when the container is
      // recreated — ensurePreviewRoute re-points an existing route on
      // mismatch.
      const httpsPort = sandboxHttpsPortFor(sandbox.id, webapp.port);
      const host = await previewHost();
      if (await ensurePreviewRoute(httpsPort, published, host)) {
        previewUrl = `https://${host}:${httpsPort}`;
      }
    } else {
      console.warn(
        `[preview] ${sandbox.id}: webapp on ${webapp.port} is up in-container but the port isn't published — add it to sandbox previewPorts`,
      );
    }
  } else if (webapp) {
    const allocated = lookupSandboxHttpsPort(sandbox.id, webapp.port);
    if (allocated != null) await removePreviewRoute(allocated);
  }

  if (webapp?.running) starting.delete(worktreeDir);

  return {
    hasPortsConf: ports.length > 0,
    webappPort: webapp?.port ?? null,
    running: !!webapp?.running,
    starting: !webapp?.running && isStarting(worktreeDir),
    previewUrl,
    bootable:
      !!webapp?.running ||
      (await resolvePreviewBoot(worktreeDir, repoForPath(worktreeDir), sandboxExists(sandbox))) !=
        null,
    services,
  };
}

/** `exists` predicate for resolvePreviewBoot inside a sandbox. */
function sandboxExists(sandbox: Sandbox): (p: string) => Promise<boolean> {
  return async (p) => (await sandbox.exec(["test", "-f", p])).exitCode === 0;
}

/**
 * Seed `<worktree>/.ports.conf` so the in-container dev flow adopts the
 * chosen (pre-published) webapp port instead of allocating a random one that
 * isn't published. tella-fusion's dev-services.sh SOURCES an existing
 * .ports.conf and keeps any port that's free — inside the container's fresh
 * netns ours always is. When the file already exists we rewrite only the
 * WEBAPP_PORT line; when it's absent we write the full six-key file in
 * dev-services.sh's format (harmless for repos that ignore it — a lifecycle
 * start.sh just reads $WEBAPP_PORT from its env).
 */
async function seedSandboxPortsConf(
  sandbox: Sandbox,
  worktreeDir: string,
  webappPort: number,
): Promise<void> {
  const conf = assertSafePath(`${worktreeDir}/.ports.conf`);
  const fresh = freshPortsConfText(webappPort, "sandbox preview").replace(/\n/g, "\\n");
  await sandbox.exec([
    "sh", "-c",
    `if [ -f ${conf} ]; then sed -i 's/^WEBAPP_PORT=.*/WEBAPP_PORT=${webappPort}/' ${conf}; ` +
      `else printf '${fresh}' > ${conf}; fi`,
  ]);
}

/**
 * `.tunnels.env` contract (adopted from background-agents): when a sandbox
 * preview starts, opensession writes `<worktree>/.tunnels.env` — a dotenv file
 * in-container dev processes can source/read to learn their public URLs:
 *
 *   PREVIEW_URL=https://<host>:<httpsPort>          # the primary (webapp) URL
 *   PREVIEW_URL_<containerPort>=https://…           # one var per exposed port
 *
 * Stale files are removed on container (re)start (docker.ts's ensure) and on
 * preview stop; each preview start rewrites it whole.
 */
async function writeSandboxTunnelsEnv(
  sandbox: Sandbox,
  worktreeDir: string,
  vars: Record<string, string>,
): Promise<void> {
  const file = assertSafePath(`${worktreeDir}/.tunnels.env`);
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${shellQuoteWord(v)}`)
    .join("\n");
  await sandbox.exec([
    "sh",
    "-c",
    `printf '%s\\n' ${shellQuoteWord(body)} > ${shellQuoteWord(file)}`,
  ]);
  // Keep it out of the session diff: one idempotent line in the repo's shared
  // info/exclude (tella-fusion doesn't gitignore .tunnels.env yet).
  await sandbox.exec([
    "sh", "-c",
    `ex="$(git rev-parse --git-path info/exclude 2>/dev/null)" && [ -n "$ex" ] && ` +
      `{ grep -qxF ".tunnels.env" "$ex" 2>/dev/null || echo ".tunnels.env" >> "$ex"; } || true`,
  ]);
}

/**
 * Bring the dev server up INSIDE the sandbox. Gated behind config
 * `devServerInSandbox` (default off). The flow (docs in
 * deploy/sandbox/README.md "Previews in sandboxes"):
 *
 *  1. Pick a webapp port from the container's PRE-PUBLISHED preview range
 *     (docker -p at create; config `previewPorts`, default 3300-3302) —
 *     preferring the worktree's existing .ports.conf entry when it's one of
 *     them, else the first published port nothing listens on. All busy =
 *     range exhausted; we refuse with a warning (fallback: raise
 *     `previewPorts` in ~/.opensession-sandbox.json and let the container be
 *     recreated — mounts/ports are create-time).
 *  2. Seed .ports.conf with that port and write the .tunnels.env contract
 *     (PREVIEW_URL against the allocated sandbox https port).
 *  3. Run the bring-up, detached in-container, with WEBAPP_PORT/PREVIEW_URL/
 *     OPENSESSION_BOOT_MODE in its env. Command resolution (lifecycle
 *     convention): `<worktree>/.opensession/start.sh` (or pre-rename
 *     `.backstage/`) when present, else the
 *     repo's configured `previewCommand`.
 */
export async function startSandboxPreview(
  sandbox: Sandbox,
  worktreeDir: string,
): Promise<PreviewStatus> {
  const status = await getSandboxPreviewStatus(sandbox, worktreeDir);
  if (status.running || status.starting) return status;
  if (!sandboxConfig().devServerInSandbox) {
    console.log(
      `[preview] ${sandbox.id}: in-sandbox dev-server start is gated off (devServerInSandbox) — not starting`,
    );
    return status;
  }

  // 1. Allocate a webapp port from the pre-published range.
  const portMap = await sandbox.ports();
  const publishedPorts = Object.keys(portMap).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!publishedPorts.length) {
    console.warn(
      `[preview] ${sandbox.id}: no preview ports are published — configure previewPorts and recreate the container`,
    );
    return status;
  }
  let port: number | null =
    status.webappPort != null && publishedPorts.includes(status.webappPort)
      ? status.webappPort
      : null;
  if (port == null) {
    for (const p of publishedPorts) {
      if (!(await sandboxPortListening(sandbox, p))) {
        port = p;
        break;
      }
    }
  }
  if (port == null) {
    console.warn(
      `[preview] ${sandbox.id}: preview port range exhausted (${publishedPorts.join(",")} all busy) — ` +
        `stop one, or widen previewPorts in ~/.opensession-sandbox.json and recreate the container`,
    );
    return status;
  }

  // 2. Resolve the bring-up command — the same chain as host previews
  //    (repo .opensession/start.sh → previewCommand), with
  //    existence checked in-container.
  const boot = await resolvePreviewBoot(
    worktreeDir,
    repoForPath(worktreeDir),
    sandboxExists(sandbox),
  );
  if (!boot) {
    console.warn(
      `[preview] ${sandbox.id}: no .opensession/start.sh or usable repo previewCommand in the sandbox — cannot start`,
    );
    return status;
  }
  const cmd = boot.cmd;

  // 3. Seed ports + tunnels, then launch detached in its own session (setsid
  //    → pgid recorded so stop can kill the whole tree; ensure-up.sh's inner
  //    `just dev` overwrites .ports/dev-pgid with its own group, which is the
  //    one that outlives the bring-up — either way the file points at the
  //    right group).
  await seedSandboxPortsConf(sandbox, worktreeDir, port);
  const entry = portMap[port];
  const directUrl = typeof entry === "object" ? entry.url : undefined;
  const httpsPort = directUrl ? null : sandboxHttpsPortFor(sandbox.id, port);
  const host = directUrl ? null : await previewHost();
  const previewUrl = directUrl || `https://${host}:${httpsPort}`;
  await writeSandboxTunnelsEnv(sandbox, worktreeDir, {
    PREVIEW_URL: previewUrl,
    [`PREVIEW_URL_${port}`]: previewUrl,
  });

  starting.set(worktreeDir, Date.now());
  const bootMode = sandbox.bootMode || "fresh";
  const r = await sandbox.exec([
    "sh", "-c",
    `mkdir -p .ports && nohup setsid env WEBAPP_PORT=${port} PREVIEW_URL=${shellQuoteWord(previewUrl)} ` +
      `OPENSESSION_BOOT_MODE=${shellQuoteWord(bootMode)} ` +
      `bash -c 'echo $$ > .ports/dev-pgid; exec ${cmd}' >> /tmp/backstage-preview.log 2>&1 &`,
  ]);
  if (r.exitCode !== 0) starting.delete(worktreeDir);
  return { ...status, starting: r.exitCode === 0 };
}

/**
 * Stop a sandboxed session's dev server: drop the Caddy route(s), signal the
 * bring-up's process group (.ports/dev-pgid, in-container), and clear the
 * .tunnels.env contract. pkill by pattern is safe HERE (unlike on the host,
 * where it was the "kills every session's webapp" trap) because the container
 * only ever hosts this one session's processes.
 */
export async function stopSandboxPreview(
  sandbox: Sandbox,
  worktreeDir: string,
): Promise<PreviewStatus> {
  starting.delete(worktreeDir);
  const conf = await sandbox.exec(["cat", ".ports.conf"]);
  const ports = conf.exitCode === 0 ? parsePortsText(conf.stdout) : [];
  const webapp = ports.find((p) => p.key === "WEBAPP_PORT");
  if (webapp) {
    const allocated = lookupSandboxHttpsPort(sandbox.id, webapp.port);
    if (allocated != null) await removePreviewRoute(allocated);
  }
  await sandbox.exec([
    "bash", "-c",
    `[ -f .ports/dev-pgid ] && kill -TERM -- "-$(cat .ports/dev-pgid)" 2>/dev/null; true`,
  ]);
  await sandbox.exec(["pkill", "-f", "next dev"]);
  await sandbox.exec(["pkill", "-f", ".opensession/start.sh"]);
  await sandbox.exec(["pkill", "-f", ".backstage/start.sh"]);
  await sandbox.exec(["sh", "-c", "rm -f .ports/dev-pgid .tunnels.env"]);
  return getSandboxPreviewStatus(sandbox, worktreeDir);
}

/**
 * Teardown hook for DockerProvider.destroy(): release the sandbox's https
 * allocations and drop any Caddy routes still pointing at them.
 */
export async function dropSandboxPreviewRoutes(sandboxId: string): Promise<void> {
  for (const httpsPort of releaseSandboxPreviewPorts(sandboxId)) {
    // removePreviewRoute only touches routes this process cached — a destroy
    // right after a restart may miss the cache, so delete unconditionally.
    previewRoutes.delete(httpsPort);
    try {
      await fetch(`${caddyAdmin()}/config/apps/http/servers/preview_${httpsPort}`, {
        method: "DELETE",
      });
    } catch {}
  }
}
