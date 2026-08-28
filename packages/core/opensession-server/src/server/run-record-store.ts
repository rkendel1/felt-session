/**
 * FeltDB-backed Run Record Store
 *
 * Replaces active-runs.json as the sole durable authority for active run metadata.
 * Handles run lifecycle tracking, recovery, and state transitions.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ActiveRunRecord } from "./run-journal";

interface StoredRunRecord {
  // Primary key
  id: string; // runKey

  // Identifiers
  runKey: string;
  osSessionId?: string;
  claudeSessionId?: string;

  // Prompt and entry
  prompt?: string;
  promptEntryId?: string;

  // Environment and configuration
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  user?: string;

  // MCP and tool configuration
  mcpServersJson?: string; // serialized McpScope
  deniedToolsJson?: string; // serialized Record<string, string>
  confirmToolsJson?: string; // serialized Record<string, string>

  // Runtime configuration
  aws?: boolean;
  claudeCliEnv?: boolean;
  codexCliEnv?: boolean;
  model?: string;
  selectedModel?: string;
  transientFallback?: boolean;
  effort?: string;
  fastMode?: boolean;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  fallbackModel?: string;
  prReviewer?: string;

  // Executor and sandbox
  serverKey?: string;
  launchPhase?: "prepared" | "launching" | "started";
  sandboxId?: string;
  runnerId?: string;
  hostId?: string;
  sandboxProvider?: string;
  trustProfile?: "interactive" | "automation";

  // Run metadata
  kind?: string;
  firstJournaledAt?: string;
  resumeAttempts?: number;
  lastResumeAt?: string;
  terminalFailureJson?: string; // serialized { type: "error"; content: string; at: string }

  // Timestamps
  startedAt: string;
  claimedAt?: string;
}

const RUNS_COLLECTION = "active_runs";

/**
 * Run Record Store interface
 */
export interface RunRecordStore {
  /**
   * Register a run as active
   */
  recordRun(record: ActiveRunRecord): Promise<void>;

  /**
   * Get all active runs
   */
  getAllRuns(): Promise<ActiveRunRecord[]>;

  /**
   * Get a specific run by key
   */
  getRun(runKey: string): Promise<ActiveRunRecord | null>;

  /**
   * Get all runs that haven't been claimed (for recovery)
   */
  getUnclaimedRuns(): Promise<ActiveRunRecord[]>;

  /**
   * Mark a run as claimed (recovery in progress)
   */
  claimRun(runKey: string, claimedAt: string): Promise<void>;

  /**
   * Remove a run from the active list
   */
  clearRun(runKey: string): Promise<void>;

  /**
   * Clear a run and its lineage
   */
  clearRunIfLineage(record: ActiveRunRecord): Promise<boolean>;

  /**
   * Close the store
   */
  close(): Promise<void>;
}

/**
 * Open a FeltDB-backed run record store
 */
