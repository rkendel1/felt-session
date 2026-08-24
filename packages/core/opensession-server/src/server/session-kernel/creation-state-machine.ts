/** Pure creation reducer. Physical setup is emitted separately as typed effects. */

export type CreationState =
  | "planned"
  | "preparing"
  | "opening_dispatched"
  | "ready"
  | "failed";

export type CreationEvent =
  | "plan"
  | "preparation_started"
  | "opening_dispatched"
  | "succeeded"
  | "failed";

export const CREATION_STATE_TRANSITIONS: Record<
  CreationState,
  Partial<Record<CreationEvent, CreationState>>
> = {
  planned: {
    plan: "planned",
    preparation_started: "preparing",
    failed: "failed",
  },
  preparing: {
    plan: "preparing",
    preparation_started: "preparing",
    opening_dispatched: "opening_dispatched",
    failed: "failed",
  },
  opening_dispatched: {
    opening_dispatched: "opening_dispatched",
    succeeded: "ready",
    failed: "failed",
  },
  ready: {
    succeeded: "ready",
  },
  failed: {
    failed: "failed",
  },
};

export function nextCreationState(
  state: CreationState | undefined,
  event: CreationEvent,
): CreationState | undefined {
  if (state === undefined) return event === "plan" ? "planned" : undefined;
  return CREATION_STATE_TRANSITIONS[state][event];
}
