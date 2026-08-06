# Self-development: working on Open Session with Open Session

Open Session can develop itself: open a session on the `opensession` repo, edit
the server, and press **Preview** to boot your edited code as an isolated dev
instance next to the one you are using. This doc explains the pieces and their
boundaries.

## The dev instance

A dev instance is `bun run opensession.ts` with:

- `OPENSESSION_DEV=1` — historically this only swapped the frontend pipeline:
  serve the UI through Bun's HMR dev server instead of the prebuilt
  `.frontend-dist` bundle. It gated nothing on the backend. With the dev boot
  gate, `OPENSESSION_DEV=1` additionally skips every boot side effect that
  talks to the outside world or to shared state: integration agents
  (Slack/Linear/Plain/GitHub/Stripe/Grafana), the webhook server, the cron
  automation scheduler and all background tickers/sweeps, the public-ingress
  listener, detached-engine-server adoption, run resume/redelivery, and the
  seed writes to automations/actions. What remains is the web server, the
  session store, and the UI.
- `OPENSESSION_DEMO=1` — demo mode: the instance seeds generated demo
  sessions/transcripts into its (empty) state dir so the UI has something to
  show without real history. (Forthcoming; until the generator lands a demo
  instance simply starts empty.)
- `OPENSESSION_STATE_DIR=<dir>` — root for all instance state. Everything
  that defaults to `~/.opensession-*` (sessions, config, automations, sandbox
  config, the run-rpc unix socket, …) resolves under this dir instead, so a
  dev instance never reads or writes the operator's live stores.

None of these flags change anything when unset: an unflagged boot is
byte-identical to today's behavior.

## Previewing your own change

The Preview button uses the repo's own lifecycle scripts, the same convention
every other repo uses ([repo-lifecycle.md](repo-lifecycle.md)):

- `.opensession/setup.sh` — one-shot per worktree: `bun install
  --frozen-lockfile`. Safe to re-run.
- `.opensession/start.sh` — boots the dev instance in the foreground on
  `$WEBAPP_PORT`, loopback only, with the three flags above and
  `OPENSESSION_STATE_DIR=$PWD/.dev-state`.

Flow: press Preview in an opensession session → the running server allocates a
port (3100–3999), runs `setup.sh` once, then `start.sh` detached with cwd =
the session's checkout → Caddy fronts the port at
`https://<host>:<port+6000>` (the `PREVIEW_URL` in the button). Stop kills the
script's process group, which kills the instance because `start.sh` `exec`s it.

`start.sh` is deliberately paranoid: the environment it inherits is the
calling server's production env (ports, agent toggles, secrets), so it
overrides or unsets every operationally significant variable rather than
inheriting anything — the production port is explicitly refused. Read the
comment block in the script for the variable-by-variable rationale.

`.dev-state/` (plus the preview flow's `.ports.conf` / `.ports/`) appears in
the checkout the preview ran from; it is disposable and must stay gitignored.

## What a dev instance does NOT cover

Live integrations are out of scope by design. A dev instance has no Slack,
Linear, Plain, Stripe, Grafana, or GitHub agents, receives no webhooks, runs
no cron automations, and never adopts or spawns detached engine servers. You
cannot use it to test "did my change fix the Slack agent" end-to-end — that
class of change is verified by tests plus a real deploy. Engine runs (actually
chatting inside the dev instance) depend on engine credentials and are best
treated as untested from a preview.

## Deploying your change: `deploy_self` and the canary

The complement of previews is the `opensession-self-deploy` in-process MCP
server (interactive sessions only, never automations, never dev instances):
`deploy_self({ sha?, confirm: true })` launches `deploy/self-deploy.sh` as a
transient system unit — so the sequence survives the restart it triggers —
which fetches, fast-forwards the checkout (ff-only; aborts loudly on a dirty
or diverged tree), records the pre-deploy HEAD as a last-known-good pin,
restarts the service, and health-gates the result (3 consecutive `/api/health`
successes from the same `bootId`). On failure it rolls back to the pin —
rewriting the tree only when it is clean AND `OPENSESSION_DEPLOY_ALLOW_RESET=1`
is set (meant for a dedicated deploy-only checkout; on a live shared checkout
it instead records `rollback-needed` and leaves the tree for a human).
`deploy_status({})` reads the pin, the last result, and the watchdog window.

Prerequisites — **your own remote first**: self-sessions commit and push to
`origin`, and `deploy_self` fast-forwards from `origin/main`. If your checkout
was cloned straight from `tellahq/opensession`, every push is rejected (you
can't write to our upstream) and, after your first local commit, ff-only
deploys abort permanently because your history has diverged from ours. Clone
your **fork** (keep `tellahq/opensession` as an `upstream` remote to pull our
updates), and in worktree mode set the self repo's `ghRepo` in your config to
the fork so the PR flow targets it. Beyond that, the service user needs
passwordless sudo for `systemctl restart <service>` and `systemd-run`.

Staying current is one command: **`opensession update`** detects the fork
topology (origin = your fork + an upstream remote), fetches upstream, merges
it into your branch (an honest merge commit — never a rebase; conflicts abort
cleanly back to your tree), pushes the result to your fork, reinstalls deps,
and restarts through the same health-gated deploy path as `deploy_self` — the
pre-update commit becomes the rollback pin, so an upstream release that
doesn't come up healthy on your instance rolls back under the same rules.
`opensession update --check` previews what it would pull without changing
anything. The optional watchdog —
`deploy/systemd/opensession-watchdog.{service,timer}` — probes health every
60s but only ever acts inside a 15-minute window after a self-deploy restart,
after 3 consecutive failures, at most once per deploy. Install it with:

```bash
sudo cp deploy/systemd/opensession-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now opensession-watchdog.timer
```
