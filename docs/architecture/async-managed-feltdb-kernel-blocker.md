# Async FeltDB kernel conversion: authority capability report

Date: 2026-08-28

## Outcome

The conversion stops under required Stop Conditions 1 and 2. The installed
Managed FeltDB authority can atomically commit several unconditional writes
and can reject `requireAbsent`, but it cannot enforce an existing-record
version, epoch, or lease precondition as part of that same multi-record
transaction. The session kernel requires that primitive to preserve its
current read-decide-write transactions and fencing.

No async cache, SQLite synchronization layer, local FeltDB, or fallback was
introduced.

The local FeltDB server was subsequently evaluated as a development authority.
Its canonical state-contract engine does implement atomic per-record version
preconditions, so the storage engine itself is suitable. The supported
`@feltdb/core@0.6.14` application API does not expose that capable protocol,
however. Open Session therefore cannot begin the kernel conversion without
either a FeltDB SDK addition or an application-specific raw HTTP client. The
latter would create a second, private FeltDB protocol implementation in Open
Session and is not an acceptable migration foundation.

## Current command and transaction contract

The actor service already supplies the correct asynchronous serialization
seam. `pumpSessionMailbox` marks one mailbox turn running, awaits the worker
response, and starts the next turn only in `finally`. Global turns wait on the
active session mutation tails. Converting worker calls to `await` would not by
itself weaken per-session ordering.

The worker is synchronous below that seam. `executeCall` selects the routed
store, checks quarantine/tombstone state, invokes one reducer/store operation,
constructs the response, and only then posts it. Infrastructure failures either
quarantine one isolated session or fail the actor lane. SQLite `IMMEDIATE`
transactions currently make every reducer's reads, decisions, writes, and
result one serialized unit.

Representative semantic transactions are:

| Operation | Reads and conditions | Atomic writes |
| --- | --- | --- |
| `appendChange` | Current session state and `changeSeq` | Incremented state sequence plus the uniquely sequenced change record |
| `applyCreationEvent` | Tombstone, creation identity/state/effect receipt, run sequence | Creation state, run sequence, optional outbox effect, change record |
| `applyRunEvent` | Tombstone, current run identity/generation, cancellation state | Run state/generation/sequence plus change record |
| turn cancellation | Expected run id and generation, turn identity, delivery ownership | Delivery queue, cancellation state, stopped run state, change record, outbox effect |
| turn outcome preparation | Run generation, cancellation result, unique generation owner | Projection owner, run sequence, change record, outbox effect |

The result is derived from the exact committed prior state. A stale actor must
not pass its checks and then commit after another actor changes ownership or
generation.

## FeltDB capability evidence

`@feltdb/core@0.6.14` exposes two separate capabilities:

1. `Collection.updateIfVersion` provides CAS for one record, including optional
   epoch and lease checks.
2. `db.transaction` provides atomic multi-record set/delete with durable
   transaction-id replay and `requireAbsent`.

The public transaction operation type and builder expose no `expectedVersion`,
`expectedEpoch`, or `expectedLeaseId`. The lower runtime interface mentions an
optional `expectedVersion`, so this was tested against the real configured
managed authority rather than inferred from TypeScript declarations.

Disposable live probes produced these results:

- `requireAbsent` on an existing record: transaction rejected, original record
  preserved, second staged record absent.
- deliberately stale `expectedVersion` attached to the first operation of a
  two-record transaction: transaction did not throw, the guarded state changed,
  and the second record committed.
- remote `Collection.putIfAbsent` is not implemented by the HTTP runtime. Open
  Session's managed entity creation path now uses the working transactional
  `requireAbsent` primitive instead.

The stale-version result proves that the managed authority does not currently
enforce a version precondition for multi-record transactions. A separate CAS
followed by a transaction is insufficient: ownership can change between the
two commits, and a crash can leave only the CAS applied.

## Local server authority verification

FeltDB 0.6.14 has two distinct HTTP transaction contracts:

- The application-facing `/transactions` route used by
  `createFeltDB({ server })` accepts `transactionId`, multi-record operations,
  and `requireAbsent`. Its request type has no record version, epoch, or lease
  field. The route translates only `requireAbsent` into an atomic
  precondition.
- The canonical `/v1/transactions` state contract accepts `if_version` on
  update and delete operations. `execute_transaction` resolves the persisted
  record version, stages that version as an `AtomicPrecondition`, and submits
  the preconditions and all mutations to one `apply_atomic_transaction` call.

The focused FeltDB test
`state_contract::tests::stale_record_precondition_is_structured_and_identity_is_idempotent`
passes against the 0.6.14 server engine. It proves that a stale `if_version`
returns `PRECONDITION_FAILED`, preserves the existing record, and retains
transaction-id idempotency.

This is enough to validate the proposed server authority topology at the
engine level. It is not yet enough for Open Session to consume it through the
supported SDK:

- `StateContractClient` is built in `@feltdb/core@0.6.14`, but is not exported
  by the package root or exports map.
- The internal client does not expose authority credential headers.
- The public `AtomicTransactionBuilder` cannot stage `ifVersion`.
- Epoch and lease identity are kernel fields. They can be fenced by requiring
  the observed version of the ownership record in every dependent atomic
  transaction, but only after that record-version condition is available to
  the public transaction API.

The next safe dependency step is to expose one supported server-authority
transaction client from `@feltdb/core` that carries authenticated reads and
multi-record writes with per-record `ifVersion`. Both the local server and the
eventual managed authority must implement the same request and conflict
contract. Open Session can then convert its actor worker, store host, and
kernel against that interface without changing application semantics between
development and managed deployment.

## Why the permitted alternatives do not work

- Packing all kernel state into one CAS record would combine unbounded
  transcripts, changes, operations, timers, and outbox history into one record,
  redesign the domain model, and remove independently addressable durable
  records.
- A process-local aggregate followed by an async flush creates the prohibited
  authoritative cache and loses crash semantics.
- A single-record CAS followed by unconditional multi-record writes creates a
  fencing race and partial-commit boundary.
- Durable transaction IDs solve duplicate replay only. They do not prove that
  the state read to make the decision is still current.
- Per-process mailbox serialization cannot fence a stale process or a second
  actor owner against the shared managed authority.

## Required authority primitive

The conversion can resume when one managed atomic transaction supports all of:

```text
transactionId
preconditions:
  - collection + id + expectedVersion
  - optional expectedEpoch / expectedLeaseId
operations:
  - set/delete across multiple collections
```

The authority must evaluate every precondition and apply every operation in
one commit, or apply nothing. A retry with the same transaction ID must return
the original result. A stale version, epoch, or lease must return a structured
conflict without committing any staged record.

With that primitive available through the supported SDK, the existing actor
mailbox can remain the serialization boundary and the worker, store host, and
reducers can be converted coherently to async calls. Without it, implementing
the conversion would weaken current kernel atomicity and ownership fencing,
or force Open Session to own a duplicate raw FeltDB protocol client. Both
outcomes violate the requested persistence boundary.
