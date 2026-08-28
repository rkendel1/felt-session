/**
 * Tests for Worktree and Agent Run registries.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { randomUUIDv7 } from "bun";
import {
  openDurableWorktreeRegistry,
  createStandardWorktree,
} from "./durable-worktree-registry";
import {
  openDurableAgentRunRegistry,
  createStandardAgentRun,
} from "./durable-agent-run-registry";
import type { MissionControlWorktree } from "./mission-control-worktree";
import type { MissionControlAgentRun } from "./mission-control-agent-run";

let testDir: string;
let testCounter = 0;

beforeEach(() => {
  testDir = `/tmp/worktree-test-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe("DurableWorktreeRegistry", () => {
  it("should create and retrieve a worktree", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const worktree = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/home/user/projects/myrepo/.git/worktrees/feature",
      "feature/new-api",
      "abc123def456",
    );

    await registry.createWorktree(worktree);
    const retrieved = await registry.getWorktree(worktree.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.branch).toBe("feature/new-api");
    expect(retrieved?.baseCommit).toBe("abc123def456");
    expect(retrieved?.status).toBe("active");
  });

  it("should list worktrees by project", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const wt1 = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path1",
      "branch1",
      "commit1",
    );

    const wt2 = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path2",
      "branch2",
      "commit2",
    );

    const wt3 = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-2",
      "repo-2",
      "/path3",
      "branch3",
      "commit3",
    );

    await registry.createWorktree(wt1);
    await registry.createWorktree(wt2);
    await registry.createWorktree(wt3);

    const proj1Worktrees = await registry.listWorktreesByProject("proj-1");
    expect(proj1Worktrees.length).toBe(2);
    expect(proj1Worktrees.map((w) => w.id).sort()).toContain(wt1.id);
    expect(proj1Worktrees.map((w) => w.id).sort()).toContain(wt2.id);
  });

  it("should list worktrees by repository", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const wt1 = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path1",
      "branch1",
      "commit1",
    );

    const wt2 = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-2",
      "/path2",
      "branch2",
      "commit2",
    );

    await registry.createWorktree(wt1);
    await registry.createWorktree(wt2);

    const repo1Worktrees = await registry.listWorktreesByRepository("repo-1");
    expect(repo1Worktrees.length).toBe(1);
    expect(repo1Worktrees[0].id).toBe(wt1.id);
  });

  it("should list active worktrees by agent", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const wt1 = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path1",
      "branch1",
      "commit1",
    );
    wt1.agentId = "agent-1";

    const wt2 = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path2",
      "branch2",
      "commit2",
    );
    wt2.agentId = "agent-1";
    wt2.status = "completed";

    await registry.createWorktree(wt1);
    await registry.createWorktree(wt2);

    const activeWorktrees = await registry.listWorktreesByAgent("agent-1");
    expect(activeWorktrees.length).toBe(1);
    expect(activeWorktrees[0].status).toBe("active");
  });

  it("should record and retrieve worktree files", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const worktree = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path",
      "branch",
      "commit",
    );

    await registry.createWorktree(worktree);

    const files = [
      {
        id: `file-${randomUUIDv7()}`,
        worktreeId: worktree.id,
        path: "src/index.ts",
        status: "modified" as const,
        size: 1024,
      },
      {
        id: `file-${randomUUIDv7()}`,
        worktreeId: worktree.id,
        path: "src/utils.ts",
        status: "created" as const,
        size: 512,
      },
    ];

    await registry.recordWorktreeFiles(worktree.id, files);

    const retrieved = await registry.getWorktreeFiles(worktree.id);
    expect(retrieved.length).toBe(2);
    expect(retrieved.map((f) => f.path).sort()).toEqual([
      "src/index.ts",
      "src/utils.ts",
    ]);
  });

  it("should record and retrieve change sets", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const worktree = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path",
      "branch",
      "abc123",
    );

    await registry.createWorktree(worktree);

    const changes = {
      id: `changes-${randomUUIDv7()}`,
      worktreeId: worktree.id,
      fromCommit: "abc123",
      toCommit: "def456",
      filesChanged: 3,
      insertions: 150,
      deletions: 42,
      summary: "Add new API endpoint",
      createdAt: new Date().toISOString(),
    };

    await registry.recordChanges(changes);

    const history = await registry.getWorktreeChangeHistory(worktree.id);
    expect(history.length).toBe(1);
    expect(history[0].filesChanged).toBe(3);
    expect(history[0].insertions).toBe(150);
  });

  it("should update worktree head commit", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const worktree = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path",
      "branch",
      "abc123",
    );

    await registry.createWorktree(worktree);

    await registry.updateWorktreeHead(worktree.id, "xyz789");

    const updated = await registry.getWorktree(worktree.id);
    expect(updated?.headCommit).toBe("xyz789");
  });

  it("should update worktree status", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const worktree = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path",
      "branch",
      "commit",
    );

    await registry.createWorktree(worktree);

    worktree.status = "completed";
    await registry.updateWorktree(worktree);

    const updated = await registry.getWorktree(worktree.id);
    expect(updated?.status).toBe("completed");
  });

  it("should delete worktree and cascade cleanup", async () => {
    const registry = openDurableWorktreeRegistry(testDir);

    const worktree = createStandardWorktree(
      `wt-${randomUUIDv7()}`,
      "proj-1",
      "repo-1",
      "/path",
      "branch",
      "commit",
    );

    await registry.createWorktree(worktree);

    const files = [
      {
        id: `file-${randomUUIDv7()}`,
        worktreeId: worktree.id,
        path: "file.ts",
        status: "created" as const,
      },
    ];

    await registry.recordWorktreeFiles(worktree.id, files);

    await registry.deleteWorktree(worktree.id);

    const retrieved = await registry.getWorktree(worktree.id);
    expect(retrieved).toBeNull();

    const filesRetrieved = await registry.getWorktreeFiles(worktree.id);
    expect(filesRetrieved.length).toBe(0);
  });
});

describe("DurableAgentRunRegistry", () => {
  it("should create and retrieve an agent run", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/home/user/projects/repo",
    );

    await registry.createRun(run);
    const retrieved = await registry.getRun(run.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.command).toBe("npm test");
    expect(retrieved?.status).toBe("pending");
  });

  it("should list runs by agent", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run1 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
    );

    const run2 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-2",
      "npm build",
      "/path",
    );

    await registry.createRun(run1);
    await registry.createRun(run2);

    const agent1Runs = await registry.listRunsByAgent("agent-1");
    expect(agent1Runs.length).toBe(1);
    expect(agent1Runs[0].id).toBe(run1.id);
  });

  it("should list runs by task", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run1 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
      "task-1",
    );

    const run2 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm build",
      "/path",
      "task-2",
    );

    await registry.createRun(run1);
    await registry.createRun(run2);

    const task1Runs = await registry.listRunsByTask("task-1");
    expect(task1Runs.length).toBe(1);
    expect(task1Runs[0].command).toBe("npm test");
  });

  it("should mark run as started", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
    );

    await registry.createRun(run);
    await registry.markRunStarted(run.id);

    const updated = await registry.getRun(run.id);
    expect(updated?.status).toBe("running");
    expect(updated?.startedAt).toBeDefined();
  });

  it("should mark run as completed with output", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
    );

    await registry.createRun(run);
    await registry.markRunStarted(run.id);

    const output = "Test results: 42 passed, 0 failed";
    await registry.markRunCompleted(run.id, "succeeded", output, undefined, 0);

    const updated = await registry.getRun(run.id);
    expect(updated?.status).toBe("succeeded");
    expect(updated?.output).toBe(output);
    expect(updated?.exitCode).toBe(0);
    expect(updated?.completedAt).toBeDefined();
    expect(updated?.durationMs).toBeDefined();
  });

  it("should record run output", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
    );

    await registry.createRun(run);

    const outputs = [
      {
        id: `output-${randomUUIDv7()}`,
        agentRunId: run.id,
        type: "stdout" as const,
        content: "Running tests...",
        lineNumber: 1,
        timestamp: new Date().toISOString(),
      },
      {
        id: `output-${randomUUIDv7()}`,
        agentRunId: run.id,
        type: "stdout" as const,
        content: "✓ All tests passed",
        lineNumber: 2,
        timestamp: new Date().toISOString(),
      },
    ];

    for (const output of outputs) {
      await registry.recordRunOutput(output);
    }

    const retrieved = await registry.getRunOutput(run.id);
    expect(retrieved.length).toBe(2);
    expect(retrieved.map((o) => o.content)).toContain("Running tests...");
  });

  it("should record and retrieve run environment", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
    );

    await registry.createRun(run);

    const env = {
      id: `env-${randomUUIDv7()}`,
      agentRunId: run.id,
      workingDirectory: "/home/user/projects/repo",
      environmentVariables: {
        NODE_ENV: "test",
        DEBUG: "true",
      },
      gitBranch: "feature/new-api",
      gitCommit: "abc123def456",
      gitStatus: "dirty" as const,
    };

    await registry.recordRunEnvironment(env);

    const retrieved = await registry.getRunEnvironment(run.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.environmentVariables.NODE_ENV).toBe("test");
    expect(retrieved?.gitBranch).toBe("feature/new-api");
  });

  it("should list failed runs by project", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run1 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
    );

    const run2 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm build",
      "/path",
    );

    await registry.createRun(run1);
    await registry.createRun(run2);

    await registry.markRunCompleted(run1.id, "succeeded");
    await registry.markRunCompleted(
      run2.id,
      "failed",
      undefined,
      "Build failed",
      1,
    );

    const failedRuns = await registry.listFailedRunsByProject("proj-1");
    expect(failedRuns.length).toBe(1);
    expect(failedRuns[0].id).toBe(run2.id);
  });

  it("should list runs by worktree", async () => {
    const registry = openDurableAgentRunRegistry(testDir);

    const run1 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm test",
      "/path",
      undefined,
      "wt-1",
    );

    const run2 = createStandardAgentRun(
      `run-${randomUUIDv7()}`,
      "proj-1",
      "agent-1",
      "npm build",
      "/path",
      undefined,
      "wt-2",
    );

    await registry.createRun(run1);
    await registry.createRun(run2);

    const wt1Runs = await registry.listRunsByWorktree("wt-1");
    expect(wt1Runs.length).toBe(1);
    expect(wt1Runs[0].id).toBe(run1.id);
  });
});
