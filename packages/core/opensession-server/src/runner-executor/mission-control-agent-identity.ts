/**
 * Mission Control Agent Identity definitions.
 *
 * Agents are first-class citizens with persistent identities, capabilities, and presence.
 */

/**
 * Agent kind type.
 */
export type AgentKind = "role" | "integration";

/**
 * Predefined agent roles in Mission Control.
 */
export type AgentRole =
  | "architect"
  | "builder"
  | "reviewer"
  | "tester"
  | "release"
  | "github";

/**
 * Agent capabilities.
 */
export interface StructuredAgentCapability {
  name: string;
  description: string;
  version: string;
}
export type AgentCapability = StructuredAgentCapability | string;

/**
 * Agent identity - represents an agent as an addressable entity.
 */
export interface AgentIdentity {
  id: string;
  handle: string; // @architect, @builder, @github, etc.
  displayName: string;
  description?: string;
  kind: AgentKind;
  role?: AgentRole;
  provider?: string; // e.g., "github", "openai", "anthropic"
  capabilities: AgentCapability[];
  projectId?: string; // If project-scoped
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Agent presence state.
 */
export type AgentPresenceState =
  | "idle"
  | "busy"
  | "thinking"
  | "executing"
  | "unavailable"
  | "active";

/**
 * Agent presence information.
 */
export interface AgentPresence {
  agentId: string;
  state: AgentPresenceState;
  currentTask?: string;
  statusMessage?: string;
  lastSeen: string;
  updatedAt: string;
}

/**
 * Agent assignment - tracks what agent is assigned to what task.
 */
export interface AgentAssignment {
  id: string;
  agentId: string;
  taskId: string;
  projectId: string;
  assignedAt: string;
  status: "pending" | "active" | "assigned" | "accepted" | "completed" | "failed";
  result?: string;
  completedAt?: string;
}

/**
 * Standard built-in agents.
 */
export const BUILTIN_AGENTS: Record<AgentRole, Partial<AgentIdentity>> = {
  architect: {
    handle: "@architect",
    displayName: "Architect Agent",
    description: "Analyzes code structure, design patterns, and architecture decisions",
    kind: "role",
    role: "architect",
    capabilities: [
      {
        name: "code_analysis",
        description: "Analyze code structure and architecture",
        version: "1.0.0",
      },
      {
        name: "design_review",
        description: "Review design patterns and decisions",
        version: "1.0.0",
      },
      {
        name: "risk_assessment",
        description: "Assess technical risks in changes",
        version: "1.0.0",
      },
    ],
  },
  builder: {
    handle: "@builder",
    displayName: "Builder Agent",
    description: "Implements features, fixes bugs, and makes code changes",
    kind: "role",
    role: "builder",
    capabilities: [
      {
        name: "code_generation",
        description: "Generate and modify code",
        version: "1.0.0",
      },
      {
        name: "test_writing",
        description: "Write and run tests",
        version: "1.0.0",
      },
      {
        name: "git_operations",
        description: "Perform git operations",
        version: "1.0.0",
      },
    ],
  },
  reviewer: {
    handle: "@reviewer",
    displayName: "Reviewer Agent",
    description: "Reviews code changes and provides feedback",
    kind: "role",
    role: "reviewer",
    capabilities: [
      {
        name: "code_review",
        description: "Review code changes",
        version: "1.0.0",
      },
      {
        name: "style_checking",
        description: "Check code style and conventions",
        version: "1.0.0",
      },
      {
        name: "best_practice_audit",
        description: "Audit for best practices",
        version: "1.0.0",
      },
    ],
  },
  tester: {
    handle: "@tester",
    displayName: "Tester Agent",
    description: "Runs tests, validates changes, and reports quality",
    kind: "role",
    role: "tester",
    capabilities: [
      {
        name: "test_execution",
        description: "Execute test suites",
        version: "1.0.0",
      },
      {
        name: "coverage_analysis",
        description: "Analyze test coverage",
        version: "1.0.0",
      },
      {
        name: "performance_testing",
        description: "Run performance tests",
        version: "1.0.0",
      },
    ],
  },
  release: {
    handle: "@release",
    displayName: "Release Agent",
    description: "Manages releases, deployments, and version management",
    kind: "role",
    role: "release",
    capabilities: [
      {
        name: "version_management",
        description: "Manage version numbers",
        version: "1.0.0",
      },
      {
        name: "deployment",
        description: "Deploy to production",
        version: "1.0.0",
      },
      {
        name: "release_notes",
        description: "Generate release notes",
        version: "1.0.0",
      },
    ],
  },
  github: {
    handle: "@github",
    displayName: "GitHub Integration",
    description: "Integrates with GitHub for PR/issue management and automation",
    kind: "integration",
    role: "github",
    provider: "github",
    capabilities: [
      {
        name: "issue_management",
        description: "Create and manage GitHub issues",
        version: "1.0.0",
      },
      {
        name: "pull_request_management",
        description: "Create, review, and merge pull requests",
        version: "1.0.0",
      },
      {
        name: "repository_analysis",
        description: "Analyze repository state",
        version: "1.0.0",
      },
    ],
  },
};
