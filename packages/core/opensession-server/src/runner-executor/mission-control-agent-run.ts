/**
 * Mission Control Agent Run type definitions.
 *
 * An Agent Run represents a single command execution by an agent within a worktree.
 * Runs provide full audit trail and enable rollback/debugging.
 */

/**
 * MissionControlAgentRun represents a single agent command execution.
 */
export interface MissionControlAgentRun {
  id: string;
  projectId: string;
  agentId: string;
  taskId?: string;
  worktreeId?: string;
  command: string; // the shell command executed
  workingDirectory: string;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * AgentRunStatus represents the execution state.
 */
export type AgentRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * Agent Run Output - structured capture of command output.
 */
export interface AgentRunOutput {
  id: string;
  agentRunId: string;
  type: "stdout" | "stderr" | "exit_code";
  content: string;
  lineNumber?: number;
  timestamp: string;
}

/**
 * Agent Run Environment - capture of execution context.
 */
export interface AgentRunEnvironment {
  id: string;
  agentRunId: string;
  workingDirectory: string;
  environmentVariables: Record<string, string>;
  gitBranch: string;
  gitCommit: string;
  gitStatus: "clean" | "dirty";
}
