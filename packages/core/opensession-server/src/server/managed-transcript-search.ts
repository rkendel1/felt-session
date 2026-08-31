import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";
import { KERNEL_COLLECTIONS } from "./session-kernel/feltdb-decision-store";
import { transcriptEntryMatchSnippet } from "./transcript-search";
import type { TranscriptEntry } from "./types";

export type ManagedTranscriptSearchExhaustion =
  | "sessions" | "rows" | "time" | "matches" | null;

export interface ManagedTranscriptSearchResult {
  matches: Array<{ id: string; snippet: string }>;
  searchedSessions: number;
  candidateRows: number;
  exhausted: ManagedTranscriptSearchExhaustion;
}

type SessionHead = {
  decisionEpoch: number;
  authority: { lifecycle: string };
};
type TranscriptHead = {
  decisionEpoch: number;
  transcriptEpoch: number;
};
type TranscriptEvent = {
  sessionId: string;
  decisionEpoch: number;
  transcriptEpoch: number;
  seq: number;
  entry: TranscriptEntry;
};

const MAX_SESSIONS = 250;
const MAX_ROWS = 6_000;
const MAX_MATCHES = 50;
const MAX_MS = 5_000;
const PAGE_ROWS = 200;

/** Bounded cross-session search over the managed transcript collection. */
export async function searchManagedTranscripts(
  query: string,
  sessionIds: string[],
  signal?: AbortSignal,
  db: StateFirstDB = managedFeltDb(),
  now: () => number = () => performance.now(),
  limits: Partial<{
    maxSessions: number;
    maxRows: number;
    maxMatches: number;
    maxMs: number;
  }> = {},
): Promise<ManagedTranscriptSearchResult> {
  const matches: ManagedTranscriptSearchResult["matches"] = [];
  let searchedSessions = 0;
  let candidateRows = 0;
  let exhausted: ManagedTranscriptSearchExhaustion = null;
  const term = query.trim();
  if (term.length < 2 || term.length > 1_000 || sessionIds.length === 0)
    return { matches, searchedSessions, candidateRows, exhausted };

  const startedAt = now();
  const maxSessions = Math.min(MAX_SESSIONS, Math.max(1, limits.maxSessions ?? MAX_SESSIONS));
  const maxRows = Math.min(MAX_ROWS, Math.max(1, limits.maxRows ?? MAX_ROWS));
  const maxMatches = Math.min(MAX_MATCHES, Math.max(1, limits.maxMatches ?? MAX_MATCHES));
  const maxMs = Math.min(MAX_MS, Math.max(1, limits.maxMs ?? MAX_MS));
  const ids = sessionIds.slice(0, maxSessions);
  sessionLoop: for (const sessionId of ids) {
    if (signal?.aborted || now() - startedAt >= maxMs) {
      exhausted = "time";
      break;
    }
    if (candidateRows >= maxRows) { exhausted = "rows"; break; }
    if (matches.length >= maxMatches) { exhausted = "matches"; break; }
    searchedSessions++;
    const [authority, transcriptHead] = await Promise.all([
      db.collection<SessionHead>(KERNEL_COLLECTIONS.sessions).get(sessionId),
      db.collection<TranscriptHead>(KERNEL_COLLECTIONS.transcriptHeads).get(sessionId),
    ]);
    if (
      !authority || authority.authority.lifecycle !== "active" ||
      !transcriptHead || transcriptHead.decisionEpoch !== authority.decisionEpoch
    ) continue;

    let beforeSeq = Number.MAX_SAFE_INTEGER;
    while (candidateRows < maxRows) {
      if (signal?.aborted || now() - startedAt >= maxMs) {
        exhausted = "time";
        break sessionLoop;
      }
      const limit = Math.min(PAGE_ROWS, maxRows - candidateRows);
      const page = await db.query<TranscriptEvent>({
        collection: KERNEL_COLLECTIONS.transcriptEvents,
        where: [
          { field: "sessionId", eq: sessionId },
          { field: "decisionEpoch", eq: authority.decisionEpoch },
          { field: "transcriptEpoch", eq: transcriptHead.transcriptEpoch },
          { field: "seq", lt: beforeSeq },
        ],
        orderBy: [{ field: "seq", direction: "desc" }],
        limit,
      });
      candidateRows += page.records.length;
      let found: string | undefined;
      for (const row of page.records) {
        found = transcriptEntryMatchSnippet(row.entry, term) ?? undefined;
        if (found) break;
      }
      if (found) {
        matches.push({ id: sessionId, snippet: found });
        break;
      }
      if (page.records.length < limit) break;
      beforeSeq = page.records.at(-1)!.seq;
    }
  }
  if (!exhausted && matches.length >= maxMatches) exhausted = "matches";
  else if (!exhausted && candidateRows >= maxRows) exhausted = "rows";
  else if (!exhausted && sessionIds.length > ids.length) exhausted = "sessions";
  return { matches, searchedSessions, candidateRows, exhausted };
}
