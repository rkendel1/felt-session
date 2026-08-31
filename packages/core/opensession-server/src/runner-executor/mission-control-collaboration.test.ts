/**
 * Comprehensive tests for PR 7: Unified Agent Context and Autonomous Collaboration.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { randomUUIDv7 } from "bun";

import {
  openDurableConversationLedger,
  type DurableConversationLedger,
} from "./durable-conversation-ledger";
import {
  createAgentContextBuilder,
  type AgentContextBuilderInterface,
} from "./agent-context-builder";
import {
  createAutonomousCollaborationEngine,
  type AutonomousCollaborationEngineInterface,
} from "./autonomous-collaboration-engine";
import {
  openDurableAgentIdentityRegistry,
  type DurableAgentIdentityRegistry,
} from "./durable-agent-identity-registry";
import type { DurableConversation, ConversationTurn, AgentDecision } from "./mission-control-collaboration";
import type { AgentIdentity } from "./mission-control-agent-identity";

let testCounter = 0;
let testDir: string;
let ledger: DurableConversationLedger;
let contextBuilder: AgentContextBuilderInterface;
let engine: AutonomousCollaborationEngineInterface;
let agentRegistry: DurableAgentIdentityRegistry;

const prefix = "mc-collab-test";

beforeEach(() => {
  testDir = `/tmp/${prefix}-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });

  ledger = openDurableConversationLedger(path.join(testDir, "ledger.db"));
  agentRegistry = openDurableAgentIdentityRegistry(
    path.join(testDir, "agents.db"),
  );
  contextBuilder = createAgentContextBuilder(ledger);
  engine = createAutonomousCollaborationEngine(
    ledger,
    agentRegistry,
    contextBuilder,
  );
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Durable Conversation Ledger Tests
// ============================================================================

describe("DurableConversationLedger", () => {
  it("should create and retrieve a conversation", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;

    const conversation: DurableConversation = {
      id: `conv-${randomUUIDv7()}`,
      taskId,
      projectId,
      title: "Implement feature X",
      agents: ["agent-1", "agent-2"],
      participants: ["user-1"],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ledger.createConversation(conversation);

    const retrieved = await ledger.getConversation(conversation.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe("Implement feature X");
    expect(retrieved?.status).toBe("active");
  });

  it("should retrieve conversation by task", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;

    const conversation: DurableConversation = {
      id: `conv-${randomUUIDv7()}`,
      taskId,
      projectId,
      title: "Task conversation",
      agents: [],
      participants: [],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ledger.createConversation(conversation);

    const byTask = await ledger.getConversationByTask(taskId);
    expect(byTask).toBeDefined();
    expect(byTask?.taskId).toBe(taskId);
  });

  it("should add and retrieve conversation turns", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;
    const conversationId = `conv-${randomUUIDv7()}`;

    const conversation: DurableConversation = {
      id: conversationId,
      taskId,
      projectId,
      title: "Test conversation",
      agents: [],
      participants: [],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ledger.createConversation(conversation);

    const turn: ConversationTurn = {
      id: `turn-${randomUUIDv7()}`,
      conversationId,
      turnIndex: 0,
      agentId: "agent-1",
      actor: "agent",
      messageType: "agent_response",
      content: "This is a response",
      timestamp: new Date().toISOString(),
    };

    await ledger.addTurn(turn);

    const turns = await ledger.getTurnsByConversation(conversationId);
    expect(turns.length).toBe(1);
    expect(turns[0].content).toBe("This is a response");
  });

  it("should record and retrieve agent decisions", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;
    const conversationId = `conv-${randomUUIDv7()}`;

    const conversation: DurableConversation = {
      id: conversationId,
      taskId,
      projectId,
      title: "Decision test",
      agents: [],
      participants: [],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ledger.createConversation(conversation);

    const decision: AgentDecision = {
      id: `dec-${randomUUIDv7()}`,
      conversationId,
      turnIndex: 1,
      agentId: "agent-1",
      decision: "Proceed with implementation",
      reasoning: "Requirements are clear",
      confidence: 0.95,
      timestamp: new Date().toISOString(),
    };

    await ledger.recordDecision(decision);

    const decisions = await ledger.getDecisionsByConversation(conversationId);
    expect(decisions.length).toBe(1);
    expect(decisions[0].confidence).toBe(0.95);
  });

  it("should record audit entries", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;

    const entry = {
      id: `audit-${randomUUIDv7()}`,
      taskId,
      projectId,
      timestamp: new Date().toISOString(),
      actor: "agent-1",
      action: "created_pull_request",
      result: "success" as const,
    };

    await ledger.addAuditEntry(entry);

    const trail = await ledger.getAuditTrail(taskId);
    expect(trail.length).toBeGreaterThan(0);
    expect(trail[0].action).toBe("created_pull_request");
  });

  it("should list conversations by project", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const conv1: DurableConversation = {
      id: `conv-${randomUUIDv7()}`,
      taskId: `task-${randomUUIDv7()}`,
      projectId,
      title: "Conversation 1",
      agents: [],
      participants: [],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const conv2: DurableConversation = {
      id: `conv-${randomUUIDv7()}`,
      taskId: `task-${randomUUIDv7()}`,
      projectId,
      title: "Conversation 2",
      agents: [],
      participants: [],
      turns: [],
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ledger.createConversation(conv1);
    await ledger.createConversation(conv2);

    const convs = await ledger.listConversations(projectId);
    expect(convs.length).toBeGreaterThanOrEqual(2);
  });

  it("should get conversations by status", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const active: DurableConversation = {
      id: `conv-${randomUUIDv7()}`,
      taskId: `task-${randomUUIDv7()}`,
      projectId,
      title: "Active",
      agents: [],
      participants: [],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const completed: DurableConversation = {
      id: `conv-${randomUUIDv7()}`,
      taskId: `task-${randomUUIDv7()}`,
      projectId,
      title: "Completed",
      agents: [],
      participants: [],
      turns: [],
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ledger.createConversation(active);
    await ledger.createConversation(completed);

    const active_convs = await ledger.getConversationsByStatus("active", projectId);
    expect(active_convs.map((c) => c.title)).toContain("Active");
  });
});

// ============================================================================
// Agent Context Builder Tests
// ============================================================================

describe("AgentContextBuilder", () => {
  it("should build initial context for agent", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const agentId = `agent-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const context = await contextBuilder.buildContext(
      taskId,
      agentId,
      "architect",
      projectId,
      "Design the system",
      "Create architecture for new feature",
      ["Must handle 1000 RPS", "Must be secure"],
    );

    expect(context.taskId).toBe(taskId);
    expect(context.role).toBe("architect");
    expect(context.task.criteria.length).toBe(2);
    expect(context.currentState.phase).toBe("planning");
  });

  it("should update context progress", async () => {
    const context = await contextBuilder.buildContext(
      `task-${randomUUIDv7()}`,
      `agent-${randomUUIDv7()}`,
      "builder",
      `proj-${randomUUIDv7()}`,
      "Implement feature",
      "Write the code",
      [],
    );

    const updated = await contextBuilder.updateContextProgress(context, 50, "implementation");

    expect(updated.currentState.progress).toBe(50);
    expect(updated.currentState.phase).toBe("implementation");
  });

  it("should record attempts", async () => {
    let context = await contextBuilder.buildContext(
      `task-${randomUUIDv7()}`,
      `agent-${randomUUIDv7()}`,
      "tester",
      `proj-${randomUUIDv7()}`,
      "Run tests",
      "Execute test suite",
      [],
    );

    context = await contextBuilder.recordAttempt(context, 1, "run_tests", "2 failures", false);

    expect(context.previousAttempts?.length).toBe(1);
    expect(context.previousAttempts?.[0].success).toBe(false);
  });

  it("should add and resolve blockers", async () => {
    let context = await contextBuilder.buildContext(
      `task-${randomUUIDv7()}`,
      `agent-${randomUUIDv7()}`,
      "builder",
      `proj-${randomUUIDv7()}`,
      "Implement",
      "Code",
      [],
    );

    context = await contextBuilder.addBlocker(context, "Missing dependency");
    expect(context.currentState.blockers?.length).toBe(1);

    context = await contextBuilder.resolveBlocker(context, "Missing dependency");
    expect(context.currentState.blockers?.length).toBe(0);
  });
});

// ============================================================================
// Autonomous Collaboration Engine Tests
// ============================================================================

describe("AutonomousCollaborationEngine", () => {
  it("should start collaboration", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    // Create test agents
    const agents: AgentIdentity[] = [
      {
        id: "agent-architect",
        handle: "@architect",
        displayName: "Architect",
        kind: "role",
        capabilities: [],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    for (const agent of agents) {
      await agentRegistry.createIdentity(agent);
    }

    const conversation = await engine.startCollaboration(
      `task-${randomUUIDv7()}`,
      projectId,
      "Build new feature",
    );

    expect(conversation).toBeDefined();
    expect(conversation.status).toBe("active");
    expect(conversation.projectId).toBe(projectId);
  });

  it("should run autonomous loop", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;

    // Create agents
    const agents: AgentIdentity[] = [
      {
        id: "agent-architect",
        handle: "@architect",
        displayName: "Architect",
        kind: "role",
        capabilities: [],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    for (const agent of agents) {
      await agentRegistry.createIdentity(agent);
    }

    const conversation = await engine.startCollaboration(taskId, projectId, "Build feature");
    const loop = await engine.runAutonomousLoop(conversation.id);

    expect(loop.totalSteps).toBe(5);
    expect(loop.completedSteps).toBeGreaterThan(0);
  });

  it("should transition phases", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const agents: AgentIdentity[] = [
      {
        id: "agent-architect",
        handle: "@architect",
        displayName: "Architect",
        kind: "role",
        capabilities: [],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    for (const agent of agents) {
      await agentRegistry.createIdentity(agent);
    }

    const conversation = await engine.startCollaboration(
      `task-${randomUUIDv7()}`,
      projectId,
      "Test",
    );

    await engine.transitionPhase(conversation.id, "design", "agent-architect");

    const state = await ledger.getCollaborationState(conversation.taskId);
    expect(state?.phase).toBe("design");
  });

  it("should conclude collaboration", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const agents: AgentIdentity[] = [
      {
        id: "agent-architect",
        handle: "@architect",
        displayName: "Architect",
        kind: "role",
        capabilities: [],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    for (const agent of agents) {
      await agentRegistry.createIdentity(agent);
    }

    const conversation = await engine.startCollaboration(
      `task-${randomUUIDv7()}`,
      projectId,
      "Complete task",
    );

    await engine.concludeCollaboration(conversation.id, "completed");

    const final = await ledger.getConversation(conversation.id);
    expect(final?.status).toBe("completed");
  });
});
