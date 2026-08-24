import type { AskActorRequest } from "./ask-protocol";
import type { DeliveryActorRequest } from "./delivery-protocol";
import type { CreationActorEffect } from "./creation-effect-protocol";
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
  "answer_question",
  "cancel_session",
  "delete_session",
  "session_file_updated",
  "submit_prompt",
  "timer_fired",
  "websocket_command",
] as const);

export const LEGACY_GATEWAY_EFFECT_SITE_BASELINE = 6;

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

export type SessionActorEffect = HumanAskDeliverEffect | CreationActorEffect;
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
