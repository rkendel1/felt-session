import type {
	UnifiedSession,
	SlackChannelLink,
	SlackMessage,
	PlainThread,
	Project,
} from "./types";

const BASE = "/backstage/api";

/** Single error shape for every API failure: HTTP status + the server's
 * `error` field when it sent one (else a "<label>: <status>" message). */
export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

/**
 * The one request helper behind every wrapper below. Checks `res.ok` BEFORE
 * touching the body — so an HTML 502 during a server restart surfaces as a
 * useful ApiError instead of `SyntaxError: Unexpected token '<'` — and parses
 * JSON defensively (a bodyless 204/500 just yields null).
 */
async function request<T>(
	path: string,
	opts: {
		method?: string;
		/** JSON-encoded and sent with a Content-Type header when present. */
		body?: unknown;
		signal?: AbortSignal;
		/** Error-message prefix when the server didn't provide an `error` field. */
		label?: string;
	} = {},
): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: opts.method || "GET",
		signal: opts.signal,
		...(opts.body !== undefined
			? {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(opts.body),
				}
			: {}),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new ApiError(
			body?.error || `${opts.label || "Failed"}: ${res.status}`,
			res.status,
		);
	}
	return (await res.json().catch(() => null)) as T;
}

/**
 * Raw JSON text of the sessions list. useSessions polls this so it can compare
 * the response text against the previous poll and skip the state update (and
 * the app-wide re-render) entirely when nothing changed.
 */
export async function fetchSessionsText(): Promise<string> {
	const res = await fetch(`${BASE}/sessions`);
	if (!res.ok)
		throw new ApiError(`Failed to fetch sessions: ${res.status}`, res.status);
	return res.text();
}

export async function fetchSessions(): Promise<UnifiedSession[]> {
	return request<UnifiedSession[]>("/sessions", {
		label: "Failed to fetch sessions",
	});
}

/** One open PR from the batched repo-wide list (session or not). */
export interface OpenPr {
	repo: string;
	branch: string;
	url: string;
	number: number;
	title: string;
	isDraft: boolean;
	reviewDecision: string;
	author: string;
	/** Web user-picker key ("kent"), or null when the author isn't a teammate. */
	person: string | null;
	updatedAt: string;
	/** The PR's auto-created workspace (`ghpr-<n>`), when one exists. */
	workspaceId: string | null;
}

/** Every open PR across the covered repos, attributed by GitHub author. */
export async function fetchOpenPrs(): Promise<OpenPr[]> {
	const data = await request<{ prs: OpenPr[] }>("/open-prs", {
		label: "Failed to fetch open PRs",
	});
	return data?.prs || [];
}

export interface TranscriptMatch {
	id: string;
	snippet: string;
}

/** Full-text search across session transcripts (⌘K "search in conversations"). */
export async function searchTranscripts(
	q: string,
	signal?: AbortSignal,
): Promise<TranscriptMatch[]> {
	const data = await request<{ matches?: TranscriptMatch[] }>(
		`/sessions/search?q=${encodeURIComponent(q)}`,
		{ signal, label: "Transcript search failed" },
	);
	return data?.matches ?? [];
}

export interface PreviewService {
	name: string;
	key: string;
	port: number;
	running: boolean;
	pids: number[];
}

export interface PreviewStatus {
	hasPortsConf: boolean;
	webappPort: number | null;
	running: boolean;
	starting: boolean;
	previewUrl: string | null;
	services: PreviewService[];
}

export async function fetchPreview(sessionId: string): Promise<PreviewStatus> {
	return request<PreviewStatus>(
		`/sessions/${encodeURIComponent(sessionId)}/preview`,
		{ label: "Failed to fetch preview" },
	);
}

export async function startPreviewApi(
	sessionId: string,
): Promise<PreviewStatus> {
	return request<PreviewStatus>(
		`/sessions/${encodeURIComponent(sessionId)}/preview/start`,
		{ method: "POST", label: "Failed to start preview" },
	);
}

