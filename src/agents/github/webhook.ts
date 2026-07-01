/**
 * Dispatch target for GitHub PR webhooks. The single GitHub webhook is owned by
 * the Slack agent (`POST /github/webhook`), which forwards `pull_request` events
 * here. This routes them to the review / auto-fix / simplify behaviors.
 *
 * Defensive: never throws into the Slack handler; all behaviors are fired
 * fire-and-forget (GitHub's 10s webhook timeout).
 */
import { listAutomations, fireAutomationsForEvent } from "../../server/automations";
import { GITHUB_REPO, BOT_LOGIN } from "./github-rest";
import {
  PR_EVENT_KEY,
  PR_MERGED_EVENT_KEY,
  REVIEW_AUTOMATION_NAME,
  LABEL_REVIEW,
  LABEL_AUTOFIX,
  LABEL_SIMPLIFY,
  LABEL_ADVERSARIAL,
} from "./constants";
import { runReview, type PrRef, type ReviewConfig } from "./review";
import { DEFAULT_REVIEW_PROMPT } from "./prompts";
import { SEO_LABEL } from "../loops/seo";

let onSessionInvalidate: (() => void) | undefined;
export function setGithubSessionInvalidate(cb: () => void): void {
  onSessionInvalidate = cb;
}

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

interface PrPayload {
  number: number;
  draft?: boolean;
  state?: string;
  title?: string;
  head?: { ref?: string; sha?: string };
  user?: { login?: string };
  labels?: Array<{ name: string }>;
  merged?: boolean;
  merged_at?: string;
}

function prRef(pr: PrPayload): PrRef | null {
  if (!pr || typeof pr.number !== "number" || !pr.head?.ref) return null;
  return {
    number: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha || "",
    title: pr.title || `PR #${pr.number}`,
  };
}

/** Resolve review config from the seeded automation (its enabled flag + prompt/model). */
export function resolveReviewConfig(): { autoEnabled: boolean; config: ReviewConfig } {
  const automation = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY);
  return {
    autoEnabled: !!automation?.enabled,
    config: {
      prompt: automation?.prompt || DEFAULT_REVIEW_PROMPT,
      model: automation?.model,
    },
  };
}

export async function handleGithubPrEvent(event: string, payload: any): Promise<void> {
  try {
    if (payload?.repository?.full_name && payload.repository.full_name !== GITHUB_REPO) return;

    // Our bot account shows up as `sender` both when we comment/review AND when we
    // push (auto-fix/simplify/mention commits land as a `synchronize`). We must not
    // react to those self-triggers — but we DO want to review PRs the bot *opens*
    // (e.g. automated security fixes). So apply the guard per-event below, not blanket.
    const senderIsBot = !!payload?.sender?.login && payload.sender.login === BOT_LOGIN;

    // @mention replies on PR comments (inline + conversation). Never react to our own
    // comments/reviews (mention.ts also re-checks the author + our hidden markers).
    if (event === "issue_comment" || event === "pull_request_review_comment") {
      if (senderIsBot) return;
      const { handleMention } = await import("./mention");
      void handleMention(event === "issue_comment" ? "issue" : "review", payload).catch((e) =>
        console.error("[github] handleMention failed:", e),
      );
      return;
    }

    if (event !== "pull_request") return;

    const pr = payload.pull_request as PrPayload;
    const ref = prRef(pr);
    if (!ref) return;
    const action: string = payload.action || "";

    // ── Label actions ── (ignore labels we applied to ourselves)
    if (action === "labeled") {
      if (senderIsBot) return;
      const label: string = payload.label?.name || "";
      const requestedBy: string = payload.sender?.login || "";
      if (label === LABEL_REVIEW) {
        void fireReview(ref, true);
      } else if (label === LABEL_AUTOFIX) {
        void fireAutoFix(ref, requestedBy);
      } else if (label === LABEL_SIMPLIFY) {
        void fireSimplify(ref, requestedBy);
      } else if (label === LABEL_ADVERSARIAL) {
        void fireAdversarial(ref, requestedBy);
      }
      return;
    }

    // ── Merge → queue seo-sweep PRs + fire docs-sync ──
    if (action === "closed" && pr.merged) {
      if ((pr.labels || []).some((l) => l.name === SEO_LABEL)) {
        const { recordMergedSeoPr } = await import("../loops/seo");
        recordMergedSeoPr(pr.number, pr.merged_at || new Date().toISOString());
      }
      // Docs-sync: review the merged PR for user-facing changes and update the
      // Mintlify docs. Skip PRs authored by our bot account — that includes the
      // docs-sync automation's own PRs, so this can never loop on itself.
      if (pr.user?.login !== BOT_LOGIN) {
        const payload = JSON.stringify({
          prNumber: pr.number,
          title: pr.title || `PR #${pr.number}`,
          headRef: pr.head?.ref || "",
          author: pr.user?.login || "",
        });
        const fired = fireAutomationsForEvent(PR_MERGED_EVENT_KEY, payload);
        if (fired) console.log(`[github] PR #${pr.number} merged → fired ${fired} docs-sync automation(s)`);
      }
      return;
    }

    // ── Open / update actions → review when opted in and non-draft ──
    if (REVIEW_ACTIONS.has(action)) {
      if (pr.draft) return; // skip drafts until ready_for_review
      // A `synchronize` from the bot is our own push (auto-fix/simplify/mention) —
      // skip it so we don't review our own work mid-loop. But reviewing a PR the bot
      // *opened* (opened/reopened/ready_for_review) is fine: read-only, no push, no loop.
      if (senderIsBot && action === "synchronize") return;
      const labeled = (pr.labels || []).some((l) => l.name === LABEL_REVIEW);
      const { autoEnabled } = resolveReviewConfig();
      if (labeled || autoEnabled) void fireReview(ref, false);
    }
  } catch (e) {
    console.error("[github] handleGithubPrEvent error:", e);
  }
}

async function fireReview(ref: PrRef, _byLabel: boolean): Promise<void> {
  const { config } = resolveReviewConfig();
  await runReview(ref, config, onSessionInvalidate).catch((e) =>
    console.error(`[github] runReview failed for PR #${ref.number}:`, e),
  );
}

async function fireAutoFix(ref: PrRef, requestedBy: string): Promise<void> {
  const { runAutoFix } = await import("./autofix");
  await runAutoFix(ref, requestedBy, onSessionInvalidate).catch((e) =>
    console.error(`[github] runAutoFix failed for PR #${ref.number}:`, e),
  );
}

async function fireSimplify(ref: PrRef, requestedBy: string): Promise<void> {
  const { runSimplify } = await import("./simplify");
  await runSimplify(ref, requestedBy, onSessionInvalidate).catch((e) =>
    console.error(`[github] runSimplify failed for PR #${ref.number}:`, e),
  );
}

async function fireAdversarial(ref: PrRef, requestedBy: string): Promise<void> {
  const { runAdversarial } = await import("./adversarial");
  await runAdversarial(ref, requestedBy, onSessionInvalidate).catch((e) =>
    console.error(`[github] runAdversarial failed for PR #${ref.number}:`, e),
  );
}
