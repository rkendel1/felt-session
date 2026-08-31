import { createHash } from "node:crypto";
import { nextCreationState } from "./creation-state-machine";
import type {
  CreationEventDecision,
  CreationEventDecisionResult,
  DurableCreationState,
} from "./store";
import {
  SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS,
  SESSION_KERNEL_MAX_OPENING_PLAN_BYTES,
} from "./store";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type DecisionEffect,
  type SessionDecisionHead,
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";

type StoredCreation = DurableCreationState & {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  __version: number;
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function creationId(sessionId: string): string {
  return kernelRecordId("creation", sessionId);
}

function validSetupPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  if (keys.some((key) =>
    !["branch", "workspaceId", "attachments", "resolved"].includes(key) ||
    patch[key] === undefined
  )) return false;
  if (
    patch.branch !== undefined &&
    (typeof patch.branch !== "string" || !patch.branch || patch.branch.length > 512)
  ) return false;
  if (
    patch.workspaceId !== undefined &&
    (typeof patch.workspaceId !== "string" || !patch.workspaceId || patch.workspaceId.length > 256)
  ) return false;
  if (patch.attachments !== undefined) {
    if (!Array.isArray(patch.attachments) || patch.attachments.length > 32) return false;
    for (const item of patch.attachments) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const attachment = item as Record<string, unknown>;
      if (
        typeof attachment.attachmentId !== "string" ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(attachment.attachmentId) ||
        typeof attachment.name !== "string" || !attachment.name || attachment.name.length > 1024 ||
        typeof attachment.sourceRef !== "string" ||
        !attachment.sourceRef.startsWith("uploads:") || attachment.sourceRef.length > 8192 ||
        typeof attachment.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(attachment.digest)
      ) return false;
    }
  }
  if (patch.resolved !== undefined) {
    if (!patch.resolved || typeof patch.resolved !== "object" || Array.isArray(patch.resolved))
      return false;
    const resolved = patch.resolved as Record<string, unknown>;
    if (["gitEnv", "images", "materializeWorktree"].some((key) => key in resolved))
      return false;
  }
  return true;
}