export async function stopPreviewApi(
	sessionId: string,
): Promise<PreviewStatus> {
	return request<PreviewStatus>(
		`/sessions/${encodeURIComponent(sessionId)}/preview/stop`,
		{ method: "POST", label: "Failed to stop preview" },
	);
}

/** Screenshot the session's running preview; resolves to a data: URL (PNG). */
export async function capturePreviewShot(sessionId: string): Promise<string> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/preview/screenshot`,
		{ method: "POST" },
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new ApiError(body?.error || `Screenshot failed: ${res.status}`, res.status);
	}
	const blob = await res.blob();
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Failed to read screenshot"));
		reader.readAsDataURL(blob);
	});
}

export async function fetchTranscript(sessionId: string) {
	return request<any>(
		`/sessions/${encodeURIComponent(sessionId)}/transcript`,
		{ label: "Failed to fetch transcript" },
	);
}

/** One media item in the workspace-overview panel. Image srcs are lazy-load
 * refs served by /sessions/:id/transcript-image; videos stream from
 * /backstage/media. */
export interface WorkspaceMediaItem {
	kind: "image" | "video";
	src: string;
	sessionId: string;
	chatTitle?: string;
	at: string;
}

export interface WorkspaceOverview {
	prompt: { content: string; sessionId: string; at: string } | null;
	/** Latest assistant text across the workspace's chats. Optional because a
	 *  server that hasn't restarted onto the new overview code omits the key. */
	lastMessage?: { content: string; sessionId: string; at: string } | null;
	media: WorkspaceMediaItem[];
}

/** Opening prompt + all media across a workspace's chats (the floating
 * preview panel in the session viewer). */
export async function fetchWorkspaceOverview(
	wsId: string,
): Promise<WorkspaceOverview> {
	return request<WorkspaceOverview>(
		`/workspaces/${encodeURIComponent(wsId)}/overview`,
		{ label: "Failed to fetch workspace overview" },
	);
}

export interface SubagentTranscript {
	meta: {
		agentId: string;
		agentType?: string;
		description?: string;
		toolUseId?: string;
		spawnDepth?: number;
	};
	entries: import("./types").TranscriptEntry[];
	sessionRunning: boolean;
}

export async function fetchSubagent(
	sessionId: string,
	agentId: string,
): Promise<SubagentTranscript> {
	return request<SubagentTranscript>(
		`/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentId)}`,
		{ label: "Failed to fetch sub-agent" },
	);
}

/** A single "@"-mention suggestion. `insert` is what lands in the textarea. */
export interface FileMention {
	/** Repo-relative path (files) or session title (sessions), for display. */
	display: string;
	/** Text inserted after the "@": path, `repo:path`, or `session:<id>`. */
	insert: string;
	/** Repo label, set only when more than one repo is searched (cross-repo). */
	repo?: string;
	/** Entry type; absent means a file. */
	kind?: "session";
	/** Subtitle for non-file entries (e.g. a session's branch). */
	sub?: string;
}

/**
 * File suggestions for "@"-mention autocomplete in the composer. Searches the
 * session's primary checkout plus any attached repos when `sessionId` is given;
 * otherwise the given `repo`'s checkout (used by the New-session prompt, which
 * has no session yet), falling back to the default repo.
 */
export async function fetchFileMentions(
	query: string,
	sessionId?: string,
	repo?: string,
): Promise<FileMention[]> {
	const params = new URLSearchParams({ q: query });
	if (sessionId) params.set("session", sessionId);
	else if (repo) params.set("repo", repo);
	try {
		const data = await request<{ files?: FileMention[] }>(
			`/files?${params.toString()}`,
		);
		return data?.files ?? [];
	} catch (e) {
		console.warn("fetchFileMentions failed:", e);
		return [];
	}
}

export interface RepoInfo {
	id: string;
	defaultBranch: string;
	sharedCheckout: boolean;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
	try {
		const data = await request<{ repos?: RepoInfo[] }>("/repos");
		return data?.repos ?? [];
	} catch (e) {
		console.warn("fetchRepos failed:", e);
		return [];
	}
}

// ── Projects (folders that group chats) ──

export async function fetchProjects(): Promise<Project[]> {
	try {
		const data = await request<{ projects?: Project[] }>("/projects");
		return data?.projects ?? [];
	} catch (e) {
		console.warn("fetchProjects failed:", e);
		return [];
	}
}

export async function createProjectApi(input: {
	name: string;
	repo?: string;
	color?: string;
	user: string;
}): Promise<Project> {
	const body = await request<{ project: Project }>("/projects", {
		method: "POST",
		body: input,
	});
	return body.project;
}

export async function updateProjectApi(
	id: string,
	patch: {
		name?: string;
		repo?: string;
		/** null clears the swatch color. */
		color?: string | null;
		order?: number;
	},
): Promise<Project> {
	const body = await request<{ project: Project }>(
		`/projects/${encodeURIComponent(id)}`,
		{ method: "PATCH", body: patch },
	);
	return body.project;
}

export async function deleteProjectApi(id: string): Promise<void> {
	await request<void>(`/projects/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete project",
	});
}

