import React, { useEffect, useState, useCallback, useMemo } from "react";
import type { PrDetails } from "../lib/types";
import { fetchPr, fetchPrDiff, postPrCommentApi, mergePrApi } from "../lib/api";
import { CommentableDiff, type CommentTarget } from "./CommentableDiff";
import { getCurrentUser } from "./UserPicker";

interface Props {
  sessionId: string;
  /** When provided, renders an "Open session →" action (used by the Reviews view). */
  onOpenSession?: () => void;
  /** Side-by-side info|diff layout for wide containers (the Reviews drawer). */
  split?: boolean;
}

interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
}

export function PrPanel({ sessionId, onOpenSession, split }: Props) {
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [diff, setDiff] = useState<PrDiffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastCommentUrl, setLastCommentUrl] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [prData, diffData] = await Promise.all([
        fetchPr(sessionId),
        fetchPrDiff(sessionId).catch(() => null),
      ]);
      setPr(prData);
      setDiff(diffData);
    } catch {
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  async function handlePrComment(target: CommentTarget, text: string) {
    const result = await postPrCommentApi(sessionId, {
      text,
      user: getCurrentUser(),
      path: target.path,
      line: target.endLine,
      startLine: target.startLine !== target.endLine ? target.startLine : undefined,
      side: target.side === "deletions" ? "LEFT" : "RIGHT",
    });
    setLastCommentUrl(result.url || null);
  }

  // Two-click confirm guards against accidental merges (this mutates the repo).
  async function handleMerge() {
    if (!confirmMerge) {
      setConfirmMerge(true);
      setMergeError(null);
      setTimeout(() => setConfirmMerge(false), 4000);
      return;
    }
    setConfirmMerge(false);
    setMerging(true);
    setMergeError(null);
    try {
      await mergePrApi(sessionId, "squash");
      await load();
    } catch (e: any) {
      setMergeError(e.message || "Merge failed");
    } finally {
      setMerging(false);
    }
  }

  // Roll the per-check list up into headline counts, and surface failing checks
  // first so a reviewer sees what's broken without expanding the whole list.
  const checkSummary = useMemo(() => {
    const checks = pr?.checks || [];
    let passed = 0,
      failed = 0,
      pending = 0;
    for (const c of checks) {
      const cls = checkClass(c.status, c.conclusion);
      if (cls === "check-success") passed++;
      else if (cls === "check-failure") failed++;
      else if (cls === "check-pending") pending++;
    }
    const sorted = [...checks].sort((a, b) => {
      const rank = (c: PrCheckRank) =>
        c === "check-failure" ? 0 : c === "check-pending" ? 1 : c === "check-success" ? 3 : 2;
      return rank(checkClass(a.status, a.conclusion)) - rank(checkClass(b.status, b.conclusion));
    });
    return { passed, failed, pending, total: checks.length, sorted };
  }, [pr]);

  if (loading) return <div className="panel-placeholder">Loading PR…</div>;
  if (!pr) return <div className="panel-placeholder">No pull request for this branch yet</div>;

  const stateClass =
    pr.state === "MERGED" ? "pr-pill-merged" : pr.state === "CLOSED" ? "pr-pill-closed" : pr.isDraft ? "pr-pill-draft" : "pr-pill-open";
  const stateLabel = pr.state === "OPEN" && pr.isDraft ? "Draft" : pr.state.charAt(0) + pr.state.slice(1).toLowerCase();

  return (
    <div className={`pr-panel ${split ? "pr-panel-split" : ""}`}>
      <div className="pr-panel-info">
      <div className="pr-head">
        <span className={`pr-pill ${stateClass}`}>{stateLabel}</span>
        <a className="pr-number" href={pr.url} target="_blank" rel="noopener">
          #{pr.number}
        </a>
        <button className="btn-icon" onClick={load} title="Refresh">↻</button>
      </div>

      <a className="pr-title" href={pr.url} target="_blank" rel="noopener">
        {pr.title}
      </a>

      <div className="pr-meta">
        <span className="pr-branch">
          {pr.headRefName} → {pr.baseRefName}
        </span>
        <span>
          {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
          {" "}<span className="diff-add">+{pr.additions}</span>{" "}
          <span className="diff-del">−{pr.deletions}</span>
        </span>
        {pr.reviewDecision && (
          <span className={`pr-review pr-review-${pr.reviewDecision.toLowerCase()}`}>
            {pr.reviewDecision.replaceAll("_", " ").toLowerCase()}
          </span>
        )}
      </div>

      {pr.checks.length > 0 && (
        <div className="pr-checks">
          <button
            className="pr-checks-summary"
            onClick={() => setChecksOpen((o) => !o)}
            aria-expanded={checksOpen}
          >
            <span
              className={`pr-checks-status ${
                checkSummary.failed > 0
                  ? "pr-sum-fail"
                  : checkSummary.pending > 0
                    ? "pr-sum-pending"
                    : "pr-sum-pass"
              }`}
            >
              {checkSummary.failed > 0
                ? "Some checks failed"
                : checkSummary.pending > 0
                  ? "Checks running"
                  : "All checks passed"}
            </span>
            <span className="pr-checks-counts">
              {checkSummary.passed > 0 && (
                <span className="pr-count check-success-text">✓ {checkSummary.passed}</span>
              )}
              {checkSummary.failed > 0 && (
                <span className="pr-count check-failure-text">✕ {checkSummary.failed}</span>
              )}
              {checkSummary.pending > 0 && (
                <span className="pr-count check-pending-text">● {checkSummary.pending}</span>
              )}
            </span>
            <span className="pr-checks-chevron">{checksOpen ? "▾" : "▸"}</span>
          </button>
          {checksOpen &&
            checkSummary.sorted.map((check, i) => (
              <a
                key={i}
                className="pr-check"
                href={check.url}
                target="_blank"
                rel="noopener"
              >
                <span className={`pr-check-dot ${checkClass(check.status, check.conclusion)}`} />
                <span className="pr-check-name">{check.name}</span>
                <span className="pr-check-state">
                  {(check.conclusion || check.status).toLowerCase()}
                </span>
              </a>
            ))}
        </div>
      )}

      {pr.body && (
        <div className="pr-body">
          <div className="pr-checks-title">Description</div>
          <pre className="pr-body-text">{pr.body.slice(0, 3000)}</pre>
        </div>
      )}

      <div className="pr-actions">
        <a className="btn-open-pr" href={pr.url} target="_blank" rel="noopener">
          Open on GitHub ↗
        </a>
        {pr.state === "OPEN" && !pr.isDraft && (
          <button
            className={`btn-merge-pr ${confirmMerge ? "btn-merge-confirm" : ""}`}
            onClick={handleMerge}
            disabled={merging}
            title="Squash and merge this PR into its base branch"
          >
            {merging ? "Merging…" : confirmMerge ? "Confirm squash & merge" : "Squash & merge"}
          </button>
        )}
        {onOpenSession && (
          <button className="btn-open-session" onClick={onOpenSession}>
            Open session →
          </button>
        )}
      </div>
      {mergeError && <div className="pr-merge-error">{mergeError}</div>}
      </div>

      {diff?.patch && (
        <div className="pr-panel-diff">
        <div className="pr-diff-section">
          <div className="pr-checks-title">
            Review — comments land on the PR
            {lastCommentUrl && (
              <a className="pr-comment-link" href={lastCommentUrl} target="_blank" rel="noopener">
                last comment ↗
              </a>
            )}
          </div>
          <CommentableDiff
            patch={diff.patch}
            submitLabel="Comment on PR"
            placeholder={`Review comment — posts on #${diff.number} as an inline comment…`}
            onSubmit={handlePrComment}
          />
        </div>
        </div>
      )}
    </div>
  );
}

type PrCheckRank = "check-success" | "check-failure" | "check-pending" | "check-neutral";

function checkClass(status: string, conclusion: string): PrCheckRank {
  if (status !== "COMPLETED" && status !== "") return "check-pending";
  switch (conclusion) {
    case "SUCCESS":
      return "check-success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ERROR":
      return "check-failure";
    default:
      return "check-neutral";
  }
}
