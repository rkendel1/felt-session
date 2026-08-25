import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderSessionKernelUnit, renderUnit } from "../scripts/lib/service";

const repoRoot = resolve(import.meta.dir, "..");

describe("session kernel service deployment", () => {
  test("makes the authenticated actor service a fail-closed gateway dependency", async () => {
    const gateway = await renderUnit("system");
    const actor = await Bun.file(
      resolve(repoRoot, "opensession-session-kernel.service"),
    ).text();
    expect(gateway).toContain("Requires=opensession-session-kernel.service");
    expect(gateway).toContain("LoadCredential=session-kernel-token:");
    expect(actor).toContain("IPAddressAllow=localhost");
    expect(actor).toContain("IPAddressDeny=any");
    expect(actor).not.toContain("EnvironmentFile=");
  });

  test("leaves no gateway-side actor or writable-store fallback", async () => {
    const runtime = await Bun.file(
      resolve(
        repoRoot,
        "packages/core/opensession-server/src/server/session-kernel/actor-runtime.ts",
      ),
    ).text();
    expect(runtime).toContain("session-kernel-transport-worker.js");
    expect(runtime).not.toContain('workerEntry("session-kernel-worker.js"');
    expect(runtime).not.toContain("new SessionKernelStore");
  });

  test("renders source and rootless units with minimal state environment", async () => {
    const system = await renderSessionKernelUnit("system");
    const user = await renderSessionKernelUnit("user");
    expect(system).toContain(
      "packages/core/opensession-server/src/session-kernel-service.ts",
    );
    expect(system).toContain("LoadCredential=session-kernel-token:/etc/opensession/session-kernel-token");
    expect(system).not.toContain("EnvironmentFile=");
    expect(user).not.toMatch(/^User=/m);
    expect(user).not.toContain("IPAddressDeny=");
    expect(user).toContain("WantedBy=default.target");
  });

  test("root and self deploy restart the actor before the gateway", async () => {
    const deploy = await Bun.file(resolve(repoRoot, "deploy/deploy.sh")).text();
    const selfDeploy = await Bun.file(
      resolve(repoRoot, "deploy/self-deploy.sh"),
    ).text();
    expect(deploy).toContain("install-session-kernel-credential.sh");
    expect(deploy).toContain("opensession-session-kernel.service");
    expect(deploy.indexOf('systemctl restart opensession-session-kernel.service'))
      .toBeLessThan(deploy.lastIndexOf("systemctl restart opensession.service"));
    expect(selfDeploy).toContain("refresh_session_kernel");
    expect(selfDeploy.indexOf("refresh_session_kernel"))
      .toBeLessThan(selfDeploy.lastIndexOf("restart_service"));
  });

  test("renders the same credential into both sides of the gateway boundary", async () => {
    const gateway = await renderUnit("system");
    const actor = await renderSessionKernelUnit("system");
    const credential =
      "LoadCredential=session-kernel-token:/etc/opensession/session-kernel-token";
    expect(gateway).toContain(credential);
    expect(actor).toContain(credential);
  });
});