/**
 * Start a new sibling chat in the source chat's workspace. Returns the new
 * chat's id plus its full session object (so the caller can render it
 * immediately, without waiting for the next sessions poll); it has no run yet —
 * its first prompt starts fresh. `mode` picks the worktree relationship: share
 * the workspace worktree (default), stack a new worktree branched off it, or
 * ask (no worktree).
 */
export async function newChatApi(
	sourceId: string,
	user: string,
	mode?: "share" | "stack" | "ask",
): Promise<{ id: string; session: UnifiedSession | null }> {
	const body = await request<{ id: string; session?: UnifiedSession }>(
		`/sessions/${encodeURIComponent(sourceId)}/new-chat`,
		{ method: "POST", body: { user, ...(mode ? { mode } : {}) } },
	);
	return { id: body.id, session: body.session || null };
}

/**
 * Promote an ask chat to code: create a worktree and attach it (also
 * materializes the workspace's worktree if it doesn't own one yet). Returns the
 * new branch + worktree dir.
 */
export async function promoteChatApi(
	sessionId: string,
	opts?: { branch?: string; repo?: string },
): Promise<{ branch: string; worktreeDir: string }> {
	return request<{ branch: string; worktreeDir: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/promote`,
		{ method: "POST", body: opts || {} },
	);
}

/** Move a chat into a project (or `null` to make it standalone). */
export async function setSessionProjectApi(
	sessionId: string,
	projectId: string | null,
): Promise<void> {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/project`, {
		method: "POST",
		body: { projectId },
	});
}

export interface AttachedRepo {
	repo: string;
	branch: string;
	dir: string;
}

