/**
 * DockerProvider — the Docker sandbox backend (docs/sandboxes-plan.md §5
 * Phase 1, "bind-mount mode").
 *
 * One long-lived container per session (`bks-sbx-<sessionId>`, image
 * `backstage-runner:latest` — see deploy/sandbox/), kept alive across turns so
 * engine session state (~/.claude history, codex rollouts) and dev servers
 * survive. A run is the SAME runner-host entry the systemd path uses
 * (src/runner-host/host.ts), `docker exec`'d into the container; backstage
 * talks to it over the host's unix socket in a bind-mounted per-session run
 * dir, reusing host-client's HostHandle (NDJSON protocol, ask proxying,
 * reconnect, respawn-to-resume) with a Docker HostLauncher. Because the
 * socket + spec/meta/journal files live on a bind mount, a restarted
 * backstage reattaches to a still-running in-container run exactly like it
 * would to a systemd host — that's what makes restart-resume work.
 *
 * Mount design (all deliberate, see also deploy/sandbox/README.md):
 *
 *  - NO volume at /home/ubuntu. The image bakes the claude CLI and the runner
 *    bundle under /home/ubuntu; a $HOME volume would shadow both (and copy the
 *    ~223MB vendored codex binary per session). Engine state persists in two
 *    named volumes mounted at exactly ~/.claude and ~/.codex.
 *  - The session worktree is bind-mounted rw at its IDENTICAL host path, so
 *    @-mention search, diff, git status/push and previews keep working
 *    host-side with zero changes.
 *  - Git worktrees are not self-contained: `<worktree>/.git` is a file whose
 *    gitdir points at `<main-checkout>/.git/worktrees/<name>` by absolute
 *    path, and objects/refs live in the main checkout's .git. So the main
 *    checkout's `.git` directory is ALSO bind-mounted rw at its identical
 *    path (resolved via `git rev-parse --git-common-dir`, never guessed).
 *    Mounting the shared .git rw is an accepted Phase 1 tradeoff: a sandboxed
 *    session can touch other worktrees' refs — same trust level as host runs
 *    today. Phase 2's volume-owned workspaces remove it.
 *  - ~/.claude/projects/<munged-cwd> (the engine transcript dir for THIS cwd)
 *    is bind-mounted from the host over the ~/.claude volume, so the session
 *    viewer's transcript tail, parseTranscript handoffs, and resume-continuity
 *    with host runs of the same worktree all keep working. Narrow on purpose:
 *    only this worktree's transcript dir, not the host's whole ~/.claude.
 *  - The run-rpc socket (~/.backstage-chats/backstage-rpc.sock) is
 *    bind-mounted (a socket can't be mounted ro) so the opensession-* stdio
 *    proxies work from inside. Caveat: if backstage rebinds the socket (real
 *    restart), the bind still points at the old inode until the CONTAINER is
 *    restarted — the idle-stop/start cycle self-heals this, and mcp-proxy
 *    retries until then.
 *  - ~/.ssh, ~/.gitconfig, ~/.config/gh, mcp-config.json and
 *    ~/.backstage-claude-accounts.json are mounted read-only for git/gh/PR
 *    parity and in-container account-pool selection. Interactive sessions
 *    only — the same ambient trust those runs already have on the host today.
 *    Automations are NOT sandboxed in Phase 1 (the wiring refuses them), so
 *    none of this is reachable from untrusted prompt text.
 *  - ~/.backstage-audit is mounted rw so in-container runs land in the same
 *    audit log stream as host runs (appendFileSync, O_APPEND).
 *
 * Phase 2 additions (docs/sandboxes-plan.md §5 Phase 2):
 *  - VOLUME workspaces (config `workspace: "volume"`, new sandboxes only): the
 *    workspace is a per-session named volume (`<name>-ws`) mounted at the
 *    session's canonical worktree path, cloned from the repo's origin INSIDE
 *    the container (host creds mounted ro do the auth) — no host worktree at
 *    all. The mode is sticky per sandbox (recorded in the state file; a later
 *    config flip never re-mounts an existing workspace). destroy() removes the
 *    workspace volume — that data loss is the mode's contract: push your work.
 *    Host-side reads (diff/status/@-mentions) reach it through the
 *    workspace-exec choke point. A local-path origin URL (scratch/test repos)
 *    is mounted ro so the in-container clone can read it; real repos clone
 *    over ssh/https. Attached repos are rejected in volume mode.
 *  - Attached-repo mounts (bind mode): each attachedDirs entry is bind-mounted
 *    rw at its identical path plus its repo's common .git — a changed set
 *    recreates the container on the next ensure (mounts are create-time).
 *  - Preview ports: config `previewPorts` publishes each listed container port
 *    to a random loopback host port at create time (docker -p 127.0.0.1::p);
 *    `ports()` reads the live mapping for preview.ts's Caddy routing.
 *
 * Snapshots (config `snapshots: { enabled: true, … }` — background-agents'
 * warm-restore pattern adapted to Docker; default OFF):
 *  - On the idle-stop sweep (and only while no run is active), the container is
 *    `docker commit`ed to `bks-snap-<sessionId>:t<millis>` + `:latest` BEFORE
 *    the stop; a snapshot failure logs and never blocks the stop. At most
 *    `maxPerSession` timestamped snapshots are kept per session (older ones
 *    deleted right after each commit).
 *  - ensure() for a session whose container is GONE (docker rm'd, host reboot
 *    with pruning, …) creates the new container FROM the newest snapshot image
 *    instead of the base image — same mounts/volumes logic, different image.
 *  - **What a snapshot actually captures — read this before expecting more:**
 *    `docker commit` records the container LAYER only. Engine state (~/.claude,
 *    ~/.codex) lives on named volumes and the workspace is a bind mount (bind
 *    mode) or the `-ws` named volume (volume mode) — none of that is in the
 *    image. The snapshot mainly captures installed deps, apt packages, and
 *    global caches written to the container layer between runs. Never expect
 *    workspace or session state in a snapshot; volumes carry those across the
 *    rm/recreate exactly as before.
 *  - Volume-mode workspaces get a "quick sync" after a snapshot restore
 *    (`git fetch origin` + `git status` inside — NEVER a reset/checkout; refs
 *    freshen, work is untouched) when `quickSyncOnRestore` (default true).
 *  - destroy() also removes the session's snapshot images, and the idle sweep
 *    prunes `bks-snap-*` images orphaned by sessions deleted while their
 *    sandbox was already gone (state file + container + session file all
 *    absent). `docker image prune` is deliberately NOT run here.
 *
 * Known Phase 1 caveats (documented, not chased):
 *  - External MCP servers from mcp-config.json now spawn INSIDE the container;
 *    ones with host-only deps won't start there.
 *  - Codex models: codex account homes (CODEX_HOME dirs) are not mounted, so
 *    codex runs inside a sandbox have no account pool yet. Claude first.
 *  - `aws: true` runs can't mint creds inside the container (IMDS is blocked
 *    by the DOCKER-USER rule — deploy/sandbox/setup-host.sh); getAgentAwsEnv
 *    degrades to no AWS env.
 *
 * Runner internals: nothing here hot-reloads meaningfully into live runs —
 * wire-ups need a real restart (see CLAUDE.md "Hot reload & restarts").
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import { OPENSESSION_CHATS_DIR } from "../paths";
import { envAlias, stateDir } from "../rename-compat";
import { journalSet, journalClear, type ActiveRunRecord } from "../run-journal";
import type { StreamEvent } from "../run-events";
import { RESUME_CONTINUATION_PROMPT } from "../agent-runner";
import { providerFor } from "../models";
import { hostRunBusy, hostSteer, hostInterruptSteer, hostCancel } from "../host-registry";
import { registerRunToken, unregisterRunToken } from "../run-rpc";
import { writeJsonAtomic } from "../shared/atomic-write";
import { HostHandle, type HandleCallbacks, type HostLauncher } from "../host-client";
import { registerRunWsHost, unregisterRunWsHost, runWsConnector } from "../run-ws";
import { getTranscriptPath } from "../sessions";
import { listCodexAccounts } from "../codex-accounts";
import { OPENCODE_TRANSCRIPTS_DIR } from "../opencode-transcript";
import { dropSandboxPreviewRoutes, tellaLocalSkillDir } from "../preview";
import { REPOS, getRepo, worktreePathFor, type Repo } from "../worktree";
import { LocalProvider } from "./local";
import {
  sandboxConfig,
  sandboxSnapshots,
  sandboxTransport,
  sandboxCallbackBaseUrl,
  type SandboxTransport,
} from "./config";
import {
  HOST_SPEC_NAME,
  HOST_META_NAME,
  HOST_LOG_NAME,
  HOST_ENTRY,
  rpcSocketPath,
  type RunHostSpec,
  type RunHostMeta,
} from "../../runner-host/protocol";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
  RunHandle,
  RunHandleCallbacks,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "./provider";

const HOME = process.env.HOME || "/home/ubuntu";
const CONTAINER_PREFIX = "bks-sbx-";
const DEFAULT_IMAGE = "backstage-runner:latest";
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY = "8g";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Pre-published preview range: every sandbox container publishes these
 *  container ports to random loopback host ports at create, so a dev server
 *  started AFTER creation (ports are create-time-only in docker) still has a
 *  routable port — startSandboxPreview allocates from this set. Config
 *  `previewPorts` overrides; exhaustion = widen it + recreate the container. */
