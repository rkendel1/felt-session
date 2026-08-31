import { describe, expect, test } from "bun:test";
import { decideFeltDbAskAnswer } from "./feltdb-ask-store";

describe("managed FeltDB ask decisions", () => {
  test("settles an unanswered matching ask", () => {
    expect(decideFeltDbAskAnswer(
      { questionId: "q1" },
      "q1",
      { q1: "yes" },
      "request-a",
    )).toMatchObject({
      result: { matched: true },
      next: { answer: { requestId: "request-a", answers: { q1: "yes" } } },
    });
  });

  test("replays the committed answer instead of retry input", () => {
    expect(decideFeltDbAskAnswer(
      { questionId: "q1", answer: { requestId: "request-a", answers: { q1: "yes" } } },
      "q1",
      { q1: "no" },
      "request-a",
    )).toEqual({ result: { matched: true, answers: { q1: "yes" } } });
  });

  test("rejects another answer identity", () => {
    expect(decideFeltDbAskAnswer(
      { questionId: "q1", answer: { requestId: "request-a", answers: null } },
      "q1",
      null,
      "request-b",
    )).toEqual({ result: { matched: false } });
  });
});
