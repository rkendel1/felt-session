import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { existsSync } from "fs";
import { slackIdToFirstName } from "./shared/user-mappings";
import { isArchivedId } from "./archive";
import { findCodexRollout } from "./codex-accounts";
import { providerFor } from "./models";
import type {
  UnifiedSession,
  SlackSessionFile,
  LinearSessionFile,
  CLISessionFile,
  BackstageSessionFile,
} from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const SLACK_SESSIONS_DIR = `${HOME}/.slack-sessions`;
const LINEAR_SESSIONS_DIR = `${HOME}/.linear-sessions`;
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
const BACKSTAGE_SESSIONS_DIR = `${HOME}/.backstage-sessions`;
const CLAUDE_PROJECTS_DIR = `${HOME}/.claude/projects`;

const SKIP_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
  "prompt-queues.json",
  "active-at-shutdown.json",
  "active-runs.json",
]);

function resolveSlackUser(userId: string): string {
  // Could be a Slack user ID (e.g. UT41L6GCC) or already a display name
  const mapped = slackIdToFirstName(userId);
  if (mapped) return mapped;
  // Extract first name from "Firstname Lastname" format
  if (userId.includes(" ")) return userId.split(" ")[0];
  return userId;
}

export function getTranscriptPath(
  worktreeDir: string,
  sessionId: string
): string {
  const hash = worktreeDir.replaceAll("/", "-").replace(/^-/, "");
  return `${CLAUDE_PROJECTS_DIR}/-${hash}/${sessionId}.jsonl`;
}

