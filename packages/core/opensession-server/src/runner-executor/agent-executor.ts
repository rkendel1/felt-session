/**
 * Agent Executor Service for Mission Control.
 *
 * Manages agent command execution within worktrees with full audit trail.
 */

import { spawn } from "child_process";
import { randomUUIDv7 } from "bun";
import type { MissionControlWorktree } from "./mission-control-worktree";
import type { MissionControlAgentRun } from "./mission-control-agent-run";
import type { DurableWorktreeRegistry } from "./durable-worktree-registry";
import type { DurableAgentRunRegistry } from "./durable-agent-run-registry";
import { createStandardWorktree } from "./durable-worktree-registry";
import { createStandardAgentRun } from "./durable-agent-run-registry";
import { LocalGitOperations, createLocalGitOperations } from "./local-git-operations";
import {
  FilesystemObserver,
  createFilesystemObserver,
} from "./filesystem-observer";

/**
 * Command execution options.
 */
export interface ExecutionOptions {
  timeout?: number; // milliseconds
  env?: Record<string, string>;
  captureOutput?: boolean;
  captureFiles?: boolean;
}

/**
 * Command execution result.
 */
export interface ExecutionResult {
  runId: string;
  success: boolean;
  exitCode: number;
  output: string;
  error: string;
  durationMs: number;
  filesChanged?: number;
}

/**
 * Agent Executor Service
 */
export class AgentExecutor {
  private projectId: string;
  private repositoryId: string;
  private repositoryPath: string;
  private worktreeRegistry: DurableWorktreeRegistry;
  private runRegistry: DurableAgentRunRegistry;
  private git: LocalGitOperations;
  private fsObserver: FilesystemObserver;

  constructor(
    projectId: string,
    repositoryId: string,
    repositoryPath: string,
    worktreeRegistry: DurableWorktreeRegistry,
    runRegistry: DurableAgentRunRegistry,
  ) {
    this.projectId = projectId;
    this.repositoryId = repositoryId;
    this.repositoryPath = repositoryPath;
    this.worktreeRegistry = worktreeRegistry;
    this.runRegistry = runRegistry;
    this.git = createLocalGitOperations(repositoryPath);
    this.fsObserver = createFilesystemObserver(repositoryPath);
  }

  /**
   * Create a new worktree for an agent to work in.
   */
  async createWorktree(
    agentId: string,
    taskId?: string,
    branch?: string,
    baseBranch = "main",
  ): Promise<MissionControlWorktree> {
    const worktreeId = `wt-${randomUUIDv7()}`;
    const worktreeBranch = branch || `agent/${agentId}/${taskId || randomUUIDv7().substring(0, 8)}`;
    const worktreePath = `${this.repositoryPath}/.git/worktrees/${worktreeId}`;

    // Create worktree in git
    const result = await this.git.createWorktree(
      worktreePath,
      worktreeBranch,
      baseBranch,
    );

    if (!result.success) {
      throw new Error(`Failed to create worktree: ${result.stderr}`);
    }

    // Get current commit
    const commit = await this.git.getCurrentCommit(worktreePath);

    // Create worktree record
    const worktree = createStandardWorktree(
      worktreeId,
      this.projectId,
      this.repositoryId,
      worktreePath,
      worktreeBranch,
      commit,
    );
    worktree.agentId = agentId;
    worktree.taskId = taskId;

    await this.worktreeRegistry.createWorktree(worktree);

    return worktree;
  }

