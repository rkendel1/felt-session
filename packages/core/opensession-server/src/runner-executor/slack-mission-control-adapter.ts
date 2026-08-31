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

class SlackEventSequence {
  private readonly next = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly eventSpine: EventSpine) {}

  allocate(sessionId: string): Promise<number> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let resolveValue!: (value: number) => void;
    const value = new Promise<number>((resolve) => { resolveValue = resolve; });
    const current = previous.then(async () => {
      const sequence = this.next.get(sessionId) ?? await this.eventSpine.count(sessionId);
      this.next.set(sessionId, sequence + 1);
      resolveValue(sequence);
    });
    this.tails.set(sessionId, current);
    return value;
  }
}

/**
 * Implementation of SlackCommandHandler that persists commands as events.
 */
class MissionControlSlackCommandHandler implements SlackCommandHandler {
  private eventSpine: EventSpine;
  private slackWorkspaceId: string;
  private sequence: SlackEventSequence;

  constructor(eventSpine: EventSpine, slackWorkspaceId: string, sequence: SlackEventSequence) {
    this.eventSpine = eventSpine;
    this.slackWorkspaceId = slackWorkspaceId;
    this.sequence = sequence;
  }

  async handle(command: SlackHumanCommand): Promise<void> {
    // Get the next sequence number for this session
    const sessionId = `slack-${this.slackWorkspaceId}-${command.projectId}`;

    // Ensure we have the correct sequence by checking event spine
    const sequence = await this.sequence.allocate(sessionId);

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
    await this.eventSpine.record(event);
  }
}

/**
 * Implementation of SlackNotificationSender that posts messages to Slack.
 */
class MissionControlSlackNotificationSender implements SlackNotificationSender {
  private eventSpine: EventSpine;
  private slackClient: SlackNotificationSender;
  private slackWorkspaceId: string;
  private sequence: SlackEventSequence;

  constructor(eventSpine: EventSpine, slackClient: SlackNotificationSender, slackWorkspaceId: string, sequence: SlackEventSequence) {
    this.eventSpine = eventSpine;
    this.slackClient = slackClient;
    this.slackWorkspaceId = slackWorkspaceId;
    this.sequence = sequence;
  }

  async sendNotification(notification: SlackAgentNotification): Promise<void> {
    // First, send the message to Slack
    await this.slackClient.sendNotification(notification);

    // Then, record it as a durable event
    const sessionId = `slack-${this.slackWorkspaceId}-${notification.projectId}`;

    // Ensure we have the correct sequence by checking event spine
    const sequence = await this.sequence.allocate(sessionId);

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
  const sequence = new SlackEventSequence(config.eventSpine);
  return {
    handler: new MissionControlSlackCommandHandler(config.eventSpine, config.slackWorkspaceId, sequence),
    notificationSender: new MissionControlSlackNotificationSender(
      config.eventSpine,
      config.slackClient,
      config.slackWorkspaceId,
      sequence,
    ),
  };
}
