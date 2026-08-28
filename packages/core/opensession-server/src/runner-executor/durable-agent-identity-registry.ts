/**
 * Durable Agent Identity Registry backed by FeltDB.
 *
 * Manages persistent agent identities, presence, and assignments.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { randomUUIDv7 } from "bun";
import type {
  AgentIdentity,
  AgentPresence,
  AgentAssignment,
  BUILTIN_AGENTS,
} from "./mission-control-agent-identity";
import { BUILTIN_AGENTS as BUILTIN_AGENTS_CONST } from "./mission-control-agent-identity";

/**
 * Stored row for agent identities.
 */
interface StoredAgentIdentity {
  id: string;
  handle: string;
  displayName: string;
  description?: string;
  kind: "role" | "integration";
  role?: string;
  provider?: string;
  capabilities: string; // JSON string
  projectId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stored row for presence.
 */
interface StoredAgentPresence {
  id: string;
  agentId: string;
  state: string;
  currentTask?: string;
  statusMessage?: string;
  lastSeen: string;
  updatedAt: string;
}

/**
 * Stored row for assignments.
 */
interface StoredAgentAssignment {
  id: string;
  agentId: string;
  taskId: string;
  projectId: string;
  assignedAt: string;
  status: string;
  result?: string;
  completedAt?: string;
}

/**
 * Durable Agent Identity Registry Interface.
 */
export interface DurableAgentIdentityRegistry {
  // Agent Identity
  createIdentity(identity: AgentIdentity): Promise<void>;
  getIdentity(id: string): Promise<AgentIdentity | undefined>;
  getIdentityByHandle(handle: string): Promise<AgentIdentity | undefined>;
  listIdentities(projectId?: string): Promise<AgentIdentity[]>;
  updateIdentity(identity: AgentIdentity): Promise<void>;
  deleteIdentity(id: string): Promise<void>;

  // Presence
  setPresence(presence: AgentPresence): Promise<void>;
  getPresence(agentId: string): Promise<AgentPresence | undefined>;
  listPresence(projectId?: string): Promise<AgentPresence[]>;

  // Assignments
  createAssignment(assignment: AgentAssignment): Promise<void>;
  getAssignment(id: string): Promise<AgentAssignment | undefined>;
  getAssignmentsByTask(taskId: string): Promise<AgentAssignment[]>;
  getAssignmentsByAgent(agentId: string): Promise<AgentAssignment[]>;
  updateAssignment(assignment: AgentAssignment): Promise<void>;

