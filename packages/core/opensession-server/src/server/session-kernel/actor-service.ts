import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_REQUEST_BYTES,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_MAX_TRANSPORT_REQUESTS,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorServiceCall,
  type KernelActorServiceResponse,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import { sessionActorServiceRoute } from "./actor-routing";
import { workerEntry } from "../../runner-host/exe";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3849;
const ACTOR_RESPONSE_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_WORKERS = 4;

class RetryableActorHostError extends Error {
  readonly retryable = true;
}

type Pending = {
  resolve: (response: KernelActorServiceResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  originalRpcId: string;
};

type WorkerSlot = {
  index: number;
  generation: number;
  pending: Map<string, Pending>;
  worker?: Worker;
  ready: boolean;
  restarting: boolean;
};

export type SessionKernelServiceOptions = {
  host?: string;
  port?: number;
  token?: string;
  workerUrl?: string | URL;
  /** Bounded session execution lanes. A separate catalog lane is always kept. */
  workerCount?: number;
  responseTimeoutMs?: number;
  /** Explicit isolated/dev database path inherited by Worker isolates. */
  databasePath?: string;
};

export function sessionKernelServiceUrl(): string {
  const value =
    process.env.OPENSESSION_SESSION_KERNEL_URL ??
    `http://${process.env.OPENSESSION_SESSION_KERNEL_HOST ?? DEFAULT_HOST}:${process.env.OPENSESSION_SESSION_KERNEL_PORT ?? DEFAULT_PORT}`;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== DEFAULT_HOST)
    throw new Error("Session kernel service URL must use HTTP on 127.0.0.1");
  return url.origin;
}

export async function readSessionKernelCredential(): Promise<string> {
  const inline = process.env.OPENSESSION_SESSION_KERNEL_TOKEN?.trim();
  if (inline) return inline;
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  const credentialFile = credentialDirectory
    ? `${credentialDirectory}/session-kernel-token`
    : process.env.OPENSESSION_SESSION_KERNEL_TOKEN_FILE;
  if (credentialFile) {
    const value = (await readFile(credentialFile, "utf8")).trim();
    if (value) return value;
  }
  throw new Error("Session kernel service credential is unavailable");
}

function authorized(actual: string | null, token: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(actual.slice(7));
  const expected = Buffer.from(token);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, {
    ...init,
    headers: { "cache-control": "no-store", ...init.headers },
  });
}

function actorFatal(response: KernelActorServiceResponse): boolean {
  if (response.t !== "call_result" || !response.body) return false;
  try {
    return (JSON.parse(response.body) as { code?: string }).code === "actor_fatal";
  } catch {
    return false;
  }
}

