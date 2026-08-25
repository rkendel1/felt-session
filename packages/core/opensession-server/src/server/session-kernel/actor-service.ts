import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_REQUEST_BYTES,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_MAX_TRANSPORT_REQUESTS,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorServiceResponse,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import { workerEntry } from "../../runner-host/exe";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3849;
const ACTOR_RESPONSE_TIMEOUT_MS = 10_000;

type Pending = {
  resolve: (response: KernelActorServiceResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  originalRpcId: string;
};

export type SessionKernelServiceOptions = {
  host?: string;
  port?: number;
  token?: string;
  workerUrl?: string | URL;
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
  const worker = new Worker(
    options.workerUrl ??
      workerEntry(
        "session-kernel-worker.js",
        new URL("../../session-kernel-worker.ts", import.meta.url).href,
      ),
    { type: "module" },
  );
  const pending = new Map<string, Pending>();
  const serviceEpoch = crypto.randomUUID();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let actorReady = false;
  let actorError: Error | undefined;

  function fail(error: Error): void {
    if (actorError) return;
    actorError = error;
    actorReady = false;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    worker.terminate();
    server?.stop(true);
  }

  worker.addEventListener("message", (event: MessageEvent<KernelActorServiceResponse>) => {
    const response = event.data;
    const entry = pending.get(response.rpcId);
    if (!entry) return;
    pending.delete(response.rpcId);
    clearTimeout(entry.timer);
    entry.resolve({ ...response, rpcId: entry.originalRpcId });
  });
  worker.addEventListener("error", (event) =>
    fail(new Error(`Session kernel actor failed: ${event.message}`)),
  );
  worker.addEventListener("messageerror", () =>
    fail(new Error("Session kernel actor emitted an invalid message")),
  );
  (
    worker as Worker & {
      addEventListener(type: "close", listener: () => void): void;
    }
  ).addEventListener("close", () =>
    fail(new Error("Session kernel actor exited")),
  );

  function actorRequest(
    request: KernelActorTransportEnvelope["request"],
  ): Promise<KernelActorServiceResponse> {
    if (actorError) return Promise.reject(actorError);
    if (pending.size >= SESSION_KERNEL_MAX_TRANSPORT_REQUESTS)
      return Promise.reject(new Error("Session kernel transport is full"));
    const originalRpcId = request.rpcId;
    const rpcId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rpcId);
        const error = new Error("Session kernel actor response timed out");
        reject(error);
        fail(error);
      }, ACTOR_RESPONSE_TIMEOUT_MS);
      pending.set(rpcId, { resolve, reject, timer, originalRpcId });
      worker.postMessage({ ...request, rpcId });
    });
  }

  try {
    const hello = await actorRequest({
      t: "hello",
      rpcId: crypto.randomUUID(),
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    if (hello.t !== "ready" || hello.version !== SESSION_KERNEL_ACTOR_VERSION)
      throw new Error("Session kernel actor handshake failed");
    actorReady = true;
  } catch (error) {
    worker.terminate();
    throw error;
  }

  server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 15,
    maxRequestBodySize: SESSION_KERNEL_MAX_REQUEST_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/live")
        return json({ live: !actorError, version: SESSION_KERNEL_TRANSPORT_VERSION }, { status: actorError ? 503 : 200 });
      if (request.method === "GET" && url.pathname === "/ready")
        return json(
          {
            ready: actorReady && !actorError,
            actorVersion: SESSION_KERNEL_ACTOR_VERSION,
            transportVersion: SESSION_KERNEL_TRANSPORT_VERSION,
          },
          { status: actorReady && !actorError ? 200 : 503 },
        );
      if (request.method !== "POST" || url.pathname !== "/rpc")
        return json({ error: "Not found" }, { status: 404 });
      if (!authorized(request.headers.get("authorization"), token))
        return json({ error: "Unauthorized" }, { status: 401 });
      if (!actorReady || actorError)
        return json({ error: actorError?.message ?? "Actor is not ready" }, { status: 503 });
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
      if (
        envelope.request?.t !== "hello" &&
        envelope.serviceEpoch !== serviceEpoch
      )
        return json(
          { error: "Session kernel service incarnation changed" },
          { status: 409 },
        );
      if (!envelope.request || typeof envelope.request.rpcId !== "string")
        return json({ error: "Invalid RPC envelope" }, { status: 400 });
      try {
        const response = await actorRequest(envelope.request);
        const fencedResponse =
          response.t === "ready" ? { ...response, serviceEpoch } : response;
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
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: actorError ? 503 : 429 },
        );
      }
    },
  });

  const runningServer = server;
  return {
    url: runningServer.url.origin,
    stop() {
      actorReady = false;
      runningServer.stop(true);
      worker.terminate();
      fail(new Error("Session kernel service stopped"));
    },
  };
}
