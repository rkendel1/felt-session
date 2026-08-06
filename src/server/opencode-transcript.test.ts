import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { TranscriptEntry } from "./types";

// Point both stores at scratch dirs BEFORE importing the module under test
// (cache-busted import so the env overrides are read fresh). The cache-bust
// keeps this test's own module instance isolated from the bare-imported one
// other files (and production code) use — but process.env is process-wide,
// so it must be restored, or a LATER test's own fresh envAlias(...) read
// (e.g. opencode-state-paths.test.ts's consistency check) sees this scratch
// path leak through.
const scratch = mkdtempSync(join(tmpdir(), "oc-transcript-test-"));
const dbPath = join(scratch, "opencode.db");
const transcriptsDir = join(scratch, "transcripts");
const priorDb = process.env.OPENSESSION_OPENCODE_DB;
const priorTranscriptsDir = process.env.OPENSESSION_OPENCODE_TRANSCRIPTS_DIR;
process.env.OPENSESSION_OPENCODE_DB = dbPath;
process.env.OPENSESSION_OPENCODE_TRANSCRIPTS_DIR = transcriptsDir;

const mod = await import(`./opencode-transcript.ts?test=${crypto.randomUUID()}`);
const {
  isOpencodeSessionId,
  readOpencodeTranscript,
  hasOpencodeTranscript,
  getOpencodeTranscriptPath,
  existingOpencodeTranscriptPath,
  appendOpencodeTranscript,
  ensureOpencodeTranscriptFile,
  transcriptLineUser,
  transcriptLineAssistantText,
  transcriptLineToolUse,
  transcriptLineToolResult,
  transcriptLineForEntry,
  opencodeToolResultImages,
  opencodeOpenTaskSnapshot,
  opencodeTurnLooksCompleted,
} = mod;
const { parseJsonlLines } = await import("./jsonl-parser");
const { TranscriptStore, transcriptStore, __setTranscriptStoreForTest } = await import(
  "./transcript-store"
);
const { __setSessionsDirForTest } = await import("./paths");

// Since the 2026-07-23 mirror retirement (35bb2767, transcript-v2 design §11)
// the three transcript WRITERS below — appendOpencodeTranscript,
// ensureOpencodeTranscriptFile, backfillOpencodeTranscriptGap — no longer
// touch the per-oc-session jsonl file. They resolve the UNIFIED session id
// through the oc→bks map and write into the transcript store; mirror files on
// disk are a frozen read-only archive. So the writer tests below seed a
// mapping and read the store back, the same way zz-opencode-mirror.test.ts
// does. The READER helpers (readOpencodeTranscript, hasOpencodeTranscript,
// the parse/line builders) still work off SQLite + jsonl and are unchanged.
//
// Three seams have to move together, all for the same reason as in
// zz-opencode-mirror.test.ts: the store singleton (force-replaced — the
// writer calls transcriptStore(), which this file cannot inject into), the
// oc→bks map PATH (module-scoped, so redirect it on `mod`'s cache-busted
// instance, which is the one the writers under test read), and the map's
// in-memory STATE (parked on globalThis, so a map already loaded from the
// real file would otherwise flush our test entries into it on the next write
// from any code in this process).
const priorBksMapPath = mod.__setOpencodeBksMapPathForTest(join(scratch, "bks-map.json"));
const priorBksMapState = mod.__setOpencodeBksMapStateForTest();
const priorSessionsDir = __setSessionsDirForTest(scratch);
// The store's import-first gate reads OpenCode's SQLite through the BARE
// opencode-transcript module, not this file's cache-busted `mod` — and the
// bare one resolves its db path at ITS load, which in a full `bun test` run
// happened under the real env, long before this file set OPENSESSION_OPENCODE_DB.
// Left alone the legacy-import test then probes the real ~/.opensession
// database, finds no ses_testabc123, and imports nothing (passes in isolation,
// fails in the suite). The live-binding seams repoint it whoever loaded first.
const bare = await import("./opencode-transcript");
const priorBareDb = bare.__setOpencodeDbPathForTest(dbPath);
const priorBareTranscriptsDir = bare.__setOpencodeTranscriptsDirForTest(transcriptsDir);
const scratchStore = new TranscriptStore(join(scratch, "transcripts.db"));
const priorStore = __setTranscriptStoreForTest(scratchStore);
const { recordBksSessionFor, backfillOpencodeTranscriptGap } = mod;

