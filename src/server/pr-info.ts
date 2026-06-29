/**
 * PR details for a session branch via the gh CLI, Devin-style "PR" tab.
 * Cached per branch for 30s to keep the UI snappy without hammering GitHub.
 */
import { $ } from "bun";
import { audited } from "./audit";

export interface PrCheck {
  name: string;
  status: string; // COMPLETED, IN_PROGRESS, QUEUED…
  conclusion: string; // SUCCESS, FAILURE, NEUTRAL, ""…
  url?: string;
}

export interface PrDetails {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  body: string;
  checks: PrCheck[];
}

const REPO = "tellahq/tella-fusion";
const cache = new Map<string, { data: PrDetails | null; ts: number }>();
const TTL = 30_000;

export interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
}

const diffCache = new Map<string, { data: PrDiffData | null; ts: number }>();

export async function getPrDiff(branch: string): Promise<PrDiffData | null> {
  const hit = diffCache.get(branch);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  let data: PrDiffData | null = null;
  try {
    const metaRaw = await $`gh pr view ${branch} --repo ${REPO} --json number,headRefOid`
      .quiet()
      .text();
    const meta = JSON.parse(metaRaw);
    const patch = await $`gh pr diff ${meta.number} --repo ${REPO}`.quiet().text();
    data = { number: meta.number, headRefOid: meta.headRefOid, patch };
  } catch {
    data = null;
  }

  diffCache.set(branch, { data, ts: Date.now() });
  return data;
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
  input: PrCommentInput
): Promise<{ ok: true; url?: string } | { error: string }> {
  const diff = await getPrDiff(branch);
  if (!diff) return { error: "No PR found for this branch" };

  try {
    if (input.path && input.line) {
      const args = [
        "api", "-X", "POST", `repos/${REPO}/pulls/${diff.number}/comments`,
        "-f", `body=${input.body}`,
        "-f", `commit_id=${diff.headRefOid}`,
        "-f", `path=${input.path}`,
        "-F", `line=${input.line}`,
        "-f", `side=${input.side || "RIGHT"}`,
      ];
      if (input.startLine && input.startLine !== input.line) {
        args.push("-F", `start_line=${input.startLine}`);
        args.push("-f", `start_side=${input.startSide || input.side || "RIGHT"}`);
      }
      const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
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
      return { ok: true, url };
    }

    const proc = Bun.spawn(
      ["gh", "pr", "comment", String(diff.number), "--repo", REPO, "--body", input.body],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { error: (err || "gh pr comment failed").slice(0, 300) };
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
  input: PrReviewInput
): Promise<{ ok: true; url?: string } | { error: string }> {
  const diff = await getPrDiff(branch);
  if (!diff) return { error: "No PR found for this branch" };
  if (!input.comments.length && !input.body?.trim()) {
    return { error: "Nothing to submit" };
  }

  const payload = {
    commit_id: diff.headRefOid,
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
      args: { branch, number: diff.number, event: input.event, comments: input.comments.length },
    },
    async () => {
      const proc = Bun.spawn(
        ["gh", "api", "-X", "POST", `repos/${REPO}/pulls/${diff.number}/reviews`, "--input", "-"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
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
      return { ok: true, url } as const;
    }
  );
}

export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Merge a branch's PR via the gh CLI — human-triggered from the Reviews view
 * (Michael never merges on its own; this is a UI affordance for the operator).
 * Defaults to squash. Audited as `reviews/pr_merge` since it mutates the repo.
 */
export async function mergePr(
  branch: string,
  opts: { method?: MergeMethod; deleteBranch?: boolean } = {}
): Promise<{ ok: true; url?: string } | { error: string }> {
  const pr = await getPrDetails(branch);
  if (!pr) return { error: "No PR found for this branch" };
  if (pr.state !== "OPEN") return { error: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isDraft) return { error: `PR #${pr.number} is a draft — mark it ready first` };

  const method = opts.method || "squash";
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";

  return audited(
    {
      context: "reviews",
      action: "pr_merge",
      args: { branch, number: pr.number, method, deleteBranch: !!opts.deleteBranch },
    },
    async () => {
      const args = ["pr", "merge", String(pr.number), "--repo", REPO, flag];
      if (opts.deleteBranch) args.push("--delete-branch");
      const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
      const [, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh pr merge failed").slice(0, 300) } as const;
      // Drop cached PR/diff so the UI reflects the merge on the next poll.
      cache.delete(branch);
      diffCache.delete(branch);
      return { ok: true, url: pr.url } as const;
    }
  );
}

export async function getPrDetails(branch: string): Promise<PrDetails | null> {
  const hit = cache.get(branch);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  let data: PrDetails | null = null;
  try {
    const raw = await $`gh pr view ${branch} --repo ${REPO} --json number,title,url,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision,author,body,statusCheckRollup`
      .quiet()
      .text();
    const pr = JSON.parse(raw);
    data = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
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
      })),
    };
  } catch {
    data = null; // no PR for this branch (or gh failure) — both fine to cache briefly
  }

  cache.set(branch, { data, ts: Date.now() });
  return data;
}
