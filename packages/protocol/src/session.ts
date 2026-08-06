/**
 * Session protocol — the client ↔ server contract for watching and driving a
 * cloud agent session: the durable record types (transcript entries, usage,
 * asks) and the core WebSocket frames every session viewer/driver speaks.
 *
 * This is the "bring your own UI" layer. A conformant client can render a
 * live session with nothing but these frames: watch → transcript_init (+
 * transcript_append / load_history pages), the stream_* / session_feed live
 * turn events, prompt/cancel/queue control to drive it, and ask_question /
 * ask_resolved for human-in-the-loop questions.
 *
 * The reference web UI multiplexes app extensions over the same socket —
 * collaborative notes, terminals, presence, PR/report/todo change
 * pings. Those are deliberately NOT here: they're the app, not the protocol.
 * The frontend composes its full unions as `ProtocolClientMessage | <app
 * variants>` (src/frontend/lib/types.ts), which keeps this file the single
 * authoritative statement of the core surface.
 *
 * Compatibility stance (same as the native clients document): fields are
 * added, never repurposed; a server ahead of a client adds keys, it never
 * breaks one. Unknown frame types must be ignored by clients.
 */

/** One rendered line of a session's durable transcript (the jsonl record). */
export interface TranscriptEntry {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  requestId?: string;
  // Set on a tool_result whose block carried is_error — the UI shows the step
  // with an error state instead of a success check.
  isError?: boolean;
  // On assistant text entries: the model that wrote this message. Per-message —
  // mid-session switches and usage-limit fallbacks make the session-level
  // model unreliable history.
  model?: string;
  // Set on a Task/Agent tool_result: the spawned sub-agent's id, linking a
  // tool call to that sub-agent's own transcript.
  agentId?: string;
  // Ready-to-render image srcs (http(s), data:, or authenticated local-media
  // URLs) extracted from image blocks — e.g. a Read or a pasted image.
  images?: string[];
  // Ready-to-render video srcs (served via the media endpoint) parsed from
  // `OPENSESSION_VIDEO: <path>` markers a tool printed.
  videos?: string[];
  // Non-media composer attachments (staged to disk server-side) — rendered as
  // downloadable chips on the user bubble.
  files?: { name: string; path: string }[];
  // Set when `content` was clamped for the WebSocket wire — `contentLength`
  // is the full length; the full entry is at GET /api/sessions/:id/entry/:id.
  contentClamped?: boolean;
  contentLength?: number;
  /** Transcript v2: immutable display order plus monotonic mutation cursor.
   *  Present only on v2 frames; changeSeq advances on inserts and rewrites. */
  seq?: number;
  changeSeq?: number;
  // Set on a system entry holding an engine context-compaction summary — the
  // UI renders a collapsed "context compacted" chip, not an assistant bubble.
  compaction?: boolean;
  // Set on a system entry holding a session recap (the away-summary written
  // when a turn finished with nobody watching) — rendered as a "recap:" line.
  recap?: boolean;
}

/** Cumulative token/cost accounting for a session, as viewers render it. */
export interface SessionUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Most recent turn's full prompt size (context currently in use). */
  contextTokens: number;
  /** Token ceiling of the model that produced `contextTokens`. */
  contextWindow: number;
  /** Number of completed turns folded into these totals. */
  turns: number;
  /** ISO time of the last update. */
  updatedAt: string;
}

/** One question of a human-in-the-loop ask (AskUserQuestion payload). */
export interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** A prompt waiting in (or steered out of) a session's queue. */
export interface QueuedPrompt {
  id: string;
  content: string;
  user?: string;
  images?: string[];
  files?: unknown;
}

/**
 * Core client → server frames: everything needed to watch and drive a
 * session. The reference UI's full union adds app variants on top.
 */
