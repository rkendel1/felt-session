/**
 * Sandbox configuration (sandbox rollout Phase 0).
 *
 * `~/.opensession-sandbox.json` (dual-read fallback to `~/.opensession-sandbox.json`)
 * picks the provider, e.g.
 *   {"provider": "docker", "image": "opensession-runner:latest",
 *    "idleStopMinutes": 30, "perRepo": {"app": {"provider": "docker"}}}
 *
 * Read fresh on every call (same pattern as codexTransport() reading
 * ~/.opensession-codex-transport.json) so a config flip applies to the next run
 * without a restart. Missing/invalid config = provider "local" = exactly
 * today's behavior.
 *
 * Kill switch: `touch <sessions-dir>/disable-sandboxes` forces "local" for
 * new runs regardless of config — mirroring host-client's disable-run-hosts.
 */

import { existsSync, readFileSync } from "fs";
import { getDefaultModel, providerFor, resolveModel } from "../models";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "../paths";
import { stateDir } from "../paths";
import type { SandboxProviderId } from "./provider";

const HOME = homeDir();
// Env-overridable so the verify suite (and unit tests) can point a scratch
// config at a scratch docker setup without touching the live file (which is
// read fresh per run). Read per call, not at module load, so a test can flip
// the env var without re-importing this module.
function configPath(): string {
  return (
    process.env.OPENSESSION_SANDBOX_CONFIG ||
    stateDir("sandbox.json")
  );
}
const DISABLE_FILE = `${OPENSESSION_SESSIONS_DIR}/disable-sandboxes`;

function modalConfigHasCredentials(): boolean {
  try {
    const path = process.env.MODAL_CONFIG_PATH || `${HOME}/.modal.toml`;
    const text = readFileSync(path, "utf-8");
    return /(?:^|\n)token_id\s*=/.test(text) && /(?:^|\n)token_secret\s*=/.test(text);
  } catch {
    return false;
  }
}

export interface SandboxRepoOverride {
  provider?: SandboxProviderId;
  image?: string;
}

/** Where a docker sandbox's workspace lives (sandbox rollout Phase 2):
 *  "bind" (default) bind-mounts the existing host worktree at its identical
 *  path; "volume" clones the repo into a per-session volume INSIDE the
 *  container — no host worktree at all, so destroy() deletes the workspace
 *  (that data loss is the mode's contract; push your work). */
export type SandboxWorkspaceMode = "bind" | "volume";

/** How a sandboxed run's host process talks to opensession (Phase 3):
 *  "socket" (default) = unix socket in a shared run dir (docker bind mounts
 *  it); "ws" = the host DIALS OUT to opensession's /run-ws route —
 *  required for remote providers (daytona/e2b force it), dogfooded by docker. */
export type SandboxTransport = "socket" | "ws";

/** How remote providers authenticate `git clone` inside the sandbox (they
 *  can't mount host creds). "none" = public clone; "https-token" injects the
 *  token into the https URL (GitHub PAT / x-access-token). */
export interface SandboxCloneCredential {
  type: "none" | "https-token";
  token?: string;
}

/** Snapshot-based warm restores for the docker provider (background-agents
 *  pattern, adapted): on idle-stop the container is `docker commit`ed to a
 *  per-session image, and a later ensure() for a GONE container starts from
 *  that image instead of the base one — preserving container-layer state
 *  (installed deps/apt/global caches), NOT workspace or engine state (those
 *  live on volumes/bind mounts). See docker.ts's "Snapshots" header section. */
export interface SandboxSnapshotsConfig {
  /** Master switch. Default false — no snapshot is ever taken or restored. */
  enabled: boolean;
  /** Snapshot on the idle-stop sweep, right before the container stops. Default true. */
  onIdle: boolean;
  /** Keep at most this many snapshot images per session (older ones deleted). Default 2. */
  maxPerSession: number;
  /** After restoring a volume-mode workspace from a snapshot, freshen refs with
   *  a non-destructive `git fetch origin` + `git status` inside. Default true. */
  quickSyncOnRestore: boolean;
}

export const SNAPSHOT_DEFAULTS: SandboxSnapshotsConfig = {
  enabled: false,
  onIdle: true,
  maxPerSession: 2,
  quickSyncOnRestore: true,
};

/** The isolated public dial-back listener (src/server/public-ingress.ts):
 *  a SECOND Bun.serve that exposes ONLY the run-ws/rpc-ws upgrade routes (+ a
 *  bare health check) so remote sandboxes on the public internet can dial
 *  back without the rest of the app ever being reachable. Front it with a
 *  TLS terminator (Caddy/tunnel) — it binds loopback by default. */
export interface SandboxPublicIngressConfig {
  /** Master switch. The listener only starts (at boot — needs a restart) when true. */
  enabled: boolean;
  /** Listen port (default 3860). */
  port: number;
  /** Bind host (default "127.0.0.1" — a reverse proxy/tunnel fronts it). */
  host: string;
  /** The base URL remote sandboxes dial, e.g. "wss://sessions.example.com"
   *  (http(s) is normalized to ws(s)). When set, remote-provider launches use
   *  it as their callback base instead of callbackBaseUrl. */
  publicBaseUrl?: string;
}

export const PUBLIC_INGRESS_DEFAULT_PORT = 3860;

