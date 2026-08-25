# Session kernel architecture

Open Session has one logical owner for every session. The owner is a
`SessionKernel` actor addressed by the canonical session id. Its writable store and autonomous reducers run in a separate Worker isolate;
the gateway reaches it through a versioned IPC client. HTTP routes, WebSocket handlers, MCP tools,
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
- Durable delivery and blocking-ask aggregates with monotonic revisions.
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
or one-shot sends on an older server. A command whose physical execution was
interrupted becomes a retryable durable failure receipt only when its server
call site explicitly declares the operation replay-safe. Admission committed but
never marked as executing is also promoted to that safe retry receipt on actor
restart, because no physical callback could have begun. Replay policy is not part of client request identity,
and the first policy-aware migration preserves pre-existing interrupted receipts. The default is fail-closed: interrupted physical work
becomes `indeterminate` and cannot execute again without reconciliation. Web and
native clients keep every unresolved mutation envelope until `command_result`,
without age or count eviction, then replay the same request id after reconnect
or app restart. Chrome keeps unresolved create and follow-up intents by request
identity instead of overwriting one ambiguous request with the next. Completed retries return the
stored result; interrupted retries re-enter the actor with the original id.
Readiness ages only pending or processing commands. Indeterminate outcomes have
separate count and oldest-age metrics, so a retained forensic receipt cannot make
an unrelated active command report the whole actor service as stale.

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

The actor owns two durable aggregates that previously lived in unrelated global
maps and JSON files. Production delivery and ask access fails closed when the
actor is unavailable. The direct store adapter exists only for isolated tests.

- Delivery state: ordered prompt queue, one pre-journal dispatch and steer receipts.
- Blocking ask facts: question identity, content, escalation and recovery state.

Delivery mutation and dispatch claim, acknowledgement or failure are short typed
Worker reductions. Mutation replies contain only the operation result and new
revision. They invalidate the gateway projection instead of returning or eagerly
refetching the full attachment-bearing aggregate. Queue batching policy (solo
interrupts, auto-continue, review handoffs, delegated reports and worker holds)
now runs inside the same actor reduction as the claim. The gateway supplies
only live policy facts such as whether child workers remain. The actor prepares
a stable interrupt identity and fenced cancel outbox effect before physical
cancellation, then records the explicit `confirmed` or `not_aborted` result. An
`executing` receipt makes cancellation retryable against only the same run
generation and an immutable physical dispatch identity; ambiguous retry
conservatively confirms instead of crossing into a successor that reused the
same session or engine alias. Claiming waits for confirmation and atomically moves
the interrupt with its selected batch into dispatch ownership. A crash or
launch failure restores the exact batch and confirmed interrupt together, so
restart cannot lose the solo target or separate hold bypass from steer framing.
Failure atomically restores that exact batch
ahead of later work. Actor-owned boot recovery reconciles each dispatch and
steer with idempotent reducers and never clears durable slots for a projection
rebuild. Interrupt preparation may atomically move an accepted-but-unread steer
receipt into its anchored queue position; `not_aborted` restores its original
steered position. Steering first moves an item to a pending-steer checkpoint,
then reports runner acceptance or rejection as a second typed fact. Restart treats
an unresolved checkpoint as ambiguous acceptance and reconciles it through the
receipt and transcript path instead of delivering a duplicate turn. The old queue and ask JSON formats are imported once under
durable migration markers, then deleted. Default-path writers no-op after the
marker commits; only explicit test/migration fixture paths retain JSON output.
Explicit Stop is also actor-owned. Preparation atomically records the target run
and generation, moves only unconfirmed steer receipts back to the queue, parks
the run state, and emits a `turn_cancel` effect keyed to the immutable physical
dispatch. `prepared`, `executing`, and settled receipts survive gateway crashes;
settlement precedes outbox acknowledgement, retries cannot cancel a successor,
and the durable `stopped` state keeps the queue parked across restart until an
explicit prompt advances the reducer. Boot recovery preserves and attaches an
exact journal owner named by a cancel receipt instead of treating `stopped` as
proof of absence. The effect reissues cancellation when that control appears;
an executing retry with no positive reconciliation remains failed closed. Small
run-targeting command payloads remain with their permanent receipts so reconnect
replay reconstructs the original run id and generation even after actor state
moves on. Resolver closures and timeout handles
remain process-local executor state because they are not durable decisions.

