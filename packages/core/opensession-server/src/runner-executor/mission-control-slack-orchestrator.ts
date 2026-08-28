/**
 * Mission Control Slack Orchestrator.
 *
 * Main service coordinating Slack ↔ Mission Control integration.
 * Handles agent addressing, command routing, and channel management.
 */

import type { DurableProjectRegistry } from "./durable-project-registry";
import type {
  DurableAgentIdentityRegistry,
} from "./durable-agent-identity-registry";
import type {
  SlackChannelManagerInterface,
} from "./slack-channel-manager";
import type {
  SlackConversationModelInterface,
  SlackConversation,
  SlackConversationEvent,
} from "./slack-conversation-model";
import type { AgentIdentity } from "./mission-control-agent-identity";
import { randomUUIDv7 } from "bun";

/**
 * Parsed Slack command.
 */
export interface ParsedSlackCommand {
  projectId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  targetAgent: string;
  targetHandle: string;
  intent: string;
  entities: Record<string, unknown>;
  rawText: string;
  timestamp: string;
}

/**
 * Command routing result.
 */
export interface CommandRoutingResult {
  success: boolean;
  agentId: string;
  intent: string;
  message: string;
  conversationId: string;
}

/**
 * Autocomplete suggestion.
 */
export interface AgentAutocompleteSuggestion {
  handle: string;
  displayName: string;
  description?: string;
  kind: "role" | "integration";
}

/**
 * Mission Control Slack Orchestrator Interface.
 */
export interface MissionControlSlackOrchestratorInterface {
  // Channel management
  setupProjectChannel(
    projectId: string,
    slackWorkspaceId: string,
  ): Promise<string>;
  getProjectChannel(projectId: string): Promise<string | undefined>;

  // Command parsing and routing
  parseCommand(
    projectId: string,
    channelId: string,
    userId: string,
    messageText: string,
    threadTs?: string,
  ): Promise<ParsedSlackCommand | null>;
  routeCommand(
    command: ParsedSlackCommand,
  ): Promise<CommandRoutingResult>;

  // Agent addressing
  resolveAgentHandle(handle: string, projectId?: string): Promise<AgentIdentity | undefined>;
  listAgentsForProject(projectId: string): Promise<AgentIdentity[]>;
  getAgentAutocomplete(
    projectId?: string,
  ): Promise<AgentAutocompleteSuggestion[]>;

  // Conversation tracking
  createConversation(
    projectId: string,
    slackWorkspaceId: string,
    channelId: string,
    userId: string,
    taskId?: string,
    agentId?: string,
  ): Promise<SlackConversation>;
  recordConversationEvent(
    conversationId: string,
    eventType: SlackConversationEvent["eventType"],
    userId: string,
    content: string,
    slackMessageTs?: string,
    slackThreadTs?: string,
  ): Promise<void>;
}

/**
 * Create a Mission Control Slack Orchestrator.
 */
