/**
 * Durable Conversation Ledger backed by FeltDB.
 *
 * Stores all interactions causally linked across agents, users, and systems.
 * Conversations are the audit trail of all Mission Control work.
 */

import type { StateFirstDB } from "@feltdb/core";
import { randomUUIDv7 } from "bun";
import type {
  DurableConversation,
  ConversationTurn,
  AgentDecision,
  CollaborationState,
  AutonomousLoop,
  AuditEntry,
} from "./mission-control-collaboration";

/**
 * Stored conversation row.
 */
interface StoredConversation {
  id: string;
  taskId: string;
  projectId: string;
  title: string;
  agents: DurableConversation["agents"];
  participants: DurableConversation["participants"];
  turnCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * Stored conversation turn row.
 */
interface StoredConversationTurn {
  id: string;
  conversationId: string;
  turnIndex: number;
  agentId: string;
  actor: string;
  messageType: string;
  content: string;
  metadata?: ConversationTurn["metadata"];
  timestamp: string;
}

/**
 * Stored decision row.
 */
interface StoredAgentDecision {
  id: string;
  conversationId: string;
  turnIndex: number;
  agentId: string;
  decision: string;
  reasoning: string;
  confidence: number;
  alternatives?: AgentDecision["alternatives"];
  approvalRequired?: boolean;
  approvedBy?: AgentDecision["approvedBy"];
  timestamp: string;
}

/**
 * Stored collaboration state row.
 */
interface StoredCollaborationState {
  id: string;
  taskId: string;
  projectId: string;
  phase: string;
  activeAgentId?: string;
  decisions: CollaborationState["decisions"];
  transitions: CollaborationState["transitions"];
  startedAt: string;
  completedAt?: string;
}

/**
 * Stored audit entry row.
 */
interface StoredAuditEntry {
  id: string;
  taskId: string;
  projectId: string;
  timestamp: string;
  actor: string;
  action: string;
  changes?: AuditEntry["changes"];
  result: string;
  metadata?: AuditEntry["metadata"];
}

/**
 * Durable Conversation Ledger Interface.
 */
export interface DurableConversationLedger {
  // Conversation CRUD
  createConversation(conversation: DurableConversation): Promise<void>;
  getConversation(id: string): Promise<DurableConversation | undefined>;
  getConversationByTask(taskId: string): Promise<DurableConversation | undefined>;
  listConversations(projectId: string): Promise<DurableConversation[]>;
  updateConversation(conversation: DurableConversation): Promise<void>;

  // Conversation turns
  addTurn(turn: ConversationTurn): Promise<void>;
  getTurn(id: string): Promise<ConversationTurn | undefined>;
  getTurnsByConversation(conversationId: string): Promise<ConversationTurn[]>;
  getRecentTurns(conversationId: string, limit: number): Promise<ConversationTurn[]>;

  // Decisions
  recordDecision(decision: AgentDecision): Promise<void>;
  getDecision(id: string): Promise<AgentDecision | undefined>;
  getDecisionsByConversation(conversationId: string): Promise<AgentDecision[]>;
  getDecisionsByAgent(agentId: string, projectId: string): Promise<AgentDecision[]>;

  // Collaboration state
  createOrUpdateState(state: CollaborationState): Promise<void>;
  getCollaborationState(taskId: string): Promise<CollaborationState | undefined>;

  // Audit trail
  addAuditEntry(entry: AuditEntry): Promise<void>;
  getAuditTrail(taskId: string): Promise<AuditEntry[]>;
  getAuditByActor(actor: string, projectId: string): Promise<AuditEntry[]>;

