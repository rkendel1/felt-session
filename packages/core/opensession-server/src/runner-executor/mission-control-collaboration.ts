/**
 * PR 7: Unified Agent Context and Autonomous Collaboration types.
 *
 * Models durable conversations, agent context, and autonomous decision-making.
 */

/**
 * Durable conversation turn - a single message or action in a conversation.
 */
export interface ConversationTurn {
  id: string;
  conversationId: string;
  turnIndex: number;
  agentId: string;
  actor: "human" | "agent" | "system";
  messageType:
    | "user_message"
    | "agent_response"
    | "decision"
    | "action"
    | "observation"
    | "error"
    | "status";
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Durable conversation linking all interactions for a task.
 */
export interface DurableConversation {
  id: string;
  taskId: string;
  projectId: string;
  title: string;
  agents: string[]; // Agent IDs involved
  participants: string[]; // User IDs or agent handles
  turns: ConversationTurn[];
  status: "active" | "completed" | "failed" | "stalled";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * Decision point in agent collaboration.
 */
export interface AgentDecision {
  id: string;
  conversationId: string;
  turnIndex: number;
  agentId: string;
  decision: string;
  reasoning: string;
  confidence: number; // 0-1
  alternatives?: string[];
  approvalRequired?: boolean;
  approvedBy?: string[];
  timestamp: string;
}

/**
 * Agent's context for a task.
 */
export interface AgentTaskContext {
  taskId: string;
  agentId: string;
  projectId: string;
  role: string;
  task: {
    title: string;
    description: string;
    criteria: string[];
    constraints: string[];
  };
  codeContext?: {
    relevantFiles: string[];
    changedSymbols?: string[];
    riskscore?: number;
  };
  previousAttempts?: Array<{
    turnIndex: number;
    action: string;
    result: string;
    success: boolean;
  }>;
  currentState: {
    phase: string;
    blockers?: string[];
    progress: number; // 0-100
  };
  graphContext?: Record<string, unknown>;
  conversationHistory: ConversationTurn[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Autonomous collaboration state machine.
 */
export interface CollaborationState {
  id: string;
  taskId: string;
  projectId: string;
  phase:
    | "planning"
    | "design"
    | "implementation"
    | "review"
    | "testing"
    | "deployment"
    | "complete"
    | "failed";
  activeAgentId?: string;
  decisions: AgentDecision[];
  transitions: Array<{
    fromPhase: string;
    toPhase: string;
    condition: string;
    triggeredBy: string; // Agent ID
    timestamp: string;
  }>;
  startedAt: string;
  completedAt?: string;
}

/**
 * Autonomous loop execution.
 */
export interface AutonomousLoop {
  id: string;
  taskId: string;
  projectId: string;
  conversationId: string;
  sequence: Array<{
    step: number;
    agentId: string;
    agentHandle: string;
    action: string;
    expectedOutcome: string;
    actualOutcome?: string;
    success?: boolean;
    errorMessage?: string;
    duration?: number;
  }>;
  overallSuccess: boolean;
  completedSteps: number;
  totalSteps: number;
  startedAt: string;
  completedAt?: string;
}

/**
 * Task audit trail entry.
 */
export interface AuditEntry {
  id: string;
  taskId: string;
  projectId: string;
  timestamp: string;
  actor: string;
  action: string;
  changes?: Record<string, unknown>;
  result: "success" | "failure" | "partial";
  metadata?: Record<string, unknown>;
}
