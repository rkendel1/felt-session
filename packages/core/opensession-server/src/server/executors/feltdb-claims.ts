/**
 * FeltDB-backed Runner Executor claims and monotonic generation revocations.
 *
 * Durable record of which executor incarnation holds which generation,
 * preventing concurrent claims and tracking revocations.
 */

import type { StateFirstDB } from "@feltdb/core";

interface AuthorityRow {
  id: string;
  executorId: string;
  highestGeneration: number;
  revokedThrough: number;
  __version?: number;
}

interface ClaimRow {
  id: string;
  executorId: string;
  generation: number;
  instanceId: string;
  __version?: number;
}

const AUTHORITY_COLLECTION = "runner_executor_authority";
const CLAIMS_COLLECTION = "runner_executor_instance_claims";

/**
 * FeltDB-backed runner executor claims store.
 * Preserves the same invariants as SQLiteRunnerExecutorClaims.
 */
export class FeltDbRunnerExecutorClaims {
  readonly #db: StateFirstDB;
  #closed = false;

  constructor(db: StateFirstDB) {
    if (!db)
      throw new Error(
        "managed FeltDB authority is required for Runner Executor claims",
      );
    this.#db = db;
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

    for (;;) {
      const authority = await this.#db
        .collection<AuthorityRow>(AUTHORITY_COLLECTION)
        .get(authorityKey);
      const existing = await this.#db
        .collection<ClaimRow>(CLAIMS_COLLECTION)
        .get(claimKey);

      if (
        authority &&
        (input.generation < authority.highestGeneration ||
          input.generation <= authority.revokedThrough)
      )
        return false;
      if (existing) return existing.instanceId === input.instanceId;

      try {
        await this.#db.transaction((tx) => {
          if (!authority || input.generation > authority.highestGeneration) {
            tx.collection<AuthorityRow>(AUTHORITY_COLLECTION).set(
              authorityKey,
              authority
                ? { ...authority, highestGeneration: input.generation }
                : {
                    id: authorityKey,
                    executorId: input.executorId,
                    highestGeneration: input.generation,
                    revokedThrough: 0,
                  },
              authority?.__version === undefined
                ? { requireAbsent: true }
                : { ifVersion: authority.__version },
            );
          }
          tx.collection<ClaimRow>(CLAIMS_COLLECTION).set(
            claimKey,
            {
              id: claimKey,
              executorId: input.executorId,
              generation: input.generation,
              instanceId: input.instanceId,
            },
            { requireAbsent: true },
          );
        });
        return true;
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalConflictError")
          throw error;
      }
    }
  }

  /** Revoke all generations through the specified one. */
  async revokeThrough(executorId: string, generation: number): Promise<void> {
    if (this.#closed) throw new Error("Claims store is closed");

    for (;;) {
      const authority = await this.#db
        .collection<AuthorityRow>(AUTHORITY_COLLECTION)
        .get(executorId);
      if (authority && authority.revokedThrough >= generation) return;
      try {
        await this.#db.transaction((tx) => {
          tx.collection<AuthorityRow>(AUTHORITY_COLLECTION).set(
            executorId,
            authority
              ? { ...authority, revokedThrough: generation }
              : {
                  id: executorId,
                  executorId,
                  highestGeneration: 0,
                  revokedThrough: generation,
                },
            authority?.__version === undefined
              ? { requireAbsent: true }
              : { ifVersion: authority.__version },
          );
        });
        return;
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalConflictError")
          throw error;
      }
    }
  }

  close(): void | Promise<void> {
    this.#closed = true;
  }
}