export type ProtocolClientMessage =
  // Liveness probe — the server echoes `pong`. Detects half-open sockets
  // (iOS/Safari kills backgrounded connections without firing onclose).
  | { type: "ping" }
  | {
      type: "watch";
      sessionId: string;
      user?: string;
      /** Reconnect resume cursor: the endOffset/rev of the last
       *  transcript_init/append this client received for the session. When
       *  they still match the live mirror file, the server skips the full
       *  transcript_init replace and replays only the gap from the jsonl. */
      sinceOffset?: number;
      sinceRev?: string;
      /** Transcript v2 capability: this client understands seq-cursor
       *  frames (docs/transcripts.md). Old servers ignore it. */
      supportsSeq?: boolean;
      /** This client resumes every mutation, including old-seq rewrites. */
      supportsChangeSeq?: boolean;
      /** Seq-mode resume cursor: the lastSeq of the last v2 frame this
       *  client received for the session (used instead of offset/rev). */
      sinceSeq?: number;
      sinceChangeSeq?: number;
      /** Ordered ephemeral-feed capability and reconnect cursor. */
      supportsFeed?: boolean;
      sinceFeedSeq?: number;
      feedEpoch?: string;
    }
  | { type: "unwatch"; sessionId: string }
  | {
      type: "load_history";
      sessionId: string;
      beforeOffset?: number;
      beforeRev?: string;
      /** Transcript v2 seq paging: earliest seq the client holds — the
       *  server returns the page just before it. */
      beforeSeq?: number;
      /** Entries per page (seq paging only), server-capped. */
      limit?: number;
    }
  | {
      type: "prompt";
      sessionId: string;
      content: string;
      user?: string;
      images?: string[];
      files?: unknown;
      busyMode?: "queue" | "steer";
      /** Reasoning effort — persisted on the session and enforced per run. */
      effort?: "low" | "medium" | "high" | string;
      fastMode?: boolean;
      /** Sibling-session ids whose transcripts ride along as context. */
      contextChats?: string[];
    }
  | {
      type: "interrupt_prompt";
      sessionId: string;
      content: string;
      user?: string;
      images?: string[];
      files?: unknown;
      effort?: "low" | "medium" | "high" | string;
      fastMode?: boolean;
    }
  | {
      type: "delete_queued_prompt";
      sessionId: string;
      queueId?: string;
      queueIndex?: number;
    }
  | {
      type: "update_queued_prompt";
      sessionId: string;
      queueId?: string;
      queueIndex?: number;
      content: string;
    }
  | {
      type: "steer_queued_prompt";
      sessionId: string;
      queueId?: string;
      queueIndex?: number;
    }
  | {
      type: "interrupt_queued_prompt";
      sessionId: string;
      queueId?: string;
      queueIndex?: number;
    }
  | {
      // Drag-to-reorder: `order` is the queued items' ids in their new send
      // order. The server reconciles its queue array to match.
      type: "reorder_queued_prompt";
      sessionId: string;
      order: string[];
    }
  | { type: "cancel" }
  | {
      type: "create_session";
      branch: string;
      prompt: string;
      user: string;
      /** Local-profile bridge only: create this session on the hosted upstream. */
      cloud?: boolean;
      mode?: "ask" | "code" | "scratch";
      repo?: string;
      /** Existing workspace to add this new session to. */
      workspaceId?: string;
      /** Create a new workspace for this session. */
      createWorkspace?: { name?: string };
      /**
       * How the session relates to its workspace's worktree: share it (default),
       * stack a new worktree off it, or ask (no worktree).
       */
      worktreeMode?: "share" | "stack" | "ask";
      model?: string;
      /** Optional MCP server allowlist for the opening run. [] means none. */
      mcpServers?: string[];
      /** Run in a sandbox: true = server's default provider, or an explicit
       *  configured provider id. Omit = host. */
      sandbox?: boolean | string;
      images?: string[];
      /** Reasoning effort — persisted on the new session and enforced per run. */
      effort?: "low" | "medium" | "high";
      /** Fork an existing session, keeping its real conversation history. */
      forkFrom?: { sourceId: string; messageId?: string };
      /**
       * Session opened from a PR: `branch` is the PR's existing head branch —
       * check it out (isolated worktree) instead of branching off the default.
       */
      fromPr?: boolean;
    };

/**
 * Core server → client frames. sessionId on the session-scoped messages lets
 * viewers drop events meant for a different session (socket races,
 * creator-side direct sends); optional where a few direct replies
 * legitimately have no session.
 */
