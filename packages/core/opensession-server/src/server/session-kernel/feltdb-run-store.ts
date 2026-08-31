import { createHash } from "node:crypto";
import { nextRunState, type RunState } from "./run-state-machine";
import type {
  DurableRunState,
  DurableTurnState,
  RunEventDecision,
  RunEventDecisionResult,
} from "./store";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
  type SessionDecisionHead,
  type VersionedSessionDecisionHead,
} from "./feltdb-decision-store";

type MigratedTurnRecord = {
  cancel?: DurableTurnState["cancel"];
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(
      (value as Record<string, unknown>)[key],
    )}`)
    .join(",")}}`;
}

function inputHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function durableRun(head: VersionedSessionDecisionHead): DurableRunState {
  return { ...head.run, changeSeq: head.changeSeq };
}

export function decideFeltDbRunEvent(
  head: VersionedSessionDecisionHead,
  input: RunEventDecision,
  canceledDispatch: DurableTurnState["cancel"] | undefined,
  now = Date.now(),
): { result: RunEventDecisionResult; nextRun?: SessionDecisionHead["run"] } {
  const prior = durableRun(head);
  const from = prior.state as RunState;
  const stale = (): { result: RunEventDecisionResult } => ({
    result: {
      accepted: false,
      from,
      to: from,
      reason: "stale_run",
      currentRunId: prior.currentRunId,
      rejectedRunId: input.runKey,
      state: prior,
    },
  });
  if (
    input.runKey &&
    ["turn_end", "run_failed", "start_failed", "start_aborted"].includes(input.event) &&
    prior.currentRunId !== input.runKey
  ) return stale();
  const to = nextRunState(from, input.event);
  if (!to) return {
    result: {
      accepted: false,
      from,
      to: from,
      reason: "invalid_transition",
      state: prior,
    },
  };
  if (
    (input.event === "run_registered" || input.event === "boot_journal_found") &&
    input.runKey &&
    canceledDispatch?.runId === input.runKey &&
    canceledDispatch.runGeneration === prior.generation
  ) return stale();
  if (
    (input.event === "prompt" || input.event === "run_registered") &&
    input.runKey &&
    prior.currentRunId &&
    prior.currentRunId !== input.runKey &&
    ["preparing", "starting", "running", "ask_blocked", "interrupted", "reattaching"]
      .includes(from)
  ) return stale();
  const claimsRun = !!input.runKey &&
    ["prompt", "run_registered", "boot_journal_found"].includes(input.event);
  const generation = claimsRun && prior.currentRunId !== input.runKey
    ? prior.generation + 1
    : prior.generation;
  const currentRunId = ["idle", "stopped", "failed"].includes(to)
    ? undefined
    : claimsRun
      ? input.runKey
      : prior.currentRunId;
  const nextRun: SessionDecisionHead["run"] = {
    state: to,
    since: new Date(now).toISOString(),
    lastEvent: input.event,
    generation,
    ...(currentRunId ? { currentRunId } : {}),
  };
  return {
    nextRun,
    result: {
      accepted: true,
      from,
      to,
      state: { ...nextRun, changeSeq: head.changeSeq + 1 },
    },
  };
}

/** Managed FeltDB implementation of the complete run-state decision boundary. */
export class FeltDbRunStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  async runState(sessionId: string): Promise<DurableRunState | undefined> {
    const head = await this.decisions.head(sessionId);
    return head ? durableRun(head) : undefined;
  }

  async applyRunEvent(
    commandId: string,
    input: RunEventDecision,
    now = Date.now(),
  ): Promise<RunEventDecisionResult> {
    const head = await this.decisions.head(input.sessionId);
    if (!head) throw new Error(`Session ${input.sessionId} has no FeltDB authority`);
    const turn = await this.decisions.record<MigratedTurnRecord>(
      KERNEL_COLLECTIONS.turns,
      kernelRecordId("turn", input.sessionId),
    );
    const decision = decideFeltDbRunEvent(head, input, turn?.cancel, now);
    if (!decision.nextRun) return decision.result;
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:run:${input.sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "run",
      inputHash: inputHash(input),
      observedHead: head,
      nextRun: decision.nextRun,
      changeKind: "run_state",
      changePayload: { state: decision.nextRun.state, event: input.event, detail: input.detail },
      result: decision.result,
      now,
    });
  }
}
