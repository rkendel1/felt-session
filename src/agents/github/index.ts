/**
 * GitHub PR agent: automated review + auto-fix + simplify for tellahq/tella-fusion.
 *
 * Does NOT own a webhook route — the single GitHub webhook lives in the Slack agent
 * (`POST /github/webhook`), which forwards `pull_request` events to
 * `handleGithubPrEvent` (webhook.ts). This module owns lifecycle: seeding the
 * disabled review automation, recovering interrupted auto-fix loops on restart,
 * health, and a secret-gated manual trigger for testing.
 */
import type { AgentModule } from "../types";
import {
  listAutomations,
  createAutomation,
  saveAutomation,
} from "../../server/automations";
import { githubConfigured } from "./github-rest";
import {
  PR_EVENT_KEY,
  REVIEW_AUTOMATION_NAME,
  PR_MERGED_EVENT_KEY,
  DOCS_SYNC_AUTOMATION_NAME,
} from "./constants";
import { DEFAULT_REVIEW_PROMPT, DOCS_SYNC_PROMPT } from "./prompts";
import { setGithubSessionInvalidate, resolveReviewConfig } from "./webhook";
import { listPrStates, activeCodeLoops, clearPendingMention } from "./state";
import type { PrRef } from "./review";

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

/** Seed the review automation (disabled) if it doesn't exist yet. Keyed on eventKey. */
function ensureReviewAutomation(): void {
  const existing = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY);
  if (existing) return;
  const created = createAutomation({
    name: REVIEW_AUTOMATION_NAME,
    prompt: DEFAULT_REVIEW_PROMPT,
    schedule: "",
    mode: "ask",
    createdBy: "Michael (github agent)",
    eventKey: PR_EVENT_KEY,
    model: "claude-opus-4-8",
  });
  if ("error" in created) {
    console.error(`[github] Failed to seed review automation:`, created.error);
    return;
  }
  // Seed it OFF — start label-only; flip on in the Automations UI to review every non-draft PR.
  saveAutomation({ ...created, enabled: false });
  console.log(`[github] Seeded review automation "${REVIEW_AUTOMATION_NAME}" (disabled)`);
}

/**
 * Seed the docs-sync automation if it doesn't exist yet. Keyed on eventKey.
 * Code mode: each merged PR runs a headless session in a fresh worktree that
 * updates the Mintlify docs and opens a PR. Seeded ENABLED — this is the live
 * replacement for the old Mintlify-hosted docs-sync workflow. Toggle it in the
 * Automations UI.
 */
function ensureDocsSyncAutomation(): void {
  const existing = listAutomations().find((a) => a.eventKey === PR_MERGED_EVENT_KEY);
  if (existing) return;
  const created = createAutomation({
    name: DOCS_SYNC_AUTOMATION_NAME,
    prompt: DOCS_SYNC_PROMPT,
    schedule: "",
    mode: "code",
    createdBy: "Michael (github agent)",
    eventKey: PR_MERGED_EVENT_KEY,
    model: "claude-opus-4-8",
  });
  if ("error" in created) {
    console.error(`[github] Failed to seed docs-sync automation:`, created.error);
    return;
  }
  console.log(`[github] Seeded docs-sync automation "${DOCS_SYNC_AUTOMATION_NAME}" (enabled)`);
}

/** Re-enter auto-fix loops that a restart interrupted. */
async function recoverFixLoops(): Promise<void> {
  const interrupted = listPrStates().filter((s) => s.autoFix?.active);
  if (!interrupted.length) return;
  const { runAutoFix } = await import("./autofix");
  for (const s of interrupted) {
    console.log(`[github] Recovering interrupted auto-fix loop for PR #${s.prNumber}`);
    const ref: PrRef = { number: s.prNumber, headRef: s.headRef, headSha: "", title: `PR #${s.prNumber}` };
    void runAutoFix(ref, s.autoFix?.requestedBy || "", undefined, /*resuming*/ true, s.autoFix?.steer).catch((e) =>
      console.error(`[github] auto-fix recovery failed for PR #${s.prNumber}:`, e),
    );
  }
}

/** Re-run one-shot actions (review/simplify/adversarial) that a restart interrupted. */
async function recoverOneShots(): Promise<void> {
  const interrupted = listPrStates().filter((s) => s.activeRun);
  if (!interrupted.length) return;
  const { triggerPrAction } = await import("./trigger");
  for (const s of interrupted) {
    const run = s.activeRun!;
    console.log(`[github] Recovering interrupted ${run.kind} for PR #${s.prNumber}`);
    void triggerPrAction(run.kind, s.prNumber, run.requestedBy, run.steer).catch((e) =>
      console.error(`[github] ${run.kind} recovery failed for PR #${s.prNumber}:`, e),
    );
  }
}

