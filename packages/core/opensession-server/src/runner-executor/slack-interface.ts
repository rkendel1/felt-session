/**
 * Slack integration definitions for Mission Control.
 *
 * Slack becomes the natural interface for humans to interact with
 * the team of agents, receiving updates as events occur and issuing
 * commands through natural language.
 */

/**
 * SlackMessage represents a message from Slack that drives Mission Control.
 */
export interface SlackMessage {
  channel: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
  threadTs?: string;
}

/**
 * SlackProjectChannel represents a Slack channel dedicated to a project.
 *
 * Each project has its own channel where:
 * - Humans can request work (e.g., "@mission-control investigate replication")
 * - Agents report their status and results
 * - Reviews and approvals happen synchronously
 */
export interface SlackProjectChannel {
  projectId: string;
  channelId: string;
  channelName: string;
  topic?: string;
  description?: string;
}

/**
 * SlackAgentNotification represents a message that an agent wants to post to Slack.
 */
export interface SlackAgentNotification {
  projectId: string;
  channelId: string;
  agentId: string;
  role: string;
  emoji?: string;
  message: string;
  threadTs?: string;
}

/**
 * SlackHumanCommand represents a command from a human in Slack.
 */
export interface SlackHumanCommand {
  projectId: string;
  userId: string;
  userName: string;
  channelId: string;
  command: string;
  args?: string[];
  threadTs?: string;
}

/**
 * Commands that humans can issue through Slack.
 */
export type SlackCommandType =
  | "investigate"
  | "create_task"
  | "assign"
  | "approve"
  | "reject"
  | "status"
  | "list_tasks"
  | "help"
  | "pause"
  | "resume"
  | "what_is_blocked";

/**
 * SlackCommandHandler processes human commands from Slack.
 */
export interface SlackCommandHandler {
  /**
   * Process a human command from Slack and emit appropriate events.
   */
  handle(command: SlackHumanCommand): Promise<void>;
}

/**
 * SlackNotificationSender posts agent notifications to Slack channels.
 */
export interface SlackNotificationSender {
  /**
   * Send a notification to a Slack project channel.
   */
  sendNotification(notification: SlackAgentNotification): Promise<void>;
}
