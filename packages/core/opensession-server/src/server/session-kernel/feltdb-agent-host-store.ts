import { createHash } from "node:crypto";
import {
  decodeAgentHostPlanRegistration,
  type AgentHostPlanRegistration,
  type AgentHostPlanRegistrationResult,
} from "./store";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
} from "./feltdb-decision-store";

type StoredAgentHostPlan = AgentHostPlanRegistration & {
  schemaVersion: 1;
  decisionEpoch: number;
  hostId?: string;
  hostGenerationHighWater: number;
  supervisorHighWater: number;
  updatedAt: number;
  __version: number;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function planId(sessionId: string): string {
  return kernelRecordId("agent_host_plan", sessionId);
}

const LIVE_RUN_STATES = [
  "starting", "running", "ask_blocked", "interrupted", "reattaching",
];

/** Managed FeltDB transcript-destination plan fence. */
export class FeltDbAgentHostStore {
  constructor(private readonly decisions: FeltDbSessionDecisionStore) {}

  private record(sessionId: string): Promise<StoredAgentHostPlan | undefined> {
    return this.decisions.record(KERNEL_COLLECTIONS.agentHostPlans, planId(sessionId));
  }

  async assertTranscriptDestinationFence(input: {
    sessionId: string;
    runId: string;
    turnId: string;
    generation: number;
  }): Promise<void> {
    const [head, plan] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
    ]);
    if (
      !head || head.authority.lifecycle !== "active" ||
      head.run.currentRunId !== input.runId || head.run.generation !== input.generation ||
      !LIVE_RUN_STATES.includes(head.run.state)
    ) throw new Error(`Transcript destination run fence rejected ${input.sessionId}`);
    if (
      !plan || plan.decisionEpoch !== head.decisionEpoch ||
      plan.runId !== input.runId || plan.generation !== input.generation ||
      plan.turnId !== input.turnId
    ) throw new Error(`Transcript destination turn fence rejected ${input.sessionId}`);
  }

  async registerPlan(
    commandId: string,
    input: AgentHostPlanRegistration,
    now = Date.now(),
  ): Promise<AgentHostPlanRegistrationResult> {
    if (!decodeAgentHostPlanRegistration(input))
      return { accepted: false, reason: "invalid_plan" };
    const [head, storedPrior] = await Promise.all([
      this.decisions.head(input.sessionId),
      this.record(input.sessionId),
    ]);
    if (!head || head.authority.lifecycle !== "active")
      throw new Error(`Session ${input.sessionId} was deleted`);
    if (head.run.currentRunId !== input.runId || head.run.generation !== input.generation)
      return { accepted: false, reason: "stale_run" };
    if (!LIVE_RUN_STATES.includes(head.run.state))
      return { accepted: false, reason: "terminal_run" };
    const prior = storedPrior?.decisionEpoch === head.decisionEpoch ? storedPrior : undefined;
    if (prior?.runId === input.runId && prior.generation === input.generation) {
      return prior.turnId === input.turnId && prior.planHash === input.planHash
        ? { accepted: true, replayed: true }
        : { accepted: false, reason: "plan_mismatch" };
    }
    const result = { accepted: true, replayed: false } as const;
    return this.decisions.commitDecision({
      transactionId: `opensession:kernel:agent_host:plan:${input.sessionId}:${commandId}`,
      operationId: commandId,
      operationKind: "agent_host_plan",
      inputHash: digest(input),
      observedHead: head,
      changeKind: "agent_host_plan_registered",
      changePayload: { runId: input.runId, turnId: input.turnId, generation: input.generation },
      domainOperations: [{
        collection: KERNEL_COLLECTIONS.agentHostPlans,
        id: planId(input.sessionId),
        value: {
          schemaVersion: 1,
          decisionEpoch: head.decisionEpoch,
          ...input,
          ...(prior?.hostId ? { hostId: prior.hostId } : {}),
          hostGenerationHighWater: prior?.hostGenerationHighWater ?? 0,
          supervisorHighWater: prior?.supervisorHighWater ?? 0,
          updatedAt: now,
        },
        ...(storedPrior ? { ifVersion: storedPrior.__version } : { requireAbsent: true }),
      }],
      result,
      now,
    });
  }
}