export function createMissionControlSlackOrchestrator(
  projectRegistry: DurableProjectRegistry,
  agentIdentityRegistry: DurableAgentIdentityRegistry,
  slackChannelManager: SlackChannelManagerInterface,
  slackConversationModel: SlackConversationModelInterface,
): MissionControlSlackOrchestratorInterface {
  return {
    async setupProjectChannel(
      projectId: string,
      slackWorkspaceId: string,
    ): Promise<string> {
      const project = await projectRegistry.getProject(projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      // Check if channel already exists
      const existing = await slackChannelManager.getChannelByProject(projectId);
      if (existing) {
        return existing.channelId;
      }

      // Generate channel name
      const channelName = slackChannelManager.generateChannelName(project.name);

      // Create channel record
      const now = new Date().toISOString();
      const channel = {
        id: `ch-${randomUUIDv7()}`,
        projectId,
        slackWorkspaceId,
        channelId: `C${randomUUIDv7().substring(0, 12).toUpperCase()}`, // Placeholder Slack ID
        channelName,
        topic: `Project: ${project.name}`,
        description: `Coordination channel for project ${project.name}`,
        createdAt: now,
        updatedAt: now,
      };

      await slackChannelManager.createChannel(channel);
      return channel.channelId;
    },

    async getProjectChannel(projectId: string): Promise<string | undefined> {
      const channel = await slackChannelManager.getChannelByProject(projectId);
      return channel?.channelId;
    },

    async parseCommand(
      projectId: string,
      channelId: string,
      userId: string,
      messageText: string,
      threadTs?: string,
    ): Promise<ParsedSlackCommand | null> {
      // Extract @mentions from message
      // Pattern: @handle ... rest of command
      const mentionMatch = messageText.match(/@(\w+)\s+(.*)/);
      if (!mentionMatch) {
        return null;
      }

      const [, rawHandle, restOfMessage] = mentionMatch;
      const targetHandle = `@${rawHandle}`; // Add @ back for storage

      // Resolve agent by handle - try project-scoped first, then workspace-level
      let agent = await this.resolveAgentHandle(targetHandle, projectId);
      if (!agent) {
        // Try workspace-level agents if project-scoped not found
        agent = await this.resolveAgentHandle(targetHandle);
      }
      if (!agent) {
        return null;
      }

      // Parse intent from rest of message
      // Simplified: extract first meaningful verb
      const intentMatch = restOfMessage.match(/^(\w+)/);
      const intent = intentMatch ? intentMatch[1].toLowerCase() : "execute";

      // Extract entities (simple pattern: word followed by number/identifier)
      // e.g., "PR 42" → { pullRequest: 42 }
      const entities: Record<string, unknown> = {};
      const prMatch = restOfMessage.match(/PR\s+(\d+)/i);
      if (prMatch) entities.pullRequest = parseInt(prMatch[1], 10);

      const issueMatch = restOfMessage.match(/issue\s+(\d+)/i);
      if (issueMatch) entities.issue = parseInt(issueMatch[1], 10);

      const branchMatch = restOfMessage.match(/branch\s+([^\s]+)/i);
      if (branchMatch) entities.branch = branchMatch[1];

      return {
        projectId,
        channelId,
        userId,
        threadTs,
        targetAgent: agent.id,
        targetHandle,
        intent,
        entities,
        rawText: messageText,
        timestamp: new Date().toISOString(),
      };
    },

    async routeCommand(
      command: ParsedSlackCommand,
    ): Promise<CommandRoutingResult> {
      // Create conversation to track this interaction
      const conversation = await this.createConversation(
        command.projectId,
        "", // slackWorkspaceId would be provided in real usage
        command.channelId,
        command.userId,
        undefined,
        command.targetAgent,
      );

      // Record command as an event
      await this.recordConversationEvent(
        conversation.id,
        "command",
        command.userId,
        command.rawText,
      );

      // In a full implementation, this would:
      // 1. Route to appropriate agent handler based on targetHandle + intent
      // 2. Execute agent-specific logic (GitHub API, local execution, etc)
      // 3. Capture result and update conversation
      // 4. Return routing result

      return {
        success: true,
        agentId: command.targetAgent,
        intent: command.intent,
        message: `Routing to @${command.targetHandle}: ${command.intent}`,
        conversationId: conversation.id,
      };
    },

    async resolveAgentHandle(
      handle: string,
      projectId?: string,
    ): Promise<AgentIdentity | undefined> {
      return projectId
        ? (
            await agentIdentityRegistry.listIdentities(projectId)
          ).find((a) => a.handle === handle)
        : await agentIdentityRegistry.getIdentityByHandle(handle);
    },

    async listAgentsForProject(projectId: string): Promise<AgentIdentity[]> {
      return agentIdentityRegistry.listIdentities(projectId);
    },

    async getAgentAutocomplete(
      projectId?: string,
    ): Promise<AgentAutocompleteSuggestion[]> {
      const agents = await (projectId
        ? agentIdentityRegistry.listIdentities(projectId)
        : agentIdentityRegistry.listIdentities());

      return agents
        .filter((a) => a.enabled)
        .map((a) => ({
          handle: a.handle,
          displayName: a.displayName,
          description: a.description,
          kind: a.kind,
        }));
    },

    async createConversation(
      projectId: string,
      slackWorkspaceId: string,
      channelId: string,
      userId: string,
      taskId?: string,
      agentId?: string,
    ): Promise<SlackConversation> {
      const now = new Date().toISOString();
      const conversation: SlackConversation = {
        id: `conv-${randomUUIDv7()}`,
        projectId,
        slackWorkspaceId,
        channelId,
        taskId,
        agentId,
        context: {},
        participants: [userId],
        createdAt: now,
        updatedAt: now,
      };

      await slackConversationModel.createConversation(conversation);
      return conversation;
    },

    async recordConversationEvent(
      conversationId: string,
      eventType: SlackConversationEvent["eventType"],
      userId: string,
      content: string,
      slackMessageTs?: string,
      slackThreadTs?: string,
    ): Promise<void> {
      const event: SlackConversationEvent = {
        id: `evt-${randomUUIDv7()}`,
        conversationId,
        eventType,
        slackMessageTs,
        slackThreadTs,
        userId,
        content,
        timestamp: new Date().toISOString(),
      };

      await slackConversationModel.recordEvent(event);
    },
  };
}
