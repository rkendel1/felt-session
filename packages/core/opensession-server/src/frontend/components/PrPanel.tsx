import { repoLabel } from "../lib/repo-label";
import { AGENT_NAME } from "../lib/brand";
import { randomUUID } from "../lib/random-uuid";
import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  useRef,
} from "react";
import type {
  GitStatusInfo,
  DiffFileGroup,
  PrCheck,
  PrDetails,
  CodeFlowResult,
  SessionWalkthrough,
  UnifiedSession,
  WSServerMessage,
} from "../lib/types";
import { PrSessionsList, prRelatedSessions } from "./PrSessions";
import { WalkthroughCard } from "./WalkthroughCard";
import { DiffPanel } from "./DiffPanel";
import {
  API_BASE,
  fetchPr,
  fetchPrDiff,
  fetchPrCodeFlow,
  fetchPrDiffGroups,
  fetchPrReviewThreads,
  fetchPrViewedFiles,
  fetchPrFile,
  setPrFileViewed,
  fetchGitStatus,
	publishPrApi,
  fetchReviewGuide,
  fetchWorktreeFile,
  saveWorktreeFile,
  submitPrReviewApi,
  mergePrApi,
  closePrApi,
  unlinkPrApi,
} from "../lib/api";
import {
  fetchPrPreview,
  fetchPrPreviewDiff,
  fetchPrPreviewCodeFlow,
  fetchPrPreviewGuide,
  submitPrPreviewReviewApi,
  mergePrPreviewApi,
  closePrPreviewApi,
} from "../lib/api";
import type { PrReviewThread } from "../lib/api/prs";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { toast } from "../ui/toast";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  CommentableDiff,
  type CommentTarget,
  type PendingComment,
} from "./CommentableDiff";
import { SelectionToSession } from "./SelectionToSession";
import { getCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { renderPrCommentMarkdown } from "../lib/markdown";
import { useMarkdownRepo } from "./MarkdownBody";
import { isOutdatedReviewComment } from "../lib/pr-comments";
import {
  dedupeTargets,
  matchFocusTarget,
  type PrFocus,
  type PrTarget,
} from "../lib/pr-focus";
import { providerFromUrl, prCapabilities } from "../lib/provider";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import {
  WS_SUMMARY_REVIEW_CANVAS_CLEARANCE,
} from "../lib/workspace-summary-classes";
import { Textarea } from "../ui/input";
import {
  IconBranches,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconDotsHorizontal,
  IconGitMerge,
  IconGlobe,
  IconMessage,
  IconPullRequest,
  IconSliders,
  IconUndo,
  IconX,
} from "./icons";
import { Menu, MENU_ICON } from "../ui/menu";
import { Modal, useEnterOnMount } from "../ui/modal";
import { Tooltip } from "../ui/tooltip";
import { TopBar } from "../ui/top-bar";
import { Popover } from "../ui/popover";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingRow } from "../ui/setting-row";
import {
  CodeDisplaySettings,
  CodeOrganizationSettings,
  DiffSourceSetting,
} from "./CodeDisplaySettings";
import {
  useCodeDisplaySettings,
  useCodeOrganizationSettings,
} from "../hooks/useCodeDisplaySettings";

import { checkClass, isDeployment, summarize } from "../lib/pr-status-derive";
import { prStatusMark } from "../lib/pr-status";
import { PR_NO_PR_BAR, PR_REPO_TABS } from "../lib/pr-tone-classes";
import { formatPrCommentPrompt, stripHtmlComments } from "../lib/pr-prompts";
import { CheckRow } from "./pr/CheckRow";
import { PrStateIcon } from "./pr/PrStateIcon";
import { ConversationView } from "./pr/PrViews";
import { LinkPrControl } from "./pr/LinkPrControl";
import { PrCard } from "./pr/PrCard";
import { MergeUndoControl } from "./pr/MergeUndoControl";
import { StackLinkSection } from "./pr/Stack";
import { PrStackChip } from "./pr/StackPopover";
import { ReviewRail } from "./pr/ReviewRail";
import { GitStatusRows } from "./pr/GitStatus";
import { ReviewToolbar } from "./pr/ReviewToolbar";
import { EmptyState, LoadingState } from "../ui/state";
import { CodeFlow } from "./CodeFlow";
import { revealDiffFile } from "../lib/diff-navigation";
import { PrFileTree } from "./pr/PrFileTree";
import { reviewDiffLoadPolicy } from "../lib/review-diff";
import { BrandMark } from "./BrandTile";
import { useCopy } from "../ui/copy";
import { useDeferredMergePhase } from "../hooks/useDeferredMerge";
import {
  cancelDeferredMergeByKey,
  deferredMergeKey,
  scheduleDeferredMerge,
} from "../lib/deferred-merge";

// Re-exported so existing importers of these (formerly local) helpers keep working.
export {
  checkClass,
  isDeployment,
  formatPrCommentPrompt,
  CheckRow,
  PrStateIcon,
};

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

type CodeView = "all" | "guide" | "flow";
type DiffSource = "pull-request" | "worktree";
export type PrReviewPage = "overview" | "files";

const NO_PR_FILES: NonNullable<PrDetails["files"]> = [];
const NOOP_SEND = () => {};

interface Props {
  sessionId: string;
  /** When provided, the review action bar offers "Open workspace" (Reviews view). */
  onOpenSession?: () => void;
  /** Append PR/check/comment context to this session's composer draft. */
  onAddToInput?: (text: string) => void;
  /**
   * Repos in this session (primary + attached). Together with `linkedPrs`
   * these form the PR targets; when more than one, a tab bar selects which PR
   * to show. Omit for single-repo callers (e.g. the Reviews drawer) — they
   * target the primary branch as before.
   */
  repos?: Array<{ repo: string; primary: boolean }>;
  /** PRs manually linked to the session (session.linkedPrs) — extra targets. */
  linkedPrs?: LinkedPrEntry[];
  /**
   * PRs the server discovered through the session link in their body footer
   * (`session.prs` entries with source "discovered") — the PRs this session
   * opened on branches it doesn't own. Same tabs as a linked PR, minus the
   * unlink affordance: the link is derived from the PR itself, not stored.
   */
  discoveredPrs?: LinkedPrEntry[];
  /**
   * Preselect one of the targets — the PR chips in the Workspace strip, and
   * `repo#123` mentions in prose, open the Review tab on a specific PR. `seq`
   * is bumped per click so clicking the same chip again re-focuses it after
   * the user has switched tabs by hand. See lib/pr-focus.ts for the matching.
   */
  focusTarget?: PrFocus;
  /** Offer the "Link PR" affordance (session Review tab; off in the Reviews drawer). */
  linkable?: boolean;
  /**
   * WebSocket sender. When provided, selecting text in the PR info column shows a
   * "Send to session" popover that delivers the selection + a message to this PR's
   * session (via a `prompt` message — the server steers/queues if it's busy).
   */
  send?: (msg: any) => void;
  /** Agent-published walkthrough (session.walkthrough) — rendered at the top
   *  of the info column; its mirrored section is stripped from the PR body. */
  walkthrough?: SessionWalkthrough;
  /**
   * Allow in-place edit mode (@pierre/diffs edit) on the review canvas's diff.
   * Only meaningful for callers whose session backs the shown PR with a live
   * worktree; carries the same agent-idle gate as the Changes tab (edits and
   * agent writes must not race). Linked/discovered PRs and session-less
   * previews stay read-only regardless.
   */
  editGate?: boolean;
  /** Session-less PR target; uses the same canvas with repo+branch APIs. */
  previewTarget?: { repo: string; branch: string };
  /**
   * Live sessions list. When provided, the panel surfaces every session
   * linked to the shown PR (matched by repo + head branch / number) and — with
   * `send` — offers starting a new session on the PR's head branch.
   */
  sessions?: UnifiedSession[];
  /** Navigate to a session picked from the linked-sessions list. */
  onOpenSessionById?: (id: string) => void;
  /** Open another PR in this panel — used by the stack map to move between
   *  layers in-app. Without it the layer rows still link, just via a full
   *  page load. */
  onOpenPr?: (repo: string, branch: string) => void;
  /** WS handler hook — resets the new-session form on server errors. */
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
  /** The surrounding review header already offers the workspace summary.
   * Keep this panel's metadata rail only when it stacks for a narrow canvas. */
  hideWideOverviewRail?: boolean;
  /** Controlled page for hosts that move Review navigation into the summary. */
  page?: PrReviewPage;
  onPageChange?: (page: PrReviewPage) => void;
  /** Move file controls into the identity row and omit the secondary row. */
  compactToolbar?: boolean;
  /** Legacy caller hint; Review now keeps its desktop top inset either way. */
  flushToolbarTop?: boolean;
}

interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
  diffVersion?: string;
  skippedFiles?: number;
}

/** A PR manually linked to the session (mirrors session.linkedPrs entries). */
export interface LinkedPrEntry {
  repo: string;
  branch: string;
  number?: number;
  url?: string;
  title?: string;
}

const NO_LINKED_PRS: LinkedPrEntry[] = [];

/** One narrative section of the AI review guide (mirrors the server shape). */
interface ReviewGuideSection {
  title: string;
  explanation: string;
  files: string[];
}

export interface ReviewGuideData {
  number: number;
  headRefOid: string;
  sections: ReviewGuideSection[];
}

/** Split a unified diff into per-file chunks keyed by the new-side path. */
function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (m) map.set(m[2], part);
  }
  return map;
}

/**
 * Pair each guide section with the slice of the unified diff covering its
 * files (so inline commenting keeps working inside the guide). Model paths are
 * matched exactly, then by suffix; files no section claimed come back as a
 * trailing "Everything else" section so guide mode never hides part of a PR.
 */
