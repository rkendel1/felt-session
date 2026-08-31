import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __setSessionsDirForTest } from "./paths";
import {
  deleteNativeSessionMetadata,
  initializeManagedNativeSessions,
  nativeSessionMetadata,
  nativeSessionMetadataEntries,
  updateNativeSessionMetadata,
} from "./managed-native-sessions";

describe("managed native-session authority", () => {
  const directory = join(tmpdir(), `opensession-native-sessions-${crypto.randomUUID()}`);
  let previousDirectory: string;

  beforeAll(() => {
    mkdirSync(directory, { recursive: true });
    previousDirectory = __setSessionsDirForTest(directory);
  });

  afterAll(() => {
    __setSessionsDirForTest(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  });

  test("imports, verifies, removes files, and serves all later writes from FeltDB", async () => {
    const native = `${directory}/os-native.json`;
    const sidecar = `${directory}/slack-thread.json`;
    const bookkeeping = `${directory}/active-runs.json`;
    writeFileSync(native, JSON.stringify({
      id: "os-native",
      source: "opensession",
      title: "Before",
    }));
    writeFileSync(sidecar, JSON.stringify({ workspaceId: "workspace-one" }));
    writeFileSync(bookkeeping, JSON.stringify({ runs: [] }));

    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await initializeManagedNativeSessions(db);

    expect(nativeSessionMetadata("os-native")).toMatchObject({ title: "Before" });
    expect(nativeSessionMetadata("slack-thread")).toMatchObject({
      workspaceId: "workspace-one",
    });
    expect(nativeSessionMetadataEntries()).toHaveLength(2);
    expect(existsSync(native)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(bookkeeping)).toBe(true);
    expect(await db.collection("opensession_migrations").get(
      "native-session-json-to-managed-feltdb-v1",
    )).toBeDefined();

    const updated = await updateNativeSessionMetadata("os-native", (current) => ({
      ...current,
      title: "After",
    }));
    expect(updated).toMatchObject({ title: "After", rev: 1 });
    expect(nativeSessionMetadata("os-native")).toMatchObject({ title: "After", rev: 1 });
    expect(existsSync(native)).toBe(false);

    await deleteNativeSessionMetadata("os-native");
    expect(nativeSessionMetadata("os-native")).toBeUndefined();
    expect(await db.collection("opensession_sessions").get("os-native"))
      .toBeNull();
  });
});
