/**
 * Slack Conversation Model for Mission Control.
 *
 * Durable model linking Slack interactions to Mission Control state.
 * Slack is the human surface; FeltDB is the canonical durable history.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { randomUUIDv7 } from "bun";

/**
 * Slack conversation linking Slack messages to Mission Control tasks/decisions.
 */
export interface SlackConversation {
  id: string;
  projectId: string;
  slackWorkspaceId: string;
  channelId: string;
  threadTs?: string; // Slack thread timestamp
  messageTs?: string; // Initial message timestamp
  taskId?: string; // Linked Mission Control task
  agentId?: string; // Agent involved in conversation
  context: Record<string, unknown>; // JSON serializable context
  participants: string[]; // Slack user IDs
  createdAt: string;
  updatedAt: string;
}

/**
 * Slack conversation event record.
 */
export interface SlackConversationEvent {
  id: string;
  conversationId: string;
  eventType:
    | "message"
    | "reaction"
    | "command"
    | "status_update"
    | "decision"
    | "error";
  slackMessageTs?: string;
  slackThreadTs?: string;
  userId: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Stored row for Slack conversations.
 */
interface StoredSlackConversation {
  id: string;
  projectId: string;
  slackWorkspaceId: string;
  channelId: string;
  threadTs?: string;
  messageTs?: string;
  taskId?: string;
  agentId?: string;
  context: string; // JSON
  participants: string; // JSON array
  createdAt: string;
  updatedAt: string;
}

/**
 * Stored row for conversation events.
 */
interface StoredConversationEvent {
  id: string;
  conversationId: string;
  eventType: string;
  slackMessageTs?: string;
  slackThreadTs?: string;
  userId: string;
  content: string;
  metadata?: string; // JSON
  timestamp: string;
}

/**
 * Slack Conversation Model Interface.
 */
export interface SlackConversationModelInterface {
  // Conversation CRUD
  createConversation(
    conversation: SlackConversation,
  ): Promise<void>;
  getConversation(id: string): Promise<SlackConversation | undefined>;
  getConversationByThread(
    channelId: string,
    threadTs: string,
  ): Promise<SlackConversation | undefined>;
  listConversations(projectId: string): Promise<SlackConversation[]>;
  updateConversation(conversation: SlackConversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  // Events
  recordEvent(event: SlackConversationEvent): Promise<void>;
  getEventsByConversation(conversationId: string): Promise<SlackConversationEvent[]>;
  listRecentEvents(
    projectId: string,
    limit: number,
  ): Promise<SlackConversationEvent[]>;
}

/**
 * Open or create a Slack conversation model.
 */
export function openSlackConversationModel(
  path: string,
): SlackConversationModelInterface {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-slack-conversations",
  });

  const CONVERSATIONS_COLLECTION = "slack_conversations";
  const EVENTS_COLLECTION = "slack_conversation_events";

  return {
    async createConversation(
      conversation: SlackConversation,
    ): Promise<void> {
      const row: StoredSlackConversation = {
        id: conversation.id,
        projectId: conversation.projectId,
        slackWorkspaceId: conversation.slackWorkspaceId,
        channelId: conversation.channelId,
        threadTs: conversation.threadTs,
        messageTs: conversation.messageTs,
        taskId: conversation.taskId,
        agentId: conversation.agentId,
        context: JSON.stringify(conversation.context),
        participants: JSON.stringify(conversation.participants),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredSlackConversation>(CONVERSATIONS_COLLECTION).set(
          conversation.id,
          row,
        );
      });
    },

