/** `opensession sandbox …` — one-command local provider setup. */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  connectSandboxProvider,
  getSandboxConnection,
  isWorkspaceSandboxProvider,
  updateSandboxConnection,
} from "../../packages/core/opensession-server/src/server/sandbox/connections";
import { qualifySandboxConnection } from "../../packages/core/opensession-server/src/server/sandbox/qualification";
import { upsertCaddyIngress } from "../../packages/core/opensession-server/src/server/sandbox/caddy-ingress";
import { savePublicIngress } from "../../packages/core/opensession-server/src/server/ingress-settings";
import { configuredServer } from "../../packages/core/opensession-server/src/server/config";
import { stateDir } from "../../packages/core/opensession-server/src/server/paths";
import { writeJsonAtomic } from "../../packages/core/opensession-server/src/server/shared/atomic-write";
import { REPO_ROOT } from "./paths";
import { localAutomationToken } from "./local-auth";
import { dim, fail, heading, info, ok, run, runInherit, warn } from "./ui";

function sandboxConfigPath(): string {
  return process.env.OPENSESSION_SANDBOX_CONFIG || stateDir("sandbox.json");
}

function updateSandboxConfig(patch: Record<string, unknown>): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(sandboxConfigPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
  } catch {}
  writeJsonAtomic(sandboxConfigPath(), { ...raw, ...patch });
  chmodSync(sandboxConfigPath(), 0o600);
}