export async function attachRepoApi(
	sessionId: string,
	repo: string,
	branch?: string,
): Promise<AttachedRepo[]> {
	const body = await request<{ attachedRepos: AttachedRepo[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/attach-repo`,
		{ method: "POST", body: { repo, ...(branch ? { branch } : {}) } },
	);
	return body.attachedRepos;
}

export async function detachRepoApi(
	sessionId: string,
	repo: string,
): Promise<AttachedRepo[]> {
	const body = await request<{ attachedRepos: AttachedRepo[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/detach-repo`,
		{ method: "POST", body: { repo } },
	);
	return body.attachedRepos;
}

// Whether this session is fresh enough to switch its primary repo (clean-only).
export async function fetchRepoSwitchable(sessionId: string): Promise<boolean> {
	try {
		const body = await request<{ switchable?: boolean }>(
			`/sessions/${encodeURIComponent(sessionId)}/repo-switchable`,
		);
		return !!body?.switchable;
	} catch (e) {
		console.warn("fetchRepoSwitchable failed:", e);
		return false;
	}
}

// Switch the session's PRIMARY repo (wrong repo picked at creation). Returns the
// new primary repo + branch; the next prompt runs from the new worktree.
export async function switchPrimaryRepoApi(
	sessionId: string,
	repo: string,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
	return request<{ repo: string; branch: string; worktreeDir: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/switch-primary-repo`,
		{ method: "POST", body: { repo } },
	);
}

// ── Linked Slack channels ──

export async function linkChannelApi(
	sessionId: string,
	opts: { mode: "create" | "existing"; name?: string; channelId?: string },
): Promise<SlackChannelLink> {
	const body = await request<{ slackChannel: SlackChannelLink }>(
		`/sessions/${encodeURIComponent(sessionId)}/link-channel`,
		{ method: "POST", body: opts },
	);
	return body.slackChannel;
}

export async function unlinkChannelApi(sessionId: string): Promise<void> {
	await request<void>(
		`/sessions/${encodeURIComponent(sessionId)}/unlink-channel`,
		{ method: "POST" },
	);
}

export async function fetchChannelHistoryApi(
	sessionId: string,
): Promise<SlackMessage[]> {
	const body = await request<{ messages?: SlackMessage[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/channel/history`,
		{ label: "Failed to fetch history" },
	);
	return Array.isArray(body?.messages) ? body.messages : [];
}

export async function fetchPlainThreadApi(
	sessionId: string,
): Promise<PlainThread | null> {
	const body = await request<{ thread?: PlainThread }>(
		`/sessions/${encodeURIComponent(sessionId)}/plain/thread`,
	);
	return body?.thread || null;
}

export async function postChannelMessageApi(
	sessionId: string,
	text: string,
	user: string,
): Promise<SlackMessage> {
	const body = await request<{ message: SlackMessage }>(
		`/sessions/${encodeURIComponent(sessionId)}/channel/message`,
		{ method: "POST", body: { text, user } },
	);
	return body.message;
}

export async function fetchWorktrees(repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	return request<any>(`/worktrees${qs}`, {
		label: "Failed to fetch worktrees",
	});
}

export async function deleteSessionApi(
	sessionId: string,
	cleanWorktree: boolean,
): Promise<void> {
	const params = cleanWorktree ? "?worktree=true" : "";
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}${params}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function fetchDiff(
	sessionId: string,
): Promise<import("./types").SessionDiffResponse> {
	return request<import("./types").SessionDiffResponse>(
		`/sessions/${encodeURIComponent(sessionId)}/diff`,
		{ label: "Failed to fetch diff" },
	);
}

/** `repo` (a repo id) targets an attached repo's PR; omit for the primary. */
export async function fetchPr(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	return request<any>(`/sessions/${encodeURIComponent(sessionId)}/pr${qs}`, {
		label: "Failed to fetch PR",
	});
}

/** Local git state (ahead/behind, dirty tree) for the status header. */
export async function fetchGitStatus(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	return request<import("./types").GitStatusInfo | null>(
		`/sessions/${encodeURIComponent(sessionId)}/git-status${qs}`,
		{ label: "Failed to fetch git status" },
	);
}

/** Push the session's branch (sets upstream on first push). */
export async function gitPushApi(sessionId: string, repo?: string) {
	return request<{ ok: true }>(
		`/sessions/${encodeURIComponent(sessionId)}/git-push`,
		{ method: "POST", body: repo ? { repo } : {} },
	);
}

export async function fetchPrDiff(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	return request<any>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-diff${qs}`,
		{ label: "Failed to fetch PR diff" },
	);
}

export async function postPrCommentApi(
	sessionId: string,
	payload: {
		text: string;
		user: string;
		path?: string;
		line?: number;
		startLine?: number;
		side?: "RIGHT" | "LEFT";
		repo?: string;
	},
) {
	return request<{ ok: true; url?: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-comment`,
		{ method: "POST", body: payload },
	);
}

export async function submitPrReviewApi(
	sessionId: string,
	payload: {
		user: string;
		event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
		summary?: string;
		repo?: string;
		comments: Array<{
			text: string;
			path: string;
			line: number;
			startLine?: number;
			side?: "RIGHT" | "LEFT";
			startSide?: "RIGHT" | "LEFT";
		}>;
	},
) {
	return request<{ ok: true; url?: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-review`,
		{ method: "POST", body: payload },
	);
}

export async function mergePrApi(
	sessionId: string,
	method: "squash" | "merge" | "rebase" = "squash",
	repo?: string,
) {
	return request<{ ok: true; url?: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-merge`,
		{ method: "POST", body: { method, ...(repo ? { repo } : {}) } },
	);
}

