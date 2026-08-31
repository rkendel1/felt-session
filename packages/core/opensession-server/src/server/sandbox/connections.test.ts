import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  connectSandboxProvider,
  disconnectSandboxProvider,
  getSandboxConnection,
  initializeManagedSandboxConnections,
  safeSandboxConnections,
  sandboxConnectionReady,
  sandboxProviderCredential,
  setSandboxConnectionQualification,
} from "./connections";
import { initializeManagedWorkspaceSecrets } from "../workspace-secrets";
import { initializeManagedSandboxConfig } from "./config";

let scratch = "";
let oldConfig: string | undefined;
let oldSecrets: string | undefined;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-sandbox-connections-"));
  oldConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
  oldSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_SANDBOX_CONFIG = join(scratch, "sandbox.json");
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(scratch, "secrets.json");
  const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await initializeManagedWorkspaceSecrets(db);
  await initializeManagedSandboxConnections(db);
  await initializeManagedSandboxConfig(db);
});

afterEach(() => {
  if (oldConfig === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = oldConfig;
  if (oldSecrets === undefined) delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = oldSecrets;
  rmSync(scratch, { recursive: true, force: true });
});

describe("workspace sandbox connections", () => {
  test("stores Daytona credentials behind an opaque reference and never returns it", async () => {
    await connectSandboxProvider("daytona", {
      secret: "daytona-secret-value",
      settings: { apiUrl: "https://daytona.example.test", snapshot: "team-large" },
    });

    expect(existsSync(process.env.OPENSESSION_SANDBOX_CONFIG!)).toBe(false);
    expect(sandboxProviderCredential("daytona")).toEqual({
      apiKey: "daytona-secret-value",
    });

    const safe = safeSandboxConnections().find((value) => value.provider === "daytona")!;
    expect(safe.hasCredentials).toBe(true);
    expect(safe.state).toBe("checking");
    expect(safe).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(safe)).not.toContain("daytona-secret-value");
  });

  test("stores Box credentials behind an opaque reference and exposes only readiness", async () => {
    await connectSandboxProvider("box", {
      secret: "box-secret-value",
      settings: { apiUrl: "https://box.example.test/v1" },
    });
    expect(existsSync(process.env.OPENSESSION_SANDBOX_CONFIG!)).toBe(false);
    expect(sandboxProviderCredential("box")).toEqual({ apiKey: "box-secret-value" });
    expect(safeSandboxConnections().find((value) => value.provider === "box")).toMatchObject({
      hasCredentials: true,
      state: "checking",
      settings: { apiUrl: "https://box.example.test/v1" },
    });
  });

  test("rotates Modal credentials in place and disconnect deletes the secret", async () => {
    const first = await connectSandboxProvider("modal", {
      tokenId: "modal-id-one",
      tokenSecret: "modal-secret-one",
    });
    const ref = first.credentialRef;
    const second = await connectSandboxProvider("modal", {
      tokenId: "modal-id-two",
      tokenSecret: "modal-secret-two",
    });
    expect(second.id).toBe(first.id);
    expect(second.credentialRef).toBe(ref);
    expect(sandboxProviderCredential("modal")).toEqual({
      tokenId: "modal-id-two",
      tokenSecret: "modal-secret-two",
    });

    expect(await disconnectSandboxProvider("modal")).toBe(true);
    expect(getSandboxConnection("modal")).toBeUndefined();
    expect(sandboxProviderCredential("modal")).toBeUndefined();
  });

  test("only enabled, successfully qualified connections become Ready", async () => {
    await connectSandboxProvider("docker", { settings: { cpu: 4, memoryMb: 8192 } });
    expect(sandboxConnectionReady("docker")).toBe(false);
    await setSandboxConnectionQualification("docker", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(sandboxConnectionReady("docker")).toBe(true);
    expect(
      safeSandboxConnections().find((value) => value.provider === "docker")?.state,
    ).toBe("ready");
  });

  test("a runner pin change does not invalidate provider qualification", async () => {
    await connectSandboxProvider("daytona", { secret: "daytona-secret" });
    await setSandboxConnectionQualification("daytona", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(sandboxConnectionReady("daytona")).toBe(true);
    expect(
      safeSandboxConnections().find((value) => value.provider === "daytona")?.state,
    ).toBe("ready");
  });

  test("an adapter signature change makes a previous qualification stale", async () => {
    await connectSandboxProvider("docker", {});
    await setSandboxConnectionQualification("docker", {
      status: "ready",
      checkedAt: "2026-08-11T00:00:00.000Z",
    });
    const legacy = {
      connections: [{ ...getSandboxConnection("docker"), qualification: {
        ...getSandboxConnection("docker")!.qualification,
        adapterSignature: "docker:old-adapter",
      } }],
    };
    const nextDb = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    writeFileSync(process.env.OPENSESSION_SANDBOX_CONFIG!, JSON.stringify(legacy));
    await initializeManagedSandboxConnections(nextDb);
    await initializeManagedSandboxConfig(nextDb);

    expect(sandboxConnectionReady("docker")).toBe(false);
    expect(
      safeSandboxConnections().find((value) => value.provider === "docker")?.state,
    ).toBe("needs_attention");
  });
});
