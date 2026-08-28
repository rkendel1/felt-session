/**
 * Autonomous Collaboration State Machine: Evidence-based task progression.
 *
 * States transition only when evidence supports it, not on agent promises.
 * This is the orchestration core of PR7.
 *
 * States:
 * TASK_CREATED → ARCHITECTING → DESIGNED → BUILDING → BUILT → REVIEWING → 
 * (approved) → TESTING → VALIDATED → RELEASE_READY → (GitHub/merge)
 * (rejected) → BUILDING (restart)
 * (failed tests) → BUILDING (restart)
 */

export type CollaborationPhase =
  | "TASK_CREATED"
  | "ARCHITECTING"
  | "DESIGNED"
  | "BUILDING"
  | "BUILT"
  | "REVIEWING"
  | "REVIEW_APPROVED"
  | "TESTING"
  | "VALIDATED"
  | "RELEASE_READY"
  | "RELEASED"
  | "FAILED";

export interface PhaseTransition {
  id: string;
  taskId: string;
  fromPhase: CollaborationPhase;
  toPhase: CollaborationPhase;
  transitionedBy: string;
  evidence: Array<{
    type: "test" | "build" | "review" | "decision" | "evidence";
    ref: string;
    timestamp: string;
  }>;
  timestamp: string;
}

export interface CollaborationState {
  id: string;
  taskId: string;
  projectId: string;
  phase: CollaborationPhase;
  agentSequence: string[];
  currentAgentId: string;
  completedPhases: CollaborationPhase[];
  failedAttempts: number;
  lastTransitionAt: string;
  transitions: PhaseTransition[];
}

/**
 * Evidence gates: what proof is needed for each transition?
 */
export const EVIDENCE_GATES: Record<
  CollaborationPhase,
  {
    nextPhase: CollaborationPhase;
    requiredEvidence: string[];
  }[]
> = {
  TASK_CREATED: [
    {
      nextPhase: "ARCHITECTING",
      requiredEvidence: ["task_created"],
    },
  ],
  ARCHITECTING: [
    {
      nextPhase: "DESIGNED",
      requiredEvidence: ["architecture_decided"],
    },
  ],
  DESIGNED: [
    {
      nextPhase: "BUILDING",
      requiredEvidence: ["design_reviewed"],
    },
  ],
  BUILDING: [
    {
      nextPhase: "BUILT",
      requiredEvidence: ["code_committed", "build_passes"],
    },
  ],
  BUILT: [
    {
      nextPhase: "REVIEWING",
      requiredEvidence: ["pr_created"],
    },
  ],
  REVIEWING: [
    {
      nextPhase: "REVIEW_APPROVED",
      requiredEvidence: ["pr_approved"],
    },
    {
      nextPhase: "BUILDING",
      requiredEvidence: ["changes_requested"],
    },
  ],
  REVIEW_APPROVED: [
    {
      nextPhase: "TESTING",
      requiredEvidence: ["review_approved"],
    },
  ],
  TESTING: [
    {
      nextPhase: "VALIDATED",
      requiredEvidence: ["tests_passed"],
    },
    {
      nextPhase: "BUILDING",
      requiredEvidence: ["tests_failed"],
    },
  ],
  VALIDATED: [
    {
      nextPhase: "RELEASE_READY",
      requiredEvidence: ["validation_complete"],
    },
  ],
  RELEASE_READY: [
    {
      nextPhase: "RELEASED",
      requiredEvidence: ["pr_merged", "deployed"],
    },
  ],
  RELEASED: [
    {
      nextPhase: "RELEASED",
      requiredEvidence: [],
    },
  ],
  FAILED: [
    {
      nextPhase: "TASK_CREATED",
      requiredEvidence: ["retry_approved"],
    },
  ],
};

export interface AutonomousCollaborationOrchestrator {
  /**
   * Initialize collaboration for a task.
   */
  initializeCollaboration(
    taskId: string,
    projectId: string
  ): Promise<CollaborationState>;

  /**
   * Current phase for a task.
   */
  getPhase(taskId: string): Promise<CollaborationPhase>;

  /**
   * Check if transition is valid given evidence.
   */
  canTransition(
    state: CollaborationState,
    toPhase: CollaborationPhase,
    evidence: Array<{ type: string; ref: string }>
  ): { valid: boolean; missingEvidence?: string[] };

  /**
   * Transition to a new phase (with evidence).
   */
  transitionPhase(
    taskId: string,
    toPhase: CollaborationPhase,
    agentId: string,
    evidence: Array<{ type: string; ref: string }>
  ): Promise<CollaborationState>;

  /**
   * Record that current agent failed, restart from last good phase.
   */
  failPhaseAndRestart(
    taskId: string,
    agentId: string,
    error: string
  ): Promise<CollaborationState>;

  /**
   * Get full transition history for a task.
   */
  getTransitionHistory(taskId: string): Promise<PhaseTransition[]>;

  /**
   * Get next valid agent for current phase.
   */
  getNextAgent(state: CollaborationState): string | undefined;

  /**
   * Conclude collaboration (success or failure).
   */
  concludeCollaboration(
    taskId: string,
    finalPhase: "RELEASED" | "FAILED"
  ): Promise<void>;
}

/**
 * What does each phase require the agent to do?
 */
export const PHASE_AGENT_MAP: Record<
  CollaborationPhase,
  "architect" | "builder" | "reviewer" | "tester" | "github" | "none"
> = {
  TASK_CREATED: "none",
  ARCHITECTING: "architect",
  DESIGNED: "architect",
  BUILDING: "builder",
  BUILT: "builder",
  REVIEWING: "reviewer",
  REVIEW_APPROVED: "reviewer",
  TESTING: "tester",
  VALIDATED: "tester",
  RELEASE_READY: "github",
  RELEASED: "github",
  FAILED: "none",
};

/**
 * Recovery: if Mission Control crashes mid-collaboration, can it recover?
 */
export interface CollaborationRecovery {
  taskId: string;
  currentPhase: CollaborationPhase;
  lastTransition: {
    timestamp: string;
    agentId: string;
    toPhase: CollaborationPhase;
  };
  incompleteAgent: {
    agentId: string;
    phase: CollaborationPhase;
  } | null;
  contextSnapshot: {
    commitSha: string;
    graphVersion: number;
  };
  nextAction: string; // what to do on restart
}
