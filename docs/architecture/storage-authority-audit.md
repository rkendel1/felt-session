# Storage authority audit: remaining JSON, Postgres and SQLite

Audit date: 2026-09-01. Branch: `claude/audit-feltdb-migration-5n853x`.
FeltDB pinned at `@feltdb/core@0.7.4` (bumped from 0.7.2 in this change).

This is a file-and-line audit of every durable store in the repository, answering
one question: what is still **not** FeltDB, and why.

It deliberately does **not** classify anything as an acceptable exception. Where
state lives outside FeltDB, the reason is written down as a **requirement FeltDB
does not currently cover**. A store that stays on the filesystem because FeltDB
cannot hold it is a gap in the database, not a property of the architecture.

## Verdict

| Backend | Status |
| --- | --- |
| PostgreSQL | **Absent.** No dependency, no client, no connection string. |
| SQLite | **Present in production**, narrowed to central kernel bookkeeping. |
| JSON files | **Present in production** for five stores, plus config/credential/blob files. |

## 1. PostgreSQL: none

No `pg`, `postgres.js`, Prisma, Drizzle, Knex, TypeORM or Sequelize dependency
exists in `package.json` or any workspace manifest. The only matches in the tree
are prose:

- `adrs/feltdb-native-durable-substrate.md:139` — "Alternative 2: PostgreSQL", a
  rejected option in the ADR.
- `deploy/sandbox/README.md:226` — notes Postgres-class daemons are out of image scope.
- `memory-budget.test.ts`, `memory-v2/retrieval.test.ts` — fixture *sentences*
  containing the word "postgres" used as memory-retrieval test corpus.

Nothing to remove.

## 2. SQLite

### 2.1 What is genuinely live

A SQLite driver (`bun:sqlite`) is imported by exactly **five** non-test files —
two live stores and three offline tools:

| File | Role |
| --- | --- |
| `src/server/session-kernel/store.ts` | 212 KB compatibility store (live, §2.3) |
| `src/server/transcript-store.ts` | transcript store (live only under `NODE_ENV=test`, §2.2) |
| `session-kernel/transcript-offline-migration.ts` | offline operator tool |
| `session-kernel/feltdb-offline-migration.ts` | offline operator tool |
| `scripts/migrate-session-kernel-to-feltdb.ts` | offline operator tool |

`src/server/session-kernel/store-host.ts` is a sixth SQLite *consumer* — it
constructs `SessionKernelStore` and `TranscriptStore` (`store-host.ts:130`,
`:659`, `:685`) — but imports no driver of its own.

The offline tools read legacy SQLite to move it into FeltDB. They are the
migration, not a live backend, and the server-invariant rule in `AGENTS.md`
explicitly sanctions one-off full-fleet visits as offline operator jobs.

### 2.2 Session-scoped data is already FeltDB, and enforced

`actor-worker.ts` activates a managed FeltDB head for every session-scoped
command and **throws rather than falling back** when one is absent:

```ts
// actor-worker.ts
const managedHead = managedKind && sessionId
  ? await ensureManagedHead(sessionId, !isReadReducer(command)) : undefined;
if (managedKind && sessionId && !managedHead)
  throw new Error(`Managed FeltDB session ${sessionId} has not been activated`);
```

`managedKind` covers transcript, run_event, creation_event, core, and
ask/delivery/gateway/timer/turn. So the SQLite branches beneath those `else`s are
unreachable for session work — dead code kept as a conversion seam, which the
file itself admits:

> "Store methods remain synchronous until their domain moves to FeltDB, while
> migrated methods return promises."

`kernel.ts:76` makes the same guarantee at the front door — the compatibility
store is reachable **only** under test:

```ts
if (process.env.NODE_ENV !== "test")
  throw new Error(`Session ${domain} mutation requires the authoritative actor`);
```

`actor-transcript.ts:33` is the same shape for transcripts:

```ts
if (process.env.NODE_ENV !== "test") return sessionTranscript(request);
const { transcriptStore } = await import("./transcript-store"); // test only
```

**Consequence worth stating plainly:** `transcript-store.ts` and the SQLite half
of `store.ts` are now a *test-only* backend. The suites in
`transcript-store.test.ts`, `transcript-reliability.test.ts`,
`transcript-search.test.ts`, `store-host.test.ts` and `kernel.test.ts` therefore
exercise a backend production no longer uses. That is a test-fidelity gap, not a
storage gap, but it means green tests are not evidence about the FeltDB path.

### 2.3 The SQLite that *is* still live

`store.ts:299-305`:

