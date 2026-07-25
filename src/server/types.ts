export type SessionSource = "slack" | "linear" | "backstage" | "cli";

/**
 * Cumulative token/cost accounting for a chat session, updated after every run.
 * Cost is the API-equivalent USD spend (authoritative `total_cost_usd` from the
 * Claude SDK; computed from the rate table for Codex). `contextTokens` is the
 * size of the most recent turn's full prompt (input + cache read + cache
 * creation) — the live "how full is the window" number, shown against
 * `contextWindow`. `costApproximate` is set when any run in the session priced
 * cost from the table rather than an authoritative SDK figure (i.e. Codex).
 */
export interface SessionUsage {
  costUsd: number;
  costApproximate?: boolean;
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

export interface UnifiedSession {
  id: string;
  /** Present and true when a local-profile server owns this session. */
  local?: boolean;
  /** Cloud destination after a local session was upgraded. */
  upgradedTo?: { id: string; url: string };
  /** Marks a cloud session created by importing a local session. */
  importedFrom?: "local";
  claudeSessionId: string | null;
  source: SessionSource;
  branch: string | null;
  worktreeDir: string | null;
  startedBy: string | null;
  title: string;
  lastActivity: string;
  createdAt: string;
  isRunning: boolean;
  /**
   * When the in-flight run started (ISO), for the "in progress" elapsed ticker
   * in the sidebar. Only set while isRunning; sourced from the run journal, so
   * it survives a page refresh (external CLI/tmux runs have no journal record,
   * so it's absent there and the UI falls back to a client-observed start).
   */
  runStartedAt?: string;
  /**
   * The run-state machine's view of this session (src/server/run-state.ts),
   * stamped by the session-cache enrichment. Only present when not "idle" —
   * lets the UI and session-control tools distinguish running / ask_blocked /
   * interrupted / failed without re-deriving it from busy flags. In-memory
   * (restart-fresh) by design.
   */
  runState?: string;
  transcriptPath: string | null;
  prUrl?: string;
  prState?: "OPEN" | "MERGED" | "CLOSED";
  /** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
  prMergeable?: string;
  // Rich PR fields, populated from the batched gh pr list for the Reviews
  // table's columns (so the list never fetches per-PR).
  prNumber?: number;
  prTitle?: string;
  prIsDraft?: boolean;
  prAdditions?: number;
  prDeletions?: number;
  prChangedFiles?: number;
  prReviewDecision?: string;
  /** Person keys ("kent") of teammates with a pending review request. */
  prReviewRequested?: string[];
  /** Person keys whose latest submitted PR review stands (approved /
   *  changes requested / commented). Open PRs only. */
  prReviewedBy?: string[];
  prAuthor?: string;
  prUpdatedAt?: string;
  prChecks?: { total: number; passed: number; failed: number; pending: number };
  mode?: "ask" | "code";
  /** Primary repo this chat works in (repo id; default "tella-fusion"). */
  repo?: string;
  /** Optional Project (folder) this chat belongs to; null/undefined = standalone. */
  projectId?: string | null;
  /** Parent/orchestrator session when spawned as a worker sub-session. */
  parentSessionId?: string;
  /** Set on a side chat — the parent session it was spawned from and
   *  @-mentions back into. Suppressed from the left sidebar. */
  sideChatOf?: string;
  /** The user's standing Desk (concierge) session — hidden from lists. */
  desk?: boolean;
  /** How many spawn_task hops away from a human-created session this is
   *  (opensession-sessions spawn_task loop guard: refused at depth ≥ 2). Absent =
   *  0 = created by a human or by create_session. */
  spawnDepth?: number;
  /** Secondary repos this session also works in (cross-repo sessions). */
  attachedRepos?: AttachedRepo[];
  /** PRs manually linked to this session (beyond branch/attached-repo ones). */
  linkedPrs?: LinkedPr[];
  /**
   * Every PR associated with this session (primary branch + attached repos +
   * manual links), enriched from the bulk PR cache. The singular pr* fields
   * above stay the primary branch's PR for existing list/Reviews consumers.
   */
  prs?: SessionPrRef[];
  /**
   * Root-relative route the agent recorded as the place to test this change
   * (e.g. `/settings/tags`). Appended to the Preview (local dev) and Staging
   * (PR deploy) URLs so a click lands directly on the feature under test.
   */
  previewPath?: string;
  /** Agent-published demo walkthrough (opensession-walkthrough). */
  walkthrough?: SessionWalkthrough;
  automation?: string;
  /** Stable automation id for linking back to its settings. Older sessions may
   *  only have `automation`, which the settings route also accepts by name. */
  automationId?: string;
  archived?: boolean;
  /** Why this session is archived — powers the "Auto-archived" filter. */
  archivedReason?: "manual" | "idle" | "auto" | "plain";
  plainThreadId?: string;
  /** Model id for runs in this session; unset = default (MICHAEL_MODEL). */
  model?: string;
  /** OpenCode reasoning variant for runs in this session; unset = model default. */
  effort?: string;
  /** Use OpenAI's priority service tier for ChatGPT OAuth Codex runs. */
  fastMode?: boolean;
  /**
   * Pinned provider account for runs in this session. The id belongs to the
   * active model's Claude or Codex pool. Unset = auto (personal-first, shared
   * pool fallback); an exhausted soft pin falls back to another eligible account.
   */
  accountId?: string;
  /** Codex thread id, when this session has run on a codex-provider model. */
  codexThreadId?: string;
  /** OpenCode session id (`ses_…`), when this session has run on an
   *  opencode/* model. Its own slot (not the claude slot) so a migration to
   *  the opencode engine keeps the claude history resumable/readable. Legacy
   *  session files from before this field may still carry a `ses_…` id in
   *  claudeSessionId — readers fall back on the id shape. */
  opencodeSessionId?: string;
  /** Provider whose engine last drove a run — lets the next run detect an
   *  in-place cross-provider switch and bridge context. */
  lastEngineProvider?: "claude" | "codex" | "opencode";
  /** Model that last actually drove a run. Anthropic and OpenAI models both
   *  report provider "opencode", so provider alone can't detect a family
   *  switch (which lands on another server as a fresh engine session and
   *  needs a transcript bridge) — this can. */
  lastEngineModel?: string;
  /** /model switches, newest last — rendered as dividers in the conversation.
   *  `from` is the model in effect before the switch (for a "X → Y" divider). */
  modelHistory?: Array<{ model: string; from?: string; at: string; by?: string }>;
  /** Cumulative token/cost accounting for this session's runs. */
  usage?: SessionUsage;
  goal?: string;
  /** Goal record id, when this session is driven by a Goal (src/server/goals.ts). */
  goalId?: string;
  /**
   * The session's last run died on a terminal failure (usage limits exhausted
   * on every account, credit/API errors) — a human must act before the session
   * can continue, so the UI surfaces it as "Needs input" instead of Backlog.
   * Cleared by the next run that ends cleanly.
   */
  lastRunError?: { message: string; at: string };
  /**
   * Manual sidebar-lane override (Needs input / In progress / In review / Done /
   * Backlog). When set it wins over the derived lane in the sidebar, letting a
   * human pin a session where they want it. Set from the status-override
   * registry in getAllSessions; unset = derive the lane as usual.
   */
  manualStatus?: "needsinput" | "inprogress" | "review" | "merged" | "pending";
  /**
   * True when `title` is a manual rename (title-override registry) rather than
   * a derived/generated one. The sidebar names shared-worktree rows after the
   * branch because generated titles drift — a manual rename is explicit user
   * intent and should win there too.
   */
  titleOverridden?: boolean;
  /**
   * A pending "please review this" pointed at a teammate, set from the info
   * panel's Reviewer picker. Surfaces the session in a "Needs review" band at
   * the top of the reviewer's sidebar. Set from the review-request registry in
   * getAllSessions; cleared by picking "No reviewer" (or re-assigning).
   */
  reviewRequest?: {
    to: string;
    by: string;
    at: string;
    accepted?: { by: string; at: string };
  };
  loop?: { prompt: string; intervalMinutes: number; lastRunAt?: string; setBy?: string };
  // Other IDs that resolve to this session. The same Claude session can be
  // tracked by multiple files (e.g. a Slack run writes both <branch>.json and
  // <channel>-<threadTs>.json) and external deep links may use any of them.
  aliasIds?: string[];
  /** Slack threads this session posted to (automation runs capture their own
   *  posts here) — a reply in one of these threads drives THIS session instead
   *  of starting a new one (thread index in slack-links.ts). */
  slackThreads?: Array<{ channel: string; threadTs: string }>;
  // Source-specific
  linearIssue?: { identifier: string; title: string; url?: string };
  slackThread?: { channel: string; threadTs: string };
  mcpServers?: string[]; // External MCP servers loaded for this session
  /** Sandbox opt-in (docs/sandboxes-plan.md): mirrors the session file's field.
   *  Runs route through the named provider when config + kill-switch allow;
   *  `sandboxId` is set once a provider materializes the sandbox (Phase 1+).
   *  `workspace` records how the workspace was materialized: "volume" means it
   *  lives ONLY inside the sandbox (no host worktree — Phase 2). */
  sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
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
/**
 * A secondary repo attached to a session for cross-repo work. Each gets its own
 * isolated worktree (never the shared main checkout), so the agent can branch,
 * commit, and open a PR there independently of the primary repo.
 */
export interface AttachedRepo {
  repo: string; // repo id (key in worktree.ts REPOS)
  branch: string;
  dir: string; // worktree path
}

/**
 * A pull request manually linked to a session, beyond the ones derived from
 * its own branch (primary repo) and attached repos. Keyed by repo+branch —
 * the whole PR pipeline (pr-info, the bulk PR cache) is branch-keyed — with
 * number/url/title stored as a fallback label for repos outside the PR cache.
 */
export interface LinkedPr {
  repo: string; // repo id (key in worktree.ts REPOS)
  branch: string; // the PR's head branch
  number?: number;
  url?: string;
  title?: string;
}

/**
 * One PR associated with a session, resolved at list time: the primary
 * branch's PR, an attached repo's PR, or a manually linked one. Enriched from
 * the bulk PR cache when covered; a linked PR outside the cache keeps its
 * stored url/number/title with no live state.
 */
export interface SessionPrRef {
  repo: string;
  branch: string;
  source: "primary" | "attached" | "linked";
  url?: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  number?: number;
  title?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
  checks?: { total: number; passed: number; failed: number; pending: number };
}

/** One before/after screenshot pair in a session walkthrough. Paths are
 *  absolute, under the walkthrough uploads dir (staged copies — never the
 *  agent's worktree/tmp originals, which vanish when the worktree is pruned). */
export interface WalkthroughShot {
  before?: string;
  after?: string;
  caption?: string;
}

/**
 * A Cursor-style PR walkthrough the agent publishes when it finishes a
 * user-visible change: a short demo video, before/after screenshots, and a
 * writeup. Rendered inline in the session's Review tab and mirrored into the
 * GitHub PR description (video + images as os.tella.dev links there — the
 * server is tailnet-only, so GitHub's camo proxy can't inline them).
 */
export interface SessionWalkthrough {
  /** Markdown writeup: what changed, root cause, how it was verified. */
  summary: string;
  /** Absolute path to the staged demo video (mp4/webm/mov), if any. */
  video?: string;
  videoTitle?: string;
  shots?: WalkthroughShot[];
  publishedAt: string;
  publishedBy?: string;
}

export interface BackstageSessionFile {
  id: string;
  claudeSessionId: string;
  branch: string;
  worktreeDir: string;
  /** Secondary repos this session also works in (cross-repo sessions). */
  attachedRepos?: AttachedRepo[];
  /** PRs manually linked to this session (beyond branch/attached-repo ones). */
  linkedPrs?: LinkedPr[];
  /** Root-relative route the Preview/Preview environment buttons deep-link to (set by the
   *  agent via opensession-preview's set_preview_path). Unset = open the app root. */
  previewPath?: string;
  /** Agent-published demo walkthrough (opensession-walkthrough). */
  walkthrough?: SessionWalkthrough;
  createdBy: string;
  /** Verified GitHub login of the creator — stamped when GitHub web sign-in
   *  is active (web-auth.ts), and backfilled onto older sessions by the
   *  one-time boot migration (resolved from createdBy via the identity
   *  table). Absent on automation sessions and unresolvable creators. */
  createdByLogin?: string;
  createdAt: string;
  lastActivity: string;
  title?: string;
  mode?: "ask" | "code";
  repo?: string; // which repo this chat works in (default "tella-fusion")
  workspaceId?: string | null; // Workspace this chat belongs to (canonical key)
  projectId?: string | null; // legacy alias of workspaceId (dual-read during migration)
  /** Parent/orchestrator session when this chat was spawned as a visible worker sub-session. */
  parentSessionId?: string;
  /** Set on a side chat — the parent session it was spawned from and
   *  @-mentions back into. Suppressed from the left sidebar. */
  sideChatOf?: string;
  /** The user's standing Desk (concierge) session — fixed title, suppressed
   *  from the session lists, opened via the Desk overlay. */
  desk?: boolean;
  /** spawn_task hop count from a human-created session (loop guard; see
   *  UnifiedSession.spawnDepth). Stamped by opensession-sessions' spawn_task. */
  spawnDepth?: number;
  /** This session was opened as a worker that owes its parent a report
   *  (spawn_task, or create_session without reportBack:false). */
  reportBack?: boolean;
  /** When this worker last reported back to its parent (send_to_session to
   *  parentSessionId). Suppresses the failure beacon: a worker that already
   *  said its piece doesn't need the server saying it again. */
  lastReportToParentAt?: string;
  /** When the server last told this worker's parent that a run died here
   *  (handoff-evidence beacon) — throttles repeats. */
  parentNotifiedAt?: string;
  automation?: string; // name of the automation that created this session
  automationId?: string; // id of that automation — lets a Slack thread reply "retrigger" re-fire it
  /** The triggering event payload of the automation run that created this
   *  session (truncated like the prompt embed). A "retrigger" replays the
   *  automation with this exact payload. */
  automationEvent?: string;

