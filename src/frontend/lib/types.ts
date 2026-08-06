// Type-only (erased at build): the dynamic-workflow run snapshot broadcast to
// the session's Agents panel.
import type { WorkflowRunSnapshot } from "../../shared/workflow-types";
// The protocol core: durable record types and the WebSocket frames any
// session client speaks. This file re-exports them and layers the reference
// app's own variants on top — new frames go in the package when any client
// would need them, here when they're this app's feature.
import type {
	ProtocolClientMessage,
	ProtocolServerMessage,
} from "@tellahq/opensession-protocol/session";

export type {
	TranscriptEntry,
	SessionUsage,
	AskQuestion,
	ProtocolClientMessage,
	ProtocolServerMessage,
} from "@tellahq/opensession-protocol/session";
import type {
	TranscriptEntry,
	SessionUsage,
	AskQuestion,
} from "@tellahq/opensession-protocol/session";

export type SessionSource = "slack" | "linear" | "opensession" | "cli";

/**
 * What the last automated (os-review) run concluded about a PR, as the UI needs
 * it: the same verdict and 1-5 confidence its PR comment ends with, plus whether
 * the branch has moved on since.
 */
export interface OsReview {
	/** approve | comment | request_changes. */
	verdict?: string;
	/** 1-5: how safe the reviewer thought this was to merge. */
	confidence?: number;
	findings: number;
	/** P0/P1 findings — what would block a merge. */
	blocking: number;
	/** The branch has moved on since: this verdict describes older code. */
	stale: boolean;
	at: string;
}

/** One message in a session's linked Plain thread (customer support). */
/** A file on a Plain message. Bytes load through `/plain/attachments/:id`. */
export interface PlainEntryAttachment {
	id: string;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
}

export interface PlainTimelineEntry {
	id: string;
	timestamp: string;
	actorName: string;
	actorType: "customer" | "support" | "bot" | "system";
	/** "message" = a CustomEntry, e.g. the in-app support form's original message. */
	kind: "email" | "chat" | "note" | "message";
	subject?: string;
	text: string;
	attachments?: PlainEntryAttachment[];
}

/** A Plain thread's conversation timeline, as shown in the Plain sidebar. */
export interface PlainThread {
	id: string;
	title: string | null;
	status: string | null;
	priority: number | null;
	customer: {
		id?: string | null;
		name: string | null;
		email: string | null;
		isSpam?: boolean;
	};
	/** Workspace user (or bot) the thread is assigned to, if anyone. */
	assignee?: { id: string; name: string; isBot: boolean } | null;
	/** Labels on the thread. `id` removes it, `labelTypeId` is the kind. */
	labels?: { id: string; labelTypeId: string; name: string; icon: string | null }[];
	/** When the customer's still-unanswered message landed, else null. */
	waitingSince?: string | null;
	/** True while no human has ever replied ("needs first response"). */
	awaitingFirstResponse?: boolean;
	entries: PlainTimelineEntry[];
}

/** A Plain workspace teammate, for the Support UI's Assign menu. */
export interface PlainWorkspaceUser {
	id: string;
	name: string;
	email: string | null;
}

/** A Plain label kind, for the Support UI's Labels menu. */
export interface PlainLabelType {
	id: string;
	name: string;
	icon: string | null;
}

/** A TODO Plain thread in the sidebar's Support queue. */
export interface SupportThreadAssignee {
	id: string;
	name: string;
	isBot: boolean;
}

export interface SupportThread {
	id: string;
	title: string | null;
	previewText: string | null;
	status: string | null;
	statusChangedAt: string | null;
	createdAt: string | null;
	priority: number | null;
	/** Labels on the thread (id = instance l_…, typeId = kind lt_…). Optional
	 *  so rows cached by an older server shape still render. */
	labels?: { id: string; typeId: string; name: string; icon: string | null }[];
	customer: { name: string | null; email: string | null };
	/** Plain user the thread is assigned to (optional: older server shape). */
	assignee?: SupportThreadAssignee | null;
}

/** Generic feed-item → session/workspace linkage (mirror of server types.ts;
 *  the feeds design). */
export interface ExternalRef {
	kind: string;
	id: string;
	url?: string;
	title?: string;
}

