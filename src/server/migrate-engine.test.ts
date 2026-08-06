import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setSessionsDirForTest } from "./paths";

const scratch = mkdtempSync(join(tmpdir(), "migrate-engine-test-"));
const prevDir = __setSessionsDirForTest(scratch);

// Import AFTER repointing the sessions dir isn't required (the module reads the
// live binding per call), but cache-bust anyway for isolation.
const { migrateSessionEngine, isAutomationOwnedSession, sessionHasJournaledRun } =
  await import(`./migrate-engine.ts?test=${crypto.randomUUID()}`);

function writeSession(id: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(scratch, `${id}.json`),
    JSON.stringify({
      id,
      claudeSessionId: "11111111-2222-7000-8000-000000000000",
      branch: "",
      worktreeDir: "/tmp",
      createdBy: "Alex",
      createdAt: "2026-07-08T00:00:00.000Z",
      lastActivity: "2026-07-08T00:00:00.000Z",
      model: "claude-haiku-4-5",
      ...extra,
    })
  );
}

beforeAll(() => {
  writeSession("bks-mig-ok");
  writeSession("bks-mig-automation", { automation: "plain triage" });
  writeSession("bks-mig-automation2", { createdBy: "triage (automation)" });
  writeSession("bks-mig-busy");
  writeFileSync(
    join(scratch, "active-runs.json"),
    JSON.stringify({
      runkey1: { runKey: "runkey1", osSessionId: "bks-mig-busy", cwd: "/tmp", startedAt: "now" },
    })
  );
});

afterAll(() => {
  __setSessionsDirForTest(prevDir);
  rmSync(scratch, { recursive: true, force: true });
});

describe("migrateSessionEngine", () => {
  test("flips the model and records modelHistory", () => {
    const res = migrateSessionEngine(
      "bks-mig-ok",
      "opencode/anthropic/claude-haiku-4-5",
      "tester"
    );
    expect(res).toMatchObject({
      ok: true,
      from: "claude-haiku-4-5",
      to: "opencode/anthropic/claude-haiku-4-5",
    });
    const data = JSON.parse(readFileSync(join(scratch, "bks-mig-ok.json"), "utf-8"));
    expect(data.model).toBe("opencode/anthropic/claude-haiku-4-5");
    expect(data.claudeSessionId).toBe("11111111-2222-7000-8000-000000000000"); // untouched
    expect(data.modelHistory).toHaveLength(1);
    expect(data.modelHistory[0]).toMatchObject({
      model: "opencode/anthropic/claude-haiku-4-5",
      from: "claude-haiku-4-5",
      by: "tester",
    });
    // Idempotent: same target again is ok, no duplicate history entry.
    const again = migrateSessionEngine("bks-mig-ok", "opencode/anthropic/claude-haiku-4-5");
    expect(again.ok).toBe(true);
    expect(
      JSON.parse(readFileSync(join(scratch, "bks-mig-ok.json"), "utf-8")).modelHistory
    ).toHaveLength(1);
  });

  test("rejects non-opencode targets", () => {
    const res = migrateSessionEngine("bks-mig-ok", "claude-sonnet-5");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not an opencode engine model");
  });

  test("rejects automation-owned sessions (both markers)", () => {
    for (const id of ["bks-mig-automation", "bks-mig-automation2"]) {
      const res = migrateSessionEngine(id, "opencode/anthropic/claude-haiku-4-5");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("automation-owned");
    }
    expect(isAutomationOwnedSession({ automation: "x", createdBy: "y" })).toBe(true);
    expect(isAutomationOwnedSession({ createdBy: "Alex" })).toBe(false);
  });

  test("rejects sessions with an in-flight journaled run", () => {
    expect(sessionHasJournaledRun("bks-mig-busy")).toBe(true);
    const res = migrateSessionEngine("bks-mig-busy", "opencode/anthropic/claude-haiku-4-5");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("in-flight");
  });

  test("rejects unknown sessions", () => {
    const res = migrateSessionEngine("bks-nope", "opencode/anthropic/claude-haiku-4-5");
    expect(res.ok).toBe(false);
  });
});
