Default to using Bun instead of Node.js.

Instance-private operator instructions (deployment hostnames, org access
grants, incident history) belong in an untracked `AGENTS.local.md` or
`CLAUDE.local.md` next to this file — the runner appends it to every engine
run (`readLocalInstructions` in src/server/opencode-runner.ts), and Claude
Code auto-loads `CLAUDE.local.md`. Keep anything you wouldn't publish there,
never here.

## Public repositories require confirmation

NEVER publish changes to an open-source or public repository without explicit
user confirmation in the current conversation. A request to investigate,
implement, or prepare a change is not permission to publish it. This covers
every kind of write — issues and comments included, not just forks/branches/PRs.
Local edits and commits are allowed, but before writing anything to a
public/open-source repository, stop and ask the user. This rule overrides
bias-to-action and generic commit/push/PR defaults; automatic PR creation
applies only to your registered first-party repositories.

Enforce this with credential scope, not just prompts — see
docs/security-model.md for the token setup that makes any out-of-org GitHub
write fail server-side. The rule itself is injected into every engine run via
`buildRunInstructions` (run-instructions.ts).

## Data handling — never upload to public hosts

NEVER upload files or data to public file-sharing hosts or pastebins — no
exceptions, no matter how delivery of a file is failing. Anything uploaded
there is public and unrecoverable, and session files routinely contain
customer data. Deliver files only through channels you control: Slack file
upload, the session UI, email via your own tooling, or a commit/PR in a
private repo. If every controlled channel fails, stop and report the failure
instead of escalating to a third-party host. The same rule is injected into
every engine run via `buildRunInstructions` (run-instructions.ts).

## The five client apps — resolve which one BEFORE working

OS1 has five user-facing clients in this repo, and requests about "the app"
are ambiguous between them:

- **Web UI** — `src/frontend/` (React, served by the Bun server; also what the
  iOS PWA and the Electron shell display).
- **Electron desktop shell** — `os1-mac/` (bundle id `dev.tella.os1.shell`;
  wraps the web UI).
- **Native Swift app** — `os1-ios/` (one SwiftUI codebase, iOS + macOS targets,
  bundle id `dev.tella.os1`). Read `os1-ios/AGENTS.md` before touching it —
  build/verify workflow, release trigger, and performance invariants live there.
- **Chrome extension** — `os1-chrome/` (MV3 side panel; captures page context —
  screenshot, element pick with React fiber info — and starts sessions via the
  REST surface with Bearer auth; loaded unpacked, never the Web Store; see
  `os1-chrome/README.md`).
- **Terminal client** — `os1-tui/` (the `os` binary; TUI on OpenTUI, tmux
  keys, tabs). Pure client: HTTP + one WebSocket per watched session, no
  server imports, so it compiles to a standalone binary. `opensession tui` is
  an alias. Read `os1-tui/AGENTS.md` before touching it.

Conversation scoping rule: once a conversation is about a specific app, every
following message is about THAT app unless the user says otherwise — don't
drift back to the web UI because it's the default surface (e.g. after an iOS
bug report, "also fix X" means fix X in the native app). If it's genuinely
unclear which app a request targets, ask first instead of guessing; a fix
landed in the wrong app wastes a round-trip and can mask the real bug.

## Server architecture map

