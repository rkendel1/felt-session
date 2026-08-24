export type CreationEffectBase = {
  creationIdentity: string;
  creationGeneration: number;
};

export type CreationWorkspacePrepareEffect = {
  kind: "creation_workspace_prepare";
  payload: CreationEffectBase & {
    workspaceId: string;
    dedupeKey: string;
    name: string;
    createdBy: string;
    project?: string;
    branch?: string;
    worktreeDir?: string;
    mode: "adopt_or_create";
  };
};

export type CreationBranchPrepareEffect = {
  kind: "creation_branch_prepare";
  payload: CreationEffectBase & {
    project: string;
    branch: string;
    worktreePath: string;
    baseBranch?: string;
    isolated: boolean;
    existingBranch?: boolean;
    credentialPrincipal?: string;
    mode: "adopt_or_create";
  };
};

export type CreationSandboxPrepareEffect = {
  kind: "creation_sandbox_prepare";
  payload: CreationEffectBase & {
    provider: string;
    sandboxKey: string;
    repo?: string;
    branch?: string;
    sessionMode?: "ask" | "code" | "scratch";
    cwd?: string;
    base?: string;
    attachedDirs?: string[];
    trustProfile?: "interactive" | "automation";
    egressAllowlist?: string[];
    mode: "adopt_or_create";
  };
};

export type CreationCredentialResolveEffect = {
  kind: "creation_credential_resolve";
  payload: CreationEffectBase & {
    principal: string;
    scope: string;
    mode: "resolve_current";
  };
};

export type CreationAttachmentStageEffect = {
  kind: "creation_attachment_stage";
  payload: CreationEffectBase & {
    attachmentId: string;
    name: string;
    sourceRef: string;
    digest: string;
    mode: "reconcile_or_stage";
  };
};

export type CreationOpeningTurnEffect = {
  kind: "creation_opening_turn";
  payload: CreationEffectBase & {
    openingPromptEntryId: string;
    runId: string;
    runGeneration: number;
    mode: "adopt_or_launch";
  };
};

/** Physical creation work. Payloads contain stable identities and references, never secrets or attachment bodies. */
export type CreationActorEffect =
  | CreationWorkspacePrepareEffect
  | CreationBranchPrepareEffect
  | CreationSandboxPrepareEffect
  | CreationCredentialResolveEffect
  | CreationAttachmentStageEffect
  | CreationOpeningTurnEffect;

export type StagedCreationActorEffect = CreationActorEffect & {
  effectKey: string;
};
