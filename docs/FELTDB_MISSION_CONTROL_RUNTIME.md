# Mission Control Runtime: FeltDB as Sole Persistence Substrate

**Status**: Phase 1 Complete  
**Date**: 2026-08-28  
**Scope**: Runner Executor, Command Ledger, Managed Executor State, Agent & Task Registries

## Overview

Mission Control's runtime environment now uses FeltDB as its **sole durable persistence substrate**. This document establishes the architectural boundary and verifies that no SQLite persistence exists in the core executor and mission control components.

## Architecture: FeltDB as Source of Truth

```
┌────────────────────────────────────────────────────────────┐
│                    Mission Control                         │
│         (ExecutorRuntime, RunnerExecutor)                 │
└────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   FeltDB     │
                    │ (Embedded    │
                    │  Database)   │
                    └──────────────┘
                           │
                   ┌───────┴────────┐
                   │                │
                   ▼                ▼
            ┌──────────────┐  ┌──────────────┐
            │ Filesystem   │  │ Git/Repos    │
            │ (Worktrees,  │  │ (External    │
            │  Artifacts)  │  │  References) │
            └──────────────┘  └──────────────┘
```

**Key Principle**: All durable application state flows through FeltDB. Filesystem and Git are for content and artifacts, not control state.

## Components Using FeltDB

### 1. Command Ledger (Runtime Persistence)

**Module**: `runner-executor/open-command-ledger.ts`  
**Implementation**: `runner-executor/feltdb-ledger.ts`

Stores:
- `runner_command_ledger` — Execution commands with outcomes
- `runner_command_index` — Deduplication keys
- `runner_retired_scopes` — Scope retirement markers

**Guarantee**: No SQLite backend exists. The `openCommandLedger()` function:
- Always returns a FeltDB-backed ledger
- Accepts legacy `dbPath` parameter for compatibility but ignores it
- Derives FeltDB path from `feltdbPath` option or defaults from `dbPath`
- Fails hard if FeltDB initialization fails

**Recovery**: Ledger calls `recover()` on startup to fail all inherited active claims before accepting new execution frames.

### 2. Executor State Store

**Module**: `server/managed-executors/feltdb-state.ts`

Stores:
- Managed executor records (lifecycle, generation, workspace checkpoints)
- Instance claims and generation tracking

**Guarantee**: FeltDB-only. No SQLite alternative exists.

### 3. Executor Claims Authority

**Module**: `server/executors/feltdb-claims.ts`

Stores:
- Runner executor claims by instance ID
- Generation revocation tracking

**Guarantee**: FeltDB-only. No SQLite alternative exists.

### 4. Agent & Task Registries

**Modules**: 
- `runner-executor/durable-agent-registry.ts`
- `runner-executor/durable-task-registry.ts`

Stores:
- `mission_control_agents` — Agent definitions, roles, capabilities
- `mission_control_tasks` — Task definitions and metadata
- `mission_control_task_executions` — Execution history
- `mission_control_task_reviews` — Review records

**Guarantee**: FeltDB-only. Both registries call `createFeltDB()` directly with no fallback paths.

## Verification: No SQLite in Mission Control Runtime

### Production Code Audit

| Module | Component | SQLite Imports | Status |
|--------|-----------|---|--------|
| `runner-executor/` | Command Ledger | ❌ None | ✅ FeltDB-only |
| `runner-executor/` | Agent Registry | ❌ None | ✅ FeltDB-only |
| `runner-executor/` | Task Registry | ❌ None | ✅ FeltDB-only |
| `server/executors/` | Runtime | ❌ None | ✅ FeltDB-only |
| `server/managed-executors/` | State Store | ❌ None | ✅ FeltDB-only |
| `server/executors/` | Claims Authority | ❌ None | ✅ FeltDB-only |

**Result**: ✅ No `from "bun:sqlite"` imports found in production code paths.

### Configuration Audit

**Persistence Options**: ❌ None

- No `PERSISTENCE_BACKEND` feature flag in production code
- No `READ_FROM_FELTDB` conditional (FeltDB is always used)
- No `DualWriteStore` or fallback mechanisms
- No `storageKind` configuration option

**Result**: ✅ No configuration options to select alternative backends.

### Fallback Mechanism Audit

**Fallback Patterns**: ❌ None in core runtime

The executor runtime does NOT silently fall back to JSON or SQLite:

```typescript
// ✅ Correct: Ledger fails hard if FeltDB is unavailable
ledger = openCommandLedger({
  dbPath: this.#options.paths.runnerLedgerDb,
  feltdbPath: this.#options.feltdbPath,
  ...this.#options.runnerLedger,
});
await ledger.recover();  // Throws if ledger fails

// ✅ Correct: All state stores are FeltDB-only
managedStore = new FeltDbExecutorStateStore(
  this.#options.paths.managedStateDb,
);
```