  // Bootstrap
  ensureBuiltinAgents(projectId?: string): Promise<void>;
}

/**
 * Open or create a durable agent identity registry.
 */
export function openDurableAgentIdentityRegistry(
  path: string,
): DurableAgentIdentityRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-agents",
  });

  const IDENTITIES_COLLECTION = "agent_identities";
  const PRESENCE_COLLECTION = "agent_presence";
  const ASSIGNMENTS_COLLECTION = "agent_assignments";

  return {
    async createIdentity(identity: AgentIdentity): Promise<void> {
      const row: StoredAgentIdentity = {
        id: identity.id,
        handle: identity.handle,
        displayName: identity.displayName,
        description: identity.description,
        kind: identity.kind,
        role: identity.role,
        provider: identity.provider,
        capabilities: JSON.stringify(identity.capabilities),
        projectId: identity.projectId,
        enabled: identity.enabled,
        createdAt: identity.createdAt,
        updatedAt: identity.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentIdentity>(IDENTITIES_COLLECTION).set(
          identity.id,
          row,
        );
      });
    },

    async getIdentity(id: string): Promise<AgentIdentity | undefined> {
      const row = await db
        .collection<StoredAgentIdentity>(IDENTITIES_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        handle: row.handle,
        displayName: row.displayName,
        description: row.description,
        kind: row.kind,
        role: row.role as any,
        provider: row.provider,
        capabilities: JSON.parse(row.capabilities),
        projectId: row.projectId,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async getIdentityByHandle(handle: string): Promise<AgentIdentity | undefined> {
      const rows = await db
        .collection<StoredAgentIdentity>(IDENTITIES_COLLECTION)
        .find({ handle });

      if (rows.length === 0) return undefined;
      const row = rows[0];
      return {
        id: row.id,
        handle: row.handle,
        displayName: row.displayName,
        description: row.description,
        kind: row.kind,
        role: row.role as any,
        provider: row.provider,
        capabilities: JSON.parse(row.capabilities),
        projectId: row.projectId,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async listIdentities(projectId?: string): Promise<AgentIdentity[]> {
      let rows: StoredAgentIdentity[];

      if (projectId) {
        rows = await db
          .collection<StoredAgentIdentity>(IDENTITIES_COLLECTION)
          .find({ projectId });
      } else {
        rows = await db
          .collection<StoredAgentIdentity>(IDENTITIES_COLLECTION)
          .all();
      }

      return rows.map((row) => ({
        id: row.id,
        handle: row.handle,
        displayName: row.displayName,
        description: row.description,
        kind: row.kind,
        role: row.role as any,
        provider: row.provider,
        capabilities: JSON.parse(row.capabilities),
        projectId: row.projectId,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async updateIdentity(identity: AgentIdentity): Promise<void> {
      const row: StoredAgentIdentity = {
        id: identity.id,
        handle: identity.handle,
        displayName: identity.displayName,
        description: identity.description,
        kind: identity.kind,
        role: identity.role,
        provider: identity.provider,
        capabilities: JSON.stringify(identity.capabilities),
        projectId: identity.projectId,
        enabled: identity.enabled,
        createdAt: identity.createdAt,
        updatedAt: new Date().toISOString(),
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentIdentity>(IDENTITIES_COLLECTION).set(
          identity.id,
          row,
        );
      });
    },

    async deleteIdentity(id: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredAgentIdentity>(IDENTITIES_COLLECTION).delete(id);
      });
    },

    async setPresence(presence: AgentPresence): Promise<void> {
      const row: StoredAgentPresence = {
        id: `${presence.agentId}-presence`,
        agentId: presence.agentId,
        state: presence.state,
        currentTask: presence.currentTask,
        statusMessage: presence.statusMessage,
        lastSeen: presence.lastSeen,
        updatedAt: presence.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentPresence>(PRESENCE_COLLECTION).set(
          presence.agentId,
          row,
        );
      });
    },

    async getPresence(agentId: string): Promise<AgentPresence | undefined> {
      const row = await db
        .collection<StoredAgentPresence>(PRESENCE_COLLECTION)
        .get(agentId);
      if (!row) return undefined;
      return {
        agentId: row.agentId,
        state: row.state as any,
        currentTask: row.currentTask,
        statusMessage: row.statusMessage,
        lastSeen: row.lastSeen,
        updatedAt: row.updatedAt,
      };
    },

    async listPresence(projectId?: string): Promise<AgentPresence[]> {
      const rows = await db
        .collection<StoredAgentPresence>(PRESENCE_COLLECTION)
        .all();

      return rows.map((row) => ({
        agentId: row.agentId,
        state: row.state as any,
        currentTask: row.currentTask,
        statusMessage: row.statusMessage,
        lastSeen: row.lastSeen,
        updatedAt: row.updatedAt,
      }));
    },

    async createAssignment(assignment: AgentAssignment): Promise<void> {
      const row: StoredAgentAssignment = {
        id: assignment.id,
        agentId: assignment.agentId,
        taskId: assignment.taskId,
        projectId: assignment.projectId,
        assignedAt: assignment.assignedAt,
        status: assignment.status,
        result: assignment.result,
        completedAt: assignment.completedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentAssignment>(ASSIGNMENTS_COLLECTION).set(
          assignment.id,
          row,
        );
      });
    },

    async getAssignment(id: string): Promise<AgentAssignment | undefined> {
      const row = await db
        .collection<StoredAgentAssignment>(ASSIGNMENTS_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        agentId: row.agentId,
        taskId: row.taskId,
        projectId: row.projectId,
        assignedAt: row.assignedAt,
        status: row.status as any,
        result: row.result,
        completedAt: row.completedAt,
      };
    },

    async getAssignmentsByTask(taskId: string): Promise<AgentAssignment[]> {
      const rows = await db
        .collection<StoredAgentAssignment>(ASSIGNMENTS_COLLECTION)
        .find({ taskId });

      return rows.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        taskId: row.taskId,
        projectId: row.projectId,
        assignedAt: row.assignedAt,
        status: row.status as any,
        result: row.result,
        completedAt: row.completedAt,
      }));
    },

    async getAssignmentsByAgent(agentId: string): Promise<AgentAssignment[]> {
      const rows = await db
        .collection<StoredAgentAssignment>(ASSIGNMENTS_COLLECTION)
        .find({ agentId });

      return rows.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        taskId: row.taskId,
        projectId: row.projectId,
        assignedAt: row.assignedAt,
        status: row.status as any,
        result: row.result,
        completedAt: row.completedAt,
      }));
    },

    async updateAssignment(assignment: AgentAssignment): Promise<void> {
      const row: StoredAgentAssignment = {
        id: assignment.id,
        agentId: assignment.agentId,
        taskId: assignment.taskId,
        projectId: assignment.projectId,
        assignedAt: assignment.assignedAt,
        status: assignment.status,
        result: assignment.result,
        completedAt: assignment.completedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentAssignment>(ASSIGNMENTS_COLLECTION).set(
          assignment.id,
          row,
        );
      });
    },

    async ensureBuiltinAgents(projectId?: string): Promise<void> {
      for (const [role, template] of Object.entries(BUILTIN_AGENTS_CONST)) {
        const existing = await this.getIdentityByHandle(template.handle!);
        if (!existing) {
          const identity: AgentIdentity = {
            id: `agent-${role}-${randomUUIDv7()}`,
            handle: template.handle!,
            displayName: template.displayName!,
            description: template.description,
            kind: template.kind!,
            role: template.role as any,
            provider: template.provider,
            capabilities: template.capabilities || [],
            projectId,
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await this.createIdentity(identity);
        }
      }
    },
  };
}
