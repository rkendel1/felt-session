# Phase 2 Implementation - Code Changes

## Key Modifications to run-journal.ts

### 1. Added FeltDB Imports
```typescript
import { openRunRecordStore } from "./run-record-store";
import type { RunRecordStore } from "./run-record-store";
```

### 2. Added Global State for FeltDB
```typescript
let store: RunRecordStore | null = null;
const enableFeltDB = process.env.ENABLE_FELTDB_RUN_RECORDS === "true";
let feltDBInitialized = false;
```

### 3. Added Initialization and Cleanup Functions
```typescript
async function initializeFeltDBStore(): Promise<void> {
  if (feltDBInitialized) return;
  if (!enableFeltDB) {
    feltDBInitialized = true;
    return;
  }
  
  try {
    const feltDBPath = ACTIVE_RUNS_PATH.replace(/\.json$/, ".feltdb");
    store = openRunRecordStore(feltDBPath);
    feltDBInitialized = true;
  } catch (e) {
    console.error("[runner] Failed to initialize FeltDB store, falling back to JSON:", e);
    feltDBInitialized = true;
  }
}

export async function closeRunRecordStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
  }
}
```

### 4. Added Async Read/Write Functions
```typescript
async function readRunJournalAsync(): Promise<Record<string, ActiveRunRecord>> {
  if (!enableFeltDB) {
    return readRunJournal();
  }

  await initializeFeltDBStore();
  if (!store) {
    return readRunJournal();
  }

  try {
    const runs = await store.getAllRuns();
    const journal: Record<string, ActiveRunRecord> = {};
    for (const run of runs) {
      journal[run.runKey] = run;
    }
    syncActiveRunAliases(journal);
    return journal;
  } catch (e) {
    console.error("[runner] Failed to read from FeltDB, falling back to JSON:", e);
    return readRunJournal();
  }
}

async function writeRunJournalAsync(journal: Record<string, ActiveRunRecord>): Promise<void> {
  writeRunJournal(journal);

  if (!enableFeltDB) {
    return;
  }

  await initializeFeltDBStore();
  if (!store) {
    return;
  }

  try {
    for (const run of Object.values(journal)) {
      await store.recordRun(run);
    }
  } catch (e) {
    console.error("[runner] Failed to write to FeltDB:", e);
  }
}
```

### 5. Updated Async Functions to Use New Backend Functions
```typescript
// journalSet now uses async backends
export async function journalSet(
  record: ActiveRunRecord,
  transition: JournalRunStateTransition = transitionRunState,
): Promise<void> {
  const journal = await readRunJournalAsync();
  const prior = journal[record.runKey];
  const rejournal = !!prior;
  journal[record.runKey] = {
    ...record,
    firstJournaledAt:
      prior?.firstJournaledAt || record.firstJournaledAt || prior?.startedAt || record.startedAt,
    resumeAttempts: prior ? prior.resumeAttempts : record.resumeAttempts,
    lastResumeAt: prior ? prior.lastResumeAt : record.lastResumeAt,
  };
  await writeRunJournalAsync(journal);
  // ... rest of function
}

// journalQuarantine now async and handles FeltDB
export async function journalQuarantine(entries: QuarantinedRun[]): Promise<void> {
  if (!entries.length) return;
  const journal = await readRunJournalAsync();
  // ... process entries ...
  await writeRunJournalAsync(journal);
  
  // Delete from FeltDB if enabled
  if (enableFeltDB && store) {
    for (const runKey of runsToDelete) {
      try {
        await store.clearRun(runKey);
      } catch (e) {
        console.error(`[runner] Failed to delete quarantined run ${runKey} from FeltDB:`, e);
      }
    }
  }
}

// takeInterruptedRuns now uses async backends
export async function takeInterruptedRuns(
  seedRecords: ActiveRunRecord[] = [],
  shouldTake: (record: ActiveRunRecord) => boolean | Promise<boolean> = () => true,
  transition: JournalRunStateTransition = transitionRunState,
): Promise<ActiveRunRecord[]> {
  const journal = await readRunJournalAsync();
  // ... process entries ...
  await writeRunJournalAsync(journal);
  
  // Claim runs in FeltDB if enabled
  if (enableFeltDB && store) {
    for (const r of entries) {
      try {
        await store.claimRun(r.runKey, now);
      } catch (e) {
        console.error(`[runner] Failed to claim run ${r.runKey} in FeltDB:`, e);
      }
    }
  }
}
```

