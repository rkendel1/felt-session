/**
 * PR7 Unified Agent Context and Autonomous Collaboration: Comprehensive tests
 *
 * Tests for context engine, collaboration state machine, evidence gates, and recovery.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { randomUUIDv7 } from "bun";

import {
  openDurableCollaborationStateRegistry,
  type DurableCollaborationStateRegistry,
} from "./durable-collaboration-state-registry";
import {
  openDurableConversationLedger,
  type DurableConversationLedger,
} from "./durable-conversation-ledger";
import type {
  CollaborationPhase,
  AutonomousCollaborationOrchestrator,
} from "./autonomous-collaboration-orchestrator";
import { EVIDENCE_GATES, PHASE_AGENT_MAP } from "./autonomous-collaboration-orchestrator";

let testCounter = 0;
let testDir: string;
let stateRegistry: DurableCollaborationStateRegistry;
let ledger: DurableConversationLedger;

beforeEach(() => {
  testDir = `/tmp/pr7-test-${Date.now()}-${testCounter++}`;
  fs.mkdirSync(testDir, { recursive: true });

  stateRegistry = openDurableCollaborationStateRegistry(
    path.join(testDir, "state.db")
  );
  ledger = openDurableConversationLedger(path.join(testDir, "ledger.db"));
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe("PR7: Unified Agent Context and Autonomous Collaboration", () => {
  // ========================================================================
  // 1. Collaboration State Machine
  // ========================================================================

  it("should initialize collaboration state", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const state = await stateRegistry.createState(taskId, projectId);

    expect(state.taskId).toBe(taskId);
    expect(state.projectId).toBe(projectId);
    expect(state.phase).toBe("TASK_CREATED");
    expect(state.failedAttempts).toBe(0);
  });

  it("should transition phases with evidence", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const state = await stateRegistry.createState(taskId, projectId);
    expect(state.phase).toBe("TASK_CREATED");

    // Transition to ARCHITECTING
    const transition = await stateRegistry.transitionPhase(
      taskId,
      "ARCHITECTING",
      "architect-1",
      [{ type: "task_created", ref: taskId }]
    );

    expect(transition.fromPhase).toBe("TASK_CREATED");
    expect(transition.toPhase).toBe("ARCHITECTING");
    expect(transition.evidence.length).toBe(1);

    const updated = await stateRegistry.getState(taskId);
    expect(updated?.phase).toBe("ARCHITECTING");
  });

  it("should track phase transition history", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    await stateRegistry.createState(taskId, projectId);

    // Multiple transitions
    const phases: CollaborationPhase[] = [
      "ARCHITECTING",
      "DESIGNED",
      "BUILDING",
    ];

    for (const phase of phases) {
      await stateRegistry.transitionPhase(taskId, phase, "agent", [
        { type: "test", ref: `test-${phase}` },
      ]);
    }

    const history = await stateRegistry.getTransitions(taskId);
    expect(history.length).toBe(3);
    expect(history[0].toPhase).toBe("ARCHITECTING");
    expect(history[2].toPhase).toBe("BUILDING");
  });

  it("should record failures and track attempts", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const state = await stateRegistry.createState(taskId, projectId);
    expect(state.failedAttempts).toBe(0);

    await stateRegistry.recordFailure(taskId, "BUILDING", "Tests failed");

    const recovery = await stateRegistry.getRecoveryInfo(taskId);
    expect(recovery).toBeDefined();
    expect(recovery?.incompleteAgent?.phase).toBe("BUILDING");
  });

  it("should list collaborations by project", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const task1 = `task-${randomUUIDv7()}`;
    const task2 = `task-${randomUUIDv7()}`;

    await stateRegistry.createState(task1, projectId);
    await stateRegistry.createState(task2, projectId);

    const collaborations = await stateRegistry.listByProject(projectId);
    expect(collaborations.length).toBe(2);
  });

  it("should get collaborations by phase", async () => {
    const projectId = `proj-${randomUUIDv7()}`;

    const task1 = `task-${randomUUIDv7()}`;
    const task2 = `task-${randomUUIDv7()}`;

    await stateRegistry.createState(task1, projectId);
    const state2 = await stateRegistry.createState(task2, projectId);

    // Move task2 to ARCHITECTING
    await stateRegistry.transitionPhase(
      task2,
      "ARCHITECTING",
      "agent",
      []
    );

    const inArchitecting = await stateRegistry.getByPhase(
      projectId,
      "ARCHITECTING"
    );
    expect(inArchitecting.length).toBe(1);
    expect(inArchitecting[0].taskId).toBe(task2);

    const created = await stateRegistry.getByPhase(projectId, "TASK_CREATED");
    expect(created.length).toBe(1);
    expect(created[0].taskId).toBe(task1);
  });

  it("should conclude collaboration successfully", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    await stateRegistry.createState(taskId, projectId);
    await stateRegistry.conclude(taskId, "RELEASED");

    const state = await stateRegistry.getState(taskId);
    expect(state?.phase).toBe("RELEASED");
  });

  // ========================================================================
  // 2. Evidence Gates
  // ========================================================================

  it("should verify EVIDENCE_GATES define transitions", () => {
    // TASK_CREATED can transition to ARCHITECTING
    const created = EVIDENCE_GATES["TASK_CREATED"];
    expect(created.length).toBeGreaterThan(0);
    expect(created[0].nextPhase).toBe("ARCHITECTING");

    // BUILDING requires code_committed and build_passes
    const building = EVIDENCE_GATES["BUILDING"];
    expect(building.length).toBeGreaterThan(0);
    const builtTransition = building.find((g) => g.nextPhase === "BUILT");
    expect(builtTransition?.requiredEvidence).toContain("code_committed");
    expect(builtTransition?.requiredEvidence).toContain("build_passes");
  });

  it("should map phases to agents", () => {
    expect(PHASE_AGENT_MAP["ARCHITECTING"]).toBe("architect");
    expect(PHASE_AGENT_MAP["BUILDING"]).toBe("builder");
    expect(PHASE_AGENT_MAP["REVIEWING"]).toBe("reviewer");
    expect(PHASE_AGENT_MAP["TESTING"]).toBe("tester");
    expect(PHASE_AGENT_MAP["RELEASE_READY"]).toBe("github");
  });

  // ========================================================================
  // 3. Recovery and Restart Safety
  // ========================================================================

  it("should provide recovery info for crash restart", async () => {
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const state = await stateRegistry.createState(taskId, projectId);

    // Simulate work interrupted
    await stateRegistry.recordFailure(taskId, "BUILDING", "Process crashed");

    const recovery = await stateRegistry.getRecoveryInfo(taskId);
    expect(recovery).toBeDefined();
    expect(recovery?.taskId).toBe(taskId);
    expect(recovery?.currentPhase).toBe("BUILDING");
    expect(recovery?.nextAction).toContain("Retry");
  });

  // ========================================================================
  // 4. Collaboration Conversation Integration
  // ========================================================================

  it("should link collaboration to conversation", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;

    const state = await stateRegistry.createState(taskId, projectId);

    // Create corresponding conversation
    const conv = await ledger.createConversation({
      id: `conv-${randomUUIDv7()}`,
      taskId,
      projectId,
      title: "Work on task",
      agents: ["architect"],
      participants: [],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const retrieved = await ledger.getConversationByTask(taskId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.taskId).toBe(taskId);
  });

  it("should record decisions in conversation", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;
    const convId = `conv-${randomUUIDv7()}`;

    const conv = await ledger.createConversation({
      id: convId,
      taskId,
      projectId,
      title: "Decision test",
      agents: ["architect"],
      participants: [],
      turns: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await ledger.recordDecision({
      id: `dec-${randomUUIDv7()}`,
      conversationId: convId,
      turnIndex: 1,
      agentId: "architect",
      decision: "Use microservices",
      reasoning: "Scalability required",
      confidence: 0.95,
      timestamp: new Date().toISOString(),
    });

    const decisions = await ledger.getDecisionsByConversation(convId);
    expect(decisions.length).toBe(1);
    expect(decisions[0].decision).toBe("Use microservices");
  });

  // ========================================================================
  // 5. State Persistence
  // ========================================================================

  it("should survive restart", async () => {
    const persistPath = path.join(testDir, "persist.db");

    // Write state
    let reg1 = openDurableCollaborationStateRegistry(persistPath);
    const taskId = `task-${randomUUIDv7()}`;
    const projectId = `proj-${randomUUIDv7()}`;

    const state1 = await reg1.createState(taskId, projectId);
    await reg1.transitionPhase(
      taskId,
      "ARCHITECTING",
      "agent",
      []
    );

    // Simulate restart
    let reg2 = openDurableCollaborationStateRegistry(persistPath);
    const state2 = await reg2.getState(taskId);

    expect(state2).toBeDefined();
    expect(state2?.phase).toBe("ARCHITECTING");
  });

  // ========================================================================
  // 6. Multi-Task Isolation
  // ========================================================================

  it("should isolate collaborations between tasks", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const task1 = `task-${randomUUIDv7()}`;
    const task2 = `task-${randomUUIDv7()}`;

    const state1 = await stateRegistry.createState(task1, projectId);
    const state2 = await stateRegistry.createState(task2, projectId);

    // Transition only task1
    await stateRegistry.transitionPhase(
      task1,
      "ARCHITECTING",
      "agent",
      []
    );

    const s1 = await stateRegistry.getState(task1);
    const s2 = await stateRegistry.getState(task2);

    expect(s1?.phase).toBe("ARCHITECTING");
    expect(s2?.phase).toBe("TASK_CREATED");
  });

  // ========================================================================
  // 7. Full Collaboration Lifecycle
  // ========================================================================

  it("should complete full collaboration lifecycle", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;

    // Create
    let state = await stateRegistry.createState(taskId, projectId);
    expect(state.phase).toBe("TASK_CREATED");

    // Architect
    await stateRegistry.transitionPhase(
      taskId,
      "ARCHITECTING",
      "architect",
      []
    );
    state = await stateRegistry.getState(taskId);
    expect(state?.phase).toBe("ARCHITECTING");

    // Design
    await stateRegistry.transitionPhase(taskId, "DESIGNED", "architect", []);
    state = await stateRegistry.getState(taskId);
    expect(state?.phase).toBe("DESIGNED");

    // Build
    await stateRegistry.transitionPhase(
      taskId,
      "BUILDING",
      "builder",
      []
    );
    state = await stateRegistry.getState(taskId);
    expect(state?.phase).toBe("BUILDING");

    // Built
    await stateRegistry.transitionPhase(taskId, "BUILT", "builder", []);
    state = await stateRegistry.getState(taskId);
    expect(state?.phase).toBe("BUILT");

    // Review
    await stateRegistry.transitionPhase(
      taskId,
      "REVIEWING",
      "reviewer",
      []
    );
    state = await stateRegistry.getState(taskId);
    expect(state?.phase).toBe("REVIEWING");

    // Release
    await stateRegistry.conclude(taskId, "RELEASED");
    state = await stateRegistry.getState(taskId);
    expect(state?.phase).toBe("RELEASED");
  });

  it("should handle rejection and restart from BUILDING", async () => {
    const projectId = `proj-${randomUUIDv7()}`;
    const taskId = `task-${randomUUIDv7()}`;

    const state = await stateRegistry.createState(taskId, projectId);

    // Progress to REVIEWING
    await stateRegistry.transitionPhase(
      taskId,
      "ARCHITECTING",
      "architect",
      []
    );
    await stateRegistry.transitionPhase(taskId, "DESIGNED", "architect", []);
    await stateRegistry.transitionPhase(taskId, "BUILDING", "builder", []);
    await stateRegistry.transitionPhase(taskId, "BUILT", "builder", []);
    await stateRegistry.transitionPhase(
      taskId,
      "REVIEWING",
      "reviewer",
      []
    );

    // Record failure (changes requested)
    await stateRegistry.recordFailure(
      taskId,
      "REVIEWING",
      "Changes requested by reviewer"
    );

    const recovery = await stateRegistry.getRecoveryInfo(taskId);
    expect(recovery?.currentPhase).toBe("REVIEWING");
  });
});
