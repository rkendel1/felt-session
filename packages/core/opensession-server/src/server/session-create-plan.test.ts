import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setSessionsDirForTest } from "./paths";
import { SessionKernelStore } from "./session-kernel/store";
import {
  clearCreatePlan,
  createPlanWorkspaceId,
  readCreatePlan,
  pruneCreatePlans,
  restoreResolvedCreate,
  snapshotResolvedCreate,
  updateCreatePlan,
} from "./session-create-plan";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable create plan", () => {
  test("never persists ephemeral GitHub bearer tokens", () => {
    const snapshot = snapshotResolvedCreate({
      gitPrincipal: "user:alice",
      gitEnv: {
        GH_TOKEN: "gho_secret",
        GITHUB_TOKEN: "gho_secret",
        GIT_CONFIG_VALUE_1: "!opensession github-credential",
      },
      branch: "feature/private",
    });
    expect(snapshot.gitPrincipal).toBe("user:alice");
    expect(snapshot.gitEnv).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("gho_secret");
  });

  test("preserves explicitly absent resolved decisions", () => {
    const snapshot = snapshotResolvedCreate({
      model: "pi/openai/gpt-5.5",
      accountId: undefined,
      mcpServers: undefined,
    });
    const restored = restoreResolvedCreate<Record<string, unknown>>(snapshot);
    expect(Object.hasOwn(restored, "accountId")).toBe(true);
    expect(Object.hasOwn(restored, "mcpServers")).toBe(true);
    expect(restored.accountId).toBeUndefined();
  });

  test("prunes only terminal plans with bounded retention", () => {
    const root = mkdtempSync(join(tmpdir(), "create-plan-prune-"));
    roots.push(root);
    const previous = __setSessionsDirForTest(root);
    const store = new SessionKernelStore(":memory:");
    try {
      const plan = updateCreatePlan("os-terminal", "request", {});
      store.acceptCommand({
        sessionId: plan.sessionId,
        requestId: plan.identity,
        type: "create_session",
      });
      store.completeCommand(plan.sessionId, plan.identity, { id: plan.sessionId });
      expect(
        pruneCreatePlans(
          store,
          Date.parse(plan.createdAt) + 24 * 60 * 60_000 + 1,
        ),
      ).toBe(1);
      expect(readCreatePlan(plan.sessionId, plan.identity)).toBeUndefined();

      const retryable = updateCreatePlan("os-retryable", "retry", {});
      store.acceptCommand({
        sessionId: retryable.sessionId,
        requestId: retryable.identity,
        type: "create_session",
      });
      store.failCommand(
        retryable.sessionId,
        retryable.identity,
        "temporary",
        true,
      );
      expect(
        pruneCreatePlans(
          store,
          Date.parse(retryable.createdAt) + 365 * 24 * 60 * 60_000,
        ),
      ).toBe(0);
      expect(readCreatePlan(retryable.sessionId, retryable.identity)).toBeDefined();
    } finally {
      store.close();
      __setSessionsDirForTest(previous);
    }
  });

  test("keeps branch and workspace choices across a retry", () => {
    const root = mkdtempSync(join(tmpdir(), "create-plan-"));
    roots.push(root);
    const previous = __setSessionsDirForTest(root);
    try {
      const first = updateCreatePlan("os-create", "same", {
        branch: "feature/stable",
        workspaceId: createPlanWorkspaceId("os-create"),
        attachments: [{
          attachmentId: "attachment-one",
          name: "brief.pdf",
          sourceRef: "uploads:staged%2Fbrief.pdf",
          digest: "sha256:brief",
        }],
        resolved: {
          model: "pi/openai/gpt-5.5",
          sandboxProvider: "docker",
          openingPrompt: "stable context",
        },
      });
      expect(readCreatePlan("os-create", "same")).toEqual(first);
      expect(() => readCreatePlan("os-create", "different")).toThrow(
        "reused with another payload",
      );
      clearCreatePlan("os-create");
      expect(readCreatePlan("os-create", "same")).toBeUndefined();
    } finally {
      __setSessionsDirForTest(previous);
    }
  });
});