  // Analytics
  getConversationsByAgent(agentId: string, projectId: string): Promise<DurableConversation[]>;
  getConversationsByStatus(status: string, projectId: string): Promise<DurableConversation[]>;
}

/**
 * Open or create a durable conversation ledger.
 */
export function openDurableConversationLedger(
  db: StateFirstDB,
): DurableConversationLedger {

  const CONVERSATIONS_COLLECTION = "conversations";
  const TURNS_COLLECTION = "conversation_turns";
  const DECISIONS_COLLECTION = "agent_decisions";
  const STATES_COLLECTION = "collaboration_states";
  const AUDIT_COLLECTION = "audit_entries";

  return {
    async createConversation(
      conversation: DurableConversation,
    ): Promise<void> {
      const row: StoredConversation = {
        id: conversation.id,
        taskId: conversation.taskId,
        projectId: conversation.projectId,
        title: conversation.title,
        agents: conversation.agents,
        participants: conversation.participants,
        turnCount: conversation.turns.length,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        completedAt: conversation.completedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredConversation>(CONVERSATIONS_COLLECTION).set(
          conversation.id,
          row,
        );
      });
    },

    async getConversation(
      id: string,
    ): Promise<DurableConversation | undefined> {
      const row = await db
        .collection<StoredConversation>(CONVERSATIONS_COLLECTION)
        .get(id);
      if (!row) return undefined;

      const turns = await db
        .collection<StoredConversationTurn>(TURNS_COLLECTION)
        .find({ conversationId: id });

      return {
        id: row.id,
        taskId: row.taskId,
        projectId: row.projectId,
        title: row.title,
        agents: row.agents,
        participants: row.participants,
        turns: turns.map((t) => ({
          id: t.id,
          conversationId: t.conversationId,
          turnIndex: t.turnIndex,
          agentId: t.agentId,
          actor: t.actor as any,
          messageType: t.messageType as any,
          content: t.content,
          metadata: t.metadata,
          timestamp: t.timestamp,
        })),
        status: row.status as any,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
      };
    },

    async getConversationByTask(
      taskId: string,
    ): Promise<DurableConversation | undefined> {
      const rows = await db
        .collection<StoredConversation>(CONVERSATIONS_COLLECTION)
        .find({ taskId });

      if (rows.length === 0) return undefined;
      return this.getConversation(rows[0].id);
    },

    async listConversations(
      projectId: string,
    ): Promise<DurableConversation[]> {
      const rows = await db
        .collection<StoredConversation>(CONVERSATIONS_COLLECTION)
        .find({ projectId });

      const convs: DurableConversation[] = [];
      for (const row of rows) {
        const conv = await this.getConversation(row.id);
        if (conv) convs.push(conv);
      }
      return convs;
    },

    async updateConversation(
      conversation: DurableConversation,
    ): Promise<void> {
      const row: StoredConversation = {
        id: conversation.id,
        taskId: conversation.taskId,
        projectId: conversation.projectId,
        title: conversation.title,
        agents: conversation.agents,
        participants: conversation.participants,
        turnCount: conversation.turns.length,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: new Date().toISOString(),
        completedAt: conversation.completedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredConversation>(CONVERSATIONS_COLLECTION).set(
          conversation.id,
          row,
        );
      });
    },

    async addTurn(turn: ConversationTurn): Promise<void> {
      const row: StoredConversationTurn = {
        id: turn.id,
        conversationId: turn.conversationId,
        turnIndex: turn.turnIndex,
        agentId: turn.agentId,
        actor: turn.actor,
        messageType: turn.messageType,
        content: turn.content,
        metadata: turn.metadata,
        timestamp: turn.timestamp,
      };

      await db.transaction((tx) => {
        tx.collection<StoredConversationTurn>(TURNS_COLLECTION).set(turn.id, row);
      });
    },

    async getTurn(id: string): Promise<ConversationTurn | undefined> {
      const row = await db
        .collection<StoredConversationTurn>(TURNS_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        conversationId: row.conversationId,
        turnIndex: row.turnIndex,
        agentId: row.agentId,
        actor: row.actor as any,
        messageType: row.messageType as any,
        content: row.content,
        metadata: row.metadata,
        timestamp: row.timestamp,
      };
    },

