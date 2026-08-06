/**
 * PR details for a session branch via the gh CLI, Devin-style "PR" tab.
 * Cached per branch for 5 minutes (stale-while-revalidate) to keep the UI snappy
 * without hammering GitHub; snapshotted to disk so restarts keep last-good
 * data; and wired into the shared rate-limit gate (github-limit.ts) so a
 * throttled quota serves stale snapshots instead of errors.
 */
import { homeDir } from "./paths";
import { statePath } from "./paths";
import { configuredIntegration, configuredRepos, configuredServer, defaultRepo } from "./config";
import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { audited } from "./audit";
import { ghRateLimited, noteGhRateLimited, isGhRateLimitMsg } from "./github-limit";
import { serviceGithubCredential, type GithubCredential } from "./github-auth";
import { githubAppEnv } from "./github-app";
import { getPrStack, unmergedLayersBelow, type PrStack } from "./pr-stack";
import type { OsReviewSummary, UnifiedSession } from "./types";

export interface PrCheck {
  name: string;
  status: string; // COMPLETED, IN_PROGRESS, QUEUED…
  conclusion: string; // SUCCESS, FAILURE, NEUTRAL, ""…
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

export interface PrStaging {
  /** Vercel branch-alias preview, e.g. https://tella-git-<branch>.tella.dev */
  url: string;
  /** Deploy status from the butler table, verbatim: Building | Ready | Error… */
  status: string;
  /**
   * Whether this deploy opts into being embedded in the OS1 review iframe —
   * true once its response CSP names os.tella.dev in frame-ancestors (the
   * tella-fusion preview change). Probed out-of-band (see embeddableFor); a
   * deploy predating that change reads back false and the UI shows the launch
   * panel instead, so nothing regresses.
   */
  embeddable?: boolean;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * A person on the PR's reviewer list. `state` is the review outcome
 * (APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED) or PENDING for a
 * requested-but-not-yet-submitted review. `isTeam` marks a requested team
 * (login is the team slug) rather than an individual.
 */
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
  /** Current head commit, used by correctness-sensitive callers to reject stale data. */
  headRefOid?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  body: string;
  checks: PrCheck[];
  comments: PrComment[];
  commits: PrCommit[];
  /** Per-file line stats, sorted by churn (biggest first). */
  files: PrFile[];
  /** People/teams on the reviewer list, with their latest review state. */
  reviewers: PrReviewer[];
  /** MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe. */
  mergeable: string;
  /** CLEAN | BEHIND | BLOCKED | DIRTY | UNSTABLE | … — merge-box state. */
  mergeStateStatus: string;
  /** The PR's webapp preview environment (Vercel preview), when one exists. */
  staging: PrStaging | null;
  /** The GitHub stack this PR is a layer of, when it belongs to one. Read
   *  best-effort (see pr-stack.ts) — null covers both "not stacked" and "the
   *  stack read failed", which the UI treats identically. */
  stack?: PrStack | null;
  /** The latest automated agent review, enriched by the session PR route. */
  osReview?: OsReviewSummary;
  /** An automated review is currently running for this PR. */
  reviewActive?: boolean;
}

/**
 * Turn the bulk session snapshot into the minimum honest PR detail response.
 * This keeps PR surfaces coherent when the richer GitHub query is unavailable.
 */
export function cachedPrDetailsForSession(
  session: UnifiedSession,
  repoId: string,
  branch: string,
): PrDetails | null {
  const ref = (session.prs || []).find(
    (candidate) =>
      candidate.repo === repoId &&
      candidate.branch === branch &&
      candidate.number != null &&
      candidate.url &&
      candidate.state,
  );
  const primary =
    repoId === (session.repo || defaultRepo().id) && branch === session.branch;
  const number = ref?.number ?? (primary ? session.prNumber : undefined);
  const url = ref?.url ?? (primary ? session.prUrl : undefined);
  const state = ref?.state ?? (primary ? session.prState : undefined);
  // MERGED is irreversible. OPEN/CLOSED snapshots can be stale (a closed PR
  // may reopen), and synthesizing their missing checks could expose bad actions.
  if (number == null || !url || state !== "MERGED") return null;

  return {
    number,
    title: ref?.title || (primary ? session.prTitle : "") || `PR #${number}`,
    url,
    state,
    isDraft: ref?.isDraft ?? (primary ? !!session.prIsDraft : false),
    baseRefName: "",
    headRefName: branch,
    additions: ref?.additions ?? (primary ? session.prAdditions : 0) ?? 0,
    deletions: ref?.deletions ?? (primary ? session.prDeletions : 0) ?? 0,
    changedFiles: primary ? session.prChangedFiles ?? 0 : 0,
    reviewDecision:
      ref?.reviewDecision || (primary ? session.prReviewDecision : "") || "",
    author: primary ? session.prAuthor || "" : "",
    body: "",
    checks: [],
    comments: [],
    commits: [],
    files: [],
    reviewers: [],
    mergeable: primary ? session.prMergeable || "UNKNOWN" : "UNKNOWN",
    mergeStateStatus: "",
    staging: null,
  };
}

/** An irreversible bulk merge must not regress from a stale detail-cache row. */
export function reconcilePrDetails(
  details: PrDetails | null,
  cached: PrDetails | null,
): PrDetails | null {
  if (!details) return cached;
  if (
    cached &&
    details.number === cached.number &&
    details.state !== "MERGED" &&
    cached.state === "MERGED"
  ) {
    return { ...details, state: "MERGED", isDraft: false };
  }
  return details;
}

function parseStaging(comments: Array<{ body?: string }> | undefined): PrStaging | null {
  const github = configuredIntegration("github");
  const marker =
    typeof github.previewCommentMarker === "string"
      ? github.previewCommentMarker
      : "";
  const service =
    typeof github.previewTableService === "string"
      ? github.previewTableService
      : "";
  if (!marker || !service) return null;
  const escapedService = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = new RegExp(
    `^\\|\\s*${escapedService}\\s*\\|\\s*([^|]+?)\\s*\\|\\s*\\[[^\\]]*\\]\\((https?:\\/\\/[^)\\s]+)\\)`,
    "m",
  );
  for (const c of comments || []) {
    if (!c.body?.includes(marker)) continue;
    const m = c.body.match(row);
    if (m) return { status: m[1], url: m[2], embeddable: embeddableFor(m[2]) };
  }
  return null;
}

// Whether a preview environment opts into being embedded in the review iframe.
// Probed out-of-band — a plain GET of the deploy,
// reading the CSP header — and cached, so the PR fetch never blocks on it and a
// deploy that predates the fusion change simply reads back false (the UI then
// shows the launch panel, exactly as before). Best-effort: any failure → false.
const EMBED_TTL = 300_000;
const embedCache = new Map<string, { ok: boolean; ts: number }>();
const embedInflight = new Set<string>();

async function probeEmbeddable(url: string): Promise<void> {
  if (embedInflight.has(url)) return;
  embedInflight.add(url);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "os1-embed-probe" },
      signal: AbortSignal.timeout(5000),
    });
    const csp = res.headers.get("content-security-policy") || "";
    const uiHost = new URL(configuredServer().publicBaseUrl).hostname;
    const escaped = uiHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ok = new RegExp(`frame-ancestors[^;]*\\b${escaped}\\b`, "i").test(csp);
    embedCache.set(url, { ok, ts: Date.now() });
  } catch {
    embedCache.set(url, { ok: false, ts: Date.now() });
  } finally {
    embedInflight.delete(url);
  }
}