const DEFAULT_PREVIEW_PORTS = [3300, 3301, 3302];
/** Cap for a `.backstage/setup.sh` lifecycle run (one-shot, per workspace). */
const SETUP_TIMEOUT_MS = 10 * 60_000;

/** Provider-owned state, one file per sandbox — lets get() reattach (or fully
 *  recreate a removed container with identical mounts) after any restart. */
const STATE_DIR = `${OPENSESSION_CHATS_DIR}/sandboxes`;
/** Per-session run dirs (spec/meta/journal/socket/log per run), bind-mounted
 *  into the session's container at the identical path. */
const RUNS_BASE = `${OPENSESSION_CHATS_DIR}/sandbox-runs`;

interface DockerSandboxState {
  sandboxId: string;
  sessionId: string;
  cwd: string;
  image: string;
  createdAt: string;
  /** Last run start/end — drives the idle-stop sweep. */
  lastActivityAt: string;
  /** How the workspace is materialized. Sticky for the sandbox's lifetime;
   *  absent (pre-Phase-2 state files) = "bind". */
  workspace?: "bind" | "volume";
  /** Repo id + branch, recorded so get() can recreate a volume workspace's
   *  container (the clone source and checkout) after a docker rm. */
  repoId?: string;
  branch?: string;
  /** Attached-repo dirs mounted at create time (bind mode) — a differing set
   *  on the next ensure() recreates the container with fresh mounts. */
  attachedDirs?: string[];
  /** Run transport the container was created for. "ws" containers don't mount
   *  the run-rpc socket (proxies dial /backstage/rpc-ws instead); a config
   *  flip recreates the container on the next ensure (mounts are create-time).
   *  Absent (pre-Phase-3 state files) = "socket". */
  transport?: SandboxTransport;
  /** Whether the `.backstage/setup.sh` lifecycle hook already ran (or was
   *  skipped — snapshot restore / script absent). One-shot per sandbox. */
  setupRan?: boolean;
  /** How the current container came to exist: fresh create vs snapshot
   *  restore. Lifecycle scripts receive it as BACKSTAGE_BOOT_MODE. */
  bootMode?: "fresh" | "snapshot-restore";
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
}

export function containerNameFor(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sanitizeName(sessionId)}`.slice(0, 100);
}

/** Snapshot image repo for a sandbox: `bks-snap-<sessionId>` (image repos must
 *  be lowercase, unlike container names). Derived from the container name so
 *  destroy() can clean images even when the state file is already gone. */
const SNAPSHOT_PREFIX = "bks-snap-";

export function snapshotRepoForSandbox(sandboxId: string): string {
  const sessionPart = sandboxId.startsWith(CONTAINER_PREFIX)
    ? sandboxId.slice(CONTAINER_PREFIX.length)
    : sanitizeName(sandboxId);
  return `${SNAPSHOT_PREFIX}${sessionPart.toLowerCase()}`.slice(0, 100);
}

function statePath(sandboxId: string): string {
  return `${STATE_DIR}/${sandboxId}.json`;
}

function readState(sandboxId: string): DockerSandboxState | null {
  try {
    if (!existsSync(statePath(sandboxId))) return null;
    return JSON.parse(readFileSync(statePath(sandboxId), "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state: DockerSandboxState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(statePath(state.sandboxId), state);
}

function touchStateActivity(sandboxId: string): void {
  const s = readState(sandboxId);
  if (s) {
    s.lastActivityAt = new Date().toISOString();
    writeState(s);
  }
}

/** Activity touch for callers outside this module (the Shell tab's terminal
 *  start counts as interaction — it resets the idle-stop clock like a run
 *  does; an OPEN shell deliberately doesn't hold the container awake). */
export function touchSandboxActivity(sandboxId: string): void {
  touchStateActivity(sandboxId);
}

function sessionRunsDir(sessionId: string): string {
  return `${RUNS_BASE}/${sanitizeName(sessionId)}`;
}

/** Run `docker <args>` (argv array — nothing is shell-interpolated). */
async function docker(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts?.timeoutMs ?? 120_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function containerStatus(name: string): Promise<SandboxStatus> {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name]);
  if (r.exitCode !== 0) return "gone";
  return r.stdout.trim() === "running" ? "running" : "stopped";
}

/** Container status by name, for callers outside this module (the
 *  workspace-exec choke point checks "actually running" without starting). */
export function dockerContainerStatus(name: string): Promise<SandboxStatus> {
  return containerStatus(name);
}

/**
 * A raw in-container exec bound to `cwd` that NEVER starts a stopped
 * container (unlike Sandbox.exec) — the workspace-exec choke point uses it
 * for read surfaces, where waking a stopped sandbox just to run `git status`
 * would defeat the idle-stop policy. A container that stops between the
 * caller's status check and the exec simply returns a non-zero exit.
 */
export function rawDockerExec(container: string, cwd: string) {
  return (cmd: string[], opts?: ExecOpts): Promise<ExecResult> => {
    const envArgs = Object.entries(opts?.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return docker(["exec", "-w", cwd, ...envArgs, container, ...cmd]);
  };
}

async function ensureStarted(name: string): Promise<void> {
  const st = await containerStatus(name);
  if (st === "running") return;
  if (st === "gone") throw new Error(`sandbox container ${name} does not exist`);
  const r = await docker(["start", name]);
  if (r.exitCode !== 0) {
    throw new Error(`docker start ${name} failed: ${r.stderr.trim().slice(0, 300)}`);
  }
}

// ── Snapshots (see the "Snapshots" header section for the semantics) ──────────

async function listSnapshotTags(repo: string): Promise<string[]> {
  const r = await docker(["image", "ls", repo, "--format", "{{.Tag}}"]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((t) => t && t !== "<none>");
}

/** `<repo>:latest` when the sandbox has a snapshot image, else null. */
async function latestSnapshotImage(sandboxId: string): Promise<string | null> {
  const repo = snapshotRepoForSandbox(sandboxId);
  const r = await docker(["image", "inspect", "-f", "{{.Id}}", `${repo}:latest`]);
  return r.exitCode === 0 ? `${repo}:latest` : null;
}

/**
 * `docker commit` the sandbox container to `bks-snap-<sessionId>:t<millis>`
 * (+ `:latest`), labeled with the session id and timestamp, then prune older
 * timestamped snapshots beyond `maxPerSession`. Skipped (returns null) while a
 * run is active for the session — never snapshot a mid-run container — or when
 * the container/state is gone. Throws on a failed commit; the idle sweep
 * catches and stops the container anyway. Exported for the verify suite.
 *
 * Remember what this captures: the container LAYER only (installed deps, apt,
 * global caches) — engine state and workspaces live on volumes/bind mounts and
 * are NOT in the image (see header).
 */
export async function snapshotSandboxImage(sandboxId: string): Promise<string | null> {
  const state = readState(sandboxId);
  if (!state) return null;
  if (hostRunBusy(state.sessionId)) {
    console.log(`[sandbox] skipping snapshot of ${sandboxId}: a run is active`);
    return null;
  }
  if ((await containerStatus(sandboxId)) === "gone") return null;
  const repo = snapshotRepoForSandbox(sandboxId);
  const tag = `t${Date.now()}`;
  const r = await docker(
    [
      "commit",
      "-c", `LABEL backstage.snapshot="1"`,
      "-c", `LABEL backstage.session="${state.sessionId}"`,
      "-c", `LABEL backstage.snapshotAt="${new Date().toISOString()}"`,
      "-m", `backstage sandbox snapshot of ${sandboxId}`,
      sandboxId,
      `${repo}:${tag}`,
    ],
    { timeoutMs: 300_000 },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker commit ${sandboxId} → ${repo}:${tag} failed: ${r.stderr.trim().slice(0, 300)}`);
  }
  await docker(["tag", `${repo}:${tag}`, `${repo}:latest`]);
  // Strict maxPerSession: `t<millis>` tags sort lexicographically = by time
  // (fixed digit count until 2286). `-f` because a live container restored
  // from an old snapshot, or a newer snapshot layered on top of it, still
  // references its layers: -f drops the TAG now (that's the quota we enforce)
  // and docker keeps shared layer data alive only as long as dependents do.
  const keep = Math.max(1, sandboxSnapshots().maxPerSession);
  const tTags = (await listSnapshotTags(repo))
    .filter((t) => /^t\d+$/.test(t))
    .sort()
    .reverse();
  for (const old of tTags.slice(keep)) {
    await docker(["rmi", "-f", `${repo}:${old}`]);
  }
  return `${repo}:${tag}`;
}

