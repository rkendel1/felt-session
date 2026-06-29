export type SessionSource = "slack" | "linear" | "backstage" | "cli";

export interface UnifiedSession {
  id: string;
  claudeSessionId: string | null;
  source: SessionSource;
  branch: string | null;
  worktreeDir: string | null;
  startedBy: string | null;
  title: string;
  lastActivity: string;
  createdAt: string;
  isRunning: boolean;
  transcriptPath: string | null;
  prUrl?: string;
  prState?: "OPEN" | "MERGED" | "CLOSED";
  mode?: "ask" | "code";
  automation?: string;
  archived?: boolean;
  plainThreadId?: string;
  goal?: string;
  loop?: { prompt: string; intervalMinutes: number; lastRunAt?: string; setBy?: string };
  aliasIds?: string[];
  model?: string;
  codexThreadId?: string;
  modelHistory?: Array<{ model: string; at: string; by?: string }>;
  linearIssue?: { identifier: string; title: string; url?: string };
  slackThread?: { channel: string; threadTs: string };
}

export interface TranscriptEntry {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  requestId?: string;
  // Set on a Task/Agent tool_result: the spawned sub-agent's id. Lets the UI
  // open that sub-agent's conversation in the right sidebar.
  agentId?: string;
  // Ready-to-render image srcs (http(s) URLs or data: URLs), e.g. from a Read
  // of an image file or a pasted image.
  images?: string[];
  // Ready-to-render video srcs (served via /backstage/media), parsed from
  // `BACKSTAGE_VIDEO: <path>` markers a tool printed — e.g. tella-local rec.mjs.
  videos?: string[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface SessionDiff {
  branch: string | null;
  baseRef: string | null;
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  rawPatch: string;
  truncated?: boolean;
}

export interface PrCheck {
  name: string;
  status: string;
  conclusion: string;
  url?: string;
}

export interface PrDetails {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  body: string;
  checks: PrCheck[];
}

export type WSClientMessage =
  | { type: "watch"; sessionId: string; user?: string }
  | { type: "prompt"; sessionId: string; content: string; user?: string; images?: string[] }
  | { type: "interrupt_prompt"; sessionId: string; content: string; user?: string }
  | { type: "cancel" }
  | {
      type: "create_session";
      branch: string;
      prompt: string;
      user: string;
      mode?: "ask" | "code";
      project?: string;
      model?: string;
      images?: string[];
      /** Fork an existing session, keeping its real conversation history. */
      forkFrom?: { sourceId: string; messageId?: string };
    };

export type WSServerMessage =
  | { type: "transcript_init"; entries: TranscriptEntry[] }
  | { type: "transcript_append"; entries: TranscriptEntry[] }
  | { type: "session_status"; isRunning: boolean }
  | { type: "presence"; sessionId: string; viewers: string[] }
  | { type: "stream_start"; sessionId: string; by?: string }
  | { type: "stream_text"; text: string }
  | { type: "stream_tool_use"; entry: TranscriptEntry }
  | { type: "stream_tool_result"; entry: TranscriptEntry }
  | { type: "stream_done" }
  | { type: "session_created"; id: string }
  | { type: "notice"; message: string }
  | { type: "model_changed"; sessionId: string; model: string; by?: string }
  | {
      type: "queue_update";
      sessionId: string;
      queued: Array<{ content: string; user?: string }>;
      steered?: Array<{ content: string; user?: string }>;
    }
  | { type: "ask_question"; sessionId: string; questionId: string; questions: AskQuestion[] }
  | { type: "ask_resolved"; sessionId: string; questionId: string }
  | { type: "server_restarting" }
  | { type: "frontend_updated"; version: string }
  | { type: "error"; message: string };

export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}
