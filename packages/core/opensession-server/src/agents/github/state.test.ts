import { beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const {
  activeRunCancellationRequested,
  getOrInitPrState,
  readPrState,
  recordReviewed,
  requestActiveRunCancellation,
  setPendingMention,
  updatePrState,
  initializeManagedGithubPrState,
} = await import("./state");

const PR = 990101;
const HEAD = "some-feature-branch";

beforeEach(async () => {
  await initializeManagedGithubPrState(
    createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
    `/tmp/missing-github-state-${crypto.randomUUID()}`,
  );
});

function pendingMention(commentId: number) {
  return {
    kind: "issue" as const,
    commentId,
    body: "@bot please look at this",
    author: "someone",
    receivedAt: new Date().toISOString(),
  };
}

describe("concurrent writers on one PR's state", () => {
  test("imports legacy PR state once and removes its file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "github-pr-state-legacy-"));
    const path = join(dir, `${PR}.json`);
    writeFileSync(path, JSON.stringify({
      prNumber: PR,
      headRef: HEAD,
      reviewedShas: ["aaaaaaa"],
      updatedAt: new Date().toISOString(),
    }));
    await initializeManagedGithubPrState(
      createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
      dir,
    );
    expect(readPrState(PR)?.reviewedShas).toEqual(["aaaaaaa"]);
    expect(existsSync(path)).toBe(false);
  });

  // Reviews and code actions hold DIFFERENT locks by design, so their windows
  // overlap: a mention webhook lands while a review is awaiting network work.
  test("a review-lane commit keeps a mention marker that landed mid-flight", async () => {
    // The review's early read, taken before its (slow) model run.
    const snapshot = getOrInitPrState(PR, HEAD);
    await updatePrState(PR, HEAD, (s) => { s.summaryCommentId = 11; });

    // A mention webhook arrives while the review is still awaiting.
    await setPendingMention(PR, pendingMention(7));

    // The review's commit point, after the await.
    await recordReviewed(PR, HEAD, "bbbbbbb", {
      verdict: "comment",
      confidence: 4,
      findings: 2,
      blocking: 0,
      sha: "bbbbbbb",
      at: new Date().toISOString(),
    });

    const after = readPrState(PR)!;
    // pendingMention exists to survive a crash in exactly this window; writing a
    // pre-await snapshot back would have reverted it.
    expect(after.pendingMention?.commentId).toBe(7);
    expect(after.lastReviewedSha).toBe("bbbbbbb");
    expect(after.reviewedShas).toContain("bbbbbbb");
    expect(after.summaryCommentId).toBe(11);
    // The snapshot the review started from never saw the mention.
    expect(snapshot.pendingMention).toBeUndefined();
  });

  test("a code-lane commit keeps the review verdict written during its run", async () => {
    const pr = PR + 1;
    await updatePrState(pr, HEAD, (s) => {
      s.autoFix = { active: true, iterations: 1, startedAt: new Date().toISOString() };
    });

    // The review lane records its verdict while the auto-fix loop is running.
    await recordReviewed(pr, HEAD, "ccccccc", {
      findings: 0,
      blocking: 0,
      sha: "ccccccc",
      at: new Date().toISOString(),
    });

    // The loop's own locals win for its own fields, and nothing else is touched.
    await updatePrState(pr, HEAD, (s) => {
      if (s.autoFix) { s.autoFix.active = false; s.autoFix.iterations = 3; s.autoFix.lastPushedSha = "ddddddd"; }
    });

    const after = readPrState(pr)!;
    expect(after.autoFix).toMatchObject({ active: false, iterations: 3, lastPushedSha: "ddddddd" });
    expect(after.lastReview?.sha).toBe("ccccccc");
    expect(after.lastReviewedSha).toBe("ccccccc");
  });

  test("a review cancellation is durable and kind-scoped", async () => {
    const pr = PR + 2;
    await updatePrState(pr, HEAD, (s) => {
      s.activeRun = {
        kind: "review",
        requestedBy: "Kent",
        startedAt: new Date().toISOString(),
      };
    });

    expect(await requestActiveRunCancellation(pr, HEAD, "review")).toBe(true);
    expect(activeRunCancellationRequested(pr, "review")).toBe(true);
    expect(await requestActiveRunCancellation(pr, HEAD, "simplify")).toBe(false);
    expect(readPrState(pr)?.activeRun?.cancelRequestedAt).toBeTruthy();
  });
});