/** Warm-on-typing prewarm pool (src/server/sandbox/prewarm.ts): typing a
 *  new-session prompt starts provider-specific preparation; session create
 *  adopts the warmed sandbox. */
export interface SandboxPrewarmConfig {
  enabled: boolean;
  /** Destroy an untouched prewarm after this many minutes (default 10). */
  ttlMinutes: number;
  /** At most this many live prewarms across all keys (default 2 — paid compute). */
  maxLive: number;
}

export const PREWARM_DEFAULTS: Omit<SandboxPrewarmConfig, "enabled"> = {
  ttlMinutes: 10,
  maxLive: 2,
};

export interface SandboxDaytonaConfig {
  /** Falls back to DAYTONA_API_KEY. */
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  /**
   * Org snapshot to create sandboxes from (custom `resources` are rejected
   * when creating from a snapshot, so sizing lives in the snapshot itself).
   * Unset = Daytona's default snapshot: 1 vCPU / 1GB / 3GiB disk — too small
   * for real repo workspaces (the runner payload alone is ~2GB; a tella-fusion
   * clone died on ENOSPC, 2026-07-09). Create one via the SDK, e.g. name
   * backstage-lg-us, image daytonaio/sandbox:0.8.0, resources {cpu:2,
   * memory:4, disk:10 (org max)}, regionId "us".
   */
  snapshot?: string;
}

export interface SandboxE2bConfig {
  /** Falls back to E2B_API_KEY. */
  apiKey?: string;
  /** Sandbox template id/name (default "base"). */
  template?: string;
}

export interface SandboxBoxConfig {
  /** ascii.dev Box API key (`box_…`). Falls back to BOX_API_KEY. */
  apiKey?: string;
  /** API base (default https://ascii.dev/api/box/v1). */
  apiUrl?: string;
}

export interface SandboxModalConfig {
  /** Modal token credentials. Fall back to MODAL_TOKEN_ID/MODAL_TOKEN_SECRET. */
  tokenId?: string;
  tokenSecret?: string;
  /** Named profile in ~/.modal.toml (or use MODAL_PROFILE / the active profile). */
  profile?: string;
  /** Modal App name used to group sandboxes (default opensession-sandboxes). */
  app?: string;
  /** Registry image for new sandboxes (default daytonaio/sandbox:0.8.0). */
  image?: string;
  environment?: string;
  endpoint?: string;
  region?: string;
  cloud?: string;
  /** Modal tunnel URLs are public. Require an explicit opt-in before exposing preview ports. */
  publicPreviews?: boolean;
}

export interface SandboxAwsLambdaMicrovmConfig {
  /** ARN or ID of a CREATED Lambda MicroVM image containing the control daemon. */
  imageIdentifier?: string;
  imageVersion?: string;
  executionRoleArn?: string;
  region?: string;
  ingressConnectorArn?: string;
  egressConnectorArn?: string;
  controlPort?: number;
  maximumDurationSeconds?: number;
  /** Opt-in endpoint-idle suspension. Omit for long-running agent safety. */
  idleSuspendSeconds?: number;
  suspendedDurationSeconds?: number;
  logGroup?: string;
}

export interface SandboxFirecrackerMicrovmConfig {
  /** Explicit opt-in: the provider owns root-level Firecracker/netns resources. */
  enabled: boolean;
  /** Credential-free golden store built by refresh-sandbox-golden.sh. */
  storeDir: string;
  /** Disjoint from preview-pool clone indexes (defaults 64..127). */
  indexStart: number;
  indexEnd: number;
}

export interface SandboxConfig {
  provider: SandboxProviderId;
  /** Container image for the docker provider (Phase 1). */
  image?: string;
  /** Stop idle sandboxes after this many minutes; unset = provider default (30). */
  idleStopMinutes?: number;
  /** CPU limit per container (docker --cpus); unset = provider default (4). */
  cpus?: number;
  /** Memory limit per container (docker --memory, e.g. "8g"); unset = default ("8g"). */
  memory?: string;
  /** Workspace mode for NEW docker sandboxes (existing sandboxes keep the mode
   *  they were created with — recorded in their state file). Default "bind". */
  workspace?: SandboxWorkspaceMode;
  /** Container ports to publish for previews (docker -p 127.0.0.1::<port>,
   *  random loopback host port, set at container create). Default none. */
  previewPorts?: number[];
  /** Allow startPreview to launch the dev-server bring-up INSIDE the sandbox
   *  (requires the image to carry the repo's dev toolchain). Default false:
   *  only the port-mapping + Caddy layer is active. */
  devServerInSandbox?: boolean;
  /** Snapshot-based warm restores (docker provider only). Absent = disabled. */
  snapshots?: SandboxSnapshotsConfig;
  /** Per-repo overrides keyed by repo id (worktree.ts REPOS). */
  perRepo?: Record<string, SandboxRepoOverride>;
  /** Run-stream + MCP-RPC transport for NEW sandbox launches. Default "socket".
   *  Remote providers always use "ws" regardless of this value. */
  transport?: SandboxTransport;
  /**
   * Base URL sandboxes dial back to for the WS transport, e.g.
   * "ws://100.x.y.z:3850" (or https://… — normalized to wss). Default is
   * derived from the server's bind (HOST:PORT env). MUST be reachable FROM the
   * sandbox: for remote providers that means a publicly/tailnet-reachable URL
   * (self-hosters: your Tailscale ts.net URL or a tunnel); a 127.0.0.1 bind
   * only works for host-local sandboxes.
   */
  callbackBaseUrl?: string;
  /** Public dial-back listener for remote providers (absent = disabled). */
  publicIngress?: SandboxPublicIngressConfig;
  /** Daytona adapter (provider "daytona"). */
  daytona?: SandboxDaytonaConfig;
  /** E2B adapter (provider "e2b"). */
  e2b?: SandboxE2bConfig;
  /** ascii.dev Box adapter (provider "box"). */
  box?: SandboxBoxConfig;
  /** Modal adapter (provider "modal"). */
  modal?: SandboxModalConfig;
  /** AWS Lambda MicroVM adapter (provider "lambda-microvm"). */
  awsLambdaMicrovm?: SandboxAwsLambdaMicrovmConfig;
  /** Local Firecracker adapter (provider "microvm"). */
  firecrackerMicrovm?: SandboxFirecrackerMicrovmConfig;
  /** Clone auth for remote-provider workspaces + runner bootstrap. On hosted
   *  GitHub clones, the live GITHUB_API_TOKEN takes precedence so an expiring
   *  GitHub App user token is never treated as durable sandbox config. */
  cloneCredential?: SandboxCloneCredential;
  /** Warm-on-typing prewarm pool. Absent = defaults, with `enabled` true
   *  whenever a provider with a prewarm adapter is configured. */
  prewarm?: Partial<SandboxPrewarmConfig>;
  /** Tarball URL of the opensession runner bundle for remote bootstrap (takes
   *  precedence over the git-clone fallback). */
  runnerBundleUrl?: string;
  /** Git URL of the opensession repo for remote bootstrap (default: this
   *  checkout's origin). */
  runnerRepoUrl?: string;
  /** Pinned sha/ref the remote bootstrap checks out (default: origin default). */
  runnerSha?: string;
}

