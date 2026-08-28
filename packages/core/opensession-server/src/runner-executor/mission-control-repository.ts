/**
 * Mission Control Repository type definitions.
 *
 * A Repository is scoped to a Project and represents the remote repository
 * and its configuration.
 */

/**
 * MissionControlRepository represents a repository within a project.
 *
 * This stores metadata about the repository and its state, separate from
 * the actual git repository files.
 */
export interface MissionControlRepository {
  id: string;
  projectId: string;
  name: string;
  provider: "github";
  owner: string;
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
  status: "active" | "archived" | "error";
  lastSyncAt?: string;
  syncError?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * RepositoryStatus represents the sync/health status of a repository.
 */
export type RepositoryStatus = "active" | "archived" | "error";
