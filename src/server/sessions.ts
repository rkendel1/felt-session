import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { existsSync } from "fs";
import {
	slackIdToFirstName,
	githubLoginToPersonKey,
} from "./shared/user-mappings";
import { isArchivedId } from "./archive";
import { listWorkspaces } from "./workspaces";
import { getTitleOverride } from "./title-overrides";
import { getGeneratedTitle } from "./generated-titles";
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
const BACKSTAGE_SESSIONS_DIR = BACKSTAGE_CHATS_DIR;
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
  } catch (e) {
    // A missing file is normal; a corrupt one makes the session silently
    // vanish from the UI, so leave a trace.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
      console.warn(`[sessions] Failed to parse ${path}:`, e);
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
      // Back-compat: older session files stored the repo under `project`.
      repo: data.repo ?? (data as { project?: string }).project,
      // Dual-read: the migration mirrors projectId→workspaceId; prefer the new key.
      projectId:
        (data as { workspaceId?: string | null }).workspaceId ??
        data.projectId ??
        null,
      attachedRepos: data.attachedRepos,
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
      goalId: data.goalId,
      loop: data.loop,
      slackChannel: data.slackChannel,
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
// Repos the bulk PR cache covers — the active dev repos whose PRs the sidebar
// Open PRs section and Reviews table surface. Fusion carries 200+ open PRs and
// GitHub's GraphQL 504s on wide statusCheckRollup queries there, so limits are
// per-repo. Repos not listed here fall back to session-derived PR info only.
const PR_REPOS = [
	{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion", openLimit: 500, recentLimit: 200, rollupLimit: 60 },
	{ id: "backstage", ghRepo: "tellahq/backstage", openLimit: 100, recentLimit: 100, rollupLimit: 30 },
] as const;

// repo id → branch → PR info. Keyed per repo so the same branch name in two
// repos (multi-repo sessions share branch names) never collides.
let prCache: { data: Map<string, Map<string, PrInfo>>; ts: number } = { data: new Map(), ts: 0 };
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
// fusion, which used to freeze every agent in the process).
function getPrsByRepo(): Map<string, Map<string, PrInfo>> {
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
    type BulkPr = {
      headRefName: string; url: string; state: string; number: number; title: string;
      isDraft: boolean; additions: number; deletions: number; changedFiles: number;
      reviewDecision: string; author?: { login?: string; name?: string }; updatedAt: string;
    };
    const FIELDS =
      "headRefName,url,state,number,title,isDraft,additions,deletions,changedFiles,reviewDecision,author,updatedAt";

    // A session's branch is matched against open PRs, so we must see EVERY open
    // PR — not just the newest N. Fusion carries 200+ open PRs at a time, so a
    // single `--state all --limit 200` window silently drops older open ones
    // (the bug where a real PR wouldn't show on its session). Split it:
    //   - `--state open` with a generous limit → all open PRs (the live matches)
    //   - `--state all` window → recently merged/closed (Reviews "merged" view +
    //     sessions whose PR just landed)
    // GitHub's GraphQL also 504s asking for statusCheckRollup across hundreds of
    // PRs, so the CI rollup stays a small scoped call over the most recent open
    // PRs (the ones a reviewer actually triages); others show no checks column.
    const next = new Map<string, Map<string, PrInfo>>();
    await Promise.all(PR_REPOS.map(async (repo) => {
      const [openPrs, recentAll, rollups] = await Promise.all([
        ghJson<BulkPr[]>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "open",
          "--limit", String(repo.openLimit), "--json", FIELDS,
        ]),
        ghJson<BulkPr[]>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "all",
          "--limit", String(repo.recentLimit), "--json", FIELDS,
        ]),
        ghJson<Array<{ number: number; statusCheckRollup?: RollupCheck[] }>>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "open",
          "--limit", String(repo.rollupLimit), "--json", "number,statusCheckRollup",
        ]),
      ]);

      if (!openPrs && !recentAll) {
        // Both calls failed for this repo — keep its stale data.
        const stale = prCache.data.get(repo.id);
        if (stale) next.set(repo.id, stale);
        return;
      }

      const checksByNumber = new Map<number, PrChecksSummary>();
      for (const r of rollups || []) {
        checksByNumber.set(r.number, summarizeChecks(r.statusCheckRollup));
      }

      const toInfo = (pr: BulkPr): PrInfo => ({
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

      // Seed with recent closed/merged (newest-first → keep the first per branch),
      // then let open PRs override: an open PR is the authoritative state for a
      // branch even if an older closed PR reused the same head ref.
      const map = new Map<string, PrInfo>();
      for (const pr of recentAll || []) {
        if (!map.has(pr.headRefName)) map.set(pr.headRefName, toInfo(pr));
      }
      for (const pr of openPrs || []) {
        map.set(pr.headRefName, toInfo(pr));
      }
      next.set(repo.id, map);
    }));
    prCache = { data: next, ts: Date.now() };
  } catch (e) {
    console.error("Failed to fetch PRs:", e);
    prCache.ts = Date.now(); // back off on failure too
  } finally {
    prRefreshing = false;
  }
}

