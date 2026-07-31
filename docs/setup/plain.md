# Plain (customer support)

The Plain agent (`src/agents/plain/`) triages inbound support tickets: a new
thread fires a spam/complexity router, then the triage automation
investigates the customer (WorkOS, Stripe, Tinybird, Sentry, Linear via MCP)
and writes an **internal note** with findings and a suggested reply — it
never replies to the customer itself.

## Env vars

| Var | Required for | Notes |
| --- | --- | --- |
| `PLAIN_API_KEY` | API calls | constructs the `PlainClient` (`src/agents/plain/api.ts`); also read by the thread-status archive sweep (`src/server/plain-archive.ts`, no-op without it) |
| `PLAIN_WEBHOOK_SECRET` | webhooks | **fail-closed**: unset/empty → every webhook 401s |
| `PLAIN_API_URL` | optional | GraphQL endpoint for the top-issues rollup; default `https://core-api.uk.plain.com/graphql/v1` |
| `PLAIN_SPAM_CHECK_MODEL` | optional | pre-triage router model, default `claude-haiku-4-5` |
| `PLAIN_REFUND_INTENT_MODEL` | optional | refund-approval classifier model, default `claude-haiku-4-5` |
| `PLAIN_TOPISSUES_QUOTE_MODEL` | optional | top-issues quote extraction, default `claude-haiku-4-5` |

The Plain MCP server (which gives runs their Plain tools) is configured
separately in `mcp-config.json` with its own `PLAIN_API_KEY` in the server's
`env` block — see [install.md](install.md#5-mcp-configjson).

Disable the agent with `ENABLE_PLAIN_AGENT=false` (default ON — see
[integrations-misc.md](integrations-misc.md#boot-guards)).

## Webhook intake

Point a Plain webhook at `POST /plain/webhook` on the
[webhook server](install.md#webhook-server). Signature header:
`plain-request-signature` (HMAC-SHA256, timing-safe).

Consumed events (`src/agents/plain/handlers.ts`):

- `thread.thread_created` — gated, then fires the triage automation (below)
- `thread.thread_status_transitioned` to `DONE` — archives the OpenSession
  sessions linked to that thread
- `thread.note_created` containing `@michael` — runs the mention flow, but
  only when the note author is a human teammate (`actorType === "user"`);
  customer/bot/system notes are ignored

Before triage fires, outbound threads are filtered out (teammate follow-ups
and Linear "close the loop" messages also emit `thread_created`): the
first-message actor is checked (teammate/machine → skip), and a thread that
still has **no customer message but other activity** after polling (up to
8×15s — outbound entries can lag the webhook by minutes) is treated as
outbound and skipped. A truly empty thread fails open and gets triaged. The
surviving ticket runs through the spam/basic/full router
(`ticket-router.ts`) before the full automation fires.

## The triage automation (least-privilege model)

Automations are JSON files in `~/.opensession-automations/<id>.json`
(`src/server/automations.ts`). The Plain agent seeds a triage automation on
startup, keyed to event `plain:thread_created`, create-if-absent so your UI
edits survive restarts (`src/agents/plain/triage-automation.ts`). Its shape
is the reference for scoping any automation:

- **`mode: "code"`** — runs in an isolated worktree with Write/Edit, so it
  can implement a fix and open a PR (never merge; PRs are the human gate).
  Use `mode: "ask"` for automations that only need to read.
- **`mcpServers` allowlist** — the run only sees the named MCP servers.
  Triage ships with: `plain`, `workos`, `tinybird`, `linear`, `sentry`,
  `stripe`, `TellaInternalSupportMCP`, `grafana`, `slack` (that exact list is
  Tella's; trim it to what you run).
- **Denied tools** — every automation run hard-denies customer-facing and
  identity-mutating tools in `canUseTool` (`AUTOMATION_DENIED_TOOLS`,
  `src/server/automations.ts`): the Plain thread writes
  (`mcp__plain__reply_to_thread`, `mark_thread_done`, `mark_thread_todo`,
  `snooze_thread`) and the WorkOS write/impersonation set (create/delete/
  update user+org+membership, revoke, invitations, password-reset and
  verification emails, `get_impersonation_url`). Reads stay allowed;
  suggested customer replies go in an internal note.
- **Stripe money-moving tools** are a separate tier: in unattended runs
  they're denied with instructions to propose the action in the note; a human
  approves by opening the session ([integrations-misc.md](integrations-misc.md#stripe)).
- Automation runs also pass **no user**, so any MCP server restricted with
  `allowedUsers` is invisible to them (fail-closed), and their subprocess env
  is minimal — no tokens from `~/.opensession.env`.

## Internal-notes-in-English convention

Baked into the prompts (`src/agents/plain/prompts.ts` and
`triage-prompt.ts`): internal notes and draft replies are always written in
English regardless of the customer's language, with the customer's language
noted so the team can translate before sending. Keep the same rule in any
automation prompts you store in `~/.opensession-automations/`.

The triage/router prompts describe your product from `persona.company`,
`persona.product` and `persona.name` in `~/.opensession/config.json` — set
those and the prompts follow.
