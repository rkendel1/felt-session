/**
 * Durable storage for repository commits and file changes.
 * Tracks Git history as FeltDB records.
 */

import type { StateFirstDB } from "@feltdb/core";
import type { RepositoryCommit, CommitFileChange } from "./mission-control-repository-observer";
import { randomUUIDv7 } from "bun";

export interface DurableRepositoryCommitRegistry {
  /**
   * Create or update a commit record.
   */
  createCommit(commit: RepositoryCommit): Promise<void>;

  /**
   * Get a single commit by SHA.
   */
  getCommitBySha(sha: string): Promise<RepositoryCommit | undefined>;

  /**
   * Get commits for a repository.
   */
  getCommits(repositoryId: string, limit?: number): Promise<RepositoryCommit[]>;

  /**
   * Get commits on a branch.
   */
  getCommitsByBranch(repositoryId: string, branch: string): Promise<RepositoryCommit[]>;

  /**
   * Check if commit exists.
   */
  commitExists(sha: string): Promise<boolean>;

  /**
   * Record a file change for a commit.
   */
  recordFileChange(change: CommitFileChange): Promise<void>;

  /**
   * Get all file changes in a commit.
   */
  getCommitChanges(commitId: string): Promise<CommitFileChange[]>;

  /**
   * Get file change history for a specific file.
   */
  getFileChangeHistory(fileId: string, limit?: number): Promise<CommitFileChange[]>;

  /**
   * Get commits that touched a specific file.
   */
  getCommitsTouchingFile(fileId: string): Promise<RepositoryCommit[]>;

  /**
   * Delete old commits (historical cleanup).
   */
  deleteCommitsOlderThan(repositoryId: string, beforeDate: string): Promise<number>;
}

export function openDurableRepositoryCommitRegistry(
  db: StateFirstDB
): DurableRepositoryCommitRegistry {
  const commitCollection = db.collection<RepositoryCommit>("commits");
  const changeCollection = db.collection<CommitFileChange>("changes");

  return {
    async createCommit(commit: RepositoryCommit): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<RepositoryCommit>("commits").set(commit.id, commit);
      });
    },

    async getCommitBySha(sha: string): Promise<RepositoryCommit | undefined> {
      return (await commitCollection.find({ sha }))[0];
    },

    async getCommits(
      repositoryId: string,
      limit: number = 100
    ): Promise<RepositoryCommit[]> {
      const commits = await commitCollection.find({ repositoryId });
      return commits
        .sort((a, b) => {
          const dateA = new Date(a.committedAt).getTime();
          const dateB = new Date(b.committedAt).getTime();
          return dateB - dateA;
        })
        .slice(0, limit);
    },

    async getCommitsByBranch(
      repositoryId: string,
      branch: string
    ): Promise<RepositoryCommit[]> {
      const commits = await commitCollection.find({
        repositoryId,
        branch,
      });
      return commits.sort((a, b) => {
        const dateA = new Date(a.committedAt).getTime();
        const dateB = new Date(b.committedAt).getTime();
        return dateB - dateA;
      });
    },

    async commitExists(sha: string): Promise<boolean> {
      const commit = (await commitCollection.find({ sha }))[0];
      return !!commit;
    },

    async recordFileChange(change: CommitFileChange): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<CommitFileChange>("changes").insert(change, change.id);
      });
    },

    async getCommitChanges(commitId: string): Promise<CommitFileChange[]> {
      return changeCollection.find({ commitId });
    },

    async getFileChangeHistory(
      fileId: string,
      limit: number = 50
    ): Promise<CommitFileChange[]> {
      const changes = await changeCollection.find({ fileId });
      return changes.slice(0, limit);
    },

    async getCommitsTouchingFile(fileId: string): Promise<RepositoryCommit[]> {
      const changes = await changeCollection.find({ fileId });
      const commitIds = new Set(changes.map((c) => c.commitId));

      const commits = (await commitCollection.all()).filter((commit) =>
        commitIds.has(commit.id),
      );

      return commits.sort((a, b) => {
        const dateA = new Date(a.committedAt).getTime();
        const dateB = new Date(b.committedAt).getTime();
        return dateB - dateA;
      });
    },

    async deleteCommitsOlderThan(
      repositoryId: string,
      beforeDate: string
    ): Promise<number> {
      const cutoff = new Date(beforeDate).getTime();
      const commits = await commitCollection.find({ repositoryId });

      const toDelete = commits.filter((c) => {
        return new Date(c.committedAt).getTime() < cutoff;
      });

      const changes = await changeCollection.all();
      await db.transaction((tx) => {
        for (const commit of toDelete) {
          tx.collection<RepositoryCommit>("commits").delete(commit.id);

          // Also delete associated changes
          const deleteMany = (doc: CommitFileChange) =>
            doc.commitId === commit.id;
          for (const change of changes.filter(deleteMany)) {
            tx.collection<CommitFileChange>("changes").delete(change.id);
          }
        }
      });

      return toDelete.length;
    },
  };
}
