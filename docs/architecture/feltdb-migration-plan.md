# FeltDB Migration Plan: Path from Current Architecture to FeltDB Native Storage

**Status**: Architecture Planning (No Implementation)  
**Scope**: Migration strategy, compatibility, rollout, rollback, and recovery

---

## 1. Executive Summary

This document defines the strategy for migrating felt-session from its current fragmented persistence (SQLite + JSON journal + filesystem) to a unified FeltDB-native architecture.

**Key principle**: Incremental, reversible, non-disruptive migration with zero data loss.

**Phases**:
1. **Phase 1 (this PR)**: Assessment and planning (complete)
2. **Phase 2 (next PR)**: Adapter pattern implementation
3. **Phase 3 (subsequent PR)**: Dual-write validation
4. **Phase 4 (later PR)**: Cutover and cleanup

**Estimated duration**: 4-6 weeks for full rollout
**Rollback capability**: Retain until Phase 4 complete (6+ weeks)

---

## 2. Current State Assessment

### 2.1 Existing Persistence Components

**Component**: SQLite Ledger (executor)
- **Location**: `~/.opensession/executor/ledger.db`
- **Tables**: commands (v2)
- **Scope**: Global (shared across all sessions)
- **Data lifetime**: Lifetime of executor process
- **Size**: Bounded (10,000 records max)

**Component**: Session Kernel Database (per-session)
- **Location**: `~/.opensession/sessions/{sessionId}/session.db`
- **Tables**: Multiple (v32: command_state, run_state, timer_state, delivery_state, cancel_state)
- **Scope**: One table per session
- **Data lifetime**: Lifetime of session
- **Size**: Typical 100KB-1MB per session

**Component**: Transcript Store (per-session)
- **Location**: `~/.opensession/sessions/{sessionId}/transcript.db`
- **Tables**: entries (v2, append-only)
- **Scope**: One table per session
- **Data lifetime**: Lifetime of session
- **Size**: Typical 100KB-5MB per session (depending on turn count)

**Component**: JSON Journal (recovery tracking)
- **Location**: `~/.opensession/active-runs.json`
- **Format**: JSON array of ActiveRunRecord
- **Scope**: Global (tracks in-flight runs)
- **Data lifetime**: Until normal shutdown or recovery
- **Size**: Typical 10KB-100KB (max ~1MB)

**Component**: Filesystem (worktrees, artifacts)
- **Location**: `~/.opensession/sessions/{sessionId}/`
- **Content**: `.git/`, worktree files, build outputs, artifacts
- **Scope**: One directory per session
- **Data lifetime**: Lifetime of session
- **Size**: Variable (git worktree typically 100MB-1GB+)

### 2.2 Data Distribution

```
SQLite
├─ executor/ledger.db       (1 global)
├─ sessions/*/session.db    (N per-session)
└─ sessions/*/transcript.db (N per-session)

JSON
└─ active-runs.json         (1 global)

Filesystem
├─ sessions/*/
│  ├─ .git/                 (worktree)
│  ├─ artifacts/            (outputs)
│  └─ ...                   (repo files)

→ Total: ~N sessions × (300KB-1GB per session)
```

---

## 3. Migration Strategy: Adapter Pattern

### 3.1 Three-Layer Architecture

```
┌─────────────────────────────────┐
│     Agent Runtime Layer         │
│  (unchanged, no dependencies    │
│   on persistence mechanism)     │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│    DurableStore Interface       │
│  (abstraction, defines API)     │
└──────┬──────────────────────┬───┘
       │                      │
   Phase 2 & 3            Phase 4
       │                      │
┌──────▼──────────────┐ ┌────▼──────────────┐
│ SQLiteStore         │ │ FeltDBStore       │
│ (legacy, reads)     │ │ (native, writes)  │
│ (adapter)           │ │ (new)             │
└─────────────────────┘ └───────────────────┘
       │                      │
       └──────┬───────────────┘
              │
    ┌─────────▼─────────┐
    │  SQLite / FeltDB  │
    │  (dual-write)     │
    └───────────────────┘
```

