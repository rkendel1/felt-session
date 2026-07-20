/**
 * Dispatch target for GitHub PR webhooks. The single GitHub webhook is owned by
 * the Slack agent (`POST /github/webhook`), which forwards `pull_request` events
 * here. This routes them to the review / auto-fix / simplify behaviors.
 *
 * Defensive: never throws into the Slack handler; all behaviors are fired
 * fire-and-forget (GitHub's 10s webhook timeout).
 */
import { listAutomations, fireAutomationsForEvent } from "../../server/automations";
import { BOT_LOGIN } from "./github-rest";
import { defaultRepo } from "../../server/config";
import {
  PR_EVENT_KEY,
  PR_MERGED_EVENT_KEY,
  DOCS_SYNC_BRANCH_PREFIX,
  REVIEW_AUTOMATION_NAME,
  repoForFullName,
  prKey,
  LABEL_REVIEW,
  LABEL_AUTOFIX,
  LABEL_SIMPLIFY,
  LABEL_ADVERSARIAL,
  labelMatches,
} from "./constants";
import { runReview, type PrRef, type ReviewConfig } from "./review";
import { clearHandoff, isHandoffActive, maybeHandoffFindings } from "./handoff";
import { isLockHeld } from "./state";
import { DEFAULT_REVIEW_PROMPT } from "./prompts";
import { SEO_LABEL } from "../loops/seo";

let onSessionInvalidate: (() => void) | undefined;
export function setGithubSessionInvalidate(cb: () => void): void {
  onSessionInvalidate = cb;
}

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

interface PrPayload {
  number: number;
  html_url?: string;
  draft?: boolean;
  state?: string;
  title?: string;
  head?: { ref?: string; sha?: string };
  user?: { login?: string };
  labels?: Array<{ name: string }>;
  merged?: boolean;
  merged_at?: string;
}

