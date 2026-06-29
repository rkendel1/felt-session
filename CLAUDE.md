Default to using Bun instead of Node.js.

## Backstage dev workflow (self-hosting — read this first)

Backstage runs itself: the live server is `bun --hot` from this main checkout
(`/home/ubuntu/projects/tella-backstage`), so the fastest way to see a change is
to **edit the main checkout on `master` directly** — `bun --hot` reloads it live.
Because of that, backstage code sessions do **not** get their own worktree
(`sharedCheckout` in `src/server/worktree.ts`); they all work in this one shared
checkout on `master`. That's intentional wild-west iteration. The rules that keep
it from descending into chaos:

- **Only `add` → `commit` → `push`. Never `git reset --hard`, `git checkout .`,
  `git revert`, or `git checkout <other-branch>` in the shared checkout.** A reset
  or branch-switch yanks the working tree out from under the live server *and*
  every other session — that's the "sessions undoing each other's work" trap. If
  something looks wrong, inspect and fix forward; don't roll back the shared tree.
- **`git add <specific files>`, not `git add -A`** — multiple sessions may have
  uncommitted edits in this tree; only commit your own.
- **Commit + push frequently.** Un-pushed work is the only thing a sync can't
  protect (the deploy is now `merge --ff-only`, never `reset --hard`, so it aborts
  loudly instead of wiping — but push anyway).
- **Don't `systemctl restart` casually.** Most edits hot-reload. Only runner
  internals / agent-loop / scheduler changes need a real restart, and a restart
  drains every session — treat it as a deliberate, announced action. Frontend
  changes never need it (`kill -USR2 <pid>` or the watcher rebuilds the bundle).
- Want isolation for a risky/breaking change? Make a worktree by hand and run a
  second instance on another `PORT` — but note `BACKSTAGE_DEV=1` only swaps the
  frontend build; it does **not** yet disable the Slack/Linear/Stripe loops,
  webhook server, or schedulers, so a naive second instance double-sends. (A real
  isolated dev mode is a future task.)

- Use `bun run backstage.ts` to start the server
- Server binds to Tailscale IP (100.65.135.7:3850) — not publicly accessible
- Access at `http://michael:3850/backstage/`
- Bun automatically loads .env, so don't use dotenv
- HTML imports for frontend bundling (no Vite)
- All session file access is read-only (never modify ~/.slack-sessions/ or ~/.linear-sessions/)
- Own session store at ~/.backstage-sessions/
- Audit log: every agent run emits structured JSON events (incident-agent style) to ~/.backstage-audit/audit-YYYY-MM-DD.jsonl via src/server/audit.ts — see deploy/README-audit.md for the event catalog and CloudWatch shipping
- Internal notes and draft replies (Plain, Linear) are always written in English, regardless of the customer's language — note the customer's language so the team can translate before sending. This applies to agent prompts here (src/agents/plain/prompts.ts) and to automation prompts stored in ~/.backstage-automations/.

## Hot reload & restarts

The systemd service runs `bun --hot run backstage.ts`: editing source hot-reloads in-process so WebSocket clients and in-flight runs survive (rather than restarting and dropping every session). One-time setup (agents, schedulers, timers, signal handlers) is guarded behind `globalThis.__backstageBooted`; live state (watchers, pendingAsks, promptQueues, loaded agents, runner active-run maps) is parked on `globalThis`; the `Bun.serve` server is reused, not rebound.

