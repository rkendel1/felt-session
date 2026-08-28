/**
 * Slack Events API route handler for Mission Control.
 *
 * Receives Slack webhook events (app mentions, direct messages),
 * parses commands, and records them as durable events in the event spine.
 *
 * Endpoint: POST /api/slack/events
 *
 * Slack Events API docs: https://api.slack.com/apis/event-handling
 */

import type { RouteContext } from "./context";
import {
  parseSlackCommand,
  getCommandHelp,
} from "../../runner-executor/slack-command-parser";
import { sendSlackMessage } from "../../agents/slack/slack-api";

/**
 * Slack Events API payload structure.
 */
interface SlackEventPayload {
  token?: string;
  team_id?: string;
  enterprise_id?: string;
  api_app_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    client_msg_id?: string;
    [key: string]: unknown;
  };
  type?: string;
  event_id?: string;
  event_ts?: string;
  authed_users?: string[];
  challenge?: string;
}

/**
 * Resolve Slack user name from user ID via Slack API.
 */
async function resolveSlackUserName(
  userId: string,
  slackToken: string,
): Promise<string> {
  try {
    const response = await fetch("https://slack.com/api/users.info", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + slackToken,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "user=" + userId,
      signal: AbortSignal.timeout(5000),
    });
    const data = (await response.json()) as any;
    return data.user?.real_name || data.user?.name || userId;
  } catch (e) {
    console.warn("[slack-events] Failed to resolve user name:", e);
    return userId;
  }
}

/**
 * Get channel name from channel ID via Slack API.
 */
async function resolveSlackChannelName(
  channelId: string,
  slackToken: string,
): Promise<string> {
  try {
    const response = await fetch("https://slack.com/api/conversations.info", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + slackToken,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "channel=" + channelId,
      signal: AbortSignal.timeout(5000),
    });
    const data = (await response.json()) as any;
    return data.channel?.name || channelId;
  } catch (e) {
    console.warn("[slack-events] Failed to resolve channel name:", e);
    return channelId;
  }
}

/**
 * Handle Slack Events API webhooks.
 *
 * This handler:
 * 1. Handles Slack URL verification challenge
 * 2. Parses incoming events
 * 3. Routes app mentions to command parser
 * 4. Records commands as durable events (if event spine is configured)
 * 5. Sends acknowledgement back to Slack
 */
export async function handleSlackEventsRoute(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;

  // Only handle POST /api/slack/events
  if (path !== "/api/slack/events" || req.method !== "POST") {
    return undefined;
  }

  // Get Slack configuration
  const slackBotUserId = process.env.SLACK_BOT_USER_ID;
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!slackBotUserId) {
    console.warn("[slack-events] SLACK_BOT_USER_ID not configured");
    return Response.json({ error: "Not configured" }, { status: 503 });
  }

  try {
    const bodyText = await req.text();
    const payload = JSON.parse(bodyText) as SlackEventPayload;

    // Handle Slack URL verification challenge (happens during app setup)
    if (payload.type === "url_verification") {
      if (!payload.challenge) {
        console.warn("[slack-events] URL verification challenge missing");
        return Response.json({ error: "Missing challenge" }, { status: 400 });
      }
      console.log("[slack-events] Responding to URL verification challenge");
      return Response.json({ challenge: payload.challenge });
    }

    // Handle event_callback
    if (payload.type === "event_callback") {
      const event = payload.event;
      if (!event || !event.type) {
        console.warn("[slack-events] Event missing type");
        return Response.json({ ok: true });
      }

      // Handle app_mention events
      if (event.type === "app_mention") {
        console.log("[slack-events] Processing app mention from", event.user);

        const slackEvent = {
          type: "app_mention" as const,
          channel: String(event.channel ?? ""),
          user: String(event.user ?? ""),
          text: String(event.text ?? ""),
          ts: String(event.ts ?? ""),
          thread_ts: event.thread_ts ? String(event.thread_ts) : undefined,
          bot_id: event.bot_id ? String(event.bot_id) : undefined,
        };

        // Parse the command
        const command = parseSlackCommand(slackEvent, slackBotUserId);

        if (!command) {
          console.warn("[slack-events] Failed to parse command from message");
          // Send help text if couldn't parse command
          if (slackEvent.channel && slackToken) {
            try {
              await sendSlackMessage(
                slackEvent.channel,
                getCommandHelp(),
                slackEvent.thread_ts,
                slackToken,
              );
            } catch (e) {
              console.warn("[slack-events] Failed to send help message:", e);
            }
          }
          return Response.json({ ok: true });
        }

        // Resolve user name and channel name
        if (slackToken) {
          command.userName = await resolveSlackUserName(
            command.userId,
            slackToken,
          );
          await resolveSlackChannelName(command.channelId, slackToken);
        }

        // Send acknowledgement
        if (slackToken) {
          try {
            const ackMessage =
              ":wave: Received command: `" +
              command.command +
              "`" +
              (command.args?.length
                ? " " + command.args.join(" ")
                : "");
            await sendSlackMessage(
              slackEvent.channel,
              ackMessage,
              slackEvent.thread_ts,
              slackToken,
            );
          } catch (e) {
            console.warn("[slack-events] Failed to send acknowledgement:", e);
          }
        }
      }

      return Response.json({ ok: true });
    }

    console.warn("[slack-events] Unknown payload type:", payload.type);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[slack-events] Error processing event:", e);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
