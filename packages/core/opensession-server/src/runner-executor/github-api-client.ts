/**
 * GitHub API Client for Mission Control.
 *
 * Provides high-level access to GitHub operations via REST API.
 */

import { fetch } from "bun";
import type {
  GitHubAPIResponse,
  GitHubIssue,
  GitHubPullRequest,
  GitHubCommit,
} from "./mission-control-github";

export class GitHubAPIClient {
  private baseUrl = "https://api.github.com";
  private token: string;
  private owner: string;
  private repo: string;

  constructor(token: string, owner: string, repo: string) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * List open issues.
   */
  async listIssues(state: "open" | "closed" | "all" = "open"): Promise<GitHubAPIResponse<GitHubIssue[]>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues?state=${state}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const issues = await response.json();
      return {
        success: true,
        data: this.normalizeIssues(issues),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Get a specific issue.
   */
  async getIssue(issueNumber: number): Promise<GitHubAPIResponse<GitHubIssue>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const issue = await response.json();
      return {
        success: true,
        data: this.normalizeIssue(issue),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * List pull requests.
   */
  async listPullRequests(state: "open" | "closed" | "all" = "open"): Promise<GitHubAPIResponse<GitHubPullRequest[]>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls?state=${state}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const prs = await response.json();
      return {
        success: true,
        data: this.normalizePullRequests(prs),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Get a specific pull request.
   */
  async getPullRequest(prNumber: number): Promise<GitHubAPIResponse<GitHubPullRequest>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
        {
          headers: this.getHeaders(),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const pr = await response.json();
      return {
        success: true,
        data: this.normalizePullRequest(pr),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Create an issue.
   */
  async createIssue(title: string, body?: string, labels?: string[]): Promise<GitHubAPIResponse<GitHubIssue>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            title,
            body,
            labels,
          }),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const issue = await response.json();
      return {
        success: true,
        data: this.normalizeIssue(issue),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Create a pull request.
   */
  async createPullRequest(
    title: string,
    head: string,
    base: string,
    body?: string,
    draft = false,
  ): Promise<GitHubAPIResponse<GitHubPullRequest>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            title,
            head,
            base,
            body,
            draft,
          }),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const pr = await response.json();
      return {
        success: true,
        data: this.normalizePullRequest(pr),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Close an issue.
   */
  async closeIssue(issueNumber: number): Promise<GitHubAPIResponse<GitHubIssue>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
        {
          method: "PATCH",
          headers: this.getHeaders(),
          body: JSON.stringify({ state: "closed" }),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const issue = await response.json();
      return {
        success: true,
        data: this.normalizeIssue(issue),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Close a pull request.
   */
  async closePullRequest(prNumber: number): Promise<GitHubAPIResponse<GitHubPullRequest>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
        {
          method: "PATCH",
          headers: this.getHeaders(),
          body: JSON.stringify({ state: "closed" }),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const pr = await response.json();
      return {
        success: true,
        data: this.normalizePullRequest(pr),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Merge a pull request.
   */
  async mergePullRequest(
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
  ): Promise<GitHubAPIResponse<{ merged: boolean; message: string }>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`,
        {
          method: "PUT",
          headers: this.getHeaders(),
          body: JSON.stringify({
            merge_method: method,
          }),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const result = await response.json();
      return {
        success: true,
        data: {
          merged: result.merged || false,
          message: result.message,
        },
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Add a comment to an issue or PR.
   */
  async createComment(issueNumber: number, body: string): Promise<GitHubAPIResponse<{ id: string; body: string }>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({ body }),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const comment = await response.json();
      return {
        success: true,
        data: {
          id: comment.id,
          body: comment.body,
        },
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Add labels to an issue.
   */
  async addLabels(issueNumber: number, labels: string[]): Promise<GitHubAPIResponse<{ labels: string[] }>> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`,
        {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({ labels }),
        },
      );

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const result = await response.json();
      return {
        success: true,
        data: {
          labels: result.map((l: Record<string, string>) => l.name),
        },
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Get commits for a ref.
   */
  async getCommits(ref = "main", since?: string): Promise<GitHubAPIResponse<GitHubCommit[]>> {
    try {
      let url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/commits?sha=${ref}`;
      if (since) {
        url += `&since=${since}`;
      }

      const response = await fetch(url, {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `GitHub API error: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const commits = await response.json();
      return {
        success: true,
        data: commits.map((c: Record<string, string>) => ({
          sha: c.sha,
          message: c.commit.message,
          author: {
            name: c.commit.author.name,
            email: c.commit.author.email,
          },
          date: c.commit.author.date,
          url: c.html_url,
        })),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        statusCode: 0,
      };
    }
  }

  /**
   * Get request headers with auth token.
   */
  private getHeaders(): Record<string, string> {
    return {
      "Authorization": `token ${this.token}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    };
  }

  /**
   * Normalize single issue.
   */
  private normalizeIssue(issue: Record<string, unknown>): GitHubIssue {
    return {
      id: String(issue.id),
      number: issue.number as number,
      title: issue.title as string,
      body: issue.body as string | undefined,
      state: (issue.state as string) === "open" ? "open" : "closed",
      labels: ((issue.labels || []) as Record<string, string>[]).map((l) => l.name),
      assignee: issue.assignee ? (issue.assignee as Record<string, string>).login : undefined,
      createdAt: issue.created_at as string,
      updatedAt: issue.updated_at as string,
      url: issue.html_url as string,
    };
  }

  /**
   * Normalize issues list.
   */
  private normalizeIssues(issues: Record<string, unknown>[]): GitHubIssue[] {
    return issues.map((issue) => this.normalizeIssue(issue));
  }

  /**
   * Normalize single PR.
   */
  private normalizePullRequest(pr: Record<string, unknown>): GitHubPullRequest {
    return {
      id: String(pr.id),
      number: pr.number as number,
      title: pr.title as string,
      body: pr.body as string | undefined,
      state: (pr.state as string) === "merged" ? "merged" : ((pr.merged_at as string) ? "merged" : (pr.state as "open" | "closed")),
      head: {
        branch: ((pr.head || {}) as Record<string, string>).ref,
        sha: ((pr.head || {}) as Record<string, string>).sha,
      },
      base: {
        branch: ((pr.base || {}) as Record<string, string>).ref,
        sha: ((pr.base || {}) as Record<string, string>).sha,
      },
      draft: pr.draft as boolean,
      labels: ((pr.labels || []) as Record<string, string>[]).map((l) => l.name),
      assignees: ((pr.assignees || []) as Record<string, string>[]).map((a) => a.login),
      reviewers: ((pr.requested_reviewers || []) as Record<string, string>[]).map((r) => r.login),
      createdAt: pr.created_at as string,
      updatedAt: pr.updated_at as string,
      mergedAt: pr.merged_at as string | undefined,
      url: pr.html_url as string,
    };
  }

  /**
   * Normalize PRs list.
   */
  private normalizePullRequests(prs: Record<string, unknown>[]): GitHubPullRequest[] {
    return prs.map((pr) => this.normalizePullRequest(pr));
  }
}

/**
 * Create a GitHub API client.
 */
export function createGitHubAPIClient(
  token: string,
  owner: string,
  repo: string,
): GitHubAPIClient {
  return new GitHubAPIClient(token, owner, repo);
}