```ts
export function sessionKernelDbPath(): string {
  const explicit = process.env.OPENSESSION_SESSION_KERNEL_DB_PATH?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "test") return ":memory:";
  return `${sessionsDir()}/session-kernel.sqlite`;   // <- production file
}
```

`actor-worker.ts` ends its store dispatch with:

```ts
} else result = host.call(request.method, request.args);   // -> SQLite central
```

That branch is reached for **global-scope methods only** (no session id). Per
`store-routing.ts`, the state still served from `session-kernel.sqlite` is:

- session quarantine records (`quarantinedSessions`, `quarantineSession`, `releaseQuarantine`)
- dead letters (`deadLetters`), `settlePendingSteers`
- outbox id allocation (`allocateIsolatedOutboxId`)
- `stats`, `compact`, `maintain`
- ask/delivery migration completion flags

`store-host.ts:130/659/685` also still constructs `SessionKernelStore` and
`TranscriptStore` per session, though `actor-worker` throws before those are used
for session-scoped work.

**Remaining SQLite = central kernel bookkeeping, not session or transcript data.**

## 3. JSON stores still holding durable application state

The bulk of the server is migrated. 120+ modules import `@feltdb/core` /
`managedFeltDb`, and the established pattern is FeltDB authority plus a
boot-time, verify-then-unlink migration of the legacy file — see
`run-journal.ts:48`, `managed-native-sessions.ts:52`, `shared/user-store.ts:98`.
The most recent commits on this branch (`e9913b5`..`755013c`) removed those
migration readers once complete.

Five stores were **never** migrated:

| # | Store | File | State it holds |
| --- | --- | --- | --- |
| 1 | `claude-accounts.json` + `-state.json` | `claude-accounts.ts:263,272` | Claude account pool, long-lived OAuth setup tokens, sideline/exhaustion state |
| 2 | `codex-accounts.json` + `-state.json` | `codex-accounts.ts:144,153` | same, for Codex |
| 3 | `.opensession-plugins.json` | `plugins.ts:374,392` | installed-plugin ledger |
| 4 | per-session asset metadata | `session-assets.ts:163` | user-authored asset descriptions |
| 5 | `.opensession-session-list-v3.json(.gz)` | `routes/sessions.ts:316` | derived warm-boot session-list cache |

Items 1-4 are authoritative durable state. Item 5 is a rebuildable cache
(versioned, max-age-bounded), but it is still a second copy of session state on
disk that can be served to clients for up to two minutes.

## 4. What FeltDB does not cover — the requirements this audit refuses to hide

Each remaining store is blocked on a capability FeltDB does not provide today.
These are database requirements, not architectural preferences.

### R1. A local / pre-configuration tier

`managed-feltdb.ts` requires a namespace, URL and API key, and throws without
them. `feltdb-change-store.ts:59-66` and `feltdb-decision-store.ts:230` go
further and **reject any non-remote runtime**:

```ts
// "This store accepts only the remote/server runtime. It has no SQLite mirror"
if (runtime.runtime !== "remote" || runtime.storage !== "remote") throw ...
```

0.7.4 *does* ship a durable local file runtime — `FileJsDb` in `dist/file-db.js`,
exported from the package root, with a lock file, peer set and a replayable event
log. So this is a **repo-side restriction, not a missing database feature**: the
kernel stores refuse the runtime the database offers.

What is genuinely missing is the tier that a Node CLI can use before a server is
configured. The documented `createFeltDB` options are `server` (remote),
`browser: true` (durable IndexedDB) and `memory: true` — and `memory` is
explicitly labelled "never use for customer data". `FileJsDb` fills the gap but
is single-writer (see R7), so a CLI process and the running server cannot both
hold it.

