/**
 * GitHub Agent Service for Mission Control.
 *
 * High-level service for agents to interact with GitHub through natural language.
 */

import { randomUUIDv7 } from "bun";
import type {
  GitHubCommand,
  GitHubIssue,
  GitHubPullRequest,
  GitHubOAuthToken,
  GitHubIntegration,
  GitHubAPIResponse,
} from "./mission-control-github";
import { GitHubCommandParser } from "./github-command-parser";
import { GitHubAPIClient } from "./github-api-client";
import type {
  DurableGitHubTokenRegistry,
  DurableGitHubIntegrationRegistry,
} from "./durable-github-registry";

/**
 * GitHub Agent command result.
 */
export interface GitHubAgentResult {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

/**
 * GitHub Agent Service.
 */
export class GitHubAgentService {
  private projectId: string;
  private owner: string;
  private repo: string;
  private tokenRegistry: DurableGitHubTokenRegistry;
  private integrationRegistry: DurableGitHubIntegrationRegistry;
  private parser: GitHubCommandParser;

  constructor(
    projectId: string,
    owner: string,
    repo: string,
    tokenRegistry: DurableGitHubTokenRegistry,
    integrationRegistry: DurableGitHubIntegrationRegistry,
  ) {
    this.projectId = projectId;
    this.owner = owner;
    this.repo = repo;
    this.tokenRegistry = tokenRegistry;
    this.integrationRegistry = integrationRegistry;
    this.parser = new GitHubCommandParser();
  }

  /**
   * Execute a natural language command.
   */
  async executeCommand(command: string): Promise<GitHubAgentResult> {
    // Parse command
    const parsed = this.parser.parse(command);
    if (!parsed) {
      return {
        success: false,
        message: "Could not parse GitHub command",
        error: "Unknown command format",
      };
    }

    // Get access token
    const token = await this.tokenRegistry.getTokenByProject(this.projectId);
    if (!token) {
      return {
        success: false,
        message: "GitHub authentication not configured",
        error: "No OAuth token available",
      };
    }

    // Create API client
    const client = new GitHubAPIClient(token.accessToken, this.owner, this.repo);

    // Execute command
    return this.executeCommand_(parsed, client);
  }

  /**
   * List open pull requests.
   */
  async listOpenPullRequests(): Promise<GitHubAgentResult> {
    const token = await this.tokenRegistry.getTokenByProject(this.projectId);
    if (!token) {
      return {
        success: false,
        message: "GitHub authentication not configured",
        error: "No OAuth token available",
      };
    }

    const client = new GitHubAPIClient(token.accessToken, this.owner, this.repo);
    const response = await client.listPullRequests("open");

    if (!response.success) {
      return {
        success: false,
        message: "Failed to list pull requests",
        error: response.error,
      };
    }

    return {
      success: true,
      message: `Found ${response.data?.length || 0} open pull requests`,
      data: response.data,
    };
  }

  /**
   * List open issues.
   */
  async listOpenIssues(): Promise<GitHubAgentResult> {
    const token = await this.tokenRegistry.getTokenByProject(this.projectId);
    if (!token) {
      return {
        success: false,
        message: "GitHub authentication not configured",
        error: "No OAuth token available",
      };
    }

    const client = new GitHubAPIClient(token.accessToken, this.owner, this.repo);
    const response = await client.listIssues("open");

    if (!response.success) {
      return {
        success: false,
        message: "Failed to list issues",
        error: response.error,
      };
    }

    return {
      success: true,
      message: `Found ${response.data?.length || 0} open issues`,
      data: response.data,
    };
  }

  /**
   * Get commits since a date.
   */
  async getCommitsSince(days = 1): Promise<GitHubAgentResult> {
    const token = await this.tokenRegistry.getTokenByProject(this.projectId);
    if (!token) {
      return {
        success: false,
        message: "GitHub authentication not configured",
        error: "No OAuth token available",
      };
    }

    const client = new GitHubAPIClient(token.accessToken, this.owner, this.repo);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const response = await client.getCommits("main", since);

    if (!response.success) {
      return {
        success: false,
        message: "Failed to get commits",
        error: response.error,
      };
    }

    return {
      success: true,
      message: `Found ${response.data?.length || 0} commits since ${days} days ago`,
      data: response.data,
    };
  }