    async getTurnsByConversation(
      conversationId: string,
    ): Promise<ConversationTurn[]> {
      const rows = await db
        .collection<StoredConversationTurn>(TURNS_COLLECTION)
        .find({ conversationId });

      return rows
        .sort((a, b) => a.turnIndex - b.turnIndex)
        .map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          turnIndex: r.turnIndex,
          agentId: r.agentId,
          actor: r.actor as any,
          messageType: r.messageType as any,
          content: r.content,
          metadata: r.metadata,
          timestamp: r.timestamp,
        }));
    },

    async getRecentTurns(
      conversationId: string,
      limit: number = 10,
    ): Promise<ConversationTurn[]> {
      const turns = await this.getTurnsByConversation(conversationId);
      return turns.slice(-limit);
    },

    async recordDecision(decision: AgentDecision): Promise<void> {
      const row: StoredAgentDecision = {
        id: decision.id,
        conversationId: decision.conversationId,
        turnIndex: decision.turnIndex,
        agentId: decision.agentId,
        decision: decision.decision,
        reasoning: decision.reasoning,
        confidence: decision.confidence,
        alternatives: decision.alternatives,
        approvalRequired: decision.approvalRequired,
        approvedBy: decision.approvedBy,
        timestamp: decision.timestamp,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentDecision>(DECISIONS_COLLECTION).set(
          decision.id,
          row,
        );
      });
    },

    async getDecision(id: string): Promise<AgentDecision | undefined> {
      const row = await db
        .collection<StoredAgentDecision>(DECISIONS_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        conversationId: row.conversationId,
        turnIndex: row.turnIndex,
        agentId: row.agentId,
        decision: row.decision,
        reasoning: row.reasoning,
        confidence: row.confidence,
        alternatives: row.alternatives,
        approvalRequired: row.approvalRequired,
        approvedBy: row.approvedBy,
        timestamp: row.timestamp,
      };
    },

    async getDecisionsByConversation(
      conversationId: string,
    ): Promise<AgentDecision[]> {
      const rows = await db
        .collection<StoredAgentDecision>(DECISIONS_COLLECTION)
        .find({ conversationId });

      return rows.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        turnIndex: r.turnIndex,
        agentId: r.agentId,
        decision: r.decision,
        reasoning: r.reasoning,
        confidence: r.confidence,
        alternatives: r.alternatives,
        approvalRequired: r.approvalRequired,
        approvedBy: r.approvedBy,
        timestamp: r.timestamp,
      }));
    },

    async getDecisionsByAgent(
      agentId: string,
      projectId: string,
    ): Promise<AgentDecision[]> {
      const decisions = await db
        .collection<StoredAgentDecision>(DECISIONS_COLLECTION)
        .find({ agentId });

      return decisions.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        turnIndex: r.turnIndex,
        agentId: r.agentId,
        decision: r.decision,
        reasoning: r.reasoning,
        confidence: r.confidence,
        alternatives: r.alternatives,
        approvalRequired: r.approvalRequired,
        approvedBy: r.approvedBy,
        timestamp: r.timestamp,
      }));
    },

    async createOrUpdateState(state: CollaborationState): Promise<void> {
      const row: StoredCollaborationState = {
        id: state.id,
        taskId: state.taskId,
        projectId: state.projectId,
        phase: state.phase,
        activeAgentId: state.activeAgentId,
        decisions: state.decisions,
        transitions: state.transitions,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredCollaborationState>(STATES_COLLECTION).set(
          state.taskId,
          row,
        );
      });
    },

    async getCollaborationState(
      taskId: string,
    ): Promise<CollaborationState | undefined> {
      const row = await db
        .collection<StoredCollaborationState>(STATES_COLLECTION)
        .get(taskId);
      if (!row) return undefined;
      return {
        id: row.id,
        taskId: row.taskId,
        projectId: row.projectId,
        phase: row.phase as any,
        activeAgentId: row.activeAgentId,
        decisions: row.decisions,
        transitions: row.transitions,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
      };
    },

    async addAuditEntry(entry: AuditEntry): Promise<void> {
      const row: StoredAuditEntry = {
        id: entry.id,
        taskId: entry.taskId,
        projectId: entry.projectId,
        timestamp: entry.timestamp,
        actor: entry.actor,
        action: entry.action,
        changes: entry.changes,
        result: entry.result,
        metadata: entry.metadata,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAuditEntry>(AUDIT_COLLECTION).set(entry.id, row);
      });
    },

    async getAuditTrail(taskId: string): Promise<AuditEntry[]> {
      const rows = await db
        .collection<StoredAuditEntry>(AUDIT_COLLECTION)
        .find({ taskId });

      return rows
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )
        .map((r) => ({
          id: r.id,
          taskId: r.taskId,
          projectId: r.projectId,
          timestamp: r.timestamp,
          actor: r.actor,
          action: r.action,
          changes: r.changes,
          result: r.result as any,
          metadata: r.metadata,
        }));
    },

    async getAuditByActor(
      actor: string,
      projectId: string,
    ): Promise<AuditEntry[]> {
      const rows = await db
        .collection<StoredAuditEntry>(AUDIT_COLLECTION)
        .find({ actor, projectId });

      return rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        projectId: r.projectId,
        timestamp: r.timestamp,
        actor: r.actor,
        action: r.action,
        changes: r.changes,
        result: r.result as any,
        metadata: r.metadata,
      }));
    },

    async getConversationsByAgent(
      agentId: string,
      projectId: string,
    ): Promise<DurableConversation[]> {
      const convs = await this.listConversations(projectId);
      return convs.filter((c) => c.agents.includes(agentId));
    },

    async getConversationsByStatus(
      status: string,
      projectId: string,
    ): Promise<DurableConversation[]> {
      const convs = await this.listConversations(projectId);
      return convs.filter((c) => c.status === status);
    },
  };
}
