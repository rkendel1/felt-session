# Session kernel architecture

Open Session has one logical owner for every session. The owner is a
`SessionKernel` actor addressed by the canonical session id. Its writable store
and lease coordinator run in a separate Worker isolate; the gateway reaches it
through a versioned IPC client. HTTP routes, WebSocket handlers, MCP tools,
automations, timers, recovery, and executors are clients of that owner. They do not own session lifecycle state themselves.

## Invariant

For one session id, one kernel serializes commands and is the only module that
may commit session mutations. Read models can lag. They never decide whether a
prompt starts, whether a run is busy, whether recovery retries, or whether an
executor event belongs to the current run.

The implementation lives in
`packages/core/opensession-server/src/server/session-kernel/`.

The target is an Erlang/Durable Objects style state machine: each typed message
is reduced and committed in one short actor turn, external work is emitted as a
durable effect, and results return as fenced messages. The actor never waits for
a model run or gateway callback before processing the next state fact.

## Durable state

`~/.opensession-sessions/session-kernel.sqlite` contains:

- Durable commands, keyed by session id and client request id.
- Authoritative run state, run id, and generation.
- A monotonic session change stream.
- Durable timers.
- A retrying effect outbox.

Completed request ids are retained permanently because clients retain unresolved
intents without an expiry. Payloads become SHA-256 fingerprints after admission. Large semantic results
remain fully replayable until the client durably records and delivers
`command_ack`; the client retries that acknowledgement until
`command_ack_result`. After 30 days acknowledged results compact to a permanent
digest marker. Terminal
failures always retain their bounded error. Replaying an unresolved id therefore
returns the complete committed result without duplicating attachment bodies
forever. Reusing an id with another payload is
rejected. WebSocket receipt replay is capability-negotiated. Mutations wait
behind the hello handshake, then become durable commands on a capable server
or one-shot sends on an older server. A command whose actor lease was
interrupted becomes pending again only when its server call site explicitly declares
the operation replay-safe. Replay policy is not part of client request identity,
and the first policy-aware migration preserves pre-existing interrupted receipts. The default is fail-closed: interrupted physical work
becomes `indeterminate` and cannot execute again without reconciliation. Web and
native clients keep every unresolved mutation envelope until `command_result`,
without age or count eviction, then replay the same request id after reconnect
or app restart. Chrome keeps unresolved create and follow-up intents by request
identity instead of overwriting one ambiguous request with the next. Completed retries return the
stored result; interrupted retries re-enter the actor with the original id.

Large attachments are not copied into the command journal. Their content hash
is part of the command identity. Create requests derive a stable session id
from the verified actor and request id. Every opening prompt enters a durable dispatch record before the session file is
announced. Create retries and boot recovery share one request-derived
prompt-entry id: whichever path runs first adopts that dispatch, so they cannot
launch two opening turns. Creation is owned by the deterministic target session,
not a person-wide mailbox. Command admission completes once the session and
opening dispatch are durable, while the opening run continues under generation
fencing. A retried create rebuilds
its full environment plan from the deterministic id and original request. A
0600 create-plan record persists nondeterministic branch and workspace choices
before those resources are created, plus the serializable `ResolvedCreate`
decisions (model, sandbox, MCP scope and assembled opening context) before the
opening run. Attachments remain in their dedicated durable store rather than
being copied into the plan. The plan survives until setup completes. REST and native callers reuse the original request id. MCP calls derive it from
the model's durable tool-use id, which the Pi bridge forwards in request
metadata rather than relying on a transport JSON-RPC id. Recovery therefore
resumes the same worktree, attachment, sandbox or runner preparation before
delivering the opening prompt.

## Runtime ownership

The kernel owns the runtime slots previously stored in unrelated global maps:

- Prompt queues and dispatch receipts.
- Steer receipts and the explicit Stop latch.
- Pending asks and their timer handles.

The existing queue and ask persistence formats remain readable during this
migration. Runtime values are exposed as immutable copies, so mutations cannot
bypass an actor lease by changing an array returned from a Map-compatible view.
Idle gateway facades without runtime state passivate. Addressing a session activates it
again from durable state.

## Run ownership

Run state is durable and explicit. Run events are typed actor messages. The
Worker validates the transition, current run id and generation, then commits the
new state and change event in one SQLite transaction. This reducer remains
responsive even while a gateway command is waiting on external work.

Registering a new run id increments the session generation. Registering the
same logical run again, such as a detached host reconnect, keeps its generation.

Detached host events and direct side-effect frames (transcript, asks and failed
steers) are accepted only while their stable logical run id is current. An
input from an older physical host is audited, ignored, and that host is asked
to stop. A missing executor is not proof that a run is dead. Restart recovery retains
uncertain journals, refuses to replay persisted `starting` launches with
execution evidence, and settles durable kernel state only when no recoverable
journal owner exists. Stop retains that journal until the host reports terminal
or its launcher proves absence. Cancel and interrupt receipts bind to the run
generation present at admission, so replay cannot affect a successor.

## Mutation boundaries

The following public compatibility modules delegate writes to SessionKernel:

- `run-state.ts`
- `queue-state.ts`
- `asks.ts`
- `session-cache.ts`
- `transcript-store.ts`
- `session-control-wiring.ts`
- `ws-handlers.ts`

