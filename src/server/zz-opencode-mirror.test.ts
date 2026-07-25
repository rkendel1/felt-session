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
 * store (transcript-store.ts), keyed by the UNIFIED backstage session id
 * (spec.bksSessionId), not by the opencode engine session id. So these
 * assertions read the store by unified id instead of a per-oc-session file.
 * That also changes what "account rotation" means to assert: every oc id a
 * rotation touches maps onto the SAME unified session (spec.bksSessionId
 * never changes mid-turn), so there is one continuous transcript to check —
 * not two separate per-oc files — and each test below uses its own
 * bksSessionId to stay isolated from the others, the same way the old
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
} from "./opencode-transcript";
import { __setChatsDirForTest } from "./paths";
import { transcriptStore } from "./transcript-store";
import { RESUME_CONTINUATION_PROMPT } from "./agent-runner";
import type { StreamEvent } from "./run-events";
import type { RunHostSpec } from "../runner-host/protocol";

// The mirror's writer path (opencode-transcript.ts's storeAppendLines) calls
// the transcriptStore() SINGLETON, not an injectable instance — unlike the
// other transcript-store tests, which construct their own
// `new TranscriptStore(tempPath)` and never touch the singleton (invariant 8:
// one writer), this file has no way to inject a different store into the
// writer under test. So it redirects the singleton itself: repointing
// OPENSESSION_CHATS_DIR before transcriptStore() is ever called makes the
// lazy singleton open a scratch DB instead of the live transcripts.db.
// __setOpencodeTranscriptsDirForTest/__setOpencodeDbPathForTest do the same
// for the two on-disk seams the store's import-first gate still reads (the
// frozen mirror archive + OpenCode's own SQLite fallback probe), so a fresh
// unified session never picks up stray real data.
const scratch = mkdtempSync(join(tmpdir(), "bks-oc-mirror-"));
const priorTranscriptsDir = __setOpencodeTranscriptsDirForTest(
  join(scratch, "mirror-archive"),
);
const priorOpencodeDb = __setOpencodeDbPathForTest(join(scratch, "opencode.db"));
const priorChatsDir = __setChatsDirForTest(scratch);

const expectedDbPath = join(scratch, "transcripts.db");
// Full-suite caveat (same pattern as zz-fake-run.test.ts): if an earlier test
// file already called transcriptStore() before this file's redirect above
// took effect, the singleton is permanently pinned to that dir — it's a
// globalThis `??=`, nothing here can un-create it. Probe once and skip
// loudly rather than silently asserting against a stranger's store (or the
// developer's real one). Run this file directly for full coverage.
const redirected = transcriptStore().dbPath === expectedDbPath;
if (!redirected) {
  console.warn(
    "[zz-opencode-mirror] transcripts.db redirect didn't take (singleton " +
      "already warm from an earlier test file) — skipping; run this file " +
      "directly: bun test src/server/zz-opencode-mirror.test.ts",
  );
}

afterAll(() => {
  __setOpencodeTranscriptsDirForTest(priorTranscriptsDir);
  __setOpencodeDbPathForTest(priorOpencodeDb);
  __setChatsDirForTest(priorChatsDir);
  rmSync(scratch, { recursive: true, force: true });
});

function spec(overrides: Partial<RunHostSpec>): RunHostSpec {
  return {
    hostId: `rh-test-${Math.random().toString(36).slice(2, 10)}`,
    bksSessionId: "bks-mirror-test",
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
    if (!redirected) return;
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
        spec({ bksSessionId: bks, prompt: "first question" }),
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
      spec({ bksSessionId: bks, prompt: "second question", engineSessionId: oc }),
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
    if (!redirected) return;
    const bks = "bks-rotation";
    const s = spec({ bksSessionId: bks, prompt: "rotate me" });
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
    // Both engine sessions map onto the SAME unified session (spec.bksSessionId
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
    if (!redirected) return;
    const bks = "bks-notice";
    const s = spec({ bksSessionId: bks, prompt: "notice me" });
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
    if (!redirected) return;
    const bks = "bks-resume";
    const oc = "ses_mirror_resume";
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          { type: "text_chunk", text: "resumed output" } as StreamEvent,
        ]),
        spec({
          bksSessionId: bks,
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
    if (!redirected) return;
    const bks = "bks-redeliver";
    const oc = "ses_mirror_redeliver";
    const s = spec({ bksSessionId: bks, prompt: "once only", engineSessionId: oc });
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
    if (!redirected) return;
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
        spec({ bksSessionId: bks, prompt: "list files" }),
      ),
    );
    const entries = entriesFor(bks);
    expect(entries.map((e) => e.type)).toEqual(["user", "tool_use", "tool_result"]);
    // No plain-text user entry beyond the prompt (the empty-user-bubble bug).
    const userTexts = entries.filter((e) => e.type === "user").map((e) => e.content);
    expect(userTexts).toEqual(["list files"]);
  });

  test("non-opencode models pass through untouched", async () => {
    const events = [
      { type: "init", sessionId: "claude-native" } as StreamEvent,
      { type: "text_chunk", text: "hi" } as StreamEvent,
    ];
    const out = await drain(
      withOpencodeTranscriptMirror(
        stream(events),
        spec({ bksSessionId: "bks-passthrough", model: "claude-sonnet-5", prompt: "x" }),
      ),
    );
    expect(out).toHaveLength(2);
  });
});
