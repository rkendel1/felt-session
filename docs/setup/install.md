# Install: bare box to running service

## Fastest path: nothing to a first session

One prerequisite the installer cannot give you: **a model subscription** — a
Claude Max subscription for the Anthropic path, or a ChatGPT plan for the
OpenAI one. Sessions run on subscription capacity, not on a bundled key.

The tooling it does give you: the OpenCode engine plus the `claude` and `codex`
CLIs, which are how you mint an account token and how the in-app ChatGPT
sign-in works. Each is skipped if you already have it, and `--no-engine` skips
all three.

Then, end to end:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
# onboarding: accept the defaults — bind 127.0.0.1, press enter through the
# public base URL, point it at one repo, say no to every integration
claude setup-token     # on your Max login; copy the sk-ant-… it prints
opensession start
```

Now **open <http://127.0.0.1:3850>**. Add your account under Settings → Accounts
(paste the `sk-ant-…`, or use the ChatGPT device-code sign-in for the OpenAI
path), then pick your repo on the home screen, write a prompt, and create the
session. A turn that actually runs is the only proof the install works — a
health check is not.

Budget 5-15 minutes on a fresh box, most of it unattended: the installer
downloads Bun, the OpenCode engine and the two model CLIs, and installs a
multi-gigabyte dependency tree.

Sections 3-7 below — automations, the env-var inventory, the `config.json`
reference, MCP — are reference material you can skip on a first install, and
networking, TLS, GitHub and systemd are all optional for session #1. Come back
to them when the first session has run.

Prerequisites: Linux (or macOS), `git`, and `curl`. The installer brings its
own [Bun](https://bun.sh) and [OpenCode](https://opencode.ai). `gh`
(authenticated) is needed for pull-request operations. See
[README.md](README.md#minimum-requirements) for the optional extras.

Provisioning a fresh cloud box first? [ec2.md](ec2.md) — there is one
cloud-init trap worth knowing about.

## 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

This installs missing prerequisites, clones the source to
`~/.opensession/src`, installs dependencies, the engine and Tailscale, puts an
`opensession` command on your `PATH`, and runs the onboarding wizard. It is
safe to re-run: an existing install is fast-forwarded, and existing config is
backed up rather than overwritten.

Useful flags — `--dir <path>` to install elsewhere, `--channel <ref>` to track
a branch or tag, `--no-engine` to skip OpenCode, `--no-tailscale` to skip
Tailscale, `--yes` to accept defaults, `--uninstall` to remove it. `--help`
lists them all.

### Why Tailscale is installed by default

There is no authentication (see the
[trust model](README.md#trust-model-read-this)) — the bind address *is* the
access control. Installing the client up front means onboarding can offer your
tailnet address as the bind default, rather than the usual path: accept
`127.0.0.1`, discover later that a teammate cannot reach it, and reach for
`HOST=0.0.0.0`.

**Installing the client is not joining a network.** Nothing is exposed and no
account is touched; `tailscale up` is a separate, explicit step. To do that
part automatically too, set an [auth
key](https://tailscale.com/kb/1085/auth-keys):

```sh
TS_AUTHKEY=tskey-auth-... curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

Otherwise the installer prints the `sudo tailscale up` command and carries on.
Run it whenever you like, then `opensession onboard --force` to pick up the
address. Full walkthrough: [networking.md](networking.md).