const PROVIDER_IDS = new Set<string>([
  "local",
  "docker",
  "daytona",
  "e2b",
  "box",
  "modal",
  "microvm",
  "lambda-microvm",
]);

function asProviderId(v: unknown): SandboxProviderId | undefined {
  return typeof v === "string" && PROVIDER_IDS.has(v)
    ? (v as SandboxProviderId)
    : undefined;
}

/** False while the kill-switch file exists — new runs must stay local. */
export function sandboxesEnabled(): boolean {
  return !existsSync(DISABLE_FILE);
}

/** Current config, read fresh per call. Never throws; falls back to local. */
export function sandboxConfig(): SandboxConfig {
  try {
    const path = configPath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const perRepo: Record<string, SandboxRepoOverride> = {};
      if (raw?.perRepo && typeof raw.perRepo === "object") {
        for (const [repoId, o] of Object.entries<any>(raw.perRepo)) {
          const provider = asProviderId(o?.provider);
          const image = typeof o?.image === "string" ? o.image : undefined;
          if (provider || image) perRepo[repoId] = { provider, image };
        }
      }
      const previewPorts = Array.isArray(raw?.previewPorts)
        ? raw.previewPorts.filter(
            (p: unknown): p is number =>
              typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536,
          )
        : [];
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;
      return {
        provider: asProviderId(raw?.provider) || "local",
        image: typeof raw?.image === "string" ? raw.image : undefined,
        idleStopMinutes:
          typeof raw?.idleStopMinutes === "number" && raw.idleStopMinutes > 0
            ? raw.idleStopMinutes
            : undefined,
        cpus: typeof raw?.cpus === "number" && raw.cpus > 0 ? raw.cpus : undefined,
        memory:
          typeof raw?.memory === "string" && /^\d+(\.\d+)?[kmg]b?$/i.test(raw.memory.trim())
            ? raw.memory.trim()
            : undefined,
        workspace: raw?.workspace === "volume" ? "volume" : undefined,
        previewPorts: previewPorts.length ? previewPorts : undefined,
        devServerInSandbox: raw?.devServerInSandbox === true || undefined,
        snapshots:
          raw?.snapshots && typeof raw.snapshots === "object"
            ? {
                enabled: raw.snapshots.enabled === true,
                onIdle: raw.snapshots.onIdle !== false,
                maxPerSession:
                  typeof raw.snapshots.maxPerSession === "number" &&
                  raw.snapshots.maxPerSession >= 1
                    ? Math.floor(raw.snapshots.maxPerSession)
                    : SNAPSHOT_DEFAULTS.maxPerSession,
                quickSyncOnRestore: raw.snapshots.quickSyncOnRestore !== false,
              }
            : undefined,
        perRepo: Object.keys(perRepo).length ? perRepo : undefined,
        transport: raw?.transport === "ws" ? "ws" : undefined,
        callbackBaseUrl: str(raw?.callbackBaseUrl),
        publicIngress:
          raw?.publicIngress && typeof raw.publicIngress === "object"
            ? {
                enabled: raw.publicIngress.enabled === true,
                port:
                  typeof raw.publicIngress.port === "number" &&
                  Number.isInteger(raw.publicIngress.port) &&
                  raw.publicIngress.port > 0 &&
                  raw.publicIngress.port < 65536
                    ? raw.publicIngress.port
                    : PUBLIC_INGRESS_DEFAULT_PORT,
                host: str(raw.publicIngress.host) || "127.0.0.1",
                publicBaseUrl: str(raw.publicIngress.publicBaseUrl),
              }
            : undefined,
        daytona:
          raw?.daytona && typeof raw.daytona === "object"
            ? {
                apiKey: str(raw.daytona.apiKey),
                apiUrl: str(raw.daytona.apiUrl),
                target: str(raw.daytona.target),
                snapshot: str(raw.daytona.snapshot),
              }
            : undefined,
        e2b:
          raw?.e2b && typeof raw.e2b === "object"
            ? { apiKey: str(raw.e2b.apiKey), template: str(raw.e2b.template) }
            : undefined,
        box:
          raw?.box && typeof raw.box === "object"
            ? { apiKey: str(raw.box.apiKey), apiUrl: str(raw.box.apiUrl) }
            : undefined,
        modal:
          raw?.modal && typeof raw.modal === "object"
            ? {
                tokenId: str(raw.modal.tokenId),
                tokenSecret: str(raw.modal.tokenSecret),
                profile: str(raw.modal.profile),
                app: str(raw.modal.app),
                image: str(raw.modal.image),
                environment: str(raw.modal.environment),
                endpoint: str(raw.modal.endpoint),
                region: str(raw.modal.region),
                cloud: str(raw.modal.cloud),
                publicPreviews: raw.modal.publicPreviews === true || undefined,
              }
            : undefined,
        awsLambdaMicrovm:
          raw?.awsLambdaMicrovm && typeof raw.awsLambdaMicrovm === "object"
            ? {
                imageIdentifier: str(raw.awsLambdaMicrovm.imageIdentifier),
                imageVersion: str(raw.awsLambdaMicrovm.imageVersion),
                executionRoleArn: str(raw.awsLambdaMicrovm.executionRoleArn),
                region: str(raw.awsLambdaMicrovm.region),
                ingressConnectorArn: str(raw.awsLambdaMicrovm.ingressConnectorArn),
                egressConnectorArn: str(raw.awsLambdaMicrovm.egressConnectorArn),
                controlPort:
                  typeof raw.awsLambdaMicrovm.controlPort === "number" &&
                  Number.isInteger(raw.awsLambdaMicrovm.controlPort) &&
                  raw.awsLambdaMicrovm.controlPort > 0 &&
                  raw.awsLambdaMicrovm.controlPort < 65536
                    ? raw.awsLambdaMicrovm.controlPort
                    : undefined,
                maximumDurationSeconds:
                  typeof raw.awsLambdaMicrovm.maximumDurationSeconds === "number" &&
                  raw.awsLambdaMicrovm.maximumDurationSeconds > 0
                    ? Math.min(28_800, Math.floor(raw.awsLambdaMicrovm.maximumDurationSeconds))
                    : undefined,
                idleSuspendSeconds:
                  typeof raw.awsLambdaMicrovm.idleSuspendSeconds === "number" &&
                  raw.awsLambdaMicrovm.idleSuspendSeconds >= 60
                    ? Math.min(28_800, Math.floor(raw.awsLambdaMicrovm.idleSuspendSeconds))
                    : undefined,
                suspendedDurationSeconds:
                  typeof raw.awsLambdaMicrovm.suspendedDurationSeconds === "number" &&
                  raw.awsLambdaMicrovm.suspendedDurationSeconds > 0
                    ? Math.floor(raw.awsLambdaMicrovm.suspendedDurationSeconds)
                    : undefined,
                logGroup: str(raw.awsLambdaMicrovm.logGroup),
              }
            : undefined,
        firecrackerMicrovm:
          raw?.firecrackerMicrovm && typeof raw.firecrackerMicrovm === "object"
            ? {
                enabled: raw.firecrackerMicrovm.enabled === true,
                storeDir:
                  str(raw.firecrackerMicrovm.storeDir) ||
                  "/opt/firecracker/sandbox-store",
                indexStart:
                  typeof raw.firecrackerMicrovm.indexStart === "number" &&
                  Number.isInteger(raw.firecrackerMicrovm.indexStart) &&
                  raw.firecrackerMicrovm.indexStart >= 1 &&
                  raw.firecrackerMicrovm.indexStart <= 253
                    ? raw.firecrackerMicrovm.indexStart
                    : 64,
                indexEnd:
                  typeof raw.firecrackerMicrovm.indexEnd === "number" &&
                  Number.isInteger(raw.firecrackerMicrovm.indexEnd) &&
                  raw.firecrackerMicrovm.indexEnd >= 1 &&
                  raw.firecrackerMicrovm.indexEnd <= 253
                    ? raw.firecrackerMicrovm.indexEnd
                    : 127,
              }
            : undefined,
        cloneCredential:
          raw?.cloneCredential?.type === "https-token" ||
          raw?.cloneCredential?.type === "none"
            ? { type: raw.cloneCredential.type, token: str(raw.cloneCredential.token) }
            : undefined,
        prewarm:
          raw?.prewarm && typeof raw.prewarm === "object"
            ? {
                enabled:
                  typeof raw.prewarm.enabled === "boolean" ? raw.prewarm.enabled : undefined,
                ttlMinutes:
                  typeof raw.prewarm.ttlMinutes === "number" && raw.prewarm.ttlMinutes > 0
                    ? raw.prewarm.ttlMinutes
                    : undefined,
                maxLive:
                  typeof raw.prewarm.maxLive === "number" && raw.prewarm.maxLive >= 1
                    ? Math.floor(raw.prewarm.maxLive)
                    : undefined,
              }
            : undefined,
        runnerBundleUrl: str(raw?.runnerBundleUrl),
        runnerRepoUrl: str(raw?.runnerRepoUrl),
        runnerSha: str(raw?.runnerSha),
      };
    }
  } catch {}
  return { provider: "local" };
}