    async getConversation(
      id: string,
    ): Promise<SlackConversation | undefined> {
      const row = await db
        .collection<StoredSlackConversation>(CONVERSATIONS_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        projectId: row.projectId,
        slackWorkspaceId: row.slackWorkspaceId,
        channelId: row.channelId,
        threadTs: row.threadTs,
        messageTs: row.messageTs,
        taskId: row.taskId,
        agentId: row.agentId,
        context: JSON.parse(row.context),
        participants: JSON.parse(row.participants),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async getConversationByThread(
      channelId: string,
      threadTs: string,
    ): Promise<SlackConversation | undefined> {
      const rows = await db
        .collection<StoredSlackConversation>(CONVERSATIONS_COLLECTION)
        .find({ channelId, threadTs });

      if (rows.length === 0) return undefined;
      const row = rows[0];
      return {
        id: row.id,
        projectId: row.projectId,
        slackWorkspaceId: row.slackWorkspaceId,
        channelId: row.channelId,
        threadTs: row.threadTs,
        messageTs: row.messageTs,
        taskId: row.taskId,
        agentId: row.agentId,
        context: JSON.parse(row.context),
        participants: JSON.parse(row.participants),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async listConversations(
      projectId: string,
    ): Promise<SlackConversation[]> {
      const rows = await db
        .collection<StoredSlackConversation>(CONVERSATIONS_COLLECTION)
        .find({ projectId });

      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        slackWorkspaceId: row.slackWorkspaceId,
        channelId: row.channelId,
        threadTs: row.threadTs,
        messageTs: row.messageTs,
        taskId: row.taskId,
        agentId: row.agentId,
        context: JSON.parse(row.context),
        participants: JSON.parse(row.participants),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async updateConversation(
      conversation: SlackConversation,
    ): Promise<void> {
      const row: StoredSlackConversation = {
        id: conversation.id,
        projectId: conversation.projectId,
        slackWorkspaceId: conversation.slackWorkspaceId,
        channelId: conversation.channelId,
        threadTs: conversation.threadTs,
        messageTs: conversation.messageTs,
        taskId: conversation.taskId,
        agentId: conversation.agentId,
        context: JSON.stringify(conversation.context),
        participants: JSON.stringify(conversation.participants),
        createdAt: conversation.createdAt,
        updatedAt: new Date().toISOString(),
      };

      await db.transaction((tx) => {
        tx.collection<StoredSlackConversation>(CONVERSATIONS_COLLECTION).set(
          conversation.id,
          row,
        );
      });
    },

    async deleteConversation(id: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredSlackConversation>(CONVERSATIONS_COLLECTION).delete(id);
      });
    },

    async recordEvent(event: SlackConversationEvent): Promise<void> {
      const row: StoredConversationEvent = {
        id: event.id,
        conversationId: event.conversationId,
        eventType: event.eventType,
        slackMessageTs: event.slackMessageTs,
        slackThreadTs: event.slackThreadTs,
        userId: event.userId,
        content: event.content,
        metadata: event.metadata ? JSON.stringify(event.metadata) : undefined,
        timestamp: event.timestamp,
      };

      await db.transaction((tx) => {
        tx.collection<StoredConversationEvent>(EVENTS_COLLECTION).set(
          event.id,
          row,
        );
      });
    },

    async getEventsByConversation(
      conversationId: string,
    ): Promise<SlackConversationEvent[]> {
      const rows = await db
        .collection<StoredConversationEvent>(EVENTS_COLLECTION)
        .find({ conversationId });

      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        eventType: row.eventType as any,
        slackMessageTs: row.slackMessageTs,
        slackThreadTs: row.slackThreadTs,
        userId: row.userId,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        timestamp: row.timestamp,
      }));
    },

    async listRecentEvents(
      projectId: string,
      limit: number,
    ): Promise<SlackConversationEvent[]> {
      // Get all conversations for project first
      const conversations = await db
        .collection<StoredSlackConversation>(CONVERSATIONS_COLLECTION)
        .find({ projectId });

      const conversationIds = conversations.map((c) => c.id);

      // Get all events for those conversations
      const allEvents = await db
        .collection<StoredConversationEvent>(EVENTS_COLLECTION)
        .all();

      // Filter to project conversations, sort by timestamp, limit
      const filtered = allEvents
        .filter((e) => conversationIds.includes(e.conversationId))
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )
        .slice(0, limit);

      return filtered.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        eventType: row.eventType as any,
        slackMessageTs: row.slackMessageTs,
        slackThreadTs: row.slackThreadTs,
        userId: row.userId,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        timestamp: row.timestamp,
      }));
    },
  };
}
