/**
 * Mission Control Project type definitions.
 *
 * A Project is the root durable object in Mission Control. It scopes all
 * orchestration, repositories, agents, tasks, and decisions.
 */

/**
 * GitHub or other version control provider configuration.
 */
export interface RepositoryConfig {
  provider: "github";
  owner: string;
  repo: string;
  defaultBranch: string;
  remoteUrl: string;
}

/**
 * Local machine configuration for worktrees and execution.
 */
export interface LocalConfig {
  rootPath: string;
  worktreeStrategy: "nested" | "sibling";
}

/**
 * Slack workspace configuration.
 */
export interface SlackConfig {
  workspaceId: string;
  generalChannelId: string;
  projectChannelId?: string;
}

/**
 * MissionControlProject represents a single project scoped to a team.
 *
 * All orchestration, agents, tasks, and decisions are scoped to a project.
 */
export interface MissionControlProject {
  id: string;
  name: string;
  slug: string;
  description?: string;
  repository: RepositoryConfig;
  local: LocalConfig;
  slack: SlackConfig;
  status: "active" | "archived" | "paused";
  createdAt: string;
  updatedAt: string;
}

/**
 * ProjectStatus represents the current state of a project.
 */
export type ProjectStatus = "active" | "archived" | "paused";
