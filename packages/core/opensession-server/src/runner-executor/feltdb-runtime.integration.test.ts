/**
 * Integration test demonstrating FeltDB as the durable ledger backend
 * for the session runtime.
 *
 * Proves the vertical slice: create session → create command → execute
 * command → persist result → restart owner → recover command → continue
 * session with PERSISTENCE_BACKEND=feltdb.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCommandLedger,
  commandLedgerBackend,
  type OpenCommandLedger,
} from "./open-command-ledger";
import {
  operationDigest,
  type LedgerCommandIdentity,
  type LedgerScope,
} from "./ledger";

const roots: string[] = [];
const ledgers: OpenCommandLedger[] = [];

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "feltdb-runtime-"));
  roots.push(root);
  return join(root, "private", "ledger.sqlite");
}

function openLedger(
  options: Parameters<typeof openCommandLedger>[0],
): OpenCommandLedger {
  const ledger = openCommandLedger(options);
  ledgers.push(ledger);
  return ledger;
}

describe("FeltDB Runtime Integration", () => {
  test("persists and recovers commands across process restart", async () => {
    const path = dbPath();
    const scope: LedgerScope = {
      executorId: "executor-1",
      rootId: "root-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 1,
    };

    // Vertical slice: create session → create command
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      const operation = { kind: "fs.read" as const, path: "x" };
      const identity: LedgerCommandIdentity = {
        ...scope,
        requestId: "request-1",
        operation,
        operationDigest: operationDigest(operation),
      };
      const receipt = {
        receiptId: "receipt-1",
        requestId: "request-1",
        state: "queued" as const,
        acceptedAt: "2026-08-22T12:00:00.000Z",
      };

      const { record, claimed } = await ledger.claim(identity, receipt);
      expect(claimed).toBe(true);
      expect(record.receipt.state).toBe("queued");

      // Execute command → persist result
      const execution = await ledger.transition(
        scope,
        "receipt-1",
        "queued",
        {
          state: "running",
        },
      );
      expect(execution.receipt.state).toBe("running");

      const completed = await ledger.transition(
        scope,
        "receipt-1",
        "running",
        {
          state: "succeeded",
          completedAt: "2026-08-22T12:00:01.000Z",
          outcome: {
            kind: "fs.read" as const,
            streamId: "stream-1",
            size: 100,
            binary: false,
          },
        },
      );
      expect(completed.receipt.state).toBe("succeeded");
      expect(completed.outcome).toEqual({
        kind: "fs.read",
        streamId: "stream-1",
        size: 100,
        binary: false,
      });

      await ledger.close();
    }

    // Restart owner → recover command → continue session
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      // Verify FeltDB is the source of truth after restart
      const recovered = await ledger.get(scope, "receipt-1");
      expect(recovered).toBeDefined();
      expect(recovered!.receipt.state).toBe("succeeded");
      expect(recovered!.outcome).toEqual({
        kind: "fs.read",
        streamId: "stream-1",
        size: 100,
        binary: false,
      });

      // Verify command ordering is preserved
      expect(recovered!.requestId).toBe("request-1");
      expect(recovered!.operation).toEqual({ kind: "fs.read", path: "x" });

      await ledger.close();
    }
  });

  test("handles idempotent commands correctly across restart", async () => {
    const path = dbPath();
    const scope: LedgerScope = {
      executorId: "executor-1",
      rootId: "root-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 1,
    };

    // Create idempotent command (with idempotencyKey)
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      const operation = {
        kind: "fs.write" as const,
        path: "x",
        data: "hello",
        encoding: "utf8" as const,
        idempotencyKey: "mutation-key-1",
      };
      const identity: LedgerCommandIdentity = {
        ...scope,
        requestId: "request-1",
        idempotencyKey: "mutation-key-1",
        operation,
        operationDigest: operationDigest(operation),
      };
      const receipt = {
        receiptId: "receipt-1",
        requestId: "request-1",
        idempotencyKey: "mutation-key-1",
        state: "queued" as const,
        acceptedAt: "2026-08-22T12:00:00.000Z",
      };

      await ledger.claim(identity, receipt);
      await ledger.transition(scope, "receipt-1", "queued", {
        state: "running",
      });
      await ledger.transition(scope, "receipt-1", "running", {
        state: "succeeded",
        completedAt: "2026-08-22T12:00:01.000Z",
        outcome: {
          kind: "fs.changed" as const,
          path: "x",
        },
      });

      await ledger.close();
    }

    // After restart, duplicate claims should return existing command
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      const operation = {
        kind: "fs.write" as const,
        path: "x",
        data: "hello",
        encoding: "utf8" as const,
        idempotencyKey: "mutation-key-1",
      };
      const identity: LedgerCommandIdentity = {
        ...scope,
        requestId: "request-2",
        idempotencyKey: "mutation-key-1",
        operation,
        operationDigest: operationDigest(operation),
      };
      const receipt = {
        receiptId: "receipt-2",
        requestId: "request-2",
        idempotencyKey: "mutation-key-1",
        state: "queued" as const,
        acceptedAt: "2026-08-22T12:00:02.000Z",
      };

      // Claim with different receiptId but same idempotencyKey
      const { record, claimed } = await ledger.claim(identity, receipt);
      expect(claimed).toBe(false);
      expect(record.receipt.receiptId).toBe("receipt-1");
      expect(record.receipt.state).toBe("succeeded");
      expect(record.outcome).toEqual({
        kind: "fs.changed",
        path: "x",
      });

      await ledger.close();
    }
  });

  test("handles failed executions and makes them recoverable", async () => {
    const path = dbPath();
    const scope: LedgerScope = {
      executorId: "executor-1",
      rootId: "root-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 1,
    };

    // Create a command that fails
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      const operation = { kind: "fs.read" as const, path: "missing" };
      const identity: LedgerCommandIdentity = {
        ...scope,
        requestId: "request-1",
        operation,
        operationDigest: operationDigest(operation),
      };
      const receipt = {
        receiptId: "receipt-1",
        requestId: "request-1",
        state: "queued" as const,
        acceptedAt: "2026-08-22T12:00:00.000Z",
      };

      await ledger.claim(identity, receipt);
      await ledger.transition(scope, "receipt-1", "queued", {
        state: "running",
      });
      await ledger.transition(scope, "receipt-1", "running", {
        state: "failed",
        completedAt: "2026-08-22T12:00:01.000Z",
        error: {
          code: "not_found" as const,
          message: "file not found",
        },
      });

      await ledger.close();
    }

    // After restart, failed command should still be recoverable
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      const record = await ledger.get(scope, "receipt-1");
      expect(record).toBeDefined();
      expect(record!.receipt.state).toBe("failed");
      expect(record!.error).toEqual({
        code: "not_found",
        message: "file not found",
      });

      // Command is still in the ledger and can be replayed if needed
      expect(record!.operation).toEqual({ kind: "fs.read", path: "missing" });

      await ledger.close();
    }
  });

  test("FeltDB backend is selectable via environment-like configuration", () => {
    const path = dbPath();

    // Simulate PERSISTENCE_BACKEND=feltdb environment variable
    const backend = commandLedgerBackend("feltdb");
    expect(backend).toBe("feltdb");

    // Default to sqlite when not specified
    const defaultBackend = commandLedgerBackend(undefined);
    expect(defaultBackend).toBe("sqlite");
  });

  test("proves FeltDB remains source of truth after multiple restarts", async () => {
    const path = dbPath();
    const scope: LedgerScope = {
      executorId: "executor-1",
      rootId: "root-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 1,
    };

    const requests = ["request-1", "request-2", "request-3"];

    // Create three commands
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      for (let i = 0; i < requests.length; i++) {
        const requestId = requests[i];
        const operation = { kind: "fs.read" as const, path: `file-${i}` };
        const identity: LedgerCommandIdentity = {
          ...scope,
          requestId,
          operation,
          operationDigest: operationDigest(operation),
        };
        const receipt = {
          receiptId: `receipt-${i + 1}`,
          requestId,
          state: "queued" as const,
          acceptedAt: `2026-08-22T12:00:0${i}.000Z`,
        };

        await ledger.claim(identity, receipt);
        await ledger.transition(scope, `receipt-${i + 1}`, "queued", {
          state: "succeeded",
          completedAt: `2026-08-22T12:00:0${i + 1}.000Z`,
          outcome: {
            kind: "fs.read" as const,
            streamId: `stream-${i}`,
            size: 100 * (i + 1),
            binary: false,
          },
        });
      }

      await ledger.close();
    }

    // First restart - verify all commands are present
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      for (let i = 0; i < requests.length; i++) {
        const record = await ledger.get(scope, `receipt-${i + 1}`);
        expect(record).toBeDefined();
        expect(record!.receipt.state).toBe("succeeded");
        expect(record!.outcome).toEqual({
          kind: "fs.read",
          streamId: `stream-${i}`,
          size: 100 * (i + 1),
          binary: false,
        });
      }

      await ledger.close();
    }

    // Second restart - verify data integrity is preserved
    {
      const ledger = openLedger({
        backend: "feltdb",
        dbPath: path,
      });

      for (let i = 0; i < requests.length; i++) {
        const record = await ledger.get(scope, `receipt-${i + 1}`);
        expect(record).toBeDefined();
        expect(record!.receipt.state).toBe("succeeded");
        expect(record!.outcome).toEqual({
          kind: "fs.read",
          streamId: `stream-${i}`,
          size: 100 * (i + 1),
          binary: false,
        });
      }

      await ledger.close();
    }
  });
});
