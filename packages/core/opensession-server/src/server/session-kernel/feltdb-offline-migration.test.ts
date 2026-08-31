import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { KERNEL_COLLECTIONS } from "./feltdb-decision-store";
import { encodeKernelSessionMigration } from "./feltdb-offline-migration";
import { SessionKernelStore } from "./store";
import { TranscriptStore } from "../transcript-store";

describe("offline Session Kernel FeltDB migration", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test("encodes one coherent actor database without discovering other sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "opensession-kernel-feltdb-migration-"));
    directories.push(directory);
    const path = join(directory, "kernel.sqlite");
    const source = new SessionKernelStore(path);
    source.appendChange("wanted", "created", { ready: true });
    source.setAskRecord("wanted", { question: "continue?" });
    source.enqueueOutbox("wanted", "notify", { channel: "test" }, "notify-1");
    source.appendChange("other", "ignored", { hidden: true });
    source.close();

    const db = new Database(path, { readonly: true, strict: true });
    try {
      const encoded = encodeKernelSessionMigration(db, "wanted");
      expect(encoded.run).toMatchObject({ state: "idle", generation: 0 });
      expect(encoded.changeSeq).toBe(2);
      expect(encoded.operations.map((operation) => operation.collection)).toEqual([
        KERNEL_COLLECTIONS.asks,
        KERNEL_COLLECTIONS.changes,
        KERNEL_COLLECTIONS.changes,
        KERNEL_COLLECTIONS.outbox,
      ]);
      expect(encoded.operations.every((operation) => operation.requireAbsent)).toBe(true);
      expect(encoded.operations.some((operation) =>
        JSON.stringify(operation.value).includes("other")
      )).toBe(false);
      expect(encoded.operations.find((operation) =>
        operation.collection === KERNEL_COLLECTIONS.outbox
      )?.value).toMatchObject({
        schemaVersion: 1,
        sessionId: "wanted",
        decisionEpoch: 1,
        status: "pending",
        payload: { channel: "test" },
      });
    } finally {
      db.close();
    }
  });

  test("rejects a non-dense journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "opensession-kernel-feltdb-migration-"));
    directories.push(directory);
    const path = join(directory, "kernel.sqlite");
    const source = new SessionKernelStore(path);
    source.appendChange("broken", "one");
    source.appendChange("broken", "two");
    source.close();
    const writable = new Database(path);
    writable.run(
      "DELETE FROM session_kernel_changes WHERE session_id = ? AND change_seq = ?",
      ["broken", 1],
    );
    writable.close();
    const db = new Database(path, { readonly: true, strict: true });
    try {
      expect(() => encodeKernelSessionMigration(db, "broken"))
        .toThrow("non-dense change journal");
    } finally {
      db.close();
    }
  });

  test("encodes co-located transcript authority with structured entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opensession-kernel-feltdb-transcript-"));
    directories.push(directory);
    const path = join(directory, "kernel.sqlite");
    new SessionKernelStore(path).close();
    const transcript = new TranscriptStore(path, { actorOwned: false });
    await transcript.applyActorRequest({
      op: "append",
      sessionId: "with-transcript",
      requestId: "append-1",
      entries: [{
        id: "entry-1",
        type: "user",
        content: "managed",
        timestamp: new Date(1_000).toISOString(),
      }],
    });
    transcript.close();
    const db = new Database(path, { readonly: true, strict: true });
    try {
      const encoded = encodeKernelSessionMigration(db, "with-transcript");
      expect(encoded.operations.find(({ collection }) =>
        collection === KERNEL_COLLECTIONS.transcriptHeads)?.value).toMatchObject({
        sessionId: "with-transcript",
        decisionEpoch: 1,
        nextSeq: 2,
        nextChangeSeq: 2,
      });
      expect(encoded.operations.find(({ collection }) =>
        collection === KERNEL_COLLECTIONS.transcriptEvents)?.value).toMatchObject({
        entryId: "entry-1",
        entry: { content: "managed" },
      });
      expect(encoded.operations.find(({ collection }) =>
        collection === KERNEL_COLLECTIONS.transcriptReceipts)?.value).toMatchObject({
        requestId: "append-1",
        result: { replay: false, wakeCursor: 1 },
      });
    } finally {
      db.close();
    }
  });
});
