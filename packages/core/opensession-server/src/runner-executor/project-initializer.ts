/**
 * Project initialization and management service.
 *
 * Handles project lifecycle: creation, configuration, discovery, and cleanup.
 */

import * as path from "path";
import * as fs from "fs";
import { randomUUIDv7 } from "bun";
import type { MissionControlProject } from "./mission-control-project";
import type { MissionControlRepository } from "./mission-control-repository";
import {
  openDurableProjectRegistry,
  createStandardProject,
} from "./durable-project-registry";
import {
  openDurableRepositoryRegistry,
  createStandardRepository,
} from "./durable-repository-registry";

/**
 * Configuration for creating a new project.
 */
export interface ProjectCreationConfig {
  name: string;
  slug: string;
  repositoryUrl: string; // e.g., https://github.com/owner/repo.git
  localRootPath: string;
  workspaceId: string;
  generalChannelId: string;
  slackProjectChannelId?: string;
  defaultBranch?: string;
  worktreeStrategy?: "nested" | "sibling";
}

/**
 * ProjectInitializer manages project creation and configuration.
 */
export class ProjectInitializer {
  private projectRegistryPath: string;
  private repositoryRegistryPath: string;
  private projectRegistry: ReturnType<typeof openDurableProjectRegistry> | null = null;
  private repositoryRegistry: ReturnType<typeof openDurableRepositoryRegistry> | null = null;

  constructor(dataDir: string) {
    this.projectRegistryPath = path.join(dataDir, "projects");
    this.repositoryRegistryPath = path.join(dataDir, "repositories");

    // Ensure directories exist
    fs.mkdirSync(this.projectRegistryPath, { recursive: true });
    fs.mkdirSync(this.repositoryRegistryPath, { recursive: true });
  }

  private getProjectRegistry() {
    if (!this.projectRegistry) {
      this.projectRegistry = openDurableProjectRegistry(this.projectRegistryPath);
    }
    return this.projectRegistry;
  }

  private getRepositoryRegistry() {
    if (!this.repositoryRegistry) {
      this.repositoryRegistry = openDurableRepositoryRegistry(
        this.repositoryRegistryPath,
      );
    }
    return this.repositoryRegistry;
  }

  /**
   * Create a new project with an associated repository.
   */
  async createProject(config: ProjectCreationConfig): Promise<MissionControlProject> {
    const projectRegistry = this.getProjectRegistry();
    const repositoryRegistry = this.getRepositoryRegistry();

    // Parse repository URL
    const repoInfo = this.parseRepositoryUrl(config.repositoryUrl);

    // Create project
    const projectId = `proj-${randomUUIDv7()}`;
    const project = createStandardProject(
      projectId,
      config.name,
      config.slug,
      {
        provider: "github",
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        defaultBranch: config.defaultBranch || "main",
        remoteUrl: config.repositoryUrl,
      },
      {
        rootPath: config.localRootPath,
        worktreeStrategy: config.worktreeStrategy || "nested",
      },
      {
        workspaceId: config.workspaceId,
        generalChannelId: config.generalChannelId,
        projectChannelId: config.slackProjectChannelId,
      },
    );

    await projectRegistry.createProject(project);

    // Create repository record
    const repositoryId = `repo-${randomUUIDv7()}`;
    const repository = createStandardRepository(
      repositoryId,
      projectId,
      repoInfo.repo,
      repoInfo.owner,
      repoInfo.repo,
      config.repositoryUrl,
      config.defaultBranch || "main",
    );

    await repositoryRegistry.createRepository(repository);

    return project;
  }

  /**
   * Get or create the general Mission Control project for workspace-level coordination.
   */
  async initializeWorkspaceProject(
    workspaceId: string,
    generalChannelId: string,
  ): Promise<MissionControlProject> {
    const projectRegistry = this.getProjectRegistry();
    return projectRegistry.getOrCreateGeneralProject(workspaceId, generalChannelId);
  }

  /**
   * Get all projects in the workspace.
   */
  async listProjects(): Promise<MissionControlProject[]> {
    const projectRegistry = this.getProjectRegistry();
    return projectRegistry.listProjects();
  }

  /**
   * Get a project by ID.
   */
  async getProject(projectId: string): Promise<MissionControlProject | null> {
    const projectRegistry = this.getProjectRegistry();
    return projectRegistry.getProject(projectId);
  }

  /**
   * Get a project by slug.
   */
  async getProjectBySlug(slug: string): Promise<MissionControlProject | null> {
    const projectRegistry = this.getProjectRegistry();
    return projectRegistry.getProjectBySlug(slug);
  }

  /**
   * Get all repositories for a project.
   */
  async getRepositoriesForProject(
    projectId: string,
  ): Promise<MissionControlRepository[]> {
    const repositoryRegistry = this.getRepositoryRegistry();
    return repositoryRegistry.listRepositoriesByProject(projectId);
  }

  /**
   * Get all repositories.
   */
  async listRepositories(): Promise<MissionControlRepository[]> {
    const repositoryRegistry = this.getRepositoryRegistry();
    return repositoryRegistry.listRepositories();
  }

  /**
   * Record a successful repository sync.
   */
  async recordRepositorySync(repositoryId: string): Promise<void> {
    const repositoryRegistry = this.getRepositoryRegistry();
    await repositoryRegistry.recordSync(repositoryId);
  }

  /**
   * Record a repository sync error.
   */
  async recordRepositorySyncError(
    repositoryId: string,
    error: string,
  ): Promise<void> {
    const repositoryRegistry = this.getRepositoryRegistry();
    await repositoryRegistry.recordSyncError(repositoryId, error);
  }

  /**
   * Delete a project and all associated repositories.
   */
  async deleteProject(projectId: string): Promise<void> {
    const projectRegistry = this.getProjectRegistry();
    const repositoryRegistry = this.getRepositoryRegistry();

    // Get all repositories for this project
    const repos = await repositoryRegistry.listRepositoriesByProject(projectId);

    // Delete repositories
    for (const repo of repos) {
      await repositoryRegistry.deleteRepository(repo.id);
    }

    // Delete project
    await projectRegistry.deleteProject(projectId);
  }

  /**
   * Parse a GitHub repository URL into owner and repo.
   */
  private parseRepositoryUrl(url: string): { owner: string; repo: string } {
    // Handle formats like:
    // https://github.com/owner/repo.git
    // https://github.com/owner/repo
    // git@github.com:owner/repo.git
    // git@github.com:owner/repo

    let parsed: { owner: string; repo: string } | null = null;

    if (url.startsWith("https://github.com/") || url.startsWith("http://github.com/")) {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match) {
        parsed = { owner: match[1], repo: match[2] };
      }
    } else if (url.startsWith("git@github.com:")) {
      const match = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match) {
        parsed = { owner: match[1], repo: match[2] };
      }
    }

    if (!parsed) {
      throw new Error(
        `Invalid GitHub repository URL: ${url}. Expected format: https://github.com/owner/repo.git`,
      );
    }

    return parsed;
  }
}

/**
 * Create a project initializer instance.
 */
export function createProjectInitializer(dataDir: string): ProjectInitializer {
  return new ProjectInitializer(dataDir);
}