## Creation ownership

The actor persists a fenced creation aggregate with `planned`, `preparing`,
`opening_dispatched`, `ready`, and `failed` states. Typed creation events reject
identity crossover, invalid transitions, and stale physical-effect results while
other gateway work is active. Creation reductions can now atomically persist state and a stable typed effect.
The protocol names workspace, branch, sandbox, credential, attachment-reference,
and opening-turn effects, including adoption or reconciliation modes and durable
creation fences. Payload decoding strips unknown fields, so bearer credentials
and inline attachment bodies do not cross the durable executor boundary. The
creation aggregate durably retains bounded completed-effect receipts. An
executor result clears the current effect and records its stable ID in the same
state/change transaction. Actor-store restarts preserve those receipts, and a
completed effect cannot be emitted again after its outbox row is acknowledged.
The receipt set rejects new completions at a fixed capacity before acceptance.

The workspace effect now has a production executor. It creates a fixed-ID,
dedupe-keyed workspace or adopts the exact existing destination, then returns a
fenced result through the creation reducer before the outbox item is
acknowledged. A crash after the atomic workspace write adopts on retry. A crash
after result acceptance replays as an audited stale no-op. Identity, project, or
branch ambiguity dead-letters immediately instead of overwriting the workspace.
The interactive MCP and WebSocket create paths now record the actor plan before
physical setup and emit `creation_workspace_prepare` instead of writing a new
workspace. Their gateway continuations wait for the completed actor receipt,
never workspace file presence. Existing-workspace joins remain reads, while
create-plan JSON still carries other recovery decisions.
The branch effect also has a production executor. It adopts only an exact
project, branch, and worktree-path match, or materializes the requested branch
with stable base and isolation options before returning its actor fence. Branch
or path crossover is immediately indeterminate. An unregistered destination
that already exists also fails indeterminate instead of being overwritten, while
a crash after Git registers the worktree adopts it on retry. Credential
preparation now has a production
executor and stable intent. It validates only a durable principal selector and
scope, records no token or Git environment, and returns an ordinary fenced
receipt. Branch effects can carry that selector and resolve its process-local Git
capability only when Git creation is necessary. Both fresh and restored MCP
creates emit the credential receipt before the credential-bound branch intent.
WebSocket creates and cold create-plan recovery use the same actor materializer,
including an explicit existing-branch flag for PR heads. No create entry point
calls Git worktree creation directly.
Sandbox preparation now has a production executor and stable receipt intent. Its
durable effect carries the complete non-secret provider/session specification;
the provider's idempotent `ensure` adopts resources by canonical session key.
Session-key or returned-provider crossover is indeterminate, and a crash after
provider acceptance re-enters the same ensure before returning the fenced actor
receipt. Create entry points emit this effect before opening a sandboxed run.

