/**
 * @mention replies. When someone mentions Michael in a PR comment — inline
 * (pull_request_review_comment) or in the conversation (issue_comment) — route it
 * to the PR's mention session and post Michael's reply in-thread.
 *
 * Loop-safe: we skip any comment carrying one of Michael's hidden markers (our own
 * posts), and only act when the body actually mentions a Michael handle — so
 * Michael's replies (which don't mention itself) never re-trigger.
 */
import { getPrDetails, type PrDetails } from "../../server/pr-info";
import { listAutomations } from "../../server/automations";
import { createWorktreeForPrBranch, createWorktreeForFollowup } from "../../server/worktree";
import {
  claimLock,
  releaseLock,
  getOrInitPrState,
  writePrState,
  setPendingMention,
  clearPendingMention,
} from "./state";
import { runGithubAgent, authorForLogin, finalSummary, sessionUrl } from "./run";
import { buildMentionPrompt, buildFollowupMentionPrompt, REVIEW_DEFAULT_MODEL } from "./prompts";
import { triggerPrAction } from "./trigger";
import {
  postIssueComment,
  editIssueComment,
  postOrEditComment,
  replyToReviewComment,
  BOT_LOGIN,
  REPLY_MARKER,
  MICHAEL_MARKERS,
} from "./github-rest";
import { PR_EVENT_KEY } from "./constants";
import { classifyPrActionIntent } from "../slack/mention-intent";

// Handles that mean "Michael". @michael isn't a real GitHub user (renders as
// plain text) but people type it; tella-butler is the bot's actual handle.
const MENTION_HANDLES = (process.env.GITHUB_MENTION_HANDLES || "michael,tella-butler")
  .split(",")
  .map((h) => h.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean);
const MENTION_RE = new RegExp(`@(${MENTION_HANDLES.join("|")})\\b`, "i");

function mentionsMichael(body: string): boolean {
  if (!body) return false;
  if (MICHAEL_MARKERS.some((m) => body.includes(m))) return false; // our own content
  return MENTION_RE.test(body);
}

// Bounded in-memory dedup against webhook redelivery.
const handled = new Set<string>();
function alreadyHandled(key: string): boolean {
  if (handled.has(key)) return true;
  handled.add(key);
  // Evict oldest-first (Sets iterate in insertion order) — a wholesale clear()
  // would forget the most recent keys and re-handle a prompt redelivery.
  while (handled.size > 500) {
    const oldest = handled.values().next().value;
    if (oldest === undefined) break;
    handled.delete(oldest);
  }
  return false;
}

export type MentionKind = "issue" | "review";

export async function handleMention(kind: MentionKind, payload: any): Promise<void> {
  if (payload?.action !== "created") return; // ignore edits/deletes
  const comment = payload.comment;
  const body: string = comment?.body || "";
  if (!mentionsMichael(body)) return;

  const authorLogin: string = comment?.user?.login || "";
  if (authorLogin === BOT_LOGIN) return; // the bot's own pushes' account

  let prNumber: number | undefined;
  let inline: { path: string; line?: number; diffHunk?: string } | undefined;
  let replyToId: number | undefined;

  if (kind === "review") {
    prNumber = payload.pull_request?.number;
    inline = {
      path: comment?.path,
      line: comment?.line ?? comment?.original_line,
      diffHunk: comment?.diff_hunk,
    };
    // Reply at the thread root so GitHub threads it correctly.
    replyToId = comment?.in_reply_to_id || comment?.id;
  } else {
    if (!payload.issue?.pull_request) return; // a plain issue, not a PR
    prNumber = payload.issue?.number;
  }
  if (!prNumber || !comment?.id) return;
  if (alreadyHandled(`${kind}:${comment.id}`)) return;

  // Persist the mention on receipt, BEFORE the slow classify + worktree window. If
  // the process dies in that window — e.g. this webhook landed mid-shutdown-drain,
  // which we still ack 200 so GitHub won't redeliver — startup recovery replays it.
  // The run self-persists its richer activeMention/activeRun only seconds later.
  setPendingMention(prNumber, {
    kind,
    commentId: comment.id,
    body,
    author: authorLogin,
    replyToId,
    inline,
    receivedAt: new Date().toISOString(),
  });
  try {
    await dispatchMention({ prNumber, kind, body, author: authorLogin, replyToId, inline });
  } finally {
    clearPendingMention(prNumber);
  }
}

