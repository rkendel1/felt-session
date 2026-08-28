/**
 * Tests for Slack command parser.
 */

import { describe, test, expect } from "bun:test";
import {
  parseSlackCommand,
  getCommandHelp,
} from "./slack-command-parser";

describe("parseSlackCommand", () => {
  const botUserId = "U0LFJBRPA";

  test("parses status command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> status",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("status");
    expect(command?.args).toEqual([]);
    expect(command?.userId).toBe("U0987654321");
    expect(command?.channelId).toBe("C1234567890");
  });

  test("parses create task command with description", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> create task Fix authentication bug",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("create_task");
    expect(command?.args).toEqual(["Fix authentication bug"]);
  });

  test("parses investigate command with question", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> investigate Why are builds failing?",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("investigate");
    expect(command?.args).toEqual(["Why are builds failing?"]);
  });

  test("parses what is blocked command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> what is blocked",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("what_is_blocked");
    expect(command?.args).toEqual([]);
  });

  test("parses assign command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> assign TASK-123 builder",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("assign");
    expect(command?.args).toEqual(["TASK-123", "builder"]);
  });

  test("parses approve command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> approve TASK-123",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("approve");
    expect(command?.args).toEqual(["TASK-123"]);
  });

  test("parses reject command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> reject TASK-123",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("reject");
    expect(command?.args).toEqual(["TASK-123"]);
  });

  test("parses list_tasks command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> list_tasks",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("list_tasks");
  });

  test("parses help command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> help",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("help");
  });

  test("returns null for bot messages", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> status",
      ts: "1234567890.123456",
      bot_id: "B0123456789",
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).toBeNull();
  });

  test("returns null for messages not addressed to bot", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "just a regular message",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).toBeNull();
  });

  test("returns null for unknown commands", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> unknowncommand",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).toBeNull();
  });

  test("includes thread_ts when present", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> status",
      ts: "1234567890.123456",
      thread_ts: "1234567890.100000",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.threadTs).toBe("1234567890.100000");
  });

  test("parses pause command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> pause",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("pause");
  });

  test("parses resume command", () => {
    const message = {
      type: "app_mention" as const,
      channel: "C1234567890",
      user: "U0987654321",
      text: "<@U0LFJBRPA> resume",
      ts: "1234567890.123456",
      bot_id: undefined,
    };

    const command = parseSlackCommand(message, botUserId);
    expect(command).not.toBeNull();
    expect(command?.command).toBe("resume");
  });
});

describe("getCommandHelp", () => {
  test("returns help text", () => {
    const help = getCommandHelp();
    expect(help).toContain("status");
    expect(help).toContain("create task");
    expect(help).toContain("investigate");
    expect(help).toContain("assign");
    expect(help).toContain("approve");
    expect(help).toContain("reject");
  });
});
