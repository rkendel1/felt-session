import { describe, expect, test } from "bun:test";

const read = (relative: string) =>
  Bun.file(new URL(relative, import.meta.url)).text();

describe("shutdown intake fence", () => {
  test("parks automation scheduler, webhook, and direct runs", async () => {
    const source = await read("./automations.ts");
    const run = source.indexOf("export async function runAutomation(");
    const shutdown = source.indexOf("if (isShuttingDown())", run);
    expect(source.indexOf("persistAutomationIntent({", run)).toBeLessThan(shutdown);
    expect(shutdown).toBeLessThan(source.indexOf("runningCounts.set", run));
    expect(source).toContain(
      "schedulerInterval = setInterval(() => {\n    if (isShuttingDown()) return;",
    );
    expect(
      source.match(
        /return Response\.json\(\{ error: "Server restarting" \}, \{ status: 503 \}\)/g,
      )?.length,
    ).toBe(2);
    expect(source).toContain("export function resumePendingAutomationRuns(");
    expect(source).toContain("osSessionId: intent.sessionId");
    expect(source).toContain("acceptedAt: intent.acceptedAt");
    expect(source).toContain("const startedAt = new Date(acceptedAt)");
    expect(source).toContain("automationPreparations.has(intent.sessionId)");
    expect(source).toContain("activeAutomationIntentSessions.has(intent.sessionId)");
    expect(source).toContain(
      "activeRunRecords().some((run) => run.osSessionId === intent.sessionId)",
    );
    expect(source).toContain("resumePendingAutomationRuns(onSessionCreated)");
    expect(source).toContain("recordAutomationIntentTerminal(");
    const streamAdoption = source.indexOf("for await (const event of events)");
    const terminal = source.indexOf("recordAutomationIntentTerminal(bksId", streamAdoption);
    const settle = source.indexOf("settleRun(automation.id, bksId", terminal);
    expect(terminal).toBeLessThan(settle);
    expect(settle).toBeLessThan(
      source.indexOf("clearAutomationIntent(bksId)", settle),
    );
    expect(source).toContain("if (!hasAutomationIntent(osSessionId))");
    expect(
      source.indexOf("automationPreparations.delete(bksId)", streamAdoption),
    ).toBeGreaterThan(streamAdoption);
    const cleanup = source.indexOf("} finally {", streamAdoption);
    expect(
      source.indexOf("automationPreparations.delete(bksId)", cleanup),
    ).toBeGreaterThan(cleanup);
  });

  test("parks new GitHub reviews before claiming their lock", async () => {
    const source = await read("../agents/github/review.ts");
    const review = source.indexOf("export async function runReview(");
    expect(source.indexOf("if (isShuttingDown())", review)).toBeLessThan(
      source.indexOf('claimLock("review"', review),
    );
    expect(source).toContain("preserveRecovery = true");
    expect(source).toContain("review parked for restart");
    expect(source).toContain("review repair parked for restart");
    expect(source).not.toContain(
      "if (cancellationRequested() || isShuttingDown())",
    );
  });

  test("counts accepted automation setup and resumes its durable intent", async () => {
    const source = await read("../../opensession.ts");
    expect(source).toContain("activeAutomationPreparationCount(),");
    expect(source.indexOf("activeAutomationPreparationCount(),")).toBeLessThan(
      source.indexOf("activeAgentRunCount() - activeDetachedAgentRunCount()"),
    );
    expect(source).toContain("resumePendingAutomationRuns(onAutomationSession)");
  });

  test("does not start a queued boot recovery after shutdown begins", async () => {
    const source = await read("./agent-runner.ts");
    const recovery = source.indexOf("const recoveryTask = (");
    const start = source.indexOf("const start = async () =>", recovery);
    expect(source.indexOf("if (started || isShuttingDown()) return", start)).toBeGreaterThan(start);
    expect(source.indexOf("if (started || isShuttingDown()) return", start)).toBeLessThan(
      source.indexOf("started = true", start),
    );
  });
});
