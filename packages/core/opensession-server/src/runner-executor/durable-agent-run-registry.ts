/**
 * Durable agent run registry backed by FeltDB.
 *
 * Agent runs capture command execution history with full audit trail,
 * enabling debugging, rollback, and performance analysis.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import type {
  MissionControlAgentRun,
  AgentRunStatus,
  AgentRunOutput,
  AgentRunEnvironment,
} from "./mission-control-agent-run";

interface StoredAgentRunRow {
  id: string;
  projectId: string;
  agentId: string;
  taskId?: string;
  worktreeId?: string;
  command: string;
  workingDirectory: string;
  status: AgentRunStatus;
  output?: string;
  error?: string;
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredAgentRunOutputRow {
  id: string;
  agentRunId: string;
  type: "stdout" | "stderr" | "exit_code";
  content: string;
  lineNumber?: number;
  timestamp: string;
}

interface StoredAgentRunEnvironmentRow {
  id: string;
  agentRunId: string;
  workingDirectory: string;
  environmentVariables: string; // JSON
  gitBranch: string;
  gitCommit: string;
  gitStatus: "clean" | "dirty";
}

const RUNS_COLLECTION = "mission_control_agent_runs";
const OUTPUTS_COLLECTION = "mission_control_agent_run_outputs";
const ENVIRONMENTS_COLLECTION = "mission_control_agent_run_environments";

/**
 * DurableAgentRunRegistry manages persistent agent run records in FeltDB.
 */
export interface DurableAgentRunRegistry {
  /**
   * Create a new agent run.
   */
  createRun(run: MissionControlAgentRun): Promise<void>;

  /**
   * Retrieve a run by ID.
   */
  getRun(runId: string): Promise<MissionControlAgentRun | null>;

  /**
   * List all runs for an agent.
   */
  listRunsByAgent(agentId: string): Promise<MissionControlAgentRun[]>;

  /**
   * List all runs for a task.
   */
  listRunsByTask(taskId: string): Promise<MissionControlAgentRun[]>;

  /**
   * List all runs for a worktree.
   */
  listRunsByWorktree(worktreeId: string): Promise<MissionControlAgentRun[]>;

  /**
   * List all failed runs for a project.
   */
  listFailedRunsByProject(projectId: string): Promise<MissionControlAgentRun[]>;

  /**
   * Update a run (e.g., mark as completed).
   */
  updateRun(run: MissionControlAgentRun): Promise<void>;

  /**
   * Mark a run as started.
   */
  markRunStarted(runId: string): Promise<void>;

  /**
   * Mark a run as completed.
   */
  markRunCompleted(
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    output?: string,
    error?: string,
    exitCode?: number,
  ): Promise<void>;

  /**
   * Record command output.
   */
  recordRunOutput(output: AgentRunOutput): Promise<void>;

  /**
   * Get output for a run.
   */
  getRunOutput(runId: string): Promise<AgentRunOutput[]>;

  /**
   * Record execution environment.
   */
  recordRunEnvironment(env: AgentRunEnvironment): Promise<void>;

  /**
   * Get environment for a run.
   */
  getRunEnvironment(runId: string): Promise<AgentRunEnvironment | null>;
}