export async function startSessionKernelService(
  options: SessionKernelServiceOptions = {},
): Promise<{ stop(): void; url: string }> {
  const host = options.host ?? process.env.OPENSESSION_SESSION_KERNEL_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.OPENSESSION_SESSION_KERNEL_PORT ?? DEFAULT_PORT);
  if (host !== DEFAULT_HOST)
    throw new Error("Session kernel service must bind to 127.0.0.1");
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("Invalid session kernel service port");
  const token = options.token ?? (await readSessionKernelCredential());
  const configuredWorkers = options.workerCount ?? Number(
    process.env.OPENSESSION_SESSION_KERNEL_WORKERS ?? DEFAULT_SESSION_WORKERS,
  );
  if (!Number.isInteger(configuredWorkers) || configuredWorkers < 1 || configuredWorkers > 32)
    throw new Error("Session kernel worker count must be between 1 and 32");
  const responseTimeoutMs = options.responseTimeoutMs ?? ACTOR_RESPONSE_TIMEOUT_MS;
  if (!Number.isFinite(responseTimeoutMs) || responseTimeoutMs < 100)
    throw new Error("Invalid session kernel worker timeout");

  // Worker isolates in this independently supervised process share one writer
  // incarnation. The service mailbox scheduler, not a thread-local token, is
  // the authority that prevents concurrent turns for one session.
  process.env.OPENSESSION_SESSION_KERNEL_OWNER_ID ??= crypto.randomUUID();
  if (options.databasePath)
    process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = options.databasePath;

  const workerUrl = options.workerUrl ?? workerEntry(
    "session-kernel-worker.js",
    new URL("../../session-kernel-worker.ts", import.meta.url).href,
  );
  // Slot zero is reserved for catalog/global compatibility work. Remaining
  // slots are the bounded session execution pool.
  const slots: WorkerSlot[] = Array.from(
    { length: configuredWorkers + 1 },
    (_, index) => ({
      index,
      generation: 0,
      pending: new Map(),
      ready: false,
      restarting: false,
    }),
  );
  const sessionSlots = slots.slice(1);
  const sessionMailboxes = new Map<string, Promise<void>>();
  let globalGate = Promise.resolve();
  const serviceEpoch = crypto.randomUUID();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let serviceError: Error | undefined;
  let stopping = false;

  function pendingCount(): number {
    return slots.reduce((total, slot) => total + slot.pending.size, 0);
  }

  function stopSlot(slot: WorkerSlot, error: Error): void {
    slot.ready = false;
    const worker = slot.worker;
    slot.worker = undefined;
    worker?.terminate();
    for (const entry of slot.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    slot.pending.clear();
  }

  function failService(error: Error): void {
    if (serviceError) return;
    serviceError = error;
    for (const slot of slots) stopSlot(slot, error);
    server?.stop(true);
  }

  function scheduleRestart(slot: WorkerSlot, error: Error, generation: number): void {
    if (stopping || serviceError || generation !== slot.generation || slot.restarting)
      return;
    slot.restarting = true;
    stopSlot(slot, error);
    setTimeout(() => {
      slot.restarting = false;
      if (stopping || serviceError) return;
      void startSlot(slot).catch((restartError) => {
        scheduleRestart(
          slot,
          restartError instanceof Error ? restartError : new Error(String(restartError)),
          slot.generation,
        );
      });
    }, 25);
  }

  function sendToSlot(
    slot: WorkerSlot,
    request: KernelActorTransportEnvelope["request"],
    allowUnready = false,
  ): Promise<KernelActorServiceResponse> {
    if (serviceError) return Promise.reject(serviceError);
    if ((!slot.ready && !allowUnready) || !slot.worker)
      return Promise.reject(new RetryableActorHostError("Session actor lane is restarting"));
    if (pendingCount() >= SESSION_KERNEL_MAX_TRANSPORT_REQUESTS)
      return Promise.reject(new RetryableActorHostError("Session kernel transport is full"));
    const originalRpcId = request.rpcId;
    const rpcId = crypto.randomUUID();
    const generation = slot.generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(rpcId);
        const error = new RetryableActorHostError(
          `Session actor lane ${slot.index} response timed out`,
        );
        reject(error);
        scheduleRestart(slot, error, generation);
      }, responseTimeoutMs);
      slot.pending.set(rpcId, { resolve, reject, timer, originalRpcId });
      try {
        slot.worker!.postMessage({ ...request, rpcId });
      } catch (error) {
        clearTimeout(timer);
        slot.pending.delete(rpcId);
        const failure = error instanceof Error ? error : new Error(String(error));
        reject(failure);
        scheduleRestart(slot, failure, generation);
      }
    });
  }

  async function startSlot(slot: WorkerSlot): Promise<void> {
    slot.generation += 1;
    const generation = slot.generation;
    const worker = new Worker(workerUrl, { type: "module" });
    slot.worker = worker;
    slot.ready = false;
    worker.addEventListener(
      "message",
      (event: MessageEvent<KernelActorServiceResponse>) => {
        if (slot.worker !== worker || generation !== slot.generation) return;
        const response = event.data;
        const entry = slot.pending.get(response.rpcId);
        if (!entry) return;
        slot.pending.delete(response.rpcId);
        clearTimeout(entry.timer);
        const restored = { ...response, rpcId: entry.originalRpcId };
        entry.resolve(restored);
        if (actorFatal(response))
          failService(new Error("Session kernel catalog authority became ambiguous"));
      },
    );
    worker.addEventListener("error", (event) =>
      scheduleRestart(
        slot,
        new Error(`Session actor lane ${slot.index} failed: ${event.message}`),
        generation,
      ),
    );
    worker.addEventListener("messageerror", () =>
      scheduleRestart(
        slot,
        new Error(`Session actor lane ${slot.index} emitted an invalid message`),
        generation,
      ),
    );
    (
      worker as Worker & {
        addEventListener(type: "close", listener: () => void): void;
      }
    ).addEventListener("close", () =>
      scheduleRestart(
        slot,
        new Error(`Session actor lane ${slot.index} exited`),
        generation,
      ),
    );
    const hello = await sendToSlot(
      slot,
      {
        t: "hello",
        rpcId: crypto.randomUUID(),
        version: SESSION_KERNEL_ACTOR_VERSION,
      },
      true,
    );
    if (hello.t !== "ready" || hello.version !== SESSION_KERNEL_ACTOR_VERSION)
      throw new Error(`Session actor lane ${slot.index} handshake failed`);
    slot.ready = true;
  }

  function assignedSessionSlot(sessionId: string): WorkerSlot {
    // Stable affinity keeps one logical actor's in-memory SQLite/cache state on
    // one lane until that lane restarts. The durable database remains the
    // authority and is rehydrated after restart or LRU passivation.
    let hash = 2_166_136_261;
    for (let index = 0; index < sessionId.length; index += 1) {
      hash ^= sessionId.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    const slot = sessionSlots[(hash >>> 0) % sessionSlots.length]!;
    if (!slot.ready || !slot.worker)
      throw new RetryableActorHostError("Session actor lane is restarting");
    return slot;
  }

  function enqueueSession(
    sessionId: string,
    request: KernelActorTransportEnvelope["request"],
  ): Promise<KernelActorServiceResponse> {
    const prior = sessionMailboxes.get(sessionId) ?? Promise.resolve();
    const gate = globalGate;
    const turn = prior
      .catch(() => {})
      .then(() => gate)
      .then(() => sendToSlot(assignedSessionSlot(sessionId), request));
    const tail = turn.then(() => {}, () => {});
    sessionMailboxes.set(sessionId, tail);
    void tail.then(() => {
      if (sessionMailboxes.get(sessionId) === tail)
        sessionMailboxes.delete(sessionId);
    });
    return turn;
  }

  async function resolveOutboxSession(id: number): Promise<string> {
    const response = await sendToSlot(slots[0], {
      t: "call",
      rpcId: crypto.randomUUID(),
      outputBytes: 256 * 1024,
      request: { t: "store", method: "outboxSessionId", args: [id] },
    });
    if (response.t !== "call_result" || response.status !== 1 || !response.body)
      throw new Error(`Outbox ${id} route could not be resolved`);
    const body = JSON.parse(response.body) as { ok: boolean; result?: unknown; error?: string };
    if (!body.ok || typeof body.result !== "string" || !body.result)
      throw new Error(body.error ?? `Outbox ${id} has no session route`);
    return body.result;
  }

  async function actorRequest(
    request: KernelActorTransportEnvelope["request"],
  ): Promise<KernelActorServiceResponse> {
    const route = sessionActorServiceRoute(request);
    if (route.scope === "session")
      return enqueueSession(route.sessionId, request);
    if (route.scope === "outbox")
      return enqueueSession(await resolveOutboxSession(route.id), request);

    if (request.t === "hello") return sendToSlot(slots[0], request);
    const active = [...sessionMailboxes.values()];
    const operation = globalGate
      .catch(() => {})
      .then(() => Promise.all(active))
      .then(() => sendToSlot(slots[0], request));
    globalGate = operation.then(() => {}, () => {});
    return operation;
  }

  try {
    // Serialize catalog/schema opening. Session turns use the pool only after
    // every lane has acquired the shared actor-host writer incarnation.
    for (const slot of slots) await startSlot(slot);
  } catch (error) {
    stopping = true;
    for (const slot of slots)
      stopSlot(slot, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 15,
    maxRequestBodySize: SESSION_KERNEL_MAX_REQUEST_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      const ready = !serviceError && slots[0].ready && sessionSlots.some((slot) => slot.ready);
      if (request.method === "GET" && url.pathname === "/live")
        return json({ live: !serviceError, version: SESSION_KERNEL_TRANSPORT_VERSION }, { status: serviceError ? 503 : 200 });
      if (request.method === "GET" && url.pathname === "/ready")
        return json(
          {
            ready,
            actorVersion: SESSION_KERNEL_ACTOR_VERSION,
            transportVersion: SESSION_KERNEL_TRANSPORT_VERSION,
            workers: {
              ready: sessionSlots.filter((slot) => slot.ready).length,
              capacity: sessionSlots.length,
            },
          },
          { status: ready ? 200 : 503 },
        );
      if (request.method !== "POST" || url.pathname !== "/rpc")
        return json({ error: "Not found" }, { status: 404 });
      if (!authorized(request.headers.get("authorization"), token))
        return json({ error: "Unauthorized" }, { status: 401 });
      if (!ready)
        return json({ error: serviceError?.message ?? "Actor pool is not ready" }, { status: 503 });
      const declaredLength = Number(request.headers.get("content-length") ?? 0);
      if (declaredLength > SESSION_KERNEL_MAX_REQUEST_BYTES)
        return json({ error: "Request is too large" }, { status: 413 });
      let text: string;
      try {
        text = await request.text();
      } catch {
        return json({ error: "Invalid request body" }, { status: 400 });
      }
      if (Buffer.byteLength(text) > SESSION_KERNEL_MAX_REQUEST_BYTES)
        return json({ error: "Request is too large" }, { status: 413 });
      let envelope: KernelActorTransportEnvelope;
      try {
        envelope = JSON.parse(text) as KernelActorTransportEnvelope;
      } catch {
        return json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (envelope.version !== SESSION_KERNEL_TRANSPORT_VERSION)
        return json(
          { error: "Unsupported session kernel transport version" },
          { status: 409 },
        );
      if (envelope.actorVersion !== SESSION_KERNEL_ACTOR_VERSION)
        return json(
          { error: "Unsupported session kernel actor version" },
          { status: 409 },
        );
      if (envelope.request?.t !== "hello" && envelope.serviceEpoch !== serviceEpoch)
        return json(
          { error: "Session kernel service incarnation changed" },
          { status: 409 },
        );
      if (!envelope.request || typeof envelope.request.rpcId !== "string")
        return json({ error: "Invalid RPC envelope" }, { status: 400 });
      try {
        const response = await actorRequest(envelope.request);
        const fencedResponse = response.t === "ready"
          ? { ...response, serviceEpoch }
          : response;
        const body = JSON.stringify(fencedResponse);
        if (Buffer.byteLength(body) > SESSION_KERNEL_MAX_RESPONSE_BYTES + 1024)
          return json({ error: "Response is too large" }, { status: 507 });
        return new Response(body, {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        });
      } catch (error) {
        const retryable =
          error instanceof RetryableActorHostError ||
          (!!error && typeof error === "object" && "retryable" in error);
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: serviceError ? 503 : retryable ? 429 : 500 },
        );
      }
    },
  });

  const runningServer = server;
  return {
    url: runningServer.url.origin,
    stop() {
      if (stopping) return;
      stopping = true;
      runningServer.stop(true);
      const error = new Error("Session kernel service stopped");
      for (const slot of slots) stopSlot(slot, error);
    },
  };
}
