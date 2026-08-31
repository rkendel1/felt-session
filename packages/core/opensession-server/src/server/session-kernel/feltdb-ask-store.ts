import { createHash } from "node:crypto";
import type { AtomicTransactionOperationRequest } from "@feltdb/core";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type SessionDecisionHead,
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";

type AskRecord = {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  revision: number;
  record: unknown;
  updatedAt: number;
  __version: number;
};

type AnswerableAsk = {
  questionId?: string;
  answer?: { requestId: string; answers: Record<string, string> | null };
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

function askId(sessionId: string): string {
  return kernelRecordId("asks", sessionId);
}

function nextRun(head: VersionedSessionDecisionHead, now: number): SessionDecisionHead["run"] {
  return head.run.since === new Date(0).toISOString()
    ? { ...head.run, since: new Date(now).toISOString() }
    : head.run;
}

export function decideFeltDbAskAnswer(
  record: AnswerableAsk | undefined,
  questionId: string | null,
  answers: Record<string, string> | null,
  answeredVia: string,
): { result: { matched: boolean; answers?: Record<string, string> | null }; next?: AnswerableAsk } {
  if (!record) return { result: { matched: false } };
  if (record.answer) return {
    result: record.answer.requestId === answeredVia
      ? { matched: true, answers: record.answer.answers }
      : { matched: false },
  };
  if (questionId !== null && (record.questionId ?? null) !== questionId)
    return { result: { matched: false } };
  return {
    result: { matched: true },
    next: { ...record, answer: { requestId: answeredVia, answers } },
  };
}

/** Managed FeltDB implementation of ask reads and set/answer/delete decisions. */
export class FeltDbAskStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  private record(sessionId: string): Promise<AskRecord | undefined> {
    return this.decisions.record(KERNEL_COLLECTIONS.asks, askId(sessionId));
  }

  async snapshot(sessionId: string): Promise<unknown | undefined> {
    const [head, record] = await Promise.all([
      this.decisions.head(sessionId),
      this.record(sessionId),
    ]);
    return head && record?.decisionEpoch === head.decisionEpoch ? record.record : undefined;
  }

  async set(commandId: string, sessionId: string, value: unknown, now = Date.now()): Promise<void> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.record(sessionId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    const activePrior = prior?.decisionEpoch === head.decisionEpoch ? prior : undefined;
    const operation: AtomicTransactionOperationRequest = {
      collection: KERNEL_COLLECTIONS.asks,
      id: askId(sessionId),
      value: {
        schemaVersion: 1,
        sessionId,
        decisionEpoch: head.decisionEpoch,
        revision: (activePrior?.revision ?? 0) + 1,
        record: value,
        updatedAt: now,
      },
      ...(prior ? { ifVersion: prior.__version } : { requireAbsent: true }),
    };
    await this.decisions.commitDecision({
      transactionId: `opensession:kernel:ask:set:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "ask_set",
      inputHash: digest({ sessionId, value }),
      observedHead: head,
      nextRun: nextRun(head, now),
      changeKind: "ask_state",
      changePayload: { active: true },
      domainOperations: [operation],
      result: null,
      now,
    });
  }

  async answer(
    commandId: string,
    sessionId: string,
    questionId: string | null,
    answers: Record<string, string> | null,
    answeredVia: string,
    now = Date.now(),
  ): Promise<{ matched: boolean; answers?: Record<string, string> | null }> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.record(sessionId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    const activePrior = prior?.decisionEpoch === head.decisionEpoch ? prior : undefined;
    const answer = decideFeltDbAskAnswer(
      activePrior?.record as AnswerableAsk | undefined,
      questionId,
      answers,
      answeredVia,
    );
    if (!answer.next) return answer.result;
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:ask:answer:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "ask_answer",
      inputHash: digest({ sessionId, questionId, answers, answeredVia }),
      observedHead: head,
      nextRun: nextRun(head, now),
      changeKind: "ask_state",
      changePayload: { active: true },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.asks,
        id: askId(sessionId),
        value: {
          schemaVersion: 1,
          sessionId,
          decisionEpoch: head.decisionEpoch,
          revision: activePrior!.revision + 1,
          record: answer.next,
          updatedAt: now,
        },
        ifVersion: activePrior!.__version,
      }],
      result: answer.result,
      now,
    });
  }

  async delete(commandId: string, sessionId: string, now = Date.now()): Promise<boolean> {
    const [head, prior] = await Promise.all([
      this.decisions.head(sessionId),
      this.record(sessionId),
    ]);
    if (!head) throw new Error(`Session ${sessionId} has no FeltDB authority`);
    if (!prior || prior.decisionEpoch !== head.decisionEpoch) return false;
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:ask:delete:${sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "ask_delete",
      inputHash: digest({ sessionId }),
      observedHead: head,
      nextRun: nextRun(head, now),
      changeKind: "ask_state",
      changePayload: { active: false },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.asks,
        id: askId(sessionId),
        ifVersion: prior.__version,
      }],
      result: true,
      now,
    });
  }
}