/**
 * Effective provider id for a session in `repoId`, honoring the kill switch
 * and per-repo overrides. Missing config, disabled sandboxes, or garbage in
 * the file all resolve to "local".
 */
export function effectiveSandboxProvider(repoId?: string): SandboxProviderId {
  if (!sandboxesEnabled()) return "local";
  const cfg = sandboxConfig();
  return (repoId && cfg.perRepo?.[repoId]?.provider) || cfg.provider || "local";
}

/** Effective snapshot settings — the config's `snapshots` block over the
 *  defaults; a missing block = the defaults with `enabled: false`. */
export function sandboxSnapshots(): SandboxSnapshotsConfig {
  return sandboxConfig().snapshots || SNAPSHOT_DEFAULTS;
}

/** Effective warm-on-typing prewarm settings (prewarm.ts pool). `enabled`
 *  defaults to true exactly when a provider with an implemented adapter is
 *  configured — a docker-only or unconfigured setup stays inert. */
export function sandboxPrewarmConfig(): SandboxPrewarmConfig {
  const cfg = sandboxConfig();
  const prewarmProviderConfigured =
    sandboxConfigPresent() &&
    Boolean(
      cfg.daytona?.apiKey ||
        process.env.DAYTONA_API_KEY ||
        cfg.e2b?.apiKey ||
        process.env.E2B_API_KEY ||
        sandboxProviderConfigured("microvm"),
    );
  return {
    enabled: cfg.prewarm?.enabled ?? prewarmProviderConfigured,
    ttlMinutes: cfg.prewarm?.ttlMinutes ?? PREWARM_DEFAULTS.ttlMinutes,
    maxLive: cfg.prewarm?.maxLive ?? PREWARM_DEFAULTS.maxLive,
  };
}

