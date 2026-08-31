import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectSandboxProvider, updateSandboxConnection } from "./connections";
import { initializeManagedWorkspaceSecrets } from "../workspace-secrets";
import { initializeManagedSandboxConnections } from "./connections";
import {
  initializeManagedRemoteRepoTemplates,
  readRemoteRepoTemplate,
  remoteRepoTemplateNeedsRefresh,
  writeRemoteRepoTemplate,
} from "./remote-repo-template";

let scratch = "";
let db: ReturnType<typeof createFeltDB>;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "os-remote-template-"));
  process.env.OPENSESSION_SESSIONS_DIR = `${scratch}/sessions`;
  process.env.OPENSESSION_SANDBOX_CONFIG = `${scratch}/sandbox.json`;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = `${scratch}/secrets.json`;
  db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await initializeManagedWorkspaceSecrets(db);
  await initializeManagedSandboxConnections(db);
  await initializeManagedRemoteRepoTemplates(db, `${scratch}/sessions/sandbox-repo-templates`);
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
    await writeRemoteRepoTemplate("modal", "app", "im-1", 1_000);
    expect(readRemoteRepoTemplate("modal", "app", 2_000)?.artifactId).toBe("im-1");
    expect(readRemoteRepoTemplate("modal", "app", 365 * 24 * 60 * 60_000)?.artifactId).toBe("im-1");
  });

  test("refreshes source images every 30 minutes without expiring the old mapping", async () => {
    const { current } = await writeRemoteRepoTemplate("modal", "app", "im-1", 1_000);
    expect(remoteRepoTemplateNeedsRefresh(current, 1_000 + 29 * 60_000)).toBe(false);
    expect(remoteRepoTemplateNeedsRefresh(current, 1_000 + 30 * 60_000)).toBe(true);
    expect(readRemoteRepoTemplate("modal", "app", 1_000 + 30 * 60_000)?.artifactId).toBe("im-1");
  });

  test("preserves Box's daily start quota with a six-hour source refresh", async () => {
    const { current } = await writeRemoteRepoTemplate("box", "app", "snapshot-1", 1_000);
    expect(remoteRepoTemplateNeedsRefresh(current, 1_000 + 30 * 60_000)).toBe(false);
    expect(remoteRepoTemplateNeedsRefresh(current, 1_000 + 6 * 60 * 60_000)).toBe(true);
  });

  test("create-shape changes invalidate the local artifact mapping", async () => {
    await writeRemoteRepoTemplate("modal", "app", "im-1");
    await updateSandboxConnection("modal", { settings: { image: "base:v2" } });
    expect(readRemoteRepoTemplate("modal", "app")).toBeNull();
  });

  test("replacements report the old artifact for provider cleanup", async () => {
    await writeRemoteRepoTemplate("daytona", "app", "snap-1");
    const result = await writeRemoteRepoTemplate("daytona", "app", "snap-2");
    expect(result.previous?.artifactId).toBe("snap-1");
    const stored = (await db.collection<{ repoId: string; artifactId: string }>(
      "opensession_remote_repo_templates",
    ).all()).find((record) => record.repoId === "app");
    expect(stored?.artifactId).toBe("snap-2");
  });
});
