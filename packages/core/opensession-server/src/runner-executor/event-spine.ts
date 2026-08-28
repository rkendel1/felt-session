/**
 * Mission Control event spine.
 *
 * Every meaningful thing becomes an event, recorded through the
 * DurableCommandLedger, making the ledger the source of truth for
 * session state and enabling durable projections (Slack, UI, etc).
 *
 * Events are immutable and append-only. They record what happened,
 * not what should happen next. Projections consume these events to
 * build derived state (e.g. current task status).
 */

import type { ExecutorStreamEvent } from "@tellahq/opensession-protocol/executor";

/** Unique event identifier, globally scoped. */
export interface EventId {
  sessionId: string;
  eventSequence: number;
}

/** Base properties all events share. */
export interface MissionControlEvent {
  kind: string;
  id: EventId;
  timestamp: string;
  causality?: {
    executionId?: string;
    commandId?: string;
    precedingEventId?: EventId;
  };
}

/** Session was created. */
export interface SessionCreatedEvent extends MissionControlEvent {
  kind: "session.created";
  projectId: string;
  repository: string;
  branch: string;
  initiatedBy: string;
}

/** Task was created within the session. */
export interface TaskCreatedEvent extends MissionControlEvent {
  kind: "task.created";
  taskId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
}

/** Task was assigned to an agent. */
export interface TaskAssignedEvent extends MissionControlEvent {
  kind: "task.assigned";
  taskId: string;
  agentId: string;
  role: "architect" | "builder" | "reviewer" | "tester" | "release";
}

/** Agent started work. */
export interface AgentStartedEvent extends MissionControlEvent {
  kind: "agent.started";
  agentId: string;
  role: "architect" | "builder" | "reviewer" | "tester" | "release";
  model: string;
}

/** Agent sent a message (to human, another agent, or UI). */
export interface AgentMessageEvent extends MissionControlEvent {
  kind: "agent.message";
  agentId: string;
  message: string;
  recipient?: {
    type: "human" | "agent" | "ui";
    id?: string;
  };
}

/** Agent started executing a command (file operation, process, etc). */
export interface AgentExecutionStartedEvent extends MissionControlEvent {
  kind: "agent.execution.started";
  agentId: string;
  executionId: string;
  operation: unknown;
}

/** Agent command completed. */
export interface AgentExecutionCompletedEvent extends MissionControlEvent {
  kind: "agent.execution.completed";
  agentId: string;
  executionId: string;
  state: "succeeded" | "failed" | "cancelled";
  outcome?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/** Tool was called (from agent code or coding-agent). */
export interface ToolCalledEvent extends MissionControlEvent {
  kind: "tool.called";
  toolName: string;
  agentId?: string;
  arguments: Record<string, unknown>;
}

/** Tool call completed. */
export interface ToolCompletedEvent extends MissionControlEvent {
  kind: "tool.completed";
  toolName: string;
  toolCallId: string;
  result: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/** Commit was created. */
export interface CommitCreatedEvent extends MissionControlEvent {
  kind: "commit.created";
  repository: string;
  sha: string;
  message: string;
  author: string;
  taskId?: string;
  executionId?: string;
}

/** Review was requested. */
export interface ReviewRequestedEvent extends MissionControlEvent {
  kind: "review.requested";
  revieweeId: string;
  reviewerId: string;
  taskId: string;
  target: {
    type: "commit" | "pr" | "artifact";
    reference: string;
  };
}

/** Review completed. */
export interface ReviewCompletedEvent extends MissionControlEvent {
  kind: "review.completed";
  reviewerId: string;
  state: "approved" | "rejected" | "requested_changes";
  feedback?: string;
  taskId: string;
}

/** Test started. */
export interface TestStartedEvent extends MissionControlEvent {
  kind: "test.started";
  agentId: string;
  testName: string;
  taskId: string;
}

/** Test completed. */
export interface TestCompletedEvent extends MissionControlEvent {
  kind: "test.completed";
  testName: string;
  state: "passed" | "failed";
  taskId: string;
  output?: string;
}

/** Task was blocked waiting for something. */
export interface TaskBlockedEvent extends MissionControlEvent {
  kind: "task.blocked";
  taskId: string;
  reason: string;
  blockedBy?: string[];
}

/** Task was completed. */
export interface TaskCompletedEvent extends MissionControlEvent {
  kind: "task.completed";
  taskId: string;
  state: "succeeded" | "failed";
  summary?: string;
}

/** Human made a decision (approved continuation, etc). */
export interface HumanDecisionEvent extends MissionControlEvent {
  kind: "human.decision";
  decision: string;
  decisionBy: string;
  context?: {
    taskId?: string;
    relatedEventIds?: EventId[];
  };
}

export type AnyMissionControlEvent =
  | SessionCreatedEvent
  | TaskCreatedEvent
  | TaskAssignedEvent
  | AgentStartedEvent
  | AgentMessageEvent
  | AgentExecutionStartedEvent
  | AgentExecutionCompletedEvent
  | ToolCalledEvent
  | ToolCompletedEvent
  | CommitCreatedEvent
  | ReviewRequestedEvent
  | ReviewCompletedEvent
  | TestStartedEvent
  | TestCompletedEvent
  | TaskBlockedEvent
  | TaskCompletedEvent
  | HumanDecisionEvent;

/** Event spine: append-only log of all session events. */
export interface EventSpine {
  /** Record a new event, persisted durably through the ledger. */
  record(event: AnyMissionControlEvent): Promise<EventId>;

  /** Retrieve a range of events by sequence. */
  range(
    sessionId: string,
    fromSequence: number,
    toSequence?: number,
  ): Promise<AnyMissionControlEvent[]>;

  /** Get all events up to a point in time. */
  since(sessionId: string, timestamp: string): Promise<AnyMissionControlEvent[]>;

  /** Count events in a session. */
  count(sessionId: string): Promise<number>;
}
