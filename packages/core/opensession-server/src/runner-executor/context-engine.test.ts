/**
 * Tests for context engine.
 *
 * Proves that agents can query durable context about their work,
 * including task history, feedback, and blockers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableTaskRegistry } from "./durable-task-registry";
import { testFeltDb } from "./test-feltdb";
import { openFeltDbEventSpine } from "./feltdb-event-spine";
import { createContextEngine } from "./context-engine";
import type { MissionControlTask } from "./mission-control-task";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "context-engine-"));
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

describe("ContextEngine", () => {
  test("assembles comprehensive task context", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    const task = createTask();
    await taskRegistry.upsertTask(task);

    const context = await engine.getTaskContext("project-1", "task-1");

    expect(context.currentTaskId).toBe("task-1");
    expect(context.currentTask?.title).toBe("Implement feature");
    expect(context.acceptanceCriteria).toHaveLength(2);
    expect(context.priorExecutions).toHaveLength(0);
  });

  test("includes prior executions in context", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    const task = createTask();
    await taskRegistry.upsertTask(task);

    await taskRegistry.recordExecution({
      id: "exec-1",
      taskId: "task-1",
      executionId: "executor-1",
      agentId: "builder-1",
      status: "failed",
      startedAt: new Date().toISOString(),
      error: "Compilation error",
    });

    const context = await engine.getTaskContext("project-1", "task-1");

    expect(context.priorExecutions).toHaveLength(1);
    expect(context.failures).toHaveLength(1);
    expect(context.failures?.[0]?.error).toBe("Compilation error");
  });

  test("includes review feedback in context", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    const task = createTask();
    await taskRegistry.upsertTask(task);

    await taskRegistry.recordExecution({
      id: "exec-1",
      taskId: "task-1",
      executionId: "executor-1",
      agentId: "builder-1",
      status: "succeeded",
      startedAt: new Date().toISOString(),
    });

    await taskRegistry.recordReview({
      id: "review-1",
      taskId: "task-1",
      executionId: "exec-1",
      reviewerId: "reviewer-1",
      status: "rejected",
      createdAt: new Date().toISOString(),
      feedback: "Needs error handling",
    });

    const context = await engine.getTaskContext("project-1", "task-1");

    expect(context.rejections).toHaveLength(1);
    expect(context.rejections?.[0]?.feedback).toBe("Needs error handling");
  });

  test("lists active tasks in project", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    await taskRegistry.upsertTask(createTask({ id: "task-1", status: "open" }));
    await taskRegistry.upsertTask(
      createTask({ id: "task-2", status: "in_progress" }),
    );
    await taskRegistry.upsertTask(
      createTask({ id: "task-3", status: "completed" }),
    );

    const active = await engine.getProjectActiveTasks("project-1");

    expect(active).toHaveLength(2);
    expect(active.map((t) => t.id)).toContain("task-1");
    expect(active.map((t) => t.id)).toContain("task-2");
  });

  test("gets task history with executions and reviews", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    const task = createTask();
    await taskRegistry.upsertTask(task);

    await taskRegistry.recordExecution({
      id: "exec-1",
      taskId: "task-1",
      executionId: "executor-1",
      agentId: "builder-1",
      status: "succeeded",
      startedAt: new Date().toISOString(),
    });

    await taskRegistry.recordReview({
      id: "review-1",
      taskId: "task-1",
      executionId: "exec-1",
      reviewerId: "reviewer-1",
      status: "approved",
      createdAt: new Date().toISOString(),
    });

    const history = await engine.getTaskHistory("task-1");

    expect(history.executions).toHaveLength(1);
    expect(history.reviews).toHaveLength(1);
  });

  test("lists blocked tasks in project", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    await taskRegistry.upsertTask(createTask({ id: "task-1", status: "blocked" }));
    await taskRegistry.upsertTask(createTask({ id: "task-2", status: "open" }));
    await taskRegistry.upsertTask(createTask({ id: "task-3", status: "blocked" }));

    const blocked = await engine.getBlockedTasks("project-1");

    expect(blocked).toHaveLength(2);
    expect(blocked.map((t) => t.id)).toContain("task-1");
    expect(blocked.map((t) => t.id)).toContain("task-3");
  });

  test("retrieves all review feedback for a task", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    const task = createTask();
    await taskRegistry.upsertTask(task);

    await taskRegistry.recordReview({
      id: "review-1",
      taskId: "task-1",
      executionId: "exec-1",
      reviewerId: "reviewer-1",
      status: "rejected",
      createdAt: new Date().toISOString(),
      feedback: "Needs more tests",
    });

    await taskRegistry.recordReview({
      id: "review-2",
      taskId: "task-1",
      executionId: "exec-2",
      reviewerId: "reviewer-1",
      status: "approved",
      createdAt: new Date().toISOString(),
      feedback: "Looks good now",
    });

    const feedback = await engine.getReviewFeedback("task-1");

    expect(feedback).toHaveLength(2);
    expect(feedback).toContain("Needs more tests");
    expect(feedback).toContain("Looks good now");
  });

  test("handles blocked by relationships", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    const blocker = createTask({ id: "task-blocker" });
    const blocked = createTask({
      id: "task-1",
      blockedBy: ["task-blocker"],
    });

    await taskRegistry.upsertTask(blocker);
    await taskRegistry.upsertTask(blocked);

    const context = await engine.getTaskContext("project-1", "task-1");

    expect(context.blockedBy).toHaveLength(1);
    expect(context.blockedBy?.[0]?.id).toBe("task-blocker");
  });

  test("handles missing blockers gracefully", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const engine = createContextEngine(taskRegistry, eventSpine);

    const task = createTask({
      id: "task-1",
      blockedBy: ["non-existent-task"],
    });

    await taskRegistry.upsertTask(task);

    const context = await engine.getTaskContext("project-1", "task-1");

    expect(context.blockedBy).toHaveLength(0);
  });
});
