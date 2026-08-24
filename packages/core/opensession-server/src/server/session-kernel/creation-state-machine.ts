/** Pure creation reducer. Physical setup is emitted separately as typed effects. */

export type CreationState =
  | "planned"
  | "preparing"
  | "opening_dispatched"
  | "ready"
  | "failed"
  | "cancelled";

export type CreationEvent =
  | "plan"
  | "preparation_started"
  | "opening_dispatched"
  | "succeeded"
  | "failed"
  | "cancelled";

export const CREATION_STATE_TRANSITIONS: Record<
  CreationState,
  Partial<Record<CreationEvent, CreationState>>
> = {
  planned: {
    plan: "planned",
    preparation_started: "preparing",
    failed: "failed",
    cancelled: "cancelled",
  },
  preparing: {
    plan: "preparing",
    preparation_started: "preparing",
    opening_dispatched: "opening_dispatched",
    failed: "failed",
    cancelled: "cancelled",
  },
  opening_dispatched: {
    opening_dispatched: "opening_dispatched",
    succeeded: "ready",
    failed: "failed",
    cancelled: "cancelled",
  },
  ready: {
    succeeded: "ready",
  },
  failed: {
    failed: "failed",
  },
  cancelled: {
    cancelled: "cancelled",
  },
};

export function nextCreationState(
  state: CreationState | undefined,
  event: CreationEvent,
): CreationState | undefined {
  if (state === undefined) return event === "plan" ? "planned" : undefined;
  return CREATION_STATE_TRANSITIONS[state][event];
}
