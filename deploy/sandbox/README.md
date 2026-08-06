# `opensession-runner` image

Prebaked container image for the **Docker sandbox provider** (operator guide:
`docs/self-hosting-sandboxes.md`). One container per session runs the
existing runner-host entry inside an isolated filesystem/env/network, with the
session's git worktree **bind-mounted at its identical host path**.

## What it contains

| Component | Purpose | Pin |
| --- | --- | --- |
| `bun` | runs the runner bundle + Bun `$` exec | `1.3.14` (host) |
| Node.js LTS | native-dep builds, tooling | `24.x` |
| `git`, `gh` | clone / status / diff / push / PR | apt latest |
| `ripgrep` | @-mention file search | apt |
| `python3`, `build-essential` | worktree `bun install` native deps | apt |
| `just`, `direnv`, `lsof` | common repo dev-server bring-up chains (in-sandbox previews) | apt / pinned release |
| Claude Code CLI | baked at the identical host CLI path for session-resume parity | `2.1.218` (host); build FAILS on version mismatch |
| `opencode` | the engine — runs in-sandbox | `1.17.15` (host), npm -g, build asserts version |
| runner bundle | `/home/ubuntu/projects/opensession` (`src/`, `opensession.ts`, `tsconfig.json`) + `node_modules` | from lockfile |
| minimal `~/.claude/settings.json` | so `settingSources:["user"]` doesn't error | `{}` |

Runs as uid **1000** user `ubuntu` (matches the host uid) so bind-mounted
worktrees keep sane ownership. Default `CMD` is `sleep infinity` — the provider
starts the container long-lived and `docker exec`s runs into it; there's no
baked ENTRYPOINT.

## Why path parity matters

The runner config points at host absolute paths: the claude CLI at
`/home/ubuntu/.local/bin/claude`, the runner bundle at
`/home/ubuntu/projects/opensession`, and the session worktree
bind-mounted at its **same** host path. The image reproduces every one of those
absolute paths exactly. If any drifts, the in-container runner can't find the
CLI, its dependencies, or the worktree. Do not "tidy" these paths — and if your
host's username/home/checkout path differs, edit them in the Dockerfile and
rebuild (see docs/self-hosting-sandboxes.md "Path parity is load-bearing").

## Build

```sh
deploy/sandbox/build.sh
```

Tags `opensession-runner:latest` and `opensession-runner:<git-sha>` from the repo
root context. Override the name with `IMAGE=... deploy/sandbox/build.sh`.

Version pins are `ARG`s in the Dockerfile (`BUN_VERSION`, `CLAUDE_VERSION`,
`NODE_MAJOR`, `OPENCODE_VERSION`) — override per build with `--build-arg` if
needed.

## Runtime design (Phase 1 — DockerProvider)

`src/server/sandbox/docker.ts` runs one container per session
(`bks-sbx-<sessionId>`, labels `opensession.sandbox=1` +
`opensession.session=<id>`, `--init`, `--restart no`, `--cpus`/`--memory` from
`~/.opensession-sandbox.json`, defaults 4 / 8g). A run is the same runner-host
entry the systemd path uses (`src/runner-host/host.ts`), `docker exec -d`'d
into the container; its unix socket + spec/meta/journal/log live in a
bind-mounted per-session run dir (`~/.opensession-sessions/sandbox-runs/<id>`), so
the server drives it with the normal HostHandle machinery and can reattach
after a restart. Idle containers are `docker stop`ped after
`idleStopMinutes` (default 30) and restarted on the next turn.

Mounts (rationale in the docker.ts header):

| Mount | Mode | Why |
| --- | --- | --- |
| named vol → `~/.claude`, `~/.codex` | rw | engine session state survives; NEVER a volume at `/home/ubuntu` (would shadow the baked CLI + bundle) |
| session worktree at identical path | rw | diff/files/status/push/preview unchanged host-side |
| main checkout `.git` at identical path | rw | worktrees aren't self-contained (`rev-parse --git-common-dir`); accepted Phase 1 tradeoff |
| host `~/.claude/projects/<munged-cwd>` | rw | engine transcripts stay host-visible (viewer tail, resume continuity) |
| `~/.opensession-sessions/opensession-rpc.sock` | rw | opensession-* stdio proxies (socket filename kept for protocol compat); goes stale across a server restart until the container restarts |
| `~/.ssh`, `~/.gitconfig`, `~/.config/gh` | ro | git push / PR parity — interactive-level ambient trust, same as host runs today; automations are refused in Phase 1 |
| `mcp-config.json`, `~/.opensession-claude-accounts.json` | ro | external MCP servers + in-container account-pool selection |
| `~/.opensession-audit` | rw | one audit jsonl stream for host + sandboxed runs |

