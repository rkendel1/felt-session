/**
 * Durable Collaboration State Registry: Persistent storage for autonomous collaboration.
 *
 * Tracks each task's phase, transitions, evidence, and recovery metadata.
 * Used by AutonomousCollaborationOrchestrator.
 */

import { createFeltDB } from "@feltdb/core";
import type {
  CollaborationState,
  CollaborationPhase,
  PhaseTransition,
  CollaborationRecovery,
} from "./autonomous-collaboration-orchestrator";
import { randomUUIDv7 } from "bun";

export interface DurableCollaborationStateRegistry {
  /**
   * Create new collaboration state for a task.
   */
  createState(
    taskId: string,
    projectId: string
  ): Promise<CollaborationState>;

  /**
   * Get current state for a task.
   */
  getState(taskId: string): Promise<CollaborationState | undefined>;

  /**
   * Transition to a new phase.
   */
  transitionPhase(
    taskId: string,
    toPhase: CollaborationPhase,
    agentId: string,
    evidence: Array<{ type: string; ref: string }>
  ): Promise<PhaseTransition>;

  /**
   * Get all transitions for a task.
   */
  getTransitions(taskId: string): Promise<PhaseTransition[]>;

  /**
   * Mark phase as failed, track attempt count.
   */
  recordFailure(
    taskId: string,
    phase: CollaborationPhase,
    error: string
  ): Promise<void>;

  /**
   * Get recovery info for restart.
   */
  getRecoveryInfo(taskId: string): Promise<CollaborationRecovery | undefined>;

  /**
   * Conclude collaboration.
   */
  conclude(
    taskId: string,
    finalPhase: "RELEASED" | "FAILED"
  ): Promise<void>;

  /**
   * List active collaborations for a project.
   */
  listByProject(projectId: string): Promise<CollaborationState[]>;

  /**
   * Get collaborations by phase.
   */
  getByPhase(
    projectId: string,
    phase: CollaborationPhase
  ): Promise<CollaborationState[]>;
}

export function openDurableCollaborationStateRegistry(
  path: string
): DurableCollaborationStateRegistry {
  const db = createFeltDB({ path, namespace: "mission_control_collaboration" });
  const stateCollection = db.collection<CollaborationState>("states");
  const transitionCollection = db.collection<PhaseTransition>("transitions");
  const recoveryCollection = db.collection<CollaborationRecovery>("recovery");

  return {
    async createState(
      taskId: string,
      projectId: string
    ): Promise<CollaborationState> {
      const state: CollaborationState = {
        id: `collab-${randomUUIDv7()}`,
        taskId,
        projectId,
        phase: "TASK_CREATED",
        agentSequence: ["architect", "builder", "reviewer", "tester", "github"],
        currentAgentId: "architect",
        completedPhases: [],
        failedAttempts: 0,
        lastTransitionAt: new Date().toISOString(),
        transitions: [],
      };

      await db.transaction((tx) => {
        tx.insertOne(stateCollection, state);
      });

      return state;
    },

    async getState(taskId: string): Promise<CollaborationState | undefined> {
      return stateCollection.findOne({ taskId });
    },

    async transitionPhase(
      taskId: string,
      toPhase: CollaborationPhase,
      agentId: string,
      evidence: Array<{ type: string; ref: string }>
    ): Promise<PhaseTransition> {
      const state = await stateCollection.findOne({ taskId });
      if (!state) throw new Error(`No collaboration for task: ${taskId}`);

      const transition: PhaseTransition = {
        id: `trans-${randomUUIDv7()}`,
        taskId,
        fromPhase: state.phase,
        toPhase,
        transitionedBy: agentId,
        evidence: evidence.map((e) => ({
          ...e,
          timestamp: new Date().toISOString(),
        })),
        timestamp: new Date().toISOString(),
      };

      // Update state and record transition
      await db.transaction((tx) => {
        const updated: CollaborationState = {
          ...state,
          phase: toPhase,
          currentAgentId: agentId,
          lastTransitionAt: new Date().toISOString(),
          completedPhases: [
            ...state.completedPhases,
            state.phase,
          ],
        };

        tx.replaceOne(stateCollection, { taskId }, updated, false);
        tx.insertOne(transitionCollection, transition);
      });

      return transition;
    },

    async getTransitions(taskId: string): Promise<PhaseTransition[]> {
      const transitions = await transitionCollection.find({ taskId });
      return transitions.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() -
          new Date(b.timestamp).getTime()
      );
    },

    async recordFailure(
      taskId: string,
      phase: CollaborationPhase,
      error: string
    ): Promise<void> {
      const state = await stateCollection.findOne({ taskId });
      if (!state) throw new Error(`No collaboration for task: ${taskId}`);

      const updated: CollaborationState = {
        ...state,
        failedAttempts: state.failedAttempts + 1,
      };

      // Record recovery info
      const recovery: CollaborationRecovery = {
        taskId,
        currentPhase: phase,
        lastTransition: {
          timestamp: state.lastTransitionAt,
          agentId: state.currentAgentId,
          toPhase: state.phase,
        },
        incompleteAgent: {
          agentId: state.currentAgentId,
          phase,
        },
        contextSnapshot: {
          commitSha: "unknown",
          graphVersion: 0,
        },
        nextAction: `Retry ${phase} with feedback`,
      };

      await db.transaction((tx) => {
        tx.replaceOne(stateCollection, { taskId }, updated, false);
        tx.replaceOne(recoveryCollection, { taskId }, recovery, true);
      });
    },

    async getRecoveryInfo(
      taskId: string
    ): Promise<CollaborationRecovery | undefined> {
      return recoveryCollection.findOne({ taskId });
    },

    async conclude(
      taskId: string,
      finalPhase: "RELEASED" | "FAILED"
    ): Promise<void> {
      const state = await stateCollection.findOne({ taskId });
      if (!state) throw new Error(`No collaboration for task: ${taskId}`);

      const updated: CollaborationState = {
        ...state,
        phase: finalPhase,
        lastTransitionAt: new Date().toISOString(),
      };

      await db.transaction((tx) => {
        tx.replaceOne(stateCollection, { taskId }, updated, false);
      });
    },

    async listByProject(projectId: string): Promise<CollaborationState[]> {
      return stateCollection.find({ projectId });
    },

    async getByPhase(
      projectId: string,
      phase: CollaborationPhase
    ): Promise<CollaborationState[]> {
      return stateCollection.find({ projectId, phase });
    },
  };
}
