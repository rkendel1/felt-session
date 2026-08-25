import { afterEach, describe, expect, test } from "bun:test";
import { SessionKernelActorClient } from "./actor-client";
import {
  __setSessionKernelStoreForTest,
  installSessionKernelActor,
  sessionDelivery,
  sessionKernel,
} from "./kernel";

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
  test("reconciles compatible branch dead letters inside the actor store", async () => {
    const host = await actor();
    const id = host.store.enqueueOutbox(
      "shared-session",
      "creation_branch_prepare",
      {
        creationIdentity: "creation-one",
        creationGeneration: 1,
        project: "opensession",
        branch: "feature",
        worktreePath: "/srv/opensession",
        isolated: false,
        mode: "adopt_or_create",
      },
      "shared-branch",
    );
    host.store.applyCreationEvent({
      sessionId: "shared-session",
      identity: "creation-one",
      event: "plan",
    });
    host.store.applyCreationEvent({
      sessionId: "shared-session",
      identity: "creation-one",
      event: "preparation_started",
      nextEffectId: "shared-branch",
      effect: {
        kind: "creation_branch_prepare",
        effectKey: "shared-branch",
        payload: {
          creationIdentity: "creation-one",
          creationGeneration: 1,
          project: "opensession",
          branch: "feature",
          worktreePath: "/srv/opensession",
          isolated: false,
          mode: "adopt_or_create",
        },
      },
    });
    host.store.noteOutboxFailure(
      id,
      "Worktree destination /srv/opensession exists without a registered branch",
      1,
    );

    expect(
      host.store.retryCompatibleCreationBranchDeadLetters([
        { project: "opensession", worktreePath: "/srv/opensession" },
      ]),
    ).toEqual([
      {
        id,
        sessionId: "shared-session",
        reason: "shared_checkout_destination_adoptable",
      },
    ]);
    expect(host.store.pendingOutbox(Date.now() + 1_000)).toHaveLength(1);
  });

  test("owns turn cancellation and its physical effect while gateway work is active", async () => {
    const host = await actor();
    host.decideRunEvent({ sessionId: "turn-cancel", event: "prompt" });
    host.decideRunEvent({
      sessionId: "turn-cancel",
      event: "run_registered",
      runKey: "run-one",
    });
    host.decideDelivery({
      op: "set",
      sessionId: "turn-cancel",
      slot: "steered",
      value: [{ id: "steer-one", content: "return me" }],
    });
    expect(host.decideTurn({
      op: "prepare_cancel",
      sessionId: "turn-cancel",
      cancelId: "cancel-one",
      expectedRunId: "run-one",
      expectedGeneration: 1,
      dispatchId: "run-one",
      requeueIds: ["steer-one"],
      source: "test",
    })).toMatchObject({
      cancel: { phase: "prepared", runId: "run-one" },
      runState: { state: "stopped" },
    });
    expect(host.store.runState("turn-cancel")).toMatchObject({
      state: "stopped",
    });
    expect(host.store.runState("turn-cancel").currentRunId).toBeUndefined();
    expect(host.store.pendingOutbox(Date.now(), 10, ["turn_cancel"])).toEqual([
      expect.objectContaining({ kind: "turn_cancel", effectKey: "cancel-one" }),
    ]);
  });

  test("owns cancel command retry identity before gateway continuation", async () => {
    const host = await actor();
    host.decideRunEvent({
      sessionId: "typed-cancel",
      event: "prompt",
      runKey: "run-one",
    });
    expect(host.decideTurn({
      op: "request_cancel_command",
      sessionId: "typed-cancel",
      requestId: "request-one",
      fallbackRunId: null,
    })).toEqual({
      status: "execute",
      targetRunId: "run-one",
      targetRunGeneration: 1,
    });
    expect(host.decideTurn({
      op: "request_cancel_command",
      sessionId: "typed-cancel",
      requestId: "request-one",
      fallbackRunId: "run-two",
    })).toMatchObject({ status: "execute", targetRunId: "run-one" });
  });

  test("owns submit-prompt command receipts through the delivery actor", async () => {
    const host = await actor();
    const input = {
      op: "request_submit_command" as const,
      sessionId: "typed-submit",
      requestId: "delivery-one",
      identity: { content: "hello", attachmentsHash: "none" },
    };
    expect(host.decideDelivery(input)).toEqual({ status: "execute" });
    const result = {
      status: "queued",
      message: "Queued behind the current run.",
      deliveryId: input.requestId,
    };
    expect(host.decideDelivery({
      op: "complete_submit_command",
      sessionId: input.sessionId,
      requestId: input.requestId,
      result,
    })).toEqual(result);
    expect(host.decideDelivery(input)).toEqual({
      status: "completed",
      result,
      duplicate: true,
    });
  });

  test("owns timer execution receipts through the actor protocol", async () => {
    const host = await actor();
    host.store.scheduleTimer({
      sessionId: "typed-timer",
      timerId: "wake",
      kind: "test_timer",
      dueAt: Date.now() - 1,
      payload: { value: 1 },
    });
    const timer = host.store.timer("typed-timer", "wake")!;
    expect(host.decideTimer({
      op: "begin",
      sessionId: timer.sessionId,
      timerId: timer.timerId,
      token: timer.token,
    })).toBe("execute");
    expect(host.decideTimer({
      op: "complete",
      sessionId: timer.sessionId,
      timerId: timer.timerId,
      token: timer.token,
    })).toBe(true);
    expect(host.store.timer(timer.sessionId, timer.timerId)).toBeUndefined();
  });

  test("owns terminal outcome projection and settlement while gateway work is active", async () => {
    const host = await actor();
    host.decideRunEvent({
      sessionId: "turn-outcome",
      event: "prompt",
      runKey: "run-one",
    });
    host.decideRunEvent({
      sessionId: "turn-outcome",
      event: "run_registered",
      runKey: "run-one",
    });
    host.decideRunEvent({
      sessionId: "turn-outcome",
      event: "run_failed",
      runKey: "run-one",
    });
    expect(
      host.decideTurn({
        op: "prepare_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runId: "run-one",
        runGeneration: 1,
        errorMessage: "failed",
        noticePersisted: false,
        projectedAt: "2026-08-24T18:00:00.000Z",
      }),
    ).toMatchObject({ phase: "pending", runGeneration: 1 });
    expect(
      host.store.pendingOutbox(Date.now(), 10, ["turn_outcome_project"]),
    ).toEqual([
      expect.objectContaining({
        kind: "turn_outcome_project",
        effectKey: "outcome:run-one",
      }),
    ]);
    expect(
      host.decideTurn({
        op: "begin_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runGeneration: 1,
      }),
    ).toBe("execute");
    expect(
      host.decideTurn({
        op: "settle_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runGeneration: 1,
      }),
    ).toBe(true);
    expect(
      host.decideTurn({
        op: "begin_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runGeneration: 1,
      }),
    ).toBe("completed");
  });

  test("reduces creation events atomically", async () => {
    const host = await actor();
    expect(host.decideCreationEvent({
      sessionId: "creating",
      identity: "create-request",
      event: "plan",
    })).toMatchObject({ accepted: true, to: "planned" });
    expect(host.decideCreationEvent({
      sessionId: "creating",
      identity: "create-request",
      event: "preparation_started",
      nextEffectId: "prepare-effect",
      effect: {
        kind: "creation_workspace_prepare",
        effectKey: "prepare-effect",
        payload: {
          creationIdentity: "create-request",
          creationGeneration: 1,
          workspaceId: "workspace-one",
          dedupeKey: "creation:workspace-one",
          name: "Workspace one",
          createdBy: "Alice",
          mode: "adopt_or_create",
        },
      },
    })).toMatchObject({
      accepted: true,
      to: "preparing",
      state: { currentEffectId: "prepare-effect" },
    });
    expect(host.store.creationState("creating")).toMatchObject({
      state: "preparing",
      identity: "create-request",
    });
  });

  test("resizes creation decisions and snapshots for bounded opening plans", async () => {
    const host = await actor();
    const sessionId = "large-opening-plan";
    const identity = "large-opening-request";
    expect(host.decideCreationEvent({
      sessionId,
      identity,
      event: "plan",
    }).accepted).toBe(true);
    expect(host.decideCreationEvent({
      sessionId,
      identity,
      event: "preparation_started",
    }).accepted).toBe(true);
    const openingPrompt = "x".repeat(300 * 1024);
    const effectId = "opening:large-opening-entry";
    expect(host.decideCreationEvent({
      sessionId,
      identity,
      event: "opening_dispatched",
      openingPlan: {
        id: sessionId,
        openingPrompt,
        openingPromptEntryId: "large-opening-entry",
      },
      nextEffectId: effectId,
      effect: {
        kind: "creation_opening_turn",
        effectKey: effectId,
        payload: {
          creationIdentity: identity,
          creationGeneration: 1,
          openingPromptEntryId: "large-opening-entry",
          runId: `opening:${sessionId}:large-opening-entry`,
          runGeneration: 1,
          mode: "adopt_or_launch",
        },
      },
    })).toMatchObject({
      accepted: true,
      state: { openingPlan: { openingPrompt } },
    });
    expect(host.store.creationState(sessionId)?.openingPlan).toMatchObject({
      openingPrompt,
    });
  });

  test("hydrates persisted run state into the gateway projection", async () => {
    const host = await actor();
    host.callStore("setRunState", [
      {
      sessionId: "persisted",
      state: "running",
      event: "run_registered",
      generation: 4,
      currentRunId: "run-4",
      },
    ]);
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
    expect(() => host.decideGateway({
      op: "request",
      sessionId: "s1",
      requestId: "after-stop",
      operation: "websocket_command",
    })).toThrow("actor stopped");
  });

  test("fail-stops the actor client after ambiguous typed settlement", async () => {
    const host = await actor();
    host.decideGateway({
      op: "request",
      sessionId: "ambiguous-settlement",
      requestId: "one",
      operation: "websocket_command",
    });
    host.callStore("failCommand", [
      "ambiguous-settlement",
      "one",
      "receipt changed",
      false,
    ]);
    expect(() => host.decideGateway({
      op: "complete",
      sessionId: "ambiguous-settlement",
      requestId: "one",
      operation: "websocket_command",
      result: "done",
    })).toThrow("receipt changed");
    expect(() => host.decideDelivery({
      op: "snapshot",
      sessionId: "other-session",
    })).toThrow("receipt changed");
  });

  test("returns a terminal failure instead of re-executing it", async () => {
    const host = await actor();
    const input = {
      op: "request" as const,
      sessionId: "sticky",
      requestId: "same",
      operation: "websocket_command" as const,
      identity: { n: 1 },
    };
    expect(host.decideGateway(input)).toEqual({ status: "execute" });
    host.decideGateway({
      op: "fail",
      sessionId: input.sessionId,
      requestId: input.requestId,
      operation: input.operation,
      error: "not allowed",
      retryable: false,
    });
    expect(() => host.decideGateway(input)).toThrow("not allowed");
  });

  test("acknowledges replay results through async IPC", async () => {
    const host = await actor();
    host.decideGateway({
      op: "request",
      sessionId: "ack",
      requestId: "one",
      operation: "websocket_command",
    });
    host.decideGateway({
      op: "complete",
      sessionId: "ack",
      requestId: "one",
      operation: "websocket_command",
      result: { item: "kept" },
    });
    await host.acknowledgeCommand("ack", "one");
    expect(host.store.command("ack", "one")?.acknowledgedAt).toBeNumber();
  });

  test("loads registered runtime work through async IPC", async () => {
    const host = await actor();
    host.callStore("scheduleTimer", [
      {
      sessionId: "known",
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: null,
      },
    ]);
    host.callStore("scheduleTimer", [
      {
      sessionId: "future",
      timerId: "wake",
      kind: "future_timer",
      dueAt: Date.now() - 1,
      payload: null,
      },
    ]);
    host.callStore("enqueueOutbox", ["known", "known_effect", null, "known"]);
    host.callStore("enqueueOutbox", [
      "future",
      "future_effect",
      null,
      "future",
    ]);
    const work = await host.runtimeWork(["known_timer"], ["known_effect"]);
    expect(work.timers.map((timer) => timer.kind)).toEqual(["known_timer"]);
    expect(work.outbox.map((item) => item.kind)).toEqual(["known_effect"]);
  });

  test("returns a committed result after an uncertain reply", async () => {
    const host = await actor();
    const input = {
      op: "request" as const,
      sessionId: "s1",
      requestId: "same",
      operation: "websocket_command" as const,
      identity: { n: 1 },
    };
    expect(host.decideGateway(input)).toEqual({ status: "execute" });
    host.decideGateway({
      op: "complete",
      sessionId: input.sessionId,
      requestId: input.requestId,
      operation: input.operation,
      result: { accepted: true },
    });
    expect(host.decideGateway(input)).toEqual({
      status: "completed",
      result: { accepted: true },
      duplicate: true,
    });
  });

  test("resizes read-only delivery snapshots beyond the initial buffer", async () => {
    const host = await actor();
    const content = "x".repeat(9 * 1024 * 1024);
    host.decideDelivery({
      op: "set",
      sessionId: "large-delivery",
      slot: "queued",
      value: [{ id: "large", content }],
    });
    const snapshot = host.decideDelivery({
      op: "snapshot",
      sessionId: "large-delivery",
    });
    expect((snapshot.queued as Array<{ content: string }>)[0]?.content.length).toBe(
      content.length,
    );
  });

  test("delivery mutations invalidate projections without fetching a snapshot", async () => {
    const host = await actor();
    const original = host.decideDelivery.bind(host);
    let snapshotCalls = 0;
    host.decideDelivery = ((request) => {
      if (request.op === "snapshot") snapshotCalls += 1;
      return original(request);
    }) as typeof host.decideDelivery;
    installSessionKernelActor(host);

    sessionDelivery({
      op: "set",
      sessionId: "small-mutation-reply",
      slot: "queued",
      value: [{ id: "queued", content: "hello" }],
    });
    expect(snapshotCalls).toBe(0);
    expect(
      sessionDelivery({ op: "snapshot", sessionId: "small-mutation-reply" })
        .revision,
    ).toBe(1);
    expect(snapshotCalls).toBe(1);
  });

  test("selects and claims a queue batch through the actor protocol", async () => {
    const host = await actor();
    host.decideDelivery({
      op: "set",
      sessionId: "actor-next-dispatch",
      slot: "queued",
      value: [
        { id: "held", content: "later", hold: true },
        { id: "solo", promptEntryId: "stable-entry", content: "now", hold: true },
      ],
    });
    host.decideDelivery({
      op: "prepare_interrupt",
      sessionId: "actor-next-dispatch",
      interruptId: "interrupt-one",
      anchorId: "solo",
      dispatchId: "run-owner",
      soloId: "solo",
    });
    host.decideDelivery({
      op: "settle_interrupt",
      sessionId: "actor-next-dispatch",
      interruptId: "interrupt-one",
      outcome: "confirmed",
    });
    expect(host.decideDelivery({
      op: "claim_next_dispatch",
      sessionId: "actor-next-dispatch",
      promptEntryId: "candidate-entry",
      stillWorking: true,
    })).toMatchObject({
      kind: "deliver",
      promptEntryId: "stable-entry",
      items: [{ id: "solo", promptEntryId: "stable-entry" }],
      interrupted: true,
    });
    expect(host.decideDelivery({
      op: "snapshot",
      sessionId: "actor-next-dispatch",
    })).toMatchObject({
      queued: [{ id: "held" }],
      dispatch: { promptEntryId: "stable-entry" },
    });
  });

  test("keeps reducers responsive while physical gateway work is blocked", async () => {
    const host = await actor();
    const first = {
      op: "request" as const,
      sessionId: "responsive",
      requestId: "first-effect",
      operation: "websocket_command" as const,
    };
    expect(host.decideGateway(first)).toEqual({ status: "execute" });
    let release!: () => void;
    const physical = new Promise<void>((resolve) => { release = resolve; });

    // A second command and unrelated reducers are decided immediately. The actor
    // never waits for the first command's physical continuation.
    expect(host.decideGateway({
      ...first,
      requestId: "second-effect",
    })).toEqual({ status: "execute" });
    host.decideDelivery({
      op: "set",
      sessionId: "responsive",
      slot: "queued",
      value: [{ id: "q1", content: "still responsive" }],
    });
    host.decideAsk({
      op: "set",
      sessionId: "responsive",
      value: { questionId: "ask-1", questions: [] },
    });
    expect(host.decideDelivery({
      op: "snapshot",
      sessionId: "responsive",
    }).queued).toHaveLength(1);
    expect(host.decideAsk({
      op: "snapshot",
      sessionId: "responsive",
    })).toMatchObject({ questionId: "ask-1" });

    release();
    await physical;
    host.decideGateway({
      op: "complete",
      sessionId: first.sessionId,
      requestId: first.requestId,
      operation: first.operation,
      result: "first",
    });
  });

});