### Doing it by hand

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession && bun install
bun run setup
```

If you plan to use self-development (sessions that modify Open Session itself —
see [../self-development.md](../self-development.md)), clone **your own fork**
instead and add this repo as `upstream`: self-sessions push to `origin`, which
must be a remote you can write to.

```sh
git clone https://github.com/<you>/opensession.git
cd opensession
git remote add upstream https://github.com/tellahq/opensession.git
bun install && bun run setup
```

With that in place, `opensession update` pulls upstream releases into your
fork (merging over your own commits when needed) and restarts through the
health-gated deploy path.

Nothing depends on the checkout living in a particular place — the CLI derives
paths from wherever it is running, and onboarding writes the rest into
`~/.opensession/config.json`. If you skip onboarding, the default mcp-config
path is `<checkout>/mcp-config.json` (`src/server/config.ts`) and the checkout
registers *itself* as a repo.

## 2. Onboarding

`opensession onboard` asks for the bind address and port, your public base
URL, your first repository, and which integrations to turn on. It writes:

| File | What |
| --- | --- |
| `~/.opensession/config.json` | instance config — re-read on change, no restart |
| `~/.opensession.env` | secrets and feature flags, `0600` |
| `~/.opensession/opensession.service` | systemd unit templated for this box |
| `~/.opensession-opencode.json` | engine config — created as `{"enabled": true}` when absent, so the Anthropic bridge is on out of the box ([engines.md](engines.md)) |

Re-run it any time with `opensession onboard --force`; the previous files are
backed up to `.bak-<n>` first.

Then check the result:

```sh
opensession doctor
```

It reports missing tooling, unparseable config, an integration that is enabled
but missing a required credential, a service that is installed but dead, and
whether anything is actually listening. Sections below are the reference for
what it is checking.

## 3. Automations (optional)

A fresh install runs nothing on its own. The repository ships a few generic
starting points:

```sh
opensession automations              # what is available
opensession automations add github-pr-review
opensession restart                  # created on the next boot, disabled
```

`github-pr-review` is the highest-leverage one — a lot of other workflow hangs
off having every PR reviewed automatically. `instance-health` watches this
install's own disk, memory and liveness. Both are offered during onboarding.

Recipes arrive **disabled**: read the prompt, adjust it for your codebase, then
enable it in the UI. Adding one appends to `integrations.seeds.automations` in
your config, and seeding is create-if-absent, so your edits are never
overwritten by a later restart.

Anything specific to your company — your product, customers, people, playbooks
— belongs in that config section rather than in the repository. See
[recipes/README.md](../../recipes/README.md) for the line and for how to write
your own.

## 4. Secrets: `~/.opensession.env`

Bun auto-loads a `.env` in the working directory for manual runs; the
systemd unit (`opensession.service`) instead loads `~/.opensession.env` via
`EnvironmentFile=` (the path is rendered for your box by
`opensession service install`). Use that as your single secrets file.

Everything is optional in the sense that the server boots without it — but
integrations degrade (or must be disabled) without their vars. Inventory of
what the code actually reads, by feature:

**Core server**

| Var | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | bind address for the main server. Bind to a Tailscale IP to share it with your team — there is no auth layer (see the [trust model](README.md#trust-model-read-this)) |
| `PORT` | `3850` | main server (UI + API at the server root) |
| `WEBHOOK_PORT` | `3848` | second HTTP server for inbound webhooks |
| `OPENSESSION_UI_BASE` | `http://127.0.0.1:<port>` | public base URL used in links posted to Slack/Linear/notes |
| `OPENSESSION_CONFIG` | `~/.opensession/config.json` | config-file path override |
| `SHUTDOWN_DRAIN_MS` | `60000` | graceful-shutdown drain window for in-flight runs |
| `OPENSESSION_SESSIONS_DIR` | `~/.opensession-sessions` | session store override (mostly a test seam) |
| `OPENSESSION_WORKTREES_DIR` | `~/.opensession/worktrees` | where session worktrees are created |
| `OPENSESSION_DEV` | unset | `1` = dev frontend build only; does NOT disable agent loops (a second naive instance double-sends) |

