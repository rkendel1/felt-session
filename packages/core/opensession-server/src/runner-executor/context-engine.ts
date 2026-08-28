/**
 * Mission Control agent context engine.
 *
 * Provides agents with durable, queryable context about their work:
 * - Project information
 * - Current task and acceptance criteria
 * - Prior execution history and failures
 * - Review feedback
 * - Related decisions
 * - Recent events and messages
 */

import type { DurableTaskRegistry } from "./durable-task-registry";
import type { EventSpine } from "./event-spine";
import type { MissionControlTask, TaskExecution, TaskReview } from "./mission-control-task";

export interface AgentContext {
  projectId: string;
  projectDescription?: string;
  currentTaskId?: string;
  currentTask?: MissionControlTask;
  acceptanceCriteria?: string[];
  priorExecutions?: TaskExecution[];
  failures?: TaskExecution[];
  reviews?: TaskReview[];
  approvals?: TaskReview[];
  rejections?: TaskReview[];
  recentEvents?: unknown[];
  blockedBy?: MissionControlTask[];
  dependencies?: string[];
}

/**
 * ContextEngine assembles agent context from multiple durable sources.
 */
export interface ContextEngine {
  /**
   * Get comprehensive context for an agent working on a task.
   */
  getTaskContext(
    projectId: string,
    taskId: string,
  ): Promise<AgentContext>;

  /**
   * Get all active tasks in a project.
   */
  getProjectActiveTasks(projectId: string): Promise<MissionControlTask[]>;

  /**
   * Get task history including executions and reviews.
   */
  getTaskHistory(
    taskId: string,
  ): Promise<{
    executions: TaskExecution[];
    reviews: TaskReview[];
  }>;

  /**
   * Find tasks blocked by failures.
   */
  getBlockedTasks(projectId: string): Promise<MissionControlTask[]>;

  /**
   * Get feedback from reviews on a task.
   */
  getReviewFeedback(taskId: string): Promise<string[]>;
}

export function createContextEngine(
  taskRegistry: DurableTaskRegistry,
  eventSpine: EventSpine,
): ContextEngine {
  return {
    async getTaskContext(projectId: string, taskId: string): Promise<AgentContext> {
      const task = await taskRegistry.getTask(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const executions = await taskRegistry.listExecutions(taskId);
      const reviews = await taskRegistry.listReviews(taskId);

      const failures = executions.filter((e) => e.status === "failed");
      const approvals = reviews.filter((r) => r.status === "approved");
      const rejections = reviews.filter((r) => r.status === "rejected");

      // Get blockers
      const blockedBy: MissionControlTask[] = [];
      for (const blockerId of task.blockedBy) {
        const blocker = await taskRegistry.getTask(blockerId);
        if (blocker) {
          blockedBy.push(blocker);
        }
      }

      // Get recent events for this session (simplified - in full implementation
      // would query event spine for events related to this task)
      const recentEvents = await eventSpine.range(projectId, 0, 10);

      return {
        projectId,
        currentTaskId: taskId,
        currentTask: task,
        acceptanceCriteria: task.acceptanceCriteria,
        priorExecutions: executions,
        failures,
        reviews,
        approvals,
        rejections,
        recentEvents,
        blockedBy,
      };
    },

    async getProjectActiveTasks(projectId: string): Promise<MissionControlTask[]> {
      const tasks = await taskRegistry.listTasksByProject(projectId);
      return tasks.filter(
        (t) => t.status === "open" || t.status === "in_progress",
      );
    },

    async getTaskHistory(
      taskId: string,
    ): Promise<{ executions: TaskExecution[]; reviews: TaskReview[] }> {
      const executions = await taskRegistry.listExecutions(taskId);
      const reviews = await taskRegistry.listReviews(taskId);
      return { executions, reviews };
    },

    async getBlockedTasks(projectId: string): Promise<MissionControlTask[]> {
      const tasks = await taskRegistry.listTasksByProject(projectId);
      return tasks.filter((t) => t.status === "blocked");
    },

    async getReviewFeedback(taskId: string): Promise<string[]> {
      const reviews = await taskRegistry.listReviews(taskId);
      return reviews
        .filter((r) => r.feedback && r.status !== "requested" && r.status !== "in_progress")
        .map((r) => r.feedback!)
        .filter(Boolean);
    },
  };
}
