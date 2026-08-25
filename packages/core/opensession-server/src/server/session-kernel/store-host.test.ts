import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStoreHost } from "./store-host";
import { SessionKernelStore, sessionKernelSessionDbPath } from "./store";

const roots: string[] = [];
function paths() {
  const root = mkdtempSync(join(tmpdir(), "session-kernel-host-"));
  roots.push(root);
  return {
    root,
    central: join(root, "session-kernel.sqlite"),
    isolated: join(root, "sessions"),
  };
}

function failWithSqliteIo(store: SessionKernelStore, method: string): void {
  Object.defineProperty(store, method, {
    configurable: true,
    value: () => {
      const error = new Error("disk I/O error");
      Object.assign(error, { code: "SQLITE_IOERR" });
      throw error;
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("per-session session kernel storage", () => {
  test("claims a new session before writing only its isolated database", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const state = host.call("setRunState", [{
      sessionId: "new-session",
      state: "running",
      event: "prompt",
      currentRunId: "run-one",
    }]);

    expect(state).toMatchObject({ state: "running", currentRunId: "run-one" });
    expect(host.central.hasSessionDurableState("new-session")).toBe(false);
    expect(host.central.sessionPlacement("new-session")).toMatchObject({
      placement: "isolated",
      needsScan: true,
    });
    expect(host.storeForSession("new-session").runState("new-session")).toMatchObject({
      state: "running",
      currentRunId: "run-one",
    });
    host.close();

    const isolated = new SessionKernelStore(
      sessionKernelSessionDbPath("new-session", path.isolated),
    );
    expect(isolated.runState("new-session").state).toBe("running");
    isolated.close();
  });

  test("keeps a legacy session on the central database without dual writing", () => {
    const path = paths();
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({
      sessionId: "legacy-session",
      state: "idle",
      event: "seed",
    });
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "legacy-session",
      state: "running",
      event: "prompt",
      currentRunId: "legacy-run",
    }]);

    expect(host.central.sessionPlacement("legacy-session")).toBeUndefined();
    expect(host.central.runState("legacy-session")).toMatchObject({
      state: "running",
      currentRunId: "legacy-run",
    });
    host.close();
  });

  test("cuts a legacy session over without dual authority", () => {
    const path = paths();
    const sessionId = "legacy-cutover";
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({
      sessionId,
      state: "running",
      event: "prompt",
      currentRunId: "legacy-run",
    });
    seed.setDeliverySlot(sessionId, "queued", [{ id: "queued", content: "later" }]);
    seed.scheduleTimer({
      sessionId,
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: { stable: true },
    });
    const outboxId = seed.enqueueOutbox(
      sessionId,
      "known_effect",
      { stable: true },
      "legacy-effect",
    );
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.migrateLegacySessions(1)).toBe(1);
    expect(host.central.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      needsScan: true,
    });
    expect(host.central.hasSessionDurableState(sessionId)).toBe(false);
    expect(host.central.isolatedOutboxSessionId(outboxId)).toBe(sessionId);
    expect(host.storeForSession(sessionId).runState(sessionId)).toMatchObject({
      state: "running",
      currentRunId: "legacy-run",
    });
    expect(host.storeForSession(sessionId).deliverySnapshot(sessionId).queued)
      .toEqual([{ id: "queued", content: "later" }]);
    expect(host.storeForSession(sessionId).timer(sessionId, "wake")).toBeTruthy();
    expect(host.storeForOutbox(outboxId).outboxSessionId(outboxId)).toBe(sessionId);
    expect(host.call("ackOutbox", [outboxId])).toBeUndefined();
    expect(host.central.isolatedOutboxSessionId(outboxId)).toBeUndefined();
    host.close();

    const reopened = new SessionKernelStoreHost(path.central, path.isolated);
    expect(reopened.storeForSession(sessionId).runState(sessionId).state).toBe("running");
    expect(reopened.central.hasSessionDurableState(sessionId)).toBe(false);
    reopened.close();
  });

  test("quarantines one unreadable session database without blocking global stats", () => {
    const path = paths();
    const first = new SessionKernelStoreHost(path.central, path.isolated);
    first.call("setRunState", [{
      sessionId: "broken-session",
      state: "running",
      event: "prompt",
    }]);
    first.call("setRunState", [{
      sessionId: "healthy-session",
      state: "running",
      event: "prompt",
    }]);
    first.close();
    writeFileSync(
      sessionKernelSessionDbPath("broken-session", path.isolated),
      "not a sqlite database",
    );

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    expect(recovered.stats()).toMatchObject({
      sessions: 1,
      quarantinedSessions: 1,
    });
    expect(recovered.quarantinedSession("broken-session")).toMatchObject({
      commandKind: "global:stats",
    });
    expect(recovered.storeForSession("healthy-session").runState("healthy-session").state)
      .toBe("running");
    recovered.close();
  });

  test("releases the catalog quarantine while an isolated store still fails", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "repair-session",
      state: "running",
      event: "prompt",
    }]);
    failWithSqliteIo(host.storeForSession("repair-session"), "releaseQuarantine");
    host.central.quarantineSession(
      "repair-session",
      "disk I/O error",
      "runtime:scan",
    );

    expect(host.call("releaseQuarantine", ["repair-session"])).toBe(true);
    expect(host.central.quarantinedSession("repair-session")).toBeUndefined();
    expect(host.storeForSession("repair-session").runState("repair-session").state)
      .toBe("running");
    host.close();
  });

  test("contains failures from already-open isolated databases per session", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (const sessionId of [
      "runtime-broken",
      "stats-broken",
      "maintenance-broken",
      "fanout-broken",
      "healthy-session",
    ]) {
      host.call("setRunState", [{ sessionId, state: "running", event: "prompt" }]);
    }

    failWithSqliteIo(host.storeForSession("runtime-broken"), "dueTimers");
    failWithSqliteIo(host.storeForSession("stats-broken"), "stats");
    failWithSqliteIo(host.storeForSession("maintenance-broken"), "maintain");
    failWithSqliteIo(host.storeForSession("fanout-broken"), "runStates");

    expect(() => host.runtimeWork(Date.now(), [], [], 100)).not.toThrow();
    expect(host.quarantinedSession("runtime-broken")).toMatchObject({
      commandKind: "runtime:scan",
    });
    expect(host.stats()).toMatchObject({ sessions: 3, quarantinedSessions: 2 });
    expect(host.quarantinedSession("stats-broken")).toMatchObject({
      commandKind: "global:stats",
    });
    expect(() => host.maintain()).not.toThrow();
    expect(host.quarantinedSession("maintenance-broken")).toMatchObject({
      commandKind: "maintenance:store",
    });
    expect(host.allRunStates()).toEqual([
      expect.objectContaining({ sessionId: "healthy-session", state: "running" }),
    ]);
    expect(host.quarantinedSession("fanout-broken")).toMatchObject({
      commandKind: "global:run-states",
    });
    expect(host.storeForSession("healthy-session").runState("healthy-session").state)
      .toBe("running");

    // A failure in the central identity allocator is not misattributed to the
    // isolated session. It must escape so the actor can fail-stop globally.
    failWithSqliteIo(host.central, "allocateIsolatedOutboxId");
    expect(() => host.call("enqueueOutbox", [
      "healthy-session",
      "known_effect",
      null,
      "central-failure",
    ])).toThrow("disk I/O error");
    expect(host.quarantinedSession("healthy-session")).toBeUndefined();
    host.close();
  });

  test("lazily reactivates a passivated session store", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated, 1);
    host.call("setRunState", [{
      sessionId: "first-session",
      state: "running",
      event: "first",
      currentRunId: "first-run",
    }]);
    const firstActivation = host.storeForSession("first-session");

    host.call("setRunState", [{
      sessionId: "second-session",
      state: "running",
      event: "second",
      currentRunId: "second-run",
    }]);
    expect(() => firstActivation.command("first-session", "missing")).toThrow();

    expect(host.storeForSession("first-session").runState("first-session"))
      .toMatchObject({ state: "running", currentRunId: "first-run" });
    expect(host.stats()).toMatchObject({ sessions: 2, quarantinedSessions: 0 });
    host.close();
  });

  test("pages wake candidates in the catalog instead of rotating a fixed prefix", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (let index = 0; index < 250; index += 1) {
      const sessionId = `due-${String(index).padStart(3, "0")}`;
      host.central.claimIsolatedSession(sessionId);
      host.central.settleIsolatedSessionWake(sessionId, 0, undefined);
    }
    const first = host.central.isolatedWakeCandidates(Date.now(), 100);
    const second = host.central.isolatedWakeCandidates(
      Date.now(),
      100,
      first.at(-1),
    );
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(new Set([...first, ...second]).size).toBe(200);
    expect(second[0]).toBe("due-100");
    host.close();
  });

  test("fails closed on conflicting central and isolated outbox routes", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const id = host.call("enqueueOutbox", [
      "isolated-route-session",
      "known_effect",
      null,
      "isolated-effect",
    ]) as number;
    const central = new Database(path.central);
    central.run(`
      INSERT INTO session_kernel_outbox
        (id, effect_id, effect_key, session_id, kind, payload, attempts,
         next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'null', 0, 0, ?)
    `, [
      id,
      "central-conflict:known_effect:central-effect",
      "central-effect",
      "central-conflict",
      "known_effect",
      Date.now(),
    ]);
    central.close();

    expect(() => host.outboxSessionId(id)).toThrow(
      "conflicting central and isolated route evidence",
    );
    expect(() => host.storeForOutbox(id)).toThrow(
      "conflicting central and isolated route evidence",
    );
    host.close();
  });

  test("caches sparse global projections and invalidates them after mutations", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setAskRecord", ["cache-session", {
      questionId: "ask-one",
      questions: [{ question: "First?" }],
    }]);
    host.call("setDeliverySlot", [
      "cache-session",
      "queued",
      [{ id: "queue-one", content: "First" }],
    ]);

    const asks = host.allAskEntries();
    const deliveries = host.allDeliveryEntries("queued");
    (asks[0]![1] as { questionId: string }).questionId = "caller-mutated";
    (deliveries[0]![1] as Array<{ content: string }>)[0]!.content = "caller-mutated";
    expect(host.allAskEntries()[0]![1]).toMatchObject({ questionId: "ask-one" });
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-one", content: "First" },
    ]);

    host.call("deleteAskRecord", ["cache-session"]);
    host.call("setDeliverySlot", [
      "cache-session",
      "queued",
      [{ id: "queue-two", content: "Second" }],
    ]);
    expect(host.allAskEntries()).toEqual([]);
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-two", content: "Second" },
    ]);
    host.close();
  });

  test("settles only isolated stores that contain pending steers", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "empty-session",
      state: "idle",
      event: "seed",
    }]);
    host.call("prepareSteerDelivery", [
      "pending-session",
      "steer-one",
      { id: "steer-one", content: "recover me" },
    ]);
    Object.defineProperty(host.storeForSession("empty-session"), "settlePendingSteers", {
      configurable: true,
      value: () => {
        throw new Error("empty stores must not enter the mutation sweep");
      },
    });

    expect(host.call("settlePendingSteers", [])).toBe(1);
    expect(host.storeForSession("pending-session").deliverySnapshot("pending-session"))
      .toMatchObject({
        pendingSteers: [],
        steered: [{ id: "steer-one", content: "recover me" }],
      });
    host.close();
  });

  test("skips empty stores when retrying compatible creation dead letters", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "empty-creation-session",
      state: "idle",
      event: "seed",
    }]);
    Object.defineProperty(
      host.storeForSession("empty-creation-session"),
      "retryCompatibleCreationBranchDeadLetters",
      {
        configurable: true,
        value: () => {
          throw new Error("empty stores must not enter the mutation sweep");
        },
      },
    );

    expect(host.call("retryCompatibleCreationBranchDeadLetters", [[], Date.now()]))
      .toEqual([]);
    host.close();
  });

  test("recovers isolated wake work from the durable dirty placement", () => {
    const path = paths();
    const first = new SessionKernelStoreHost(path.central, path.isolated);
    first.call("scheduleTimer", [{
      sessionId: "wake-session",
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: { stable: true },
    }]);
    const outboxId = first.call("enqueueOutbox", [
      "wake-session",
      "known_effect",
      { stable: true },
      "effect-one",
    ]) as number;
    expect(outboxId).toBeGreaterThanOrEqual(4_000_000_000_000_000);
    expect(first.call("enqueueOutbox", [
      "wake-session",
      "known_effect",
      { stable: true },
      "effect-one",
    ])).toBe(outboxId);
    expect(first.central.isolatedOutboxRoutes()).toEqual([
      { id: outboxId, sessionId: "wake-session" },
    ]);
    expect(first.central.isolatedOutboxSessionId(outboxId)).toBe("wake-session");
    first.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    const work = recovered.runtimeWork(
      Date.now(),
      ["known_timer"],
      ["known_effect"],
      10,
    );
    expect(work.timers).toEqual([
      expect.objectContaining({ sessionId: "wake-session", timerId: "wake" }),
    ]);
    expect(work.outbox).toEqual([
      expect.objectContaining({
        id: outboxId,
        sessionId: "wake-session",
        effectKey: "effect-one",
      }),
    ]);

    recovered.call("ackOutbox", [outboxId]);
    expect(recovered.central.isolatedOutboxSessionId(outboxId)).toBeUndefined();
    expect(recovered.storeForSession("wake-session").pendingOutbox()).toEqual([]);
    const successorId = recovered.call("enqueueOutbox", [
      "successor-session",
      "known_effect",
      null,
      "effect-two",
    ]) as number;
    expect(successorId).toBeGreaterThan(outboxId);
    expect(recovered.central.isolatedOutboxSessionId(successorId))
      .toBe("successor-session");
    recovered.close();
  });
});
