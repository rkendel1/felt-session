import { sessionKernel } from "./kernel";
import type { DurableCreationState } from "./store";

export type CreationWorkspaceIntent = {
  sessionId: string;
  identity: string;
  workspaceId: string;
  dedupeKey: string;
  name: string;
  createdBy: string;
  project?: string;
  branch?: string;
  worktreeDir?: string;
};

export type CreationBranchIntent = {
  sessionId: string;
  identity: string;
  project: string;
  branch: string;
  worktreePath: string;
  baseBranch?: string;
  isolated: boolean;
  existingBranch?: boolean;
  credentialPrincipal?: string;
};

export type CreationCredentialIntent = {
  sessionId: string;
  identity: string;
  principal: string;
  scope: string;
};

export type CreationSandboxIntent = {
  sessionId: string;
  identity: string;
  provider: string;
  repo?: string;
  branch?: string;
  sessionMode?: "ask" | "code" | "scratch";
  cwd?: string;
  base?: string;
  attachedDirs?: string[];
  trustProfile?: "interactive" | "automation";
  egressAllowlist?: string[];
};

type CreationIntentKernel = Pick<
  ReturnType<typeof sessionKernel>,
  "creationState" | "applyCreationEvent"
>;

type CreationIntentOptions = {
  kernel?: CreationIntentKernel;
  timeoutMs?: number;
  pollMs?: number;
};

function assertIdentity(
  state: DurableCreationState,
  identity: string,
): void {
  if (state.identity !== identity)
    throw new Error("Create request identity crossed durable session ownership");
  if (state.state === "failed")
    throw new Error("Session creation has already failed");
}

export function ensureCreationPlanned(
  sessionId: string,
  identity: string,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
): DurableCreationState {
  const existing = kernel.creationState();
  if (existing) {
    assertIdentity(existing, identity);
    return existing;
  }
  const planned = kernel.applyCreationEvent({ identity, event: "plan" });
  if (!planned.accepted || !planned.state)
    throw new Error(`Creation plan was rejected: ${planned.reason || "unknown"}`);
  return planned.state;
}