/** Remove every snapshot image of a sandbox (destroy + orphan sweep). */
async function removeSnapshotImages(sandboxId: string): Promise<void> {
  const repo = snapshotRepoForSandbox(sandboxId);
  for (const t of await listSnapshotTags(repo)) {
    await docker(["rmi", "-f", `${repo}:${t}`]);
  }
}

/**
 * Sweep `bks-snap-*` images orphaned by sessions deleted while their sandbox
 * was already gone (so destroy() never saw them): no provider state file, no
 * container, and no session file left. Sessions that still exist keep their
 * snapshots — that's the warm-restore path. Fail-safe: images whose session
 * label is unreadable are left alone. Throttled to once an hour (it lists
 * images); runs piggybacked on the idle sweep. NOTE: the 14-day archived-
 * session sweep lives in backstage.ts and funnels through destroy(), which
 * cleans snapshots itself — this covers only the already-gone-sandbox gap.
 */
async function sweepOrphanSnapshots(): Promise<void> {
  const g = globalThis as { __sandboxSnapOrphanSweepAt?: number };
  if (g.__sandboxSnapOrphanSweepAt && Date.now() - g.__sandboxSnapOrphanSweepAt < 60 * 60_000) {
    return;
  }
  g.__sandboxSnapOrphanSweepAt = Date.now();
  const r = await docker([
    "images", "--filter", `reference=${SNAPSHOT_PREFIX}*`, "--format", "{{.Repository}}",
  ]);
  if (r.exitCode !== 0) return;
  for (const repo of new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean))) {
    try {
      const tags = await listSnapshotTags(repo);
      if (!tags.length) continue;
      const lbl = await docker([
        "image", "inspect", "-f", `{{index .Config.Labels "backstage.session"}}`, `${repo}:${tags[0]}`,
      ]);
      const sessionId = lbl.exitCode === 0 ? lbl.stdout.trim() : "";
      if (!sessionId) continue; // unknown provenance — keep
      const container = containerNameFor(sessionId);
      if (readState(container)) continue; // still tracked → destroy() cleans
      if ((await containerStatus(container)) !== "gone") continue;
      if (existsSync(`${OPENSESSION_CHATS_DIR}/${sessionId}.json`)) continue; // session alive — keep
      console.log(`[sandbox] removing orphaned snapshot images ${repo} (session ${sessionId} deleted, sandbox gone)`);
      await removeSnapshotImages(container);
    } catch (e) {
      console.warn(`[sandbox] orphan snapshot sweep failed for ${repo}:`, e);
    }
  }
}

/** Paths that end up inside a `sh -c` log-redirect line must be boring. They
 *  are always provider-constructed (OPENSESSION_CHATS_DIR + sanitized ids), so
 *  this is an assertion, not an escape. */
function assertSafePath(p: string): string {
  if (!/^[A-Za-z0-9_\/.@:-]+$/.test(p)) {
    throw new Error(`refusing unsafe path for in-container exec: ${p}`);
  }
  return p;
}

/** Host-side resolution of the main checkout's .git dir for a worktree —
 *  `<worktree>/.git` is a pointer file; the common dir holds objects/refs. */
