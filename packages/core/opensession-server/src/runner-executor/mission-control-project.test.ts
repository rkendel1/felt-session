/**
 * Tests for Project and Repository registries.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  openDurableProjectRegistry,
  createStandardProject,
} from "./durable-project-registry";
import {
  openDurableRepositoryRegistry,
  createStandardRepository,
} from "./durable-repository-registry";
import type { MissionControlProject } from "./mission-control-project";
import type { MissionControlRepository } from "./mission-control-repository";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";

let testDir: string;
let projectRegistryPath: string;
let repositoryRegistryPath: string;
let db: StateFirstDB;
let testCounter = 0;

beforeEach(() => {
  testDir = `/tmp/mission-control-test-${Date.now()}`;
  projectRegistryPath = path.join(testDir, "projects");
  repositoryRegistryPath = path.join(testDir, "repositories");
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(projectRegistryPath, { recursive: true });
  fs.mkdirSync(repositoryRegistryPath, { recursive: true });
  db = createFeltDB({
    namespace: `mission-control-project-test-${testCounter++}`,
    memory: true,
  });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe("DurableProjectRegistry", () => {
  it("should create and retrieve a project", async () => {
    const registry = openDurableProjectRegistry(db);

    const project = createStandardProject(
      "proj-1",
      "My Project",
      "my-project",
      {
        provider: "github",
        owner: "myorg",
        repo: "myrepo",
        defaultBranch: "main",
        remoteUrl: "https://github.com/myorg/myrepo.git",
      },
      {
        rootPath: "/home/user/projects/myrepo",
        worktreeStrategy: "nested",
      },
      {
        workspaceId: "W123",
        generalChannelId: "C123",
      },
    );

    await registry.createProject(project);
    const retrieved = await registry.getProject("proj-1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("My Project");
    expect(retrieved?.slug).toBe("my-project");
    expect(retrieved?.repository.owner).toBe("myorg");
  });

  it("should retrieve project by slug", async () => {
    const registry = openDurableProjectRegistry(db);

    const project = createStandardProject(
      "proj-2",
      "Another Project",
      "another-project",
      {
        provider: "github",
        owner: "org2",
        repo: "repo2",
        defaultBranch: "main",
        remoteUrl: "https://github.com/org2/repo2.git",
      },
      {
        rootPath: "/home/user/projects/repo2",
        worktreeStrategy: "sibling",
      },
      {
        workspaceId: "W456",
        generalChannelId: "C456",
      },
    );

    await registry.createProject(project);
    const retrieved = await registry.getProjectBySlug("another-project");

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("proj-2");
  });

  it("should list all projects", async () => {
    const registry = openDurableProjectRegistry(db);

    const proj1 = createStandardProject(
      "proj-1",
      "Project 1",
      "project-1",
      {
        provider: "github",
        owner: "org1",
        repo: "repo1",
        defaultBranch: "main",
        remoteUrl: "https://github.com/org1/repo1.git",
      },
      { rootPath: "/path1", worktreeStrategy: "nested" },
      { workspaceId: "W1", generalChannelId: "C1" },
    );

    const proj2 = createStandardProject(
      "proj-2",
      "Project 2",
      "project-2",
      {
        provider: "github",
        owner: "org2",
        repo: "repo2",
        defaultBranch: "main",
        remoteUrl: "https://github.com/org2/repo2.git",
      },
      { rootPath: "/path2", worktreeStrategy: "sibling" },
      { workspaceId: "W2", generalChannelId: "C2" },
    );

    await registry.createProject(proj1);
    await registry.createProject(proj2);

    const all = await registry.listProjects();
    expect(all.length).toBe(2);
    expect(all.map((p) => p.id).sort()).toEqual(["proj-1", "proj-2"]);
  });

  it("should update a project", async () => {
    const registry = openDurableProjectRegistry(db);

    let project = createStandardProject(
      "proj-1",
      "Original Name",
      "original-slug",
      {
        provider: "github",
        owner: "org",
        repo: "repo",
        defaultBranch: "main",
        remoteUrl: "https://github.com/org/repo.git",
      },
      { rootPath: "/path", worktreeStrategy: "nested" },
      { workspaceId: "W", generalChannelId: "C" },
    );

    await registry.createProject(project);

    project.name = "Updated Name";
    project.description = "New description";
    project.updatedAt = new Date().toISOString();

    await registry.updateProject(project);
    const updated = await registry.getProject("proj-1");

    expect(updated?.name).toBe("Updated Name");
    expect(updated?.description).toBe("New description");
  });

  it("should delete a project", async () => {
    const registry = openDurableProjectRegistry(db);

    const project = createStandardProject(
      "proj-1",
      "To Delete",
      "to-delete",
      {
        provider: "github",
        owner: "org",
        repo: "repo",
        defaultBranch: "main",
        remoteUrl: "https://github.com/org/repo.git",
      },
      { rootPath: "/path", worktreeStrategy: "nested" },
      { workspaceId: "W", generalChannelId: "C" },
    );

    await registry.createProject(project);
    await registry.deleteProject("proj-1");

    const retrieved = await registry.getProject("proj-1");
    expect(retrieved).toBeNull();
  });

  it("should create or return general project", async () => {
    const registry = openDurableProjectRegistry(db);

    const general1 = await registry.getOrCreateGeneralProject(
      "W123",
      "C123",
    );
    expect(general1.id).toBe("workspace-W123");
    expect(general1.slug).toBe("mission-control");

    // Calling again should return the same project
    const general2 = await registry.getOrCreateGeneralProject(
      "W123",
      "C123",
    );
    expect(general2.id).toBe("workspace-W123");

    // Different workspace should create different project
    const general3 = await registry.getOrCreateGeneralProject(
      "W456",
      "C456",
    );
    expect(general3.id).toBe("workspace-W456");
  });
});

describe("DurableRepositoryRegistry", () => {
  it("should create and retrieve a repository", async () => {
    const registry = openDurableRepositoryRegistry(db);

    const repo = createStandardRepository(
      "repo-1",
      "proj-1",
      "My Repo",
      "myorg",
      "myrepo",
      "https://github.com/myorg/myrepo.git",
      "main",
    );

    await registry.createRepository(repo);
    const retrieved = await registry.getRepository("repo-1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("My Repo");
    expect(retrieved?.projectId).toBe("proj-1");
  });

  it("should list repositories by project", async () => {
    const registry = openDurableRepositoryRegistry(db);

    const repo1 = createStandardRepository(
      "repo-1",
      "proj-1",
      "Repo 1",
      "org",
      "repo1",
      "https://github.com/org/repo1.git",
      "main",
    );

    const repo2 = createStandardRepository(
      "repo-2",
      "proj-1",
      "Repo 2",
      "org",
      "repo2",
      "https://github.com/org/repo2.git",
      "main",
    );

    const repo3 = createStandardRepository(
      "repo-3",
      "proj-2",
      "Repo 3",
      "org",
      "repo3",
      "https://github.com/org/repo3.git",
      "main",
    );

    await registry.createRepository(repo1);
    await registry.createRepository(repo2);
    await registry.createRepository(repo3);

    const proj1Repos = await registry.listRepositoriesByProject("proj-1");
    expect(proj1Repos.length).toBe(2);
    expect(proj1Repos.map((r) => r.id).sort()).toEqual(["repo-1", "repo-2"]);

    const proj2Repos = await registry.listRepositoriesByProject("proj-2");
    expect(proj2Repos.length).toBe(1);
  });

  it("should record sync success", async () => {
    const registry = openDurableRepositoryRegistry(db);

    const repo = createStandardRepository(
      "repo-1",
      "proj-1",
      "My Repo",
      "org",
      "repo",
      "https://github.com/org/repo.git",
      "main",
    );

    await registry.createRepository(repo);
    const before = new Date();

    await registry.recordSync("repo-1");

    const updated = await registry.getRepository("repo-1");
    expect(updated?.lastSyncAt).toBeDefined();
    expect(updated?.syncError).toBeUndefined();
    expect(new Date(updated?.lastSyncAt || "") >= before).toBe(true);
  });

  it("should record sync error", async () => {
    const registry = openDurableRepositoryRegistry(db);

    const repo = createStandardRepository(
      "repo-1",
      "proj-1",
      "My Repo",
      "org",
      "repo",
      "https://github.com/org/repo.git",
      "main",
    );

    await registry.createRepository(repo);

    await registry.recordSyncError("repo-1", "Authentication failed");

    const updated = await registry.getRepository("repo-1");
    expect(updated?.syncError).toBe("Authentication failed");
    expect(updated?.status).toBe("error");
  });

  it("should list all repositories", async () => {
    const registry = openDurableRepositoryRegistry(db);

    const repo1 = createStandardRepository(
      "repo-1",
      "proj-1",
      "Repo 1",
      "org",
      "repo1",
      "https://github.com/org/repo1.git",
      "main",
    );

    const repo2 = createStandardRepository(
      "repo-2",
      "proj-2",
      "Repo 2",
      "org",
      "repo2",
      "https://github.com/org/repo2.git",
      "main",
    );

    await registry.createRepository(repo1);
    await registry.createRepository(repo2);

    const all = await registry.listRepositories();
    expect(all.length).toBe(2);
  });

  it("should delete a repository", async () => {
    const registry = openDurableRepositoryRegistry(db);

    const repo = createStandardRepository(
      "repo-1",
      "proj-1",
      "To Delete",
      "org",
      "repo",
      "https://github.com/org/repo.git",
      "main",
    );

    await registry.createRepository(repo);
    await registry.deleteRepository("repo-1");

    const retrieved = await registry.getRepository("repo-1");
    expect(retrieved).toBeNull();
  });
});
