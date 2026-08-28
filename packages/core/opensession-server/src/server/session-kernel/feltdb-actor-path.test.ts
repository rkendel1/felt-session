import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createFeltDB } from "@feltdb/core";
import {
  SessionKernelActorClient,
  SessionKernelConditionalConflictError,
} from "./actor-client";
import { startSessionKernelService } from "./actor-service";

const serverBinary = process.env.FELTDB_SERVER_BIN;
const authorityTest = serverBinary ? describe : describe.skip;
const token = "felt-kernel-actor-test";

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

async function waitUntil(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

authorityTest("Session Kernel actor to FeltDB authority", () => {
  let authority: ChildProcess;
  let authorityDir: string;
  let authorityUrl: string;
  let proxy: ReturnType<typeof Bun.serve>;
  let transactionArrivals = 0;
  let transactionGate: (() => Promise<void>) | undefined;
  const services: Array<{ stop(): void }> = [];
  const clients: SessionKernelActorClient[] = [];
  const stateDirs: string[] = [];
  const previous = new Map<string, string | undefined>();
  const envNames = [
    "OPENSESSION_FELTDB_SERVER_URL",
    "OPENSESSION_FELTDB_SERVER_NAMESPACE",
    "OPENSESSION_FELTDB_SERVER_TOKEN",
    "OPENSESSION_SESSION_KERNEL_URL",
    "OPENSESSION_SESSION_KERNEL_TOKEN",
  ];

  beforeAll(async () => {
    for (const name of envNames) previous.set(name, process.env[name]);
    const port = await availablePort();
    authorityDir = mkdtempSync(join(tmpdir(), "opensession-feltdb-actor-"));
    authorityUrl = `http://127.0.0.1:${port}`;
    authority = spawn(serverBinary!, [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--data", join(authorityDir, "feltdb.log"),
      "--namespace", "opensession-actor-test",
    ], {
      env: { ...process.env, FELTDB_MASTER_KEY: "opensession-actor-test-key" },
      stdio: "ignore",
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (authority.exitCode !== null) throw new Error("FeltDB authority exited during startup");
      try {
        if ((await fetch(`${authorityUrl}/health`)).ok) break;
      } catch { /* authority is starting */ }
      await Bun.sleep(50);
    }

    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const source = new URL(request.url);
        if (source.pathname === "/transactions") {
          transactionArrivals += 1;
          await transactionGate?.();
        }
        const target = new URL(source.pathname + source.search, authorityUrl);
        return fetch(new Request(target, request));
      },
    });
    process.env.OPENSESSION_FELTDB_SERVER_URL = proxy.url.origin;
    process.env.OPENSESSION_FELTDB_SERVER_NAMESPACE = "opensession-actor-test";
    process.env.OPENSESSION_FELTDB_SERVER_TOKEN = "";
  });

  afterAll(async () => {
    for (const client of clients) client.terminate();
    for (const service of services) service.stop();
    proxy?.stop(true);
    if (authority?.exitCode === null) {
      const exited = new Promise<void>((resolve) => authority.once("exit", () => resolve()));
      authority.kill("SIGTERM");
      await exited;
    }
    for (const directory of stateDirs) rmSync(directory, { recursive: true, force: true });
    if (authorityDir) rmSync(authorityDir, { recursive: true, force: true });
    for (const name of envNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function startActor(): Promise<{
    client: SessionKernelActorClient;
    stop(): void;
  }> {
    const stateDir = mkdtempSync(join(tmpdir(), "opensession-actor-service-"));
    stateDirs.push(stateDir);
    const service = await startSessionKernelService({
      port: 0,
      token,
      workerCount: 1,
      responseTimeoutMs: 5_000,
      databasePath: join(stateDir, "kernel.sqlite"),
    });
    services.push(service);
    process.env.OPENSESSION_SESSION_KERNEL_URL = service.url;
    process.env.OPENSESSION_SESSION_KERNEL_TOKEN = token;
    const worker = new Worker(
      new URL("../../session-kernel-transport-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    const client = new SessionKernelActorClient(worker);
    clients.push(client);
    await client.hello();
    return { client, stop: () => { client.terminate(); service.stop(); } };
  }

  test("awaits commits, preserves mailbox order, replays, and hydrates after restart", async () => {
    const first = await startActor();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    transactionArrivals = 0;
    transactionGate = () => held;

    const turnOne = first.client.appendChangeAsync(
      "actor-order-one",
      "ordered-session",
      "first",
    );
    const turnTwo = first.client.appendChangeAsync(
      "actor-order-two",
      "ordered-session",
      "second",
    );
    await waitUntil(() => transactionArrivals === 1, "First transaction did not reach FeltDB");
    await Bun.sleep(100);
    expect(transactionArrivals).toBe(1);
    release();
    expect(await turnOne).toBe(1);
    expect(await turnTwo).toBe(2);
    transactionGate = undefined;

    expect(await first.client.appendChangeAsync(
      "actor-order-one",
      "ordered-session",
      "first",
    )).toBe(1);
    const changes = await first.client.callAsync<any[]>(
      { t: "store", method: "changesSince", args: ["ordered-session", 0] },
      "changesSince ordered-session",
      true,
    );
    expect(changes.map((change) => change.changeSeq)).toEqual([1, 2]);
    const sqlite = new Database(join(stateDirs[0]!, "kernel.sqlite"), { readonly: true });
    try {
      const mirror = sqlite.query(
        "SELECT COUNT(*) AS count FROM session_kernel_changes WHERE session_id = ?",
      ).get("ordered-session") as { count: number };
      expect(mirror.count).toBe(0);
    } finally {
      sqlite.close();
    }
    first.stop();

    const restarted = await startActor();
    expect(await restarted.client.appendChangeAsync(
      "actor-after-restart",
      "ordered-session",
      "third",
    )).toBe(3);
    restarted.stop();

    const db = createFeltDB({
      namespace: "opensession-actor-test",
      server: { url: authorityUrl, token: "" },
    });
    const state = await db.collection<{ changeSeq: number; __version: number }>(
      "opensession_kernel_run_states",
    ).get("ordered-session");
    expect(state).toMatchObject({ changeSeq: 3, __version: 3 });
  }, 30_000);

  test("keeps stale actor conflict typed and commits zero losing writes", async () => {
    const left = await startActor();
    const right = await startActor();
    transactionArrivals = 0;
    let releaseRace!: () => void;
    const raceReleased = new Promise<void>((resolve) => { releaseRace = resolve; });
    transactionGate = async () => {
      if (transactionArrivals === 2) releaseRace();
      await raceReleased;
    };
    const outcomes = await Promise.allSettled([
      left.client.appendChangeAsync("stale-left", "stale-session", "left"),
      right.client.appendChangeAsync("stale-right", "stale-session", "right"),
    ]);
    transactionGate = undefined;
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected && rejected.reason).toBeInstanceOf(
      SessionKernelConditionalConflictError,
    );
    left.stop();
    right.stop();

    const db = createFeltDB({
      namespace: "opensession-actor-test",
      server: { url: authorityUrl, token: "" },
    });
    const changes = await db.collection<{ sessionId: string }>(
      "opensession_kernel_changes",
    ).where((change) => change.sessionId === "stale-session").all();
    expect(changes).toHaveLength(1);
  }, 30_000);
});
