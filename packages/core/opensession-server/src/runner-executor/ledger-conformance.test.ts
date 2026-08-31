/**
 * One contract, two stores.
 *
 * Everything here is expressed purely against DurableCommandLedger, so each
 * case runs unchanged on the in-memory reference and the FeltDB ledger. A backend that drifts from the contract fails here rather than
 * in the dual-write phase, where a divergence would look like data loss.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  InMemoryCommandLedger,
  LedgerFullError,
  operationDigest,
  type DurableCommandLedger,
  type LedgerCommandIdentity,
  type LedgerScope,
} from "./ledger";
import { openFeltDbCommandLedger } from "./feltdb-ledger";
import { createFeltDB } from "@feltdb/core";

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

interface Backend {
  name: string;
  open(options?: { capacity?: number }): DurableCommandLedger;
}

const backends: Backend[] = [
  {
    name: "InMemoryCommandLedger",
    open: (options) => new InMemoryCommandLedger(options?.capacity ?? 100_000),
  },
  {
    name: "FeltDbCommandLedger",
    open: (options) => {
      const ledger = openFeltDbCommandLedger({
        db: createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
        ...options,
      });
      closers.push(() => ledger.close());
      return ledger;
    },
  },
];

const baseScope: LedgerScope = {
  executorId: "executor-1",
  rootId: "root-1",
  sessionId: "session-1",
  runId: "run-1",
  generation: 1,
};
const completedAt = "2026-08-22T12:00:01.000Z";

function command(
  requestId: string,
  options: { key?: string; scope?: Partial<LedgerScope>; data?: string } = {},
): LedgerCommandIdentity {
  const operation = options.key
    ? {
        kind: "fs.write" as const,
        path: "x",
        data: options.data ?? "a",
        encoding: "utf8" as const,
        idempotencyKey: options.key,
      }
    : ({ kind: "fs.read" as const, path: "x" } as const);
  return {
    ...baseScope,
    ...options.scope,
    requestId,
    ...(options.key ? { idempotencyKey: options.key } : {}),
    operation,
    operationDigest: operationDigest(operation),
  };
}

function receipt(identity: LedgerCommandIdentity, id: string) {
  return {
    receiptId: id,
    requestId: identity.requestId,
    state: "queued" as const,
    acceptedAt: "2026-08-22T12:00:00.000Z",
    ...(identity.idempotencyKey
      ? { idempotencyKey: identity.idempotencyKey }
      : {}),
  };
}

function claim(
  ledger: DurableCommandLedger,
  identity: LedgerCommandIdentity,
  id: string,
) {
  return ledger.claim(identity, receipt(identity, id));
}

async function running(
  ledger: DurableCommandLedger,
  identity: LedgerCommandIdentity,
  id: string,
) {
  await claim(ledger, identity, id);
  return ledger.transition(identity, id, "queued", { state: "running" });
}

for (const backend of backends) {
  describe(`DurableCommandLedger contract: ${backend.name}`, () => {
    test("returns one stable receipt per command and detects digest conflicts", async () => {
      const ledger = backend.open();
      const first = await claim(ledger, command("a", { key: "shared" }), "r-a");
      expect(first.claimed).toBe(true);
      const replay = await claim(
        ledger,
        command("a", { key: "shared" }),
        "r-b",
      );
      expect(replay.claimed).toBe(false);
      expect(replay.record.receipt.receiptId).toBe("r-a");
      await expect(
        claim(
          ledger,
          command("c", { key: "shared", data: "different" }),
          "r-c",
        ),
      ).rejects.toMatchObject({ name: "LedgerConflictError" });
    });

    test("rejects a receipt id already owned by another command", async () => {
      const ledger = backend.open();
      await claim(ledger, command("a"), "shared-receipt");
      await expect(
        claim(ledger, command("b"), "shared-receipt"),
      ).rejects.toMatchObject({ name: "LedgerConflictError" });
    });

    test("scopes key reuse by executor/root/run/generation", async () => {
      const ledger = backend.open();
      const variants = [
        command("a", { key: "same" }),
        command("b", { key: "same", scope: { rootId: "root-2" } }),
        command("c", { key: "same", scope: { runId: "run-2" } }),
        command("d", { key: "same", scope: { generation: 2 } }),
      ];
      for (const [index, identity] of variants.entries())
        expect((await claim(ledger, identity, `r${index}`)).claimed).toBe(true);
    });

    test("requires exact scope ownership for receipt lookup", async () => {
      const ledger = backend.open();
      const identity = command("request");
      await claim(ledger, identity, "receipt");
      expect(await ledger.get(identity, "receipt")).toBeDefined();
      expect(
        await ledger.get({ ...identity, rootId: "other-root" }, "receipt"),
      ).toBeUndefined();
    });

    test("recovers inherited work once and marks mutations ambiguous", async () => {
      const ledger = backend.open();
      const read = command("read");
      const mutation = command("mutation", { key: "key" });
      await claim(ledger, read, "read-r");
      await running(ledger, mutation, "mutation-r");
      expect(await ledger.recover()).toBe(2);
      const recoveredRead = await ledger.get(read, "read-r");
      expect(recoveredRead).toMatchObject({
        receipt: { state: "failed" },
        error: { code: "operation_failed" },
      });
      expect(recoveredRead?.error?.ambiguous).toBeUndefined();
      expect(await ledger.get(mutation, "mutation-r")).toMatchObject({
        receipt: { state: "failed" },
        error: { ambiguous: true },
      });
      expect(await ledger.recover()).toBe(0);
    });

    test("enforces monotonic transitions and coherent terminal payloads", async () => {
      const ledger = backend.open();
      const identity = command("request");
      await running(ledger, identity, "receipt");
      const succeeded = await ledger.transition(
        identity,
        "receipt",
        "running",
        {
          state: "succeeded",
          completedAt,
          outcome: {
            kind: "fs.read",
            streamId: "stream",
            size: 0,
            binary: false,
          },
        },
      );
      expect(succeeded.error).toBeUndefined();
      await expect(
        ledger.transition(identity, "receipt", "running", {
          state: "failed",
          completedAt,
          error: { code: "operation_failed", message: "late send failure" },
        }),
      ).rejects.toMatchObject({ name: "LedgerTransitionError" });
      expect((await ledger.get(identity, "receipt"))?.receipt.state).toBe(
        "succeeded",
      );
    });

    test("reports a missing receipt as not found", async () => {
      const ledger = backend.open();
      await expect(
        ledger.transition(baseScope, "absent-receipt", "queued", {
          state: "running",
        }),
      ).rejects.toMatchObject({ name: "LedgerNotFoundError" });
    });

    test("failed transitions contain no stale outcome or events", async () => {
      const ledger = backend.open();
      const identity = command("request");
      await running(ledger, identity, "receipt");
      const failed = await ledger.transition(identity, "receipt", "running", {
        state: "failed",
        completedAt,
        error: { code: "operation_failed", message: "failed" },
      });
      expect(failed).toMatchObject({ receipt: { state: "failed" } });
      expect(failed.outcome).toBeUndefined();
      expect(failed.events).toBeUndefined();
    });

    test("reclaims oldest terminal reads but never mutations or active rows", async () => {
      const ledger = backend.open({ capacity: 2 });
      const oldRead = command("old-read");
      await running(ledger, oldRead, "old-r");
      await ledger.transition(oldRead, "old-r", "running", {
        state: "succeeded",
        completedAt,
        outcome: { kind: "fs.read", streamId: "stream", size: 0, binary: false },
      });
      const mutation = command("mutation", { key: "key" });
      await claim(ledger, mutation, "mutation-r");
      await claim(ledger, command("next-read"), "next-r");
      expect(await ledger.get(oldRead, "old-r")).toBeUndefined();
      expect(await ledger.get(mutation, "mutation-r")).toBeDefined();
      await expect(
        claim(ledger, command("last-read"), "last-r"),
      ).rejects.toBeInstanceOf(LedgerFullError);
    });

    test("an evicted command key can be claimed fresh", async () => {
      const ledger = backend.open({ capacity: 2 });
      const settle = async (identity: LedgerCommandIdentity, id: string) => {
        await running(ledger, identity, id);
        await ledger.transition(identity, id, "running", {
          state: "succeeded",
          completedAt,
          outcome: {
            kind: "fs.read",
            streamId: "stream",
            size: 0,
            binary: false,
          },
        });
      };
      const evicted = command("evicted");
      await settle(evicted, "evicted-r");
      await settle(command("filler"), "filler-r");
      // Takes the ledger over capacity, evicting the oldest terminal read.
      await claim(ledger, command("overflow"), "overflow-r");
      expect(await ledger.get(evicted, "evicted-r")).toBeUndefined();
      // Eviction must drop the command's uniqueness entry with its record,
      // otherwise this replay would resolve to a receipt that no longer exists.
      const again = await claim(ledger, evicted, "evicted-r2");
      expect(again.claimed).toBe(true);
      expect(again.record.receipt.receiptId).toBe("evicted-r2");
    });

    test("retires only acknowledged terminal scopes and restores capacity", async () => {
      const ledger = backend.open({ capacity: 2 });
      const retired = command("retired", { key: "retired-key" });
      await running(ledger, retired, "retired-receipt");
      await ledger.transition(retired, "retired-receipt", "running", {
        state: "succeeded",
        completedAt,
        outcome: { kind: "fs.changed", path: "x" },
      });
      const active = command("active", {
        key: "active-key",
        scope: { runId: "active-run" },
      });
      await claim(ledger, active, "active-receipt");
      await expect(ledger.retireScope(active)).rejects.toMatchObject({
        name: "LedgerScopeActiveError",
      });
      await expect(
        claim(
          ledger,
          command("blocked", {
            key: "blocked-key",
            scope: { runId: "blocked-run" },
          }),
          "blocked-receipt",
        ),
      ).rejects.toBeInstanceOf(LedgerFullError);
      expect(await ledger.retireScope(retired)).toBe(1);
      expect(
        (
          await claim(
            ledger,
            command("restored", {
              key: "restored-key",
              scope: { runId: "restored-run" },
            }),
            "restored-receipt",
          )
        ).claimed,
      ).toBe(true);
      expect(await ledger.get(active, "active-receipt")).toBeDefined();
    });

    test("a retired scope refuses replay until it is purged", async () => {
      const ledger = backend.open();
      const identity = command("retire-me", { key: "retire-key" });
      await running(ledger, identity, "retire-receipt");
      await ledger.transition(identity, "retire-receipt", "running", {
        state: "succeeded",
        completedAt,
        outcome: { kind: "fs.changed", path: "x" },
      });
      expect(await ledger.retireScope(identity)).toBe(1);
      await expect(
        claim(ledger, command("replay", { key: "retire-key" }), "replay-r"),
      ).rejects.toMatchObject({ name: "LedgerScopeRetiredError" });
      expect(await ledger.purgeRetiredScope(identity)).toBe(true);
      expect(await ledger.purgeRetiredScope(identity)).toBe(false);
      expect(
        (
          await claim(
            ledger,
            command("after-horizon", { key: "retire-key" }),
            "after-horizon-r",
          )
        ).claimed,
      ).toBe(true);
    });

    test("rejects semantically incompatible outcomes without mutating state", async () => {
      const ledger = backend.open();
      const identity = command("write", { key: "write-key" });
      await running(ledger, identity, "receipt");
      await expect(
        ledger.transition(identity, "receipt", "running", {
          state: "succeeded",
          completedAt,
          outcome: { kind: "fs.changed", path: "wrong-target" },
        }),
      ).rejects.toThrow("incompatible");
      expect((await ledger.get(identity, "receipt"))?.receipt.state).toBe(
        "running",
      );
    });

    test("accepts a contiguous stream batch starting after sequence zero", async () => {
      const ledger = backend.open();
      const operation = {
        kind: "process.status" as const,
        processId: "process",
      };
      const identity: LedgerCommandIdentity = {
        ...baseScope,
        requestId: "process-status",
        operation,
        operationDigest: operationDigest(operation),
      };
      await running(ledger, identity, "process-receipt");
      const result = await ledger.transition(
        identity,
        "process-receipt",
        "running",
        {
          state: "succeeded",
          completedAt,
          outcome: {
            kind: "process",
            processId: "process",
            state: "running",
            streamId: "process-stream",
          },
          events: [
            {
              kind: "text",
              streamId: "process-stream",
              sequence: 5,
              channel: "stdout",
              data: "later batch",
            },
            {
              kind: "text",
              streamId: "process-stream",
              sequence: 6,
              channel: "stdout",
              data: "continued",
            },
          ],
        },
      );
      expect(result.events?.map((event) => event.sequence)).toEqual([5, 6]);
    });
  });
}
