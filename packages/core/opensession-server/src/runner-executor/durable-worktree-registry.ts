/**
 * Durable worktree registry backed by FeltDB.
 *
 * Worktrees are persistent representations of local git worktrees,
 * enabling agents to work isolated from each other.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import type {
  MissionControlWorktree,
  WorktreeStatus,
  WorktreeFile,
  WorktreeChanges,
} from "./mission-control-worktree";

interface StoredWorktreeRow {
  id: string;
  projectId: string;
  repositoryId: string;
  path: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  agentId?: string;
  taskId?: string;
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
}

interface StoredWorktreeFileRow {
  id: string;
  worktreeId: string;
  path: string;
  status: "unchanged" | "modified" | "created" | "deleted";
  size?: number;
  lastModified?: string;
}

interface StoredWorktreeChangesRow {
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

const WORKTREES_COLLECTION = "mission_control_worktrees";
const FILES_COLLECTION = "mission_control_worktree_files";
const CHANGES_COLLECTION = "mission_control_worktree_changes";

/**
 * DurableWorktreeRegistry manages persistent worktree definitions in FeltDB.
 */
export interface DurableWorktreeRegistry {
  /**
   * Create a new worktree.
   */
  createWorktree(worktree: MissionControlWorktree): Promise<void>;

  /**
   * Retrieve a worktree by ID.
   */
  getWorktree(worktreeId: string): Promise<MissionControlWorktree | null>;

  /**
   * List all worktrees for a project.
   */
  listWorktreesByProject(projectId: string): Promise<MissionControlWorktree[]>;

  /**
   * List all worktrees for a repository.
   */
  listWorktreesByRepository(repositoryId: string): Promise<MissionControlWorktree[]>;

  /**
   * List all active worktrees for an agent.
   */
  listWorktreesByAgent(agentId: string): Promise<MissionControlWorktree[]>;

  /**
   * Update a worktree.
   */
  updateWorktree(worktree: MissionControlWorktree): Promise<void>;

  /**
   * Delete a worktree.
   */
  deleteWorktree(worktreeId: string): Promise<void>;

  /**
   * Record files in a worktree.
   */
  recordWorktreeFiles(worktreeId: string, files: WorktreeFile[]): Promise<void>;

  /**
   * Get files for a worktree.
   */
  getWorktreeFiles(worktreeId: string): Promise<WorktreeFile[]>;

  /**
   * Record a change set.
   */
  recordChanges(changes: WorktreeChanges): Promise<void>;

  /**
   * Get change history for a worktree.
   */
  getWorktreeChangeHistory(worktreeId: string): Promise<WorktreeChanges[]>;

  /**
   * Update HEAD commit for a worktree.
   */
  updateWorktreeHead(worktreeId: string, commitSha: string): Promise<void>;
}

