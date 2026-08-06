/**
 * withOpencodeTranscriptMirror (sandbox/adapters/bootstrap.ts) — the
 * host-side transcript writer for REMOTE opencode runs. The in-sandbox
 * writer path is covered by opencode-transcript.test.ts; this covers the
 * mirror specifically, including the bks-019f46d2 regression: the turn's
 * user entry must come from the SPEC at dispatch/init time (with full text)
 * and must land in the UNIFIED transcript store for every engine session the
 * turn touches (an account rotation mid-turn starts a fresh one), without
 * duplicates.
 *
 * Since the 2026-07-23 mirror retirement (35bb2767, transcript-v2 design §11)
 * the per-oc-session JSONL mirror file this test used to read
 * (getOpencodeTranscriptPath + parseTranscript) is a frozen, never-written
 * archive — appendOpencodeTranscript now writes ONLY into the transcript
 * store (transcript-store.ts), keyed by the UNIFIED opensession session id
 * (spec.osSessionId), not by the opencode engine session id. So these
 * assertions read the store by unified id instead of a per-oc-session file.
 * That also changes what "account rotation" means to assert: every oc id a
 * rotation touches maps onto the SAME unified session (spec.osSessionId
 * never changes mid-turn), so there is one continuous transcript to check —
 * not two separate per-oc files — and each test below uses its own
 * osSessionId to stay isolated from the others, the same way the old
 * per-oc-file tests were isolated by using distinct oc ids.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withOpencodeTranscriptMirror } from "./sandbox/adapters/bootstrap";
import {
  __setOpencodeTranscriptsDirForTest,
  __setOpencodeDbPathForTest,
  __setOpencodeBksMapPathForTest,
  __setOpencodeBksMapStateForTest,
  __restoreOpencodeBksMapStateForTest,
} from "./opencode-transcript";
import { __setSessionsDirForTest } from "./paths";
import {
  TranscriptStore,
  transcriptStore,
  __setTranscriptStoreForTest,
} from "./transcript-store";
import { RESUME_CONTINUATION_PROMPT } from "./agent-runner";
import type { StreamEvent } from "./run-events";
import type { RunHostSpec } from "../runner-host/protocol";

// The mirror's writer path (opencode-transcript.ts's storeAppendLines) calls
// the transcriptStore() SINGLETON, not an injectable instance — unlike the
// other transcript-store tests, which construct their own
// `new TranscriptStore(tempPath)` and never touch the singleton (invariant 8:
// one writer), this file has no way to inject a different store into the
// writer under test. So it force-replaces the singleton itself (below, via
// __setTranscriptStoreForTest) with one backed by a scratch DB instead of the
// live transcripts.db. __setOpencodeTranscriptsDirForTest/
// __setOpencodeDbPathForTest do the same for the two on-disk seams the
// store's import-first gate still reads (the frozen mirror archive +
// OpenCode's own SQLite fallback probe), and __setSessionsDirForTest covers any
// other OPENSESSION_SESSIONS_DIR reads reachable from that gate — together they
// make sure a fresh unified session never picks up stray real data.
//
// recordBksSessionFor (called on every init) writes the oc→unified mapping
// through a THIRD globalThis-parked seam, OPENCODE_SESSION_MAP_PATH — not
// derived from OPENSESSION_SESSIONS_DIR, so __setSessionsDirForTest doesn't touch
// it. __setOpencodeBksMapPathForTest redirects the path; the in-memory map
// itself is also parked on globalThis (same shape as transcriptStore()), so
// __setOpencodeBksMapStateForTest swaps it for a blank one too — otherwise a
// map already loaded from the real file before this module's redirect took
// effect would still be sitting there after afterAll restores the real
// path, and the next in-process write from ANY code would flush our test
// entries into it.
const scratch = mkdtempSync(join(tmpdir(), "bks-oc-mirror-"));
const priorTranscriptsDir = __setOpencodeTranscriptsDirForTest(
  join(scratch, "mirror-archive"),
);
const priorOpencodeDb = __setOpencodeDbPathForTest(join(scratch, "opencode.db"));
const priorSessionsDir = __setSessionsDirForTest(scratch);
const priorBksMapPath = __setOpencodeBksMapPathForTest(join(scratch, "bks-map.json"));
const priorBksMapState = __setOpencodeBksMapStateForTest();

const expectedDbPath = join(scratch, "transcripts.db");
// Unlike zz-fake-run.test.ts's redirect probe, this doesn't need to skip when
// an earlier test file has already warmed the singleton: __setTranscriptStoreForTest
// force-replaces it (transcriptStore()'s `??=` can't), so the writer under
// test always lands in our scratch DB regardless of load order. Saving the
// previous store lets afterAll hand the singleton back intact — restoring
// only the path bindings and deleting `scratch` out from under a still-live
// singleton would leave it pointed at a removed database.
const scratchStore = new TranscriptStore(expectedDbPath);
const priorStore = __setTranscriptStoreForTest(scratchStore);

afterAll(() => {
  __setTranscriptStoreForTest(priorStore);
  scratchStore.close();
  __setOpencodeTranscriptsDirForTest(priorTranscriptsDir);
  __setOpencodeDbPathForTest(priorOpencodeDb);
  __setSessionsDirForTest(priorSessionsDir);
  __setOpencodeBksMapPathForTest(priorBksMapPath);
  __restoreOpencodeBksMapStateForTest(priorBksMapState);
  rmSync(scratch, { recursive: true, force: true });
});

function spec(overrides: Partial<RunHostSpec>): RunHostSpec {
  return {
    hostId: `rh-test-${Math.random().toString(36).slice(2, 10)}`,
    osSessionId: "bks-mirror-test",
    prompt: "hello",
    cwd: "/tmp",
    mode: "code",
    model: "opencode/anthropic/claude-haiku-4-5",
    ...overrides,
  } as RunHostSpec;
}

async function* stream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) yield ev;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Every stored entry for a unified session, in ascending seq order. */
const entriesFor = (unifiedId: string) => transcriptStore().readTail(unifiedId, 200).entries;

