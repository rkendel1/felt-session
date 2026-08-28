/**
 * Durable agent registry backed by FeltDB.
 *
 * Agents are persistent definitions that define roles, capabilities,
 * and the LLM model to use for each team member.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import {
  type MissionControlAgent,
  type AgentRole,
  type AgentProvider,
  type AgentStatus,
  AGENT_SYSTEM_PROMPTS,
  AGENT_CAPABILITIES,
} from "./mission-control-agent";

interface StoredAgentRow {
  id: string;
  name: string;
  role: AgentRole;
  provider: AgentProvider;
  model: string;
  capabilities: string;
  systemPrompt: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

const COLLECTION_NAME = "mission_control_agents";

/**
 * DurableAgentRegistry manages persistent agent definitions in FeltDB.
 */
export interface DurableAgentRegistry {
  /**
   * Create or update an agent definition.
   */
  upsertAgent(agent: MissionControlAgent): Promise<void>;

  /**
   * Retrieve an agent by ID.
   */
  getAgent(agentId: string): Promise<MissionControlAgent | null>;

  /**
   * List all agents for a specific role.
   */
  listAgentsByRole(role: AgentRole): Promise<MissionControlAgent[]>;

  /**
   * List all agents.
   */
  listAllAgents(): Promise<MissionControlAgent[]>;

  /**
   * Delete an agent.
   */
  deleteAgent(agentId: string): Promise<void>;
}

export function openDurableAgentRegistry(path: string): DurableAgentRegistry {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-agents",
  });

  return {
    async upsertAgent(agent: MissionControlAgent): Promise<void> {
      const row: StoredAgentRow = {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        provider: agent.provider,
        model: agent.model,
        capabilities: JSON.stringify(agent.capabilities),
        systemPrompt: agent.systemPrompt,
        status: agent.status,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredAgentRow>(COLLECTION_NAME).set(agent.id, row);
      });
    },

    async getAgent(agentId: string): Promise<MissionControlAgent | null> {
      const row = await db
        .collection<StoredAgentRow>(COLLECTION_NAME)
        .get(agentId);

      if (!row) return null;

      return {
        id: row.id,
        name: row.name,
        role: row.role,
        provider: row.provider,
        model: row.model,
        capabilities: JSON.parse(row.capabilities),
        systemPrompt: row.systemPrompt,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async listAgentsByRole(role: AgentRole): Promise<MissionControlAgent[]> {
      const all = await db
        .collection<StoredAgentRow>(COLLECTION_NAME)
        .find({ role });

      return all.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        provider: row.provider,
        model: row.model,
        capabilities: JSON.parse(row.capabilities),
        systemPrompt: row.systemPrompt,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async listAllAgents(): Promise<MissionControlAgent[]> {
      const all = await db.collection<StoredAgentRow>(COLLECTION_NAME).all();

      return all.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        provider: row.provider,
        model: row.model,
        capabilities: JSON.parse(row.capabilities),
        systemPrompt: row.systemPrompt,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async deleteAgent(agentId: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection(COLLECTION_NAME).delete(agentId);
      });
    },
  };
}

/**
 * Create a standard agent configuration for a given role and LLM provider.
 */
export function createStandardAgent(
  id: string,
  role: AgentRole,
  provider: AgentProvider,
  model: string,
): MissionControlAgent {
  const now = new Date().toISOString();
  return {
    id,
    name: `${role}-${provider}`,
    role,
    provider,
    model,
    capabilities: AGENT_CAPABILITIES[role],
    systemPrompt: AGENT_SYSTEM_PROMPTS[role],
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}