Known Phase 1 caveats: external MCP servers now spawn inside the container
(host-only deps won't start); native Codex account homes are never mounted —
the capability matrix keeps GPT (Codex) runs host-only, and GPT-in-a-sandbox
goes through `opencode/openai/*` models; `aws: true` can't mint creds inside
(IMDS blocked).

## Phase 2 — exec-routed surfaces, volume workspaces, preview ports

- **workspace-exec choke point** (`src/server/sandbox/workspace-exec.ts`):
  @-mention file search, the Changes diff/discard, and git status/pull/push
  take an optional exec from `workspaceExecFor(session, dir)` — host Bun `$`
  unless the session's sandbox is ACTIVE (materialized + config docker +
  kill-switch absent + container **running**; a stopped container is never
  started for a read). With bind mounts this is redundant by design — it's
  the seam volume workspaces and Phase 3 remote providers run through.
- **Volume workspaces** (`~/.opensession-sandbox.json` → `"workspace":
  "volume"`, default `"bind"`): new sandboxes whose canonical worktree path
  has no host dir get a per-session `<name>-ws` volume mounted at that path
  and cloned **inside** the container from the repo's origin (ro-mounted
  creds do the auth; a local-path origin is mounted ro — that's the verify
  suite's scratch case). No host worktree is created at all; the mode is
  sticky per sandbox (state file), and the session records
  `sandbox.workspace: "volume"`. **Contract: `destroy()` (session delete,
  archive sweep) deletes the workspace volume — un-pushed work is gone.
  Push your work.** While the container is idle-stopped, the read surfaces
  go quiet (empty diff/status) rather than waking it. Attached repos and
  sibling chats are rejected for volume-mode sessions.
- **Attached repos (bind mode)**: `attachedRepos[].dir` + each repo's common
  `.git` are now bind-mounted rw at identical paths; changing the attach set
  recreates the container on the next ensure (mounts are create-time).
- **Preview ports** (`"previewPorts": [3300, …]`, default `[3300, 3301,
  3302]`): each container port in the set is published to a random
  **loopback** host port at container create; `sandbox.ports()` reads the
  live map and preview.ts routes the same Caddy tailnet-HTTPS front at the
  published port. In-container dev-server start is gated behind
  `"devServerInSandbox": true` (default off); without it, preview start is a
  no-op and only status/ports/Caddy routing are active. See "Previews in
  sandboxes" below for the full Phase 4A flow (port namespace, lifecycle
  scripts, `.tunnels.env`).

## Previews in sandboxes (Phase 4A)

The session Preview button works for sandboxed sessions: `startSandboxPreview`
(preview.ts) brings the dev server up INSIDE the container and fronts it with
the same Caddy tailnet-HTTPS origin as host previews.

**HTTPS-port namespace (the old collision TODO, fixed).** Host previews key
their Caddy route as `webappPort + 6000` (9100-9999) — safe on the host
because a host-side port allocator can enforce webapp-port uniqueness with
lsof, but blind to container netns: a sandbox and a host session (or two
sandboxes) can hold the same webapp port number. Sandbox routes therefore use
a dedicated allocated range **[20000, 28000)**, keyed by
`(sandboxId, containerPort)` and persisted in
`~/.opensession-sessions/sandbox-preview-ports.json`
(src/server/sandbox/preview-ports.ts): host-vs-sandbox collisions are
impossible by range disjointness, sandbox-vs-sandbox by the allocator's
uniqueness probe. Allocations survive restarts/recreations (stable preview
URL) and are released by `destroy()`.

**Pre-published port range.** Docker port publishing is create-time-only, so
every sandbox container publishes the `previewPorts` set (default 3 ports,
3300-3302) at create. `startSandboxPreview` picks the worktree's existing
`.ports.conf` WEBAPP_PORT when it's one of them, else the first published
port nothing listens on, and seeds/rewrites `.ports.conf` so the dev flow
adopts it (a repo dev script that sources an existing `.ports.conf` and keeps
free ports will keep ours — inside the fresh netns they always are). **Range
exhaustion** (every published port busy) refuses to start; the fallback is
widening `previewPorts` in `~/.opensession-sandbox.json` and letting the
container be recreated (stop it or change the attach set — mounts/ports are
create-time).