/** Effective run transport (docker honors the config; remote providers pass
 *  their own "ws" regardless). */
export function sandboxTransport(): SandboxTransport {
  return sandboxConfig().transport === "ws" ? "ws" : "socket";
}

// ── Provider capability status (per-session provider picker) ────────────────

/** The providers a session can explicitly pick ("local" = no sandbox). */
export const RUNNABLE_SANDBOX_PROVIDERS = [
  "docker",
  "daytona",
  "e2b",
  "box",
  "modal",
  "microvm",
  "lambda-microvm",
] as const;
export type RunnableSandboxProviderId = (typeof RUNNABLE_SANDBOX_PROVIDERS)[number];

export function isRunnableSandboxProvider(v: unknown): v is RunnableSandboxProviderId {
  return (
    typeof v === "string" &&
    (RUNNABLE_SANDBOX_PROVIDERS as readonly string[]).includes(v)
  );
}

/** Remote providers have no host mounts — their workspaces are ALWAYS
 *  volume-style (cloned inside the sandbox; no host fallback for runs). */
export function isRemoteSandboxProvider(
  v: unknown,
): v is "daytona" | "e2b" | "box" | "modal" | "microvm" | "lambda-microvm" {
  return (
    v === "daytona" ||
    v === "e2b" ||
    v === "box" ||
    v === "modal" ||
    v === "microvm" ||
    v === "lambda-microvm"
  );
}

/** True when a sandbox config file exists and parses — the operator has set
 *  sandboxing up at all. Without it every provider is unconfigured. */
export function sandboxConfigPresent(): boolean {
  try {
    const path = configPath();
    if (!existsSync(path)) return false;
    JSON.parse(readFileSync(path, "utf-8"));
    return true;
  } catch {
    return false;
  }
}

export interface SandboxProviderStatusEntry {
  id: RunnableSandboxProviderId;
  configured: boolean;
  /** Human caveat shown ONLY when something is actually missing (e.g. a remote
   *  provider with no dial-back URL configured). Healthy providers carry no
   *  note — the UI renders it as a dim hint line under the picker row. */
  note?: string;
}

// ── Model-family × environment capability matrix ─────────────────────────────
//
// THE single source of truth for "can this model run in that environment":
// served verbatim in /api/sandbox/status.modelFamilies (the NewSession picker
// warns/blocks from it) and enforced server-side by resolveRequestedSandbox on
// every create path — never hardcode a combo in either place. An environment
// is `"local" | RunnableSandboxProviderId` ("local" = host, no sandbox).

export type SandboxEnvironmentId = "local" | RunnableSandboxProviderId;

export interface SandboxModelFamily {
  id: string;
  /** Human name for warnings ("GPT (Codex) models can't run in …"). */
  label: string;
  /** First-match-wins rules (applied in SANDBOX_MODEL_FAMILIES order):
   *  the model's runner provider, plus an optional canonical-id prefix for
   *  the opencode/<provider>/ split. */
  match: { provider: "claude" | "codex" | "opencode" | "pi"; idPrefix?: string };
  environments: Record<SandboxEnvironmentId, boolean>;
  /** Why the unsupported environments are unsupported (warning suffix). */
  hint?: string;
}

