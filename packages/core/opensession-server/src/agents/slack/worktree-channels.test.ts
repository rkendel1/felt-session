import { beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import {
  branchToChannel,
  loadWorktreeChannels,
  removeWorktreeChannel,
  setWorktreeChannel,
  worktreeChannels,
} from "./worktree-channels";

let db: StateFirstDB;

beforeEach(async () => {
  db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
  await loadWorktreeChannels(db);
});

describe("Slack worktree channel mappings", () => {
  test("survive managed-store hydration", async () => {
    await setWorktreeChannel("C123", "feature/feltdb");
    worktreeChannels.clear();
    branchToChannel.clear();

    await loadWorktreeChannels(db);

    expect(worktreeChannels.get("C123")).toBe("feature/feltdb");
    expect(branchToChannel.get("feature/feltdb")).toBe("C123");
  });

  test("removes both durable and in-memory mappings", async () => {
    await setWorktreeChannel("C456", "feature/remove");
    await removeWorktreeChannel("C456");
    await loadWorktreeChannels(db);

    expect(worktreeChannels.has("C456")).toBe(false);
    expect(branchToChannel.has("feature/remove")).toBe(false);
  });
});
