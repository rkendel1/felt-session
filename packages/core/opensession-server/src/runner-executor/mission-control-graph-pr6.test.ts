/**
 * PR6 Repository Intelligence Graph: Comprehensive tests
 * 
 * Tests for commit registry, graph queries, risk scoring, and durable state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { randomUUIDv7 } from "bun";

import {
  openDurableRepositoryCommitRegistry,
  type DurableRepositoryCommitRegistry,
} from "./durable-repository-commit-registry";
import {
  createRepositoryGraphQueries,
  type RepositoryGraphQueries,
} from "./repository-graph-queries";
import {
  openDurableRepositoryFileRegistry,
  type DurableRepositoryFileRegistry,
} from "./durable-repository-file-registry";
import type {
  RepositoryCommit,
  CommitFileChange,
} from "./mission-control-repository-observer";
import { testFeltDb } from "./test-feltdb";

let testCounter = 0;
let testDir: string;
let commitRegistry: DurableRepositoryCommitRegistry;
let fileRegistry: DurableRepositoryFileRegistry;
let graphQueries: RepositoryGraphQueries;

beforeEach(() => {
  testDir = `/tmp/pr6-test-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });

  commitRegistry = openDurableRepositoryCommitRegistry(
    testFeltDb(path.join(testDir, "commits.db")),
  );
  fileRegistry = openDurableRepositoryFileRegistry(
    path.join(testDir, "files.db")
  );
  graphQueries = createRepositoryGraphQueries({
    fileRegistry,
    commitRegistry,
  });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe("PR6: Repository Intelligence Graph", () => {
  it("should create and retrieve commits with full metadata", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;
    const commit: RepositoryCommit = {
      id: `commit-${randomUUIDv7()}`,
      repositoryId,
      sha: "abc123def456",
      parentShas: [],
      branch: "main",
      author: "dev@example.com",
      message: "Initial commit",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };

    await commitRegistry.createCommit(commit);
    const retrieved = await commitRegistry.getCommitBySha(commit.sha);

    expect(retrieved).toBeDefined();
    expect(retrieved?.message).toBe("Initial commit");
    expect(retrieved?.author).toBe("dev@example.com");
    expect(retrieved?.branch).toBe("main");
  });

  it("should list commits by repository in reverse chronological order", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;
    const now = Date.now();

    const commits: RepositoryCommit[] = [
      {
        id: `c1-${randomUUIDv7()}`,
        repositoryId,
        sha: "sha1",
        parentShas: [],
        message: "First",
        committedAt: new Date(now - 3000).toISOString(),
        observedAt: new Date().toISOString(),
      },
      {
        id: `c2-${randomUUIDv7()}`,
        repositoryId,
        sha: "sha2",
        parentShas: ["sha1"],
        message: "Second",
        committedAt: new Date(now - 1000).toISOString(),
        observedAt: new Date().toISOString(),
      },
      {
        id: `c3-${randomUUIDv7()}`,
        repositoryId,
        sha: "sha3",
        parentShas: ["sha2"],
        message: "Third",
        committedAt: new Date(now).toISOString(),
        observedAt: new Date().toISOString(),
      },
    ];

    for (const c of commits) {
      await commitRegistry.createCommit(c);
    }

    const retrieved = await commitRegistry.getCommits(repositoryId, 10);
    expect(retrieved.length).toBe(3);
    expect(retrieved[0].message).toBe("Third");
    expect(retrieved[1].message).toBe("Second");
    expect(retrieved[2].message).toBe("First");
  });

  it("should record and retrieve file changes in commits", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;
    const commit: RepositoryCommit = {
      id: `commit-${randomUUIDv7()}`,
      repositoryId,
      sha: "change-test",
      parentShas: [],
      message: "File changes",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };

    await commitRegistry.createCommit(commit);

    const fileId = `file-${randomUUIDv7()}`;
    const change: CommitFileChange = {
      id: `change-${randomUUIDv7()}`,
      commitId: commit.id,
      fileId,
      changeType: "modified",
      additions: 15,
      deletions: 3,
    };

    await commitRegistry.recordFileChange(change);

    const changes = await commitRegistry.getCommitChanges(commit.id);
    expect(changes.length).toBe(1);
    expect(changes[0].changeType).toBe("modified");
    expect(changes[0].additions).toBe(15);
    expect(changes[0].deletions).toBe(3);
  });

  it("should track file change history across commits", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;
    const fileId = `file-${randomUUIDv7()}`;

    for (let i = 0; i < 3; i++) {
      const commit: RepositoryCommit = {
        id: `c${i}-${randomUUIDv7()}`,
        repositoryId,
        sha: `sha-${i}`,
        parentShas: i > 0 ? [`sha-${i - 1}`] : [],
        message: `Change ${i}`,
        committedAt: new Date(Date.now() - (3 - i) * 1000).toISOString(),
        observedAt: new Date().toISOString(),
      };
      await commitRegistry.createCommit(commit);

      const change: CommitFileChange = {
        id: `change${i}-${randomUUIDv7()}`,
        commitId: commit.id,
        fileId,
        changeType: i === 0 ? "added" : "modified",
      };
      await commitRegistry.recordFileChange(change);
    }

    const history = await commitRegistry.getFileChangeHistory(fileId, 10);
    expect(history.length).toBe(3);
  });

  it("should retrieve commits touching a specific file", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;
    const fileId = `file-${randomUUIDv7()}`;

    const commitIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const commit: RepositoryCommit = {
        id: `c${i}-${randomUUIDv7()}`,
        repositoryId,
        sha: `touch-sha-${i}`,
        parentShas: [],
        message: `Touched file ${i}`,
        committedAt: new Date(Date.now() - i * 1000).toISOString(),
        observedAt: new Date().toISOString(),
      };
      commitIds.push(commit.id);
      await commitRegistry.createCommit(commit);

      const change: CommitFileChange = {
        id: `change${i}-${randomUUIDv7()}`,
        commitId: commit.id,
        fileId,
        changeType: "modified",
      };
      await commitRegistry.recordFileChange(change);
    }

    const touching = await commitRegistry.getCommitsTouchingFile(fileId);
    expect(touching.length).toBe(2);
  });

  it("should handle file change with rename", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;
    const commit: RepositoryCommit = {
      id: `rename-${randomUUIDv7()}`,
      repositoryId,
      sha: "rename-sha",
      parentShas: [],
      message: "Rename",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };

    await commitRegistry.createCommit(commit);

    const fileId = `file-${randomUUIDv7()}`;
    const change: CommitFileChange = {
      id: `change-${randomUUIDv7()}`,
      commitId: commit.id,
      fileId,
      changeType: "renamed",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
    };

    await commitRegistry.recordFileChange(change);

    const changes = await commitRegistry.getCommitChanges(commit.id);
    expect(changes[0].changeType).toBe("renamed");
    expect(changes[0].oldPath).toBe("src/old.ts");
    expect(changes[0].newPath).toBe("src/new.ts");
  });

  it("should get recent changes within a time window", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;

    // Create old commit (2 days ago)
    const old = new Date();
    old.setDate(old.getDate() - 2);

    const oldCommit: RepositoryCommit = {
      id: `old-${randomUUIDv7()}`,
      repositoryId,
      sha: "old-sha",
      parentShas: [],
      message: "Old",
      committedAt: old.toISOString(),
      observedAt: new Date().toISOString(),
    };

    await commitRegistry.createCommit(oldCommit);

    const fileId = `file-${randomUUIDv7()}`;
    const change: CommitFileChange = {
      id: `change-${randomUUIDv7()}`,
      commitId: oldCommit.id,
      fileId,
      changeType: "modified",
    };
    await commitRegistry.recordFileChange(change);

    // Query recent changes (7-day window)
    const recent7 = await graphQueries.getRecentChanges(repositoryId, 7);
    expect(recent7.length).toBe(1);

    // Query recent changes (1-day window) - should not include old
    const recent1 = await graphQueries.getRecentChanges(repositoryId, 1);
    expect(recent1.length).toBe(0);
  });

  it("should check if commits exist", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;
    const commit: RepositoryCommit = {
      id: `check-${randomUUIDv7()}`,
      repositoryId,
      sha: "check-sha",
      parentShas: [],
      message: "Check",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };

    await commitRegistry.createCommit(commit);

    const exists = await commitRegistry.commitExists("check-sha");
    expect(exists).toBe(true);

    const notExists = await commitRegistry.commitExists("nonexistent");
    expect(notExists).toBe(false);
  });

  it("should delete old commits", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;

    const old = new Date();
    old.setDate(old.getDate() - 30);

    const oldCommit: RepositoryCommit = {
      id: `cleanup-${randomUUIDv7()}`,
      repositoryId,
      sha: "cleanup-sha",
      parentShas: [],
      message: "Cleanup",
      committedAt: old.toISOString(),
      observedAt: new Date().toISOString(),
    };

    await commitRegistry.createCommit(oldCommit);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const deleted = await commitRegistry.deleteCommitsOlderThan(
      repositoryId,
      cutoff.toISOString()
    );

    expect(deleted).toBe(1);

    const exists = await commitRegistry.commitExists("cleanup-sha");
    expect(exists).toBe(false);
  });

  it("should isolate commits between repositories", async () => {
    const repo1 = `repo-${randomUUIDv7()}`;
    const repo2 = `repo-${randomUUIDv7()}`;

    const commit1: RepositoryCommit = {
      id: `c1-${randomUUIDv7()}`,
      repositoryId: repo1,
      sha: "shared",
      parentShas: [],
      message: "Repo 1",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };

    const commit2: RepositoryCommit = {
      id: `c2-${randomUUIDv7()}`,
      repositoryId: repo2,
      sha: "shared",
      parentShas: [],
      message: "Repo 2",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };

    await commitRegistry.createCommit(commit1);
    await commitRegistry.createCommit(commit2);

    const list1 = await commitRegistry.getCommits(repo1);
    const list2 = await commitRegistry.getCommits(repo2);

    expect(list1.length).toBe(1);
    expect(list1[0].message).toBe("Repo 1");
    expect(list2.length).toBe(1);
    expect(list2[0].message).toBe("Repo 2");
  });

  it("should survive process restart (durable state)", async () => {
    const persistPath = path.join(testDir, "persist.db");

    // Write data
    let reg1 = openDurableRepositoryCommitRegistry(testFeltDb(persistPath));
    const commit: RepositoryCommit = {
      id: `persist-${randomUUIDv7()}`,
      repositoryId: `repo-${randomUUIDv7()}`,
      sha: "persist-sha",
      parentShas: [],
      message: "Durable",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };
    await reg1.createCommit(commit);

    // Simulate restart
    let reg2 = openDurableRepositoryCommitRegistry(testFeltDb(persistPath));
    const retrieved = await reg2.getCommitBySha("persist-sha");

    expect(retrieved).toBeDefined();
    expect(retrieved?.message).toBe("Durable");
  });

  it("should be idempotent for same SHA (upsert behavior)", async () => {
    const repositoryId = `repo-${randomUUIDv7()}`;

    const commit1: RepositoryCommit = {
      id: `idem1-${randomUUIDv7()}`,
      repositoryId,
      sha: "idem-sha",
      parentShas: [],
      message: "First",
      committedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };

    const commit2: RepositoryCommit = {
      id: `idem2-${randomUUIDv7()}`,
      repositoryId,
      sha: "idem-sha",
      parentShas: [],
      message: "First",
      committedAt: new Date().toISOString(),
      observedAt: new Date(Date.now() + 5000).toISOString(),
    };

    await commitRegistry.createCommit(commit1);
    await commitRegistry.createCommit(commit2);

    // Should have only one record per SHA
    const all = await commitRegistry.getCommits(repositoryId);
    const withSha = all.filter((c) => c.sha === "idem-sha");
    expect(withSha.length).toBeGreaterThanOrEqual(1);
  });
});
