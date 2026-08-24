import type {
  LegacyGatewayEffect,
  SessionActorReducerCommand,
} from "./lifecycle-protocol";
import type {
  DurableOutboxItem,
  DurableTimer,
  RunEventDecisionResult,
} from "./store";

export const SESSION_KERNEL_ACTOR_VERSION = 10;
export const SESSION_KERNEL_MAX_WAITERS_PER_COMMAND = 64;
export const SESSION_KERNEL_MAX_WAITERS_TOTAL = 4096;
export const SESSION_KERNEL_MAX_EXECUTIONS_PER_SESSION = 128;
export const SESSION_KERNEL_MAX_EXECUTIONS_TOTAL = 4096;

export type KernelActorAsyncRequest =
  | { t: "hello"; rpcId: string; version: number }
  | {
      t: "begin";
      rpcId: string;
      command: LegacyGatewayEffect;
      sessionId: string;
    }
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
  | {
      t: "complete";
      rpcId: string;
      executionId: string;
      result: unknown;
      effects: Array<{ kind: string; payload: unknown; effectKey: string }>;
    }
  | {
      t: "fail";
      rpcId: string;
      executionId: string;
      error: string;
      retryable: boolean;
    };

export type KernelActorAsyncResponse =
  | { t: "ready"; rpcId: string; version: number }
  | {
      t: "begin_result";
      rpcId: string;
      duplicate: boolean;
      executionId?: string;
      result?: unknown;
    }
  | {
      t:
        | "complete_result"
        | "fail_result"
        | "acknowledge_result"
        | "maintain_result";
      rpcId: string;
    }
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

type SyncBuffers = {
  control: SharedArrayBuffer;
  output: SharedArrayBuffer;
};

export type KernelActorSyncRequest =
  | ({ t: "store"; method: string; args: unknown[] } & SyncBuffers)
  | ({ t: "reduce"; command: SessionActorReducerCommand } & SyncBuffers);

export type KernelActorRunEventResult = RunEventDecisionResult;
