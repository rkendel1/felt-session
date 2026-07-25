import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
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
const priorDb = process.env.BACKSTAGE_OPENCODE_DB;
const priorTranscriptsDir = process.env.BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR;
process.env.BACKSTAGE_OPENCODE_DB = dbPath;
process.env.BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR = transcriptsDir;

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
} = mod;
const { parseTranscript, parseJsonlLines } = await import("./jsonl-parser");

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
      text: "<backstage:context>\nplumbing\n</backstage:context>\n\nRemember the codeword: PELICAN.",
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
  if (priorDb === undefined) delete process.env.BACKSTAGE_OPENCODE_DB;
  else process.env.BACKSTAGE_OPENCODE_DB = priorDb;
  if (priorTranscriptsDir === undefined) delete process.env.BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR;
  else process.env.BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR = priorTranscriptsDir;
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

describe("opencodeToolResultImages", () => {
  test("preserves validated image snapshots regardless of source path", () => {
    for (const [extension, mime] of [
      ["png", "image/png"],
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
    ]) {
      const path = `/srv/worktrees/configured-root/read-result.${extension}`;
      const dataUrl = `data:${mime};base64,AA==`;
      expect(opencodeToolResultImages({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: path },
          attachments: [{ type: "file", mime, url: dataUrl }],
        },
      })).toEqual([dataUrl]);
    }
  });
  test("rejects missing, external, and MIME-mismatched attachment URLs", () => {
    const part = {
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/srv/worktrees/read-result.png" },
        attachments: [{ type: "file", mime: "image/png" }],
      },
    };
    expect(opencodeToolResultImages(part)).toEqual([]);
    expect(opencodeToolResultImages({
      ...part,
      state: {
        ...part.state,
        attachments: [{ type: "file", mime: "image/png", url: "https://example.com/image.png" }],
      },
    })).toEqual([]);
    expect(opencodeToolResultImages({
      ...part,
      state: {
        ...part.state,
        attachments: [{ type: "file", mime: "image/png", url: "data:image/jpeg;base64,AA==" }],
      },
    })).toEqual([]);
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
        text: "Captured the production flow.\n\nBACKSTAGE_VIDEO: /tmp/opencode-demo.mov",
      }),
    );
    db.close();

    const entries = readOpencodeTranscript(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("Captured the production flow.");
    expect(entries[0].videos).toEqual([
      "/backstage/media?path=%2Ftmp%2Fopencode-demo.mov",
    ]);
  });
  test("maps Read image attachments to their immutable snapshots", () => {
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
      images: ["data:image/png;base64,iVBORw0KGgo="],
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
    const url = "/backstage/media?path=%2Ftmp%2Fstoryboard-videos.png";
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

  test("appended claude-shape lines round-trip through parseTranscript", () => {
    const id = "ses_roundtrip";
    appendOpencodeTranscript(id, [
      transcriptLineUser("hello there", "u1", "2026-07-08T00:00:00.000Z"),
      transcriptLineToolUse("tu1", "bash", { command: "ls" }, "2026-07-08T00:00:01.000Z"),
      transcriptLineToolResult("tu1", "file.txt", false, "2026-07-08T00:00:02.000Z"),
      transcriptLineAssistantText("done!", "a1", "2026-07-08T00:00:03.000Z"),
    ]);
    const path = getOpencodeTranscriptPath(id);
    expect(existingOpencodeTranscriptPath(id)).toBe(path);
    const entries = parseTranscript(path);
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
  });

  test("ensureOpencodeTranscriptFile seeds a fresh file with handoff entries, preserving ids", () => {
    const id = "ses_seeded";
    const seed: TranscriptEntry[] = [
      { id: "orig-1", type: "user", content: "old turn", timestamp: "2026-07-07T00:00:00.000Z" },
      { id: "orig-2", type: "assistant", content: "old reply", timestamp: "2026-07-07T00:00:01.000Z" },
    ];
    ensureOpencodeTranscriptFile(id, seed);
    const entries = parseTranscript(getOpencodeTranscriptPath(id));
    expect(entries.map((e) => e.id)).toEqual(["orig-1", "orig-2"]);
    // Second ensure is a no-op (file exists).
    ensureOpencodeTranscriptFile(id, [
      { id: "other", type: "user", content: "x", timestamp: "2026-07-07T00:00:02.000Z" },
    ]);
    expect(parseTranscript(getOpencodeTranscriptPath(id))).toHaveLength(2);
  });

  test("ensureOpencodeTranscriptFile backfills legacy sessions from SQLite", () => {
    ensureOpencodeTranscriptFile(SES);
    const path = getOpencodeTranscriptPath(SES);
    expect(existsSync(path)).toBe(true);
    const entries = parseTranscript(path);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0].content).toBe("Remember the codeword: PELICAN.");
    expect(readFileSync(path, "utf-8")).toContain("PELICAN");
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
  const { backfillOpencodeTranscriptGap, opencodeTranscriptUuids } = mod;
  const GAP_SES = "ses_gaptest";
  test("appends only missing assistant/tool lines, never user lines, and seeds dedup", () => {
    // Own session (the shared fixture's file is already fully backfilled by
    // the ensure test above). Store state: user text + tool pair + final
    // assistant text.
    const db = new Database(dbPath);
    const t0 = 1783600000000;
    db.query("INSERT INTO session VALUES (?, 'p', 't', 1, 1)").run(GAP_SES);
    const ins = db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    ins.run("gm_1", GAP_SES, t0, t0, JSON.stringify({ role: "user", time: { created: t0 } }));
    ins.run("gm_2", GAP_SES, t0 + 1000, t0 + 1000, JSON.stringify({ role: "assistant", time: { created: t0 + 1000 } }));
    const insP = db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    insP.run("gprt_u1", "gm_1", GAP_SES, t0, t0, JSON.stringify({ type: "text", text: "do the thing" }));
    insP.run("gprt_tool", "gm_2", GAP_SES, t0 + 800, t0 + 800,
      JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "file.txt" } }));
    insP.run("gprt_a1", "gm_2", GAP_SES, t0 + 1000, t0 + 1000,
      JSON.stringify({ type: "text", text: "all done" }));
    db.close();

    // Simulate the restart gap: the live mirror wrote the user line and the
    // pre-restart tool pair, then the process died before the assistant text.
    appendOpencodeTranscript(GAP_SES, [
      transcriptLineUser("do the thing", undefined, "2026-07-08T00:00:00.000Z"),
      transcriptLineToolUse("gprt_tool", "bash", { command: "ls" }, "2026-07-08T00:00:01.000Z"),
      transcriptLineToolResult("gprt_tool", "file.txt", false, "2026-07-08T00:00:02.000Z"),
    ]);
    const seen = backfillOpencodeTranscriptGap(GAP_SES);
    const lines = readFileSync(getOpencodeTranscriptPath(GAP_SES), "utf-8").trim().split("\n");
    // Exactly one line appended: the assistant text. The tool pair was
    // already mirrored (uuid dedup) and the SQLite user entry must NOT
    // duplicate the runner-written user line (random uuid, still one bubble).
    expect(lines.length).toBe(4);
    const added = JSON.parse(lines[lines.length - 1]);
    expect(added.uuid).toBe("gprt_a1");
    expect(added.message.content[0].text).toBe("all done");
    // Seeds cover file + store uuids for the live pump's dedup sets.
    expect(seen.has("gprt_a1")).toBe(true);
    expect(seen.has("gprt_tool-use")).toBe(true);
    expect(seen.has("gprt_tool-result")).toBe(true);
    // Idempotent: a second backfill appends nothing.
    backfillOpencodeTranscriptGap(GAP_SES);
    expect(
      readFileSync(getOpencodeTranscriptPath(GAP_SES), "utf-8").trim().split("\n").length
    ).toBe(4);
    expect(opencodeTranscriptUuids(GAP_SES).size).toBe(4);
  });
});