**Bring-up resolution (repo-local lifecycle scripts, background-agents
convention).** ONE chain — `resolvePreviewBoot` in preview.ts — shared by
sandboxed AND host previews (the Preview button on a plain non-sandboxed
session resolves identically; only the existence checks and process plumbing
differ):

1. `<worktree>/.opensession/start.sh` when present — a script committed IN
   the target repo (`.backstage/` is honored as the pre-rename fallback; when
   both dirs exist, `.opensession/` wins and the setup sibling is taken from
   the same dir). Run detached with `WEBAPP_PORT` (the allocated port —
   pre-published container port in sandboxes, a free host port for host
   previews, seeded into `.ports.conf` either way), `PREVIEW_URL`, and
   `OPENSESSION_BOOT_MODE` (`fresh` | `snapshot-restore`; host previews always
   say `fresh`) in its env. It should bring the dev server up on
   `$WEBAPP_PORT` (exec your server so stop's process-group kill reaches it).
2. else the repo's configured `previewCommand` (an instance-config `repos`
   entry — e.g. a repo-specific ensure-up script kept outside the repo),
   invoked with the worktree path as `$1`. A configured absolute path that
   doesn't exist in the current environment (e.g. a host path the sandbox
   image doesn't carry) is skipped instead of failing.

No rung resolves → the status reports `bootable: false` and the UI renders a
disabled Start explaining what to add. Host previews additionally inject the
short-lived instance-role AWS creds from aws-creds.ts into the bring-up: the
service cgroup denies IMDS (IPAddressDeny) for every child, which otherwise
breaks bring-ups that need AWS access (e.g. an `aws` preflight or an
S3-backed prebuilt-artifact install).

`<worktree>/.opensession/setup.sh` is the sibling one-shot hook: it runs once
per workspace materialization (first ensure of the sandbox, cwd = workspace,
same `OPENSESSION_BOOT_MODE` env), is **skipped on snapshot restore** (the
restored container layer already carries its effects), is never retried once
settled (log: `~/.opensession-sessions/sandbox-runs/<session>/workspace-setup.log`),
and never blocks the session on failure. Keep both scripts convention-level:
no framework, no arguments beyond env. Host previews honor setup.sh too, with
one asymmetry: there is no workspace-materialization moment on the host, so it
runs (and settles, success or not) as part of the FIRST repo-script preview
start, stamped per worktree under `<chats-dir>/preview-setup/` (SETUP_STAMP_DIR
in preview.ts).

**`.tunnels.env` contract** (adopted from background-agents): when a preview
starts, Open Session writes `<worktree>/.tunnels.env` — dotenv, consumable by
in-container dev processes:

```
PREVIEW_URL=https://<host>:<httpsPort>     # the primary (webapp) URL
PREVIEW_URL_<containerPort>=https://…      # one var per exposed port
```

Stale files are removed whenever ensure() (re)starts the container and on
preview stop; each start rewrites the file whole. It's kept out of session
diffs via the repo's `.git/info/exclude`.

**External `previewCommand` scripts in-container.** When a repo's configured
`previewCommand` is an absolute path outside the repo, its directory is
mounted read-only at its identical path in every sandbox
(`externalPreviewCommandDirs` in preview.ts), so the same bring-up script
works host-side and in-sandbox. The image bakes the common dev-chain deps
such scripts tend to need — bash/coreutils/curl/python3/git, plus `just`,
`direnv` (`direnv exec . just dev` chains) and `lsof` (port probes).
Deliberately NOT installed: the **aws CLI** and heavyweight backing services
(Postgres/Redis-class daemons are out of image scope — the dev server points
at whatever its bind-mounted env files point at, seeded host-side). Caveat:
anything in the bring-up that needs cloud credentials fails inside the
container (minimal env, IMDS blocked). Example from Tella's setup: their
webapp's prebuilt-WASM S3 install has to run host-side once per worktree
(any host preview does it) before an in-sandbox bring-up can rely on it.

**Post-prompt snapshots.** When `snapshots.enabled`, a successfully completed
sandboxed run schedules a `docker commit` snapshot (same helper as the
idle-stop path; deduped, delayed past the run-teardown busy window) — the
background-agents "snapshot after every turn" warm-restore behavior.

