# Concepts

Open Session is a server that runs coding agents on your own machines. Almost
everything you do with it is one of five nouns: a **project** that is a source
of work, a **workspace** that groups the work on one thing, a **session** where an
agent actually thinks, and the ways a session gets started without you typing —
**automations**, **goals** and **actions**.

This page is the core model. It is deliberately short on configuration; the
linked docs go deeper on each part.

## The core model

| Concept | What it is | Relationship |
| --- | --- | --- |
| **Project** | a source of work — a git repository, or a feed like Plain | 1 instance has many projects |
| **Workspace** | a container grouping the sessions about one piece of work | 1 project has many workspaces |
| **Session** | one conversation with an agent, with its own transcript | 1 workspace has many sessions |
| **Turn** | one prompt → one agent response, with its tool calls | 1 session has many turns |

That is the usual hierarchy you navigate: the sidebar is a list of projects,
each holding workspaces, each holding sessions. Repo-less scratch workspaces sit
alongside the projects instead. The URL follows the bottom of it —
`/workspace/<workspaceId>/session/<sessionId>`.

Alongside it sits a second, independent axis — *where* a session's work happens:

| Concept | What it is |
| --- | --- |
| **Worktree** | the isolated git working directory a code session edits in |
| **Sandbox** | an optional container the session runs inside instead of on the host |
| **Node** | another machine (a Mac, a Windows box) attached for platform-locked work |

And a third — *what starts a session when you are not there*:

| Concept | Trigger | Memory across runs |
| --- | --- | --- |
| **Automation** | a cron schedule or an external event | none — every run is a fresh session |
| **Goal** | its own self-set wake time | yes — one session resumed over days |
| **Action** | a human filling in a form | none — one session per run |
| **Workflow** | a script fanning out many agents | none — agents report into the script |

## Projects

A project is a source of work. It gets its own band in the sidebar, and the
things inside it become workspaces.

There are two kinds, and the difference is only where the work comes from:

**Repository projects** are git checkouts on the host that you registered.
Their workspaces are branches: you start a session, it cuts a worktree, it opens a
pull request.

**Feed projects** are external systems, reached through an integration or an
MCP server. Plain is a project — its items are support tickets. So are Slack,
your videos, your issue tracker. Their items are things that already exist
somewhere else; opening one gets you a workspace for it, created on first touch
and reused forever after.

The same nouns hang off both. A Plain ticket and a `myapp` branch are both
workspaces, both hold sessions, both show up in your lanes. What differs is that a
repository project's workspaces are *created* by you working, while a feed
project's workspaces are *adopted* as items arrive.

> **Repository ≠ project.** A repository is one kind of project, not a synonym
> for one. If a doc or a menu says "project", it means the band — which may or
> may not be git-backed.

### Registering a repository project

A repository entry carries what the server needs to work on it autonomously:
its default branch, its `owner/name` on GitHub (for pull requests), how to
install dependencies in a fresh worktree, and how to boot its dev server for
previews. They live in `~/.opensession/config.json` — see
[docs/instance-configuration.md](docs/instance-configuration.md).

A repo can also commit its own lifecycle scripts (`.opensession/setup.sh`,
`.opensession/start.sh`) so every worktree provisions and boots itself without
instance config. That convention is what lets an agent open its own change in a
real browser — see [docs/repo-lifecycle.md](docs/repo-lifecycle.md).

