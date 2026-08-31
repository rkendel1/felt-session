import { afterEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseJsonlLines } from "./jsonl-parser";
import {
  __setEngineSessionMapPathForTest,
  initializeManagedEngineSessionOwners,
  recordEngineSessionOwner,
  sessionForEngineId,
  transcriptLineAssistantText,
  transcriptLineCompactionSummary,
  transcriptLineRunnerNotice,
  transcriptLineToolResult,
  transcriptLineToolUse,
  transcriptLineUser,
} from "./transcript-persistence";

let dir = "";
let previous = "";
afterEach(() => {
  if (previous) __setEngineSessionMapPathForTest(previous);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
  previous = "";
});

describe("transcript persistence", () => {
  test("persists engine-session ownership", async () => {
    dir = mkdtempSync(join(tmpdir(), "engine-session-map-"));
    previous = __setEngineSessionMapPathForTest(join(dir, "map.json"));
    await initializeManagedEngineSessionOwners(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
    await recordEngineSessionOwner("engine-1", "session-1");
    expect(sessionForEngineId("engine-1")).toBe("session-1");
  });

  test("builders round-trip through the shared parser", () => {
    const lines = [
      transcriptLineUser("hello", "u1", "2026-01-01T00:00:00.000Z"),
      transcriptLineAssistantText("hi", "a1", "2026-01-01T00:00:01.000Z", "pi/anthropic/claude-fable-5"),
      transcriptLineToolUse("tool-1", "read", { path: "README.md" }),
      transcriptLineToolResult("tool-1", "contents"),
      transcriptLineRunnerNotice("retrying"),
      transcriptLineCompactionSummary("summary"),
    ];
    const entries = parseJsonlLines(lines.map((line) => JSON.stringify(line)));
    expect(entries.map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
      "tool_use",
      "tool_result",
      "system",
      "system",
    ]);
  });
});
