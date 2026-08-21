import { afterEach, describe, expect, test } from "bun:test";
import { SessionKernelActorClient } from "./actor-client";
import {
  __setSessionKernelStoreForTest,
  installSessionKernelActor,
  sessionKernel,
} from "./kernel";
import { SESSION_KERNEL_MAX_QUEUED_PER_SESSION } from "./actor-protocol";

let client: SessionKernelActorClient | undefined;
afterEach(() => {
  installSessionKernelActor(undefined);
  __setSessionKernelStoreForTest(undefined);
  client?.terminate();
  client = undefined;
});

async function actor(): Promise<SessionKernelActorClient> {
  const worker = new Worker(
    new URL("../../session-kernel-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  client = new SessionKernelActorClient(worker);
  await client.hello();
  return client;
}

describe("session kernel actor boundary", () => {
  test("serializes leases for one session across IPC", async () => {
    const host = await actor();
    const first = await host.begin("s1", { requestId: "first", type: "test" });
    expect(first.leaseId).toBeString();
    let secondGranted = false;
    const secondPromise = host
      .begin("s1", { requestId: "second", type: "test" })
      .then((value) => {
        secondGranted = true;
        return value;
      });
    await Bun.sleep(10);
    expect(secondGranted).toBe(false);
    await host.complete(first.leaseId!, "one", []);
    const second = await secondPromise;
    expect(second.leaseId).toBeString();
    await host.complete(second.leaseId!, "two", []);
    expect(host.store.command("s1", "second")).toMatchObject({
      status: "completed",
      result: "two",
    });
  });

  test("bounds waiting admissions without evicting accepted work", async () => {
    const host = await actor();
    const active = await host.begin("bounded", { requestId: "active", type: "test" });
    const waiting = Array.from({ length: SESSION_KERNEL_MAX_QUEUED_PER_SESSION }, (_, index) =>
      host.begin("bounded", { requestId: `queued-${index}`, type: "test" }).catch((error) => error));
    await Bun.sleep(100);
    await expect(host.begin("bounded", { requestId: "overflow", type: "test" }))
      .rejects.toMatchObject({ retryable: true });
    host.terminate();
    await Promise.allSettled(waiting);
    expect(active.leaseId).toBeString();
  });

  test("fail-stops after a failure receipt cannot be settled", async () => {
    const host = await actor();
    await expect(host.fail("missing-lease", "disk failed", true)).rejects.toThrow();
    await expect(host.begin("s1", { requestId: "after-fatal", type: "test" })).rejects.toThrow();
  });

  test("borrows the actor writer for compatibility work during an async lease", async () => {
    const host = await actor();
    const first = await host.begin("s1", { requestId: "first", type: "test" });
    const borrowed = host.beginSync("s1", {
      requestId: "sync",
      type: "sync:transcript_append",
    });
    expect(borrowed).toEqual({ duplicate: false, borrowed: true });
    host.store.setRunState({
      sessionId: "s1",
      state: "running",
      event: "stream_started",
    });
    expect(host.store.runState("s1").state).toBe("running");
    expect(host.store.command("s1", "sync")).toBeUndefined();
    await host.complete(first.leaseId!, null, []);

    const sync = host.beginSync("s1", { requestId: "after", type: "sync:test" });
    expect(sync.leaseId).toBeString();
    host.completeSync(sync.leaseId!, "done", []);
  });

  test("a tombstone rejects compatibility writes even during an active lease", async () => {
    const host = await actor();
    const active = await host.begin("deleted", { requestId: "active", type: "test" });
    host.store.tombstoneSession("deleted");
    expect(() => host.beginSync("deleted", {
      requestId: "late",
      type: "sync:transcript_append",
    })).toThrow("Session deleted was deleted");
    await host.complete(active.leaseId!, null, []);
  });

  test("persists detached writes while a command owns the mailbox", async () => {
    const host = await actor();
    const active = await host.begin("detached", {
      requestId: "active",
      type: "submit_prompt",
    });
    installSessionKernelActor(host);
    const kernel = sessionKernel("detached");

    kernel.setRunState({ state: "running", event: "stream_started" });
    kernel.enqueueEffect("notify", { ok: true }, "detached-effect");
    expect(kernel.runState().state).toBe("running");
    expect(host.store.pendingOutbox(Date.now(), 10, ["notify"])).toHaveLength(1);

    await host.complete(active.leaseId!, "done", []);
  });

  test("reduces run events atomically while gateway work is still active", async () => {
    const host = await actor();
    const active = await host.begin("autonomous", {
      requestId: "physical-work",
      type: "submit_prompt",
    });
    expect(host.decideRunEvent({ sessionId: "autonomous", event: "prompt" }))
      .toMatchObject({ accepted: true, from: "idle", to: "starting" });
    expect(host.decideRunEvent({
      sessionId: "autonomous",
      event: "run_registered",
      runKey: "run-1",
    })).toMatchObject({
      accepted: true,
      from: "starting",
      to: "running",
      state: { currentRunId: "run-1", generation: 1 },
    });
    expect(host.decideRunEvent({
      sessionId: "autonomous",
      event: "run_registered",
      runKey: "stale-run",
    })).toMatchObject({
      accepted: false,
      reason: "stale_run",
      state: { currentRunId: "run-1", generation: 1 },
    });
    expect(host.store.runState("autonomous")).toMatchObject({
      state: "running",
      currentRunId: "run-1",
      generation: 1,
    });
    await host.complete(active.leaseId!, "done", []);
  });

  test("hydrates persisted run state into the gateway projection", async () => {
    const host = await actor();
    host.callStore("setRunState", [{
      sessionId: "persisted",
      state: "running",
      event: "run_registered",
      generation: 4,
      currentRunId: "run-4",
    }]);
    await host.hello();
    expect(host.store.runState("persisted")).toMatchObject({
      state: "running",
      generation: 4,
      currentRunId: "run-4",
    });
  });

  test("fails new requests immediately after the actor stops", async () => {
    const host = await actor();
    host.terminate();
    client = undefined;
    await expect(
      host.begin("s1", { requestId: "after-stop", type: "test" }),
    ).rejects.toThrow("actor stopped");
  });

  test("returns a terminal failure instead of re-executing it", async () => {
    const host = await actor();
    const first = await host.begin("sticky", {
      requestId: "same",
      type: "test",
    });
    await host.complete(first.leaseId!, { __sessionKernelFailure: true, message: "not allowed" }, []);
    let failure: unknown;
    try {
      await host.begin("sticky", { requestId: "same", type: "test" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("not allowed");
  });

  test("acknowledges replay results through async IPC", async () => {
    const host = await actor();
    const admission = await host.begin("ack", { requestId: "one", type: "take" });
    await host.complete(admission.leaseId!, { item: "kept" }, []);
    await host.acknowledgeCommand("ack", "one");
    expect(host.store.command("ack", "one")?.acknowledgedAt).toBeNumber();
  });

  test("loads registered runtime work through async IPC", async () => {
    const host = await actor();
    host.callStore("scheduleTimer", [{
      sessionId: "known",
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: null,
    }]);
    host.callStore("scheduleTimer", [{
      sessionId: "future",
      timerId: "wake",
      kind: "future_timer",
      dueAt: Date.now() - 1,
      payload: null,
    }]);
    host.callStore("enqueueOutbox", ["known", "known_effect", null, "known"]);
    host.callStore("enqueueOutbox", ["future", "future_effect", null, "future"]);
    const work = await host.runtimeWork(["known_timer"], ["known_effect"]);
    expect(work.timers.map((timer) => timer.kind)).toEqual(["known_timer"]);
    expect(work.outbox.map((item) => item.kind)).toEqual(["known_effect"]);
  });

  test("returns a committed result after an uncertain reply", async () => {
    const host = await actor();
    const first = await host.begin("s1", {
      requestId: "same",
      type: "test",
      payload: { n: 1 },
    });
    await host.complete(first.leaseId!, { accepted: true }, []);
    expect(
      await host.begin("s1", {
        requestId: "same",
        type: "test",
        payload: { n: 1 },
      }),
    ).toMatchObject({ duplicate: true, result: { accepted: true } });
  });
});
