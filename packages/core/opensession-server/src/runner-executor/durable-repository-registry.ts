/**
 * Durable repository registry backed by FeltDB.
 *
 * Repositories are scoped to projects and represent configured GitHub repositories.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import type {
  MissionControlRepository,
  RepositoryStatus,
} from "./mission-control-repository";

interface StoredRepositoryRow {
  id: string;
  projectId: string;
  name: string;
  provider: "github";
  owner: string;
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
  status: RepositoryStatus;
  lastSyncAt?: string;
  syncError?: string;
  createdAt: string;
  updatedAt: string;
}

const COLLECTION_NAME = "mission_control_repositories";

/**
 * DurableRepositoryRegistry manages persistent repository definitions in FeltDB.
 */
export interface DurableRepositoryRegistry {
  /**
   * Create a new repository.
   */
  createRepository(repository: MissionControlRepository): Promise<void>;

  /**
   * Retrieve a repository by ID.
   */
  getRepository(repositoryId: string): Promise<MissionControlRepository | null>;

  /**
   * List all repositories for a project.
   */
  listRepositoriesByProject(projectId: string): Promise<MissionControlRepository[]>;

  /**
   * List all repositories.
   */
  listRepositories(): Promise<MissionControlRepository[]>;

  /**
   * Update an existing repository.
   */
  updateRepository(repository: MissionControlRepository): Promise<void>;

  /**
   * Delete a repository.
   */
  deleteRepository(repositoryId: string): Promise<void>;

  /**
   * Record a successful sync.
   */
  recordSync(repositoryId: string): Promise<void>;

  /**
   * Record a sync error.
   */
  recordSyncError(repositoryId: string, error: string): Promise<void>;
}

export function openDurableRepositoryRegistry(path: string): DurableRepositoryRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-repositories",
  });

  return {
    async createRepository(repository: MissionControlRepository): Promise<void> {
      const row: StoredRepositoryRow = {
        id: repository.id,
        projectId: repository.projectId,
        name: repository.name,
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        remoteUrl: repository.remoteUrl,
        defaultBranch: repository.defaultBranch,
        status: repository.status,
        lastSyncAt: repository.lastSyncAt,
        syncError: repository.syncError,
        createdAt: repository.createdAt,
        updatedAt: repository.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredRepositoryRow>(COLLECTION_NAME).set(repository.id, row);
      });
    },

    async getRepository(repositoryId: string): Promise<MissionControlRepository | null> {
      const row = await db
        .collection<StoredRepositoryRow>(COLLECTION_NAME)
        .get(repositoryId);

      if (!row) return null;
      return deserializeRepository(row);
    },

    async listRepositoriesByProject(projectId: string): Promise<MissionControlRepository[]> {
      const results = await db
        .collection<StoredRepositoryRow>(COLLECTION_NAME)
        .find({ projectId });

      return results.map(deserializeRepository);
    },

    async listRepositories(): Promise<MissionControlRepository[]> {
      const all = await db
        .collection<StoredRepositoryRow>(COLLECTION_NAME)
        .all();

      return all.map(deserializeRepository);
    },

    async updateRepository(repository: MissionControlRepository): Promise<void> {
      const row: StoredRepositoryRow = {
        id: repository.id,
        projectId: repository.projectId,
        name: repository.name,
        provider: repository.provider,
        owner: repository.owner,
        repo: repository.repo,
        remoteUrl: repository.remoteUrl,
        defaultBranch: repository.defaultBranch,
        status: repository.status,
        lastSyncAt: repository.lastSyncAt,
        syncError: repository.syncError,
        createdAt: repository.createdAt,
        updatedAt: repository.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredRepositoryRow>(COLLECTION_NAME).set(repository.id, row);
      });
    },

    async deleteRepository(repositoryId: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection(COLLECTION_NAME).delete(repositoryId);
      });
    },

    async recordSync(repositoryId: string): Promise<void> {
      const repo = await this.getRepository(repositoryId);
      if (!repo) throw new Error(`Repository ${repositoryId} not found`);

      repo.lastSyncAt = new Date().toISOString();
      repo.syncError = undefined;
      repo.updatedAt = new Date().toISOString();

      await this.updateRepository(repo);
    },

    async recordSyncError(repositoryId: string, error: string): Promise<void> {
      const repo = await this.getRepository(repositoryId);
      if (!repo) throw new Error(`Repository ${repositoryId} not found`);

      repo.syncError = error;
      repo.status = "error";
      repo.updatedAt = new Date().toISOString();

      await this.updateRepository(repo);
    },
  };
}

function deserializeRepository(row: StoredRepositoryRow): MissionControlRepository {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    provider: row.provider,
    owner: row.owner,
    repo: row.repo,
    remoteUrl: row.remoteUrl,
    defaultBranch: row.defaultBranch,
    status: row.status,
    lastSyncAt: row.lastSyncAt,
    syncError: row.syncError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a standard repository record.
 */
export function createStandardRepository(
  id: string,
  projectId: string,
  name: string,
  owner: string,
  repo: string,
  remoteUrl: string,
  defaultBranch: string,
): MissionControlRepository {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    name,
    provider: "github",
    owner,
    repo,
    remoteUrl,
    defaultBranch,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}