/** One filter control on a feed band (mirror of src/server/feeds.ts). */
export interface FeedFilterSpec {
	key: string;
	label: string;
	mode?: "arg" | "meta";
	field?: string;
	options?: { value: string; label: string }[];
	optionsFrom?: unknown;
	optionsFromItems?: { value: string; label: string };
}

/**
 * A project — the top level of the model: a source of work that owns a sidebar
 * band and whose contents resolve to workspaces (mirror of
 * src/server/projects.ts). Two kinds: a registered git repo, or a feed backed
 * by an MCP server / integration. See CONCEPTS.md.
 */
export interface Project {
	id: string;
	kind: "repo" | "feed";
	/** Unique across kinds: `repo:<id>` / `feed:<id>`. */
	key: string;
	label: string;
	description?: string;
	tileBg?: string;
	repo?: {
		ghRepo: string;
		defaultBranch: string;
		sharedCheckout: boolean;
		isDefault: boolean;
	};
	feed?: {
		refKind: string;
		fromConfig: boolean;
		mcpServers?: string[];
	};
}

/** A sidebar feed band's identity (mirror of src/server/feeds.ts). */
export interface FeedDescriptor {
	id: string;
	title: string;
	refKind: string;
	lanes?: { key: string; label: string; dot?: string }[];
	tileBg?: string;
	/** Session MCP allowlist for this feed's workspaces (server names). */
	mcpServers?: string[];
	/** Web panel template for this feed's items ({id}-substituted), or a
	 *  custom component key (slack-channel). */
	panel?: {
		label: string;
		component?: string;
		embedUrlTemplate?: string;
		links?: { label: string; hrefTemplate: string }[];
	};
	/** Lane whose count badges the collapsed band (e.g. Urgent). */
	attentionLane?: string;
	/** Filter controls for the band header (mirror of server feeds.ts). */
	filters?: FeedFilterSpec[];
	/** Extra meta dot-paths the sidebar search matches. */
	searchMeta?: string[];
	/** Sort options (first = default): recent | oldest | title | meta:<path>. */
	sortOptions?: { value: string; label: string }[];
	/** True for config-declared feeds (editable/deletable in the UI). */
	fromConfig?: boolean;
}

/** One external object in a feed band (mirror of src/server/feeds.ts). */
export interface FeedItem {
	id: string;
	title: string;
	preview?: string;
	lane?: string;
	ts?: number;
	url?: string;
	thumbnail?: string;
	meta?: Record<string, unknown>;
}

/** One item on a user's Desk todo list (mirror of src/server/todos.ts). */
export interface TodoItem {
	id: string;
	user: string;
	text: string;
	status: "open" | "done" | "dropped";
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	note?: string;
	due?: string;
	/** Reminder: push + Slack DM fire once this ISO datetime passes. */
	remindAt?: string;
	remindedAt?: string;
	source: { kind: "session" | "manual"; sessionId?: string; by?: string };
}

export interface ReportMeta {
	id: string;
	title: string;
	automationId: string;
	automationName: string;
	sessionId?: string;
	createdAt: string;
	summary?: string;
}

export interface ReportGroup {
	automationId: string;
	automationName: string;
	count: number;
	latest: ReportMeta;
}

/**
 * Cumulative token/cost accounting for a session (mirror of the server type).
 * Cost is the USD price returned by the engine for each completed provider
 * message. `contextTokens` is the most recent turn's full prompt size, shown
 * against `contextWindow` as the live "how full is the context window" gauge.
 */
/** One before/after screenshot pair in a session walkthrough. */
export interface WalkthroughShot {
	before?: string;
	after?: string;
	caption?: string;
}

/** Agent-published PR walkthrough: demo video + before/after + writeup.
 *  Paths are server-absolute; stream them via /media?path=. */
export interface SessionWalkthrough {
	summary: string;
	video?: string;
	videoTitle?: string;
	shots?: WalkthroughShot[];
	publishedAt: string;
	publishedBy?: string;
}

