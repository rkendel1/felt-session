/**
 * Task Code Context Service.
 *
 * Links Mission Control tasks to repository code for impact analysis.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { randomUUIDv7 } from "bun";
import type { TaskCodeContext } from "./mission-control-graph";
import type {
  DurableRepositoryFileRegistry,
} from "./durable-repository-file-registry";

/**
 * Stored task-code relationship.
 */
interface StoredTaskCodeContext {
  id: string;
  taskId: string;
  projectId: string;
  relevantFiles: string; // JSON
  relatedTasks?: string; // JSON
  estimatedScope: string;
  complexity: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Task Code Context Manager Interface.
 */
export interface TaskCodeContextManagerInterface {
  // Context CRUD
  setContext(context: TaskCodeContext): Promise<void>;
  getContext(taskId: string): Promise<TaskCodeContext | undefined>;
  updateContext(context: TaskCodeContext): Promise<void>;
  deleteContext(taskId: string): Promise<void>;

  // Linking
  linkFilesToTask(
    taskId: string,
    projectId: string,
    filePaths: string[],
  ): Promise<void>;
  unlinkFileFromTask(taskId: string, filePath: string): Promise<void>;

  // Recommendations
  suggestRelevantFiles(
    projectId: string,
    taskDescription: string,
  ): Promise<Array<{ path: string; relevance: number }>>;
}

/**
 * Create a task code context manager.
 */
export function createTaskCodeContextManager(
  dbPath: string,
  fileRegistry?: DurableRepositoryFileRegistry,
): TaskCodeContextManagerInterface {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path: dbPath,
    namespace: "mission-control-task-context",
  });

  const CONTEXTS_COLLECTION = "task_code_contexts";

  return {
    async setContext(context: TaskCodeContext): Promise<void> {
      const row: StoredTaskCodeContext = {
        id: `ctx-${randomUUIDv7()}`,
        taskId: context.taskId,
        projectId: context.projectId,
        relevantFiles: JSON.stringify(context.relevantFiles),
        relatedTasks: context.relatedTasks
          ? JSON.stringify(context.relatedTasks)
          : undefined,
        estimatedScope: context.estimatedScope,
        complexity: context.complexity,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.transaction((tx) => {
        tx.collection<StoredTaskCodeContext>(CONTEXTS_COLLECTION).set(
          context.taskId,
          row,
        );
      });
    },

    async getContext(taskId: string): Promise<TaskCodeContext | undefined> {
      const row = await db
        .collection<StoredTaskCodeContext>(CONTEXTS_COLLECTION)
        .get(taskId);
      if (!row) return undefined;
      return {
        taskId: row.taskId,
        projectId: row.projectId,
        relevantFiles: JSON.parse(row.relevantFiles),
        relatedTasks: row.relatedTasks
          ? JSON.parse(row.relatedTasks)
          : undefined,
        estimatedScope: row.estimatedScope as any,
        complexity: row.complexity as any,
      };
    },

    async updateContext(context: TaskCodeContext): Promise<void> {
      const existing = await this.getContext(context.taskId);
      if (!existing) {
        await this.setContext(context);
        return;
      }

      const row: StoredTaskCodeContext = {
        id: `ctx-${randomUUIDv7()}`,
        taskId: context.taskId,
        projectId: context.projectId,
        relevantFiles: JSON.stringify(context.relevantFiles),
        relatedTasks: context.relatedTasks
          ? JSON.stringify(context.relatedTasks)
          : undefined,
        estimatedScope: context.estimatedScope,
        complexity: context.complexity,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.transaction((tx) => {
        tx.collection<StoredTaskCodeContext>(CONTEXTS_COLLECTION).set(
          context.taskId,
          row,
        );
      });
    },

    async deleteContext(taskId: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredTaskCodeContext>(CONTEXTS_COLLECTION).delete(
          taskId,
        );
      });
    },

    async linkFilesToTask(
      taskId: string,
      projectId: string,
      filePaths: string[],
    ): Promise<void> {
      const context = await this.getContext(taskId);

      const updated: TaskCodeContext = {
        taskId,
        projectId,
        relevantFiles: filePaths.map((path) => ({
          path,
          relevance: 1.0,
          symbols: [],
          reason: "Manually linked",
        })),
        relatedTasks: context?.relatedTasks,
        estimatedScope:
          filePaths.length <= 3
            ? "small"
            : filePaths.length <= 10
              ? "medium"
              : "large",
        complexity: "medium",
      };

      await this.updateContext(updated);
    },

    async unlinkFileFromTask(taskId: string, filePath: string): Promise<void> {
      const context = await this.getContext(taskId);
      if (!context) return;

      const updated: TaskCodeContext = {
        ...context,
        relevantFiles: context.relevantFiles.filter((f) => f.path !== filePath),
      };

      await this.updateContext(updated);
    },

    async suggestRelevantFiles(
      projectId: string,
      taskDescription: string,
    ): Promise<Array<{ path: string; relevance: number }>> {
      // Simplified: return empty for now
      // Full implementation would use NLP/semantic search to match task description to files
      return [];
    },
  };
}