// ── Automations ──

export interface ModelOption {
	id: string;
	provider: "claude" | "codex";
	label: string;
	aliases: string[];
}

/**
 * Ask the backend (a quick Haiku call) to suggest a branch name for a task
 * prompt. Returns null when the prompt is too thin or anything fails — callers
 * just leave the field for the user to fill.
 */
export async function suggestBranch(prompt: string): Promise<string | null> {
	try {
		const data = await request<{ branch?: unknown }>("/suggest-branch", {
			method: "POST",
			body: { prompt },
		});
		return typeof data?.branch === "string" ? data.branch : null;
	} catch {
		return null;
	}
}

export async function fetchModels(): Promise<{
	models: ModelOption[];
	default: string;
}> {
	return request<{ models: ModelOption[]; default: string }>("/models", {
		label: "Failed to fetch models",
	});
}

export async function fetchAutomations() {
	return request<any>("/automations", {
		label: "Failed to fetch automations",
	});
}

export interface AutomationTemplate {
	id: string;
	name: string;
	description: string;
	category: "sweep" | "digest" | "investigator" | "triage" | "hygiene";
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	mcpServers?: string[];
	eventKey?: string;
}

export async function fetchAutomationTemplates(): Promise<AutomationTemplate[]> {
	const res = await fetch(`${BASE}/automation-templates`);
	if (!res.ok) throw new Error(`Failed to fetch templates: ${res.status}`);
	return res.json();
}

export interface AutomationDraft {
	name: string;
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	mcpServers?: string[];
	eventKey?: string;
}

/** Draft an automation config from a free-text description (backend Haiku
 *  call). Throws with a friendly message when the draft fails. */
export async function draftAutomationApi(description: string): Promise<AutomationDraft> {
	const res = await fetch(`${BASE}/automations/draft`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ description }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

/** MCP server list + agent health, for pickers (Automations) and Settings. */
export async function fetchConnections(): Promise<{
	mcpServers: Array<{ name: string; status: string; allowedUsers?: string[] }>;
	agents: Record<string, unknown>;
}> {
	const res = await fetch(`${BASE}/connections`);
	if (!res.ok) throw new Error(`Failed to fetch connections: ${res.status}`);
	return res.json();
}

export async function createAutomationApi(input: {
	name: string;
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	createdBy: string;
	eventKey?: string;
	model?: string;
	fallbackModel?: string;
	mcpServers?: string[];
	slackWatch?: { channel: string };
}) {
	return request<any>("/automations", { method: "POST", body: input });
}

export async function updateAutomationApi(id: string, patch: object) {
	return request<any>(`/automations/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteAutomationApi(id: string) {
	await request<void>(`/automations/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runAutomationApi(id: string) {
	await request<void>(`/automations/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
}

// ── Scheduled prompts (composer "send later") ──

export interface ScheduledPrompt {
	id: string;
	sessionId: string;
	prompt: string;
	user: string;
	at: string;
	createdAt: string;
}

export async function fetchScheduledPrompts(
	sessionId: string,
): Promise<ScheduledPrompt[]> {
	const data = await request<{ prompts?: ScheduledPrompt[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`,
		{ label: "Failed to fetch scheduled prompts" },
	);
	return data?.prompts ?? [];
}

export async function createScheduledPromptApi(
	sessionId: string,
	input: { prompt: string; at: string; user: string },
): Promise<ScheduledPrompt> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`, {
		method: "POST",
		body: input,
	});
}

export async function deleteScheduledPromptApi(id: string): Promise<void> {
	await request<void>(`/scheduled-prompts/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete scheduled prompt",
	});
}

// ── Human asks (waiting-on-teammates board) ──

export interface HumanAskView {
	id: string;
	sessionId: string;
	createdBy: string;
	person: { slackId: string; name: string };
	question: string;
	options?: string[];
	mode: "block" | "async";
	state: "scheduled" | "delivered" | "answered" | "timeout" | "cancelled";
	answer?: string;
	answeredBy?: string;
	createdAt: string;
	deliveredAt?: string;
	answeredAt?: string;
}