`opensession.ts` is a thin entry (~900 lines): env, `hotServe` (reuse the live
server across hot reloads), the `Bun.serve` composition (SPA routes map + fetch
preamble → route dispatch → WS-upgrade/SPA-fallback/404 tail), `loadAgents`,
the `__opensessionBooted` boot block, and graceful shutdown. Everything else
lives in focused modules — work in the module that owns your feature, not the
entry file (that's what keeps parallel sessions from colliding):

- `src/server/routes/` — every HTTP route, one file per domain (sessions, pr,
  plain, workspace, models, …). Handlers get a `RouteContext` and return a
  `Response` or `undefined` to fall through; `routes/index.ts` is the ordered
  chain. Order only matters *within* a path family — keep a family (e.g.
  `/notes/search` before `/notes/:id`) in one module. New endpoint → add it to
  the matching domain file (or a new file + one line in index.ts).
- `src/server/ws-handlers.ts` — the UI WebSocket (watch/prompt/queue control/
  answers/terminals/notes + create_session).
- `src/server/run-session.ts` — driving a session turn: runSessionPrompt(Inner),
  queue delivery (enqueue/steer/interrupt/drain), sandbox launch, restart
  resume, /loop ticker. This is runner-adjacent: changes need a real restart.
- State modules (all park live state on `globalThis` under the same keys so
  hot reloads keep it): `ws-hub.ts` (clients/presence/broadcasts),
  `queue-state.ts` (prompt queues + steer receipts), `asks.ts` (pending
  AskUserQuestion + Slack escalation), `session-cache.ts` (2s session cache —
  call `invalidateSessionsCache()`, never poke the cache), `agents-registry.ts`.
- `session-repos.ts` (repo notes/attach/switch), `interactive-mcp.ts`
  (interactive opensession-* MCP builders; side-effect registers the run-rpc
  builder), `session-control-wiring.ts` (opensession-sessions MCP surface),
  `slash-commands.ts`, `goal-runner.ts` (goal wakes + ticker),
  `frontend-build.ts` (in-process SPA rebuild), `uploads.ts`,
  `session-sandbox.ts`.

Modules with module-scope side effects (listener/ticker registration guarded
by `__opensessionBooted`) are explicitly side-effect-imported at the top of
opensession.ts — if you add such a module, add it to that import list.

## Open Session dev workflow (self-hosting — read this first)

Basics:

- `bun run opensession.ts` starts the server; it binds 127.0.0.1:3850 (not
  publicly accessible — front it however you like: reverse proxy, VPN/tailnet,
  SSH tunnel).
- Bun automatically loads .env, so don't use dotenv.
- HTML imports for frontend bundling (no Vite).
- Naming: OPENSESSION_* env vars, `~/.opensession-*` state. URLs are
  prefix-less: the app serves at the bare domain root. The product model —
  Projects > Workspaces > Sessions — is in CONCEPTS.md; use those words.
- Own session store at ~/.opensession-sessions/. All other engines' session file
  access is read-only (never modify ~/.slack-sessions/ or ~/.linear-sessions/)
  — sole exception: `src/server/agent-session-sync.ts` (see that module's doc
  before widening it).
- Audit log: every agent run emits structured JSON events to
  ~/.opensession-audit/audit-YYYY-MM-DD.jsonl via src/server/audit.ts — see
  deploy/README-audit.md for the event catalog and CloudWatch shipping.
- Internal notes and draft customer replies (Plain, Linear agents) are always
  written in English regardless of the customer's language — note the
  customer's language so the team can translate before sending.

Open Session runs itself from its main checkout. Code sessions on this repo do
**not** get their own worktree (`sharedCheckout` in `src/server/worktree.ts`);
they all work in this one shared checkout on the default branch. That's
intentional wild-west iteration. The rules that keep it from descending into
chaos:

- **Only `add` → `commit` → `push`. Never `git reset --hard`, `git checkout .`,
  `git revert`, or `git checkout <other-branch>` in the shared checkout.** A
  reset or branch-switch yanks the working tree out from under the live server
  *and* every other session. If something looks wrong, inspect and fix
  forward; don't roll back the shared tree.
- **`git add <specific files>`, not `git add -A`** — multiple sessions may
  have uncommitted edits in this tree; only commit your own. High-traffic
  files (`global.css`, `opensession.ts`, `App.tsx`) are sweep magnets: even a
  specific `git add` on one of them can pick up another session's uncommitted
  hunks. For those files use `git add -p` to stage only your hunks, and check
  `git diff --cached` before committing.
- **Scope the *commit*, not just the `add`.** The index is shared too: another
  session's `git add` may already be staged before you touch anything. Always
  check `git diff --cached --name-only` first — if it lists anything that
  isn't yours, commit with a pathspec (`git commit -- <your files>`). Never
  `git reset`/`git restore --staged` to "clean up" first — that silently
  unstages what another session staged deliberately. When a file has foreign
  staged entries *and* foreign edits inside your own files, build the commit
  through a private index: `GIT_INDEX_FILE=/tmp/my.index git read-tree HEAD` →
  `git apply --cached your.patch` → `git write-tree` → `git commit-tree` →
  `git update-ref refs/heads/main <new> <old>` (the three-argument form is a
  compare-and-swap that fails instead of clobbering).
- **After a private-index commit, resync the shared index to HEAD for the
  paths you committed.** `update-ref` moves the branch without touching the
  shared index, so every path you just committed is left staged at its
  *pre-commit* content. `git status` then shows dozens of files as modified
  when the worktree already matches HEAD, and the next plain `git commit` in
  this checkout silently REVERTS them. Walk your own paths only — never the
  whole index, which would unstage other sessions' deliberate work:

  ```sh
  for f in $(git diff --name-only HEAD~1 HEAD); do
    if git cat-file -e "HEAD:$f" 2>/dev/null; then
      git update-index --add --cacheinfo \
        "$(git ls-tree HEAD -- "$f" | awk '{print $1}'),$(git rev-parse "HEAD:$f"),$f"
    else
      git update-index --force-remove "$f"
    fi
  done
  ```

  Reading `git status` here: a path listed as modified whose
  `git diff HEAD -- <path>` is empty is a stale index entry, not open work —
  resync it. Real open work shows up in `git diff HEAD --name-only`.
- **Commit + push frequently.** Un-pushed work is the only thing a sync can't
  protect (the deploy is `merge --ff-only`, never `reset --hard`, so it aborts
  loudly instead of wiping — but push anyway).
- **Backend edits need a deliberate `systemctl restart opensession`.** Commit
  and push first, then restart and verify health. Restarts are graceful and
  detached engine turns reattach, but they still churn active sessions, so do
  this once after the backend change rather than after every save. Frontend
  changes never need it: the in-process watcher rebuilds the bundle live.
- Want isolation for a risky/breaking change? Boot a real dev instance:
  `OPENSESSION_DEV=1` gates the FULL dev mode — no agent loops, webhook
  server, schedulers, automation seeding, detached-server adoption, or prewarm
  — and it refuses to boot without `OPENSESSION_STATE_DIR` (or a chats-dir
  override), so it can never touch live state or steal the run-rpc socket. Add
  `OPENSESSION_DEMO=1` for synthetic demo data. The repo's
  `.opensession/start.sh` wires all of this for the session Preview button;
  see docs/self-development.md.

## Frontend UI system (Base UI + Tailwind + Motion)

New UI goes through this stack; legacy `global.css` classes are migrated
opportunistically when touched (strangler pattern — never a big-bang rewrite):

- **Tokens**: `src/frontend/styles/tailwind.css` maps the existing `global.css`
  variables (`--bg`, `--text-dim`, …) into Tailwind's namespace via
  `@theme inline` — use `bg-panel text-dim border-line text-fg bg-surface` etc.,
  never raw hex or stock Tailwind grays. Dark/light theming comes for free
  because the vars re-resolve under `html[data-theme]`. The spacing/radius/text
  scales are px-anchored there (global.css sets `html { font-size: 14px }`,
  which would otherwise shrink every rem-based utility to 87.5%) — so `p-3` is
  a true 12px and `text-xs` a true 12px. Bare `rounded` bypasses the radius
  scale; use `rounded-sm/md/lg` (4/6/8px).
- **Compile**: Tailwind is compiled by an `@tailwindcss/cli` subprocess inside
  `buildFrontend()` (src/server/frontend-build.ts) and linked *after*
  `global.css`; utilities are imported unlayered so they win source-order ties
  against legacy rules. Preflight is intentionally NOT imported (global.css
  assumes browser defaults). Don't import tailwind.css from App.tsx — Bun
  can't compile it.
- **Primitives**: wrap Base UI (`@base-ui/react`) per component in
  `src/frontend/ui/` (see `ui/tooltip.tsx` for the pattern). Rules: always
  pass `className` through `cn()` (ui/cn.ts); keep Base UI's composable parts
  shape rather than mega prop APIs; style open/close state via Base UI data
  attributes; few variants (`variant`/`size`), no boolean prop explosions.
- **Motion**: use `motion.*` directly with shared presets from `ui/motion.ts` —
  don't build wrapper components around Motion. Caveat for Base UI popups:
  `render={<motion.div/>}` drops Base UI's injected attributes (role, data-*),
  so it's only safe on non-focus popups like the tooltip (enter-only; restore
  `role` by hand — see ui/tooltip.tsx). Focus-managed popups (menus, dialogs)
  animate with CSS transitions on Base UI's `[data-starting-style]` /
  `[data-ending-style]` lifecycle attributes instead (see ui/menu.tsx) — that
  keeps keyboard nav + a11y intact and gets exit animations for free.
  AnimatePresence can't track exits through Base UI portals; don't use it there.