## Terminals in sandboxes (Shell tab)

The session viewer's **Shell tab** (xterm.js ↔ server-side PTY over the
tailnet-gated session WS — `src/server/terminals.ts`) is sandbox-aware:
`startSessionTerminal` lands the PTY where the session's work actually
happens.

- **Docker**: `docker exec -it -w <workspace> <container> bash -il` under the
  host PTY. Works for bind AND volume workspaces (volume ones have no host
  copy at all). Opening a terminal is an interactive gesture, so unlike the
  read surfaces it **wakes a stopped container** (`docker start` first) and
  resets the idle-stop clock; an idle-stop while a shell is open simply ends
  it (`term_exit` in the tab) — reopen to wake again. Works on every existing
  container: no image change, no published port, no Caddy route.
- **Daytona**: a host `ssh` through Daytona's SSH gateway — `createSshAccess`
  mints a per-shell token (`ssh <token>@ssh.app.daytona.io`, 12 h expiry)
  that is **revoked the moment the shell closes**. Host keys aren't pinned
  (their gateway fronts rotating infra); the token is the authentication.
  Works against a bare, un-bootstrapped sandbox — the terminal needs no
  runner payload.
- **Anything else / any failure** (kill-switch, gone container, provider
  unconfigured, e2b): host login shell in the worktree with a dim fallback
  notice — the pre-sandbox behavior.

Deliberately NOT ttyd-in-the-sandbox: both providers already have an
interactive exec transport that plugs into the existing PTY plumbing, so the
browser only ever speaks the existing tailnet- + team-gated session WS — no
extra HTTPS listener, no basic-auth credential to store, no public-ish
preview-domain URL, no preview-port slot consumed, and no image rebuild /
container recreation to roll it out. The UI signals where a shell landed via
`term_ready` (dim `[shell inside docker sandbox — <cwd>]` banner).

Terminal code is reached through the server's WebSocket handlers
(`src/server/ws-handlers.ts`), which do NOT hot-apply — a real restart is
needed after changing it.

## Phase 3 — WS transport + remote adapters