/**
 * Every open PR across the covered repos (PR_REPOS — from the same batched
 * cache the session enrichment uses), each attributed to a teammate when its
 * GitHub author maps to one via the identity table. Bot-authored PRs
 * (tella-butler — the ones Michael opens from sessions) come back with
 * `person: null`; the frontend attributes those through the session that
 * opened them. Powers the sidebar's Open PRs section, which must show a
 * person's PRs even when no Backstage session exists for them — e.g. PRs
 * opened from another tool (Conductor, local CLI) under their own account.
 */
export interface OpenPrEntry {
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

export function getOpenPrs(): OpenPrEntry[] {
	// PR-backed workspaces, keyed per repo + PR number, so a sessionless PR row
	// can still open the workspace the PR automations already created for it.
	// The ghpr key carries no repo, and workspaces predating the repo field are
	// tella-fusion's (its automations created them all), so absent repo = fusion.
	const wsByPr = new Map<string, string>();
	for (const w of listWorkspaces()) {
		const num = w.prNumber ?? Number(/^ghpr-(\d+)$/.exec(w.key || "")?.[1]);
		if (num) wsByPr.set(`${w.repo || "tella-fusion"}#${num}`, w.id);
	}

	const out: OpenPrEntry[] = [];
	for (const [repoId, byBranch] of getPrsByRepo()) {
		for (const [branch, pr] of byBranch) {
			if (pr.state !== "OPEN") continue;
			out.push({
				repo: repoId,
				branch,
				url: pr.url,
				number: pr.number,
				title: pr.title,
				isDraft: pr.isDraft,
				reviewDecision: pr.reviewDecision,
				author: pr.author,
				person: githubLoginToPersonKey(pr.author),
				updatedAt: pr.updatedAt,
				workspaceId: wsByPr.get(`${repoId}#${pr.number}`) || null,
			});
		}
	}
	return out.sort((a, b) =>
		(b.updatedAt || "").localeCompare(a.updatedAt || ""),
	);
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

  // Enrich with PR URLs and state, matched within the session's own repo so a
  // branch name reused across repos never picks up the wrong PR.
  const prsByRepo = getPrsByRepo();
  for (const session of allSessions) {
    if (session.branch) {
      const pr = prsByRepo.get(session.repo || "tella-fusion")?.get(session.branch);
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

  // Apply auto-generated summary titles (the short Conductor-style name),
  // keyed by unified id or merged alias id. Sits UNDER a manual rename (applied
  // next) but OVER the derived first-line title.
  for (const session of allSessions) {
    const generated =
      getGeneratedTitle(session.id) ??
      session.aliasIds?.map((a) => getGeneratedTitle(a)).find(Boolean);
    if (generated) session.title = generated;
  }

  // Apply cross-source manual title overrides (rename). Keyed by the unified id
  // or any merged alias id, so a rename sticks across the dedup in this scan.
  for (const session of allSessions) {
    const override =
      getTitleOverride(session.id) ??
      session.aliasIds?.map((a) => getTitleOverride(a)).find(Boolean);
    if (override) session.title = override;
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
