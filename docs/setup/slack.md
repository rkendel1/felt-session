# Slack

The Slack agent (`src/agents/slack/`) is the main chat surface: DMs and
@-mentions become agent runs, worktree channels drive coding sessions, and
watched channels fire automations.

## Tokens and env vars

Everything uses a single **bot token** — there is no user-token or OAuth
flow anywhere in the Slack agent.

| Var | Required | Notes |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…`; used as Bearer for every Web API call (`src/agents/slack/slack-api.ts`). Missing → the agent loads and every Slack call fails with logged auth warnings (no crash) |
| `SLACK_SIGNING_SECRET` | yes | HMAC verification of `/slack/events` and `/slack/actions`; missing → real Slack requests fail verification → 401, so event intake is dead |
| `ALLOWED_SLACK_USER_ID` | recommended | admin gating, see below. **Unset = everyone is admin** (fail-open) |
| `WORKTREE_HOOK_SECRET` | for `/worktree/*` hooks | shared secret; fail-closed (empty → all worktree-hook requests rejected) |
| `SLACK_MENTION_INTENT_MODEL` | no | mention intent-router model, default `claude-haiku-4-5` |
| `SCHEDULE_WHEN_MODEL` | no | natural-language schedule parsing, default `claude-haiku-4-5` |

Disable the agent with `ENABLE_SLACK_AGENT=false` (default ON — see
[integrations-misc.md](integrations-misc.md#boot-guards)).

## Event intake: HTTP Events API

Not Socket Mode, not polling. The agent registers routes on the
[webhook server](install.md#webhook-server) (default `127.0.0.1:3848`,
behind your TLS proxy):

- `POST /slack/events` — Events API callbacks (handles Slack's
  `url_verification` challenge)
- `POST /slack/actions` — Block Kit interactivity
- `POST /github/webhook`, `POST /worktree/create-channel`,
  `POST /worktree/archive-channel` — co-located here (see
  [github.md](github.md))

Point your Slack app's Event Subscriptions and Interactivity request URLs at
the first two. Events are acked 200 immediately and handled async, with
persisted dedup so Slack retries don't double-run.

Event subscriptions the code consumes: `message.im` (DMs), `app_mention`,
and plain `message` events in channels (for session-linked mirroring and
watched-channel automations).

## OAuth scopes

Derived from the Web API methods the code actually calls
(`slack-api.ts`, `worktree-channels.ts`, `github-reviews.ts`, `index.ts`,
`streamer.ts`): `auth.test`, `chat.postMessage`, `chat.update`,
`chat.startStream`/`appendStream`/`stopStream`,
`assistant.threads.setStatus`/`setSuggestedPrompts`, `reactions.add`/
`remove`, `conversations.history`/`replies`/`info`/`open`/`list`/`create`/
`archive`/`setTopic`/`join`/`invite`, `users.info`, `views.open`.

Bot token scopes to grant:

- `chat:write`, `chat:write.customize`
- `reactions:write`
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`
- `channels:manage`, `groups:write` (create/archive/topic/invite worktree
  channels), `channels:join`
- `im:write`
- `users:read`
- `assistant:write` (assistant threads + streaming)

No `files:*` — the Slack agent doesn't upload files. The bot must be a
member of a channel to read its history; the code calls `conversations.join`
for channels it manages, but invite it to any pre-existing channel you want
it to read.

## Who can drive it (`ALLOWED_SLACK_USER_ID`)

`src/agents/slack/handlers.ts`:

- DMs and mentions are ignored unless the sender matches
  `ALLOWED_SLACK_USER_ID` — **except** mentions in worktree channels or
  channels linked to a OpenSession session, where the whole team can drive.
- `isAdmin = !ALLOWED_SLACK_USER_ID || sender === ALLOWED_SLACK_USER_ID`.
  Admin unlocks the mutating tools of the in-process MCP servers
  (`michael-admin` self-management, session control, goals, human-asks);
  non-admins keep the read-only subsets.
- Leaving it unset makes every workspace member an admin. Set it.

## What triggers what

- **DM** → conversational agent run.
- **@-mention** → intent-classified (haiku): PR action, read-only "ask" in
  thread, or "code" (new worktree + dedicated channel).
- **Message in a session-linked channel** → mirrored into the session's chat
  panel; an @-mention there steers the linked session.
- **Top-level message in a watched channel** → fires channel-watch
  automations (thread replies and bot posts don't).

## Channel memory

`src/agents/slack/memory.ts`, stored under `~/.michael-memory/`, one JSON
file per scope, injected into the system prompt each run and edited via the
admin `remember`/`list_memory`/`forget` tools:

- public channel → shared `workspace.json`
- private channel → isolated `channel-<id>.json` + read-only workspace view
- DM → isolated `user-<id>.json` + read-only workspace view

## Channel IDs

No channel or user id is compiled in. Everything that posts to Slack resolves
its destination from config, and an unset channel means that particular
message is skipped rather than misdelivered:

| Setting | Used for |
| --- | --- |
| `integrations.slack.workspaceId` | building `app.slack.com` deep links in session labels |
| `integrations.slack.channelNames` | channel-id→name map for rendering transcripts |
| `integrations.github.docsSyncChannel` | where docs-sync announces its PRs |
| `SLACK_EXPORT_FAILURE_CHANNEL` / `SLACK_UPLOAD_FAILURE_CHANNEL` | Grafana-poller failure cards ([integrations-misc.md](integrations-misc.md#grafana-poller)) |

Identity mapping (Slack id → person, for attribution and per-user MCP
gating) is **not** hardcoded anymore: it derives from `identity.team` /
`identity.slackNames` in `~/.opensession/config.json`
([install.md](install.md#3-opensessionconfigjson)); with no config file you get
Tella's built-in roster.
