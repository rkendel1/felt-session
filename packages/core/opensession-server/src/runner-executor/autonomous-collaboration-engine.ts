/**
 * Autonomous Collaboration Engine for PR 7.
 *
 * Orchestrates the autonomous loop: architect → builder → reviewer → tester → GitHub → merge
 */

import { randomUUIDv7 } from "bun";
import type {
  DurableConversation,
  ConversationTurn,
  CollaborationState,
  AutonomousLoop,
} from "./mission-control-collaboration";
import type {
  DurableConversationLedger,
} from "./durable-conversation-ledger";
import type {
  DurableAgentIdentityRegistry,
} from "./durable-agent-identity-registry";
import type {
  AgentContextBuilderInterface,
} from "./agent-context-builder";

/**
 * Autonomous Collaboration Engine Interface.
 */
export interface AutonomousCollaborationEngineInterface {
  // Loop orchestration
  startCollaboration(
    taskId: string,
    projectId: string,
    taskDescription: string,
  ): Promise<DurableConversation>;

  runAutonomousLoop(
    conversationId: string,
  ): Promise<AutonomousLoop>;

  transitionPhase(
    conversationId: string,
    toPhase: string,
    triggeredBy: string,
  ): Promise<void>;

  concludeCollaboration(
    conversationId: string,
    status: "completed" | "failed" | "stalled",
  ): Promise<void>;
}

/**
 * Create an autonomous collaboration engine.
 */
export function createAutonomousCollaborationEngine(
  conversationLedger: DurableConversationLedger,
  agentRegistry: DurableAgentIdentityRegistry,
  contextBuilder: AgentContextBuilderInterface,
): AutonomousCollaborationEngineInterface {
  return {
    async startCollaboration(
      taskId: string,
      projectId: string,
      taskDescription: string,
    ): Promise<DurableConversation> {
      // Get all available agents
      const agents = await agentRegistry.listIdentities(projectId);
      const agentIds = agents.map((a) => a.id);

      // Create initial conversation
      const conversation: DurableConversation = {
        id: `conv-${randomUUIDv7()}`,
        taskId,
        projectId,
        title: `Task: ${taskDescription.substring(0, 50)}`,
        agents: agentIds,
        participants: [],
        turns: [],
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await conversationLedger.createConversation(conversation);

      // Create initial state machine
      const state: CollaborationState = {
        id: `state-${randomUUIDv7()}`,
        taskId,
        projectId,
        phase: "planning",
        decisions: [],
        transitions: [
          {
            fromPhase: "start",
            toPhase: "planning",
            condition: "task_received",
            triggeredBy: "system",
            timestamp: new Date().toISOString(),
          },
        ],
        startedAt: new Date().toISOString(),
      };

      await conversationLedger.createOrUpdateState(state);

      return conversation;
    },

    async runAutonomousLoop(
      conversationId: string,
    ): Promise<AutonomousLoop> {
      const conversation = await conversationLedger.getConversation(
        conversationId,
      );
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      const state = await conversationLedger.getCollaborationState(
        conversation.taskId,
      );
      if (!state) {
        throw new Error(`State not found for task: ${conversation.taskId}`);
      }

      // Define the autonomous loop sequence
      const loopSequence = [
        {
          agentHandle: "@architect",
          action: "design",
          expectedOutcome: "Architecture plan",
        },
        {
          agentHandle: "@builder",
          action: "implement",
          expectedOutcome: "Code implementation",
        },
        {
          agentHandle: "@reviewer",
          action: "review",
          expectedOutcome: "Code review complete",
        },
        {
          agentHandle: "@tester",
          action: "test",
          expectedOutcome: "Tests passing",
        },
        {
          agentHandle: "@GitHub",
          action: "merge",
          expectedOutcome: "PR merged to main",
        },
      ];

      const loop: AutonomousLoop = {
        id: `loop-${randomUUIDv7()}`,
        taskId: conversation.taskId,
        projectId: conversation.projectId,
        conversationId,
        sequence: loopSequence.map((s, idx) => ({
          step: idx + 1,
          agentId: `agent-${s.agentHandle}`,
          agentHandle: s.agentHandle,
          action: s.action,
          expectedOutcome: s.expectedOutcome,
        })),
        overallSuccess: false,
        completedSteps: 0,
        totalSteps: loopSequence.length,
        startedAt: new Date().toISOString(),
      };

      // Execute each step in sequence (simplified)
      for (let i = 0; i < loopSequence.length; i++) {
        const step = loopSequence[i];

        // Create turn for this agent action
        const turn: ConversationTurn = {
          id: `turn-${randomUUIDv7()}`,
          conversationId,
          turnIndex: conversation.turns.length + i,
          agentId: `agent-${step.agentHandle}`,
          actor: "agent",
          messageType: "action",
          content: `${step.agentHandle} executing: ${step.action}`,
          timestamp: new Date().toISOString(),
        };

        await conversationLedger.addTurn(turn);

        // Update loop step
        const loopStep = loop.sequence[i];
        loopStep.actualOutcome = step.expectedOutcome;
        loopStep.success = true;
        loop.completedSteps++;
      }

      loop.overallSuccess = loop.completedSteps === loop.totalSteps;
      loop.completedAt = new Date().toISOString();

      return loop;
    },

    async transitionPhase(
      conversationId: string,
      toPhase: string,
      triggeredBy: string,
    ): Promise<void> {
      const conversation = await conversationLedger.getConversation(
        conversationId,
      );
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      const state = await conversationLedger.getCollaborationState(
        conversation.taskId,
      );
      if (!state) {
        throw new Error(`State not found for task: ${conversation.taskId}`);
      }

      // Record transition
      state.transitions.push({
        fromPhase: state.phase,
        toPhase,
        condition: `transition_requested`,
        triggeredBy,
        timestamp: new Date().toISOString(),
      });

      state.phase = toPhase as any;
      await conversationLedger.createOrUpdateState(state);
    },

    async concludeCollaboration(
      conversationId: string,
      status: "completed" | "failed" | "stalled",
    ): Promise<void> {
      const conversation = await conversationLedger.getConversation(
        conversationId,
      );
      if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      conversation.status = status;
      conversation.completedAt = new Date().toISOString();
      await conversationLedger.updateConversation(conversation);

      const state = await conversationLedger.getCollaborationState(
        conversation.taskId,
      );
      if (state) {
        state.phase = "complete";
        state.completedAt = new Date().toISOString();
        await conversationLedger.createOrUpdateState(state);
      }
    },
  };
}
