/**
 * GitHub OAuth Token Registry backed by FeltDB.
 *
 * Stores and manages GitHub access tokens and integrations.
 */

import { randomUUIDv7, createFeltDB, getTelemetryClient } from "@feltdb/core";
import type {
  GitHubOAuthToken,
  GitHubIntegration,
} from "./mission-control-github";

/**
 * Stored row for OAuth tokens.
 */
interface StoredGitHubToken {
  id: string;
  projectId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope: string;
  userId: string;
  userName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stored row for integrations.
 */
interface StoredGitHubIntegration {
  id: string;
  projectId: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  installationId?: string;
  status: "pending" | "authorized" | "revoked";
  createdAt: string;
  updatedAt: string;
}

/**
 * GitHub OAuth Token Registry Interface.
 */
export interface DurableGitHubTokenRegistry {
  createToken(token: GitHubOAuthToken): Promise<void>;
  getToken(id: string): Promise<GitHubOAuthToken | undefined>;
  getTokenByProject(projectId: string): Promise<GitHubOAuthToken | undefined>;
  listTokens(projectId: string): Promise<GitHubOAuthToken[]>;
  updateToken(token: GitHubOAuthToken): Promise<void>;
  deleteToken(id: string): Promise<void>;
}

/**
 * GitHub Integration Registry Interface.
 */
export interface DurableGitHubIntegrationRegistry {
  createIntegration(integration: GitHubIntegration): Promise<void>;
  getIntegration(id: string): Promise<GitHubIntegration | undefined>;
  getIntegrationByProject(projectId: string): Promise<GitHubIntegration | undefined>;
  listIntegrations(projectId: string): Promise<GitHubIntegration[]>;
  updateIntegration(integration: GitHubIntegration): Promise<void>;
  deleteIntegration(id: string): Promise<void>;
}

/**
 * Open or create a GitHub OAuth token registry.
 */
export function openDurableGitHubTokenRegistry(
  path: string,
): DurableGitHubTokenRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-github",
  });

  const TOKENS_COLLECTION = "github_tokens";

  return {
    async createToken(token: GitHubOAuthToken): Promise<void> {
      const row: StoredGitHubToken = {
        id: token.id,
        projectId: token.projectId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scope: token.scope.join(","),
        userId: token.userId,
        userName: token.userName,
        createdAt: token.createdAt,
        updatedAt: token.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredGitHubToken>(TOKENS_COLLECTION).set(token.id, row);
      });
    },

    async getToken(id: string): Promise<GitHubOAuthToken | undefined> {
      const row = await db
        .collection<StoredGitHubToken>(TOKENS_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        projectId: row.projectId,
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        expiresAt: row.expiresAt,
        scope: row.scope.split(","),
        userId: row.userId,
        userName: row.userName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async getTokenByProject(projectId: string): Promise<GitHubOAuthToken | undefined> {
      const rows = await db
        .collection<StoredGitHubToken>(TOKENS_COLLECTION)
        .find({ projectId });

      if (rows.length === 0) return undefined;
      const row = rows[0];
      return {
        id: row.id,
        projectId: row.projectId,
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        expiresAt: row.expiresAt,
        scope: row.scope.split(","),
        userId: row.userId,
        userName: row.userName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async listTokens(projectId: string): Promise<GitHubOAuthToken[]> {
      const rows = await db
        .collection<StoredGitHubToken>(TOKENS_COLLECTION)
        .find({ projectId });

      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        expiresAt: row.expiresAt,
        scope: row.scope.split(","),
        userId: row.userId,
        userName: row.userName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async updateToken(token: GitHubOAuthToken): Promise<void> {
      const now = new Date().toISOString();
      const row: StoredGitHubToken = {
        id: token.id,
        projectId: token.projectId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scope: token.scope.join(","),
        userId: token.userId,
        userName: token.userName,
        createdAt: token.createdAt,
        updatedAt: now,
      };

      await db.transaction((tx) => {
        tx.collection<StoredGitHubToken>(TOKENS_COLLECTION).set(token.id, row);
      });
    },

    async deleteToken(id: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredGitHubToken>(TOKENS_COLLECTION).delete(id);
      });
    },
  };
}

/**
 * Open or create a GitHub integration registry.
 */
export function openDurableGitHubIntegrationRegistry(
  path: string,
): DurableGitHubIntegrationRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-github",
  });

  const INTEGRATIONS_COLLECTION = "github_integrations";

  return {
    async createIntegration(integration: GitHubIntegration): Promise<void> {
      const row: StoredGitHubIntegration = {
        id: integration.id,
        projectId: integration.projectId,
        appId: integration.appId,
        clientId: integration.clientId,
        clientSecret: integration.clientSecret,
        installationId: integration.installationId,
        status: integration.status,
        createdAt: integration.createdAt,
        updatedAt: integration.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredGitHubIntegration>(INTEGRATIONS_COLLECTION).set(
          integration.id,
          row,
        );
      });
    },

    async getIntegration(id: string): Promise<GitHubIntegration | undefined> {
      const row = await db
        .collection<StoredGitHubIntegration>(INTEGRATIONS_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        projectId: row.projectId,
        appId: row.appId,
        clientId: row.clientId,
        clientSecret: row.clientSecret,
        installationId: row.installationId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async getIntegrationByProject(projectId: string): Promise<GitHubIntegration | undefined> {
      const rows = await db
        .collection<StoredGitHubIntegration>(INTEGRATIONS_COLLECTION)
        .find({ projectId });

      if (rows.length === 0) return undefined;
      const row = rows[0];
      return {
        id: row.id,
        projectId: row.projectId,
        appId: row.appId,
        clientId: row.clientId,
        clientSecret: row.clientSecret,
        installationId: row.installationId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async listIntegrations(projectId: string): Promise<GitHubIntegration[]> {
      const rows = await db
        .collection<StoredGitHubIntegration>(INTEGRATIONS_COLLECTION)
        .find({ projectId });

      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        appId: row.appId,
        clientId: row.clientId,
        clientSecret: row.clientSecret,
        installationId: row.installationId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async updateIntegration(integration: GitHubIntegration): Promise<void> {
      const now = new Date().toISOString();
      const row: StoredGitHubIntegration = {
        id: integration.id,
        projectId: integration.projectId,
        appId: integration.appId,
        clientId: integration.clientId,
        clientSecret: integration.clientSecret,
        installationId: integration.installationId,
        status: integration.status,
        createdAt: integration.createdAt,
        updatedAt: now,
      };

      await db.transaction((tx) => {
        tx.collection<StoredGitHubIntegration>(INTEGRATIONS_COLLECTION).set(
          integration.id,
          row,
        );
      });
    },

    async deleteIntegration(id: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredGitHubIntegration>(INTEGRATIONS_COLLECTION).delete(id);
      });
    },
  };
}
