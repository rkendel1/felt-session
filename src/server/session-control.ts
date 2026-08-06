/**
 * session-control — a tiny registry that decouples the opensession-sessions MCP
 * (src/agents/slack/sessions-tools.ts) from the live in-process state that only
 * exists inside the main opensession.ts process: the running-run map, the pending
 * AskUserQuestion map, the prompt queues, and the WebSocket broadcast fan-out.
 *
 * opensession.ts owns all of that and calls registerSessionControl() at startup
 * with an implementation that wires into its own helpers (runSessionPromptAndDrain,
 * steerAgentRun, makeAskHandler, …). The MCP — which is constructed in the Slack
 * handler module, NOT in opensession.ts — reaches it through getSessionControl()
 * without importing opensession.ts (that would re-run the server bootstrap and
 * create a circular import).
 *
 * A future autonomous monitor (src/agents/loops) can call the same
 * getSessionControl() surface directly, no MCP involved.
 */
import type { ImageInput } from "./run-events";
import type { UnifiedSession, TranscriptEntry } from "./types";

/**
 * Derived, at-a-glance status for a session. `waiting_question` is the one the
 * UI/MCP most cares about — a run paused on an AskUserQuestion, needing a human.
 */
export type SessionState =
  | "running"
  | "waiting_question"
  | "queued"
  | "idle"
  | "archived";

/** A pending AskUserQuestion a session is blocked on, surfaced for answering. */
export interface PendingQuestionView {
  questionId: string;
  /** Raw AskUserQuestion `questions` array: each has header/question/options. */
  questions: unknown[];
}

export interface SessionSummary extends UnifiedSession {
  state: SessionState;
  /** Present only when state === "waiting_question". */
  pendingQuestion?: PendingQuestionView;
  /** Messages queued behind an in-flight run. */
  queuedCount: number;
  /** Whether this session's run is owned by this process (steerable/cancelable). */
  controllable: boolean;
}

export interface DeliverResult {
  status: "steered" | "queued" | "started" | "handled" | "error";
  message: string;
}

export interface CreateSessionOpts {
  prompt: string;
  /** Branch for a code-mode worktree session. Ignored for ask mode. */
  branch?: string;
  /** Registered repo id to run in. Defaults to tella-fusion. */
  repo?: string;
  /** "ask" (default) runs read-only on the main checkout; "code" gets a worktree. */
  mode?: "ask" | "code" | "scratch";
  /** Optional model id; invalid input falls back to the default. */
  model?: string;
  /** Reasoning effort persisted on the session and enforced per run. */
  effort?: string;
  /** OpenAI fast-mode flag persisted on the session. */
  fastMode?: boolean;
  /** Composer image attachments as `data:image/...;base64,` URLs. */
  images?: string[];
  /** Optional MCP allowlist for the opening run. Empty array means no MCP servers. */
  mcpServers?: string[];
  /**
   * Join an existing workspace as a sibling session — a new tab, the create path's
   * equivalent of the web tab strip's "+". The session takes the workspace's
   * `workspaceId` (so it lands in that sidebar row's tab strip), defaults its repo
   * to the workspace's, and in code mode shares the workspace's worktree/branch
   * instead of minting its own. An unknown id fails the create rather than
   * silently starting a standalone session.
   */
  workspaceId?: string;
  /** Parent/orchestrator session id when this is a worker sub-session. */
  parentSessionId?: string;
  /** Whether the opening prompt was augmented with parent report-back instructions. */
  reportBack?: boolean;
  /** Display name credited as the creator. */
  user?: string;
  /**
   * Ask for a sandboxed session (the sandbox rollout plan). `true` = the config
   * default provider; a provider id (including "modal" / "lambda-microvm")
   * picks one explicitly and must be configured (~/.opensession-sandbox.json),
   * else the create fails with a clear error.
   */
  sandbox?: boolean | "docker" | "daytona" | "e2b" | "box" | "modal" | "microvm" | "lambda-microvm";
}

/**
 * The control surface the MCP (and future loops) use. Every method operates on
 * the live opensession process state.
 */
export interface SessionControl {
  /** All sessions with creator identity, derived state, queue depth and controllability. */
  listSessions(): SessionSummary[];
  /** One session's summary including creator identity, or undefined if no such id. */
  getSession(id: string): SessionSummary | undefined;
  /** Last `n` transcript entries for a session (for the "what's it doing" view). */
  transcriptTail(id: string, n: number): TranscriptEntry[];
  /**
   * Resolve a session's pending AskUserQuestion. `answers` maps each question's
   * header to the chosen option label. Returns false if nothing was waiting.
   */
  answerQuestion(id: string, answers: Record<string, string>): boolean;
  /**
   * Deliver a message to a session: steer it into the running turn if busy and
   * owned by this process, queue it behind an external run, or start a fresh
   * turn when idle. Fire-and-forget — returns once the message is placed.
   * `opts.busy: "queue"` skips the steer and waits behind the run. Steering is
   * a non-interrupting fold (picked up at the turn's next stopping point), so
   * even FYI events (merge/deploy notifications) steer by default now — only
   * messages that must ride the queue machinery (Slack-thread replies, whose
   * answer mirror needs its own turn) set "queue".
   * `opts.slackReplyTo` marks the message as coming from a Slack thread — the
   * answering turn's reply is mirrored back into that thread (rides the queue,
   * so it survives a busy run and a restart).
   * `opts.images` carries composer attachments on every branch (steer folds
   * them into the live run, the queue stores their data URLs, an idle send
   * passes them to the fresh turn) — that's what lets a REST caller match the
   * WebSocket composer instead of silently dropping the pictures.
   */
  deliverToSession(
    id: string,
    content: string,
    user?: string,
    opts?: {
      busy?: "steer" | "queue";
      slackReplyTo?: { channel: string; threadTs: string };
      /** Decoded images for the run/steer path. */
      images?: ImageInput[];
      /** The same images as `data:` URLs, for the queue's stored copy. */
      imageUrls?: string[];
      /**
       * Hold a queued message until the agent FULLY completes (child workers
       * included) instead of delivering at the next drain point — the web and
       * native composers' "queue" semantics.
       */
      hold?: boolean;
    },
  ): Promise<DeliverResult>;
  /** Cancel a session's in-flight run (only runs this process owns). */
  cancelSession(id: string): boolean;
  /** Create a new session and start its first turn in the background. */
  createSession(opts: CreateSessionOpts): Promise<{
    id: string;
    createdBy: string;
    createdAt: string;
  }>;
}

let impl: SessionControl | null = null;

/** Called once by opensession.ts at startup. */
export function registerSessionControl(c: SessionControl): void {
  impl = c;
}

/** Throws if called before opensession.ts has registered (i.e. outside the server). */
export function getSessionControl(): SessionControl {
  if (!impl) {
    throw new Error(
      "session control not registered — opensession-sessions tools only work inside the opensession server process"
    );
  }
  return impl;
}

/** Non-throwing variant for callers that want to degrade gracefully. */
export function tryGetSessionControl(): SessionControl | null {
  return impl;
}
