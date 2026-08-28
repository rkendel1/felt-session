/**
 * Mission Control Worktree type definitions.
 *
 * A Worktree represents a local git worktree managed by an agent.
 * It tracks the local filesystem state, git history, and agent ownership.
 */

/**
 * MissionControlWorktree represents a local git worktree.
 *
 * Worktrees enable agents to isolate work, make changes, and experiment
 * without affecting the main branch or other worktrees.
 */
export interface MissionControlWorktree {
  id: string;
  projectId: string;
  repositoryId: string;
  path: string;
  branch: string;
  baseCommit: string; // commit this worktree is based on
  headCommit: string; // current HEAD commit
  agentId?: string; // agent currently owning this worktree
  taskId?: string; // task this worktree is working on
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * WorktreeStatus represents the lifecycle state of a worktree.
 */
export type WorktreeStatus = "active" | "error" | "completed" | "archived";

/**
 * File inventory for a worktree.
 */
export interface WorktreeFile {
  id: string;
  worktreeId: string;
  path: string;
  status: "unchanged" | "modified" | "created" | "deleted";
  size?: number;
  lastModified?: string;
}

/**
 * Change set for a worktree.
 */
export interface WorktreeChanges {
  id: string;
  worktreeId: string;
  fromCommit: string;
  toCommit: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
  createdAt: string;
}