describe("withOpencodeTranscriptMirror", () => {
  test("two turns: both user prompts present with full text, in order, no dupes", async () => {
    const bks = "bks-two-turns";
    const oc = "ses_mirror_two_turns";
    // Turn 1: fresh session — engine id arrives via init.
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          { type: "text_chunk", text: "first answer" } as StreamEvent,
          { type: "done", sessionId: oc, result: "first answer" } as StreamEvent,
        ]),
        spec({ osSessionId: bks, prompt: "first question" }),
      ),
    );
    // Turn 2: resumed session — engine id known at dispatch; the user entry
    // must exist BEFORE any event arrives (the "Sending…" bubble reconciles
    // on it while the remote engine still boots).
    const turn2 = withOpencodeTranscriptMirror(
      stream([
        { type: "init", sessionId: oc } as StreamEvent,
        { type: "text_chunk", text: "second answer" } as StreamEvent,
      ]),
      spec({ osSessionId: bks, prompt: "second question", engineSessionId: oc }),
    );
    // Pull nothing yet — the generator body runs on first next(); one tick in.
    const first = await turn2.next();
    const midTurn = entriesFor(bks).filter((e) => e.type === "user");
    expect(midTurn.map((e) => e.content)).toContain("second question");
    while (!(await turn2.next()).done) {}
    void first;

    const entries = entriesFor(bks);
    const texts = entries.map((e) => [e.type, e.content]);
    expect(texts).toEqual([
      ["user", "first question"],
      ["assistant", "first answer"],
      ["user", "second question"],
      ["assistant", "second answer"],
    ]);
  });

  test("account rotation: the prompt survives in the unified store, no dupes", async () => {
    const bks = "bks-rotation";
    const s = spec({ osSessionId: bks, prompt: "rotate me" });
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: "ses_rot_a" } as StreamEvent,
          { type: "text_chunk", text: "[runner] usage limit; switching" } as StreamEvent,
          { type: "init", sessionId: "ses_rot_b" } as StreamEvent,
          { type: "text_chunk", text: "answer after rotation" } as StreamEvent,
        ]),
        s,
      ),
    );
    // Both engine sessions map onto the SAME unified session (spec.osSessionId
    // never changes across a rotation), so there's one continuous transcript,
    // not two per-oc files. The prompt must open it and survive the rotation
    // intact: written at attempt 1's init, then upserted — not duplicated —
    // at attempt 2's init via the deterministic `${hostId}-prompt` uuid. This
    // is the store-level equivalent of the original bks-019f46d2 bug (the
    // prompt only ever landed in attempt 1's file).
    const entries = entriesFor(bks);
    expect(entries[0]).toMatchObject({ type: "user", content: "rotate me" });
    expect(entries.filter((e) => e.type === "user")).toHaveLength(1);
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "assistant"]);
  });

  test("runner_notice events persist as system entries across a rotation", async () => {
    const bks = "bks-notice";
    const s = spec({ osSessionId: bks, prompt: "notice me" });
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: "ses_notice_a" } as StreamEvent,
          { type: "runner_notice", text: "usage limit; switching accounts" } as StreamEvent,
          { type: "init", sessionId: "ses_notice_b" } as StreamEvent,
          { type: "text_chunk", text: "answer after rotation" } as StreamEvent,
        ]),
        s,
      ),
    );
    // One unified transcript again; what matters is the notice parses back
    // as a system chip (not a user bubble), landing between the prompt and
    // the post-rotation reply.
    const entries = entriesFor(bks);
    expect(entries.map((e) => [e.type, e.content])).toEqual([
      ["user", "notice me"],
      ["system", "usage limit; switching accounts"],
      ["assistant", "answer after rotation"],
    ]);
  });

  test("synthetic resume-continuation prompt is not a user entry", async () => {
    const bks = "bks-resume";
    const oc = "ses_mirror_resume";
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          { type: "text_chunk", text: "resumed output" } as StreamEvent,
        ]),
        spec({
          osSessionId: bks,
          prompt: RESUME_CONTINUATION_PROMPT,
          engineSessionId: oc,
          journalKind: "prompt-resume",
        }),
      ),
    );
    const entries = entriesFor(bks);
    expect(entries.filter((e) => e.type === "user")).toHaveLength(0);
    expect(entries.filter((e) => e.type === "assistant")).toHaveLength(1);
  });

  test("re-delivery with the same hostId upserts instead of duplicating", async () => {
    const bks = "bks-redeliver";
    const oc = "ses_mirror_redeliver";
    const s = spec({ osSessionId: bks, prompt: "once only", engineSessionId: oc });
    await drain(
      withOpencodeTranscriptMirror(
        stream([{ type: "init", sessionId: oc } as StreamEvent]),
        s,
      ),
    );
    // Reattach after a restart replays with the SAME spec/hostId.
    await drain(
      withOpencodeTranscriptMirror(
        stream([{ type: "init", sessionId: oc } as StreamEvent]),
        s,
      ),
    );
    const users = entriesFor(bks).filter((e) => e.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toBe("once only");
  });

  test("tool use/result mirror as tool entries (not empty user bubbles)", async () => {
    const bks = "bks-tools";
    const oc = "ses_mirror_tools";
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          {
            type: "tool_use",
            toolUseId: "prt_1",
            toolName: "bash",
            toolInput: { command: "ls" },
          } as StreamEvent,
          { type: "tool_result", toolUseId: "prt_1", content: "file.txt" } as StreamEvent,
        ]),
        spec({ osSessionId: bks, prompt: "list files" }),
      ),
    );
    const entries = entriesFor(bks);
    expect(entries.map((e) => e.type)).toEqual(["user", "tool_use", "tool_result"]);
    // No plain-text user entry beyond the prompt (the empty-user-bubble bug).
    const userTexts = entries.filter((e) => e.type === "user").map((e) => e.content);
    expect(userTexts).toEqual(["list files"]);
  });

  test("a sandboxed Read's inline image survives the mirror", async () => {
    // The in-sandbox runner is the only thing that ever sees the Read
    // attachment's bytes, and it sends them inline because the host cannot
    // serve a path inside the sandbox. The mirror used to build its
    // tool_result line without ev.images, so every sandboxed Read image
    // arrived blank in the transcript.
    const bks = "bks-tool-images";
    const oc = "ses_mirror_images";
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          {
            type: "tool_use",
            toolUseId: "prt_img",
            toolName: "read",
            toolInput: { filePath: "/workspace/shot.png" },
          } as StreamEvent,
          {
            type: "tool_result",
            toolUseId: "prt_img",
            content: "Image read successfully",
            images: [dataUrl],
          } as StreamEvent,
        ]),
        spec({ osSessionId: bks, prompt: "look at the screenshot" }),
      ),
    );
    const result = entriesFor(bks).find((e) => e.type === "tool_result");
    expect(result?.images).toEqual([dataUrl]);
  });

  test("non-opencode models pass through untouched", async () => {
    const events = [
      { type: "init", sessionId: "claude-native" } as StreamEvent,
      { type: "text_chunk", text: "hi" } as StreamEvent,
    ];
    const out = await drain(
      withOpencodeTranscriptMirror(
        stream(events),
        spec({ osSessionId: "bks-passthrough", model: "claude-sonnet-5", prompt: "x" }),
      ),
    );
    expect(out).toHaveLength(2);
  });
});