export function sectionsWithPatches(guide: ReviewGuideData, patch: string) {
  const byFile = splitPatchByFile(patch);
  const unclaimed = new Set(byFile.keys());
  // A suffix match can only ever pair two paths that end in the same segment,
  // so bucket the patch's paths by basename once rather than scanning every
  // one of them per section file.
  const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const byBasename = new Map<string, string[]>();
  for (const path of byFile.keys()) {
    const bucket = byBasename.get(basename(path));
    if (bucket) bucket.push(path);
    else byBasename.set(basename(path), [path]);
  }
  const resolve = (file: string): string | null => {
    if (byFile.has(file)) return file;
    for (const path of byBasename.get(basename(file)) ?? [])
      if (path.endsWith(`/${file}`) || file.endsWith(`/${path}`)) return path;
    return null;
  };
  const out = guide.sections.map((s) => {
    const chunks: string[] = [];
    for (const file of s.files) {
      const path = resolve(file);
      if (!path || !unclaimed.has(path)) continue;
      unclaimed.delete(path);
      chunks.push(byFile.get(path)!);
    }
    return { ...s, patch: chunks.join("") };
  });
  if (unclaimed.size > 0)
    out.push({
      title: "Everything else",
      explanation: "Changes the guide didn't group into a section.",
      files: [...unclaimed],
      patch: [...unclaimed].map((f) => byFile.get(f)!).join(""),
    });
  return out;
}