export function openDurableAgentRunRegistry(path: string): DurableAgentRunRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-agent-runs",
  });

  return {
    async createRun(run: MissionControlAgentRun): Promise<void> {
      const row: StoredAgentRunRow = {
        id: run.id,
        projectId: run.projectId,
        agentId: run.agentId,
        taskId: run.taskId,
        worktreeId: run.worktreeId,
        command: run.command,
        workingDirectory: run.workingDirectory,
        status: run.status,
        output: run.output,
        error: run.error,
        exitCode: run.exitCode,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentRunRow>(RUNS_COLLECTION).set(run.id, row);
      });
    },

    async getRun(runId: string): Promise<MissionControlAgentRun | null> {
      const row = await db
        .collection<StoredAgentRunRow>(RUNS_COLLECTION)
        .get(runId);

      if (!row) return null;
      return deserializeRun(row);
    },

    async listRunsByAgent(agentId: string): Promise<MissionControlAgentRun[]> {
      const results = await db
        .collection<StoredAgentRunRow>(RUNS_COLLECTION)
        .find({ agentId });

      return results.map(deserializeRun);
    },

    async listRunsByTask(taskId: string): Promise<MissionControlAgentRun[]> {
      const results = await db
        .collection<StoredAgentRunRow>(RUNS_COLLECTION)
        .find({ taskId });

      return results.map(deserializeRun);
    },

    async listRunsByWorktree(worktreeId: string): Promise<MissionControlAgentRun[]> {
      const results = await db
        .collection<StoredAgentRunRow>(RUNS_COLLECTION)
        .find({ worktreeId });

      return results.map(deserializeRun);
    },

    async listFailedRunsByProject(projectId: string): Promise<MissionControlAgentRun[]> {
      const results = await db
        .collection<StoredAgentRunRow>(RUNS_COLLECTION)
        .find({ projectId, status: "failed" });

      return results.map(deserializeRun);
    },

    async updateRun(run: MissionControlAgentRun): Promise<void> {
      const row: StoredAgentRunRow = {
        id: run.id,
        projectId: run.projectId,
        agentId: run.agentId,
        taskId: run.taskId,
        worktreeId: run.worktreeId,
        command: run.command,
        workingDirectory: run.workingDirectory,
        status: run.status,
        output: run.output,
        error: run.error,
        exitCode: run.exitCode,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentRunRow>(RUNS_COLLECTION).set(run.id, row);
      });
    },

    async markRunStarted(runId: string): Promise<void> {
      const run = await this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);

      run.status = "running";
      run.startedAt = new Date().toISOString();
      run.updatedAt = new Date().toISOString();

      await this.updateRun(run);
    },

    async markRunCompleted(
      runId: string,
      status: "succeeded" | "failed" | "cancelled",
      output?: string,
      error?: string,
      exitCode?: number,
    ): Promise<void> {
      const run = await this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);

      const now = new Date().toISOString();
      run.status = status;
      run.completedAt = now;
      run.output = output;
      run.error = error;
      run.exitCode = exitCode;
      if (run.startedAt) {
        run.durationMs =
          new Date(now).getTime() - new Date(run.startedAt).getTime();
      }
      run.updatedAt = now;

      await this.updateRun(run);
    },

    async recordRunOutput(output: AgentRunOutput): Promise<void> {
      const row: StoredAgentRunOutputRow = {
        id: output.id,
        agentRunId: output.agentRunId,
        type: output.type,
        content: output.content,
        lineNumber: output.lineNumber,
        timestamp: output.timestamp,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentRunOutputRow>(OUTPUTS_COLLECTION).set(output.id, row);
      });
    },

    async getRunOutput(runId: string): Promise<AgentRunOutput[]> {
      const rows = await db
        .collection<StoredAgentRunOutputRow>(OUTPUTS_COLLECTION)
        .find({ agentRunId: runId });

      return rows.map((row) => ({
        id: row.id,
        agentRunId: row.agentRunId,
        type: row.type,
        content: row.content,
        lineNumber: row.lineNumber,
        timestamp: row.timestamp,
      }));
    },

    async recordRunEnvironment(env: AgentRunEnvironment): Promise<void> {
      const row: StoredAgentRunEnvironmentRow = {
        id: env.id,
        agentRunId: env.agentRunId,
        workingDirectory: env.workingDirectory,
        environmentVariables: JSON.stringify(env.environmentVariables),
        gitBranch: env.gitBranch,
        gitCommit: env.gitCommit,
        gitStatus: env.gitStatus,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentRunEnvironmentRow>(ENVIRONMENTS_COLLECTION).set(
          env.id,
          row,
        );
      });
    },

    async getRunEnvironment(runId: string): Promise<AgentRunEnvironment | null> {
      const rows = await db
        .collection<StoredAgentRunEnvironmentRow>(ENVIRONMENTS_COLLECTION)
        .find({ agentRunId: runId });

      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        id: row.id,
        agentRunId: row.agentRunId,
        workingDirectory: row.workingDirectory,
        environmentVariables: JSON.parse(row.environmentVariables),
        gitBranch: row.gitBranch,
        gitCommit: row.gitCommit,
        gitStatus: row.gitStatus,
      };
    },
  };
}

function deserializeRun(row: StoredAgentRunRow): MissionControlAgentRun {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    taskId: row.taskId,
    worktreeId: row.worktreeId,
    command: row.command,
    workingDirectory: row.workingDirectory,
    status: row.status,
    output: row.output,
    error: row.error,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a standard agent run.
 */
export function createStandardAgentRun(
  id: string,
  projectId: string,
  agentId: string,
  command: string,
  workingDirectory: string,
  taskId?: string,
  worktreeId?: string,
): MissionControlAgentRun {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    agentId,
    taskId,
    worktreeId,
    command,
    workingDirectory,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}