function prRef(pr: PrPayload, ghRepo?: string): PrRef | null {
  if (!pr || typeof pr.number !== "number" || !pr.head?.ref) return null;
  return {
    number: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha || "",
    title: pr.title || `PR #${pr.number}`,
    ...(ghRepo ? { ghRepo } : {}),
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
    // Multi-repo: any repo in the config registry participates (the GitHub-side
    // webhook config is the outer gate). Unconfigured repos are dropped.
    const eventRepo = payload?.repository?.full_name
      ? repoForFullName(payload.repository.full_name)
      : null;
    if (payload?.repository?.full_name && !eventRepo) return;
    const ghRepo: string | undefined = eventRepo?.ghRepo;
    const isDefaultRepo = !ghRepo || ghRepo.toLowerCase() === defaultRepo().ghRepo.toLowerCase();

    // Our bot account shows up as `sender` both when we comment/review AND when we
    // push (auto-fix/simplify/mention commits land as a `synchronize`). We must not
    // react to those self-triggers — but we DO want to review PRs the bot *opens*
    // (e.g. automated security fixes). So apply the guard per-event below, not blanket.
    const senderIsBot = !!payload?.sender?.login && payload.sender.login === BOT_LOGIN;

    // @mention replies on PR comments (inline + conversation). Never react to our own
    // comments/reviews (mention.ts also re-checks the author + our hidden markers).
    if (event === "issue_comment" || event === "pull_request_review_comment") {
      // Butler's Vercel preview-table edits (from our bot account) carry no
      // mention and need no reaction — the session header's Staging button
      // already surfaces the preview URL + Ready state, so we don't inject a
      // redundant chat notification. They fall through to the self-trigger guard.
      if (senderIsBot) return;
      const { handleMention } = await import("./mention");
      void handleMention(event === "issue_comment" ? "issue" : "review", payload).catch((e) =>
        console.error("[github] handleMention failed:", e),
      );
      return;
    }

    // Deploy workflow completions → notify sessions waiting on a merged PR's deploy.
    if (event === "workflow_run") {
      const { handleDeployWorkflowRun } = await import("./session-notify");
      void handleDeployWorkflowRun(payload).catch((e) =>
        console.error("[github] handleDeployWorkflowRun failed:", e),
      );
      return;
    }

    if (event !== "pull_request") return;

    const pr = payload.pull_request as PrPayload;
    const ref = prRef(pr, ghRepo);
    if (!ref) return;
    const action: string = payload.action || "";

    // ── Label actions ── (ignore labels we applied to ourselves)
    if (action === "labeled") {
      if (senderIsBot) return;
      const label: string = payload.label?.name || "";
      const requestedBy: string = payload.sender?.login || "";
      if (labelMatches(label, LABEL_REVIEW)) {
        void fireReview(ref, true);
      } else if (labelMatches(label, LABEL_AUTOFIX)) {
        void fireAutoFix(ref, requestedBy);
      } else if (labelMatches(label, LABEL_SIMPLIFY)) {
        void fireSimplify(ref, requestedBy);
      } else if (labelMatches(label, LABEL_ADVERSARIAL)) {
        void fireAdversarial(ref, requestedBy);
      } else if (isDefaultRepo && label === SEO_LABEL) {
        // A human tagged an existing PR as seo-sweep — track it in #proj-seo too.
        const { announceSeoPr } = await import("./seo-notify");
        void announceSeoPr(pr.number, pr.title || `PR #${pr.number}`, pr.html_url || "").catch((e) =>
          console.error(`[github] announceSeoPr failed for #${pr.number}:`, e),
        );
      }
      return;
    }

    // Closed (merged or not): a pending debounced review would fire against a
    // dead PR — cancel it, and drop any handoff round tracking.
    if (action === "closed") {
      cancelPendingReview(prKey(pr.number, ghRepo));
      clearHandoff(pr.number, ghRepo);
    }

    // ── Merge → notify linked sessions + queue seo-sweep PRs + fire docs-sync ──
    if (action === "closed" && pr.merged) {
      if (!isDefaultRepo) return; // docs-sync/SEO/session-notify are default-repo flows
      import("./session-notify")
        .then((m) => m.notifyMergedPrSessions(payload))
        .catch((e) => console.error("[github] notifyMergedPrSessions failed:", e));
      if ((pr.labels || []).some((l) => l.name === SEO_LABEL)) {
        const { recordMergedSeoPr } = await import("../loops/seo");
        recordMergedSeoPr(pr.number, pr.merged_at || new Date().toISOString());
        // Tick the #proj-seo announcement done so the channel shows landed vs open.
        const { markSeoPrMerged } = await import("./seo-notify");
        void markSeoPrMerged(pr.number).catch((e) =>
          console.error(`[github] markSeoPrMerged failed for #${pr.number}:`, e),
        );
      }
      // Docs-sync: review the merged PR for user-facing changes and update the
      // Mintlify docs. Skip only the docs-sync automation's OWN PRs (they land on
      // `auto-docs-sync-*` branches) so it can never loop on itself. Do NOT skip by
      // author: tella-butler authors most real feature PRs (co-recording, camera
      // backgrounds, onboarding, …), and those are exactly the merges that need docs.
      const headRef = pr.head?.ref || "";
      if (headRef.startsWith(DOCS_SYNC_BRANCH_PREFIX)) {
        // A docs-sync PR itself was merged — don't re-fire docs-sync (loop), but
        // tick its Slack announcement done, like Mintlify used to.
        const { markDocsSyncPrMerged } = await import("./docs-sync-notify");
        void markDocsSyncPrMerged(pr.number).catch((e) =>
          console.error(`[github] markDocsSyncPrMerged failed for #${pr.number}:`, e),
        );
      } else {
        const payload = JSON.stringify({
          prNumber: pr.number,
          title: pr.title || `PR #${pr.number}`,
          headRef,
          author: pr.user?.login || "",
        });
        const fired = fireAutomationsForEvent(PR_MERGED_EVENT_KEY, payload);
        if (fired) console.log(`[github] PR #${pr.number} merged → fired ${fired} docs-sync automation(s)`);
      }
      return;
    }

    // ── seo-sweep PR opened → announce in #proj-seo so it can be tracked ──
    // The sweep opens as the bot with the `seo-sweep` label already applied, so
    // this fires for our own PRs (a human labelling an existing PR is handled in
    // the `labeled` block above). announceSeoPr is idempotent, so the two paths
    // can't double-post. Falls through so a normal review still runs below.
    if (
      isDefaultRepo &&
      (action === "opened" || action === "reopened" || action === "ready_for_review") &&
      (pr.labels || []).some((l) => l.name === SEO_LABEL)
    ) {
      const { announceSeoPr } = await import("./seo-notify");
      void announceSeoPr(pr.number, pr.title || `PR #${pr.number}`, pr.html_url || "").catch((e) =>
        console.error(`[github] announceSeoPr failed for #${pr.number}:`, e),
      );
    }

    // ── Open / update actions → review when opted in and non-draft ──
    if (REVIEW_ACTIONS.has(action)) {
      if (pr.draft) return; // skip drafts until ready_for_review
      // A `synchronize` from the bot is our own push (auto-fix/simplify/mention) —
      // skip it so we don't review our own work mid-loop. But reviewing a PR the bot
      // *opened* (opened/reopened/ready_for_review) is fine: read-only, no push, no loop.
      // Carve-out: while a handoff fix round is active, a bot-credentialed push IS
      // the owning session's fix (sessions without per-user GitHub auth push as the
      // bot) — it must be re-reviewed or the handoff loop never closes.
      if (senderIsBot && action === "synchronize" && !isHandoffActive(pr.number, ghRepo)) return;
      const labeled = (pr.labels || []).some((l) => labelMatches(l.name, LABEL_REVIEW));
      const { autoEnabled } = resolveReviewConfig();
      if (labeled || autoEnabled) {
        // Pushes debounce (hot PRs got one review per push — #4913: 20 pushes
        // ≈ $131/day of review spend on 2026-07-17); first reviews of a PR
        // stay immediate.
        if (action === "synchronize") scheduleDebouncedReview(ref);
        else void fireReview(ref, false);
      }
    }
  } catch (e) {
    console.error("[github] handleGithubPrEvent error:", e);
  }
}