Design/motion skills can be installed instance-locally under `.agents/skills/`
(gitignored — see docs/extending.md for the skill format). If your instance
has them, read the smallest relevant set before frontend design or motion
work.

## Frontend rebuilds & restarts

The systemd service runs `bun run opensession.ts`, intentionally without
`--hot`: a Bun backend hot reload can permanently kill all timers while HTTP
keeps serving, leaving sessions stuck until a restart. The in-process frontend
watcher still rebuilds and broadcasts frontend changes. Every backend change —
routes, WebSocket handlers, agent loops, runner internals — needs one
deliberate `systemctl restart opensession` after the change is committed and
pushed.

Restarts are graceful and do not kill in-flight engine turns: `opencode serve`
processes are detached into transient systemd user scopes outside the unit's
cgroup (`src/server/opencode-detach.ts`), survive the restart, and are
re-adopted on boot with journaled runs reattached to their live turns
(`tryReattachOpencodeRun`; the continuation re-prompt is the fallback for dead
servers). Kill switch: `OPENSESSION_OC_DETACH=0`. Full mechanics live in the
module docs of opencode-detach.ts and opencode-runner.ts. Ops invariants: the
unit's `TimeoutStopSec` must stay above `SHUTDOWN_DRAIN_MS` (60s default),
`KillMode=mixed` is required, and the deployed
`/etc/systemd/system/opensession.service` is a **copy** of the repo
`opensession.service`, not a symlink — sync with `sudo cp` +
`systemctl daemon-reload`.

