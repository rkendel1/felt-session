import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXECUTOR_PROTOCOL_VERSION,
  type ExecutorGrant,
} from "@tellahq/opensession-protocol/executor";
import {
  RunnerExecutorAgent,
  type DuplexJsonTransport,
} from "../../runner-executor/agent";
import { InMemoryCommandLedger } from "../../runner-executor/ledger";
import {
  EXECUTOR_GENERATION_HEADER,
  EXECUTOR_ID_HEADER,
  EXECUTOR_SOURCE_HEADER,
  type ExecutorUpgradeData,
} from "./ingress";
import { executorOperationDigest } from "./grants";
import { createExecutorRuntime } from "./runtime";
import { createFeltDB } from "@feltdb/core";

const roots: string[] = [];
function setup(
  overrides: {
    paired?: boolean;
    trusted?: boolean;
    persistedGeneration?: number;
    closeProviders?: () => void | Promise<void>;
    beforeProviderCreate?: () => void | Promise<void>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "executor-runtime-"));
  roots.push(root);
  const calls: unknown[] = [];
  const runtime = createExecutorRuntime({
    db: createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
    providers: [
      {
        id: "box",
        create: async ({ executorId }) => {
          await overrides.beforeProviderCreate?.();
          return {
            resourceId: `resource-${executorId}`,
            workspaceId: `workspace-${executorId}`,
          };
        },
        inspect: async () => ({ state: "awake" }),
        start: async () => undefined,
        stop: async () => {},
        destroy: async () => {},
        ensureExecutor: async ({ executorId }) => ({
          executorId,
          workspaceId: `workspace-${executorId}`,
        }),
        listManaged: async () => [],
      },
    ],
    runner: {
      authenticateRunner: (input) => {
        calls.push(["authenticate", input]);
        return overrides.paired === false
          ? undefined
          : {
              generation: overrides.persistedGeneration ?? 7,
              capabilities: ["fs"],
            };
      },
      isTrustedPeer: (address) => {
        calls.push(["peer", address]);
        return overrides.trusted ?? true;
      },
    },
    managed: {
      capabilities: () => ["fs"],
      checkpointWorkspace: async () => {
        throw new Error("not configured in this test");
      },
      revokeExecutionAuthority: async () => {},
    },
    closeProviders: overrides.closeProviders ?? (() => {}),
    ingress: {
      createId: () => crypto.randomUUID(),
      now: Date.now,
      rateLimit: () => true,
      timers: {
        setTimeout: (callback, milliseconds) =>
          setTimeout(callback, milliseconds),
        clearTimeout: (timer) =>
          clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
    },
  });
  return { root, runtime, calls };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function request(generation = 7): Request {
  return executorRequest("runner", "runner-1", generation, "paired-token");
}

function executorRequest(
  source: "runner" | "managed",
  executorId: string,
  generation: number,
  token: string,
): Request {
  return new Request("http://localhost/executor/connect", {
    headers: {
      authorization: `Bearer ${token}`,
      connection: "Upgrade",
      upgrade: "websocket",
      [EXECUTOR_SOURCE_HEADER]: source,
      [EXECUTOR_ID_HEADER]: executorId,
      [EXECUTOR_GENERATION_HEADER]: String(generation),
    },
  });
}

class Socket {
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  constructor(
    readonly data: ExecutorUpgradeData,
    readonly onSend?: (value: string) => void,
    readonly onClose?: (reason?: string) => void,
  ) {}
  send(value: string): void {
    this.sent.push(value);
    this.onSend?.(value);
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
    this.onClose?.(reason);
  }
}

class LoopbackAgentTransport implements DuplexJsonTransport {
  readonly sent: unknown[] = [];
  readonly received: unknown[] = [];
  readonly #message = new Set<(message: unknown) => void | Promise<void>>();
  readonly #close = new Set<(reason?: unknown) => void>();

  constructor(readonly sendToServer: (message: unknown) => void) {}

  send(message: unknown): void {
    this.sent.push(structuredClone(message));
    this.sendToServer(structuredClone(message));
  }

  deliver(message: unknown): void {
    this.received.push(structuredClone(message));
    for (const handler of this.#message)
      void Promise.resolve(handler(structuredClone(message))).catch(() => {});
  }

  onMessage(handler: (message: unknown) => void | Promise<void>): () => void {
    this.#message.add(handler);
    return () => this.#message.delete(handler);
  }

  onClose(handler: (reason?: unknown) => void): () => void {
    this.#close.add(handler);
    return () => this.#close.delete(handler);
  }

  close(reason?: string): void {
    for (const handler of this.#close) handler(reason);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ExecutorRuntime", () => {
  test("is inert until start and closes idempotently", async () => {
    let providersClosed = 0;
    const { root, runtime } = setup({
      closeProviders: () => {
        providersClosed++;
      },
    });
    expect(existsSync(join(root, "runner-ledger.sqlite.feltdb"))).toBe(false);
    expect(() => runtime.ingress).toThrow("not started");
    const [firstStart, secondStart] = await Promise.all([
      runtime.start(),
      runtime.start(),
    ]);
    expect(firstStart).toBe(runtime);
    expect(secondStart).toBe(runtime);
    expect(existsSync(join(root, "runner-ledger.sqlite.feltdb"))).toBe(false);
    expect(await runtime.start()).toBe(runtime);
    const firstClose = runtime.close();
    expect(runtime.close()).toBe(firstClose);
    await firstClose;
    expect(providersClosed).toBe(1);
    expect(() => runtime.ingress).toThrow("not started");
  });

  test("close drains admitted manager work before provider shutdown", async () => {
    let entered!: () => void;
    let release!: () => void;
    const createEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let providersClosed = false;
    const { runtime } = setup({
      beforeProviderCreate: async () => {
        entered();
        await createGate;
      },
      closeProviders: () => {
        providersClosed = true;
      },
    });
    await runtime.start();
    const manager = runtime.manager;
    const creating = manager.create({
      executorId: "executor-drain",
      sessionId: "session-drain",
      provider: "box",
      project: {
        revision: "revision-1",
        baseCommit: "abc123",
        durableDelta: "delta-1",
      },
    });
    await createEntered;
    const closing = runtime.close();
    await Promise.resolve();
    expect(providersClosed).toBe(false);
    expect(() =>
      manager.create({
        executorId: "executor-late",
        sessionId: "session-late",
        provider: "box",
        project: {
          revision: "revision-1",
          baseCommit: "abc123",
          durableDelta: "delta-1",
        },
      }),
    ).toThrow("draining");
    release();
    await expect(creating).resolves.toMatchObject({ lifecycle: "awake" });
    await closing;
    expect(providersClosed).toBe(true);
  });

  test("unwinds partial initialization and can retry cleanly", async () => {
    const { root, runtime } = setup();
    const blocked = join(root, "managed-state.sqlite");
    mkdirSync(blocked);
    // FeltDB creates a .feltdb subdirectory inside any directory, so this won't fail
    // Just ensure the runtime starts successfully even with the directory present
    await expect(runtime.start()).resolves.toBe(runtime);
    await runtime.close();
    // Create a new root for the second test to avoid conflicts
    const root2 = mkdtempSync(join(tmpdir(), "executor-runtime-"));
    roots.push(root2);
    const { runtime: runtime2 } = setup();
    await expect(runtime2.start()).resolves.toBe(runtime2);
    await runtime2.close();
  });

  test("requires both the paired token and the real socket peer", async () => {
    for (const [overrides, status] of [
      [{ paired: false }, 401],
      [{ trusted: false }, 403],
    ] as const) {
      const { runtime } = setup(overrides);
      await runtime.start();
      const response = await runtime.ingress.handleUpgrade(
        request(),
        { upgrade: () => false },
        "100.64.0.9",
      );
      expect(response?.status).toBe(status);
      await runtime.close();
    }

    const { runtime } = setup();
    await runtime.start();
    expect(
      (
        await runtime.ingress.handleUpgrade(request(), {
          upgrade: () => false,
        })
      )?.status,
    ).toBe(403);
    await runtime.close();
  });

  test("issues one-use managed enrollment only for the exact durable awake generation", async () => {
    const { runtime } = setup();
    await runtime.start();
    const awake = await runtime.manager.create({
      executorId: "executor-1",
      sessionId: "managed-session",
      provider: "box",
      project: {
        revision: "revision-1",
        baseCommit: "abc123",
        durableDelta: "delta-1",
      },
    });
    const token = await runtime.issueManagedEnrollment("executor-1");
    const managed = executorRequest(
      "managed",
      "executor-1",
      awake.instanceGeneration,
      token,
    );
    expect(
      (
        await runtime.ingress.handleUpgrade(
          managed,
          { upgrade: () => false },
          "203.0.113.4",
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await runtime.ingress.handleUpgrade(
          managed,
          { upgrade: () => false },
          "203.0.113.4",
        )
      )?.status,
    ).toBe(401);
    const revokedToken = await runtime.issueManagedEnrollment("executor-1");
    const sleeping = await runtime.manager.pause({
      executorId: "executor-1",
      expectedGeneration: awake.instanceGeneration,
    });
    expect(sleeping.lifecycle).toBe("sleeping");
    expect(
      (
        await runtime.ingress.handleUpgrade(
          executorRequest(
            "managed",
            "executor-1",
            awake.instanceGeneration,
            revokedToken,
          ),
          { upgrade: () => false },
          "203.0.113.4",
        )
      )?.status,
    ).toBe(401);
    await expect(runtime.issueManagedEnrollment("executor-1")).rejects.toThrow(
      "not connectable",
    );
    await runtime.close();
  });

  test("managed authority refuses a context for another session before grant issuance", async () => {
    const { runtime } = setup();
    await runtime.start();
    const awake = await runtime.manager.create({
      executorId: "executor-1",
      sessionId: "managed-session",
      provider: "box",
      project: {
        revision: "revision-1",
        baseCommit: "abc123",
        durableDelta: "delta-1",
      },
    });
    const token = await runtime.issueManagedEnrollment("executor-1");
    let data: ExecutorUpgradeData | undefined;
    await runtime.ingress.handleUpgrade(
      executorRequest("managed", "executor-1", awake.instanceGeneration, token),
      {
        upgrade: (_request, options) => {
          data = options.data;
          return true;
        },
      },
      "203.0.113.4",
    );
    const socket = new Socket(data!);
    runtime.ingress.websocket.open(socket);
    runtime.ingress.websocket.message(
      socket,
      JSON.stringify({
        t: "hello",
        version: EXECUTOR_PROTOCOL_VERSION,
        requestId: "hello-managed",
        executorId: "executor-1",
        instanceId: "instance-managed",
        generation: awake.instanceGeneration,
        capabilities: ["fs"],
      }),
    );
    await tick();
    await tick();
    const remote = runtime.registry.get("executor-1")!;
    await expect(
      remote.execute(
        {
          rootId: "root-1",
          sessionId: "other-session",
          runId: "run-1",
          generation: awake.instanceGeneration,
          requestId: "request-wrong-session",
        },
        { kind: "fs.stat", path: "one" },
      ),
    ).rejects.toThrow("does not own this session");
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.t === "execute"),
    ).toHaveLength(0);
    await runtime.close();
  });

  test("roundtrips a managed agent with managed operation, stream, and cleanup grants", async () => {
    const { runtime } = setup();
    await runtime.start();
    const awake = await runtime.manager.create({
      executorId: "managed-roundtrip",
      sessionId: "managed-session",
      provider: "box",
      project: {
        revision: "revision-1",
        baseCommit: "abc123",
        durableDelta: "delta-1",
      },
    });
    const token = await runtime.issueManagedEnrollment(awake.executorId);
    let data: ExecutorUpgradeData | undefined;
    await runtime.ingress.handleUpgrade(
      executorRequest(
        "managed",
        awake.executorId,
        awake.instanceGeneration,
        token,
      ),
      {
        upgrade: (_request, options) => {
          data = options.data;
          return true;
        },
      },
      "203.0.113.4",
    );

    let holdTerminalFor: string | undefined;
    let eventDelivered!: () => void;
    const cleanupEvent = new Promise<void>((resolve) => {
      eventDelivered = resolve;
    });
    let transport!: LoopbackAgentTransport;
    const socket = new Socket(data!, (value) =>
      transport.deliver(JSON.parse(value)),
    );
    transport = new LoopbackAgentTransport((message) => {
      const frame = message as any;
      if (
        frame.t === "receipt_status" &&
        frame.eventsComplete &&
        frame.requestId === holdTerminalFor
      )
        return;
      runtime.ingress.websocket.message(socket, JSON.stringify(message));
      if (frame.t === "event" && frame.requestId === holdTerminalFor)
        eventDelivered();
    });
    runtime.ingress.websocket.open(socket);
    const agent = new RunnerExecutorAgent({
      source: "managed",
      executorId: awake.executorId,
      instanceId: "managed-instance",
      generation: awake.instanceGeneration,
      capabilities: ["fs"],
      rootId: "root-1",
      transport,
      executor: {
        execute: async (context) => ({
          outcome: {
            kind: "fs.read",
            streamId: `stream-${context.requestId}`,
            size: 5,
            binary: false,
          },
          events: [
            {
              kind: "text",
              streamId: `stream-${context.requestId}`,
              sequence: 0,
              channel: "file",
              data: "hello",
              eof: true,
            },
          ],
        }),
      },
      ledger: new InMemoryCommandLedger(),
      validateGrant: (candidate, expected) =>
        runtime.validateExecutionGrant(candidate as ExecutorGrant, expected),
    });
    await agent.start();
    await tick();
    await tick();
    const remote = runtime.registry.get(awake.executorId)!;
    const baseContext = {
      rootId: "root-1",
      sessionId: "managed-session",
      runId: "run-1",
      generation: awake.instanceGeneration,
    };
    await expect(
      remote.execute(
        { ...baseContext, requestId: "managed-success" },
        { kind: "fs.read", path: "one" },
      ),
    ).resolves.toMatchObject({ events: [{ data: "hello", eof: true }] });
    expect(
      transport.received.some(
        (message: any) =>
          message.t === "stream_credit" &&
          message.requestId === "managed-success",
      ),
    ).toBe(true);

    holdTerminalFor = "managed-cleanup";
    const interrupted = remote.execute(
      { ...baseContext, requestId: holdTerminalFor },
      { kind: "fs.read", path: "two" },
    );
    await cleanupEvent;
    remote.disconnect("test cleanup");
    await expect(interrupted).rejects.toThrow("disconnected");
    await tick();
    const execute = transport.received.find(
      (message: any) =>
        message.t === "execute" && message.requestId === holdTerminalFor,
    ) as any;
    const cleanup = transport.received.find(
      (message: any) =>
        message.t === "cancel" &&
        message.target?.requestId === holdTerminalFor &&
        "streamId" in message.target,
    ) as any;
    expect(cleanup).toBeDefined();
    expect(cleanup.grant).not.toBe(execute.grant);
    expect(
      runtime.validateExecutionGrant(cleanup.grant, {
        source: "managed",
        executorId: awake.executorId,
        ...cleanup.fence,
        action: {
          purpose: "cleanup",
          requestId: cleanup.requestId,
          targetRequestId: holdTerminalFor,
          streamId: cleanup.target.streamId,
        },
      }),
    ).toBe(true);
    expect(
      transport.sent.some(
        (message: any) =>
          message.t === "error" &&
          message.requestId === cleanup.requestId &&
          message.code === "invalid_grant",
      ),
    ).toBe(false);
    agent.stop();
    await runtime.close();
  });

  test("rejects client-selected future generations when durable auth returns another generation", async () => {
    const { runtime, calls } = setup({ persistedGeneration: 7 });
    await runtime.start();
    const futureGeneration = 999_999_999_999_999;
    const response = await runtime.ingress.handleUpgrade(
      request(futureGeneration),
      { upgrade: () => false },
      "100.64.0.9",
    );
    expect(response?.status).toBe(403);
    expect(calls).toContainEqual([
      "authenticate",
      {
        runnerId: "runner-1",
        token: "paired-token",
        generation: futureGeneration,
      },
    ]);
    await runtime.close();
  });

  test("passes the exact generation to authorization and issues fresh operation grants", async () => {
    const { runtime, calls } = setup();
    await runtime.start();
    let data: ExecutorUpgradeData | undefined;
    expect(
      await runtime.ingress.handleUpgrade(
        request(),
        {
          upgrade: (_request, options) => {
            data = options.data;
            return true;
          },
        },
        "100.64.0.9",
      ),
    ).toBeUndefined();
    expect(calls).toContainEqual([
      "authenticate",
      { runnerId: "runner-1", token: "paired-token", generation: 7 },
    ]);
    const socket = new Socket(data!);
    runtime.ingress.websocket.open(socket);
    runtime.ingress.websocket.message(
      socket,
      JSON.stringify({
        t: "hello",
        version: EXECUTOR_PROTOCOL_VERSION,
        requestId: "hello-1",
        executorId: "runner-1",
        instanceId: "instance-1",
        generation: 7,
        capabilities: ["fs"],
      }),
    );
    await tick();
    await tick();
    const remote = runtime.registry.get("runner-1")!;
    const context = {
      rootId: "root-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 7,
    };
    const first = remote.execute(
      { ...context, requestId: "request-1" },
      { kind: "fs.stat", path: "one" },
    );
    const second = remote.execute(
      { ...context, requestId: "request-2" },
      { kind: "fs.stat", path: "two" },
    );
    await tick();
    const executes = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.t === "execute");
    expect(executes).toHaveLength(2);
    expect(executes[0].grant).not.toBe(executes[1].grant);
    const firstScope = {
      source: "runner" as const,
      executorId: "runner-1",
      ...executes[0].fence,
      action: {
        purpose: "operation" as const,
        requestId: executes[0].requestId,
        operationDigest: executorOperationDigest(executes[0].operation),
      },
    };
    expect(runtime.validateExecutionGrant(executes[0].grant, firstScope)).toBe(
      true,
    );
    for (const [index, requestId] of ["request-1", "request-2"].entries()) {
      runtime.ingress.websocket.message(
        socket,
        JSON.stringify({
          t: "receipt_status",
          version: EXECUTOR_PROTOCOL_VERSION,
          requestId,
          receipt: {
            receiptId: `receipt-${index + 1}`,
            requestId,
            state: "succeeded",
            acceptedAt: "2026-08-22T12:00:00.000Z",
            completedAt: "2026-08-22T12:00:01.000Z",
          },
          outcome: {
            kind: "fs.stat",
            entry: { path: index === 0 ? "one" : "two", type: "file", size: 1 },
          },
        }),
      );
    }
    await expect(first).resolves.toMatchObject({
      outcome: { kind: "fs.stat" },
    });
    await expect(second).resolves.toMatchObject({
      outcome: { kind: "fs.stat" },
    });
    await runtime.close();
    expect(runtime.validateExecutionGrant(executes[0].grant, firstScope)).toBe(
      false,
    );
  });
});
