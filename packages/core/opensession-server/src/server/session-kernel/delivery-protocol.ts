import type { DeliverySlot, DurableDeliveryState } from "./store";

type DeliveryItem = {
  id?: string;
  promptEntryId?: string;
} & Record<string, unknown>;

export type DeliveryActorRequest =
  | { op: "snapshot"; sessionId: string }
  | { op: "entries"; slot: DeliverySlot }
  | { op: "set"; sessionId: string; slot: DeliverySlot; value: unknown }
  | { op: "delete"; sessionId: string; slot: DeliverySlot }
  | { op: "clear_slot"; slot: DeliverySlot }
  | { op: "prepare_steer"; sessionId: string; itemId: string; item?: unknown }
  | { op: "accept_steer"; sessionId: string; itemId: string }
  | { op: "reject_steer"; sessionId: string; itemId: string }
  | { op: "settle_pending_steers" }
  | { op: "requeue_steers"; sessionId: string; items: unknown[] }
  | {
      op: "claim_next_dispatch";
      sessionId: string;
      promptEntryId: string;
      soloId?: string;
      interruptMark?: boolean;
      stillWorking?: boolean;
    }
  | {
      op: "claim_dispatch";
      sessionId: string;
      items: DeliveryItem[];
      promptEntryId: string;
      kind?: "create";
      requireQueued?: boolean;
    }
  | { op: "ack_dispatch"; sessionId: string; promptEntryId: string }
  | { op: "fail_dispatch"; sessionId: string; promptEntryId: string };

export type DeliveryMutationReply<TResult = unknown> = {
  revision?: number;
  result: TResult;
};

export function isDeliveryReadRequest(
  request: DeliveryActorRequest,
): request is Extract<DeliveryActorRequest, { op: "snapshot" | "entries" }> {
  return request.op === "snapshot" || request.op === "entries";
}

export type DeliveryActorResult<T extends DeliveryActorRequest> =
  T extends { op: "snapshot" }
    ? DurableDeliveryState
    : T extends { op: "entries" }
      ? Array<[string, unknown]>
      : T extends { op: "claim_dispatch" }
        ? { promptEntryId: string; items: unknown[]; revision: number }
        : T extends { op: "claim_next_dispatch" }
          ?
              | { kind: "empty"; revision: number }
              | { kind: "hold"; heldCount: number; revision: number }
              | {
                  kind: "deliver";
                  promptEntryId: string;
                  items: unknown[];
                  revision: number;
                }
        : T extends { op: "prepare_steer" }
          ? unknown | undefined
          : T extends {
                op:
                  | "delete"
                  | "ack_dispatch"
                  | "fail_dispatch"
                  | "accept_steer"
                  | "reject_steer";
              }
            ? boolean
            : T extends { op: "settle_pending_steers" | "requeue_steers" }
              ? number
              : void;
