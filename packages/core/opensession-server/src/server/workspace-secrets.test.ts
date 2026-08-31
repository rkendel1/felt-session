import { beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import {
  deleteWorkspaceSecret,
  initializeManagedWorkspaceSecrets,
  putWorkspaceSecret,
  resolveWorkspaceSecret,
  workspaceSecretExists,
} from "./workspace-secrets";

beforeEach(async () => {
  await initializeManagedWorkspaceSecrets(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
});

describe("workspace secrets", () => {
  test("creates, rotates, resolves and deletes an opaque FeltDB secret", async () => {
    const ref = await putWorkspaceSecret("sandbox.daytona", "first");
    expect(ref).toMatch(/^wssec-/);
    expect(resolveWorkspaceSecret(ref)).toBe("first");
    expect(await putWorkspaceSecret("sandbox.daytona", "second", ref)).toBe(ref);
    expect(resolveWorkspaceSecret(ref)).toBe("second");
    expect(workspaceSecretExists(ref)).toBe(true);
    expect(await deleteWorkspaceSecret(ref)).toBe(true);
    expect(workspaceSecretExists(ref)).toBe(false);
  });
});