### 3.2 Phase Breakdown

#### Phase 2: Adapter Pattern (No Behavior Change)

**Goal**: Establish DurableStore interface without changing persistence behavior.

**Work**:
1. Create `packages/core/opensession-server/src/durable-store/` directory
2. Define `DurableStore` interface (read + write methods)
3. Implement `SQLiteStore` adapter (wraps existing SQLite code)
4. Implement `InMemoryStore` for testing
5. Add factory: `createDurableStore(config.persistence)` → SQLiteStore | InMemoryStore
6. Inject DurableStore into session service (no behavior change)
7. All existing tests continue passing

**Code changes**: Refactoring only (no logic changes)
- Create new interface definition file
- Wrap existing SQLite calls in adapter methods
- Update service constructors to accept DurableStore
- Remove direct SQLite imports from runtime code

**Backward compatibility**: ✓ 100% (no data changes, no behavior changes)

**Rollback**: Trivial (revert branch)

**Testing**:
- Unit tests: All existing tests use InMemoryStore (fast)
- Integration tests: Run against SQLiteStore (validates adapter)
- E2E: Unchanged (still uses SQLite under the hood)

**Duration**: ~1-2 weeks (moderate refactoring)

**Risk**: Low (wrapping existing code, no logic changes)

#### Phase 3: Dual-Write Validation (No Read Change Yet)

**Goal**: Parallel write to both SQLite and FeltDB, validate consistency.

**Work**:
1. Implement `FeltDB` integration (client library)
2. Implement `FeltDBStore` adapter
3. Create `DualWriteStore` wrapper that writes to both SQLite and FeltDB
4. Add consistency checking:
   - On each read from SQLite, compare result with FeltDB
   - Log/alert if mismatch detected
   - Do NOT use FeltDB results yet (stay on SQLite for reads)
5. Deploy to staging environment
6. Monitor consistency for ~2 weeks
7. Verify: Zero mismatches over observation period

**Code changes**: Adding FeltDB writes (no read changes)
- Implement FeltDBStore methods
- Wrap in DualWriteStore
- Add validation/monitoring
- Update config to enable dual-write

**Backward compatibility**: ✓ 100% (reads still from SQLite)
- If FeltDB write fails, log error but continue (read from SQLite)
- Users see no difference

**Rollback**: Revert to Phase 2 (disable FeltDB writes)

**Testing**:
- Unit tests: Run against SQLiteStore only (Phase 2)
- Integration tests: Run DualWriteStore against both
- Add consistency validation tests
- E2E: Unchanged (reads from SQLite)

**Duration**: ~2-3 weeks (implementation + observation period)

**Risk**: Medium
- FeltDB implementation complexity
- Consistency bugs could be detected in phase, giving time to fix
- If critical bug found, disable FeltDB writes (zero data loss)

#### Phase 4: Cutover to FeltDB (Final Migration)

**Goal**: Switch reads to FeltDB, deprecate SQLite.

**Work**:
1. Create migration script: SQLite → FeltDB (one-time backfill)
   - For each session: read from SQLite, write to FeltDB
   - Verify: row counts match
   - Reconcile: any missing records
2. Test migration on copy of production data
3. Execute migration on production (off-peak hours)
4. Enable FeltDB reads (factory returns FeltDBStore)
5. Monitor for errors (zero, or rollback immediately)
6. Disable SQLite writes
7. After 4+ weeks: delete SQLite files (archive first)
8. Remove SQLiteStore code (refactor only)

**Code changes**: Switching read path + cleanup
- Update factory to return FeltDBStore
- Remove SQLiteStore implementation
- Update tests to use only FeltDB (backward-compatible)
- Delete SQLite migration helper code

**Backward compatibility**: ✓ Migration-compatible
- Existing SQLite data fully migrated before cutover
- Transparent to users (same API)
- No client/protocol changes needed

