import { createHash } from "node:crypto";
import type { AtomicTransactionOperationRequest, StateFirstDB } from "@feltdb/core";
import type { TranscriptEntry } from "../types";
import { classifyEntry, dropContextInjections } from "@tellahq/opensession-protocol/notices";
import type { TranscriptIndexEntry, TranscriptIndexRole } from "@tellahq/opensession-protocol/session";
import type {
  AppendResult,
  DestinationTranscriptAppendResult,
  SeqEntry,
  TranscriptImportInfo,
  TranscriptPage,
  TranscriptHydratedPage,
  TranscriptOutline,
  TranscriptRangePage,
} from "../transcript-store";
import { handoffTranscriptEntryWeight, TranscriptAppendConflictError } from "../transcript-store";
import { v2SnapshotEntryWeight } from "../transcript-wire";
import type {
  TranscriptActorRequest,
  TranscriptMutationResult,
  TranscriptWake,
} from "./transcript-protocol";
import {
  FeltDbSessionDecisionStore,
  KERNEL_COLLECTIONS,
  kernelRecordId,
} from "./feltdb-decision-store";

type LegacyMutation = Exclude<
  Extract<TranscriptActorRequest, { requestId: string }>,
  { op: "agent_append_destination" }
>;

type TranscriptHead = {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  transcriptEpoch: number;
  nextSeq: number;
  nextChangeSeq: number;
  resetChangeSeq: number;
  lastTs: number | null;
  importedAt?: number;
  importSrc?: string;
  importWatermark?: number;
  wake: TranscriptWake;
};
type StoredTranscriptHead = TranscriptHead & { __version: number };
type TranscriptEvent = {
  schemaVersion: 1;
  sessionId: string;
  decisionEpoch: number;
  transcriptEpoch: number;
  seq: number;
  changeSeq: number;
  entryId: string;
  ts: number;
  entry: TranscriptEntry;
};
type StoredTranscriptEvent = TranscriptEvent & { __version: number };
type TranscriptReceipt = {
  schemaVersion: 1;
  sessionId: string;
  requestId: string;
  requestHash: string;
  result: TranscriptMutationResult<unknown>;
  committedAt: number;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function eventId(sessionId: string, decisionEpoch: number, transcriptEpoch: number, entryId: string) {
  return kernelRecordId("transcript_event", `${sessionId}:${decisionEpoch}:${transcriptEpoch}:${entryId}`);
}

function receiptId(sessionId: string, requestId: string) {
  return kernelRecordId("transcript_receipt", `${sessionId}:${requestId}`);
}

function initialHead(sessionId: string, decisionEpoch: number): TranscriptHead {
  return {
    schemaVersion: 1,
    sessionId,
    decisionEpoch,
    transcriptEpoch: 1,
    nextSeq: 1,
    nextChangeSeq: 1,
    resetChangeSeq: 0,
    lastTs: null,
    wake: {
      cursor: 0,
      ackedCursor: 0,
      firstChangeSeq: 0,
      lastChangeSeq: 0,
      resetEpoch: 0,
      ackedResetEpoch: 0,
    },
  };
}

function entryTs(entry: TranscriptEntry, now: number): number {
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : now;
}

/** Remote managed FeltDB transcript sequence, reset, wake, and replay authority. */
export class FeltDbTranscriptStore {
  private readonly db: StateFirstDB;

  constructor(private readonly decisions: FeltDbSessionDecisionStore) {
    this.db = decisions.runtime();
  }

  private async head(sessionId: string): Promise<StoredTranscriptHead | undefined> {
    return (await this.db.collection<StoredTranscriptHead>(KERNEL_COLLECTIONS.transcriptHeads)
      .get(sessionId)) ?? undefined;
  }

  async applyMutation(
    request: LegacyMutation,
    now = Date.now(),
  ): Promise<TranscriptMutationResult<unknown>> {
    const requestHash = digest(request);
    const priorReceipt = await this.db.collection<TranscriptReceipt>(
      KERNEL_COLLECTIONS.transcriptReceipts,
    ).get(receiptId(request.sessionId, request.requestId));
    if (priorReceipt) {
      if (priorReceipt.requestHash !== requestHash)
        throw new TranscriptAppendConflictError(request.sessionId, request.requestId);
      return { ...priorReceipt.result, replay: true };
    }
    const [authority, storedHead] = await Promise.all([
      this.decisions.head(request.sessionId),
      this.head(request.sessionId),
    ]);
    if (!authority || authority.authority.lifecycle !== "active")
      throw new Error(`Session ${request.sessionId} was deleted`);
    const prior = storedHead?.decisionEpoch === authority.decisionEpoch
      ? storedHead
      : initialHead(request.sessionId, authority.decisionEpoch);
    if (request.expectedEpoch !== undefined && request.expectedEpoch !== prior.resetChangeSeq)
      throw new Error(
        `Transcript epoch fence rejected ${request.sessionId}: expected ${request.expectedEpoch}, current ${prior.resetChangeSeq}`,
      );

    const replacing = request.op === "replace" || request.op === "delete";
    const transcriptEpoch = replacing ? prior.transcriptEpoch + 1 : prior.transcriptEpoch;
    let nextSeq = replacing ? 1 : prior.nextSeq;
    let nextChangeSeq = replacing ? prior.nextChangeSeq + 1 : prior.nextChangeSeq;
    const beforeChangeSeq = prior.nextChangeSeq - 1;
    const entries = request.op === "delete" ? [] : request.entries;
    const ids = entries.map((entry) => eventId(
      request.sessionId, authority.decisionEpoch, transcriptEpoch, entry.id,
    ));
    const existing = replacing ? [] : await Promise.all(ids.map((id) =>
      this.db.collection<StoredTranscriptEvent>(KERNEL_COLLECTIONS.transcriptEvents).get(id)));
    const operations: AtomicTransactionOperationRequest[] = [];
    const affected: SeqEntry[] = [];
    let inserted = 0;
    let updated = 0;
    let lastTs = replacing ? null : prior.lastTs;
    for (let index = 0; index < entries.length; index++) {
      const entry = structuredClone(entries[index]);
      const previous = existing[index];
      const seq = previous?.seq ?? nextSeq++;
      const changeSeq = nextChangeSeq++;
      const ts = entryTs(entry, now);
      lastTs = ts;
      previous ? updated++ : inserted++;
      const value: TranscriptEvent = {
        schemaVersion: 1,
        sessionId: request.sessionId,
        decisionEpoch: authority.decisionEpoch,
        transcriptEpoch,
        seq,
        changeSeq,
        entryId: entry.id,
        ts,
        entry,
      };
      operations.push({
        collection: KERNEL_COLLECTIONS.transcriptEvents,
        id: ids[index],
        value,
        ...(previous ? { ifVersion: previous.__version } : { requireAbsent: true }),
      });
      affected.push({ ...entry, seq, changeSeq });
    }
    const resetChangeSeq = replacing ? prior.nextChangeSeq : prior.resetChangeSeq;
    const lastChangeSeq = nextChangeSeq - 1;
    const wakeCursor = prior.wake.cursor + 1;
    const wake: TranscriptWake = {
      ...prior.wake,
      cursor: wakeCursor,
      firstChangeSeq: prior.wake.cursor > prior.wake.ackedCursor
        ? prior.wake.firstChangeSeq
        : Math.min(lastChangeSeq, beforeChangeSeq + 1),
      lastChangeSeq,
      resetEpoch: prior.wake.cursor > prior.wake.ackedCursor
        ? Math.max(prior.wake.resetEpoch, request.op === "delete" ? resetChangeSeq : resetChangeSeq)
        : resetChangeSeq,
    };
    const next: TranscriptHead = {
      schemaVersion: 1,
      sessionId: request.sessionId,
      decisionEpoch: authority.decisionEpoch,
      transcriptEpoch,
      nextSeq,
      nextChangeSeq,
      resetChangeSeq,
      lastTs,
      ...(request.op === "import" && request.final !== false
        ? { importedAt: now, importSrc: request.src, importWatermark: request.watermark ?? undefined }
        : request.op === "append" || request.op === "append_destination"
          ? {
              importedAt: prior.importedAt ?? now,
              importSrc: prior.importSrc ?? "live-only",
              ...(prior.importWatermark === undefined ? {} : { importWatermark: prior.importWatermark }),
            }
          : {}),
      wake,
    };
    const base: AppendResult | null = affected.length ? {
      firstSeq: Math.min(...affected.map((entry) => entry.seq)),
      lastSeq: Math.max(...affected.map((entry) => entry.seq)),
      inserted,
      updated,
    } : null;
    const mutationValue: unknown = request.op === "append"
      ? base
      : request.op === "append_destination"
        ? {
            ...(base ?? { firstSeq: 0, lastSeq: 0, inserted: 0, updated: 0 }),
            changes: affected.map((entry) => ({
              entryId: entry.id, seq: entry.seq, changeSeq: entry.changeSeq,
            })),
          } satisfies DestinationTranscriptAppendResult
        : request.op === "delete"
          ? null
          : { inserted, updated };
    const result: TranscriptMutationResult<unknown> = {
      result: mutationValue,
      wakeCursor,
      replay: false,
    };
    await this.db.transaction({
      transactionId: `opensession:transcript:${request.sessionId}:${request.requestId}`,
      preconditions: [
        { collection: KERNEL_COLLECTIONS.sessions, id: request.sessionId, ifVersion: authority.__version },
        { collection: KERNEL_COLLECTIONS.transcriptReceipts, id: receiptId(request.sessionId, request.requestId), requireAbsent: true },
      ],
      operations: [
        ...operations,
        {
          collection: KERNEL_COLLECTIONS.transcriptHeads,
          id: request.sessionId,
          value: next,
          ...(storedHead ? { ifVersion: storedHead.__version } : { requireAbsent: true }),
        },
        {
          collection: KERNEL_COLLECTIONS.transcriptReceipts,
          id: receiptId(request.sessionId, request.requestId),
          value: {
            schemaVersion: 1,
            sessionId: request.sessionId,
            requestId: request.requestId,
            requestHash,
            result,
            committedAt: now,
          } satisfies TranscriptReceipt,
          requireAbsent: true,
        },
      ],
    });
    return result;
  }

  async importInfo(sessionId: string): Promise<TranscriptImportInfo | null> {
    const [authority, head] = await Promise.all([
      this.decisions.head(sessionId),
      this.head(sessionId),
    ]);
    if (!authority || head?.decisionEpoch !== authority.decisionEpoch || !head.importedAt || !head.importSrc)
      return null;
    return {
      importedAt: head.importedAt,
      src: head.importSrc,
      watermark: head.importWatermark ?? null,
    };
  }

  private async activeHead(sessionId: string): Promise<StoredTranscriptHead | undefined> {
    const [authority, head] = await Promise.all([
      this.decisions.head(sessionId),
      this.head(sessionId),
    ]);
    return authority && head?.decisionEpoch === authority.decisionEpoch ? head : undefined;
  }

  private async page(input: {
    sessionId: string;
    where?: Array<{ field: string; gt?: number; lt?: number }>;
    direction?: "asc" | "desc";
    orderField?: "seq" | "changeSeq";
    limit: number;
  }): Promise<TranscriptPage> {
    const head = await this.activeHead(input.sessionId);
    if (!head || input.limit <= 0) return { entries: [], firstSeq: 0, lastSeq: 0 };
    const result = await this.db.query<StoredTranscriptEvent>({
      collection: KERNEL_COLLECTIONS.transcriptEvents,
      where: [
        { field: "sessionId", eq: input.sessionId },
        { field: "decisionEpoch", eq: head.decisionEpoch },
        { field: "transcriptEpoch", eq: head.transcriptEpoch },
        ...(input.where ?? []),
      ],
      orderBy: [{ field: input.orderField ?? "seq", direction: input.direction ?? "asc" }],
      limit: Math.min(500, Math.max(1, Math.floor(input.limit))),
    });
    const rows = input.direction === "desc" ? [...result.records].reverse() : result.records;
    const entries = rows.map((row) => ({ ...row.entry, seq: row.seq, changeSeq: row.changeSeq }));
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries.at(-1)?.seq ?? 0,
    };
  }

  readTail(sessionId: string, limit = 50): Promise<TranscriptPage> {
    return this.page({ sessionId, direction: "desc", limit });
  }

  readSince(sessionId: string, sinceSeq: number, limit = 200): Promise<TranscriptPage> {
    return this.page({ sessionId, where: [{ field: "seq", gt: sinceSeq }], limit });
  }

  readChangesSince(sessionId: string, changeSeq: number, limit = 200): Promise<TranscriptPage> {
    return this.page({
      sessionId,
      where: [{ field: "changeSeq", gt: changeSeq }],
      orderField: "changeSeq",
      limit,
    });
  }

  readBefore(sessionId: string, beforeSeq: number, limit = 40): Promise<TranscriptPage> {
    return this.page({
      sessionId,
      where: [{ field: "seq", lt: beforeSeq }],
      direction: "desc",
      limit,
    });
  }

  async lastSeq(sessionId: string): Promise<number> {
    return Math.max(0, (await this.activeHead(sessionId))?.nextSeq ?? 1) - 1;
  }

  async lastChangeSeq(sessionId: string): Promise<number> {
    return Math.max(0, (await this.activeHead(sessionId))?.nextChangeSeq ?? 1) - 1;
  }

  async lastResetChangeSeq(sessionId: string): Promise<number> {
    return (await this.activeHead(sessionId))?.resetChangeSeq ?? 0;
  }

  async summary(sessionId: string): Promise<{ lastTs: number | null; seqHighWater: number } | null> {
    const head = await this.activeHead(sessionId);
    return head ? { lastTs: head.lastTs, seqHighWater: head.nextSeq - 1 } : null;
  }

  async pendingWake(sessionId: string): Promise<TranscriptWake | null> {
    const head = await this.activeHead(sessionId);
    return head && head.wake.cursor > head.wake.ackedCursor ? head.wake : null;
  }

  async acknowledgeWake(sessionId: string, cursor: number): Promise<boolean> {
    const [authority, head] = await Promise.all([
      this.decisions.head(sessionId),
      this.head(sessionId),
    ]);
    if (!authority || !head || head.decisionEpoch !== authority.decisionEpoch) return false;
    if (cursor > head.wake.cursor) return false;
    if (cursor <= head.wake.ackedCursor) return true;
    const next: TranscriptHead = {
      ...head,
      wake: {
        ...head.wake,
        ackedCursor: cursor,
        ackedResetEpoch: cursor === head.wake.cursor
          ? head.wake.resetEpoch
          : head.wake.ackedResetEpoch,
      },
    };
    delete (next as Partial<StoredTranscriptHead>).__version;
    await this.db.transaction({
      transactionId: `opensession:transcript:wake_ack:${sessionId}:${cursor}`,
      preconditions: [{
        collection: KERNEL_COLLECTIONS.sessions,
        id: sessionId,
        ifVersion: authority.__version,
      }],
      operations: [{
        collection: KERNEL_COLLECTIONS.transcriptHeads,
        id: sessionId,
        value: next,
        ifVersion: head.__version,
      }],
    });
    return true;
  }

  async fullEntry(sessionId: string, entryId: string): Promise<TranscriptEntry | null> {
    const head = await this.activeHead(sessionId);
    if (!head) return null;
    const event = await this.db.collection<StoredTranscriptEvent>(
      KERNEL_COLLECTIONS.transcriptEvents,
    ).get(eventId(sessionId, head.decisionEpoch, head.transcriptEpoch, entryId));
    return event?.entry ? structuredClone(event.entry) : null;
  }

  async readRange(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
    afterSeq = fromSeq - 1,
    limit = 200,
  ): Promise<TranscriptRangePage> {
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
    const page = await this.page({
      sessionId,
      where: [
        { field: "seq", gt: Math.max(afterSeq, fromSeq - 1) },
        { field: "seq", lt: toSeq + 1 },
      ],
      limit: bounded + 1,
    });
    const complete = page.entries.length <= bounded;
    const entries = complete ? page.entries : page.entries.slice(0, bounded);
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries.at(-1)?.seq ?? 0,
      coveredThroughSeq: entries.at(-1)?.seq ?? Math.max(afterSeq, fromSeq - 1),
      complete,
    };
  }

  async readHydratedSince(
    sessionId: string,
    sinceSeq: number,
    limit = 100,
    maxBytes = 12 * 1024 * 1024,
  ): Promise<TranscriptHydratedPage> {
    const page = await this.readSince(sessionId, sinceSeq, Math.min(500, limit + 1));
    const candidates = page.entries.slice(0, limit);
    const entries: SeqEntry[] = [];
    let bytes = 0;
    let coveredThroughSeq = sinceSeq;
    let complete = page.entries.length <= limit;
    for (const entry of candidates) {
      const cost = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length > 0 && bytes + cost > maxBytes) {
        complete = false;
        break;
      }
      entries.push(entry);
      bytes += cost;
      coveredThroughSeq = entry.seq;
    }
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries.at(-1)?.seq ?? 0,
      coveredThroughSeq,
      complete,
    };
  }

  async outline(sessionId: string, afterSeq = 0, limit = 2_000): Promise<TranscriptOutline> {
    const [head, page] = await Promise.all([
      this.activeHead(sessionId),
      this.readSince(sessionId, afterSeq, Math.min(500, limit)),
    ]);
    const entries: TranscriptIndexEntry[] = page.entries.map((entry) => {
      let role: TranscriptIndexRole;
      let reviewPrNumber: number | undefined;
      if (dropContextInjections([entry]).length === 0) role = "hidden";
      else {
        const classified = classifyEntry(entry);
        if (classified.notice?.kind === "review-handoff") {
          role = "review_handoff";
          const match = classified.notice.title.match(/PR #(\d+)/);
          if (match) reviewPrNumber = Number(match[1]);
        } else if (classified.notice) role = "notice";
        else if (["user", "assistant", "tool_use", "tool_result"].includes(classified.type))
          role = classified.type as TranscriptIndexRole;
        else role = "system";
      }
      return {
        id: entry.id,
        seq: entry.seq,
        changeSeq: entry.changeSeq,
        timestampMs: entryTs(entry, 0),
        role,
        contentLength: entry.contentLength ?? entry.content?.length ?? 0,
        ...(reviewPrNumber === undefined ? {} : { reviewPrNumber }),
      };
    });
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries.at(-1)?.seq ?? 0,
      lastChangeSeq: Math.max(0, (head?.nextChangeSeq ?? 1) - 1),
      epoch: head?.resetChangeSeq ?? 0,
    };
  }

  async readTailWindow(
    sessionId: string,
    options: Extract<TranscriptActorRequest, { op: "tail_window" }>["options"],
  ): Promise<TranscriptPage> {
    const maxEntries = Math.min(500, Math.max(1, Math.floor(options.maxEntries)));
    const probe = await this.readTail(sessionId, maxEntries);
    const newest = [...probe.entries].reverse();
    const minEntries = Math.max(1, Math.min(Math.floor(options.minEntries), maxEntries));
    const minMessages = Math.max(0, Math.floor(options.minMessages));
    const minUsers = Math.max(0, Math.floor(options.minUserMessagesWithToolWork ?? 0));
    const weigh = options.weightProfile === "v2_snapshot"
      ? v2SnapshotEntryWeight
      : options.weightProfile === "handoff"
        ? handoffTranscriptEntryWeight
        : (_kind: string, bytes: number) => bytes;
    let count = 0;
    let estimatedBytes = 0;
    let messages = 0;
    let users = 0;
    let tools = 0;
    for (const entry of newest) {
      if (count >= minEntries && messages >= minMessages && (tools === 0 || users >= minUsers))
        break;
      const kind = entry.type ?? "unknown";
      const cost = weigh(kind, Buffer.byteLength(JSON.stringify(entry)));
      if (count >= minEntries && estimatedBytes + cost > options.maxEstimatedBytes) break;
      count++;
      estimatedBytes += cost;
      if (kind === "user" || kind === "assistant") messages++;
      if (kind === "user") users++;
      if (kind === "tool_use" || kind === "tool_result") tools++;
    }
    return {
      entries: newest.slice(0, count).reverse(),
      firstSeq: newest[count - 1]?.seq ?? 0,
      lastSeq: newest[0]?.seq ?? 0,
    };
  }

  async applyRequest(request: Exclude<
    TranscriptActorRequest,
    { op: "agent_append_destination" | "agent_query_destination_receipt" | "agent_validate_destination_receipt" }
  >): Promise<unknown> {
    if ("requestId" in request) return this.applyMutation(request);
    if (request.op === "needs_import") return !(await this.importInfo(request.sessionId));
    if (request.op === "import_info") return this.importInfo(request.sessionId);
    if (request.op === "tail") return this.readTail(request.sessionId, request.limit ?? 50);
    if (request.op === "tail_window")
      return this.readTailWindow(request.sessionId, request.options);
    if (request.op === "since")
      return this.readSince(request.sessionId, request.sinceSeq, request.limit ?? 200);
    if (request.op === "changes_since")
      return this.readChangesSince(request.sessionId, request.changeSeq, request.limit ?? 200);
    if (request.op === "hydrated_since")
      return this.readHydratedSince(
        request.sessionId,
        request.sinceSeq,
        request.limit ?? 100,
        request.maxBytes,
      );
    if (request.op === "before")
      return this.readBefore(request.sessionId, request.beforeSeq, request.limit ?? 40);
    if (request.op === "range")
      return this.readRange(
        request.sessionId,
        request.fromSeq,
        request.toSeq,
        request.afterSeq ?? request.fromSeq - 1,
        request.limit ?? 200,
      );
    if (request.op === "outline")
      return this.outline(request.sessionId, request.afterSeq ?? 0, request.limit ?? 2_000);
    if (request.op === "full_entry") return this.fullEntry(request.sessionId, request.entryId);
    if (request.op === "last_seq") return this.lastSeq(request.sessionId);
    if (request.op === "last_change_seq") return this.lastChangeSeq(request.sessionId);
    if (request.op === "last_reset_change_seq") return this.lastResetChangeSeq(request.sessionId);
    if (request.op === "count") return this.lastSeq(request.sessionId);
    if (request.op === "summary") return this.summary(request.sessionId);
    if (request.op === "pending_wake") return this.pendingWake(request.sessionId);
    return this.acknowledgeWake(request.sessionId, request.cursor);
  }
}