const ALL_ENVIRONMENTS: Record<SandboxEnvironmentId, boolean> = {
  local: true,
  docker: true,
  daytona: true,
  e2b: true,
  box: true,
  modal: true,
  microvm: true,
  "lambda-microvm": true,
};

export const SANDBOX_MODEL_FAMILIES: SandboxModelFamily[] = [
  {
    // Docker can run the OpenCode engine in-container with its mounted account
    // material. Remote providers and MicroVMs keep the engine/auth on the host
    // and expose only the workspace runtime (sandboxEnginePlacement below).
    id: "opencode-openai",
    label: "GPT (OpenCode)",
    match: { provider: "opencode", idPrefix: "opencode/openai/" },
    environments: { ...ALL_ENVIRONMENTS },
  },
  {
    // Docker can run the OpenCode engine in-container with its mounted bridge
    // config. Remote providers and MicroVMs keep the engine/auth on the host.
    id: "opencode-anthropic",
    label: "Claude (OpenCode)",
    match: { provider: "opencode", idPrefix: "opencode/anthropic/" },
    environments: { ...ALL_ENVIRONMENTS },
  },
  {
    // Other OpenCode providers keep their auth + model loop on the host and
    // operate on sandbox workspaces through opensession-workspace. Local
    // filesystem/bash tools are stripped on those runs (opencodeRunPolicy).
    id: "opencode-other",
    label: "OpenCode (other providers)",
    match: { provider: "opencode" },
    environments: { ...ALL_ENVIRONMENTS },
  },
  {
    // The pi engine always stays in-process on this host (per-turn SDK session
    // with host-side bridge auth, pi-runner.ts), so every environment runs it
    // engine-on-host with only the workspace inside the sandbox
    // (sandboxEnginePlacement forces "host" for this family).
    id: "pi",
    label: "Pi",
    match: { provider: "pi" },
    environments: { ...ALL_ENVIRONMENTS },
    hint: "engine runs on the host; the sandbox isolates the workspace",
  },
  {
    // Native Codex runs need a writable CODEX_HOME (refresh-token rotation) —
    // deliberately never mounted or uploaded into sandboxes. GPT-in-a-sandbox
    // goes through opencode/openai/* instead.
    id: "codex",
    label: "GPT (Codex)",
    match: { provider: "codex" },
    environments: { local: true, docker: false, daytona: false, e2b: false, box: false, modal: false, microvm: false, "lambda-microvm": false },
    hint: "Codex account state stays on the host; use an opencode/openai/* model to run GPT in a sandbox",
  },
  {
    id: "claude",
    label: "Claude",
    match: { provider: "claude" },
    environments: { ...ALL_ENVIRONMENTS, microvm: false },
  },
];

const ENVIRONMENT_LABELS: Record<SandboxEnvironmentId, string> = {
  local: "Host",
  docker: "Docker",
  daytona: "Daytona",
  e2b: "E2B",
  box: "Box",
  modal: "Modal",
  microvm: "Local Firecracker MicroVM",
  "lambda-microvm": "AWS Lambda MicroVM",
};

/** The matrix row a model (or the current default, for ""/undefined) falls
 *  into. Unknown model strings resolve like providerFor does (→ claude). */
export function sandboxModelFamilyFor(model?: string | null): SandboxModelFamily {
  const raw = (model || "").trim() || getDefaultModel();
  const canonical = resolveModel(raw)?.id ?? raw;
  const provider = providerFor(canonical);
  return (
    SANDBOX_MODEL_FAMILIES.find(
      (f) =>
        f.match.provider === provider &&
        (!f.match.idPrefix || canonical.startsWith(f.match.idPrefix)),
    ) ?? SANDBOX_MODEL_FAMILIES[SANDBOX_MODEL_FAMILIES.length - 1]
  );
}

/**
 * Decide where the model loop runs for a sandboxed session.
 *
 * Remote providers and MicroVMs are workspace sandboxes for every OpenCode
 * family: credentials, account rotation and engine state stay on this host.
 * Docker retains the existing in-container OpenAI/Anthropic runner because it
 * already has explicit local mounts; OpenCode-other remains host-only there
 * because its provider auth is not mounted. Pi is host-only on EVERY provider:
 * its bridge auth, session state and in-memory MCP servers exist only in this
 * process, so the in-sandbox runner-host can never run it.
 */
export function sandboxEnginePlacement(
  model: string | undefined | null,
  provider: RunnableSandboxProviderId,
): "host" | "sandbox" {
  const family = sandboxModelFamilyFor(model).id;
  if (family === "pi") return "host";
  if (family === "opencode-other") return "host";
  if (
    provider !== "docker" &&
    (family === "opencode-openai" || family === "opencode-anthropic")
  ) {
    return "host";
  }
  return "sandbox";
}

/**
 * Can `model` run in sandbox `provider`? (null/"local" = host = always ok.)
 * The create paths enforce this server-side; NewSession pre-warns from the
 * same matrix. The error names the family and the environments that DO work.
 */
export function sandboxModelSupport(
  model: string | undefined | null,
  provider: SandboxProviderId | null,
): { ok: true } | { ok: false; error: string } {
  if (!provider || provider === "local") return { ok: true };
  const family = sandboxModelFamilyFor(model);
  if (family.environments[provider]) return { ok: true };
  const supported = (Object.keys(family.environments) as SandboxEnvironmentId[])
    .filter((e) => family.environments[e])
    .map((e) => ENVIRONMENT_LABELS[e]);
  const pick =
    supported.length > 1
      ? `${supported.slice(0, -1).join(", ")} or ${supported[supported.length - 1]}`
      : supported[0] || "Host";
  return {
    ok: false,
    error:
      `${family.label} models can't run in ${ENVIRONMENT_LABELS[provider]} yet — pick ${pick}` +
      (family.hint ? ` (${family.hint})` : "") +
      ".",
  };
}

