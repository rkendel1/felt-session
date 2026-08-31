/**
 * Durable task registry backed by FeltDB.
 *
 * Tasks are persistent units of work that can have multiple executions
 * and reviews before completion. They form a graph with parent/child
 * relationships and blocking dependencies.
 */

import type { StateFirstDB } from "@feltdb/core";
import {
  type MissionControlTask,
  type TaskExecution,
  type TaskReview,
  type TaskStatus,
  type TaskPriority,
} from "./mission-control-task";

interface StoredTaskRow {
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

interface StoredTaskExecutionRow {
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

interface StoredTaskReviewRow {
  id: string;
  taskId: string;
  executionId: string;
  reviewerId: string;
  status: "requested" | "in_progress" | "approved" | "rejected";
  createdAt: string;
  completedAt?: string;
  feedback?: string;
}

const TASKS_COLLECTION = "mission_control_tasks";
const EXECUTIONS_COLLECTION = "mission_control_task_executions";
const REVIEWS_COLLECTION = "mission_control_task_reviews";

/**
 * DurableTaskRegistry manages persistent task definitions in FeltDB.
 */
export interface DurableTaskRegistry {
  /**
   * Create or update a task.
   */
  upsertTask(task: MissionControlTask): Promise<void>;

  /**
   * Retrieve a task by ID.
   */
  getTask(taskId: string): Promise<MissionControlTask | null>;

  /**
   * List all tasks for a project.
   */
  listTasksByProject(projectId: string): Promise<MissionControlTask[]>;

  /**
   * List all tasks with a given status.
   */
  listTasksByStatus(status: TaskStatus): Promise<MissionControlTask[]>;

  /**
   * List subtasks of a parent task.
   */
  listSubtasks(parentTaskId: string): Promise<MissionControlTask[]>;

  /**
   * Record a task execution attempt.
   */
  recordExecution(execution: TaskExecution): Promise<void>;

  /**
   * List all executions for a task.
   */
  listExecutions(taskId: string): Promise<TaskExecution[]>;

  /**
   * Record a task review.
   */
  recordReview(review: TaskReview): Promise<void>;

  /**
   * List all reviews for a task.
   */
  listReviews(taskId: string): Promise<TaskReview[]>;

  /**
   * Delete a task.
   */
  deleteTask(taskId: string): Promise<void>;
}

export function openDurableTaskRegistry(db: StateFirstDB): DurableTaskRegistry {

  return {
    async upsertTask(task: MissionControlTask): Promise<void> {
      const row: StoredTaskRow = {
        id: task.id,
        projectId: task.projectId,
        parentTaskId: task.parentTaskId,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assignedAgentId: task.assignedAgentId,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        acceptanceCriteria: task.acceptanceCriteria,
        blockedBy: task.blockedBy,
      };

      await db.transaction((tx) => {
        tx.collection<StoredTaskRow>(TASKS_COLLECTION).set(task.id, row);
      });
    },

    async getTask(taskId: string): Promise<MissionControlTask | null> {
      const row = await db
        .collection<StoredTaskRow>(TASKS_COLLECTION)
        .get(taskId);

      if (!row) return null;

      return {
        id: row.id,
        projectId: row.projectId,
        parentTaskId: row.parentTaskId,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assignedAgentId: row.assignedAgentId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        acceptanceCriteria: row.acceptanceCriteria,
        blockedBy: row.blockedBy,
      };
    },

    async listTasksByProject(projectId: string): Promise<MissionControlTask[]> {
      const all = await db
        .collection<StoredTaskRow>(TASKS_COLLECTION)
        .find({ projectId });

      return all.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        parentTaskId: row.parentTaskId,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assignedAgentId: row.assignedAgentId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        acceptanceCriteria: row.acceptanceCriteria,
        blockedBy: row.blockedBy,
      }));
    },

    async listTasksByStatus(status: TaskStatus): Promise<MissionControlTask[]> {
      const all = await db
        .collection<StoredTaskRow>(TASKS_COLLECTION)
        .find({ status });

      return all.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        parentTaskId: row.parentTaskId,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assignedAgentId: row.assignedAgentId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        acceptanceCriteria: row.acceptanceCriteria,
        blockedBy: row.blockedBy,
      }));
    },

    async listSubtasks(parentTaskId: string): Promise<MissionControlTask[]> {
      const all = await db
        .collection<StoredTaskRow>(TASKS_COLLECTION)
        .find({ parentTaskId });

      return all.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        parentTaskId: row.parentTaskId,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assignedAgentId: row.assignedAgentId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        acceptanceCriteria: row.acceptanceCriteria,
        blockedBy: row.blockedBy,
      }));
    },

    async recordExecution(execution: TaskExecution): Promise<void> {
      const row: StoredTaskExecutionRow = {
        id: execution.id,
        taskId: execution.taskId,
        executionId: execution.executionId,
        agentId: execution.agentId,
        status: execution.status,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        result: execution.result,
        error: execution.error,
      };

      await db.transaction((tx) => {
        tx.collection<StoredTaskExecutionRow>(EXECUTIONS_COLLECTION).set(
          execution.id,
          row,
        );
      });
    },

    async listExecutions(taskId: string): Promise<TaskExecution[]> {
      const all = await db
        .collection<StoredTaskExecutionRow>(EXECUTIONS_COLLECTION)
        .find({ taskId });

      return all.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        executionId: row.executionId,
        agentId: row.agentId,
        status: row.status,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        result: row.result,
        error: row.error,
      }));
    },

    async recordReview(review: TaskReview): Promise<void> {
      const row: StoredTaskReviewRow = {
        id: review.id,
        taskId: review.taskId,
        executionId: review.executionId,
        reviewerId: review.reviewerId,
        status: review.status,
        createdAt: review.createdAt,
        completedAt: review.completedAt,
        feedback: review.feedback,
      };

      await db.transaction((tx) => {
        tx.collection<StoredTaskReviewRow>(REVIEWS_COLLECTION).set(
          review.id,
          row,
        );
      });
    },

    async listReviews(taskId: string): Promise<TaskReview[]> {
      const all = await db
        .collection<StoredTaskReviewRow>(REVIEWS_COLLECTION)
        .find({ taskId });

      return all.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        executionId: row.executionId,
        reviewerId: row.reviewerId,
        status: row.status,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        feedback: row.feedback,
      }));
    },

    async deleteTask(taskId: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection(TASKS_COLLECTION).delete(taskId);
      });
    },
  };
}
