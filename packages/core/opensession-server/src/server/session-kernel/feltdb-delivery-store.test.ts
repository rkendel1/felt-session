import { describe, expect, test } from "bun:test";
import { prepareFeltDbDeliveryMutation } from "./feltdb-delivery-store";

describe("managed FeltDB delivery decisions", () => {
  test("retires only a completed creation dispatch", () => {
    const prior = {
      revision: 2,
      queued: [],
      dispatch: { promptEntryId: "prompt-a", kind: "create" },
      steered: [],
      pendingSteers: [],
      updatedAt: 1,
    };
    const working = prepareFeltDbDeliveryMutation(prior, {
      identity: "identity-a",
      state: "ready",
      generation: 1,
      completedEffectIds: ["opening:prompt-a"],
      changeSeq: 1,
      updatedAt: 1,
    }, "delivery_queued_enqueue");
    expect(working.dispatch).toBeUndefined();
    expect(prior.dispatch).toBeDefined();
  });
});
