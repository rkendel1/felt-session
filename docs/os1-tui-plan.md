# os1-tui — a herdr-style TUI client for OpenSession

Status: **built** (2026-07-30) — see `os1-tui/README.md` for the shipped
surface and `os1-tui/AGENTS.md` for the build loop. Phases 0–3 and 5 landed in
one pass; phase 4 (diff pane, PR panel, terminal pane) is still open, and splits
were dropped deliberately — tabs only, per review.

## What it is

A terminal client for an OpenSession server. It is *only* a client: it opens
HTTP + one WebSocket to a server (`os --host os.tella.dev`), lists that user's
sessions, streams their transcripts, and sends prompts. It never spawns agents,
never touches a worktree locally, never imports `src/server/*`.

That is the key difference from [herdr](https://herdr.dev/), which multiplexes
*local* agent CLIs in real ptys. We take herdr's shape — workspace sidebar,
panes/tabs, blocked/working/done/idle at a glance, tmux keys, works fine over
ssh — and point it at sessions that are already running on the server. Detach is
free: the sessions live on the box, so quitting the TUI costs nothing.

It becomes the fifth client alongside the web UI (`src/frontend/`), the Electron
shell (`os1-mac/`), the native Swift app (`os1-ios/`), and the Chrome extension
(`os1-chrome/`).

## Where it lives, and which binary

**Package: `os1-tui/`** — its own `package.json`, matching the `os1-*` client
naming. Not in `src/`: it must stay importable-from-nothing so a `bun build
--compile` binary doesn't drag the server in.

**Binary: a separate `os`, not a subcommand of `opensession`.** The existing
`opensession` CLI (`scripts/cli.ts`) is a *server-admin* tool — it imports
`src/server/integrations/registry`, manages the systemd unit, and is expected to
run on the box that hosts the server. `os` is the opposite: it runs on your
laptop and needs nothing but fetch + WebSocket. Keeping them separate keeps the
TUI binary small and keeps its startup free of server-module import cost.

We still get discoverability both ways:

- `os [--host <url>]` — the real entry point, a compiled single-file binary.
- `opensession tui` — thin alias in `scripts/cli.ts` that `Bun.spawn`s `os`
  (or `bun run os1-tui/src/index.ts` from a checkout).

Resolution order for the host: `--host` flag → `OPENSESSION_HOST` env →
`~/.opensession/tui.json` → `http://127.0.0.1:3850`. Bare hostnames get
`https://` prepended, same rule as `ServerConfig.baseURL` in os1-ios.

## Rendering: OpenTUI

`@opentui/core` + `@opentui/react` (0.4.5). Bun-native, Zig renderer over FFI,
Yoga flexbox layout, and it ships the components this app is mostly made of:
`ScrollBox`, `Input`, `Select`, `Code` (tree-sitter highlighting), `Diff`. It
powers opencode's TUI, so the "long streaming transcript in a scrollback pane"
path is proven at our exact workload.

Risk + mitigation: it's a native FFI dep, so it needs prebuilts for
darwin-arm64 / linux-x64 / linux-arm64. Phase 0 verifies all three before any UI
is written. The client layer (below) is deliberately renderer-agnostic, so if
OpenTUI turns out to be a dead end the fallback is a hand-rolled ANSI
diff-renderer and only the view layer is thrown away.

## Protocol — reuse what os1-ios already proved

No new server endpoints. The wire surface is exactly what `OS1API.swift` /
`OS1Socket.swift` use, which is the strongest evidence available that a
non-browser client can drive a session end to end.

REST (`<host>/api/…`; the server normalizes onto the internal
`/backstage/api/*` literals):

| Endpoint | Use |
| --- | --- |
| `GET /api/sessions` | the list; carries `isRunning`, `runState`, `waitingForInput`, `queuedCount`, `lastRunError`, `prState`, `projectId` |
| `GET /api/projects` | canonical workspace names for sidebar grouping |
| `GET /api/sessions/:id/transcript` | initial backfill (the WS also sends `transcript_init`) |
| `GET /api/sessions/:id/entry/:entryId` | unclamped body for a wire-clamped entry |
| `GET /api/sessions/search?q=` | fuzzy find across transcripts |
| `GET /api/sessions/:id/diff` | diff pane (phase 4) |
| `POST /api/sessions` | new session |
| `GET /api/models`, `/api/repos` | pickers |
| `GET /api/health` | connectivity + auth probe |

WebSocket `<host>/ws`, `Authorization: Bearer` on the upgrade. Out: `watch`,
`unwatch`, `load_history`, `prompt` (`busyMode: queue|steer`), `answer_question`,
`cancel`, `steer_queued_prompt`, `delete_queued_prompt`, `create_session`,
`ping`. In: `hello`, `transcript_init`/`_history`/`_append`, `stream_start`/
`_text`/`_tool_use`/`_tool_result`/`_done`, `session_status`, `queue_update`,
`ask_question`, `ask_resolved`, `notice`, `error`.

Two hard-won details to copy verbatim from the iOS client:

- **The server never pings.** The client sends `{"type":"ping"}` and treats a
  missed pong as a dead socket. Reconnect with backoff, then re-`watch`.
- **No message-size cap.** A heavy `transcript_init` is ~120 entries × 32 KB;
  iOS had to raise its 1 MB default or one session reconnect-looped forever.

Auth: probe `GET /api/sessions`. On 401 run the **device flow** —
`POST /api/auth/device`, print the user code + verification URI, poll
`POST /api/auth/device/poll` with `native: true`, which returns the token in the
body. Store it in `~/.opensession/tui.json`, mode 0600, alongside
`node.json` from `scripts/lib/connect.ts`. Servers without the auth gate work
with no token at all. `os login` / `os logout` / `os whoami` cover the rest.

## Layout

```
┌ workspaces ───────┬ tui: transcript ──────────────────────────────────┐
│ ● backstage    3  │  ▸ read  src/server/ws-handlers.ts                │
│   ├ ⣾ tui plan    │  ▸ edit  os1-tui/src/client/socket.ts             │
│   ├ ✓ sidebar fix │                                                   │
│   └ ? auth gate   │  Wired the reconnect backoff. Two things left:    │
│ ● tella-fusion 1  │  …                                                │
│   └ ⣾ upload race │                                                   │
│   feeds        0  ├───────────────────────────────────────────────────┤
│                   │ > _                                               │
├───────────────────┴───────────────────────────────────────────────────┤
│ os.tella.dev  michiel  opus-5  ⣾1 ?1  ^b ? help                       │
└───────────────────────────────────────────────────────────────────────┘
```

- **Sidebar**: sessions grouped by workspace, ordered like the web sidebar.
  Status glyph per session — `⣾` running (animated), `?` waiting on an
  AskUserQuestion, `✓` done, `!` last-run error, `·` idle — which is herdr's
  blocked/working/done/idle read, driven by `runState` + `waitingForInput`.
- **Main pane**: the watched session's transcript, streaming. Tool calls
  collapsed to one line, expandable. Code/diff blocks through OpenTUI `Code`.
- **Composer**: one-line input that grows; `queued` chips above it.
- **Status bar**: host, identity, model, global counts, prefix hint.
- **Tabs** = watched sessions. **Splits** = two sessions on screen at once.

## Keys — tmux by default

Prefix `ctrl+b` (rebindable via `prefix` in the config), plus prefix-less
`ctrl+arrow` movement, because that's what the muscle memory is.

| Key | Action |
| --- | --- |
| `ctrl+←/→` | previous / next tab |
| `ctrl+↑/↓` | focus previous / next pane (sidebar ↔ transcript ↔ composer) |
| `ctrl+h/j/k/l` | same, vim flavour |
| `^b c` | new session (repo + mode + model prompt, then `create_session`) |
| `^b n` / `^b p` | next / previous tab |
| `^b 0…9` | jump to tab |
| `^b w` | fuzzy session picker (all sessions, incl. archived) |
| `^b %` / `^b "` | split vertical / horizontal — second session side by side |
| `^b z` | zoom current pane |
| `^b x` | cancel the current run (`cancel`) |
| `^b &` | close tab (unwatch; asks before archiving) |
| `^b ,` | rename session title |
| `^b [` | scroll mode: arrows / PgUp / `g` / `G`, `q` exits |
| `^b :` | command prompt — `:model`, `:effort`, `:archive`, `:host`, `:reconnect` |
| `^b d` | detach (quit; sessions keep running) |
| `^b ?` | keybinding help overlay |
| `enter` | send — queues behind a busy run |
| `ctrl+enter` | send as a steer instead of a queue |
| `1…9` on an ask card | answer an AskUserQuestion |
| `esc` | leave composer, back to nav |

Send semantics mirror the web composer's per-gesture prefs: Enter queues,
`ctrl+enter` steers. Never silently forced either way.

## Phases

**0 — scaffold + client core.** `os1-tui/` package, `api.ts` / `socket.ts` /
`store.ts` under `src/client/`, no UI. A `SessionSocket`-style interface so tests
substitute a recording mock (copy the iOS split). `bun test` covers reconnect,
ping/pong death, `transcript_init` → `_append` → `stream_*` reduction, queue
state. Verify OpenTUI prebuilts on all three targets here.

**1 — read-only herdr view.** Sidebar + transcript + status bar, live streaming,
tmux nav keys, reconnect. This alone satisfies "connect and show my sessions".

**2 — interactive.** Composer with queue/steer, ask-question answering, cancel,
queue chips, `^b c` new session, archive.

**3 — multiplexing.** Tabs, splits, zoom, `^b w` picker, `^b :` commands,
transcript search.

**4 — depth.** Diff pane (OpenTUI `Diff`), PR panel, and a **terminal pane** via
the existing `term_start`/`term_input`/`term_resize` WS messages — a real shell
in the session's worktree (or sandbox). Rendering a pty inside a TUI pane needs a
terminal emulator we don't have, so v1 of this is a full-screen alt-screen
handoff (`^b !`) with raw passthrough until you detach — tmux-zoom semantics.

**5 — packaging.** `bun build --compile --target=bun-{darwin-arm64,linux-x64,linux-arm64}`,
`install.sh` support, `opensession tui` alias, `os1-tui/README.md` + an
`AGENTS.md` for the build/verify loop.

## Testing

The renderer is the untestable part, so almost nothing lives there. Everything
above the view is a pure reducer over wire frames, tested headlessly with a mock
socket and recorded frame fixtures captured from a real session. On top of that,
a smoke test drives the compiled binary against the live server in a pty
(`Bun.spawn` with a fake TTY), sends a scripted keystroke sequence, and asserts
on the rendered screen buffer.

## Decisions taken at review (2026-07-30)

1. **Tabs, no splits.** Splits were the bulk of the layout complexity for a
   layout nobody had asked for yet. `^b w` + `ctrl+←/→` covers the same ground.
2. **`os` is the binary name.**
3. **It ships with the open-source release**, so `install.sh` should eventually
   grow a client-only mode (not done yet).

## Still open

- Phase 4: diff pane (OpenTUI `Diff`), PR panel, and the terminal pane over
  `term_start` (full-screen alt-screen handoff — rendering a pty inside a TUI
  pane needs an emulator we don't have).
- `install.sh` client-only mode + published binaries per target.
- Mouse support. OpenTUI has it; herdr leans on it. Untouched here because the
  keyboard story had to be right first.