**Rollback**: Revert factory to SQLiteStore, re-migrate data back (slow but possible)

**Testing**:
- Dry-run migration on prod copy
- Unit tests: All use FeltDB now
- Integration tests: All use FeltDB now
- E2E: Unchanged API (just different storage)

**Duration**: ~1-2 weeks (migration + monitoring)

**Risk**: High if migration has bugs
- Mitigation: dry-run on backup, gradual cutover per workspace
- If bug detected: revert to Phase 3 (Phase 3 still has SQLite writes)

---

## 4. Data Migration: SQLite → FeltDB

### 4.1 Migration Script

```typescript
// pseudocode
async function migrateSessionsToFeltDB(sourceSQLite, targetFeltDB) {
  const sessions = await sourceSQLite.getAllSessions();
  let success = 0, failed = 0;
  
  for (const session of sessions) {
    try {
      // Migrate session metadata
      const sessionRecord = await sourceSQLite.getSessionMetadata(session.id);
      await targetFeltDB.createSession(sessionRecord);
      
      // Migrate session events (append-only, must preserve order)
      const events = await sourceSQLite.getTranscriptEntries(session.id);
      for (const event of events) {
        await targetFeltDB.recordEvent(session.id, event);
      }
      
      // Migrate executions
      const executions = await sourceSQLite.getExecutions(session.id);
      for (const execution of executions) {
        await targetFeltDB.createExecution(execution);
      }
      
      // Migrate timers (if any active)
      const timers = await sourceSQLite.getTimers(session.id);
      for (const timer of timers) {
        await targetFeltDB.registerTimer(timer);
      }
      
      success++;
    } catch (err) {
      console.error(`Failed to migrate session ${session.id}:`, err);
      failed++;
    }
  }
  
  console.log(`Migration: ${success} sessions OK, ${failed} failed`);
  return { success, failed };
}
```

**Key properties**:
- Idempotent: Can run migration multiple times, no duplicates
  - FeltDB document IDs are deterministic (derived from SQLite IDs)
  - Append-only collections are duplicate-safe (same ID = same data)
- Non-destructive: Source SQLite NOT modified during migration
- Verifiable: Check row counts and content checksums before/after
- Resumable: If migration interrupted, restart from where it stopped (check last migrated session ID)

### 4.2 Verification

After migration, before cutover:

```typescript
async function verifyMigration(sourceSQLite, targetFeltDB) {
  // Count verification
  const srcSessions = await sourceSQLite.countSessions();
  const tgtSessions = await targetFeltDB.countSessions();
  if (srcSessions !== tgtSessions) throw new Error("Session count mismatch");
  
  const srcEvents = await sourceSQLite.countEvents();
  const tgtEvents = await targetFeltDB.countEvents();
  if (srcEvents !== tgtEvents) throw new Error("Event count mismatch");
  
  // Content verification (sample check)
  for (let i = 0; i < 100; i++) {
    const sessionId = sampleSessionIds[i];
    const srcEvents = await sourceSQLite.getEvents(sessionId);
    const tgtEvents = await targetFeltDB.getEvents(sessionId);
    
    if (srcEvents.length !== tgtEvents.length) {
      throw new Error(`Event count mismatch for session ${sessionId}`);
    }
    
    for (let j = 0; j < srcEvents.length; j++) {
      if (srcEvents[j].id !== tgtEvents[j].id) {
        throw new Error(`Event ID mismatch at index ${j} in session ${sessionId}`);
      }
    }
  }
  
  console.log("✓ Migration verified: all counts and samples match");
}
```

### 4.3 Cutover Strategy

**Option A: Big Bang (Riskier)**
1. Stop all processes
2. Run migration (full dataset)
3. Verify
4. Switch reads to FeltDB
5. Restart processes
6. **Downtime**: ~15-30 minutes

