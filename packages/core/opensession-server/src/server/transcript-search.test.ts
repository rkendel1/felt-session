import { describe, expect, test } from "bun:test";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchManagedTranscripts } from "./managed-transcript-search";
import {
  KERNEL_COLLECTIONS,
  kernelRecordId,
} from "./session-kernel/feltdb-decision-store";
import { transcriptEntryMatchSnippet } from "./transcript-search";
import type { TranscriptEntry } from "./types";

function entry(id: string, content: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id, type: "assistant", content, ...extra,
    timestamp: extra.timestamp ?? "2026-08-20T10:00:00Z" };
}

async function append(db: StateFirstDB, sessionId: string, entries: TranscriptEntry[]) {
  await db.transaction((tx) => {
    tx.collection(KERNEL_COLLECTIONS.sessions).set(sessionId, {
      sessionId, decisionEpoch: 1, authority: { lifecycle: "active" },
    });
    tx.collection(KERNEL_COLLECTIONS.transcriptHeads).set(sessionId, {
      sessionId, decisionEpoch: 1, transcriptEpoch: 1,
    });
    entries.forEach((value, index) => {
      const seq = index + 1;
      tx.collection(KERNEL_COLLECTIONS.transcriptEvents).set(
        kernelRecordId("search_test", `${sessionId}:${seq}`), {
        sessionId, decisionEpoch: 1, transcriptEpoch: 1, seq, entry: value,
      });
    });
  }, { transactionId: `transcript-search-fixture:${sessionId}` });
}

function queryable(db: StateFirstDB): StateFirstDB {
  return new Proxy(db, {
    get(target, property) {
      if (property !== "query") return Reflect.get(target, property, target);
      return async (query: any) => {
        let records = await target.collection<any>(query.collection).all();
        for (const predicate of query.where ?? []) records = records.filter((record) => {
          const value = record[predicate.field];
          if ("eq" in predicate && value !== predicate.eq) return false;
          if ("lt" in predicate && !(value < predicate.lt)) return false;
          return true;
        });
        for (const order of [...(query.orderBy ?? [])].reverse())
          records.sort((a, b) => (a[order.field] - b[order.field]) *
            (order.direction === "desc" ? -1 : 1));
        return { records: records.slice(0, query.limit), exhausted: true };
      };
    },
  });
}

describe("managed transcript search", () => {
  test("matches visible text in requested session order", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await append(db, "newer", [entry("tool", "Ran a command", {
      type: "tool_use", toolInput: { command: "echo NEEDLE" },
    })]);
    await append(db, "older", [entry("answer", "The needle is here")]);
    await append(db, "metadata", [entry("needle-only-id", "Nothing visible")]);
    const result = await searchManagedTranscripts(
      "needle", ["newer", "older", "metadata"], undefined, queryable(db),
    );
    expect(result.matches.map((match) => match.id)).toEqual(["newer", "older"]);
    expect(result.matches[0]!.snippet).toContain("NEEDLE");
    expect(result.searchedSessions).toBe(3);
  });

  test("pages within row budgets and ignores superseded epochs", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    await append(db, "deep", Array.from({ length: 60 }, (_, i) =>
      entry(`deep-${i}`, i === 10 ? "older needle survives paging" : `ordinary row ${i}`)));
    const result = await searchManagedTranscripts(
      "older needle", ["deep"], undefined, queryable(db), undefined, { maxRows: 60 },
    );
    expect(result.matches).toMatchObject([{ id: "deep" }]);
    expect(result.candidateRows).toBeGreaterThan(24);
    await db.transaction((tx) => {
      tx.collection(KERNEL_COLLECTIONS.transcriptHeads).set("deep", {
        sessionId: "deep", decisionEpoch: 1, transcriptEpoch: 2,
      });
    }, { transactionId: "transcript-search-reset:deep" });
    expect((await searchManagedTranscripts(
      "older needle", ["deep"], undefined, queryable(db),
    )).matches)
      .toEqual([]);
  });

  test("enforces session, row, and wall-clock budgets", async () => {
    const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
    for (const id of ["one", "two", "three"])
      await append(db, id, Array.from({ length: 4 }, (_, i) => entry(`${id}-${i}`, "shared phrase")));
    expect(await searchManagedTranscripts(
      "shared phrase", ["one", "two", "three"], undefined, queryable(db), undefined,
      { maxMatches: 10, maxSessions: 2 },
    )).toMatchObject({ searchedSessions: 2, exhausted: "sessions" });
    expect(await searchManagedTranscripts(
      "absent phrase", ["one", "two", "three"], undefined, queryable(db), undefined,
      { maxMatches: 10, maxRows: 1 },
    )).toMatchObject({ candidateRows: 1, exhausted: "rows" });
    let tick = 0;
    expect(await searchManagedTranscripts(
      "shared phrase", ["one"], undefined, queryable(db), () => tick++, { maxMs: 1 },
    )).toMatchObject({ searchedSessions: 0, exhausted: "time" });
  });

  test("global route queries managed FeltDB and never actor SQLite", () => {
    const route = readFileSync(join(import.meta.dir, "routes/sessions.ts"), "utf8");
    expect(route).toContain("searchManagedTranscripts(q, recentIds, req.signal)");
    expect(route).not.toContain("transcriptSearchWorkerArgv");
    expect(route).not.toContain("ripgrepFiles");
    expect(route).not.toContain("transcriptMatchSnippet");
    const managed = readFileSync(join(import.meta.dir, "managed-transcript-search.ts"), "utf8");
    expect(managed).not.toContain("bun:sqlite");
    expect(managed).toContain("KERNEL_COLLECTIONS.transcriptEvents");
  });

  test("builds one-line context around a match", () => {
    expect(transcriptEntryMatchSnippet(
      entry("a", `before ${"x".repeat(80)}\nNeedle\tafter`), "needle", 12,
    )).toMatch(/^….*Needle after$/);
  });
});
