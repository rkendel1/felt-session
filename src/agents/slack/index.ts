/**
 * Slack Agent Module — handles Slack DMs, @mentions, GitHub PR reviews,
 * worktree channel management, and Block Kit interactions.
 *
 * Implements the AgentModule interface for the opensession webhook server.
 */

import { defaultRepo } from "../../server/config";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { timingSafeEqual } from "crypto";
import type { AgentModule } from "../types";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import {
  verifySlackSignature,
  verifyGitHubSignature,
} from "../../server/shared/signature";
import { handleMessageEvent, handleMentionEvent } from "./handlers";
import { handleLinkShared } from "./unfurl";
import {
  handlePullRequestReview,
  inviteRelevantUsersToChannel,
} from "./github-reviews";
import {
  worktreeChannels,
  branchToChannel,
  branchToChannelName,
  loadWorktreeChannels,
  saveWorktreeChannels,
  createSlackChannel,
  archiveSlackChannel,
  setChannelTopic,
  inviteBotToChannel,
  getWorktreeDirForChannel,
} from "./worktree-channels";
import { loadQueueFromDisk, sessionQueues } from "./queue";
import {
  enqueueMessage,
  getOrCreateQueue,
} from "./queue";
import { cancelSession } from "./cancel";
import { cancelAgentRun } from "../../server/agent-runner";
import { worktreePathFor } from "../../server/worktree";
import { personaName } from "../../server/config";
import {
  slackApiCall,
  sendSlackMessage,
  updateSlackBlocks,
  openSlackModal,
  openHumanAskModal,
  resolveSlackUser,
  prettifyMentions,
} from "./slack-api";
import {
  isChannelWatched,
  fireAutomationsForSlackChannel,
} from "../../server/automations";
import {
  resolveByOption as resolveHumanAsk,
  isAwaiting as isHumanAskAwaiting,
  getAsk as getHumanAsk,
} from "../../server/human-asks";
import {
  SESSION_DIR,
  GITHUB_REPO,
  activeSessions,
  isEventProcessed,
  markEventProcessed,
  loadProcessedEvents,
  pendingAnswers,
  slackTeamId,
  slackBotUserId,
  githubWebhooksReceived,
  setSlackTeamId,
  setSlackBotUserId,
  incrementGithubWebhooks,
  loadActiveSessionsOnStartup,
} from "./state";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

/**
 * Shared-secret gate for the /worktree/* hooks. A reverse proxy fronts this
 * port with a public origin, so these routes are reachable from the open
 * internet — without this check anyone could create Slack
 * channels or archive worktree channels. Callers (the `wt` CLI) send
 * `x-worktree-secret` matching WORKTREE_HOOK_SECRET. Fail closed: no secret
 * configured means every request is rejected.
 */
function verifyWorktreeSecret(req: Request): boolean {
  const secret = process.env.WORKTREE_HOOK_SECRET || "";
  if (!secret) return false;
  const given = req.headers.get("x-worktree-secret") || "";
  const secretBuf = Buffer.from(secret);
  const givenBuf = Buffer.from(given);
  if (secretBuf.length !== givenBuf.length) return false;
  try {
    return timingSafeEqual(secretBuf, givenBuf);
  } catch {
    return false;
  }
}

// Bounded dedup of GitHub webhook delivery ids (x-github-delivery) — GitHub
// redeliveries (manual or automatic) would otherwise re-trigger reviews and
// PR-event automations. In-memory ring of the last ~500 ids, parked on
// globalThis so a hot reload doesn't forget recent deliveries.
const seenGithubDeliveries: Set<string> = ((globalThis as any).__githubDeliveryIds ??=
  new Set<string>());

function markGithubDelivery(id: string): void {
  seenGithubDeliveries.add(id);
  // Oldest-first eviction — Sets iterate in insertion order.
  while (seenGithubDeliveries.size > 500) {
    const oldest = seenGithubDeliveries.values().next().value;
    if (oldest === undefined) break;
    seenGithubDeliveries.delete(oldest);
  }
}

export class SlackAgent implements AgentModule {
  name = "slack";

