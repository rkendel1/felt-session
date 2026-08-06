import { existsSync, readFileSync } from "fs";
import { configuredRepos, configuredServer, type Repo } from "../config";
import { configuredCloudAccess } from "../cloud-proxy";
import { gitPush } from "../git-status";
import { parseJsonlLines } from "../jsonl-parser";
import { sessionHasJournaledRun } from "../migrate-engine";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { isLocalProfile } from "../profile";
import { promptQueues } from "../queue-state";
import {
  findSession,
  getCachedSessions,
  invalidateSessionsCache,
} from "../session-cache";
import {
  beginLocalSessionUpgrade,
  endLocalSessionUpgrade,
} from "../session-transfer-state";
import { writeJsonAtomic } from "../shared/atomic-write";
import { mergedSessionTranscriptAsync } from "../sessions";
import { transcriptStore } from "../transcript-store";
import type {
  NativeSessionFile,
  TranscriptEntry,
  UnifiedSession,
} from "../types";
import {
  createWorktreeForExistingBranch,
  worktreeHeadBranch,
} from "../worktree";
import {
  isAgentSessionBusy,
  markSessionStarting,
  unmarkSessionStarting,
} from "../agent-runner";
import type { RouteContext } from "./context";

// os- is the current mint prefix; bks- ids exist in sessions created before
// the 2026-08-05 rename and stay importable forever (ids are never rewritten).
const OPENSESSION_UUID_V7 =
  /^(?:os|bks)-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ImportedFromLocalMarker {
  importedFrom: "local";
}

export interface UpgradedToCloudMarker {
  upgradedTo: { id: string; url: string };
}

export interface TransferSessionSubset {
  id: string;
  title?: string;
  createdBy?: string;
  createdAt?: string;
  lastActivity?: string;
  mode?: "ask" | "code" | "scratch";
  model?: string;
  effort?: string;
  fastMode?: boolean;
  modelHistory?: NativeSessionFile["modelHistory"];
  usage?: NativeSessionFile["usage"];
}

export interface SessionImportRequest {
  session: TransferSessionSubset;
  transcriptFormat: "transcript-v2-jsonl";
  transcriptJsonl: string;
  repo: string;
  branch: string;
}

interface ImportDependencies {
  repos(): Record<string, Repo>;
  sessionExists(id: string): boolean;
  branchExists(repo: Repo, branch: string): Promise<boolean>;
  createWorktree(branch: string, repo: string): Promise<string>;
  verifyWorktree(repo: Repo, branch: string, worktreeDir: string): Promise<void>;
  importTranscript(sessionId: string, entries: TranscriptEntry[]): void;
  removeTranscript(sessionId: string): void;
  writeSession(id: string, session: NativeSessionFile & ImportedFromLocalMarker): void;
  sessionUrl(id: string): string;
}

interface GitState {
  branch: string | null;
  uncommittedFiles: string[];
}

interface UpgradeDependencies {
  repos(): Record<string, Repo>;
  findSession(id: string): UnifiedSession | undefined;
  readSession(id: string): NativeSessionFile | null;
  isBusy(session: UnifiedSession, data: NativeSessionFile): boolean;
  hasQueuedPrompts(id: string): boolean;
  reserve(id: string): void;
  release(id: string): void;
  gitState(dir: string): Promise<GitState>;
  push(dir: string, branch: string): Promise<{ ok: true } | { error: string }>;
  readTranscript(
    session: UnifiedSession,
    data: NativeSessionFile,
  ): string | Promise<string>;
  cloud(): { upstream: string; token: string | null };
  fetch: typeof fetch;
  archive(
    id: string,
    data: NativeSessionFile,
    upgradedTo: { id: string; url: string },
  ): void;
}

const importingSessionIds: Set<string> = ((globalThis as any)
  .__importingLocalSessionIds ??= new Set());

function errorResponse(error: string, status = 400, extra?: object): Response {
  return Response.json({ error, ...extra }, { status });
}