async function qualifyRemoteThroughServer(provider: "daytona" | "box" | "modal"): Promise<number> {
  const token = await localAutomationToken();
  if (!token) {
    fail(
      "no local Open Session web session is available",
      "open the app once, then rerun this command; remote qualification must run inside the server process",
    );
    return 1;
  }
  const base = `http://127.0.0.1:${configuredServer().port}`;
  const headers = {
    Cookie: `opensession_auth=${token}`,
    "Content-Type": "application/json",
  };
  let start: Response;
  try {
    start = await fetch(`${base}/api/sandbox/connections/${provider}/test`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail(
      "Open Session is not reachable on its local port",
      "start the service before testing Daytona, Box or Modal",
    );
    return 1;
  }
  const started = (await start.json().catch(() => ({}))) as {
    error?: string;
    operation?: { id?: string };
  };
  if (!start.ok || !started.operation?.id) {
    fail("remote qualification could not start", started.error || `HTTP ${start.status}`);
    return 1;
  }
  const operationId = started.operation.id;
  for (let attempt = 0; attempt < 600; attempt++) {
    await Bun.sleep(1_000);
    const status = await fetch(`${base}/api/sandbox/status`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    const body = status?.ok
      ? ((await status.json().catch(() => ({}))) as {
          operations?: Array<{
            id: string;
            status: "running" | "succeeded" | "failed";
            stage?: string;
            failureSummary?: string;
          }>;
        })
      : undefined;
    const operation = body?.operations?.find((candidate) => candidate.id === operationId);
    if (!operation || operation.status === "running") continue;
    if (operation.status === "succeeded") {
      ok(`${provider} is Ready`);
      return 0;
    }
    fail(`${provider} needs attention`, operation.failureSummary || "qualification failed");
    return 1;
  }
  fail(`${provider} qualification timed out`, "check Workspace → Sandboxes for the operation state");
  return 1;
}

async function requireCommand(name: string, hint: string): Promise<boolean> {
  if (Bun.which(name)) {
    ok(name);
    return true;
  }
  fail(`${name} is missing`, hint);
  return false;
}

async function installPersistentHostFirewall(): Promise<boolean> {
  const setup = `${REPO_ROOT}/deploy/sandbox/setup-host.sh`;
  const unitPath = "/etc/systemd/system/opensession-sandbox-host.service";
  if (!(await requireCommand("sudo", "install sudo and grant this operator host setup access"))) {
    return false;
  }
  const scratch = mkdtempSync(join(tmpdir(), "opensession-sandbox-unit-"));
  const staged = join(scratch, "opensession-sandbox-host.service");
  const unit = `[Unit]\nDescription=Open Session sandbox host firewall\nAfter=docker.service network-online.target\nWants=docker.service network-online.target\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/bash ${setup}\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n`;
  try {
    await Bun.write(staged, unit);
    for (const argv of [
      ["sudo", "-n", "install", "-m", "0644", staged, unitPath],
      ["sudo", "-n", "systemctl", "daemon-reload"],
      ["sudo", "-n", "systemctl", "enable", "--now", "opensession-sandbox-host.service"],
    ]) {
      const result = await run(argv);
      if (result.code !== 0) {
        fail("could not install the persistent sandbox firewall", result.stderr || argv.join(" "));
        return false;
      }
    }
    ok("persistent metadata-service firewall", unitPath);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function releaseVersion(): Promise<string> {
  const pkg = await Bun.file(`${REPO_ROOT}/package.json`).json();
  return String(pkg.version || "latest");
}

async function installDockerImage(): Promise<string | null> {
  const version = await releaseVersion();
  const releaseImage = `ghcr.io/tellahq/opensession-runner:${version}`;
  heading("Runner image");
  const pull = await run(["docker", "pull", releaseImage]);
  if (pull.code === 0) {
    if (!Bun.which("cosign")) {
      fail("cosign is required to verify the published runner image", "install cosign, then rerun this command");
      return null;
    }
    const verify = await run([
      "cosign",
      "verify",
      "--certificate-identity-regexp",
      "^https://github.com/tellahq/opensession/.github/workflows/sandbox-release.yml@refs/.*$",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      releaseImage,
    ]);
    if (verify.code !== 0) {
      fail("runner image signature verification failed");
      return null;
    }
    ok("verified release image", releaseImage);
    return releaseImage;
  }

  warn("no matching published image; building this checkout for the local architecture");
  const code = await runInherit(["bash", `${REPO_ROOT}/deploy/sandbox/build.sh`], REPO_ROOT);
  if (code !== 0) {
    fail("runner image build failed");
    return null;
  }
  return "opensession-runner:latest";
}

async function enableDocker(): Promise<number> {
  heading("Docker sandbox");
  if (!(await requireCommand("docker", "install Docker Engine, then rerun this command"))) return 1;
  const daemon = await run(["docker", "info", "--format", "{{.ServerVersion}}"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (daemon.code !== 0) {
    fail("Docker daemon is unavailable", "start Docker and allow this user to access its socket");
    return 1;
  }
  ok("Docker daemon", daemon.stdout);
  const image = await installDockerImage();
  if (!image) return 1;
  if (!(await installPersistentHostFirewall())) return 1;

  updateSandboxConfig({
    workspace: "volume",
    transport: "ws",
    snapshots: { enabled: true, onIdle: true, maxPerSession: 2, quickSyncOnRestore: true },
  });
  connectSandboxProvider("docker", { settings: { image, cpu: 4, memoryMb: 8192 } });
  heading("Qualification");
  try {
    await qualifySandboxConnection("docker");
  } catch (error) {
    fail("Docker needs attention", error instanceof Error ? error.message : String(error));
    return 1;
  }
  ok("Docker is Ready", "select it in Workspace → Sandboxes");
  return 0;
}

function architecture(): "x64" | "arm64" | null {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  return null;
}

async function downloadPublishedGolden(storeDir: string): Promise<"installed" | "missing" | "failed"> {
  const arch = architecture();
  if (!arch) return "missing";
  const version = await releaseVersion();
  const base =
    process.env.OPENSESSION_MICROVM_GOLDEN_URL ||
    `https://github.com/tellahq/opensession/releases/download/v${version}/opensession-microvm-golden-linux-${arch}.tar.zst`;
  const scratch = mkdtempSync(join(tmpdir(), "opensession-microvm-golden-"));
  const archive = join(scratch, "golden.tar.zst");
  try {
    const download = await run(["curl", "-fL", "--retry", "2", "-o", archive, base]);
    if (download.code !== 0) return "missing";
    const checksum = await run(["curl", "-fL", "--retry", "2", "-o", `${archive}.sha256`, `${base}.sha256`]);
    const signature = await run(["curl", "-fL", "--retry", "2", "-o", `${archive}.sig`, `${base}.sig`]);
    const certificate = await run(["curl", "-fL", "--retry", "2", "-o", `${archive}.pem`, `${base}.pem`]);
    if (checksum.code !== 0 || signature.code !== 0 || certificate.code !== 0) {
      fail("published golden is missing checksum or signature metadata");
      return "failed";
    }
    const expected = (await Bun.file(`${archive}.sha256`).text()).trim().split(/\s+/)[0];
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
    if (!expected || actual !== expected) {
      fail("published golden checksum verification failed");
      return "failed";
    }
    if (!Bun.which("cosign")) {
      fail("cosign is required to verify the published MicroVM golden");
      return "failed";
    }
    const verify = await run([
      "cosign",
      "verify-blob",
      "--signature",
      `${archive}.sig`,
      "--certificate",
      `${archive}.pem`,
      "--certificate-identity-regexp",
      "^https://github.com/tellahq/opensession/.github/workflows/sandbox-release.yml@refs/.*$",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      archive,
    ]);
    if (verify.code !== 0) {
      fail("published golden provenance verification failed");
      return "failed";
    }
    const install = await run([
      "sudo",
      "-n",
      "bash",
      "-lc",
      `mkdir -p '${storeDir}' && tar --zstd -xf '${archive}' -C '${storeDir}'`,
    ]);
    if (install.code !== 0) {
      fail("could not install the verified MicroVM golden", install.stderr);
      return "failed";
    }
    ok("verified release golden", base);
    return "installed";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function microvmStoreCandidates(): string[] {
  const explicit = process.env.OPENSESSION_MICROVM_STORE_DIR?.trim();
  if (explicit) return [explicit];
  return [
    "/opt/firecracker/sandbox-store",
    "/opt/firecracker/store/opensession-sandboxes",
  ];
}

async function reflinkCapableStore(storeDir: string): Promise<boolean> {
  if (!storeDir.startsWith("/opt/firecracker/")) return false;
  const created = await run(["sudo", "-n", "install", "-d", "-m", "0755", storeDir]);
  if (created.code !== 0) return false;
  const localScratch = mkdtempSync(join(tmpdir(), "opensession-cow-source-"));
  const source = join(localScratch, "source");
  let hostScratch = "";
  try {
    await Bun.write(source, "opensession-cow-check");
    const made = await run([
      "sudo",
      "-n",
      "mktemp",
      "-d",
      `${storeDir}/.opensession-cow-check.XXXXXX`,
    ]);
    hostScratch = made.stdout.trim();
    if (made.code !== 0 || !hostScratch.startsWith(`${storeDir}/.opensession-cow-check.`)) {
      return false;
    }
    const installed = await run([
      "sudo",
      "-n",
      "install",
      "-m",
      "0600",
      source,
      `${hostScratch}/source`,
    ]);
    if (installed.code !== 0) return false;
    return (
      await run([
        "sudo",
        "-n",
        "cp",
        "--reflink=always",
        `${hostScratch}/source`,
        `${hostScratch}/clone`,
      ])
    ).code === 0;
  } finally {
    if (hostScratch.startsWith(`${storeDir}/.opensession-cow-check.`)) {
      await run([
        "sudo",
        "-n",
        "rm",
        "-f",
        `${hostScratch}/source`,
        `${hostScratch}/clone`,
      ]).catch(() => undefined);
      await run(["sudo", "-n", "rmdir", hostScratch]).catch(() => undefined);
    }
    rmSync(localScratch, { recursive: true, force: true });
  }
}

async function microvmPrerequisites(): Promise<string | undefined> {
  let valid = true;
  if (process.platform !== "linux") {
    fail("Local MicroVM requires Linux");
    valid = false;
  } else ok("Linux host");
  if (!existsSync("/dev/kvm")) {
    fail("/dev/kvm is unavailable", "enable KVM/nested virtualization on this host");
    valid = false;
  } else ok("KVM device");
  const cpuInfo = existsSync("/proc/cpuinfo") ? readFileSync("/proc/cpuinfo", "utf-8") : "";
  if (!/\b(vmx|svm)\b/.test(cpuInfo)) {
    fail("CPU virtualization flags are unavailable");
    valid = false;
  } else ok("CPU virtualization");
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) {
    fail("cgroup v2 is unavailable");
    valid = false;
  } else ok("cgroup v2");
  for (const [name, hint] of [
    ["docker", "install Docker Engine to build the credential-free guest"],
    ["curl", "install curl"],
    ["sudo", "install sudo and configure non-interactive host setup access"],
  ] as const) {
    if (!(await requireCommand(name, hint))) valid = false;
  }
  if (!existsSync("/opt/firecracker/firecracker") || !existsSync("/opt/firecracker/vmlinux")) {
    fail("Firecracker runtime is incomplete", "install /opt/firecracker/firecracker and /opt/firecracker/vmlinux");
    valid = false;
  } else ok("Firecracker runtime and kernel");
  const disk = statfsSync(REPO_ROOT);
  const freeGb = Number(disk.bavail * disk.bsize) / 1024 ** 3;
  if (freeGb < 30) {
    fail("less than 30 GB of free disk is available", `${freeGb.toFixed(1)} GB free`);
    valid = false;
  } else ok("disk capacity", `${freeGb.toFixed(0)} GB free`);
  let storeDir: string | undefined;
  if (valid) {
    for (const candidate of microvmStoreCandidates()) {
      if (await reflinkCapableStore(candidate)) {
        storeDir = candidate;
        break;
      }
    }
    if (!storeDir) {
      fail(
        "no MicroVM store supports copy-on-write clones",
        "mount XFS with reflink=1 or Btrfs under /opt/firecracker, or set OPENSESSION_MICROVM_STORE_DIR",
      );
      valid = false;
    } else ok("copy-on-write MicroVM store", storeDir);
  }
  return valid ? storeDir : undefined;
}

async function enableMicrovm(): Promise<number> {
  heading("Local MicroVM sandbox");
  const storeDir = await microvmPrerequisites();
  if (!storeDir) return 1;
  updateSandboxConfig({
    firecrackerMicrovm: { enabled: true, storeDir, indexStart: 64, indexEnd: 127 },
  });
  const published = await downloadPublishedGolden(storeDir);
  if (published === "failed") return 1;
  if (published === "missing") {
    warn("no matching release golden; building a verified local fallback from this checkout");
    const build = await runInherit(
      ["sudo", "-n", "bash", `${REPO_ROOT}/deploy/sandbox/microvm/refresh-sandbox-golden.sh`, storeDir],
      REPO_ROOT,
    );
    if (build !== 0) {
      fail("MicroVM golden build failed");
      return 1;
    }
  }
  if (!(await installPersistentHostFirewall())) return 1;
  connectSandboxProvider("microvm", {});
  heading("Qualification");
  try {
    await qualifySandboxConnection("microvm");
  } catch (error) {
    fail("Local MicroVM needs attention", error instanceof Error ? error.message : String(error));
    return 1;
  }
  ok("Local MicroVM is Ready", "select it in Workspace → Sandboxes");
  return 0;
}

async function installCaddyIngress(originValue: string | undefined): Promise<number> {
  let origin: string;
  try {
    const parsed = new URL(originValue || "");
    if (parsed.protocol !== "https:") throw new Error("HTTPS is required");
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    origin = parsed.toString().replace(/\/$/, "");
  } catch {
    fail("usage: opensession sandbox ingress install https://ingress.example.com");
    return 1;
  }
  if (!(await requireCommand("caddy", "install Caddy, or copy the generated Settings snippet manually"))) {
    return 1;
  }
  if (!(await requireCommand("sudo", "grant this operator Caddy configuration access"))) return 1;

  const caddyfile = process.env.OPENSESSION_CADDYFILE || "/etc/caddy/Caddyfile";
  let main = "";
  try {
    main = readFileSync(caddyfile, "utf-8");
  } catch {
    fail(`could not read ${caddyfile}`);
    return 1;
  }
  const scratch = mkdtempSync(join(tmpdir(), "opensession-caddy-ingress-"));
  const staged = join(scratch, "Caddyfile");
  const backup = `${caddyfile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const sudo = ["sudo", "-n"];
  const rollback = async () => {
    await run([...sudo, "cp", "-p", backup, caddyfile]);
    await run([...sudo, "systemctl", "reload", "caddy"]);
  };
  try {
    try {
      await Bun.write(staged, upsertCaddyIngress(main, origin));
    } catch (error) {
      fail("Open Session could not safely update this Caddyfile", String(error));
      return 1;
    }
    if ((await run([...sudo, "cp", "-p", caddyfile, backup])).code !== 0) {
      fail("could not back up the Caddyfile");
      return 1;
    }
    if ((await run([...sudo, "install", "-m", "0644", staged, caddyfile])).code !== 0) {
      await rollback();
      fail("could not install the managed Caddy routes; the prior Caddyfile was restored");
      return 1;
    }
    const validate = await run([...sudo, "caddy", "validate", "--config", caddyfile, "--adapter", "caddyfile"]);
    if (validate.code !== 0) {
      await rollback();
      fail("Caddy rejected the generated configuration; the prior Caddyfile was restored", validate.stderr);
      return 1;
    }
    const reload = await run([...sudo, "systemctl", "reload", "caddy"]);
    if (reload.code !== 0) {
      await rollback();
      fail("Caddy reload failed; the prior Caddyfile was restored", reload.stderr);
      return 1;
    }
    let healthy = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(`${origin}/ingress-health`, {
          signal: AbortSignal.timeout(5_000),
        });
        healthy = response.ok && (await response.text()).trim() === "ok";
      } catch {}
      if (healthy) break;
      await Bun.sleep(1_000);
    }
    if (!healthy) {
      await rollback();
      fail("the public ingress check failed; the prior Caddyfile was restored");
      return 1;
    }
    await savePublicIngress({ publicBaseUrl: origin, exposure: "custom" });
    ok("sandbox ingress is Ready", origin);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function sandbox(args: string[]): Promise<number> {
  const action = args[0];
  const provider = args[1];
  if (action === "ingress" && provider === "install") {
    return installCaddyIngress(args[2]);
  }
  if (!isWorkspaceSandboxProvider(provider)) {
    fail("usage: opensession sandbox enable docker|microvm");
    info(dim("Also available: opensession sandbox test|disable docker|daytona|box|modal|microvm"));
    info(dim("Provider accounts are connected in Workspace → Sandboxes."));
    return 1;
  }
  if (action === "enable") {
    if (provider !== "docker" && provider !== "microvm") {
      fail(`${provider} credentials are connected in Workspace → Sandboxes`);
      return 1;
    }
    return provider === "docker" ? enableDocker() : enableMicrovm();
  }
  if (action === "disable") {
    if (!getSandboxConnection(provider)) {
      fail(`${provider} is not connected`);
      return 1;
    }
    updateSandboxConnection(provider, { enabled: false });
    ok(`${provider} is disabled`, "configuration and existing sandboxes were preserved");
    return 0;
  }
  if (action === "test") {
    if (!getSandboxConnection(provider)) {
      fail(`${provider} is not connected`);
      return 1;
    }
    heading(`${provider} qualification`);
    if (provider === "daytona" || provider === "box" || provider === "modal") {
      return qualifyRemoteThroughServer(provider);
    }
    try {
      await qualifySandboxConnection(provider);
      ok(`${provider} is Ready`);
      return 0;
    } catch (error) {
      fail(`${provider} needs attention`, error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  fail("usage: opensession sandbox enable docker|microvm");
  info(dim("Also available: opensession sandbox test|disable docker|daytona|box|modal|microvm"));
  return 1;
}
