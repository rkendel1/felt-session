# Session Kernel SQLite transaction evidence map

This inventory traces the remaining explicit SQLite transactions from
`actor-worker.ts` through `SessionKernelStoreHost` into
`SessionKernelStore`. It describes the code at `81cbe700d`; it does not change
runtime behavior.

## Result

Creation and run state are not an isolated migration family.

The following actor mutations all allocate the same per-session
`session_kernel_state.change_seq` and append to the same
`session_kernel_changes` journal:

- creation events;
- run events and direct run-state changes;
- ask mutations;
- delivery mutations;
- turn cancellation and outcome projection;
- command completion.

Creation, turn cancellation, turn outcome preparation, and command completion
also create outbox effects inside that same SQLite transaction. Moving only
creation and run would therefore leave SQLite and FeltDB concurrently assigning
one journal sequence, and moving their changes without their effects would
split an existing atomic decision. Neither is a valid migration boundary.

The `appendChange` path migrated in `81cbe700d` proves the actor, transport,
FeltDB transaction, replay, and fencing mechanism. No production reducer calls
that compatibility method. Production reducers listed below still derive their
sequence and commit their decisions in SQLite.

## Live actor transactions

| Actor operation | SQLite reads and decision guards | Atomic writes | Preserved invariant | Migration dependency |
| --- | --- | --- | --- | --- |
| `releaseQuarantine` | quarantine record; run state; pending or indeterminate commands; claimed timers; live outbox | command recovery state; quarantine deletion | release only after ambiguous work is either absent or deliberately recovered | commands, run, timers, outbox, quarantine |
| `applyCreationEvent` | tombstone; creation identity, state, generation and effect receipt; run change head | creation state; run change head; `creation_state` change; optional creation outbox effect | identity/effect replay and transition validation commit with the next effect | creation, run head, journal, outbox, tombstone |
| `applyRunEvent` | tombstone; run state, generation and current run; turn cancellation receipt | run state; `run_state` change | transition, run ownership, generation advancement and journal entry are one decision | run, turn, journal, tombstone |
| `setRunState` | run state and change head | run state; `run_state` change | direct state replacement and its journal entry share one sequence | run, journal |
| `tombstoneSession` | none beyond the serialized actor turn | deletion from every session table; tombstone upsert | no live session-owned record survives deletion | every session domain |
| `clearSession` | none beyond the serialized actor turn | deletion from every session table except tombstone | administrative clearing cannot leave partial session state | every session domain |
| ask mutations through `mutateAskRecord` | tombstone; ask record and revision; run change head | ask state; run change head; `ask_state` change | ask revision and visibility change have one journal sequence | asks, run head, journal, tombstone |
| delivery mutations through `mutateDelivery` | tombstone; delivery revision; completed creation effect; run change head | delivery state; run change head; delivery change | queue, dispatch, steer, interrupt and dispatch settlement changes are revisioned and journaled together | delivery, creation, run head, journal, tombstone |
| `prepareTurnCancel` | tombstone; cancel identity; run ID and generation; delivery ownership and requeue items | delivery; turn cancel receipt; stopped run state; change; cancel outbox effect | cancel targets exactly one run generation and parks/requeues delivery before physical cancellation | turn, run, delivery, journal, outbox, tombstone |
| `prepareTurnOutcomeProjection` | tombstone; projection identity and generation ownership; run generation; cancel outcome | projection; run change head; change; projection outbox effect | one projection owns a generation and its physical effect cannot exist without its durable intent | turn projection, run, journal, outbox, tombstone |
| `settleTurnOutcomeProjection` | projection identity, phase and generation; run change head | completed projection; run change head; change | completion is idempotent and journaled once | turn projection, run, journal |
| cancel phase updates through `updateTurnCancel` | turn revision and cancel identity; run change head | turn cancel phase; run change head; change | executing and settled cancel phases are revisioned with their journal entry | turn, run, journal |
| `enqueueOutboxMany` | existing effect keys and allocated IDs | all requested outbox effects | a batch is all-or-nothing and effect keys are idempotent | outbox and global outbox-ID routing |
| `completeCommandDecision` | command receipt; run change head; existing effect keys | completed command and result receipt; run change head; change; zero or more outbox effects | command success, journal visibility, and physical effects become durable together | commands, run, journal, outbox |

`mutateDelivery` is the transaction behind queue set/enqueue/promote/delete,
steer prepare/accept/reject/requeue/recovery, delivery interrupt phases,
dispatch claim, and dispatch acknowledgement or failure. `updateTurnCancel` is
the transaction behind beginning and settling the cancel effect.

## Service and migration transactions

These transactions are not ordinary session reducer decisions, but remain
SQLite authority and must be accounted for before SQLite removal.

| Operation | Atomic purpose | Classification |
| --- | --- | --- |
| `claimWriter` | replace a dead process owner, but reject a live owner | service boot ownership |
| `retryCompatibleCreationBranchDeadLetters` | re-admit only specifically decoded, previously non-executed creation effects | bounded maintenance |
| `migrateLegacySession` publication | publish isolated placement and outbox routes, then remove central rows after verified file copy | offline SQLite sharding migration |
| `publishActorTranscriptAuthorities` | publish a verified batch of transcript authority receipts | offline transcript migration |
| `rollbackActorTranscriptAuthorities` | roll a batch back from actor to shared transcript authority | offline transcript migration |
| `claimIsolatedSessionsForTranscriptMigration` | atomically claim a batch of transcript-only placements | offline transcript migration |
| `allocateIsolatedOutboxId` | reserve a globally unique outbox route ID | catalog routing authority |

Seven additional transactions at store construction are schema upgrades. They
are migration mechanics, not actor decisions, and disappear with the SQLite
store rather than becoming FeltDB application transactions.

## Adjacent SQLite authority outside explicit transactions

Several actor methods use one SQLite statement or rely on an enclosing helper
transaction. They still own durable state and cannot be omitted from the final
migration map: command admission and processing; quarantine creation; agent
host plan and supervision; timer schedule, claim and settlement; individual
outbox enqueue, acknowledgement, deferral and failure; dead-letter retry or
discard; placement and wake-index projection updates.

These operations do not create a safe shortcut around the shared journal.
Where one is part of a larger decision, its FeltDB write must be included in
the same authority transaction as that decision.

## Smallest safe next implementation boundary

The next implementation cannot be creation plus run alone. The smallest safe
boundary is the per-session decision backbone:

1. one FeltDB session envelope owns run state and the next change sequence;
2. every actor mutation that allocates that sequence moves to FeltDB in the
   same rollout;
3. each mutation writes its family state and journal record in one conditional
   transaction;
4. mutations that emit effects include the outbox record in that transaction;
5. journal readers, run-state readers, and outbox workers switch to FeltDB at
   the same authority cutover;
6. SQLite rows for these domains become offline migration input only and are
   never read or updated after cutover.

This is broader than one semantic family but narrower than the whole store. It
does not require placement, transcript storage, quarantine, or offline
migration machinery to move in the same PR. Attempting a smaller live cutover
would require cross-authority synchronization or would permit duplicate change
sequences, both prohibited by the persistence architecture.

## Required next design evidence

Before implementation, specify the FeltDB document and transaction shape for
each row in the live actor table, including stable transaction identity,
`ifVersion` guards, tombstone preconditions, outbox identity allocation, and
the exact conflict result returned to each reducer. The design must also define
an offline, one-way SQLite import and an atomic per-session authority cutover.
No runtime dual-read or dual-write period is acceptable.
