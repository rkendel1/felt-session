# ADR: FeltDB as the Native Durable Agent Substrate

**Status**: Proposed (pending review)  
**Decision Date**: 2026-08-28  
**Affected Components**: Session service, persistence layer, executor, runtime  
**Supercedes**: None  
**Related**: None

---

## Problem Statement

**felt-session** currently uses a **fragmented persistence architecture**:
- SQLite ledger (executor commands, global scope)
- Per-session SQLite databases (kernel state, transcripts)
- JSON journal (in-flight run recovery)
- Filesystem (git worktrees, artifacts)

This architecture has emerged organically from incremental development and lacks a unified storage boundary. As a result:

1. **No coherent abstraction**: Persistence logic scattered throughout the runtime
2. **Racy recovery**: JSON journal read-modify-write is not atomic
3. **Limited scalability**: Multiple independent databases per session
4. **Testing burden**: Integration tests must set up and clean multiple stores
5. **Migration path unclear**: Adding new persistence capability requires changes everywhere

**Desired state**: Single, durable, local-first storage substrate that serves as the native infrastructure for agent session lifecycle.

---

## Decision

**Adopt FeltDB as the native durable storage substrate for felt-session.**

FeltDB will:
- Store all durable application state (sessions, events, executions, timers)
- Replace SQLite/JSON as the canonical persistence layer
- Be accessed exclusively through a `DurableStore` abstraction
- Remain embedded/local (no network dependency)
- Preserve local self-hosted nature of felt-session

Filesystem will continue to own:
- Git worktrees and repository files
- Build artifacts and outputs
- Large tool results (via external reference pattern)

---

## Rationale

### 1. Durability Requirements (FeltDB ✓)

| Requirement | Current | FeltDB Capability |
|---|---|---|
| ACID transactions | Partial (SQLite only) | Full |
| Append-only events | Sequence-numbered | Native |
| Crash recovery | Journal + state | Reliable |
| Deduplication | Manual hashing | Document IDs |
| Ordered operations | Per-database | Global ordering |

**Conclusion**: FeltDB meets all durability requirements without compromise.

### 2. Local-First Architecture (FeltDB ✓)

FeltDB is designed as an embedded database:
- Runs in-process with agent runtime (or local subprocess)
- No network dependency for normal operation
- Data stays on-machine
- Self-hosted design matches felt-session's values

**Conclusion**: FeltDB's embedded nature suits local-first, with one caveat
found in Phase 2: constructing a database posts an adoption event to
feltdb.com. It is opt-out via `FELTDB_TELEMETRY`, and adapters must default it
off rather than inherit it.

### 3. Concurrency Model (FeltDB ✓)