/** Sync read of the embed-probe cache; kicks a background refresh when stale. */
function embeddableFor(url: string): boolean {
  const hit = embedCache.get(url);
  if (!hit || Date.now() - hit.ts >= EMBED_TTL) void probeEmbeddable(url);
  return hit?.ok ?? false;
}

/** Changed files, biggest churn first, so the panel leads with the meat. */
function buildFiles(files: Array<{ path?: string; additions?: number; deletions?: number }> | undefined): PrFile[] {
  return (files || [])
    .filter((f) => f.path)
    .map((f) => ({
      path: f.path as string,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

/**
 * Merge the provider's `latestReviews` (people who submitted a review) with
 * `reviewRequests` (requested but not yet reviewed → PENDING) into one list.
 * A submitted review wins over a pending request for the same person. Requested
 * teams have no `login`, only a `name`/`slug`, and are flagged `isTeam`.
 */
function buildReviewers(
  latest: Array<{ author?: { login?: string }; state?: string }> | undefined,
  requests: Array<{ login?: string; slug?: string; name?: string }> | undefined,
): PrReviewer[] {
  const byLogin = new Map<string, PrReviewer>();
  for (const r of latest || []) {
    const login = r.author?.login;
    const state = r.state as PrReviewer["state"] | undefined;
    // DISMISSED/PENDING sneak in via the API; only surface real outcomes here.
    if (!login || !state) continue;
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "COMMENTED") continue;
    const prev = byLogin.get(login);
    // Keep the strongest signal if someone appears twice (approve > changes > comment).
    const rank = (s: string) => (s === "CHANGES_REQUESTED" ? 3 : s === "APPROVED" ? 2 : 1);
    if (!prev || rank(state) > rank(prev.state)) byLogin.set(login, { login, state });
  }
  for (const r of requests || []) {
    const login = r.login || r.slug || r.name;
    if (!login) continue;
    if (byLogin.has(login)) continue;
    byLogin.set(login, { login, state: "PENDING", isTeam: !r.login });
  }
  // Requesters/blockers first (they gate the merge), approvers next.
  const rank = (s: string) =>
    s === "CHANGES_REQUESTED" ? 0 : s === "PENDING" ? 1 : s === "COMMENTED" ? 2 : 3;
  return [...byLogin.values()].sort((a, b) => rank(a.state) - rank(b.state));
}

const DEFAULT_REPO = () => defaultRepo().ghRepo;
const cache = new Map<string, { data: PrDetails | null; ts: number }>();
// 5 min: the detail pane and staging/status pollers tolerate that staleness,
// and each open session tab runs several independent /pr pollers — a short
// TTL made nearly every tick spawn a real `gh pr view` into the shared
// GraphQL budget (2026-07-23). Action gates that must not act on stale data
// use getPrDetailsFresh, which bypasses this cache entirely.
const TTL = 5 * 60_000;

// The details cache is snapshotted to disk (debounced) and seeded on boot —
// without this, a restart during a GitHub outage or rate-limit window boots
// with an empty cache and the PR panel shows a dead error instead of the
// last-good snapshot (same failure mode the bulk cache fixed on 2026-07-22).
// Entries keep their original ts, so everything seeds as stale: served
// immediately while a background refresh runs. The diff cache is NOT
// persisted — patches are big and cheap to refetch.
const DETAILS_CACHE_FILE = statePath(".opensession-pr-details-cache.json");
/** Seed the details cache from disk. Also exported for demo instances, whose
 *  snapshot is written at the end of boot — see loadPrCacheSnapshot(). */
export function loadPrDetailsSnapshot(): void {
  try {
    const raw: Record<string, { data: PrDetails | null; ts: number }> = JSON.parse(
      readFileSync(DETAILS_CACHE_FILE, "utf8"),
    );
    for (const [k, v] of Object.entries(raw)) cache.set(k, v);
  } catch {}
}
loadPrDetailsSnapshot();

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const cutoff = Date.now() - 7 * 24 * 3600_000; // drop long-dead branches
      const obj: Record<string, { data: PrDetails | null; ts: number }> = {};
      for (const [k, v] of cache) if (v.ts > cutoff) obj[k] = v;
      writeFileSync(DETAILS_CACHE_FILE, JSON.stringify(obj));
    } catch {}
  }, 5_000);
}

