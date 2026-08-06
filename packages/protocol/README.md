# @tellahq/opensession-protocol

The wire and record contracts for [Open Session](https://opensession.com) cloud
agent sessions — **bring your own runner, bring your own UI**. The Open Session
server, web UI, and native clients (terminal, iOS/macOS, Chrome) are the
reference implementations; anything speaking these types can run or watch a
session.

Two protocols, one shared record:

## `./runner` — bring your own runner

The contract between a control-plane server and a **run host**: a process
that owns one agent run. `RunHostSpec` in; `HostToClientMsg` frames out
(`hello`, `event`, `ask`, `end`, …) and `ClientToHostMsg` back (`steer`,
`cancel`, `ask_answer`, …). Framing is newline-delimited JSON — `ndjsonReader`
is the reference reader. Local hosts serve a unix socket (live-only; the
transcript on disk is the durable copy), remote hosts layer seq/ack replay on
a WebSocket transport.

A conformant runner is anything that accepts a `RunHostSpec`, drives an agent
with it, emits `StreamEvent`s, and persists the transcript. Engine neutrality
is proven in-tree: the same contract drives Claude, Codex, and opencode runs.

## `./session` — bring your own UI

The contract between a session client and the server: the durable record
types (`TranscriptEntry`, `SessionUsage`, `AskQuestion`) and the core
WebSocket frames (`ProtocolClientMessage` / `ProtocolServerMessage`). A
client renders a live session with nothing but these: `watch` →
`transcript_init` (+ `transcript_append`, `load_history` pages), the
`stream_*` / `session_feed` live-turn events, `prompt` / `cancel` / queue
control to drive it, `ask_question` / `ask_resolved` for human-in-the-loop.

The reference web UI multiplexes app extensions (collaborative notes, team
terminals, presence, change pings) over the same socket — those are the
app, not the protocol, and are deliberately absent here.

## `./events` — the run event stream

Engine-neutral events a run emits while executing: `init`, `text_chunk`,
`tool_use`, `tool_result`, `usage_snapshot`, `model_switch`,
`runner_notice`, terminal `done`/`error`, with `TurnUsage` accounting.

## Compatibility

Fields are added, never repurposed. A server ahead of a client adds keys — it
never breaks one. Clients must ignore unknown frame types. Historical id
prefixes (`bks-`, `/backstage/*` route literals) are protocol constants;
renaming them is a breaking change.