## Security model — invariants (full detail in docs/security-model.md)

Automation runs (Plain ticket triage, channel watches, scheduled jobs) process
untrusted text: event/ticket content is data the agent reads, never
configuration for the run. Constraints are enforced at the tool/env layer, not
just in prompts. Every change must preserve these invariants:

- Automation subprocesses get a minimal env — no tokens from the server's env
  file. MCP servers receive their own credentials via mcp-config.json.
- Each automation has an optional `mcpServers` allowlist; runs only see those
  servers. When adding an automation, scope it: ask mode unless it must write,
  and name only the MCP servers it uses.
- Customer-facing and identity-mutating tools are hard-denied for automation
  runs *and* interactive resumes of automation-owned sessions, by STRIPPING
  them from the model's tool list (`opencodeRunPolicy` in opencode-runner.ts).
  Money-moving tools (`STRIPE_CONFIRM_TOOLS` in runner-shared.ts) are stripped
  from every run; reads keep working on a server-side-restricted key.
- The run gate (`opencodeGateReason`) is deny-by-default on journal kind.
- `mode` is per-automation: "ask" runs read-only on the main checkout; "code"
  gets an isolated worktree with Write/Edit and can open PRs — never merge,
  PRs are the human gate. Code mode keeps every other scoping.
- An MCP server can carry `allowedUsers`; enforcement is at the runner layer
  (`filterMcpServers` in runner-shared.ts), matched through the identity
  table. Automation runs pass no user, so restricted servers are invisible to
  them — fail-closed.
- Per-user GitHub tokens (opt-in `integrations.github`, see the doc) ride
  interactive runs only; unattended/least-privilege runs keep the bot
  credential — fail-closed. When web sign-in is active, the verified identity
  overrides client-claimed `user` on every WS message.
- The in-process self-management servers — `opensession-admin` (automations +
  MCP connections + channel memory), `opensession-sessions` (see/steer other
  sessions), `opensession-repos` — are wired into INTERACTIVE runs only
  (`interactiveMcpServers` in src/server/interactive-mcp.ts), never
  automations, never interactive resumes of automation-owned sessions. Do NOT
  add them to automation/`runAgent` paths — that would let untrusted text
  reconfigure the agent or escalate across sessions. The two deliberate,
  tightly-scoped exceptions (append-only papercuts; human-set
  `automation.selfImprove`) are documented in docs/security-model.md — hold
  anything new to the same bar: append-only, nothing sensitive readable, no
  control surface.
- Changes to runner-layer enforcement need a real `systemctl restart`.

## Model routing and delegation

Interactive sessions should act as orchestrators, not as the only worker. Use
the `opensession-sessions` MCP tools to spin up focused worker sessions when
that reduces context noise or parallelizes work.

