import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import {
  sessionKernelServiceUrl,
  startSessionKernelService,
} from "./actor-service";
import { sessionKernelSessionDbPath } from "./store";

const token = "test-session-kernel-token";
const stateDir = mkdtempSync(join(tmpdir(), "opensession-kernel-service-"));
let service: Awaited<ReturnType<typeof startSessionKernelService>>;
let serviceEpoch: string | undefined;
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const previousDatabasePath = process.env.OPENSESSION_SESSION_KERNEL_DB_PATH;

beforeAll(async () => {
  process.env.OPENSESSION_STATE_DIR = stateDir;
  service = await startSessionKernelService({
    port: 0,
    token,
    databasePath: join(stateDir, "sessions", "session-kernel.sqlite"),
  });
});

afterAll(() => {
  service.stop();
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  if (previousDatabasePath === undefined)
    delete process.env.OPENSESSION_SESSION_KERNEL_DB_PATH;
  else process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = previousDatabasePath;
  rmSync(stateDir, { recursive: true, force: true });
});

async function rpc(request: KernelActorTransportEnvelope["request"]) {
  if (!serviceEpoch && request.t !== "hello")
    await rpc({
      t: "hello",
      rpcId: "test-handshake",
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
  const response = await fetch(`${service.url}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: SESSION_KERNEL_TRANSPORT_VERSION,
      actorVersion: SESSION_KERNEL_ACTOR_VERSION,
      ...(serviceEpoch ? { serviceEpoch } : {}),
      request,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, any>;
  if (body.t === "ready") serviceEpoch = body.serviceEpoch;
  return body;
}

describe("session kernel actor service", () => {
  test("accepts the transport worker's first message immediately", async () => {
    const previousToken = process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
    const previousUrl = process.env.OPENSESSION_SESSION_KERNEL_URL;
    process.env.OPENSESSION_SESSION_KERNEL_TOKEN = token;
    process.env.OPENSESSION_SESSION_KERNEL_URL = service.url;
    const worker = new Worker(
      new URL("../../session-kernel-transport-worker.ts", import.meta.url),
      { type: "module" },
    );
    try {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("transport worker handshake timed out")),
          2_000,
        );
        worker.addEventListener("message", (event: MessageEvent) => {
          clearTimeout(timeout);
          resolve(event.data as Record<string, unknown>);
        });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        });
      });
      worker.postMessage({
        t: "hello",
        rpcId: "immediate-worker-handshake",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
      expect(await response).toMatchObject({
        t: "ready",
        rpcId: "immediate-worker-handshake",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
    } finally {
      worker.terminate();
      if (previousToken === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
      else process.env.OPENSESSION_SESSION_KERNEL_TOKEN = previousToken;
      if (previousUrl === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_URL;
      else process.env.OPENSESSION_SESSION_KERNEL_URL = previousUrl;
    }
  });

  test("reports liveness and readiness without exposing the RPC", async () => {
    const live = await fetch(`${service.url}/live`);
    const ready = await fetch(`${service.url}/ready`);
    expect(live.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ready: true,
      actorVersion: SESSION_KERNEL_ACTOR_VERSION,
      transportVersion: SESSION_KERNEL_TRANSPORT_VERSION,
    });
    const unauthorized = await fetch(`${service.url}/rpc`, {
      method: "POST",
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
  });

  test("refuses to send the actor credential off host", () => {
    const previous = process.env.OPENSESSION_SESSION_KERNEL_URL;
    process.env.OPENSESSION_SESSION_KERNEL_URL = "https://example.com/rpc";
    try {
      expect(() => sessionKernelServiceUrl()).toThrow(
        "must use HTTP on 127.0.0.1",
      );
    } finally {
      if (previous === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_URL;
      else process.env.OPENSESSION_SESSION_KERNEL_URL = previous;
    }
  });

  test("rejects mixed transport versions before actor dispatch", async () => {
    const response = await fetch(`${service.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: SESSION_KERNEL_TRANSPORT_VERSION + 1,
        actorVersion: SESSION_KERNEL_ACTOR_VERSION,
        request: {
          t: "hello",
          rpcId: "wrong-version",
          version: SESSION_KERNEL_ACTOR_VERSION,
        },
      }),
    });
    expect(response.status).toBe(409);
  });

  test("fences actor versions and service incarnations on every call", async () => {
    await rpc({
      t: "hello",
      rpcId: "version-handshake",
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    for (const envelope of [
      {
        version: SESSION_KERNEL_TRANSPORT_VERSION,
        actorVersion: SESSION_KERNEL_ACTOR_VERSION + 1,
        serviceEpoch,
      },
      {
        version: SESSION_KERNEL_TRANSPORT_VERSION,
        actorVersion: SESSION_KERNEL_ACTOR_VERSION,
        serviceEpoch: "stale-service",
      },
    ]) {
      const response = await fetch(`${service.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...envelope,
          request: { t: "stats", rpcId: crypto.randomUUID() },
        }),
      });
      expect(response.status).toBe(409);
    }
  });

  test("rejects a call outside the bounded response budget", async () => {
    const response = await rpc({
      t: "call",
      rpcId: "oversized-output",
      outputBytes: SESSION_KERNEL_MAX_RESPONSE_BYTES + 1,
      request: { t: "store", method: "stats", args: [] },
    });
    expect(response).toMatchObject({
      t: "error",
      error: "Invalid kernel actor response bound",
    });
  });

  test("a locked session database does not block another session mailbox", async () => {
    for (const sessionId of ["locked-pool-session", "healthy-pool-session"]) {
      const created = await rpc({
        t: "call",
        rpcId: `create-${sessionId}`,
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "idle", event: "seed" }],
        },
      });
      expect(created).toMatchObject({ t: "call_result", status: 1 });
    }

    const isolatedRoot = join(
      stateDir,
      "sessions",
      "session-kernel-sessions",
    );
    const lockedPath = sessionKernelSessionDbPath(
      "locked-pool-session",
      isolatedRoot,
    );
    const healthyPath = sessionKernelSessionDbPath(
      "healthy-pool-session",
      isolatedRoot,
    );
    expect(lockedPath).not.toBe(healthyPath);
    expect(existsSync(lockedPath)).toBe(true);
    expect(existsSync(healthyPath)).toBe(true);

    const lock = new Database(lockedPath);
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;");
    try {
      const blocked = rpc({
        t: "call",
        rpcId: "blocked-session-turn",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{
            sessionId: "locked-pool-session",
            state: "running",
            event: "blocked",
            currentRunId: "locked-run",
          }],
        },
      });
      await Bun.sleep(50);

      const startedAt = performance.now();
      const healthy = await rpc({
        t: "call",
        rpcId: "healthy-session-turn",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{
            sessionId: "healthy-pool-session",
            state: "running",
            event: "healthy",
            currentRunId: "healthy-run",
          }],
        },
      });
      expect(healthy).toMatchObject({ t: "call_result", status: 1 });
      expect(performance.now() - startedAt).toBeLessThan(1_000);

      lock.exec("COMMIT;");
      expect(await blocked).toMatchObject({ t: "call_result", status: 1 });
    } finally {
      try {
        lock.exec("ROLLBACK;");
      } catch {}
      lock.close();
    }
  });

  test("keeps reductions responsive while an executor owns physical work", async () => {
    const active = await rpc({
      t: "call",
      rpcId: "begin-long-effect",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "gateway",
          commandId: "long-effect-admission",
          request: {
            op: "request",
            sessionId: "service-session",
            requestId: "long-effect",
            operation: "websocket_command",
            identity: { command: "prompt" },
          },
        },
      },
    });
    expect(JSON.parse(active.body)).toMatchObject({
      ok: true,
      result: { status: "execute" },
    });

    const startedAt = performance.now();
    const reduction = await rpc({
      t: "call",
      rpcId: "run-reduction",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "run_event",
          commandId: "prompt-reduction",
          decision: { sessionId: "service-session", event: "prompt" },
        },
      },
    });
    expect(reduction).toMatchObject({ t: "call_result", status: 1 });
    expect(JSON.parse(reduction.body)).toMatchObject({
      ok: true,
      result: { accepted: true, to: "starting" },
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    await rpc({
      t: "call",
      rpcId: "complete-long-effect",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "gateway",
          commandId: "long-effect-completion",
          request: {
            op: "complete",
            sessionId: "service-session",
            requestId: "long-effect",
            operation: "websocket_command",
            result: "done",
          },
        },
      },
    });
    const command = await rpc({
      t: "call",
      rpcId: "read-command",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "command",
        args: ["service-session", "long-effect"],
      },
    });
    expect(JSON.parse(command.body)).toMatchObject({
      ok: true,
      result: { status: "completed", result: "done" },
    });
  });
});