async function fireReview(ref: PrRef, _byLabel: boolean): Promise<void> {
  const { config } = resolveReviewConfig();
  const result = await runReview(ref, config, onSessionInvalidate).catch((e) => {
    console.error(`[github] runReview failed for PR #${ref.number}:`, e);
    return null;
  });
  // Unsatisfied review → hand the findings to the session that owns the branch
  // (its push re-enters this cycle). Satisfied/skipped reviews no-op inside.
  await maybeHandoffFindings(ref, result);
}

// ── Push → review debounce ───────────────────────────────────────────────────
// Each `synchronize` (re)arms a quiet-period timer per PR; the fire reviews
// whatever HEAD is by then (runReview refetches by number; the review worktree
// pins to PR HEAD at run time), so a burst of pushes costs ONE review. A
// continuous pusher is still reviewed within the max-wait cap. If a review is
// already running at fire time, the debounce re-arms instead of dropping the
// push (claimLock coalescing would silently skip the new SHA). In-memory: a
// restart mid-window loses the pending fire — the next push or the victim
// sweep recovers it. Parked on globalThis so hot reloads don't double-arm.
const REVIEW_DEBOUNCE_MS = parseInt(process.env.OPENSESSION_REVIEW_DEBOUNCE_MS || "240000");
const REVIEW_DEBOUNCE_MAX_WAIT_MS = parseInt(
  process.env.OPENSESSION_REVIEW_DEBOUNCE_MAX_MS || "900000",
);
type PendingReview = { timer: ReturnType<typeof setTimeout>; firstPushAt: number };
const pendingReviewDebounce: Map<string, PendingReview> = ((globalThis as any)
  .__githubReviewDebounce ??= new Map());

function cancelPendingReview(key: string): void {
  const pending = pendingReviewDebounce.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingReviewDebounce.delete(key);
}

function scheduleDebouncedReview(ref: PrRef): void {
  const key = prKey(ref.number, ref.ghRepo);
  const existing = pendingReviewDebounce.get(key);
  if (existing) clearTimeout(existing.timer);
  const firstPushAt = existing?.firstPushAt ?? Date.now();
  const capLeft = Math.max(0, firstPushAt + REVIEW_DEBOUNCE_MAX_WAIT_MS - Date.now());
  const delay = existing ? Math.min(REVIEW_DEBOUNCE_MS, capLeft) : REVIEW_DEBOUNCE_MS;
  const timer = setTimeout(() => {
    if (isLockHeld("review", ref.number, ref.ghRepo)) {
      pendingReviewDebounce.delete(key);
      scheduleDebouncedReview(ref);
      return;
    }
    pendingReviewDebounce.delete(key);
    console.log(`[github] debounced review firing for PR #${ref.number}`);
    void fireReview(ref, false);
  }, delay);
  pendingReviewDebounce.set(key, { timer, firstPushAt });
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
