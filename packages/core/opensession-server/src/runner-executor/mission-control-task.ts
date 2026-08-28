/**
 * Mission Control task definitions.
 *
 * Tasks represent work to be done, with acceptance criteria and dependencies.
 * They are independent from executions - a task can have multiple executions
 * (with different agents, tools, or approaches) until one succeeds.
 */

export type TaskStatus = "open" | "in_progress" | "blocked" | "completed" | "failed";

export type TaskPriority = "critical" | "high" | "medium" | "low";

/**
 * MissionControlTask represents a unit of work to be completed.
 */
export interface MissionControlTask {
  id: string;
  projectId: string;
  parentTaskId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  acceptanceCriteria: string[];
  blockedBy: string[];
}

/**
 * Task execution result linking a task to one attempt to complete it.
 */
export interface TaskExecution {
  id: string;
  taskId: string;
  executionId: string;
  agentId: string;
  status: "in_progress" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

/**
 * Task review result linking a task to a reviewer's assessment.
 */
export interface TaskReview {
  id: string;
  taskId: string;
  executionId: string;
  reviewerId: string;
  status: "requested" | "in_progress" | "approved" | "rejected";
  createdAt: string;
  completedAt?: string;
  feedback?: string;
}
