/**
 * Slack ↔ Mission Control adapter.
 *
 * Bridges the gap between Slack messages and the Mission Control event spine,
 * ensuring every human interaction becomes a durable event.
 *
 * Responsible for:
 * 1. Processing incoming Slack commands
 * 2. Recording them as durable events
 * 3. Posting agent notifications back to Slack
 */

import type {
  SlackHumanCommand,
  SlackAgentNotification,
  SlackNotificationSender,
  SlackCommandHandler,
} from "./slack-interface";
import type { EventSpine, SlackCommandReceivedEvent, SlackNotificationPostedEvent } from "./event-spine";
import type { EventId } from "./event-spine";

/**
 * Configuration for the adapter.
 */
export interface MissionControlSlackAdapterConfig {
  /** The EventSpine instance for recording events. */
  eventSpine: EventSpine;

  /** Slack API client for posting messages. */
  slackClient: SlackNotificationSender;

  /** Bot user ID for Slack app mentions. */
  botUserId: string;

  /** Slack workspace ID. */
  slackWorkspaceId: string;
}

/**
 * Implementation of SlackCommandHandler that persists commands as events.
 */
class MissionControlSlackCommandHandler implements SlackCommandHandler {
  private eventSpine: EventSpine;
  private slackWorkspaceId: string;
  private nextSequence: Map<string, number> = new Map();

  constructor(eventSpine: EventSpine, slackWorkspaceId: string) {
    this.eventSpine = eventSpine;
    this.slackWorkspaceId = slackWorkspaceId;
  }

  async handle(command: SlackHumanCommand): Promise<void> {
    // Get the next sequence number for this session
    const sessionId = `slack-${this.slackWorkspaceId}-${command.projectId}`;
    const sequence = this.nextSequence.get(sessionId) ?? 0;

    const event: SlackCommandReceivedEvent = {
      kind: "slack.command.received",
      id: {
        sessionId,
        eventSequence: sequence,
      },
      timestamp: new Date().toISOString(),
      slackUserId: command.userId,
      slackUserName: command.userName,
      slackChannelId: command.channelId,
      slackChannelName: "", // Would be resolved from channel context
      slackMessageTimestamp: new Date().getTime().toString(),
      command: command.command,
      args: command.args ?? [],
      rawMessage: `@mission-control ${command.command}${command.args?.length ? ` ${command.args.join(" ")}` : ""}`,
      slackThreadTs: command.threadTs,
    };

    // Record the event durably
    const recordedId = await this.eventSpine.record(event);

    // Update sequence for next event
    this.nextSequence.set(sessionId, recordedId.eventSequence + 1);
  }
}

/**
 * Implementation of SlackNotificationSender that posts messages to Slack.
 */
class MissionControlSlackNotificationSender implements SlackNotificationSender {
  private eventSpine: EventSpine;
  private slackClient: SlackNotificationSender;
  private slackWorkspaceId: string;
  private nextSequence: Map<string, number> = new Map();

  constructor(eventSpine: EventSpine, slackClient: SlackNotificationSender, slackWorkspaceId: string) {
    this.eventSpine = eventSpine;
    this.slackClient = slackClient;
    this.slackWorkspaceId = slackWorkspaceId;
  }

  async sendNotification(notification: SlackAgentNotification): Promise<void> {
    // First, send the message to Slack
    await this.slackClient.sendNotification(notification);

    // Then, record it as a durable event
    const sessionId = `slack-${this.slackWorkspaceId}-${notification.projectId}`;
    const sequence = this.nextSequence.get(sessionId) ?? 0;

    const event: SlackNotificationPostedEvent = {
      kind: "slack.notification.posted",
      id: {
        sessionId,
        eventSequence: sequence,
      },
      timestamp: new Date().toISOString(),
      agentId: notification.agentId,
      slackChannelId: notification.channelId,
      slackMessageTimestamp: new Date().getTime().toString(),
      message: notification.message,
      slackThreadTs: notification.threadTs,
    };

    await this.eventSpine.record(event);

    // Update sequence for next event
    this.nextSequence.set(sessionId, sequence + 1);
  }
}

/**
 * Create a Mission Control Slack adapter with both command handler and notification sender.
 */
export function createMissionControlSlackAdapter(
  config: MissionControlSlackAdapterConfig,
): {
  handler: SlackCommandHandler;
  notificationSender: SlackNotificationSender;
} {
  return {
    handler: new MissionControlSlackCommandHandler(config.eventSpine, config.slackWorkspaceId),
    notificationSender: new MissionControlSlackNotificationSender(
      config.eventSpine,
      config.slackClient,
      config.slackWorkspaceId,
    ),
  };
}
