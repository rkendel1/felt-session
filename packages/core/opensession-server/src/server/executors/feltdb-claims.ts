/**
 * FeltDB-backed Runner Executor claims and monotonic generation revocations.
 *
 * Durable record of which executor incarnation holds which generation,
 * preventing concurrent claims and tracking revocations.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

interface AuthorityRow {
  id: string;
  executorId: string;
  highestGeneration: number;
  revokedThrough: number;
}

interface ClaimRow {
  id: string;
  executorId: string;
  generation: number;
  instanceId: string;
}

const AUTHORITY_COLLECTION = "runner_executor_authority";
const CLAIMS_COLLECTION = "runner_executor_instance_claims";

/**
 * FeltDB-backed runner executor claims store.
 * Preserves the same invariants as SQLiteRunnerExecutorClaims.
 */
export class FeltDbRunnerExecutorClaims {
  readonly #db: ReturnType<typeof createFeltDB>;
  #closed = false;

  constructor(path: string) {
    if (!path || path === ":memory:")
      throw new Error(
        "a filesystem FeltDB path is required for Runner Executor claims",
      );
    
    // Ensure directory exists
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    const telemetry = getTelemetryClient();
    telemetry.disable();

    this.#db = createFeltDB({
      path,
      namespace: "runner-executor-claims",
    });
  }

  /**
   * Atomically claims one instance and refuses generations below the durable
   * high-water mark.
   */
  async claim(input: {
    executorId: string;
    generation: number;
    instanceId: string;
  }): Promise<boolean> {
    if (this.#closed) throw new Error("Claims store is closed");

    const authorityKey = input.executorId;
    const claimKey = `${input.executorId}_${input.generation}`;

    // Read outside of transaction
    const authority = await this.#db
      .collection<AuthorityRow>(AUTHORITY_COLLECTION)
      .get(authorityKey);
    const existing = await this.#db
      .collection<ClaimRow>(CLAIMS_COLLECTION)
      .get(claimKey);

    // Check if generation is below revocation threshold
    if (
      authority &&
      (input.generation < authority.highestGeneration ||
        input.generation <= authority.revokedThrough)
    ) {
      return false;
    }

    // If claim already exists, it must match
    if (existing) {
      return existing.instanceId === input.instanceId;
    }

    // Atomically update authority and create claim
    await this.#db.transaction((tx) => {
      // Update or create authority record
      if (!authority) {
        tx.collection<AuthorityRow>(AUTHORITY_COLLECTION).set(
          authorityKey,
          {
            id: authorityKey,
            executorId: input.executorId,
            highestGeneration: input.generation,
            revokedThrough: 0,
          },
        );
      } else if (input.generation > authority.highestGeneration) {
        tx.collection<AuthorityRow>(AUTHORITY_COLLECTION).set(
          authorityKey,
          {
            ...authority,
            highestGeneration: input.generation,
          },
        );
      }

      // Create new claim - this always happens
      tx.collection<ClaimRow>(CLAIMS_COLLECTION).set(claimKey, {
        id: claimKey,
        executorId: input.executorId,
        generation: input.generation,
        instanceId: input.instanceId,
      });
    });

    return true;
  }

  /** Revoke all generations through the specified one. */
  async revokeThrough(executorId: string, generation: number): Promise<void> {
    if (this.#closed) throw new Error("Claims store is closed");

    const authorityKey = executorId;

    // Read outside of transaction
    const authority = await this.#db
      .collection<AuthorityRow>(AUTHORITY_COLLECTION)
      .get(authorityKey);

    // Always perform at least one write operation
    await this.#db.transaction((tx) => {
      if (!authority) {
        tx.collection<AuthorityRow>(AUTHORITY_COLLECTION).set(
          authorityKey,
          {
            id: authorityKey,
            executorId,
            highestGeneration: 0,
            revokedThrough: generation,
          },
        );
      } else {
        tx.collection<AuthorityRow>(AUTHORITY_COLLECTION).set(
          authorityKey,
          {
            ...authority,
            revokedThrough: Math.max(authority.revokedThrough, generation),
          },
        );
      }
    });
  }

  close(): void | Promise<void> {
    this.#closed = true;
    try {
      return this.#db.close?.();
    } catch (error) {
      // Silently ignore close errors - they may occur if the DB is in an inconsistent state
    }
  }
}