export function decideFeltDbCreationEvent(
  head: VersionedSessionDecisionHead,
  prior: DurableCreationState | undefined,
  input: CreationEventDecision,
  now = Date.now(),
): {
  result: CreationEventDecisionResult;
  next?: DurableCreationState;
  effects?: DecisionEffect[];
  nextRun?: SessionDecisionHead["run"];
} {
  const reject = (reason: NonNullable<CreationEventDecisionResult["reason"]>) => ({
    result: { accepted: false, from: prior?.state, to: prior?.state, reason, state: prior },
  });
  if (prior && prior.identity !== input.identity) return reject("identity_mismatch");
  const requiresEffectResult = !!prior?.currentEffectId &&
    ["preparation_started", "opening_dispatched", "succeeded", "failed", "cancelled"]
      .includes(input.event);
  if (
    (requiresEffectResult || input.effectId !== undefined) &&
    prior?.currentEffectId !== input.effectId
  ) return reject("stale_effect");
  const from = prior?.state;
  const to = nextCreationState(from, input.event);
  if (!to) return reject("invalid_transition");
  const generation = prior?.generation ?? 1;
  const effect = input.effect;
  const completedEffectIds = [...(prior?.completedEffectIds ?? [])];
  const completesNewEffect = input.effectId !== undefined &&
    !completedEffectIds.includes(input.effectId);
  if (
    (completesNewEffect || effect !== undefined) &&
    completedEffectIds.length >= SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS
  ) return reject("effect_receipt_capacity");
  if (completesNewEffect) completedEffectIds.push(input.effectId!);
  const invalidEffect =
    (input.event === "opening_dispatched" && !effect) ||
    (input.nextEffectId !== undefined && !effect) ||
    (!!effect && input.nextEffectId !== effect.effectKey) ||
    (!!effect && completedEffectIds.includes(effect.effectKey)) ||
    (!!effect && (
      effect.payload.creationIdentity !== input.identity ||
      effect.payload.creationGeneration !== generation
    )) ||
    (!!effect && input.event === "opening_dispatched" && effect.kind !== "creation_opening_turn") ||
    (!!effect && input.event === "preparation_started" && effect.kind === "creation_opening_turn") ||
    (!!effect && !["preparation_started", "opening_dispatched"].includes(input.event));
  if (invalidEffect) return reject("invalid_effect");
  let setupPlan = prior?.setupPlan;
  if (input.planPatch !== undefined) {
    if (input.event !== "plan" || !validSetupPatch(input.planPatch))
      return reject("invalid_setup_plan");
    const candidate = { ...(setupPlan ?? {}) };
    for (const [key, value] of Object.entries(input.planPatch)) {
      if (Object.hasOwn(candidate, key) && JSON.stringify(candidate[key]) !== JSON.stringify(value))
        return reject("setup_plan_conflict");
      candidate[key] = value;
    }
    if (Buffer.byteLength(JSON.stringify(candidate)) > SESSION_KERNEL_MAX_OPENING_PLAN_BYTES)
      return reject("invalid_setup_plan");
    setupPlan = candidate;
  }
  const openingPlanText = input.openingPlan === undefined
    ? undefined
    : JSON.stringify(input.openingPlan);
  if (
    (input.event === "opening_dispatched" && (
      !openingPlanText || Buffer.byteLength(openingPlanText) > SESSION_KERNEL_MAX_OPENING_PLAN_BYTES
    )) ||
    (input.event !== "opening_dispatched" && input.openingPlan !== undefined)
  ) return reject("invalid_opening_plan");
  if (["opening_dispatched", "ready", "failed", "cancelled"].includes(to)) setupPlan = undefined;
  const openingPlan = ["ready", "failed", "cancelled"].includes(to)
    ? undefined
    : input.openingPlan ?? prior?.openingPlan;
  const currentEffectId = ["ready", "failed", "cancelled"].includes(to)
    ? undefined
    : effect?.effectKey ?? (input.effectId === undefined ? prior?.currentEffectId : undefined);
  const next: DurableCreationState = {
    identity: input.identity,
    state: to,
    generation,
    ...(currentEffectId ? { currentEffectId } : {}),
    completedEffectIds,
    ...(setupPlan ? { setupPlan } : {}),
    ...(openingPlan ? { openingPlan } : {}),
    changeSeq: head.changeSeq + 1,
    updatedAt: now,
  };
  const nextRun = head.run.since === new Date(0).toISOString()
    ? { ...head.run, since: new Date(now).toISOString() }
    : head.run;
  return {
    next,
    nextRun,
    ...(effect ? { effects: [{ effectKey: effect.effectKey, kind: effect.kind, payload: effect.payload }] } : {}),
    result: { accepted: true, from, to, state: next },
  };
}

/** Managed FeltDB creation state, journal, and physical-effect admission. */
export class FeltDbCreationStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  async creationState(sessionId: string): Promise<DurableCreationState | undefined> {
    const [head, value] = await Promise.all([
      this.decisions.head(sessionId),
      this.decisions.record<StoredCreation>(KERNEL_COLLECTIONS.creation, creationId(sessionId)),
    ]);
    if (!head || !value || value.decisionEpoch !== head.decisionEpoch) return undefined;
    const {
      schemaVersion: _, sessionId: __, decisionEpoch: ___, __version: ____, ...state
    } = value;
    return state;
  }

  async applyCreationEvent(
    commandId: string,
    input: CreationEventDecision,
    now = Date.now(),
  ): Promise<CreationEventDecisionResult> {
    const [head, stored] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.decisions.record<StoredCreation>(KERNEL_COLLECTIONS.creation, creationId(input.sessionId)),
    ]);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const prior = stored?.decisionEpoch === head.decisionEpoch
      ? (({ schemaVersion: _, sessionId: __, decisionEpoch: ___, __version: ____, ...state }) => state)(stored)
      : undefined;
    const decision = decideFeltDbCreationEvent(head, prior, input, now);
    if (!decision.next) return decision.result;
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:creation:${input.sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "creation",
      inputHash: digest(input),
      observedHead: head,
      nextRun: decision.nextRun,
      changeKind: "creation_state",
      changePayload: {
        identity: input.identity,
        state: decision.next.state,
        event: input.event,
        effectId: input.effectId,
        nextEffectId: input.nextEffectId,
        detail: input.detail,
      },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.creation,
        id: creationId(input.sessionId),
        value: {
          schemaVersion: 1,
          sessionId: input.sessionId,
          decisionEpoch: head.decisionEpoch,
          ...decision.next,
        },
        ...(stored ? { ifVersion: stored.__version } : { requireAbsent: true }),
      }],
      effects: decision.effects,
      result: decision.result,
      now,
    });
  }
}