async function gitCommonDir(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git rev-parse --git-common-dir failed in ${cwd}: ${err.trim()}`);
  return resolvePath(cwd, out.trim());
}

// ── Container creation ────────────────────────────────────────────────────────

function isMainCheckout(cwd: string): boolean {
  return Object.values(REPOS).some((r) => r.repo === cwd);
}

/** Host-side resolution of a repo's origin URL — the clone source for
 *  volume-mode workspaces. */
async function repoOriginUrl(repoDir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoDir, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || !out.trim()) {
    throw new Error(`cannot resolve origin URL for ${repoDir}: ${err.trim() || "no origin"}`);
  }
  return out.trim();
}

interface CreateContainerOpts {
  workspace: "bind" | "volume";
  /** Attached-repo worktrees to mount (bind mode only). */
  attachedDirs: string[];
  /** Repo backing a volume workspace (clone source + default branch). */
  repo?: Repo;
  /** Run transport (see DockerSandboxState.transport). */
  transport: SandboxTransport;
  /** Image to create from (snapshot restore); default = config/base image. */
  image?: string;
}

async function createContainer(
  name: string,
  sessionId: string,
  cwd: string,
  opts: CreateContainerOpts,
): Promise<void> {
  const cfg = sandboxConfig();
  const image = opts.image || cfg.image || DEFAULT_IMAGE;
  const cpus = cfg.cpus || DEFAULT_CPUS;
  const memory = cfg.memory || DEFAULT_MEMORY;

  const vol = (host: string, container: string, ro = false) => [
    "-v",
    `${host}:${container}${ro ? ":ro" : ""}`,
  ];

  // Workspace mounts. Bind mode: the host worktree + its git common dir, rw at
  // identical paths. Volume mode: a per-session named volume at the canonical
  // worktree path (cloned by setupVolumeWorkspace after start) — plus the
  // origin repo itself mounted ro when it's a local path (scratch/test repos),
  // since the in-container clone must be able to read its source.
  const workspaceMounts: string[] = [];
  if (opts.workspace === "volume") {
    workspaceMounts.push(...vol(`${name}-ws`, cwd));
    const originUrl = opts.repo ? await repoOriginUrl(opts.repo.repo) : "";
    if (originUrl.startsWith("/") && existsSync(originUrl)) {
      workspaceMounts.push(...vol(originUrl, originUrl, true));
    }
  } else {
    const commonGit = await gitCommonDir(cwd);
    if (commonGit === `${cwd}/.git`) {
      // Standalone checkout (not a linked worktree) — only ever legitimate for
      // scratch/test repos; main checkouts were already refused in ensure().
      console.warn(`[sandbox] ${name}: ${cwd} is a standalone checkout (no separate common .git)`);
    }
    workspaceMounts.push(
      ...vol(cwd, cwd),
      ...(commonGit !== `${cwd}/.git` ? vol(commonGit, commonGit) : []),
    );
    // Attached repos (multi-repo sessions): each worktree + its repo's common
    // .git, rw at identical paths — same trust as the primary workspace.
    const mounted = new Set([cwd, commonGit]);
    for (const dir of opts.attachedDirs) {
      if (mounted.has(dir)) continue;
      mounted.add(dir);
      workspaceMounts.push(...vol(dir, dir));
      try {
        const attCommon = await gitCommonDir(dir);
        if (attCommon !== `${dir}/.git` && !mounted.has(attCommon)) {
          mounted.add(attCommon);
          workspaceMounts.push(...vol(attCommon, attCommon));
        }
      } catch (e) {
        console.warn(`[sandbox] ${name}: could not resolve common .git for attached ${dir}:`, e);
      }
    }
  }

  const runsDir = sessionRunsDir(sessionId);
  mkdirSync(runsDir, { recursive: true });
  // Engine transcript dir for this cwd, host-side (see mount design above).
  // Volume mode keeps it too: transcripts are engine state, not workspace —
  // mounting them host-side keeps the session viewer's tail working.
  const transcriptDir = dirname(getTranscriptPath(cwd, "x"));
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(OPENCODE_TRANSCRIPTS_DIR, { recursive: true });

  const mounts: string[] = [
    // Named volumes ONLY at ~/.claude and ~/.codex — never at /home/ubuntu
    // (a $HOME volume would shadow the image's claude install + repo bundle).
    ...vol(`${name}-claude`, `${HOME}/.claude`),
    ...vol(`${name}-codex`, `${HOME}/.codex`),
    ...workspaceMounts,
    // Host-visible engine transcripts for this cwd (over the .claude volume).
    ...vol(transcriptDir, transcriptDir),
    // OpenCode engine transcripts: the opencode runner persists claude-shape
    // JSONL per session under ~/.claude/projects/-opencode-engine (see
    // opencode-transcript.ts) — same trick as the per-cwd dir above, bound rw
    // over the ~/.claude volume so the host session viewer can tail
    // in-container opencode runs. (OpenCode's own SQLite store stays inside
    // the container; the persisted JSONL is the durable host-visible copy.)
    ...vol(OPENCODE_TRANSCRIPTS_DIR, OPENCODE_TRANSCRIPTS_DIR),
    // Per-session run dirs: spec/meta/journal/host.sock/log for every run.
    ...vol(runsDir, runsDir),
    // Audit log parity (append-only jsonl stream). Deliberately rw where the
    // other trust mounts are ro: in-container runs must land in the SAME audit
    // stream as host runs (append-only writes via O_APPEND), and host runs can
    // already write here today — so this is parity with host-run trust, not an
    // escalation. Worst case a hostile run scribbles on its own audit trail;
    // it gains no credentials or control surface from it.
    ...vol(stateDir("audit"), stateDir("audit")),
  ];
  mkdirSync(stateDir("audit"), { recursive: true });

  // run-rpc socket (opensession-* proxies). WS transport skips it — the proxies
  // dial /backstage/rpc-ws instead, which also removes the stale-inode caveat
  // (a rebound socket needed a container restart to re-resolve). Guard:
  // mounting a MISSING host path would make docker create a directory there
  // and break run-rpc's bind.
  if (opts.transport !== "ws") {
    const rpcSock = rpcSocketPath(OPENSESSION_CHATS_DIR);
    try {
      if (statSync(rpcSock).isSocket()) mounts.push(...vol(rpcSock, rpcSock));
      else console.warn(`[sandbox] ${rpcSock} exists but is not a socket — opensession-* proxies disabled`);
    } catch {
      console.warn(`[sandbox] ${rpcSock} missing — opensession-* proxies will be unavailable in ${name}`);
    }
  }

  // Read-only trust mounts (interactive parity — see header).
  const roIfExists = (p: string, label: string) => {
    if (existsSync(p)) mounts.push(...vol(p, p, true));
    else console.warn(`[sandbox] ${label} (${p}) missing — skipping mount for ${name}`);
  };
  roIfExists(`${HOME}/.ssh`, "ssh keys");
  roIfExists(`${HOME}/.gitconfig`, "gitconfig");
  roIfExists(`${HOME}/.config/gh`, "gh config");
  roIfExists(
    envAlias("OPENSESSION_MCP_CONFIG", "BACKSTAGE_MCP_CONFIG") ||
      `${HOME}/projects/tella-backstage/mcp-config.json`,
    "mcp-config.json",
  );
  roIfExists(
    envAlias("OPENSESSION_CLAUDE_ACCOUNTS_PATH", "BACKSTAGE_CLAUDE_ACCOUNTS_PATH") ||
      stateDir("claude-accounts.json"),
    "claude account pool",
  );
  // Codex/ChatGPT account material, for opencode/openai/* dispatch
  // IN-CONTAINER (pickOpenaiAccount reads the pool store; bindOpenaiAccount
  // reads each home-account's CODEX_HOME/auth.json and seeds an access-token-
  // only opencode auth.json under the container-local
  // ~/.backstage-opencode/openai-data — never these mounts). Without them an
  // openai model in a sandbox died as opencode's bare "model not found".
  // Mounted per-FILE and ro on purpose: the auth.json files carry the
  // rotation-sensitive refresh-token family (opencode-openai-auth.ts header)
  // — sandboxed code must never be able to rotate/corrupt them, and native
  // codex runs in-container keep their own per-sandbox ~/.codex volume
  // (an in-container refresh attempt against a ro auth.json fails loudly
  // instead of corrupting the host family).
  roIfExists(stateDir("codex-accounts.json"), "codex account pool");
  for (const acct of listCodexAccounts()) {
    if (acct.kind === "home") roIfExists(`${acct.value}/auth.json`, `codex auth (${acct.name})`);
  }
  // OpenCode bridge config (~/.backstage-opencode.json): read IN-CONTAINER by
  // the runner-host's opencode dispatch (bridge mode, accounts restriction,
  // turn timeout) — without it every opencode/anthropic/* run in a sandbox
  // fails with "bridge disabled". ro like the account pool it selects from.
  // Source honors the host-side OPENSESSION_OPENCODE_CONFIG seam (old name
  // accepted), but the destination stays the legacy default path — that's what
  // the in-container process (which has no such env) dual-reads.
  {
    const src =
      envAlias("OPENSESSION_OPENCODE_CONFIG", "BACKSTAGE_OPENCODE_CONFIG") ||
      stateDir("opencode.json");
    if (existsSync(src)) mounts.push(...vol(src, `${HOME}/.backstage-opencode.json`, true));
  }
  // The tella-local skill (ensure-up.sh + CDP helpers) at its identical host
  // path, read-only — the Preview button's default bring-up for tella-fusion
  // must work inside sandboxes (both bind and volume mode). Mounted over the
  // ~/.claude volume like the transcript dir (more-specific mounts win).
  roIfExists(tellaLocalSkillDir(), "tella-local skill");

  // Preview ports: publish each container port on a random LOOPBACK host
  // port (Caddy fronts them with the tailnet HTTPS origin — see preview.ts;
  // nothing is exposed off-host). Create-time only, hence the pre-published
  // DEFAULT range: a dev server started later still lands on a routable port
  // (startSandboxPreview allocates from this set).
  const portArgs = (cfg.previewPorts?.length ? cfg.previewPorts : DEFAULT_PREVIEW_PORTS)
    .flatMap((p) => ["-p", `127.0.0.1::${p}`]);

  const r = await docker([
    "create",
    "--name", name,
    "--label", "backstage.sandbox=1",
    "--label", `backstage.session=${sessionId}`,
    "--init",
    "--restart", "no",
    "--cpus", String(cpus),
    "--memory", memory,
    ...portArgs,
    ...mounts,
    image,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`docker create ${name} failed: ${r.stderr.trim().slice(0, 500)}`);
  }
}

/**
 * Materialize a volume workspace after (re)start: clone from origin (host
 * creds are mounted ro; local-path origins are mounted ro by createContainer)
 * and check out the session's branch — tracking origin/<branch> when it
 * exists, else cut from origin/<defaultBranch>, mirroring createWorktree.
 * Idempotent: an already-cloned volume only re-verifies the checkout.
 */
async function setupVolumeWorkspace(
  name: string,
  cwd: string,
  repo: Repo,
  branch: string,
): Promise<void> {
  // A fresh named volume's mountpoint is root-owned (the path doesn't exist
  // in the image, so there's no ownership to copy) — chown before cloning.
  const own = await docker(["exec", "-u", "0", name, "chown", "1000:1000", assertSafePath(cwd)]);
  if (own.exitCode !== 0) {
    throw new Error(`sandbox ${name}: chown of workspace volume failed: ${own.stderr.trim().slice(0, 300)}`);
  }
  const cloned = await docker(["exec", name, "test", "-d", `${cwd}/.git`]);
  if (cloned.exitCode !== 0) {
    const originUrl = await repoOriginUrl(repo.repo);
    // Redact credentials before logging — https origins can carry a token in
    // the userinfo part (https://x-access-token:ghp_…@github.com/…).
    const loggedUrl = originUrl.replace(/^(https?:\/\/)[^@/]+@/, "$1");
    console.log(`[sandbox] ${name}: cloning ${loggedUrl} into workspace volume at ${cwd}`);
    const clone = await docker(
      ["exec", name, "git", "clone", "--", originUrl, cwd],
      { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`sandbox ${name}: in-container clone failed: ${clone.stderr.trim().slice(0, 500)}`);
    }
  }
  const cur = await docker(["exec", "-w", assertSafePath(cwd), name, "git", "branch", "--show-current"]);
  if (cur.exitCode === 0 && cur.stdout.trim() === branch) return;
  const hasRemote = await docker([
    "exec", "-w", cwd, name,
    "git", "rev-parse", "--verify", "--quiet", `origin/${branch}`,
  ]);
  const startPoint = hasRemote.exitCode === 0 ? `origin/${branch}` : `origin/${repo.defaultBranch}`;
  const co = await docker(["exec", "-w", cwd, name, "git", "checkout", "-B", branch, startPoint]);
  if (co.exitCode !== 0) {
    throw new Error(`sandbox ${name}: checkout -B ${branch} ${startPoint} failed: ${co.stderr.trim().slice(0, 300)}`);
  }
}

/**
 * In-container dirs that must be ubuntu-owned for the runner to work, but that
 * docker materializes ROOT-owned when it creates missing parents of bind-mount
 * targets. The chats dir is the canonical case: the per-session run dir is
 * mounted at `<chats>/sandbox-runs/<id>`, and when the image doesn't pre-seed
 * `<chats>` under the CURRENT name (the rename moved it from ~/.backstage-chats
 * to ~/.opensession-chats — an image built before that only seeds the old
 * name), docker creates `<chats>` + `<chats>/sandbox-runs` as root and the
 * in-container opencode runner then EACCESes on `mkdir <chats>/opencode`
 * (regressed 2026-07-09, bks-019f4742-e65c). Exported for the regression test.
 */
export function containerStateDirFixups(): string[] {
  return [OPENSESSION_CHATS_DIR, `${OPENSESSION_CHATS_DIR}/sandbox-runs`];
}

/** One-time in-container setup after (re)start. Idempotent. */
async function setupContainer(name: string, cwd: string): Promise<void> {
  // Seed ~/.claude/settings.json when the volume is empty — the volume mount
  // shadows the image's seeded file (docker's copy-up covers the very first
  // mount, but not a volume that was created empty out-of-band).
  const seed = await docker([
    "exec", name, "sh", "-c",
    `test -s ${HOME}/.claude/settings.json || printf '{}' > ${HOME}/.claude/settings.json`,
  ]);
  if (seed.exitCode !== 0) {
    throw new Error(`sandbox ${name}: seeding ~/.claude failed: ${seed.stderr.trim().slice(0, 300)}`);
  }
  // Re-own the docker-created mount-target parents (see containerStateDirFixups).
  // Only the dirs themselves, never -R: their CONTENTS are bind mounts owned by
  // the host. Idempotent, and works with images from before the state rename.
  const fixups = containerStateDirFixups().map((d) => assertSafePath(d));
  const own = await docker([
    "exec", "-u", "0", name, "sh", "-c",
    `mkdir -p ${fixups.join(" ")} && chown 1000:1000 ${fixups.join(" ")}`,
  ]);
  if (own.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: re-owning state dirs failed: ${own.stderr.trim().slice(0, 300)}`,
    );
  }
  // Trap (b) from the plan: verify the worktree actually works inside — the
  // .git pointer file must resolve through the mounted common dir.
  const git = await docker(["exec", "-w", assertSafePath(cwd), name, "git", "status", "--porcelain"]);
  if (git.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: git status failed inside the container (worktree/.git mounts broken?): ${git.stderr.trim().slice(0, 300)}`,
    );
  }
}

/**
 * Repo-local lifecycle hook `.backstage/setup.sh` (the background-agents
 * convention, kept minimal): run ONCE per workspace materialization, inside
 * the container, cwd = the workspace — the place for repo-specific dep
 * installs / codegen a sandboxed dev server needs. Skipped when the container
 * was restored from a snapshot (its container layer already carries the
 * setup's effects — that's what snapshots capture). Failure logs loudly but
 * never blocks the session, and is NOT retried (one-shot semantics; the log
 * lives in the session's bind-mounted run dir). `.backstage/start.sh` is the
 * sibling hook — preview.ts runs it as the dev-server bring-up.
 *
 * Returns true when the hook is settled (ran / skipped / absent) so the
 * caller records `setupRan` and never re-enters.
 */
async function runWorkspaceSetup(
  name: string,
  sessionId: string,
  cwd: string,
  bootMode: "fresh" | "snapshot-restore",
): Promise<boolean> {
  // Repo hooks: `.opensession/setup.sh` (new) with `.backstage/setup.sh`
  // (pre-rename) fallback.
  let script = `${cwd}/.opensession/setup.sh`;
  let probe = await docker(["exec", name, "test", "-f", script]);
  if (probe.exitCode !== 0) {
    script = `${cwd}/.backstage/setup.sh`;
    probe = await docker(["exec", name, "test", "-f", script]);
  }
  if (probe.exitCode !== 0) return true; // no hook — settled
  if (bootMode === "snapshot-restore") {
    console.log(`[sandbox] ${name}: skipping ${script} (snapshot restore carries its effects)`);
    return true;
  }
  const log = assertSafePath(`${sessionRunsDir(sessionId)}/workspace-setup.log`);
  console.log(`[sandbox] ${name}: running workspace setup hook ${script} (log: ${log})`);
  const r = await docker(
    [
      "exec", "-w", assertSafePath(cwd),
      "-e", `OPENSESSION_BOOT_MODE=${bootMode}`,
      "-e", `BACKSTAGE_BOOT_MODE=${bootMode}`, // deprecated alias for older hooks
      name,
      "sh", "-c", `bash ${assertSafePath(script)} >> ${log} 2>&1`,
    ],
    { timeoutMs: SETUP_TIMEOUT_MS },
  );
  if (r.exitCode !== 0) {
    console.warn(
      `[sandbox] ${name}: workspace setup hook failed (exit ${r.exitCode}) — continuing; see ${log}`,
    );
  }
  return true;
}

// ── The docker HostLauncher: `docker exec` instead of systemd-run ─────────────

function makeDockerLauncher(container: string, sessionId: string): HostLauncher {
  return {
    async alive(dir, meta: RunHostMeta | null) {
      if (!meta?.pid) return false;
      const r = await docker(["exec", container, "kill", "-0", String(meta.pid)]);
      return r.exitCode === 0;
    },
    newRunDir: (hostId) => `${sessionRunsDir(sessionId)}/${sanitizeName(hostId)}`,
    // WS-transport runs (spec.wsToken present) attach through the run-ws
    // dial-back instead of the run dir's unix socket. Socket runs return
    // undefined = HostHandle's default unix connector.
    connector: (_dir, spec) =>
      spec.wsToken ? runWsConnector(spec.hostId) : undefined,
    async launch(hostId, dir) {
      await ensureStarted(container);
      const specPath = assertSafePath(`${dir}/${HOST_SPEC_NAME}`);
      const logPath = assertSafePath(`${dir}/${HOST_LOG_NAME}`);
      // Detached exec (-d): the in-container host must NOT die with backstage —
      // its socket lives on the bind-mounted run dir, so a restarted backstage
      // reconnects. All output goes to the run dir's host.log (host-visible).
      // Env mirrors what launchHostUnit provides, MINUS ~/.backstage.env:
      // the container gets no ambient credentials; MCP servers carry their own
      // env via mcp-config.json, and the account pool file is mounted ro.
      const env = (kv: string) => ["-e", kv];
      // WS transport: register the run's dial-back token (spec.json was just
      // written to `dir` — respawns included) and point the host at the run-ws
      // + rpc-ws routes instead of socket paths.
      const spec = readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
      const wsEnv: string[] = [];
      if (spec?.wsToken) {
        const base = sandboxCallbackBaseUrl();
        registerRunWsHost(hostId, spec.wsToken);
        wsEnv.push(
          // Primary prefix — the server accepts /backstage too, so URLs baked
          // into already-running containers stay valid.
          ...env(`BKS_RUN_WS_URL=${base}/opensession/run-ws/${hostId}`),
          ...env(`BKS_RUN_WS_TOKEN=${spec.wsToken}`),
          ...env(`BKS_RPC_WS_URL=${base}/opensession/rpc-ws`),
        );
      }
      const args = [
        "exec", "-d",
        // New env names primary; deprecated aliases ride along so an
        // un-migrated in-container build keeps working.
        ...env(`OPENSESSION_RUN_JOURNAL=${dir}/journal.json`),
        ...env(`BACKSTAGE_RUN_JOURNAL=${dir}/journal.json`),
        ...env("NODE_ENV=production"),
        ...(envAlias("OPENSESSION_MODEL", "MICHAEL_MODEL")
          ? [
              ...env(`OPENSESSION_MODEL=${envAlias("OPENSESSION_MODEL", "MICHAEL_MODEL")}`),
              ...env(`MICHAEL_MODEL=${envAlias("OPENSESSION_MODEL", "MICHAEL_MODEL")}`),
            ]
          : []),
        ...(envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE")
          ? [
              ...env(`OPENSESSION_UI_BASE=${envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE")}`),
              ...env(`MICHAEL_UI_BASE=${envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE")}`),
            ]
          : []),
        ...wsEnv,
        container,
        "sh", "-c",
        `exec bun run ${assertSafePath(HOST_ENTRY)} ${specPath} >> ${logPath} 2>&1`,
      ];
      const r = await docker(args);
      if (r.exitCode !== 0) {
        if (spec?.wsToken) unregisterRunWsHost(hostId);
        throw new Error(`docker exec (run host) failed: ${r.stderr.trim().slice(0, 400)}`);
      }
    },
  };
}