  plainThreadId?: string; // Plain thread this session is triaging
  model?: string; // model id for this session's runs; unset = default
  effort?: string; // OpenCode reasoning variant for this session's runs; unset = model default
  fastMode?: boolean; // OpenAI priority service tier for ChatGPT OAuth Codex runs
  accountId?: string; // pinned Claude/Codex provider account; unset = auto pool
  codexThreadId?: string; // codex thread id once the session has run on a codex model
  opencodeSessionId?: string; // opencode session id (ses_…) once the session has run on an opencode/* model
  /** Provider whose engine last actually drove a run in this session. Lets the
   *  next run detect an in-place cross-provider switch (Claude↔Codex) and hand
   *  the incoming engine a transcript bridge so context carries over. */
  lastEngineProvider?: "claude" | "codex" | "opencode";
  lastEngineModel?: string; // model that last drove a run (family-switch detection)
  modelHistory?: Array<{ model: string; from?: string; at: string; by?: string }>;
  usage?: SessionUsage; // cumulative token/cost accounting for this session's runs
  archived?: boolean;
  archivedAt?: string;
  archivedReason?: "manual" | "idle" | "auto" | "plain";
  /** Cloud destination after this local session was upgraded. */
  upgradedTo?: { id: string; url: string };
  /** Marks a cloud session created by importing a local session. */
  importedFrom?: "local";
  goal?: string; // pinned goal, appended to every prompt until cleared
  goalId?: string; // Goal record this session is driven by (src/server/goals.ts)
  lastRunError?: { message: string; at: string }; // last run died on a terminal error; cleared on the next clean run
  loop?: { prompt: string; intervalMinutes: number; lastRunAt?: string; setBy?: string };
  /** Slack threads this session posted to (see UnifiedSession.slackThreads). */
  slackThreads?: Array<{ channel: string; threadTs: string }>;
  mcpServers?: string[]; // External MCP servers to load for this session; empty = none (minimal context)
  /** Sandbox opt-in (docs/sandboxes-plan.md): recorded at create time when the
   *  creator asked for a sandbox. `provider` is the effective provider id at
   *  creation ("local" until a real provider is configured); `sandboxId` is
   *  set once a provider materializes a sandbox for the session (Phase 1+);
   *  `workspace` records the materialized mode — "volume" workspaces live only
   *  inside the sandbox (no host worktree; Phase 2). */
  sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
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
  // Set on a tool_result whose block carried is_error — the UI shows the step
  // with an error state instead of a success check.
  isError?: boolean;
  // On assistant text entries: the model that wrote this message (Claude jsonl
  // message.model, or the run's opencode/<provider>/<model> id). Per-message —
  // mid-session switches and usage-limit fallbacks make the session-level
  // model unreliable history.
  model?: string;
  // Set on a Task/Agent tool_result: the spawned sub-agent's id. The SDK writes
  // the sub-agent's own transcript to <transcript>/subagents/agent-<agentId>.jsonl,
  // so this links a tool call to its sub-agent conversation (see subagents.ts).
  agentId?: string;
  // Ready-to-render image srcs (http(s), data:, or authenticated local-media
  // URLs) extracted from image blocks — e.g. a Read or a pasted image.
  images?: string[];
  // Ready-to-render video srcs (served via /backstage/media) parsed from
  // `BACKSTAGE_VIDEO: <path>` markers a tool printed — e.g. tella-local rec.mjs.
  videos?: string[];
  // Non-media composer attachments (staged to disk server-side) parsed back out
  // of the uploads note — rendered as downloadable chips on the user bubble.
  files?: { name: string; path: string }[];
  // Set when `content` was clamped for the UI WebSocket (see
  // clampEntriesForWire in jsonl-parser.ts) — `contentLength` is the full
  // length; the UI fetches the whole entry on demand.
  contentClamped?: boolean;
  contentLength?: number;
  /** Owned transcript-store display order and mutation cursor. Present only
   * on v2 frames; changeSeq advances on both inserts and rewrites. */
  seq?: number;
  changeSeq?: number;
  // Set on a system entry holding an engine context-compaction summary (the
  // handoff the model wrote when its history was summarized to fit the
  // context window) — the UI renders a collapsed "context compacted" chip
  // instead of an assistant bubble.
  compaction?: boolean;
}

export interface FileWatcherState {
  path: string;
  lastMtime: number;
  lastByteOffset: number;
  viewers: Set<any>;
}
