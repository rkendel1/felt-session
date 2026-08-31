/**
 * Local Firecracker MicroVM sandbox provider.
 *
 * This reuses the proven preview-pool clone/network/control machinery but
 * requires a separate credential-free, runner-baked golden. Each session gets
 * a COW ext4 disk and restored VM in a transient systemd scope. The engine and
 * volume-style workspace live inside the guest; scoped credentials arrive per
 * launch and the run dials back to Open Session over WebSocket.
 */

import { homeDir } from "../../paths";
import { audit } from "../../audit";
import { hostRunBusy } from "../../host-registry";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { existsSync } from "node:fs";
import { getRepo } from "../../worktree";
import {
  DEFAULT_SANDBOX_PREVIEW_PORTS,
  sandboxCallbackBaseUrl,
  sandboxConfig,
  sandboxProviderConfigured,
} from "../config";
import type {
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import type { RemotePtyHandle, RemotePtyIo } from "./daytona";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  bootstrapSignature,
  findRemoteStateBySession,
  listRemoteStates,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  remoteWarmWorkspaceDir,
  removeRemoteState,
  resolveTrustPolicy,
  runRemoteLifecycleHook,
  setupRemoteWorkspace,
  touchRemoteState,
  warmRemoteWorkspace,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  type PrewarmAdapter,
  type SandboxMachineSettings,
} from "../prewarm";

const SCRIPTS = `${process.cwd()}/deploy/sandbox/microvm`;
const CONTROL_PORT = 8080;
const ROOT_CONTROL_PORT = 8081;
const DEFAULT_IDLE_STOP_MINUTES = 5;
const IDLE_SWEEP_MS = 60_000;
const DEFAULT_MACHINE: Required<SandboxMachineSettings> = {
  cpu: 4,
  memoryMb: 12_288,
  diskGb: 25,
};
const AUTOMATION_BASELINE_EGRESS = [
  "https://github.com",
  "https://api.github.com",
  "https://codeload.github.com",
  "https://objects.githubusercontent.com",
  "https://raw.githubusercontent.com",
  "https://api.openai.com",
  "https://chatgpt.com",
  "https://api.anthropic.com",
] as const;

function config() {
  const cfg = sandboxConfig().firecrackerMicrovm;
  if (!cfg?.enabled || !sandboxProviderConfigured("microvm")) {
    throw new Error(
      "microvm sandbox provider is not configured — build a clean golden with " +
        "deploy/sandbox/microvm/refresh-sandbox-golden.sh and enable firecrackerMicrovm in ~/.opensession-sandbox.json",
    );
  }
  return cfg;
}

function sandboxId(idx: number): string {
  return `microvm-${idx}`;
}

function indexFromId(id: string): number | null {
  const match = /^microvm-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

function ipFor(idx: number): string {
  return `10.200.${idx}.2`;
}

function workspacePath(sessionId: string): string {
  const safe = sessionId
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "");
  return `${homeDir()}/microvm-workspaces/${safe}`;
}

async function run(
  argv: string[],
  timeoutMs = 180_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

interface EgressDestination {
  host: string;
  port?: number;
}

/** Parse an operator-facing egress entry without ever passing hostnames or
 * shell fragments to the privileged clone helper. Resolution happens here;
 * clone.sh accepts resolved IPv4/CIDR targets only. */
export function parseMicrovmEgressDestination(value: string): EgressDestination {
  const raw = value.trim();
  if (!raw) throw new Error("empty automation egress destination");
  if (/^[0-9.]+\/([0-9]|[12][0-9]|3[0-2])$/.test(raw)) return { host: raw };
  if (/^[0-9.]+:\d+$/.test(raw)) {
    const split = raw.lastIndexOf(":");
    const host = raw.slice(0, split);
    const port = Number(raw.slice(split + 1));
    if (isIP(host) !== 4 || port < 1 || port > 65_535)
      throw new Error(`invalid automation egress destination: ${value}`);
    return { host, port };
  }
  if (isIP(raw) === 4) return { host: raw };
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`invalid automation egress destination: ${value}`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || !url.hostname)
    throw new Error(`unsupported automation egress destination: ${value}`);
  if (url.hostname.includes("*"))
    throw new Error(`wildcards are not allowed in automation egress: ${value}`);
  const port = url.port
    ? Number(url.port)
    : url.protocol === "http:" || url.protocol === "ws:"
      ? 80
      : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`invalid automation egress port: ${value}`);
  return { host: url.hostname, port };
}

