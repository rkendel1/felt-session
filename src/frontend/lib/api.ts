import type { UnifiedSession } from "./types";

const BASE = "/backstage/api";

export async function fetchSessions(): Promise<UnifiedSession[]> {
  const res = await fetch(`${BASE}/sessions`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return res.json();
}

export async function fetchTranscript(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/transcript`);
  if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
  return res.json();
}

export interface SubagentTranscript {
  meta: { agentId: string; agentType?: string; description?: string; toolUseId?: string; spawnDepth?: number };
  entries: import("./types").TranscriptEntry[];
  sessionRunning: boolean;
}

export async function fetchSubagent(sessionId: string, agentId: string): Promise<SubagentTranscript> {
  const res = await fetch(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentId)}`
  );
  if (!res.ok) throw new Error(`Failed to fetch sub-agent: ${res.status}`);
  return res.json();
}

export async function fetchWorktrees(project?: string) {
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";
  const res = await fetch(`${BASE}/worktrees${qs}`);
  if (!res.ok) throw new Error(`Failed to fetch worktrees: ${res.status}`);
  return res.json();
}

export async function deleteSessionApi(sessionId: string, cleanWorktree: boolean): Promise<void> {
  const params = cleanWorktree ? "?worktree=true" : "";
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}${params}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to delete: ${res.status}`);
  }
}

export async function fetchDiff(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/diff`);
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
  return res.json();
}

export async function fetchPr(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr`);
  if (!res.ok) throw new Error(`Failed to fetch PR: ${res.status}`);
  return res.json();
}

export async function fetchPrDiff(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-diff`);
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
  }
) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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
    comments: Array<{
      text: string;
      path: string;
      line: number;
      startLine?: number;
      side?: "RIGHT" | "LEFT";
      startSide?: "RIGHT" | "LEFT";
    }>;
  }
) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
  return body as { ok: true; url?: string };
}

export async function mergePrApi(
  sessionId: string,
  method: "squash" | "merge" | "rebase" = "squash"
) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method }),
  });
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

export async function fetchModels(): Promise<{ models: ModelOption[]; default: string }> {
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
  const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function runAutomationApi(id: string) {
  const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
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
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) throw new Error(`Failed to update archive state: ${res.status}`);
}

export async function archiveOldApi(days: number): Promise<{ archived: number }> {
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
