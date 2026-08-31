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
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";

type StoredDelivery = DurableDeliveryState & {
  schemaVersion: 1;
  sessionId: string;
  __version: number;
};

type StoredCreation = DurableCreationState & {
  schemaVersion: 1;
  sessionId: string;
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
  const { schemaVersion: _, sessionId: __, __version: ___, ...value } = record;
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
    return deliveryState(await this.record(sessionId));
  }

  private async mutate<Result>(input: {
    commandId: string;
    sessionId: string;
    kind: string;
    identity: unknown;
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
    const prior = deliveryState(priorRecord);
    const creationState = creation
      ? (({ schemaVersion: _, sessionId: __, __version: ___, ...value }) => value)(creation)
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
        value: { schemaVersion: 1, sessionId: input.sessionId, ...state },
        ...(priorRecord ? { ifVersion: priorRecord.__version } : { requireAbsent: true }),
      }],
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
}