// ── Run journal bookkeeping (backstage side) ──────────────────────────────────

function recordForSpec(spec: RunHostSpec, sandboxId: string): ActiveRunRecord {
  return {
    runKey: spec.hostId,
    bksSessionId: spec.bksSessionId,
    claudeSessionId: spec.engineSessionId,
    prompt: spec.prompt,
    cwd: spec.cwd,
    mode: spec.mode,
    mcpServers: spec.mcpServers,
    user: spec.user,
    deniedTools: spec.deniedTools,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    model: spec.model,
    effort: spec.effort,
    fastMode: spec.fastMode,
    accountId: spec.accountId,
    accountStrict: spec.accountStrict,
    usageCredits: spec.usageCredits,
    fallbackModel: spec.fallbackModel,
    sandboxId,
    sandboxProvider: "docker",
    kind: spec.journalKind || "prompt",
    startedAt: new Date().toISOString(),
  };
}

/**
 * Journal the run in the shared active-runs.json (with sandboxId/provider so
 * resumeInterruptedRuns can reattach through this module after a restart),
 * track the engine session id from init events, and clear on completion.
 */
async function* withRunJournal(
  events: AsyncGenerator<StreamEvent>,
  record: ActiveRunRecord,
): AsyncGenerator<StreamEvent> {
  journalSet(record);
  touchStateActivity(record.sandboxId!);
  let sawDone = false;
  try {
    for await (const ev of events) {
      if (ev.type === "init" && ev.sessionId && ev.sessionId !== record.claudeSessionId) {
        record.claudeSessionId = ev.sessionId;
        journalSet(record);
      }
      if (ev.type === "done") sawDone = true;
      yield ev;
    }
  } finally {
    journalClear(record.runKey);
    touchStateActivity(record.sandboxId!);
    if (sawDone) schedulePostRunSnapshot(record.sandboxId!);
  }
}

