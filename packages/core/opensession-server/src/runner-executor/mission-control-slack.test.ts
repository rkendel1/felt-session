/**
 * Comprehensive tests for PR 5: Slack Agent Addressing and Project Rooms.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { randomUUIDv7 } from "bun";

import { openDurableProjectRegistry } from "./durable-project-registry";
import {
  openDurableAgentIdentityRegistry,
  type DurableAgentIdentityRegistry,
} from "./durable-agent-identity-registry";
import {
  openSlackChannelManager,
  type SlackChannelManagerInterface,
} from "./slack-channel-manager";
import {
  openSlackConversationModel,
  type SlackConversationModelInterface,
} from "./slack-conversation-model";
import {
  createMissionControlSlackOrchestrator,
  type MissionControlSlackOrchestratorInterface,
} from "./mission-control-slack-orchestrator";
import type { AgentIdentity } from "./mission-control-agent-identity";
import { createFeltDB } from "@feltdb/core";

let testCounter = 0;
let testDir: string;
let projectRegistry: any;
let agentRegistry: DurableAgentIdentityRegistry;
let channelManager: SlackChannelManagerInterface;
let conversationModel: SlackConversationModelInterface;
let orchestrator: MissionControlSlackOrchestratorInterface;

const prefix = "mc-slack-test";

beforeEach(() => {
  testDir = `/tmp/${prefix}-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });

  projectRegistry = openDurableProjectRegistry(
    createFeltDB({
      namespace: `mission-control-slack-project-test-${testCounter}`,
      memory: true,
    }),
  );
  agentRegistry = openDurableAgentIdentityRegistry(
    path.join(testDir, "agents.db"),
  );
  channelManager = openSlackChannelManager(
    path.join(testDir, "channels.db"),
  );
  conversationModel = openSlackConversationModel(
    path.join(testDir, "conversations.db"),
  );

  orchestrator = createMissionControlSlackOrchestrator(
    projectRegistry,
    agentRegistry,
    channelManager,
    conversationModel,
  );
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Agent Identity Registry Tests
// ============================================================================

describe("DurableAgentIdentityRegistry", () => {
  it("should create and retrieve an agent identity", async () => {
    const agentId = `agent-test-${randomUUIDv7()}`;
    const identity: AgentIdentity = {
      id: agentId,
      handle: "@architect",
      displayName: "Architect",
      description: "Architecture and design decisions",
      kind: "role",
      role: "architect",
      capabilities: ["design", "review", "plan"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);

    const retrieved = await agentRegistry.getIdentity(agentId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.handle).toBe("@architect");
    expect(retrieved?.kind).toBe("role");
    expect(retrieved?.capabilities).toEqual(["design", "review", "plan"]);
  });

  it("should retrieve agent by handle", async () => {
    const identity: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@builder",
      displayName: "Builder",
      kind: "role",
      role: "builder",
      capabilities: ["code", "build", "test"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);

    const retrieved = await agentRegistry.getIdentityByHandle("@builder");
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(identity.id);
    expect(retrieved?.displayName).toBe("Builder");
  });

  it("should list all identities", async () => {
    const id1: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@tester",
      displayName: "Tester",
      kind: "role",
      capabilities: ["test", "verify"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const id2: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@reviewer",
      displayName: "Reviewer",
      kind: "role",
      capabilities: ["review", "approve"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(id1);
    await agentRegistry.createIdentity(id2);

    const all = await agentRegistry.listIdentities();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((a) => a.handle)).toContain("@tester");
    expect(all.map((a) => a.handle)).toContain("@reviewer");
  });

  it("should update agent identity", async () => {
    const identity: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@github",
      displayName: "GitHub",
      kind: "integration",
      provider: "github",
      capabilities: ["pr", "issue", "commit"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);

    const updated: AgentIdentity = {
      ...identity,
      capabilities: ["pr", "issue", "commit", "release"],
    };
    await agentRegistry.updateIdentity(updated);

    const retrieved = await agentRegistry.getIdentity(identity.id);
    expect(retrieved?.capabilities).toContain("release");
  });

  it("should delete agent identity", async () => {
    const identity: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@deleteme",
      displayName: "Delete Me",
      kind: "role",
      capabilities: [],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);
    await agentRegistry.deleteIdentity(identity.id);

    const retrieved = await agentRegistry.getIdentity(identity.id);
    expect(retrieved).toBeUndefined();
  });

  it("should manage agent presence", async () => {
    const agentId = `agent-${randomUUIDv7()}`;
    const identity: AgentIdentity = {
      id: agentId,
      handle: "@presence-test",
      displayName: "Presence Test",
      kind: "role",
      capabilities: [],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);

    const presence = {
      agentId,
      state: "active" as const,
      currentTask: "task-123",
      statusMessage: "Working on PR review",
      lastSeen: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.setPresence(presence);

    const retrieved = await agentRegistry.getPresence(agentId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.state).toBe("active");
    expect(retrieved?.currentTask).toBe("task-123");
  });

  it("should manage agent assignments", async () => {
    const agentId = `agent-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const assignment = {
      id: `assign-${randomUUIDv7()}`,
      agentId,
      taskId,
      projectId,
      assignedAt: new Date().toISOString(),
      status: "pending" as const,
    };

    await agentRegistry.createAssignment(assignment);

    const retrieved = await agentRegistry.getAssignment(assignment.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.agentId).toBe(agentId);
    expect(retrieved?.status).toBe("pending");
  });

  it("should query assignments by task", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const assign1 = {
      id: `assign-${randomUUIDv7()}`,
      agentId: `agent-${randomUUIDv7()}`,
      taskId,
      projectId,
      assignedAt: new Date().toISOString(),
      status: "pending" as const,
    };

    const assign2 = {
      id: `assign-${randomUUIDv7()}`,
      agentId: `agent-${randomUUIDv7()}`,
      taskId,
      projectId,
      assignedAt: new Date().toISOString(),
      status: "active" as const,
    };

    await agentRegistry.createAssignment(assign1);
    await agentRegistry.createAssignment(assign2);

    const byTask = await agentRegistry.getAssignmentsByTask(taskId);
    expect(byTask.length).toBe(2);
  });

  it("should ensure builtin agents are created", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    await agentRegistry.ensureBuiltinAgents(projectId);

    const agents = await agentRegistry.listIdentities(projectId);
    const handles = agents.map((a) => a.handle);

    expect(handles).toContain("@architect");
    expect(handles).toContain("@builder");
    expect(handles).toContain("@reviewer");
  });
});

// ============================================================================
// Slack Channel Manager Tests
// ============================================================================

describe("SlackChannelManager", () => {
  it("should create a Slack project channel", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const channel = {
      id: `ch-${randomUUIDv7()}`,
      projectId,
      slackWorkspaceId: "W123456",
      channelId: "C123456",
      channelName: "project-myapp",
      topic: "Project: My App",
      description: "Coordination channel",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await channelManager.createChannel(channel);

    const retrieved = await channelManager.getChannel(channel.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.channelName).toBe("project-myapp");
  });

  it("should get channel by project", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const channel = {
      id: `ch-${randomUUIDv7()}`,
      projectId,
      slackWorkspaceId: "W123456",
      channelId: "C123456",
      channelName: "project-test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await channelManager.createChannel(channel);

    const byProject = await channelManager.getChannelByProject(projectId);
    expect(byProject).toBeDefined();
    expect(byProject?.projectId).toBe(projectId);
  });

  it("should generate valid Slack channel name", () => {
    const name1 = channelManager.generateChannelName("My App");
    expect(name1).toMatch(/^project-[a-z0-9-_]+$/);
    expect(name1).toBe("project-my-app");

    const name2 = channelManager.generateChannelName("FeltDB-Core");
    expect(name2).toMatch(/^project-[a-z0-9-_]+$/);
    expect(name2).toBe("project-feltdb-core");
  });

  it("should list channels by workspace", async () => {
    const workspaceId = "W123456";
    const ch1 = {
      id: `ch-${randomUUIDv7()}`,
      projectId: `proj-${randomUUIDv7()}`,
      slackWorkspaceId: workspaceId,
      channelId: "C111111",
      channelName: "project-app1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const ch2 = {
      id: `ch-${randomUUIDv7()}`,
      projectId: `proj-${randomUUIDv7()}`,
      slackWorkspaceId: workspaceId,
      channelId: "C222222",
      channelName: "project-app2",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await channelManager.createChannel(ch1);
    await channelManager.createChannel(ch2);

    const channels = await channelManager.listChannels(workspaceId);
    expect(channels.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Slack Conversation Model Tests
// ============================================================================

describe("SlackConversationModel", () => {
  it("should create and retrieve a conversation", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const conversation = {
      id: `conv-${randomUUIDv7()}`,
      projectId,
      slackWorkspaceId: "W123456",
      channelId: "C123456",
      context: { priority: "high" },
      participants: ["U123456", "U234567"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await conversationModel.createConversation(conversation);

    const retrieved = await conversationModel.getConversation(conversation.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.projectId).toBe(projectId);
    expect(retrieved?.context).toEqual({ priority: "high" });
  });

  it("should record conversation events", async () => {
    const conversationId = `conv-${randomUUIDv7()}`;
    const conversation = {
      id: conversationId,
      projectId: `proj-${randomUUIDv7()}`,
      slackWorkspaceId: "W123456",
      channelId: "C123456",
      context: {},
      participants: ["U123456"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await conversationModel.createConversation(conversation);

    const event = {
      id: `evt-${randomUUIDv7()}`,
      conversationId,
      eventType: "message" as const,
      userId: "U123456",
      content: "Hello @architect",
      timestamp: new Date().toISOString(),
    };

    await conversationModel.recordEvent(event);

    const events = await conversationModel.getEventsByConversation(
      conversationId,
    );
    expect(events.length).toBe(1);
    expect(events[0].content).toBe("Hello @architect");
  });

  it("should link conversation to task and agent", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;
    const agentId = `agent-${randomUUIDv7()}`;

    const conversation = {
      id: `conv-${randomUUIDv7()}`,
      projectId,
      slackWorkspaceId: "W123456",
      channelId: "C123456",
      taskId,
      agentId,
      context: {},
      participants: ["U123456"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await conversationModel.createConversation(conversation);

    const retrieved = await conversationModel.getConversation(conversation.id);
    expect(retrieved?.taskId).toBe(taskId);
    expect(retrieved?.agentId).toBe(agentId);
  });
});

// ============================================================================
// Mission Control Slack Orchestrator Tests
// ============================================================================

describe("MissionControlSlackOrchestrator", () => {
  it("should resolve agent by handle", async () => {
    const identity: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@architect",
      displayName: "Architect",
      kind: "role",
      capabilities: ["design"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);

    const resolved = await orchestrator.resolveAgentHandle("@architect");
    expect(resolved).toBeDefined();
    expect(resolved?.displayName).toBe("Architect");
  });

  it("should parse @mention command", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const identity: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@github",
      displayName: "GitHub",
      kind: "integration",
      provider: "github",
      capabilities: ["pr"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);

    const parsed = await orchestrator.parseCommand(
      projectId,
      "C123456",
      "U123456",
      "@github merge PR 42",
    );

    expect(parsed).toBeDefined();
    expect(parsed?.targetHandle).toBe("@github");
    expect(parsed?.intent).toBe("merge");
    expect(parsed?.entities.pullRequest).toBe(42);
  });

  it("should get agent autocomplete suggestions", async () => {
    const identity1: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@builder",
      displayName: "Builder",
      kind: "role",
      capabilities: ["code"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const identity2: AgentIdentity = {
      id: `agent-${randomUUIDv7()}`,
      handle: "@tester",
      displayName: "Tester",
      kind: "role",
      capabilities: ["test"],
      enabled: false, // Disabled
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity1);
    await agentRegistry.createIdentity(identity2);

    const suggestions = await orchestrator.getAgentAutocomplete();

    const handles = suggestions.map((s) => s.handle);
    expect(handles).toContain("@builder");
    expect(handles).not.toContain("@tester"); // Disabled agents excluded
  });

  it("should create conversation from command", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const userId = "U123456";

    const conversation = await orchestrator.createConversation(
      projectId,
      "W123456",
      "C123456",
      userId,
    );

    expect(conversation).toBeDefined();
    expect(conversation.projectId).toBe(projectId);
    expect(conversation.participants).toContain(userId);
  });

  it("should record conversation events", async () => {
    const conversation = {
      id: `conv-${randomUUIDv7()}`,
      projectId: `proj-${randomUUIDv7()}`,
      slackWorkspaceId: "W123456",
      channelId: "C123456",
      context: {},
      participants: ["U123456"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await conversationModel.createConversation(conversation);

    await orchestrator.recordConversationEvent(
      conversation.id,
      "message",
      "U123456",
      "Test message",
    );

    const events = await conversationModel.getEventsByConversation(
      conversation.id,
    );
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("message");
  });

  it("should route command to agent", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const agentId = `agent-${randomUUIDv7()}`;

    const identity: AgentIdentity = {
      id: agentId,
      handle: "@builder",
      displayName: "Builder",
      kind: "role",
      capabilities: ["code"],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRegistry.createIdentity(identity);

    const parsed = await orchestrator.parseCommand(
      projectId,
      "C123456",
      "U123456",
      "@builder build the project",
    );

    expect(parsed).toBeDefined();

    const result = await orchestrator.routeCommand(parsed!);

    expect(result.success).toBe(true);
    expect(result.agentId).toBe(agentId);
    expect(result.intent).toBe("build");
  });
});