export function PrPanel({
  sessionId,
  onOpenSession,
  onAddToInput,
  repos,
  linkedPrs,
  discoveredPrs,
  focusTarget,
  linkable,
  send,
  walkthrough,
  editGate,
  previewTarget,
  sessions,
  onOpenSessionById,
  onOpenPr,
  addHandler,
  hideWideOverviewRail = false,
  page: controlledPage,
  onPageChange,
  compactToolbar = false,
}: Props) {
  // Local copy of the linked-PR list so link/unlink applies instantly; the
  // sessions list catches up on its next refresh.
  const [linkedLocal, setLinkedLocal] = useState<LinkedPrEntry[] | null>(null);
  // One identity for "no linked PRs", or the `targets` memo below re-runs on
  // every render for the (common) session with none.
  const linked = linkedLocal ?? linkedPrs ?? NO_LINKED_PRS;
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const targets = (dedupeTargets([
      ...(previewTarget
        ? [
            {
              key: `preview:${previewTarget.repo}:${previewTarget.branch}`,
              repo: previewTarget.repo,
              branch: previewTarget.branch,
              primary: true,
              label: previewTarget.repo,
            },
          ]
        : (repos ?? []).map((r) => ({
            key: r.repo,
            repo: r.repo,
            primary: r.primary,
            label: r.repo,
          }))),
      ...linked.map((lp) => ({
        key: `${lp.repo} ${lp.branch}`,
        repo: lp.repo,
        branch: lp.branch,
        number: lp.number,
        linked: true,
        label: lp.number
          ? `${repoLabel(lp.repo)} #${lp.number}`
          : `${repoLabel(lp.repo)}:${lp.branch}`,
      })),
      // Last, so an explicit link (which owns the unlink affordance) wins the
      // dedupe over the same PR discovered from its body footer.
        ...(previewTarget ? [] : (discoveredPrs ?? [])).map((dp) => ({
        key: `${dp.repo} ${dp.branch}`,
        repo: dp.repo,
        branch: dp.branch,
        number: dp.number,
        discovered: true,
        label: dp.number
          ? `${repoLabel(dp.repo)} #${dp.number}`
          : `${repoLabel(dp.repo)}:${dp.branch}`,
      })),
    ]));
  const [activeKey, setActiveKey] = useState<string | undefined>(
    () => (targets.find((t) => t.primary) ?? targets[0])?.key,
  );
  const active = targets.find((t) => t.key === activeKey) ?? targets[0];
  const loadTargetKey = previewTarget
    ? `preview:${previewTarget.repo}:${previewTarget.branch}`
    : active?.key || sessionId;
  // Scalars so the loaders below can be useCallback'd on stable values
  // instead of the per-render preview object.
  const previewRepo = previewTarget?.repo;
  const previewBranch = previewTarget?.branch;
  // `#5528` in a PR body or review comment means a PR in the repo THIS panel is
  // showing — which is the attached repo's, not the session's, when the strip
  // is on a sibling PR. Only fall back to the surrounding surface's repo.
  const contextRepo = useMarkdownRepo();
  const markdownRepo = previewTarget?.repo || active?.repo || contextRepo;
  const [pr, setPr] = useState<PrDetails | null>(null);
  const mergeKey = deferredMergeKey(pr?.url);
  const mergePhase = useDeferredMergePhase(mergeKey);
  const merging = mergePhase === "running";
  const mergeScheduled = mergePhase === "scheduled";
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [loadedDiff, setDiff] = useState<PrDiffData | null>(null);
  const diff = loadedDiff?.headRefOid === pr?.headRefOid ? loadedDiff : null;
  const diffOutOfDate = !!loadedDiff && !diff;
  const diffLoadPolicy = reviewDiffLoadPolicy(
    diff?.patch.length ?? 0,
    pr?.changedFiles ?? 0,
  );
  const [diffGroups, setDiffGroups] = useState<{
    oid: string;
    groups: DiffFileGroup[] | null;
  } | null>(null);
  const [diffGroupsLoading, setDiffGroupsLoading] = useState(false);
  const [diffGroupsRetry, setDiffGroupsRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(true);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>("APPROVE");
  // Only the dialog's opening value and what it hands back on close. The live
  // field lives in FinishReviewDialog: a keystroke here would re-render every
  // mounted file of the diff behind it.
  const [summaryDraft, setSummaryDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  // The branch has no PR yet and the server is publishing it. The server only
  // returns success after both Git and GitHub confirm the operation.
  const [prRequested, setPrRequested] = useState(false);
  useEffect(() => {
    if (!prRequested) return;
    const timer = window.setTimeout(() => setPrRequested(false), 6000);
    return () => window.clearTimeout(timer);
  }, [prRequested]);
  const { copy: copyPrLink } = useCopy();
  // Merging is a separate decision from approving, so it starts off: the
  // reviewer opts into it, and the primary action stays "Approve".
  const [mergeAfterReview, setMergeAfterReview] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  /**
   * The review is two places, not six tabs: Overview (the conversation and the
   * PR's metadata) and Files changed (the code). `codeView` is which lens the
   * code page uses, held apart from the page so a trip to Overview and back
   * never re-triggers guide or code-flow generation.
   */
  const [localPage, setLocalPage] = useState<PrReviewPage>("files");
  const page = controlledPage ?? localPage;
  const setPage = (next: PrReviewPage) => {
      setLocalPage(next);
      onPageChange?.(next);
    };
  const [codeView, setCodeView] = useState<"all" | "guide" | "flow">("all");
  const [diffSource, setDiffSource] = useState<DiffSource>("pull-request");
  const worktreeAvailable =
    !!sessionId && !previewTarget && !active?.linked && !active?.discovered;
  const sessionRunning = !!sessions?.find(
    (session) => session.id === sessionId,
  )?.isRunning;
  useEffect(() => setDiffSource("pull-request"), [loadTargetKey]);
  /** A check chip elsewhere in the app asked for the checks (focusTarget). */
  const [focusChecksSeq, setFocusChecksSeq] = useState(0);
  // A PR chip or prose link can request a target before session PRs arrive.
  // Apply each request once after both the page setters and targets exist.
  const focusApplied = useRef<{ target?: number; checks?: number }>({});
  const applyFocusTarget = useEffectEvent(() => {
    if (!focusTarget) return;
    const { seq } = focusTarget;
    if (focusTarget.repo && focusApplied.current.target !== seq) {
      const match = matchFocusTarget(targets, focusTarget);
      if (match) {
        focusApplied.current.target = seq;
        setActiveKey(match.key);
      }
    }
    if (focusTarget.view === "checks" && focusApplied.current.checks !== seq) {
      focusApplied.current.checks = seq;
      setPage("overview");
      setFocusChecksSeq((prev) => prev + 1);
    }
  });
  useEffect(() => {
    applyFocusTarget();
  }, [focusTarget?.seq, targets]);
  /** A file picked on Overview, waiting for the code page to have its diff. */
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const phoneLayout = window.matchMedia("(max-width: 720px)").matches;
  // Rendering preferences are shared with sidebar Changes, so choosing wrap,
  // split view, highlighting or a theme in either viewer updates the other.
  const codeDisplaySettings = useCodeDisplaySettings(
    phoneLayout ? "unified" : "split",
  );
  const {
    diffStyle,
    wrapLines,
    structuralHighlighting,
    showFileStats,
    codeTheme,
  } = codeDisplaySettings;
  const organizationSettings = useCodeOrganizationSettings();
  const {
    grouping,
    fileListMode,
    fileOrder,
    sortDirection,
    hideReviewed,
  } = organizationSettings;
  // Keyed like the code flow below, so one target's guide never renders under
  // another's diff and a slow response can't land after the panel moved on.
  const [guide, setGuide] = useState<{
    key: string;
    data: ReviewGuideData;
  } | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideFailed, setGuideFailed] = useState(false);
  const guideGenerationRef = useRef(0);
  const [codeFlow, setCodeFlow] = useState<{
    key: string;
    data: CodeFlowResult;
  } | null>(null);
  const [codeFlowLoading, setCodeFlowLoading] = useState(false);
  const [codeFlowError, setCodeFlowError] = useState<string | null>(null);
  const codeFlowGenerationRef = useRef(0);
  // GitHub's per-viewer "Viewed" file state for the shown PR (review canvas
  // checkboxes). Keyed so a stale PR's set never leaks onto the next one.
  const [prViewed, setPrViewed] = useState<{
    key: string;
    prId: string;
    viewed: ReadonlySet<string>;
  } | null>(null);
  const prViewedRef = useRef(prViewed);
  useLayoutEffect(() => {
    prViewedRef.current = prViewed;
  }, [prViewed]);
  const [reviewThreads, setReviewThreads] = useState<{
    key: string;
    threads: PrReviewThread[];
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * The rail collapses on the panel's own width, not the viewport's. In the
   * workspace this panel is flanked by the sidebar and the workspace panel, so
   * it is around 990px inside a 1440px window and `phone:` (a viewport query)
   * never fires for it. Below the threshold the rail stacks above the
   * conversation instead of sitting beside it.
   */
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [diffControlsTarget, setDiffControlsTarget] =
    useState<HTMLDivElement | null>(null);
  const [worktreeToolbarTarget, setWorktreeToolbarTarget] =
    useState<HTMLDivElement | null>(null);
  const [railStacked, setRailStacked] = useState(false);
  const [headerCompact, setHeaderCompact] = useState(
    () => window.matchMedia("(max-width: 720px)").matches,
  );
  const setRoot = (el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  };
  useEffect(() => {
    if (!rootEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setRailStacked(entry.contentRect.width < 880);
      setHeaderCompact(entry.contentRect.width < 640);
    });
    observer.observe(rootEl);
    return () => observer.disconnect();
  }, [rootEl]);
  const loadGenerationRef = useRef(0);
  const activeLoadTargetRef = useRef(loadTargetKey);
  const loadInFlightRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  useLayoutEffect(() => {
    activeLoadTargetRef.current = loadTargetKey;
  }, [loadTargetKey]);

  const load = useCallback(
    (force = false): Promise<void> => {
      if (loadTargetKey !== activeLoadTargetRef.current)
        return Promise.resolve();
    const existing = loadInFlightRef.current;
    if (!force && existing?.key === loadTargetKey) return existing.promise;

    const generation = ++loadGenerationRef.current;
    setDiffLoading(true);
    let prSettled = false;
    let diffSettled = false;
    let prResult: PrDetails | null = null;
    let diffResult: PrDiffData | null = null;
    const isCurrent = () =>
      generation === loadGenerationRef.current &&
      loadTargetKey === activeLoadTargetRef.current;
    const commitDiff = () => {
      if (!isCurrent() || !prSettled || !diffSettled) return;
      setDiff(
        diffResult?.headRefOid === prResult?.headRefOid ? diffResult : null,
      );
      setDiffLoading(false);
    };
      const prRequest = (
        previewRepo && previewBranch
      ? fetchPrPreview(previewRepo, previewBranch)
      : fetchPr(sessionId, active?.repo, active?.branch)
    )
      .then((data) => {
        prSettled = true;
        prResult = data;
        if (isCurrent()) {
          setPr(data);
          setLoadError(null);
        }
        commitDiff();
      })
      .catch((e: any) => {
        prSettled = true;
        prResult = null;
          if (isCurrent())
            setLoadError(e?.message || "Failed to load the pull request.");
        commitDiff();
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
      const diffRequest = (
        previewRepo && previewBranch
      ? fetchPrPreviewDiff(previewRepo, previewBranch)
      : fetchPrDiff(sessionId, active?.repo, active?.branch)
    )
      .then((data) => {
        diffSettled = true;
        diffResult = data;
        if (isCurrent()) setDiffError(null);
        commitDiff();
      })
      .catch((e: any) => {
        diffSettled = true;
        diffResult = null;
          if (isCurrent())
            setDiffError(e?.message || "Failed to load pull request changes.");
        commitDiff();
      });
    // A linked PR has no local worktree in this session — no git state.
      const gitRequest = (
        previewRepo || active?.linked
      ? Promise.resolve(null)
      : fetchGitStatus(sessionId, active?.repo)
    )
      .then((data) => {
        if (isCurrent()) setGit(data);
      })
      .catch(() => {
        if (isCurrent()) setGit(null);
      });
      const reviewThreadsRequest = prRequest.then(async () => {
        if (!prResult) return;
        await (async () => {
const threads = await fetchPrReviewThreads(
            active?.repo,
            prResult.number,
          );
          if (isCurrent()) setReviewThreads({ key: loadTargetKey, threads });
})().catch(async () => {
// Resolved threads are supporting context. A provider or credential
          // failure must not block the diff itself.
});
      });

      const promise = Promise.allSettled([
        prRequest,
        diffRequest,
        gitRequest,
        reviewThreadsRequest,
      ]).then(() => undefined);
    loadInFlightRef.current = { key: loadTargetKey, promise };
      void promise.then(() => {
        if (loadInFlightRef.current?.promise === promise)
          loadInFlightRef.current = null;
      });
      return promise;
    },
    [sessionId, loadTargetKey, previewRepo, previewBranch, active?.repo, active?.branch, active?.linked],
  );

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    setDiffLoading(true);
    setDiffError(null);
    setPr(null);
    setDiff(null);
    setGit(null);
    setPending([]);
    setReviewing(false);
    setReviewOpen(false);
    setPrViewed(null);
    setReviewThreads(null);
    setCodeFlow(null);
    setCodeFlowLoading(false);
    setCodeFlowError(null);
    codeFlowGenerationRef.current += 1;
    load();
    const stopPolling = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
    return () => {
      stopPolling();
      loadGenerationRef.current += 1;
    };
  }, [load]);

  // A GitHub webhook reported activity on the shown PR's branch (review, CI,
  // push, merge) — refetch immediately. Primary targets omit their branch, so
  // match those through the loaded PR number/head branch instead.
  // The server invalidated its caches before broadcasting, so this reads
  // fresh data.
  const hasLoadedPr = pr !== null;
  useEffect(() => {
    if (!addHandler) return;
    return addHandler((msg) => {
      if (msg.type !== "pr_updated") return;
      const branch = previewTarget?.branch ?? active?.branch;
      const repo = previewTarget?.repo ?? active?.repo;
      if (
        msg.repo === repo &&
        (branch
          ? msg.branch === branch
          : !hasLoadedPr || msg.number === pr?.number || msg.branch === pr?.headRefName)
      )
        void load(true);
    });
  }, [
    addHandler,
    load,
    previewTarget?.repo,
    previewTarget?.branch,
    active?.repo,
    active?.branch,
    hasLoadedPr,
    pr?.number,
    pr?.headRefName,
  ]);

  const loadDiffGroups = useEffectEvent(() => {
    const files = pr?.files || [];
    if (!diff?.patch || files.length < 3 || !diffLoadPolicy.groupFiles) {
      setDiffGroups(null);
      setDiffGroupsLoading(false);
      return;
    }
    setDiffGroups(null);
    setDiffGroupsLoading(true);
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryLater = () => {
      retryTimer = setTimeout(
        () => setDiffGroupsRetry((attempt) => attempt + 1),
        125_000,
      );
    };
    fetchPrDiffGroups(
      sessionId,
      files,
      diff.patch,
      active?.repo,
      active?.branch,
    )
      .then((result) => {
        if (!live) return;
        setDiffGroups({ oid: diff.headRefOid, groups: result.groups });
        if (!result.groups) retryLater();
      })
      .catch(() => {
        if (!live) return;
        setDiffGroups({ oid: diff.headRefOid, groups: null });
        retryLater();
      })
      .finally(() => {
        if (live) setDiffGroupsLoading(false);
      });
    return () => {
      live = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  });
  useEffect(() => loadDiffGroups(), [
    sessionId,
    active?.repo,
    active?.branch,
    diff?.headRefOid,
    diffLoadPolicy.groupFiles,
    pr?.files?.length,
    diffGroupsRetry,
  ]);

  // A guide belongs to one target's head commit: the key is what makes a
  // guide from the PR the panel just left read as absent rather than current.
  const guideKey = diff ? `${loadTargetKey}\0${diff.headRefOid}` : "";
  const loadGuide = useCallback(async () => {
    if (!guideKey) return;
    const generation = ++guideGenerationRef.current;
    setGuideLoading(true);
    setGuideFailed(false);
    await (async () => {
const data = previewRepo && previewBranch
        ? await fetchPrPreviewGuide(previewRepo, previewBranch)
        : await fetchReviewGuide(sessionId, active?.repo, active?.branch);
      if (generation !== guideGenerationRef.current) return;
      if (data) setGuide({ key: guideKey, data });
      else setGuideFailed(true);
})().catch(async () => {
if (generation === guideGenerationRef.current) setGuideFailed(true);
}).finally(async () => {
if (generation === guideGenerationRef.current) setGuideLoading(false);
});
  }, [guideKey, sessionId, previewRepo, previewBranch, active?.repo, active?.branch]);

  const prPatchVersion = diff?.diffVersion || "";
  const codeFlowKey =
    diff && prPatchVersion
      ? `${loadTargetKey}\0${diff.headRefOid}\0${prPatchVersion}`
      : "";
  const loadCodeFlow = useCallback(async () => {
    if ((!diff?.patch && !diff?.skippedFiles) || !codeFlowKey) return;
    const generation = ++codeFlowGenerationRef.current;
    setCodeFlowLoading(true);
    setCodeFlowError(null);
    await (async () => {
const data = previewRepo && previewBranch
        ? await fetchPrPreviewCodeFlow(previewRepo, previewBranch)
        : await fetchPrCodeFlow(sessionId, active?.repo, active?.branch);
      if (!data)
        throw new Error("Code flow isn't available for this pull request.");
      if (data.diffVersion !== prPatchVersion) {
        if (generation === codeFlowGenerationRef.current) {
          setCodeFlowError(
            "The pull request updated while code flow was loading. Try again.",
          );
        }
        return;
      }
      if (generation === codeFlowGenerationRef.current)
        setCodeFlow({ key: codeFlowKey, data });
})().catch(async (error: any) => {
if (generation === codeFlowGenerationRef.current)
        setCodeFlowError(error?.message || "Couldn't load code flow.");
}).finally(async () => {
if (generation === codeFlowGenerationRef.current)
        setCodeFlowLoading(false);
});
  }, [diff, codeFlowKey, sessionId, prPatchVersion, previewRepo, previewBranch, active?.repo, active?.branch]);

  const refreshCodeFlow = async () => {
    codeFlowGenerationRef.current += 1;
    setCodeFlow(null);
    setCodeFlowError(null);
    setCodeFlowLoading(true);
    await load(true);
    setCodeFlowLoading(false);
  };

  // The guide is generated on demand (the first request per head commit takes
  // the model a while) — only fetch once the reviewer opens the Guide tab, and
  // refetch when a new push moves the head commit.
  const showingGuide = page === "files" && codeView === "guide";
  const showingFlow = page === "files" && codeView === "flow";
  const hasSkippedFiles = !!diff?.skippedFiles;
  // A different PR or a new head commit is a different guide: drop the in-flight
  // and failed flags with it, or one failure would disable auto-load for the
  // rest of the panel's life. The keyed `guide` itself goes stale on its own.
  useEffect(() => {
    guideGenerationRef.current += 1;
    setGuideLoading(false);
    setGuideFailed(false);
  }, [guideKey]);

  useEffect(() => {
    if (!showingGuide || !diff?.patch || !guideKey) return;
    if (guideLoading || guideFailed) return;
    if (guide?.key === guideKey) return;
    void loadGuide();
  }, [
    showingGuide,
    diff?.patch,
    guideKey,
    guide,
    guideLoading,
    guideFailed,
    loadGuide,
  ]);

  useEffect(() => {
    if (!showingFlow || codeFlowLoading || codeFlowError) return;
    if (!diff?.patch && !hasSkippedFiles) {
      if (diffLoading || diffOutOfDate) return;
      setCodeView("all");
      return;
    }
    if (codeFlow && codeFlow.key !== codeFlowKey) {
      setCodeFlowError(
        "The pull request updated. Refresh code flow to analyze the latest diff.",
      );
      return;
    }
    if (!codeFlow) void loadCodeFlow();
  }, [
    showingFlow,
    diff?.patch,
    hasSkippedFiles,
    diffLoading,
    diffOutOfDate,
    codeFlow,
    codeFlowKey,
    codeFlowLoading,
    codeFlowError,
    loadCodeFlow,
  ]);

  // Inline comments don't post one-by-one — they accumulate as pending and ship
  // together when the reviewer finishes the review (the provider's native flow).
  // Both are stable: they ride diffProps into every mounted file row, so a new
  // identity here re-renders the whole diff.
  const handleAddPending = async (target: CommentTarget, text: string) => {
      setPending((prev) => [
        ...prev,
        { ...target, text, id: randomUUID() },
      ]);
    setReviewDone(null);
    };

  const handleRemovePending = (id: string) => {
    setPending((prev) => prev.filter((c) => c.id !== id));
  };

  function handleFixChecks(summary: string) {
    if (!send || !pr) return;
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content: `Investigate the failing checks on PR #${pr.number}, fix the failures, run the relevant tests, commit the changes, and push them.`,
    });
    setSummaryDraft(summary);
    setReviewError(null);
    setMergeAfterReview(false);
    setReviewOpen(false);
    toast("Fixing checks…");
  }

  async function handleSubmitReview(summary: string) {
    if (submitting) return;
    const actionTargetKey = loadTargetKey;
    if (pending.length === 0 && !summary.trim() && reviewEvent !== "APPROVE") {
      setReviewError("Add a comment or a summary first");
      return;
    }
    setSubmitting(true);
    setReviewError(null);
    await (async () => {
const payload = {
        user: getCurrentUser(),
        event: reviewEvent,
        summary: summary.trim() || undefined,
        repo: active?.repo,
        branch: active?.branch,
        comments: pending.map((c) => ({
          text: c.text,
          path: c.path,
          line: c.endLine,
          startLine: c.startLine !== c.endLine ? c.startLine : undefined,
          side: (c.side === "deletions" ? "LEFT" : "RIGHT") as "LEFT" | "RIGHT",
        })),
      };
      const result = previewTarget
        ? await submitPrPreviewReviewApi(
            previewTarget.repo,
            previewTarget.branch,
            payload,
          )
        : await submitPrReviewApi(sessionId, payload);
      let merged = false;
      if (reviewEvent === "APPROVE" && mergeAfterReview) {
        await (async () => {
if (previewTarget)
            await mergePrPreviewApi(
              previewTarget.repo,
              previewTarget.branch,
              "squash",
            );
          else
            await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
          merged = true;
})().catch(async (e: any) => {
setMergeError(
            `Review approved, but merge failed: ${e.message || "unknown error"}`,
          );
});
      }
      if (actionTargetKey !== activeLoadTargetRef.current) return;
      setPending([]);
      setSummaryDraft("");
      setReviewOpen(false);
      setReviewEvent("APPROVE");
      setMergeAfterReview(false);
      setReviewDone(merged ? "merged" : result.url || "submitted");
      setTimeout(() => {
        if (actionTargetKey !== activeLoadTargetRef.current) return;
        setReviewDone(null);
        setReviewing(false);
      }, 6000);
      await load(true);
})().catch(async (e: any) => {
if (actionTargetKey === activeLoadTargetRef.current)
        setReviewError(e.message || "Failed to submit review");
}).finally(async () => {
setSubmitting(false);
});
  }

  function handleMerge() {
    if (!mergeKey) return;
    if (mergePhase === "scheduled") {
      cancelDeferredMergeByKey(mergeKey);
      return;
    }
    if (mergePhase !== "idle") return;
    setMergeError(null);
    const actionTargetKey = loadTargetKey;
    scheduleDeferredMerge(mergeKey, async () => {
      await (async () => {
if (previewTarget)
          await mergePrPreviewApi(
            previewTarget.repo,
            previewTarget.branch,
            "squash",
          );
        else await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
        if (actionTargetKey === activeLoadTargetRef.current) await load(true);
})().catch(async (e: any) => {
if (actionTargetKey === activeLoadTargetRef.current) {
          const message = e.message || "Merge failed";
          setMergeError(message);
          toast(message);
        }
});
    });
  }

  async function handleClose() {
    if (!confirmClose) {
      setConfirmClose(true);
      setCloseError(null);
      setTimeout(() => setConfirmClose(false), 4000);
      return;
    }
    setConfirmClose(false);
    setClosing(true);
    setCloseError(null);
    const actionTargetKey = loadTargetKey;
    await (async () => {
if (previewTarget)
        await closePrPreviewApi(previewTarget.repo, previewTarget.branch);
      else await closePrApi(sessionId, active?.repo, active?.branch);
      if (actionTargetKey === activeLoadTargetRef.current) await load(true);
})().catch(async (e: any) => {
if (actionTargetKey === activeLoadTargetRef.current)
        setCloseError(e.message || "Failed to close pull request");
}).finally(async () => {
setClosing(false);
});
  }

  // Roll the per-check list up into headline counts, and split deployments
  // (Vercel previews & friends) from CI checks — failing and running entries
  // sort first within each group.
  const checkSummary = (() => {
    const checks = pr?.checks || [];
    const s = summarize(checks);
    const rank = (c: PrCheck) => {
      const cls = checkClass(c.status, c.conclusion);
      return cls === "check-failure"
        ? 0
        : cls === "check-pending"
          ? 1
          : cls === "check-success"
            ? 3
            : 2;
    };
    const sorted = [...checks].sort((a, b) => rank(a) - rank(b));
    return {
      ...s,
      deployments: sorted.filter(isDeployment),
      checks: sorted.filter((c) => !isDeployment(c)),
    };
  })();

  const bodyHtml = (() => {
    if (!pr?.body) return "";
    // The mirrored walkthrough section is for GitHub readers; here
    // WalkthroughCard renders the real thing, so drop the mirror.
    const stripped = pr.body
      .replace(
        /<!-- opensession:walkthrough -->[\s\S]*?<!-- \/opensession:walkthrough -->/,
        "",
      )
      .trim();
    // A PR body is PR prose like its comments: the same `<details>` blocks,
    // `<img>` screenshots and bot markup, rendered by the same allowlist.
    return stripped
      ? renderPrCommentMarkdown(stripped, { repo: markdownRepo })
      : "";
  })();
  const provider = (providerFromUrl(pr?.url));
  // Host capability gating: absent (GitHub, older cache entries) means all
  // true, so nothing GitHub-shaped ever disappears. code.storage payloads
  // carry an explicit set (no checks/reviewers/comments/viewed state/stacks).
  const caps = prCapabilities(pr?.capabilities);

  // A file picked anywhere but the code itself (the Overview rail, a code-flow
  // location) has to wait: the code page may not be mounted yet, and its diff
  // loads on its own clock. Park the path and let the effect below spend it
  // once both are true, rather than revealing into a tree that isn't there.
  const scrollToFile = (path: string) => {
      if (page === "files" && codeView !== "flow") {
        revealDiffFile(rootRef.current, path);
        return;
      }
      setPage("files");
      if (codeView === "flow") setCodeView("all");
      setPendingReveal(path);
    };
  useEffect(() => {
    if (
      !pendingReveal ||
      page !== "files" ||
      codeView === "flow" ||
      !diff?.patch
    )
      return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        revealDiffFile(rootRef.current, pendingReveal);
        setPendingReveal(null);
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [pendingReveal, page, codeView, diff?.patch]);

  // Changed images render as pictures, served from the repo at the PR's head
  // (new side) / base (old side) refs through the pr-image endpoint.
  const prBase = pr?.baseRefName;
  const prHead = pr?.headRefName;
  const activeRepoId = active?.repo;
  const prImageSrcs = (file: FileDiffMetadata) => {
      const src = (ref: string, p: string) =>
        `${API_BASE}/pr-image?${activeRepoId ? `repo=${encodeURIComponent(activeRepoId)}&` : ""}ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`;
      return {
        oldSrc: prBase ? src(prBase, file.prevName || file.name) : undefined,
        newSrc: prHead ? src(prHead, file.name) : undefined,
      };
    };
  // The pr-image endpoint serves blobs through the GitHub API — on hosts
  // without it, image files fall back to the plain binary-diff placeholder.
  const imageSrcs = caps.images ? prImageSrcs : undefined;
  const fileActions = (() => {
    const ref = pr?.headRefOid || pr?.headRefName;
    const prUrl = pr?.url;
    return {
      providerName: provider.name,
      url: (file: FileDiffMetadata) => {
        if (provider.key !== "github" || !prUrl || !ref) return null;
        try {
          const url = new URL(prUrl);
          url.pathname = `${url.pathname.replace(/\/pull\/\d+.*$/, "")}/blob/${encodeURIComponent(ref)}/${file.name
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`;
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return null;
        }
      },
      loadContents:
        provider.key === "github" && ref
          ? (file: FileDiffMetadata) => fetchPrFile(activeRepoId, ref, file.name)
          : undefined,
    };
  })();

  // In-place edit mode on the review canvas. Only targets backed by one of the
  // session's own worktrees qualify (primary/attached repos — their worktree is
  // the PR's head branch); linked/discovered PRs live on branches this session
  // doesn't have checked out, so they stay read-only. Saves only touch the
  // worktree — the PR diff won't reflect them until they're committed and
  // pushed — so saved files accumulate into a "tell the agent" note that asks
  // it to commit them on this branch.
  const [handEdited, setHandEdited] = useState<string[]>([]);
  useEffect(() => setHandEdited([]), [sessionId, activeRepoId]);
  const worktreeEditable =
    !!editGate && !previewTarget && !!active && !active.branch;
  const editFile = (worktreeEditable
        ? {
            load: (file: FileDiffMetadata, side: "new" | "base") =>
              fetchWorktreeFile(
                sessionId,
                side === "base" ? file.prevName || file.name : file.name,
                activeRepoId,
                side,
              ),
            save: async (path: string, content: string) => {
              await saveWorktreeFile(sessionId, path, content, activeRepoId);
              setHandEdited((prev) =>
                prev.includes(path) ? prev : [...prev, path],
              );
              // The diff column is the PR's committed state, so it can't show
              // the edit yet — but the divergence strip's dirty state can.
              void fetchGitStatus(sessionId, activeRepoId)
                .then((g) => setGit(g))
                .catch(() => {});
            },
          }
        : undefined);
  const tellAgentAboutEdits = () => {
    if (!send || !handEdited.length) return;
    const list = handEdited.map((p) => `- \`${p}\``).join("\n");
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content:
        `${getCurrentUser()} hand-edited these files directly in the worktree via the review tab editor` +
        `${activeRepoId ? ` (${activeRepoId} repo)` : ""}:\n\n${list}\n\n` +
        `Review the edits, keep them (don't revert them unless they're clearly broken), and commit + push them on this branch so the pull request picks them up.`,
    });
    setHandEdited([]);
  };

  // GitHub "Viewed" state: fetched per PR (and refetched when the head moves,
  // since a push flips changed files to DIRTY = unviewed on GitHub's side).
  // Hosts without viewed state never fetch — prViewed stays unset, so the
  // checkboxes stay hidden.
  const viewedKey = diff ? `${activeRepoId || "pr"}#${diff.number}` : null;
  const viewedPrNumber = diff?.number;
  useEffect(() => {
    if (!caps.viewedState || !viewedKey || viewedPrNumber === undefined) return;
    let live = true;
    fetchPrViewedFiles(activeRepoId, viewedPrNumber, getCurrentUser())
      .then((res) => {
        if (!live) return;
        setPrViewed({
          key: viewedKey,
          prId: res.prId,
          viewed: new Set(res.viewed),
        });
      })
      .catch(() => {
        // Leave prViewed unset — checkboxes just stay hidden for this PR.
      });
    return () => {
      live = false;
    };
  }, [viewedKey, viewedPrNumber, diff?.headRefOid, activeRepoId, caps.viewedState]);

  const handleToggleViewed = (path: string, next: boolean) => {
    const info = prViewedRef.current;
    if (!info) return;
    const apply = (set: ReadonlySet<string>, add: boolean) => {
      const v = new Set(set);
      if (add) v.add(path);
      else v.delete(path);
      return v;
    };
    // Optimistic: flip locally, revert if GitHub rejects the mutation.
    setPrViewed({ ...info, viewed: apply(info.viewed, next) });
    void setPrFileViewed(info.prId, path, next, getCurrentUser()).catch(() => {
      setPrViewed((prev) =>
        prev && prev.key === info.key
          ? { ...prev, viewed: apply(prev.viewed, !next) }
          : prev,
      );
    });
  };

  function handleLinked(all: LinkedPrEntry[], justLinked: LinkedPrEntry) {
    setLinkedLocal(all);
    setActiveKey(`${justLinked.repo} ${justLinked.branch}`);
  }

  async function handleUnlink(t: PrTarget) {
    await (async () => {
const res = await unlinkPrApi(sessionId, t.repo, t.branch!);
      setLinkedLocal(res.all);
      if (activeKey === t.key)
        setActiveKey((targets.find((x) => x.primary) ?? targets[0])?.key);
      toast("PR unlinked");
})().catch(async (e: any) => {
toast(e.message || "Couldn't unlink the PR");
});
  }

  // Tab bar across the top: one tab per PR (primary repo, attached repos,
  // linked PRs) plus the link affordance. With a single target the bar
  // disappears and "Link PR" moves into the actions row instead.
  // Sessions linked to the shown PR — only when the caller wires the list.
  // Matched against the ACTIVE target (linked PRs carry their own branch; the
  // primary/attached branch resolves through the loaded PR's headRefName).
  const relatedSessions = (sessions && active
        ? prRelatedSessions(sessions, active.repo, active.branch, pr)
        : []);

  const files = pr?.files ?? NO_PR_FILES;
  const reviewedFiles =
    prViewed?.key === viewedKey ? prViewed.viewed : undefined;
  const reviewFiles = (() => {
    const visible =
      hideReviewed && reviewedFiles
        ? files.filter((file) => !reviewedFiles.has(file.path))
        : [...files];
    if (fileOrder === "pull-request")
      return sortDirection === "asc" ? visible : visible.reverse();
    const direction = sortDirection === "asc" ? 1 : -1;
    return visible.sort((left, right) => {
      const result =
        fileOrder === "changes"
          ? left.additions + left.deletions - right.additions - right.deletions
          : left.path.localeCompare(right.path);
      return (result || left.path.localeCompare(right.path)) * direction;
    });
  })();
  const visibleFileOrder = (reviewFiles.map((file) => file.path));

  const currentGuide = guide?.key === guideKey ? guide.data : null;
  // Slicing the patch per section walks every byte of it, so it cannot run on
  // renders it has nothing to do with — while the guide is the open lens, that
  // would be once per keystroke in the review summary.
  const guideSections = (currentGuide && diff?.patch
        ? sectionsWithPatches(currentGuide, diff.patch)
        : []);

  // Every diff on the code page is the same commentable surface; only the
  // patch it is handed differs (the whole PR, or one guide section). Memoized
  // because it is the props object of every mounted file row: rebuilding it
  // re-renders the whole diff, however unrelated the state change was.
  const diffProps = (diff && {
        diffStyle,
        controlsTarget: codeView === "all" ? diffControlsTarget : undefined,
        showViewedProgress: false,
        wrapLines,
        structuralHighlighting,
        showFileStats,
        codeTheme,
        visibleFileOrder,
        stickyFileHeaders: true,
        defaultExpandedFiles: diffLoadPolicy.defaultExpandedFiles,
        allowExpandAll: diffLoadPolicy.allowExpandAll,
        viewedFiles: prViewed?.key === viewedKey ? prViewed.viewed : undefined,
        onToggleViewed: handleToggleViewed,
        disabled: !reviewing || !caps.reviewComments,
        disabledHint: !caps.reviewComments
          ? `Inline review comments aren't supported on ${provider.name}`
          : "Start a review to add inline comments.",
        submitLabel: "Add comment",
        placeholder: `Comment on #${diff.number}, added to your pending review…`,
        pendingComments: reviewing ? pending : undefined,
        onRemovePending: handleRemovePending,
        reviewThreads:
          reviewThreads?.key === loadTargetKey
            ? reviewThreads.threads
            : undefined,
        commentRepo: markdownRepo,
        onSubmit: handleAddPending,
        imageSrcs,
        fileActions,
        editFile,
      });

  const showBar = targets.length > 1;
  const targetPicker = showBar ? (
    <Popover.Root open={targetPickerOpen} onOpenChange={setTargetPickerOpen}>
      <Tooltip label="Switch review target">
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 max-w-[180px] px-2 text-label phone:min-h-9 phone:max-w-[104px]"
              aria-label={`Switch review target. Current: ${active?.label || "repository"}`}
              caret
            >
              <span className="truncate">{active?.label}</span>
              {!headerCompact && (
                <span className="shrink-0 text-faint">
                  +{targets.length - 1}
                </span>
              )}
            </Button>
          }
        />
      </Tooltip>
      <Popover.Popup
        side="bottom"
        align="start"
        initialFocus
        className="w-[280px] p-1.5"
      >
        <div className="px-2 py-1.5 text-meta font-medium text-faint">
          Review target
        </div>
        <div className="flex flex-col gap-0.5">
          {targets.map((target) => {
            const selected = target.key === active?.key;
            const detail = target.linked
              ? "Linked pull request"
              : target.discovered
                ? "Opened by this session"
                : target.primary
                  ? "Primary repo"
                  : "Attached repo";
            return (
              <button
                key={target.key}
                type="button"
                className={`flex min-h-10 w-full items-center gap-2 rounded-md border-0 px-2 text-left hover:bg-hover phone:min-h-11 ${selected ? "bg-active" : "bg-transparent"}`}
                aria-current={selected ? "page" : undefined}
                onClick={() => {
                  setTargetPickerOpen(false);
                  setActiveKey(target.key);
                }}
              >
                <IconBranches size={17} className="shrink-0 text-dim" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label font-medium text-fg">
                    {target.label}
                  </span>
                  <span className="block truncate text-meta text-faint">
                    {detail}
                  </span>
                </span>
                {selected && (
                  <IconCheck size={16} className="shrink-0 text-fg" />
                )}
              </button>
            );
          })}
        </div>
        {linkable && (
          <div className="mt-1.5 border-t border-divider-soft px-1 pt-1.5">
            <LinkPrControl
              sessionId={sessionId}
              variant="action"
              onLinked={handleLinked}
            />
          </div>
        )}
      </Popover.Popup>
    </Popover.Root>
  ) : null;
  const switcher = showBar ? (
    <div className={PR_REPO_TABS}>{targetPicker}</div>
  ) : null;

  const reviewStateClass = `flex-1 ${compactToolbar ? WS_SUMMARY_REVIEW_CANVAS_CLEARANCE : ""}`;

  if (loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <LoadingState className={`${reviewStateClass} -translate-y-5`}>
          <span className="text-control-label font-medium text-fg">
            Loading pull request…
          </span>
        </LoadingState>
      </div>
    );

  if (loadError && !pr)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <EmptyState
          className={reviewStateClass}
          role="alert"
          icon={<IconX size={22} className="text-red" />}
          title="Couldn’t load pull request"
          action={
            <Button
              size="sm"
              onClick={() => {
                setLoading(true);
                setLoadError(null);
                void load(true);
              }}
            >
              Try again
            </Button>
          }
        />
      </div>
    );

  if (!pr) {
    const showWorktreeDiff =
      !!sessionId && !previewTarget && !active?.linked && !active?.discovered;
    // The branch's own changes are the review here, so they lead. Opening the
    // PR is the one action this state offers, and it sits in the bar rather
    // than inside a card below the diff.
    const createPr = async () => {
      if (!sessionId || prRequested) return;
      setPrRequested(true);
      await publishPrApi(sessionId, active?.repo)
        .then(async (result) => {
          toast(`Pull request #${result.number} created`);
          await load(true);
        })
        .catch((error) => {
          toast(error instanceof Error ? error.message : "Couldn’t create the pull request");
        });
      setPrRequested(false);
    };
    return (
      <div
        className={`selectable relative flex h-full min-h-0 flex-col bg-surface ${compactToolbar ? "overflow-x-hidden overflow-y-auto" : "overflow-hidden"}`}
        data-review-canvas="true"
      >
        <ReviewToolbar compact={compactToolbar}>
          <div className={PR_NO_PR_BAR}>
            {targetPicker}
            {/* Opening the PR is what this state is for, so its action leads
                before the shared diff controls. */}
            {showWorktreeDiff && (
              <Button
                variant="primary"
                size="sm"
                className="phone:min-h-11"
                icon={<IconPullRequest size={20} />}
                disabled={prRequested}
                onClick={() => void createPr()}
              >
                {prRequested ? "Publishing…" : "Create PR"}
              </Button>
            )}
            {linkable && (
              <LinkPrControl
                sessionId={sessionId}
                variant="action"
                onLinked={handleLinked}
              />
            )}
            {showWorktreeDiff && (
              <div
                ref={setWorktreeToolbarTarget}
                className="ml-auto flex shrink-0 items-center gap-2.5 text-label"
              />
            )}
          </div>
        </ReviewToolbar>
        {/* Match the PR-backed canvas: without a standing summary, content
            owns the scrollport and the toolbar stays outside it. With the
            summary, the shared outer scrollport lets its toolbar stick. */}
        <main
          className={`min-h-0 flex-1 bg-surface ${compactToolbar ? "overflow-y-visible" : "overflow-y-auto"}`}
        >
          {walkthrough && (
            <div className="mx-auto w-full max-w-[760px] px-4 pt-4 sm:px-5">
              <WalkthroughCard walkthrough={walkthrough} />
            </div>
          )}
          {showWorktreeDiff ? (
            <div
              className={`max-w-[1500px] px-2 pb-2 phone:w-full phone:px-1 ${compactToolbar ? `w-auto pt-0 ${WS_SUMMARY_REVIEW_CANVAS_CLEARANCE}` : "mx-auto w-full pt-2"}`}
              data-no-pr-worktree-diff
            >
              <DiffPanel
                sessionId={sessionId}
                isRunning={sessionRunning}
                canSend={!!send && !!editGate}
                send={send ?? NOOP_SEND}
                toolbarTarget={worktreeToolbarTarget}
              />
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4 sm:px-5">
              <PrCard title="Git status">
                <GitStatusRows
                  git={git}
                  pr={null}
                  sessionId={sessionId}
                  repo={active?.repo}
                  send={send}
                  onRefresh={load}
                />
              </PrCard>
            </div>
          )}
        </main>
      </div>
    );
  }

  // Bot bookkeeping comments are pure HTML markers — hide them, and strip
  // leading markers from real comments' previews.
  const comments = (pr.comments || []).filter(
    (c) => stripHtmlComments(c.body) && !isOutdatedReviewComment(c.body),
  );
  const stateLabel = pr.isDraft
    ? "Draft"
    : pr.state === "OPEN"
      ? "Open"
      : pr.state === "MERGED"
        ? "Merged"
        : "Closed";
  // The state reads in the app's own PR language rather than a badge of its
  // own: the glyph carries the colour (prStatusMark, the same green/yellow/
  // red/purple the sidebar row and the workspace rows paint) and the word
  // beside it stays coarse. That way the header agrees with the sidebar entry
  // for this PR, including the states a badge cannot show at all: a conflict,
  // or checks still running.
  const statusMark = prStatusMark({ ...pr, checks: checkSummary });
  const canMergeAfterReview =
    pr.state === "OPEN" &&
    !pr.isDraft &&
    pr.mergeable !== "CONFLICTING" &&
    checkSummary.failed === 0 &&
    checkSummary.pending === 0;
  const reviewSubmitLabel =
    reviewEvent === "APPROVE"
      ? mergeAfterReview && canMergeAfterReview
        ? "Approve and merge"
        : "Approve"
      : reviewEvent === "REQUEST_CHANGES"
        ? "Request changes"
        : "Submit review";
  const rail = (
    <ReviewRail
      className={railStacked ? "min-w-0" : "w-[264px] shrink-0"}
      pr={pr}
      git={git}
      sessionId={sessionId}
      repo={active?.repo}
      provider={provider}
      caps={caps}
      checkSummary={checkSummary}
      send={send}
      onRefresh={load}
      onMerge={handleMerge}
      merging={merging}
      mergeScheduled={mergeScheduled}
      mergeError={mergeError}
      onOpenFile={scrollToFile}
      onOpenFiles={() => setPage("files")}
      onOpenSessions={sessions ? () => setSessionsOpen(true) : undefined}
      sessionCount={relatedSessions.length}
      focusChecksSeq={focusChecksSeq}
      compact={railStacked}
    />
  );

  const codeSettings = (
    <Popover.Root>
      <Tooltip label="Code view settings">
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="desktop:-mr-1.5"
              aria-label="Code view settings"
              icon={<IconSliders size={18} />}
            />
          }
        />
      </Tooltip>
      {/* The content lens stands alone. File filtering and organization come
          next; lower-frequency rendering preferences come last. Every setting
          remains one row wearing the shape of its answer, which is the
          vocabulary in `ui/setting-row`. */}
      <Popover.Popup
        side="bottom"
        align="end"
        initialFocus
        className="flex w-[340px] flex-col gap-0.5 p-3"
      >
        {worktreeAvailable && (
          <>
            <DiffSourceSetting value={diffSource} onValueChange={setDiffSource} />
            <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />
          </>
        )}
        <SettingRow label="Code view">
          <Segmented
            label="Code view"
            size="sm"
            value={codeView}
            onValueChange={(next) => {
              const key = next as CodeView;
              if (key === "flow" && codeView !== "flow" && codeFlowError) {
                setCodeFlow(null);
                setCodeFlowError(null);
              }
              setCodeView(key);
            }}
          >
            <SegmentedOption value="all">Changes</SegmentedOption>
            <SegmentedOption value="guide">Guide</SegmentedOption>
            <SegmentedOption
              value="flow"
              disabled={
                (!diff?.patch && !diff?.skippedFiles) || !prPatchVersion
              }
            >
              Flow
            </SegmentedOption>
          </Segmented>
        </SettingRow>

        <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />

        <CodeOrganizationSettings
          settings={organizationSettings}
          reviewedFilesAvailable={!!reviewedFiles}
          defaultOrderLabel="Pull request"
        />

        <div aria-hidden className="mx-2 my-1.5 h-px bg-line" />

        <CodeDisplaySettings {...codeDisplaySettings} />
      </Popover.Popup>
    </Popover.Root>
  );

  /* The review has two pages. Without the workspace summary they sit in a
     small floating switcher, leaving the identity and file controls in the
     same toolbar positions used while the summary is open. */
  const pageTabs = (
    [
      ["overview", "Overview", comments.length || undefined],
      ["files", "Files", files.length || undefined],
    ] as const
  ).map(([key, label, count]) => (
    <button
      key={key}
      role="tab"
      aria-selected={page === key}
      className={`flex h-8 shrink-0 items-center gap-1.5 border-0 bg-transparent px-3 text-label font-medium transition-colors phone:h-11 phone:text-control-label ${
        page === key ? "text-fg" : "text-dim hover:text-fg"
      }`}
      onClick={() => setPage(key)}
    >
      {label}
      {count !== undefined && (
        <span
          className={`min-w-5 rounded-full px-[7px] py-px text-center text-meta font-semibold tabular-nums ${
            page === key ? "bg-accent-soft text-accent" : "bg-active text-dim"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  ));

  const fileControls = page === "files" && (
    <div
      className={`flex shrink-0 items-center gap-1.5 phone:gap-2 ${compactToolbar ? "" : "ml-auto"}`}
    >
      {diffSource === "worktree" ? (
        <div
          ref={setWorktreeToolbarTarget}
          className="flex shrink-0 items-center gap-2.5 text-label"
        />
      ) : (
        <>
          {handEdited.length > 0 && send && (
            <Button
              variant="default"
              size="sm"
              onClick={tellAgentAboutEdits}
              title="Sends a note listing your hand-edits so they get committed and pushed"
            >
              Tell {AGENT_NAME} about {handEdited.length} edit
              {handEdited.length === 1 ? "" : "s"}
            </Button>
          )}
          <div
            ref={setDiffControlsTarget}
            className="flex shrink-0 items-center gap-1.5 phone:gap-2"
          />
          {codeSettings}
        </>
      )}
    </div>
  );

  const reviewBar = !compactToolbar && (
    <div className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden bg-surface [scrollbar-width:none] desktop:absolute desktop:left-2 desktop:top-[calc(100%+8px)] desktop:z-20 desktop:rounded-lg desktop:border desktop:border-line phone:h-11 phone:gap-2 phone:px-2 phone:shadow-[inset_0_-1px_0_var(--border)] [&::-webkit-scrollbar]:hidden">
      <div
        className="flex shrink-0 items-center gap-0.5 self-stretch"
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Pull request pages"
      >
        {pageTabs}
      </div>
      {phoneLayout && fileControls}
    </div>
  );

  return (
    <div
      className={`selectable relative flex h-full min-h-0 flex-col bg-surface ${compactToolbar ? "overflow-x-hidden overflow-y-auto" : "overflow-hidden"}`}
      data-review-canvas="true"
      ref={setRoot}
    >
      {/* Desktop always keeps file controls in the identity row, so opening
          the summary only relocates page navigation. Phone keeps one
          edge-to-edge navigation and controls row below the identity. */}
      <ReviewToolbar compact={compactToolbar}>
      <TopBar as="header" className="h-10 shrink-0 gap-2.5 px-4 phone:px-3">
        {/* State, in the app's own PR language, filled rather than drawn: the
            tone washes the whole chip and the glyph and word share its ink.
            It is its own object, so it gets more air than the pieces of the
            identity line it precedes. */}
        <Tooltip label={statusMark.label}>
          <span
            className={`mr-1.5 flex h-6 shrink-0 items-center gap-1.5 rounded-control px-2 ${statusMark.bgClassName} ${statusMark.className}`}
          >
            <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
            {!headerCompact && (
              <span className="text-label font-medium">{stateLabel}</span>
            )}
          </span>
        </Tooltip>
        {targetPicker}
        {/* Author and title in the session header's own breadcrumb shape: a
            tight picture-and-name pill, a chevron, then the name of the thing
            you are looking at. Same spacing and weights as RepoBar's
            `[icon] repo › title`, so the two headers read as one bar. */}
        {!headerCompact && (
          <>
            <span className="flex shrink-0 items-center gap-[7px] text-item-title font-medium text-fg">
              <UserAvatar
                name={pr.author}
                login={provider.key === "github" ? pr.author : null}
                size={18}
                edge={false}
                title={pr.author}
              />
              <span className="max-w-[180px] truncate">{pr.author}</span>
            </span>
            <IconChevronRight size={18} className="shrink-0 text-faint" />
          </>
        )}
        {/* Title only. Counts, commits and the sessions on this PR are the
            rail's job, so the bar stays one line of identity.

            The title is the name of the page you are already on, so it is
            inert. The outbound jump rides the number, which is the reference
            everywhere else in the app. */}
        <h1
          className="flex min-w-0 flex-1 items-baseline gap-1 text-item-title font-medium leading-[1.2] text-fg"
          title={`${pr.title} #${pr.number}`}
        >
          <span className="truncate">{pr.title}</span>
          <Tooltip label={`Open on ${provider.name}`}>
            <a
              className="shrink-0 font-normal text-faint no-underline hover:text-link"
              href={pr.url}
              target="_blank"
              rel="noopener"
            >
              #{pr.number}
            </a>
          </Tooltip>
        </h1>
        {(compactToolbar || !phoneLayout) && fileControls}
        {/* A stack is secondary navigation, not page content. Keep its compact
            position/size chip in the identity bar and reveal the full rail in
            the shared popover instead of spending permanent canvas height. */}
        {caps.stacks && pr.stack && (
          <PrStackChip
            pr={pr}
            tone={statusMark.tone}
            size="bar"
            headline={statusMark.label}
            repo={active?.repo}
            onOpenPr={onOpenPr}
          />
        )}
        {pr.staging?.url && !headerCompact && (
          <Tooltip label="Open the preview environment">
            <a
              /* An icon-only control carries its glyph ~6px inside its box,
                 so the last one in the row is outdented to put that glyph on
                 the row's content edge — where the view control below it
                 sits, since a bordered control is flush with its own box. */
              className={`ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-control text-dim no-underline hover:bg-hover hover:text-fg ${pr.state === "OPEN" ? "" : "-mr-1.5"}`}
              href={pr.staging.url}
              target="_blank"
              rel="noopener"
              aria-label="Open the preview environment"
            >
              <IconGlobe size={19} />
            </a>
          </Tooltip>
        )}
        {pr.state === "OPEN" &&
          !pr.isDraft &&
          caps.reviewComments &&
          !reviewing &&
          !headerCompact && (
            /* The one call to action on a wide canvas, so it takes the accent
               plate. Compact canvases move it into the actions menu instead
               of squeezing the repository and pull request identity. */
            <Button
              variant="primary"
              size="sm"
              className={pr.staging?.url ? undefined : "ml-auto"}
              onClick={() => {
                setDiffSource("pull-request");
                setReviewing(true);
                setPage("files");
              }}
            >
              Review
            </Button>
          )}
        <Menu.Root>
          <Tooltip label="Pull request actions">
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-1.5"
                  aria-label="Pull request actions"
                  icon={<IconDotsHorizontal size={18} />}
                />
              }
            />
          </Tooltip>
          <Menu.Popup align="end">
            {headerCompact &&
              pr.state === "OPEN" &&
              !pr.isDraft &&
              caps.reviewComments &&
              !reviewing && (
                <Menu.Item
                  onClick={() => {
                    setDiffSource("pull-request");
                    setReviewing(true);
                    setPage("files");
                  }}
                >
                  <IconMessage size={18} className={MENU_ICON} />
                  <span className="min-w-0 flex-1 truncate">Start review</span>
                </Menu.Item>
              )}
            <Menu.Item
              render={<a href={pr.url} target="_blank" rel="noopener" />}
            >
              <BrandMark name={provider.key} size={16} className={MENU_ICON} />
              <span className="min-w-0 flex-1 truncate">
                Open on {provider.name}
              </span>
            </Menu.Item>
            {pr.staging?.url && (
              <Menu.Item
                render={
                  <a
                    href={pr.staging.url}
                    target="_blank"
                    rel="noopener"
                  />
                }
              >
                <IconGlobe size={18} className={MENU_ICON} />
                <span className="min-w-0 flex-1 truncate">Open preview</span>
              </Menu.Item>
            )}
            <Menu.Item
              onClick={() =>
                copyPrLink(pr.url, { toast: "Pull request link copied" })
              }
            >
              <IconCopy size={18} className={MENU_ICON} />
              <span className="min-w-0 flex-1 truncate">Copy PR link</span>
            </Menu.Item>
            {pr.state === "OPEN" && (
              <>
                <Menu.Separator />
                {canMergeAfterReview && (
                  <Menu.Item onClick={handleMerge} disabled={merging}>
                    {mergeScheduled ? (
                      <IconUndo size={18} className={MENU_ICON} />
                    ) : (
                      <IconGitMerge size={18} className={MENU_ICON} />
                    )}
                    {merging
                      ? "Merging…"
                      : mergeScheduled
                        ? "Undo"
                        : "Squash and merge"}
                  </Menu.Item>
                )}
                <Menu.Item
                  className="text-red data-[highlighted]:bg-red-soft"
                  onClick={handleClose}
                  closeOnClick={confirmClose}
                  disabled={closing}
                >
                  <IconX size={18} className={MENU_ICON} />
                  {closing
                    ? "Closing…"
                    : confirmClose
                      ? "Confirm close pull request"
                      : "Close pull request"}
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Root>
      </TopBar>
      {reviewBar}
      </ReviewToolbar>

      {caps.stacks && !pr.stack && (
        <StackLinkSection pr={pr} sessionId={sessionId} onLinked={load} />
      )}

      <div
        className={`flex min-h-0 flex-1 ${compactToolbar ? `${WS_SUMMARY_REVIEW_CANVAS_CLEARANCE} desktop:flex-none desktop:[--review-file-tree-gap:0px] desktop:[--review-file-tree-top:60px]` : "desktop:pt-12"}`}
      >
        {page === "files" &&
          diffSource === "pull-request" &&
          fileListMode !== "hidden" &&
          files.length > 0 && (
            <PrFileTree
              files={reviewFiles}
              mode={fileListMode}
              showFileStats={showFileStats}
              onOpenFile={scrollToFile}
            />
          )}

        <main
          // Wide review scrolls the toolbar and canvas in one container. Once
          // the toolbar sticks, file titles clear its 10px inset, 40px row,
          // 2px border, 8px section gap, and the file card's own 1px border.
          className={`min-w-0 flex-1 bg-surface [--review-file-header-top:0px] ${compactToolbar ? "overflow-y-visible desktop:[--review-file-header-top:61px]" : "overflow-y-auto"} ${reviewing ? "pb-24 phone:pb-36" : "pb-4"}`}
        >
          {page === "overview" ? (
            <SelectionToSession
              sessionId={sessionId}
              label={`${provider.changeAbbr} #${pr.number}`}
              send={send}
            >
              <div
                className={`mx-auto w-full max-w-[1120px] px-6 py-6 phone:px-3 ${railStacked ? "flex flex-col gap-6" : "flex gap-8"}`}
              >
                {railStacked && rail}
                <div className="flex min-w-0 flex-1 flex-col gap-5">
                  {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
                  <ConversationView
                    author={pr.author}
                    descriptionHtml={bodyHtml}
                    comments={comments}
                    repo={markdownRepo}
                    onAddToInput={onAddToInput}
                    pr={pr}
                  />
                </div>
                {!railStacked && !hideWideOverviewRail && rail}
              </div>
            </SelectionToSession>
          ) : (
            // Keep the review canvas close to the viewport edge. The file
            // section's own border now carries the shape instead of a wide
            // gray gutter around it.
            <div
              className={`mx-auto max-w-[1500px] px-2 pb-2 phone:px-1 ${compactToolbar ? "pt-0" : "pt-2"}`}
            >
              {diffSource === "worktree" ? (
                <DiffPanel
                  sessionId={sessionId}
                  isRunning={sessionRunning}
                  canSend={!!send && !!editGate}
                  send={send ?? NOOP_SEND}
                  repo={activeRepoId}
                  toolbarTarget={worktreeToolbarTarget}
                  source="worktree"
                  onSourceChange={setDiffSource}
                />
              ) : codeView === "flow" ? (
                <CodeFlow
                  data={codeFlow?.key === codeFlowKey ? codeFlow.data : null}
                  loading={
                    codeFlowLoading ||
                    (codeFlow?.key !== codeFlowKey && !codeFlowError)
                  }
                  error={codeFlowError}
                  onRetry={() => void refreshCodeFlow()}
                  onOpenLocation={scrollToFile}
                />
              ) : !diff?.patch || !diffProps ? (
                <div className="py-12 text-center text-sm text-faint">
                  {diffError ? (
                    <>
                      <span className="text-red">{diffError}</span>
                      <button
                        className="ml-2 border-0 bg-transparent text-link"
                        onClick={() => {
                          setDiffLoading(true);
                          setDiffError(null);
                          void load(true);
                        }}
                      >
                        Retry
                      </button>
                    </>
                  ) : diffLoading ? (
                    "Loading pull request changes…"
                  ) : diffOutOfDate ? (
                    "The pull request changed while loading. It will refresh automatically."
                  ) : (
                    "No text diff is available for this pull request."
                  )}
                </div>
              ) : codeView === "guide" ? (
                guideLoading || (!currentGuide && !guideFailed) ? (
                  <>
                    <div className="mb-4 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-faint">
                      Writing the review guide… You can review the file diff
                      while it groups the change by intent.
                    </div>
                    <CommentableDiff patch={diff.patch} {...diffProps} />
                  </>
                ) : guideFailed ? (
                  <div className="py-12 text-center text-sm text-faint">
                    Couldn't generate a guide for this PR.
                    <button
                      className="ml-2 border-0 bg-transparent text-link"
                      onClick={() => void loadGuide()}
                    >
                      Retry
                    </button>
                  </div>
                ) : currentGuide ? (
                  <>
                    <div className="mb-7 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                      <div className="text-meta font-medium leading-relaxed text-faint">
                        Review guide
                      </div>
                      <div>
                        <h2 className="m-0 text-item-title font-semibold tracking-[-0.01em] text-fg">
                          {currentGuide.sections.length} focused review step
                          {currentGuide.sections.length === 1 ? "" : "s"}
                        </h2>
                        <p className="mt-1 max-w-[680px] text-xs leading-relaxed text-dim">
                          {reviewing
                            ? "Review the change by intent rather than alphabetically. Comments stay pending until you finish the review."
                            : "Read the change by intent rather than alphabetically."}
                        </p>
                      </div>
                    </div>
                    {guideSections.map((section, index, all) => (
                      <section
                        id={`review-guide-${index}`}
                        className="mb-8 scroll-mt-[64px]"
                        key={`${section.title}-${index}`}
                      >
                        <div className="mb-3 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                          <div className="text-meta text-faint">
                            {String(index + 1).padStart(2, "0")} /{" "}
                            {String(all.length).padStart(2, "0")}
                          </div>
                          <div>
                            <div className="text-item-title font-semibold text-fg">
                              {section.title}
                            </div>
                            <div className="mt-1 text-supporting leading-relaxed text-dim">
                              {section.explanation}
                            </div>
                          </div>
                        </div>
                        {section.patch && (
                          <CommentableDiff
                            patch={section.patch}
                            {...diffProps}
                          />
                        )}
                      </section>
                    ))}
                  </>
                ) : null
              ) : (
                <CommentableDiff
                  patch={diff.patch}
                  {...diffProps}
                  groups={
                    grouping === "ai" && diffGroups?.oid === diff.headRefOid
                      ? diffGroups.groups || undefined
                      : undefined
                  }
                  groupsLoading={grouping === "ai" && diffGroupsLoading}
                />
              )}
            </div>
          )}
        </main>
      </div>

      {sessionsOpen && (
        <>
          <button
            className="absolute inset-0 z-20 cursor-default border-0 bg-black/25"
            aria-label="Close sessions"
            onClick={() => setSessionsOpen(false)}
          />
          <div
            className={`absolute right-5 ${showBar ? "top-[108px]" : "top-16"} z-30 w-[460px] max-w-[calc(100%-40px)] rounded-md border border-line-strong bg-panel p-4 smooth-shadow-lg`}
          >
            <div className="mb-2 flex items-center">
              <span className="text-sm font-semibold text-fg">
                Sessions on this PR
              </span>
              <button
                className="ml-auto border-0 bg-transparent text-item-title text-faint hover:text-fg"
                onClick={() => setSessionsOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <PrSessionsList
              sessions={relatedSessions}
              repo={active?.repo || ""}
              branch={active?.branch}
              pr={pr}
              currentSessionId={sessionId || undefined}
              onOpenSession={(id) => {
                setSessionsOpen(false);
                onOpenSessionById?.(id);
              }}
              send={send}
              addHandler={addHandler}
              compose
            />
          </div>
        </>
      )}

      {/* Review controls only exist while the person is actively reviewing.
          Passive PR browsing should not imply that a review is in progress. */}
      {reviewing && (
        <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex min-h-[54px] items-center gap-3 rounded-md border border-line-strong bg-panel/95 px-3 py-2 smooth-shadow-soft backdrop-blur phone:flex-col phone:items-stretch phone:gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-fg">
              {reviewDone === "merged"
                ? "Approved and merged"
                : reviewDone
                  ? "Review submitted"
                  : !caps.reviewComments
                    ? "Review"
                    : pending.length > 0
                      ? `${pending.length} pending comment${pending.length === 1 ? "" : "s"}`
                      : "No pending comments"}
            </div>
            <div
              className={`mt-0.5 truncate text-supporting ${closeError ? "text-red" : "text-faint"}`}
              title={closeError || undefined}
            >
              {closeError ||
                (caps.reviewComments
                  ? "Comments are sent together when you finish the review"
                  : `${provider.name} has no reviews. Merge or close when you're done.`)}
            </div>
          </div>
          <div className="pointer-events-auto flex shrink-0 flex-wrap justify-end gap-2">
            {onOpenSession && (
              <Button
                variant="soft"
                className="text-xs"
                onClick={onOpenSession}
              >
                Open workspace
              </Button>
            )}
            <Button
              variant="soft"
              className="text-xs"
              onClick={() => setReviewing(false)}
            >
              Exit review
            </Button>
            {pr.state === "OPEN" && !pr.isDraft && caps.reviewComments && (
              <Button
                variant="success"
                className="text-xs"
                onClick={() => setReviewOpen(true)}
              >
                Finish review
              </Button>
            )}
          </div>
        </div>
      )}

      {reviewOpen && (
        <FinishReviewDialog
          prNumber={pr.number}
          pendingCount={pending.length}
          event={reviewEvent}
          onEventChange={setReviewEvent}
          defaultSummary={summaryDraft}
          canMerge={canMergeAfterReview}
          onFixChecks={
            checkSummary.failed > 0 && send ? handleFixChecks : undefined
          }
          mergeAfterReview={mergeAfterReview}
          onMergeAfterReviewChange={setMergeAfterReview}
          error={reviewError || mergeError}
          submitting={submitting}
          submitLabel={reviewSubmitLabel}
          onSubmit={handleSubmitReview}
          onClose={(summary) => {
            setSummaryDraft(summary);
            setReviewOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * The review canvas' "Finish review" dialog: pick a verdict, add an optional
 * summary, submit.
 *
 * Approving and merging are separate decisions, so they are separate controls.
 * The verdict rows are the choice; merging is an opt-in that starts off, which
 * keeps the primary action "Approve" until someone asks for more.
 *
 * The summary is held here rather than by the canvas: the canvas re-renders the
 * whole diff, and this is a field someone types a paragraph into. It is seeded
 * from `defaultSummary` and handed back on both exits, so closing the dialog
 * and reopening it still finds the draft.
 */
function FinishReviewDialog({
  prNumber,
  pendingCount,
  event,
  onEventChange,
  defaultSummary,
  canMerge,
  onFixChecks,
  mergeAfterReview,
  onMergeAfterReviewChange,
  error,
  submitting,
  submitLabel,
  onSubmit,
  onClose,
}: {
  prNumber: number;
  pendingCount: number;
  event: ReviewEvent;
  onEventChange: (event: ReviewEvent) => void;
  defaultSummary: string;
  canMerge: boolean;
  onFixChecks?: (summary: string) => void;
  mergeAfterReview: boolean;
  onMergeAfterReviewChange: (merge: boolean) => void;
  error: string | null;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (summary: string) => void;
  onClose: (summary: string) => void;
}) {
  const [summary, setSummary] = useState(defaultSummary);
  const open = useEnterOnMount();
  // Without this Base UI focuses the first tabbable, which is the header's
  // close. A focus ring on the ✕ is the wrong first read for a dialog you
  // opened in order to write in it.
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const verdicts: Array<{ event: ReviewEvent; label: string; hint: string }> = [
    { event: "APPROVE", label: "Approve", hint: "Sign off on these changes" },
    {
      event: "COMMENT",
      label: "Comment",
      hint: "Leave feedback without a verdict",
    },
    {
      event: "REQUEST_CHANGES",
      label: "Request changes",
      hint: "Ask for another pass before merging",
    },
  ];
  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose(summary)}>
      <Modal.Content
        widthClassName="max-w-[30rem]"
        className="bottom-[max(1rem,env(safe-area-inset-bottom))] left-auto right-4 top-auto translate-x-0 translate-y-0 origin-bottom-right phone:left-1/2 phone:right-auto phone:-translate-x-1/2 phone:origin-bottom"
        initialFocus={summaryRef}
      >
        <Modal.Header
          title="Finish review"
          description={
            pendingCount > 0
              ? `Your ${pendingCount} pending comment${pendingCount === 1 ? "" : "s"} on #${prNumber} are sent with this review.`
              : `Leave a review on #${prNumber}.`
          }
        />
        <div
          className="flex flex-col gap-1.5"
          role="radiogroup"
          aria-label="Review verdict"
        >
          {verdicts.map((verdict) => (
            <button
              key={verdict.event}
              type="button"
              role="radio"
              aria-checked={event === verdict.event}
              data-active={event === verdict.event || undefined}
              className="group focus-ring flex cursor-pointer items-start gap-2.5 rounded-row border border-line bg-surface px-3 py-2.5 text-left transition-[background-color,border-color] hover:bg-hover data-active:border-accent data-active:bg-accent-soft"
              onClick={() => onEventChange(verdict.event)}
            >
              <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong transition-colors group-data-active:border-accent group-data-active:bg-accent">
                <span className="size-1.5 rounded-full bg-on-accent opacity-0 group-data-active:opacity-100" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-label font-semibold text-fg">
                  {verdict.label}
                </span>
                <span className="text-supporting text-dim">{verdict.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <Textarea
          ref={summaryRef}
          size="sm"
          className="h-20 resize-none"
          placeholder={
            event === "APPROVE" || pendingCount > 0
              ? "Summary (optional)"
              : "Summary"
          }
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        {event === "APPROVE" && canMerge && (
          // Quieter than the verdict rows on purpose: merging is an extra you
          // opt into here, not a fourth thing to choose between.
          <label className="flex cursor-pointer items-center gap-2.5 px-0.5">
            <Checkbox
              checked={mergeAfterReview}
              onCheckedChange={onMergeAfterReviewChange}
            />
            <span className="text-supporting text-dim">
              Squash and merge as well
            </span>
          </label>
        )}
        {event === "APPROVE" && !canMerge && onFixChecks && (
          <div className="flex items-center justify-between gap-3 rounded-row bg-red-soft px-3 py-2">
            <span className="text-supporting text-red">
              Checks must pass before you can merge.
            </span>
            <Button
              variant="danger"
              size="sm"
              className="shrink-0"
              onClick={() => onFixChecks(summary)}
            >
              Fix checks
            </Button>
          </div>
        )}
        {error && <div className="text-supporting text-red">{error}</div>}
        <Modal.Footer>
          <Button onClick={() => onClose(summary)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => onSubmit(summary)}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : submitLabel}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
