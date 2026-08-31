import type {
  ExecutorRequest,
  ExecutorResponse,
} from "@tellahq/opensession-protocol/executor";
import { executorSocketPath } from "@tellahq/opensession-protocol/executor";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { SocketWriteQueue } from "../runner-host/socket-write-queue";
import { ndjsonReader } from "../runner-host/protocol";
import { sessionsDir } from "../server/paths";
import { ExecutorCoordinator } from "./coordinator";
import { managedFeltDb } from "../server/managed-feltdb";

const MAX_REQUEST_BYTES = 1024 * 1024;

export async function startExecutorServer(options: {
  sessionsDir?: string;
  coordinator?: ExecutorCoordinator;
  token: string;
}): Promise<ReturnType<typeof Bun.listen>> {
  const root = options.sessionsDir ?? sessionsDir();
  const socketPath = executorSocketPath(root);
  mkdirSync(root, { recursive: true });
  if (existsSync(socketPath)) {
    if (await socketAcceptsConnections(socketPath)) {
      throw new Error(`executor socket ${socketPath} is already live`);
    }
    unlinkSync(socketPath);
  }
  const coordinator =
    options.coordinator ??
    new ExecutorCoordinator(root, options.token, managedFeltDb());
  await coordinator.initialize();
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        const writer = new SocketWriteQueue(
          (data) => socket.write(data),
          MAX_REQUEST_BYTES,
          () => socket.end(),
        );
        (socket as any).__writer = writer;
        (socket as any).__read = ndjsonReader(
          (request: ExecutorRequest) => {
            void coordinator
              .handle(request)
              .then((response: ExecutorResponse) => {
                writer.write(`${JSON.stringify(response)}\n`);
              })
              .catch((error) => {
                console.error("[executor] request failed:", error);
                socket.end();
              });
          },
          "executor",
          {
            maxBufferedBytes: MAX_REQUEST_BYTES,
            onInvalid: () => socket.end(),
          },
        );
      },
      data(socket, data) {
        (socket as any).__read(data);
      },
      drain(socket) {
        (socket as any).__writer?.drain();
      },
      error(_socket, error) {
        console.error("[executor] client socket error:", error);
      },
    },
  });
  chmodSync(socketPath, 0o600);
  return listener;
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 250);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.end();
          finish(true);
        },
        connectError() {
          finish(false);
        },
        error() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}
