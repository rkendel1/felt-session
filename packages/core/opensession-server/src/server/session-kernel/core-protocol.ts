import type {
  SessionActorEffectFor,
  SessionActorEffectKind,
} from "./lifecycle-protocol";

export type CoreActorRequest =
  | {
      op: "enqueue_effect";
      sessionId: string;
      kind: SessionActorEffectKind;
      payload: SessionActorEffectFor<SessionActorEffectKind>["payload"];
      effectKey: string;
    }
  | { op: "clear"; sessionId: string }
  | { op: "tombstone"; sessionId: string };

export type CoreActorResult<T extends CoreActorRequest> =
  T extends { op: "enqueue_effect" } ? number : void;
