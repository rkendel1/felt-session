# Managed FeltDB persistence audit

This audit follows the production read and write paths as of 2026-08-28. It is
the evidence baseline for moving Open Session to one managed FeltDB authority.

## Current authority map

| Current source | Actual read/write consumers | Intended managed collection |
| --- | --- | --- |
| `~/.opensession/session-list.db` | `session-list-store.ts` opens SQLite lazily. `session-cache.ts`, session routes, and archive projection helpers query and update it. It is a materialized projection of assembled session records, but coverage markers currently decide whether list requests trust it. | None. Replace with queries over `opensession_sessions`; it must not be authoritative or required for recovery. |
| `~/.opensession/search.db` | `session-index.ts` starts a boot-time sweeper, reads sessions and transcripts, and writes distilled records through `session-search-store.ts`. Search routes and MCP search read it directly. | `opensession_session_search`, derived from canonical sessions and transcript events. Records must remain rebuildable and must not own session state. |
| `~/.opensession/sessions/<id>.json` and Slack/Linear JSON session records | `sessions.ts` scans and assembles these files, reads native rows, applies sidecar overlays, deletes files, and feeds `session-cache.ts`. Session creation/projection paths write native records. | `opensession_sessions` for the session entity and `opensession_session_metadata` for bounded projections that do not belong in the transcript stream. |
| `~/.opensession/sessions/session-kernel.sqlite` | `SessionKernelStore`, through `SessionKernelStoreHost`, owns the placement catalog, global outbox routing, tombstones, quarantine, wake indexes, and schema/owner fencing. The actor service starts before the HTTP server. | `opensession_session_placements`, `opensession_session_tombstones`, `opensession_session_quarantine`, and transactionally maintained wake/outbox records. |
| `~/.opensession/sessions/session-kernel-sessions/<hash>.sqlite` | Per-session `SessionKernelStore` actors own command admission, run/creation/delivery/turn state, asks, timers, outbox, changes, agent operations, and actor transcripts. `SessionKernelStoreHost` opens only a bounded actor set selected by the catalog. | Domain collections for commands, run state, creation state, delivery/turn state, asks, timers, effects/outbox, changes, operations, transcript metadata, and transcript events. Managed transactions and CAS must preserve the current actor invariants. |
| `~/.opensession/workspaces/<id>.json` | `workspaces.ts` is the synchronous canonical CRUD path. Session creation, routes, PR projection, repositories, models, automations, branches, and handoffs call it directly. `worktreeDir`, branch, attached repos, drafts, archive state, model presets, and external refs are stored in each record. | `opensession_workspaces`. Worktree paths are references only; Git remains authoritative for checkout contents. |
| Git worktrees plus workspace `worktreeDir` metadata | `worktree.ts` and session/workspace routes inspect Git filesystem state. Workspace JSON owns the durable association. Runner Mission Control also has a separate file-backed `DurableWorktreeRegistry`, which must not become a second authority. | `opensession_workspaces` for associations and `opensession_worktrees` for lifecycle metadata. Repository files and `.git` remain on the filesystem. |
| `~/.opensession/config.json` | `config.ts` reads instance configuration per call; `config-mutation.ts` writes it. The current pairing route stores `integrations.feltdbRuntimeHandoffs` here. This makes managed workspace identity depend on a local JSON record. | Deployment configuration stays operator-owned, but managed authority identity comes from service environment variables and an in-code namespace default. Pairing state belongs in `opensession_pairings`; handoff entities stay in the shared canonical handoff collection. |
| `runtime_investigation_handoffs` in a FeltDB development workspace | `runtime-investigation-handoffs.ts` independently calls `connectDevelopmentWorkspace`, queries pending records at startup, subscribes live, reads canonical investigations/observations, creates local sessions/workspaces, then acknowledges the handoff remotely. Pairing resolves an endpoint/workspace id and persists it locally. | Keep `runtime_investigation_handoffs`, `runtime_investigation`, and observation collections in the same managed namespace used by Open Session and DevTools. Use the single managed client rather than a second development connection. |
| Optional local `.feltdb` stores | Run journal, transcript store, memory, executor claims/state, and runner registries call `createFeltDB({ path })` in scattered modules. Several paths explicitly fall back to JSON or SQLite. | Remove these constructors and fallbacks. Each domain must receive the single managed client and use managed collections. |

## Boot and call-graph constraints

1. `opensession.ts` starts the session-kernel actor before binding HTTP. The
   actor opens the central SQLite catalog and per-session SQLite databases.
2. Workspace CRUD is synchronous and is called from session creation, routing,
   automation, repository, and handoff code. A remote authority is asynchronous,
   so this API and its callers must be converted rather than hidden behind an
   eventually persisted cache.
3. `session-list.db` and `search.db` are described as projections, but callers
   query them directly. They are safe to remove only after managed queries cover
   those reads and restart recovery is proven.
4. Session-kernel SQLite is canonical decision state, not a disposable index.
   Replacing only session JSON/list/search would leave the most important
   persistence boundary local.
5. The existing handoff consumer reaches FeltDB, but it constructs a separate
   development-workspace connection and then writes Open Session state through
   local workspace/session APIs. It does not prove a shared canonical state
   boundary.

## Managed capability evidence

`@feltdb/core@0.6.14` supports a remote-only runtime through
`createFeltDB({ namespace, server: { url, token } })`. Its HTTP runtime exposes
collection CRUD, versioned CAS, authority transactions, revisions, remote
search, and an event stream. A live write/read/delete probe against the current
managed development namespace succeeded and reported `runtime: remote` and
`storage: remote`.

The package capability is therefore not the blocking boundary. The required
work is converting Open Session's synchronous local owners to asynchronous
managed transactions while preserving actor admission, fencing, recovery, and
bounded-work invariants.

## Blocking boundary found during cutover

The session kernel cannot be safely redirected by changing a database
constructor. `session-kernel/store.ts` is a 6,013-line synchronous SQLite
transaction engine. `actor-worker.ts` executes a complete command turn
synchronously and serializes its result immediately; `store-host.ts` also
performs synchronous placement, quarantine, wake-index, outbox, timer, and
transcript decisions. Managed FeltDB collection operations and authority
transactions are asynchronous.

Two tempting shortcuts are invalid:

- asynchronously flushing an in-memory kernel snapshot would make the process
  cache authoritative across the durability gap;
- retaining SQLite below a managed projection would leave SQLite canonical and
  create the prohibited ongoing synchronization architecture.

The safe seam is the existing serialized actor mailbox, but the worker turn,
kernel reducers, store host, and store API must become asynchronous together.
Until that conversion and an idempotent verified migration of every central
and per-session decision record are complete, the strongest acceptance test
cannot pass. The SQLite files must not be deleted or described as migrated.
