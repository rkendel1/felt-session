import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_REQUEST_BYTES,
  SESSION_KERNEL_MAX_TRANSPORT_REQUESTS,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorAsyncRequest,
  type KernelActorAsyncResponse,
  type KernelActorServiceCall,
  type KernelActorServiceResponse,
  type KernelActorSyncRequest,
  type KernelActorTransportEnvelope,
} from "./server/session-kernel/actor-protocol";
import {
  readSessionKernelCredential,
  sessionKernelServiceUrl,
} from "./server/session-kernel/actor-service";

const token = await readSessionKernelCredential();
const endpoint = `${sessionKernelServiceUrl().replace(/\/$/, "")}/rpc`;
let inFlight = 0;
let fatal = false;
let serviceEpoch: string | undefined;

function failTransport(message: string): never {
  fatal = true;
  queueMicrotask(() => self.close());
  throw new Error(message);
}

async function rpc(
  request: KernelActorAsyncRequest | KernelActorServiceCall,
): Promise<KernelActorServiceResponse> {
  if (fatal) throw new Error("Session kernel transport is unavailable");
  if (inFlight >= SESSION_KERNEL_MAX_TRANSPORT_REQUESTS)
    throw Object.assign(new Error("Session kernel transport is full"), {
      retryable: true,
    });
  const envelope: KernelActorTransportEnvelope = {
    version: SESSION_KERNEL_TRANSPORT_VERSION,
    actorVersion: SESSION_KERNEL_ACTOR_VERSION,
    ...(serviceEpoch ? { serviceEpoch } : {}),
    request,
  };
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body) > SESSION_KERNEL_MAX_REQUEST_BYTES)
    throw new Error("Session kernel request is too large");
  inFlight += 1;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `Session kernel service returned ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {}
      if (response.status === 429)
        throw Object.assign(new Error(message), { retryable: true });
      failTransport(message);
    }
    const result = JSON.parse(text) as KernelActorServiceResponse;
    if (!result || result.rpcId !== request.rpcId)
      failTransport("Session kernel service returned an invalid response");
    if (request.t === "hello") {
      if (result.t !== "ready" || !result.serviceEpoch)
        failTransport("Session kernel service omitted its incarnation fence");
      serviceEpoch = result.serviceEpoch;
    } else if (!serviceEpoch) {
      failTransport("Session kernel service was used before handshake");
    }
    return result;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { retryable?: boolean }).retryable === true
    )
      throw error;
    if (fatal) throw error;
    failTransport(
      `Session kernel service request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    inFlight -= 1;
  }
}

function settleSync(
  request: KernelActorSyncRequest,
  response?: Extract<KernelActorServiceResponse, { t: "call_result" }>,
  error?: unknown,
): void {
  const control = new Int32Array(request.control);
  const output = new Uint8Array(request.output);
  if (response) {
    Atomics.store(control, 0, response.status);
    Atomics.store(control, 1, response.length);
    if (response.body) output.set(new TextEncoder().encode(response.body));
  } else {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    output.set(bytes.subarray(0, output.length));
    Atomics.store(control, 1, Math.min(bytes.length, output.length));
    Atomics.store(control, 0, -1);
  }
  Atomics.notify(control, 0);
}

self.onmessage = (
  event: MessageEvent<KernelActorAsyncRequest | KernelActorSyncRequest>,
) => {
  const request = event.data;
  if (request.t === "store" || request.t === "reduce") {
    const call: KernelActorServiceCall = {
      t: "call",
      rpcId: crypto.randomUUID(),
      request:
        request.t === "store"
          ? { t: "store", method: request.method, args: request.args }
          : { t: "reduce", command: request.command },
      outputBytes: request.output.byteLength,
    };
    void rpc(call).then(
      (response) => {
        if (response.t !== "call_result") {
          settleSync(request, undefined, new Error("Invalid kernel call response"));
          failTransport("Session kernel service returned the wrong response type");
        }
        settleSync(request, response);
      },
      (error) => settleSync(request, undefined, error),
    );
    return;
  }
  void rpc(request).then(
    (response) => self.postMessage(response),
    (error) => {
      const reply: KernelActorAsyncResponse = {
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
        retryable:
          !!error &&
          typeof error === "object" &&
          (error as { retryable?: boolean }).retryable === true,
      };
      self.postMessage(reply);
    },
  );
};
