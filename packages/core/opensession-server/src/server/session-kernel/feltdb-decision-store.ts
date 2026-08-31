import { createHash } from "node:crypto";
import type {
  AtomicTransactionOperationRequest,
  StateFirstDB,
} from "@feltdb/core";

export const KERNEL_COLLECTIONS = {
  sessions: "opensession_kernel_sessions",
  changes: "opensession_kernel_changes",
  transactions: "opensession_kernel_transactions",
  tombstones: "opensession_kernel_tombstones",
  quarantine: "opensession_kernel_quarantine",
  outbox: "opensession_kernel_outbox",
  creation: "opensession_kernel_creation",
  asks: "opensession_kernel_asks",
  delivery: "opensession_kernel_delivery",
  turns: "opensession_kernel_turns",
  turnProjections: "opensession_kernel_turn_projections",
  turnProjectionGenerations: "opensession_kernel_turn_projection_generations",
  commands: "opensession_kernel_commands",
  timers: "opensession_kernel_timers",
  agentHostPlans: "opensession_kernel_agent_host_plans",
  agentHostSupervision: "opensession_kernel_agent_host_supervision",
  agentOperations: "opensession_kernel_agent_operations",
  agentOperationCancellations: "opensession_kernel_agent_operation_cancellations",
  agentOperationHighWater: "opensession_kernel_agent_operation_high_water",
  migrations: "opensession_kernel_migrations",
  migrationBatches: "opensession_kernel_migration_batches",
} as const;

export type SessionDecisionHead = {
  schemaVersion: 1;
  sessionId: string;
  authority: {
    owner: string;
    epoch: number;
    lifecycle: "active" | "tombstoned";
  };
  lease: null | {
    leaseId: string;
    epoch: number;
    expiresAt: number;
  };
  decisionEpoch: number;
  changeSeq: number;
  run: {
    state: string;
    since: string;
    lastEvent?: string;
    generation: number;
    currentRunId?: string;
  };
  migratedAt: number;
  migrationId: string;
  updatedAt: number;
};

export type VersionedSessionDecisionHead = SessionDecisionHead & { __version: number };

export type SessionKernelChange = {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  changeSeq: number;
  kind: string;
  payload?: unknown;
  transactionId: string;
  createdAt: number;
};

export type SessionKernelOutboxRecord = {
  schemaVersion: 1;
  recordId: string;
  effectId: string;
  effectKey: string;
  sessionId: string;
  decisionEpoch: number;
  kind: string;
  payload?: unknown;
  status: "pending" | "dead_letter";
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  deadLetteredAt?: number;
  createdAt: number;
};

export type SessionKernelTransactionReceipt<Result = unknown> = {
  schemaVersion: 1;
  transactionId: string;
  operationId: string;
  sessionId: string;
  operationKind: string;
  inputHash: string;
  changeSeq: number;
  journalId: string;
  effectIds: string[];
  result: Result;
  committedAt: number;
};

export type DecisionEffect = {
  effectKey: string;
  kind: string;
  payload?: unknown;
  nextAttemptAt?: number;
};

export type CommitSessionDecision<Result> = {
  transactionId: string;
  operationId: string;
  operationKind: string;
  inputHash: string;
  observedHead: VersionedSessionDecisionHead;
  nextRun?: SessionDecisionHead["run"];
  changeKind: string;
  changePayload?: unknown;
  domainOperations?: readonly AtomicTransactionOperationRequest[];
  effects?: readonly DecisionEffect[];
  result: Result;
  now?: number;
};

export type ActivateSessionInput = {
  sessionId: string;
  migrationId: string;
  owner: string;
  leaseId: string;
  leaseDurationMs: number;
  migrationManifestVersion?: number;
  run?: SessionDecisionHead["run"];
  changeSeq?: number;
  domainOperations?: readonly AtomicTransactionOperationRequest[];
  now?: number;
};

