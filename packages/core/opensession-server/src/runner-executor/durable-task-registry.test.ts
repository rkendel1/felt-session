/**
 * Tests for durable task registry.
 *
 * Proves that tasks can be created, retrieved, listed by status/project,
 * have subtasks and dependencies, and can track executions and reviews.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableTaskRegistry } from "./durable-task-registry";
import type {
  MissionControlTask,
  TaskExecution,
  TaskReview,
} from "./mission-control-task";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "task-registry-"));
  roots.push(root);
  return root;
}

function createTask(
  overrides?: Partial<MissionControlTask>,
): MissionControlTask {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Implement feature",
    description: "Add new capability",
    status: "open",
    priority: "high",
    createdBy: "user-1",
    createdAt: now,
    updatedAt: now,
    acceptanceCriteria: ["Feature works", "Tests pass"],
    blockedBy: [],
    ...overrides,
  };
}

describe("DurableTaskRegistry", () => {
  test("creates and retrieves tasks", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());
    const task = createTask();

    await registry.upsertTask(task);
    const retrieved = await registry.getTask("task-1");

    expect(retrieved).toBeTruthy();
    expect(retrieved?.title).toBe("Implement feature");
    expect(retrieved?.priority).toBe("high");
    expect(retrieved?.acceptanceCriteria).toHaveLength(2);
  });

  test("lists tasks by project", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task1 = createTask({ id: "task-1", projectId: "project-1" });
    const task2 = createTask({ id: "task-2", projectId: "project-1" });
    const task3 = createTask({ id: "task-3", projectId: "project-2" });

    await registry.upsertTask(task1);
    await registry.upsertTask(task2);
    await registry.upsertTask(task3);

    const project1Tasks = await registry.listTasksByProject("project-1");
    const project2Tasks = await registry.listTasksByProject("project-2");

    expect(project1Tasks).toHaveLength(2);
    expect(project2Tasks).toHaveLength(1);
  });

  test("lists tasks by status", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const openTask = createTask({ id: "task-1", status: "open" });
    const inProgressTask = createTask({
      id: "task-2",
      status: "in_progress",
    });
    const completedTask = createTask({ id: "task-3", status: "completed" });

    await registry.upsertTask(openTask);
    await registry.upsertTask(inProgressTask);
    await registry.upsertTask(completedTask);

    const openTasks = await registry.listTasksByStatus("open");
    const inProgressTasks = await registry.listTasksByStatus("in_progress");
    const completedTasks = await registry.listTasksByStatus("completed");

    expect(openTasks).toHaveLength(1);
    expect(inProgressTasks).toHaveLength(1);
    expect(completedTasks).toHaveLength(1);
  });

  test("handles parent and child task relationships", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const parentTask = createTask({ id: "parent-1" });
    const childTask1 = createTask({
      id: "child-1",
      parentTaskId: "parent-1",
    });
    const childTask2 = createTask({
      id: "child-2",
      parentTaskId: "parent-1",
    });

    await registry.upsertTask(parentTask);
    await registry.upsertTask(childTask1);
    await registry.upsertTask(childTask2);

    const subtasks = await registry.listSubtasks("parent-1");

    expect(subtasks).toHaveLength(2);
    expect(subtasks.map((t) => t.id)).toContain("child-1");
    expect(subtasks.map((t) => t.id)).toContain("child-2");
  });

  test("tracks task blockers", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask({
      id: "task-1",
      blockedBy: ["task-2", "task-3"],
    });

    await registry.upsertTask(task);
    const retrieved = await registry.getTask("task-1");

    expect(retrieved?.blockedBy).toHaveLength(2);
    expect(retrieved?.blockedBy).toContain("task-2");
  });

  test("records and retrieves task executions", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask();
    await registry.upsertTask(task);

    const execution: TaskExecution = {
      id: "exec-1",
      taskId: "task-1",
      executionId: "executor-1",
      agentId: "builder-1",
      status: "in_progress",
      startedAt: new Date().toISOString(),
    };

    await registry.recordExecution(execution);
    const executions = await registry.listExecutions("task-1");

    expect(executions).toHaveLength(1);
    expect(executions[0]?.agentId).toBe("builder-1");
  });

  test("tracks execution completion", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask();
    await registry.upsertTask(task);

    const startTime = new Date().toISOString();
    const execution: TaskExecution = {
      id: "exec-1",
      taskId: "task-1",
      executionId: "executor-1",
      agentId: "builder-1",
      status: "succeeded",
      startedAt: startTime,
      completedAt: new Date().toISOString(),
      result: "Feature implemented",
    };

    await registry.recordExecution(execution);
    const executions = await registry.listExecutions("task-1");

    expect(executions[0]?.status).toBe("succeeded");
    expect(executions[0]?.result).toBe("Feature implemented");
  });

  test("records and retrieves task reviews", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask();
    await registry.upsertTask(task);

    const review: TaskReview = {
      id: "review-1",
      taskId: "task-1",
      executionId: "exec-1",
      reviewerId: "reviewer-1",
      status: "requested",
      createdAt: new Date().toISOString(),
    };

    await registry.recordReview(review);
    const reviews = await registry.listReviews("task-1");

    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.status).toBe("requested");
  });

  test("tracks review completion with feedback", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask();
    await registry.upsertTask(task);

    const review: TaskReview = {
      id: "review-1",
      taskId: "task-1",
      executionId: "exec-1",
      reviewerId: "reviewer-1",
      status: "approved",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      feedback: "Looks good!",
    };

    await registry.recordReview(review);
    const reviews = await registry.listReviews("task-1");

    expect(reviews[0]?.status).toBe("approved");
    expect(reviews[0]?.feedback).toBe("Looks good!");
  });

  test("handles multiple executions for a single task", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask();
    await registry.upsertTask(task);

    const exec1: TaskExecution = {
      id: "exec-1",
      taskId: "task-1",
      executionId: "executor-1",
      agentId: "builder-1",
      status: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: "Compilation error",
    };

    const exec2: TaskExecution = {
      id: "exec-2",
      taskId: "task-1",
      executionId: "executor-2",
      agentId: "builder-2",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "Feature implemented",
    };

    await registry.recordExecution(exec1);
    await registry.recordExecution(exec2);

    const executions = await registry.listExecutions("task-1");

    expect(executions).toHaveLength(2);
    expect(executions.filter((e) => e.status === "succeeded")).toHaveLength(1);
    expect(executions.filter((e) => e.status === "failed")).toHaveLength(1);
  });

  test("updates task status", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask({ status: "open" });
    await registry.upsertTask(task);

    const updated = {
      ...task,
      status: "in_progress" as const,
      assignedAgentId: "builder-1",
      updatedAt: new Date().toISOString(),
    };

    await registry.upsertTask(updated);
    const retrieved = await registry.getTask("task-1");

    expect(retrieved?.status).toBe("in_progress");
    expect(retrieved?.assignedAgentId).toBe("builder-1");
  });

  test("deletes tasks", async () => {
    const registry = openDurableTaskRegistry(tmpRoot());

    const task = createTask();
    await registry.upsertTask(task);
    await registry.deleteTask("task-1");

    const retrieved = await registry.getTask("task-1");
    expect(retrieved).toBeNull();
  });
});