That is why `plugins.ts` (#3) is still JSON: `scripts/lib/plugins.ts` imports it
directly and runs outside a configured server, concurrently with the server.

**Requirement:** either relax the kernel stores' remote-only assertion so the
file runtime is usable, or give FeltDB a multi-reader/multi-writer local tier a
CLI can share with a running server.

### R2. Synchronous reads

The FeltDB API is async throughout. `claude-accounts.ts` and `codex-accounts.ts`
are consumed synchronously by ~15 call sites, several on hot paths
(`pickAccount` in `pi-runner.ts`, `getAccountById` in `session-create.ts`,
`effective-config.ts`, `automations.ts`, `model-catalog.ts`). Migrating them means
making account resolution async across run start-up.

**Requirement:** a synchronous read path (a maintained local materialization or
coherent read-through cache) for hot, small, whole-collection reads.

### R3. Blob storage — available in 0.7.4, unused

This gap is **closed by the database and open in the application.**

0.7.4 exports an `ArtifactClient` (`dist/artifact.d.ts`, re-exported through
`index-core.js`) that stores bytes directly:

```ts
export interface CreateArtifact {
  applicationId: string;
  kind: ArtifactKind;          // IMAGE | REPORT | DOCUMENT | LOG | BUILD | ...
  content: Blob | ArrayBuffer | Uint8Array;
  contentType: string;
  name: string;
  parents?: string[]; supersedes?: string; ...
}
```

with content hashing, lifecycle (`CREATED|ACTIVE|SUPERSEDED|ARCHIVED|DELETED`),
provenance, retention metadata, and `content(id)` to read bytes back.

`grep -rn "ArtifactClient" packages scripts test` returns **nothing**. The
repository does not use it. Meanwhile the filesystem still holds repo icons
(`repo-appearance.ts:184`), report HTML and assets (`reports.ts:347`), session
asset bytes (`session-assets.ts:183`), uploads, social cards, and worktree
patches (`worktree-reaper.ts:369`).

Store #4 is the clearest casualty: asset *descriptions* are ordinary application
state kept in a JSON sidecar purely because the bytes beside them were not in
FeltDB. With artifacts, both belong in FeltDB and the sidecar disappears.

Note the older `test/feltdb-capabilities.test.ts` still describes capability 11 as
"Blob **references** — Large object references can be stored". That test predates
the artifact API and understates what FeltDB now does; it should be updated.

**Requirement:** none outstanding on FeltDB. This is application work: adopt
`ArtifactClient` and retire the filesystem blob paths.

### R4. Secret handling — currently delegated to FeltDB and unverified here

This one cuts both ways and should not be presented as a reason to keep
credentials on disk.

`keychain.ts` already puts secrets in FeltDB — its header states "the secret lives
in managed FeltDB and is never returned by any API or tool" — and neither
`keychain.ts` nor `workspace-secrets.ts` performs any encryption. There is no
`createCipheriv`, no key derivation. Confidentiality at rest is therefore
**assumed of FeltDB and unverified in this repository**.

So the account stores (#1, #2) staying in mode-0600 local files is an
*inconsistency* with keychain, not a principled boundary. Either FeltDB is
trusted with secrets — in which case the account pools should move — or it is
not, in which case `keychain.ts` and `workspace-secrets.ts` are already
mis-placed.

**Requirement:** a stated, tested at-rest confidentiality guarantee, and a
documented decision applied uniformly to every secret.

Separately, some credential files are on disk because an **external process**
reads them, not because of FeltDB: the AWS SDK credential file
(`aws-creds.ts:262`), the GitHub App PEM (`github-app.ts:301`), the cloudflared
token and Caddyfile (`ingress-settings.ts:567`). Those need FeltDB to be the
authority with the file rendered as a derived artifact — currently the file *is*
the authority.

**Requirement:** an export/materialization path so FeltDB can own state that a
foreign tool must read from a file.

### R5. Derived caches, indexes and warm start

Store #5 exists because a cold FeltDB scan is too slow to serve the first
session-list response, so the answer is cached to local disk and served for up to
`LIVE_LIST_DISK_SERVE_MS` (2 minutes). `AGENTS.md` separately forbids cross-session
SQLite fanout and mandates "catalog-maintained projections or counters", which
FeltDB does not natively provide — the projections are hand-maintained
(`session-list-store.ts`, `managed-session-list-store.ts`,
`managed-transcript-search.ts`).

**Requirement:** maintained projections/materialized views and indexed queries,
so warm-start does not require a private on-disk copy.

### R6. Client-side sync — a browser runtime exists and is unused

Every client keeps its own local mirror: `chrome.storage.local`
(`chrome/sidepanel.js:29`), `UserDefaults` plus a file-backed outbox (iOS
`SettingsCache.swift`, `SocketMutationOutbox`), Electron JSON state
(`mac/src/main.js:330,340,729`), and browser `localStorage` / `sessionStorage` in
the web UI.

0.7.4 ships `browser: true` — a "durable IndexedDB runtime with restart-safe
change replay" — and a `./react` entry point (`dist/react/useFeltDB.d.ts`). The
web UI uses neither. So the browser half of this gap is, like R3, available in
the database and unadopted in the application.

The native clients still have no story: there is no Swift or Kotlin FeltDB
client, so iOS/Electron mirrors cannot be replaced regardless.

**Requirement:** native-client SDKs, and a defined sync/conflict model if these
mirrors are ever to be authoritative rather than per-device caches.

### R7. Multi-writer — confirmed still open

Not inherited from stale notes; confirmed against the 0.7.4 README:

> **Single concurrent writer:** Only one process may call `database.mutate()` at a time
> **Enforcement:** File lock acquired at database open, held for lifetime
> **Not suitable for:** Multi-process concurrent writes. See Phase 3 roadmap for
> multi-writer replication model.

So `FELTDB_MIGRATION.md`'s "ONE FELTDB INSTANCE = ONE MISSION CONTROL OWNER" is
accurate for the file runtime. The README documents this under a "FeltDB 0.4.3"
heading while shipping as 0.7.4, so the managed/server runtime's concurrency
guarantee is **not clearly documented** and should be confirmed with the vendor
rather than assumed.

This is what blocks R1: a CLI cannot open the same file database as a running
server.

**Requirement:** the Phase 3 multi-writer replication model, and an explicit
concurrency statement for the managed server runtime.

## 5. The UI

The web UI is a browser bundle with no database access; it reads the server's
HTTP API, and those routes are FeltDB-backed. Its `localStorage` /
`sessionStorage` use (199 references) is per-device convenience — panel widths,
expanded sidebar nodes, filters, last-used repo — and the one case that looks
like state, the composer draft outbox, is explicitly a mirror: `lib/drafts.ts`
calls sessionStorage "a best-effort mirror", with `server/drafts.ts` (FeltDB) as
the authority.

The exception is the account-pool surface: Settings > Accounts renders
`/api/claude-accounts` and `/api/codex-accounts`, which are served from stores #1
and #2 — JSON files. **That is the one UI surface not backed by FeltDB.**

## 6. Corrections to existing documentation

`FELTDB_MIGRATION.md` is materially inaccurate and should not be relied on:

| Claim | Reality |
| --- | --- |
| "Phase 4 IN PROGRESS", memory-v2 still SQLite | `src/server/memory-v2/` contains **no** SQLite. It is `managed-store.ts`, FeltDB. Phase 4 is done. |
| Dual-write gated on `ENABLE_FELTDB_RUN_RECORDS` | The flag exists **only in stale markdown**. It is absent from all code. `run-journal.ts` is FeltDB-only with a verify-then-unlink migration. |
| "Writes to JSON for compat" in `run-journal.ts` | `run-journal.ts` never writes JSON. It imports `unlinkSync`, not a writer. |
| Phase 6: "8 test suites, 18 individual tests", "15,427 bytes" | `durability-crash-recovery.test.ts` is **47 lines, 3 tests**. |
| "SQLite runtime access: 0" | `session-kernel.sqlite` is opened in production for central bookkeeping (§2.3). |
| "active-runs.json replaced" ✅ / "Session/transcript SQLite removed" ✅ | First is true. Second is true for the live path but the modules remain and are the test backend. |

`PHASE2_*.md` and `MISSION_CONTROL_IMPLEMENTATION.md` describe the same removed
flag and dual-write design. They document a plan, not the code.

## 7. Work remaining, in dependency order

Two of the seven gaps need no database work at all — FeltDB 0.7.4 already covers
them and the application has not adopted them.

**Available now, application work only:**

1. **Adopt `ArtifactClient` (R3).** Closes store #4 outright and moves repo icons,
   reports, uploads, social cards and session assets off the filesystem. Update
   `test/feltdb-capabilities.test.ts`, whose capability 11 still says "blob
   references".
2. **Relax the remote-only assertion (R1)** in `feltdb-change-store.ts:65` and
   `feltdb-decision-store.ts:230`, or document why the shipped `FileJsDb` runtime
   is refused.
3. **Consider `browser: true` + `./react` for the web UI (R6).**

**Blocked on a decision:**

4. **Decide R4 — secrets in FeltDB, yes or no — and apply it uniformly.** Today
   `keychain.ts` and `workspace-secrets.ts` put unencrypted secrets in managed
   FeltDB while `claude-accounts.ts` / `codex-accounts.ts` keep them in mode-0600
   files. One of those two is wrong. This gates stores #1 and #2, and is the one
   item that should not be actioned without an explicit call.

**Blocked on FeltDB:**

5. **R2 (sync reads)** — otherwise migrating #1 and #2 forces async through run
   start-up.
6. **R7 (multi-writer)** — gates sharing a local database between the CLI and the
   server, which is what keeps #3 on JSON.
7. **R5 (projections / warm start)** — gates retiring #5.

**Independent of all the above:**

8. Move the central kernel bookkeeping in §2.3 (quarantine, dead letters, outbox
   id allocation, stats, maintenance) to FeltDB, then delete `store.ts`'s SQLite
   half, `transcript-store.ts`, and the SQLite paths in `store-host.ts`.
9. Repoint the transcript and kernel test suites at the FeltDB path so tests stop
   validating a backend production no longer uses (§2.2).
