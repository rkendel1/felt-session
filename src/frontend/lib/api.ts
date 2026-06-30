import type { UnifiedSession } from "./types";

const BASE = "/backstage/api";

export async function fetchSessions(): Promise<UnifiedSession[]> {
	const res = await fetch(`${BASE}/sessions`);
	if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
	return res.json();
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
	previewUrl: string | null;
	services: PreviewService[];
}

export async function fetchPreview(sessionId: string): Promise<PreviewStatus> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/preview`,
	);
	if (!res.ok) throw new Error(`Failed to fetch preview: ${res.status}`);
	return res.json();
}

export async function stopPreviewApi(
	sessionId: string,
): Promise<PreviewStatus> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/preview/stop`,
		{
			method: "POST",
		},
	);
	if (!res.ok) throw new Error(`Failed to stop preview: ${res.status}`);
	return res.json();
}

export async function fetchTranscript(sessionId: string) {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/transcript`,
	);
	if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
	return res.json();
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
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentId)}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch sub-agent: ${res.status}`);
	return res.json();
}

/** A single "@"-mention suggestion. `insert` is what lands in the textarea. */
export interface FileMention {
	/** Repo-relative path, for display. */
	display: string;
	/** Text inserted after the "@": bare path (primary repo) or `project:path`. */
	insert: string;
	/** Repo label, set only when more than one repo is searched (cross-repo). */
	repo?: string;
}

/**
 * File suggestions for "@"-mention autocomplete in the composer. Searches the
 * session's primary checkout plus any attached repos (or the default project
 * repo when there's no session).
 */
export async function fetchFileMentions(
	query: string,
	sessionId?: string,
): Promise<FileMention[]> {
	const params = new URLSearchParams({ q: query });
	if (sessionId) params.set("session", sessionId);
	const res = await fetch(`${BASE}/files?${params.toString()}`);
	if (!res.ok) return [];
	const data = await res.json();
	return data.files ?? [];
}

export interface ProjectInfo {
	id: string;
	defaultBranch: string;
	sharedCheckout: boolean;
}

export async function fetchProjects(): Promise<ProjectInfo[]> {
	const res = await fetch(`${BASE}/projects`);
	if (!res.ok) return [];
	const data = await res.json();
	return data.projects ?? [];
}

export interface AttachedRepo {
	project: string;
	branch: string;
	dir: string;
}

export async function attachRepoApi(
	sessionId: string,
	project: string,
	branch?: string,
): Promise<AttachedRepo[]> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/attach-repo`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project, ...(branch ? { branch } : {}) }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.attachedRepos as AttachedRepo[];
}

export async function detachRepoApi(
	sessionId: string,
	project: string,
): Promise<AttachedRepo[]> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/detach-repo`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.attachedRepos as AttachedRepo[];
}

export async function fetchWorktrees(project?: string) {
	const qs = project ? `?project=${encodeURIComponent(project)}` : "";
	const res = await fetch(`${BASE}/worktrees${qs}`);
	if (!res.ok) throw new Error(`Failed to fetch worktrees: ${res.status}`);
	return res.json();
}

export async function deleteSessionApi(
	sessionId: string,
	cleanWorktree: boolean,
): Promise<void> {
	const params = cleanWorktree ? "?worktree=true" : "";
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}${params}`,
		{
			method: "DELETE",
		},
	);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `Failed to delete: ${res.status}`);
	}
}

export async function fetchDiff(
	sessionId: string,
): Promise<import("./types").SessionDiffResponse> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/diff`,
	);
	if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
	return res.json();
}

/** `repo` (a project id) targets an attached repo's PR; omit for the primary. */
export async function fetchPr(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr${qs}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch PR: ${res.status}`);
	return res.json();
}

export async function fetchPrDiff(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-diff${qs}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch PR diff: ${res.status}`);
	return res.json();
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
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-comment`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { ok: true; url?: string };
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
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-review`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { ok: true; url?: string };
}

