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
import { FeltDbKernelChangeStore } from "./feltdb-change-store";

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

authorityTest("FeltDB Session Kernel change authority", () => {
  let process: ChildProcess;
  let dataDir: string;
  let url: string;
  let db: StateFirstDB;

  const connect = () => createFeltDB({
    namespace: "opensession-kernel-test",
    server: { url, token: "" },
  });

  beforeAll(async () => {
    const port = await availablePort();
    dataDir = mkdtempSync(join(tmpdir(), "opensession-feltdb-kernel-"));
    url = `http://127.0.0.1:${port}`;
    process = spawn(serverBinary!, [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--data", join(dataDir, "feltdb.log"),
      "--namespace", "opensession-kernel-test",
    ], {
      env: { ...globalThis.process.env, FELTDB_MASTER_KEY: "opensession-kernel-test-key" },
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

  test("commits state, change, and durable replay receipt exactly once", async () => {
    const store = new FeltDbKernelChangeStore(db);
    expect(await store.appendChange("tx-first", "session-a", "created", { source: "test" })).toBe(1);
    expect(await store.appendChange("tx-first", "session-a", "created", { source: "test" })).toBe(1);
    expect(await store.runState("session-a")).toMatchObject({ changeSeq: 1, state: "idle" });
    expect(await store.changesSince("session-a", 0)).toHaveLength(1);
    const raw = await db.collection<{ __version: number }>("opensession_kernel_run_states")
      .get("session-a");
    expect(raw?.__version).toBe(1);
  });

  test("allows exactly one stale concurrent decision to commit", async () => {
    const first = new FeltDbKernelChangeStore(db);
    const second = new FeltDbKernelChangeStore(connect());
    const decisions = await Promise.all([
      first.decideAppendChange("tx-race-a", "session-a", "race-a"),
      second.decideAppendChange("tx-race-b", "session-a", "race-b"),
    ]);
    const outcomes = await Promise.allSettled([
      first.commitAppendChange(decisions[0]!),
      second.commitAppendChange(decisions[1]!),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected && rejected.reason).toBeInstanceOf(ConditionalConflictError);
    expect((await first.runState("session-a")).changeSeq).toBe(2);
    expect(await first.changesSince("session-a", 0)).toHaveLength(2);
  });

  test("recovers committed state and replay identity after reconnect", async () => {
    const recovered = new FeltDbKernelChangeStore(connect());
    expect((await recovered.runState("session-a")).changeSeq).toBe(2);
    expect(await recovered.appendChange("tx-first", "session-a", "created")).toBe(1);
    expect(await recovered.changesSince("session-a", 0)).toHaveLength(2);
  });

  test("refuses an embedded authority", () => {
    expect(() => new FeltDbKernelChangeStore(createFeltDB({ namespace: "bad", memory: true })))
      .toThrow("remote server authority");
  });
});
