/**
 * Mission Control agent definitions and registry.
 *
 * Each agent has a persistent definition stored in FeltDB,
 * enabling the system to coordinate team-based work execution.
 */

export type AgentRole = "architect" | "builder" | "reviewer" | "tester" | "release";

export type AgentProvider = "anthropic" | "openai" | "google";

export type AgentStatus = "idle" | "active" | "failed";

/**
 * MissionControlAgent represents a team member that can execute work.
 */
export interface MissionControlAgent {
  id: string;
  name: string;
  role: AgentRole;
  provider: AgentProvider;
  model: string;
  capabilities: string[];
  systemPrompt: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Standard system prompts for each agent role.
 */
export const AGENT_SYSTEM_PROMPTS: Record<AgentRole, string> = {
  architect:
    "You are a software architect. Your role is to investigate projects, understand their architecture, identify problems, and create detailed specifications for builders to implement.",
  builder:
    "You are a software builder. Your role is to implement features and bug fixes based on clear specifications from the architect. Write clean, tested code that follows the project's conventions.",
  reviewer:
    "You are a code reviewer. Your role is to review pull requests for correctness, performance, security, and adherence to project conventions. Provide constructive feedback.",
  tester:
    "You are a quality assurance specialist. Your role is to write and execute tests to verify that implementations work correctly and handle edge cases.",
  release:
    "You are a release engineer. Your role is to verify that all tests pass, create release notes, tag versions, and deploy to production.",
};

/**
 * Standard capabilities for each agent role.
 */
export const AGENT_CAPABILITIES: Record<AgentRole, string[]> = {
  architect: [
    "code_exploration",
    "architecture_analysis",
    "decision_documentation",
    "specification_writing",
  ],
  builder: [
    "code_editing",
    "test_writing",
    "branch_management",
    "commit_creation",
    "pr_opening",
  ],
  reviewer: [
    "pr_review",
    "code_analysis",
    "test_verification",
    "approval_authority",
  ],
  tester: [
    "test_writing",
    "test_execution",
    "failure_analysis",
    "coverage_reporting",
  ],
  release: [
    "version_tagging",
    "release_notes",
    "deployment",
    "rollback_authority",
  ],
};
