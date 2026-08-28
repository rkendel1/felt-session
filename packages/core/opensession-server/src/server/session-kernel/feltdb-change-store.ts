import { createHash } from "node:crypto";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";

const RUN_STATES = "opensession_kernel_run_states";
const CHANGES = "opensession_kernel_changes";
const TRANSACTIONS = "opensession_kernel_transactions";

export type FeltDbKernelRunState = {
  sessionId: string;
  state: string;
  since: string;
  lastEvent?: string;
  generation: number;
  currentRunId?: string;
  changeSeq: number;
};

export type FeltDbKernelChange = {
  sessionId: string;
  changeSeq: number;
  kind: string;
  payload?: unknown;
  createdAt: number;
};

type VersionedRunState = FeltDbKernelRunState & { __version: number };
type AppendReceipt = {
  transactionId: string;
  sessionId: string;
  kind: string;
  changeSeq: number;
};

export type AppendChangeDecision = {
  transactionId: string;
  prior: FeltDbKernelRunState;
  expectedVersion?: number;
  change: FeltDbKernelChange;
};

function authorityId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
}

function initialRunState(sessionId: string): FeltDbKernelRunState {
  return {
    sessionId,
    state: "idle",
    since: new Date(0).toISOString(),
    generation: 0,
    changeSeq: 0,
  };
}

/**
 * FeltDB authority for the first migrated Session Kernel transaction.
 *
 * This store accepts only the remote/server runtime. It has no SQLite mirror
 * and no embedded FeltDB fallback, so a successful return means the authority
 * durably committed the run-state sequence, journal entry, and replay receipt.
 */
export class FeltDbKernelChangeStore {
  constructor(private readonly db: StateFirstDB) {
    const runtime = db.runtime();
    if (runtime.runtime !== "remote" || runtime.storage !== "remote") {
      throw new Error("Session Kernel FeltDB persistence requires a remote server authority");
    }
  }

  async runState(sessionId: string): Promise<FeltDbKernelRunState> {
    const value = await this.db.collection<VersionedRunState>(RUN_STATES).get(sessionId);
    if (!value) return initialRunState(sessionId);
    return {
      sessionId,
      state: value.state,
      since: value.since,
      lastEvent: value.lastEvent,
      generation: value.generation,
      currentRunId: value.currentRunId,
      changeSeq: value.changeSeq,
    };
  }

  async decideAppendChange(
    transactionId: string,
    sessionId: string,
    kind: string,
    payload?: unknown,
    now = Date.now(),
  ): Promise<AppendChangeDecision> {
    const stored = await this.db.collection<VersionedRunState>(RUN_STATES).get(sessionId);
    if (stored && !Number.isSafeInteger(stored.__version)) {
      throw new Error(`FeltDB run state ${sessionId} has no authority version`);
    }
    const prior = stored ? await this.runState(sessionId) : initialRunState(sessionId);
    return {
      transactionId,
      prior,
      expectedVersion: stored?.__version,
      change: {
        sessionId,
        changeSeq: prior.changeSeq + 1,
        kind,
        payload,
        createdAt: now,
      },
    };
  }

  async commitAppendChange(decision: AppendChangeDecision): Promise<number> {
    const receiptId = authorityId("tx", decision.transactionId);
    const existing = await this.db.collection<AppendReceipt>(TRANSACTIONS).get(receiptId);
    if (existing) return this.validateReplay(existing, decision);

    const changeId = authorityId(
      "change",
      `${decision.change.sessionId}:${decision.change.changeSeq}`,
    );
    const nextState: FeltDbKernelRunState = {
      ...decision.prior,
      since: decision.prior.since === new Date(0).toISOString()
        ? new Date(decision.change.createdAt).toISOString()
        : decision.prior.since,
      changeSeq: decision.change.changeSeq,
    };
    const stateGuard = decision.expectedVersion === undefined
      ? { requireAbsent: true as const }
      : { ifVersion: decision.expectedVersion };

    const result = await this.db.transaction({
      transactionId: decision.transactionId,
      preconditions: [{ collection: TRANSACTIONS, id: receiptId, requireAbsent: true }],
      operations: [
        { collection: RUN_STATES, id: decision.change.sessionId, value: nextState, ...stateGuard },
        { collection: CHANGES, id: changeId, value: decision.change, requireAbsent: true },
        {
          collection: TRANSACTIONS,
          id: receiptId,
          value: {
            transactionId: decision.transactionId,
            sessionId: decision.change.sessionId,
            kind: decision.change.kind,
            changeSeq: decision.change.changeSeq,
          },
          requireAbsent: true,
        },
      ],
    });
    if (result.duplicate) {
      const replay = await this.db.collection<AppendReceipt>(TRANSACTIONS).get(receiptId);
      if (!replay) throw new Error(`FeltDB replay receipt ${decision.transactionId} is missing`);
      return this.validateReplay(replay, decision);
    }
    return decision.change.changeSeq;
  }

  async appendChange(
    transactionId: string,
    sessionId: string,
    kind: string,
    payload?: unknown,
  ): Promise<number> {
    const receiptId = authorityId("tx", transactionId);
    const existing = await this.db.collection<AppendReceipt>(TRANSACTIONS).get(receiptId);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.kind !== kind)
        throw new Error(`FeltDB transaction ${transactionId} was reused for another change`);
      return existing.changeSeq;
    }
    return this.commitAppendChange(
      await this.decideAppendChange(transactionId, sessionId, kind, payload),
    );
  }

  async changesSince(
    sessionId: string,
    afterChangeSeq: number,
    limit = 500,
  ): Promise<FeltDbKernelChange[]> {
    const rows = await this.db.collection<FeltDbKernelChange>(CHANGES)
      .where((change) => change.sessionId === sessionId && change.changeSeq > afterChangeSeq)
      .all();
    return rows
      .sort((left, right) => left.changeSeq - right.changeSeq)
      .slice(0, limit);
  }

  private validateReplay(receipt: AppendReceipt, decision: AppendChangeDecision): number {
    if (
      receipt.transactionId !== decision.transactionId ||
      receipt.sessionId !== decision.change.sessionId ||
      receipt.kind !== decision.change.kind
    ) throw new Error(`FeltDB transaction ${decision.transactionId} was reused for another change`);
    return receipt.changeSeq;
  }
}

export function openFeltDbKernelChangeStore(
  env: Record<string, string | undefined> = process.env,
): FeltDbKernelChangeStore {
  const url = env.OPENSESSION_FELTDB_SERVER_URL?.trim().replace(/\/$/, "");
  const namespace = env.OPENSESSION_FELTDB_SERVER_NAMESPACE?.trim();
  if (!url) throw new Error("Session Kernel requires OPENSESSION_FELTDB_SERVER_URL");
  if (!namespace)
    throw new Error("Session Kernel requires OPENSESSION_FELTDB_SERVER_NAMESPACE");
  return new FeltDbKernelChangeStore(createFeltDB({
    namespace,
    server: {
      url,
      token: env.OPENSESSION_FELTDB_SERVER_TOKEN?.trim() ?? "",
    },
  }));
}