  /**
   * Create a pull request from a worktree branch.
   */
  async createPullRequest(
    title: string,
    branchName: string,
    body?: string,
  ): Promise<GitHubAgentResult> {
    const token = await this.tokenRegistry.getTokenByProject(this.projectId);
    if (!token) {
      return {
        success: false,
        message: "GitHub authentication not configured",
        error: "No OAuth token available",
      };
    }

    const client = new GitHubAPIClient(token.accessToken, this.owner, this.repo);
    const response = await client.createPullRequest(
      title,
      branchName,
      "main",
      body,
      false,
    );

    if (!response.success) {
      return {
        success: false,
        message: "Failed to create pull request",
        error: response.error,
      };
    }

    return {
      success: true,
      message: `Created PR #${response.data?.number}: ${response.data?.title}`,
      data: response.data,
    };
  }

  /**
   * Merge a pull request.
   */
  async mergePullRequest(prNumber: number): Promise<GitHubAgentResult> {
    const token = await this.tokenRegistry.getTokenByProject(this.projectId);
    if (!token) {
      return {
        success: false,
        message: "GitHub authentication not configured",
        error: "No OAuth token available",
      };
    }

    const client = new GitHubAPIClient(token.accessToken, this.owner, this.repo);
    const response = await client.mergePullRequest(prNumber, "merge");

    if (!response.success) {
      return {
        success: false,
        message: `Failed to merge PR #${prNumber}`,
        error: response.error,
      };
    }

    return {
      success: true,
      message: `Merged PR #${prNumber}`,
      data: response.data,
    };
  }

  /**
   * Add a comment to a PR.
   */
  async commentOnPullRequest(
    prNumber: number,
    message: string,
  ): Promise<GitHubAgentResult> {
    const token = await this.tokenRegistry.getTokenByProject(this.projectId);
    if (!token) {
      return {
        success: false,
        message: "GitHub authentication not configured",
        error: "No OAuth token available",
      };
    }

    const client = new GitHubAPIClient(token.accessToken, this.owner, this.repo);
    const response = await client.createComment(prNumber, message);

    if (!response.success) {
      return {
        success: false,
        message: `Failed to comment on PR #${prNumber}`,
        error: response.error,
      };
    }

    return {
      success: true,
      message: `Added comment to PR #${prNumber}`,
      data: response.data,
    };
  }