  /**
   * Slack channels as a sidebar feed (the feeds design): the bot's
   * member channels, most-populated first. Click → repo-less workspace with
   * scratch sessions scoped to the slack MCP; the plugin context hook
   * injects the channel's recent history (fetchChannelHistory — resolved
   * user names, prettified mentions) so a session opens knowing the
   * conversation. Bot-token identity for now; per-user Slack OAuth (user
   * tokens via a Slack app) is a follow-up — it's Slack's own OAuth, not
   * MCP-spec OAuth, so it needs a github-auth-style custom flow.
   */
  getFeed(): import("../../server/feeds").FeedProvider | null {
    if (!process.env.SLACK_BOT_TOKEN) return null;
    return {
      descriptor: {
        id: "slack",
        title: "Slack",
        refKind: "slack-channel",
        tileBg: "#4a154b",
        mcpServers: ["slack"],
        searchMeta: ["topic", "purpose"],
        filters: [
          {
            key: "visibility",
            label: "Type",
            mode: "meta",
            field: "isPrivate",
            options: [
              { value: "false", label: "Public" },
              { value: "true", label: "Private" },
            ],
          },
        ],
        // Workspace tab: the channel Conversation pane (custom component —
        // routes/slack-channels.ts serves history + post-as-me).
        panel: { label: "Conversation", component: "slack-channel" },
        // Slack-style list sorting: busiest first (default), A–Z, newest.
        sortOptions: [
          { value: "meta:members", label: "Most members" },
          { value: "title", label: "A–Z" },
          { value: "recent", label: "Newest first" },
        ],
      },
      async listItems(ctx?: { user?: string }) {
        const { slackApiCall } = await import("./slack-api");
        const { mcpUserGrantToken } = await import("../../server/mcp-oauth");
        // The viewer's own grant (once they've connected Slack in My
        // accounts) lists THEIR channels; bot token as fallback.
        const token = ctx?.user
          ? mcpUserGrantToken("slack", ctx.user)
          : undefined;
        const byId = new Map<string, import("../../server/feeds").FeedItem>();
        let teamId = "";
        try {
          const auth = await slackApiCall("auth.test", {}, token);
          teamId = auth?.team_id || "";
        } catch {}
        // conversations.list wants query params (a JSON body is silently
        // ignored → the same first page forever); GET like worktree-channels.
        const { fetchWithTimeout } = await import(
          "../../server/shared/fetch-with-timeout"
        );
        const authToken = token || process.env.SLACK_BOT_TOKEN;
        let cursor = "";
        for (let page = 0; page < 6; page++) {
          const params = new URLSearchParams({
            // Bot token lacks groups:read → private_channel errors the whole
            // call (missing_scope). Personal grants request groups:read, so
            // private channels appear once a user connects their account.
            types: token ? "public_channel,private_channel" : "public_channel",
            exclude_archived: "true",
            limit: "200",
            ...(cursor ? { cursor } : {}),
          });
          const resp = await fetchWithTimeout(
            `https://slack.com/api/conversations.list?${params}`,
            { headers: { Authorization: `Bearer ${authToken}` } },
          );
          const data = (await resp.json()) as any;
          if (!data?.ok) break;
          for (const ch of data.channels || []) {
            if (!ch.is_member) continue; // history needs membership
            byId.set(ch.id, {
              id: ch.id,
              title: `#${ch.name}`,
              preview: ch.topic?.value || ch.purpose?.value || undefined,
              ts: (ch.created || 0) * 1000,
              ...(teamId
                ? { url: `https://app.slack.com/client/${teamId}/${ch.id}` }
                : {}),
              meta: {
                topic: ch.topic?.value || "",
                purpose: ch.purpose?.value || "",
                members: ch.num_members || 0,
                isPrivate: !!ch.is_private,
              },
            });
          }
          cursor = data.response_metadata?.next_cursor || "";
          if (!cursor) break;
        }
        // Most-populated first — the bot's hundreds of 1-2-member worktree
        // channels sink; cap to a sane band size.
        const items = [...byId.values()]
          .sort(
            (a, b) =>
              ((b.meta?.members as number) || 0) -
              ((a.meta?.members as number) || 0),
          )
          .slice(0, 40);
        // Unread state — only meaningful against a person's own read
        // cursors, so grant-token only. Slack exposes no bulk unreads to
        // xoxp tokens (client.counts is xoxc-only): per channel, compare
        // conversations.info's last_read with the newest history ts. Two
        // Tier-3 calls per channel, bounded concurrency; failures just
        // leave the item unread-less. The 60s feed cache amortizes it.
        if (token) {
          const { slackApiGet } = await import("./slack-api");
          const CONCURRENCY = 8;
          const queue = [...items];
          const workers = Array.from({ length: CONCURRENCY }, async () => {
            for (;;) {
              const item = queue.shift();
              if (!item) return;
              try {
                const [info, history] = await Promise.all([
                  slackApiGet(
                    "conversations.info",
                    { channel: item.id },
                    token,
                  ),
                  slackApiGet(
                    "conversations.history",
                    { channel: item.id, limit: 1 },
                    token,
                  ),
                ]);
                const lastRead = info?.channel?.last_read;
                const latest = history?.messages?.[0]?.ts;
                if (lastRead && latest) {
                  item.meta = {
                    ...item.meta,
                    unread: Number(latest) > Number(lastRead),
                  };
                }
              } catch {}
            }
          });
          await Promise.all(workers);
        }
        return items;
      },
      async contextForRef(id: string, user?: string) {
        const { fetchChannelHistory, slackApiCall } = await import(
          "./slack-api"
        );
        const { mcpUserGrantToken } = await import("../../server/mcp-oauth");
        const token = user ? mcpUserGrantToken("slack", user) : undefined;
        const [info, history] = await Promise.all([
          slackApiCall("conversations.info", { channel: id }, token).catch(
            () => null,
          ),
          fetchChannelHistory(id, 30),
        ]);
        const ch = info?.channel;
        const lines = history.map(
          (m) =>
            `[${new Date(Number(m.ts) * 1000).toISOString().slice(5, 16)}] ${m.userName}: ${m.text}`,
        );
        return [
          ch
            ? `Channel: #${ch.name}${ch.topic?.value ? ` — topic: ${ch.topic.value}` : ""}${ch.purpose?.value ? `\nPurpose: ${ch.purpose.value}` : ""}`
            : `Channel: ${id}`,
          lines.length
            ? `Recent messages (oldest first):\n${lines.join("\n")}`
            : "No recent messages.",
          `Use the slack MCP tools for more history, thread replies, or to post (always prefix posts saying you're ${personaName()}).`,
        ].join("\n\n");
      },
    };
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    // ----- POST /slack/events -----
    routes.set("POST /slack/events", async (req) => {
      // Slack retries a delivery when the original didn't get a 200 — which,
      // since we ack every event immediately below, means we were down/erroring
      // when it first arrived (e.g. mid-restart). The old code blindly acked-and-
      // dropped every retry on the assumption it was already handled, silently
      // losing any event delivered during a restart window. Instead, let retries
      // fall through to the persisted dedup check, which drops only events we
      // actually handled and processes the ones we missed.
      const retryNum = req.headers.get("x-slack-retry-num");
      if (retryNum) {
        console.log(
          `[slack] Slack retry #${retryNum} (reason: ${req.headers.get("x-slack-retry-reason")}) — routing through dedup`
        );
      }

      const body = await req.text();
      const timestamp = req.headers.get("x-slack-request-timestamp") || "";
      const signature = req.headers.get("x-slack-signature") || "";

      if (
        !verifySlackSignature(body, timestamp, signature, SLACK_SIGNING_SECRET)
      ) {
        console.error("[slack] Invalid Slack signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      const payload = JSON.parse(body);

      // URL verification challenge
      if (payload.type === "url_verification") {
        console.log("[slack] URL verification challenge received");
        return Response.json({ challenge: payload.challenge });
      }

      // Event callback
      if (payload.type === "event_callback") {
        const event = payload.event;

        if (event.type === "link_shared") {
          console.log(
            `[slack] link_shared links=${JSON.stringify((event.links || []).map((l: any) => l.url))}`,
          );
        }

        if (event.bot_id || event.subtype === "bot_message") {
          return Response.json({ ok: true });
        }

        // Handle message.im events (DMs)
        if (event.type === "message" && event.channel_type === "im") {
          const eventId = `${event.channel}-${event.ts}`;
          if (isEventProcessed(eventId)) {
            console.log(`[slack] Duplicate event: ${eventId}`);
            return Response.json({ ok: true });
          }

          // Mark processed only AFTER the handler has enqueued the message —
          // marking first meant a handler throw made Slack's retry look like a
          // duplicate and the message was silently dropped.
          handleMessageEvent(event)
            .then(() => markEventProcessed(eventId))
            .catch((e) => {
              console.error("[slack] Error handling message:", e);
            });
        }

        // Channel-watch automations: one run per top-level message in a
        // watched channel (thread replies and @-mentions don't
        // re-trigger — mentions go through the interactive path below).
        if (
          event.type === "message" &&
          event.channel_type !== "im" &&
          !event.subtype &&
          !event.thread_ts &&
          !(event.text || "").includes(`<@${slackBotUserId}>`) &&
          isChannelWatched(event.channel)
        ) {
          const watchId = `watch-${event.channel}-${event.ts}`;
          if (!isEventProcessed(watchId)) {
            markEventProcessed(watchId);
            const u = event.user
              ? await resolveSlackUser(event.user)
              : { name: "Unknown", avatarUrl: undefined };
            fireAutomationsForSlackChannel(
              event.channel,
              JSON.stringify(
                {
                  channel: event.channel,
                  ts: event.ts,
                  userId: event.user || null,
                  userName: u.name,
                  text: event.text || "",
                  permalink: `thread ts ${event.ts} — reply in-thread via the slack MCP if your instructions say to respond`,
                },
                null,
                2,
              ),
            );
          }
        }

        // Handle app_mention events
        if (event.type === "app_mention") {
          const eventId = `${event.channel}-${event.ts}`;
          if (isEventProcessed(eventId)) {
            console.log(`[slack] Duplicate mention event: ${eventId}`);
            return Response.json({ ok: true });
          }

          // Same as DMs above: only mark processed once the handler succeeded,
          // so a throw leaves the retry eligible instead of dropping the event.
          handleMentionEvent(event)
            .then(() => markEventProcessed(eventId))
            .catch((e) => {
              console.error("[slack] Error handling mention:", e);
            });
        }

        // Unfurl os.tella.dev session links (Slack can't reach the tailnet-only
        // host to read OG tags, so we look the session up in-process and post a
        // preview via chat.unfurl). Deduped on the shared message ts.
        if (event.type === "link_shared") {
          const eventId = `unfurl-${event.channel}-${event.message_ts}`;
          if (!isEventProcessed(eventId)) {
            markEventProcessed(eventId);
            handleLinkShared(event).catch((e) => {
              console.error("[slack] Error unfurling link:", e);
            });
          }
        }

        // Handle assistant_thread_started events (DM thread opened)
        if (event.type === "assistant_thread_started") {
          const thread = event.assistant_thread;
          if (thread?.channel_id && thread?.thread_ts) {
            slackApiCall("assistant.threads.setSuggestedPrompts", {
              channel_id: thread.channel_id,
              thread_ts: thread.thread_ts,
              prompts: [
                {
                  title: "Check worktrees",
                  message: "What worktrees are currently active?",
                },
                {
                  title: "Health check",
                  message: "Run a health check on all services",
                },
              ],
            }).catch((e: any) => {
              console.warn("[slack] Error setting suggested prompts:", e);
            });
          }
        }
      }

      return Response.json({ ok: true });
    });

    // ----- POST /slack/actions (Block Kit interactions) -----
    routes.set("POST /slack/actions", async (req) => {
      const body = await req.text();
      const timestamp = req.headers.get("x-slack-request-timestamp") || "";
      const signature = req.headers.get("x-slack-signature") || "";

      if (
        !verifySlackSignature(body, timestamp, signature, SLACK_SIGNING_SECRET)
      ) {
        console.error("[slack] Invalid Slack action signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      // Parse URL-encoded body
      const params = new URLSearchParams(body);
      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return Response.json({ error: "No payload" }, { status: 400 });
      }

      const payload = JSON.parse(payloadStr);

      // Handle block_actions (button clicks)
      if (payload.type === "block_actions") {
        const action = payload.actions?.[0];
        if (!action) {
          return new Response("", { status: 200 });
        }

        const actionId: string = action.action_id;

        // Check if this is an "Other..." button — must open modal BEFORE returning
        if (actionId.endsWith("-other")) {
          // Human-in-the-loop ask "Other…" — open the free-text modal.
          const haOther = actionId.match(/^humanask-(.+)-other$/);
          if (haOther?.[1]) {
            const askId = haOther[1];
            const ask = getHumanAsk(askId);
            if (ask && isHumanAskAwaiting(askId) && payload.trigger_id) {
              const r = await openHumanAskModal(payload.trigger_id, askId, ask.question);
              if (!r?.ok) console.error("[slack] human-ask modal open failed:", r);
            }
            return new Response("", { status: 200 });
          }
          // Extract questionId: "askq-{questionId}-other"
          const match = actionId.match(/^askq-(.+)-other$/);
          if (match?.[1]) {
            const questionId = match[1];
            const pending = pendingAnswers.get(questionId);
            if (pending) {
              const triggerId = payload.trigger_id;
              if (triggerId) {
                const modalResult = await openSlackModal(
                  triggerId,
                  questionId,
                  pending.questionText
                );
                if (!modalResult?.ok) {
                  console.error("[slack] Failed to open modal:", modalResult);
                }
              }
            }
          }
          return new Response("", { status: 200 });
        }

        // Regular option button — handle in background
        const optMatch = actionId.match(/^askq-(.+)-opt-(\d+)$/);
        if (optMatch?.[1]) {
          const questionId = optMatch[1];
          const selectedLabel = action.value;

          // Respond immediately, resolve in background
          setImmediate(() => {
            const pending = pendingAnswers.get(questionId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pendingAnswers.delete(questionId);
              pending.resolve(selectedLabel);
            }
          });
          return new Response("", { status: 200 });
        }

        // Human-in-the-loop ask — option button picked.
        const haOpt = actionId.match(/^humanask-(.+)-opt-(\d+)$/);
        if (haOpt?.[1]) {
          const askId = haOpt[1];
          const label = action.value;
          setImmediate(() => resolveHumanAsk(askId, label));
          const msgChannel = payload.channel?.id;
          const msgTs = payload.message?.ts;
          if (msgChannel && msgTs) {
            const kept = (payload.message?.blocks || []).filter((b: any) => b.type !== "actions");
            kept.push({
              type: "context",
              elements: [{ type: "mrkdwn", text: `:white_check_mark: _You answered: ${label}_` }],
            });
            await updateSlackBlocks(msgChannel, msgTs, `Answered: ${label}`, kept);
          }
          return new Response("", { status: 200 });
        }

        // Stop button on a Grafana-poller investigation card — cancel the
        // automation-run session by its opensession id (registered in activeRuns
        // under the bks id, so cancelAgentRun reaches it). `investigate-stop:`
        // is the current prefix; `export-stop:`/`upload-stop:` are kept for any
        // cards posted before the generic poller landed.
        const stopPrefix = ["investigate-stop:", "export-stop:", "upload-stop:", "pr-stop:"].find((p) =>
          actionId.startsWith(p)
        );
        if (stopPrefix) {
          const bksId = actionId.slice(stopPrefix.length);
          const didCancel = cancelAgentRun(bksId);

          const msgChannel = payload.channel?.id;
          const msgTs = payload.message?.ts;
          if (msgTs && msgChannel) {
            const label = didCancel ? "Stopped" : "Nothing to stop";
            const keptBlocks = (payload.message?.blocks || []).filter(
              (b: any) => b.type !== "actions"
            );
            keptBlocks.push({
              type: "context",
              elements: [{ type: "mrkdwn", text: `_${label}_` }],
            });
            await updateSlackBlocks(msgChannel, msgTs, label, keptBlocks);
          }
          return new Response("", { status: 200 });
        }

        // Stop button — cancel the running session
        if (actionId.startsWith("stop:")) {
          const sessionKey = actionId.slice("stop:".length);
          const didCancel = cancelSession(sessionKey);

          const msgChannel = payload.channel?.id;
          const msgTs = payload.message?.ts;
          if (msgTs && msgChannel) {
            const label = didCancel ? "Cancelled" : "Nothing to cancel";
            await updateSlackBlocks(msgChannel, msgTs, label, [
              {
                type: "context",
                elements: [{ type: "mrkdwn", text: `_${label}_` }],
              },
            ]);
          }
          return new Response("", { status: 200 });
        }

        // GitHub PR review — "Address this feedback" button
        if (actionId.startsWith("gh-review-address-")) {
          const reviewData = JSON.parse(action.value);
          const {
            branch,
            channelId: reviewChannelId,
            prNumber,
            prUrl,
            reviewerName,
            reviewState,
            reviewBody,
            inlineCommentCount,
          } = reviewData;

          // Update message to remove buttons and show status
          const msgChannel = payload.channel?.id || reviewChannelId;
          const msgTs = payload.message?.ts;
          if (msgTs) {
            const updatedBlocks = (payload.message?.blocks || []).filter(
              (b: any) => b.type !== "actions"
            );
            updatedBlocks.push({
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "\u23f3 _Addressing this feedback..._",
                },
              ],
            });
            await updateSlackBlocks(
              msgChannel,
              msgTs,
              "Addressing PR review feedback...",
              updatedBlocks
            );
          }

          // Enqueue prompt to the worktree's Claude session
          const sessionKey = reviewChannelId;
          const worktreeDir = getWorktreeDirForChannel(reviewChannelId);
          const worktreeBranch = worktreeChannels.get(reviewChannelId);

          const prompt = `A PR review was submitted on PR #${prNumber} (${prUrl}) by ${reviewerName}.

Review type: ${reviewState}
${reviewBody ? `Review comment: "${reviewBody}"` : "No overall review comment."}
${inlineCommentCount > 0 ? `There are ${inlineCommentCount} inline comments on specific files.` : ""}

Please address this feedback:
1. Read the PR review comments by running: gh api repos/${defaultRepo().ghRepo}/pulls/${prNumber}/reviews --jq '.[-1]' and gh api repos/${defaultRepo().ghRepo}/pulls/${prNumber}/comments
2. Understand each piece of feedback
3. Make the necessary code changes to address the review
4. Commit and push the changes (ALWAYS push \u2014 never leave changes unpushed)
5. Respond to each individual review comment on the PR by posting replies via: gh api repos/${defaultRepo().ghRepo}/pulls/${prNumber}/comments/{comment_id}/replies -f body="<your response>"
6. Summarize what you changed in response to the review`;

          enqueueMessage(sessionKey, {
            prompt,
            channel: reviewChannelId,
            threadTs: msgTs || "",
            messageTs: msgTs || "",
            userName: "GitHub PR Review",
            userId: slackBotUserId,
            isNewSession: false,
            worktreeDir: worktreeDir || undefined,
            branch: worktreeBranch || undefined,
          });

          return new Response("", { status: 200 });
        }

        // GitHub PR review — "Dismiss" button
        if (actionId.startsWith("gh-review-dismiss-")) {
          const msgChannel = payload.channel?.id;
          const msgTs = payload.message?.ts;
          if (msgTs && msgChannel) {
            const updatedBlocks = (payload.message?.blocks || []).filter(
              (b: any) => b.type !== "actions"
            );
            updatedBlocks.push({
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "\ud83d\udeab _Dismissed_",
                },
              ],
            });
            await updateSlackBlocks(
              msgChannel,
              msgTs,
              "PR review feedback dismissed",
              updatedBlocks
            );
          }
          return new Response("", { status: 200 });
        }

        return new Response("", { status: 200 });
      }

      // Handle view_submission (modal submit for "Other...")
      if (payload.type === "view_submission") {
        const callbackId: string = payload.view?.callback_id || "";

        // Human-in-the-loop ask — free-text "Other…" answer.
        const haModal = callbackId.match(/^humanask-modal-(.+)$/);
        if (haModal?.[1]) {
          const askId = haModal[1];
          const answer: string =
            payload.view?.state?.values?.answer_block?.answer_input?.value || "";
          if (answer.trim()) setImmediate(() => resolveHumanAsk(askId, answer.trim()));
          return new Response("", { status: 200 });
        }

        const match = callbackId.match(/^askq-modal-(.+)$/);

        if (match?.[1]) {
          const questionId = match[1];
          const values = payload.view?.state?.values;
          const answerValue: string =
            values?.answer_block?.answer_input?.value || "";

          setImmediate(() => {
            const pending = pendingAnswers.get(questionId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pendingAnswers.delete(questionId);
              pending.resolve(answerValue);
            }
          });
        }

        // Must return 200 with empty body to close the modal
        return new Response("", { status: 200 });
      }

      return new Response("", { status: 200 });
    });

