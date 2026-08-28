/**
 * Agent Context Builder for PR 7.
 *
 * Assembles rich context for agents including task, code, history, and graph data.
 */

import type { AgentTaskContext, ConversationTurn } from "./mission-control-collaboration";
import type {
  DurableConversationLedger,
} from "./durable-conversation-ledger";
import type {
  DurableRepositoryFileRegistry,
} from "./durable-repository-file-registry";
import type { GraphAnalyzerInterface } from "./graph-analyzer";
import type { TaskCodeContextManagerInterface } from "./task-code-context";

/**
 * Agent Context Builder Interface.
 */
export interface AgentContextBuilderInterface {
  buildContext(
    taskId: string,
    agentId: string,
    agentRole: string,
    projectId: string,
    taskTitle: string,
    taskDescription: string,
    taskCriteria: string[],
  ): Promise<AgentTaskContext>;

  updateContextProgress(
    context: AgentTaskContext,
    progressPercent: number,
    phase: string,
  ): Promise<AgentTaskContext>;

  recordAttempt(
    context: AgentTaskContext,
    turnIndex: number,
    action: string,
    result: string,
    success: boolean,
  ): Promise<AgentTaskContext>;

  addBlocker(context: AgentTaskContext, blocker: string): Promise<AgentTaskContext>;
  resolveBlocker(context: AgentTaskContext, blocker: string): Promise<AgentTaskContext>;
}

/**
 * Create an agent context builder.
 */
export function createAgentContextBuilder(
  conversationLedger: DurableConversationLedger,
  fileRegistry?: DurableRepositoryFileRegistry,
  analyzer?: GraphAnalyzerInterface,
  taskContextManager?: TaskCodeContextManagerInterface,
): AgentContextBuilderInterface {
  return {
    async buildContext(
      taskId: string,
      agentId: string,
      agentRole: string,
      projectId: string,
      taskTitle: string,
      taskDescription: string,
      taskCriteria: string[],
    ): Promise<AgentTaskContext> {
      // Get previous conversation for this task
      const conversation = await conversationLedger.getConversationByTask(taskId);
      const conversationHistory = conversation?.turns || [];

      // Get code context if available
      let codeContext = undefined;
      if (taskContextManager) {
        const taskCode = await taskContextManager.getContext(taskId);
        if (taskCode) {
          codeContext = {
            relevantFiles: taskCode.relevantFiles.map((f) => f.path),
            riskscore: 0.5,
          };
        }
      }

      // Extract previous attempts from history
      const previousAttempts = conversationHistory
        .filter((t) => t.actor === "agent")
        .map((t, idx) => ({
          turnIndex: t.turnIndex,
          action: t.messageType,
          result: t.content.substring(0, 100),
          success: t.messageType !== "error",
        }));

      return {
        taskId,
        agentId,
        projectId,
        role: agentRole,
        task: {
          title: taskTitle,
          description: taskDescription,
          criteria: taskCriteria,
          constraints: [],
        },
        codeContext,
        previousAttempts: previousAttempts.slice(-5), // Last 5 attempts
        currentState: {
          phase: "planning",
          blockers: [],
          progress: 0,
        },
        conversationHistory: conversationHistory.slice(-10), // Last 10 turns
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },

    async updateContextProgress(
      context: AgentTaskContext,
      progressPercent: number,
      phase: string,
    ): Promise<AgentTaskContext> {
      return {
        ...context,
        currentState: {
          ...context.currentState,
          progress: progressPercent,
          phase,
        },
        updatedAt: new Date().toISOString(),
      };
    },

    async recordAttempt(
      context: AgentTaskContext,
      turnIndex: number,
      action: string,
      result: string,
      success: boolean,
    ): Promise<AgentTaskContext> {
      const attempt = {
        turnIndex,
        action,
        result,
        success,
      };

      return {
        ...context,
        previousAttempts: [
          ...(context.previousAttempts || []),
          attempt,
        ].slice(-5), // Keep last 5
        updatedAt: new Date().toISOString(),
      };
    },

    async addBlocker(
      context: AgentTaskContext,
      blocker: string,
    ): Promise<AgentTaskContext> {
      return {
        ...context,
        currentState: {
          ...context.currentState,
          blockers: [...(context.currentState.blockers || []), blocker],
        },
        updatedAt: new Date().toISOString(),
      };
    },

    async resolveBlocker(
      context: AgentTaskContext,
      blocker: string,
    ): Promise<AgentTaskContext> {
      return {
        ...context,
        currentState: {
          ...context.currentState,
          blockers: (context.currentState.blockers || []).filter(
            (b) => b !== blocker,
          ),
        },
        updatedAt: new Date().toISOString(),
      };
    },
  };
}