  /**
   * Execute a command in a worktree.
   */
  async executeCommand(
    worktreeId: string,
    agentId: string,
    command: string,
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const worktree = await this.worktreeRegistry.getWorktree(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    const runId = `run-${randomUUIDv7()}`;

    // Create run record
    const run = createStandardAgentRun(
      runId,
      this.projectId,
      agentId,
      command,
      worktree.path,
    );
    run.worktreeId = worktreeId;

    await this.runRegistry.createRun(run);
    await this.runRegistry.markRunStarted(runId);

    try {
      // Scan filesystem before execution
      const filesBefore = options.captureFiles
        ? await this.fsObserver.scan()
        : [];

      // Execute command
      const result = await this.executeProcess(
        command,
        worktree.path,
        options,
      );

      // Scan filesystem after execution
      let filesChanged = 0;
      if (options.captureFiles) {
        const filesAfter = await this.fsObserver.scan();
        filesChanged = filesAfter.length - filesBefore.length;
      }

      // Record environment
      const branch = await this.git.getCurrentBranch(worktree.path);
      const commit = await this.git.getCurrentCommit(worktree.path);
      const status = await this.git.getStatus(worktree.path);

      await this.runRegistry.recordRunEnvironment({
        id: `env-${randomUUIDv7()}`,
        agentRunId: runId,
        workingDirectory: worktree.path,
        environmentVariables: options.env || {},
        gitBranch: branch,
        gitCommit: commit,
        gitStatus: status,
      });

      // Update worktree state
      await this.worktreeRegistry.updateWorktreeHead(worktreeId, commit);

      // Mark run as completed
      await this.runRegistry.markRunCompleted(
        runId,
        result.success ? "succeeded" : "failed",
        result.stdout,
        result.stderr || undefined,
        result.exitCode,
      );

      return {
        runId,
        success: result.success,
        exitCode: result.exitCode,
        output: result.stdout,
        error: result.stderr,
        durationMs: result.durationMs,
        filesChanged,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.runRegistry.markRunCompleted(
        runId,
        "failed",
        undefined,
        errorMessage,
        1,
      );

      throw error;
    }
  }

  /**
   * Get worktree files.
   */
  async getWorktreeFiles(worktreeId: string): Promise<string[]> {
    const worktree = await this.worktreeRegistry.getWorktree(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    return this.git.listFiles(undefined, worktree.path);
  }

  /**
   * Get worktree status.
   */
  async getWorktreeStatus(worktreeId: string) {
    const worktree = await this.worktreeRegistry.getWorktree(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    const branch = await this.git.getCurrentBranch(worktree.path);
    const commit = await this.git.getCurrentCommit(worktree.path);
    const status = await this.git.getStatus(worktree.path);
    const changed = await this.git.getChangedFiles(
      worktree.baseCommit,
      worktree.path,
    );

    return {
      branch,
      commit,
      status,
      changedFiles: changed,
    };
  }

  /**
   * Clean up a worktree.
   */
  async deleteWorktree(worktreeId: string, force = false): Promise<void> {
    const worktree = await this.worktreeRegistry.getWorktree(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    // Delete worktree from git
    await this.git.deleteWorktree(worktree.path, force);

    // Update status in registry
    worktree.status = "archived";
    await this.worktreeRegistry.updateWorktree(worktree);
  }

  /**
   * Execute a process and capture output.
   */
  private executeProcess(
    command: string,
    cwd: string,
    options: ExecutionOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean; durationMs: number }> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      // Parse command
      const parts = command.split(" ");
      const executable = parts[0];
      const args = parts.slice(1);

      const child = spawn(executable, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...globalThis.process.env, ...options.env },
        timeout: options.timeout,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code: number | null) => {
        const durationMs = Date.now() - startTime;
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
          success: code === 0 || code === null,
          durationMs,
        });
      });

      child.on("error", (error: Error) => {
        const durationMs = Date.now() - startTime;
        resolve({
          stdout: "",
          stderr: error.message,
          exitCode: 1,
          success: false,
          durationMs,
        });
      });
    });
  }
}

/**
 * Create an agent executor.
 */
export function createAgentExecutor(
  projectId: string,
  repositoryId: string,
  repositoryPath: string,
  worktreeRegistry: DurableWorktreeRegistry,
  runRegistry: DurableAgentRunRegistry,
): AgentExecutor {
  return new AgentExecutor(
    projectId,
    repositoryId,
    repositoryPath,
    worktreeRegistry,
    runRegistry,
  );
}