/** Cross the durable preparation-to-opening boundary before launching a runner. */
export function markCreationOpeningDispatched(
  sessionId: string,
  identity: string,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
): DurableCreationState {
  let state = ensureCreationPlanned(sessionId, identity, kernel);
  if (state.state === "ready" || state.state === "opening_dispatched") return state;
  assertIdentity(state, identity);
  if (state.currentEffectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before opening`,
    );
  if (state.state === "planned") {
    const preparing = kernel.applyCreationEvent({
      identity,
      event: "preparation_started",
    });
    if (!preparing.accepted || !preparing.state)
      throw new Error(
        `Creation preparation was rejected: ${preparing.reason || "unknown"}`,
      );
    state = preparing.state;
  }
  const dispatched = kernel.applyCreationEvent({
    identity,
    event: "opening_dispatched",
  });
  if (!dispatched.accepted || !dispatched.state)
    throw new Error(
      `Creation opening dispatch was rejected: ${dispatched.reason || "unknown"}`,
    );
  return dispatched.state;
}

export function settleCreationSucceeded(
  sessionId: string,
  identity: string,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
): DurableCreationState {
  const state = ensureCreationPlanned(sessionId, identity, kernel);
  if (state.state === "ready") return state;
  assertIdentity(state, identity);
  const settled = kernel.applyCreationEvent({ identity, event: "succeeded" });
  if (!settled.accepted || !settled.state)
    throw new Error(
      `Creation success was rejected: ${settled.reason || "unknown"}`,
    );
  return settled.state;
}

export function settleCreationFailed(
  sessionId: string,
  identity: string,
  error: unknown,
  kernel: CreationIntentKernel = sessionKernel(sessionId),
): DurableCreationState {
  const existing = kernel.creationState();
  if (existing?.identity !== undefined && existing.identity !== identity)
    throw new Error("Create request identity crossed durable session ownership");
  if (existing?.state === "failed") return existing;
  ensureCreationPlanned(sessionId, identity, kernel);
  const settled = kernel.applyCreationEvent({
    identity,
    event: "failed",
    detail: { error: error instanceof Error ? error.message : String(error) },
  });
  if (!settled.accepted || !settled.state)
    throw new Error(
      `Creation failure was rejected: ${settled.reason || "unknown"}`,
    );
  return settled.state;
}

/** Emit one stable workspace intent and wait for its actor receipt, never its file. */
export async function requestCreationWorkspace(
  input: CreationWorkspaceIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = ensureCreationPlanned(input.sessionId, input.identity, kernel);
  const effectId = `workspace:${input.workspaceId}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_workspace_prepare",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
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
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation workspace intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Creation workspace effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = kernel.creationState();
    if (!current)
      throw new Error("Creation state disappeared while workspace work was pending");
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}

/** Emit one stable branch intent and wait for its actor receipt. */
export async function requestCreationBranch(
  input: CreationBranchIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = ensureCreationPlanned(input.sessionId, input.identity, kernel);
  const effectId = `branch:${input.project}:${input.branch}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_branch_prepare",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          project: input.project,
          branch: input.branch,
          worktreePath: input.worktreePath,
          baseBranch: input.baseBranch,
          isolated: input.isolated,
          existingBranch: input.existingBranch,
          credentialPrincipal: input.credentialPrincipal,
          mode: "adopt_or_create",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation branch intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new Error(`Creation branch effect ${effectId} remains durably pending`);
    await Bun.sleep(options.pollMs ?? 25);
    const current = kernel.creationState();
    if (!current)
      throw new Error("Creation state disappeared while branch work was pending");
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}

/** Resolve a durable principal selector without admitting secret material. */
export async function requestCreationCredential(
  input: CreationCredentialIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = ensureCreationPlanned(input.sessionId, input.identity, kernel);
  const effectId = `credential:${input.principal}:${input.scope}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_credential_resolve",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          principal: input.principal,
          scope: input.scope,
          mode: "resolve_current",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation credential intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Creation credential effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = kernel.creationState();
    if (!current)
      throw new Error(
        "Creation state disappeared while credential work was pending",
      );
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}

/** Ensure a session-keyed sandbox and wait only for its actor receipt. */
export async function requestCreationSandbox(
  input: CreationSandboxIntent,
  options: CreationIntentOptions = {},
): Promise<DurableCreationState> {
  const kernel = options.kernel ?? sessionKernel(input.sessionId);
  let state = ensureCreationPlanned(input.sessionId, input.identity, kernel);
  const effectId = `sandbox:${input.provider}:${input.sessionId}`;
  if (state.completedEffectIds.includes(effectId)) return state;
  if (state.currentEffectId && state.currentEffectId !== effectId)
    throw new Error(
      `Creation effect ${state.currentEffectId} must settle before ${effectId}`,
    );
  if (!state.currentEffectId) {
    const emitted = kernel.applyCreationEvent({
      identity: input.identity,
      event: "preparation_started",
      nextEffectId: effectId,
      effect: {
        kind: "creation_sandbox_prepare",
        effectKey: effectId,
        payload: {
          creationIdentity: input.identity,
          creationGeneration: state.generation,
          provider: input.provider,
          sandboxKey: input.sessionId,
          repo: input.repo,
          branch: input.branch,
          sessionMode: input.sessionMode,
          cwd: input.cwd,
          base: input.base,
          attachedDirs: input.attachedDirs,
          trustProfile: input.trustProfile,
          egressAllowlist: input.egressAllowlist,
          mode: "adopt_or_create",
        },
      },
    });
    if (!emitted.accepted || !emitted.state)
      throw new Error(
        `Creation sandbox intent was rejected: ${emitted.reason || "unknown"}`,
      );
    state = emitted.state;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (!state.completedEffectIds.includes(effectId)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Creation sandbox effect ${effectId} remains durably pending`,
      );
    await Bun.sleep(options.pollMs ?? 25);
    const current = kernel.creationState();
    if (!current)
      throw new Error("Creation state disappeared while sandbox work was pending");
    assertIdentity(current, input.identity);
    state = current;
  }
  return state;
}
