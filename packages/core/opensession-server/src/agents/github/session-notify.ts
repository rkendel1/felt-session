/**
 * Merge/deploy/preview events for PR-linked Open Session sessions. When a PR whose
 * head branch belongs to a session (primary branch or an attached repo) is
 * merged, a `[GitHub]` message is delivered into that session's transcript through the
 * SessionControl registry — the same steer/queue/start path a human message
 * takes — so the agent sees it and can react. The merge commit is then tracked in
 * managed FeltDB (survives restarts), and when the
 * Deploy workflow (.github/workflows/deploy.yml) completes for that commit the
 * session gets a second message with the outcome. (Pre-merge staging previews
 * are NOT announced here — the session header's Preview environment button already surfaces
 * the preview URL + Ready state, so a session notification would just be redundant.)
 */
import { stateDir } from "../../server/paths";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "../../server/managed-feltdb";
import { tryGetSessionControl, type SessionControl, type SessionSummary } from "../../server/session-control";
import { audit } from "../../server/audit";
import { isSharedCheckoutDir, REPOS, worktreeHeadBranch } from "../../server/worktree";
import { defaultRepo } from "../../server/config";

const PENDING_PATH = `${stateDir("github")}/pending-deploys.json`;
const PENDING_COLLECTION = "opensession_github_pending_deploys";
const PENDING_MIGRATION = "github-pending-deploys-json-to-managed-feltdb-v1";
const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";
/** A merge whose deploy never reported back is dropped after this long. */
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;
/** A branch-linked event should normally target one session. Refuse an
 * implausible broadcast before it can start a fleet of agent turns. */
export const MAX_SESSION_NOTIFICATION_FANOUT = 25;

interface PendingDeploy {
  id: string;
  prNumber: number;
  title: string;
  headRef: string;
  sessionIds: string[];
  recordedAt: string;
}

/** merge_commit_sha → the merge we're waiting on a deploy for. */
type LegacyPendingDeploy = Omit<PendingDeploy, "id">;
const pendingDeploys = new Map<string, PendingDeploy>();
let pendingDb: StateFirstDB | undefined;