FeltDB supports:
- Multiple concurrent readers
- ACID transactions for multi-record writes
- Optimistic locking with version vectors
- Session-level partitioning (sessions don't interfere)

**Conclusion**: FeltDB's concurrency primitives handle felt-session's workload,
with one correction found in Phase 2: the embedded file runtime does not
serialize writers across processes, so a single owning process is still
required, exactly as it is for SQLite. Version-vector locking is not what this
runtime provides.

### 4. Query Capability (FeltDB ✓)

Required queries map naturally to FeltDB collections:
- List sessions (indexed by workspace, status, creation time)
- Get events after sequence N (append-only)
- Query executions by status (recovery)
- Get active timers (scheduling)

**Conclusion**: FeltDB queries are sufficient and efficient.

### 5. No Architecture Distortion (FeltDB ✓)

With `DurableStore` abstraction:
- Runtime depends on interface, not implementation
- FeltDB calls isolated to single layer
- Testable with InMemoryStore
- Swappable (if needed in future)

**Conclusion**: FeltDB as infrastructure, not business logic.

### 6. Operational Clarity (FeltDB ✓)

Single unified store provides:
- Clear durability boundary
- Consistent backup/recovery semantics
- Single source of truth (eliminates dual-write bugs)
- Simpler deployment and monitoring

**Conclusion**: FeltDB simplifies operations.

---

## Alternatives Considered

### Alternative 1: Stay with Current Architecture

**Pros**:
- No migration effort
- Uses familiar SQLite/JSON tooling

**Cons**:
- Fragmented persistence remains
- Scaling issues persist
- Recovery semantics unclear
- No unified abstraction
- Does not solve identified problems

**Decision**: Rejected (misses opportunity to improve architecture)

### Alternative 2: PostgreSQL or other relational DB

**Pros**:
- Mature, well-tested
- ACID transactions
- Complex queries

**Cons**:
- Requires network or local daemon
- Breaks local-first model (single machine architecture)
- Operational overhead (schema migrations, backups)
- Overkill for felt-session's query needs (simple key-value + append)
- Does not align with self-hosted design

**Decision**: Rejected (violates local-first principle)

### Alternative 3: RocksDB or similar key-value store

**Pros**:
- Embedded, no network
- Simple operations
- Local-first

**Cons**:
- No transactions across keys (durability boundary issue)
- No built-in query language
- Limited support for append-only collections
- Requires custom layer for ordering/indexing

**Decision**: Rejected (would require reimplementing FeltDB's abstractions)

### Alternative 4: Event Sourcing + In-Memory Materialization

**Pros**:
- Single canonical event stream
- Replays possible
- Audit trail built-in

**Cons**:
- Requires replaying all events on startup (scales poorly)
- Complex recovery semantics
- Performance overhead for every read
- State reconstruction adds latency

**Decision**: Rejected (performance unacceptable for large transcripts)

---

## Proposed Implementation

### Phase 1: Assessment (✓ This PR)
- Complete inventory of existing persistence
- Define DurableStore abstraction
- Design FeltDB schema
- Document recovery semantics
- Produce migration plan

### Phase 2: Adapter Pattern (✓ delivered, for the command ledger)
- `DurableCommandLedger` already existed and needed no new interface
- Shared record codec extracted so every backend validates identically
- `FeltDbCommandLedger` implemented on `@feltdb/core@0.6.13`
- One conformance suite runs against in-memory, SQLite, and FeltDB
- Backend factory added, still defaulting to SQLite: no behavior changed

Scope note: this covered the executor command ledger only. Sessions, events,
and timers live in the per-session kernel stores and the run journal, and have
no adapter yet. See "Phase 2 as delivered" in
`docs/architecture/feltdb-migration-plan.md`, which also records six ways
`@feltdb/core@0.6.13` differs from what this ADR assumed — including that the
file runtime does not serialize writers across processes.

### Phase 3: Dual-Write Validation (Later PR)
- Implement FeltDB integration
- Enable dual-write (both SQLite and FeltDB)
- Validate consistency
- Dry-run migration

### Phase 4: Cutover (Subsequent PR)
- Execute live migration
- Switch reads to FeltDB
- Deprecate SQLite
- Monitor for issues

### Phase 5: Cleanup (Future)
- Delete SQLite files (archive first)
- Remove SQLiteStore code
- FeltDB becomes canonical

**Total time**: ~8-12 weeks with observation windows

---

## Consequences

### Positive

1. **Unified durability model**: Single abstraction for all persistent state
2. **Improved reliability**: ACID transactions, better crash recovery
3. **Scalability**: Collections are more efficient than multiple databases
4. **Operational clarity**: Single "source of truth" for session state
5. **Testing**: InMemoryStore enables fast unit tests
6. **Migration path**: Adapter pattern allows reversible cutover
7. **Future-proof**: Positions felt-session for multi-machine scenarios (if ever needed)

### Negative

1. **Migration effort**: Phased rollout required, not instantaneous
2. **New dependency**: FeltDB becomes required (but embedded, no external service)
3. **Learning curve**: Team must learn FeltDB data model and APIs
4. **Observation period**: Phases 3-4 require weeks of validation before full cutover
5. **Rollback complexity**: If critical bug found, rollback adds operational work

### Mitigations

- **Migration effort**: Adapter pattern minimizes code changes per phase
- **New dependency**: FeltDB is lightweight, embedded library (no deployment overhead)
- **Learning curve**: FeltDB is simpler than current SQLite + JSON + FS combination
- **Observation period**: Necessary for confidence; reduces post-cutover incidents
- **Rollback complexity**: Careful testing and staged rollout minimize rollback need

---

## Implementation Risks

### Risk 1: FeltDB Implementation Bugs (Phase 3)

**Probability**: Medium  
**Impact**: High (duplicate events, lost data)  
**Mitigation**:
- Phase 3 validates against SQLite before cutover
- Dry-run migration on backup before Phase 4
- Consistency checking detects issues early
- Rollback to Phase 2 is fast if needed

### Risk 2: Performance Degradation

**Probability**: Low  
**Impact**: Medium (queries slow, writes lag)  
**Mitigation**:
- Phase 3 includes performance benchmarking
- Indexes tuned before Phase 4
- Query patterns validated against expected volume
- Monitoring alerts on latency regression

### Risk 3: Schema Evolution Complexity

**Probability**: Low  
**Impact**: Medium (adding fields breaks consistency)  
**Mitigation**:
- Schema designed for additive changes (new fields with defaults)
- Versioning strategy documented
- Migration scripts tested before execution
- Rollback includes data reconciliation

### Risk 4: Data Loss During Migration

**Probability**: Very Low  
**Impact**: Critical  
**Mitigation**:
- Migration script is idempotent (safe to re-run)
- Verification step checks all rows and content
- SQLite backup retained for recovery
- Dry-run migration on prod copy before live execution
- Checksum validation before/after

---

## Dependencies and Constraints

### External Dependencies
- **FeltDB library**: Embedded Rust library, no external services required
- **Bun runtime**: Already in use, compatible with FeltDB bindings

### Internal Dependencies
- **Session Service**: Must accept DurableStore (already planned interface)
- **Executor**: Must accept DurableStore for command ledger
- **Transcript Store**: Can be implemented on top of DurableStore
- **Run Journal**: Replaced by execution state in DurableStore

### Constraints
- **Local-first**: FeltDB must remain embedded, no network dependency
- **No secrets**: FeltDB stores no API keys, OAuth tokens, or provider secrets
- **Filesystem integration**: Git worktrees remain on filesystem (external references only)
- **Backward compatibility**: Phase 2-3 must not break existing sessions

---

## Monitoring and Observability

### Metrics to Track
- **Phase 2**: Regression test pass rate (100%)
- **Phase 3**: Consistency error rate (0%)
- **Phase 4**: Migration success rate (99%+)
- **Phase 4+**: Query latency, write throughput, crash recovery success

### Alerting
- Consistency errors trigger investigation
- Migration errors >1% pauses rollout
- Session access latency regression >20% triggers alert
- Recovery failures trigger operator intervention

### Observability
- Detailed error logs for each phase
- Migration progress dashboard
- Consistency report (before/after row counts)
- Performance comparison (SQLite vs FeltDB)

---

## Review Criteria

This ADR is ready for implementation when:

1. **Assessment complete**: All three docs (assessment, data model, migration plan) reviewed
2. **Team consensus**: Stakeholders agree on approach and timeline
3. **Risk assessment**: Identified risks are understood and mitigated
4. **Test strategy**: Testing plan covers all phases
5. **Rollback plan**: Rollback procedures documented and tested
6. **Monitoring**: Alerting and dashboards designed
7. **Communication**: Stakeholder communication plan documented

---

## Related Decisions

None currently, but this ADR informs:
- Storage abstraction design (to be detailed in Phase 2 code review)
- Testing strategy for persistence layer
- Deployment and rollout procedures
- Monitoring and alerting configuration

---

## Appendix: FeltDB Feature Validation

### Required Capabilities

| Capability | FeltDB Support | Evidence |
|---|---|---|
| Embedded operation | ✓ | Rust library, in-process |
| ACID transactions | ✓ | Documented in FeltDB specification |
| Append-only collections | ✓ | Native collection type |
| Indexed queries | ✓ | Query engine with indexes |
| Crash recovery | ✓ | Durable write-through semantics |
| Deduplication | ✓ | Document IDs + uniqueness constraints |
| Multi-machine (future) | ✗ | The file runtime takes no cross-process write lock and publishes by whole-snapshot rename; concurrent writers lose data (`FileJsDb.freshness()`) |

### Not Required (Won't Use)

| Feature | Reason | Alternative |
|---|---|---|
| Remote network access | Local-first design | Embedded only |
| Automatic sharding | Single-machine volume is manageable | Per-session partition is sufficient |
| GraphQL/REST APIs | Bun process owns queries | Direct client library access |
| Advanced access control | Single operator model | OS-level file permissions |

---

End of ADR