export async function fetchHumanAsks(all = false): Promise<HumanAskView[]> {
	const data = await request<{ asks?: HumanAskView[] }>(
		`/human-asks${all ? "?all=1" : ""}`,
		{ label: "Failed to fetch asks" },
	);
	return data?.asks ?? [];
}

export async function nudgeHumanAsk(id: string): Promise<void> {
	await request<void>(`/human-asks/${encodeURIComponent(id)}/nudge`, {
		method: "POST",
	});
}

export async function cancelHumanAsk(id: string): Promise<void> {
	await request<void>(`/human-asks/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to cancel ask",
	});
}

// ── Audit log ──

export interface AuditPage {
	dates: string[];
	events?: Array<Record<string, unknown>>;
	total?: number;
	types?: string[];
}

export async function fetchAudit(opts: {
	date?: string;
	q?: string;
	type?: string;
	session?: string;
	/** Include the per-turn firehose (tool_use/tool_result/…). */
	all?: boolean;
	offset?: number;
	limit?: number;
}): Promise<AuditPage> {
	const params = new URLSearchParams();
	if (opts.date) params.set("date", opts.date);
	if (opts.q) params.set("q", opts.q);
	if (opts.type) params.set("type", opts.type);
	if (opts.session) params.set("session", opts.session);
	if (opts.all) params.set("all", "1");
	if (opts.offset) params.set("offset", String(opts.offset));
	if (opts.limit) params.set("limit", String(opts.limit));
	return request(`/audit?${params.toString()}`, {
		label: "Failed to fetch audit log",
	});
}

// ── Session monitor (per-user, opt-in) ──

export interface MonitorConfig {
	enabled: boolean;
	intervalMinutes: number;
	slackDm: boolean;
	autoAnswer: boolean;
	stalledMinutes: number;
}

export async function fetchMonitorConfig(user: string): Promise<MonitorConfig> {
	return request(`/monitor?user=${encodeURIComponent(user)}`, {
		label: "Failed to fetch monitor config",
	});
}

export async function updateMonitorConfig(
	user: string,
	patch: Partial<MonitorConfig>,
): Promise<MonitorConfig> {
	return request("/monitor", { method: "PUT", body: { user, ...patch } });
}

// ── Security (deepsec scans + profiles) ──

export interface ScanProfile {
	id: string;
	name: string;
	prompt: string;
	createdBy: string;
	createdAt: string;
}

export interface ScanSessionRef {
	repo: string;
	sessionId: string;
	status: "running" | "ok" | "error";
	error?: string;
}

export interface SecurityScan {
	id: string;
	repos: string[];
	profileId?: string;
	profileName?: string;
	instructions?: string;
	interactive: boolean;
	status: "running" | "done" | "error" | "interactive";
	error?: string;
	createdBy: string;
	createdAt: string;
	finishedAt?: string;
	sessions: ScanSessionRef[];
}

export async function fetchSecurity(): Promise<{
	scans: SecurityScan[];
	profiles: ScanProfile[];
	repos: Array<{ id: string; defaultBranch: string }>;
}> {
	return request("/security", { label: "Failed to fetch security" });
}

export async function startScanApi(input: {
	repos: "all" | string[];
	profileId?: string;
	instructions?: string;
	interactive?: boolean;
	recurrence?: "none" | "daily" | "weekly";
	createdBy: string;
}): Promise<{ scan?: SecurityScan; sessionId?: string; automation?: unknown }> {
	return request("/security/scans", { method: "POST", body: input });
}

export async function deleteScanApi(id: string) {
	await request<void>(`/security/scans/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete scan",
	});
}

export async function createScanProfileApi(input: {
	name: string;
	prompt: string;
	createdBy: string;
}): Promise<ScanProfile> {
	return request("/security/profiles", { method: "POST", body: input });
}

