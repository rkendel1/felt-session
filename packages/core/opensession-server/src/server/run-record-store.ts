import type { StateFirstDB } from "@feltdb/core";
import type { ActiveRunRecord, QuarantinedRun, RunQuarantineReason } from "./run-journal";

const RUNS_COLLECTION = "opensession_active_runs";
const QUARANTINE_COLLECTION = "opensession_run_quarantine";

type StoredRunRecord = ActiveRunRecord & { id: string; __version?: number };

export interface StoredQuarantinedRun extends ActiveRunRecord {
  id: string;
  quarantinedAt: string;
  quarantineReason: RunQuarantineReason;
}

export interface RunRecordStore {
  recordRun(record: ActiveRunRecord): Promise<ActiveRunRecord>;
  getAllRuns(): Promise<ActiveRunRecord[]>;
  getRun(runKey: string): Promise<ActiveRunRecord | null>;
  claimRuns(records: ActiveRunRecord[], claimedAt: string): Promise<void>;
  clearRun(runKey: string): Promise<boolean>;
  clearRunIfLineage(record: ActiveRunRecord): Promise<boolean>;
  quarantine(entries: QuarantinedRun[]): Promise<void>;
  getQuarantinedRuns(): Promise<StoredQuarantinedRun[]>;
}

function decode(row: StoredRunRecord): ActiveRunRecord {
  const { id: _id, __version: _version, ...record } = row;
  return record;
}

function sameLineage(left: ActiveRunRecord, right: ActiveRunRecord): boolean {
  return (left.firstJournaledAt || left.startedAt) ===
    (right.firstJournaledAt || right.startedAt) && left.osSessionId === right.osSessionId;
}

/** Managed FeltDB authority for active-run recovery metadata. */
export function openRunRecordStore(db: StateFirstDB): RunRecordStore {
  const runs = db.collection<StoredRunRecord>(RUNS_COLLECTION);
  return {
    async recordRun(record) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await runs.get(record.runKey);
        try {
          await db.transaction((tx) => {
            tx.collection<StoredRunRecord>(RUNS_COLLECTION).set(record.runKey,
              { ...record, id: record.runKey }, current
                ? { ifVersion: current.__version }
                : { requireAbsent: true });
          }, { transactionId: `opensession:run-journal:set:${record.runKey}:${crypto.randomUUID()}` });
          const saved = await runs.get(record.runKey);
          if (!saved) throw new Error(`Run journal record ${record.runKey} disappeared after save`);
          return decode(saved);
        } catch (error) {
          if (attempt === 4) throw error;
        }
      }
      throw new Error(`Failed to save run journal record ${record.runKey}`);
    },

    async getAllRuns() {
      return (await runs.all()).map(decode);
    },

    async getRun(runKey) {
      const row = await runs.get(runKey);
      return row ? decode(row) : null;
    },

    async claimRuns(records, claimedAt) {
      if (!records.length) return;
      const current = (await Promise.all(records.map((record) => runs.get(record.runKey))))
        .filter((row): row is StoredRunRecord => !!row);
      await db.transaction((tx) => {
        for (const row of current) tx.collection<StoredRunRecord>(RUNS_COLLECTION).set(row.runKey,
          { ...row, claimedAt }, { ifVersion: row.__version });
      }, { transactionId: `opensession:run-journal:claim:${crypto.randomUUID()}` });
    },

    async clearRun(runKey) {
      const current = await runs.get(runKey);
      if (!current) return false;
      try {
        await db.transaction((tx) => { tx.collection<StoredRunRecord>(RUNS_COLLECTION)
          .delete(runKey, { ifVersion: current.__version }); },
        { transactionId: `opensession:run-journal:clear:${runKey}:${crypto.randomUUID()}` });
        return true;
      } catch {
        return !(await runs.get(runKey));
      }
    },

    async clearRunIfLineage(record) {
      const current = await runs.get(record.runKey);
      if (!current || !sameLineage(current, record)) return false;
      await db.transaction((tx) => { tx.collection<StoredRunRecord>(RUNS_COLLECTION)
        .delete(record.runKey, { ifVersion: current.__version }); },
      { transactionId: `opensession:run-journal:clear-lineage:${record.runKey}:${crypto.randomUUID()}` });
      return true;
    },

    async quarantine(entries) {
      if (!entries.length) return;
      const quarantinedAt = new Date().toISOString();
      const current = await Promise.all(entries.map((entry) => runs.get(entry.run.runKey)));
      await db.transaction((tx) => {
        entries.forEach((entry, index) => {
          const row = current[index];
          if (row && sameLineage(row, entry.run))
            tx.collection<StoredRunRecord>(RUNS_COLLECTION).delete(row.runKey, { ifVersion: row.__version });
          const id = crypto.randomUUID();
          tx.collection<StoredQuarantinedRun>(QUARANTINE_COLLECTION).set(id, {
            ...entry.run, id, quarantinedAt, quarantineReason: entry.reason,
          }, { requireAbsent: true });
        });
      }, { transactionId: `opensession:run-journal:quarantine:${crypto.randomUUID()}` });
    },

    async getQuarantinedRuns() {
      return await db.collection<StoredQuarantinedRun>(QUARANTINE_COLLECTION).all();
    },
  };
}
