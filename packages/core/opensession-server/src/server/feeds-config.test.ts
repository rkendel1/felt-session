import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  initializeManagedConfigFeeds,
  readConfigFeeds,
  removeConfigFeed,
  upsertConfigFeed,
} from "./feeds-config";

describe("managed config feeds", () => {
  test("persists independent feed records and deletes them in FeltDB", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedConfigFeeds(db);
    expect(await upsertConfigFeed({
      id: "tickets", title: "Tickets", refKind: "ticket",
      items: { server: "plain", tool: "list", map: { id: "id", title: "title" } },
    })).toEqual({ ok: true });
    expect(readConfigFeeds().map((feed) => feed.id)).toEqual(["tickets"]);
    await initializeManagedConfigFeeds(db);
    expect(readConfigFeeds()[0]?.title).toBe("Tickets");
    expect(await removeConfigFeed("tickets")).toEqual({ ok: true });
    await initializeManagedConfigFeeds(db);
    expect(readConfigFeeds()).toEqual([]);
  });
});