export async function updateScanProfileApi(
	id: string,
	patch: { name?: string; prompt?: string },
): Promise<ScanProfile> {
	return request(`/security/profiles/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteScanProfileApi(id: string) {
	await request<void>(`/security/profiles/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete profile",
	});
}

// ── Goals (long-running, self-pacing missions) ──

export async function fetchGoals() {
	return request<any>("/goals", { label: "Failed to fetch goals" });
}

/** Single goal incl. its ledger text (for the detail view). */
export async function fetchGoal(id: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}`, {
		label: "Failed to fetch goal",
	});
}

export async function createGoalApi(input: {
	name: string;
	mission: string;
	mode?: "ask" | "code";
	repo?: string;
	model?: string;
	fallbackModel?: string;
	mcpServers?: string[];
	minWakeMinutes?: number;
	maxWakes?: number;
	createdBy: string;
}) {
	return request<any>("/goals", { method: "POST", body: input });
}

export async function updateGoalApi(id: string, patch: object) {
	return request<any>(`/goals/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteGoalApi(id: string) {
	await request<void>(`/goals/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runGoalApi(id: string) {
	await request<void>(`/goals/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
}

export async function resumeGoalApi(id: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}/resume`, {
		method: "POST",
		body: {},
	});
}

export async function pauseGoalApi(id: string, reason?: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}/pause`, {
		method: "POST",
		body: { reason },
	});
}

// ── Actions (run a registered repo script behind a form) ──

export type ActionInputType = "text" | "number" | "select" | "boolean";

export interface ActionInput {
	name: string;
	label?: string;
	type: ActionInputType;
	required?: boolean;
	default?: string;
	options?: string[];
	hint?: string;
}

export interface Action {
	id: string;
	name: string;
	description?: string;
	kind?: "repo" | "mcp";
	repo?: string;
	scriptPath?: string;
	argMode?: "positional" | "env";
	mcpServer?: string;
	toolName?: string;
	inputs: ActionInput[];
	confirm?: boolean;
	model?: string;
	seeded?: boolean;
	createdBy: string;
	createdAt: string;
	lastRunAt?: string;
	lastRunSessionId?: string;
}

export async function fetchActions(): Promise<Action[]> {
	return request<Action[]>("/actions", { label: "Failed to fetch actions" });
}

export async function createActionApi(input: {
	name: string;
	description?: string;
	kind: "repo" | "mcp";
	repo?: string;
	scriptPath?: string;
	argMode?: "positional" | "env";
	mcpServer?: string;
	toolName?: string;
	inputs: ActionInput[];
	confirm?: boolean;
	createdBy: string;
}): Promise<Action> {
	return request<Action>("/actions", { method: "POST", body: input });
}

