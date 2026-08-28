/**
 * Mission Control GitHub Agent type definitions.
 *
 * GitHub integration for natural language commands to GitHub API operations.
 */

/**
 * GitHub OAuth token and credentials.
 */
export interface GitHubOAuthToken {
  id: string;
  projectId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope: string[];
  userId: string;
  userName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * GitHub integration configuration.
 */
export interface GitHubIntegration {
  id: string;
  projectId: string;
  appId: string;
  clientId: string;
  clientSecret: string; // encrypted at rest
  installationId?: string;
  status: "pending" | "authorized" | "revoked";
  createdAt: string;
  updatedAt: string;
}

/**
 * GitHub issue representation.
 */
export interface GitHubIssue {
  id: string;
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  labels: string[];
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

/**
 * GitHub pull request representation.
 */
export interface GitHubPullRequest {
  id: string;
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed" | "merged";
  head: {
    branch: string;
    sha: string;
  };
  base: {
    branch: string;
    sha: string;
  };
  draft: boolean;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  url: string;
}

/**
 * GitHub commit representation.
 */
export interface GitHubCommit {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  date: string;
  url: string;
}

/**
 * GitHub action command parsed from natural language.
 */
export interface GitHubCommand {
  action:
    | "list_issues"
    | "list_prs"
    | "list_commits"
    | "get_issue"
    | "get_pr"
    | "create_issue"
    | "create_pr"
    | "close_issue"
    | "close_pr"
    | "merge_pr"
    | "comment"
    | "label"
    | "assign"
    | "reopen";
  params: Record<string, string | number | boolean | string[]>;
}

/**
 * GitHub API Response wrapper.
 */
export interface GitHubAPIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode: number;
}
