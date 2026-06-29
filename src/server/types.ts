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
  project?: string;
  automation?: string;
  archived?: boolean;
  plainThreadId?: string;
  /** Model id for runs in this session; unset = default (MICHAEL_MODEL). */
  model?: string;
  /** Codex thread id, when this session has run on a codex-provider model. */
  codexThreadId?: string;
  /** /model switches, newest last — rendered as dividers in the conversation. */
  modelHistory?: Array<{ model: string; at: string; by?: string }>;
  goal?: string;
  loop?: { prompt: string; intervalMinutes: number; lastRunAt?: string; setBy?: string };
  // Other IDs that resolve to this session. The same Claude session can be
  // tracked by multiple files (e.g. a Slack run writes both <branch>.json and
  // <channel>-<threadTs>.json) and external deep links may use any of them.
  aliasIds?: string[];
  // Source-specific
  linearIssue?: { identifier: string; title: string; url?: string };
  slackThread?: { channel: string; threadTs: string };
}

// Slack session file format (two variants exist)
export interface SlackSessionFile {
  branch?: string | null;
  userId?: string;
  message?: string;
  worktreeDir?: string | null;
  claudeSessionId?: string | null;
  createdAt?: string;
  lastActivity?: string;
  channel?: string;
  threadTs?: string;
  mode?: "conversational" | "worktree";
  model?: string;
  codexThreadId?: string | null;
}

// Linear session file format
export interface LinearSessionFile {
  branch: string;
  claudeSessionId: string | null;
  issueIdentifier?: string;
  issueTitle?: string;
  worktreeDir?: string;
  linearSessionId?: string;
  isRalphMode?: boolean;
  issueId?: string;
  issueUrl?: string;
  participants?: Array<{ id: string; name: string; email: string | null }>;
  lastActiveUser?: { id: string; name: string; email: string | null } | null;
  updatedAt?: string;
  model?: string;
}

// CLI session file format (~/.claude/sessions/*.json)
export interface CLISessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

// Backstage session file format
export interface BackstageSessionFile {
  id: string;
  claudeSessionId: string;
  branch: string;
  worktreeDir: string;
  createdBy: string;
  createdAt: string;
  lastActivity: string;
  title?: string;
  mode?: "ask" | "code";
  project?: string; // which repo this session works in (default "tella-fusion")
  automation?: string; // name of the automation that created this session
  plainThreadId?: string; // Plain thread this session is triaging
  model?: string; // model id for this session's runs; unset = default
  codexThreadId?: string; // codex thread id once the session has run on a codex model
  modelHistory?: Array<{ model: string; at: string; by?: string }>;
  archived?: boolean;
  archivedAt?: string;
  goal?: string; // pinned goal, appended to every prompt until cleared
  loop?: { prompt: string; intervalMinutes: number; lastRunAt?: string; setBy?: string };
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
  // Set on a Task/Agent tool_result: the spawned sub-agent's id. The SDK writes
  // the sub-agent's own transcript to <transcript>/subagents/agent-<agentId>.jsonl,
  // so this links a tool call to its sub-agent conversation (see subagents.ts).
  agentId?: string;
  // Ready-to-render image srcs (http(s) URLs or data: URLs) extracted from
  // image blocks — e.g. a Read of an image file, or a pasted image.
  images?: string[];
  // Ready-to-render video srcs (served via /backstage/media) parsed from
  // `BACKSTAGE_VIDEO: <path>` markers a tool printed — e.g. tella-local rec.mjs.
  videos?: string[];
}

export interface FileWatcherState {
  path: string;
  lastMtime: number;
  lastByteOffset: number;
  viewers: Set<any>;
}
