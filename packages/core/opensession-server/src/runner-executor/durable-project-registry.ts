/**
 * Durable project registry backed by FeltDB.
 *
 * Projects are the root organizational unit in Mission Control.
 * All other entities (repositories, agents, tasks, etc.) are scoped to a project.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import type {
  MissionControlProject,
  ProjectStatus,
  RepositoryConfig,
  LocalConfig,
  SlackConfig,
} from "./mission-control-project";

interface StoredProjectRow {
  id: string;
  name: string;
  slug: string;
  description?: string;
  repository: string; // JSON
  local: string; // JSON
  slack: string; // JSON
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

const COLLECTION_NAME = "mission_control_projects";

/**
 * DurableProjectRegistry manages persistent project definitions in FeltDB.
 */
export interface DurableProjectRegistry {
  /**
   * Create a new project.
   */
  createProject(project: MissionControlProject): Promise<void>;

  /**
   * Retrieve a project by ID.
   */
  getProject(projectId: string): Promise<MissionControlProject | null>;

  /**
   * Retrieve a project by slug.
   */
  getProjectBySlug(slug: string): Promise<MissionControlProject | null>;

  /**
   * List all projects.
   */
  listProjects(): Promise<MissionControlProject[]>;

  /**
   * Update an existing project.
   */
  updateProject(project: MissionControlProject): Promise<void>;

  /**
   * Delete a project.
   */
  deleteProject(projectId: string): Promise<void>;

  /**
   * Get or create the general Mission Control project for workspace coordination.
   */
  getOrCreateGeneralProject(
    workspaceId: string,
    slackGeneralChannelId: string,
  ): Promise<MissionControlProject>;
}

export function openDurableProjectRegistry(path: string): DurableProjectRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-projects",
  });

  return {
    async createProject(project: MissionControlProject): Promise<void> {
      const row: StoredProjectRow = {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        repository: JSON.stringify(project.repository),
        local: JSON.stringify(project.local),
        slack: JSON.stringify(project.slack),
        status: project.status,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredProjectRow>(COLLECTION_NAME).set(project.id, row);
      });
    },

    async getProject(projectId: string): Promise<MissionControlProject | null> {
      const row = await db
        .collection<StoredProjectRow>(COLLECTION_NAME)
        .get(projectId);

      if (!row) return null;

      return deserializeProject(row);
    },

    async getProjectBySlug(slug: string): Promise<MissionControlProject | null> {
      const results = await db
        .collection<StoredProjectRow>(COLLECTION_NAME)
        .find({ slug });

      if (results.length === 0) return null;
      return deserializeProject(results[0]);
    },

    async listProjects(): Promise<MissionControlProject[]> {
      const all = await db
        .collection<StoredProjectRow>(COLLECTION_NAME)
        .all();

      return all.map(deserializeProject);
    },

    async updateProject(project: MissionControlProject): Promise<void> {
      const row: StoredProjectRow = {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        repository: JSON.stringify(project.repository),
        local: JSON.stringify(project.local),
        slack: JSON.stringify(project.slack),
        status: project.status,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredProjectRow>(COLLECTION_NAME).set(project.id, row);
      });
    },

    async deleteProject(projectId: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection(COLLECTION_NAME).delete(projectId);
      });
    },

    async getOrCreateGeneralProject(
      workspaceId: string,
      slackGeneralChannelId: string,
    ): Promise<MissionControlProject> {
      const generalProjectId = `workspace-${workspaceId}`;
      const existing = await this.getProject(generalProjectId);

      if (existing) return existing;

      const now = new Date().toISOString();
      const project: MissionControlProject = {
        id: generalProjectId,
        name: "Mission Control",
        slug: "mission-control",
        description: "General workspace coordination project",
        repository: {
          provider: "github",
          owner: "",
          repo: "",
          defaultBranch: "main",
          remoteUrl: "",
        },
        local: {
          rootPath: "",
          worktreeStrategy: "nested",
        },
        slack: {
          workspaceId,
          generalChannelId: slackGeneralChannelId,
        },
        status: "active",
        createdAt: now,
        updatedAt: now,
      };

      await this.createProject(project);
      return project;
    },
  };
}

function deserializeProject(row: StoredProjectRow): MissionControlProject {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    repository: JSON.parse(row.repository),
    local: JSON.parse(row.local),
    slack: JSON.parse(row.slack),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a standard project for a new repository.
 */
export function createStandardProject(
  id: string,
  name: string,
  slug: string,
  repository: RepositoryConfig,
  local: LocalConfig,
  slack: SlackConfig,
): MissionControlProject {
  const now = new Date().toISOString();
  return {
    id,
    name,
    slug,
    repository,
    local,
    slack,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}
