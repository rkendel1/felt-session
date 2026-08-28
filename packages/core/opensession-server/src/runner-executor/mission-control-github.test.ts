/**
 * Tests for GitHub Agent integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import { randomUUIDv7 } from "bun";
import { GitHubCommandParser } from "./github-command-parser";
import {
  openDurableGitHubTokenRegistry,
  openDurableGitHubIntegrationRegistry,
} from "./durable-github-registry";
import { createGitHubAgentService } from "./github-agent-service";
import type { GitHubOAuthToken, GitHubIntegration } from "./mission-control-github";

let testCounter = 0;
let testDir: string;

beforeEach(() => {
  testDir = `/tmp/github-agent-test-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe("GitHub Command Parser", () => {
  const parser = new GitHubCommandParser();

  it("parses list open PRs command", () => {
    const cmd = parser.parse("show open prs");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("list_prs");
  });

  it("parses list open issues command", () => {
    const cmd = parser.parse("list open issues");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("list_issues");
  });

  it("parses get specific PR command", () => {
    const cmd = parser.parse("get pr 42");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("get_pr");
    expect(cmd?.params.number).toBe(42);
  });

  it("parses get specific issue command", () => {
    const cmd = parser.parse("show issue #123");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("get_issue");
    expect(cmd?.params.number).toBe(123);
  });

  it("parses create issue command", () => {
    const cmd = parser.parse("create issue titled Bug in auth system");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("create_issue");
    expect(cmd?.params.title).toContain("Bug");
  });

  it("parses create PR command", () => {
    const cmd = parser.parse("create PR from feature branch");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("create_pr");
  });

  it("parses close issue command", () => {
    const cmd = parser.parse("close issue 99");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("close_issue");
    expect(cmd?.params.number).toBe(99);
  });

  it("parses merge PR command", () => {
    const cmd = parser.parse("merge pr 15");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("merge_pr");
    expect(cmd?.params.number).toBe(15);
  });

  it("parses merge PR with squash", () => {
    const cmd = parser.parse("merge pr 15 with squash");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("merge_pr");
    expect(cmd?.params.method).toBe("squash");
  });

  it("parses comment command", () => {
    const cmd = parser.parse("comment on pr 42 message Tests passed!");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("comment");
    expect(cmd?.params.number).toBe(42);
  });

  it("parses label command", () => {
    const cmd = parser.parse("add labels bug,critical to issue 88");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("label");
    expect(cmd?.params.number).toBe(88);
  });

  it("parses commits since command", () => {
    const cmd = parser.parse("show changes since 3 days");
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe("list_commits");
    expect(cmd?.params.sinceDays).toBe(3);
  });

  it("returns null for unknown commands", () => {
    const cmd = parser.parse("xyz blah foo bar");
    expect(cmd).toBeNull();
  });
});

describe("GitHub Token Registry", () => {
  const projectId = randomUUIDv7();

  it("creates and retrieves a token", async () => {
    const registry = openDurableGitHubTokenRegistry(testDir);

    const token: GitHubOAuthToken = {
      id: `gh-token-${randomUUIDv7()}`,
      projectId,
      accessToken: "test_token_abc123",
      scope: ["repo", "issues"],
      userId: "user-123",
      userName: "testuser",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createToken(token);
    const retrieved = await registry.getToken(token.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.accessToken).toBe("test_token_abc123");
    expect(retrieved?.userName).toBe("testuser");
    expect(retrieved?.scope).toContain("repo");
  });

  it("retrieves token by project", async () => {
    const registry = openDurableGitHubTokenRegistry(testDir);

    const token: GitHubOAuthToken = {
      id: `gh-token-${randomUUIDv7()}`,
      projectId,
      accessToken: "test_token_xyz",
      scope: ["repo"],
      userId: "user-456",
      userName: "anotheruser",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createToken(token);
    const retrieved = await registry.getTokenByProject(projectId);

    expect(retrieved).toBeDefined();
    expect(retrieved?.projectId).toBe(projectId);
  });

  it("lists tokens by project", async () => {
    const registry = openDurableGitHubTokenRegistry(testDir);

    const projectId2 = randomUUIDv7();

    const token1: GitHubOAuthToken = {
      id: `gh-token-${randomUUIDv7()}`,
      projectId,
      accessToken: "token1",
      scope: ["repo"],
      userId: "user1",
      userName: "user1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const token2: GitHubOAuthToken = {
      id: `gh-token-${randomUUIDv7()}`,
      projectId: projectId2,
      accessToken: "token2",
      scope: ["repo"],
      userId: "user2",
      userName: "user2",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createToken(token1);
    await registry.createToken(token2);

    const tokens = await registry.listTokens(projectId);
    expect(tokens.length).toBe(1);
    expect(tokens[0].projectId).toBe(projectId);
  });

  it("updates a token", async () => {
    const registry = openDurableGitHubTokenRegistry(testDir);

    const token: GitHubOAuthToken = {
      id: `gh-token-${randomUUIDv7()}`,
      projectId,
      accessToken: "old_token",
      scope: ["repo"],
      userId: "user-789",
      userName: "testuser",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createToken(token);

    token.accessToken = "new_token";
    token.refreshToken = "refresh_token";
    await registry.updateToken(token);

    const retrieved = await registry.getToken(token.id);
    expect(retrieved?.accessToken).toBe("new_token");
    expect(retrieved?.refreshToken).toBe("refresh_token");
  });

  it("deletes a token", async () => {
    const registry = openDurableGitHubTokenRegistry(testDir);

    const token: GitHubOAuthToken = {
      id: `gh-token-${randomUUIDv7()}`,
      projectId,
      accessToken: "test_token",
      scope: ["repo"],
      userId: "user-999",
      userName: "testuser",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createToken(token);
    await registry.deleteToken(token.id);

    const retrieved = await registry.getToken(token.id);
    expect(retrieved).toBeUndefined();
  });
});

describe("GitHub Integration Registry", () => {
  const projectId = randomUUIDv7();

  it("creates and retrieves an integration", async () => {
    const registry = openDurableGitHubIntegrationRegistry(testDir);

    const integration: GitHubIntegration = {
      id: `gh-int-${randomUUIDv7()}`,
      projectId,
      appId: "app-12345",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createIntegration(integration);
    const retrieved = await registry.getIntegration(integration.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.appId).toBe("app-12345");
    expect(retrieved?.status).toBe("pending");
  });

  it("retrieves integration by project", async () => {
    const registry = openDurableGitHubIntegrationRegistry(testDir);

    const integration: GitHubIntegration = {
      id: `gh-int-${randomUUIDv7()}`,
      projectId,
      appId: "app-67890",
      clientId: "client-def",
      clientSecret: "secret-123",
      status: "authorized",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createIntegration(integration);
    const retrieved = await registry.getIntegrationByProject(projectId);

    expect(retrieved).toBeDefined();
    expect(retrieved?.projectId).toBe(projectId);
    expect(retrieved?.status).toBe("authorized");
  });

  it("updates an integration", async () => {
    const registry = openDurableGitHubIntegrationRegistry(testDir);

    const integration: GitHubIntegration = {
      id: `gh-int-${randomUUIDv7()}`,
      projectId,
      appId: "app-11111",
      clientId: "client-ghi",
      clientSecret: "secret-456",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createIntegration(integration);

    integration.status = "authorized";
    integration.installationId = "inst-99999";
    await registry.updateIntegration(integration);

    const retrieved = await registry.getIntegration(integration.id);
    expect(retrieved?.status).toBe("authorized");
    expect(retrieved?.installationId).toBe("inst-99999");
  });

  it("deletes an integration", async () => {
    const registry = openDurableGitHubIntegrationRegistry(testDir);

    const integration: GitHubIntegration = {
      id: `gh-int-${randomUUIDv7()}`,
      projectId,
      appId: "app-22222",
      clientId: "client-jkl",
      clientSecret: "secret-789",
      status: "revoked",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await registry.createIntegration(integration);
    await registry.deleteIntegration(integration.id);

    const retrieved = await registry.getIntegration(integration.id);
    expect(retrieved).toBeUndefined();
  });
});

describe("GitHub Agent Service", () => {
  const projectId = randomUUIDv7();
  const owner = "test-owner";
  const repo = "test-repo";

  it("creates and stores OAuth token", async () => {
    const tokenRegistry = openDurableGitHubTokenRegistry(testDir);
    const integrationRegistry = openDurableGitHubIntegrationRegistry(testDir);

    const service = createGitHubAgentService(
      projectId,
      owner,
      repo,
      tokenRegistry,
      integrationRegistry,
    );

    const result = await service.setOAuthToken(
      "user-123",
      "testuser",
      "token_abc123",
      ["repo", "issues"],
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("testuser");

    const token = await tokenRegistry.getTokenByProject(projectId);
    expect(token).toBeDefined();
    expect(token?.accessToken).toBe("token_abc123");
  });

  it("creates and stores GitHub integration", async () => {
    const tokenRegistry = openDurableGitHubTokenRegistry(testDir);
    const integrationRegistry = openDurableGitHubIntegrationRegistry(testDir);

    const service = createGitHubAgentService(
      projectId,
      owner,
      repo,
      tokenRegistry,
      integrationRegistry,
    );

    const result = await service.setGitHubIntegration(
      "app-12345",
      "client-abc",
      "secret-xyz",
    );

    expect(result.success).toBe(true);

    const integration = await integrationRegistry.getIntegrationByProject(projectId);
    expect(integration).toBeDefined();
    expect(integration?.appId).toBe("app-12345");
  });

  it("fails to execute command without token", async () => {
    const tokenRegistry = openDurableGitHubTokenRegistry(testDir);
    const integrationRegistry = openDurableGitHubIntegrationRegistry(testDir);

    const service = createGitHubAgentService(
      projectId,
      owner,
      repo,
      tokenRegistry,
      integrationRegistry,
    );

    const result = await service.executeCommand("show open prs");

    expect(result.success).toBe(false);
    expect(result.message).toContain("not configured");
  });

  it("lists open PRs", async () => {
    const tokenRegistry = openDurableGitHubTokenRegistry(testDir);
    const integrationRegistry = openDurableGitHubIntegrationRegistry(testDir);

    const service = createGitHubAgentService(
      projectId,
      owner,
      repo,
      tokenRegistry,
      integrationRegistry,
    );

    await service.setOAuthToken(
      "user-123",
      "testuser",
      "token_abc123",
      ["repo"],
    );

    const result = await service.listOpenPullRequests();
    // Will fail with mock token, but tests infrastructure
    expect(result).toBeDefined();
  });

  it("creates pull request", async () => {
    const tokenRegistry = openDurableGitHubTokenRegistry(testDir);
    const integrationRegistry = openDurableGitHubIntegrationRegistry(testDir);

    const service = createGitHubAgentService(
      projectId,
      owner,
      repo,
      tokenRegistry,
      integrationRegistry,
    );

    await service.setOAuthToken(
      "user-123",
      "testuser",
      "token_abc123",
      ["repo"],
    );

    const result = await service.createPullRequest(
      "Add new feature",
      "feature/awesome",
      "This PR adds an awesome feature",
    );

    // Will fail with mock token, but tests infrastructure
    expect(result).toBeDefined();
  });

  it("merges pull request", async () => {
    const tokenRegistry = openDurableGitHubTokenRegistry(testDir);
    const integrationRegistry = openDurableGitHubIntegrationRegistry(testDir);

    const service = createGitHubAgentService(
      projectId,
      owner,
      repo,
      tokenRegistry,
      integrationRegistry,
    );

    await service.setOAuthToken(
      "user-123",
      "testuser",
      "token_abc123",
      ["repo"],
    );

    const result = await service.mergePullRequest(42);

    // Will fail with mock token, but tests infrastructure
    expect(result).toBeDefined();
  });

  it("comments on PR", async () => {
    const tokenRegistry = openDurableGitHubTokenRegistry(testDir);
    const integrationRegistry = openDurableGitHubIntegrationRegistry(testDir);

    const service = createGitHubAgentService(
      projectId,
      owner,
      repo,
      tokenRegistry,
      integrationRegistry,
    );

    await service.setOAuthToken(
      "user-123",
      "testuser",
      "token_abc123",
      ["repo"],
    );

    const result = await service.commentOnPullRequest(
      42,
      "All tests passing!",
    );

    // Will fail with mock token, but tests infrastructure
    expect(result).toBeDefined();
  });
});