/** Shape served by GET /api/sandbox/status (read fresh per call). */
export interface SandboxCapabilityStatus {
  /** A sandbox config file exists — the control surface is worth showing. */
  enabled: boolean;
  /** What `sandbox: true` resolves to (the config's default provider). */
  defaultProvider: SandboxProviderId;
  providers: SandboxProviderStatusEntry[];
  /** disable-sandboxes kill-switch file present — runs stay on the host. */
  killSwitch: boolean;
  /** Model-family × environment support (SANDBOX_MODEL_FAMILIES verbatim) —
   *  the NewSession picker derives its "can't run in X" warning from this,
   *  never from strings of its own. */
  modelFamilies: SandboxModelFamily[];
}

/**
 * Whether an explicit per-session provider is currently usable. Kept simple
 * (docs: "Sandbox provider dropdown"): docker is available whenever a sandbox
 * config exists; daytona/e2b additionally need their API key (config block or
 * env). This is the same gate `maybeLaunchSandboxedRun` re-checks per run.
 */
export function sandboxProviderConfigured(id: RunnableSandboxProviderId): boolean {
  if (!sandboxConfigPresent()) return false;
  const cfg = sandboxConfig();
  if (id === "docker") return true;
  if (id === "daytona") return Boolean(cfg.daytona?.apiKey || process.env.DAYTONA_API_KEY);
  if (id === "box") return Boolean(cfg.box?.apiKey || process.env.BOX_API_KEY);
  if (id === "modal") {
    return Boolean(
      ((cfg.modal?.tokenId || process.env.MODAL_TOKEN_ID) &&
        (cfg.modal?.tokenSecret || process.env.MODAL_TOKEN_SECRET)) ||
        cfg.modal?.profile ||
        process.env.MODAL_PROFILE ||
        modalConfigHasCredentials(),
    );
  }
  if (id === "microvm") {
    const m = cfg.firecrackerMicrovm;
    return Boolean(
      m?.enabled &&
        m.indexStart <= m.indexEnd &&
        existsSync("/opt/firecracker/firecracker") &&
        existsSync("/opt/firecracker/vmlinux") &&
        existsSync(`${m.storeDir}/golden.ext4`) &&
        existsSync(`${m.storeDir}/golden.mem`) &&
        existsSync(`${m.storeDir}/golden.vmstate`),
    );
  }
  if (id === "lambda-microvm") return Boolean(cfg.awsLambdaMicrovm?.imageIdentifier);
  return Boolean(cfg.e2b?.apiKey || process.env.E2B_API_KEY);
}

/** Full provider-capability snapshot, read fresh from config + kill switch. */
export function sandboxCapabilityStatus(): SandboxCapabilityStatus {
  const enabled = sandboxConfigPresent();
  const cfg = sandboxConfig();
  const daytonaConfigured =
    enabled && Boolean(cfg.daytona?.apiKey || process.env.DAYTONA_API_KEY);
  const e2bConfigured =
    enabled && Boolean(cfg.e2b?.apiKey || process.env.E2B_API_KEY);
  const boxConfigured =
    enabled && Boolean(cfg.box?.apiKey || process.env.BOX_API_KEY);
  const modalConfigured =
    enabled &&
    Boolean(
      ((cfg.modal?.tokenId || process.env.MODAL_TOKEN_ID) &&
        (cfg.modal?.tokenSecret || process.env.MODAL_TOKEN_SECRET)) ||
        cfg.modal?.profile ||
        process.env.MODAL_PROFILE ||
        modalConfigHasCredentials(),
    );
  const lambdaMicrovmConfigured = enabled && Boolean(cfg.awsLambdaMicrovm?.imageIdentifier);
  const firecrackerMicrovmConfigured =
    enabled && sandboxProviderConfigured("microvm");
  // Remote sandboxes must dial back over WS: healthy = a public-ingress URL or
  // an explicit callbackBaseUrl is configured, and then the row shows no note.
  // Only an actually-missing dial-back URL surfaces a caveat (no static
  // "unverified" scare-copy — dial-back is proven in production).
  const remoteDialBackConfigured = Boolean(
    (cfg.publicIngress?.enabled && cfg.publicIngress.publicBaseUrl) ||
      cfg.callbackBaseUrl,
  );
  const remoteNote = remoteDialBackConfigured
    ? {}
    : {
        note: "no dial-back URL configured — set publicIngress.publicBaseUrl (or callbackBaseUrl) so sandboxes can reach this server; see docs/self-hosting-sandboxes.md",
      };
  const providers: SandboxProviderStatusEntry[] = [
    { id: "docker", configured: enabled },
    {
      id: "daytona",
      configured: daytonaConfigured,
      ...(daytonaConfigured ? remoteNote : {}),
    },
    {
      id: "e2b",
      configured: e2bConfigured,
      ...(e2bConfigured ? remoteNote : {}),
    },
    {
      id: "box",
      configured: boxConfigured,
      ...(boxConfigured ? remoteNote : {}),
    },
    {
      id: "modal",
      configured: modalConfigured,
      ...(modalConfigured ? remoteNote : {}),
    },
    {
      id: "microvm",
      configured: firecrackerMicrovmConfigured,
    },
    {
      id: "lambda-microvm",
      configured: lambdaMicrovmConfigured,
      ...(lambdaMicrovmConfigured ? remoteNote : {}),
    },
  ];
  return {
    enabled,
    defaultProvider: cfg.provider || "local",
    providers,
    killSwitch: !sandboxesEnabled(),
    modelFamilies: SANDBOX_MODEL_FAMILIES,
  };
}