function findTranscriptPath(
  worktreeDir: string | null,
  sessionId: string | null
): string | null {
  if (!sessionId) return null;
  if (worktreeDir) {
    const path = getTranscriptPath(worktreeDir, sessionId);
    if (existsSync(path)) return path;
  }
  // Fallback: check common CWD paths the agents use
  const fallbacks = [
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu-projects-tella-fusion/${sessionId}.jsonl`,
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu/${sessionId}.jsonl`,
  ];
  for (const path of fallbacks) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Transcript for a session that may have run on either engine: codex-model
 * sessions render their rollout jsonl; everything else the claude transcript.
 */
function resolveTranscriptPath(
  claudePath: string | null,
  codexThreadId: string | null | undefined,
  model: string | null | undefined
): string | null {
  if (codexThreadId && providerFor(model) === "codex") {
    const rollout = findCodexRollout(codexThreadId);
    if (rollout) return rollout.path;
  }
  return claudePath;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function getFileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function scanSlackSessions(): UnifiedSession[] {
  if (!existsSync(SLACK_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(SLACK_SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<SlackSessionFile>(
      `${SLACK_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const branch = data.branch || file.replace(".json", "");
    const startedBy = data.userId
      ? resolveSlackUser(data.userId)
      : null;

    // Use a stable ID based on filename
    const id = `slack-${file.replace(".json", "")}`;

    sessions.push({
      id,
      claudeSessionId: data.claudeSessionId || null,
      source: "slack",
      branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title: branch,
      lastActivity:
        data.lastActivity ||
        data.createdAt ||
        getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      createdAt:
        data.createdAt || getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir || null, data.claudeSessionId || null),
        data.codexThreadId,
        data.model
      ),
      slackThread: data.channel
        ? { channel: data.channel, threadTs: data.threadTs || "" }
        : undefined,
      model: data.model,
      codexThreadId: data.codexThreadId || undefined,
    });
  }
  return sessions;
}

function scanLinearSessions(): UnifiedSession[] {
  if (!existsSync(LINEAR_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(LINEAR_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<LinearSessionFile>(
      `${LINEAR_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const rawName =
      data.participants?.[0]?.name ||
      data.lastActiveUser?.name ||
      null;
    // Clean up email-style names (e.g. "john@tella.com" → "John")
    const startedBy = rawName?.includes("@")
      ? rawName.split("@")[0].charAt(0).toUpperCase() + rawName.split("@")[0].slice(1)
      : rawName;

    const title = data.issueIdentifier
      ? `${data.issueIdentifier}: ${data.issueTitle || data.branch}`
      : data.branch;

    const id = `linear-${data.branch}`;

    sessions.push({
      id,
      claudeSessionId: data.claudeSessionId,
      source: "linear",
      branch: data.branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title,
      lastActivity:
        data.updatedAt || getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      createdAt: getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: findTranscriptPath(
        data.worktreeDir || null,
        data.claudeSessionId
      ),
      linearIssue: data.issueIdentifier
        ? {
            identifier: data.issueIdentifier,
            title: data.issueTitle || data.branch,
            url: data.issueUrl,
          }
        : undefined,
      model: data.model,
    });
  }
  return sessions;
}

function scanBackstageSessions(): UnifiedSession[] {
  if (!existsSync(BACKSTAGE_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(BACKSTAGE_SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<BackstageSessionFile>(
      `${BACKSTAGE_SESSIONS_DIR}/${file}`
    );
    // Skip non-session bookkeeping files in this dir (active-runs.json,
    // prompt-queues.json, active-at-shutdown.json, …) — a real session always
    // has an id, these don't, so they'd otherwise become bogus id:undefined rows.
    if (!data || !data.id) continue;

    sessions.push({
      id: data.id,
      claudeSessionId: data.claudeSessionId,
      source: "backstage",
      branch: data.branch || null,
      worktreeDir: data.worktreeDir || null,
      startedBy: data.createdBy,
      title: data.title || data.branch || "Ask session",
      mode: data.mode,
      project: data.project,
      automation:
        data.automation ||
        (data.createdBy?.endsWith(" (automation)")
          ? data.createdBy.slice(0, -" (automation)".length)
          : undefined),
      archived: data.archived || undefined,
      plainThreadId: data.plainThreadId,
      model: data.model,
      codexThreadId: data.codexThreadId,
      modelHistory: data.modelHistory,
      goal: data.goal,
      loop: data.loop,
      lastActivity: data.lastActivity,
      createdAt: data.createdAt,
      isRunning: false,
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir, data.claudeSessionId),
        data.codexThreadId,
        data.model
      ),
    });
  }
  return sessions;
}

function getRunningPids(): Map<string, number> {
  // Map of sessionId → pid for currently running CLI sessions
  const running = new Map<string, number>();
  if (!existsSync(CLI_SESSIONS_DIR)) return running;

  for (const file of readdirSync(CLI_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<CLISessionFile>(`${CLI_SESSIONS_DIR}/${file}`);
    if (!data) continue;

    try {
      process.kill(data.pid, 0); // Check if PID is alive
      running.set(data.sessionId, data.pid);
    } catch {
      // PID is dead
    }
  }
  return running;
}

// PR cache: branch → rich PR info, refreshed every 60s. A single batched
// `gh pr list` carries everything the Reviews table renders as columns
// (diffstat, review decision, a CI checks rollup summary, author), so the list
// never has to N+1 fetch per PR — only the detail pane does.
interface PrChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}
interface PrInfo {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  number: number;
  title: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  updatedAt: string;
  checks: PrChecksSummary;
}
let prCache: { data: Map<string, PrInfo>; ts: number } = { data: new Map(), ts: 0 };
const PR_CACHE_TTL = 60_000;
let prRefreshing = false;

interface RollupCheck { status?: string; conclusion?: string; state?: string }

// Collapse GitHub's per-check rollup into the four counts the UI shows. A check
// is "pending" until COMPLETED; once complete its conclusion decides pass/fail.
// Skipped/neutral checks count toward the total but are neither pass nor fail,
// matching how GitHub's merge box treats them.
function summarizeChecks(rollup: RollupCheck[] | undefined): PrChecksSummary {
  const summary: PrChecksSummary = { total: 0, passed: 0, failed: 0, pending: 0 };
  for (const c of rollup || []) {
    summary.total++;
    // StatusContext (legacy commit statuses) report `state`; CheckRun reports
    // status + conclusion.
    const status = (c.status || "").toUpperCase();
    const conclusion = (c.conclusion || c.state || "").toUpperCase();
    if (status && status !== "COMPLETED") {
      summary.pending++;
    } else if (["FAILURE", "TIMED_OUT", "ERROR", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"].includes(conclusion)) {
      summary.failed++;
    } else if (conclusion === "SUCCESS") {
      summary.passed++;
    }
    // SKIPPED / NEUTRAL / "" fall through — counted in total only.
  }
  return summary;
}

// Stale-while-revalidate: never block the event loop on gh (it takes ~10s on
// this repo, which used to freeze every agent in the process).
function getPrsByBranch(): Map<string, PrInfo> {
  if (Date.now() - prCache.ts >= PR_CACHE_TTL) void refreshPrCache();
  return prCache.data;
}

async function ghJson<T>(args: string[]): Promise<T | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore" });
    const raw = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || !raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function refreshPrCache(): Promise<void> {
  if (prRefreshing) return;
  prRefreshing = true;
  try {
    // GitHub's GraphQL 504s when asked for statusCheckRollup across hundreds of
    // PRs, so split the work: one cheap bulk call for every PR's metadata, and
    // a second scoped call that pulls the CI rollup only for the recent open
    // PRs (the ones a reviewer actually triages). Closed/merged PRs simply show
    // no checks column.
    const [bulk, rollups] = await Promise.all([
      ghJson<Array<{
        headRefName: string; url: string; state: string; number: number; title: string;
        isDraft: boolean; additions: number; deletions: number; changedFiles: number;
        reviewDecision: string; author?: { login?: string; name?: string }; updatedAt: string;
      }>>([
        "pr", "list", "--repo", "tellahq/tella-fusion", "--state", "all", "--limit", "200",
        "--json", "headRefName,url,state,number,title,isDraft,additions,deletions,changedFiles,reviewDecision,author,updatedAt",
      ]),
      ghJson<Array<{ number: number; statusCheckRollup?: RollupCheck[] }>>([
        "pr", "list", "--repo", "tellahq/tella-fusion", "--state", "open", "--limit", "40",
        "--json", "number,statusCheckRollup",
      ]),
    ]);

    if (!bulk) {
      prCache.ts = Date.now(); // back off on failure, keep stale data
      return;
    }

    const checksByNumber = new Map<number, PrChecksSummary>();
    for (const r of rollups || []) {
      checksByNumber.set(r.number, summarizeChecks(r.statusCheckRollup));
    }

    const map = new Map<string, PrInfo>();
    for (const pr of bulk) {
      map.set(pr.headRefName, {
        url: pr.url,
        state: pr.state as PrInfo["state"],
        number: pr.number,
        title: pr.title || "",
        isDraft: !!pr.isDraft,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changedFiles: pr.changedFiles || 0,
        reviewDecision: pr.reviewDecision || "",
        author: pr.author?.login || pr.author?.name || "",
        updatedAt: pr.updatedAt || "",
        checks: checksByNumber.get(pr.number) || { total: 0, passed: 0, failed: 0, pending: 0 },
      });
    }
    prCache = { data: map, ts: Date.now() };
  } catch (e) {
    console.error("Failed to fetch PRs:", e);
    prCache.ts = Date.now(); // back off on failure too
  } finally {
    prRefreshing = false;
  }
}

export function getAllSessions(): UnifiedSession[] {
  const slackSessions = scanSlackSessions();
  const linearSessions = scanLinearSessions();
  const backstageSessions = scanBackstageSessions();
  const runningPids = getRunningPids();

  // Merge all sessions, deduplicating by claudeSessionId
  const byClaudeId = new Map<string, UnifiedSession>();
  const allSessions: UnifiedSession[] = [];

  for (const session of [
    ...backstageSessions,
    ...linearSessions,
    ...slackSessions,
  ]) {
    if (session.claudeSessionId) {
      const existing = byClaudeId.get(session.claudeSessionId);
      if (existing) {
        // Keep the one with richer data (linear > backstage > slack)
        // but mark running status from either
        if (runningPids.has(session.claudeSessionId)) {
          existing.isRunning = true;
        }
        // Keep the dropped ID as an alias so deep links to it (e.g. the
        // Slack "Open in Backstage" button, which uses slack-<channel>-<ts>)
        // still resolve to the surviving session.
        existing.aliasIds = [...(existing.aliasIds || []), session.id];
        continue;
      }
      byClaudeId.set(session.claudeSessionId, session);
    }

    // Mark running status
    if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
      session.isRunning = true;
    }

    allSessions.push(session);
  }

  // Enrich with PR URLs and state
  const prs = getPrsByBranch();
  for (const session of allSessions) {
    if (session.branch) {
      const pr = prs.get(session.branch);
      if (pr) {
        session.prUrl = pr.url;
        session.prState = pr.state;
        session.prNumber = pr.number;
        session.prTitle = pr.title;
        session.prIsDraft = pr.isDraft;
        session.prAdditions = pr.additions;
        session.prDeletions = pr.deletions;
        session.prChangedFiles = pr.changedFiles;
        session.prReviewDecision = pr.reviewDecision;
        session.prAuthor = pr.author;
        session.prUpdatedAt = pr.updatedAt;
        session.prChecks = pr.checks;
      }
    }
  }

  // Apply the cross-source archive registry
  for (const session of allSessions) {
    if (!session.archived && isArchivedId(session.id)) session.archived = true;
  }

  // Sort by lastActivity descending
  allSessions.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  return allSessions;
}

export function deleteSession(session: UnifiedSession): void {
  // Delete the session JSON file based on source
  switch (session.source) {
    case "slack": {
      // ID format: slack-{filename}
      const filename = session.id.replace(/^slack-/, "") + ".json";
      const path = `${SLACK_SESSIONS_DIR}/${filename}`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "linear": {
      // ID format: linear-{branch}
      const branch = session.id.replace(/^linear-/, "");
      const path = `${LINEAR_SESSIONS_DIR}/${branch}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "backstage": {
      const path = `${BACKSTAGE_SESSIONS_DIR}/${session.id}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
  }
}
