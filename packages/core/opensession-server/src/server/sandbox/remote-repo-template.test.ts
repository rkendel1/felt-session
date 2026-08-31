import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectSandboxProvider, updateSandboxConnection } from "./connections";
import { initializeManagedWorkspaceSecrets } from "../workspace-secrets";
import { initializeManagedSandboxConnections } from "./connections";

let scratch = "";

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "os-remote-template-"));
  process.env.OPENSESSION_SESSIONS_DIR = `${scratch}/sessions`;
  process.env.OPENSESSION_SANDBOX_CONFIG = `${scratch}/sandbox.json`;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = `${scratch}/secrets.json`;
  const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await initializeManagedWorkspaceSecrets(db);
  await initializeManagedSandboxConnections(db);
  await Bun.write(
    process.env.OPENSESSION_SANDBOX_CONFIG,
    JSON.stringify({ runnerSha: "abc" }),
  );
  await connectSandboxProvider("modal", {
    tokenId: "test-id",
    tokenSecret: "test-secret",
    settings: { image: "base:v1" },
  });
});

afterEach(() => {
  delete process.env.OPENSESSION_SESSIONS_DIR;
  delete process.env.OPENSESSION_SANDBOX_CONFIG;
  delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  rmSync(scratch, { recursive: true, force: true });
});

describe("remote repo template index", () => {
  test("keeps credential-free stopped artifacts until an input changes", async () => {
    const mod = await import(`./remote-repo-template?roundtrip=${Math.random()}`);
    mod.writeRemoteRepoTemplate("modal", "app", "im-1", 1_000);
    expect(mod.readRemoteRepoTemplate("modal", "app", 2_000)?.artifactId).toBe("im-1");
    expect(mod.readRemoteRepoTemplate("modal", "app", 365 * 24 * 60 * 60_000)?.artifactId).toBe("im-1");
  });

  test("refreshes source images every 30 minutes without expiring the old mapping", async () => {
    const mod = await import(`./remote-repo-template?refresh=${Math.random()}`);
    const { current } = mod.writeRemoteRepoTemplate("modal", "app", "im-1", 1_000);
    expect(mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 29 * 60_000)).toBe(false);
    expect(mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 30 * 60_000)).toBe(true);
    expect(mod.readRemoteRepoTemplate("modal", "app", 1_000 + 30 * 60_000)?.artifactId).toBe("im-1");
  });

  test("preserves Box's daily start quota with a six-hour source refresh", async () => {
    const mod = await import(`./remote-repo-template?box-refresh=${Math.random()}`);
    const { current } = mod.writeRemoteRepoTemplate("box", "app", "snapshot-1", 1_000);
    expect(mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 30 * 60_000)).toBe(false);
    expect(mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 6 * 60 * 60_000)).toBe(true);
  });

  test("create-shape changes invalidate the local artifact mapping", async () => {
    const mod = await import(`./remote-repo-template?shape=${Math.random()}`);
    mod.writeRemoteRepoTemplate("modal", "app", "im-1");
    await updateSandboxConnection("modal", { settings: { image: "base:v2" } });
    expect(mod.readRemoteRepoTemplate("modal", "app")).toBeNull();
  });

  test("replacements report the old artifact for provider cleanup", async () => {
    const mod = await import(`./remote-repo-template?replace=${Math.random()}`);
    mod.writeRemoteRepoTemplate("daytona", "app", "snap-1");
    const result = mod.writeRemoteRepoTemplate("daytona", "app", "snap-2");
    expect(result.previous?.artifactId).toBe("snap-1");
    const stored = JSON.parse(
      readFileSync(
        `${scratch}/sessions/sandbox-repo-templates/daytona-app.json`,
        "utf-8",
      ),
    );
    expect(stored.artifactId).toBe("snap-2");
  });
});