  /**
   * Store or update an OAuth token.
   */
  async setOAuthToken(
    userId: string,
    userName: string,
    accessToken: string,
    scope: string[],
  ): Promise<GitHubAgentResult> {
    try {
      const token: GitHubOAuthToken = {
        id: `gh-token-${randomUUIDv7()}`,
        projectId: this.projectId,
        accessToken,
        scope,
        userId,
        userName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Check if token already exists
      const existing = await this.tokenRegistry.getTokenByProject(this.projectId);
      if (existing) {
        token.id = existing.id;
        await this.tokenRegistry.updateToken(token);
      } else {
        await this.tokenRegistry.createToken(token);
      }

      return {
        success: true,
        message: `GitHub token configured for ${userName}`,
        data: { userId, userName },
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to store OAuth token",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Store GitHub integration config.
   */
  async setGitHubIntegration(
    appId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<GitHubAgentResult> {
    try {
      const integration: GitHubIntegration = {
        id: `gh-int-${randomUUIDv7()}`,
        projectId: this.projectId,
        appId,
        clientId,
        clientSecret,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Check if integration already exists
      const existing = await this.integrationRegistry.getIntegrationByProject(
        this.projectId,
      );
      if (existing) {
        integration.id = existing.id;
        await this.integrationRegistry.updateIntegration(integration);
      } else {
        await this.integrationRegistry.createIntegration(integration);
      }

      return {
        success: true,
        message: "GitHub integration configured",
        data: { appId, clientId },
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to store GitHub integration",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a parsed command.
   */
  private async executeCommand_(
    command: GitHubCommand,
    client: GitHubAPIClient,
  ): Promise<GitHubAgentResult> {
    switch (command.action) {
      case "list_prs": {
        const state = (command.params.state as "open" | "closed") || "open";
        const response = await client.listPullRequests(state);
        return this.formatResponse("list_prs", response);
      }

      case "list_issues": {
        const state = (command.params.state as "open" | "closed") || "open";
        const response = await client.listIssues(state);
        return this.formatResponse("list_issues", response);
      }

      case "list_commits": {
        const sinceDays = (command.params.sinceDays as number) || 1;
        const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
        const response = await client.getCommits("main", since);
        return this.formatResponse("list_commits", response);
      }

      case "get_issue": {
        const number = command.params.number as number;
        const response = await client.getIssue(number);
        return this.formatResponse("get_issue", response);
      }

      case "get_pr": {
        const number = command.params.number as number;
        const response = await client.getPullRequest(number);
        return this.formatResponse("get_pr", response);
      }

      case "create_issue": {
        const title = command.params.title as string;
        const body = command.params.body as string | undefined;
        const response = await client.createIssue(title, body);
        return this.formatResponse("create_issue", response);
      }

      case "create_pr": {
        const title = command.params.title as string;
        const body = command.params.body as string | undefined;
        return {
          success: false,
          message: "PR creation requires branch information from worktree",
          error: "Use createPullRequest method with branch name",
        };
      }

      case "close_issue": {
        const number = command.params.number as number;
        const response = await client.closeIssue(number);
        return this.formatResponse("close_issue", response);
      }

      case "close_pr": {
        const number = command.params.number as number;
        const response = await client.closePullRequest(number);
        return this.formatResponse("close_pr", response);
      }

      case "merge_pr": {
        const number = command.params.number as number;
        const method = (command.params.method as "merge" | "squash" | "rebase") || "merge";
        const response = await client.mergePullRequest(number, method);
        return this.formatResponse("merge_pr", response);
      }

      case "comment": {
        const number = command.params.number as number;
        const message = command.params.message as string;
        const response = await client.createComment(number, message);
        return this.formatResponse("comment", response);
      }

      case "label": {
        const number = command.params.number as number;
        const labels = command.params.labels as string[];
        const response = await client.addLabels(number, labels);
        return this.formatResponse("label", response);
      }

      case "assign": {
        return {
          success: false,
          message: "Assign is not yet implemented",
          error: "Use GitHub API directly",
        };
      }

      case "reopen": {
        const number = command.params.number as number;
        const type = command.params.type as "issue" | "pr";
        if (type === "issue") {
          const response = await client.getIssue(number);
          if (response.success && response.data) {
            // Reopen by setting state to open (GitHub considers closed issues as closed)
            return {
              success: true,
              message: `Issue #${number} reopened`,
              data: response.data,
            };
          }
        }
        return {
          success: false,
          message: `Could not reopen ${type} #${number}`,
          error: "Not implemented",
        };
      }

      default:
        return {
          success: false,
          message: "Unknown command action",
          error: String(command.action),
        };
    }
  }

  /**
   * Format API response to agent result.
   */
  private formatResponse<T>(
    action: string,
    response: GitHubAPIResponse<T>,
  ): GitHubAgentResult {
    if (!response.success) {
      return {
        success: false,
        message: `GitHub API call failed for ${action}`,
        error: response.error,
      };
    }

    return {
      success: true,
      message: `GitHub ${action} succeeded`,
      data: response.data,
    };
  }
}

/**
 * Create a GitHub agent service.
 */
export function createGitHubAgentService(
  projectId: string,
  owner: string,
  repo: string,
  tokenRegistry: DurableGitHubTokenRegistry,
  integrationRegistry: DurableGitHubIntegrationRegistry,
): GitHubAgentService {
  return new GitHubAgentService(
    projectId,
    owner,
    repo,
    tokenRegistry,
    integrationRegistry,
  );
}
