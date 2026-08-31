import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { REPOS } from "../worktree";
import {
  connectSandboxProvider,
  setSandboxConnectionQualification,
  updateSandboxConnection,
} from "./connections";
import {
  initializeManagedSandboxEnvironments,
  invalidateSandboxEnvironmentsForRepo,
  listSandboxEnvironments,
  prepareSandboxEnvironment,
} from "./environments";
import { initializeManagedWorkspaceSecrets } from "../workspace-secrets";
import { initializeManagedSandboxConnections } from "./connections";

let scratch = "";
let db: ReturnType<typeof createFeltDB>;
const previous: Record<string, string | undefined> = {};
const keys = [
  "OPENSESSION_SANDBOX_CONFIG",
  "OPENSESSION_WORKSPACE_SECRETS_STORE",
  "OPENSESSION_SANDBOX_ENVIRONMENTS_STORE",
] as const;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "opensession-sandbox-environments-"));
  for (const key of keys) previous[key] = process.env[key];
  process.env.OPENSESSION_SANDBOX_CONFIG = join(scratch, "sandbox.json");
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(scratch, "secrets.json");
  process.env.OPENSESSION_SANDBOX_ENVIRONMENTS_STORE = join(scratch, "environments.json");
  db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await initializeManagedWorkspaceSecrets(db);
  await initializeManagedSandboxConnections(db);
  await initializeManagedSandboxEnvironments(db);
});

afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("sandbox project environments", () => {
  test("Docker is prepared per session and disabling its connection removes readiness", async () => {
    const repo = Object.keys(REPOS)[0]!;
    await connectSandboxProvider("docker", {});
    await setSandboxConnectionQualification("docker", {
      status: "ready",
      checkedAt: new Date().toISOString(),
    });
    await prepareSandboxEnvironment(repo, "docker");
    expect(
      (await listSandboxEnvironments()).find(
        (environment) => environment.repo === repo && environment.provider === "docker",
      ),
    ).toMatchObject({ state: "ready", mode: "per_session" });

    await updateSandboxConnection("docker", { enabled: false });
    expect(
      (await listSandboxEnvironments()).find(
        (environment) => environment.repo === repo && environment.provider === "docker",
      )?.state,
    ).toBe("not_prepared");
  });

  test("rejects unknown repositories before allocating provider work", async () => {
    await connectSandboxProvider("docker", {});
    await setSandboxConnectionQualification("docker", { status: "ready" });
    await expect(
      prepareSandboxEnvironment("not-a-repository", "docker"),
    ).rejects.toMatchObject({ code: "REPO_UNKNOWN" });
  });

  test("rejects invalid project machine settings before allocating provider work", async () => {
    const repo = Object.keys(REPOS)[0]!;
    await connectSandboxProvider("modal", { tokenId: "test-id", tokenSecret: "test-secret" });
    await setSandboxConnectionQualification("modal", { status: "ready" });
    await expect(
      prepareSandboxEnvironment(repo, "modal", { settings: { cpu: 0 } }),
    ).rejects.toMatchObject({ code: "MACHINE_SETTINGS_INVALID" });

    await connectSandboxProvider("box", { secret: "test-box-key" });
    await setSandboxConnectionQualification("box", { status: "ready" });
    await expect(
      prepareSandboxEnvironment(repo, "box", {
        settings: { cpu: 4, memoryMb: 8_192, diskGb: 40 },
      }),
    ).rejects.toMatchObject({ code: "MACHINE_SETTINGS_INVALID" });

    await connectSandboxProvider("microvm", {});
    await setSandboxConnectionQualification("microvm", { status: "ready" });
    await expect(
      prepareSandboxEnvironment(repo, "microvm", {
        settings: { cpu: 3, memoryMb: 4_096, diskGb: 25 },
      }),
    ).rejects.toMatchObject({ code: "MACHINE_SETTINGS_INVALID" });
  });

  test("marks every reusable provider template stale after a default-branch update", async () => {
    const repo = Object.keys(REPOS)[0]!;
    const path = process.env.OPENSESSION_SANDBOX_ENVIRONMENTS_STORE!;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        environments: ["daytona", "box", "modal", "microvm"].map((provider) => ({
          repo,
          provider,
          state: "ready",
          mode: "template",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      }),
    );
    db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedSandboxEnvironments(db);
    await invalidateSandboxEnvironmentsForRepo(repo);
    const stored = await db.collection<{
      repo: string;
      provider: string;
      state: string;
    }>("opensession_sandbox_environments").all();
    const reusable = stored.filter((environment) =>
      environment.repo === repo && ["daytona", "box", "modal", "microvm"].includes(environment.provider));
    expect(reusable).toHaveLength(4);
    expect(reusable.every((environment) => environment.state === "stale")).toBe(true);
  });
});
