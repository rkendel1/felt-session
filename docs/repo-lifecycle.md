# Repo lifecycle scripts: `.opensession/`

Commit a `.opensession/` directory to a repository and every agent host that
follows this convention — Open Session, and anything else that adopts it —
knows how to provision a workspace for that repo and boot its dev server.
Three files, each optional:

| File          | When it runs                              | Job                                       |
| ------------- | ----------------------------------------- | ----------------------------------------- |
| `setup.sh`    | once per workspace materialization        | install deps, fetch prebuilt assets       |
| `start.sh`    | when a preview starts                     | bring the dev server up in the foreground |
| `preview.json`| warm-pool / warm-template refreshes       | declare which routes to pre-compile       |

Why commit them rather than configure the host: the boot recipe travels with
the code. Every worktree of every session starts provisioned, the Preview
button works identically on the host, in sandboxes and from the warm pool,
and — the real payoff — an agent can bring your app up **headlessly** in its
own worktree and verify its changes in a real browser (screenshots, DOM
checks, CDP) without a human bootstrapping anything. See
[Letting the agent test the app itself](#letting-the-agent-test-the-app-itself).

`setup.sh` is always taken from the same directory as the resolved
`start.sh` — the pair ships together.

## setup.sh — one-shot provisioning

Runs once per workspace materialization, `cwd` = repo root, no arguments —
everything arrives by environment:

- **Worktree creation.** Every new session worktree runs the repo's
  `setup.sh` when present (it beats the instance-level `worktreeSetup`
  command); afterwards the configured `depsInstall` — or a plain
  `bun install` when there is a root `package.json` — still runs, so
  `setup.sh` only needs to cover what that default doesn't.
  See [worktrees.md](worktrees.md).
- **Sandbox workspace setup.** Once per sandbox workspace, skipped on
  snapshot restores (the restored layer already carries its effects), never
  retried once settled. See
  [deploy/sandbox/README.md](../deploy/sandbox/README.md).
- **First host preview start**, as a safety net — there is no
  workspace-materialization moment on the host, so it runs (and settles,
  success or not) as part of the first repo-script preview boot, stamped per
  worktree.

Because it can fire from more than one of these paths, it must be
**idempotent** — cheap when there is nothing to do. Failure is deliberately
non-fatal everywhere (a session with missing deps is still useful; a blocked
session is not), so when something important fails, print a loud, actionable
message rather than exiting quietly.

Keep it scoped to what the dev server needs: dependency install, prebuilt
artifact fetch, codegen. Slow extras belong behind an existence check.

## start.sh — boot the dev server

Runs when someone — or the agent itself — starts a preview: detached, `cwd` =
repo root, no arguments. Two rules make it work:

1. **Foreground.** `exec` the final dev process. Stop kills the script's
   process group; if you background the server, stopping the preview orphans
   it.
2. **Honor the environment contract:**

   | Variable | Meaning |
   | --- | --- |
   | `WEBAPP_PORT` | The port the app must listen on. On the host it's allocated and seeded into `.ports.conf`; in a sandbox it's a pre-published container port — honoring it is what makes the preview reachable. |
   | `PREVIEW_URL` | The public HTTPS origin fronting that port (e.g. `https://host.ts.net:9301`). Add its hostname to your framework's allowed dev origins so pages served through it actually hydrate. |
   | `OPENSESSION_BOOT_MODE` | `fresh` \| `snapshot-restore`, informational. Host previews always say `fresh`. |

Beyond that it should be just a script: a developer with a normal setup can
run `./.opensession/start.sh` by hand and get the usual dev server with sane
defaults. Assume no TTY and no human — never prompt. When a one-time human
step is missing (a gitignored `.env` that needs an interactive login to pull,
say), exit non-zero with the exact commands to run; that error message is
what both the session UI and the agent will act on.

**Resolution chain.** `.opensession/start.sh` → the
instance-config `previewCommand` (invoked with the worktree path as `$1` —
for repos you can't commit to). One chain, shared by host and sandbox
previews (`resolvePreviewBoot` in src/server/preview.ts); no rung resolves →
the Preview button is disabled with a hint about what to add.

**`.ports.conf`.** The host seeds `WEBAPP_PORT=<port>` into
`<worktree>/.ports.conf` before booting. If your dev tooling allocates its
own ports, have it source `.ports.conf` and keep any value that is free —
that's how the app comes up exactly where the caller published it. Extra
`*_PORT` keys your tooling writes there show up as additional services on the
session's preview card. Sandboxed previews additionally write
`<worktree>/.tunnels.env` with `PREVIEW_URL` / `PREVIEW_URL_<port>` entries
(see [deploy/sandbox/README.md](../deploy/sandbox/README.md)).

Host previews also inject the instance's short-lived cloud credentials (the
same ones agent runs get) into the boot, so a `start.sh` that needs, say, S3
access for a prebuilt-artifact fetch works without its own credential
plumbing.

## preview.json — warm routes

Frameworks with on-demand compilers (Next dev, Vite with heavy transforms)
serve a route slowly the first time it's requested. The warm preview pool and
warm-template refresh counter that by requesting a set of routes right after
boot, so the first human or agent visit is fast:

```json
{
  "warmRoutes": ["/", "/dashboard", "/api/session"]
}
```

Keep it to the handful of routes people actually open first from a preview.
Precedence: explicit instance Settings → the repo's committed
`.opensession/preview.json` → built-in defaults.

## A minimal pair

```bash
#!/usr/bin/env bash
# .opensession/setup.sh — one-shot per workspace. Idempotent.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun install
```

```bash
#!/usr/bin/env bash
# .opensession/start.sh — boot the dev server in the foreground.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env.local ]; then
  echo "ERROR: .env.local missing. Run once: <your env-pull command>" >&2
  exit 2
fi

# Trust the preview origin so the framework hydrates behind it.
if [ -n "${PREVIEW_URL:-}" ]; then
  host="${PREVIEW_URL#*://}"; host="${host%%[:/]*}"
  export ALLOWED_DEV_ORIGINS="$host"   # whatever your framework expects
fi

exec bun run dev --port "${WEBAPP_PORT:-3000}"
```

Real scripts grow from here — a prebuilt-WASM fetch instead of a local
toolchain build, a credentials shim, a write-access preflight — but the shape
stays: idempotent setup, foreground start, contract honored, loud actionable
failures.

## Letting the agent test the app itself

The scripts have a second consumer besides the Preview button: the agent.
With the pair committed, any session worktree is bootable headlessly, which
closes the loop *change → boot → screenshot → iterate* entirely inside a
session — the agent verifies its own UI work in a real browser instead of
declaring victory from a successful compile. Running this daily on our own
repos, these are the patterns that make it work:

- **A dev auth bypass.** The single biggest unlock. An env-gated auto-login
  (dev-only, secrets gitignored) means every headless request is
  authenticated — no interactive OAuth dance a bot can't perform. Gate it
  hard: dev environment only, never in committed config.
- **An idempotent ensure-up.** The agent shouldn't reason about whether the
  server is running — give it one command that is instant when it already is
  and boots when it isn't, and make the port discoverable (`.ports.conf`, or
  a well-known file) so follow-up tooling finds the server without guessing.
- **Committed driving instructions.** Pair the scripts with a repo skill or
  an agent-instructions section that says: run this to bring the app up, then
  use these one-liners to screenshot / record / evaluate JS over CDP
  (puppeteer or `chrome --remote-debugging-port`). The lifecycle scripts make
  the app *reachable*; the instructions make it *drivable*.
- **Human-once bootstrap, machine-many reuse.** Secrets that genuinely need
  an interactive login get pulled once into the main checkout by a human;
  `setup.sh` (or the skill) seeds them from there into each worktree. Scripts
  fail with the copy-pasteable bootstrap commands when the seed is missing.

## Pointers

- [worktrees.md](worktrees.md) — worktree creation and where `setup.sh` fits
  in the dependency-install chain
- [deploy/sandbox/README.md](../deploy/sandbox/README.md) — the same
  convention inside sandboxes: port publishing, `.tunnels.env`, setup logs
- [self-development.md](self-development.md) — Open Session's own
  `.opensession/` scripts, a real in-tree example