Pick the model that fits each task — intelligence and taste come first, cost
isn't a reason to downgrade. All models run on the opencode engine (ids are
`opencode/<provider>/<model>`; bare native ids map onto that form at dispatch).

How to delegate from an Open Session session:
- Use `opensession-sessions.create_session`, setting `model` to whatever fits
  the worker's task.
- For workers that only need filesystem/code access, pass `mcpServers: []` so
  unrelated external MCP startup does not slow or block them.
- Set `repo` to the registered repo id the worker should inspect or edit
  (see "Multi-repo sessions").
- Use `mode: "ask"` for read-only investigation on the main checkout;
  `mode: "code"` plus a branch name for implementation work that can edit
  files or open a PR.
- Give worker sessions self-contained prompts: scope, repo/worktree path,
  relevant files, constraints, acceptance criteria, and exactly what to report
  back. Ask for summarized findings and file references, not raw dumps.
- Keep the final call in the orchestrator session. Inspect the worker's
  summary, diff, tests, and assumptions; rerun, steer, or escalate to a
  smarter model if the result misses the bar.

Engine notes: the opencode engine has no mid-turn steer — a busy send queues
and delivers as the next turn. Anthropic models run through the bundled
Meridian bridge on your configured Anthropic account pool; OpenAI models run
on your configured OpenAI (ChatGPT-OAuth) account pool. One-shot utility calls
(titles, branch names, intent classifiers) go through `opencodeOneShot`
(src/server/opencode-oneshot.ts) on a shared tool-less server. Runner code is
runner internals — changes need a real restart.

Eligible interactive runs multiplex onto one shared always-warm
`opencode serve` per (bridge account × user); automations and other unattended
kinds keep per-session servers so their least-privilege MCP allowlist stays
config-level. Full contract in opencode-runner.ts's module doc ("Server
lifecycle"); adding a new in-process opensession-* server requires adding it
to SHARED_INPROCESS_SERVERS or its sessions silently fall back to per-session
servers.

Priority rule for shipped work: intelligence > taste > cost. Cost is only a
tie-breaker. Do not ship mediocre output just because it was cheaper to
produce.

## Multi-repo sessions

A session is not single-repo. Beyond its primary `project`/`worktreeDir`/
`branch`, it can **attach** secondary repos (`attachedRepos:
{project,branch,dir}[]` on the session file + `UnifiedSession`). The
registered repos live in `REPOS` (`src/server/worktree.ts`), each with a
`defaultBranch` and `ghRepo` (`owner/name` for the gh CLI). All but the
self-hosted Open Session repo (`sharedCheckout`) use the normal worktree+PR
flow.

- **Attaching** creates (or reuses) an *isolated* worktree via
  `prepareAttachedWorktree` (never another repo's shared main checkout —
  that's the "parked on a random branch / collisions" trap). Default branch =
  the session's primary branch, so cross-repo PRs line up. Two entry points,
  both hitting `POST /api/sessions/:id/attach-repo` → `attachRepo()` in
  src/server/session-repos.ts: the `opensession-repos` in-process MCP server
  (`attach_repo`/`list_repos`, interactive runs only, never automations) and
  the `RepoBar` UI in the session viewer. Detach via
  `POST /api/sessions/:id/detach-repo` (POST, not DELETE — a DELETE on
  `/sessions/:id/...` is swallowed by the generic session-delete route).
- **Agent awareness**: `runSessionPrompt` passes `reposNote` through
  `runAgent`; the opencode runner injects it via the per-session instructions
  file. It lists primary + attached repos with their worktree paths so the
  agent cd's into the right isolated checkout. Only present when the session
  has attached repos.
- **@-mentions** (`GET /api/files`) search the primary worktree + every
  attached repo; cross-repo hits insert as `@<project>:path` (primary stays a
  bare path) and carry a repo label.
- **Diff** (`GET /api/sessions/:id/diff`) returns
  `{ repos: [{project,dir,primary,diff}] }` — one `getSessionDiff` per repo.
  `DiffPanel` shows a repo switcher when >1 repo changed.
- **PR** routes accept `?repo=<project>`; `resolvePrTarget` maps it to the
  right `ghRepo`+branch. `pr-info.ts` functions take a `repo` arg (caches
  keyed by repo+branch). `PrPanel` shows a repo switcher when a session spans
  repos. The Reviews list table still only surfaces the *primary* repo's PR
  columns — attached-repo PRs live inside the session's PR tab.
