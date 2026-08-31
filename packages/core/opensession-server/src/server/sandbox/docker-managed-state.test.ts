import { afterEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  flushDockerSandboxStateWrites,
  initializeManagedDockerSandboxState,
  touchSandboxActivity,
} from "./docker";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("managed Docker sandbox state", () => {
  test("imports legacy JSON, removes it, and persists later activity in FeltDB", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "opensession-docker-state-"));
    temporaryDirectories.push(legacyDir);
    const sandboxId = `bks-sbx-${crypto.randomUUID()}`;
    const legacyPath = join(legacyDir, `${sandboxId}.json`);
    const originalActivity = "2026-01-01T00:00:00.000Z";
    writeFileSync(legacyPath, JSON.stringify({
      sandboxId,
      sessionId: crypto.randomUUID(),
      cwd: "/workspace",
      image: "opensession-runner:test",
      createdAt: originalActivity,
      lastActivityAt: originalActivity,
    }));
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });

    await initializeManagedDockerSandboxState(db, legacyDir);

    expect(existsSync(legacyPath)).toBe(false);
    let records = await db.collection<{ sandboxId: string; lastActivityAt: string }>(
      "opensession_docker_sandbox_state",
    ).all();
    expect(records.find((record) => record.sandboxId === sandboxId)?.lastActivityAt).toBe(originalActivity);

    touchSandboxActivity(sandboxId);
    await flushDockerSandboxStateWrites();
    records = await db.collection<{ sandboxId: string; lastActivityAt: string }>(
      "opensession_docker_sandbox_state",
    ).all();
    expect(records.find((record) => record.sandboxId === sandboxId)?.lastActivityAt).not.toBe(originalActivity);
  });
});