export async function deleteActionApi(id: string): Promise<void> {
	await request<void>(`/actions/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runActionApi(
	id: string,
	values: Record<string, unknown>,
	user: string,
): Promise<{ sessionId: string }> {
	return request<{ sessionId: string }>(
		`/actions/${encodeURIComponent(id)}/run`,
		{ method: "POST", body: { values, user } },
	);
}

export async function introspectActionApi(
	repo: string,
	scriptPath: string,
): Promise<{ inputs: ActionInput[]; argMode: "positional" | "env" }> {
	return request<{ inputs: ActionInput[]; argMode: "positional" | "env" }>(
		"/actions/introspect",
		{ method: "POST", body: { repo, scriptPath } },
	);
}

// ── Pins (per-user pinned tabs) ──

export async function fetchPins(user: string): Promise<string[]> {
	const body = await request<{ pins?: string[] }>(
		`/pins?user=${encodeURIComponent(user)}`,
		{ label: "Failed to fetch pins" },
	);
	return Array.isArray(body?.pins) ? body.pins : [];
}

export async function savePinsApi(
	user: string,
	pins: string[],
): Promise<string[]> {
	const body = await request<{ pins?: string[] }>("/pins", {
		method: "PUT",
		body: { user, pins },
		label: "Failed to save pins",
	});
	return Array.isArray(body?.pins) ? body.pins : pins;
}

// ── Tab colors (per-user session tab colors) ──

export async function fetchTabColors(
	user: string,
): Promise<Record<string, string>> {
	const body = await request<{ colors?: Record<string, string> }>(
		`/tab-colors?user=${encodeURIComponent(user)}`,
		{ label: "Failed to fetch tab colors" },
	);
	return body?.colors && typeof body.colors === "object" ? body.colors : {};
}

export async function saveTabColorsApi(
	user: string,
	colors: Record<string, string>,
): Promise<Record<string, string>> {
	const body = await request<{ colors?: Record<string, string> }>(
		"/tab-colors",
		{ method: "PUT", body: { user, colors }, label: "Failed to save tab colors" },
	);
	return body?.colors && typeof body.colors === "object" ? body.colors : colors;
}

// ── Wiki ──

export async function fetchWikiTree() {
	return request<any>("/wiki/tree", { label: "Failed to fetch wiki tree" });
}

export async function fetchWikiFile(path: string) {
	return request<any>(`/wiki/file?path=${encodeURIComponent(path)}`, {
		label: "Failed to fetch doc",
	});
}

export async function searchWikiApi(q: string) {
	return request<any>(`/wiki/search?q=${encodeURIComponent(q)}`, {
		label: "Search failed",
	});
}

// ── Notes (shared, collaborative) ──

export interface NoteMeta {
	id: string;
	title: string;
	updatedAt: number;
}

export async function fetchNotes(): Promise<NoteMeta[]> {
	const body = await request<{ notes?: NoteMeta[] }>("/notes", {
		label: "Failed to fetch notes",
	});
	return Array.isArray(body?.notes) ? body.notes : [];
}

export async function createNoteApi(title?: string): Promise<NoteMeta> {
	const body = await request<{ note: NoteMeta }>("/notes", {
		method: "POST",
		body: { title },
		label: "Failed to create note",
	});
	return body.note;
}

export async function deleteNoteApi(id: string): Promise<void> {
	await request<void>(`/notes/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete note",
	});
}

export interface NoteSearchHit {
	id: string;
	title: string;
	line: number;
	snippet: string;
}

/** Full-text search across the shared notes (merged with docs hits in the UI). */
export async function searchNotesApi(q: string): Promise<NoteSearchHit[]> {
	const body = await request<{ hits?: NoteSearchHit[] }>(
		`/notes/search?q=${encodeURIComponent(q)}`,
		{ label: "Note search failed" },
	);
	return body?.hits ?? [];
}

/** One note's meta + current markdown text (preview / discuss-with-Michael). */
export async function fetchNote(
	id: string,
): Promise<NoteMeta & { text: string }> {
	return request(`/notes/${encodeURIComponent(id)}`, {
		label: "Failed to fetch note",
	});
}

/** Notes that link to this one via [label](note:id) chips. */
export async function fetchNoteBacklinks(
	id: string,
): Promise<Array<{ id: string; title: string }>> {
	const body = await request<{ notes?: Array<{ id: string; title: string }> }>(
		`/notes/${encodeURIComponent(id)}/backlinks`,
		{ label: "Failed to fetch backlinks" },
	);
	return body?.notes ?? [];
}

/** Run a Haiku rewrite of the note; the new content arrives live over the WS. */
export async function promptNoteApi(id: string, prompt: string): Promise<void> {
	await request<void>(`/notes/${encodeURIComponent(id)}/prompt`, {
		method: "POST",
		body: { prompt },
		label: "Update failed",
	});
}

export async function archiveSessionApi(sessionId: string, archived: boolean) {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
		method: "POST",
		body: { archived },
		label: "Failed to update archive state",
	});
}

/** Set a manual display title for a session; empty string clears the rename. */
export async function renameSessionApi(
	sessionId: string,
	title: string,
): Promise<void> {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/title`, {
		method: "PUT",
		body: { title },
		label: "Failed to rename session",
	});
}

export function getWebSocketUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/backstage/ws`;
}

export function relativeTime(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diff = now - then;

	if (diff < 0) return "just now";
	if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
	return new Date(dateStr).toLocaleDateString();
}
