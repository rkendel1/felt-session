# FeltDB Session Kernel actor migration

## Managed boundary

The Session Kernel has managed FeltDB decision stores for creation, run state,
delivery, asks, turns, timers, commands, outbox effects, agent-host fencing, and
transcripts. Once a session has an `opensession_kernel_sessions` authority head,
the actor worker routes those complete atomic decisions to FeltDB and does not
mirror them to SQLite.

The original change-journal path is:

1. `SessionKernelActorClient.appendChangeAsync` supplies the stable logical
   transaction ID, session ID, change kind, and payload.
2. The transport preserves that transaction ID when it wraps the request for
   the independently supervised actor service.
3. `pumpSessionMailbox` holds the session mailbox in its running state while it
   awaits the assigned worker response.
4. The worker reads the current FeltDB state and its authority-owned version.
5. `FeltDbKernelChangeStore` atomically writes the updated sequence state, the
   change record, and the replay receipt, guarded by `ifVersion` or
   `requireAbsent`.
6. Only after the FeltDB server commits does the worker construct success and
   allow the mailbox to begin its next turn.

The result is the committed change sequence. A typed conditional conflict is
returned when another authority writer advances the state after the decision.
Mutations are not automatically retried. Re-delivery with the same logical
transaction ID returns the committed receipt.

## Authority boundary

The collections `opensession_kernel_run_states`,
`opensession_kernel_changes`, and `opensession_kernel_transactions` are owned
by the remote FeltDB server for this operation. The worker does not call the
SQLite `appendChange` or `changesSince` implementations and does not mirror
these records in either direction.

Sessions without a managed authority head remain on the isolated SQLite actor
only until the offline fleet migration activates them. This compatibility path
must be removed after every production placement has been verified in FeltDB.

## Offline fleet cutover

First deploy the code containing the managed decision stores. Then stop and
drain both the gateway and actor service. While they remain stopped:

1. Run `bun scripts/migrate-session-kernel-storage.ts` to finish the older
   central-to-isolated placement migration.
2. Run `bun scripts/migrate-session-kernel-to-feltdb.ts --confirm-offline gateway-and-actor-stopped`.
3. Rerun the same command. A successful verification run reports every selected
   session as `alreadyManaged` and migrates zero sessions.

The runner is resumable. Each session imports bounded, content-hashed batches,
verifies its manifest, and publishes its authority head last. It is the only
fleet-enumerating caller and is strictly offline. `--limit N` permits a staged
cutover; `--central` and `--isolated-root` override source locations for an
isolated rehearsal.

## Configuration

The actor service workers connect through `@feltdb/core` using:

- `OPENSESSION_FELTDB_SERVER_URL`
- `OPENSESSION_FELTDB_SERVER_NAMESPACE`
- `OPENSESSION_FELTDB_SERVER_TOKEN`

There is no embedded or file-backed fallback. Missing server configuration
fails the migrated operation instead of selecting another authority.
