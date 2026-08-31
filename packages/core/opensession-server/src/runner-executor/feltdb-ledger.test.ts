/**
 * FeltDB-specific behavior. The shared contract lives in
 * ledger-conformance.test.ts; what is checked here is durability across a
 * reopen, and that a store edited behind the ledger's back is refused rather
 * than served.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import {
  operationDigest,
  type LedgerCommandIdentity,
  type LedgerScope,
} from "./ledger";
import {
  openFeltDbCommandLedger,
  type FeltDbCommandLedger,
} from "./feltdb-ledger";

const roots: string[] = [];
const ledgers: FeltDbCommandLedger[] = [];

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function pathFor(): string {
  const root = mkdtempSync(join(tmpdir(), "feltdb-ledger-"));
  roots.push(root);
  return join(root, "state");
}

function open(path = pathFor(), options: Record<string, number> = {}) {
  const ledger = openFeltDbCommandLedger({ path, ...options });
  ledgers.push(ledger);
  return ledger;
}

async function close(ledger: FeltDbCommandLedger) {
  await ledger.close();
  ledgers.splice(ledgers.indexOf(ledger), 1);
}

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
  options: { key?: string } = {},
): LedgerCommandIdentity {
  const operation = options.key
    ? {
        kind: "fs.write" as const,
        path: "x",
        data: "a",
        encoding: "utf8" as const,
        idempotencyKey: options.key,
      }
    : ({ kind: "fs.read" as const, path: "x" } as const);
  return {
    ...baseScope,
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
  ledger: FeltDbCommandLedger,
  identity: LedgerCommandIdentity,
  id: string,
) {
  return ledger.claim(identity, receipt(identity, id));
}

describe("FeltDbCommandLedger", () => {
  test("requires a durable directory", () => {
    expect(() => openFeltDbCommandLedger({ path: "" })).toThrow("durable");
  });

  test("rejects a non-positive capacity", () => {
    expect(() => open(undefined, { capacity: 0 })).toThrow(
      "ledger capacity must be a positive integer",
    );
  });

  test("persists records across a reopen", async () => {
    const path = pathFor();
    const identity = command("request", { key: "key" });
    const first = open(path);
    await claim(first, identity, "receipt");
    await close(first);

    const reopened = open(path);
    const record = await reopened.get(identity, "receipt");
    expect(record?.operation).toEqual(identity.operation);
    expect(record?.receipt.state).toBe("queued");
  });

  test("persists retired-scope tombstones across a reopen", async () => {
    const path = pathFor();
    const identity = command("retire-me", { key: "retire-key" });
    const first = open(path);
    await claim(first, identity, "retire-receipt");
    await first.transition(identity, "retire-receipt", "queued", {
      state: "failed",
      completedAt,
      error: { code: "cancelled", message: "done" },
    });
    expect(await first.retireScope(identity)).toBe(1);
    await close(first);

    const reopened = open(path);
    await expect(
      claim(reopened, command("replay", { key: "retire-key" }), "replay-r"),
    ).rejects.toMatchObject({ name: "LedgerScopeRetiredError" });
    expect(await reopened.purgeRetiredScope(identity)).toBe(true);
  });

  test("keeps eviction order across a reopen", async () => {
    const path = pathFor();
    const first = open(path, { capacity: 2 });
    const settle = async (
      ledger: FeltDbCommandLedger,
      identity: LedgerCommandIdentity,
      id: string,
    ) => {
      await claim(ledger, identity, id);
      await ledger.transition(identity, id, "queued", {
        state: "failed",
        completedAt,
        error: { code: "cancelled", message: "done" },
      });
    };
    const oldest = command("oldest");
    await settle(first, oldest, "oldest-r");
    await close(first);

    // The ordinal counter is durable, so the record claimed before the reopen
    // is still the oldest and is the one evicted.
    const reopened = open(path, { capacity: 2 });
    await settle(reopened, command("newer"), "newer-r");
    await claim(reopened, command("overflow"), "overflow-r");
    expect(await reopened.get(oldest, "oldest-r")).toBeUndefined();
    expect(await reopened.get(baseScope, "newer-r")).toBeDefined();
  });

  test("leaves nothing behind when a claim is rejected", async () => {
    const path = pathFor();
    const ledger = open(path);
    await claim(ledger, command("first"), "shared-receipt");
    await expect(
      claim(ledger, command("second"), "shared-receipt"),
    ).rejects.toMatchObject({ name: "LedgerConflictError" });
    // The rejected claim must not have consumed the receipt or left a
    // uniqueness entry that would block the command from ever being claimed.
    const retry = await claim(ledger, command("second"), "second-receipt");
    expect(retry.claimed).toBe(true);
    expect((await ledger.get(baseScope, "shared-receipt"))?.requestId).toBe(
      "first",
    );
  });

  test("refuses a persisted row edited behind the ledger", async () => {
    const path = pathFor();
    const identity = command("request");
    const ledger = open(path);
    await claim(ledger, identity, "receipt");
    await close(ledger);

    const raw = createFeltDB({
      namespace: "opensession-runner-ledger",
      path,
    });
    const rows = raw.collection<Record<string, unknown>>(
      "runner_command_ledger",
    );
    const row = await rows.get("receipt");
    await raw.transaction((tx) => {
      tx.collection("runner_command_ledger").set("receipt", {
        ...row,
        state: "running",
      });
    });
    await raw.close();

    const reopened = open(path);
    expect(reopened.get(identity, "receipt")).rejects.toThrow(
      "identity mismatch",
    );
  });

  test("does not let the storage layer phone home", async () => {
    // Constructing a FeltDB database posts an adoption event to feltdb.com.
    // Opening a ledger must leave that off rather than opening an outbound
    // channel from the command ledger.
    delete process.env.FELTDB_TELEMETRY;
    getTelemetryClient().enable();
    open();
    expect(String(process.env.FELTDB_TELEMETRY)).toBe("0");
    expect(getTelemetryClient().isEnabled()).toBe(false);
  });

  test("leaves an explicit operator opt-in alone", async () => {
    const previous = process.env.FELTDB_TELEMETRY;
    process.env.FELTDB_TELEMETRY = "1";
    try {
      open();
      expect(process.env.FELTDB_TELEMETRY).toBe("1");
    } finally {
      if (previous === undefined) delete process.env.FELTDB_TELEMETRY;
      else process.env.FELTDB_TELEMETRY = previous;
    }
  });

  test("refuses use after close", async () => {
    const ledger = open();
    await close(ledger);
    expect(() => ledger.get(baseScope, "receipt")).toThrow("closed");
  });
});