**Option B: Staged (Safer)**
1. Enable dual-write for all sessions (Phase 3)
2. For each workspace (or % of sessions):
   a. Run migration for that workspace
   b. Verify
   c. Switch reads to FeltDB (per-workspace)
   d. Monitor for 24h
   e. If OK, proceed to next workspace
3. **Downtime**: ~5 minutes per workspace (minimal)

**Recommended**: Option B (staged per-workspace)

---

## 5. Rollback Strategy

### 5.1 Rollback Windows

**Phase 2**: Revert branch (0 data changes)

**Phase 3**: Disable FeltDB writes, keep SQLite
- Duration: Can rollback instantly for up to 6 weeks
- Mechanism: Set config `feltdb.enabled = false`
- Verify: Restart, check SQLite contains all recent writes

**Phase 4 (before completion)**: Revert to FeltDB reads
- Duration: Can rollback if migration is incomplete
- Mechanism: Set factory to return SQLiteStore
- Verify: Restart, check SQLite is authoritative

**Phase 4 (after completion)**: Data recovery from backup
- Duration: If data loss occurs, restore from FeltDB backup
- Mechanism: Last known-good FeltDB snapshot (from before cutover)
- Verify: Reconcile with application logs

### 5.2 Rollback Procedure

If critical bug detected during Phase 3 (dual-write):

1. Disable FeltDB writes (set config `feltdb.enabled = false`)
2. Verify SQLite still has all data
3. Investigate bug (does not affect users)
4. Fix bug in code
5. Resume FeltDB writes (re-enable in config)
6. Monitor for 24h before proceeding

If critical bug detected during Phase 4 (cutover):

1. Switch reads back to SQLite (factory returns SQLiteStore)
2. Stop writing to FeltDB
3. Verify users can access their sessions (SQLite)
4. Investigate bug
5. Fix bug
6. If rollback preferred, archive FeltDB and stay on SQLite
7. If fix is solid, restart Phase 4 migration

**Data loss recovery**: If FeltDB migration lost data:

1. Compare FeltDB event count with SQLite event count
2. For any mismatch, re-migrate missing sessions from SQLite
3. Detect duplicates by ID (should be none, as IDs are deterministic)
4. Mark sessions as "recovered" for operator review

---

## 6. Existing State Compatibility

### 6.1 Backward Compatibility Requirements

**Requirement 1: Existing sessions must remain accessible**
- Old SQLite session.db files must be importable
- Legacy session ID format ("bks-...") must be mapped to new format ("os-...")
- Existing worktrees must be found and linked

**Requirement 2: Existing transcripts must be readable**
- Transcript v2 schema must be parsed and migrated
- Event sequence numbers must be preserved (no gaps)
- Wire format (clamped content) must be expanded on read

**Requirement 3: Existing configurations must work**
- workspace.json files must be imported
- Automation definitions must be importable
- Provider state must not be lost

### 6.2 Compatibility Implementation

**Legacy session ID mapping**:
```typescript
function normalizeSessionId(legacyId: string): string {
  if (legacyId.startsWith("os-")) return legacyId;  // Already normalized
  if (legacyId.startsWith("bks-")) {
    // Convert "bks-xyz" to "os-xyz" (keep UUID part)
    return "os-" + legacyId.substring(4);
  }
  throw new Error(`Unknown session ID format: ${legacyId}`);
}
```

**Lazy import** (optional, for performance):
- On first read of old session, import on-demand
- Cached, so subsequent reads are fast
- Allows migration to happen in background

**Dual-format support** (Phase 2-3):
- SQLiteStore can read both v2 and v32 schemas
- FeltDBStore only writes v1 (no versioning needed)
- Adapter abstracts away version complexity

### 6.3 Legacy Data Lifecycle

