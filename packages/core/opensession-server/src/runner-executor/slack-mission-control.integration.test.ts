/**
 * Integration tests for Slack Mission Control boundary.
 *
 * These tests verify the complete flow:
 * Slack message → Event spine persistence → Event durability
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeltDbEventSpine } from "./feltdb-event-spine";
import { createMissionControlSlackAdapter } from "./slack-mission-control-adapter";
import { parseSlackCommand } from "./slack-command-parser";
import type { SlackCommandReceivedEvent } from "./event-spine";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "slack-mission-control-"));
  roots.push(root);
  return root;
}

/**
 * Mock Slack notification sender.
 */
class MockSlackNotificationSender {
  sentMessages: any[] = [];

  async sendNotification(notification: any) {
    this.sentMessages.push(notification);
  }
}

describe("Slack Mission Control Integration", () => {
  test("records Slack command as durable event through FeltDB", async () => {
    const eventSpine = openFeltDbEventSpine(join(tmpRoot(), "events"));
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    // Simulate a Slack message: @mission-control status
    const slackMessage = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> status",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    // Parse the command
    const command = parseSlackCommand(slackMessage, "U0LFJBRPA");
    expect(command).not.toBeNull();

    // Record via adapter
    await adapter.handler.handle(command!);

    // Verify event was recorded
    const sessionId = "slack-T0LFGBRPA-current";
    const events = await eventSpine.range(sessionId, 0, 10);
    expect(events).toHaveLength(1);

    const event = events[0] as SlackCommandReceivedEvent;
    expect(event.kind).toBe("slack.command.received");
    expect(event.command).toBe("status");
  });

  test("persists multiple commands with correct sequence", async () => {
    const eventSpine = openFeltDbEventSpine(join(tmpRoot(), "events"));
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    const sessionId = "slack-T0LFGBRPA-current";

    // First command
    await adapter.handler.handle({
      projectId: "current",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "status",
      args: [],
    });

    // Second command
    await adapter.handler.handle({
      projectId: "current",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "list_tasks",
      args: [],
    });

    // Third command
    await adapter.handler.handle({
      projectId: "current",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "create_task",
      args: ["Fix auth"],
    });

    // Verify all events were recorded with correct sequence
    const events = await eventSpine.range(sessionId, 0, 10);
    expect(events).toHaveLength(3);
    expect(events[0].id.eventSequence).toBe(0);
    expect(events[1].id.eventSequence).toBe(1);
    expect(events[2].id.eventSequence).toBe(2);
  });

  test("events survive process restart (process crash recovery)", async () => {
    const dbPath = join(tmpRoot(), "events");

    // First "process" - record events
    {
      const eventSpine = openFeltDbEventSpine(dbPath);
      const slackClient = new MockSlackNotificationSender();

      const adapter = createMissionControlSlackAdapter({
        eventSpine,
        slackClient: slackClient as any,
        botUserId: "U0LFJBRPA",
        slackWorkspaceId: "T0LFGBRPA",
      });

      await adapter.handler.handle({
        projectId: "current",
        userId: "U0987654321",
        userName: "alice",
        channelId: "C1234567890",
        command: "status",
        args: [],
      });

      await adapter.handler.handle({
        projectId: "current",
        userId: "U0987654321",
        userName: "alice",
        channelId: "C1234567890",
        command: "investigate",
        args: ["Why are builds failing?"],
      });
    }

    // Simulate process crash and restart
    // Second "process" - verify events survived
    {
      const eventSpine = openFeltDbEventSpine(dbPath);
      const sessionId = "slack-T0LFGBRPA-current";

      const events = await eventSpine.range(sessionId, 0, 10);
      expect(events).toHaveLength(2);
      const commands = events.filter((event) => event.kind === "slack.command.received");
      expect(commands[0].command).toBe("status");
      expect(commands[1].command).toBe("investigate");
      expect(commands[1].args).toEqual(["Why are builds failing?"]);
    }
  });

  test("records agent notifications with event durability", async () => {
    const eventSpine = openFeltDbEventSpine(join(tmpRoot(), "events"));
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    // Simulate agent sending notification
    await adapter.notificationSender.sendNotification({
      projectId: "project-1",
      channelId: "C1234567890",
      agentId: "architect-1",
      role: "architect",
      message: "Found the root cause: authentication is not properly validating tokens.",
    });

    // Verify Slack message was sent
    expect(slackClient.sentMessages).toHaveLength(1);

    // Verify event was recorded
    const sessionId = "slack-T0LFGBRPA-project-1";
    const events = await eventSpine.range(sessionId, 0, 10);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.kind).toBe("slack.notification.posted");
    if (event.kind !== "slack.notification.posted") throw new Error("unexpected event kind");
    expect(event.agentId).toBe("architect-1");
    expect(event.message).toBe(
      "Found the root cause: authentication is not properly validating tokens.",
    );
  });

  test("interleaves human commands and agent notifications in event log", async () => {
    const eventSpine = openFeltDbEventSpine(join(tmpRoot(), "events"));
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    const sessionId = "slack-T0LFGBRPA-project-1";

    // Human command
    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "investigate",
      args: ["Why are tests failing?"],
    });

    // Agent notification
    await adapter.notificationSender.sendNotification({
      projectId: "project-1",
      channelId: "C1234567890",
      agentId: "architect-1",
      role: "architect",
      message: "Investigating test failures...",
    });

    // Another human command
    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "assign",
      args: ["TASK-123", "builder"],
    });

    // Verify complete event sequence
    const events = await eventSpine.range(sessionId, 0, 10);
    expect(events).toHaveLength(3);

    expect(events[0].kind).toBe("slack.command.received");
    expect(events[0].id.eventSequence).toBe(0);

    expect(events[1].kind).toBe("slack.notification.posted");
    expect(events[1].id.eventSequence).toBe(1);

    expect(events[2].kind).toBe("slack.command.received");
    expect(events[2].id.eventSequence).toBe(2);
  });

  test("counts events correctly after multiple operations", async () => {
    const eventSpine = openFeltDbEventSpine(join(tmpRoot(), "events"));
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    const sessionId = "slack-T0LFGBRPA-project-1";

    // Initial count should be 0
    let count = await eventSpine.count(sessionId);
    expect(count).toBe(0);

    // Record first event
    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "status",
      args: [],
    });

    count = await eventSpine.count(sessionId);
    expect(count).toBe(1);

    // Record more events
    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "list_tasks",
      args: [],
    });

    count = await eventSpine.count(sessionId);
    expect(count).toBe(2);
  });
});
