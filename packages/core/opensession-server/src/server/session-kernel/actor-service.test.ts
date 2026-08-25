import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import { startSessionKernelService } from "./actor-service";

const token = "test-session-kernel-token";
const stateDir = mkdtempSync(join(tmpdir(), "opensession-kernel-service-"));
let service: Awaited<ReturnType<typeof startSessionKernelService>>;
const previousStateDir = process.env.OPENSESSION_STATE_DIR;

beforeAll(async () => {
  process.env.OPENSESSION_STATE_DIR = stateDir;
  service = await startSessionKernelService({ port: 0, token });
});

afterAll(() => {
  service.stop();
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

async function rpc(request: KernelActorTransportEnvelope["request"]) {
  const response = await fetch(`${service.url}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: SESSION_KERNEL_TRANSPORT_VERSION,
      request,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

describe("session kernel actor service", () => {
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

  test("rejects mixed transport versions before actor dispatch", async () => {
    const response = await fetch(`${service.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: SESSION_KERNEL_TRANSPORT_VERSION + 1,
        request: {
          t: "hello",
          rpcId: "wrong-version",
          version: SESSION_KERNEL_ACTOR_VERSION,
        },
      }),
    });
    expect(response.status).toBe(409);
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