export interface UnifiedSession {
	id: string;
	/** Present and true when the local-profile server owns this session. */
	local?: boolean;
	claudeSessionId: string | null;
	source: SessionSource;
	branch: string | null;
	worktreeDir: string | null;
	/** Explicit creator identity from the session store. */
	createdBy?: string | null;
	/** Verified GitHub login when available. */
	createdByLogin?: string;
	startedBy: string | null;
	title: string;
	/** True when `title` is a manual rename rather than derived/generated. */
	titleOverridden?: boolean;
	lastActivity: string;
	createdAt: string;
	isRunning: boolean;
	/**
	 * When the in-flight run started (ISO), for the "in progress" elapsed ticker
	 * in the sidebar. Only set while isRunning; sourced server-side from the run
	 * journal so it survives a refresh. Absent for external CLI/tmux runs — the
	 * sidebar then falls back to a client-observed start time.
	 */
	runStartedAt?: string;
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
	/** What the last automated review concluded on this PR. */
	prOsReview?: OsReview;
	mode?: "ask" | "code" | "scratch";
	/** Primary repo this session works in (registered repo id). */
	repo?: string;
	/** Workspace this session belongs to; null/undefined = standalone. NOT a
	 *  project — a project is the level above (a repo band or a feed band).
	 *  See CONCEPTS.md. */
	workspaceId?: string | null;
	/** Parent/orchestrator session when spawned as a worker sub-session. */
	parentSessionId?: string;
	/** Legacy removed side-chat record. Kept hidden until its parent is deleted. */
	/** The user's standing Desk (concierge) session — fixed title, hidden from
	 *  the session lists, opened via the Desk overlay (⌘J). */
	desk?: boolean;
	/** Secondary repos this session also works in (cross-repo sessions). */
	attachedRepos?: Array<{ repo: string; branch: string; dir: string }>;
	/** PRs manually linked to this session (beyond branch/attached-repo ones). */
	linkedPrs?: Array<{
		repo: string;
		branch: string;
		number?: number;
		url?: string;
		title?: string;
	}>;
	/** Every PR this session spans (primary + attached + linked), enriched from
	 *  the server's bulk PR cache. The singular pr* fields above stay the
	 *  primary branch's PR. */
	prs?: Array<{
		repo: string;
		branch: string;
		/** "discovered" = found through the session link in the PR body's
		 *  attribution footer (a PR the agent opened on a branch this session
		 *  doesn't own — another repo, or a second branch of its own). */
		source: "primary" | "attached" | "linked" | "discovered";
		url?: string;
		state?: "OPEN" | "MERGED" | "CLOSED";
		number?: number;
		title?: string;
		isDraft?: boolean;
		reviewDecision?: string;
		additions?: number;
		deletions?: number;
		checks?: { total: number; passed: number; failed: number; pending: number };
	}>;
	/** Route the Preview/Preview environment buttons deep-link to (agent-set via
	 *  opensession-preview); appended to the base URL. Unset = open the app root. */
	previewPath?: string;
	/** Agent-published demo walkthrough (video + before/after + writeup),
	 *  rendered in the Review tab and mirrored to the PR description. */
	walkthrough?: SessionWalkthrough;
	automation?: string;
	/** Stable automation id for linking back to its settings. */
	automationId?: string;
	archived?: boolean;
	/** Why this session is archived — powers the "Auto-archived" filter. */
	archivedReason?: "manual" | "idle" | "auto" | "plain";
	plainThreadId?: string;
	/** Generic feed-item linkage (Tella videos, …) — the feeds design. */
	externalRefs?: ExternalRef[];
	goal?: string;
	loop?: {
		prompt: string;
		intervalMinutes: number;
		lastRunAt?: string;
		setBy?: string;
	};
	aliasIds?: string[];
	model?: string;
	/** OpenCode reasoning variant for this session's runs; unset = model default. */
	effort?: string;
	/** OpenAI priority service tier for ChatGPT OAuth Codex runs. */
	fastMode?: boolean;
	/** Pinned account in the active model provider's pool; unset = auto. */
	accountId?: string;
	codexThreadId?: string;
	modelHistory?: Array<{ model: string; from?: string; at: string; by?: string }>;
	/** Cumulative token/cost accounting for this session's runs. */
	usage?: SessionUsage;
	/** Sandbox opt-in (the sandbox rollout plan): the session's runs execute in an
	 *  isolated container via the named provider. `sandboxId` is set once the
	 *  provider materialized it; `workspace: "volume"` means the workspace lives
	 *  ONLY inside the sandbox (no host worktree). Mirrors the session file. */
	sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
	linearIssue?: { identifier: string; title: string; url?: string };
	slackThread?: { channel: string; threadTs: string };
	/** Blocked on an AskUserQuestion — a human needs to answer. Set by /api/sessions. */
	waitingForInput?: boolean;
	/** Number of prompts queued behind the current run. Set by /api/sessions. */
	queuedCount?: number;
	/**
	 * The create run is still preparing this session's worktree (git fetch +
	 * worktree add + dep install). The viewer shows "Waiting for workspace" and
	 * holds sends in the queue until it flips off. Set by /api/sessions.
	 */
	workspacePreparing?: boolean;
	/**
	 * The last run died on a terminal failure (usage limits exhausted, credit/API
	 * errors) — a human must act, so the session reads as "Needs input" rather
	 * than Backlog. Cleared by the next run that ends cleanly. Set by /api/sessions.
	 */
	lastRunError?: { message: string; at: string };
	/**
	 * Manual sidebar-lane override. When set it wins over the lane derived from
	 * PR/run state, letting a human pin a session into any lane (e.g. Backlog).
	 * Set server-side from the status-override registry; unset = derive as usual.
	 */
	manualStatus?: "needsinput" | "inprogress" | "review" | "merged" | "pending";
	/**
	 * A pending "please review this" pointed at a teammate, set from the info
	 * panel's Reviewer picker. Surfaces the session in a "Needs review" band at
	 * the top of the reviewer's sidebar until cleared or re-assigned.
	 */
	reviewRequest?: {
		to: string;
		by: string;
		at: string;
		accepted?: { by: string; at: string };
	};
}

