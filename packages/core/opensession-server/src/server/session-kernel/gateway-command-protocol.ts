export type GatewayCommandOperation =
  | "websocket_command"
  | "delete_session"
  | "session_file_updated";

export type GatewayCommandRequest =
  | {
      op: "request";
      sessionId: string;
      requestId: string;
      operation: GatewayCommandOperation;
      identity?: unknown;
    }
  | {
      op: "complete";
      sessionId: string;
      requestId: string;
      operation: GatewayCommandOperation;
      result: unknown;
    }
  | {
      op: "fail";
      sessionId: string;
      requestId: string;
      operation: GatewayCommandOperation;
      error: string;
      retryable: boolean;
    };

export type GatewayCommandResult<T extends GatewayCommandRequest> =
  T extends { op: "request" }
    ?
        | { status: "execute" }
        | { status: "in_progress" }
        | { status: "completed"; result: unknown; duplicate: true }
    : T extends { op: "complete" }
      ? unknown
      : void;
