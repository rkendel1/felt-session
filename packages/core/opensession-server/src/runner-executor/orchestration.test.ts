/**
 * Tests for orchestration engine.
 *
 * Proves that agents can be coordinated through event-driven orchestration,
 * with proper phase transitions and feedback flow.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableTaskRegistry } from "./durable-task-registry";
import { testFeltDb } from "./test-feltdb";
import { openDurableAgentRegistry, createStandardAgent } from "./durable-agent-registry";
import { openFeltDbEventSpine } from "./feltdb-event-spine";
import { createContextEngine } from "./context-engine";
import { createOrchestration } from "./orchestration";
import type { MissionControlTask } from "./mission-control-task";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestration-"));
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

describe("Orchestration", () => {
  test("starts task and transitions to in_progress", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    const task = createTask();
    await taskRegistry.upsertTask(task);

    await orchestration.startTask("project-1", "task-1");

    const updated = await taskRegistry.getTask("task-1");
    expect(updated?.status).toBe("in_progress");
  });

  test("determines next role based on task status", () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    const openTask = createTask({ status: "open" });
    const inProgressTask = createTask({ status: "in_progress" });
    const completedTask = createTask({ status: "completed" });
    const blockedTask = createTask({ status: "blocked" });

    expect(orchestration.getNextRole(openTask)).toBe("architect");
    expect(orchestration.getNextRole(inProgressTask)).toBe("builder");
    expect(orchestration.getNextRole(completedTask)).toBeNull();
    expect(orchestration.getNextRole(blockedTask)).toBeNull();
  });

  test("handles successful execution completion", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    const task = createTask();
    await taskRegistry.upsertTask(task);

    await orchestration.handleExecutionComplete(
      "task-1",
      "executor-1",
      true,
      "Feature completed",
    );

    const events = await eventSpine.range("task-1", 0, 10);
    expect(events.length).toBeGreaterThan(0);
  });

  test("handles failed execution", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    const task = createTask();
    await taskRegistry.upsertTask(task);

    await orchestration.handleExecutionComplete(
      "task-1",
      "executor-1",
      false,
      "Compilation error",
    );

    const events = await eventSpine.range("task-1", 0, 10);
    const failureEvent = events.find(
      (e) => e.kind === "agent.execution.completed" && e.state === "failed",
    );
    expect(failureEvent).toBeTruthy();
  });

  test("handles approved review", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    const task = createTask({ status: "in_progress" });
    await taskRegistry.upsertTask(task);

    await orchestration.handleReviewComplete(
      "task-1",
      "executor-1",
      true,
      "Looks good!",
    );

    const updated = await taskRegistry.getTask("task-1");
    expect(updated?.status).toBe("completed");
  });

  test("handles rejected review", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    const task = createTask({ status: "in_progress" });
    await taskRegistry.upsertTask(task);

    await orchestration.handleReviewComplete(
      "task-1",
      "executor-1",
      false,
      "Needs error handling",
    );

    const updated = await taskRegistry.getTask("task-1");
    expect(updated?.status).toBe("open");
  });

  test("creates work envelope for agent", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    const task = createTask();
    const agent = createStandardAgent("builder-1", "builder", "anthropic", "claude-opus");

    await taskRegistry.upsertTask(task);
    await agentRegistry.upsertAgent(agent);

    const envelope = await orchestration.createWorkEnvelope(
      "project-1",
      "task-1",
      "builder-1",
    );

    expect(envelope.taskId).toBe("task-1");
    expect(envelope.agentId).toBe("builder-1");
    expect(envelope.role).toBe("builder");
    expect(envelope.context).toBeTruthy();
  });

  test("orchestration handles missing resources gracefully", async () => {
    const taskRegistry = openDurableTaskRegistry(testFeltDb(join(tmpRoot(), "tasks")));
    const agentRegistry = openDurableAgentRegistry(testFeltDb(join(tmpRoot(), "agents")));
    const eventSpine = openFeltDbEventSpine(testFeltDb(join(tmpRoot(), "events")));
    const contextEngine = createContextEngine(taskRegistry, eventSpine);
    const orchestration = createOrchestration(
      taskRegistry,
      agentRegistry,
      eventSpine,
      contextEngine,
    );

    try {
      await orchestration.createWorkEnvelope(
        "project-1",
        "non-existent-task",
        "agent-1",
      );
      expect(false).toBe(true); // Should not reach here
    } catch (e) {
      expect((e as Error).message).toContain("not found");
    }
  });
});