/** Re-run conversational @mentions that a restart interrupted. */
async function recoverMentions(): Promise<void> {
  const interrupted = listPrStates().filter((s) => s.activeMention);
  if (!interrupted.length) return;
  const { runConversationalMention } = await import("./mention");
  for (const s of interrupted) {
    const m = s.activeMention!;
    console.log(`[github] Recovering interrupted mention for PR #${s.prNumber}`);
    void runConversationalMention(
      { prNumber: s.prNumber, author: m.author, body: m.body, kind: m.kind, replyToId: m.replyToId, inline: m.inline },
      /*recovering*/ true,
    ).catch((e) => console.error(`[github] mention recovery failed for PR #${s.prNumber}:`, e));
  }
}

/**
 * Replay @mentions that were received but dropped before their run could
 * self-persist — the classic case being a webhook that landed during shutdown
 * drain (acked 200, so GitHub won't redeliver). PRs already owned by a richer
 * recovery (activeMention mid-run, or an action's activeRun/autoFix) are handed
 * off to it and their stale receipt marker cleared, so nothing fires twice.
 */
async function recoverPendingMentions(): Promise<void> {
  const pending = listPrStates().filter((s) => s.pendingMention);
  if (!pending.length) return;
  const { dispatchMention } = await import("./mention");
  for (const s of pending) {
    if (s.activeMention || s.activeRun || s.autoFix?.active) {
      clearPendingMention(s.prNumber); // a more specific recovery owns it
      continue;
    }
    const p = s.pendingMention!;
    console.log(`[github] Recovering dropped mention for PR #${s.prNumber} (from @${p.author})`);
    void dispatchMention({
      prNumber: s.prNumber,
      kind: p.kind,
      body: p.body,
      author: p.author,
      replyToId: p.replyToId,
      inline: p.inline,
    })
      .catch((e) => console.error(`[github] dropped-mention recovery failed for PR #${s.prNumber}:`, e))
      .finally(() => clearPendingMention(s.prNumber));
  }
}

export class GithubAgent implements AgentModule {
  name = "github";
  private readonly onSessionInvalidate?: () => void;

  constructor(opts?: { onSessionInvalidate?: () => void }) {
    this.onSessionInvalidate = opts?.onSessionInvalidate;
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

    // Manual trigger for testing: POST /github-pr/<secret> { prNumber, headRef, headSha?, behavior, requestedBy? }
    routes.set("POST /github-pr/*", async (req, url) => {
      const m = url.pathname.match(/^\/github-pr\/([^/]+)$/);
      if (!m || !GITHUB_WEBHOOK_SECRET || m[1] !== GITHUB_WEBHOOK_SECRET) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      const prNumber = Number(body?.prNumber);
      const headRef = String(body?.headRef || "").trim();
      const behavior = String(body?.behavior || "review");
      if (!prNumber || !headRef) return Response.json({ error: "prNumber and headRef required" }, { status: 400 });
      const ref: PrRef = { number: prNumber, headRef, headSha: String(body?.headSha || ""), title: `PR #${prNumber}` };
      const requestedBy = String(body?.requestedBy || "");

      if (behavior === "autofix") {
        const { runAutoFix } = await import("./autofix");
        void runAutoFix(ref, requestedBy, this.onSessionInvalidate);
      } else if (behavior === "simplify") {
        const { runSimplify } = await import("./simplify");
        void runSimplify(ref, requestedBy, this.onSessionInvalidate);
      } else {
        const { runReview } = await import("./review");
        void runReview(ref, resolveReviewConfig().config, this.onSessionInvalidate);
      }
      return Response.json({ ok: true, behavior, prNumber });
    });

    return routes;
  }

  async startup(): Promise<void> {
    if (!githubConfigured()) {
      console.warn("[github] GITHUB_API_TOKEN unset — review/fix/simplify can't post; agent idle");
    }
    if (!GITHUB_WEBHOOK_SECRET) {
      console.warn("[github] GITHUB_WEBHOOK_SECRET unset — PR webhooks won't be verified/forwarded");
    }
    if (this.onSessionInvalidate) setGithubSessionInvalidate(this.onSessionInvalidate);
    ensureReviewAutomation();
    ensureDocsSyncAutomation();
    await recoverFixLoops();
    await recoverOneShots();
    await recoverMentions();
    await recoverPendingMentions();
    const { autoEnabled } = resolveReviewConfig();
    console.log(`[github] Agent started — review automation ${autoEnabled ? "ENABLED (all non-draft PRs)" : "disabled (label-only)"}`);
  }

  async shutdown(): Promise<void> {
    // Auto-fix loop state is persisted to disk after each iteration; nothing to flush.
  }

  health(): Record<string, unknown> {
    const { autoEnabled } = resolveReviewConfig();
    return {
      status: githubConfigured() ? "operational" : "missing GITHUB_API_TOKEN",
      reviewAutomationEnabled: autoEnabled,
      trackedPrs: listPrStates().length,
      activeCodeLoops: activeCodeLoops(),
    };
  }
}
