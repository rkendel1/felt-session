# Linear

The Linear agent (`src/agents/linear/`) turns Linear agent-session
assignments into OpenSession coding sessions: assign the app to an issue, it
creates a worktree, offers plan/implement, runs the work, and opens a PR when
implementation completes.

## Env vars

| Var | Required for | Notes |
| --- | --- | --- |
| `LINEAR_CLIENT_ID` | OAuth | your Linear OAuth app's client id (`src/agents/linear/oauth.ts`) |
| `LINEAR_CLIENT_SECRET` | OAuth | token exchange + refresh |
| `LINEAR_WEBHOOK_SECRET` | webhooks | HMAC verification is **fail-closed**: unset/empty secret means every webhook is rejected with 401, not accepted |
| `LINEAR_API_KEY` | optional | NOT used by the Linear agent itself — it's the Plain agent's fallback auth for creating/searching Linear issues when the OAuth token store is empty (`src/agents/plain/api.ts`) |

Disable the agent entirely with `ENABLE_LINEAR_AGENT=false` (default ON — see
[integrations-misc.md](integrations-misc.md#boot-guards)).

## OAuth app setup

Create an OAuth application in Linear (with agent/app-actor capability). The
code requests scopes `app:assignable read write` with `actor: "app"`
(`src/agents/linear/oauth.ts`).

Routes (on the [webhook server](install.md#webhook-server), port 3848 behind
your TLS proxy):

- `GET /oauth/authorize` — redirects to Linear's consent page
- `GET /oauth/callback` — token exchange; tokens are stored per-organization
  in `~/.linear-agent-tokens.json` (written atomically, auto-refreshed 5
  minutes before expiry)

The OAuth `redirect_uri` is derived, not hardcoded: it is
`integrations.linear.oauthRedirectUrl` if you set it, otherwise
`<server.publicBaseUrl>/oauth/callback`. Register whichever one applies on your
Linear OAuth app — they must match exactly, including the scheme and any
trailing path.

The stored OAuth token is also overlaid onto the `linear` MCP server config
at run time (`withDynamicCredentials` in `src/server/connections.ts`), so
sessions get authenticated Linear MCP tools from the same grant.

## Webhook intake

Point a Linear webhook at `POST /webhook` on the webhook server. Signature
header: `linear-signature` (HMAC-SHA256 of the raw body with
`LINEAR_WEBHOOK_SECRET`, timing-safe compare).

Consumed event types (`src/agents/linear/index.ts`):

- `AgentSessionEvent` / `AgentSession`:
  - `created` — creates an isolated worktree + session, replies with an
    elicitation (plan / implement / other)
  - `prompted` — routes to planning, implementation, or free-form runs;
    `signal: "stop"` aborts the current run
  - `dismissed` / `ended` — deletes the worktree and session state
- `Issue` (action `update`): when an issue with a stored plan moves to
  **In Progress**, implementation auto-starts; `IMPLEMENTATION_COMPLETE`
  produces a PR.

Everything else is acked and ignored. There are no hardcoded team or bot user
IDs — team ids are fetched per issue. Session state is persisted to disk so
in-flight Linear sessions survive restarts.

Worktrees are cut at `<paths.worktreesDir>/<repo>-<branch>` against whichever
repo the session resolves to, so nothing here is repo-specific.