What hot-reloads vs. what needs a real `systemctl restart` — **important, this has bitten us:**
- **Hot-applies:** HTTP/route + WebSocket handlers, the `SessionControl` registry (re-registered on every reload, so session-control / MCP-injection logic updates), per-message config and prompts read fresh.
- **Needs a real restart:** long-lived **agent loop code** (Slack/Linear/Stripe event loops — guarded against double-start, so the old code keeps running), and **runner internals** (`claude-runner.ts` / `agent-runner.ts` / `runClaude`, e.g. how a run's MCP/tool list is built). `--hot` does NOT propagate a change in a deeply-imported module like runClaude into the running process even though health/PID look fine. Before declaring a runner-path change live, `systemctl restart` and verify with a real run.

Restarts are graceful: SIGTERM stops new intake, then drains in-flight runner runs (bounded by `SHUTDOWN_DRAIN_MS`, default 2 min/120s; unit `TimeoutStopSec=140`, which must stay above the drain) before exiting; anything still going is resumed from the run journal on next boot. The unit also sets `KillMode=mixed` so SIGTERM hits only the bun parent (not the whole cgroup) — otherwise systemd kills the Claude children directly and the drain/journal never get a chance. The deployed `/etc/systemd/system/backstage.service` is a **copy** of the repo `backstage.service`, not a symlink — sync with `sudo cp` + `systemctl daemon-reload`.

## Automation least-privilege

Automation runs (especially event-triggered ones like Plain ticket triage) process untrusted text — customer ticket content is data the agent reads, never configuration for the run. Constraints are enforced at the tool/env layer, not just in prompts:

- Agent subprocesses get a minimal env (PATH, HOME, LANG, MICHAEL_MODEL) — no tokens from ~/.backstage.env. MCP servers receive their own credentials via mcp-config.json per-server `env` or load it themselves (workos-mcp wrapper).
- Each automation has an optional `mcpServers` allowlist (per-automation field, settable via the API); runs only see those servers. Triage uses six (`plain`, `workos`, `tinybird`, `linear`, `sentry`, `stripe`) so it can look up the customer, analytics, billing, related issues and errors while investigating.
- Stripe is money-moving, so it gets a third enforcement tier beyond allow/deny: **per-call human confirmation**. The MCP uses a restricted key (write on Refunds + Subscriptions only, read on core billing resources, nothing else — Stripe enforces this ceiling server-side). The tools in `STRIPE_CONFIRM_TOOLS` (claude-runner.ts: create_refund, cancel/update_subscription, and stripe_api_execute since it can hit any permitted endpoint) pause interactive sessions on an approve/deny card showing the exact tool input; in unattended runs they're denied with instructions to post the proposed action (tool + full parameters) in the note for a human to approve by opening the session. Approvals/denials land in the audit log as `human_confirmation` / `confirm_unattended` decisions.
- Automation runs hard-deny *customer-facing and identity-mutating* tools in canUseTool (enforced for direct runs and interactive resumes of automation sessions): Plain thread writes (reply_to_thread, mark_thread_done/todo, snooze_thread) and the WorkOS write/destructive subset (create/delete/update user+org, revoke, invitations, password/verification emails, impersonation URLs). Reads stay allowed; suggested customer replies go in an internal Plain note. Linear (incl. issue creation) and Sentry are internal, so their writes are allowed — that's the "spin off work" affordance.
- `mode` is per-automation: "ask" runs read-only on the main checkout (no worktree, no Write/Edit); "code" gets an isolated worktree with Write/Edit and can open PRs (never merge — PRs are the human gate). Triage runs in code mode: it can implement a fix in its worktree and open a PR for review, or recommend the fix in the note. Code mode still carries every other scoping (MCP allowlist, denied customer/identity writes, IMDS blocked, minimal env) — only the worktree + write tools differ from ask.
- When adding an automation, scope it: pick ask mode unless it must write, and name only the MCP servers it uses.

## Self-management tools (Slack + interactive Backstage sessions)

The `michael-admin` in-process MCP server (src/agents/slack/admin-tools.ts) lets Michael manage his own setup from Slack: channel memory (remember/list_memory/forget) and — gated to the trusted user (`isAdmin` = no `ALLOWED_SLACK_USER_ID` set, or sender matches it) — automations (list/create/update/delete/run) and MCP connections (list/add/remove). It is wired ONLY into interactive Slack runs (handlers.ts `processMessage`); automation runs never go through there, so they never receive these tools. Do not add `michael-admin` to automation/`runAgent` paths — that would let untrusted ticket text reconfigure Michael. Channel memory is scoped in src/agents/slack/memory.ts (public channel → shared `workspace` store; private channel/DM → isolated, with read-only workspace view) and auto-injected into the system prompt each run.

Both `michael-admin` and `michael-sessions` are ALSO available inside **interactive Backstage sessions** (web UI + loops), not just Slack: backstage.ts's `interactiveMcpServers(user)` builds them and passes them as `runClaude`'s `inProcessMcp` from the interactive run paths (`runSessionPrompt`, both `create_session` paths). They're withheld from automation runs **and** from interactive resumes of automation-owned sessions (gated on `!isAutomationSession`, the same gate as `deniedTools`) — untrusted ticket text must never reach these tools. Backstage is Tailscale- and team-gated and already exposes all of this through its UI, so interactive users are treated as `isAdmin: true` there. Claude backend only — the Codex runner ignores `inProcessMcp`. `runClaude` also appends a short "Managing Michael" system-prompt note when `inProcessMcp` is present so the session knows the tools exist.

The `michael-sessions` in-process MCP (src/agents/slack/sessions-tools.ts) is a sibling, wired the same way (interactive runs only — Slack and Backstage sessions per above — never automations). It lets Michael see and steer every *other* Backstage session: read tools `list_sessions` (with a `waiting` filter for sessions blocked on an AskUserQuestion) and `get_session` (state + pending question + transcript tail) are open to any whitelisted user; the control tools — `answer_session_question` (resolves a paused question), `send_to_session` (steer/queue/start a turn), `cancel_session`, `create_session` — are gated to the trusted user via `isAdmin`. The tools don't touch in-process state directly; they go through the `SessionControl` registry (src/server/session-control.ts) that backstage.ts populates at startup with the same helpers (`runSessionPromptAndDrain`, `steerAgentRun`, `makeAskHandler`, the `pendingAsks`/`promptQueues` maps) the WebSocket handlers use — so steering from here behaves exactly like a human in the web UI, and a future autonomous monitor (src/agents/loops) can call the same registry directly without the MCP. Sessions whose runs aren't owned by this process (CLI/tmux) are surfaced as `observe-only` and can't be steered/cancelled. Do NOT wire `michael-sessions` into automation/`runAgent` paths — cross-session control from untrusted ticket text would be a privilege-escalation path.