/**
 * Classify the mention and route it: a whole-PR action (review/simplify/etc.) or a
 * conversational reply. Shared by the live webhook path (handleMention) and startup
 * recovery of a mention that was dropped before its run could self-persist.
 */
export async function dispatchMention(args: {
  prNumber: number;
  kind: MentionKind;
  body: string;
  author: string;
  replyToId?: number;
  inline?: { path: string; line?: number; diffHunk?: string };
}): Promise<void> {
  const { prNumber, kind, body, author, replyToId, inline } = args;

  // A whole-PR action request ("@michael adversarial review plz") → run the dedicated
  // behavior. Classified before any lock, since triggerPrAction claims the "code" lock.
  const action = await classifyPrActionIntent(body);
  if (action !== "none") {
    // Pass the full comment as steer: the classifier reduced it to a verb, but the
    // body may carry specific guidance ("…the Update.call change wasn't needed.
    // /simplify") that the run should honor — not just a generic pass.
    const res = await triggerPrAction(action, prNumber, author, body);
    const ack = `${REPLY_MARKER}\nOn it — ${res.message}`;
    if (kind === "review" && replyToId) await replyToReviewComment(prNumber, replyToId, ack).catch(() => {});
    else await postIssueComment(prNumber, ack).catch(() => {});
    return;
  }

  // Otherwise it's a conversational request — answer (and act) in a worktree session.
  await runConversationalMention({ prNumber, author, body, kind, replyToId, inline });
}

export interface ConversationalMentionArgs {
  prNumber: number;
  author: string;
  body: string;
  kind: MentionKind;
  replyToId?: number;
  inline?: { path: string; line?: number; diffHunk?: string };
}

/** Run (or, on restart recovery, re-run) a conversational @mention in a PR-branch worktree. */
export async function runConversationalMention(
  args: ConversationalMentionArgs,
  recovering = false,
): Promise<void> {
  const { prNumber } = args;
  if (!claimLock("code", prNumber)) {
    console.log(`[github] a code action is already running for PR #${prNumber}, skipping mention`);
    return;
  }
  let headRef = "";
  try {
    const details = await getPrDetails(String(prNumber));
    if (!details) return;
    // Merged/closed PR: you can't push to it, but a mention like "fix this in a
    // follow-up PR" (Kent's case) should still spin up a session — off a fresh
    // branch that opens its own PR — not be silently dropped.
    if (details.state !== "OPEN") {
      await runFollowupMention(args, details);
      return;
    }
    headRef = details.headRefName;
    const model = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY)?.model || REVIEW_DEFAULT_MODEL;
    const link = `[📺 open session](${sessionUrl(prNumber, "mention")})`;

    const st = getOrInitPrState(prNumber, headRef);
    // Reuse the progress comment only when recovering an interrupted run.
    const reuseId = recovering ? st.activeMention?.progressCommentId : undefined;
    const progressId = await postOrEditComment(
      prNumber,
      reuseId,
      `${REPLY_MARKER}\n🔄 On it — working on @${args.author}'s request… · ${link}`,
    );
    st.activeMention = {
      author: args.author,
      body: args.body,
      kind: args.kind,
      replyToId: args.replyToId,
      inline: args.inline,
      progressCommentId: progressId ?? undefined,
      startedAt: new Date().toISOString(),
    };
    // This run now owns recovery via activeMention; drop the on-receipt marker in
    // the same write so recovery never replays it twice.
    st.pendingMention = undefined;
    writePrState(st);

    // Code mode in the PR-branch worktree so Michael can make + push changes if asked.
    const worktreeDir = await createWorktreeForPrBranch(headRef);
    console.log(`[github] Mention reply on PR #${prNumber} (${args.kind}) from @${args.author}`);
    const result = await runGithubAgent({
      prNumber,
      kind: "mention",
      prompt: buildMentionPrompt({
        prNumber,
        prTitle: details.title,
        headRef,
        author: args.author,
        commentBody: args.body,
        inline: args.inline,
      }),
      cwd: worktreeDir,
      mode: "code",
      model,
      branch: headRef,
      title: `Mention · PR #${prNumber} ${details.title}`.slice(0, 100),
      resume: true, // keep a conversation across mentions on the same PR
      author: authorForLogin(args.author), // attribute any commits to the person who asked
    });

    const reply = finalSummary(result.text) || "(no reply produced)";
    const out = `${REPLY_MARKER}\n${reply}\n\n<sub>${link}</sub>`;
    if (args.kind === "review" && args.replyToId) {
      // Answer in the inline thread; the progress comment becomes a pointer to it.
      const ok = await replyToReviewComment(prNumber, args.replyToId, out);
      if (!ok) console.warn(`[github] failed to post mention thread reply for PR #${prNumber}`);
      if (progressId) await editIssueComment(progressId, `${REPLY_MARKER}\n✓ Replied in the review thread above. · ${link}`);
    } else {
      // Conversation reply: turn the progress comment into the answer.
      if (progressId) {
        if (!(await editIssueComment(progressId, out))) await postIssueComment(prNumber, out);
      } else {
        await postIssueComment(prNumber, out);
      }
    }
  } catch (e) {
    console.error(`[github] mention reply error for PR #${prNumber}:`, e);
  } finally {
    // Clear recovery state on completion; a killed process leaves it set so the
    // github agent re-runs the mention on startup.
    const fin = getOrInitPrState(prNumber, headRef || `pr-${prNumber}`);
    fin.activeMention = undefined;
    writePrState(fin);
    releaseLock("code", prNumber);
  }
}