/**
 * Resolve a create-path `sandbox` request (boolean | provider string) to the
 * provider to persist on the session, validating explicit picks against the
 * current config. `true` keeps today's behavior (config default provider);
 * a string must name a configured provider or the create fails with a clear
 * error. Returns `provider: null` for "no sandbox".
 *
 * `model` (the create's model pick; ""/undefined = the current default) is
 * checked against the capability matrix so an unsupported model × environment
 * combo fails AT CREATE with the same message the UI pre-warns with — never
 * trust just the picker (sandboxModelSupport).
 */
export function resolveRequestedSandbox(
  requested: boolean | string | undefined | null,
  repoId?: string,
  model?: string | null,
): { ok: true; provider: SandboxProviderId | null } | { ok: false; error: string } {
  const withModelCheck = (
    provider: SandboxProviderId | null,
  ): { ok: true; provider: SandboxProviderId | null } | { ok: false; error: string } => {
    const support = sandboxModelSupport(model, provider);
    return support.ok ? { ok: true, provider } : support;
  };
  if (!requested) return { ok: true, provider: null };
  if (requested === true)
    return withModelCheck(effectiveSandboxProvider(repoId));
  const id = String(requested).trim().toLowerCase();
  if (id === "local") return { ok: true, provider: null }; // explicit "host"
  if (!isRunnableSandboxProvider(id)) {
    return {
      ok: false,
      error: `Unknown sandbox provider "${requested}" — valid values: docker, daytona, e2b, box, modal, microvm, lambda-microvm (or true for the configured default).`,
    };
  }
  if (!sandboxProviderConfigured(id)) {
    const hint =
      id === "docker"
        ? "create ~/.opensession-sandbox.json (see docs/self-hosting-sandboxes.md)"
        : id === "daytona"
          ? 'set {"daytona":{"apiKey":"…"}} in ~/.opensession-sandbox.json (or DAYTONA_API_KEY)'
          : id === "box"
            ? 'set {"box":{"apiKey":"…"}} in ~/.opensession-sandbox.json (or BOX_API_KEY)'
            : id === "modal"
              ? 'set {"modal":{"tokenId":"…","tokenSecret":"…"}} in ~/.opensession-sandbox.json (or MODAL_TOKEN_ID/MODAL_TOKEN_SECRET)'
              : id === "microvm"
                ? 'build a clean golden with deploy/sandbox/microvm/refresh-sandbox-golden.sh and set {"firecrackerMicrovm":{"enabled":true,"storeDir":"/opt/firecracker/sandbox-store"}}'
              : id === "lambda-microvm"
                ? 'set {"awsLambdaMicrovm":{"imageIdentifier":"arn:aws:lambda:…:microvm-image/…"}} in ~/.opensession-sandbox.json'
                : 'set {"e2b":{"apiKey":"…"}} in ~/.opensession-sandbox.json (or E2B_API_KEY)';
    return {
      ok: false,
      error: `Sandbox provider "${id}" is not configured — ${hint}.`,
    };
  }
  return withModelCheck(id);
}

/**
 * The base URL sandboxes dial back to (run-ws / rpc-ws routes). Config value
 * wins; the fallback derives from the server's bind env (HOST:PORT — the same
 * defaults opensession.ts uses). http(s) schemes are normalized to ws(s).
 * NOTE: a 127.0.0.1 default is unreachable from any sandbox — ws-transport
 * setups should set callbackBaseUrl explicitly (Tailscale URL for remote
 * providers; the docker bridge can reach the host's tailnet/LAN bind).
 */
export function sandboxCallbackBaseUrl(): string {
  const cfg = sandboxConfig();
  let base =
    cfg.callbackBaseUrl ||
    `ws://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "3850"}`;
  return normalizeWsBase(base);
}

function normalizeWsBase(base: string): string {
  return base.replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "");
}

/** The publicIngress block when it's actually enabled, else null. */
export function publicIngressConfig(): SandboxPublicIngressConfig | null {
  const pi = sandboxConfig().publicIngress;
  return pi?.enabled ? pi : null;
}

/**
 * The base URL REMOTE-provider sandboxes (daytona/e2b) dial back to: the
 * public-ingress URL when the isolated public listener is enabled and has a
 * publicBaseUrl, else the plain callbackBaseUrl (tailnet/self-hosted setups
 * where the sandbox can reach the main bind directly). Docker sandboxes never
 * use this — they stay on sandboxCallbackBaseUrl (the internal bridge path).
 */
export function remoteSandboxCallbackBaseUrl(): string {
  const pi = publicIngressConfig();
  if (pi?.publicBaseUrl) return normalizeWsBase(pi.publicBaseUrl);
  return sandboxCallbackBaseUrl();
}