function validImportId(id: unknown): id is string {
  return typeof id === "string" && OPENSESSION_UUID_V7.test(id);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseTranscriptJsonl(
  value: unknown,
  format: "transcript-v2-jsonl" | "claude-jsonl-v1",
): { entries: TranscriptEntry[]; error: null } | { entries: null; error: string } {
  if (typeof value !== "string") {
    return { entries: null, error: "transcriptJsonl must be a string" };
  }
  const rawLines = value.split("\n");
  if (format === "transcript-v2-jsonl") {
    const entries: TranscriptEntry[] = [];
    for (const [index, line] of rawLines.entries()) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (
          !parsed ||
          typeof parsed.id !== "string" ||
          !parsed.id ||
          (parsed.type !== "user" &&
            parsed.type !== "assistant" &&
            parsed.type !== "tool_use" &&
            parsed.type !== "tool_result" &&
            parsed.type !== "system") ||
          typeof parsed.content !== "string" ||
          typeof parsed.timestamp !== "string"
        ) {
          return {
            entries: null,
            error: `transcriptJsonl line ${index + 1} is not a supported transcript-v2 entry`,
          };
        }
        delete parsed.seq;
        entries.push(parsed as unknown as TranscriptEntry);
      } catch {
        return {
          entries: null,
          error: `transcriptJsonl line ${index + 1} is not valid JSON`,
        };
      }
    }
    return { entries, error: null };
  }
  for (const [index, line] of rawLines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const message = parsed?.message as Record<string, unknown> | undefined;
      if (
        !parsed ||
        (parsed.type !== "user" && parsed.type !== "assistant") ||
        typeof parsed.uuid !== "string" ||
        !parsed.uuid ||
        !message ||
        (message.role !== "user" && message.role !== "assistant") ||
        !Array.isArray(message.content)
      ) {
        return {
          entries: null,
          error: `transcriptJsonl line ${index + 1} is not a supported Claude-shape transcript record`,
        };
      }
    } catch {
      return {
        entries: null,
        error: `transcriptJsonl line ${index + 1} is not valid JSON`,
      };
    }
  }
  const lines = rawLines.filter((line) => line.trim());
  try {
    return { entries: parseJsonlLines(lines), error: null };
  } catch (error) {
    return {
      entries: null,
      error: `transcriptJsonl could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function transcriptJsonlForTransfer(entries: TranscriptEntry[]): string {
  const lines = entries
    .map((entry) => {
      const { seq: _seq, ...transferred } = entry as TranscriptEntry & {
        seq?: number;
      };
      return JSON.stringify(transferred);
    });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function importEngineId(sessionId: string): string {
  const bare = sessionId.replace(/^(os|bks)-/, "");
  return `ses_import_${bare.replaceAll("-", "")}`;
}

function transferredSession(
  value: unknown,
): { ok: true; session: TransferSessionSubset } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "session must be an object" };
  }
  const input = value as Record<string, unknown>;
  if (!validImportId(input.id)) {
    return { ok: false, error: "session.id must be a lowercase bks- UUIDv7 id" };
  }
  if (input.mode !== undefined && input.mode !== "ask" && input.mode !== "code") {
    return { ok: false, error: 'session.mode must be "ask" or "code"' };
  }
  for (const key of ["createdAt", "lastActivity"] as const) {
    if (input[key] !== undefined && !validDate(input[key])) {
      return { ok: false, error: `session.${key} must be an ISO date string` };
    }
  }
  const text = (key: string, max: number): string | undefined =>
    typeof input[key] === "string" && input[key].trim()
      ? input[key].trim().slice(0, max)
      : undefined;
  return {
    ok: true,
    session: {
      id: input.id,
      ...(text("title", 80) ? { title: text("title", 80) } : {}),
      ...(text("createdBy", 100) ? { createdBy: text("createdBy", 100) } : {}),
      ...(validDate(input.createdAt) ? { createdAt: input.createdAt } : {}),
      ...(validDate(input.lastActivity) ? { lastActivity: input.lastActivity } : {}),
      ...(input.mode === "ask" || input.mode === "code" ? { mode: input.mode } : {}),
      ...(text("model", 200) ? { model: text("model", 200) } : {}),
      ...(text("effort", 40) ? { effort: text("effort", 40) } : {}),
      ...(input.fastMode === true ? { fastMode: true } : {}),
      ...(Array.isArray(input.modelHistory)
        ? { modelHistory: input.modelHistory as NativeSessionFile["modelHistory"] }
        : {}),
      ...(input.usage && typeof input.usage === "object" && !Array.isArray(input.usage)
        ? { usage: input.usage as NativeSessionFile["usage"] }
        : {}),
    },
  };
}

export function sessionSubsetForTransfer(
  data: NativeSessionFile,
): TransferSessionSubset {
  return {
    id: data.id,
    ...(data.title ? { title: data.title } : {}),
    ...(data.createdBy ? { createdBy: data.createdBy } : {}),
    ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    ...(data.lastActivity ? { lastActivity: data.lastActivity } : {}),
    ...(data.mode ? { mode: data.mode } : {}),
    ...(data.model ? { model: data.model } : {}),
    ...(data.effort ? { effort: data.effort } : {}),
    ...(data.fastMode ? { fastMode: true } : {}),
    ...(data.modelHistory ? { modelHistory: data.modelHistory } : {}),
    ...(data.usage ? { usage: data.usage } : {}),
  };
}

export async function importCloudSession(
  body: unknown,
  authUser: RouteContext["authUser"],
  deps: ImportDependencies,
): Promise<Response> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const selected = transferredSession(input.session);
  if (!selected.ok) return errorResponse(selected.error);
  const repoId = typeof input.repo === "string" ? input.repo.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const repo = deps.repos()[repoId];
  if (!repo) return errorResponse(`Repository "${repoId}" is not registered`);
  if (!branch) return errorResponse("branch is required");
  const transcriptFormat =
    input.transcriptFormat === undefined
      ? "claude-jsonl-v1"
      : input.transcriptFormat;
  if (
    transcriptFormat !== "transcript-v2-jsonl" &&
    transcriptFormat !== "claude-jsonl-v1"
  ) {
    return errorResponse(
      'transcriptFormat must be "transcript-v2-jsonl" or "claude-jsonl-v1"',
    );
  }
  const transcript = parseTranscriptJsonl(
    input.transcriptJsonl,
    transcriptFormat,
  );
  if (transcript.entries === null) return errorResponse(transcript.error);

  const id = selected.session.id;
  if (deps.sessionExists(id) || importingSessionIds.has(id)) {
    return errorResponse(`Session "${id}" already exists`, 409);
  }
  importingSessionIds.add(id);
  const engineId = importEngineId(id);
  let transcriptImportStarted = false;
  try {
    if (!(await deps.branchExists(repo, branch))) {
      return errorResponse(
        `Branch "${branch}" does not exist on origin for repository "${repoId}"`,
      );
    }
    const worktreeDir = await deps.createWorktree(branch, repoId);
    await deps.verifyWorktree(repo, branch, worktreeDir);
    const now = new Date().toISOString();
    const session: NativeSessionFile & ImportedFromLocalMarker = {
      id,
      claudeSessionId: engineId,
      opencodeSessionId: engineId,
      branch,
      worktreeDir,
      repo: repoId,
      createdBy: selected.session.createdBy || authUser?.name || "Local user",
      ...(authUser?.login ? { createdByLogin: authUser.login } : {}),
      createdAt: selected.session.createdAt || now,
      lastActivity: selected.session.lastActivity || now,
      ...(selected.session.title ? { title: selected.session.title } : {}),
      mode: selected.session.mode || "code",
      ...(selected.session.model ? { model: selected.session.model } : {}),
      ...(selected.session.effort ? { effort: selected.session.effort } : {}),
      ...(selected.session.fastMode ? { fastMode: true } : {}),
      ...(selected.session.modelHistory
        ? { modelHistory: selected.session.modelHistory }
        : {}),
      ...(selected.session.usage ? { usage: selected.session.usage } : {}),
      importedFrom: "local",
    };
    transcriptImportStarted = true;
    deps.importTranscript(id, transcript.entries);
    deps.writeSession(id, session);
    return Response.json({ id, url: deps.sessionUrl(id) }, { status: 201 });
  } catch (error) {
    if (transcriptImportStarted) {
      try {
        deps.removeTranscript(id);
      } catch {}
    }
    return errorResponse(
      error instanceof Error ? error.message : String(error),
      500,
    );
  } finally {
    importingSessionIds.delete(id);
  }
}

function normalizeGitHubRepo(value: string): string {
  return value.trim().replace(/\.git$/i, "").toLowerCase();
}

function upstreamEndpoint(upstream: string, path: string): string {
  const url = new URL(upstream);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("cloud.upstream must use HTTP or HTTPS");
  }
  return `${url.toString().replace(/\/+$/, "")}${path}`;
}

function cloudSessionDestination(
  value: unknown,
  id: string,
  upstream: string,
): { id: string; url: string } | null {
  if (!value || typeof value !== "object") return null;
  const result = value as { id?: unknown; url?: unknown };
  if (result.id !== id || !validImportId(result.id) || typeof result.url !== "string") {
    return null;
  }
  try {
    const expectedOrigin = new URL(upstream).origin;
    const destination = new URL(result.url);
    if (
      destination.origin !== expectedOrigin ||
      !destination.pathname.endsWith(`/session/${encodeURIComponent(id)}`)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { id, url: result.url };
}

async function passUpstreamError(response: Response): Promise<Response> {
  let text = "";
  try {
    text = await response.text();
  } catch {}
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as Record<string, unknown>;
        const error =
          typeof body.error === "string" && body.error
            ? body.error
            : typeof body.message === "string" && body.message
              ? body.message
              : `Cloud Open Session returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
        return Response.json({ ...body, error }, { status: response.status });
      }
    } catch {}
  }
  const detail = text.trim().slice(0, 2_000);
  return errorResponse(
    detail ||
      `Cloud Open Session returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    response.status,
  );
}

export async function upgradeLocalSession(
  id: string,
  deps: UpgradeDependencies,
): Promise<Response> {
  const session = deps.findSession(id);
  if (!session || session.source !== "opensession") {
    return errorResponse("Local session not found", 404);
  }
  const data = deps.readSession(id);
  if (!data?.id || data.id !== id) {
    return errorResponse("Local session file not found", 404);
  }
  if (data.upgradedTo) {
    return Response.json(data.upgradedTo);
  }
  if (session.archived || data.archived) {
    return errorResponse("Archived local sessions cannot be upgraded", 409);
  }
  if (deps.isBusy(session, data)) {
    return errorResponse("Session is running; stop it before upgrading", 409);
  }
  if (deps.hasQueuedPrompts(id)) {
    return errorResponse(
      "Session has queued prompts; let them finish or remove them before upgrading",
      409,
    );
  }
  if (session.attachedRepos?.length || data.attachedRepos?.length) {
    return errorResponse(
      "Sessions with attached repositories cannot yet be moved to cloud",
      409,
    );
  }
  if (!beginLocalSessionUpgrade(id)) {
    return errorResponse("Session upgrade is already in progress", 409);
  }
  // Reserve synchronously before the first await below. This uses the same
  // starting-state gate as a prompt, so no new engine turn can begin while the
  // branch and transcript are being shipped.
  let reserved = false;
  try {
    deps.reserve(id);
    reserved = true;
    return await finishLocalUpgrade(id, session, data, deps);
  } finally {
    if (reserved) deps.release(id);
    endLocalSessionUpgrade(id);
  }
}

async function finishLocalUpgrade(
  id: string,
  session: UnifiedSession,
  data: NativeSessionFile,
  deps: UpgradeDependencies,
): Promise<Response> {
  if (!session.worktreeDir || !session.branch || session.mode !== "code") {
    return errorResponse("Only local code sessions with a branch can be upgraded");
  }
  const repoId = session.repo || data.repo || "";
  const repo = deps.repos()[repoId];
  if (!repo) return errorResponse(`Local repository "${repoId}" is not registered`);
  if (!repo.ghRepo) {
    return errorResponse(
      `Repository "${repoId}" does not have a GitHub origin and cannot be upgraded`,
    );
  }

  let state: GitState;
  try {
    state = await deps.gitState(session.worktreeDir);
  } catch (error) {
    return errorResponse(
      `Could not inspect the session worktree: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  if (!state.branch) {
    return errorResponse("The session worktree has a detached HEAD", 409);
  }
  if (state.branch !== session.branch) {
    return errorResponse(
      `The session records branch "${session.branch}" but the worktree is on "${state.branch}"`,
      409,
    );
  }
  if (state.uncommittedFiles.length) {
    return errorResponse(
      "Commit or discard the worktree changes before upgrading",
      409,
      { uncommittedFiles: state.uncommittedFiles },
    );
  }

  const cloud = deps.cloud();
  if (!cloud.token) {
    return errorResponse(
      "Cloud upgrade is not configured; set cloud.token or OPENSESSION_CLOUD_TOKEN",
    );
  }
  let reposUrl: string;
  let importUrl: string;
  let sessionsUrl: string;
  try {
    reposUrl = upstreamEndpoint(cloud.upstream, "/api/repos");
    importUrl = upstreamEndpoint(cloud.upstream, "/api/sessions/import");
    sessionsUrl = upstreamEndpoint(cloud.upstream, "/api/sessions");
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error));
  }
  const headers = { authorization: `Bearer ${cloud.token}` };
  let reposResponse: Response;
  try {
    reposResponse = await deps.fetch(reposUrl, { headers });
  } catch (error) {
    return errorResponse(`Cloud Open Session is unreachable: ${error}`, 502);
  }
  if (!reposResponse.ok) return passUpstreamError(reposResponse);
  const reposBody = await reposResponse.json().catch(() => null);
  const cloudRepos = Array.isArray(reposBody?.repos) ? reposBody.repos : null;
  if (!cloudRepos) {
    return errorResponse("Cloud Open Session returned an invalid repository list", 502);
  }
  const ghRepo = normalizeGitHubRepo(repo.ghRepo);
  const cloudRepo = cloudRepos.find(
    (entry: any) =>
      typeof entry?.id === "string" &&
      typeof entry?.ghRepo === "string" &&
      normalizeGitHubRepo(entry.ghRepo) === ghRepo,
  );
  if (!cloudRepo) {
    return errorResponse(
      `GitHub repository "${repo.ghRepo}" is not registered on the cloud Open Session`,
    );
  }

  let pushed: { ok: true } | { error: string };
  try {
    pushed = await deps.push(session.worktreeDir, session.branch);
  } catch (error) {
    return errorResponse(
      `Could not push the session branch: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  if ("error" in pushed) return errorResponse(pushed.error, 500);

  let transcriptJsonl: string;
  try {
    transcriptJsonl = await deps.readTranscript(session, data);
  } catch (error) {
    return errorResponse(
      `Could not read the local transcript: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  const importBody: SessionImportRequest = {
    session: sessionSubsetForTransfer(data),
    transcriptFormat: "transcript-v2-jsonl",
    transcriptJsonl,
    repo: cloudRepo.id,
    branch: session.branch,
  };
  let imported: Response;
  try {
    imported = await deps.fetch(importUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(importBody),
    });
  } catch (error) {
    return errorResponse(`Cloud Open Session is unreachable: ${error}`, 502);
  }
  let destination: { id: string; url: string } | null = null;
  if (imported.ok) {
    destination = cloudSessionDestination(
      await imported.json().catch(() => null),
      id,
      cloud.upstream,
    );
  } else if (imported.status === 409) {
    // The cloud import commits before the local archive marker. If the process
    // died in that narrow gap, a retry sees the required duplicate-id 409.
    // Verify that the existing destination is this local import, then finish
    // the local archive instead of stranding the transfer forever.
    try {
      const sessionsResponse = await deps.fetch(sessionsUrl, { headers });
      if (sessionsResponse.ok) {
        const sessions = await sessionsResponse.json().catch(() => null);
        const existing = Array.isArray(sessions)
          ? sessions.find(
              (entry: any) =>
                entry?.id === id &&
                entry?.importedFrom === "local" &&
                entry?.repo === cloudRepo.id &&
                entry?.branch === session.branch,
            )
          : null;
        if (existing) {
          destination = {
            id,
            url: upstreamEndpoint(
              cloud.upstream,
              `/session/${encodeURIComponent(id)}`,
            ),
          };
        }
      }
    } catch {}
    if (!destination) return passUpstreamError(imported);
  } else {
    return passUpstreamError(imported);
  }
  if (!destination) {
    return errorResponse("Cloud Open Session returned an invalid import response", 502);
  }

  try {
    deps.archive(id, data, destination);
  } catch (error) {
    return errorResponse(
      `The cloud session was imported, but the local session could not be archived: ${error instanceof Error ? error.message : String(error)}`,
      500,
      destination,
    );
  }
  return Response.json(destination);
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

const productionImportDependencies: ImportDependencies = {
  repos: configuredRepos,
  sessionExists: (id) =>
    existsSync(`${OPENSESSION_SESSIONS_DIR}/${id}.json`) ||
    getCachedSessions().some(
      (session) => session.id === id || session.aliasIds?.includes(id),
    ),
  branchExists: async (repo, branch) => {
    const valid = await runGit(repo.repo, ["check-ref-format", "--branch", branch]);
    if (valid.exitCode !== 0) return false;
    const remote = await runGit(repo.repo, [
      "ls-remote",
      "--exit-code",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    ]);
    if (remote.exitCode !== 0) return false;
    const fetched = await runGit(repo.repo, ["fetch", "origin", branch, "--quiet"]);
    return fetched.exitCode === 0;
  },
  createWorktree: createWorktreeForExistingBranch,
  verifyWorktree: async (repo, branch, worktreeDir) => {
    const [head, origin, status] = await Promise.all([
      runGit(worktreeDir, ["rev-parse", "HEAD"]),
      runGit(repo.repo, ["rev-parse", `origin/${branch}`]),
      runGit(worktreeDir, ["status", "--porcelain=v1"]),
    ]);
    if (head.exitCode !== 0 || origin.exitCode !== 0 || head.stdout !== origin.stdout) {
      throw new Error(
        `Cloud worktree for "${branch}" does not match the freshly fetched origin branch`,
      );
    }
    if (status.exitCode !== 0 || status.stdout) {
      throw new Error(`Cloud worktree for "${branch}" has uncommitted changes`);
    }
  },
  importTranscript: (sessionId, entries) =>
    transcriptStore().importLegacyTranscript(
      sessionId,
      entries,
      "local-import",
      null,
    ),
  removeTranscript: (sessionId) =>
    transcriptStore().deleteSessionTranscript(sessionId),
  writeSession: (id, session) => {
    writeJsonAtomic(`${OPENSESSION_SESSIONS_DIR}/${id}.json`, session);
    invalidateSessionsCache();
  },
  sessionUrl: (id) =>
    `${configuredServer().publicBaseUrl.replace(/\/+$/, "")}/session/${encodeURIComponent(id)}`,
};

const productionUpgradeDependencies: UpgradeDependencies = {
  repos: configuredRepos,
  findSession,
  readSession: (id) => {
    try {
      return JSON.parse(
        readFileSync(`${OPENSESSION_SESSIONS_DIR}/${id}.json`, "utf-8"),
      );
    } catch {
      return null;
    }
  },
  isBusy: (session, data) =>
    session.isRunning ||
    isAgentSessionBusy(
      session.claudeSessionId,
      session.codexThreadId,
      session.id,
    ) ||
    sessionHasJournaledRun(session.id, data),
  hasQueuedPrompts: (id) => !!promptQueues.get(id)?.length,
  reserve: markSessionStarting,
  release: unmarkSessionStarting,
  gitState: async (dir) => {
    const branch = worktreeHeadBranch(dir);
    const status = await runGit(dir, ["status", "--porcelain=v1"]);
    if (status.exitCode !== 0) {
      throw new Error(status.stderr || "git status failed");
    }
    return {
      branch,
      uncommittedFiles: status.stdout
        .split("\n")
        .filter(Boolean)
        // runGit trims the full stdout, so the first porcelain line may lose
        // its leading index-space (" M file" becomes "M file"). Accept both.
        .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim()),
    };
  },
  push: gitPush,
  readTranscript: async (session) => {
    // A drifted v2 read repairs the store but returns the legacy fallback for
    // that call. Read once to perform any repair, then export the authoritative
    // store view so store-only notices and live entries cannot be omitted.
    await mergedSessionTranscriptAsync(session);
    return transcriptJsonlForTransfer(
      await mergedSessionTranscriptAsync(session),
    );
  },
  cloud: configuredCloudAccess,
  fetch,
  archive: (id, data, upgradedTo) => {
    const now = new Date().toISOString();
    writeJsonAtomic(`${OPENSESSION_SESSIONS_DIR}/${id}.json`, {
      ...data,
      archived: true,
      archivedAt: now,
      archivedReason: "manual",
      lastActivity: now,
      upgradedTo,
    } satisfies NativeSessionFile & UpgradedToCloudMarker);
    invalidateSessionsCache();
  },
};

export async function handleSessionTransferRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (
    !isLocalProfile() &&
    ctx.path === "/api/sessions/import" &&
    ctx.req.method === "POST"
  ) {
    const body = await ctx.req.json().catch(() => null);
    try {
      return await importCloudSession(
        body,
        ctx.authUser,
        productionImportDependencies,
      );
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : String(error),
        500,
      );
    }
  }

  const upgradeMatch = ctx.path.match(
    /^\/api\/sessions\/([^/]+)\/upgrade$/,
  );
  if (isLocalProfile() && upgradeMatch && ctx.req.method === "POST") {
    try {
      return await upgradeLocalSession(
        decodeURIComponent(upgradeMatch[1]),
        productionUpgradeDependencies,
      );
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : String(error),
        500,
      );
    }
  }

  return undefined;
}
