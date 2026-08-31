import { describe, expect, test } from "bun:test";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import { SlackEventInbox, type SlackEventInboxDependencies } from "./event-inbox";

function setup(patch: Partial<SlackEventInboxDependencies> = {}) {
  const handled: string[] = [];
  const processed = new Set<string>();
  const deps: SlackEventInboxDependencies = {
    handleDirectMessage: async (event) => { handled.push(`dm:${event.ts}`); },
    handleMention: async (event) => { handled.push(`mention:${event.ts}`); },
    isProcessed: (id) => processed.has(id),
    markProcessed: (id) => { processed.add(id); },
    ...patch,
  };
  const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  return { handled, processed, deps, db };
}

function event(ts = "1787752607.643009") {
  return {
    type: "app_mention", channel: "C0A77HH0XPT", ts,
    thread_ts: "1787285297.117399", user: "U0866D7PCCU",
    text: "<@U0A7T08405R> check?",
  };
}

async function records(db: StateFirstDB) {
  return db.collection<{ status: string; attempts: number; lastError?: string }>(
    "opensession_slack_event_inbox",
  ).all();
}

describe("SlackEventInbox", () => {
  test("persists a mention before processing starts", async () => {
    const state = setup();
    const inbox = new SlackEventInbox("/missing", state.deps, { db: state.db });
    expect(await inbox.enqueue("mention", event())).toBe("enqueued");
    expect(state.handled).toEqual([]);
    expect(await records(state.db)).toMatchObject([{ status: "pending", attempts: 0 }]);
    await inbox.start();
    expect(state.handled).toEqual(["mention:1787752607.643009"]);
    expect(state.processed.has("C0A77HH0XPT-1787752607.643009")).toBe(true);
    expect(await records(state.db)).toMatchObject([{ status: "completed" }]);
  });

  test("replays an unfinished event in a new process", async () => {
    const state = setup();
    const first = new SlackEventInbox("/missing", state.deps, { db: state.db });
    await first.enqueue("mention", event());
    const replay = new SlackEventInbox("/missing", state.deps, { db: state.db });
    await replay.start();
    expect(state.handled).toEqual(["mention:1787752607.643009"]);
    expect(replay.pendingCount()).toBe(0);
  });

  test("keeps a failed event durable for a later retry", async () => {
    const state = setup({ handleMention: async () => { throw new Error("classifier unavailable"); } });
    const first = new SlackEventInbox("/missing", state.deps, {
      db: state.db, retryDelayMs: 60_000,
    });
    await first.enqueue("mention", event());
    await first.start();
    first.stop();
    expect(await records(state.db)).toMatchObject([{
      status: "pending", attempts: 1, lastError: "classifier unavailable",
    }]);
    const recovered: string[] = [];
    const replay = new SlackEventInbox("/missing", {
      ...state.deps,
      handleMention: async (value) => { recovered.push(value.ts); },
    }, { db: state.db });
    await replay.start();
    expect(recovered).toEqual(["1787752607.643009"]);
    expect(await records(state.db)).toMatchObject([{ status: "completed" }]);
  });

  test("deduplicates pending and completed provider retries", async () => {
    const state = setup();
    const inbox = new SlackEventInbox("/missing", state.deps, { db: state.db });
    expect(await inbox.enqueue("direct_message", event("1.1"))).toBe("enqueued");
    expect(await inbox.enqueue("direct_message", event("1.1"))).toBe("pending");
    await inbox.start();
    expect(await inbox.enqueue("direct_message", event("1.1"))).toBe("processed");
  });

  test("cleans up a stale pending record already marked processed", async () => {
    const state = setup();
    const first = new SlackEventInbox("/missing", state.deps, { db: state.db });
    await first.enqueue("mention", event());
    state.processed.add("C0A77HH0XPT-1787752607.643009");
    const replay = new SlackEventInbox("/missing", state.deps, { db: state.db });
    await replay.start();
    expect(state.handled).toEqual([]);
    expect(await records(state.db)).toMatchObject([{ status: "completed" }]);
  });
});