`updateSessionFile` remains the session JSON compatibility facade, but its
per-session serialization belongs to the kernel. Direct session JSON writes
outside that facade are rejected by a structural test.

The transcript database keeps its own `changeSeq`, which is the client replay
cursor. SessionKernel also records lifecycle and metadata changes in its own
change stream. Token deltas remain ephemeral.

## Timers and effects

A process timer is only a wake-up. The durable timer row is the authority. Timer
firing enters the same command mailbox with a deterministic request id. A
restart or duplicate wake therefore runs the decision once.

External effects can be added to the kernel outbox in the same transaction
that completes a command. Delivery is destination-idempotent at-least-once: a
crash after a destination accepts an effect but before acknowledgement retries
the stable effect id. It is exact-once only where the destination honors that
id. Each effect has a stable destination id and unique command-local key. Registered handlers retry with exponential backoff; poison
effects dead-letter after a bounded attempt count. Unknown kinds remain queued but
are excluded from registered-kind work batches, so version skew cannot make them head-of-line block compatible work. Timers and
outbox effects both dead-letter after bounded attempts; authenticated operators
can inspect, paginate, retry or discard them through
`/api/system/session-kernel/dead-letters`.
Slack human-ask delivery is the first production handler and uses the ask id as
Slack `client_msg_id`. Durable timers use the same bounded backoff discipline.

The runtime starts only after run-host recovery and queue restoration establish
ownership. Any recovery-gate error fail-stops the gateway before timers or
outbox effects can run. Shutdown stops the runtime before draining the server.

## Read projections

The existing session-list cache, list snapshots, search index, and workspace
summaries are read projections. They may be rebuilt or served stale while a
refresh runs. Admission and recovery consult SessionKernel and the engine
control plane, never those projections.

Transcript clients already reconnect by durable `changeSeq`. This keeps a
future gateway process split mechanical: the gateway can translate commands
and replay committed changes without becoming another session owner.

## Process boundary

The writable `SessionKernelStore` and per-session lease coordinator run in
`session-kernel-worker.ts`, a separate JavaScript actor isolate. The gateway
starts and handshakes that actor before hydrating queue or ask projections.
Run-state facts use exhaustive typed IPC and are reduced autonomously in the
Worker. Runtime timer/outbox work is loaded through asynchronous typed IPC, so
the one-second wake does not block the gateway or allocate fixed multi-megabyte
SharedArrayBuffers. Remaining gateway command closures still use the older lease
adapter while their queue, ask, create and turn behavior moves into typed
reducers. Synchronous compatibility writes use a bounded SharedArrayBuffer RPC;
when they must run during an older lease, the Worker remains the sole physical
writer and batches any resulting outbox effects in one transaction. This bridge
is not the target API and must shrink with each migrated domain.

Unmigrated decision closures still execute in the gateway as effect adapters,
but every such execution is fenced by the compatibility lease and its command
result is committed by the actor. Run-state transitions no longer use that
path. Terminal failures are durable receipts and do not execute again.
If the actor is lost after physical execution begins, commands fail closed as
`indeterminate` unless the call site explicitly declares a stable adoption path
with `replaySafe`. Handler failures can retry only for replay-safe commands;
durable timer commands opt into policy-driven retries until their timer
dead-letters. Session JSON and transcript databases remain specialized
physical stores whose writes run under that lease. Moving the actor from a Worker to an
independently supervised Unix process is now a transport and failure-isolation
change, not an ownership migration; no second writer or fallback is permitted.

## Tests

`session-kernel/kernel.test.ts` covers serialization, interrupted-command
re-admission, restart-persistent idempotency, generations, transactional
effects, timer/outbox backoff, dead-lettering, and passivation.

`session-kernel/actor-client.test.ts` exercises the real IPC boundary, including
cross-isolate serialization, duplicate-result replay, and sync/async race
fencing. Web and native outbox tests pin request-id retention through receipts.

`session-kernel/ownership.test.ts` pins the architectural boundary and rejects
new direct session-file writers. Existing queue, ask, journal, transcript,
host-client, and recovery suites exercise their compatibility facades through
the kernel.

## Writer lease and deletion fencing

The SQLite store carries a singleton writer claim with the process id and an
unpredictable owner token. Startup acquires that claim before checking or
migrating any other schema, so a losing process cannot modify a live actor's DB. A second live process cannot reset or process the
first process's commands. The database file is forced to mode `0600`.

Deleting a session first cancels its active engine or detached host and waits
for ownership to be released. If absence cannot be proven, deletion returns a
conflict and keeps the session. A successful deletion leaves a permanent tombstone after its files, transcript
and runtime slots are removed. Recreating intentionally deleted work requires a
new request identity and therefore a new deterministic session id. Late executor
frames, run outcomes and queued commands cannot recreate the deleted session.

## Scheduled prompts

Scheduled prompts use the same durable timer runtime. Their schedule id is also
the prompt delivery id. A crash after queueing but before timer acknowledgement
adopts the existing queue or command receipt on retry. The former destructive
30-second polling loop is no longer part of delivery.

Slack ask escalation uses a stable human-ask id and Slack `client_msg_id`, so a
retry after an ambiguous network response asks the same external question
instead of posting a second one. GitHub conflict transitions likewise persist
their delivery intent until SessionControl durably admits it. Restored ask
answers keep their durable card until the stable continuation delivery is
admitted, so a restart cannot lose the answer between retirement and queueing.