One repository can be marked a **shared checkout**, meaning its sessions work
directly in the main clone rather than in worktrees. Open Session's own
repository is configured that way so sessions improving it are editing the thing
that is running. It has sharp edges; read
[docs/worktrees.md](docs/worktrees.md#the-shared-checkout-exception) before
turning it on for anything else.

### Adding a feed project

A feed project is defined as data, not code: which connected MCP server backs
it, which tool lists its items, and how that tool's fields map onto
title/preview/timestamp. Add one from Connections → Projects. Any MCP server
with a list-shaped tool can become a band.

Feed projects also scope their sessions' tools: a project declares which MCP
servers its sessions get, so a session opened from a video never sees your billing
tools.

## Workspaces

A workspace groups the sessions about one piece of work. Every session belongs to
exactly one workspace, and a workspace is what you see as a row in the sidebar —
its sessions are its children.

The important part: **a workspace can own a worktree**. When it does, it holds a
repo, a branch, a worktree directory and any attached repos, and new sessions
created in it inherit that worktree by default. So a workspace is usually "this
branch, and every conversation I had while building it": the session that made the
change, the follow-up that fixed review comments, the one that debugged CI.
They share a checkout and add up to one pull request.

A workspace with no worktree is fine too — that is what an ask-style workspace
looks like, or a feed workspace for a ticket where there is nothing to check
out, or a fresh one before any code session materializes it.

A scratch workspace has no project at all. It sits outside the project bands in
the sidebar and gives its sessions a shared scratch directory instead of a repo.

Feed items resolve to a workspace through a generic external reference, which
is what makes the linkage stable: the same ticket always reopens the same
workspace instead of spawning a new one.

## Sessions

A session is one conversation with an agent. It has a transcript, a model, a
working directory, a queue of pending prompts, and a state you can see from the
sidebar (running, waiting on you, idle).

Sessions are the unit everything else produces. An automation run is a session. A goal
wake is a session. An action run is a session. That is deliberate: whatever started
it, you can open it, read the whole transcript, steer it mid-flight, and fork it
into a normal conversation.

### Modes

A session's mode decides what it can touch:

- **`ask`** — read-only. No worktree of its own; it shares a per-repo checkout
  pinned to the default branch. Cannot write files. Use it for questions,
  investigation and code reading.
- **`code`** — its own worktree on its own branch, with write tools. It can
  commit and open a pull request. This is the default, and the one that costs
  disk.
- **`scratch`** — no repo at all, just a working directory. This is what a session
  in a feed workspace gets when there is nothing to check out.

### Multi-repo sessions

A session has one primary repo and can **attach** more. Each attached repo gets its
own isolated worktree, branched to match the session's primary branch, so a change
spanning two repositories lines up and produces two pull requests that match.
Diffs, file mentions and the PR panel all become repo-aware once a session spans
more than one.

### Turns, queues and steering

You prompt; the agent takes a turn. While a turn is running, anything you send
is either delivered as a steer or queued behind it and delivered as the next
turn — nothing is dropped. A session can also ask *you* something mid-turn and park
until answered, which is what puts it in the "needs input" lane.

Sessions can spawn other sessions. An orchestrator delegates focused work to workers
(their own context, possibly a different model), reads their reports and keeps
the final call. Spawn depth is capped so this cannot run away.

## Where a session runs

**Worktrees** are the default. Every code session gets its own git worktree — a
separate working directory sharing one `.git` — so two sessions on the same repo
never see each other's edits and never fight over the index. Creating one
installs dependencies up front so the agent does not spend its first two minutes
on `bun install`. This is also where your disk goes:
[docs/worktrees.md](docs/worktrees.md).

**Sandboxes** are optional isolation. Instead of running on the host, a session can
run inside a container — Docker locally, with adapters for hosted providers. Use
them when you do not want agent-run commands touching the host at all:
[docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md).

**Nodes** are other machines you attach with `opensession connect`. They exist
for work that physically cannot happen on the server: an iOS build needs macOS
with Xcode, a Windows build needs MSVC. A session on the server reaches out to a
node to run commands there. See [docs/nodes.md](docs/nodes.md).

## Automations

An automation is a prompt plus a trigger. When it fires, it creates a **fresh
session** and runs the prompt in it.

The trigger is a cron schedule, a one-off time, or an external event: a message
in a watched Slack channel, an incoming support ticket, a failure signal from
your logs. The run shows up in the sidebar like any other session, with its full
transcript.

The defining property is that automations are **amnesiac**. Every run starts
clean. That is what makes them safe to point at untrusted input — a support
ticket's text is data the agent reads, never configuration for the run — and it
is why they are scoped tightly:

- each automation names the MCP servers its runs may see, and gets only those;
- runs get a minimal environment with none of your tokens;
- customer-facing and identity-mutating tools are denied outright;
- `mode` applies here too — an `ask` automation cannot write; a `code`
  automation gets a worktree and can open a pull request, never merge one.

Automations are data, not code: create one from the UI or by talking to the
agent. Reusable ones can be packaged as **recipes** — a JSON file in
`recipes/automations/` installable with `opensession automations add <id>`.

## Goals

A goal is the opposite trade from an automation: **one session, pursued over days
or weeks**.

Where an automation fires a fresh amnesiac session on a tick, a goal drives a
single session that is resumed on every wake — so context carries, and the agent
remembers what it already tried. It paces itself (each wake schedules its own
next one, with a floor so a buggy run cannot hot-loop), pauses for human
sign-off when it needs a decision, and stops when its success condition is met.

The mission is just a prompt. Goals are for open-ended, long-horizon work — "get
this metric under X", "keep this migration moving" — where the value is in
continuity rather than in a clean slate.

A goal has a mode like a session: `ask` for research and measurement, `code` for a
persistent worktree it can keep opening pull requests from.

## Actions

An action is a form in front of a script. You register a script that already
lives in a repository, describe its inputs as form fields, and anyone can run it
without a terminal.

A run is not a bespoke output panel — it spins up a real session on a fast, cheap
model that executes the command and reports the output. So it lands in the
sidebar with a transcript, and if the output is surprising you fork it into a
full session and dig in.

## Workflows

A workflow is a model-authored script that fans out agent runs deterministically
— `agent()`, `parallel()`, `pipeline()`, `phase()` — and executes in a contained
worker.

The point is control flow that should not be model-driven: loops, conditionals,
verify-every-finding fan-outs. A workflow agent is a focused
read-analyze-report worker; heavier, steerable work stays on a spawned session.
Limits (concurrent agents, lifetime agent count, per-agent timeout) are enforced
by the runner.

## Integrations

An integration connects an external system: Slack, Linear, Plain, GitHub,
Stripe. Each owns its webhook routes and a background loop, and each is off
until you enable it.

Integrations do two things in the model above. They can **back a feed project**
(Plain's tickets, Slack's channels), and they bring work in without the UI: a
Slack thread becomes a session you can reply into from Slack; a pull request review
becomes a session that fixes the comments; a support ticket triggers a triage
automation. The session is always the same object underneath — you can open any of
them in the web UI mid-flight.

## Tools: MCP servers and skills

**MCP servers** are how sessions get capability beyond files and shell. Any Model
Context Protocol server you add becomes tools your agents can call — and, if it
has a list-shaped tool, a candidate feed project. Two properties matter for the
model above:

- servers carry **their own credentials** — agent subprocesses get a minimal
  environment without your tokens;
- a server can be scoped to specific people (`allowedUsers`), and automation
  runs pass no user at all, so a restricted server is invisible to them.
  Fail-closed by design.

**Skills** are prompt-level extensions — a directory with a `SKILL.md` the
engine loads on demand, invocable as a `/`-command in the composer. They come
from your user config, from the repository's own checkout, or from the engine
itself.

See [docs/extending.md](docs/extending.md) for both, plus integrations and
providers.

## Putting it together

A typical loop, in the vocabulary above:

1. You register the repository **project** `myapp` once, and connect Plain as a
   second project.
2. You start a **session** on `myapp` in `code` mode. That creates a **workspace**
   and cuts a **worktree** on a new branch.
3. The agent takes **turns** — reading, editing, running the test suite in the
   worktree, opening a pull request.
4. Review comments arrive. The GitHub **integration** opens another **session** in
   the same workspace, on the same worktree, and it pushes fixes.
5. A ticket lands in the Plain project. Opening it gets you its **workspace**;
   a triage **automation** has already run a fresh, amnesiac session there and left
   an internal note.
6. Meanwhile a **goal** you set two weeks ago wakes itself every morning,
   remembers everything it has already tried, and moves one long migration
   forward.

## Where to go next

- [docs/worktrees.md](docs/worktrees.md) — how sessions map to git worktrees, and
  where the disk goes
- [docs/repo-lifecycle.md](docs/repo-lifecycle.md) — the `.opensession/`
  scripts a repository commits so its worktrees provision and boot themselves
- [docs/instance-configuration.md](docs/instance-configuration.md) —
  repositories, identity, branding, integrations, seeds
- [docs/extending.md](docs/extending.md) — MCP servers, recipes, integrations,
  providers
- [docs/nodes.md](docs/nodes.md) — attaching another machine
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — isolated
  execution
- [docs/setup/](docs/setup/README.md) — installing, and the trust model