**Engines and models** (details: [engines.md](engines.md))

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENSESSION_CLAUDE_BIN` | `claude` found on `PATH` | Claude Code CLI the Meridian bridge spawns for Anthropic models |
| `OPENSESSION_CLAUDE_ACCOUNTS_PATH` | `~/.opensession-claude-accounts.json` | Claude account store override |
| `OPENSESSION_OPENCODE_BIN` / `OPENSESSION_OPENCODE_CONFIG` | see engines.md | OpenCode binary / config path |
| `OPENSESSION_MODEL` | `claude-fable-5` | default model (below the UI override file) |
| `OPENSESSION_FALLBACK_MODEL` | unset | global fallback model; `none` disables |
| `OPENSESSION_MCP_CONFIG` | `<checkout>/mcp-config.json` | MCP config path override |
| `SUGGEST_BRANCH_MODEL`, `NOTE_EDIT_MODEL`, `DRAFT_AUTOMATION_MODEL` | `claude-haiku-4-5` | per-feature cheap-task models |

**Linux systemd resource controls** — detached engines default to
`MemoryHigh=6G`, `MemoryMax=12G`, `MemorySwapMax=1G`, and `TasksMax=1024`;
host previews default to 8G/12G/1G/768 plus `CPUQuota=600%`. Tune them with
`OPENSESSION_ENGINE_MEMORY_HIGH`, `OPENSESSION_ENGINE_MEMORY_MAX`,
`OPENSESSION_ENGINE_SWAP_MAX`, `OPENSESSION_ENGINE_TASKS_MAX`, and the matching
`OPENSESSION_PREVIEW_*` variables (`MEMORY_HIGH`, `MEMORY_MAX`, `SWAP_MAX`,
`TASKS_MAX`, `CPU_QUOTA`). Limits cover the whole transient scope, including
agent-started compilers, MCP proxies, and dev servers—not only `opencode`.

**Integrations** — each has its own page with the full list:

| Feature | Vars | Page |
| --- | --- | --- |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ALLOWED_SLACK_USER_ID`, `WORKTREE_HOOK_SECRET`, `SLACK_MENTION_INTENT_MODEL`, `SCHEDULE_WHEN_MODEL` | [slack.md](slack.md) |
| GitHub | `GITHUB_API_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_LOGIN`, `GITHUB_MENTION_HANDLES` | [github.md](github.md) |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY` | [linear.md](linear.md) |
| Plain | `PLAIN_API_KEY`, `PLAIN_WEBHOOK_SECRET`, `PLAIN_*_MODEL` ×2 | [plain.md](plain.md) |
| Stripe | `STRIPE_WEBHOOK_SECRET` | [integrations-misc.md](integrations-misc.md#stripe) |
| Grafana | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `LOKI_DATASOURCE_UID` | [integrations-misc.md](integrations-misc.md#grafana-poller) |
| Voice | `OPENAI_API_KEY`, `GROQ_API_KEY`, `WHISPER_CLI`, `WHISPER_MODEL` | [integrations-misc.md](integrations-misc.md#voice--transcription) |
| Sandboxes | `E2B_API_KEY`, `DAYTONA_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `OPENSESSION_SANDBOX_CONFIG` | [self-hosting-sandboxes](../self-hosting-sandboxes.md) |
| AWS runs | `AGENT_AWS_REGION` | [integrations-misc.md](integrations-misc.md#aws-creds-for-runs-agent_aws_region) |
| Previews | `PREVIEW_HOST` | Caddy-fronted live previews (`src/server/preview.ts`) |

**Feature flags** — `ENABLE_SLACK_AGENT`, `ENABLE_LINEAR_AGENT`,
`ENABLE_PLAIN_AGENT`, `ENABLE_GITHUB_AGENT`, `ENABLE_STRIPE_AGENT`,
`ENABLE_GRAFANA_POLLER`. All **default OFF**; only the literal string `true`
enables (not `1`). The env flag wins when set, otherwise
`integrations.<id>.enabled` decides — see
[integrations-misc.md](integrations-misc.md#boot-guards).

Not for operators: `OPENSESSION_RPC_*` / `OPENSESSION_RUN_WS_*` / `OPENSESSION_MCP_SERVER` (set by
Open Session for its own runner-host/MCP-proxy subprocesses), and
`OPENSESSION_FORCE_LIMIT` / `OPENSESSION_RUN_JOURNAL` (dev/test seams).

Note: agent subprocesses do **not** inherit this env file — runs get a
minimal env (PATH, HOME, LANG, OPENSESSION_MODEL) by design, and MCP servers
carry their own credentials (`src/server/runner-shared.ts`).

## 5. `~/.opensession/config.json`

Instance config for everything that isn't a secret: server ports/URLs,
binary paths, the **repo registry**, the **team identity table**, persona
and branding. Copy [`config.example.json`](../../config.example.json) to
`~/.opensession/config.json` and edit. Every field is optional; precedence per
key is env var → config.json → built-in default (`src/server/config.ts`).
The file is re-read on change — no restart for config edits.
See [instance configuration](../instance-configuration.md) for the portability
boundaries and the client-distribution settings.

The two sections a team install normally sets:

- `repos` — your git repos (checkout path, `defaultBranch`, `ghRepo`
  owner/name for the `gh` CLI, `default: true` on the main one, optional
  `depsInstall`/`previewCommand`, preview cache markers, deployment tracking,
  and security-scan guidance). When `repos` is present it is authoritative.
  With no config, a source checkout registers itself as the shared
  `opensession` repo.
- `identity.team` — your people (name, email, aliases, `slackId`, `github`,
  `linearEmails`). Drives commit attribution, per-user MCP `allowedUsers`
  gating, and human-ask routing. Omitting it leaves the roster empty and makes
  identity-dependent features no-op.

Integrations are opt-in with `integrations.<name>.enabled`. The optional
`integrations.seeds` section can create deployment-owned actions and
automations without putting company playbooks in application source.
`policy`, `persona`, and `branding` are applied at runtime; frontend branding,
the default repo id, public URL, and GitHub bot identities are injected into
the SPA bootstrap.

## 6. Engine accounts

At minimum add one Claude account or the default engine has nothing to run
on:

```sh
claude setup-token   # on a Claude Max login; prints sk-ant-…
```

Accounts are added in the web UI under **Settings → Accounts** — which means
this step happens *after* [section 8](#8-first-run): the server has to be
running before you can paste anything into it. Mint the token whenever you
like, start the server, then paste it. (The same page signs in ChatGPT-plan
logins by device code.)

The alternative, if you would rather have accounts in place before the first
boot, is to create `~/.opensession-claude-accounts.json` by hand — file
shapes, account picking, Codex accounts
(`~/.opensession-codex-accounts.json`), and OpenCode config are documented in
[engines.md](engines.md).

## 7. `mcp-config.json`

MCP servers give runs their external tools. Copy
[`mcp-config.example.json`](../../mcp-config.example.json) to
`mcp-config.json` in the repo root (or point `OPENSESSION_MCP_CONFIG`
elsewhere). Per server: `{ "type": "http", "url": … }` or
`{ "command": …, "args": [], "env": {} }` — credentials go in the server's
own `env` block or URL, never the process env. Two Open Session-specific
fields:

- `allowedUsers: ["Alice", "alice@example.com"]` — optional per-user gate;
  only runs whose user matches (through the identity table) see the server.
  Automation runs have no user, so restricted servers are invisible to them
  (fail-closed). Stripped before the config reaches the SDK.
- The `linear` server gets the Linear agent's OAuth token overlaid at run
  time ([linear.md](linear.md)).

Manage servers later from the Connections UI. **Changing the runner-layer
filtering code requires a restart; editing mcp-config.json itself is read
fresh per run.**

## 8. First run

```sh
opensession start --foreground     # or just `opensession start`
# UI at http://127.0.0.1:3850/
curl -s http://127.0.0.1:3850/api/health
```

Health returns `{ ok, bootId, frontendVersion, uptime, activeRuns, agents }`
— `agents` includes per-agent status and what's missing (e.g. "missing
GRAFANA credentials"). The drain-aware deploy polls `activeRuns` to restart
when idle.

## 9. Running it as a service

```sh
opensession service install     # renders the unit for this box, then enables it
opensession status
opensession logs -f
```

On Linux that installs a systemd unit (needs sudo). On macOS it installs a
per-user **LaunchAgent**, which needs no root at all.

The repo's `opensession.service` is a **template**, not a file to install
verbatim — it carries one deployment's user, checkout path and bun path.
`opensession service install` rewrites those for your box. The username is
resolved and then verified to exist: `os.userInfo()` returns the literal string
`"unknown"` under some non-login shells, and a unit containing `User=unknown`
installs happily and then fails every start with `status=217/USER`.

On Tella's own deployment the unit is a copy, not a symlink — after editing the
repo's `opensession.service`, re-`cp` and `daemon-reload` (deploy.sh does this
automatically).

Unit choices worth knowing (comments in the file itself):

- `ExecStart=bun run opensession.ts` — stable production runtime, see below.
- `EnvironmentFile=<your home>/.opensession.env` — your secrets file (the
  path is stamped in by `opensession service install`).
- `TimeoutStopSec=80` — must stay above `SHUTDOWN_DRAIN_MS` (60s) plus
  buffer, or systemd SIGKILLs mid-drain.
- `KillMode=mixed` — SIGTERM hits only the bun parent so it can drain
  in-flight runs; the default control-group mode would kill the Claude
  children instantly and defeat the run journal.
- `IPAddressDeny=169.254.169.254/32` — blocks the EC2 metadata endpoint for
  the whole service cgroup (untrusted agent text must not mint cloud
  credentials). Harmless off-cloud.
- `User`, `WorkingDirectory`, `EnvironmentFile`, `ExecStart` and `PATH=` are
  rewritten per box by `opensession service install`; the values checked into
  the repo are Tella's.

## 10. Frontend rebuilds vs restart

The production unit intentionally does not use `bun --hot`: failed backend
reloads on Bun 1.3.14 can permanently stop timer delivery while HTTP remains
healthy. The in-process frontend watcher still rebuilds frontend edits live.
All backend changes need `opensession restart` after commit and push.
Restarts are graceful: detached engine turns survive and the run journal
reattaches them on boot, but they still churn active sessions, so restart once
after the backend change rather than after every save.

## 11. Next

- Wire up integrations: [slack.md](slack.md), [github.md](github.md),
  [linear.md](linear.md), [plain.md](plain.md),
  [integrations-misc.md](integrations-misc.md). Inbound webhooks all land on
  the webhook server — see below.
- Sandboxed execution: [../self-hosting-sandboxes.md](../self-hosting-sandboxes.md).

## Webhook server

One detail every integration page references: `src/server/webhook-server.ts`
runs a second `Bun.serve` on `127.0.0.1:${WEBHOOK_PORT}` (default 3848).
Agents register their own routes on it (`/slack/events`, `/slack/actions`,
`/github/webhook`, `/webhook` (Linear), `/plain/webhook`, `/stripe/webhook`,
`/oauth/*`, `/worktree/*`). It's loopback-only: you need a TLS-terminating
reverse proxy on a public hostname in front of it (Caddy works well) for
Slack/GitHub/Linear/Plain/Stripe to reach it. All
signature checks are HMAC-SHA256 and fail-closed — a missing secret rejects
everything rather than letting it through.
