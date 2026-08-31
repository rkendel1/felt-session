# FeltDB per-session decision backbone

Status: implementation contract. This document changes no runtime authority.
It is based on the transaction inventory in
[`session-kernel-sqlite-transaction-map.md`](../session-kernel-sqlite-transaction-map.md)
at `f2027ac87` and the FeltDB 0.7.2 server transaction and authority-query APIs.

## Decision

The safe migration boundary is the complete per-session decision backbone, not
an individual reducer family. Every operation that advances the shared change
sequence moves together with its domain record, journal write, and any coupled
effect intent.

```text
actor decision
     |
     v
read session head and required domain records
     |
     v
one FeltDB transaction
     |
     +-- version, epoch, lease, and tombstone guards
     +-- updated session head
     +-- updated domain record(s)
     +-- exactly one journal record
     +-- zero or more outbox records
     +-- one logical-operation receipt
```

SQLite remains authoritative for an unmigrated session. FeltDB is authoritative
for a migrated session. There is no live mirror, synchronization path, fallback,
or mixed reader/writer mode.

The atomic decision model is expressible by the current FeltDB API. It depends
on multi-record transactions, `ifVersion`, `requireAbsent`, `expectedEpoch`,
`expectedLeaseId`, stable transaction replay, and zero-write conditional
conflicts. It does not require a numeric sequence allocator: new outbox records
use their already stable effect identity as their key.

FeltDB 0.7.2 adds the authority-side filter, ordering, bounded limit, and cursor
required by the complete live boundary. Journal pages and the global due-outbox
worker use `StateFirstDB.query`; they must not use `Collection.where`, `find`, or
local collection indexes because those operate on the client collection cache.

## Collections and records

Collection and record identifiers use only FeltDB's accepted identifier
characters. Dynamic components are SHA-256 encoded when concatenation could
violate that constraint or be ambiguous.

### `opensession_kernel_sessions`

Record ID: `sessionId`.

This bounded record is the decision head and authority marker:

```ts
type SessionDecisionHeadV1 = {
  schemaVersion: 1;
  sessionId: string;
  authority: {
    owner: string;
    epoch: number;
    lifecycle: "active" | "tombstoned";
  };
  lease: null | {
    leaseId: string;
    epoch: number;
    expiresAt: number;
  };
  decisionEpoch: number;
  changeSeq: number;
  run: {
    state: string;
    since: string;
    lastEvent?: string;
    generation: number;
    currentRunId?: string;
  };
  migratedAt: number;
  migrationId: string;
  updatedAt: number;
};
```

`changeSeq` is the last committed journal sequence. Run state belongs in the
head because every journal-writing decision already reads it and because run
ownership and generation fence several other domains. Arrays, history, command
receipts, and effects do not belong in this record.

FeltDB owns `__version`; clients must never put it in a write value. FeltDB
increments it when a guarded head update commits. Open Session owns all declared
fields. `authority.epoch` and `lease` use the shapes understood by FeltDB's
`expectedEpoch` and `expectedLeaseId` predicates.

`decisionEpoch` identifies the current logical contents of a session. Ordinary
decisions do not change it. Administrative clear advances it and resets
`changeSeq`; domain, journal, receipt, and effect records carry the observed
decision epoch. This makes records from an earlier clear inert without an
unbounded delete transaction.

An active head is the cutover marker. An absent head means the legacy authority
still applies. A present head is never deleted. Deletion changes its lifecycle
to `tombstoned` and advances its version and epoch.

### Domain collections

The following collections hold bounded state. Unless noted, the record ID is
`sessionId` and the record contains `schemaVersion: 1`, `sessionId`, the current
domain payload, its existing domain revision or generation, and `updatedAt`.

| Collection | Contents | Record ID |
| --- | --- | --- |
| `opensession_kernel_creation` | creation identity, state, generation, current effect, bounded completed-effect receipts, setup/opening plans, last change sequence | `sessionId` |
| `opensession_kernel_asks` | ask revision and current ask record | `sessionId` |
| `opensession_kernel_delivery` | revision, queued, dispatch, interrupt, steered, pending steers | `sessionId` |
| `opensession_kernel_turns` | revision and cancellation receipt | `sessionId` |
| `opensession_kernel_turn_projections` | projection payload, generation, and phase | hash of `sessionId:projectionId` |
| `opensession_kernel_commands` | command admission, processing state, replay policy, result receipt, and hashes | hash of `sessionId:requestId` |