**Result**: ✅ No silent degradation. System fails hard if FeltDB is unavailable.

## Test Coverage

Test files verify FeltDB-only behavior:

| Test File | Coverage |
|-----------|----------|
| `runner-executor/open-command-ledger.test.ts` | Ledger conformance against FeltDB |
| `runner-executor/feltdb-ledger.test.ts` | FeltDB ledger implementation |
| `runner-executor/feltdb-runtime.integration.test.ts` | Full runtime integration |
| `runner-executor/ledger-conformance.test.ts` | Ledger contract validation |

**Note**: Tests create FeltDB databases in temp directories. No SQLite database files are created during Mission Control runtime operation.

## Durability Guarantees

### Crash Recovery

1. Process restart triggers `ledger.recover()`
2. FeltDB atomically fails all active claims to avoid double-claiming
3. Ledger resume with new generation
4. No state loss; all committed transactions preserved

### Consistency

- FeltDB atomic transactions ensure records are never partially updated
- No dual-write inconsistencies (single source of truth)
- Sequence ordering is monotonic and globally ordered

### Performance

- Local file-based database (no network latency)
- Embedded in process (no subprocess overhead)
- Async I/O for non-blocking operations

## Migration Notes

### No Fallback to SQLite

Unlike earlier phases (run-journal.ts, which uses `ENABLE_FELTDB_RUN_RECORDS`), the Mission Control runtime **does not support dual-write or fallback modes**:

- Command ledger: FeltDB-only, no SQLite alternative
- Agent/task registries: FeltDB-only, no JSON fallback
- Executor state: FeltDB-only, no per-session SQLite databases

This is intentional and correct for the runtime core.

### Phase Scope

This completion covers **Phase 1** of the FeltDB migration:

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 1 | Runner executor persistence | ✅ Complete |
| Phase 2 | Run records (dual-write) | ✅ Separate component |
| Phase 3 | Session kernel transcripts | ⏳ Future |
| Phase 4 | Full transcript migration | ⏳ Future |
| Phase 5 | Memory v2 migration | ⏳ Future |

Session kernel and memory v2 remain on SQLite during this phase—they are separate concerns with their own migration timeline.

## Configuration & Deployment

### Environment Variables

Mission Control runtime recognizes:

| Variable | Purpose | Default |
|----------|---------|---------|
| `FELTDB_TELEMETRY` | Enable telemetry to feltdb.com | Disabled (off) |
| (none for fallback) | No fallback configuration | N/A |

### Startup Requirements

The executor runtime requires:

1. Valid `feltdbPath` (will derive from `dbPath` if not provided)
2. FeltDB library (`@feltdb/core` v0.6.13+)
3. Write access to FeltDB directory
4. Single-writer process ownership (file-based runtime limitation)

If FeltDB fails to initialize, the service **will not start**.

## Security Implications

### Data Locality

- ✅ All state stays on-machine
- ✅ No network calls for persistence (telemetry disabled)
- ✅ No API keys or credentials stored in FeltDB
- ✅ Git credentials remain in .git/config or external secret manager

### Access Control

- ✅ FeltDB data is a single file with filesystem permissions
- ✅ One write-process owner prevents concurrent modifications
- ✅ No multi-tenant isolation (single deployment per FeltDB instance)

## Operational Guidance

### Backup & Recovery

**Backup**: Copy the FeltDB data directory

```bash
cp -r <feltdbPath> <backup-path>
```

**Recovery**: Restore FeltDB directory and restart service

```bash
rm -rf <feltdbPath>
cp -r <backup-path> <feltdbPath>
```

### Troubleshooting

**Symptom**: "FeltDB path must be provided"

**Cause**: `feltdbPath` not set and `dbPath` not provided  
**Fix**: Set `feltdbPath` or ensure `dbPath` is provided

**Symptom**: "Executor runtime closed during start"

**Cause**: Service shutdown during initialization  
**Fix**: Check logs; restart service

**Symptom**: Ledger operations timing out

**Cause**: Concurrent writer attempting to access FeltDB  
**Fix**: Ensure only one process owns the FeltDB instance

## Summary

Mission Control's runtime environment is now **FeltDB-native**:

✅ FeltDB is the sole durable persistence for executor state  
✅ No fallback modes or configuration options  
✅ Atomic transactions guarantee consistency  
✅ Fail-hard semantics ensure no silent data loss  
✅ Local-first architecture preserved (no network calls)  
✅ Crash recovery verified and tested  

This establishes a clean architectural boundary for Phase 2-3 migration work on higher-level components.

---

**Next Steps**:

1. Validate crash recovery in production
2. Monitor ledger operation latency and throughput
3. Begin Phase 2 (run records) upgrade path
4. Plan Phase 3 (transcript migration) scope
