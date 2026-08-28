# FeltDB Session Kernel actor migration

## Migrated boundary

`appendChange` is the first Session Kernel operation owned by the FeltDB server.
Its production path is:

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

The remaining Session Kernel operations are still SQLite-backed migration
scaffolding. In particular, creation, run lifecycle, delivery, asks, timers,
outbox, transcripts, tombstones, quarantine, wake indexes, and placement have
not moved in this milestone. Their transactions must be migrated as complete
atomic boundaries before SQLite can be removed.

## Configuration

The actor service workers connect through `@feltdb/core` using:

- `OPENSESSION_FELTDB_SERVER_URL`
- `OPENSESSION_FELTDB_SERVER_NAMESPACE`
- `OPENSESSION_FELTDB_SERVER_TOKEN`

There is no embedded or file-backed fallback. Missing server configuration
fails the migrated operation instead of selecting another authority.