export function openRunRecordStore(path: string): RunRecordStore {
  if (!path || path === ":memory:") {
    throw new Error(
      "a filesystem FeltDB path is required for Run Record Store",
    );
  }

  // Ensure directory exists
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "run-records",
  });

  // Helper to convert stored row to ActiveRunRecord
  function rowToRecord(row: StoredRunRecord): ActiveRunRecord {
    return {
      runKey: row.runKey,
      osSessionId: row.osSessionId,
      claudeSessionId: row.claudeSessionId,
      prompt: row.prompt,
      promptEntryId: row.promptEntryId,
      cwd: row.cwd,
      mode: row.mode,
      mcpServers: row.mcpServersJson ? JSON.parse(row.mcpServersJson) : undefined,
      user: row.user,
      deniedTools: row.deniedToolsJson ? JSON.parse(row.deniedToolsJson) : undefined,
      confirmTools: row.confirmToolsJson ? JSON.parse(row.confirmToolsJson) : undefined,
      aws: row.aws,
      claudeCliEnv: row.claudeCliEnv,
      codexCliEnv: row.codexCliEnv,
      model: row.model,
      selectedModel: row.selectedModel,
      transientFallback: row.transientFallback,
      effort: row.effort,
      fastMode: row.fastMode,
      accountId: row.accountId,
      accountStrict: row.accountStrict,
      usageCredits: row.usageCredits,
      fallbackModel: row.fallbackModel,
      prReviewer: row.prReviewer,
      serverKey: row.serverKey,
      launchPhase: row.launchPhase,
      sandboxId: row.sandboxId,
      runnerId: row.runnerId,
      hostId: row.hostId,
      sandboxProvider: row.sandboxProvider,
      trustProfile: row.trustProfile,
      kind: row.kind,
      firstJournaledAt: row.firstJournaledAt,
      resumeAttempts: row.resumeAttempts,
      lastResumeAt: row.lastResumeAt,
      terminalFailure: row.terminalFailureJson ? JSON.parse(row.terminalFailureJson) : undefined,
      startedAt: row.startedAt,
      claimedAt: row.claimedAt,
    };
  }

  // Helper to convert ActiveRunRecord to stored row
  function recordToRow(record: ActiveRunRecord): StoredRunRecord {
    return {
      id: record.runKey,
      runKey: record.runKey,
      osSessionId: record.osSessionId,
      claudeSessionId: record.claudeSessionId,
      prompt: record.prompt,
      promptEntryId: record.promptEntryId,
      cwd: record.cwd,
      mode: record.mode,
      mcpServersJson: record.mcpServers ? JSON.stringify(record.mcpServers) : undefined,
      user: record.user,
      deniedToolsJson: record.deniedTools ? JSON.stringify(record.deniedTools) : undefined,
      confirmToolsJson: record.confirmTools ? JSON.stringify(record.confirmTools) : undefined,
      aws: record.aws,
      claudeCliEnv: record.claudeCliEnv,
      codexCliEnv: record.codexCliEnv,
      model: record.model,
      selectedModel: record.selectedModel,
      transientFallback: record.transientFallback,
      effort: record.effort,
      fastMode: record.fastMode,
      accountId: record.accountId,
      accountStrict: record.accountStrict,
      usageCredits: record.usageCredits,
      fallbackModel: record.fallbackModel,
      prReviewer: record.prReviewer,
      serverKey: record.serverKey,
      launchPhase: record.launchPhase,
      sandboxId: record.sandboxId,
      runnerId: record.runnerId,
      hostId: record.hostId,
      sandboxProvider: record.sandboxProvider,
      trustProfile: record.trustProfile,
      kind: record.kind,
      firstJournaledAt: record.firstJournaledAt,
      resumeAttempts: record.resumeAttempts,
      lastResumeAt: record.lastResumeAt,
      terminalFailureJson: record.terminalFailure ? JSON.stringify(record.terminalFailure) : undefined,
      startedAt: record.startedAt,
      claimedAt: record.claimedAt,
    };
  }

  return {
    async recordRun(record: ActiveRunRecord): Promise<void> {
      const row = recordToRow(record);
      await db.transaction((tx) => {
        tx.collection<StoredRunRecord>(RUNS_COLLECTION).set(row.id, row);
      });
    },

    async getAllRuns(): Promise<ActiveRunRecord[]> {
      const rows = await db.collection<StoredRunRecord>(RUNS_COLLECTION).find({});
      return rows.map(rowToRecord);
    },

    async getRun(runKey: string): Promise<ActiveRunRecord | null> {
      const row = await db
        .collection<StoredRunRecord>(RUNS_COLLECTION)
        .get(runKey);
      return row ? rowToRecord(row) : null;
    },

    async getUnclaimedRuns(): Promise<ActiveRunRecord[]> {
      const rows = await db
        .collection<StoredRunRecord>(RUNS_COLLECTION)
        .find({});
      
      return rows
        .filter((row) => !row.claimedAt)
        .map(rowToRecord);
    },

    async claimRun(runKey: string, claimedAt: string): Promise<void> {
      const row = await db
        .collection<StoredRunRecord>(RUNS_COLLECTION)
        .get(runKey);

      if (!row) return;

      const updated = { ...row, claimedAt };
      await db.transaction((tx) => {
        tx.collection<StoredRunRecord>(RUNS_COLLECTION).set(runKey, updated);
      });
    },

    async clearRun(runKey: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredRunRecord>(RUNS_COLLECTION).delete(runKey);
      });
    },

    async clearRunIfLineage(record: ActiveRunRecord): Promise<boolean> {
      // Clear a run and all its descendants in the lineage
      const allRuns = await db
        .collection<StoredRunRecord>(RUNS_COLLECTION)
        .find({});

      let cleared = false;

      // Check if this run should be cleared based on lineage
      // For now, clear if it has a promptEntryId (indicates it came from a prompt)
      if (record.promptEntryId) {
        // Clear the run
        await db.transaction((tx) => {
          tx
            .collection<StoredRunRecord>(RUNS_COLLECTION)
            .delete(record.runKey);
        });
        cleared = true;

        // Clear any descendant runs that reference this one
        for (const other of allRuns) {
          if (
            other.promptEntryId === record.promptEntryId &&
            other.runKey !== record.runKey
          ) {
            await db.transaction((tx) => {
              tx
                .collection<StoredRunRecord>(RUNS_COLLECTION)
                .delete(other.runKey);
            });
          }
        }
      }

      return cleared;
    },

    async close(): Promise<void> {
      try {
        await db.close?.();
      } catch {
        // Ignore close errors
      }
    },
  };
}
