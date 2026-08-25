import type { AskActorRequest } from "./ask-protocol";
import type { DeliveryActorRequest } from "./delivery-protocol";
import type { CreationActorEffect } from "./creation-effect-protocol";
import type { TurnActorRequest } from "./turn-protocol";
import type { TimerActorRequest } from "./timer-protocol";
import type {
  CreationEventDecision,
  RunEventDecision,
} from "./store";

/**
 * Temporary physical work that still executes as a gateway callback.
 *
 * Adding an operation is intentionally a protocol change. The ownership test
 * also fixes the production call-site budget, so migration can only shrink
 * this adapter unless a reviewer deliberately changes both fences.
 */
export const LEGACY_GATEWAY_EFFECT_OPERATIONS = Object.freeze([
  "delete_session",
  "session_file_updated",
  "websocket_command",
] as const);

export const LEGACY_GATEWAY_EFFECT_SITE_BASELINE = 2;

export type LegacyGatewayEffectOperation =
  (typeof LEGACY_GATEWAY_EFFECT_OPERATIONS)[number];

export type LegacyGatewayEffect<TPayload = unknown> = {
  kind: "legacy_gateway_effect";
  operation: LegacyGatewayEffectOperation;
  commandId: string;
  payload?: TPayload;
  source?: string;
  replaySafe?: boolean;
  retryFailures?: boolean;
};

export type LegacyGatewayEffectInput<TPayload = unknown> = Omit<
  LegacyGatewayEffect<TPayload>,
  "kind" | "operation" | "commandId"
> & { requestId: string };

export function legacyGatewayEffect<TPayload = unknown>(
  operation: LegacyGatewayEffectOperation,
  input: LegacyGatewayEffectInput<TPayload>,
): LegacyGatewayEffect<TPayload> {
  const { requestId: commandId, ...effect } = input;
  return { kind: "legacy_gateway_effect", operation, commandId, ...effect };
}

export type RunFence = {
  runId: string;
  generation: number;
};

export type SessionActorReducerCommand =
  | {
      kind: "creation_event";
      commandId: string;
      decision: CreationEventDecision;
    }
  | {
      kind: "run_event";
      commandId: string;
      decision: RunEventDecision;
    }
  | {
      kind: "delivery";
      commandId: string;
      request: DeliveryActorRequest;
    }
  | {
      kind: "ask";
      commandId: string;
      request: AskActorRequest;
    }
  | {
      kind: "turn";
      commandId: string;
      request: TurnActorRequest;
    }
  | {
      kind: "timer";
      commandId: string;
      request: TimerActorRequest;
    };

export type SessionActorCommand =
  | SessionActorReducerCommand
  | {
      kind: "effect_result";
      commandId: string;
      result: SessionActorEffectResult;
    }
  | LegacyGatewayEffect;

export type SessionActorEvent =
  | { kind: "command_accepted"; commandId: string }
  | { kind: "command_completed"; commandId: string }
  | { kind: "command_failed"; commandId: string; error: string }
  | { kind: "effect_emitted"; commandId: string; effectId: string }
  | { kind: "effect_resulted"; commandId: string; effectId: string }
  | {
      kind: "stale_result_rejected";
      commandId: string;
      effectId: string;
      actorEpoch: string;
    };

export type HumanAskDeliverEffect = {
  kind: "human_ask_deliver";
  payload: {
    askId: string;
    skipUi: boolean;
  };
};

export type DeliveryInterruptCancelEffect = {
  kind: "delivery_interrupt_cancel";
  payload: {
    interruptId: string;
    /** Exact dispatch identity for schema 13+. */
    dispatchId?: string;
    /** Schema-12 compatibility for already-durable effects. */
    runIds?: string[];
    runGeneration: number;
  };
};

export type TurnCancelEffect = {
  kind: "turn_cancel";
  payload: {
    cancelId: string;
    dispatchId: string;
    runGeneration: number;
  };
};

export type TurnOutcomeProjectEffect = {
  kind: "turn_outcome_project";
  payload: {
    projectionId: string;
    runId: string;
    runGeneration: number;
    errorMessage: string | null;
    engineSessionId?: string;
    noticePersisted: boolean;
    noticeLabel?: string;
    projectedAt: string;
  };
};

export type SessionActorEffect =
  | HumanAskDeliverEffect
  | DeliveryInterruptCancelEffect
  | TurnCancelEffect
  | TurnOutcomeProjectEffect
  | CreationActorEffect;
export type SessionActorEffectKind = SessionActorEffect["kind"];
export type SessionActorEffectFor<K extends SessionActorEffectKind> = Extract<
  SessionActorEffect,
  { kind: K }
>;
export type StagedSessionActorEffect = {
  [K in SessionActorEffectKind]: SessionActorEffectFor<K> & {
    effectKey: string;
  };
}[SessionActorEffectKind];

export type SessionActorEffectEnvelope<
  TEffect extends SessionActorEffect = SessionActorEffect,
> = TEffect & {
  actorEpoch: string;
  commandId: string;
  effectId: string;
  run?: RunFence;
};

export type SessionActorEffectResult = {
  kind: "effect_result";
  actorEpoch: string;
  commandId: string;
  effectId: string;
  run?: RunFence;
} & (
  | { outcome: "succeeded" }
  | { outcome: "failed"; error: string; retryable: boolean }
  | { outcome: "indeterminate"; error: string }
);

export type SessionActorCommandResult<TResult = unknown> = {
  kind: "command_result";
  actorEpoch: string;
  commandId: string;
  run?: RunFence;
} & (
  | { outcome: "completed"; result: TResult }
  | { outcome: "failed"; error: string; retryable: boolean }
  | { outcome: "indeterminate"; error: string }
);
