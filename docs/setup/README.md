# OpenSession setup

Operator documentation for self-hosting OpenSession. Start at
[install.md](install.md); the other pages are per-integration and optional.

For a single-user, interactive-only installation on macOS, use the smaller
[local profile guide](../local-profile.md) instead.

## What it is

OpenSession is a self-hosted agent-infrastructure server. One Bun process serves:

- **A web UI** for creating and steering coding sessions (chats) that run
  against registered git repos, in isolated worktrees or Docker sandboxes.
- **Agents** that turn external events into sessions: Slack messages, Linear
  issues, Plain support tickets, GitHub PR review comments.
- **One engine** that actually runs the agent turns: OpenCode, with Claude
  subscription capacity via the bundled Meridian bridge and ChatGPT-OAuth
  OpenAI capacity ([engines.md](engines.md)).
- **Automations**: stored prompts triggered by events or cron, run with
  least-privilege tool scoping ([plain.md](plain.md) documents the flagship
  triage automation).

## Architecture sketch

```
                 ┌──────────────────────────────────────────────┐
 Slack ─────────►│                                              │
 Linear webhook ►│  opensession.ts (one Bun process)              │
 Plain webhook ─►│                                              │
 GitHub webhook ►│  web UI + WS ──► session store ~/.opensession-chats
                 │  agents (slack/linear/plain/github/stripe)   │
                 │  automations + schedulers                    │
                 │  runner layer ──► the engine:                │
                 │    opencode-runner (opencode serve)          │
                 │  each run: git worktree or Docker sandbox    │
                 └──────────────────────────────────────────────┘
   MCP servers (mcp-config.json) give runs their external tools
   (Linear, Plain, Stripe, WorkOS, Sentry, Tinybird, ...)
```

A second small HTTP server (the webhook server, default port 3848) receives
GitHub/Linear/Plain/Stripe webhooks; the main server (default 3850) serves the
UI and API at `/opensession/`.

## Minimum requirements

- A Linux box (Tella runs Ubuntu on EC2; nothing requires AWS — see
  [github.md](github.md) for the AWS-specific deploy pipeline, which is
  replaceable).
- [Bun](https://bun.sh) — runtime, package manager, and bundler. No Node/Vite.
  The installer brings its own; you only need it up front for a manual install.
- `git`, and the [`gh` CLI](https://cli.github.com) for PR operations.
- The `claude` CLI (Claude Code) — the Claude engine shells out to it
  (`OPENSESSION_CLAUDE_BIN`, default `/home/ubuntu/.local/bin/claude`).
- **Tailscale** — the recommended way to expose the UI at all. The installer
  installs it by default (`--no-tailscale` opts out); joining a network is a
  separate step that needs your account.
- Optional: **Docker** (sandboxed sessions —
  [self-hosting-sandboxes](../self-hosting-sandboxes.md)), **Caddy** (TLS for
  live previews), `opencode` binary (OpenCode engine), `whisper.cpp`/Groq/OpenAI
  key (voice dictation).

## Trust model (read this)

**By default there is no authentication.** OpenSession binds to `HOST` (default
`127.0.0.1`) and trusts everyone who can reach that address. The UI "user" is a
self-selected display name in localStorage — it drives attribution and per-user
tool gating, not access control. On a default install, **the bind address is the
security boundary**: put it behind Tailscale or an equivalent private network and
never expose it publicly. [networking.md](networking.md) covers how.

**Authentication is available, and it is opt-in.** Setting
`integrations.github` with `userPrAuth` and an OAuth client id activates GitHub
sign-in: every `/api/*` request and the UI WebSocket require a session cookie,
only logins listed in `identity.team` may sign in, and the verified identity
overrides any client-claimed user. Tella's own deployment runs with this on. See
[github.md](github.md#per-user-github-auth--web-sign-in).

Turning it on does **not** make the server safe to expose publicly. It protects
the UI and API; it does not change the fact that a session executes arbitrary
code on your machine. Keep the network boundary and treat sign-in as defence in
depth.

Inside that boundary, safety comes from least-privilege scoping of what *runs*
can do, enforced at the tool and environment layer rather than in prompts:

- automation runs — the ones processing untrusted text like customer tickets —
  get a minimal environment with none of your API tokens
- each automation carries an MCP-server allowlist, so a run only sees the tools
  it was granted
- customer-facing and identity-mutating tools are hard-denied for unattended runs
- money-moving tools are stripped from the model's tool list entirely
- the systemd unit and the sandbox host setup both block the cloud metadata
  endpoint, so agent code cannot mint cloud credentials

[extending.md](../extending.md#security-when-you-extend) has the rules to follow
when adding anything that touches this.

## Pages

| Page | Covers |
| --- | --- |
| [install.md](install.md) | installer → onboarding → env vars → config.json → accounts → systemd → health |
| [networking.md](networking.md) | **keeping it private** — Tailscale, SSH tunnels, verifying exposure |
| [ec2.md](ec2.md) | provisioning a clean EC2 box, networking, SSH debugging |
| [../../recipes/README.md](../../recipes/README.md) | bundled automation recipes, and what belongs in the repo |
| [slack.md](slack.md) | Slack app, token, scopes, event intake, admin gating |
| [github.md](github.md) | GitHub token, webhook server, PR agent, deploy pipeline |
| [linear.md](linear.md) | Linear OAuth app, webhooks, the Linear agent |
| [plain.md](plain.md) | Plain support tickets, the triage automation |
| [integrations-misc.md](integrations-misc.md) | Stripe, WorkOS, Grafana/Sentry/Tinybird, web push, voice |
| [engines.md](engines.md) | the OpenCode engine, accounts, model routing |
| [../self-hosting-sandboxes.md](../self-hosting-sandboxes.md) | Docker/Daytona/E2B/Box/Modal/AWS Lambda MicroVM sandboxes |
| [../nodes.md](../nodes.md) | attaching a Mac/Linux box as an execution node |
| [../worktrees.md](../worktrees.md) | how sessions map to git worktrees, and where the disk goes |
| [../clients.md](../clients.md) | web UI, PWA, Electron shell, Swift app, Chrome extension |
| [../extending.md](../extending.md) | MCP servers, recipes, integrations, providers, skills |
| [../portability-audit.md](../portability-audit.md) | what's still hardcoded (Tella-specific) |