export async function resolveMicrovmEgressTargets(values: string[]): Promise<string[]> {
  const targets = new Set<string>();
  for (const value of values) {
    const destination = parseMicrovmEgressDestination(value);
    if (destination.host.includes("/")) {
      targets.add(destination.host);
      continue;
    }
    const addresses = isIP(destination.host)
      ? [{ address: destination.host }]
      : await lookup(destination.host, { all: true, family: 4 });
    if (!addresses.length)
      throw new Error(`automation egress host did not resolve: ${destination.host}`);
    for (const { address } of addresses) {
      targets.add(`${address}${destination.port ? `:${destination.port}` : ""}`);
    }
  }
  return [...targets].sort();
}

async function restrictAutomationEgress(
  idx: number,
  storeDir: string,
  values: string[],
): Promise<string[]> {
  let targets: string[] = [];
  try {
    targets = await resolveMicrovmEgressTargets(values);
  } catch (error) {
    // The zero-target policy is DNS + deny. Install it before surfacing the
    // resolution error so a reused VM never remains broadly connected.
    await run(
      ["sudo", "-n", "bash", `${SCRIPTS}/clone.sh`, "restrict-egress", String(idx), storeDir],
      30_000,
    ).catch(() => undefined);
    throw error;
  }
  const result = await run(
    [
      "sudo",
      "-n",
      "bash",
      `${SCRIPTS}/clone.sh`,
      "restrict-egress",
      String(idx),
      storeDir,
      ...targets,
    ],
    30_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `installing automation egress policy failed: ${(result.stderr || result.stdout).trim().slice(-500)}`,
    );
  }
  return targets;
}

async function unitRunning(idx: number): Promise<boolean> {
  return (
    await run(
      ["systemctl", "is-active", "--quiet", `os-fc-clone${idx}`],
      5_000,
    )
  ).exitCode === 0;
}

async function request(
  idx: number,
  path: string,
  body?: unknown,
  root = false,
  timeoutMs = 125_000,
): Promise<Response> {
  const response = await fetch(
    `http://${ipFor(idx)}:${root ? ROOT_CONTROL_PORT : CONTROL_PORT}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      // Firecracker snapshots freeze the guest TCP state. Never let Bun reuse
      // a control connection that predates a restore/clock repair: a stale
      // keep-alive can close before the request receives a response, and POST
      // /exec is not safe to retry blindly after that point.
      headers: {
        Connection: "close",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Firecracker MicroVM ${idx} ${path} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response;
}

function driverFor(idx: number): RemoteDriver {
  return {
    async exec(command: string, opts?: RemoteExecOpts) {
      try {
        const response = await request(
          idx,
          "/exec",
          {
            command,
            cwd: opts?.cwd,
            env: opts?.env,
            timeoutMs: opts?.timeoutMs ?? 120_000,
          },
          false,
          (opts?.timeoutMs ?? 120_000) + 5_000,
        );
        const result = (await response.json()) as {
          exitCode?: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          exitCode: Number(result.exitCode ?? 1),
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: String((error as Error)?.message || error),
        };
      }
    },
    async execBackground(command: string, opts?: RemoteExecOpts) {
      await request(idx, "/background", {
        command,
        cwd: opts?.cwd,
        env: opts?.env,
      });
    },
    async writeFile(path: string, content: string) {
      await request(idx, "/files", {
        path,
        content: Buffer.from(content, "utf-8").toString("base64"),
      });
    },
    async ensureStarted() {
      if (!(await unitRunning(idx))) {
        throw new Error(`Firecracker MicroVM ${idx} is not running`);
      }
      await request(idx, "/health", undefined, false, 5_000);
    },
  };
}

const TRANSIENT_CONTROL_ERROR =
  /socket connection was closed|connection reset|econnreset|fetch\(\) failed|fetch failed/i;

/**
 * A restored Firecracker guest can drop its first control connection while
 * the snapshot-frozen network stack settles after the clock repair. Bootstrap
 * commands are deliberately idempotent, so retry only this provisioning
 * driver—not the Sandbox handle used for arbitrary agent execute calls.
 */
export function microvmBootstrapDriver(driver: RemoteDriver): RemoteDriver {
  return {
    ...driver,
    async exec(command: string, opts?: RemoteExecOpts) {
      let result = await driver.exec(command, opts);
      for (let attempt = 1; attempt < 3; attempt++) {
        const detail = `${result.stderr}\n${result.stdout}`;
        if (result.exitCode === 0 || !TRANSIENT_CONTROL_ERROR.test(detail)) {
          return result;
        }
        await Bun.sleep(attempt * 250);
        await driver.ensureStarted().catch(() => {});
        result = await driver.exec(command, opts);
      }
      return result;
    },
  };
}

async function destroyClone(idx: number, storeDir: string): Promise<void> {
  const result = await run(
    ["sudo", "-n", "bash", `${SCRIPTS}/clone.sh`, "destroy", String(idx), storeDir],
    60_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `destroying Firecracker MicroVM ${idx} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
  }
}