- **WS transport** (`~/.opensession-sandbox.json` → `"transport": "ws"` +
  `"callbackBaseUrl": "ws://<reachable-host>:3850"`): the in-sandbox run host
  DIALS OUT to the server's `/opensession/run-ws/<hostId>` route (token-authed,
  same NDJSON protocol, one JSON message per WS text frame) instead of
  serving a unix socket, and the opensession-* MCP proxies dial
  `/opensession/rpc-ws`. Docker containers created in ws mode don't mount the
  rpc socket. `callbackBaseUrl` must be reachable FROM the sandbox (Tailscale
  URL for self-hosters; 127.0.0.1 never works). For remote providers that
  means the PUBLIC internet: enable the isolated `publicIngress` listener
  (src/server/public-ingress.ts — serves ONLY run-ws/rpc-ws + a health
  check, rate-limited; see docs/self-hosting-sandboxes.md "Public dial-back
  ingress") instead of exposing the main server. Transport code is runner
  internals — restart + image rebuild to take effect.
- **Remote adapters** (`provider: "daytona"` / `"e2b"`,
  src/server/sandbox/adapters/): always volume-style workspaces cloned
  in-sandbox over https (`cloneCredential`), always ws transport, runner
  payload installed on first ensure by `bootstrapRemoteSandbox` for engines
  that run inside the sandbox. OpenCode engines (OpenAI, Claude and other
  providers) stay on the host and use `bootstrapRemoteWorkspaceRuntime`
  instead (Git/Bun/ripgrep/core tools only; no runner checkout,
  Claude/OpenCode CLI, credentials, or dial-back requirement). Daytona
  idle-stops natively (`autoStopInterval`); E2B lives on a countdown that
  activity extends — expiry KILLS the sandbox and its workspace. NOTE:
  Daytona Tier 1/2 orgs restrict sandbox egress, which blocks the WS
  dial-back entirely — launchRun there needs a Tier 3 org or self-hosted
  Daytona.
- **Local Firecracker adapter** (`provider: "microvm"`): restores a
  credential-free control-only golden from `/opt/firecracker/sandbox-store`
  and runs the engine on the host through `opensession-workspace`. Build it
  with `deploy/sandbox/microvm/refresh-sandbox-golden.sh`; by default that
  builds the dedicated minimal `Dockerfile.workspace` image (Git, Bun, Node,
  ripgrep, jq, sqlite3, iproute2, Python, and native-build basics, but no model
  CLI or Open Session runner payload). Golden publication is locked against
  concurrent clone creation and rolls back as one disk/memory/vmstate
  generation on failure. Never reuse the preview-pool golden in
  `/opt/firecracker/store`.
- `deploy/sandbox/conformance.ts` — the provider conformance matrix
  (`bun run deploy/sandbox/conformance.ts [docker-socket|docker-ws|daytona|e2b|box|modal|lambda-microvm]`):
  verify.ts's checks parameterized over providers. Docker entries always run
  and must stay green; daytona/e2b/box/modal run only with credentials (else
  `SKIPPED: no credentials`) and leave zero sandboxes behind.

## Host setup + verification

- `deploy/sandbox/setup-host.sh` — idempotently installs the DOCKER-USER
  iptables rule dropping container traffic to 169.254.169.254 (IMDS), the
  container mirror of the systemd `IPAddressDeny`. Not persisted across host
  reboots — re-run it after one.
- `deploy/sandbox/verify.ts` — manual end-to-end suite
  (`bun run deploy/sandbox/verify.ts`): ensure/reuse, in-container git
  commit through the mounts, claude CLI, RPC socket, IMDS block, a minimal
  real agent run via launchRun, stop/start/get/destroy, volume workspaces,
  WS transport, snapshots, and the sandboxed preview/lifecycle flow. Uses
  only `sbxtest-*` scratch resources and a redirected run journal; safe next
  to the live server.
- `deploy/sandbox/verify-opencode-sandbox.ts` — the opencode-engine sibling of
  verify.ts (`bun run deploy/sandbox/verify-opencode-sandbox.ts`): proves the
  opencode engine runs INSIDE a docker sandbox end-to-end against the real
  DockerProvider + `opensession-runner` image. Checks the transcript/bridge-config
  mounts, in-container `opencode` binary resolution, then a real two-turn
  opencode/anthropic run (haiku, meridian bridge) via `sandbox.launchRun` —
  session resume across turns, `bks-sbx-*` sandboxId in the run journal,
  `opencode serve` living only in-container and reaped at exit, the host-visible
  JSONL transcript, and `opencode_meridian_run` audit events — before
  `destroy()` teardown. Costs two haiku turns on the meridian bridge; dry-runs
  (mount/binary checks only) when the account pool or bridge config is
  absent/disabled. Uses `octest-*` scratch resources and a redirected journal;
  safe next to the live server. Rebuild the image first if
  `opencode-runner`/`host.ts` changed — the container runs the baked src, not
  this checkout.
- `deploy/sandbox/verify-external-engine.ts` — live “brain on host, hands in
  sandbox” certification for OpenCode OpenAI/Claude models. It creates a disposable
  real WebSocket session, requires all six `opensession-workspace` methods,
  proves the engine/credentials/filesystem boundary, and destroys the session
  plus provider resource in `finally`. Repeat `--provider` to cover several
  providers; add `--restart` to prove sticky placement and reattachment:

  ```sh
  bun run deploy/sandbox/verify-external-engine.ts --provider daytona --provider modal
  bun run deploy/sandbox/verify-external-engine.ts --provider microvm --restart
  ```

  It defaults to OpenAI GPT-5.6 Sol. Use `--model
  opencode/anthropic/claude-sonnet-5` to certify the Claude path instead. For
  a UI-driven smoke test, paste
  `deploy/sandbox/external-engine-test-prompt.md` into a new code session.

## When to rebuild

- **Claude CLI bump** on the host (`claude --version` changes) → bump
  `CLAUDE_VERSION`. The in-container CLI must match host session-resume behavior
  (the build asserts the installed version and fails on drift).
- **opencode bump** on the host (`opencode --version` changes) → bump
  `OPENCODE_VERSION` (same parity rule; build asserts it).
- **Lockfile change** (`bun.lock`) — any dependency add/upgrade → rebuild
  (the deps layer re-installs).
- **Bun bump** on the host → bump `BUN_VERSION` to keep parity.
- Source changes to `src/` / `opensession.ts` that the runner-host path uses →
  rebuild (fast: only the final COPY layers change). In particular ANY change
  under `src/runner-host/` (protocol/entry) must be rebuilt before the next
  sandboxed run — the container executes the image's copy, not the checkout.

Keep the image's pins in lockstep with the host; parity is the whole point.
