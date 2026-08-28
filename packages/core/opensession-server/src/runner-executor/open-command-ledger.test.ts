import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandLedgerBackend,
  openCommandLedger,
  type OpenCommandLedger,
} from "./open-command-ledger";
import { operationDigest, type LedgerCommandIdentity } from "./ledger";

const roots: string[] = [];
const ledgers: OpenCommandLedger[] = [];

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "open-ledger-"));
  roots.push(root);
  return join(root, "private", "ledger.sqlite");
}

function open(options: Parameters<typeof openCommandLedger>[0]) {
  const ledger = openCommandLedger(options);
  ledgers.push(ledger);
  return ledger;
}

const identity: LedgerCommandIdentity = {
  executorId: "executor-1",
  rootId: "root-1",
  sessionId: "session-1",
  runId: "run-1",
  generation: 1,
  requestId: "request-1",
  operation: { kind: "fs.read", path: "x" },
  operationDigest: operationDigest({ kind: "fs.read", path: "x" }),
};
const receipt = {
  receiptId: "receipt-1",
  requestId: "request-1",
  state: "queued" as const,
  acceptedAt: "2026-08-22T12:00:00.000Z",
};

describe("openCommandLedger", () => {
  test("defaults to sqlite so this phase changes no behavior", async () => {
    const path = dbPath();
    const ledger = open({ dbPath: path });
    await ledger.claim(identity, receipt);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.feltdb`)).toBe(false);
  });

  test("opens the feltdb backend beside the sqlite path", async () => {
    const path = dbPath();
    const ledger = open({ backend: "feltdb", dbPath: path });
    await ledger.claim(identity, receipt);
    expect(existsSync(`${path}.feltdb`)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await ledger.get(identity, "receipt-1")).toMatchObject({
      receipt: { state: "queued" },
    });
  });

  test("honors an explicit feltdb directory", async () => {
    const path = dbPath();
    const explicit = join(dbPath(), "..", "elsewhere");
    const ledger = open({
      backend: "feltdb",
      dbPath: path,
      feltdbPath: explicit,
    });
    await ledger.claim(identity, receipt);
    expect(existsSync(explicit)).toBe(true);
    expect(existsSync(`${path}.feltdb`)).toBe(false);
  });

  test("resolves configured backend names and rejects unknown ones", () => {
    expect(commandLedgerBackend(undefined)).toBe("sqlite");
    expect(commandLedgerBackend("")).toBe("sqlite");
    expect(commandLedgerBackend("sqlite")).toBe("sqlite");
    expect(commandLedgerBackend("feltdb")).toBe("feltdb");
    expect(() => commandLedgerBackend("postgres")).toThrow(
      "unknown command ledger backend postgres",
    );
  });
});