async function pauseClone(idx: number, storeDir: string): Promise<void> {
  const result = await run(
    ["sudo", "-n", "bash", `${SCRIPTS}/clone.sh`, "pause", String(idx), storeDir],
    60_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `pausing Firecracker MicroVM ${idx} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
  }
}

function machine(resources?: SandboxMachineSettings): Required<SandboxMachineSettings> {
  return {
    cpu: resources?.cpu || DEFAULT_MACHINE.cpu,
    memoryMb: resources?.memoryMb || DEFAULT_MACHINE.memoryMb,
    diskGb: resources?.diskGb || DEFAULT_MACHINE.diskGb,
  };
}

async function resumeClone(
  idx: number,
  storeDir: string,
  resources?: SandboxMachineSettings,
): Promise<void> {
  const selected = machine(resources);
  const result = await run(
    [
      "sudo",
      "-n",
      "bash",
      `${SCRIPTS}/clone.sh`,
      "resume",
      String(idx),
      storeDir,
      "",
      String(selected.cpu),
      String(selected.memoryMb),
      String(selected.diskGb),
    ],
    180_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `resuming Firecracker MicroVM ${idx} failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`,
    );
  }
}

function cloneDiskExists(idx: number, storeDir: string): boolean {
  return existsSync(`${storeDir}/clone${idx}.ext4`);
}

function repoTemplateKey(repoId: string): string {
  const repo = repoId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
  const signature = createHash("sha256")
    .update(bootstrapSignature())
    .digest("hex")
    .slice(0, 16);
  return `repo-${repo}-${signature}`;
}

export function microvmRepoTemplatePath(repoId: string): string | undefined {
  const storeDir = sandboxConfig().firecrackerMicrovm?.storeDir;
  return storeDir
    ? `${storeDir}/repo-templates/${repoTemplateKey(repoId)}.ext4`
    : undefined;
}

export async function deleteMicrovmRepoTemplate(repoId: string): Promise<void> {
  const path = microvmRepoTemplatePath(repoId);
  if (!path) return;
  await run(["sudo", "-n", "rm", "-f", path], 30_000);
}

async function publishRepoTemplate(
  idx: number,
  storeDir: string,
  repoId: string,
): Promise<void> {
  const result = await run(
    [
      "sudo",
      "-n",
      "bash",
      `${SCRIPTS}/clone.sh`,
      "publish-template",
      String(idx),
      storeDir,
      repoTemplateKey(repoId),
    ],
    300_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `publishing Firecracker repo template failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`,
    );
  }
}

async function allocateClone(
  storeDir: string,
  indexStart: number,
  indexEnd: number,
  repoId?: string,
  resources?: SandboxMachineSettings,
): Promise<number> {
  const selected = machine(resources);
  return withRemoteEnsureLock("microvm", "__allocate__", async () => {
    for (let candidate = indexStart; candidate <= indexEnd; candidate++) {
      const result = await run(
        [
          "sudo",
          "-n",
          "bash",
          `${SCRIPTS}/clone.sh`,
          "create",
          String(candidate),
          storeDir,
          repoId ? repoTemplateKey(repoId) : "",
          String(selected.cpu),
          String(selected.memoryMb),
          String(selected.diskGb),
        ],
        300_000,
      );
      if (result.exitCode === 0) return candidate;
      if (
        result.exitCode === 3 ||
        /already has a live VM/i.test(result.stderr + result.stdout)
      ) {
        continue;
      }
      throw new Error(
        `creating Firecracker MicroVM ${candidate} failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`,
      );
    }
    throw new Error(
      `no free Firecracker MicroVM clone index in ${indexStart}..${indexEnd}`,
    );
  });
}

export class MicrovmProvider implements SandboxProvider {
  readonly id = "microvm" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    ensureIdleSweep();
    if (spec.attachedDirs?.length) {
      throw new Error(
        "attached repos are not supported in MicroVM sandboxes — detach them or use docker/local",
      );
    }
    const cfg = config();
    let previous = findRemoteStateBySession(this.id, spec.sessionId);
    // Resolved once, from the spec plus what this sandbox was recorded with,
    // and carried into every writeRemoteState below. A later ensure() that
    // omits the policy (recreate, resume) inherits it rather than reopening.
    const { trustProfile, egressAllowlist } = resolveTrustPolicy(spec, previous);
    const repo = getRepo(spec.repo || previous?.repoId);
    const { sandboxEnvironmentSettings } = await import("../environments");
    const resources = previous?.resources || sandboxEnvironmentSettings(repo.id, this.id);
    const branch = spec.branch || previous?.branch || repo.defaultBranch;
    // Keep workspaces in a guest-only namespace. The runner checkout is baked
    // separately at REMOTE_REPO; the Sandbox handle reports the cloned repo cwd.
    const cwd = previous?.cwd || workspacePath(spec.sessionId);

    let idx = previous ? indexFromId(previous.sandboxId) : null;
    let resumed = false;
    let resumeStartedAt: number | undefined;
    if (idx != null) {
      try {
        if (await unitRunning(idx)) {
          await driverFor(idx).ensureStarted();
        } else if (cloneDiskExists(idx, cfg.storeDir)) {
          resumeStartedAt = Date.now();
          await resumeClone(idx, cfg.storeDir, resources);
          await driverFor(idx).ensureStarted();
          resumed = true;
          console.log(`[sandbox:microvm] woke ${sandboxId(idx)} for ${spec.sessionId}`);
        } else {
          throw new Error("durable clone disk is gone");
        }
      } catch {
        await destroyClone(idx, cfg.storeDir).catch(() => {});
        await removeRemoteState(this.id, previous!.sandboxId);
        previous = null;
        idx = null;
      }
    }

    let created = false;
    if (idx == null) {
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        const candidate = indexFromId(claim.sandboxId);
        if (candidate != null) {
          try {
            if (await unitRunning(candidate)) {
              await driverFor(candidate).ensureStarted();
            } else if (cloneDiskExists(candidate, cfg.storeDir)) {
              resumeStartedAt = Date.now();
              await resumeClone(candidate, cfg.storeDir, resources);
              await driverFor(candidate).ensureStarted();
              resumed = true;
            } else {
              throw new Error("prewarmed clone disk is gone");
            }
            idx = candidate;
            created = true;
            console.log(
              `[sandbox:microvm] adopted prewarmed clone ${claim.sandboxId} for ${spec.sessionId}`,
            );
          } catch (error) {
            console.warn(
              `[sandbox:microvm] prewarm adoption failed (cold-creating):`,
              error,
            );
            discardClaimedPrewarm(this.id, claim.sandboxId);
          }
        } else {
          discardClaimedPrewarm(this.id, claim.sandboxId);
        }
      }
    }
    if (idx == null) {
      idx = await allocateClone(
        cfg.storeDir,
        cfg.indexStart,
        cfg.indexEnd,
        repo.id,
        resources,
      );
      created = true;
    }
    if (created) {
      await writeRemoteState({
        sandboxId: sandboxId(idx),
        provider: this.id,
        sessionId: spec.sessionId,
        cwd,
        repoId: repo.id,
        branch,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        trustProfile,
        egressAllowlist,
        resources: machine(resources),
      });
    }

    const driver = driverFor(idx);
    try {
      await driver.ensureStarted();
      // clone.sh repairs the snapshot-frozen clock through the root control
      // port before it returns. Doing it again here can sever an in-flight
      // keep-alive socket when the guest clock jumps.
      const bootstrapDriver = microvmBootstrapDriver(driver);
      const callbackBaseUrl = sandboxCallbackBaseUrl();
      await assertDialbackReachable(
        bootstrapDriver,
        "microvm",
        callbackBaseUrl,
      );
      await bootstrapRemoteSandbox(bootstrapDriver, "microvm");
      const cloneUrl = await remoteCloneUrl(repo);
      await setupRemoteWorkspace(
        driver,
        cwd,
        cloneUrl,
        branch,
        repo.defaultBranch,
        repo.id,
        { sandboxId: sandboxId(idx), provider: this.id, sessionId: spec.sessionId, repoId: repo.id, trustProfile },
      );
      if (resumed) {
        await runRemoteLifecycleHook(driver, cwd, "resume", "resume", undefined, { sandboxId: sandboxId(idx), provider: this.id, sessionId: spec.sessionId, repoId: repo.id, trustProfile });
        audit({
          kind: "sandbox_resume_metric",
          session_id: spec.sessionId,
          provider: this.id,
          sandbox_id: sandboxId(idx),
          resume_ms: resumeStartedAt ? Date.now() - resumeStartedAt : undefined,
          outcome: "ok",
        });
      }
      if (trustProfile === "automation") {
        const resolved = await restrictAutomationEgress(idx, cfg.storeDir, [
          callbackBaseUrl,
          cloneUrl,
          ...AUTOMATION_BASELINE_EGRESS,
          ...egressAllowlist,
        ]);
        audit({
          kind: "sandbox_automation_egress",
          session_id: spec.sessionId,
          provider: this.id,
          sandbox_id: sandboxId(idx),
          resolved_targets: resolved,
          outcome: "ok",
        });
      }
    } catch (error) {
      if (created) {
        await destroyClone(idx, cfg.storeDir).catch(() => {});
        await removeRemoteState(this.id, sandboxId(idx));
      }
      throw error;
    }
    await writeRemoteState({
      sandboxId: sandboxId(idx),
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: previous?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      trustProfile,
      egressAllowlist,
    });
    return this.makeHandle(idx, spec.sessionId, cwd);
  }

  private makeHandle(idx: number, sessionId: string, cwd: string): Sandbox {
    const id = sandboxId(idx);
    return makeRemoteSandbox({
      providerId: this.id,
      sandboxId: id,
      sessionId,
      cwd,
      driver: driverFor(idx),
      callbackBaseUrl: sandboxCallbackBaseUrl(),
      async ports(): Promise<PortMap> {
        // The guest veth is host-private, but Caddy runs on this host and can
        // dial it directly. Browser access still goes through the authenticated
        // portal route; the private address is never handed to the client.
        const ports =
          sandboxConfig().previewPorts?.length
            ? sandboxConfig().previewPorts!
            : [...DEFAULT_SANDBOX_PREVIEW_PORTS];
        return Object.fromEntries(
          ports.map((port) => [port, { upstream: `${ipFor(idx)}:${port}` }]),
        );
      },
      async status(): Promise<SandboxStatus> {
        if (!(await unitRunning(idx))) {
          const storeDir =
            sandboxConfig().firecrackerMicrovm?.storeDir ||
            "/opt/firecracker/sandbox-store";
          return cloneDiskExists(idx, storeDir) ? "stopped" : "gone";
        }
        try {
          await request(idx, "/health", undefined, false, 3_000);
          return "running";
        } catch {
          return "stopped";
        }
      },
      touchActivity: () => touchRemoteState(this.id, id),
    });
  }

  async get(id: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, id);
    const idx = indexFromId(id);
    if (!state || idx == null) return null;
    if (!(await unitRunning(idx))) {
      return cloneDiskExists(idx, config().storeDir)
        ? this.makeHandle(idx, state.sessionId, state.cwd)
        : null;
    }
    try {
      await driverFor(idx).ensureStarted();
      return this.makeHandle(idx, state.sessionId, state.cwd);
    } catch {
      return null;
    }
  }

  async destroy(id: string): Promise<void> {
    const idx = indexFromId(id);
    if (idx == null) return;
    const cfg = sandboxConfig().firecrackerMicrovm;
    // Cleanup must remain possible after an operator disables/removes the
    // provider block. Custom-store operators should destroy live sessions
    // before removing their config; the default remains recoverable.
    await destroyClone(idx, cfg?.storeDir || "/opt/firecracker/sandbox-store");
    await removeRemoteState(this.id, id);
  }

  async pause(id: string): Promise<void> {
    const state = readRemoteState(this.id, id);
    const idx = indexFromId(id);
    if (!state || idx == null || !(await unitRunning(idx))) return;
    if (hostRunBusy(state.sessionId))
      throw new Error(`cannot pause ${id} while its agent run is active`);
    await pauseClone(idx, config().storeDir);
    touchRemoteState(this.id, id);
  }

  async resume(id: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, id);
    if (!state) return null;
    return this.ensure({
      sessionId: state.sessionId,
      repo: state.repoId,
      branch: state.branch,
      cwd: state.cwd,
      trustProfile: state.trustProfile,
      egressAllowlist: state.egressAllowlist,
    });
  }
}

/** Provider qualification without coupling the Firecracker runtime check to a
 * repository credential. Real sessions receive their current scoped clone URL
 * at ensure-time; qualification proves the local isolation/snapshot machinery. */
export async function qualifyMicrovmRuntime(): Promise<void> {
  const cfg = config();
  const idx = await allocateClone(cfg.storeDir, cfg.indexStart, cfg.indexEnd);
  const driver = driverFor(idx);
  try {
    await driver.ensureStarted();
    const probe = await driver.exec(
      "set -eu; uname -s; printf opensession-qualified > /tmp/opensession-qualification",
    );
    if (probe.exitCode !== 0) throw new Error("MicroVM qualification command failed");
    await pauseClone(idx, cfg.storeDir);
    await resumeClone(idx, cfg.storeDir);
    await driver.ensureStarted();
    const restored = await driver.exec(
      'test "$(cat /tmp/opensession-qualification)" = opensession-qualified',
    );
    if (restored.exitCode !== 0) {
      throw new Error("MicroVM pause/wake did not preserve filesystem state");
    }
  } finally {
    await destroyClone(idx, cfg.storeDir).catch(() => {});
  }
}

/** Real interactive PTY inside a local Firecracker guest. The private control
 * lane exposes bounded start/read/write/resize/close calls; the browser still
 * talks only to Open Session's authenticated UI WebSocket. */
export async function microvmPtySession(
  sandboxIdValue: string,
  cwd: string,
  io: RemotePtyIo,
): Promise<RemotePtyHandle> {
  const idx = indexFromId(sandboxIdValue);
  if (idx == null) throw new Error(`invalid microvm sandbox id ${sandboxIdValue}`);
  const provider = new MicrovmProvider();
  let sandbox = await provider.get(sandboxIdValue);
  if (sandbox && (await sandbox.status()) === "stopped")
    sandbox = await provider.resume(sandboxIdValue);
  if (!sandbox || (await sandbox.status()) !== "running")
    throw new Error(`microvm sandbox ${sandboxIdValue} is unavailable`);
  const started = (await (
    await request(idx, "/pty/start", {
      cwd,
      cols: io.cols,
      rows: io.rows,
    })
  ).json()) as { id?: string };
  if (!started.id) throw new Error("microvm pty did not return an id");
  const id = started.id;
  let closed = false;
  void (async () => {
    try {
      while (!closed) {
        const response = await request(
          idx,
          `/pty/read?id=${encodeURIComponent(id)}&timeoutMs=1000`,
          undefined,
          false,
          5_000,
        );
        const frame = (await response.json()) as {
          data?: string;
          exited?: boolean;
          exitCode?: number | null;
        };
        if (frame.data) io.onData(Buffer.from(frame.data, "base64"));
        if (frame.exited) {
          closed = true;
          io.onExit(frame.exitCode ?? undefined);
        }
      }
    } catch {
      if (!closed) {
        closed = true;
        io.onExit(undefined);
      }
    }
  })();
  const post = (path: string, body: object) =>
    request(idx, path, { id, ...body }).catch(() => undefined);
  return {
    write: (data) => void post("/pty/write", { data: Buffer.from(data).toString("base64") }),
    resize: (cols, rows) => void post("/pty/resize", { cols, rows }),
    close: () => {
      if (closed) return;
      closed = true;
      void post("/pty/close", {});
    },
  };
}

/** Pause idle local MicroVMs while retaining their COW workspace disks. */
export async function sweepIdleMicrovms(onlySandboxId?: string): Promise<void> {
  const cfg = sandboxConfig().firecrackerMicrovm;
  if (!cfg?.enabled) return;
  const idleMs =
    (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  const provider = new MicrovmProvider();
  for (const state of listRemoteStates("microvm")) {
    if (state.sessionId.startsWith("__prewarm__:")) continue;
    if (onlySandboxId && state.sandboxId !== onlySandboxId) continue;
    const idx = indexFromId(state.sandboxId);
    if (idx == null || !(await unitRunning(idx))) continue;
    if (hostRunBusy(state.sessionId)) continue;
    const last = Date.parse(state.lastActivityAt || state.createdAt) || 0;
    if (Date.now() - last < idleMs) continue;
    try {
      console.log(
        `[sandbox:microvm] pausing ${state.sandboxId} after ${Math.round((Date.now() - last) / 60_000)}m idle`,
      );
      await provider.pause(state.sandboxId);
    } catch (error) {
      console.warn(`[sandbox:microvm] idle pause failed for ${state.sandboxId}:`, error);
    }
  }
}

function ensureIdleSweep(): void {
  const globalState = globalThis as any;
  if (globalState.__microvmIdleSweepTimer) return;
  globalState.__microvmIdleSweepTimer = setInterval(() => {
    void sweepIdleMicrovms();
  }, IDLE_SWEEP_MS);
}

// ── Warm-on-typing workspace prewarm hooks ──────────────────────────────────

export const microvmPrewarmAdapter: PrewarmAdapter = {
  async create(labels, options) {
    const cfg = config();
    const key = labels["opensession.prewarm.key"];
    if (!key?.startsWith("microvm:")) {
      throw new Error(`invalid MicroVM prewarm key: ${key || "(missing)"}`);
    }
    const repoId = key.slice("microvm:".length);
    const idx = await allocateClone(
      cfg.storeDir,
      cfg.indexStart,
      cfg.indexEnd,
      repoId,
      options.resources,
    );
    const id = sandboxId(idx);
    try {
      await writeRemoteState({
        sandboxId: id,
        provider: "microvm",
        sessionId: `__prewarm__:${key}`,
        cwd: workspacePath(`prewarm-${idx}`),
        repoId,
        resources: machine(options.resources),
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        // An unclaimed prewarm holds no session's credentials; the adopting
        // ensure() rewrites this state with that session's resolved policy.
        trustProfile: "interactive",
        egressAllowlist: [],
      });
      return { sandboxId: id, driver: driverFor(idx) };
    } catch (error) {
      await destroyClone(idx, cfg.storeDir).catch(() => {});
      await removeRemoteState("microvm", id);
      throw error;
    }
  },

  async prepare(driver, repo, label) {
    await driver.ensureStarted();
    await bootstrapRemoteSandbox(microvmBootstrapDriver(driver), label);
    if (!(await warmRemoteWorkspace(driver, repo, label, {
      installDeps: false,
      runSetup: true,
      identity: { sandboxId: `prewarm:${repo.id}`, provider: "microvm", repoId: repo.id },
    }))) {
      throw new Error(`MicroVM prewarm could not clone ${repo.id}`);
    }
    // Never persist the clone token in a repo-shared template. Adoption puts
    // fresh scoped authority back on the session-owned disk before fetching.
    if (repo.ghRepo) {
      const safeOrigin = `https://github.com/${repo.ghRepo}.git`;
      const scrubbed = await driver.exec(
        `git -C ${JSON.stringify(remoteWarmWorkspaceDir(repo.id))} remote set-url origin ${JSON.stringify(safeOrigin)}`,
      );
      if (scrubbed.exitCode !== 0)
        throw new Error(`MicroVM prewarm could not scrub clone authority for ${repo.id}`);
    }
  },

  async park(id) {
    const idx = indexFromId(id);
    if (idx == null) throw new Error(`invalid MicroVM prewarm id ${id}`);
    const cfg = config();
    const state = readRemoteState("microvm", id);
    if (!state?.repoId) throw new Error(`MicroVM prewarm ${id} has no repo identity`);
    await pauseClone(idx, cfg.storeDir);
    await publishRepoTemplate(idx, cfg.storeDir, state.repoId);
  },

  async destroy(id) {
    const idx = indexFromId(id);
    if (idx == null) return;
    const cfg = sandboxConfig().firecrackerMicrovm;
    await destroyClone(idx, cfg?.storeDir || "/opt/firecracker/sandbox-store");
    await removeRemoteState("microvm", id);
  },

  async listPrewarmed() {
    const out: Array<{ id: string; key: string }> = [];
    for (const state of listRemoteStates("microvm")) {
      if (!state.sessionId.startsWith("__prewarm__:")) continue;
      const idx = indexFromId(state.sandboxId);
      if (
        idx == null ||
        (!(await unitRunning(idx)) && !cloneDiskExists(idx, config().storeDir))
      ) continue;
      out.push({
        id: state.sandboxId,
        key: state.sessionId.slice("__prewarm__:".length),
      });
    }
    return out;
  },
};