/**
 * Handle a mention on a merged/closed PR: the head branch can't take new commits,
 * so branch fresh off the PR's base and let the run open its own follow-up PR.
 * Called from within `runConversationalMention`, which already holds the code lock.
 */
async function runFollowupMention(
  args: ConversationalMentionArgs,
  details: PrDetails,
): Promise<void> {
  const { prNumber } = args;
  const baseRef = details.baseRefName || "main";
  const stateLabel = details.state === "MERGED" ? "merged" : "closed";
  // Stable per-thread branch suffix (replyToId is the thread root) so a webhook
  // redelivery replays onto the same branch instead of forking a second one.
  const suffix = args.replyToId ? String(args.replyToId) : String(prNumber);
  const branch = `followup-pr-${prNumber}-${suffix}`.slice(0, 80);
  const link = `[📺 open session](${sessionUrl(prNumber, "followup")})`;

  const progressId = await postOrEditComment(
    prNumber,
    undefined,
    `${REPLY_MARKER}\n🔄 On it — PR #${prNumber} is ${stateLabel}, so I'm starting a fresh follow-up branch off \`${baseRef}\` for @${args.author}'s request… · ${link}`,
  );

  const model = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY)?.model || REVIEW_DEFAULT_MODEL;
  const worktreeDir = await createWorktreeForFollowup(branch, baseRef);
  console.log(
    `[github] Follow-up mention on ${stateLabel} PR #${prNumber} from @${args.author} → branch ${branch}`,
  );

  const result = await runGithubAgent({
    prNumber,
    kind: "followup",
    prompt: buildFollowupMentionPrompt({
      prNumber,
      prTitle: details.title,
      state: stateLabel,
      baseRef,
      branch,
      author: args.author,
      commentBody: args.body,
      inline: args.inline,
    }),
    cwd: worktreeDir,
    mode: "code",
    model,
    branch,
    title: `Follow-up · PR #${prNumber} ${details.title}`.slice(0, 100),
    resume: false, // fresh branch → fresh session, don't resume the merged PR's thread
    author: authorForLogin(args.author), // attribute commits to the person who asked
  });

  const reply = finalSummary(result.text) || "(no reply produced)";
  const out = `${REPLY_MARKER}\n${reply}\n\n<sub>${link}</sub>`;
  if (args.kind === "review" && args.replyToId) {
    const ok = await replyToReviewComment(prNumber, args.replyToId, out);
    if (!ok) console.warn(`[github] failed to post follow-up thread reply for PR #${prNumber}`);
    if (progressId)
      await editIssueComment(progressId, `${REPLY_MARKER}\n✓ Replied in the review thread above. · ${link}`);
  } else if (progressId) {
    if (!(await editIssueComment(progressId, out))) await postIssueComment(prNumber, out);
  } else {
    await postIssueComment(prNumber, out);
  }
}
