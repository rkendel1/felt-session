import { SessionKernelActorClient } from "./actor-client";
import { installSessionKernelActor } from "./kernel";
import { setServiceReadiness } from "../service-readiness";
import { workerEntry } from "../../runner-host/exe";
import { sessionKernelServiceUrl } from "./actor-service";

type ActorRuntimeState = {
  client?: SessionKernelActorClient;
  starting?: Promise<void>;
};
const globalActor = globalThis as typeof globalThis & {
  __opensessionSessionKernelActor?: ActorRuntimeState;
};
const runtime = (globalActor.__opensessionSessionKernelActor ??= {});

/**
 * The gateway keeps its bounded synchronous actor facade in a Worker bridge.
 * That bridge performs bounded authenticated RPC to the independently
 * supervised actor service, then wakes the gateway through SharedArrayBuffer.
 * The service owns the only actor Worker and the only writable SQLite store.
 */
function sessionKernelTransportWorkerUrl(): string | URL {
  return workerEntry(
    "session-kernel-transport-worker.js",
    new URL("../../session-kernel-transport-worker.ts", import.meta.url).href,
  );
}

async function waitForSessionKernelService(): Promise<void> {
  const deadline = Date.now() + 15_000;
  const url = `${sessionKernelServiceUrl().replace(/\/$/, "")}/ready`;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`readiness returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Session kernel service is unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Start the authoritative actor before the gateway hydrates mutable session state. */
export function startSessionKernelActor(): Promise<void> {
  if (runtime.client) return Promise.resolve();
  if (runtime.starting) return runtime.starting;
  runtime.starting = (async () => {
    await waitForSessionKernelService();
    const worker = new Worker(sessionKernelTransportWorkerUrl(), { type: "module" });
    const client = new SessionKernelActorClient(worker, (error) => {
      setServiceReadiness("failed", error);
      console.error("[session-kernel] authoritative actor failed; stopping gateway:", error);
      process.exitCode = 1;
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 0).unref?.();
      setTimeout(() => process.exit(1), 5_000).unref?.();
    });
    try {
      await client.hello();
      runtime.client = client;
      installSessionKernelActor(client);
    } catch (error) {
      client.terminate();
      throw error;
    } finally {
      runtime.starting = undefined;
    }
  })();
  return runtime.starting;
}

export function stopSessionKernelActor(): void {
  const client = runtime.client;
  runtime.client = undefined;
  installSessionKernelActor(undefined);
  client?.terminate();
}
