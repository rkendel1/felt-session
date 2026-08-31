import { afterEach, describe, expect, test } from "bun:test";
import {
  getOrCreateQueue,
  interruptQueuesForRestart,
  isRestartAbort,
  sessionQueues,
  type QueuedMessage,
} from "./queue";

afterEach(() => sessionQueues.clear());

describe("Slack queue restart interruption", () => {
  test("marks only live runs as restart interruptions", async () => {
    const live = getOrCreateQueue("live");
    live.queue.push({ messageTs: "123.456" } as QueuedMessage);
    live.abortController = new AbortController();
    const alreadyStopped = getOrCreateQueue("stopped");
    alreadyStopped.abortController = new AbortController();
    alreadyStopped.abortController.abort();

    const interruption = interruptQueuesForRestart();
    expect(live.restartInterrupted).toBe(true);
    expect(live.queue[0]?.restartRecovery).toBe(true);
    expect(isRestartAbort(live.abortController.signal)).toBe(true);
    expect(isRestartAbort(alreadyStopped.abortController.signal)).toBe(false);
    // Shutdown fails closed when no managed authority is configured.
    await expect(interruption).rejects.toThrow("Managed FeltDB");
  });
});
