# os1-tui — `os`

OpenSession in your terminal. A herdr-style TUI that connects to an OpenSession
server and shows you *your* sessions: workspace sidebar, live transcripts, tabs,
tmux keys.

```
os --host os.company.dev
```

It is a **client and nothing else** — HTTP plus one WebSocket per watched
session. It never spawns an agent, never touches a worktree, never imports the
server. The sessions live on the box, so detaching (`^b d`) costs nothing and
closing your laptop doesn't stop a run.

## Install

From a checkout:

```bash
cd os1-tui && bun install
bun src/index.ts --host os.company.dev    # or: bun run dev
```

Standalone binary (no Bun needed on the target machine):

```bash
bun build --compile --minify --target=bun-linux-x64 src/index.ts --outfile os
# targets: bun-linux-x64 · bun-linux-arm64 · bun-darwin-arm64
```

The binary is ~120 MB — that's the Bun runtime plus OpenTUI's Zig renderer
statically linked, and it's the price of "one file, no dependencies".

`opensession tui` is an alias that hands off to `os` if you'd rather come at it
from the server CLI.

## Commands

| Command | What it does |
| --- | --- |
| `os` | the TUI, against the configured server |
| `os --host <url>` | …against a specific server, and remember it |
| `os <session-id>` | the TUI, opened on one session |
| `os login` | sign in via the GitHub device flow |
| `os logout` | revoke and forget this box's token |
| `os whoami` | host, user, token, and what the server thinks |
| `os sessions` | one-shot list, no TUI — for scripts and ssh one-liners |

Host resolution: `--host` → `OPENSESSION_HOST` → `~/.opensession/tui.json` →
`http://127.0.0.1:3850`. Bare hostnames get `https://` (loopback and `.local`
get `http://`).

## Keys

tmux by default: prefix `ctrl+b`, plus prefix-less `ctrl+arrow` movement.
`^b ?` shows this list in the app.

| Key | Action |
| --- | --- |
| `ctrl+←/→` | previous / next tab |
| `ctrl+↑/↓` | focus pane (sidebar · transcript · composer) |
| `↑/↓` · `j/k` | move in the focused pane |
| `enter` | open session · focus composer |
| `i` | jump to the composer |
| `enter` (composer) | send — queues behind a running turn |
| `ctrl+enter` · `alt+enter` | send as a steer instead |
| `1…9` | answer a pending question |
| `^b c` | new session |
| `^b w` | session picker |
| `^b n` · `^b p` | next · previous tab |
| `^b 0…9` | jump to tab |
| `^b x` | cancel the running turn |
| `^b &` | close tab |
| `^b ,` | rename session |
| `^b a` | archive session |
| `^b z` | zoom the transcript (hide the sidebar) |
| `^b [` | scroll mode — `b` loads earlier history, `q` exits |
| `^b :` | command prompt |
| `^b r` | reconnect |
| `^b d` | detach (sessions keep running) |

`ctrl+enter` needs the kitty keyboard protocol to be distinguishable from a bare
enter at all — `os` asks for it at startup, and terminals that don't speak it
(Terminal.app, older tmux) fall back to `alt+enter`, which every terminal
reports. `ctrl+c` is *not* quit here: it's forwarded as a session interrupt.

Command prompt verbs: `archive`, `rename <title>`, `new <prompt>`, `cancel`,
`reconnect`, `close`, `quit`. Anything else is sent to the session as a prompt.

## Status glyphs

| Glyph | Meaning |
| --- | --- |
| `⣾` | working (animated) |
| `?` | blocked on a question — this is the one that needs you |
| `✓` | done |
| `!` | last run failed |
| `⧗` | workspace still being created |
| `·` | idle |

Workspaces with something blocked float to the top of the sidebar.

## Layout of the code

```
src/client/     the server, as types — no terminal, no React
  types.ts            wire shapes (a documented copy, not a server import)
  api.ts              REST
  auth.ts             GitHub device flow
  socket.ts           one WebSocket: ping/pong liveness, backoff, resume cursor
  session-store.ts    frames → renderable state (pure reducer)
  watched-session.ts  socket + reduced state + subscribers (one per tab)
  sessions-poller.ts  the sidebar's REST poll + workspace grouping
  pool.ts             one WatchedSession per open tab
  config.ts           ~/.opensession/tui.json
src/ui/         the terminal, as components
  keymap.ts           tmux keys as a pure state machine
  ui-state.ts         where the user is (tabs/panes/modes), ref-backed
  app.tsx             the only mutator: Action → effect
  sidebar · transcript · composer · status-bar · help · theme · format
```

Two rules keep this honest:

- **Anything worth testing lives below `src/ui/app.tsx`.** The reducer, the
  keymap, the formatters and the socket are pure or injectable, and the tests
  drive them with plain objects.
- **Keys never mutate.** They resolve to an `Action`, and `runAction` is the
  single mutator. "What does this key do" is answerable by reading two files.

## Tests

```bash
bun test          # 49 tests, no server and no terminal required
bun run typecheck
```

`test/app.test.tsx` renders the real app into an in-memory terminal
(OpenTUI's test renderer) against a fake `fetch` and a fake WebSocket, presses
real keys, and asserts on the resulting screen. That's where regressions in
"does the sidebar show what's blocked" get caught.

## Protocol notes

Everything here is a path os1-ios already drives, so no server change was needed.
Three details are load-bearing, each learned from a bug in another client:

- **The server never pings.** The client sends `{"type":"ping"}` and treats a
  missed pong as a dead socket; a half-open TCP connection otherwise looks alive
  forever while the session silently stops updating.
- **No message-size cap.** A heavy `transcript_init` runs to megabytes; a 1 MB
  cap made one iOS session reconnect-loop forever.
- **`watch` is one session per connection**, which is why a tab is a connection.
  It's sent from the socket's open handler only — one code path for first connect
  and every reconnect, resuming from the `endOffset`/`rev` byte cursor so the
  server replays the gap instead of the whole tail.