// Caches are keyed by `<repo>\0<branch>` so the same branch name in different
// repos (multi-repo sessions share a branch name) never collides.
const cacheKey = (repo: string, branch: string) => `${repo}\u0000${branch}`;

export interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
}

const diffCache = new Map<string, { data: PrDiffData | null; ts: number }>();

/**
 * Pin a PR patch into the diff cache. For the demo dataset only: its PR does
 * not exist on GitHub, and unlike the details cache the diff cache is never
 * snapshotted to disk, so the Review page's "Files changed" tab would always
 * fail its live fetch. The entry is stamped far in the future so the TTL never
 * expires it into a doomed `gh` call.
 */
export function seedPrDiff(repo: string, branch: string, data: PrDiffData): void {
  diffCache.set(cacheKey(repo, branch), {
    data,
    ts: Number.MAX_SAFE_INTEGER,
  });
}
const diffInflight: Map<string, Promise<PrDiffData | null>> =
  ((globalThis as any).__prDiffInflight ??= new Map());

function spawnGh(args: string[], credential: GithubCredential, stdin?: "pipe") {
  return Bun.spawn(["gh", ...args], {
    ...(stdin ? { stdin } : {}),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
}

/** Exported for pr-webhook.ts: a GitHub webhook delivery for this branch
 *  drops the cached details/diff so the next fetch re-reads GitHub instead of
 *  waiting out the 5-min TTL. */
export function invalidatePrInfo(repo: string, branch: string): void {
  const key = cacheKey(repo, branch);
  cache.delete(key);
  diffCache.delete(key);
}

export interface MutationPrMeta {
  number: number;
  headRefOid: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  url: string;
}

/**
 * The cheap "does this branch have a PR, and which one" lookup. Callers that
 * only need the number/url/state (stack linking, merge gates) use this instead
 * of getPrDetails, which pulls checks, files, comments and the stack too.
 */
export async function prMetaForBranch(
  branch: string,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<MutationPrMeta | null> {
  return getMutationPrMeta(branch, repo, credential);
}

async function getMutationPrMeta(
  branch: string,
  repo: string,
  credential: GithubCredential,
): Promise<MutationPrMeta | null> {
  const proc = spawnGh(
    ["pr", "view", branch, "--repo", repo, "--json", "number,headRefOid,state,isDraft,url"],
    credential,
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    if (isNoPrError(err)) return null;
    throw new Error(prApiErrorMessage(err));
  }
  return JSON.parse(out) as MutationPrMeta;
}

export async function getPrDiff(
  branch: string,
  repo: string = DEFAULT_REPO()
): Promise<PrDiffData | null> {
  const key = cacheKey(repo, branch);
  const hit = diffCache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  const running = diffInflight.get(key);
  if (running) return running;
  // Known backoff window: stale answer if we have one, fast friendly failure
  // if we don't — never a doomed gh spawn.
  if (ghRateLimited()) {
    if (hit) return hit.data;
    throw new Error(GH_RATE_LIMIT_MESSAGE);
  }

  const refresh = (async () => {
    try {
      const metaRaw = await $`gh pr view ${branch} --repo ${repo} --json number,headRefOid,baseRefName`
        .quiet()
        .text();
      const meta = JSON.parse(metaRaw);
      let patch: string;
      try {
        patch = await $`gh pr diff ${meta.number} --repo ${repo}`.quiet().text();
      } catch (diffErr: any) {
        // GitHub's API refuses diffs for PRs touching >300 files (HTTP 406,
        // "diff exceeded the maximum number of files"). Reconstruct the same
        // merge-base patch from the configured local checkout instead of
        // leaving big PRs permanently un-diffable (review/autofix depend on
        // this).
        const dmsg = String(diffErr?.stderr || diffErr?.message || diffErr);
        if (!/maximum number of files/i.test(dmsg)) throw diffErr;
        console.warn(`[pr-info] PR #${meta.number} diff >300 files; using local merge-base diff`);
        try {
          patch = await localPrDiffPatch(repo, meta);
        } catch (localErr: any) {
          console.warn(`[pr-info] local diff fallback failed: ${String(localErr?.stderr || localErr?.message || localErr).slice(0, 300)}`);
          throw localErr;
        }
      }
      const data = { number: meta.number, headRefOid: meta.headRefOid, patch };
      diffCache.set(key, { data, ts: Date.now() });
      return data;
    } catch (e: any) {
      const msg = String(e?.stderr || e?.message || e).slice(0, 300);
      if (!isNoPrError(msg)) {
        if (isGhRateLimitMsg(msg)) noteGhRateLimited("pr-info");
        console.warn(`[pr-info] gh pr diff ${branch} (${repo}) failed: ${msg}`);
        if (hit) return hit.data; // stale beats an error
        throw new Error(prApiErrorMessage(msg));
      }
      diffCache.set(key, { data: null, ts: Date.now() });
      return null;
    }
  })().finally(() => diffInflight.delete(key));
  diffInflight.set(key, refresh);
  return refresh;
}

/** Merge-base patch computed from the repo's local checkout — the fallback
 *  when GitHub's API refuses the diff (>300 files). Fetches the base branch
 *  and the PR head ref so both sides exist locally, then diffs exactly what
 *  `gh pr diff` would have returned. */
async function localPrDiffPatch(
  ghRepo: string,
  meta: { number: number; headRefOid: string; baseRefName: string },
): Promise<string> {
  const local = Object.values(configuredRepos()).find(
    (r) => r.ghRepo?.toLowerCase() === ghRepo.toLowerCase(),
  )?.repo;
  if (!local) throw new Error(`no local checkout configured for ${ghRepo}`);
  const headRef = `pull/${meta.number}/head`;
  await $`git -C ${local} fetch -q origin ${meta.baseRefName} ${headRef}`.quiet();
  const base = `origin/${meta.baseRefName}`;
  return await $`git -C ${local} diff ${base}...${meta.headRefOid}`
    .quiet()
    .text();
}

export interface PrCommentInput {
  body: string;
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  startSide?: "RIGHT" | "LEFT";
}

/** Post a PR comment — inline review comment when path+line given, else a general comment. */
export async function postPrComment(
  branch: string,
  input: PrCommentInput,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string } | { error: string }> {
  try {
    if (input.path && input.line) {
      const meta = await getMutationPrMeta(branch, repo, credential);
      if (!meta) return { error: "No PR found for this branch" };
      const args = [
        "api", "-X", "POST", `repos/${repo}/pulls/${meta.number}/comments`,
        "-f", `body=${input.body}`,
        "-f", `commit_id=${meta.headRefOid}`,
        "-f", `path=${input.path}`,
        "-F", `line=${input.line}`,
        "-f", `side=${input.side || "RIGHT"}`,
      ];
      if (input.startLine && input.startLine !== input.line) {
        args.push("-F", `start_line=${input.startLine}`);
        args.push("-f", `start_side=${input.startSide || input.side || "RIGHT"}`);
      }
      const proc = spawnGh(args, credential);
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh api failed").slice(0, 300) };
      const url = (() => {
        try {
          return JSON.parse(out).html_url as string;
        } catch {
          return undefined;
        }
      })();
      invalidatePrInfo(repo, branch);
      return { ok: true, url };
    }

    const proc = spawnGh(
      ["pr", "comment", branch, "--repo", repo, "--body", input.body],
      credential,
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { error: (err || "gh pr comment failed").slice(0, 300) };
    invalidatePrInfo(repo, branch);
    return { ok: true, url: out.trim() || undefined };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

export interface PrReviewComment {
  path: string;
  /** Line in the file the comment anchors to (end line of a range). */
  line: number;
  side?: "RIGHT" | "LEFT";
  startLine?: number;
  startSide?: "RIGHT" | "LEFT";
  body: string;
}

export type PrReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PrReviewInput {
  event: PrReviewEvent;
  body?: string;
  comments: PrReviewComment[];
}

/**
 * Submit a single GitHub review bundling all pending inline comments, GitHub's
 * native review flow (POST .../pulls/{n}/reviews). The whole batch posts at once
 * with one event (comment / approve / request changes) instead of each inline
 * comment landing as a loose standalone comment. Audited since approving or
 * requesting changes affects the PR's merge state.
 */
export async function submitPrReview(
  branch: string,
  input: PrReviewInput,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string } | { error: string }> {
  if (!input.comments.length && !input.body?.trim()) {
    return { error: "Nothing to submit" };
  }

  const meta = await getMutationPrMeta(branch, repo, credential).catch((e: any) => ({
    error: e?.message || String(e),
  }));
  if (!meta) return { error: "No PR found for this branch" };
  if ("error" in meta) return meta;

  const payload = {
    commit_id: meta.headRefOid,
    event: input.event,
    ...(input.body?.trim() ? { body: input.body.trim() } : {}),
    comments: input.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side || "RIGHT",
      ...(c.startLine && c.startLine !== c.line
        ? { start_line: c.startLine, start_side: c.startSide || c.side || "RIGHT" }
        : {}),
      body: c.body,
    })),
  };

  return audited(
    {
      context: "reviews",
      action: "pr_review",
      args: {
        branch,
        number: meta.number,
        event: input.event,
        comments: input.comments.length,
        credential: credential.principal,
      },
    },
    async () => {
      const proc = spawnGh(
        ["api", "-X", "POST", `repos/${repo}/pulls/${meta.number}/reviews`, "--input", "-"],
        credential,
        "pipe",
      );
      proc.stdin.write(JSON.stringify(payload));
      await proc.stdin.end();
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh api failed").slice(0, 300) } as const;
      const url = (() => {
        try {
          return JSON.parse(out).html_url as string;
        } catch {
          return undefined;
        }
      })();
      invalidatePrInfo(repo, branch);
      return { ok: true, url } as const;
    }
  );
}

export type MergeMethod = "squash" | "merge" | "rebase";

/** Close an open PR without merging it. Human-triggered from the Reviews UI. */
export async function closePr(
  branch: string,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string; number: number } | { error: string }> {
  const pr = await getMutationPrMeta(branch, repo, credential);
  if (!pr) return { error: "No PR found for this branch" };
  if (pr.state !== "OPEN") return { error: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };

  return audited(
    {
      context: "reviews",
      action: "pr_close",
      args: {
        branch,
        number: pr.number,
        credential: credential.principal,
      },
    },
    async () => {
      const proc = spawnGh(["pr", "close", String(pr.number), "--repo", repo], credential);
      const [, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh pr close failed").slice(0, 300) } as const;
      cache.delete(cacheKey(repo, branch));
      diffCache.delete(cacheKey(repo, branch));
      return { ok: true, url: pr.url, number: pr.number } as const;
    },
  );
}

/**
 * Merge a branch's PR via the gh CLI — human-triggered from the Reviews view
 * (the agent never merges on its own; this is a UI affordance for the operator).
 * Defaults to squash. Audited as `reviews/pr_merge` since it mutates the repo.
 */
export async function mergePr(
  branch: string,
  opts: { method?: MergeMethod; deleteBranch?: boolean; force?: boolean } = {},
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string } | { error: string }> {
  const pr = await getMutationPrMeta(branch, repo, credential);
  if (!pr) return { error: "No PR found for this branch" };
  if (pr.state !== "OPEN") return { error: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isDraft) return { error: `PR #${pr.number} is a draft — mark it ready first` };

  // Stack order: a layer merges into the one below it, so it can't land while
  // a lower layer is still open. GitHub enforces this itself — verified live
  // against stack #5404 on 2026-07-30, where mergePullRequest answered "must
  // be merged sequentially using the stack merge API" — so this gate exists
  // for the message, not the protection: it names the blocking PR instead of
  // surfacing a raw GraphQL error. `force` skips our check only; GitHub still
  // refuses, so there is no way to merge a stack out of order from here.
  // Taking several layers at once needs GitHub's stack merge (`gh stack
  // merge`), which we don't wire up yet.
  if (!opts.force) {
    const stack = await getPrStack(repo, pr.number, credential);
    const below = stack ? unmergedLayersBelow(stack) : [];
    if (below.length)
      return {
        error:
          `PR #${pr.number} is layer ${stack!.position} of stack #${stack!.number} and ` +
          `${below.length === 1 ? "the layer" : "the layers"} below ${below.length === 1 ? "is" : "are"} still open (` +
          `${below.map((l) => `#${l.number}`).join(", ")}). Merge from the bottom up, ` +
          "or merge the stack on GitHub.",
      };
  }

  const method = opts.method || "squash";
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";

  return audited(
    {
      context: "reviews",
      action: "pr_merge",
      args: {
        branch,
        number: pr.number,
        method,
        deleteBranch: !!opts.deleteBranch,
        credential: credential.principal,
      },
    },
    async () => {
      const args = ["pr", "merge", String(pr.number), "--repo", repo, flag];
      if (opts.deleteBranch) args.push("--delete-branch");
      const proc = spawnGh(args, credential);
      const [, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh pr merge failed").slice(0, 300) } as const;
      // Drop cached PR/diff so the UI reflects the merge on the next poll.
      cache.delete(cacheKey(repo, branch));
      diffCache.delete(cacheKey(repo, branch));
      return { ok: true, url: pr.url } as const;
    }
  );
}

/**
 * Add and/or remove GitHub reviewers on the PR for `branch` (best-effort — the
 * caller ignores the result on failure). Mirrors the Open Session review-request
 * chip onto GitHub's own Reviewers list: setting a reviewer in the info panel
 * also `--add-reviewer`s them, re-assigning removes the old and adds the new,
 * and clearing removes them. `gh pr edit` takes the branch as the PR selector,
 * so no separate lookup is needed; a branch with no open PR just errors.
 */
export async function editPrReviewers(
  branch: string,
  opts: { add?: string | null; remove?: string | null },
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true } | { error: string }> {
  const args = ["pr", "edit", branch, "--repo", repo];
  if (opts.add) args.push("--add-reviewer", opts.add);
  if (opts.remove && opts.remove !== opts.add)
    args.push("--remove-reviewer", opts.remove);
  if (args.length === 4) return { ok: true }; // nothing to do
  try {
    const proc = spawnGh(args, credential);
    const [, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { error: (err || "gh pr edit failed").slice(0, 300) };
    cache.delete(cacheKey(repo, branch)); // reviewRequests changed
    return { ok: true };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

/**
 * Rewrite the PR description through a mutator over the current body — used by
 * the walkthrough mirror to splice its managed section in place. Reads the
 * live body first (never a cached one: humans edit descriptions) and writes
 * via REST (PATCH pulls/{n} with an --input file so markdown/quotes/newlines
 * survive shell-free). NOT `gh pr edit`: its GraphQL preamble resolves org
 * teams and needs read:org, which neither the bot PAT nor the device-flow
 * OAuth tokens carry — it fails unconditionally on tellahq repos (verified
 * live on tellahq/backstage#78, 2026-07-26; same class as the label-edit
 * gotcha).
 */
export async function updatePrBody(
  branch: string,
  mutate: (body: string) => string,
  repo: string = DEFAULT_REPO()
): Promise<{ ok: true; number: number; url: string } | { error: string }> {
  try {
    const view = Bun.spawn(
      ["gh", "pr", "view", branch, "--repo", repo, "--json", "body,number,url"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [out, viewErr, viewCode] = await Promise.all([
      new Response(view.stdout).text(),
      new Response(view.stderr).text(),
      view.exited,
    ]);
    if (viewCode !== 0)
      return { error: (viewErr || "gh pr view failed").slice(0, 300) };
    const pr = JSON.parse(out) as { body: string; number: number; url: string };
    const next = mutate(pr.body || "");
    if (next === (pr.body || "")) return { ok: true, number: pr.number, url: pr.url };
    const tmp = `/tmp/opensession-pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    await Bun.write(tmp, JSON.stringify({ body: next }));
    try {
      const edit = Bun.spawn(
        ["gh", "api", "-X", "PATCH", `repos/${repo}/pulls/${pr.number}`, "--input", tmp],
        { stdout: "pipe", stderr: "pipe" }
      );
      const [, editErr, editCode] = await Promise.all([
        new Response(edit.stdout).text(),
        new Response(edit.stderr).text(),
        edit.exited,
      ]);
      if (editCode !== 0)
        return { error: (editErr || "gh api pulls PATCH failed").slice(0, 300) };
    } finally {
      await Bun.file(tmp).unlink().catch(() => {});
    }
    cache.delete(cacheKey(repo, branch)); // body changed
    return { ok: true, number: pr.number, url: pr.url };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

// One in-flight `gh pr view` per branch — concurrent panels share the promise
// instead of stacking subprocesses.
const inflight = new Map<string, Promise<PrDetails | null>>();

/**
 * Stale-while-revalidate: a fresh cache entry answers directly; an EXPIRED one
 * still answers immediately (the status header shouldn't block ~1s on a GitHub
 * round-trip every 30s) while the refresh runs in the background and lands for
 * the next poll. Only a branch with no cache at all waits on gh. During a
 * rate-limit window, ANY cached answer (even a stale "no PR") is served
 * without spawning gh; when a refresh fails outright, a stale snapshot still
 * beats surfacing an error to the panel.
 */
export async function getPrDetails(
  branch: string,
  repo: string = DEFAULT_REPO()
): Promise<PrDetails | null> {
  const key = cacheKey(repo, branch);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  // Known backoff window: serve any cached answer, and with nothing cached
  // fail fast with the friendly message rather than spawning a doomed gh call.
  if (ghRateLimited()) {
    if (hit) return hit.data;
    throw new Error(GH_RATE_LIMIT_MESSAGE);
  }

  let refresh = inflight.get(key);
  if (!refresh) {
    refresh = fetchPrDetails(branch, repo)
      .then((data) => {
        cache.set(key, { data, ts: Date.now() });
        schedulePersist();
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, refresh);
  }
  if (hit?.data) {
    void refresh.catch(() => {});
    return hit.data;
  }
  return refresh.catch((e) => {
    if (hit) return hit.data;
    throw e;
  });
}

/** Bypass the UI's stale-while-revalidate cache for action completion gates. */
export async function getPrDetailsFresh(
  branch: string,
  repo: string = DEFAULT_REPO()
): Promise<PrDetails | null> {
  // A completion gate must not act on stale data, so during a rate-limit
  // window it fails fast with the friendly message instead of burning a call.
  if (ghRateLimited()) throw new Error(GH_RATE_LIMIT_MESSAGE);
  const data = await fetchPrDetails(branch, repo);
  cache.set(cacheKey(repo, branch), { data, ts: Date.now() });
  schedulePersist();
  return data;
}

/** True for "this branch/number has no PR" — a real answer, not a failure. */
export function isNoPrError(msg: string): boolean {
  return /no pull requests found|Could not resolve to a PullRequest/i.test(msg);
}

export const GH_RATE_LIMIT_MESSAGE =
  "GitHub's API rate limit has been reached. Try again after it resets.";

export function prApiErrorMessage(msg: string): string {
  if (/rate limit/i.test(msg)) return GH_RATE_LIMIT_MESSAGE;
  if (/authentication|bad credentials|requires authentication/i.test(msg))
    return "GitHub authentication failed. Check the GitHub connection.";
  if (/resource not accessible/i.test(msg))
    return "The GitHub token is missing a permission for this API. Check the PAT's fine-grained permissions.";
  return "GitHub's pull request API is unavailable right now.";
}

function isPermanentPrApiError(msg: string): boolean {
  // "Resource not accessible" = the token lacks a permission (e.g. Checks:read
  // for statusCheckRollup) — retrying only burns GraphQL quota.
  return /rate limit|authentication|bad credentials|requires authentication|resource not accessible/i.test(msg);
}

// Fine-grained PATs can't be granted the Checks permission (GitHub App-only),
// so statusCheckRollup fails with "Resource not accessible by personal access
// token" under the tellahq-scoped bot PAT. Preferred path: run the PR query
// on a GitHub App installation token (github-app.ts), which has checks:read.
// Fallback when no app key is configured: once the error is seen, skip the
// field process-wide (checks render empty) instead of failing every PR fetch —
// the flag resets on restart.
let skipStatusCheckRollup = false;

async function fetchPrDetails(
  branch: string,
  repo: string
): Promise<PrDetails | null> {
  let data: PrDetails | null = null;
  try {
    // Under load GitHub sporadically aborts the GraphQL response mid-stream
    // ("stream error: … CANCEL; received from peer") — that's transient, and
    // treating it as "no PR" broke PR actions (PR #4910). Retry transient
    // failures; a genuine "no pull requests found" stays a fast null.
    let raw = "";
    let appEnv = await githubAppEnv();
    for (let attempt = 1; ; attempt++) {
      const baseFields =
        "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,author,body,mergeable,mergeStateStatus,comments,commits,files,latestReviews,reviewRequests";
      const includeRollup = !!appEnv || !skipStatusCheckRollup;
      const fields = includeRollup ? `${baseFields},statusCheckRollup` : baseFields;
      try {
        const cmd = $`gh pr view ${branch} --repo ${repo} --json ${fields}`;
        raw = await (appEnv ? cmd.env({ ...process.env, ...appEnv }) : cmd).quiet().text();
        break;
      } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e).slice(0, 300);
        // A minted-but-dead app token (revoked key) must not sink the fetch —
        // drop to the bot PAT once and re-run the attempt.
        if (appEnv && /authentication|bad credentials|resource not accessible/i.test(msg)) {
          console.warn(`[pr-info] app-token gh call failed (${msg.slice(0, 80)}) — falling back to bot credential`);
          appEnv = null;
          continue;
        }
        // Keyed on THIS call's field list, not the global flag — a concurrent
        // fetch may trip the flag while our rollup-carrying request is in
        // flight, and that must not turn our retry into a hard failure.
        if (includeRollup && /resource not accessible/i.test(msg) && /statusCheckRollup/.test(msg)) {
          if (!skipStatusCheckRollup) {
            skipStatusCheckRollup = true;
            console.warn(`[pr-info] token can't read statusCheckRollup — dropping checks from PR queries until restart`);
          }
          continue;
        }
        if (isNoPrError(msg) || isPermanentPrApiError(msg) || attempt >= 3) throw e;
        console.warn(`[pr-info] gh pr view ${branch} (${repo}) attempt ${attempt} failed, retrying: ${msg}`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    const pr = JSON.parse(raw);
    data = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      reviewDecision: pr.reviewDecision || "",
      author: pr.author?.login || "",
      body: pr.body || "",
      checks: (pr.statusCheckRollup || []).map((c: any) => ({
        name: c.name || c.context || "check",
        status: c.status || (c.state ? "COMPLETED" : ""),
        conclusion: c.conclusion || c.state || "",
        url: c.detailsUrl || c.targetUrl || undefined,
        startedAt: c.startedAt || undefined,
        completedAt: c.completedAt || undefined,
        workflowName: c.workflowName || undefined,
      })),
      comments: (pr.comments || [])
        .filter((c: any) => String(c.body || "").trim())
        .map((c: any) => ({
          author: c.author?.login || c.author?.name || "",
          body: String(c.body || ""),
          url: c.url || undefined,
          createdAt: c.createdAt || undefined,
        })),
      commits: (pr.commits || []).map((commit: any) => ({
        oid: commit.oid || "",
        messageHeadline: commit.messageHeadline || "Commit",
        messageBody: commit.messageBody || undefined,
        authoredDate: commit.authoredDate || commit.committedDate || undefined,
        author:
          commit.authors?.[0]?.login ||
          commit.authors?.[0]?.name ||
          commit.author?.login ||
          commit.author?.name ||
          "Unknown",
      })),
      files: buildFiles(pr.files),
      reviewers: buildReviewers(pr.latestReviews, pr.reviewRequests),
      mergeable: pr.mergeable || "UNKNOWN",
      mergeStateStatus: pr.mergeStateStatus || "",
      staging: parseStaging(pr.comments),
    };
    // Stacks live in GraphQL only (no `gh pr view --json stack`), so this is a
    // second call — paid once per cache miss, and never fatal: getPrStack
    // swallows its own failures and answers null.
    data.stack = await getPrStack(repo, pr.number);
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).slice(0, 300);
    if (!isNoPrError(msg)) {
      if (isGhRateLimitMsg(msg)) noteGhRateLimited("pr-info");
      console.warn(`[pr-info] gh pr view ${branch} (${repo}) failed: ${msg}`);
      throw new Error(prApiErrorMessage(msg));
    }
    data = null;
  }

  return data;
}