    // ----- POST /github/webhook -----
    routes.set("POST /github/webhook", async (req) => {
      const body = await req.text();
      const signature = req.headers.get("x-hub-signature-256") || "";

      if (!verifyGitHubSignature(body, signature, GITHUB_WEBHOOK_SECRET)) {
        console.error("[slack] Invalid GitHub webhook signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      // Reject replayed/redelivered webhooks by delivery id.
      const deliveryId = req.headers.get("x-github-delivery");
      if (deliveryId) {
        if (seenGithubDeliveries.has(deliveryId)) {
          console.log(`[slack] Duplicate GitHub delivery ${deliveryId} — skipping`);
          return Response.json({ ok: true, duplicate: true });
        }
        markGithubDelivery(deliveryId);
      }

      incrementGithubWebhooks();
      const event = req.headers.get("x-github-event") || "";
      const payload = JSON.parse(body);

      console.log(
        `[slack] GitHub webhook: event=${event}, action=${payload.action}`
      );

      if (event === "pull_request_review") {
        // Handle async — GitHub has a 10s timeout
        handlePullRequestReview(payload, branchToChannel).catch((e) => {
          console.error("[slack] Error handling PR review webhook:", e);
        });
      }

      // Sync the server's PR caches + nudge open tabs (server/pr-webhook.ts)
      // on every delivery — it filters to PR-carrying events itself, including
      // ones the github agent doesn't consume (reviews, checks, statuses).
      import("../../server/pr-webhook")
        .then((m) => m.handlePrWebhookEvent(event, payload))
        .catch((e) => console.error("[slack] pr-webhook dispatch failed:", e));

      // Forward PR events to the github agent (review / auto-fix / simplify,
      // @mention replies on PR comments, and merge/deploy notifications into
      // linked sessions). Fire-and-forget so a github-module error never breaks
      // the Slack path.
      if (
        event === "pull_request" ||
        event === "issue_comment" ||
        event === "pull_request_review_comment" ||
        event === "workflow_run"
      ) {
        import("../github/webhook")
          .then((m) => m.handleGithubPrEvent(event, payload))
          .catch((e) => console.error("[slack] github agent dispatch failed:", e));
      }

      return Response.json({ ok: true });
    });

    // ----- POST /worktree/create-channel -----
    routes.set("POST /worktree/create-channel", async (req) => {
      if (!verifyWorktreeSecret(req)) {
        console.error("[slack] Rejected /worktree/create-channel: bad or missing x-worktree-secret");
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      try {
        const body = (await req.json()) as { branch: string };
        const { branch } = body;
        if (!branch) {
          return Response.json(
            { error: "branch required" },
            { status: 400 }
          );
        }

        // Check if channel already exists for this branch
        if (branchToChannel.has(branch)) {
          return Response.json({
            ok: true,
            channelId: branchToChannel.get(branch),
            existing: true,
          });
        }

        const channelName = branchToChannelName(branch);
        console.log(
          `[slack] Creating Slack channel: #${channelName} for branch: ${branch}`
        );

        const result = await createSlackChannel(channelName);
        if (!result.ok || !result.channelId) {
          console.error(
            `[slack] Failed to create channel #${channelName}:`,
            result.error
          );
          return Response.json(
            { ok: false, error: result.error },
            { status: 500 }
          );
        }

        const channelId = result.channelId;

        // Invite bot to channel
        await inviteBotToChannel(channelId);

        // Set topic
        const worktreeDir = worktreePathFor(branch);
        const ghCompareUrl = `https://github.com/${GITHUB_REPO}/compare/main...${encodeURIComponent(branch)}`;
        await setChannelTopic(
          channelId,
          `${ghCompareUrl} | Mention @${personaName()} to interact`
        );

        // Post intro message
        const authResp = await fetchWithTimeout("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        });
        const botId = ((await authResp.json()) as any).user_id;
        await sendSlackMessage(
          channelId,
          `\ud83d\udc4b This channel is linked to worktree \`${branch}\`.\n\nMention <@${botId}> to interact with Claude working in this worktree.\n\nWorking directory: \`${worktreeDir}\``
        );

        // Save mapping
        worktreeChannels.set(channelId, branch);
        branchToChannel.set(branch, channelId);
        await saveWorktreeChannels();

        console.log(
          `[slack] Created and linked #${channelName} (${channelId}) -> ${branch}`
        );

        // Auto-invite relevant GitHub users (async, don't block response)
        inviteRelevantUsersToChannel(channelId, branch).catch((e) => {
          console.warn("[slack] Error auto-inviting users:", e);
        });

        return Response.json({ ok: true, channelId, channelName });
      } catch (e: any) {
        console.error("[slack] Error in /worktree/create-channel:", e);
        return Response.json(
          { ok: false, error: e.message },
          { status: 500 }
        );
      }
    });

    // ----- POST /worktree/archive-channel -----
    routes.set("POST /worktree/archive-channel", async (req) => {
      if (!verifyWorktreeSecret(req)) {
        console.error("[slack] Rejected /worktree/archive-channel: bad or missing x-worktree-secret");
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      try {
        const body = (await req.json()) as { branch: string };
        const { branch } = body;
        if (!branch) {
          return Response.json(
            { error: "branch required" },
            { status: 400 }
          );
        }

        const channelId = branchToChannel.get(branch);
        if (!channelId) {
          return Response.json({
            ok: true,
            message: "no channel for this branch",
          });
        }

        console.log(
          `[slack] Archiving Slack channel for branch: ${branch} (${channelId})`
        );

        // Post farewell message
        await sendSlackMessage(
          channelId,
          `\ud83d\uddc2\ufe0f Worktree \`${branch}\` is being deleted. Archiving this channel.`
        );

        // Archive the channel
        await archiveSlackChannel(channelId);

        // Clean up mappings
        worktreeChannels.delete(channelId);
        branchToChannel.delete(branch);
        await saveWorktreeChannels();

        // Clean up any sessions for this channel
        const sessionKey = channelId;
        const session = activeSessions.get(sessionKey);
        if (session) {
          activeSessions.delete(sessionKey);
          try {
            unlinkSync(`${SESSION_DIR}/${sessionKey}.json`);
          } catch {}
        }

        console.log(
          `[slack] Archived channel and cleaned up for branch: ${branch}`
        );

        return Response.json({ ok: true });
      } catch (e: any) {
        console.error("[slack] Error in /worktree/archive-channel:", e);
        return Response.json(
          { ok: false, error: e.message },
          { status: 500 }
        );
      }
    });

    return routes;
  }

  async startup(): Promise<void> {
    // Ensure session directory exists
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true });
    }

    await loadActiveSessionsOnStartup();
    await loadWorktreeChannels();
    await loadQueueFromDisk();
    loadProcessedEvents();

    // Fetch team ID and bot user ID for streaming APIs
    try {
      const authResp = await fetchWithTimeout("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      const authData = (await authResp.json()) as any;
      if (authData.ok) {
        setSlackTeamId(authData.team_id);
        setSlackBotUserId(authData.user_id);
        console.log(
          `[slack] Slack team: ${authData.team} (${authData.team_id}), bot: ${authData.user_id}`
        );
      } else {
        console.warn("[slack] auth.test failed:", authData.error);
      }
    } catch (e) {
      console.warn("[slack] Failed to fetch Slack team info:", e);
    }

    console.log("[slack] Agent started");
  }

  async shutdown(): Promise<void> {
    // Abort all running queries
    for (const [key, sq] of sessionQueues) {
      if (sq.abortController) {
        sq.abortController.abort();
      }
    }

    console.log("[slack] Agent shut down");
  }

  health(): Record<string, unknown> {
    const queueDetails: Record<
      string,
      { queueLength: number; processing: boolean }
    > = {};
    for (const [key, sq] of sessionQueues) {
      queueDetails[key] = {
        queueLength: sq.queue.length,
        processing: sq.processing,
      };
    }

    return {
      status: "operational",
      agent: `${personaName()} (Slack)`,
      activeSessions: activeSessions.size,
      activeQueues: sessionQueues.size,
      pendingQuestions: pendingAnswers.size,
      githubWebhookConfigured: !!process.env.GITHUB_WEBHOOK_SECRET,
      githubApiTokenConfigured: !!process.env.GITHUB_API_TOKEN,
      githubWebhooksReceived,
      queueDetails,
    };
  }
}