export function openDurableWorktreeRegistry(path: string): DurableWorktreeRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-worktrees",
  });

  return {
    async createWorktree(worktree: MissionControlWorktree): Promise<void> {
      const row: StoredWorktreeRow = {
        id: worktree.id,
        projectId: worktree.projectId,
        repositoryId: worktree.repositoryId,
        path: worktree.path,
        branch: worktree.branch,
        baseCommit: worktree.baseCommit,
        headCommit: worktree.headCommit,
        agentId: worktree.agentId,
        taskId: worktree.taskId,
        status: worktree.status,
        createdAt: worktree.createdAt,
        updatedAt: worktree.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredWorktreeRow>(WORKTREES_COLLECTION).set(worktree.id, row);
      });
    },

    async getWorktree(worktreeId: string): Promise<MissionControlWorktree | null> {
      const row = await db
        .collection<StoredWorktreeRow>(WORKTREES_COLLECTION)
        .get(worktreeId);

      if (!row) return null;
      return deserializeWorktree(row);
    },

    async listWorktreesByProject(
      projectId: string,
    ): Promise<MissionControlWorktree[]> {
      const results = await db
        .collection<StoredWorktreeRow>(WORKTREES_COLLECTION)
        .find({ projectId });

      return results.map(deserializeWorktree);
    },

    async listWorktreesByRepository(
      repositoryId: string,
    ): Promise<MissionControlWorktree[]> {
      const results = await db
        .collection<StoredWorktreeRow>(WORKTREES_COLLECTION)
        .find({ repositoryId });

      return results.map(deserializeWorktree);
    },

    async listWorktreesByAgent(agentId: string): Promise<MissionControlWorktree[]> {
      const results = await db
        .collection<StoredWorktreeRow>(WORKTREES_COLLECTION)
        .find({ agentId, status: "active" });

      return results.map(deserializeWorktree);
    },

    async updateWorktree(worktree: MissionControlWorktree): Promise<void> {
      const row: StoredWorktreeRow = {
        id: worktree.id,
        projectId: worktree.projectId,
        repositoryId: worktree.repositoryId,
        path: worktree.path,
        branch: worktree.branch,
        baseCommit: worktree.baseCommit,
        headCommit: worktree.headCommit,
        agentId: worktree.agentId,
        taskId: worktree.taskId,
        status: worktree.status,
        createdAt: worktree.createdAt,
        updatedAt: worktree.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredWorktreeRow>(WORKTREES_COLLECTION).set(worktree.id, row);
      });
    },

    async deleteWorktree(worktreeId: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection(WORKTREES_COLLECTION).delete(worktreeId);
        // Clean up related files and changes
        const files = await db
          .collection<StoredWorktreeFileRow>(FILES_COLLECTION)
          .find({ worktreeId });
        for (const file of files) {
          tx.collection(FILES_COLLECTION).delete(file.id);
        }

        const changes = await db
          .collection<StoredWorktreeChangesRow>(CHANGES_COLLECTION)
          .find({ worktreeId });
        for (const change of changes) {
          tx.collection(CHANGES_COLLECTION).delete(change.id);
        }
      });
    },

    async recordWorktreeFiles(
      worktreeId: string,
      files: WorktreeFile[],
    ): Promise<void> {
      await db.transaction((tx) => {
        // Clear existing files for this worktree
        const existing = db
          .collection<StoredWorktreeFileRow>(FILES_COLLECTION)
          .find({ worktreeId });
        for (const file of existing) {
          tx.collection(FILES_COLLECTION).delete(file.id);
        }

        // Record new files
        for (const file of files) {
          const row: StoredWorktreeFileRow = {
            id: file.id,
            worktreeId: file.worktreeId,
            path: file.path,
            status: file.status,
            size: file.size,
            lastModified: file.lastModified,
          };
          tx.collection<StoredWorktreeFileRow>(FILES_COLLECTION).set(file.id, row);
        }
      });
    },

    async getWorktreeFiles(worktreeId: string): Promise<WorktreeFile[]> {
      const rows = await db
        .collection<StoredWorktreeFileRow>(FILES_COLLECTION)
        .find({ worktreeId });

      return rows.map((row) => ({
        id: row.id,
        worktreeId: row.worktreeId,
        path: row.path,
        status: row.status,
        size: row.size,
        lastModified: row.lastModified,
      }));
    },

    async recordChanges(changes: WorktreeChanges): Promise<void> {
      const row: StoredWorktreeChangesRow = {
        id: changes.id,
        worktreeId: changes.worktreeId,
        fromCommit: changes.fromCommit,
        toCommit: changes.toCommit,
        filesChanged: changes.filesChanged,
        insertions: changes.insertions,
        deletions: changes.deletions,
        summary: changes.summary,
        createdAt: changes.createdAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredWorktreeChangesRow>(CHANGES_COLLECTION).set(changes.id, row);
      });
    },

    async getWorktreeChangeHistory(worktreeId: string): Promise<WorktreeChanges[]> {
      const rows = await db
        .collection<StoredWorktreeChangesRow>(CHANGES_COLLECTION)
        .find({ worktreeId });

      return rows.map((row) => ({
        id: row.id,
        worktreeId: row.worktreeId,
        fromCommit: row.fromCommit,
        toCommit: row.toCommit,
        filesChanged: row.filesChanged,
        insertions: row.insertions,
        deletions: row.deletions,
        summary: row.summary,
        createdAt: row.createdAt,
      }));
    },

    async updateWorktreeHead(worktreeId: string, commitSha: string): Promise<void> {
      const worktree = await this.getWorktree(worktreeId);
      if (!worktree) throw new Error(`Worktree ${worktreeId} not found`);

      worktree.headCommit = commitSha;
      worktree.updatedAt = new Date().toISOString();

      await this.updateWorktree(worktree);
    },
  };
}

function deserializeWorktree(row: StoredWorktreeRow): MissionControlWorktree {
  return {
    id: row.id,
    projectId: row.projectId,
    repositoryId: row.repositoryId,
    path: row.path,
    branch: row.branch,
    baseCommit: row.baseCommit,
    headCommit: row.headCommit,
    agentId: row.agentId,
    taskId: row.taskId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a standard worktree.
 */
export function createStandardWorktree(
  id: string,
  projectId: string,
  repositoryId: string,
  path: string,
  branch: string,
  baseCommit: string,
): MissionControlWorktree {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    repositoryId,
    path,
    branch,
    baseCommit,
    headCommit: baseCommit,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}
