/**
 * SEO tracking in #proj-seo: announce each `seo-sweep` PR when it opens, then
 * tick that announcement with ✅ when the PR merges — so the channel is a single
 * at-a-glance log of proposed vs landed SEO work.
 *
 * Mirrors docs-sync-notify: the announcement is a normal bot message that links
 * the PR, and the merge check-off finds it again by that `/pull/<n>` link (no
 * stored `ts`). Both halves are best-effort and never throw into the webhook.
 */
import { sendSlackMessage, addReaction, fetchChannelHistory } from "../slack/slack-api";
import { SEO_SLACK_CHANNEL } from "./constants";

const MERGED_REACTION = "white_check_mark";
/** Recent messages to scan when locating a PR's announcement. */
const HISTORY_LIMIT = 200;

/** True when `text` links the given PR (matches the `/pull/<n>` URL, not a
 *  longer number that merely starts with it, e.g. #4433 vs #44330). */
function linksPr(text: string, prNumber: number): boolean {
  return new RegExp(`/pull/${prNumber}(?!\\d)`).test(text);
}

/**
 * Announce a newly-opened seo-sweep PR in #proj-seo so Johnny can track it.
 * Idempotent: if an announcement for this PR is already in the channel (e.g. the
 * `opened` and `labeled` webhooks both fired), it posts nothing.
 */
export async function announceSeoPr(
  prNumber: number,
  title: string,
  htmlUrl: string,
): Promise<void> {
  const url = htmlUrl || `https://github.com/tellahq/tella-fusion/pull/${prNumber}`;
  const history = await fetchChannelHistory(SEO_SLACK_CHANNEL, HISTORY_LIMIT);
  if (history.some((m) => m.isBot && linksPr(m.text, prNumber))) return;

  await sendSlackMessage(
    SEO_SLACK_CHANNEL,
    `:mag: *New SEO PR* — ${title}\n${url}\nI'll add a ✅ here once it's merged.`,
  );
  console.log(`[github] announced seo-sweep PR #${prNumber} in #proj-seo`);
}

/**
 * Add a ✅ to the #proj-seo announcement for a just-merged seo-sweep PR. Scans
 * recent channel history for the message that links this PR and reacts to it.
 */
export async function markSeoPrMerged(prNumber: number): Promise<void> {
  const history = await fetchChannelHistory(SEO_SLACK_CHANNEL, HISTORY_LIMIT);
  const message = history.find((m) => m.isBot && linksPr(m.text, prNumber));
  if (!message) {
    console.log(
      `[github] seo-sweep PR #${prNumber} merged, but no announcement found in #proj-seo to check off`,
    );
    return;
  }

  await addReaction(SEO_SLACK_CHANNEL, message.ts, MERGED_REACTION);
  console.log(`[github] checked off #proj-seo announcement for merged PR #${prNumber}`);
}
