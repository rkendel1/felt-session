import type {
  KernelActorAsyncRequest,
  KernelActorServiceCall,
} from "./actor-protocol";
import { isDeliveryReadRequest } from "./delivery-protocol";
import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import { sessionKernelStoreRoute } from "./store-routing";

export type SessionActorRoute =
  | { scope: "global" }
  | { scope: "session"; sessionId: string; mutation: boolean }
  | { scope: "outbox"; id: number; mutation: boolean };

export function isReadReducer(command: SessionActorReducerCommand): boolean {
  if (command.kind === "ask")
    return command.request.op === "snapshot" || command.request.op === "entries";
  if (command.kind === "delivery") return isDeliveryReadRequest(command.request);
  return command.kind === "turn" && command.request.op === "snapshot";
}

/** Exhaustive routing for the typed reducer union. */
export function sessionActorReducerRoute(
  command: SessionActorReducerCommand,
): SessionActorRoute {
  switch (command.kind) {
    case "creation_event":
      return {
        scope: "session",
        sessionId: command.decision.sessionId,
        mutation: true,
      };
    case "run_event":
      return {
        scope: "session",
        sessionId: command.decision.sessionId,
        mutation: true,
      };
    case "delivery":
    case "ask":
    case "turn":
    case "timer":
    case "gateway":
      return "sessionId" in command.request
        ? {
            scope: "session",
            sessionId: command.request.sessionId,
            mutation: !isReadReducer(command),
          }
        : { scope: "global" };
    case "core":
      return "sessionId" in command.request
        ? {
            scope: "session",
            sessionId: command.request.sessionId,
            mutation: true,
          }
        : {
            scope: "outbox",
            id: command.request.id,
            mutation: true,
          };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function sessionActorServiceRoute(
  request: KernelActorAsyncRequest | KernelActorServiceCall,
): SessionActorRoute {
  if (request.t === "call") {
    if (request.request.t === "reduce")
      return sessionActorReducerRoute(request.request.command);
    return sessionKernelStoreRoute(
      request.request.method,
      request.request.args,
    );
  }
  if (request.t === "acknowledge")
    return { scope: "session", sessionId: request.sessionId, mutation: true };
  return { scope: "global" };
}