/**
 * Post-prompt snapshot (background-agents' "snapshot after every turn",
 * adapted): after a sandboxed run completes SUCCESSFULLY, commit the
 * container layer so a later docker-rm/reboot restores warm. Guarded by
 * config `snapshots.enabled` (same switch as the idle-stop snapshot);
 * delayed a few seconds so the run's host-registry control has deregistered
 * (snapshotSandboxImage refuses while the session reads busy) and deduped
 * per sandbox so back-to-back turns don't stack commits.
 */
function schedulePostRunSnapshot(sandboxId: string): void {
  if (!sandboxSnapshots().enabled) return;
  const g = globalThis as { __sandboxPostRunSnaps?: Set<string> };
  const pending = (g.__sandboxPostRunSnaps ??= new Set());
  if (pending.has(sandboxId)) return;
  pending.add(sandboxId);
  setTimeout(() => {
    pending.delete(sandboxId);
    snapshotSandboxImage(sandboxId)
      .then((img) => {
        if (img) console.log(`[sandbox] post-run snapshot of ${sandboxId} → ${img}`);
      })
      .catch((e) => console.warn(`[sandbox] post-run snapshot of ${sandboxId} failed:`, e));
  }, 8_000);
}

// ── Sandbox handle ────────────────────────────────────────────────────────────

function makeDockerSandbox(
  sandboxId: string,
  sessionId: string,
  cwd: string,
  workspace: "bind" | "volume" = "bind",
  transport: SandboxTransport = "socket",
  bootMode: "fresh" | "snapshot-restore" = "fresh",
): Sandbox {
  const launcher = makeDockerLauncher(sandboxId, sessionId);
  const sandboxHandle: Sandbox = {
    id: sandboxId,
    provider: "docker",
    cwd,
    workspace,
    bootMode,

    async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
      await ensureStarted(sandboxId);
      const envArgs = Object.entries(opts?.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      return docker(["exec", "-w", cwd, ...envArgs, sandboxId, ...cmd]);
    },

    /**
     * Eager variant: awaits the docker exec + socket connect and THROWS on any
     * launch failure, so callers with a fallback (maybeLaunchSandboxedRun →
     * host run) can catch it before committing the turn to the sandbox.
     */
    async launchRunEager(spec: RunHostSpec, cb?: RunHandleCallbacks): Promise<RunHandle> {
      const dir = launcher.newRunDir(spec.hostId);
      const callbacks: HandleCallbacks = {
        onAskUser: cb?.onAskUser,
        onSteerFailed: cb?.onSteerFailed,
      };
      // WS transport: mint the dial-back token BEFORE the spec is written —
      // launch() reads it back from spec.json (fresh launches and respawns
      // alike) and registers it with the run-ws route.
      if (transport === "ws") spec.wsToken ??= crypto.randomUUID();
      const record = recordForSpec(spec, sandboxId);
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec);
      let handle: HostHandle | undefined;
      // Per-step marks: a stalled await in this chain is otherwise silent
      // (2026-07-09: launches ran in-sandbox while backstage never attached).
      const t0 = Date.now();
      const mark = (step: string) =>
        console.log(`[sandbox] launch ${spec.hostId.slice(0, 11)}: ${step} (+${Date.now() - t0}ms)`);
      try {
        await launcher.launch(spec.hostId, dir);
        mark("host exec dispatched");
        handle = new HostHandle(dir, spec, callbacks, launcher);
        await handle.connectWithWait(30_000);
        mark("host attached");
      } catch (e) {
        // The HostHandle ctor registered its control in the host-registry —
        // drop it (and the caller-registered run token) on any launch failure,
        // or hostRunBusy(bksSessionId) stays true forever: every future prompt
        // reads busy and the idle-stop sweep skips the container.
        handle?.abandon();
        unregisterRunToken(spec.rpcToken);
        // abandon() disposes the handle's connector (which unregisters the ws
        // token); cover the pre-handle failure path too. Idempotent.
        if (spec.wsToken) unregisterRunWsHost(spec.hostId);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        throw e;
      }
      const gen = withRunJournal(handle.events(), record);
      return {
        events: () => gen,
        steerable: providerFor(spec.model) !== "codex",
        // HostHandle registers its control in host-registry keyed by the bks
        // session id — route through the same helpers the WS handlers use.
        steer: (text) => hostSteer(spec.bksSessionId, text),
        interruptSteer: (text) => hostInterruptSteer(spec.bksSessionId, text),
        cancel: () => hostCancel(spec.bksSessionId),
      };
    },

    launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle {
      // Setup is async but RunHandle is sync — do the launch inside the
      // generator (consumed exactly once, like every runner entry point) and
      // degrade a launch failure to an error event. Callers that can fall back
      // to another backend should prefer launchRunEager above.
      const gen = (async function* (): AsyncGenerator<StreamEvent> {
        let eager: RunHandle;
        try {
          eager = await sandboxHandle.launchRunEager!(spec, cb);
        } catch (e: any) {
          yield {
            type: "error",
            content: `Sandbox run failed to start: ${e?.message || e}`,
          };
          return;
        }
        yield* eager.events();
      })();
      return {
        events: () => gen,
        steerable: providerFor(spec.model) !== "codex",
        steer: (text) => hostSteer(spec.bksSessionId, text),
        interruptSteer: (text) => hostInterruptSteer(spec.bksSessionId, text),
        cancel: () => hostCancel(spec.bksSessionId),
      };
    },

    // Live published-port mapping (container port → loopback host port).
    // Empty when the container isn't running or no previewPorts are
    // configured. preview.ts routes Caddy at the host side of this map.
    async ports(): Promise<PortMap> {
      const r = await docker(["port", sandboxId]);
      if (r.exitCode !== 0) return {};
      const map: PortMap = {};
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^(\d+)\/tcp -> (?:\[[^\]]*\]|[0-9.]+):(\d+)\s*$/);
        if (!m) continue;
        const inner = parseInt(m[1], 10);
        if (!(inner in map)) map[inner] = parseInt(m[2], 10);
      }
      return map;
    },

    status: () => containerStatus(sandboxId),
  };
  return sandboxHandle;
}

// ── Idle-stop sweep ───────────────────────────────────────────────────────────

/** Exported for the verify suite, which backdates a state file and calls it
 *  directly to exercise the real snapshot-then-stop ordering. `onlySandboxId`
 *  scopes the sweep to one sandbox (verify must never snapshot/stop the live
 *  server's sandboxes with its scratch config) and skips the orphan sweep. */
