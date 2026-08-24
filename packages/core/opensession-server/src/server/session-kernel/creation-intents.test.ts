import { describe, expect, test } from "bun:test";
import {
  markCreationOpeningDispatched,
  requestCreationBranch,
  requestCreationCredential,
  requestCreationSandbox,
  requestCreationWorkspace,
  settleCreationFailed,
  settleCreationSucceeded,
} from "./creation-intents";
import {
  SessionKernelStore,
  type CreationEventDecision,
} from "./store";

function harness(sessionId: string) {
  const store = new SessionKernelStore(":memory:");
  return {
    store,
    kernel: {
      creationState: () => store.creationState(sessionId),
      applyCreationEvent: (
        input: Omit<CreationEventDecision, "sessionId">,
      ) => store.applyCreationEvent({ ...input, sessionId }),
    },
  };
}

const input = {
  sessionId: "create-intent",
  identity: "request-intent",
  workspaceId: "ws-create-intent",
  dedupeKey: "session-create:request-intent",
  name: "Creation intent",
  createdBy: "Alice",
  project: "opensession",
  branch: "feature/intent",
  worktreeDir: "/worktrees/intent",
};

const branchInput = {
  sessionId: "create-branch-intent",
  identity: "request-branch-intent",
  project: "opensession",
  branch: "feature/branch-intent",
  worktreePath: "/worktrees/branch-intent",
  baseBranch: "main",
  isolated: true,
  credentialPrincipal: "user:alice",
};

