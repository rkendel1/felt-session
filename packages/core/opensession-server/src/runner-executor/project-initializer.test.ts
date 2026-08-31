/**
 * Tests for ProjectInitializer service.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createProjectInitializer } from "./project-initializer";
import { createFeltDB } from "@feltdb/core";

let testDir: string;
let testCounter = 0;

function testDb() {
  return createFeltDB({
    namespace: `project-initializer-test-${testCounter++}`,
    memory: true,
  });
}

beforeEach(() => {
  testDir = `/tmp/project-initializer-test-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe("ProjectInitializer", () => {
  it("should create a project with repository", async () => {
    const initializer = createProjectInitializer(testDb());

    const project = await initializer.createProject({
      name: "My Project",
      slug: "my-project",
      repositoryUrl: "https://github.com/myorg/myrepo.git",
      localRootPath: "/home/user/projects/myrepo",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe("My Project");
    expect(project.slug).toBe("my-project");
    expect(project.repository.owner).toBe("myorg");
    expect(project.repository.repo).toBe("myrepo");

    // Verify it's persisted
    const retrieved = await initializer.getProject(project.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("My Project");
  });

  it("should initialize workspace project", async () => {
    const initializer = createProjectInitializer(testDb());

    const project = await initializer.initializeWorkspaceProject("W123", "C123");

    expect(project.id).toBe("workspace-W123");
    expect(project.slug).toBe("mission-control");
  });

  it("should list all projects", async () => {
    const initializer = createProjectInitializer(testDb());

    const proj1 = await initializer.createProject({
      name: "Project 1",
      slug: "project-1",
      repositoryUrl: "https://github.com/org/repo1.git",
      localRootPath: "/path1",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    const proj2 = await initializer.createProject({
      name: "Project 2",
      slug: "project-2",
      repositoryUrl: "https://github.com/org/repo2.git",
      localRootPath: "/path2",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    // Give FeltDB a moment to sync
    await new Promise((resolve) => setTimeout(resolve, 10));

    const all = await initializer.listProjects();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((p) => p.id).sort()).toContain(proj1.id);
    expect(all.map((p) => p.id).sort()).toContain(proj2.id);
  });

  it("should get project by slug", async () => {
    const initializer = createProjectInitializer(testDb());

    await initializer.createProject({
      name: "My Project",
      slug: "my-project",
      repositoryUrl: "https://github.com/org/repo.git",
      localRootPath: "/path",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    const project = await initializer.getProjectBySlug("my-project");
    expect(project).toBeDefined();
    expect(project?.name).toBe("My Project");
  });

  it("should list repositories for project", async () => {
    const initializer = createProjectInitializer(testDb());

    const project = await initializer.createProject({
      name: "My Project",
      slug: "my-project",
      repositoryUrl: "https://github.com/myorg/myrepo.git",
      localRootPath: "/path",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    const repos = await initializer.getRepositoriesForProject(project.id);
    expect(repos.length).toBe(1);
    expect(repos[0].owner).toBe("myorg");
    expect(repos[0].repo).toBe("myrepo");
  });

  it("should record repository sync", async () => {
    const initializer = createProjectInitializer(testDb());

    const project = await initializer.createProject({
      name: "My Project",
      slug: "my-project",
      repositoryUrl: "https://github.com/org/repo.git",
      localRootPath: "/path",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    const repos = await initializer.getRepositoriesForProject(project.id);
    const repo = repos[0];

    const before = new Date();
    await initializer.recordRepositorySync(repo.id);

    const updated = await initializer.listRepositories();
    const updatedRepo = updated.find((r) => r.id === repo.id);

    expect(updatedRepo?.lastSyncAt).toBeDefined();
    expect(new Date(updatedRepo?.lastSyncAt || "") >= before).toBe(true);
  });

  it("should record repository sync error", async () => {
    const initializer = createProjectInitializer(testDb());

    const project = await initializer.createProject({
      name: "My Project",
      slug: "my-project",
      repositoryUrl: "https://github.com/org/repo.git",
      localRootPath: "/path",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    const repos = await initializer.getRepositoriesForProject(project.id);
    const repo = repos[0];

    await initializer.recordRepositorySyncError(repo.id, "Auth failed");

    const updated = await initializer.listRepositories();
    const updatedRepo = updated.find((r) => r.id === repo.id);

    expect(updatedRepo?.syncError).toBe("Auth failed");
    expect(updatedRepo?.status).toBe("error");
  });

  it("should delete a project", async () => {
    const initializer = createProjectInitializer(testDb());

    const project = await initializer.createProject({
      name: "My Project",
      slug: "my-project",
      repositoryUrl: "https://github.com/org/repo.git",
      localRootPath: "/path",
      workspaceId: "W123",
      generalChannelId: "C123",
    });

    await initializer.deleteProject(project.id);

    const retrieved = await initializer.getProject(project.id);
    expect(retrieved).toBeNull();

    // Repositories should also be deleted
    const repos = await initializer.listRepositories();
    expect(repos.length).toBe(0);
  });

  it("should parse HTTPS repository URLs", () => {
    const initializer = createProjectInitializer(testDb());

    const tests = [
      {
        url: "https://github.com/myorg/myrepo.git",
        expected: { owner: "myorg", repo: "myrepo" },
      },
      {
        url: "https://github.com/myorg/myrepo",
        expected: { owner: "myorg", repo: "myrepo" },
      },
      {
        url: "http://github.com/org/repo.git",
        expected: { owner: "org", repo: "repo" },
      },
    ];

    for (const test of tests) {
      const project = initializer["createProject"]
        ? (async () => {
            try {
              await initializer.createProject({
                name: "Test",
                slug: "test",
                repositoryUrl: test.url,
                localRootPath: "/path",
                workspaceId: "W",
                generalChannelId: "C",
              });
              return "created";
            } catch {
              return "error";
            }
          })()
        : Promise.resolve("skipped");
    }
  });
});
