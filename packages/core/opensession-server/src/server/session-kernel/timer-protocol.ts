export type TimerActorRequest =
  | {
      op: "begin";
      sessionId: string;
      timerId: string;
      token: string;
    }
  | {
      op: "complete";
      sessionId: string;
      timerId: string;
      token: string;
    }
  | {
      op: "fail";
      sessionId: string;
      timerId: string;
      token: string;
      error: string;
      maxAttempts: number;
    }
  | {
      op: "record_runtime_failure";
      sessionId: string;
      timerId: string;
      token: string;
      error: string;
      maxAttempts: number;
      observedAttempts: number;
    };

export type TimerActorResult<T extends TimerActorRequest> =
  T extends { op: "begin" }
    ? "execute" | "completed" | "missing"
    : T extends { op: "complete" }
      ? boolean
      : T extends { op: "fail" | "record_runtime_failure" }
        ? { updated: boolean; deadLetteredNow: boolean }
        : never;
