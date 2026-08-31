import { afterEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  flushRemoteSandboxStateWrites,
  initializeManagedRemoteSandboxState,
  readRemoteState,
  touchRemoteState,
} from "./bootstrap";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("managed remote sandbox state", () => {
  test("imports and removes legacy JSON then persists activity in FeltDB", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "opensession-remote-state-"));
    temporaryDirectories.push(legacyDir);
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    const legacyPath = join(legacyDir, `daytona-${sandboxId}.json`);
    const originalActivity = "2026-01-01T00:00:00.000Z";
    writeFileSync(legacyPath, JSON.stringify({
      provider: "daytona",
      sandboxId,
      sessionId: crypto.randomUUID(),
      cwd: "/workspace",
      trustProfile: "interactive",
      egressAllowlist: [],
      createdAt: originalActivity,
      lastActivityAt: originalActivity,
    }));
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });

    await initializeManagedRemoteSandboxState(db, legacyDir);

    expect(existsSync(legacyPath)).toBe(false);
    expect(readRemoteState("daytona", sandboxId)?.lastActivityAt).toBe(originalActivity);
    touchRemoteState("daytona", sandboxId);
    await flushRemoteSandboxStateWrites();
    const records = await db.collection<{ sandboxId: string; lastActivityAt: string }>(
      "opensession_remote_sandbox_state",
    ).all();
    expect(records.find((record) => record.sandboxId === sandboxId)?.lastActivityAt).not.toBe(originalActivity);
  });
});
