import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConditionalConflictError,
  createFeltDB,
  type StateFirstDB,
} from "@feltdb/core";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type SessionDecisionHead,
} from "./feltdb-decision-store";

const serverBinary = process.env.FELTDB_SERVER_BIN;
const authorityTest = serverBinary ? describe : describe.skip;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject)
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

authorityTest("FeltDB Session Kernel decision authority", () => {
  let process: ChildProcess;
  let dataDir: string;
  let url: string;
  let db: StateFirstDB;

  const connect = () => createFeltDB({
    namespace: "opensession-decision-test",
    server: { url, token: "" },
  });

  beforeAll(async () => {
    const port = await availablePort();
    dataDir = mkdtempSync(join(tmpdir(), "opensession-feltdb-decision-"));
    url = `http://127.0.0.1:${port}`;
    process = spawn(serverBinary!, [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--data", join(dataDir, "feltdb.log"),
      "--namespace", "opensession-decision-test",
    ], {
      env: { ...globalThis.process.env, FELTDB_MASTER_KEY: "decision-test-key" },
      stdio: "ignore",
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (process.exitCode !== null) throw new Error("FeltDB authority exited during startup");
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch { /* authority is starting */ }
      await Bun.sleep(50);
    }
    db = connect();
  });

  afterAll(async () => {
    if (process?.exitCode === null) {
      const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
      process.kill("SIGTERM");
      await exited;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function createHead(sessionId: string): Promise<void> {
    const now = Date.now();
    const head: SessionDecisionHead = {
      schemaVersion: 1,
      sessionId,
      authority: { owner: "worker-a", epoch: 1, lifecycle: "active" },
      lease: { leaseId: "lease-a", epoch: 1, expiresAt: now + 60_000 },
      decisionEpoch: 1,
      changeSeq: 0,
      run: { state: "idle", since: new Date(now).toISOString(), generation: 0 },
      migratedAt: now,
      migrationId: `migration-${sessionId}`,
      updatedAt: now,
    };
    await db.transaction({
      transactionId: `activate-${sessionId}`,
      operations: [{
        collection: KERNEL_COLLECTIONS.sessions,
        id: sessionId,
        value: head,
        requireAbsent: true,
      }],
    });
  }

  test("activates bounded state and the authority marker together", async () => {
    const store = new FeltDbSessionDecisionStore(db);
    const activated = await store.activateSession({
      sessionId: "session-activated",
      migrationId: "migration-activated",
      owner: "worker-a",
      leaseId: "lease-a",
      leaseDurationMs: 60_000,
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.creation,
        id: "session-activated",
        value: { schemaVersion: 1, sessionId: "session-activated", state: "ready" },
        requireAbsent: true,
      }],
    });
    expect(activated.__version).toBe(1);
    expect(await db.collection(KERNEL_COLLECTIONS.creation).get("session-activated"))
      .toMatchObject({ state: "ready" });
    expect((await store.activateSession({
      sessionId: "session-activated",
      migrationId: "migration-activated",
      owner: "worker-a",
      leaseId: "lease-a",
      leaseDurationMs: 60_000,
    })).migrationId).toBe("migration-activated");
  });

  test("imports bounded migration batches before atomic activation", async () => {
    const store = new FeltDbSessionDecisionStore(db);
    let manifest = await store.beginMigration({
      sessionId: "session-migrated",
      migrationId: "migration-bounded",
      now: 100,
    });
    manifest = await store.importMigrationBatch({
      sessionId: "session-migrated",
      migrationId: "migration-bounded",
      batchId: "creation-1",
      recordCount: 1,
      contentHash: "creation-hash",
      observedManifest: manifest,
      operations: [{
        collection: KERNEL_COLLECTIONS.creation,
        id: "session-migrated",
        value: { schemaVersion: 1, sessionId: "session-migrated", state: "ready" },
        requireAbsent: true,
      }],
      now: 101,
    });
    const replay = await store.importMigrationBatch({
      sessionId: "session-migrated",
      migrationId: "migration-bounded",
      batchId: "creation-1",
      recordCount: 1,
      contentHash: "creation-hash",
      observedManifest: manifest,
      operations: [],
      now: 102,
    });
    expect(replay.importedRecords).toBe(1);
    expect(replay.importedBatches).toBe(1);
    manifest = await store.verifyMigration({
      observedManifest: replay,
      expectedRecords: 1,
      expectedBatches: 1,
      expectedContentHash: replay.contentHash,
      now: 103,
    });
    const activated = await store.activateSession({
      sessionId: "session-migrated",
      migrationId: "migration-bounded",
      owner: "worker-a",
      leaseId: "lease-a",
      leaseDurationMs: 60_000,
      migrationManifestVersion: manifest.__version,
      now: 104,
    });
    expect(activated.migrationId).toBe("migration-bounded");
    expect((await store.migrationManifest("session-migrated"))?.phase).toBe("activated");
  });

  test("commits head, domain, journal, effect, and receipt atomically", async () => {
    await createHead("session-a");
    const store = new FeltDbSessionDecisionStore(db);
    const observedHead = (await store.head("session-a"))!;
    const input = {
      transactionId: "decision-a",
      operationId: "create-a",
      operationKind: "creation",
      inputHash: "input-a",
      observedHead,
      changeKind: "creation_state",
      changePayload: { state: "ready" },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.creation,
        id: "session-a",
        value: { schemaVersion: 1, sessionId: "session-a", state: "ready" },
        requireAbsent: true,
      }],
      effects: [{ effectKey: "open-a", kind: "open_session", payload: { id: "session-a" } }],
      result: { state: "ready" },
    } as const;
    expect(await store.commitDecision(input)).toEqual({ state: "ready" });
    expect(await store.commitDecision(input)).toEqual({ state: "ready" });
    expect((await store.head("session-a"))?.changeSeq).toBe(1);
    expect(await store.changesSince("session-a", 1, 0)).toHaveLength(1);
    const [effect] = await store.dueOutbox(Date.now() + 1_000);
    expect(effect).toBeTruthy();
    expect(await db.collection(KERNEL_COLLECTIONS.creation).get("session-a")).toBeTruthy();
    const observedRecord = await store.outboxRecord(effect!.recordId);
    const observedAfterDecision = await store.head("session-a");
    const settlement = {
      transactionId: "outbox-ack-a",
      operationId: "ack-a",
      operationKind: "outbox_ack" as const,
      inputHash: "ack-input-a",
      observedHead: observedAfterDecision!,
      observedRecord: observedRecord!,
      result: { acknowledged: true },
    };
    expect(await store.commitOutboxMutation(settlement)).toEqual({ acknowledged: true });
    expect(await store.commitOutboxMutation(settlement)).toEqual({ acknowledged: true });
    expect(await store.outboxRecord(effect!.recordId)).toBeUndefined();
  });

  test("permits one stale decision and leaves no losing writes", async () => {
    await createHead("session-race");
    const first = new FeltDbSessionDecisionStore(db);
    const second = new FeltDbSessionDecisionStore(connect());
    const observedHead = (await first.head("session-race"))!;
    const decide = (suffix: string) => ({
      transactionId: `race-${suffix}`,
      operationId: `race-${suffix}`,
      operationKind: "run",
      inputHash: `hash-${suffix}`,
      observedHead,
      changeKind: "run_state",
      result: suffix,
    });
    const outcomes = await Promise.allSettled([
      first.commitDecision(decide("a")),
      second.commitDecision(decide("b")),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected && rejected.reason).toBeInstanceOf(ConditionalConflictError);
    expect((await first.head("session-race"))?.changeSeq).toBe(1);
    expect(await first.changesSince("session-race", 1, 0)).toHaveLength(1);
  });

  test("tombstone precondition prevents resurrection", async () => {
    await createHead("session-deleted");
    const store = new FeltDbSessionDecisionStore(db);
    const observedHead = (await store.head("session-deleted"))!;
    await db.collection(KERNEL_COLLECTIONS.tombstones).insert({ deletedAt: Date.now() }, "session-deleted");
    await expect(store.commitDecision({
      transactionId: "deleted-decision",
      operationId: "deleted-decision",
      operationKind: "run",
      inputHash: "deleted",
      observedHead,
      changeKind: "run_state",
      result: null,
    })).rejects.toBeInstanceOf(ConditionalConflictError);
    expect((await store.head("session-deleted"))?.changeSeq).toBe(0);
  });

  test("lease takeover fences the former writer", async () => {
    const store = new FeltDbSessionDecisionStore(db);
    const old = await store.activateSession({
      sessionId: "session-lease",
      migrationId: "migration-lease",
      owner: "worker-old",
      leaseId: "lease-old",
      leaseDurationMs: 10,
      now: 100,
    });
    const current = await store.acquireLease({
      sessionId: "session-lease",
      owner: "worker-new",
      leaseId: "lease-new",
      leaseDurationMs: 100,
      now: 111,
    });
    expect(current.authority.epoch).toBe(old.authority.epoch + 1);
    await expect(store.commitDecision({
      transactionId: "stale-lease-decision",
      operationId: "stale-lease-decision",
      operationKind: "run",
      inputHash: "stale",
      observedHead: old,
      changeKind: "run_state",
      result: null,
    })).rejects.toBeInstanceOf(ConditionalConflictError);
  });

  test("clear advances the decision epoch and tombstone permanently fences writes", async () => {
    const store = new FeltDbSessionDecisionStore(db);
    let head = await store.activateSession({
      sessionId: "session-admin",
      migrationId: "migration-admin",
      owner: "worker-a",
      leaseId: "lease-a",
      leaseDurationMs: 60_000,
    });
    const nextEpoch = await store.clearSession({
      transactionId: "clear-admin",
      operationId: "clear-admin",
      inputHash: "clear-admin",
      observedHead: head,
    });
    expect(nextEpoch).toBe(2);
    expect(await store.clearSession({
      transactionId: "clear-admin",
      operationId: "clear-admin",
      inputHash: "clear-admin",
      observedHead: head,
    })).toBe(2);
    head = (await store.head("session-admin"))!;
    await store.tombstoneSession({
      transactionId: "delete-admin",
      operationId: "delete-admin",
      inputHash: "delete-admin",
      observedHead: head,
    });
    expect((await store.head("session-admin"))?.authority.lifecycle).toBe("tombstoned");
    await expect(store.acquireLease({
      sessionId: "session-admin",
      owner: "worker-b",
      leaseId: "lease-b",
      leaseDurationMs: 60_000,
    })).rejects.toThrow("tombstoned");
  });

  test("uses deterministic FeltDB-safe identities", () => {
    expect(kernelRecordId("tx", "same")).toBe(kernelRecordId("tx", "same"));
    expect(kernelRecordId("tx", "same")).not.toBe(kernelRecordId("tx", "other"));
    expect(kernelRecordId("tx", "same")).toMatch(/^tx_[a-f0-9]{64}$/);
  });
});

test("decision authority refuses embedded FeltDB", () => {
  expect(() => new FeltDbSessionDecisionStore(createFeltDB({ namespace: "bad", memory: true })))
    .toThrow("remote FeltDB authority");
});
