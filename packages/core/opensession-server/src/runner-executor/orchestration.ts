/**
 * Mission Control orchestration engine.
 *
 * Coordinates agents through a state machine driven by the event spine.
 * Different phases (architect → builder → reviewer → tester → release)
 * are orchestrated based on event outcomes.
 */

import type { DurableTaskRegistry } from "./durable-task-registry";
import type { DurableAgentRegistry } from "./durable-agent-registry";
import type { EventSpine } from "./event-spine";
import type { ContextEngine } from "./context-engine";
import type { MissionControlTask } from "./mission-control-task";
import type { AgentRole } from "./mission-control-agent";

export interface WorkEnvelope {
  taskId: string;
  agentId: string;
  role: AgentRole;
  context: unknown;
}

/**
 * Orchestration handles the flow of work through agent phases.
 */
export interface Orchestration {
  /**
   * Start work on a task, assigning the architect.
   */
  startTask(projectId: string, taskId: string): Promise<void>;

  /**
   * Respond to a task execution result.
   */
  handleExecutionComplete(
    taskId: string,
    executionId: string,
    success: boolean,
    result?: string,
  ): Promise<void>;

  /**
   * Respond to a code review.
   */
  handleReviewComplete(
    taskId: string,
    executionId: string,
    approved: boolean,
    feedback?: string,
  ): Promise<void>;

  /**
   * Get the next agent role for a task based on its current state.
   */
  getNextRole(task: MissionControlTask): AgentRole | null;

  /**
   * Create work envelope for an agent to execute.
   */
  createWorkEnvelope(
    projectId: string,
    taskId: string,
    agentId: string,
  ): Promise<WorkEnvelope>;
}

export function createOrchestration(
  taskRegistry: DurableTaskRegistry,
  agentRegistry: DurableAgentRegistry,
  eventSpine: EventSpine,
  contextEngine: ContextEngine,
): Orchestration {
  const eventSequences = new Map<string, number>();

  function getNextSequence(sessionId: string): number {
    const current = eventSequences.get(sessionId) ?? 0;
    eventSequences.set(sessionId, current + 1);
    return current;
  }

  return {
    async startTask(projectId: string, taskId: string): Promise<void> {
      const task = await taskRegistry.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // Start with architect phase
      const updated = {
        ...task,
        status: "in_progress" as const,
        updatedAt: new Date().toISOString(),
      };
      await taskRegistry.upsertTask(updated);

      // Emit TaskStarted event
      await eventSpine.record({
        kind: "task.created",
        id: { sessionId: projectId, eventSequence: getNextSequence(projectId) },
        timestamp: new Date().toISOString(),
        taskId,
        title: task.title,
        description: task.description,
      });
    },

    async handleExecutionComplete(
      taskId: string,
      executionId: string,
      success: boolean,
      result?: string,
    ): Promise<void> {
      if (success) {
        // Move to review phase
        await eventSpine.record({
          kind: "agent.execution_completed",
          id: { sessionId: taskId, eventSequence: getNextSequence(taskId) },
          timestamp: new Date().toISOString(),
          agentId: executionId,
          executionId,
          status: "succeeded",
          result,
        });
      } else {
        // Record failure, could trigger retry
        await eventSpine.record({
          kind: "agent.execution_completed",
          id: { sessionId: taskId, eventSequence: getNextSequence(taskId) },
          timestamp: new Date().toISOString(),
          agentId: executionId,
          executionId,
          status: "failed",
          result: result || "Execution failed",
        });
      }
    },

    async handleReviewComplete(
      taskId: string,
      executionId: string,
      approved: boolean,
      feedback?: string,
    ): Promise<void> {
      const task = await taskRegistry.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      if (approved) {
        // Move to test phase or complete
        const updated = {
          ...task,
          status: "completed" as const,
          updatedAt: new Date().toISOString(),
        };
        await taskRegistry.upsertTask(updated);

        await eventSpine.record({
          kind: "review.completed",
          id: { sessionId: taskId, eventSequence: getNextSequence(taskId) },
          timestamp: new Date().toISOString(),
          executionId,
          status: "approved",
          feedback,
        });
      } else {
        // Send back to builder
        const updated = {
          ...task,
          status: "open" as const,
          updatedAt: new Date().toISOString(),
        };
        await taskRegistry.upsertTask(updated);

        await eventSpine.record({
          kind: "review.completed",
          id: { sessionId: taskId, eventSequence: getNextSequence(taskId) },
          timestamp: new Date().toISOString(),
          executionId,
          status: "rejected",
          feedback,
        });
      }
    },

    getNextRole(task: MissionControlTask): AgentRole | null {
      if (task.status === "open") return "architect";
      if (task.status === "in_progress") return "builder";
      if (task.status === "blocked") return null;
      if (task.status === "completed" || task.status === "failed") return null;
      return null;
    },

    async createWorkEnvelope(
      projectId: string,
      taskId: string,
      agentId: string,
    ): Promise<WorkEnvelope> {
      const task = await taskRegistry.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const agent = await agentRegistry.getAgent(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);

      const context = await contextEngine.getTaskContext(projectId, taskId);

      return {
        taskId,
        agentId,
        role: agent.role,
        context,
      };
    },
  };
}

// Type definitions for orchestration events emitted to event spine
export type OrchestrationEvent =
  | { kind: "task.created"; taskId: string; title: string }
  | { kind: "agent.execution_completed"; executionId: string; status: string }
  | { kind: "review.completed"; executionId: string; status: string };