export async function sweepIdleSandboxes(onlySandboxId?: string): Promise<void> {
  const cfg = sandboxConfig();
  const idleMs = (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  let states: string[] = [];
  try {
    states = existsSync(STATE_DIR) ? readdirSync(STATE_DIR) : [];
  } catch {
    return;
  }
  for (const f of states) {
    if (!f.endsWith(".json")) continue;
    const state = readState(f.slice(0, -5));
    if (!state) continue;
    if (onlySandboxId && state.sandboxId !== onlySandboxId) continue;
    try {
      if ((await containerStatus(state.sandboxId)) !== "running") continue;
      // Idle = no active run for the session (host-registry has a live control
      // handle for every attached run) and no activity inside the window.
      if (hostRunBusy(state.sessionId)) continue;
      const last = Date.parse(state.lastActivityAt || state.createdAt) || 0;
      if (Date.now() - last < idleMs) continue;
      // Snapshot BEFORE the stop (warm-restore pattern). A failure logs and
      // never blocks the stop; snapshotSandboxImage itself refuses while a run
      // is active (defense — the busy check above already covered it).
      const snaps = sandboxSnapshots();
      if (snaps.enabled && snaps.onIdle) {
        try {
          const img = await snapshotSandboxImage(state.sandboxId);
          if (img) console.log(`[sandbox] snapshotted ${state.sandboxId} → ${img} before idle-stop`);
        } catch (e) {
          console.warn(`[sandbox] idle snapshot of ${state.sandboxId} failed (stopping anyway):`, e);
        }
        // A run may have started during the (slow) commit — don't stop it now.
        if (hostRunBusy(state.sessionId)) continue;
      }
      console.log(`[sandbox] stopping idle container ${state.sandboxId} (idle > ${idleMs / 60_000}m)`);
      await docker(["stop", "-t", "10", state.sandboxId], { timeoutMs: 60_000 });
    } catch (e) {
      console.warn(`[sandbox] idle sweep failed for ${state.sandboxId}:`, e);
    }
  }
  if (!onlySandboxId) await sweepOrphanSnapshots();
}

/** Arm the idle-stop sweep once per process; parked on globalThis like the
 *  other schedulers so `bun --hot` reloads don't stack timers. */
function ensureIdleSweep(): void {
  const g = globalThis as any;
  if (g.__sandboxIdleSweepTimer) return;
  g.__sandboxIdleSweepTimer = setInterval(() => {
    void sweepIdleSandboxes();
  }, SWEEP_INTERVAL_MS);
}

// ── Provider ──────────────────────────────────────────────────────────────────

// NOT prewarmed: the warm-on-typing prewarm pool (src/server/sandbox/
// prewarm.ts) is remote-only by design. Docker mounts — workspace bind/volume,
// run dir, per-session claude/codex state volumes — are fixed at `docker
// create` time, so a container created before the session exists could never
// get the session's mounts; and a cold docker ensure is ~2-3s anyway (the
// image is prebaked, and a worktree's `git fetch origin` measured ~1.5s on
// this host — under the threshold where prewarming it would pay).

// Workspace resolution is delegated here so a cwd derived through the docker
// provider is byte-identical to the local provider's (and to the session
// paths' own resolution, which passes an already-resolved cwd in `spec.cwd`).
const localResolver = new LocalProvider();

/**
 * Serialize ensure() per session: two simultaneous ensures (e.g. a prompt and
 * a queued drain racing after a restart) would both see status "gone" and race
 * `docker create --name` — the loser errors and its turn falls back to the
 * host. Same in-process chain pattern as worktree.ts's withGitLock, parked on
 * globalThis so `bun --hot` reloads don't fork the chains.
 */
function withEnsureLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as {
    __sandboxEnsureChains?: Map<string, Promise<unknown>>;
  };
  const chains = (g.__sandboxEnsureChains ??= new Map());
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(sessionId, tail);
  void tail.finally(() => {
    if (chains.get(sessionId) === tail) chains.delete(sessionId);
  });
  return run;
}

export class DockerProvider implements SandboxProvider {
  readonly id = "docker" as const;

  /**
   * Create-or-reuse the session's container. The worktree itself is resolved
   * HOST-SIDE first (worktree creation, .env seeding, bun install all stay on
   * the host in Phase 1 — the container only ever sees the finished dir).
   */
  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withEnsureLock(spec.sessionId, () => this.ensureInner(spec));
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    ensureIdleSweep();
    const name = containerNameFor(spec.sessionId);
    const existing = readState(name);

    // Workspace mode. Sticky per sandbox: the state file's recorded mode wins
    // over a later config flip (a volume workspace's data lives in its volume
    // — re-binding it to a host path would orphan the work, and vice versa).
    // Volume applies only to workspaces with no host dir: an existing host
    // worktree (pre-existing session, shared workspace) stays bind-mounted.
    const repo = getRepo(spec.repo || existing?.repoId);
    const branch = spec.branch || existing?.branch;
    const canonical =
      spec.cwd || (branch ? worktreePathFor(branch, repo.id, { isolated: true }) : undefined);
    const wantVolume = existing?.workspace
      ? existing.workspace === "volume"
      : sandboxConfig().workspace === "volume";
    let workspace: "bind" | "volume";
    let cwd: string;
    if (wantVolume && canonical && !existsSync(canonical) && spec.mode !== "ask") {
      if (!branch) {
        throw new Error("volume-mode sandbox needs a branch to clone/check out");
      }
      workspace = "volume";
      cwd = canonical;
    } else {
      // Bind mode resolves the workspace HOST-SIDE first (worktree creation,
      // .env seeding, bun install all stay on the host — the container only
      // ever sees the finished dir).
      workspace = "bind";
      cwd = (await localResolver.ensure(spec)).cwd;
    }
    // A main checkout must never be bind-mounted rw into a sandbox as its
    // workspace: shared checkouts (backstage self-hosting) and repo mainlines
    // stay host-only forever (docs/sandboxes-plan.md §7.2). This also catches
    // the "falsy worktreeDir defaulted to the main checkout" session shape.
    if (isMainCheckout(cwd)) {
      throw new Error(
        `refusing to sandbox ${cwd}: it is a shared main checkout — docker sandboxes only run isolated worktrees`,
      );
    }
    const attachedDirs = [...new Set(spec.attachedDirs || existing?.attachedDirs || [])]
      .filter((d) => existsSync(d))
      .sort();
    if (workspace === "volume" && attachedDirs.length) {
      throw new Error(
        "attached repos are not supported in volume-mode sandboxes — detach them or use bind mode",
      );
    }

    // Transport follows the CURRENT config (not sticky): a flip changes the
    // mount set (rpc socket vs none), so a mismatched container is recreated
    // below — that's the safe migration path, volumes survive the rm.
    const transport = sandboxTransport();

