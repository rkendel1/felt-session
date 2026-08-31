/**
 * Reading a DIRECT-SDK engine session's transcript by engine session id.
 *
 * claude-direct and codex-direct reuse the legacy provider tags
 * ("claude"/"codex") and session-id slots (claudeSessionId/codexThreadId) of
 * the CLI engines they replace, but they persist into the transcript STORE
 * under the engine session id. Native JSONL and rollout files must never win
 * over the managed transcript authority.
 */
import { describe, expect, test } from "bun:test";
import { readEngineTranscript, readEngineTranscriptAsync } from "./sessions";

describe("readEngineTranscript for direct-SDK engine sessions", () => {
  test("no file on disk delegates to the managed store instead of failing", async () => {
    // Nothing wrote these ids anywhere, so the store answers empty too — the
    // point is that the read resolves through the store path rather than
    // throwing or parsing a path that does not exist.
    const engineId = crypto.randomUUID();
    expect(readEngineTranscript("/ignored", engineId, "claude")).toEqual([]);
    expect(await readEngineTranscriptAsync("/ignored", engineId, "claude")).toEqual([]);
    expect(readEngineTranscript("/ignored", "", "codex")).toEqual([]);
  });
});