Opening turns also enter the durable outbox. Create intake first records the
stable prompt dispatch, then atomically moves the creation aggregate to
`opening_dispatched` with one `creation_opening_turn` effect and the bounded,
non-secret opening recovery input in the same actor transaction. The executor
uses the active create registration or reconstructs the specification from that
actor-owned input after restart. Schema 11 also keeps branch, workspace,
attachment, and resolved setup decisions as write-once actor state. Opening
launch atomically retires that setup state in favor of the exact opening input.
Pre-schema-11 create-plan files remain a read-only mixed-version import fallback;
production has no create-plan file writer. Terminal actor settlement clears the
large recovery input while retaining the permanent effect receipt. It settles
`ready` or `failed` through the effect fence before
acknowledging the prompt dispatch. Run-journal admission and cold
queue restoration preserve actor-owned create dispatches until that settlement.
Boot leaves local openings with the generic run adopter and settles the actor
from that adopter's fenced terminal callback; remote sandbox and Runner journals
are deferred to executors that can physically adopt them. Runner openings derive
one stable host identity from the opening run fence, persist the prompt and host
identities in the run journal, and advance a durable
`prepared → launching → started` launch phase in a session-keyed launch-state
file as well as the run journal. A prepared retry may launch; a definite server
preflight rejection records a permanent `rejected` fence, while ambiguous
launching/started failures are quarantined out of boot recovery. Ambiguous
adoption requires positive Runner liveness evidence and otherwise fails closed
instead of duplicating or later reviving a creation already reported failed. Long-running opening effects use a
separate bounded runtime pool so they cannot consume all general outbox capacity.
The terminal event consumer persists final session/outcome projections and settles
the actor before requesting another generator item, so local, sandbox, and Runner
generator `finally` blocks cannot retire the only physical-owner journal first.
If a backend naturally ends without a terminal event, its wrapper replaces the
live journal with a durable abnormal-completion receipt instead of clearing it;
boot recovery or the opening executor settles that receipt without relaunching.
A crash after actor settlement adopts the completed receipt without launching
another turn. Direct `opening_dispatched` transitions without a typed effect are rejected.
Schema 15 makes Stop terminal for that opening effect as well as its physical
turn. The creation actor records a `cancelled` receipt for the exact effect,
clears its recovery plan, and fences late success. Opening recovery checks the
durable stopped turn or its retained cancel receipt before launch and while
awaiting a detached local owner, so a restart cannot resurrect a cancelled
opening prompt. Runner, sandbox, and local openings use the same stable token
for actor admission and physical control, letting Stop reach the exact backend
without giving up restart adoption. Stop bookkeeping never depends on the
creation settlement succeeding: a concurrent opening result racing the cancel
read is logged and skipped, while the durable `prepare_cancel` commit, queue
persistence, and broadcast always run. Retained cancel receipts fence by exact
run id and generation, matching the opening they cancelled.
Non-image create attachments are durably spooled to bounded source references,
then copied or adopted at deterministic session-owned paths by
`creation_attachment_stage`; digest crossover fails closed and inline bodies
never enter actor payloads. Removing the remaining create-plan compatibility
authority is the next creation cutover; the presence or absence of a plan file
is not actor lifecycle evidence.

## Run ownership

Run state is durable and explicit. Run events are typed actor messages. The
Worker validates the transition, current run id and generation, then commits the
new state and change event in one SQLite transaction. This reducer remains
responsive even while a gateway command is waiting on external work.

Registering a new run id increments the session generation. Registering the
same logical run again, such as a detached host reconnect, keeps its generation.
Prompt preparation also takes the actor decision before installing any gateway
reservation. A rejected candidate remains a cancelled local token and cannot
replace or launch ahead of the actor's current run, even when the gateway lost
its in-memory projection of that owner.

Schema 14 moves normal and opening-turn terminal outcome persistence behind the
typed `turn_outcome_project` effect. The actor validates the immutable run id and
generation, durably stores one receipt per generation, and commits the outbox row
in the same transaction. Stable projection ids and timestamps make transcript
notices and session-file patches destination-idempotent. Multiple completed turns
may await projection without overwriting accepted work; execution defers later
generations behind an earlier live projection without consuming dead-letter
attempts. The executor commits the transcript, `lastRunError`, and worker-failure
notification before settling the exact actor receipt and acknowledging the
outbox. Replays of completed, stale, cancelled, replaced, or tombstoned owners do
not project onto a successor. Compatibility-only callers without a physical run
fence still use the old facade while their launch paths migrate.