### 6. Added New Async Functions for Gradual Migration
```typescript
export async function journalClearAsync(runKey: string): Promise<void> {
  const journal = await readRunJournalAsync();
  if (runKey in journal) {
    delete journal[runKey];
    await writeRunJournalAsync(journal);
    
    if (enableFeltDB && store) {
      try {
        await store.clearRun(runKey);
      } catch (e) {
        console.error(`[runner] Failed to clear run ${runKey} from FeltDB:`, e);
      }
    }
  }
}

export async function journalClearIfLineageAsync(record: ActiveRunRecord): Promise<boolean> {
  const journal = await readRunJournalAsync();
  const current = journal[record.runKey];
  if (!current) return false;
  const expectedLineage = record.firstJournaledAt || record.startedAt;
  const currentLineage = current.firstJournaledAt || current.startedAt;
  if (
    expectedLineage !== currentLineage ||
    current.osSessionId !== record.osSessionId
  ) {
    return false;
  }
  delete journal[record.runKey];
  await writeRunJournalAsync(journal);
  
  if (enableFeltDB && store) {
    try {
      await store.clearRunIfLineage(record);
    } catch (e) {
      console.error(`[runner] Failed to clear lineage ${record.runKey} from FeltDB:`, e);
    }
  }
  
  return true;
}

export async function journalStartRecoveryAsync(record: ActiveRunRecord): Promise<ActiveRunRecord> {
  const journal = await readRunJournalAsync();
  // ... build prepared record ...
  await writeRunJournalAsync(journal);
  // ...
}

export async function journalMarkRecoveryAttachedAsync(record: ActiveRunRecord): Promise<ActiveRunRecord | undefined> {
  const journal = await readRunJournalAsync();
  // ... update attachment ...
  await writeRunJournalAsync(journal);
  // ...
}

export async function activeRunRecordsAsync(): Promise<ActiveRunRecord[]> {
  const journal = await readRunJournalAsync();
  return Object.values(journal);
}
```

### 7. Preserved Synchronous Functions for Backward Compatibility
- `journalClear(runKey)` - remains synchronous
- `journalClearIfLineage(record)` - remains synchronous
- `journalStartRecovery(record)` - remains synchronous
- `journalMarkRecoveryAttached(record)` - remains synchronous
- `activeRunRecords()` - remains synchronous
- `hasActiveRunFor(...ids)` - remains synchronous hot-path check

## API Summary

### New Exports (Phase 2)
- `closeRunRecordStore(): Promise<void>` - Graceful shutdown
- `journalClearAsync(runKey): Promise<void>` - Async clear
- `journalClearIfLineageAsync(record): Promise<boolean>` - Async lineage clear
- `journalStartRecoveryAsync(record): Promise<ActiveRunRecord>` - Async recovery start
- `journalMarkRecoveryAttachedAsync(record): Promise<ActiveRunRecord | undefined>` - Async recovery attach
- `activeRunRecordsAsync(): Promise<ActiveRunRecord[]>` - Async snapshot

### Updated Functions (Now Support FeltDB)
- `journalSet()` - Uses `readRunJournalAsync()` and `writeRunJournalAsync()`
- `journalQuarantine()` - Now async, deletes from FeltDB
- `takeInterruptedRuns()` - Now uses async backends, claims in FeltDB

### Unchanged Functions (Backward Compatible)
- `journalClear()` - JSON-only, synchronous
- `journalClearIfLineage()` - JSON-only, synchronous
- `journalStartRecovery()` - JSON-only, synchronous
- `journalMarkRecoveryAttached()` - JSON-only, synchronous
- `activeRunRecords()` - JSON-only, synchronous
- `hasActiveRunFor()` - Cache-based, synchronous

## Enabling FeltDB

Set environment variable before starting:
```bash
export ENABLE_FELTDB_RUN_RECORDS=true
```

When enabled:
- FeltDB is initialized lazily on first async operation
- Async functions use FeltDB backend
- JSON backend remains as fallback
- All synchronous functions continue working with JSON

When disabled (default):
- All functions work with JSON backend
- No FeltDB initialization
- Full backward compatibility
