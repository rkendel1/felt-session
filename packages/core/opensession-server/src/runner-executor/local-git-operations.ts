/**
 * Local git operations service for Mission Control.
 *
 * Handles all git operations: cloning, creating worktrees, managing state.
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { promisify } from "util";

const exec = promisify(require("child_process").exec);

/**
 * Git command execution result.
 */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Git worktree information.
 */
export interface GitWorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  detached: boolean;
}

/**
 * File change information.
 */
export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  additions?: number;
  deletions?: number;
}

/**
 * Local Git Operations Service
 */
export class LocalGitOperations {
  private repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = repositoryPath;
  }

  /**
   * Clone a repository.
   */
  async clone(
    remoteUrl: string,
    destination: string,
    branch?: string,
  ): Promise<GitResult> {
    const args = ["clone"];
    if (branch) {
      args.push("--branch", branch);
    }
    args.push(remoteUrl, destination);

    return this.executeGit(args, path.dirname(destination));
  }

  /**
   * Create a worktree.
   */
  async createWorktree(
    worktreePath: string,
    branch: string,
    baseBranch?: string,
  ): Promise<GitResult> {
    const args = ["worktree", "add", "-b", branch, worktreePath];
    if (baseBranch) {
      args.push(baseBranch);
    }

    return this.executeGit(args, this.repositoryPath);
  }

  /**
   * List all worktrees in this repository.
   */
  async listWorktrees(): Promise<GitWorktreeInfo[]> {
    const result = await this.executeGit(
      ["worktree", "list", "--porcelain"],
      this.repositoryPath,
    );

    if (!result.success) {
      return [];
    }

    const worktrees: GitWorktreeInfo[] = [];
    const lines = result.stdout.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split(" ");
      if (parts.length < 3) continue;

      const worktreePath = parts[0];
      const commit = parts[1];
      const branchMatch = parts[2].match(/branch refs\/heads\/(.+)/);
      const branch = branchMatch ? branchMatch[1] : "detached";

      worktrees.push({
        path: worktreePath,
        branch,
        commit,
        detached: !branchMatch,
      });
    }

    return worktrees;
  }

  /**
   * Delete a worktree.
   */
  async deleteWorktree(worktreePath: string, force = false): Promise<GitResult> {
    const args = ["worktree", "remove"];
    if (force) {
      args.push("--force");
    }
    args.push(worktreePath);

    return this.executeGit(args, this.repositoryPath);
  }

  /**
   * Get current branch name.
   */
  async getCurrentBranch(workingPath?: string): Promise<string> {
    const result = await this.executeGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      workingPath || this.repositoryPath,
    );

    if (!result.success) {
      return "unknown";
    }

    return result.stdout.trim();
  }

  /**
   * Get current HEAD commit SHA.
   */
  async getCurrentCommit(workingPath?: string): Promise<string> {
    const result = await this.executeGit(
      ["rev-parse", "HEAD"],
      workingPath || this.repositoryPath,
    );

    if (!result.success) {
      return "unknown";
    }

    return result.stdout.trim();
  }

  /**
   * Check git status (clean or dirty).
   */
  async getStatus(workingPath?: string): Promise<"clean" | "dirty"> {
    const result = await this.executeGit(
      ["status", "--porcelain"],
      workingPath || this.repositoryPath,
    );

    if (!result.success) {
      return "dirty";
    }

    return result.stdout.trim().length === 0 ? "clean" : "dirty";
  }

  /**
   * Get list of changed files since a commit.
   */
  async getChangedFiles(
    sinceCommit: string,
    workingPath?: string,
  ): Promise<FileChange[]> {
    const result = await this.executeGit(
      ["diff", "--name-status", sinceCommit + "...HEAD"],
      workingPath || this.repositoryPath,
    );

    if (!result.success) {
      return [];
    }

    const changes: FileChange[] = [];
    const lines = result.stdout.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      const [status, ...pathParts] = line.split("\t");
      const filePath = pathParts.join("\t");

      const statusMap: Record<string, FileChange["status"]> = {
        A: "added",
        M: "modified",
        D: "deleted",
        R: "renamed",
        C: "copied",
      };

      changes.push({
        path: filePath,
        status: (statusMap[status] || "modified") as FileChange["status"],
      });
    }

    return changes;
  }

  /**
   * Get diff stats for commits.
   */
  async getDiffStats(
    fromCommit: string,
    toCommit: string,
    workingPath?: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
    const result = await this.executeGit(
      ["diff", "--stat", fromCommit + "..." + toCommit],
      workingPath || this.repositoryPath,
    );

    if (!result.success) {
      return { filesChanged: 0, insertions: 0, deletions: 0 };
    }

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    const lines = result.stdout.trim().split("\n");
    for (const line of lines) {
      const match = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (match) {
        filesChanged = parseInt(match[1], 10);
        insertions = match[2] ? parseInt(match[2], 10) : 0;
        deletions = match[3] ? parseInt(match[3], 10) : 0;
        break;
      }
    }

    return { filesChanged, insertions, deletions };
  }

  /**
   * Stage all changes.
   */
  async stageAll(workingPath?: string): Promise<GitResult> {
    return this.executeGit(["add", "-A"], workingPath || this.repositoryPath);
  }

  /**
   * Commit staged changes.
   */
  async commit(
    message: string,
    workingPath?: string,
  ): Promise<GitResult> {
    return this.executeGit(
      ["commit", "-m", message],
      workingPath || this.repositoryPath,
    );
  }

  /**
   * Push changes to remote.
   */
  async push(
    remote = "origin",
    branch?: string,
    workingPath?: string,
  ): Promise<GitResult> {
    const args = ["push", remote];
    if (branch) {
      args.push(branch);
    }

    return this.executeGit(args, workingPath || this.repositoryPath);
  }

  /**
   * Fetch from remote.
   */
  async fetch(remote = "origin", workingPath?: string): Promise<GitResult> {
    return this.executeGit(
      ["fetch", remote],
      workingPath || this.repositoryPath,
    );
  }

  /**
   * Create a branch.
   */
  async createBranch(
    branchName: string,
    baseBranch?: string,
    workingPath?: string,
  ): Promise<GitResult> {
    const args = ["branch", branchName];
    if (baseBranch) {
      args.push(baseBranch);
    }

    return this.executeGit(args, workingPath || this.repositoryPath);
  }

  /**
   * Checkout a branch.
   */
  async checkout(branch: string, workingPath?: string): Promise<GitResult> {
    return this.executeGit(
      ["checkout", branch],
      workingPath || this.repositoryPath,
    );
  }

  /**
   * List files in repository at a given commit.
   */
  async listFiles(
    commit?: string,
    workingPath?: string,
  ): Promise<string[]> {
    const args = ["ls-tree", "-r", "--name-only"];
    if (commit) {
      args.push(commit);
    } else {
      args.push("HEAD");
    }

    const result = await this.executeGit(args, workingPath || this.repositoryPath);

    if (!result.success) {
      return [];
    }

    return result.stdout.trim().split("\n").filter((f) => f.trim());
  }

  /**
   * Get file content at a commit.
   */
  async getFileContent(filePath: string, commit?: string, workingPath?: string): Promise<string | null> {
    const ref = commit ? commit : "HEAD";
    const result = await this.executeGit(
      ["show", `${ref}:${filePath}`],
      workingPath || this.repositoryPath,
    );

    if (!result.success) {
      return null;
    }

    return result.stdout;
  }

  /**
   * Execute a git command.
   */
  private async executeGit(args: string[], workingPath: string): Promise<GitResult> {
    return new Promise((resolve) => {
      const process = spawn("git", args, {
        cwd: workingPath,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      process.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      process.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
          success: code === 0 || code === null,
        });
      });

      process.on("error", (error) => {
        resolve({
          stdout: "",
          stderr: error.message,
          exitCode: 1,
          success: false,
        });
      });
    });
  }
}

/**
 * Create a LocalGitOperations instance for a repository.
 */
export function createLocalGitOperations(repositoryPath: string): LocalGitOperations {
  return new LocalGitOperations(repositoryPath);
}