/**
 * A Workspace — the container that groups the sessions about one piece of work
 * (a branch, a PR, a support ticket). Optionally owns a worktree, which new
 * sessions in it inherit. Usually sits *inside* a project (a repo band or a feed
 * band); scratch workspaces are repo-less and sit outside project bands. Do not
 * confuse the two — see CONCEPTS.md.
 */
export interface Workspace {
	id: string;
	name: string;
	repo?: string;
	color?: string;
	createdBy: string;
	createdAt: string;
	order?: number;
	/** Stable dedupe key on auto-created workspaces (`ghpr-…` / `plain-…`). */
	key?: string;
	/** Present on auto-created PR folders. */
	prNumber?: number;
	branch?: string;
	/** For support-ticket workspaces: the Plain thread they're attached to. */
	plainThreadId?: string;
	/** Generic feed-item linkage (Tella videos, …) — the feeds design. */
	externalRefs?: ExternalRef[];
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

/** One repo's diff within a (possibly multi-repo) session. */
export interface RepoDiff {
	repo: string;
	dir: string | null;
	primary: boolean;
	diff: SessionDiff;
}

export interface SessionDiffResponse {
	repos: RepoDiff[];
	error?: string;
}

export interface DiffFileGroup {
	title: string;
	files: string[];
}

export interface PrCheck {
	name: string;
	status: string;
	conclusion: string;
	url?: string;
	startedAt?: string;
	completedAt?: string;
	/** CheckRun workflow (e.g. "CI") — StatusContexts (Vercel deploys) have none. */
	workflowName?: string;
}

export interface PrComment {
	author: string;
	body: string;
	url?: string;
	createdAt?: string;
}

export interface PrFile {
	path: string;
	additions: number;
	deletions: number;
}

export interface PrReviewer {
	login: string;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
	isTeam?: boolean;
}

export interface PrCommit {
	oid: string;
	messageHeadline: string;
	messageBody?: string;
	authoredDate?: string;
	author: string;
}

export interface PrDetails {
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	/** Current head commit, used to keep independently loaded metadata and diffs aligned. */
	headRefOid?: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	reviewDecision: string;
	author: string;
	body: string;
	checks: PrCheck[];
	comments?: PrComment[];
	commits?: PrCommit[];
	/** Per-file line stats, biggest churn first. */
	files?: PrFile[];
	/** People/teams on the reviewer list with their latest review state. */
	reviewers?: PrReviewer[];
	/** MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe. */
	mergeable?: string;
	/** CLEAN | BEHIND | BLOCKED | DIRTY | UNSTABLE | … — merge-box state. */
	mergeStateStatus?: string;
	/** The PR's webapp preview environment (Vercel preview), when one exists.
	 * `embeddable` is true once the deploy's CSP lets os.tella.dev frame it. */
	staging?: { url: string; status: string; embeddable?: boolean } | null;
	/** The GitHub stack this PR is a layer of. Null/absent covers both "not
	 *  stacked" and "the stack read failed" — the UI treats them the same. */
	stack?: PrStack | null;
	/** Set on the session PR route when this session's worktree was branched off
	 *  another session's branch: the branch underneath. With no `stack`, it's the
	 *  cue to offer "link these into a stack". */
	stackBase?: string;
	/** The latest automated agent review for this PR. */
	osReview?: OsReview;
	/** An automated review is currently running for this PR. */
	reviewActive?: boolean;
}

/** One PR in a GitHub stack (see server/pr-stack.ts), trunk-most first. */
export interface PrStackLayer {
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	headRefName: string;
	baseRefName: string;
	/** Position within the stack; 1 is the layer closest to the trunk. */
	position: number;
	/** True for the PR this panel is showing. */
	current?: boolean;
}

export interface PrStack {
	/** The stack number GitHub shows in its own UI. */
	number: number;
	/** Branch the bottom layer targets. */
	baseRefName: string;
	size: number;
	/** Position of the PR this panel is showing. */
	position: number;
	layers: PrStackLayer[];
}

/** Local git state of a session's worktree (git-status endpoint). */
export interface GitStatusInfo {
	branch: string | null;
	hasUpstream: boolean;
	ahead: number;
	behind: number;
	behindBase: number;
	baseBranch: string;
	uncommittedFiles: number;
	/**
	 * The session edits a repo's shared checkout rather than its own worktree,
	 * so the tree also holds other sessions' edits: `uncommittedFiles` is scoped
	 * to this session's own files, and committing must name paths.
	 */
	sharedCheckout?: boolean;
	/** The dirty files themselves, when the count is scoped (capped). */
	uncommittedPaths?: string[];
}

export type WSClientMessage =
	// The protocol core: liveness ping, watch/unwatch + history paging,
	// prompt/interrupt + queue control, cancel, create_session.
	| ProtocolClientMessage
	// Presence only: this tab went hidden or idle (or came back). The watch is
	// untouched — the transcript keeps streaming — but an away socket stops
	// showing this person's face to teammates.
	| { type: "away"; away: boolean }
	// Collaborative notes (Yjs updates relayed as base64 over this socket).
	| { type: "watch_note"; noteId: string; user?: string }
	| { type: "leave_note" }
	| { type: "note_update"; noteId: string; update: string }
	| { type: "note_awareness"; noteId: string; update: string };

export type WSServerMessage =
	// The protocol core: hello/pong/error/notice, the transcript frames (init/
	// history/append + the session_feed live-turn feed), stream_*, status,
	// usage, queue, asks, session_created / workspace_status / model_changed.
	| ProtocolServerMessage
	| { type: "presence"; sessionId: string; viewers: string[] }
	| {
			type: "global_presence";
			viewing: Array<{ user: string; sessionId: string }>;
	  }
	| { type: "pins_changed"; user: string; pins: string[] }
	// term_* frames carry the termId of the shell tab (PTY) they belong to;
	// absent on frames from servers that predate multi-tab shells.
	| { type: "term_data"; termId?: string; data: string }
	| { type: "term_exit"; termId?: string; code?: number }
	// Where the Shell tab's PTY landed (sandboxed sessions run their shell
	// inside the sandbox) + optional fallback explanation.
	| { type: "term_ready"; termId?: string; target: "host" | "docker" | "daytona"; cwd?: string }
	| { type: "term_notice"; termId?: string; message: string }
	| { type: "cache_warning"; sessionId: string }
	// A silent server-side auto-push published the session's local commits (repo
	// id for multi-repo sessions) — the PR status header refetches on this.
	| { type: "git_pushed"; sessionId: string; repo?: string }
	// A GitHub webhook reported PR/review/check activity on a branch — PR views
	// showing that branch refetch immediately instead of waiting out their
	// poll interval (`repo` is a registered repo id).
	| { type: "pr_updated"; repo: string; ghRepo: string; branch: string; number?: number }
	// The session's scratch assets folder changed (agent wrote/deleted a
	// file) — the Assets tab refetches its tree on this.
	| { type: "assets_changed"; sessionId: string }
	// An automation published a report. sessionId is present for reports tied to
	// a run and lets that run's Reports tab refresh immediately.
	| { type: "reports_changed"; automationId: string; sessionId?: string }
	// The Desk todo list changed (any mutation, any surface — see todos.ts).
	| { type: "todos_changed"; user: string }
	// Dynamic workflow run snapshot changed (workflow-store broadcasts every
	// mutation) — powers the session's Agents panel.
	| { type: "workflow_update"; sessionId: string; run: WorkflowRunSnapshot }
	| {
			type: "subscription_changed";
			sessionId: string;
			accountId: string | null;
			name: string | null;
			by?: string;
	  }
	// `by` on restart/update notices names the session(s) that likely caused
	// it (best-effort, from in-flight runs in the server checkout) — absent
	// when the trigger wasn't an opensession session.
	| { type: "server_restarting"; by?: string }
	// `force` (admin frontend-reload broadcasts, e.g. before a protocol
	// change): tabs auto-reload after a short grace instead of waiting for a
	// click — see UpdatePill.
	| { type: "frontend_updated"; version: string; by?: string; force?: boolean }
	// Collaborative notes.
	| { type: "note_state"; noteId: string; update: string }
	| { type: "note_update"; noteId: string; update: string }
	| { type: "note_awareness"; noteId: string; update: string }
	| { type: "note_presence"; noteId: string; viewers: string[] };


// ── Analytics (sidebar → Analytics; GET /api/analytics) ──

export interface AnalyticsDay {
	date: string;
	sessions: number;
	sessionsByKind: Record<string, number>;
	turns: number;
	errors: number;
	cancelled: number;
	outputTokens: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputByModel: Record<string, number>;
	prsOpened: number;
	prsMerged: number;
	durationMs: number;
}

export interface AnalyticsModel {
	model: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface AnalyticsPerson {
	name: string;
	sessionsCreated: number;
	sessionsActive: number;
	turns: number;
	outputTokens: number;
}

export interface AnalyticsAutomation {
	name: string;
	runs: number;
	sessionsActive: number;
	turns: number;
	outputTokens: number;
	errors: number;
}

export interface AnalyticsRepoPrs {
	repo: string;
	prsOpened: number;
	prsMerged: number;
	allOpened: number;
	allMerged: number;
}

export interface AnalyticsPr {
	repo: string;
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	createdAt: string;
	mergedAt: string | null;
	headRefName: string;
	byOpensession: boolean;
}

export interface AnalyticsFactoryCohort {
	merged: number;
	humanReviewed: number;
	reverts: number;
	avgReworkCommits: number;
	medianHoursToMerge: number;
	avgLinesChanged: number;
}

export interface AnalyticsSummary {
	from: string;
	to: string;
	days: AnalyticsDay[];
	totals: {
		sessions: number;
		sessionsCreated: number;
		turns: number;
		errors: number;
		cancelled: number;
		oneshots: number;
		durationMs: number;
		outputTokens: number;
		inputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		prsOpened: number;
		prsMerged: number;
		allPrsOpened: number;
		allPrsMerged: number;
		activePeople: number;
	};
	models: AnalyticsModel[];
	people: AnalyticsPerson[];
	automations: AnalyticsAutomation[];
	repos: AnalyticsRepoPrs[];
	prs: AnalyticsPr[];
	factory: {
		days: Array<{ date: string; reviewed: number; unreviewed: number }>;
		agent: AnalyticsFactoryCohort;
		other: AnalyticsFactoryCohort;
	};
	reviewQuality: {
		days: AnalyticsReviewDay[];
		earlier: AnalyticsReviewCohort;
		recent: AnalyticsReviewCohort;
	};
}

/** Per-day PR-review quality: finding cohorts by day posted + run facts. */
export interface AnalyticsReviewDay {
	date: string;
	posted: number;
	addressed: number;
	ignored: number;
	dismissed: number;
	pending: number;
	missedBugs: number;
	reviews: number;
	findings: number;
	withheld: number;
	confidenceSum: number;
	confidenceN: number;
}

export interface AnalyticsReviewCohort {
	posted: number;
	addressed: number;
	ignored: number;
	dismissed: number;
	pending: number;
	missedBugs: number;
	addressedRate: number | null;
	reviews: number;
	avgConfidence: number | null;
	avgFindingsPerReview: number | null;
	withheld: number;
}
