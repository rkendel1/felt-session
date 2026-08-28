/**
 * Tests for Mission Control Slack adapter.
 */

import { describe, test, expect } from "bun:test";
import { createMissionControlSlackAdapter } from "./slack-mission-control-adapter";
import type { EventSpine, SlackCommandReceivedEvent } from "./event-spine";

/**
 * Mock EventSpine for testing.
 */
class MockEventSpine implements EventSpine {
  private events: Map<string, any[]> = new Map();

  async record(event: any) {
    const sessionId = event.id.sessionId;
    if (!this.events.has(sessionId)) {
      this.events.set(sessionId, []);
    }
    this.events.get(sessionId)!.push(event);
    return event.id;
  }

  async range(sessionId: string, fromSequence: number, toSequence?: number) {
    return this.events.get(sessionId)?.slice(fromSequence, toSequence) ?? [];
  }

  async since(sessionId: string, timestamp: string) {
    const events = this.events.get(sessionId) ?? [];
    const startTime = new Date(timestamp).getTime();
    return events.filter(
      (e) => new Date(e.timestamp).getTime() >= startTime,
    );
  }

  async count(sessionId: string) {
    return this.events.get(sessionId)?.length ?? 0;
  }

  getRecordedEvents(sessionId: string) {
    return this.events.get(sessionId) ?? [];
  }
}

/**
 * Mock SlackNotificationSender for testing.
 */
class MockSlackNotificationSender {
  sentMessages: any[] = [];

  async sendNotification(notification: any) {
    this.sentMessages.push(notification);
  }
}

describe("createMissionControlSlackAdapter", () => {
  test("creates adapter with handler and notification sender", () => {
    const eventSpine = new MockEventSpine();
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    expect(adapter.handler).toBeDefined();
    expect(adapter.notificationSender).toBeDefined();
  });
});

describe("MissionControlSlackCommandHandler", () => {
  test("records command as SlackCommandReceivedEvent", async () => {
    const eventSpine = new MockEventSpine();
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "status",
      args: [],
      threadTs: undefined,
    });

    const sessionId = "slack-T0LFGBRPA-project-1";
    const events = (eventSpine as MockEventSpine).getRecordedEvents(sessionId);
    expect(events).toHaveLength(1);

    const event = events[0] as SlackCommandReceivedEvent;
    expect(event.kind).toBe("slack.command.received");
    expect(event.slackUserId).toBe("U0987654321");
    expect(event.slackUserName).toBe("alice");
    expect(event.command).toBe("status");
  });

  test("increments sequence for consecutive events", async () => {
    const eventSpine = new MockEventSpine();
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    const sessionId = "slack-T0LFGBRPA-project-1";

    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "status",
      args: [],
    });

    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "list_tasks",
      args: [],
    });

    const events = (eventSpine as MockEventSpine).getRecordedEvents(sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].id.eventSequence).toBe(0);
    expect(events[1].id.eventSequence).toBe(1);
  });

  test("records command with args", async () => {
    const eventSpine = new MockEventSpine();
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    await adapter.handler.handle({
      projectId: "project-1",
      userId: "U0987654321",
      userName: "alice",
      channelId: "C1234567890",
      command: "create_task",
      args: ["Fix authentication bug"],
    });

    const sessionId = "slack-T0LFGBRPA-project-1";
    const events = (eventSpine as MockEventSpine).getRecordedEvents(sessionId);
    const event = events[0] as SlackCommandReceivedEvent;

    expect(event.args).toEqual(["Fix authentication bug"]);
  });
});

describe("MissionControlSlackNotificationSender", () => {
  test("sends notification to Slack and records event", async () => {
    const eventSpine = new MockEventSpine();
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    await adapter.notificationSender.sendNotification({
      projectId: "project-1",
      channelId: "C1234567890",
      agentId: "agent-architect-1",
      role: "architect",
      message: "Found the bug",
      threadTs: undefined,
    });

    // Check that message was sent to Slack
    expect(slackClient.sentMessages).toHaveLength(1);
    expect(slackClient.sentMessages[0].message).toBe("Found the bug");

    // Check that event was recorded
    const sessionId = "slack-T0LFGBRPA-project-1";
    const events = (eventSpine as MockEventSpine).getRecordedEvents(sessionId);
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.kind).toBe("slack.notification.posted");
    expect(event.agentId).toBe("agent-architect-1");
    expect(event.message).toBe("Found the bug");
  });

  test("increments sequence for consecutive notifications", async () => {
    const eventSpine = new MockEventSpine();
    const slackClient = new MockSlackNotificationSender();

    const adapter = createMissionControlSlackAdapter({
      eventSpine,
      slackClient: slackClient as any,
      botUserId: "U0LFJBRPA",
      slackWorkspaceId: "T0LFGBRPA",
    });

    const sessionId = "slack-T0LFGBRPA-project-1";

    await adapter.notificationSender.sendNotification({
      projectId: "project-1",
      channelId: "C1234567890",
      agentId: "agent-architect-1",
      role: "architect",
      message: "First message",
    });

    await adapter.notificationSender.sendNotification({
      projectId: "project-1",
      channelId: "C1234567890",
      agentId: "agent-builder-1",
      role: "builder",
      message: "Second message",
    });

    const events = (eventSpine as MockEventSpine).getRecordedEvents(sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].id.eventSequence).toBe(0);
    expect(events[1].id.eventSequence).toBe(1);
  });
});