export type ProtocolServerMessage =
  // First frame on every socket: the server process's bootId, so a reconnect
  // can tell a real restart (changed) from a transient blip (unchanged).
  // `restartBy` (when the boot was seconds after a shutdown) names the
  // session that likely triggered that restart.
  | { type: "hello"; bootId: string; restartBy?: string }
  | {
      type: "transcript_init";
      sessionId?: string;
      entries: TranscriptEntry[];
      truncated?: boolean;
      /** Byte offset the shipped tail begins at — the "load earlier"
       *  pagination cursor (absent on older servers → full-resend fallback). */
      startOffset?: number;
      /** Resume cursor: where this snapshot ends in the mirror file, and an
       *  opaque tag identifying which file that was. Echoed back on a
       *  reconnect watch as sinceOffset/sinceRev. */
      endOffset?: number;
      rev?: string;
      /** Transcript v2 (seq protocol): present iff served from the owned
       *  store. firstSeq/lastSeq bound the shipped entries' seqs; their
       *  presence switches the client into seq mode for the session. */
      v2?: boolean;
      firstSeq?: number;
      lastSeq?: number;
      lastChangeSeq?: number;
    }
  | {
      /** Older entries from one "load earlier" page. Client merges by id and
       *  re-sorts by time (prepend semantics). */
      type: "transcript_history";
      sessionId?: string;
      entries: TranscriptEntry[];
      truncated?: boolean;
      startOffset?: number;
      /** Transcript v2 seq page bounds (see transcript_init). */
      v2?: boolean;
      firstSeq?: number;
      lastSeq?: number;
    }
  | {
      type: "transcript_append";
      sessionId?: string;
      entries: TranscriptEntry[];
      /** Resume cursor after this append (see transcript_init.endOffset). */
      endOffset?: number;
      rev?: string;
      /** Transcript v2 seq bounds. Upsert republishes reuse the entry's
       *  ORIGINAL seq, so firstSeq can sit below the client's lastSeq —
       *  merge by id, track lastSeq as a max, never assume monotonic. */
      v2?: boolean;
      firstSeq?: number;
      lastSeq?: number;
      lastChangeSeq?: number;
    }
  | {
      type: "session_feed";
      sessionId: string;
      feedEpoch: string;
      feedSeq: number;
      runId?: string;
      turnId?: string;
      entryId?: string;
      phase: "delta" | "committed" | "status";
      event:
        | {
            type: "transcript_append";
            sessionId?: string;
            entries: TranscriptEntry[];
            firstSeq?: number;
            lastSeq?: number;
            lastChangeSeq?: number;
            v2?: boolean;
          }
        | { type: "stream_start"; sessionId: string; by?: string }
        | { type: "stream_text"; sessionId?: string; text: string }
        | { type: "stream_tool_use"; sessionId?: string; entry: TranscriptEntry }
        | { type: "stream_tool_result"; sessionId?: string; entry: TranscriptEntry }
        | { type: "stream_done"; sessionId?: string }
        | { type: "session_status"; sessionId?: string; isRunning: boolean };
    }
  | {
      type: "feed_snapshot";
      sessionId: string;
      feedEpoch: string;
      feedSeq: number;
      active: null | {
        runId: string;
        turnId: string;
        entryId: string;
        by?: string;
        text: string;
        startedAt: number;
      };
    }
  | { type: "session_status"; sessionId?: string; isRunning: boolean }
  | { type: "stream_start"; sessionId: string; by?: string }
  | { type: "stream_text"; sessionId?: string; text: string }
  | { type: "stream_tool_use"; sessionId?: string; entry: TranscriptEntry }
  | { type: "stream_tool_result"; sessionId?: string; entry: TranscriptEntry }
  | { type: "stream_done"; sessionId?: string }
  | { type: "usage_update"; sessionId: string; usage: SessionUsage }
  | {
      type: "session_created";
      id: string;
      workspaceId?: string;
      /** True when this create made a brand-new workspace (vs. adding a session). */
      newWorkspace?: boolean;
      /** True while the session's worktree is still being created. */
      preparingWorkspace?: boolean;
    }
  // The create run finished (or failed) preparing the session's worktree.
  | { type: "workspace_status"; sessionId: string; ready: boolean }
  | { type: "model_changed"; sessionId: string; model: string; from?: string; by?: string }
  | {
      type: "queue_update";
      sessionId: string;
      queued: QueuedPrompt[];
      steered?: QueuedPrompt[];
    }
  | {
      type: "ask_question";
      sessionId: string;
      questionId: string;
      questions: AskQuestion[];
    }
  | { type: "ask_resolved"; sessionId: string; questionId: string }
  | { type: "notice"; sessionId?: string; message: string }
  | { type: "pong" }
  | { type: "error"; sessionId?: string; message: string };