Detached host events and direct side-effect frames (transcript, asks and failed
steers) are accepted only while their stable logical run id is current. An
input from an older physical host is audited, ignored, and that host is asked
to stop. A missing executor is not proof that a run is dead. Restart recovery retains
uncertain journals, refuses to replay persisted `starting` launches with
execution evidence, and settles durable kernel state only when no recoverable
journal owner exists. Stop retains that journal until the host reports terminal
or its launcher proves absence. Cancel and interrupt receipts bind to the run
generation and immutable dispatch identity present at admission, so replay
cannot affect a successor that reused its session or engine aliases.

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
that completes a command. Effect payloads and fenced results are discriminated
unions in `lifecycle-protocol.ts`. Executors register once by typed effect kind,
validate a persisted payload before physical work, and cannot replace another
executor for the same kind. Delivery is destination-idempotent at-least-once: a
crash after a destination accepts an effect but before acknowledgement retries
the stable effect id. It is exact-once only where the destination honors that
id. Each effect has a stable destination id and unique command-local key. Registered executors retry with exponential backoff; poison
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

Background intake observes the same process-wide shutdown fence. New cron,
automation webhook, GitHub review and queued boot-recovery work cannot start
after the fence. Automation triggers accepted before the fence write a bounded
pre-launch intent with a stable session id and acceptance time before setup.
The intent remains through physical execution: boot defers to an existing run
journal, while completed projection effects record a terminal receipt that boot can
settle without model replay. Ledger settlement precedes intent retirement.
Accepted setup remains part of bounded drain accounting until physical handoff. Review shutdown preserves its active-run/result marker
rather than treating restart as user cancellation.

## Read projections

The existing session-list cache, list snapshots, search index, and workspace
summaries are read projections. They may be rebuilt or served stale while a
refresh runs. Admission and recovery consult SessionKernel and the engine
control plane, never those projections.

Transcript clients already reconnect by durable `changeSeq`. This keeps a
future gateway process split mechanical: the gateway can translate commands
and replay committed changes without becoming another session owner.

## Process boundary

The writable `SessionKernelStore` and autonomous per-session coordinator run in
`session-kernel-worker.ts`, a separate JavaScript actor isolate. The gateway
starts and handshakes that actor before hydrating projections.

A command admission is a short bounded reduction: the actor fingerprints and
persists the intent, then immediately returns `execute`, `in_progress`, or the
committed result. It never awaits filesystem, network, process, sandbox, Runner,
or model work. Different command intents can therefore be reduced concurrently,
and Stop or steering remains responsive while physical continuations are queued
or running. A restart re-admits replay-safe intent and marks ambiguous
non-replay-safe execution indeterminate.

Physical continuations run in gateway or executor workers outside the actor.
Their per-session mutex can queue physical work, but it does not hold the actor
mailbox. An exact retry of executing work receives `in_progress` immediately
rather than attaching an actor-held waiter. Typed completion and failure
reductions settle immutable receipts; settlement ambiguity fail-stops the actor
client rather than committing over a successor.

Transcript and session-file projections use typed admission and settlement
receipts, then mutate their specialized destination stores on the gateway thread.
The actor returns from admission before that destination work begins and retains
no execution waiter or callback. Moving the Worker to an independently supervised
local process is therefore a transport and failure-isolation change, not an
ownership migration; no fallback writer is permitted.

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

## Writer claim and deletion fencing

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
Explicit Stop requests likewise enter through a typed turn command plan: the
actor permanently selects the original run id and generation before gateway
bookkeeping or physical cancellation, and an exact retry cannot target a
successor. Durable timer tokens also key typed actor begin/complete/fail
receipts. Once actor completion commits, recovery retires only that timer
generation without executing its handler again; a crash before that commit
remains destination-idempotent at-least-once delivery. SessionControl prompt
delivery uses the same pattern: the actor fingerprints the full immutable
delivery identity before slash handling, queueing or steering, then stores the
returned delivery result for exact caller replay.