| Phase | SQLite Read | SQLite Write | FeltDB Read | FeltDB Write |
|---|---|---|---|---|
| Current | ✓ | ✓ | ✗ | ✗ |
| Phase 2 | ✓ (via adapter) | ✓ (via adapter) | ✗ | ✗ |
| Phase 3 | ✓ (via adapter) | ✓ (both) | ✗ | ✓ (validation) |
| Phase 4 | ✓ (backup) | ✗ | ✓ | ✓ |
| After 4w | ✗ (deleted) | ✗ (deleted) | ✓ | ✓ |

---

## 7. Configuration and Feature Flags

### 7.1 Configuration Schema

```typescript
interface PersistenceConfig {
  // Phase 2: Choose implementation
  storageKind: "sqlite" | "feltdb" | "memory";  // Default: "sqlite"
  
  // Phase 3: Enable dual-write
  dualWriteEnabled?: boolean;  // Default: false (Phase 2)
  
  // Phase 3+: Consistency validation
  validateConsistency?: boolean;  // Default: false (Phase 3, enable for staging)
  consistencyCheckFrequency?: number;  // Every N operations (default: 100)
  
  // Phase 4: Cutover
  readFromFeltDB?: boolean;  // Default: false (Phase 3), true (Phase 4)
  
  // Paths
  sqlitePath: string;  // Default: ~/.opensession/
  feltdbPath?: string;  // Default: ~/.opensession/feltdb/
}
```

### 7.2 Environment-Based Configuration

**Development** (localhost):
```
PERSISTENCE_KIND=sqlite
FELT_DB_ENABLED=false
DUAL_WRITE=false
```

**Staging** (pre-production testing):
```
PERSISTENCE_KIND=sqlite
FELT_DB_ENABLED=true
DUAL_WRITE=true
VALIDATE_CONSISTENCY=true
```

**Production Phase 2-3** (adapter + dual-write, reads from SQLite):
```
PERSISTENCE_KIND=sqlite
FELT_DB_ENABLED=true
DUAL_WRITE=true
VALIDATE_CONSISTENCY=false
READ_FROM_FELTDB=false
```

**Production Phase 4+** (reads from FeltDB):
```
PERSISTENCE_KIND=feltdb
FELT_DB_ENABLED=true
DUAL_WRITE=false
VALIDATE_CONSISTENCY=false
READ_FROM_FELTDB=true
```

---

## 8. Risk Mitigation

### 8.1 Identified Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| FeltDB write bug causes duplicate events | Medium | High | Phase 3: validation, idempotency keys, dry-run migration |
| Adapter breaks existing session access | High | High | Phase 2: all existing tests pass, InMemoryStore + SQLiteStore comparison |
| Migration loses data (count mismatch) | Low | Critical | Phase 3: verify before cutover, backup SQLite, checksums |
| FeltDB query performance is slow | Medium | Medium | Phase 3: performance tests, indexes tuning |
| Rollback fails (data stuck in FeltDB) | Low | High | Phase 3+: always maintain SQLite dual-write until Phase 4 complete |
| Operator error (delete FeltDB files early) | Medium | Critical | Procedures: archive to backup before deletion, 2-week retention |

### 8.2 Testing Matrix

**Phase 2 Tests**:
- [ ] SQLiteStore wraps all existing SQLite calls
- [ ] InMemoryStore works for all test scenarios
- [ ] Factory correctly selects SQLiteStore (no memory leaks)
- [ ] All existing tests pass unchanged
- [ ] No behavior differences (black-box testing)

**Phase 3 Tests**:
- [ ] FeltDB connection works locally
- [ ] FeltDBStore implements all DurableStore methods
- [ ] Dual-write works (write to both, no failures)
- [ ] Validation detects actual differences
- [ ] On SQLite read, comparing with FeltDB result is consistent
- [ ] Idempotency keys prevent duplicates
- [ ] Migration script is idempotent (run twice, same result)

**Phase 4 Tests**:
- [ ] Dry-run migration on prod backup
- [ ] FeltDB read matches migrated data
- [ ] Cutover to FeltDB reads (staged per-workspace)
- [ ] Stress test: concurrent reads/writes on FeltDB
- [ ] Crash recovery: process dies mid-write, session recovers