    let status = await containerStatus(name);
    // Whether this ensure() (re)started the container — drives the stale-
    // .tunnels.env clear below (the supervisor-on-boot equivalent of the
    // background-agents contract).
    const wasRunning = status === "running";
    if (
      status !== "gone" &&
      existing &&
      (existing.cwd !== cwd ||
        (existing.transport || "socket") !== transport ||
        (existing.attachedDirs || []).join("\n") !== attachedDirs.join("\n"))
    ) {
      // The session's workspace moved (branch/worktree changed), the run
      // transport flipped, or the attached-repo set changed — the old
      // container's mounts are stale. Recreate it; the named volumes (engine
      // state AND a volume-mode workspace) survive `docker rm`.
      console.warn(`[sandbox] ${name}: mounts changed (${existing.cwd} → ${cwd}, transport ${existing.transport || "socket"} → ${transport}); recreating container`);
      await docker(["rm", "-f", name]);
      status = "gone";
    }
    // Image the container runs. A GONE container with a snapshot image
    // (snapshots enabled) is restored FROM the snapshot — container-layer
    // state (installed deps/apt/caches) comes back; volumes/bind mounts carry
    // engine + workspace state regardless (see the "Snapshots" header).
    let image = existing?.image || sandboxConfig().image || DEFAULT_IMAGE;
    let restoredFromSnapshot = false;
    let bootMode: "fresh" | "snapshot-restore" = existing?.bootMode || "fresh";
    if (status === "gone") {
      image = sandboxConfig().image || DEFAULT_IMAGE;
      if (sandboxSnapshots().enabled) {
        const snapImage = await latestSnapshotImage(name);
        if (snapImage) {
          image = snapImage;
          restoredFromSnapshot = true;
          console.log(`[sandbox] ${name}: creating container from snapshot ${snapImage}`);
        }
      }
      bootMode = restoredFromSnapshot ? "snapshot-restore" : "fresh";
      await createContainer(name, spec.sessionId, cwd, {
        workspace,
        attachedDirs,
        repo: workspace === "volume" ? repo : undefined,
        transport,
        image,
      });
    }
    await ensureStarted(name);
    if (workspace === "volume") {
      await setupVolumeWorkspace(name, cwd, repo, branch!);
      if (restoredFromSnapshot && sandboxSnapshots().quickSyncOnRestore) {
        // Quick sync after a snapshot restore: freshen refs only — NEVER a
        // reset/checkout; un-pushed work in the volume stays untouched.
        const f = await docker(
          ["exec", "-w", assertSafePath(cwd), name, "git", "fetch", "origin"],
          { timeoutMs: 120_000 },
        );
        if (f.exitCode !== 0) {
          console.warn(`[sandbox] ${name}: quick-sync git fetch failed (continuing): ${f.stderr.trim().slice(0, 200)}`);
        } else {
          await docker(["exec", "-w", cwd, name, "git", "status", "--porcelain"]);
        }
      }
    }
    await setupContainer(name, cwd);
    // Container (re)start: clear a stale .tunnels.env — its URLs described the
    // previous boot's preview; startSandboxPreview rewrites it fresh.
    if (!wasRunning) {
      await docker(["exec", name, "sh", "-c", `rm -f ${assertSafePath(cwd)}/.tunnels.env`]);
    }
    // One-shot `.backstage/setup.sh` lifecycle hook (skipped on snapshot
    // restore; never retried once settled — see runWorkspaceSetup).
    let setupRan = existing?.setupRan === true;
    if (!setupRan) {
      setupRan = await runWorkspaceSetup(name, spec.sessionId, cwd, bootMode);
    }
    writeState({
      sandboxId: name,
      sessionId: spec.sessionId,
      cwd,
      image,
      createdAt: existing?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      workspace,
      repoId: repo.id,
      transport,
      bootMode,
      ...(setupRan ? { setupRan } : {}),
      ...(branch ? { branch } : {}),
      ...(attachedDirs.length ? { attachedDirs } : {}),
    });
    return makeDockerSandbox(name, spec.sessionId, cwd, workspace, transport, bootMode);
  }

  /**
   * Reattach after a restart. A stopped container is fine (launchRun/exec
   * start it lazily); a REMOVED container is recreated from the provider's
   * state file when possible, since the volumes (engine state) outlive it.
   */
  async get(sandboxId: string): Promise<Sandbox | null> {
    ensureIdleSweep();
    const state = readState(sandboxId);
    const status = await containerStatus(sandboxId);
    if (status === "gone") {
      if (!state) return null;
      try {
        return await this.ensure({
          sessionId: state.sessionId,
          cwd: state.cwd,
          repo: state.repoId,
          branch: state.branch,
          attachedDirs: state.attachedDirs,
        });
      } catch (e) {
        console.warn(`[sandbox] could not recreate ${sandboxId}:`, e);
        return null;
      }
    }
    if (!state) {
      // Container exists but state was lost — recover what we can from labels.
      const r = await docker(["inspect", "-f", "{{index .Config.Labels \"backstage.session\"}}", sandboxId]);
      const sessionId = r.exitCode === 0 ? r.stdout.trim() : "";
      if (!sessionId) return null;
      const runs = await docker(["inspect", "-f", "{{range .Mounts}}{{.Source}}\n{{end}}", sandboxId]);
      // cwd is unknowable without state; refuse rather than guess.
      console.warn(`[sandbox] ${sandboxId} has no state file — exec-only reattach (mounts: ${runs.stdout.split("\n")[0] || "?"})`);
      return null;
    }
    return makeDockerSandbox(
      sandboxId,
      state.sessionId,
      state.cwd,
      state.workspace || "bind",
      state.transport || "socket",
      state.bootMode || "fresh",
    );
  }

  /** Tear down container + its named volumes + snapshot images + provider
   *  state. A bind-mode worktree is untouched (it belongs to the host's
   *  worktree lifecycle); a volume-mode WORKSPACE is deleted with its `-ws`
   *  volume — that data loss is the mode's documented contract (push your
   *  work). */
  async destroy(sandboxId: string): Promise<void> {
    await docker(["rm", "-f", sandboxId]);
    await docker([
      "volume", "rm", "-f",
      `${sandboxId}-claude`, `${sandboxId}-codex`, `${sandboxId}-ws`,
    ]);
    await removeSnapshotImages(sandboxId);
    // Release the sandbox's https-port allocations + their Caddy routes.
    await dropSandboxPreviewRoutes(sandboxId).catch(() => {});
    const state = readState(sandboxId);
    try {
      unlinkSync(statePath(sandboxId));
    } catch {}
    if (state) {
      try {
        rmSync(sessionRunsDir(state.sessionId), { recursive: true, force: true });
      } catch {}
    }
  }
}

// ── Restart-resume (called from agent-runner's resumeInterruptedRuns) ─────────

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Resume a journaled docker-sandbox run after a backstage restart.
 *
 *  1. If the in-container run host is STILL ALIVE (containers outlive the
 *     backstage process), reattach to its socket — nothing is re-prompted.
 *  2. If it ended while we were down, deliver its terminal event.
 *  3. Otherwise relaunch in the same sandbox with the standard continuation
 *     prompt against the journaled engine session.
 *
 * Returns null when the sandbox is gone and can't be recreated (the caller
 * logs it; the session's next user prompt will re-ensure a container).
 */
export async function resumeDockerSandboxRun(
  run: ActiveRunRecord,
  cb: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | null> {
  if (!run.sandboxId || !run.bksSessionId) return null;
  const provider = new DockerProvider();
  const sandbox = await provider.get(run.sandboxId);
  if (!sandbox) return null;

  const launcher = makeDockerLauncher(run.sandboxId, run.bksSessionId);
  const oldDir = launcher.newRunDir(run.runKey);
  const oldSpec = readJsonSafe<RunHostSpec>(`${oldDir}/${HOST_SPEC_NAME}`);
  if (oldSpec) {
    const meta = readJsonSafe<RunHostMeta>(`${oldDir}/${HOST_META_NAME}`);
    if (meta?.done) {
      // Ended while backstage was down: hand the terminal event to the normal
      // consumption bookkeeping, then clean up.
      try {
        rmSync(oldDir, { recursive: true, force: true });
      } catch {}
      const done = meta.done;
      return (async function* () {
        yield done;
      })();
    }
    if ((await containerStatus(run.sandboxId)) === "running" && (await launcher.alive(oldDir, meta))) {
      if (oldSpec.rpcToken) {
        registerRunToken(oldSpec.rpcToken, { sessionId: oldSpec.bksSessionId, user: oldSpec.user });
      }
      // WS-transport run: re-register the dial-back token so the still-alive
      // host's reconnect loop can get back in (it's been retrying since the
      // restart dropped the route).
      if (oldSpec.wsToken) registerRunWsHost(oldSpec.hostId, oldSpec.wsToken);
      console.log(`[sandbox] reattaching to live run ${run.runKey} in ${run.sandboxId}`);
      const handle = new HostHandle(oldDir, oldSpec, cb, launcher);
      try {
        await handle.connectWithWait(15_000);
      } catch (e) {
        // Drop the host-registry control the ctor registered (and the run
        // token registered just above) — a failed reattach must not leave
        // hostRunBusy() true forever. Keep oldDir: the in-container host may
        // still be alive, and a later resume attempt needs the spec.
        handle.abandon();
        throw e;
      }
      return withRunJournal(handle.events(), { ...run, startedAt: run.startedAt });
    }
  }

  // Host process died with (or before) the restart — relaunch a continuation
  // in the same sandbox so the engine session's in-container state is reused.
  const prompt = run.claudeSessionId ? RESUME_CONTINUATION_PROMPT : run.prompt;
  if (!prompt) return null;
  const rpcToken = oldSpec?.proxyMcpServers?.length ? crypto.randomUUID() : undefined;
  if (rpcToken) registerRunToken(rpcToken, { sessionId: run.bksSessionId, user: run.user });
  const spec: RunHostSpec = {
    hostId: `rh-${Bun.randomUUIDv7()}`,
    bksSessionId: run.bksSessionId,
    prompt,
    engineSessionId: run.claudeSessionId,
    cwd: run.cwd,
    mode: run.mode,
    model: run.model,
    sandboxed: true,
    mcpServers: run.mcpServers,
    proxyMcpServers: oldSpec?.proxyMcpServers,
    rpcToken,
    reposNote: oldSpec?.reposNote,
    deniedTools: run.deniedTools,
    confirmTools: run.confirmTools,
    aws: run.aws,
    author: oldSpec?.author,
    user: run.user,
    fallbackModel: run.fallbackModel,
    effort: run.effort,
    fastMode: run.fastMode,
    accountId: run.accountId,
    accountStrict: run.accountStrict,
    usageCredits: run.usageCredits,
    journalKind: `${run.kind || "prompt"}-resume`,
  };
  try {
    if (oldDir && existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  } catch {}
  console.log(`[sandbox] relaunching interrupted run ${run.runKey} in ${run.sandboxId} as ${spec.hostId}`);
  return sandbox.launchRun(spec, { onAskUser: cb.onAskUser }).events();
}
