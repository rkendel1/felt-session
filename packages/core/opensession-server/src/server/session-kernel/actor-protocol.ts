import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import type {
  DurableOutboxItem,
  DurableTimer,
  RunEventDecisionResult,
} from "./store";

export const SESSION_KERNEL_ACTOR_VERSION = 20;
export const SESSION_KERNEL_TRANSPORT_VERSION = 1;
export const SESSION_KERNEL_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const SESSION_KERNEL_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
export const SESSION_KERNEL_MAX_TRANSPORT_REQUESTS = 1024;

export type KernelActorAsyncRequest =
  | { t: "hello"; rpcId: string; version: number }
  | { t: "acknowledge"; rpcId: string; sessionId: string; requestId: string }
  | { t: "stats"; rpcId: string }
  | { t: "maintain"; rpcId: string }
  | {
      t: "runtime_work";
      rpcId: string;
      now: number;
      timerKinds: string[];
      effectKinds: string[];
      limit: number;
    }
;

export type KernelActorAsyncResponse =
  | { t: "ready"; rpcId: string; version: number; serviceEpoch?: string }
  | { t: "acknowledge_result"; rpcId: string }
  | { t: "maintain_result"; rpcId: string; pending: boolean }
  | {
      t: "stats_result";
      rpcId: string;
      stats: ReturnType<import("./store").SessionKernelStoreApi["stats"]>;
    }
  | {
      t: "runtime_work_result";
      rpcId: string;
      timers: DurableTimer[];
      outbox: DurableOutboxItem[];
    }
  | { t: "error"; rpcId: string; error: string; retryable?: boolean };

export type KernelActorServiceCall = {
  t: "call";
  rpcId: string;
  request:
    | { t: "store"; method: string; args: unknown[] }
    | { t: "reduce"; command: SessionActorReducerCommand };
  outputBytes: number;
};

export type KernelActorServiceResponse =
  | KernelActorAsyncResponse
  | {
      t: "call_result";
      rpcId: string;
      status: -1 | 1 | 2;
      length: number;
      body?: string;
    };

export type KernelActorTransportEnvelope = {
  version: number;
  actorVersion: number;
  serviceEpoch?: string;
  request: KernelActorAsyncRequest | KernelActorServiceCall;
};

type SyncBuffers = {
  control: SharedArrayBuffer;
  output: SharedArrayBuffer;
};

export type KernelActorSyncRequest =
  | ({ t: "store"; method: string; args: unknown[] } & SyncBuffers)
  | ({ t: "reduce"; command: SessionActorReducerCommand } & SyncBuffers);

export type KernelActorRunEventResult = RunEventDecisionResult;

/** Settlement follows a physical or externally visible action. Any rejected
 * settlement is ambiguous, so both the client and actor fail-stop. */
export function isCriticalSettlementCommand(
  command: SessionActorReducerCommand,
): boolean {
  if (command.kind === "gateway")
    return command.request.op === "complete" || command.request.op === "fail";
  if (command.kind === "core")
    return command.request.op === "ack_outbox" || command.request.op === "fail_outbox";
  if (command.kind === "timer")
    return command.request.op === "complete" || command.request.op === "fail";
  if (command.kind === "delivery")
    return [
      "complete_submit_command",
      "fail_submit_command",
      "settle_interrupt",
      "ack_dispatch",
      "fail_dispatch",
    ].includes(command.request.op);
  if (command.kind === "turn")
    return [
      "complete_cancel_command",
      "fail_cancel_command",
      "settle_cancel",
      "settle_outcome_projection",
    ].includes(command.request.op);
  return false;
}
