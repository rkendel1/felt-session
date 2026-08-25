import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_REQUEST_BYTES,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_MAX_TRANSPORT_REQUESTS,
  SESSION_KERNEL_TRANSPORT_VERSION,
  isCriticalSettlementCommand,
  type KernelActorServiceCall,
  type KernelActorServiceResponse,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import {
  isPrioritySessionActorRequest,
  sessionActorServiceRoute,
} from "./actor-routing";
import { workerEntry } from "../../runner-host/exe";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3849;
// Must remain below the gateway transport's 8s fail-stop budget, including
// quarantine/restart bookkeeping after an ambiguous lane turn.
const ACTOR_RESPONSE_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_WORKERS = 4;
const MAX_NORMAL_SESSION_TURNS = 8;
const MAX_PRIORITY_SESSION_TURNS = 8;
const MAX_PRIORITY_BURST = 4;
const MAX_GLOBAL_TURNS = 64;
const RESERVED_PRIORITY_TURNS = 64;
const MAX_LANE_QUEUE = 16;
const RESERVED_LANE_PRIORITY_TURNS = 4;

class RetryableActorHostError extends Error {
  readonly retryable = true;
}

type Pending = {
  resolve: (response: KernelActorServiceResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  originalRpcId: string;
  request: KernelActorTransportEnvelope["request"];
  criticalSessionId?: string;
};

type SlotTurn = {
  request: KernelActorTransportEnvelope["request"];
  allowUnready: boolean;
  priority: boolean;
  resolve: (response: KernelActorServiceResponse) => void;
  reject: (error: Error) => void;
};

type WorkerSlot = {
  index: number;
  generation: number;
  pending: Map<string, Pending>;
  queue: SlotTurn[];
  worker?: Worker;
  ready: boolean;
  restarting: boolean;
  priorityBurst: number;
};

type QueuedSessionTurn = {
  request: KernelActorTransportEnvelope["request"];
  barrier: number;
  gate: Promise<void>;
  resolve: (response: KernelActorServiceResponse) => void;
  reject: (error: Error) => void;
  settled: () => void;
};

type SessionMailbox = {
  running: boolean;
  normal: QueuedSessionTurn[];
  priority: QueuedSessionTurn[];
  priorityBurst: number;
  tail: Promise<void>;
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
      queue: [],
      ready: false,
      restarting: false,
      priorityBurst: 0,
    }),
  );
  const sessionSlots = slots.slice(1);
  const sessionMailboxes = new Map<string, SessionMailbox>();
  let queuedSessionTurns = 0;
  let queuedGlobalTurns = 0;
  let admittedTransportRequests = 0;
  let barrierGeneration = 0;
  let globalGate = Promise.resolve();
  const serviceEpoch = crypto.randomUUID();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let serviceError: Error | undefined;
  let stopping = false;

  function pendingCount(): number {
    return slots.reduce(
      (total, slot) => total + slot.pending.size + slot.queue.length,
      0,
    );
  }

  function criticalSessionId(
    request: KernelActorTransportEnvelope["request"],
  ): string | undefined {
    if (
      request.t !== "call" ||
      request.request.t !== "reduce" ||
      !isCriticalSettlementCommand(request.request.command)
    ) return undefined;
    const route = sessionActorServiceRoute(request);
    return route.scope === "session" ? route.sessionId : undefined;
  }

  function stopSlot(slot: WorkerSlot, error: Error, retainQueue = false): Pending[] {
    slot.ready = false;
    const worker = slot.worker;
    slot.worker = undefined;
    worker?.terminate();
    const active = [...slot.pending.values()];
    for (const entry of active) clearTimeout(entry.timer);
    slot.pending.clear();
    if (!retainQueue) {
      for (const entry of active) entry.reject(error);
      for (const turn of slot.queue.splice(0)) turn.reject(error);
    }
    return active;
  }

  function failService(error: Error): void {
    if (serviceError) return;
    serviceError = error;
    for (const slot of slots) stopSlot(slot, error);
    server?.stop(true);
  }

  function sessionQuarantinedResponse(
    entry: Pending,
    sessionId: string,
    reason: string,
  ): KernelActorServiceResponse {
    const body = JSON.stringify({
      ok: false,
      error: reason,
      code: "session_quarantined",
      sessionId,
    });
    return {
      t: "call_result",
      rpcId: entry.originalRpcId,
      status: -1,
      length: Buffer.byteLength(body),
      body,
    };
  }

  async function quarantineAmbiguousSession(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const response = await sendToSlot(slots[0], {
      t: "call",
      rpcId: crypto.randomUUID(),
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "quarantineSession",
        args: [sessionId, reason, "actor_lane_ambiguity"],
      },
    }, false, true);
    if (response.t !== "call_result" || response.status !== 1 || !response.body)
      throw new Error(`Failed to quarantine ambiguous session ${sessionId}`);
    const body = JSON.parse(response.body) as { ok?: boolean };
    if (!body.ok) throw new Error(`Failed to quarantine ambiguous session ${sessionId}`);
  }

  function restartSessionSlot(
    slot: WorkerSlot,
    error: Error,
    generation: number,
  ): void {
    if (stopping || serviceError || generation !== slot.generation || slot.restarting)
      return;
    // The catalog lane owns placement authority. Losing it can make routing
    // settlement ambiguous, so unlike a session lane it must fail-stop the
    // service rather than reconnect behind the gateway's negotiated epoch.
    if (slot.index === 0) {
      failService(error);
      return;
    }
    slot.restarting = true;
    const active = stopSlot(slot, error, true);
    void (async () => {
      const critical = active.filter((entry) => entry.criticalSessionId);
      const ordinary = active.filter((entry) => !entry.criticalSessionId);
      for (const entry of ordinary)
        entry.reject(new RetryableActorHostError(error.message));
      for (const sessionId of new Set(
        critical.map((entry) => entry.criticalSessionId!),
      )) await quarantineAmbiguousSession(sessionId, error.message);
      for (const entry of critical) {
        const sessionId = entry.criticalSessionId!;
        entry.resolve(sessionQuarantinedResponse(entry, sessionId, error.message));
      }
      if (stopping || serviceError) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
      slot.restarting = false;
      await startSlot(slot);
      pumpSlot(slot);
    })().catch((restartError) => {
      failService(
        restartError instanceof Error ? restartError : new Error(String(restartError)),
      );
    });
  }

  function pumpSlot(slot: WorkerSlot): void {
    if (slot.pending.size > 0 || !slot.worker) return;
    let index = -1;
    if (!slot.ready) {
      // A restart handshake is an infrastructure prerequisite, not actor work.
      // It must bypass fairness state retained from the failed generation.
      index = slot.queue.findIndex((turn) => turn.allowUnready);
    } else {
      const priorityIndex = slot.queue.findIndex((turn) => turn.priority);
      const ordinaryIndex = slot.queue.findIndex((turn) => !turn.priority);
      if (
        priorityIndex >= 0 &&
        (ordinaryIndex < 0 || slot.priorityBurst < MAX_PRIORITY_BURST)
      ) {
        index = priorityIndex;
        slot.priorityBurst += 1;
      } else if (ordinaryIndex >= 0) {
        index = ordinaryIndex;
        slot.priorityBurst = 0;
      }
    }
    if (index < 0) return;
    const turn = slot.queue[index]!;
    slot.queue.splice(index, 1);
    const originalRpcId = turn.request.rpcId;
    const rpcId = crypto.randomUUID();
    const generation = slot.generation;
    const timer = setTimeout(() => {
      const error = new Error(`Session actor lane ${slot.index} response timed out`);
      restartSessionSlot(slot, error, generation);
    }, responseTimeoutMs);
    slot.pending.set(rpcId, {
      ...turn,
      timer,
      originalRpcId,
      request: turn.request,
      criticalSessionId: criticalSessionId(turn.request),
    });
    try {
      slot.worker.postMessage({ ...turn.request, rpcId });
    } catch (error) {
      restartSessionSlot(
        slot,
        error instanceof Error ? error : new Error(String(error)),
        generation,
      );
    }
  }

  function sendToSlot(
    slot: WorkerSlot,
    request: KernelActorTransportEnvelope["request"],
    allowUnready = false,
    urgent = false,
  ): Promise<KernelActorServiceResponse> {
    if (serviceError) return Promise.reject(serviceError);
    if (
      ((!slot.ready && !allowUnready) || !slot.worker) &&
      !slot.restarting
    ) return Promise.reject(new RetryableActorHostError("Session actor lane is unavailable"));
    const priority = urgent || isPrioritySessionActorRequest(request);
    const ordinaryQueued = slot.queue.reduce(
      (count, turn) => count + (turn.priority ? 0 : 1),
      0,
    );
    if (
      pendingCount() >= SESSION_KERNEL_MAX_TRANSPORT_REQUESTS ||
      slot.queue.length >= MAX_LANE_QUEUE ||
      (!priority && ordinaryQueued >= MAX_LANE_QUEUE - RESERVED_LANE_PRIORITY_TURNS)
    ) return Promise.reject(new RetryableActorHostError("Session actor lane is full"));
    return new Promise((resolve, reject) => {
      const turn = { request, allowUnready, priority, resolve, reject };
      if (urgent) slot.queue.unshift(turn);
      else slot.queue.push(turn);
      pumpSlot(slot);
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
        else pumpSlot(slot);
      },
    );
    worker.addEventListener("error", (event) =>
      restartSessionSlot(
        slot,
        new Error(`Session actor lane ${slot.index} failed: ${event.message}`),
        generation,
      ),
    );
    worker.addEventListener("messageerror", () =>
      restartSessionSlot(
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
      restartSessionSlot(
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
    return sessionSlots[(hash >>> 0) % sessionSlots.length]!;
  }

  function pumpSessionMailbox(sessionId: string, mailbox: SessionMailbox): void {
    if (mailbox.running) return;
    const priority = mailbox.priority[0];
    const normal = mailbox.normal[0];
    const earliestBarrier = Math.min(
      priority?.barrier ?? Number.POSITIVE_INFINITY,
      normal?.barrier ?? Number.POSITIVE_INFINITY,
    );
    let turn: QueuedSessionTurn | undefined;
    if (
      priority?.barrier === earliestBarrier &&
      (normal?.barrier !== earliestBarrier || mailbox.priorityBurst < MAX_PRIORITY_BURST)
    ) {
      turn = mailbox.priority.shift();
      mailbox.priorityBurst += 1;
    } else if (normal?.barrier === earliestBarrier) {
      turn = mailbox.normal.shift();
      mailbox.priorityBurst = 0;
    }
    if (!turn) {
      if (sessionMailboxes.get(sessionId) === mailbox)
        sessionMailboxes.delete(sessionId);
      return;
    }
    mailbox.running = true;
    void turn.gate
      .then(() => sendToSlot(assignedSessionSlot(sessionId), turn.request))
      .then(turn.resolve, turn.reject)
      .finally(() => {
        queuedSessionTurns -= 1;
        mailbox.running = false;
        turn.settled();
        pumpSessionMailbox(sessionId, mailbox);
      });
  }

  function enqueueSession(
    sessionId: string,
    request: KernelActorTransportEnvelope["request"],
  ): Promise<KernelActorServiceResponse> {
    let mailbox = sessionMailboxes.get(sessionId);
    if (!mailbox) {
      mailbox = {
        running: false,
        normal: [],
        priority: [],
        priorityBurst: 0,
        tail: Promise.resolve(),
      };
      sessionMailboxes.set(sessionId, mailbox);
    }
    const priority = isPrioritySessionActorRequest(request);
    const queuedForClass = priority ? mailbox.priority.length : mailbox.normal.length;
    const classLimit = priority
      ? MAX_PRIORITY_SESSION_TURNS
      : MAX_NORMAL_SESSION_TURNS;
    if (queuedForClass >= classLimit) {
      return Promise.reject(new RetryableActorHostError(
        priority
          ? "Session priority mailbox is full"
          : "Session mailbox is full",
      ));
    }

    queuedSessionTurns += 1;
    let settleTail!: () => void;
    const settled = new Promise<void>((resolve) => { settleTail = resolve; });
    mailbox.tail = mailbox.tail.then(() => settled);
    const response = new Promise<KernelActorServiceResponse>((resolve, reject) => {
      const turn: QueuedSessionTurn = {
        request,
        barrier: barrierGeneration,
        gate: globalGate,
        resolve,
        reject,
        settled: settleTail,
      };
      if (priority) mailbox!.priority.push(turn);
      else mailbox!.normal.push(turn);
    });
    pumpSessionMailbox(sessionId, mailbox);
    return response;
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
    if (queuedGlobalTurns >= MAX_GLOBAL_TURNS)
      throw new RetryableActorHostError("Session kernel catalog mailbox is full");
    queuedGlobalTurns += 1;
    const active = [...sessionMailboxes.values()].map((mailbox) => mailbox.tail);
    const operation = globalGate
      .catch(() => {})
      .then(() => Promise.all(active))
      .then(() => sendToSlot(slots[0], request));
    globalGate = operation.then(() => {}, () => {});
    barrierGeneration += 1;
    void operation.finally(() => { queuedGlobalTurns -= 1; }).catch(() => {});
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
      const priority = envelope.request.t === "hello" ||
        isPrioritySessionActorRequest(envelope.request);
      const admissionLimit = priority
        ? SESSION_KERNEL_MAX_TRANSPORT_REQUESTS
        : SESSION_KERNEL_MAX_TRANSPORT_REQUESTS - RESERVED_PRIORITY_TURNS;
      if (admittedTransportRequests >= admissionLimit)
        return json({ error: "Session kernel transport is full" }, { status: 429 });
      admittedTransportRequests += 1;
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
      } finally {
        admittedTransportRequests -= 1;
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