/** Every stored entry for a unified session, in ascending seq order. */
const entriesFor = (unifiedId: string) => transcriptStore().readTail(unifiedId, 200).entries;

const SES = "ses_testabc123";

function seedDb() {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text, title text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
  `);
  db.query("INSERT INTO session VALUES (?, 'p', 't', 1, 1)").run(SES);
  const t0 = 1783500000000;
  const ins = db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  ins.run("msg_1", SES, t0, t0, JSON.stringify({ role: "user", time: { created: t0 } }));
  ins.run("msg_2", SES, t0 + 1000, t0 + 1000, JSON.stringify({ role: "assistant", time: { created: t0 + 1000 } }));
  const insP = db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  insP.run(
    "prt_u1", "msg_1", SES, t0, t0,
    JSON.stringify({
      type: "text",
      text: "<opensession:context>\nplumbing\n</backstage:context>\n\nRemember the codeword: PELICAN.",
    })
  );
  insP.run("prt_syn", "msg_2", SES, t0 + 500, t0 + 500,
    JSON.stringify({ type: "text", text: "injected", synthetic: true }));
  insP.run("prt_tool", "msg_2", SES, t0 + 800, t0 + 800,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
    }));
  insP.run("prt_a1", "msg_2", SES, t0 + 1000, t0 + 1000,
    JSON.stringify({ type: "text", text: "OK, noted." }));
  db.close();
}

beforeAll(seedDb);
afterAll(() => {
  if (priorDb === undefined) delete process.env.OPENSESSION_OPENCODE_DB;
  else process.env.OPENSESSION_OPENCODE_DB = priorDb;
  if (priorTranscriptsDir === undefined) delete process.env.OPENSESSION_OPENCODE_TRANSCRIPTS_DIR;
  else process.env.OPENSESSION_OPENCODE_TRANSCRIPTS_DIR = priorTranscriptsDir;
  // Hand the singleton back intact before `scratch` disappears — restoring
  // only the path bindings would leave a live store pointed at a removed db.
  __setTranscriptStoreForTest(priorStore);
  scratchStore.close();
  __setSessionsDirForTest(priorSessionsDir);
  bare.__setOpencodeDbPathForTest(priorBareDb);
  bare.__setOpencodeTranscriptsDirForTest(priorBareTranscriptsDir);
  mod.__setOpencodeBksMapPathForTest(priorBksMapPath);
  mod.__restoreOpencodeBksMapStateForTest(priorBksMapState);
  rmSync(scratch, { recursive: true, force: true });
});

describe("isOpencodeSessionId", () => {
  test("recognizes ses_ ids only", () => {
    expect(isOpencodeSessionId("ses_0bc487ca3ffe")).toBe(true);
    expect(isOpencodeSessionId("b1e2c3d4-0000-7000-8000-000000000000")).toBe(false);
    expect(isOpencodeSessionId(null)).toBe(false);
    expect(isOpencodeSessionId("")).toBe(false);
  });
});

describe("restart task-state recovery", () => {
  test("a completed assistant row is still incomplete while its task child is open", () => {
    const sessionId = "ses_open_task";
    const childSessionId = "ses_open_task_child";
    const createdAt = 1783500500000;
    const db = new Database(dbPath);
    db.query("INSERT INTO session VALUES (?, 'p', 't', ?, ?)").run(
      sessionId,
      createdAt,
      createdAt
    );
    db.query("INSERT INTO session VALUES (?, 'p', 'child', ?, ?)").run(
      childSessionId,
      createdAt + 10,
      createdAt + 5000
    );
    db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "msg_open_task",
      sessionId,
      createdAt,
      createdAt,
      JSON.stringify({
        role: "assistant",
        time: { created: createdAt, completed: createdAt + 1000 },
      })
    );
    db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      "prt_open_task",
      "msg_open_task",
      sessionId,
      createdAt,
      createdAt + 1000,
      JSON.stringify({
        type: "tool",
        tool: "task",
        state: {
          status: "running",
          time: { start: createdAt + 1000 },
          metadata: { sessionId: childSessionId },
        },
      })
    );
    db.close();

    expect(opencodeTurnLooksCompleted(sessionId)).toBe(false);
    expect(opencodeOpenTaskSnapshot(sessionId)).toEqual({
      tasks: [{ id: "prt_open_task", childSessionId }],
      lastActivityAt: createdAt + 5000,
    });

    const finished = new Database(dbPath);
    finished
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(
        JSON.stringify({
          type: "tool",
          tool: "task",
          state: { status: "completed", metadata: { sessionId: childSessionId } },
        }),
        "prt_open_task"
      );
    finished.close();
    expect(opencodeTurnLooksCompleted(sessionId)).toBe(true);
  });
});

describe("opencodeToolResultImages", () => {
  test("supports the media route image formats and rejects unscoped paths", () => {
    for (const [extension, mime] of [
      ["png", "image/png"],
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
    ]) {
      const path = `/tmp/read-result.${extension}`;
      expect(opencodeToolResultImages({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: path },
          attachments: [{ type: "file", mime }],
        },
      })).toEqual([`/media?path=${encodeURIComponent(path)}`]);
    }
    expect(opencodeToolResultImages({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/etc/secrets.png" },
        attachments: [{ type: "file", mime: "image/png" }],
      },
    })).toEqual([]);
  });

  describe("inside a sandboxed run host", () => {
    // OPENSESSION_RUN_WS_URL marks a run host that dialed OUT over WS — a sandbox,
    // whose filesystem the media route cannot reach.
    let prior: string | undefined;
    beforeAll(() => {
      prior = process.env.OPENSESSION_RUN_WS_URL;
      process.env.OPENSESSION_RUN_WS_URL = "wss://example.invalid/run-ws/rh-test";
    });
    afterAll(() => {
      if (prior === undefined) delete process.env.OPENSESSION_RUN_WS_URL;
      else process.env.OPENSESSION_RUN_WS_URL = prior;
    });

    const dataUrl = "data:image/png;base64,aGVsbG8=";

    test("carries the attachment inline instead of an unservable media path", () => {
      expect(opencodeToolResultImages({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          // A path only the sandbox can resolve — /media would 404.
          input: { filePath: "/workspace/build/shot.png" },
          attachments: [{ type: "file", mime: "image/png", url: dataUrl }],
        },
      })).toEqual([dataUrl]);
    });

    test("does not require the path allowlist the host branch enforces", () => {
      // The allowlist exists because the host branch hands the path to the
      // media route. Inline bytes are self-contained, so a sandbox path that
      // would fail that check still renders.
      expect(opencodeToolResultImages({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/etc/whatever.png" },
          attachments: [{ type: "file", mime: "image/png", url: dataUrl }],
        },
      })).toEqual([dataUrl]);
    });

    test("drops an attachment whose url is missing, foreign, or oversized", () => {
      const state = (url: unknown) => ({
        status: "completed",
        input: { filePath: "/workspace/shot.png" },
        attachments: [{ type: "file", mime: "image/png", url }],
      });
      // No url at all.
      expect(opencodeToolResultImages({ type: "tool", tool: "read", state: state(undefined) as any }))
        .toEqual([]);
      // Not the data: URL we expect for the declared mime — never hand the
      // browser an arbitrary URL sourced from tool state.
      expect(opencodeToolResultImages({ type: "tool", tool: "read", state: state("https://evil.example/x.png") as any }))
        .toEqual([]);
      expect(opencodeToolResultImages({ type: "tool", tool: "read", state: state("data:image/svg+xml;base64,PHN2Zz4=") as any }))
        .toEqual([]);
      // Past the transport bound.
      const huge = `data:image/png;base64,${"A".repeat(33 * 1024 * 1024)}`;
      expect(opencodeToolResultImages({ type: "tool", tool: "read", state: state(huge) as any }))
        .toEqual([]);
    });
  });
});

describe("readOpencodeTranscript (SQLite)", () => {
  test("maps messages/parts to entries, strips context fences and synthetic parts", () => {
    const entries = readOpencodeTranscript(SES);
    expect(entries.map((e: TranscriptEntry) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0].content).toBe("Remember the codeword: PELICAN.");
    expect(entries[1].toolName).toBe("bash");
    expect(entries[2].content).toBe("file.txt");
    expect(entries[2].toolUseId).toBe("prt_tool");
    expect(entries[3].content).toBe("OK, noted.");
  });
  test("extracts and hides video markers from assistant text parts", () => {
    const sessionId = "ses_video_marker";
    const createdAt = 1783501000000;
    const db = new Database(dbPath);
    db.query("INSERT INTO session VALUES (?, 'p', 't', 1, 1)").run(sessionId);
    db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "msg_video",
      sessionId,
      createdAt,
      createdAt,
      JSON.stringify({ role: "assistant", time: { created: createdAt } }),
    );
    db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      "prt_video",
      "msg_video",
      sessionId,
      createdAt,
      createdAt,
      JSON.stringify({
        type: "text",
        text: "Captured the production flow.\n\nOPENSESSION_VIDEO: /tmp/opencode-demo.mov",
      }),
    );
    db.close();

    const entries = readOpencodeTranscript(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("Captured the production flow.");
    expect(entries[0].videos).toEqual([
      "/media?path=%2Ftmp%2Fopencode-demo.mov",
    ]);
  });
  test("maps Read image attachments to the authenticated local media route", () => {
    const sessionId = "ses_read_image";
    const createdAt = 1783501500000;
    const db = new Database(dbPath);
    db.query("INSERT INTO session VALUES (?, 'p', 't', 1, 1)").run(sessionId);
    db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "msg_read_image",
      sessionId,
      createdAt,
      createdAt,
      JSON.stringify({ role: "assistant", time: { created: createdAt } }),
    );
    db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      "prt_read_image",
      "msg_read_image",
      sessionId,
      createdAt,
      createdAt,
      JSON.stringify({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/tmp/storyboard-videos.png" },
          output: "Image read successfully",
          attachments: [
            {
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      }),
    );
    db.close();

    const entries = readOpencodeTranscript(sessionId);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      type: "tool_result",
      content: "Image read successfully",
      images: ["/media?path=%2Ftmp%2Fstoryboard-videos.png"],
    });
  });
  test("autocompact summaries become compaction system entries", () => {
    const sessionId = "ses_compaction";
    const t = 1783502000000;
    const db = new Database(dbPath);
    db.query("INSERT INTO session VALUES (?, 'p', 't', 1, 1)").run(sessionId);
    const insM = db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    // Trigger: synthetic user message with a compaction part. Its `summary` is
    // a diffs OBJECT — must not be mistaken for the boolean summary marker.
    insM.run(
      "msg_trig", sessionId, t, t,
      JSON.stringify({ role: "user", time: { created: t }, summary: { diffs: [] } })
    );
    insM.run(
      "msg_sum", sessionId, t + 1000, t + 1000,
      JSON.stringify({
        role: "assistant",
        agent: "compaction",
        mode: "compaction",
        summary: true,
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        time: { created: t + 1000 },
      })
    );
    const insP = db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    insP.run("prt_trig", "msg_trig", sessionId, t, t,
      JSON.stringify({ type: "compaction", auto: true }));
    insP.run("prt_sum", "msg_sum", sessionId, t + 1000, t + 1000,
      JSON.stringify({ type: "text", text: "## Objective\nKeep going." }));
    db.close();

    const entries = readOpencodeTranscript(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "sys-prt_sum",
      type: "system",
      compaction: true,
      content: "## Objective\nKeep going.",
    });
  });
  test("compaction system entries round-trip through transcriptLineForEntry", () => {
    const entry: TranscriptEntry = {
      id: "sys-prt_sum",
      type: "system",
      content: "## Objective\nKeep going.",
      timestamp: "2026-07-24T00:00:00.000Z",
      compaction: true,
    };
    const line = transcriptLineForEntry(entry);
    expect(line).not.toBeNull();
    // Parser derives `sys-<uuid>` — the builder strips the prefix so the
    // upsert key is stable across the live writer and the gap backfill.
    expect(line!.uuid).toBe("prt_sum");
    const [parsed] = parseJsonlLines([JSON.stringify(line)]);
    expect(parsed).toMatchObject({
      id: "sys-prt_sum",
      type: "system",
      compaction: true,
      content: "## Objective\nKeep going.",
    });
    // Other system entries stay derived-only, as before.
    expect(
      transcriptLineForEntry({
        id: "sys-x",
        type: "system",
        content: "notice",
        timestamp: "2026-07-24T00:00:00.000Z",
      })
    ).toBeNull();
  });
  test("unknown session / missing db degrade to []", () => {
    expect(readOpencodeTranscript("ses_nope")).toEqual([]);
    expect(readOpencodeTranscript(SES, join(scratch, "missing.db"))).toEqual([]);
    expect(hasOpencodeTranscript(SES)).toBe(true);
    expect(hasOpencodeTranscript("ses_nope")).toBe(false);
  });
});

describe("persisted transcript file", () => {
  test("tool result lines round-trip local image URLs without base64 payloads", () => {
    const url = "/media?path=%2Ftmp%2Fstoryboard-videos.png";
    const line = transcriptLineToolResult(
      "tu-image",
      "Image read successfully",
      false,
      "2026-07-08T00:00:00.000Z",
      [url],
    );
    expect(JSON.stringify(line)).not.toContain("base64");
    expect(parseJsonlLines([JSON.stringify(line)])[0]).toMatchObject({
      id: "tr-tu-image",
      type: "tool_result",
      content: "Image read successfully",
      images: [url],
    });
  });

  test("appended claude-shape lines land in the store as parsed entries", () => {
    const id = "ses_roundtrip";
    const bks = "bks-roundtrip";
    recordBksSessionFor(id, bks);
    appendOpencodeTranscript(id, [
      transcriptLineUser("hello there", "u1", "2026-07-08T00:00:00.000Z"),
      transcriptLineToolUse("tu1", "bash", { command: "ls" }, "2026-07-08T00:00:01.000Z"),
      transcriptLineToolResult("tu1", "file.txt", false, "2026-07-08T00:00:02.000Z"),
      transcriptLineAssistantText("done!", "a1", "2026-07-08T00:00:03.000Z"),
    ]);
    const entries = entriesFor(bks);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0]).toMatchObject({ id: "u1", content: "hello there" });
    expect(entries[1]).toMatchObject({ toolName: "bash", toolUseId: "tu1" });
    expect(entries[2]).toMatchObject({ id: "tr-tu1", content: "file.txt" });
    expect(entries[3]).toMatchObject({ id: "a1", content: "done!" });
    // The mirror is retired: nothing was written to the per-oc jsonl path.
    expect(existingOpencodeTranscriptPath(id)).toBeNull();
    expect(existsSync(getOpencodeTranscriptPath(id))).toBe(false);
  });

  test("an unmapped engine session drops the batch instead of throwing", () => {
    // §3: no unified session mapped ⇒ skip with a warn + degraded mark. A
    // transcript write must never take the run down, and it must never guess
    // an owner — the §8 re-import heals the session once it IS mapped.
    const id = "ses_unmapped";
    expect(() =>
      appendOpencodeTranscript(id, [
        transcriptLineUser("into the void", "u-void", "2026-07-08T00:00:00.000Z"),
      ]),
    ).not.toThrow();
    expect(entriesFor("bks-unmapped")).toHaveLength(0);
  });

  test("ensureOpencodeTranscriptFile ignores its seed and writes no mirror file", () => {
    // Post-retirement this is purely the store's import-first gate: the
    // `_seed` parameter survives only so pre-restart runner closures keep
    // their arity, and the entries it carries are deliberately dropped (the
    // import reads the same sources directly). Pinned because silently
    // storing them would double every cross-engine handoff.
    const id = "ses_seeded";
    recordBksSessionFor(id, "bks-seeded");
    ensureOpencodeTranscriptFile(id, [
      { id: "orig-1", type: "user", content: "old turn", timestamp: "2026-07-07T00:00:00.000Z" },
      { id: "orig-2", type: "assistant", content: "old reply", timestamp: "2026-07-07T00:00:01.000Z" },
    ] as TranscriptEntry[]);
    expect(entriesFor("bks-seeded")).toHaveLength(0);
    expect(existsSync(getOpencodeTranscriptPath(id))).toBe(false);
  });

  test("ensureOpencodeTranscriptFile imports legacy sessions from SQLite", () => {
    recordBksSessionFor(SES, "bks-legacy-import");
    ensureOpencodeTranscriptFile(SES);
    const entries = entriesFor("bks-legacy-import");
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0].content).toBe("Remember the codeword: PELICAN.");
  });

  test("transcriptLineForEntry skips system entries and tool_results without ids", () => {
    expect(
      transcriptLineForEntry({ id: "s", type: "system", content: "x", timestamp: "" })
    ).toBeNull();
    expect(
      transcriptLineForEntry({ id: "t", type: "tool_result", content: "x", timestamp: "" })
    ).toBeNull();
  });
});

describe("backfillOpencodeTranscriptGap", () => {
  const { backfillOpencodeTranscriptGap } = mod;
  const GAP_SES = "ses_gaptest";
  test("appends only missing assistant/tool lines, never user lines, and seeds dedup", () => {
    // Own session. The steps below are in the order production runs them,
    // which matters now that the store's import-first gate is in the picture:
    // the gate fires at RUN START, when OpenCode's SQLite holds only PRIOR
    // turns. Seeding this turn's rows before the gate instead (as the
    // pre-v2 fixture did, when appends went to a jsonl file and the gate
    // didn't exist) makes the import pull in the turn's user message, which
    // the live pump then writes again under its own random uuid — two user
    // bubbles for one prompt, an artifact of the fixture rather than
    // anything the runner can produce.
    const BKS = "bks-gaptest";
    recordBksSessionFor(GAP_SES, BKS);
    const db = new Database(dbPath);
    db.query("INSERT INTO session VALUES (?, 'p', 't', 1, 1)").run(GAP_SES);
    db.close();
    ensureOpencodeTranscriptFile(GAP_SES);
    expect(entriesFor(BKS)).toHaveLength(0);

    // OpenCode persists the turn as it executes: user text, tool pair, and
    // the final assistant text.
    const db2 = new Database(dbPath);
    const t0 = 1783600000000;
    const ins = db2.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    ins.run("gm_1", GAP_SES, t0, t0, JSON.stringify({ role: "user", time: { created: t0 } }));
    ins.run("gm_2", GAP_SES, t0 + 1000, t0 + 1000, JSON.stringify({ role: "assistant", time: { created: t0 + 1000 } }));
    const insP = db2.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    insP.run("gprt_u1", "gm_1", GAP_SES, t0, t0, JSON.stringify({ type: "text", text: "do the thing" }));
    insP.run("gprt_tool", "gm_2", GAP_SES, t0 + 800, t0 + 800,
      JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "file.txt" } }));
    insP.run("gprt_a1", "gm_2", GAP_SES, t0 + 1000, t0 + 1000,
      JSON.stringify({ type: "text", text: "all done" }));
    db2.close();

    // Simulate the restart gap: the live pump stored the user line and the
    // pre-restart tool pair, then the process died before the assistant text.
    appendOpencodeTranscript(GAP_SES, [
      transcriptLineUser("do the thing", undefined, "2026-07-08T00:00:00.000Z"),
      transcriptLineToolUse("gprt_tool", "bash", { command: "ls" }, "2026-07-08T00:00:01.000Z"),
      transcriptLineToolResult("gprt_tool", "file.txt", false, "2026-07-08T00:00:02.000Z"),
    ]);
    const seen = backfillOpencodeTranscriptGap(GAP_SES);
    // The assistant text is what the gap cost us; the SQLite user entry must
    // NOT duplicate the runner-written user line (random uuid, one bubble),
    // and the tool pair re-upserts onto the rows already there rather than
    // appending a second copy (§1 upsert semantics — the frozen mirror file
    // no longer supplies uuids to dedup against, so the tool lines are
    // recomputed from SQLite on every reattach and land on the same ids).
    const entries = entriesFor(BKS);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[3].content).toBe("all done");
    // Seeds cover the uuids the live pump must not re-append after the gap.
    expect(seen.has("gprt_a1")).toBe(true);
    expect(seen.has("gprt_tool-use")).toBe(true);
    expect(seen.has("gprt_tool-result")).toBe(true);
    // Idempotent: a second backfill adds no rows.
    backfillOpencodeTranscriptGap(GAP_SES);
    expect(entriesFor(BKS)).toHaveLength(4);
  });
});