Domain records retain their current bounded-size validation. A domain mutation
is guarded by both the head version and the observed domain record version. A
missing record is created with `requireAbsent`; an existing record is replaced
with `ifVersion`.

Projection generation uniqueness is represented by a separate claim record in
`opensession_kernel_turn_projection_generations`, keyed by the hash of
`sessionId:generation`. Creating a projection creates both the projection and
claim with `requireAbsent`. This replaces the SQLite unique index without a
query-then-write race.

### `opensession_kernel_changes`

Record ID: SHA-256 of `sessionId:decisionEpoch:changeSeq`.

```ts
type SessionKernelChangeV1 = {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  changeSeq: number;
  kind: string;
  payload: unknown;
  transactionId: string;
  createdAt: number;
};
```

Within one decision epoch, `(sessionId, changeSeq)` remains the logical unique
key. The storage ID hashes `sessionId:decisionEpoch:changeSeq`, allowing an
administrative clear to retain inert audit records without colliding when the
new epoch restarts at sequence one. It needs no independently allocated
identifier. Every journal operation uses
`requireAbsent`. The next sequence is always the observed head's `changeSeq +
1`, and the same transaction writes that value back to the head.

### `opensession_kernel_outbox`

Record ID: SHA-256 of `sessionId:decisionEpoch:effectId`.

```ts
type SessionKernelOutboxV1 = {
  schemaVersion: 1;
  effectId: string;       // `${sessionId}:${kind}:${effectKey}`
  effectKey: string;      // domain idempotency identity
  sessionId: string;
  decisionEpoch: number;
  kind: string;
  payload: unknown;
  status: "pending" | "dead_letter";
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  deadLetteredAt?: number;
  createdAt: number;
};
```

The numeric SQLite `id` is not a semantic identity. It currently supplies a
globally unique routing key through `allocateIsolatedOutboxId`. FeltDB replaces
it with the deterministic outbox record ID; worker APIs use that string key and
`(nextAttemptAt, recordId)` for deterministic ordering. The effect record and
its decision are written in one transaction with `requireAbsent`. No allocator
or second routing authority is required.
The storage key includes `decisionEpoch`, so clearing a session cannot collide
with an inert effect from its prior contents.

The existing effect executors already receive `effectKey` as their destination
idempotency identity. A replay returns the prior transaction receipt and does
not create a second effect record.

Worker lifecycle APIs address the FeltDB outbox record ID, not `effectId` alone,
and return both identities in `DurableOutboxItem`. Paging is ordered by
`(nextAttemptAt, recordId)`. This remains unambiguous across a clear even if a
domain intentionally reuses an effect key.

### `opensession_kernel_transactions`

Record ID: SHA-256 of `transactionId`.

```ts
type SessionKernelTransactionReceiptV1 = {
  schemaVersion: 1;
  transactionId: string;
  operationId: string;
  sessionId: string;
  operationKind: string;
  inputHash: string;
  changeSeq: number;
  journalId: string;
  effectIds: string[];
  result: unknown;
  committedAt: number;
};
```

Receipts are bounded. Large command results remain in their domain record or a
content-addressed record; the receipt stores the result reference and hash.
Receipt creation uses `requireAbsent` and is part of every decision transaction.
On replay, Open Session verifies `operationKind`, `sessionId`, and `inputHash`
before returning the recorded result.

### `opensession_kernel_migrations`

Record ID: `sessionId` during the one-way import. The record stores
`schemaVersion`, `sessionId`, `migrationId`, phase, source snapshot hash,
per-collection counts and hashes, and timestamps. Import batches update it with
`ifVersion`. The activation transaction requires its final verified version,
changes its phase to `activated`, and creates the head. This is the bounded
authority-side proof that every inert batch belongs to the snapshot being
activated; activation never relies on an unguarded preflight read.

## Fencing and sequence allocation

A decision reads the head including its authority-owned `__version`, validates
that it is active and owned by the current actor epoch and lease, then submits:

```ts
await db.transaction({
  transactionId,
  preconditions: [
    { collection: "opensession_kernel_tombstones", id: sessionId,
      requireAbsent: true },
    { collection: "opensession_kernel_transactions", id: receiptId,
      requireAbsent: true },
  ],
  operations: [
    { collection: "opensession_kernel_sessions", id: sessionId,
      value: nextHead, ifVersion: observedHead.__version,
      expectedEpoch: observedHead.authority.epoch,
      expectedLeaseId: observedHead.lease!.leaseId },
    { collection: domainCollection, id: domainId,
      value: nextDomain, ...domainGuard },
    { collection: "opensession_kernel_changes", id: journalId,
      value: change, requireAbsent: true },
    ...outboxOperations,
    { collection: "opensession_kernel_transactions", id: receiptId,
      value: receipt, requireAbsent: true },
  ],
});
```

The tombstone collection is described below. Although the head lifecycle is
also checked, the absent-record precondition is the atomic deletion race fence.

Actor ownership is acquired or renewed by a separate guarded head transaction.
It updates `authority.owner`, `authority.epoch`, and `lease`, using `ifVersion`
and the previously observed epoch and lease when one is still active. Taking
over an expired lease increments the epoch. Every subsequent decision carries
the acquired epoch and lease ID. Losing ownership changes the head version, so
an old owner fails even before its lease predicate is evaluated. Lease changes
do not allocate a journal sequence because they coordinate the authority that
may decide; they are not user-visible session decisions.

If two writers observe head version `V` and sequence `N`, both propose sequence
`N + 1`. The authority serializes the transactions. The winner advances the
head to version `V + 1` and creates the journal key. The loser fails its head
`ifVersion` guard, with zero writes. The journal `requireAbsent` independently
protects the composite sequence identity. Actor mailbox serialization is useful
for ordering but is not part of this proof.

## Mutation transaction matrix

In the table, `H` is the head, `D` is the named domain record, `J(N+1)` is the
new journal record, `R` is the logical-operation receipt, and `E*` is zero or
more outbox effects. Every row also has the tombstone-absence guard. `H(V,E,L)`
means `ifVersion: V`, `expectedEpoch: E`, and `expectedLeaseId: L`.

| Family | Reads and decision checks | Atomic operations | Additional guards and result |
| --- | --- | --- | --- |
| Creation | H; creation identity/state/generation/effect receipt; requested plan/effect | update H to `N+1`; upsert creation D; create J `creation_state`; optional E; create R | H(V,E,L); D version/absence; E and R absent. Invalid transition returns rejected without a transaction. A raced decision is a conditional conflict. |
| Run | H; turn cancel receipt for registration fences | update H run fields and `N+1`; create J `run_state`; create R | H(V,E,L); observed turn version when consulted; R/J absent. Stale run or invalid transition decided before commit; a changed consulted record conflicts. |
| Direct run state | H | update H run fields and `N+1`; create J `run_state`; create R | H(V,E,L); R/J absent. |
| Ask | H; ask D/revision | update H to `N+1`; set or delete ask D; create J `ask_state`; create R | H(V,E,L); ask version/absence; R/J absent. Exact answer replay is returned from R. |
| Delivery | H; delivery D; creation D when retiring a completed opening dispatch | update H to `N+1`; update delivery D; create delivery J; create R | H(V,E,L); delivery version/absence; creation version precondition when consulted; R/J absent. |
| Turn cancellation prepare | H/run generation; delivery D; turn D/cancel identity | update H to stopped state and `N+1`; update delivery; update turn; create J `turn_cancel_prepared`; create cancel E; create R | H(V,E,L); delivery and turn versions/absence; cancel E/R/J absent. Reuse of a cancel identity with another payload is rejected. |
| Turn cancellation phase | H; turn D | update H to `N+1`; update turn phase/revision; create J `turn_cancel_updated`; create R | H(V,E,L); turn version; R/J absent. |
| Turn outcome prepare | H/run generation; turn cancellation; projection and generation claim | update H to `N+1`; create projection D and generation claim; create J `turn_outcome_projection_prepared`; create projection E; create R | H(V,E,L); consulted turn version; projection, claim, E, R, and J absent. Existing matching R replays; occupied generation claim rejects. |
| Turn outcome settle | H; projection D | update H to `N+1`; update projection to completed; create J `turn_outcome_projection_completed`; create R | H(V,E,L); projection version; R/J absent. |
| Command completion | H; command D; proposed effects | update H to `N+1`; update completed command/result; create J `command:<type>`; create E*; create R | H(V,E,L); command version; every E plus R/J absent. A pre-existing effect with a different transaction is an identity conflict, not partial success. |

`enqueueOutboxMany` without a journal is not a per-session decision-head writer,
but its batch becomes one FeltDB transaction containing all deterministic effect
records and one batch receipt. Effect records all use `requireAbsent`; a replay
uses the receipt. Independent outbox lifecycle updates guard the observed effect
record version and retain the same effect ID.

Tombstoning and clearing are whole-session operations, not ordinary journal
writers. They must move in the same rollout because all of the domain records
above must stop changing at cutover:

- `tombstoneSession` creates the tombstone record, advances the active head to
  lifecycle `tombstoned`, clears its lease, and increments its authority epoch
  in one transaction guarded by H(V,E,L) and tombstone absence. Existing domain,
  journal, receipt, and outbox records become inert because no reader or worker
  may use a record unless its head is active and its `decisionEpoch` matches.
  The head and tombstone remain permanently. Physical reclamation is offline.
- `clearSession` is a stopped-session operation. One transaction advances
  `decisionEpoch`, resets the bounded current state and `changeSeq`, and records
  a clear receipt. Older records become inert by epoch rather than requiring an
  unbounded delete. Runtime readers pin the new head only after that commit;
  physical reclamation is offline.

## Tombstone authority

Collection: `opensession_kernel_tombstones`; record ID: `sessionId`.

```ts
type SessionKernelTombstoneV1 = {
  schemaVersion: 1;
  sessionId: string;
  deletedAt: number;
  authorityEpoch: number;
  transactionId: string;
};
```

Every mutation that can create or update live state includes a transaction
precondition requiring this record to be absent. This is an authority-side
predicate, not a preceding application read. Tombstoning creates the record
with `requireAbsent` in the same transaction that retires the head. Therefore a
mutation and tombstone racing from the same observed head cannot both commit:
the head version decides the race, and after tombstoning every future mutation
also fails the tombstone-absence predicate.

The tombstone is never deleted by ordinary runtime code. Re-creating the same
session ID is prohibited. The head lifecycle is retained for read routing and
diagnostics; the tombstone record is the atomic absence fence.

An outbox worker may discover a due record through a projection, but it must
claim that effect in a transaction guarded by the active head version, matching
`decisionEpoch`, authority epoch, lease, and tombstone absence before any
physical effect begins. A record from a cleared or tombstoned epoch therefore
cannot execute even if a stale due-work projection still mentions it.

## Identity rules

The identifiers have different meanings and are not interchangeable:

| Identity | Meaning | Derivation |
| --- | --- | --- |
| logical operation ID | Stable caller intent, such as command request, creation event, cancel, or projection | supplied at first admission and preserved across retries |
| transaction ID | Durable identity of one decided state transition | `opensession:kernel:v1:<session hash>:<operation kind>:<operation ID>` |
| receipt ID | FeltDB key for replay validation | SHA-256 of transaction ID |
| journal ID | Unique position in one session epoch's journal | SHA-256 of `sessionId:decisionEpoch:changeSeq` |
| effect key | Destination idempotency key within a kind and session | existing reducer-supplied key |
| effect ID | Globally unique durable effect identity | `${sessionId}:${kind}:${effectKey}` |
| outbox record ID | FeltDB-safe storage key | SHA-256 of `sessionId:decisionEpoch:effectId` |

The transaction ID is created before the actor request enters the mailbox and
is carried unchanged through actor, worker, client, HTTP, and FeltDB. A transport
retry resubmits the identical transaction document. A newly decided transition,
including a retry after a conditional conflict and fresh read, has a new logical
operation attempt and transaction ID unless the domain contract says it is the
same intent. Reusing a transaction ID with a different input hash is corruption
and fails closed.

## Conflict and retry semantics

`ConditionalConflictError` with code `PRECONDITION_FAILED` means zero operations
committed. The worker preserves it as a typed actor response. The reducer does
not classify it as a network failure and does not blindly resubmit its stale
transaction.

The caller may re-read and re-run the reducer only when that reducer explicitly
declares the logical operation safe to reconsider. Reconsideration must preserve
the logical operation ID while producing a new attempt transaction ID and must
honor domain outcomes such as `stale_run`, invalid transition, already answered,
or occupied generation. Physical-effect operations are not reconsidered unless
their destination idempotency contract permits it.

For an unknown transport outcome, retry the exact same transaction ID first.
FeltDB returns `duplicate: true` if it committed previously. The receipt then
provides the committed result. Authentication, validation, server, and network
errors remain distinct infrastructure failures.

## Read-path conversion map

The rollout changes readers with writers. `SessionKernelStoreHost` resolves the
authority once per actor activation by reading the FeltDB head: present means
FeltDB, absent means SQLite. That authority choice is pinned for the actor
lifetime. A present tombstoned head resolves to FeltDB and never falls back.

| State | Current reader | New authoritative reader | SQLite disposition after cutover |
| --- | --- | --- | --- |
| run state and journal head | `SessionKernelStore.runState` and cache | session head | OFFLINE MIGRATION ONLY |
| journal | `SessionKernelStore.changesSince` | query changes by session and sequence | OFFLINE MIGRATION ONLY |
| creation | `creationState` | creation collection | OFFLINE MIGRATION ONLY |
| asks | `askSnapshot`, `askEntries` | ask collection and catalog projection for cross-session lists | OFFLINE MIGRATION ONLY |
| delivery | `deliverySnapshot`, `deliveryEntries` | delivery collection and catalog projection for bounded cross-session work | OFFLINE MIGRATION ONLY |
| turn cancellation | `turnSnapshot` | turn collection | OFFLINE MIGRATION ONLY |
| outcome projection | `turnOutcomeProjection` | projection collection | OFFLINE MIGRATION ONLY |
| command receipt | `command` and admission helpers | command collection | OFFLINE MIGRATION ONLY |
| outbox | `pendingOutbox`, route lookup, lifecycle updates | outbox collection plus a FeltDB-maintained due-work projection | OFFLINE MIGRATION ONLY |

Before a session migrates, all rows above remain `UNMIGRATED AUTHORITY`. After
activation, no correctness read for those domains may consult SQLite. Global
workers must use catalog-maintained due-work projections and remain hard
bounded; they must not enumerate every session head.

The existing compatibility `FeltDbKernelChangeStore` collections are migration
scaffolding. The backbone implementation either imports their records into this
model or proves they contain no production decisions, then retires their read
path. They cannot remain a second change-sequence authority.

## Offline migration and cutover

Migration is one way and operates on one stopped session:

1. Stop and drain the session actor. Prevent a new activation with the existing
   placement/migration claim.
2. Confirm the FeltDB session head and permanent tombstone are absent.
3. Read one consistent SQLite snapshot of all backbone tables.
4. Validate domain schemas, hashes, run generation, journal density from 1
   through `changeSeq`, projection generation uniqueness, effect identities,
   and command receipts.
5. Assign a stable `migrationId`. Build deterministic FeltDB IDs and values.
6. Create and advance a migration manifest with guarded, replayable
   transactions. Import history and other potentially numerous inert records in
   bounded transactions tagged with `migrationId`, recording each batch's count
   and hash in the manifest. They are not visible to runtime readers because no
   head exists.
7. In the activation transaction, use a stable activation transaction ID,
   require the head and tombstone absent, guard the verified migration manifest
   version, write all bounded current domain records not already imported,
   advance the manifest to `activated`, and create the active session head in
   the same atomic commit.
8. Re-read the head and all current domain records, verify versions and hashes,
   verify journal continuity and pending/dead-letter effect identity, and run
   the session consistency checker against FeltDB only.
9. Mark the external placement migration claim complete. SQLite becomes offline
   migration evidence only and is never opened by that session's live actor.
10. Activate the actor, which sees the FeltDB head and pins FeltDB authority.

Imported inert records include `migrationId`; activation rejects records from a
different migration. An interrupted pre-activation import can be resumed with
the same IDs and transaction IDs or deleted by an offline cleanup job. It cannot
affect a live session. A crash after activation cannot return to SQLite because
the active head is durable.

The head's existence is the atomic authority cutover marker. It is created in
the same FeltDB transaction as bounded current state. Readers never observe a
head without that state, and no FeltDB writer accepts a session without a head.
The actor stop and placement claim prevent legacy SQLite writes across this
offline boundary. The placement claim is coordination, not a data authority;
after head creation only FeltDB fences decisions.

## Recovery protocol

| Point of failure | Recovery |
| --- | --- |
| Before migration claim | SQLite remains authoritative. |
| After claim, before head creation | Session remains stopped. Resume or clean the inert import using `migrationId`; SQLite remains authoritative. |
| During an import batch | Replay the same import transaction. No head means no live FeltDB reader or writer can use partial data. |
| After activation commit, before verification or actor response | FeltDB is authoritative. Replay activation to learn whether it committed, verify FeltDB, and never write SQLite. |
| After a normal decision commit, before actor response | Replay the same transaction ID; FeltDB returns the durable receipt and does not repeat journal or effects. |
| After successful migration | Actor activation resolves the durable FeltDB head and all backbone recovery reads use FeltDB. |
| Tombstoned session restart | The persistent head/tombstone resolves to FeltDB and rejects mutation; no SQLite fallback. |

Startup must not scan all session actors or SQLite files. Recovery is performed
for a known activated session or a hard-bounded migration/due-work index.

## FeltDB capability dependencies and proof gate

The implementation depends on these FeltDB 0.7.2 server guarantees:

1. one durable atomic transaction may write records in multiple collections;
2. `ifVersion` is checked at the authority and advances `__version` on success;
3. `requireAbsent` works for both written records and read-only preconditions;
4. `expectedEpoch` reads `authority.epoch` and `expectedLeaseId` validates the
   matching unexpired lease inside the commit boundary;
5. a conditional conflict is typed and guarantees zero writes;
6. a stable transaction ID is durably deduplicated across process restart;
7. deletes participate in the same guarded transaction as writes;
8. transaction size limits accommodate one bounded decision and its coupled
   effects;
9. indexed queries or maintained projections can page journal and due outbox
   records without a fleet-wide actor scan.

### Authority-query capability

Dependency 9 is provided by FeltDB 0.7.2 as `StateFirstDB.query`. It accepts an
authority query containing collection, equality/range predicates, stable order,
bounded limit, and continuation cursor, and returns records, `nextCursor`, and
`exhausted`. Embedded runtimes reject this capability instead of imitating it
with a client scan.

Open Session must use the following existing authority-side contract and cannot
substitute a scan, per-process index, polling mirror, or application queue
allocator:

```ts
type AuthorityQuery = {
  collection: string;
  where: Array<
    | { field: string; eq: string | number | boolean }
    | { field: string; gt?: string | number; gte?: string | number;
        lt?: string | number; lte?: string | number }
  >;
  orderBy: Array<{ field: string; direction: "asc" | "desc" }>;
  limit: number;
  cursor?: string;
};
```

The authority returns a stable continuation cursor and enforces a maximum
limit. Open Session uses two plans:

- journal: `sessionId = S`, `decisionEpoch = E`, `changeSeq > N`, ordered by
  `changeSeq`, limited;
- due outbox: `status = pending`, `nextAttemptAt <= now`, ordered by
  `(nextAttemptAt, recordId)`, limited.

The server must index these plans durably or maintain an equivalent
authority-owned projection in the same transaction as source changes. The API
must not implement filtering by first materializing the entire collection at
the client.

The 0.7.2 acceptance probe committed four records to a real packaged Rust
authority, queried `sessionId = s1`, `decisionEpoch = 1`, and `changeSeq > 1`,
ordered by ascending `changeSeq` with limit two, then used `nextCursor` to read
the final record. The first page returned sequences 2 and 3 with
`exhausted: false`; the second returned sequence 4 with `exhausted: true`.
Existing real-authority Session Kernel tests also passed transaction replay,
stale-writer conflict, zero losing writes, actor mailbox ordering, and restart
hydration against the packaged 0.7.2 server.

Before production reducer changes, a real FeltDB server test must prove:

- one decision commits head plus journal;
- two stale writers produce one winner, one typed conflict, and one sequence;
- state, journal, receipt, and outbox commit all or none;
- exact transaction replay creates no duplicate state, journal, or effect;
- committed state and replay receipts survive server restart;
- a mutation racing tombstoning cannot resurrect the session;
- concurrent creation, run, ask, and delivery decisions allocate distinct,
  contiguous journal sequences;
- an expired or replaced lease and stale epoch reject with zero writes;
- deterministic string effect IDs support claim, acknowledgement, deferral,
  failure, and due-work ordering without the SQLite numeric route allocator;
- activation-head creation is invisible until all bounded current records in
  that transaction are committed.

If any item fails on the server authority, production migration stops and the
missing primitive belongs in a separate FeltDB PR. Open Session must not replace
it with a mutex, numeric allocator, mirror, synchronization loop, or fallback.

## Implementation boundary

The next implementation PR must migrate, in one authority rollout:

- all journal-head writers in the evidence map;
- their domain records and coupled outbox records;
- tombstoning and clearing for those records;
- run, journal, creation, ask, delivery, turn, command, and outbox readers;
- outbox worker identity from numeric SQLite IDs to stable FeltDB effect IDs;
- offline import, activation marker, and recovery behavior;
- the real-server adversarial matrix above.

Only after that cutover may the corresponding SQLite rows be classified as
offline migration input and removed from live runtime paths.
