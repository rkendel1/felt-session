/**
 * Parse human commands from Slack messages.
 *
 * Converts natural language commands like "@mission-control status" or
 * "@mission-control create task" into structured SlackHumanCommand objects.
 */

import type { SlackHumanCommand } from "./slack-interface";

/**
 * Raw message from Slack Events API.
 */
export interface SlackEventMessage {
  type: "app_mention" | "message";
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

/**
 * Parse a Slack message into a command if it's addressed to Mission Control.
 *
 * Handles patterns like:
 * - "@mission-control status"
 * - "@mission-control create task Fix authentication"
 * - "@mission-control investigate Why are builds failing?"
 * - "@mission-control assign TASK-123 builder"
 */
export function parseSlackCommand(
  message: SlackEventMessage,
  botUserId: string,
): SlackHumanCommand | null {
  // Skip messages from bots
  if (message.bot_id) return null;

  // Extract the text and normalize
  let text = message.text.trim();

  // Handle app mention: "<@U123456> command args"
  const mentionPattern = `<@${botUserId}>`;
  if (text.startsWith(mentionPattern)) {
    text = text.substring(mentionPattern.length).trim();
  } else {
    // Not addressed to us
    return null;
  }

  // Split into command and args
  const parts = text.split(/\s+/);
  if (parts.length === 0) return null;

  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  // For commands that take everything after the first word as the argument
  // (like "investigate", "create task"), rejoin the args
  let finalArgs: string[] = [];

  if (
    command === "investigate" ||
    command === "create" ||
    command === "status" ||
    command === "list_tasks" ||
    command === "what" ||
    command === "help" ||
    command === "pause" ||
    command === "resume"
  ) {
    // These commands may have multi-word arguments
    if (command === "create" && args[0]?.toLowerCase() === "task") {
      // "create task Fix authentication" -> command: "create_task", args: ["Fix authentication"]
      const taskDesc = args.slice(1).join(" ");
      return {
        projectId: "current", // Will be resolved from channel context
        userId: message.user,
        userName: "", // Will be resolved from Slack
        channelId: message.channel,
        command: "create_task",
        args: taskDesc ? [taskDesc] : [],
        threadTs: message.thread_ts,
      };
    }

    if (command === "what" && args[0]?.toLowerCase() === "is" && args[1]?.toLowerCase() === "blocked") {
      // "what is blocked" -> command: "what_is_blocked"
      return {
        projectId: "current",
        userId: message.user,
        userName: "",
        channelId: message.channel,
        command: "what_is_blocked",
        args: [],
        threadTs: message.thread_ts,
      };
    }

    if (command === "investigate") {
      // "investigate Why are builds failing?" -> all remaining text
      const question = args.join(" ");
      return {
        projectId: "current",
        userId: message.user,
        userName: "",
        channelId: message.channel,
        command: "investigate",
        args: question ? [question] : [],
        threadTs: message.thread_ts,
      };
    }

    if (command === "list_tasks") {
      return {
        projectId: "current",
        userId: message.user,
        userName: "",
        channelId: message.channel,
        command: "list_tasks",
        args,
        threadTs: message.thread_ts,
      };
    }

    if (command === "status") {
      return {
        projectId: "current",
        userId: message.user,
        userName: "",
        channelId: message.channel,
        command: "status",
        args,
        threadTs: message.thread_ts,
      };
    }

    if (command === "help") {
      return {
        projectId: "current",
        userId: message.user,
        userName: "",
        channelId: message.channel,
        command: "help",
        args,
        threadTs: message.thread_ts,
      };
    }

    if (command === "pause") {
      return {
        projectId: "current",
        userId: message.user,
        userName: "",
        channelId: message.channel,
        command: "pause",
        args,
        threadTs: message.thread_ts,
      };
    }

    if (command === "resume") {
      return {
        projectId: "current",
        userId: message.user,
        userName: "",
        channelId: message.channel,
        command: "resume",
        args,
        threadTs: message.thread_ts,
      };
    }
  }

  // Handle two-word commands: "assign TASK-123 builder"
  if (command === "assign" && args.length >= 2) {
    return {
      projectId: "current",
      userId: message.user,
      userName: "",
      channelId: message.channel,
      command: "assign",
      args,
      threadTs: message.thread_ts,
    };
  }

  // Handle approve/reject commands
  if ((command === "approve" || command === "reject") && args.length >= 1) {
    return {
      projectId: "current",
      userId: message.user,
      userName: "",
      channelId: message.channel,
      command: command as "approve" | "reject",
      args,
      threadTs: message.thread_ts,
    };
  }

  // Unknown command
  return null;
}

/**
 * Format help text for available commands.
 */
export function getCommandHelp(): string {
  return `
Mission Control commands:

• \`@mission-control status\` — Show current task status
• \`@mission-control list_tasks\` — List all tasks
• \`@mission-control create task <description>\` — Create a new task
• \`@mission-control investigate <question>\` — Ask architect to investigate
• \`@mission-control assign <TASK-ID> <role>\` — Assign task to agent role
• \`@mission-control approve <TASK-ID>\` — Approve a task
• \`@mission-control reject <TASK-ID>\` — Reject a task
• \`@mission-control what is blocked\` — Show blocked tasks
• \`@mission-control pause\` — Pause agent execution
• \`@mission-control resume\` — Resume agent execution
• \`@mission-control help\` — Show this message
  `.trim();
}