export async function mergePrApi(
	sessionId: string,
	method: "squash" | "merge" | "rebase" = "squash",
	repo?: string,
) {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-merge`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, ...(repo ? { repo } : {}) }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { ok: true; url?: string };
}

// ── Automations ──

export interface ModelOption {
	id: string;
	provider: "claude" | "codex";
	label: string;
	aliases: string[];
}

export async function fetchModels(): Promise<{
	models: ModelOption[];
	default: string;
}> {
	const res = await fetch(`${BASE}/models`);
	if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
	return res.json();
}

export async function fetchAutomations() {
	const res = await fetch(`${BASE}/automations`);
	if (!res.ok) throw new Error(`Failed to fetch automations: ${res.status}`);
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
}) {
	const res = await fetch(`${BASE}/automations`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function updateAutomationApi(id: string, patch: object) {
	const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function deleteAutomationApi(id: string) {
	const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function runAutomationApi(id: string) {
	const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
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
	repo: string;
	scriptPath: string;
	inputs: ActionInput[];
	argMode: "positional" | "env";
	confirm?: boolean;
	model?: string;
	seeded?: boolean;
	createdBy: string;
	createdAt: string;
	lastRunAt?: string;
	lastRunSessionId?: string;
}

export async function fetchActions(): Promise<Action[]> {
	const res = await fetch(`${BASE}/actions`);
	if (!res.ok) throw new Error(`Failed to fetch actions: ${res.status}`);
	return res.json();
}

export async function createActionApi(input: {
	name: string;
	description?: string;
	repo: string;
	scriptPath: string;
	inputs: ActionInput[];
	argMode: "positional" | "env";
	confirm?: boolean;
	createdBy: string;
}): Promise<Action> {
	const res = await fetch(`${BASE}/actions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function deleteActionApi(id: string): Promise<void> {
	const res = await fetch(`${BASE}/actions/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function runActionApi(
	id: string,
	values: Record<string, unknown>,
	user: string,
): Promise<{ sessionId: string }> {
	const res = await fetch(`${BASE}/actions/${encodeURIComponent(id)}/run`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ values, user }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function introspectActionApi(
	repo: string,
	scriptPath: string,
): Promise<{ inputs: ActionInput[]; argMode: "positional" | "env" }> {
	const res = await fetch(`${BASE}/actions/introspect`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ repo, scriptPath }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

// ── Pins (per-user pinned tabs) ──

export async function fetchPins(user: string): Promise<string[]> {
	const res = await fetch(`${BASE}/pins?user=${encodeURIComponent(user)}`);
	if (!res.ok) throw new Error(`Failed to fetch pins: ${res.status}`);
	const body = await res.json();
	return Array.isArray(body?.pins) ? body.pins : [];
}

export async function savePinsApi(
	user: string,
	pins: string[],
): Promise<string[]> {
	const res = await fetch(`${BASE}/pins`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ user, pins }),
	});
	if (!res.ok) throw new Error(`Failed to save pins: ${res.status}`);
	const body = await res.json();
	return Array.isArray(body?.pins) ? body.pins : pins;
}

// ── Tab colors (per-user session tab colors) ──

export async function fetchTabColors(
	user: string,
): Promise<Record<string, string>> {
	const res = await fetch(
		`${BASE}/tab-colors?user=${encodeURIComponent(user)}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch tab colors: ${res.status}`);
	const body = await res.json();
	return body?.colors && typeof body.colors === "object" ? body.colors : {};
}

export async function saveTabColorsApi(
	user: string,
	colors: Record<string, string>,
): Promise<Record<string, string>> {
	const res = await fetch(`${BASE}/tab-colors`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ user, colors }),
	});
	if (!res.ok) throw new Error(`Failed to save tab colors: ${res.status}`);
	const body = await res.json();
	return body?.colors && typeof body.colors === "object" ? body.colors : colors;
}

// ── Wiki ──

export async function fetchWikiTree() {
	const res = await fetch(`${BASE}/wiki/tree`);
	if (!res.ok) throw new Error(`Failed to fetch wiki tree: ${res.status}`);
	return res.json();
}

export async function fetchWikiFile(path: string) {
	const res = await fetch(`${BASE}/wiki/file?path=${encodeURIComponent(path)}`);
	if (!res.ok) throw new Error(`Failed to fetch doc: ${res.status}`);
	return res.json();
}

export async function searchWikiApi(q: string) {
	const res = await fetch(`${BASE}/wiki/search?q=${encodeURIComponent(q)}`);
	if (!res.ok) throw new Error(`Search failed: ${res.status}`);
	return res.json();
}

export async function archiveSessionApi(sessionId: string, archived: boolean) {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/archive`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ archived }),
		},
	);
	if (!res.ok) throw new Error(`Failed to update archive state: ${res.status}`);
}

export async function archiveOldApi(
	days: number,
): Promise<{ archived: number }> {
	const res = await fetch(`${BASE}/sessions/archive-old`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ days }),
	});
	if (!res.ok) throw new Error(`Failed to archive: ${res.status}`);
	return res.json();
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