export async function initializeManagedGithubPendingDeploys(
  db: StateFirstDB = pendingDb ?? managedFeltDb(),
): Promise<void> {
  pendingDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(PENDING_MIGRATION)) {
    let legacy: Record<string, LegacyPendingDeploy> = {};
    try {
      if (existsSync(PENDING_PATH)) legacy = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
    } catch {}
    for (const [sha, value] of Object.entries(legacy)) {
      const record = { ...value, id: sha };
      await db.transaction((tx) => {
        tx.collection<PendingDeploy>(PENDING_COLLECTION).set(sha, record);
      }, { transactionId: `opensession:github-pending-deploy:migrate:${sha}` });
    }
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(PENDING_MIGRATION, { id: PENDING_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${PENDING_MIGRATION}` });
    if (existsSync(PENDING_PATH)) unlinkSync(PENDING_PATH);
  }
  const cutoff = Date.now() - PENDING_TTL_MS;
  pendingDeploys.clear();
  for (const record of await db.collection<PendingDeploy>(PENDING_COLLECTION).all()) {
    if (Date.parse(record.recordedAt) >= cutoff) pendingDeploys.set(record.id, record);
  }
}

export async function recordPendingDeploy(sha: string, value: LegacyPendingDeploy): Promise<void> {
  const db = pendingDb ?? managedFeltDb();
  const record: PendingDeploy = { ...value, id: sha };
  await db.transaction((tx) => {
    tx.collection<PendingDeploy>(PENDING_COLLECTION).set(sha, record);
  }, { transactionId: `opensession:github-pending-deploy:set:${sha}` });
  pendingDeploys.set(sha, record);
}

export async function takePendingDeploy(sha: string): Promise<PendingDeploy | undefined> {
  const entry = pendingDeploys.get(sha);
  if (!entry) return undefined;
  const db = pendingDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<PendingDeploy>(PENDING_COLLECTION).delete(sha);
  }, { transactionId: `opensession:github-pending-deploy:take:${sha}` });
  pendingDeploys.delete(sha);
  return entry;
}

/** Registry project id for a GitHub owner/name, or null if unconfigured. */
export function workspaceIdForRepo(fullName: string): string | null {
  for (const repo of Object.values(REPOS)) {
    if (repo.ghRepo === fullName) return repo.id;
  }
  return null;
}

/** Live (non-archived) sessions working on `branch` of `workspaceId`, primary or attached.
 *  Also used by handoff.ts to find the session that owns a PR's branch. */
export function matchSessions(control: SessionControl, workspaceId: string, branch: string): SessionSummary[] {
  return control.listSessions().filter((s) => {
    if (s.state === "archived") return false;
    if ((s.repo || defaultRepo().id) === workspaceId) {
      if (s.branch === branch) return true;
      // The agent may have switched branches inside its worktree (automations
      // renaming their auto-generated branch before opening the PR) while the
      // session record keeps the original name — match the actual HEAD too.
      // A shared checkout's HEAD belongs to the whole instance, not to this
      // session. Treating it as session identity caused PR #5593's branch to
      // match 645 unrelated sessions that all pointed at the same checkout.
      if (!isSharedCheckoutDir(s.worktreeDir) && worktreeHeadBranch(s.worktreeDir) === branch)
        return true;
    }
    return (s.attachedRepos || []).some((r) => r.repo === workspaceId && r.branch === branch);
  });
}

/** Deduplicate ordinary multi-session matches and fail closed on an
 * implausible broadcast. Exported as a pure seam for the fan-out regression
 * test; the caller owns logging/auditing the refusal. */
export function boundedSessionNotificationIds(sessionIds: string[]): string[] | null {
  const unique = [...new Set(sessionIds)];
  return unique.length <= MAX_SESSION_NOTIFICATION_FANOUT ? unique : null;
}

function guardedSessionNotificationIds(
  sessionIds: string[],
  event: "pr_merged" | "deploy_completed",
  detail: Record<string, unknown>,
): string[] | null {
  const bounded = boundedSessionNotificationIds(sessionIds);
  if (bounded) return bounded;
  console.error(
    `[github] Refusing ${event} session notification fan-out to ${new Set(sessionIds).size} sessions`,
  );
  audit({
    msg: "github_session_notification_fuse",
    event,
    matched_sessions: new Set(sessionIds).size,
    max_sessions: MAX_SESSION_NOTIFICATION_FANOUT,
    ...detail,
  });
  return null;
}

async function deliver(
  control: SessionControl,
  sessionIds: string[],
  message: string,
  deliveryKey: string,
): Promise<void> {
  for (const id of sessionIds) {
    try {
      // Default busy behavior: fold into the running turn as a steer. Steering
      // is a non-interrupting history append the turn picks up at its next
      // stopping point (steerPiRun) — exactly right for an FYI; it only
      // falls back to the queue when nothing is steerable (external run).
      const res = await control.deliverToSession(id, message, "GitHub", {
        deliveryId: `${deliveryKey}:${id}`,
      });
      console.log(`[github] session notify → ${id}: ${res.status}`);
    } catch (e) {
      console.error(`[github] session notify → ${id} failed:`, e);
    }
  }
}

/** `pull_request` webhook payload with action=closed & merged=true. */
export async function notifyMergedPrSessions(payload: any): Promise<void> {
  const pr = payload?.pull_request;
  const headRef: string = pr?.head?.ref || "";
  const workspaceId = workspaceIdForRepo(payload?.repository?.full_name || "");
  if (!pr || !headRef || !workspaceId) return;
  const control = tryGetSessionControl();
  if (!control) return;

  const sessions = matchSessions(control, workspaceId, headRef);
  if (!sessions.length) return;

  const prNumber: number = pr.number;
  const title: string = pr.title || `PR #${prNumber}`;
  const mergedBy: string = pr.merged_by?.login || payload?.sender?.login || "someone";
  const base: string = pr.base?.ref || "main";
  const repo = REPOS[workspaceId];
  const trackDeploy =
    repo?.deploymentTracking === true &&
    base === repo.defaultBranch &&
    !!pr.merge_commit_sha;

  // One line. The session already knows which PR it owns, and its panel shows
  // the title, so the number and who merged it is the whole news.
  const message =
    `PR #${prNumber} merged` +
    (repo && base === repo.defaultBranch ? "" : ` into ${base}`) +
    ` by ${mergedBy}.` +
    (trackDeploy ? " Deploying." : "") +
    " No action needed.";

  const sessionIds = guardedSessionNotificationIds(
    sessions.map((s) => s.id),
    "pr_merged",
    { pr_number: prNumber, workspace_id: workspaceId, head_ref: headRef },
  );
  if (!sessionIds) return;

  console.log(`[github] PR #${prNumber} merged → notifying ${sessionIds.length} session(s) on ${workspaceId}:${headRef}`);
  await deliver(
    control,
    sessionIds,
    message,
    `github-merge:${payload?.repository?.full_name || workspaceId}:${prNumber}:${pr.merge_commit_sha || headRef}`,
  );

  if (trackDeploy) {
    await recordPendingDeploy(pr.merge_commit_sha, {
      prNumber,
      title,
      headRef,
      sessionIds,
      recordedAt: new Date().toISOString(),
    });
  }
}

/** `workflow_run` webhook payload; acts only on Deploy completions we're waiting on. */
export async function handleDeployWorkflowRun(payload: any): Promise<void> {
  if (payload?.action !== "completed") return;
  const run = payload?.workflow_run;
  if (!run || (run.path !== DEPLOY_WORKFLOW_PATH && run.name !== "Deploy")) return;

  const entry = await takePendingDeploy(run.head_sha);
  if (!entry) return;

  const control = tryGetSessionControl();
  if (!control) return;

  const success = run.conclusion === "success";
  const message = success
    ? `PR #${entry.prNumber} deployed. No action needed.`
    : `Deploy ${run.conclusion || "failed"} for PR #${entry.prNumber}: ${run.html_url}`;

  const sessionIds = guardedSessionNotificationIds(entry.sessionIds, "deploy_completed", {
    pr_number: entry.prNumber,
    head_sha: run.head_sha,
    conclusion: run.conclusion,
  });
  if (!sessionIds) return;

  console.log(`[github] Deploy ${run.conclusion} for ${run.head_sha} → notifying ${sessionIds.length} session(s)`);
  await deliver(
    control,
    sessionIds,
    message,
    `github-deploy:${run.id || run.head_sha}:${run.conclusion || "unknown"}`,
  );
}
