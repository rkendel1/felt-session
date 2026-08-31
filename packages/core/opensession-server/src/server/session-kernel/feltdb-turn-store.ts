import { createHash } from "node:crypto";
import type {
  DurableDeliveryState,
  DurableRunState,
  DurableTurnOutcomeProjection,
  DurableTurnState,
} from "./store";
import { nextRunState, type RunState } from "./run-state-machine";
import type { QueueItem } from "../queue-state";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";

type StoredTurn = DurableTurnState & {
  schemaVersion: 1;
  sessionId: string;
  __version: number;
};

type Cancel = NonNullable<DurableTurnState["cancel"]>;
type StoredProjection = DurableTurnOutcomeProjection & {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  generation: number;
  updatedAt: number;
  __version: number;
};
type StoredDelivery = DurableDeliveryState & {
  schemaVersion: 1;
  sessionId: string;
  __version: number;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function turnId(sessionId: string): string {
  return kernelRecordId("turn", sessionId);
}

function deliveryId(sessionId: string): string {
  return kernelRecordId("delivery", sessionId);
}

function projectionId(sessionId: string, decisionEpoch: number, id: string): string {
  return kernelRecordId("turn_projections", `${sessionId}:${decisionEpoch}:${id}`);
}

function generationId(sessionId: string, decisionEpoch: number, generation: number): string {
  return kernelRecordId(
    "turn_projection_generation",
    `${sessionId}:${decisionEpoch}:${generation}`,
  );
}

function state(record: StoredTurn | undefined): DurableTurnState {
  if (!record) return { revision: 0, updatedAt: 0 };
  const { schemaVersion: _, sessionId: __, __version: ___, ...value } = record;
  return value;
}

export function decideFeltDbTurnCancelBegin(
  head: VersionedSessionDecisionHead,
  prior: Cancel | undefined,
  input: { cancelId: string; runGeneration: number },
): {
  result: "execute" | "retry" | "adopt_confirmed" | "settled" | "missing";
  next?: Cancel;
} {
  if (!prior || prior.cancelId !== input.cancelId) return { result: "missing" };
  if (prior.phase === "settled") return { result: "settled" };
  if (prior.runGeneration !== input.runGeneration || head.run.generation !== input.runGeneration)
    return { result: "adopt_confirmed" };
  if (prior.phase === "executing") return { result: "retry" };
  return { result: "execute", next: { ...prior, phase: "executing" } };
}

/** Managed FeltDB turn cancellation phase state. */
export class FeltDbTurnStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  private record(sessionId: string): Promise<StoredTurn | undefined> {
    return this.decisions.record(KERNEL_COLLECTIONS.turns, turnId(sessionId));
  }

  async snapshot(sessionId: string): Promise<DurableTurnState> {
    return state(await this.record(sessionId));
  }

  async prepareCancel(
    commandId: string,
    input: {
      sessionId: string;
      cancelId: string;
      expectedRunId: string;
      expectedGeneration: number;
      dispatchId: string;
      requeueIds: string[];
      source: string;
      user?: string;
    },
    now = Date.now(),
  ): Promise<{ cancel: Cancel; runState: DurableRunState }> {
    if (
      !input.cancelId || input.cancelId.length > 256 ||
      !input.expectedRunId || input.expectedRunId.length > 256 ||
      !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 ||
      !input.dispatchId || input.dispatchId.length > 256 ||
      input.dispatchId !== input.expectedRunId ||
      input.requeueIds.length > 256 || input.requeueIds.some((id) => !id || id.length > 256) ||
      !input.source || input.source.length > 100 ||
      (input.user !== undefined && (!input.user || input.user.length > 200))
    ) throw new Error("Invalid turn cancel intent");
    const [head, priorTurn, priorDelivery] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
      this.decisions.record<StoredDelivery>(
        KERNEL_COLLECTIONS.delivery,
        deliveryId(input.sessionId),
      ),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    if (priorTurn?.cancel?.cancelId === input.cancelId) {
      const prior = priorTurn.cancel;
      if (
        prior.runId !== input.expectedRunId ||
        prior.runGeneration !== input.expectedGeneration ||
        JSON.stringify(prior.requeueIds) !== JSON.stringify(input.requeueIds) ||
        prior.source !== input.source || prior.user !== input.user
      ) throw new Error("Turn cancel identity was reused with another payload");
      return { cancel: prior, runState: { ...head.run, changeSeq: head.changeSeq } };
    }
    const ownsTarget = head.run.currentRunId === input.expectedRunId ||
      (!head.run.currentRunId && ["starting", "preparing"].includes(head.run.state) &&
        input.dispatchId === input.expectedRunId);
    if (!ownsTarget || head.run.generation !== input.expectedGeneration)
      throw new Error("The run targeted by this cancel has already changed");
    const reduced = nextRunState(head.run.state as RunState, "cancel");
    if (!reduced) throw new Error(`Cannot cancel a run while ${head.run.state}`);
    const targetState = head.run.state === "preparing" ? "stopped" : reduced;
    const baseDelivery: DurableDeliveryState = priorDelivery
      ? (({ schemaVersion: _, sessionId: __, __version: ___, ...value }) => value)(priorDelivery)
      : { revision: 0, queued: [], steered: [], pendingSteers: [], updatedAt: 0 };
    const steered = [...baseDelivery.steered] as QueueItem[];
    const requested = new Set(input.requeueIds);
    const requeued = steered.filter(
      (item) => typeof item.id === "string" && requested.has(item.id),
    );
    if (requeued.length !== requested.size)
      throw new Error("A cancel requeue receipt is no longer actor-owned");
    const duplicateIds = new Set(requeued.map((item) => item.id));
    const delivery: DurableDeliveryState = {
      ...baseDelivery,
      revision: baseDelivery.revision + 1,
      queued: [
        ...requeued,
        ...(baseDelivery.queued as QueueItem[]).filter((item) => !duplicateIds.has(item.id)),
      ],
      steered: [],
      pendingSteers: [...baseDelivery.pendingSteers],
      updatedAt: now,
    };
    const cancel: Cancel = {
      cancelId: input.cancelId,
      phase: "prepared",
      runId: input.expectedRunId,
      runGeneration: input.expectedGeneration,
      requeueIds: [...input.requeueIds],
      source: input.source,
      ...(input.user ? { user: input.user } : {}),
    };
    const nextRun = {
      ...head.run,
      state: targetState,
      since: new Date(now).toISOString(),
      lastEvent: "cancel",
      currentRunId: undefined,
    };
    const runState: DurableRunState = { ...nextRun, changeSeq: head.changeSeq + 1 };
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:turn:cancel_prepare:${input.sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "turn_cancel_prepare",
      inputHash: digest(input),
      observedHead: head,
      nextRun,
      changeKind: "turn_cancel_prepared",
      changePayload: {
        cancelId: input.cancelId,
        runId: input.expectedRunId,
        runGeneration: input.expectedGeneration,
        deliveryRevision: delivery.revision,
        source: input.source,
        ...(input.user ? { user: input.user } : {}),
      },
      domainOperations: [
        {
          collection: KERNEL_COLLECTIONS.delivery,
          id: deliveryId(input.sessionId),
          value: { schemaVersion: 1, sessionId: input.sessionId, ...delivery },
          ...(priorDelivery ? { ifVersion: priorDelivery.__version } : { requireAbsent: true }),
        },
        {
          collection: KERNEL_COLLECTIONS.turns,
          id: turnId(input.sessionId),
          value: {
            schemaVersion: 1,
            sessionId: input.sessionId,
            revision: (priorTurn?.revision ?? 0) + 1,
            cancel,
            updatedAt: now,
          },
          ...(priorTurn ? { ifVersion: priorTurn.__version } : { requireAbsent: true }),
        },
      ],
      effects: [{
        effectKey: input.cancelId,
        kind: "turn_cancel",
        payload: {
          cancelId: input.cancelId,
          dispatchId: input.dispatchId,
          runGeneration: input.expectedGeneration,
        },
      }],
      result: { cancel, runState },
      now,
    });
  }

  private commitCancel<Result>(input: {
    commandId: string;
    operationKind: string;
    inputHash: string;
    head: VersionedSessionDecisionHead;
    prior: StoredTurn;
    cancel: Cancel;
    result: Result;
    now: number;
  }): Promise<Result> {
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:turn:${input.head.sessionId}:${input.operationKind}:${input.commandId}`,
      operationId: input.commandId,
      operationKind: input.operationKind,
      inputHash: input.inputHash,
      observedHead: input.head,
      changeKind: "turn_cancel_updated",
      changePayload: input.cancel,
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.turns,
        id: turnId(input.head.sessionId),
        value: {
          schemaVersion: 1,
          sessionId: input.head.sessionId,
          revision: input.prior.revision + 1,
          cancel: input.cancel,
          updatedAt: input.now,
        },
        ifVersion: input.prior.__version,
      }],
      result: input.result,
      now: input.now,
    });
  }

  async beginCancelEffect(
    commandId: string,
    input: { sessionId: string; cancelId: string; runGeneration: number },
    now = Date.now(),
  ): Promise<"execute" | "retry" | "adopt_confirmed" | "settled" | "missing"> {
    const [head, prior] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const decision = decideFeltDbTurnCancelBegin(head, prior?.cancel, input);
    if (!decision.next || !prior) return decision.result;
    return this.commitCancel({
      commandId,
      operationKind: "turn_cancel_begin",
      inputHash: digest(input),
      head,
      prior,
      cancel: decision.next,
      result: decision.result,
      now,
    });
  }

  async settleCancel(
    commandId: string,
    input: {
      sessionId: string;
      cancelId: string;
      outcome: "confirmed" | "not_aborted";
    },
    now = Date.now(),
  ): Promise<boolean> {
    const [head, prior] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    if (!prior?.cancel || prior.cancel.cancelId !== input.cancelId) return false;
    if (prior.cancel.phase === "settled") return true;
    return this.commitCancel({
      commandId,
      operationKind: "turn_cancel_settle",
      inputHash: digest(input),
      head,
      prior,
      cancel: { ...prior.cancel, phase: "settled", outcome: input.outcome },
      result: true,
      now,
    });
  }

  private projection(
    sessionId: string,
    decisionEpoch: number,
    id: string,
  ): Promise<StoredProjection | undefined> {
    return this.decisions.record(
      KERNEL_COLLECTIONS.turnProjections,
      projectionId(sessionId, decisionEpoch, id),
    );
  }

  async prepareOutcomeProjection(
    commandId: string,
    input: {
      sessionId: string;
      projectionId: string;
      runId: string;
      runGeneration: number;
      errorMessage: string | null;
      engineSessionId?: string;
      noticePersisted: boolean;
      noticeLabel?: string;
      projectedAt: string;
    },
    now = Date.now(),
  ): Promise<DurableTurnOutcomeProjection | "stale"> {
    if (
      !input.projectionId || input.projectionId.length > 256 ||
      !input.runId || input.runId.length > 256 ||
      !Number.isSafeInteger(input.runGeneration) || input.runGeneration < 1 ||
      (input.errorMessage !== null && input.errorMessage.length > 500) ||
      (input.engineSessionId !== undefined &&
        (!input.engineSessionId || input.engineSessionId.length > 256)) ||
      typeof input.noticePersisted !== "boolean" ||
      (input.noticeLabel !== undefined && (!input.noticeLabel || input.noticeLabel.length > 100)) ||
      !input.projectedAt || input.projectedAt.length > 64 ||
      !Number.isFinite(Date.parse(input.projectedAt))
    ) throw new Error("Invalid turn outcome projection");
    const head = await this.decisions.head(input.sessionId);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const [turn, existing, generationOwner] = await Promise.all([
      this.record(input.sessionId),
      this.projection(input.sessionId, head.decisionEpoch, input.projectionId),
      this.decisions.record<{ projectionId: string }>(
        KERNEL_COLLECTIONS.turnProjectionGenerations,
        generationId(input.sessionId, head.decisionEpoch, input.runGeneration),
      ),
    ]);
    const payload: Omit<DurableTurnOutcomeProjection, "phase"> = {
      projectionId: input.projectionId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      errorMessage: input.errorMessage,
      ...(input.engineSessionId ? { engineSessionId: input.engineSessionId } : {}),
      noticePersisted: input.noticePersisted,
      ...(input.noticeLabel ? { noticeLabel: input.noticeLabel } : {}),
      projectedAt: input.projectedAt,
    };
    if (existing) {
      const {
        schemaVersion: _, sessionId: __, decisionEpoch: ___, generation: ____,
        updatedAt: _____, __version: ______,
        phase, ...priorPayload
      } = existing;
      if (JSON.stringify(priorPayload) !== JSON.stringify(payload))
        throw new Error("Turn outcome projection identity was reused with another payload");
      return { ...payload, phase };
    }
    const cancel = turn?.cancel;
    if (
      head.run.generation !== input.runGeneration ||
      (head.run.currentRunId !== undefined && head.run.currentRunId !== input.runId) ||
      (cancel?.runId === input.runId && cancel.runGeneration === input.runGeneration &&
        cancel.phase === "settled" && cancel.outcome === "confirmed")
    ) return "stale";
    if (generationOwner)
      throw new Error("Turn outcome projection generation is already owned");
    const next: StoredProjection = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      decisionEpoch: head.decisionEpoch,
      generation: input.runGeneration,
      ...payload,
      phase: "pending",
      updatedAt: now,
      __version: 0,
    };
    const { __version: _, ...stored } = next;
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:turn:projection_prepare:${input.sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "turn_projection_prepare",
      inputHash: digest(input),
      observedHead: head,
      changeKind: "turn_outcome_projection_prepared",
      changePayload: payload,
      domainOperations: [
        {
          collection: KERNEL_COLLECTIONS.turnProjections,
          id: projectionId(input.sessionId, head.decisionEpoch, input.projectionId),
          value: stored,
          requireAbsent: true,
        },
        {
          collection: KERNEL_COLLECTIONS.turnProjectionGenerations,
          id: generationId(input.sessionId, head.decisionEpoch, input.runGeneration),
          value: {
            schemaVersion: 1,
            sessionId: input.sessionId,
            decisionEpoch: head.decisionEpoch,
            generation: input.runGeneration,
            projectionId: input.projectionId,
          },
          requireAbsent: true,
        },
      ],
      effects: [{
        effectKey: input.projectionId,
        kind: "turn_outcome_project",
        orderingKey: input.runGeneration,
        payload,
      }],
      result: { ...payload, phase: "pending" as const },
      now,
    });
  }

  async beginOutcomeProjection(
    commandId: string,
    input: { sessionId: string; projectionId: string; runGeneration: number },
    now = Date.now(),
  ): Promise<"execute" | "wait" | "completed" | "missing"> {
    const head = await this.decisions.head(input.sessionId);
    if (!head || head.authority.lifecycle !== "active") return "missing";
    const projection = await this.projection(
      input.sessionId,
      head.decisionEpoch,
      input.projectionId,
    );
    if (!projection || projection.runGeneration !== input.runGeneration) return "missing";
    if (projection.phase === "completed") return "completed";
    if (projection.phase === "superseded") return "missing";
    const [higherCompleted, predecessor] = await Promise.all([
      this.decisions.completedTurnProjectionAfter(
        input.sessionId,
        head.decisionEpoch,
        input.runGeneration,
      ),
      this.decisions.pendingOutboxBefore(
        input.sessionId,
        head.decisionEpoch,
        "turn_outcome_project",
        input.runGeneration,
      ),
    ]);
    if (higherCompleted) {
      const { __version: _, ...current } = projection;
      return this.decisions.commitDecision({
        transactionId: `opensession:kernel:turn:projection_supersede:${input.sessionId}:${commandId}`,
        operationId: commandId,
        operationKind: "turn_projection_supersede",
        inputHash: digest(input),
        observedHead: head,
        changeKind: "turn_outcome_projection_superseded",
        changePayload: { projectionId: input.projectionId },
        domainOperations: [{
          collection: KERNEL_COLLECTIONS.turnProjections,
          id: projectionId(input.sessionId, head.decisionEpoch, input.projectionId),
          value: { ...current, phase: "superseded", updatedAt: now },
          ifVersion: projection.__version,
        }],
        result: "missing" as const,
        now,
      });
    }
    return predecessor ? "wait" : "execute";
  }

  async settleOutcomeProjection(
    commandId: string,
    input: { sessionId: string; projectionId: string; runGeneration: number },
    now = Date.now(),
  ): Promise<boolean> {
    const head = await this.decisions.head(input.sessionId);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const projection = await this.projection(
      input.sessionId,
      head.decisionEpoch,
      input.projectionId,
    );
    if (!projection || projection.runGeneration !== input.runGeneration) return false;
    if (projection.phase === "completed") return true;
    if (projection.phase === "superseded") return false;
    const { __version: _, ...current } = projection;
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:turn:projection_settle:${input.sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "turn_projection_settle",
      inputHash: digest(input),
      observedHead: head,
      changeKind: "turn_outcome_projection_completed",
      changePayload: current,
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.turnProjections,
        id: projectionId(input.sessionId, head.decisionEpoch, input.projectionId),
        value: { ...current, phase: "completed", updatedAt: now },
        ifVersion: projection.__version,
      }],
      result: true,
      now,
    });
  }
}
