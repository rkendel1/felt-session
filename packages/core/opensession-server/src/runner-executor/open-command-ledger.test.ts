import { afterEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  openCommandLedger,
  type OpenCommandLedger,
} from "./open-command-ledger";
import { operationDigest, type LedgerCommandIdentity } from "./ledger";

const ledgers: OpenCommandLedger[] = [];

afterEach(async () => {
  for (const ledger of ledgers.splice(0)) await ledger.close();
});

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
  test("uses the injected FeltDB authority", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    const ledger = open({ db });
    await ledger.claim(identity, receipt);
    expect(await ledger.get(identity, "receipt-1")).toMatchObject({
      receipt: { state: "queued" },
    });
  });

  test("requires an authority", () => {
    expect(() => open({ db: undefined as any })).toThrow("managed FeltDB");
  });
});