describe("creation lifecycle intents", () => {
  test("moves a preparation-free create through opening to ready idempotently", () => {
    const { store, kernel } = harness("create-lifecycle");
    try {
      const opening = markCreationOpeningDispatched(
        "create-lifecycle",
        "request-lifecycle",
        kernel,
      );
      expect(opening.state).toBe("opening_dispatched");
      expect(opening.currentEffectId).toBeUndefined();
      const ready = settleCreationSucceeded(
        "create-lifecycle",
        "request-lifecycle",
        kernel,
      );
      expect(ready.state).toBe("ready");
      expect(
        settleCreationSucceeded(
          "create-lifecycle",
          "request-lifecycle",
          kernel,
        ).state,
      ).toBe("ready");
    } finally {
      store.close();
    }
  });

  test("refuses to dispatch an opening while preparation is pending", () => {
    const { store, kernel } = harness("create-pending-opening");
    try {
      store.applyCreationEvent({
        sessionId: "create-pending-opening",
        identity: "request-pending",
        event: "plan",
      });
      store.applyCreationEvent({
        sessionId: "create-pending-opening",
        identity: "request-pending",
        event: "preparation_started",
        nextEffectId: "prepare-pending",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "prepare-pending",
          payload: {
            creationIdentity: "request-pending",
            creationGeneration: 1,
            workspaceId: "ws-pending",
            dedupeKey: "create:pending",
            name: "Pending",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      });
      expect(() =>
        markCreationOpeningDispatched(
          "create-pending-opening",
          "request-pending",
          kernel,
        ),
      ).toThrow("must settle before opening");
      expect(store.creationState("create-pending-opening")?.state).toBe(
        "preparing",
      );
    } finally {
      store.close();
    }
  });

  test("records terminal setup failure without launching an opening", () => {
    const { store, kernel } = harness("create-failed-lifecycle");
    try {
      const failed = settleCreationFailed(
        "create-failed-lifecycle",
        "request-failed",
        new Error("workspace refused"),
        kernel,
      );
      expect(failed.state).toBe("failed");
      expect(
        settleCreationFailed(
          "create-failed-lifecycle",
          "request-failed",
          "duplicate",
          kernel,
        ).state,
      ).toBe("failed");
    } finally {
      store.close();
    }
  });
});

describe("creation workspace intents", () => {
  test("waits for the actor receipt rather than destination evidence", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `workspace:${input.workspaceId}`,
        });
      }, 5);
      const state = await requestCreationWorkspace(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `workspace:${input.workspaceId}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          effectKey: `workspace:${input.workspaceId}`,
          payload: { worktreeDir: "/worktrees/intent" },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("does not re-emit work after its durable receipt", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      const effectId = `workspace:${input.workspaceId}`;
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "plan",
      });
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "preparation_started",
        nextEffectId: effectId,
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: effectId,
          payload: {
            creationIdentity: input.identity,
            creationGeneration: 1,
            workspaceId: input.workspaceId,
            dedupeKey: input.dedupeKey,
            name: input.name,
            createdBy: input.createdBy,
            project: input.project,
            branch: input.branch,
            worktreeDir: input.worktreeDir,
            mode: "adopt_or_create",
          },
        },
      });
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "preparation_started",
        effectId,
      });
      const [settled] = store.pendingOutbox();
      store.ackOutbox(settled.id);
      await requestCreationWorkspace(input, { kernel, timeoutMs: 20, pollMs: 1 });
      expect(store.pendingOutbox()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("fails closed on identity crossover", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: "another-request",
        event: "plan",
      });
      await expect(
        requestCreationWorkspace(input, { kernel, timeoutMs: 20, pollMs: 1 }),
      ).rejects.toThrow("identity crossed");
    } finally {
      store.close();
    }
  });
});

describe("creation branch intents", () => {
  test("persists stable branch identity and waits for its actor receipt", async () => {
    const { store, kernel } = harness(branchInput.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: branchInput.sessionId,
          identity: branchInput.identity,
          event: "preparation_started",
          effectId: `branch:${branchInput.project}:${branchInput.branch}`,
        });
      }, 5);
      const state = await requestCreationBranch(branchInput, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `branch:${branchInput.project}:${branchInput.branch}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_branch_prepare",
          payload: {
            worktreePath: "/worktrees/branch-intent",
            baseBranch: "main",
            isolated: true,
            credentialPrincipal: "user:alice",
          },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("leaves timed-out branch work durable and does not re-emit it", async () => {
    const { store, kernel } = harness(branchInput.sessionId);
    try {
      await expect(requestCreationBranch(branchInput, {
        kernel,
        timeoutMs: 5,
        pollMs: 1,
      })).rejects.toThrow("remains durably pending");
      expect(store.pendingOutbox()).toHaveLength(1);
      await expect(requestCreationBranch(branchInput, {
        kernel,
        timeoutMs: 5,
        pollMs: 1,
      })).rejects.toThrow("remains durably pending");
      expect(store.pendingOutbox()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("creation credential intents", () => {
  test("persists only a stable selector and scope before receipt", async () => {
    const input = {
      sessionId: "create-credential-intent",
      identity: "request-credential-intent",
      principal: "user:alice",
      scope: "git:opensession",
    };
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `credential:${input.principal}:${input.scope}`,
        });
      }, 5);
      const state = await requestCreationCredential(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `credential:${input.principal}:${input.scope}`,
      ]);
      const [effect] = store.pendingOutbox();
      expect(effect).toMatchObject({
        kind: "creation_credential_resolve",
        payload: {
          principal: "user:alice",
          scope: "git:opensession",
        },
      });
      expect(JSON.stringify(effect)).not.toContain("gitEnv");
      expect(JSON.stringify(effect)).not.toContain("token");
    } finally {
      store.close();
    }
  });

  test("continues from a credential receipt to one credential-bound branch", async () => {
    const credential = {
      sessionId: "credential-branch-sequence",
      identity: "request-credential-branch",
      principal: "user:alice",
      scope: "git:opensession",
    };
    const branch = {
      ...branchInput,
      sessionId: credential.sessionId,
      identity: credential.identity,
    };
    const { store, kernel } = harness(credential.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: credential.sessionId,
          identity: credential.identity,
          event: "preparation_started",
          effectId: `credential:${credential.principal}:${credential.scope}`,
        });
      }, 5);
      await requestCreationCredential(credential, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      const [credentialEffect] = store.pendingOutbox();
      store.ackOutbox(credentialEffect.id);
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: branch.sessionId,
          identity: branch.identity,
          event: "preparation_started",
          effectId: `branch:${branch.project}:${branch.branch}`,
        });
      }, 5);
      const state = await requestCreationBranch(branch, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `credential:${credential.principal}:${credential.scope}`,
        `branch:${branch.project}:${branch.branch}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_branch_prepare",
          payload: { credentialPrincipal: "user:alice" },
        },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("creation sandbox intents", () => {
  test("persists one session-keyed provider spec and waits for its receipt", async () => {
    const input = {
      sessionId: "create-sandbox-intent",
      identity: "request-sandbox-intent",
      provider: "modal",
      repo: "opensession",
      branch: "feature/sandbox-intent",
      sessionMode: "code" as const,
      cwd: "/worktrees/sandbox-intent",
      base: "main",
      attachedDirs: ["/worktrees/attached"],
      trustProfile: "interactive" as const,
      egressAllowlist: ["github.com"],
    };
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `sandbox:${input.provider}:${input.sessionId}`,
        });
      }, 5);
      const state = await requestCreationSandbox(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `sandbox:${input.provider}:${input.sessionId}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_sandbox_prepare",
          payload: {
            sandboxKey: input.sessionId,
            provider: "modal",
            repo: "opensession",
            sessionMode: "code",
            attachedDirs: ["/worktrees/attached"],
            egressAllowlist: ["github.com"],
          },
        },
      ]);
    } finally {
      store.close();
    }
  });
});