export type MigrationManifest = {
  schemaVersion: 1;
  sessionId: string;
  migrationId: string;
  phase: "importing" | "verified" | "activated";
  importedRecords: number;
  importedBatches: number;
  contentHash: string;
  updatedAt: number;
  __version?: number;
};

export type MigrationBatchInput = {
  sessionId: string;
  migrationId: string;
  batchId: string;
  recordCount: number;
  contentHash: string;
  observedManifest: MigrationManifest & { __version: number };
  operations: readonly AtomicTransactionOperationRequest[];
  now?: number;
};

type MigrationBatchReceipt = {
  schemaVersion: 1;
  sessionId: string;
  migrationId: string;
  batchId: string;
  recordCount: number;
  contentHash: string;
  committedAt: number;
};

export type ClearSessionInput = {
  transactionId: string;
  operationId: string;
  inputHash: string;
  observedHead: VersionedSessionDecisionHead;
  now?: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function kernelRecordId(prefix: string, identity: string): string {
  return `${prefix}_${sha256(identity)}`;
}

function withoutAuthorityVersion<T extends { __version: number }>(value: T): Omit<T, "__version"> {
  const { __version: _, ...record } = value;
  return record;
}

/**
 * Atomic authority surface for the Session Kernel decision backbone.
 *
 * Reducers may compute domain-specific state outside this class, but every
 * journal-head mutation enters through `commitDecision`, which fences the
 * observed head and commits its domain records, journal, effects, and replay
 * receipt together. This class accepts only a remote FeltDB authority.
 */
export class FeltDbSessionDecisionStore {
  constructor(private readonly db: StateFirstDB) {
    const runtime = db.runtime();
    if (runtime.runtime !== "remote" || runtime.storage !== "remote")
      throw new Error("Session Kernel decisions require a remote FeltDB authority");
  }

  async head(sessionId: string): Promise<VersionedSessionDecisionHead | undefined> {
    const head = await this.db
      .collection<VersionedSessionDecisionHead>(KERNEL_COLLECTIONS.sessions)
      .get(sessionId);
    if (!head) return undefined;
    if (!Number.isSafeInteger(head.__version) || head.__version < 1)
      throw new Error(`FeltDB session head ${sessionId} has no authority version`);
    if (head.sessionId !== sessionId || head.schemaVersion !== 1)
      throw new Error(`FeltDB session head ${sessionId} is invalid`);
    return head;
  }

  async record<T>(collection: string, id: string): Promise<T | undefined> {
    return (await this.db.collection<T>(collection).get(id)) ?? undefined;
  }

  async migrationManifest(
    sessionId: string,
  ): Promise<(MigrationManifest & { __version: number }) | undefined> {
    const manifest = await this.db
      .collection<MigrationManifest & { __version: number }>(KERNEL_COLLECTIONS.migrations)
      .get(sessionId);
    if (!manifest) return undefined;
    if (!Number.isSafeInteger(manifest.__version) || manifest.__version < 1)
      throw new Error(`FeltDB migration manifest ${sessionId} has no authority version`);
    return manifest;
  }

  async beginMigration(input: {
    sessionId: string;
    migrationId: string;
    now?: number;
  }): Promise<MigrationManifest & { __version: number }> {
    if (!input.sessionId || !input.migrationId)
      throw new Error("Session migration identities are required");
    const existing = await this.migrationManifest(input.sessionId);
    if (existing) {
      if (existing.migrationId !== input.migrationId)
        throw new Error(`Session ${input.sessionId} is already owned by another migration`);
      return existing;
    }
    const now = input.now ?? Date.now();
    await this.db.transaction({
      transactionId: `opensession:kernel:migration:begin:${input.migrationId}`,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.sessions, id: input.sessionId, requireAbsent: true },
        { collection: KERNEL_COLLECTIONS.tombstones, id: input.sessionId, requireAbsent: true },
      ],
      operations: [{
        collection: KERNEL_COLLECTIONS.migrations,
        id: input.sessionId,
        value: {
          schemaVersion: 1,
          sessionId: input.sessionId,
          migrationId: input.migrationId,
          phase: "importing",
          importedRecords: 0,
          importedBatches: 0,
          contentHash: "",
          updatedAt: now,
        } satisfies MigrationManifest,
        requireAbsent: true,
      }],
    });
    const created = await this.migrationManifest(input.sessionId);
    if (!created) throw new Error(`FeltDB migration manifest ${input.sessionId} is missing`);
    return created;
  }

  async importMigrationBatch(
    input: MigrationBatchInput,
  ): Promise<MigrationManifest & { __version: number }> {
    const manifest = input.observedManifest;
    if (
      manifest.sessionId !== input.sessionId ||
      manifest.migrationId !== input.migrationId ||
      manifest.phase !== "importing"
    ) throw new Error(`Session ${input.sessionId} migration is not importing`);
    if (!input.batchId || !Number.isSafeInteger(input.recordCount) || input.recordCount < 0)
      throw new Error("Migration batch identity and record count are required");
    const receiptId = kernelRecordId("migration_batch", `${input.migrationId}:${input.batchId}`);
    const receipts = this.db.collection<MigrationBatchReceipt>(KERNEL_COLLECTIONS.migrationBatches);
    const replay = await receipts.get(receiptId);
    if (replay) {
      this.validateMigrationBatchReplay(replay, input);
      const current = await this.migrationManifest(input.sessionId);
      if (!current) throw new Error(`FeltDB migration manifest ${input.sessionId} is missing`);
      return current;
    }
    const now = input.now ?? Date.now();
    const next: MigrationManifest = {
      ...manifest,
      importedRecords: manifest.importedRecords + input.recordCount,
      importedBatches: manifest.importedBatches + 1,
      contentHash: sha256(`${manifest.contentHash}:${input.batchId}:${input.contentHash}`),
      updatedAt: now,
    };
    delete next.__version;
    await this.db.transaction({
      transactionId: `opensession:kernel:migration:batch:${input.migrationId}:${input.batchId}`,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.sessions, id: input.sessionId, requireAbsent: true },
        { collection: KERNEL_COLLECTIONS.tombstones, id: input.sessionId, requireAbsent: true },
        { collection: KERNEL_COLLECTIONS.migrationBatches, id: receiptId, requireAbsent: true },
      ],
      operations: [
        ...input.operations,
        {
          collection: KERNEL_COLLECTIONS.migrations,
          id: input.sessionId,
          value: next,
          ifVersion: manifest.__version,
        },
        {
          collection: KERNEL_COLLECTIONS.migrationBatches,
          id: receiptId,
          value: {
            schemaVersion: 1,
            sessionId: input.sessionId,
            migrationId: input.migrationId,
            batchId: input.batchId,
            recordCount: input.recordCount,
            contentHash: input.contentHash,
            committedAt: now,
          } satisfies MigrationBatchReceipt,
          requireAbsent: true,
        },
      ],
    });
    const advanced = await this.migrationManifest(input.sessionId);
    if (!advanced) throw new Error(`FeltDB migration manifest ${input.sessionId} is missing`);
    return advanced;
  }

  async verifyMigration(input: {
    observedManifest: MigrationManifest & { __version: number };
    expectedRecords: number;
    expectedBatches: number;
    expectedContentHash: string;
    now?: number;
  }): Promise<MigrationManifest & { __version: number }> {
    const manifest = input.observedManifest;
    if (
      manifest.phase !== "importing" ||
      manifest.importedRecords !== input.expectedRecords ||
      manifest.importedBatches !== input.expectedBatches ||
      manifest.contentHash !== input.expectedContentHash
    ) throw new Error(`Session ${manifest.sessionId} migration verification failed`);
    const { __version: _, ...record } = manifest;
    await this.db.transaction({
      transactionId: `opensession:kernel:migration:verify:${manifest.migrationId}`,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.sessions, id: manifest.sessionId, requireAbsent: true },
        { collection: KERNEL_COLLECTIONS.tombstones, id: manifest.sessionId, requireAbsent: true },
      ],
      operations: [{
        collection: KERNEL_COLLECTIONS.migrations,
        id: manifest.sessionId,
        value: { ...record, phase: "verified", updatedAt: input.now ?? Date.now() },
        ifVersion: manifest.__version,
      }],
    });
    const verified = await this.migrationManifest(manifest.sessionId);
    if (!verified) throw new Error(`FeltDB migration manifest ${manifest.sessionId} is missing`);
    return verified;
  }

  async activateSession(input: ActivateSessionInput): Promise<VersionedSessionDecisionHead> {
    if (!input.sessionId || !input.migrationId || !input.owner || !input.leaseId)
      throw new Error("Session activation identities are required");
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0)
      throw new Error("Session activation requires a positive lease duration");
    if (
      input.changeSeq !== undefined &&
      (!Number.isSafeInteger(input.changeSeq) || input.changeSeq < 0)
    ) throw new Error("Session activation requires a non-negative change sequence");
    const existing = await this.head(input.sessionId);
    if (existing) {
      if (existing.migrationId !== input.migrationId)
        throw new Error(`Session ${input.sessionId} is already owned by another migration`);
      return existing;
    }
    const now = input.now ?? Date.now();
    const manifests = this.db.collection<MigrationManifest>(KERNEL_COLLECTIONS.migrations);
    const manifest = await manifests.get(input.sessionId);
    if (manifest) {
      if (
        manifest.migrationId !== input.migrationId ||
        manifest.phase !== "verified" ||
        !Number.isSafeInteger(manifest.__version) ||
        manifest.__version !== input.migrationManifestVersion
      ) throw new Error(`Session ${input.sessionId} migration manifest is not verified`);
    } else if (input.migrationManifestVersion !== undefined) {
      throw new Error(`Session ${input.sessionId} migration manifest is missing`);
    }
    const head: SessionDecisionHead = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      authority: { owner: input.owner, epoch: 1, lifecycle: "active" },
      lease: { leaseId: input.leaseId, epoch: 1, expiresAt: now + input.leaseDurationMs },
      decisionEpoch: 1,
      changeSeq: input.changeSeq ?? 0,
      run: input.run ?? {
        state: "idle",
        since: new Date(now).toISOString(),
        generation: 0,
      },
      migratedAt: now,
      migrationId: input.migrationId,
      updatedAt: now,
    };
    await this.db.transaction({
      transactionId: `opensession:kernel:activate:${input.migrationId}`,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.tombstones, id: input.sessionId, requireAbsent: true },
      ],
      operations: [
        ...(input.domainOperations ?? []),
        {
          collection: KERNEL_COLLECTIONS.migrations,
          id: input.sessionId,
          value: {
            schemaVersion: 1,
            sessionId: input.sessionId,
            migrationId: input.migrationId,
            phase: "activated",
            importedRecords: manifest?.importedRecords ?? 0,
            importedBatches: manifest?.importedBatches ?? 0,
            contentHash: manifest?.contentHash ?? "",
            updatedAt: now,
          } satisfies MigrationManifest,
          ...(manifest
            ? { ifVersion: manifest.__version! }
            : { requireAbsent: true as const }),
        },
        {
          collection: KERNEL_COLLECTIONS.sessions,
          id: input.sessionId,
          value: head,
          requireAbsent: true,
        },
      ],
    });
    const activated = await this.head(input.sessionId);
    if (!activated) throw new Error(`Activated FeltDB session ${input.sessionId} is missing`);
    return activated;
  }

  async acquireLease(input: {
    sessionId: string;
    owner: string;
    leaseId: string;
    leaseDurationMs: number;
    now?: number;
  }): Promise<VersionedSessionDecisionHead> {
    const observed = await this.head(input.sessionId);
    if (!observed) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    if (observed.authority.lifecycle !== "active")
      throw new Error(`Session ${input.sessionId} is tombstoned`);
    const now = input.now ?? Date.now();
    const priorLease = observed.lease;
    if (
      priorLease &&
      priorLease.expiresAt > now &&
      (observed.authority.owner !== input.owner || priorLease.leaseId !== input.leaseId)
    ) throw new Error(`Session ${input.sessionId} has a live writer lease`);
    const continuing = !!priorLease && priorLease.expiresAt > now &&
      observed.authority.owner === input.owner && priorLease.leaseId === input.leaseId;
    const epoch = continuing ? observed.authority.epoch : observed.authority.epoch + 1;
    const next: SessionDecisionHead = {
      ...withoutAuthorityVersion(observed),
      authority: { ...observed.authority, owner: input.owner, epoch },
      lease: { leaseId: input.leaseId, epoch, expiresAt: now + input.leaseDurationMs },
      updatedAt: now,
    };
    await this.db.transaction({
      transactionId: `opensession:kernel:lease:${input.sessionId}:${input.leaseId}:${now}`,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.tombstones, id: input.sessionId, requireAbsent: true },
      ],
      operations: [{
        collection: KERNEL_COLLECTIONS.sessions,
        id: input.sessionId,
        value: next,
        ifVersion: observed.__version,
        expectedEpoch: observed.authority.epoch,
        ...(priorLease && priorLease.expiresAt > now
          ? { expectedLeaseId: priorLease.leaseId }
          : {}),
      }],
    });
    const acquired = await this.head(input.sessionId);
    if (!acquired || acquired.lease?.leaseId !== input.leaseId)
      throw new Error(`Session ${input.sessionId} lease acquisition was not committed`);
    return acquired;
  }

  async clearSession(input: ClearSessionInput): Promise<number> {
    const head = input.observedHead;
    this.assertWritableHead(head);
    const receiptId = kernelRecordId("tx", input.transactionId);
    const receipts = this.db.collection<SessionKernelTransactionReceipt<number>>(
      KERNEL_COLLECTIONS.transactions,
    );
    const existing = await receipts.get(receiptId);
    if (existing) return this.validateAdministrativeReplay(existing, input, "clear");
    const now = input.now ?? Date.now();
    const nextEpoch = head.decisionEpoch + 1;
    const next: SessionDecisionHead = {
      ...withoutAuthorityVersion(head),
      decisionEpoch: nextEpoch,
      changeSeq: 0,
      run: { state: "idle", since: new Date(now).toISOString(), generation: 0 },
      updatedAt: now,
    };
    const receipt: SessionKernelTransactionReceipt<number> = {
      schemaVersion: 1,
      transactionId: input.transactionId,
      operationId: input.operationId,
      sessionId: head.sessionId,
      operationKind: "clear",
      inputHash: input.inputHash,
      changeSeq: 0,
      journalId: "",
      effectIds: [],
      result: nextEpoch,
      committedAt: now,
    };
    await this.db.transaction({
      transactionId: input.transactionId,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.tombstones, id: head.sessionId, requireAbsent: true },
        { collection: KERNEL_COLLECTIONS.transactions, id: receiptId, requireAbsent: true },
      ],
      operations: [
        {
          collection: KERNEL_COLLECTIONS.sessions,
          id: head.sessionId,
          value: next,
          ifVersion: head.__version,
          expectedEpoch: head.authority.epoch,
          expectedLeaseId: head.lease!.leaseId,
        },
        {
          collection: KERNEL_COLLECTIONS.transactions,
          id: receiptId,
          value: receipt,
          requireAbsent: true,
        },
      ],
    });
    return nextEpoch;
  }

  async tombstoneSession(input: ClearSessionInput): Promise<void> {
    const head = input.observedHead;
    this.assertWritableHead(head);
    const now = input.now ?? Date.now();
    const next: SessionDecisionHead = {
      ...withoutAuthorityVersion(head),
      authority: {
        ...head.authority,
        lifecycle: "tombstoned",
        epoch: head.authority.epoch + 1,
      },
      lease: null,
      updatedAt: now,
    };
    await this.db.transaction({
      transactionId: input.transactionId,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.tombstones, id: head.sessionId, requireAbsent: true },
      ],
      operations: [
        {
          collection: KERNEL_COLLECTIONS.sessions,
          id: head.sessionId,
          value: next,
          ifVersion: head.__version,
          expectedEpoch: head.authority.epoch,
          expectedLeaseId: head.lease!.leaseId,
        },
        {
          collection: KERNEL_COLLECTIONS.tombstones,
          id: head.sessionId,
          value: {
            schemaVersion: 1,
            sessionId: head.sessionId,
            deletedAt: now,
            authorityEpoch: next.authority.epoch,
            transactionId: input.transactionId,
          },
          requireAbsent: true,
        },
      ],
    });
  }

  async commitDecision<Result>(input: CommitSessionDecision<Result>): Promise<Result> {
    const receiptId = kernelRecordId("tx", input.transactionId);
    const receiptCollection = this.db.collection<SessionKernelTransactionReceipt<Result>>(
      KERNEL_COLLECTIONS.transactions,
    );
    const replay = await receiptCollection.get(receiptId);
    if (replay) return this.validateReplay(replay, input);

    const head = input.observedHead;
    this.assertWritableHead(head);
    const now = input.now ?? Date.now();
    const nextChangeSeq = head.changeSeq + 1;
    const journalId = kernelRecordId(
      "change",
      `${head.sessionId}:${head.decisionEpoch}:${nextChangeSeq}`,
    );
    const effects = (input.effects ?? []).map((effect): SessionKernelOutboxRecord => {
      const effectId = `${head.sessionId}:${effect.kind}:${effect.effectKey}`;
      const recordId = kernelRecordId(
        "effect",
        `${head.sessionId}:${head.decisionEpoch}:${effectId}`,
      );
      return {
        schemaVersion: 1,
        recordId,
        effectId,
        effectKey: effect.effectKey,
        sessionId: head.sessionId,
        decisionEpoch: head.decisionEpoch,
        kind: effect.kind,
        payload: effect.payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: effect.nextAttemptAt ?? now,
        createdAt: now,
      };
    });
    if (new Set(effects.map((effect) => effect.recordId)).size !== effects.length)
      throw new Error(`Decision ${input.transactionId} contains duplicate effects`);

    const nextHead: SessionDecisionHead = {
      ...withoutAuthorityVersion(head),
      changeSeq: nextChangeSeq,
      run: input.nextRun ?? head.run,
      updatedAt: now,
    };
    const change: SessionKernelChange = {
      schemaVersion: 1,
      sessionId: head.sessionId,
      decisionEpoch: head.decisionEpoch,
      changeSeq: nextChangeSeq,
      kind: input.changeKind,
      payload: input.changePayload,
      transactionId: input.transactionId,
      createdAt: now,
    };
    const receipt: SessionKernelTransactionReceipt<Result> = {
      schemaVersion: 1,
      transactionId: input.transactionId,
      operationId: input.operationId,
      sessionId: head.sessionId,
      operationKind: input.operationKind,
      inputHash: input.inputHash,
      changeSeq: nextChangeSeq,
      journalId,
      effectIds: effects.map((effect) => effect.recordId),
      result: input.result,
      committedAt: now,
    };
    const headGuard = {
      ifVersion: head.__version,
      expectedEpoch: head.authority.epoch,
      ...(head.lease ? { expectedLeaseId: head.lease.leaseId } : {}),
    };

    const outcome = await this.db.transaction({
      transactionId: input.transactionId,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.tombstones, id: head.sessionId, requireAbsent: true },
        { collection: KERNEL_COLLECTIONS.transactions, id: receiptId, requireAbsent: true },
      ],
      operations: [
        {
          collection: KERNEL_COLLECTIONS.sessions,
          id: head.sessionId,
          value: nextHead,
          ...headGuard,
        },
        ...(input.domainOperations ?? []),
        {
          collection: KERNEL_COLLECTIONS.changes,
          id: journalId,
          value: change,
          requireAbsent: true,
        },
        ...effects.map((effect) => ({
          collection: KERNEL_COLLECTIONS.outbox,
          id: effect.recordId,
          value: effect,
          requireAbsent: true as const,
        })),
        {
          collection: KERNEL_COLLECTIONS.transactions,
          id: receiptId,
          value: receipt,
          requireAbsent: true,
        },
      ],
    });
    if (outcome.duplicate) {
      const committed = await receiptCollection.get(receiptId);
      if (!committed)
        throw new Error(`FeltDB replay receipt ${input.transactionId} is missing`);
      return this.validateReplay(committed, input);
    }
    return input.result;
  }

  async changesSince(
    sessionId: string,
    decisionEpoch: number,
    afterChangeSeq: number,
    limit = 500,
  ): Promise<SessionKernelChange[]> {
    if (limit <= 0) return [];
    const page = await this.db.query<SessionKernelChange>({
      collection: KERNEL_COLLECTIONS.changes,
      where: [
        { field: "sessionId", eq: sessionId },
        { field: "decisionEpoch", eq: decisionEpoch },
        { field: "changeSeq", gt: afterChangeSeq },
      ],
      orderBy: [{ field: "changeSeq", direction: "asc" }],
      limit: Math.min(500, Math.max(1, Math.floor(limit))),
    });
    return page.records;
  }

  async dueOutbox(now = Date.now(), limit = 100): Promise<SessionKernelOutboxRecord[]> {
    if (limit <= 0) return [];
    const page = await this.db.query<SessionKernelOutboxRecord>({
      collection: KERNEL_COLLECTIONS.outbox,
      where: [
        { field: "status", eq: "pending" },
        { field: "nextAttemptAt", lte: now },
      ],
      orderBy: [
        { field: "nextAttemptAt", direction: "asc" },
        { field: "recordId", direction: "asc" },
      ],
      limit: Math.min(500, Math.max(1, Math.floor(limit))),
    });
    return page.records;
  }

  private assertWritableHead(head: VersionedSessionDecisionHead): void {
    if (head.authority.lifecycle !== "active")
      throw new Error(`Session ${head.sessionId} is tombstoned`);
    if (!head.lease)
      throw new Error(`Session ${head.sessionId} has no writer lease`);
    if (head.lease.epoch !== head.authority.epoch)
      throw new Error(`Session ${head.sessionId} has an invalid writer lease`);
  }

  private validateReplay<Result>(
    receipt: SessionKernelTransactionReceipt<Result>,
    input: CommitSessionDecision<Result>,
  ): Result {
    if (
      receipt.transactionId !== input.transactionId ||
      receipt.operationId !== input.operationId ||
      receipt.sessionId !== input.observedHead.sessionId ||
      receipt.operationKind !== input.operationKind ||
      receipt.inputHash !== input.inputHash
    ) throw new Error(`FeltDB transaction ${input.transactionId} was reused for another decision`);
    return receipt.result;
  }

  private validateAdministrativeReplay(
    receipt: SessionKernelTransactionReceipt<number>,
    input: ClearSessionInput,
    operationKind: string,
  ): number {
    if (
      receipt.transactionId !== input.transactionId ||
      receipt.operationId !== input.operationId ||
      receipt.sessionId !== input.observedHead.sessionId ||
      receipt.operationKind !== operationKind ||
      receipt.inputHash !== input.inputHash
    ) throw new Error(`FeltDB transaction ${input.transactionId} was reused`);
    return receipt.result;
  }

  private validateMigrationBatchReplay(
    receipt: MigrationBatchReceipt,
    input: MigrationBatchInput,
  ): void {
    if (
      receipt.sessionId !== input.sessionId ||
      receipt.migrationId !== input.migrationId ||
      receipt.batchId !== input.batchId ||
      receipt.recordCount !== input.recordCount ||
      receipt.contentHash !== input.contentHash
    ) throw new Error(`FeltDB migration batch ${input.batchId} was reused`);
  }
}