**E2E Tests** (all phases):
- [ ] Create session → turn → file change → checkpoint → resume
- [ ] Multi-client: two clients reading same session
- [ ] Recovery: process crash, restart, resume
- [ ] Delete session: removes all associated data
- [ ] Workspace operations: create, list, delete

---

## 9. Timeline and Milestones

### Phase 1: Assessment (COMPLETE)
- **Duration**: 1 week
- **Deliverables**: 
  - feltdb-assessment.md (this document's companion)
  - feltdb-data-model.md
  - ADR for architecture decision
- **Status**: ✓ Complete

### Phase 2: Adapter Pattern
- **Duration**: 1-2 weeks
- **Deliverables**:
  - DurableStore interface
  - SQLiteStore adapter
  - InMemoryStore for tests
  - Factory and injection setup
  - All existing tests passing
- **Go/No-Go**: All tests pass, black-box testing confirms zero behavior change
- **Deployment**: Production (no user impact)

### Phase 3: Dual-Write Validation
- **Duration**: 2-3 weeks (including observation period)
- **Deliverables**:
  - FeltDB integration
  - FeltDBStore adapter
  - DualWriteStore wrapper
  - Consistency validation + monitoring
  - Migration script (dry-run only)
- **Go/No-Go**: 0 consistency errors over 2-week observation, migration dry-run succeeds
- **Deployment**: Staging (1-2 weeks), then production (reads still from SQLite)

### Phase 4: Cutover to FeltDB
- **Duration**: 1-2 weeks (migration + monitoring)
- **Deliverables**:
  - Live migration script execution
  - Staged rollout per-workspace
  - FeltDB reads enabled
  - SQLite writes disabled
  - Monitoring dashboard
  - Rollback procedure validated
- **Go/No-Go**: Zero errors during staged migration, user sessions accessible, 48h monitoring OK
- **Deployment**: Production (staged rollout)

### Phase 5: Cleanup and Removal
- **Duration**: 2-4 weeks (observation period before deletion)
- **Deliverables**:
  - SQLite files archived to backup
  - SQLiteStore code removed
  - FeltDB becomes canonical implementation
  - Legacy path support deprecated
- **Go/No-Go**: 4 weeks with FeltDB as only storage, zero fallback needs
- **Deployment**: Production

**Total Duration**: ~8-12 weeks (phases 1-4), with 4+ week observation windows

---

## 10. Monitoring and Observability

### 10.1 Metrics to Track

**Phase 2 (Adapter)**:
- Regression tests pass rate: 100%
- Existing session access latency: baseline
- No errors in SQLiteStore adapter

**Phase 3 (Dual-Write)**:
- Consistency check pass rate: 100%
- FeltDB write success rate: 99%+ (expected)
- Consistency errors detected: 0
- Latency comparison (SQLite vs FeltDB reads): <10% difference

**Phase 4 (Cutover)**:
- Migration progress: % of sessions migrated
- Migration error rate: should be 0
- User session access latency: within baseline ±5%
- FeltDB query latency: <500ms for user-facing queries
- Recovery success rate: 100% for interrupted sessions

### 10.2 Alerting Rules

- **Phase 3**: Alert if consistency check fails (not expected)
- **Phase 3**: Alert if FeltDB write fails (expected to be rare)
- **Phase 4**: Alert if migration has >1% error rate
- **Phase 4**: Alert if session access latency exceeds baseline +20%
- **Phase 4**: Alert if recovery fails (user cannot resume session)

### 10.3 Dashboards

**Migration Progress** (Phase 3-4):
- Sessions migrated / total (%)
- Events migrated / total
- Errors by type (and remediation)
- Time per session (to estimate completion)

**Consistency** (Phase 3):
- Consistency errors over time
- Error types (missing record, mismatch content, etc.)
- Affected sessions (for investigation)

**Performance** (Phase 3-4):
- Query latency: p50, p95, p99 for each query type
- Write latency: append, update, multi-record transactions
- Throughput: reads/sec, writes/sec

---

## 11. Communication and Runbooks

### 11.1 Stakeholder Communication

**Phase 2** (Developers):
- "We're refactoring persistence to prepare for FeltDB integration"
- "No behavior changes, tests will validate"
- Code review focus: verify adapter correctness

**Phase 3** (Staging/QA):
- "Testing FeltDB in parallel, validating consistency"
- "If you see errors, report them for investigation"
- No action required from users

**Phase 4** (Production Rollout):
- "Migrating session storage to FeltDB for improved durability"
- "Sessions will be temporarily read-only during migration (per workspace)"
- "If any issues, rollback is immediate"

### 11.2 Runbooks

**Runbook 1: Phase 3 Consistency Error**
1. Alert triggered: consistency check failed
2. Investigate: which session, which field?
3. Fix: apply code patch to FeltDBStore
4. Test: reproduce error, validate fix
5. Deploy: restart processes
6. Verify: re-run consistency check, should pass

**Runbook 2: Phase 4 Migration Failure**
1. Alert triggered: migration error rate >1%
2. Pause: stop migration (resume from last checkpoint)
3. Investigate: which sessions failed, why?
4. Fix: resolve underlying cause (schema issue, data corruption, etc.)
5. Retry: resume migration from paused checkpoint
6. Monitor: watch error rate go back to 0%

**Runbook 3: Rollback from Phase 3 to Phase 2**
1. Decision: critical bug found, cannot fix quickly
2. Disable FeltDB writes: set `feltdb.enabled = false` in config
3. Restart: processes now write SQLite only
4. Verify: check SQLite has all recent data
5. Notify: inform team of status, ETA for fix
6. Fix: resolve bug in code
7. Resume: re-enable FeltDB writes

**Runbook 4: Rollback from Phase 4 to Phase 3**
1. Decision: critical bug found during cutover
2. Switch reads: factory returns SQLiteStore (not FeltDBStore)
3. Restart: processes now read from SQLite, write to FeltDB (unchanged)
4. Verify: users can access sessions, no errors
5. Notify: inform team, restart Phase 4 cutover after fix
6. Fix: resolve bug in FeltDB implementation

---

## 12. Success Criteria

This migration is successful when:

- ✓ Phase 2 complete: All existing tests pass, adapter is invisible to runtime
- ✓ Phase 3 complete: 0 consistency errors over 2-week observation, dry-run migration verified
- ✓ Phase 4 complete: Staged migration succeeds for all workspaces, FeltDB is primary storage
- ✓ Phase 5 complete: SQLite files archived and deleted (after 4-week observation)
- ✓ No data loss: 100% of sessions, events, executions migrated and verified
- ✓ User experience: Sessions remain accessible throughout, no downtime >5 min per workspace
- ✓ Performance: FeltDB queries <500ms (user-facing), <10s (background)
- ✓ Reliability: Crash recovery works on FeltDB, zero lost events
- ✓ Operations: Runbooks tested, monitoring active, alerting configured

---

## Appendix: Configuration Examples

### Example 1: Development Environment

```bash
# .env.development
PERSISTENCE_KIND=memory
FELT_DB_ENABLED=false
DUAL_WRITE=false
```

### Example 2: Staging (Phase 3)

```bash
# .env.staging
PERSISTENCE_KIND=sqlite
FELT_DB_ENABLED=true
DUAL_WRITE=true
VALIDATE_CONSISTENCY=true
CONSISTENCY_CHECK_FREQUENCY=100
READ_FROM_FELTDB=false
```

### Example 3: Production (Phase 4)

```bash
# .env.production
PERSISTENCE_KIND=feltdb
FELT_DB_ENABLED=true
DUAL_WRITE=false
VALIDATE_CONSISTENCY=false
READ_FROM_FELTDB=true
```

---

End of Migration Plan
