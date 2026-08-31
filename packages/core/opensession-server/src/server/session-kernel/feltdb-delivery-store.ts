import { createHash } from "node:crypto";
import type {
  DeliverySlot,
  DurableCreationState,
  DurableDeliveryState,
  DurableSteerTarget,
} from "./store";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type DecisionEffect,
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";
import { selectQueueBatch } from "./queue-batch-reducer";
import type { QueueItem } from "../queue-state";

type StoredDelivery = DurableDeliveryState & {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  __version: number;
};

type StoredCreation = DurableCreationState & {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  __version: number;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deliveryId(sessionId: string): string {
  return kernelRecordId("delivery", sessionId);
}

function creationId(sessionId: string): string {
  return kernelRecordId("creation", sessionId);
}

function initialDelivery(): DurableDeliveryState {
  return { revision: 0, queued: [], steered: [], pendingSteers: [], updatedAt: 0 };
}

function deliveryState(record: StoredDelivery | undefined): DurableDeliveryState {
  if (!record) return initialDelivery();
  const {
    schemaVersion: _, sessionId: __, decisionEpoch: ___, __version: ____, ...value
  } = record;
  return value;
}

export function prepareFeltDbDeliveryMutation(
  prior: DurableDeliveryState,
  creation: DurableCreationState | undefined,
  kind: string,
): DurableDeliveryState {
  const working: DurableDeliveryState = {
    ...prior,
    queued: [...prior.queued],
    steered: [...prior.steered],
    pendingSteers: [...prior.pendingSteers],
  };
  const dispatch = working.dispatch as { promptEntryId?: string; kind?: string } | undefined;
  const openingEffectId = dispatch?.promptEntryId ? `opening:${dispatch.promptEntryId}` : undefined;
  if (
    kind !== "delivery_dispatch_acknowledged" &&
    kind !== "delivery_dispatch_failed" &&
    dispatch?.kind === "create" &&
    openingEffectId &&
    creation &&
    ["ready", "failed", "cancelled"].includes(creation.state) &&
    creation.completedEffectIds.includes(openingEffectId)
  ) working.dispatch = undefined;
  return working;
}

/** Managed FeltDB queued, dispatch, and steering delivery state. */
export class FeltDbDeliveryStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  private record(sessionId: string): Promise<StoredDelivery | undefined> {
    return this.decisions.record(KERNEL_COLLECTIONS.delivery, deliveryId(sessionId));
  }

  async snapshot(sessionId: string): Promise<DurableDeliveryState> {
    const [head, record] = await Promise.all([
      this.decisions.head(sessionId),
      this.record(sessionId),
    ]);
    return deliveryState(
      head && record?.decisionEpoch === head.decisionEpoch ? record : undefined,
    );
  }

  private async mutate<Result>(input: {
    commandId: string;
    sessionId: string;
    kind: string;
    identity: unknown;
    effects?: DecisionEffect[] | ((head: VersionedSessionDecisionHead) => DecisionEffect[]);
    now?: number;
    mutate(state: DurableDeliveryState, head: VersionedSessionDecisionHead): Result;
  }): Promise<{ state: DurableDeliveryState; result: Result }> {
    const now = input.now ?? Date.now();
    const [head, priorRecord, creation] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
      this.decisions.record<StoredCreation>(KERNEL_COLLECTIONS.creation, creationId(input.sessionId)),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const activePrior = priorRecord?.decisionEpoch === head.decisionEpoch
      ? priorRecord
      : undefined;
    const prior = deliveryState(activePrior);
    const creationState = creation?.decisionEpoch === head.decisionEpoch
      ? (({ schemaVersion: _, sessionId: __, decisionEpoch: ___, __version: ____, ...value }) => value)(creation)
      : undefined;
    const working = prepareFeltDbDeliveryMutation(prior, creationState, input.kind);
    const result = input.mutate(working, head);
    const state: DurableDeliveryState = {
      ...working,
      revision: prior.revision + 1,
      updatedAt: now,
    };
    const committed = await this.decisions.commitDecision({
      transactionId: `opensession:kernel:delivery:${input.sessionId}:${input.kind}:${input.commandId}`,
      operationId: input.commandId,
      operationKind: input.kind,
      inputHash: digest(input.identity),
      observedHead: head,
      nextRun: head.run.since === new Date(0).toISOString()
        ? { ...head.run, since: new Date(now).toISOString() }
        : head.run,
      changeKind: input.kind,
      changePayload: { revision: state.revision },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.delivery,
        id: deliveryId(input.sessionId),
        value: {
          schemaVersion: 1,
          sessionId: input.sessionId,
          decisionEpoch: head.decisionEpoch,
          ...state,
        },
        ...(priorRecord ? { ifVersion: priorRecord.__version } : { requireAbsent: true }),
      }],
      effects: typeof input.effects === "function" ? input.effects(head) : input.effects,
      result: { state, result },
      now,
    });
    return committed;
  }

  async setSlot(
    commandId: string,
    sessionId: string,
    slot: DeliverySlot,
    value: unknown,
  ): Promise<void> {
    await this.mutate({
      commandId, sessionId, kind: `delivery_${slot}_set`, identity: { slot, value },
      mutate(state) {
        if (slot === "queued") state.queued = Array.isArray(value) ? value : [];
        else if (slot === "steered") state.steered = Array.isArray(value) ? value : [];
        else state.dispatch = value;
      },
    });
  }

  async enqueue(
    commandId: string,
    sessionId: string,
    item: unknown,
    front = false,
  ): Promise<boolean> {
    return (await this.mutate({
      commandId, sessionId, kind: "delivery_queued_enqueue", identity: { item, front },
      mutate(state) {
        const queue = state.queued as Array<{ id?: string }>;
        const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
        if (typeof id === "string" && queue.some((queued) => queued.id === id)) return false;
        if (front) queue.unshift(item as { id?: string });
        else queue.push(item as { id?: string });
        return true;
      },
    })).result;
  }

  async promoteQueued(
    commandId: string,
    sessionId: string,
    itemId: string,
    promptEntryId: string,
    directItem?: unknown,
  ): Promise<unknown | undefined> {
    if (!itemId || !promptEntryId || promptEntryId.length > 256)
      throw new Error("Invalid promoted prompt identity");
    return (await this.mutate({
      commandId,
      sessionId,
      kind: "delivery_queued_promoted",
      identity: { itemId, promptEntryId, directItem },
      mutate(state) {
        const queue = state.queued as Array<Record<string, unknown> & { id?: string }>;
        const index = queue.findIndex((item) => item.id === itemId);
        if (index < 0 && directItem === undefined) return undefined;
        const queuedItem = index >= 0 ? queue.splice(index, 1)[0] : undefined;
        const item = {
          ...(queuedItem ?? {}),
          ...(directItem && typeof directItem === "object"
            ? directItem as Record<string, unknown>
            : {}),
          id: itemId,
          promptEntryId,
        };
        state.queued = [item, ...queue.filter((candidate) => candidate.id !== itemId)];
        return item;
      },
    })).result;
  }

  async deleteSlot(
    commandId: string,
    sessionId: string,
    slot: DeliverySlot,
  ): Promise<boolean> {
    const prior = await this.snapshot(sessionId);
    const existed = slot === "dispatch"
      ? prior.dispatch !== undefined
      : (slot === "queued" ? prior.queued : prior.steered).length > 0;
    if (!existed) return false;
    await this.mutate({
      commandId, sessionId, kind: `delivery_${slot}_delete`, identity: { slot },
      mutate(state) {
        if (slot === "queued") state.queued = [];
        else if (slot === "steered") state.steered = [];
        else state.dispatch = undefined;
      },
    });
    return true;
  }

  async prepareSteer(
    commandId: string,
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
    directItem?: unknown,
    now = Date.now(),
  ): Promise<unknown | undefined> {
    return (await this.mutate({
      commandId,
      sessionId,
      kind: "delivery_steer_prepared",
      identity: { itemId, target, directItem },
      now,
      mutate(state, head) {
        if (head.run.currentRunId !== target.runId || head.run.generation !== target.generation)
          return undefined;
        const queue = state.queued as Array<{ id?: string }>;
        const index = queue.findIndex((item) => item.id === itemId);
        if (index < 0 && directItem === undefined) return undefined;
        const queuedItem = index >= 0 ? queue.splice(index, 1)[0] : undefined;
        const item = directItem && typeof directItem === "object"
          ? { ...(queuedItem as Record<string, unknown> | undefined),
              ...(directItem as Record<string, unknown>), id: itemId }
          : queuedItem ?? { id: itemId, value: directItem };
        state.queued = queue;
        state.pendingSteers.push({ item, index: index >= 0 ? index : 0, preparedAt: now, target });
        return item;
      },
    })).result;
  }

  async settleSteer(
    commandId: string,
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
    accepted: boolean,
    now = Date.now(),
  ): Promise<boolean> {
    return (await this.mutate({
      commandId,
      sessionId,
      kind: accepted ? "delivery_steer_accepted" : "delivery_steer_rejected",
      identity: { itemId, target, accepted },
      now,
      mutate(state, head) {
        if (accepted &&
          (head.run.currentRunId !== target.runId || head.run.generation !== target.generation))
          return false;
        const index = state.pendingSteers.findIndex((pending) =>
          (pending.item as { id?: string }).id === itemId &&
          pending.target?.token === target.token && pending.target.runId === target.runId &&
          pending.target.generation === target.generation
        );
        if (index < 0) return false;
        const [pending] = state.pendingSteers.splice(index, 1);
        if (accepted) state.steered.push({
          ...(pending.item as Record<string, unknown>),
          steeredAt: now,
        });
        else state.queued.splice(Math.min(pending.index, state.queued.length), 0, pending.item);
        return true;
      },
    })).result;
  }

  async requeueSteers(
    commandId: string,
    sessionId: string,
    items: unknown[],
  ): Promise<number> {
    const prior = await this.snapshot(sessionId);
    if (items.length === 0 && prior.steered.length === 0) return 0;
    await this.mutate({
      commandId, sessionId, kind: "delivery_steers_requeued", identity: { items },
      mutate(state) {
        const ids = new Set(
          (items as Array<{ id?: string }>).map((item) => item.id).filter(Boolean),
        );
        state.queued = [
          ...items,
          ...(state.queued as Array<{ id?: string }>).filter(
            (item) => !item.id || !ids.has(item.id),
          ),
        ];
        state.steered = [];
      },
    });
    return items.length;
  }

  async prepareInterrupt(
    commandId: string,
    input: {
      sessionId: string;
      interruptId: string;
      anchorId: string;
      dispatchId: string;
      soloId?: string;
    },
  ): Promise<NonNullable<DurableDeliveryState["interrupt"]>> {
    if (
      !input.interruptId || input.interruptId.length > 256 ||
      !input.anchorId || input.anchorId.length > 256 ||
      !input.dispatchId || input.dispatchId.length > 256 ||
      (input.soloId !== undefined && (!input.soloId || input.soloId.length > 256))
    ) throw new Error("Invalid prompt interrupt identity");
    const snapshot = await this.snapshot(input.sessionId);
    const existing = snapshot.interrupt;
    if (existing?.interruptId === input.interruptId) {
      if (
        (existing.dispatchId && existing.dispatchId !== input.dispatchId) ||
        existing.anchorId !== input.anchorId || existing.soloId !== input.soloId
      ) throw new Error("Prompt interrupt identity was reused with another payload");
      return existing;
    }
    return (await this.mutate({
      commandId,
      sessionId: input.sessionId,
      kind: "delivery_interrupt_prepared",
      identity: input,
      effects: (head) => [{
        effectKey: input.interruptId,
        kind: "delivery_interrupt_cancel",
        payload: {
          interruptId: input.interruptId,
          dispatchId: input.dispatchId,
          runGeneration: head.run.generation,
        },
      }],
      mutate(state, currentHead) {
        if (state.dispatch) throw new Error("A prompt dispatch is already active");
        const queued = state.queued as QueueItem[];
        const steered = state.steered as QueueItem[];
        const queuedIndex = queued.findIndex((item) => item.id === input.anchorId);
        const steeredIndex = steered.findIndex((item) => item.id === input.anchorId);
        if (queuedIndex < 0 && steeredIndex < 0)
          throw new Error("Interrupted prompt is no longer delivery-owned");
        if (state.interrupt) throw new Error("A prompt interrupt is already pending");
        const source = queuedIndex < 0 && steeredIndex >= 0
          ? { slot: "steered" as const, index: steeredIndex }
          : undefined;
        if (source) {
          const [receipt] = steered.splice(steeredIndex, 1);
          state.queued = [receipt, ...queued];
          state.steered = steered;
        }
        state.interrupt = {
          interruptId: input.interruptId,
          phase: "prepared",
          runGeneration: currentHead.run.generation,
          dispatchId: input.dispatchId,
          anchorId: input.anchorId,
          ...(input.soloId ? { soloId: input.soloId } : {}),
          ...(source ? { source } : {}),
        };
        return state.interrupt;
      },
    })).result;
  }

  async beginInterruptEffect(
    commandId: string,
    input: { sessionId: string; interruptId: string; runGeneration: number },
  ): Promise<"execute" | "retry" | "adopt_confirmed" | "confirmed" | "settled"> {
    return (await this.mutate({
      commandId,
      sessionId: input.sessionId,
      kind: "delivery_interrupt_effect_started",
      identity: input,
      mutate(state, head) {
        const dispatchInterrupt = (
          state.dispatch as { interrupt?: DurableDeliveryState["interrupt"] } | undefined
        )?.interrupt;
        const interrupt = state.interrupt || dispatchInterrupt;
        if (!interrupt || interrupt.interruptId !== input.interruptId) return "settled" as const;
        if (interrupt.phase === "confirmed") return "confirmed" as const;
        if (
          interrupt.runGeneration !== input.runGeneration ||
          head.run.generation !== input.runGeneration
        ) return "adopt_confirmed" as const;
        if (interrupt.phase === "executing") return "retry" as const;
        state.interrupt = { ...interrupt, phase: "executing" };
        return "execute" as const;
      },
    })).result;
  }

  async settleInterrupt(
    commandId: string,
    input: {
      sessionId: string;
      interruptId: string;
      outcome: "confirmed" | "not_aborted";
    },
  ): Promise<boolean> {
    return (await this.mutate({
      commandId,
      sessionId: input.sessionId,
      kind: "delivery_interrupt_settled",
      identity: input,
      mutate(state) {
        const interrupt = state.interrupt;
        if (!interrupt || interrupt.interruptId !== input.interruptId) return false;
        if (input.outcome === "not_aborted") {
          if (interrupt.source?.slot === "steered") {
            const queued = state.queued as QueueItem[];
            const index = queued.findIndex((item) => item.id === interrupt.anchorId);
            if (index >= 0) {
              const [receipt] = queued.splice(index, 1);
              const steered = state.steered as QueueItem[];
              if (!steered.some((item) => item.id === interrupt.anchorId))
                steered.splice(Math.min(interrupt.source.index, steered.length), 0, receipt);
              state.queued = queued;
              state.steered = steered;
            }
          }
          state.interrupt = undefined;
        } else state.interrupt = { ...interrupt, phase: "confirmed" };
        return true;
      },
    })).result;
  }

  async claimNextDispatch(
    commandId: string,
    input: { sessionId: string; promptEntryId: string; stillWorking?: boolean },
  ): Promise<
    | { kind: "empty"; revision: number }
    | { kind: "hold"; heldCount: number; revision: number }
    | { kind: "deliver"; promptEntryId: string; items: QueueItem[]; interrupted: boolean; revision: number }
  > {
    if (!input.promptEntryId || input.promptEntryId.length > 256)
      throw new Error("Invalid next prompt dispatch identity");
    const mutation = await this.mutate({
      commandId,
      sessionId: input.sessionId,
      kind: "delivery_next_dispatch_claimed",
      identity: input,
      mutate(state) {
        if (state.dispatch) throw new Error("A prompt dispatch is already active");
        const interrupt = state.interrupt;
        const queued = state.queued as QueueItem[];
        if (!queued.length) {
          state.interrupt = undefined;
          return { kind: "empty" as const };
        }
        const anchorQueued = interrupt !== undefined && queued.some((item) => item.id === interrupt.anchorId);
        if (interrupt && !anchorQueued) state.interrupt = undefined;
        const confirmedInterrupt = !!(anchorQueued && interrupt?.phase === "confirmed");
        const retryDispatchId = queued.find((item) => item.retryDispatchId)?.retryDispatchId;
        const plan = retryDispatchId
          ? {
              kind: "deliver" as const,
              batch: queued.filter((item) => item.retryDispatchId === retryDispatchId),
              rest: queued.filter((item) => item.retryDispatchId !== retryDispatchId),
            }
          : selectQueueBatch(queued, {
              soloId: confirmedInterrupt ? interrupt?.soloId : undefined,
              interruptMark: confirmedInterrupt,
              stillWorking: input.stillWorking,
            });
        if (plan.kind === "hold") return plan;
        const batchOwnsInterrupt = !!(anchorQueued && interrupt &&
          plan.batch.some((item) => item.id === interrupt.anchorId));
        if (batchOwnsInterrupt && interrupt?.phase !== "confirmed")
          return { kind: "hold" as const, heldCount: plan.batch.length };
        const applyInterrupt = confirmedInterrupt && batchOwnsInterrupt;
        if (applyInterrupt) state.interrupt = undefined;
        const promptEntryId = retryDispatchId || plan.batch[0]?.promptEntryId || input.promptEntryId;
        if (!promptEntryId || promptEntryId.length > 256)
          throw new Error("Invalid claimed prompt dispatch identity");
        state.queued = plan.rest;
        state.dispatch = {
          promptEntryId,
          items: plan.batch,
          ...(applyInterrupt && interrupt ? { interrupt } : {}),
        };
        return {
          kind: "deliver" as const,
          promptEntryId,
          items: plan.batch,
          interrupted: applyInterrupt,
        };
      },
    });
    return { ...mutation.result, revision: mutation.state.revision };
  }

  async claimDispatch(
    commandId: string,
    input: {
      sessionId: string;
      items: Array<{ id?: string; promptEntryId?: string } & Record<string, unknown>>;
      promptEntryId: string;
      kind?: "create";
      requireQueued?: boolean;
    },
  ): Promise<{ promptEntryId: string; items: unknown[]; revision: number }> {
    const mutation = await this.mutate({
      commandId,
      sessionId: input.sessionId,
      kind: "delivery_dispatch_claimed",
      identity: input,
      mutate(state) {
        const existing = state.dispatch as { promptEntryId?: string; items?: unknown[] } | undefined;
        if (existing?.promptEntryId === input.promptEntryId) return existing;
        if (existing) throw new Error("A prompt dispatch is already active");
        const ids = new Set(input.items.flatMap(
          (item) => [item.id, item.promptEntryId].filter(Boolean) as string[],
        ));
        const queued = state.queued as Array<{ id?: string; promptEntryId?: string }>;
        if (input.requireQueued) {
          const queuedIds = new Set(queued.flatMap(
            (item) => [item.id, item.promptEntryId].filter(Boolean) as string[],
          ));
          if (!input.items.every((item) =>
            !!(item.id || item.promptEntryId) &&
            !![item.id, item.promptEntryId].find((id) => id && queuedIds.has(id))
          )) throw new Error("Queued prompt changed before dispatch claim");
        }
        state.queued = queued.filter((item) =>
          !((item.id && ids.has(item.id)) ||
            (item.promptEntryId && ids.has(item.promptEntryId)))
        );
        state.dispatch = {
          promptEntryId: input.promptEntryId,
          items: input.items,
          ...(input.kind ? { kind: input.kind } : {}),
        };
        return state.dispatch;
      },
    });
    const dispatch = mutation.result as { promptEntryId: string; items: unknown[] };
    return { ...dispatch, revision: mutation.state.revision };
  }

  async settleDispatch(
    commandId: string,
    sessionId: string,
    promptEntryId: string,
    succeeded: boolean,
  ): Promise<boolean> {
    const current = (await this.snapshot(sessionId)).dispatch as
      | { promptEntryId?: string }
      | undefined;
    if (current?.promptEntryId !== promptEntryId) return false;
    await this.mutate({
      commandId,
      sessionId,
      kind: succeeded ? "delivery_dispatch_acknowledged" : "delivery_dispatch_failed",
      identity: { promptEntryId, succeeded },
      mutate(state) {
        const dispatch = state.dispatch as
          | { promptEntryId?: string; items?: unknown[]; interrupt?: DurableDeliveryState["interrupt"] }
          | undefined;
        if (dispatch?.promptEntryId !== promptEntryId)
          throw new Error("Prompt dispatch changed before settlement");
        if (!succeeded) {
          const restored = (dispatch.items ?? []).map((item, index) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? { ...(item as Record<string, unknown>), retryDispatchId: promptEntryId,
                  ...(index === 0 ? { promptEntryId } : {}) }
              : item
          );
          const restoredIds = new Set(
            (restored as Array<{ id?: string }>).map((item) => item.id).filter(Boolean),
          );
          state.queued = [
            ...restored,
            ...(state.queued as Array<{ id?: string }>).filter(
              (item) => !item.id || !restoredIds.has(item.id),
            ),
          ];
          if (dispatch.interrupt) {
            if (state.interrupt) throw new Error("A successor prompt interrupt is already pending");
            state.interrupt = { ...dispatch.interrupt, phase: "confirmed" };
          }
        }
        state.dispatch = undefined;
      },
    });
    return true;
  }
}
