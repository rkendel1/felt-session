import { utilityClassName } from "../ui/cn";
import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import React, { startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parsePatchFiles } from "@pierre/diffs";
import { EditProvider, FileDiff } from "@pierre/diffs/react";
import type {
  SelectedLineRange,
  FileDiffMetadata,
  DiffLineAnnotation,
  DiffsEditor,
  FileDiffLoadedFiles,
} from "@pierre/diffs";
import type { Editor, EditorOptions } from "@pierre/diffs/edit";
import type { DiffFileGroup } from "../lib/types";
import type { PrReviewThread } from "../lib/api/prs";
import { renderPrCommentMarkdown } from "../lib/markdown";
import { stripHtmlComments } from "../lib/pr-prompts";
import {
  IconArrowUpRight,
  IconArrowUpToLine,
  IconCheck,
  IconCheckCircle,
  IconChevronRight,
  IconCopy,
  IconDotsHorizontal,
  IconEye,
  IconFile,
  IconLink,
  IconPencil,
  IconUndo,
} from "./icons";
import { copyToClipboard } from "../lib/share-link";
import { canAutoExpandDiffFile } from "../lib/review-diff";
import { noAutofill } from "../lib/composer-autofill";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { useResolvedTheme } from "./CodeHighlight";
import { Spinner } from "../ui/spinner";
import { EmptyState } from "../ui/state";
import { Menu, MENU_ICON } from "../ui/menu";
import { toast } from "../ui/toast";
import { useStickyEdges } from "../hooks/useStickyEdges";
import { UserAvatar } from "./UserAvatar";
import { ExtBadge, fileExt } from "./lang-marks";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap2: {
			gap: "calc(4px * 2)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	borderNone: {
			borderStyle: "none"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	px1: {
			paddingInline: "4px"
	},
	py05: {
			paddingBlock: "calc(4px * 0.5)"
	},
	leading145: {
			lineHeight: "1.45"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	textFg: {
			color: "var(--text)"
	},
	OverflowWrapAnywhere: {
			overflowWrap: "anywhere"
	},
	size5: {
			width: "calc(4px * 5)",
			height: "calc(4px * 5)"
	},
	shrink0: {
			flexShrink: "0"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	minW0: {
			minWidth: "0"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	textEllipsis: {
			textOverflow: "ellipsis"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	gap3px: {
			gap: "3px"
	},
	fontSans: {
			fontFamily: "var(--sans)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	gap15: {
			gap: "calc(4px * 1.5)"
	},
	maxW260px: {
			maxWidth: "260px"
	},
	textRed: {
			color: "var(--red)"
	},
	minH0: {
			minHeight: "0"
	},
	px25: {
			paddingInline: "calc(4px * 2.5)"
	},
	py3px: {
			paddingBlock: "3px"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading, var(--text-xs--line-height))"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	minW230px: {
			minWidth: "230px"
	},
	flex1: {
			flex: "1"
	},
	truncate: {
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
	},
	flexCol: {
			flexDirection: "column"
	},
	borderT: {
			borderTopStyle: "solid",
			borderTopWidth: "1px"
	},
	borderDividerSoft: {
			borderColor: "var(--divider-soft)"
	},
	bgRaised: {
			backgroundColor: "var(--bg-raised)"
	},
	p2: {
			padding: "calc(4px * 2)"
	},
	gap1: {
			gap: "4px"
	},
	gap25: {
			gap: "calc(4px * 2.5)"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))",

		cornerShape: "var(--cs)",},
	bgGreenSoft: {
			backgroundColor: "var(--green-soft)"
	},
	px3: {
			paddingInline: "calc(4px * 3)"
	},
	py15: {
			paddingBlock: "calc(4px * 1.5)"
	},
	Mb1: {
			marginBottom: "calc(4px * -1)"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	gap7px: {
			gap: "7px"
	},
	wFull: {
			width: "100%"
	},
	px3px: {
			paddingInline: "3px"
	},
	py1: {
			paddingBlock: "4px"
	},
	textLeft: {
			textAlign: "left"
	},
	borderL: {
			borderLeftStyle: "solid",
			borderLeftWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	pl3: {
			paddingLeft: "calc(4px * 3)"
	},
	pb2: {
			paddingBottom: "calc(4px * 2)"
	},
	textCenter: {
			textAlign: "center"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	bgBg: {
			backgroundColor: "var(--bg)"
	},
	minH11: {
			minHeight: "calc(4px * 11)"
	},
	border0: {
			borderStyle: "solid",
			borderWidth: "0px"
	},
	py2: {
			paddingBlock: "calc(4px * 2)"
	},
	py3: {
			paddingBlock: "calc(4px * 3)"
	},
	mb2: {
			marginBottom: "calc(4px * 2)"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))",

		cornerShape: "var(--cs)",},
	bgYellowSoft: {
			backgroundColor: "var(--yellow-soft)"
	},
	px15: {
			paddingInline: "calc(4px * 1.5)"
	},
	textYellow: {
			color: "var(--yellow)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	p3: {
			padding: "calc(4px * 3)"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	gap3: {
			gap: "calc(4px * 3)"
	},
	mr1: {
			marginRight: "4px"
	},
	py5px: {
			paddingBlock: "5px"
	},
	px14px: {
			paddingInline: "14px"
	},
	py6px: {
			paddingBlock: "6px"
	},
});

/* The +/− counts. DiffPanel's summary strip carries the same pair, and the two
   must read alike. */
const DIFF_ADD = utilityClassName("font-semibold text-green");
const DIFF_DEL = utilityClassName("font-semibold text-red");

/* One collapsible file. The header is the hover group for the edit and discard
   actions revealed inside editable worktree diffs. */
const FILE_ROW =
  utilityClassName("isolate min-w-0 max-w-full overflow-clip rounded-lg border border-line bg-bg");
const FILE_HEADER =
  "group relative flex min-h-9 w-full min-w-0 items-center gap-1.5 overflow-clip px-2 text-left text-fg hover:bg-hover phone:min-h-11 phone:px-2.5";
// Clip the scrolling diff at its own lower corners. The parent keeps sticky
// headers working with `overflow-clip`, but a positioned body needs to own the
// bottom radius so its painted code surface can never square off the file row.
const FILE_BODY = utilityClassName("relative z-0 max-w-full overflow-clip rounded-b-lg");
// The outer row owns the rounded frame. The square sticky layer masks code
// below the header's curved corners with the surrounding surface, while the
// inner surface draws the actual rounded top bar. Overlap the scroll edge by a
// pixel so code cannot peek above either layer.
const STICKY_FILE_HEADER =
  "sticky top-[calc(var(--review-file-header-top,0px)-1px)] z-[6] bg-surface";
const STICKY_FILE_HEADER_SURFACE =
  "rounded-t-lg bg-bg group-data-[stuck]:shadow-[inset_0_0_0_1px_var(--border),inset_0_-1px_0_var(--divider)]";
const FILE_TOGGLE =
  "focus-ring flex min-w-0 cursor-pointer items-center gap-2 self-stretch border-none bg-transparent p-0 text-left text-fg";

/* Revealed on row hover but always occupying its space (opacity, not display),
   so nothing can shift under the pointer. Focus reveals it too — hover cannot
   be the only way to reach a control. */
const REVEAL =
  "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100";
const REVEALED = "pointer-events-auto opacity-100";
/* The edit action sits directly after the filename and always reserves its
   space, so revealing it cannot shift the rest of the row. */
const INLINE_ACTION =
  "inline-flex shrink-0 items-center justify-center rounded-md border-none bg-transparent transition-[color,background,opacity]";
/* The discard action overlays the stats at the row's trailing edge. No cursor
   here on purpose: the in-flight state wants `cursor-default`, and two cursor
   utilities on one element resolve by Tailwind's output order, not by which
   was written last. */
const ROW_ACTION =
  "absolute top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-md border-none bg-transparent transition-[color,background,opacity]";

/* The comment card and the pending-comment card share their surface. */
const CARD = "mx-2 my-1.5 flex flex-col rounded-md bg-panel font-sans";
const CARD_INPUT =
  utilityClassName("resize-y rounded-md border border-line-strong bg-raised px-2.5 py-2 font-sans text-label leading-[1.45] text-fg outline-none focus:border-accent");

/* The "Organizing files…" / "AI organized" note, left of the toolbar's actions. */
const GROUPS_NOTE =
  utilityClassName("mr-auto flex items-center gap-[7px] text-label text-faint phone:hidden @max-[540px]:hidden");

/* A changed image, shown as the actual picture. Checkerboard backing so
   transparency reads as transparency rather than as white. */
const IMAGE_CELL = utilityClassName("m-0 max-w-[min(480px,100%)] min-w-0 flex-[0_1_auto]");
const IMAGE =
  utilityClassName("block max-h-[360px] max-w-full rounded-md border border-line bg-[repeating-conic-gradient(rgba(128,128,128,0.18)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]");
const IMAGE_CAPTION = utilityClassName("mt-1 text-meta text-dim");

class CommentDraftText {
  private value = "";
  read() {
    return this.value;
  }
  write(value: string) {
    this.value = value;
  }
  clear() {
    this.value = "";
  }
}

let editModulePromise: Promise<typeof import("@pierre/diffs/edit")> | null = null;
function loadEditModule() {
  if (!editModulePromise) editModulePromise = import("@pierre/diffs/edit");
  return editModulePromise;
}

export interface CommentTarget {
  path: string;
  startLine: number;
  endLine: number;
  side: "additions" | "deletions";
}

export interface PendingComment extends CommentTarget {
  id: string;
  text: string;
}

/** URLs for a changed image's two sides (either may be absent). */
export interface DiffImageSrcs {
  oldSrc?: string;
  newSrc?: string;
}

interface Props {
  patch: string;
  submitLabel: string;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
  /** Expand this many leading files on first render. */
  defaultExpandedFiles?: number;
  /** Omit the global expander when mounting every file would exhaust the tab. */
  allowExpandAll?: boolean;
  /** Move the global file controls into a parent toolbar. Omit to keep them inline. */
  controlsTarget?: Element | null;
  /** Show the aggregate viewed-file count beside the global controls. */
  showViewedProgress?: boolean;
  onSubmit: (target: CommentTarget, text: string) => Promise<void>;
  /**
   * When provided, changed image files render the actual pictures (before/after)
   * instead of an empty binary diff. The callback maps a file to the URLs of its
   * two sides — the host knows where the bytes live (worktree endpoint, PR blob
   * endpoint). Non-image files are unaffected.
   */
  imageSrcs?: (file: FileDiffMetadata) => DiffImageSrcs | null;
  /** AI-generated logical categories. Omitted while generation is pending or
   *  unavailable, preserving the ordinary flat file list. */
  groups?: DiffFileGroup[];
  groupsLoading?: boolean;
  /** Hide grouping status when the host presents it elsewhere. */
  showGroupsStatus?: boolean;
  /** PR review canvases use GitHub's side-by-side presentation; workspace diffs stay unified. */
  diffStyle?: "unified" | "split";
  /** Soft-wrap long lines instead of scrolling each file horizontally. */
  wrapLines?: boolean;
  /** Highlight the changed words within added and removed lines. */
  structuralHighlighting?: boolean;
  /** Show per-file addition and deletion totals in file and group headers. */
  showFileStats?: boolean;
  /** Follow the app theme, or pin the code surface light or dark. */
  codeTheme?: "system" | "light" | "dark";
  /** Optional review-canvas ordering, with paths absent from the list hidden. */
  visibleFileOrder?: readonly string[];
  /** Review-only file actions supplied by the PR host. */
  fileActions?: {
    providerName: string;
    url: (file: FileDiffMetadata) => string | null;
    loadContents?: (file: FileDiffMetadata) => Promise<string | null>;
  };
  /** Keep each filename visible while its expanded file scrolls through a review canvas. */
  stickyFileHeaders?: boolean;
  /**
   * Review-batching mode: when provided, already-added comments render inline as
   * pending cards (the parent owns the list and submits them as one review).
   * Without it the component stays single-shot (e.g. session feedback).
   */
  pendingComments?: PendingComment[];
  onRemovePending?: (id: string) => void;
  /** Provider-native resolved conversations, grouped beneath their file and
   * collapsed until the reader opens one. */
  reviewThreads?: PrReviewThread[];
  /** Repository context for qualified links inside review comments. */
  commentRepo?: string;
  /**
   * When provided, each file row gets a hover-revealed "Discard" action that
   * resets the file to its base state (removing it from the diff). Only wired
   * where the diff maps to a live, editable worktree (the session Changes tab),
   * never in read-only PR previews. `oldPath` is set for renames.
   */
  onDiscard?: (path: string, oldPath?: string) => Promise<void>;
  /**
   * GitHub-style per-file "Viewed" checkboxes, backed by GitHub's own
   * per-viewer viewed state (markFileAsViewed). The parent owns the set —
   * `undefined` means still loading (checkboxes hidden); marking a file
   * viewed collapses it. GitHub handles staleness: a file changed after
   * being viewed comes back DIRTY, which the server treats as not viewed.
   */
  viewedFiles?: ReadonlySet<string>;
  onToggleViewed?: (path: string, viewed: boolean) => void;
  /**
   * @pierre/diffs edit mode: makes files editable in place. Only wired where
   * the diff maps to a live worktree (the session Changes tab). `load` fetches
   * one side's full contents (the editor needs whole files, not hunks); `save`
   * writes the edited text back.
   */
  editFile?: {
    load: (
      file: FileDiffMetadata,
      side: "new" | "base",
    ) => Promise<string | null>;
    save: (path: string, content: string) => Promise<void>;
  };
}

interface Draft {
  fileIndex: number;
  path: string;
  range: SelectedLineRange;
}

type Meta = { kind: "draft" } | { kind: "pending"; comment: PendingComment };

// `theme`/`themeType` are applied per-row from the app's resolved appearance
// (see FileDiffRow) so the diff isn't pinned dark in light mode.
const BASE_OPTIONS = {
  diffStyle: "unified" as const,
  // Our own collapsible row owns the file header (name + stats + caret), so
  // suppress @pierre/diffs' built-in one to avoid a double header.
  disableFileHeader: true,
  // `overflow` is set per row from the caller's wrap preference.
  enableLineSelection: true,
};

/** Parse the patch and keep only the files the visible order names. */
function parseFileDiffs(
  patch: string,
  visibleFileOrder: readonly string[] | undefined,
): FileDiffMetadata[] {
  try {
    const parsed = parsePatchFiles(patch).flatMap((p) => p.files);
    if (!visibleFileOrder) return parsed;
    const order = new Map(
      visibleFileOrder.map((path, index) => [path, index]),
    );
    return parsed
      .filter((file) => order.has(file.name))
      .sort((a, b) => order.get(a.name)! - order.get(b.name)!);
  } catch {
    return [];
  }
}

/** Per-file +/- counts, summed from the parsed hunks. */
function fileStats(file: FileDiffMetadata): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) {
    add += h.additionLines;
    del += h.deletionLines;
  }
  return { add, del };
}

// Stable empty-annotations reference so files with no comments keep prop identity
// across re-renders (lets the memoized row bail out instead of re-parsing).
const NO_ANNOTATIONS: DiffLineAnnotation<Meta>[] = [];

const NO_VIEWED: ReadonlySet<string> = new Set();

/* Mounting a FileDiff parses and highlights that file on the main thread, so a
   surface that opens many at once — the review canvas expands every file, and
   "Expand all" is one click anywhere — commits one long, uninterruptible task.
   Admit them a couple per frame instead: the top of the diff paints straight
   away and the rest arrive under it, with the thread free in between for
   scrolling, clicking and the caret. The budget only ever gates a batch that
   opened together; once it has caught up with what is open, expanding one more
   file mounts it in the same commit as the click, as before. */
const MOUNT_FIRST_BATCH = 2;
const MOUNT_PER_FRAME = 4;

// The viewed set spans the whole PR while a guide section renders a subset,
// so count intersections rather than trusting `viewed.size`.
function countViewed(
  viewed: ReadonlySet<string>,
  files: FileDiffMetadata[],
): number {
  return files.reduce((n, f) => n + (viewed.has(f.name) ? 1 : 0), 0);
}

/**
 * Renders a multi-file patch with @pierre/diffs, one FileDiff per file so
 * line selections carry their file context. Selecting lines opens an inline
 * comment form (the diffs annotation framework); submit is delegated to the
 * parent (session feedback or GitHub PR comment).
 *
 * Perf: the comment-draft text lives in the inline `CommentForm` (local state),
 * NOT here — so typing re-renders only the open form, not every FileDiff. Each
 * row is memoized with stable props (annotations, onSelect, renderAnnotation),
 * so a selection change re-renders at most the two files it touches.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

export function CommentableDiff({
  patch,
  defaultExpandedFiles = 0,
  allowExpandAll = true,
  controlsTarget,
  showViewedProgress = true,
  submitLabel,
  placeholder,
  disabled,
  disabledHint,
  onSubmit,
  pendingComments,
  onRemovePending,
  reviewThreads,
  commentRepo,
  onDiscard,
  imageSrcs,
  groups,
  groupsLoading,
  showGroupsStatus = true,
  diffStyle = "unified",
  wrapLines = false,
  structuralHighlighting = true,
  showFileStats = true,
  codeTheme = "system",
  visibleFileOrder,
  fileActions,
  stickyFileHeaders = false,
  viewedFiles,
  onToggleViewed,
  editFile,
}: Props) {
  const reviewMode = pendingComments !== undefined;
  const resolvedTheme = useResolvedTheme();
  const theme = codeTheme === "system" ? resolvedTheme : codeTheme;
  const files = parseFileDiffs(patch, visibleFileOrder);

  // GitHub-backed "Viewed" checkboxes: hidden until the parent's fetch lands.
  const viewedEnabled = !!onToggleViewed && viewedFiles !== undefined;
  const viewed = viewedFiles ?? NO_VIEWED;
  const stats = (files.map(fileStats));

  // Files render collapsed by default (just the header row) — mounting a
  // FileDiff parses + highlights on the main thread, so a large change would
  // otherwise block the tab. `expanded` holds the indices the user opened.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(
    () =>
      new Set(
        files
          .slice(0, defaultExpandedFiles)
          .map((_, index) => index)
          .filter((index) =>
              canAutoExpandDiffFile(
                files[index].name,
                stats[index].add + stats[index].del,
              ),
          ),
      ),
  );
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // How many of the currently-open files may mount their FileDiff. Grows a
  // batch per frame until it covers them all (see MOUNT_FIRST_BATCH).
  const [mountBudget, setMountBudget] = useState(MOUNT_FIRST_BATCH);
  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  const allOpen = expanded.size >= files.length && files.length > 0;
  const toggleAll = () => {
    setExpanded((prev) => {
      if (prev.size >= files.length) return new Set();
      setCollapsedGroups(new Set());
      return new Set(files.map((_, i) => i));
    });
  };

  const groupedFiles = (() => {
    if (!groups?.length) return null;
    const byPath = new Map(files.map((file, index) => [file.name, index]));
    const used = new Set<number>();
    const resolved = groups.flatMap((group) => {
      const indices = group.files.flatMap((path) => {
        const index = byPath.get(path);
        if (index === undefined || used.has(index)) return [];
        used.add(index);
        return [index];
      });
      return indices.length ? [{ ...group, indices }] : [];
    });
    const remaining = files.flatMap((_, index) =>
      used.has(index) ? [] : [index],
    );
    if (remaining.length)
      resolved.push({ title: "Other", files: [], indices: remaining });
    return resolved.length >= 2 ? resolved : null;
  })();

  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [groups]);

  // Discard is destructive + irreversible, so it's a two-click arm/confirm:
  // the first click arms a row (button flips to "Discard changes?"), the second
  // within 4s performs it. `discarding` disables the row while the request runs.
  const [armed, setArmed] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const disarm = () => {
    clearTimeout(disarmTimer.current);
    setArmed(null);
  };
  const handleDiscard = async (file: FileDiffMetadata) => {
      if (!onDiscard) return;
      const key = file.name;
      if (armed !== key) {
        setArmed(key);
        clearTimeout(disarmTimer.current);
        disarmTimer.current = setTimeout(() => setArmed(null), 4000);
        return;
      }
      clearTimeout(disarmTimer.current);
      setArmed(null);
      setDiscarding(key);
      await (async () => {
await onDiscard(file.name, file.prevName);
})().finally(async () => {
setDiscarding(null);
});
    };
  useEffect(() => () => clearTimeout(disarmTimer.current), []);

  // Copying the path is the reliable way to get it out of the diff — text
  // selection breaks wherever the surrounding surface sets user-select: none.
  const [copied, setCopied] = useState<string | null>(null);
  const [stickyRoot, setStickyRoot] = useState<HTMLDivElement | null>(null);
  useStickyEdges(stickyRoot, stickyFileHeaders);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const copyPath = (path: string) => {
    copyToClipboard(path, () => {
      setCopied(path);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1400);
    });
  };
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const copyMenuValue = (value: string, message: string) => {
    copyToClipboard(value, () => toast(message));
  };
  const copyFileContents = async (file: FileDiffMetadata) => {
    const loadContents = fileActions?.loadContents;
    if (!loadContents) return;
    await (async () => {
const contents = await loadContents(file);
        if (contents == null) throw new Error("File is not available at this revision");
        copyMenuValue(contents, "File contents copied");
})().catch(async (error: any) => {
toast(error?.message || "Couldn’t copy file contents");
});
    };

  const viewedCollapseKey = useRef<string | null>(null);
  useEffect(() => {
    setExpanded(
      new Set(
        files
          .slice(0, defaultExpandedFiles)
          .map((_, index) => index)
          .filter((index) =>
            canAutoExpandDiffFile(
              files[index].name,
              stats[index].add + stats[index].del,
            ),
          ),
      ),
    );
    setMountBudget(MOUNT_FIRST_BATCH);
    viewedCollapseKey.current = null;
  }, [patch, defaultExpandedFiles, files, stats]);

  // Collapse already-viewed files once GitHub's viewed state arrives (it
  // loads async, after the diff renders). Applied once per patch so it never
  // fights a user who re-expands a viewed file.
  useEffect(() => {
    if (viewedFiles === undefined || viewedCollapseKey.current === patch)
      return;
    viewedCollapseKey.current = patch;
    if (viewedFiles.size === 0) return;
    setExpanded(
      (prev) =>
        new Set(
          [...prev].filter(
            (index) => !viewedFiles.has(files[index]?.name ?? ""),
          ),
        ),
    );
  }, [viewedFiles, patch, files]);

  const toggleViewed = (file: FileDiffMetadata, index: number) => {
      if (!onToggleViewed) return;
      const wasViewed = viewed.has(file.name);
      onToggleViewed(file.name, !wasViewed);
      // Marking viewed collapses the file (done reading it); unmarking reopens.
      setExpanded((prev) => {
        const n = new Set(prev);
        if (wasViewed) n.add(index);
        else n.delete(index);
        return n;
      });
    };

  // ---- Edit mode (@pierre/diffs edit) ------------------------------------
  // One file edits at a time. The editor engine is lazy-loaded on first use
  // (it's a full code editor; review-only surfaces never pay for it). The
  // active Editor instance is captured by the EditProvider factory so Save can
  // read the full edited text.
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editModuleRef = useRef<typeof import("@pierre/diffs/edit") | null>(
    null,
  );
  const editorRef = useRef<Editor<Meta> | null>(null);

  const startEdit = async (file: FileDiffMetadata, index: number) => {
    if (!editModuleRef.current) editModuleRef.current = await loadEditModule();
    setEditError(null);
    setEditingPath(file.name);
    setExpanded((prev) => new Set(prev).add(index));
    };

  const cancelEdit = () => {
    editorRef.current = null;
    setEditingPath(null);
    setEditError(null);
  };

  const saveEdit = async () => {
    const editor = editorRef.current;
    if (!editor || !editingPath || !editFile || savingEdit) return;
    setSavingEdit(true);
    setEditError(null);
    await (async () => {
await editFile.save(editingPath, editor.getText());
      editorRef.current = null;
      setEditingPath(null);
})().catch(async (e: any) => {
setEditError(e?.message || "Failed to save");
}).finally(async () => {
setSavingEdit(false);
});
  };

  const createEditor = (options: EditorOptions<Meta>) => {
    const editor = new editModuleRef.current!.Editor<Meta>(options);
    editorRef.current = editor;
    return editor;
  };

  // Full-contents loader for the file being edited: the editor needs whole
  // files, while a patch only carries hunks (saving hunk-only text would
  // truncate the file on disk).
  const loadDiffFiles = async (fd: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      if (!editFile) throw new Error("Not editable");
      const [oldText, newText] = await Promise.all([
        editFile.load(fd, "base"),
        editFile.load(fd, "new"),
      ]);
      return {
        oldFile:
          oldText == null
            ? null
            : { name: fd.prevName || fd.name, contents: oldText },
        newFile: { name: fd.name, contents: newText ?? "" },
      } as FileDiffLoadedFiles;
    };

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  useLayoutEffect(() => {
    draftRef.current = draft;
  });
  // Kept outside React render state so text survives a range-change remount
  // without making the full diff tree rerender on every textarea keystroke.
  const [draftText] = useState(() => new CommentDraftText());

  const handleSelect = (fileIndex: number, path: string, range: SelectedLineRange | null) => {
    if (!range) return; // keep the draft on stray deselects; Cancel closes it
    setConfirmation(null);
    setDraft({ fileIndex, path, range });
    };

  const closeDraft = () => {
    draftText.clear();
    setDraft(null);
  };

  const submitDraft = async (body: string) => {
      const d = draftRef.current;
      if (!d) return;
      const side: "additions" | "deletions" =
        d.range.side === "deletions" ? "deletions" : "additions";
      await onSubmit(
        {
          path: d.path,
          startLine: Math.min(d.range.start, d.range.end),
          endLine: Math.max(d.range.start, d.range.end),
          side,
        },
        body,
      );
      draftText.clear();
      setDraft(null);
      // In review mode the pending card is the confirmation; skip the toast.
      if (!reviewMode) {
        setConfirmation(`${submitLabel} ✓`);
        setTimeout(() => setConfirmation(null), 4000);
      }
    };

  const renderPending = (comment: PendingComment): React.ReactNode => {
      const lineLabel =
        comment.startLine === comment.endLine
          ? `line ${comment.startLine}`
          : `lines ${comment.startLine}–${comment.endLine}`;
      return (
        <div
          className={utilityClassName(`${CARD} gap-1.5 border border-l-[3px] border-line-strong border-l-accent px-2.5 py-[9px]`)}
          onClick={(e) => e.stopPropagation()}
        >
          <div {...stylex.props(sx.flex, sx.itemsCenter, sx.justifyBetween, sx.gap2)}>
            <span {...stylex.props(sx.textFaint, typography.meta)}>
              {comment.path} · {lineLabel}
              {comment.side === "deletions" ? " (removed)" : ""}
            </span>
            {onRemovePending && (
              <button
                {...mergeStylexProps("hover:text-red", sx.cursorPointer, sx.borderNone, sx.bgTransparent, sx.px1, sx.py05, sx.textFaint, typography.meta)}
                onClick={() => onRemovePending(comment.id)}
                title="Remove this pending comment"
              >
                Remove
              </button>
            )}
          </div>
          <div {...stylex.props(sx.leading145, sx.whitespacePreWrap, sx.textFg, sx.OverflowWrapAnywhere, typography.label)}>
            {comment.text}
          </div>
        </div>
      );
    };

  // Stable across draft/text changes (reads the current draft from the ref), so
  // memoized rows keep their prop identity while the user selects and types.
  const renderAnnotation = (annotation: DiffLineAnnotation<Meta>): React.ReactNode => {
      if (annotation.metadata?.kind === "pending") {
        return renderPending(annotation.metadata.comment);
      }
      const d = draftRef.current;
      if (!d) return null;
      const lineLabel =
        d.range.start === d.range.end
          ? `line ${d.range.start}`
          : `lines ${Math.min(d.range.start, d.range.end)}–${Math.max(d.range.start, d.range.end)}`;
      const targetLabel = `${d.path} · ${lineLabel}${d.range.side === "deletions" ? " (removed)" : ""}`;
      return (
        <CommentForm
          targetLabel={targetLabel}
          disabled={disabled}
          disabledHint={disabledHint}
          placeholder={placeholder}
          submitLabel={submitLabel}
          textStore={draftText}
          onCancel={closeDraft}
          onSubmit={submitDraft}
        />
      );
    };

  // Group pending comments by file once per change, so unaffected files reuse a
  // stable annotations array reference (and their memoized row bails out).
  const m = new Map<string, DiffLineAnnotation<Meta>[]>();
for (const c of pendingComments || []) {
      const arr = m.get(c.path) || [];
      arr.push({
        side: c.side === "deletions" ? "deletions" : "additions",
        lineNumber: c.endLine,
        metadata: { kind: "pending", comment: c },
      });
      m.set(c.path, arr);
    }
const pendingByFile = m;

  const resolvedByFile = (() => {
    const byPath = new Map<string, PrReviewThread[]>();
    for (const thread of reviewThreads || []) {
      if (!thread.isResolved || !thread.path) continue;
      const threads = byPath.get(thread.path) || [];
      threads.push(thread);
      byPath.set(thread.path, threads);
    }
    return byPath;
  })();

  // A file is open when the reader expanded it, or when something inside it
  // has to stay on screen: a comment being written, comments already added, an
  // edit session (collapsing would unmount the editor mid-edit).
  const isOpenAt = (file: FileDiffMetadata, index: number) =>
    expanded.has(index) ||
    draft?.fileIndex === index ||
    (pendingByFile.get(file.name)?.length ?? 0) > 0 ||
    editingPath === file.name;
  // Open files in reading order, so the staged budget admits them top-down.
  const mountRank = new Map<number, number>();
  files.forEach((file, index) => {
    if (isOpenAt(file, index)) mountRank.set(index, mountRank.size);
  });

  useEffect(() => {
    if (mountBudget >= mountRank.size) return;
    // A frame apart, and as a transition, so a click or a scroll lands before
    // the next batch of files rather than behind it.
    const frame = requestAnimationFrame(() =>
      startTransition(() => setMountBudget((n) => n + MOUNT_PER_FRAME)),
    );
    return () => cancelAnimationFrame(frame);
  }, [mountBudget, mountRank.size]);

  if (files.length === 0) {
    return <EmptyState>Nothing to display</EmptyState>;
  }

  const renderFile = (file: FileDiffMetadata, i: number) => {
    const pend = pendingByFile.get(file.name) || NO_ANNOTATIONS;
    const isDraftFile = draft?.fileIndex === i;
    const isEditing = editingPath === file.name;
    // Keep a file open while it holds a draft (the comment form lives inside
    // the diff), already-added pending comments (so they stay visible), or an
    // active edit session (collapsing would unmount the editor mid-edit).
    const isOpen =
      expanded.has(i) || isDraftFile || pend.length > 0 || isEditing;
    // Open, but its turn to parse has not come round yet — the header is
    // already drawn open, and the diff drops in a frame or two later.
    const mounted = (mountRank.get(i) ?? 0) < mountBudget;
    const isViewed = viewed.has(file.name);
    const resolved = resolvedByFile.get(file.name) || [];
    const editable =
      !!editFile && file.type !== "deleted" && !IMAGE_EXT.test(file.name);
    const s = stats[i];
    const slash = file.name.lastIndexOf("/");
    const dir = slash >= 0 ? file.name.slice(0, slash) : "";
    const base = slash >= 0 ? file.name.slice(slash + 1) : file.name;
    const fileUrl = fileActions?.url(file) ?? null;
    const annotations = isDraftFile
      ? [
          ...pend,
          {
            side: (draft!.range.side === "deletions"
              ? "deletions"
              : "additions") as "additions" | "deletions",
            lineNumber: Math.max(draft!.range.start, draft!.range.end),
            metadata: { kind: "draft" as const },
          },
        ]
      : pend;

    return (
      <div
        className={FILE_ROW}
        key={`${file.name}-${i}`}
        data-diff-file={file.name}
      >
        <div
          className={`group ${stickyFileHeaders ? STICKY_FILE_HEADER : ""}`}
          data-sticky-edge={stickyFileHeaders ? "" : undefined}
        >
          <div
            // `diff-file-header` is a DOM hook, not styling — no rule reaches it
            // any more: PrPanel's Files card finds this row by that class to
            // scroll to and expand a file (`el.querySelector(".diff-file-header")`).
            className={`${FILE_HEADER} ${stickyFileHeaders ? STICKY_FILE_HEADER_SURFACE : "bg-transparent"}`}
          >
          <button
            type="button"
            className={`diff-file-header ${FILE_TOGGLE}`}
            aria-expanded={isOpen}
            onClick={() => {
              disarm();
              toggle(i);
            }}
          >
            <IconChevronRight
              size={16}
              className={utilityClassName(`shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`)}
            />
            <span {...stylex.props(sx.flex, sx.size5, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textDim)}>
              {fileExt(base) ? (
                <ExtBadge name={base} size={14} />
              ) : (
                <IconFile size={17} />
              )}
            </span>
            <span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2, sx.overflowHidden, typography.label)}>
              <span {...stylex.props(sx.shrink0, sx.overflowHidden, sx.textEllipsis, sx.whitespaceNowrap, sx.fontSemibold, sx.textFg)}>
                {base}
              </span>
              {dir && (
                <span {...stylex.props(sx.minW0, sx.overflowHidden, sx.textEllipsis, sx.whitespaceNowrap, sx.textFaint)}>
                  {dir}
                </span>
              )}
            </span>
          </button>
          {editable && !isEditing && (
            <Tooltip label="Edit file in place">
              <button
                type="button"
                className={utilityClassName(`${INLINE_ACTION} ${REVEAL} cursor-pointer p-[3px] text-faint hover:bg-hover hover:text-fg phone:pointer-events-auto phone:opacity-100`)}
                aria-label="Edit this file in place"
                onClick={(e) => {
                  e.stopPropagation();
                  void startEdit(file, i);
                }}
              >
                <IconPencil size={16} />
              </button>
            </Tooltip>
          )}
          <Tooltip label={copied === file.name ? "Copied" : "Copy path"}>
            <Button
              variant="ghost"
              size="sm"
              className={utilityClassName(`phone:hidden ${copied === file.name ? "text-green" : "text-faint"}`)}
              aria-label={`Copy path ${file.name}`}
              icon={
                copied === file.name ? (
                  <IconCheck size={18} />
                ) : (
                  <IconCopy size={18} />
                )
              }
              onClick={() => copyPath(file.name)}
            />
          </Tooltip>
          {pend.length > 0 && (
            <span {...mergeStylexProps("before:text-meta before:content-['💬']", sx.inlineFlex, sx.shrink0, sx.itemsCenter, sx.gap3px, sx.fontSans, sx.textFaint, typography.meta)} >
              {pend.length}
            </span>
          )}
          {isEditing && (
            <span
              {...stylex.props(sx.mlAuto, sx.inlineFlex, sx.shrink0, sx.itemsCenter, sx.gap15)}
              onClick={(e) => e.stopPropagation()}
            >
              {editError && (
                <span {...stylex.props(sx.maxW260px, sx.overflowHidden, sx.textEllipsis, sx.whitespaceNowrap, sx.textRed, typography.label)}>
                  {editError}
                </span>
              )}
              <Button
                variant="soft"
                size="sm"
                className={mergeStylexOverrideClassName("", sx.minH0, sx.px25, sx.py3px, sx.textXs, sx.fontNormal)}
                onClick={cancelEdit}
                disabled={savingEdit}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                className={mergeStylexOverrideClassName("shadow-none", sx.minH0, sx.px25, sx.py3px, sx.textXs, sx.fontMedium)}
                onClick={saveEdit}
                disabled={savingEdit}
              >
                {savingEdit ? "Saving…" : "Save"}
              </Button>
            </span>
          )}
          {onDiscard && (
            <Tooltip
              label={
                discarding === file.name
                  ? "Discarding…"
                  : armed === file.name
                    ? "Click again to discard"
                    : "Discard changes"
              }
            >
              <button
                type="button"
                data-discard
                className={`${ROW_ACTION} right-2 p-0.5 ${
                  discarding === file.name
                    ? `${REVEALED} cursor-default text-faint`
                    : armed === file.name
                      ? `${REVEALED} cursor-pointer text-red`
                      : `${REVEAL} cursor-pointer text-faint hover:bg-hover hover:text-red`
                }`}
                disabled={discarding === file.name}
                aria-label="Discard this file's changes (reset to base)"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDiscard(file);
                }}
              >
                <IconUndo size={20} />
              </button>
            </Tooltip>
          )}
          {/* Change counts stay pinned right, before the review state and menu. */}
          {showFileStats && (
            <span
              className={utilityClassName(`ml-auto flex shrink-0 gap-1.5 text-meta ${
                isEditing ? "hidden" : ""
              } ${
                onDiscard
                  ? "group-hover:invisible [[data-discard]:focus-visible~&]:invisible"
                  : ""
              } ${armed === file.name || discarding === file.name ? "invisible" : ""}`)}
            >
              {s.add > 0 && <span className={DIFF_ADD}>+{s.add}</span>}
              {s.del > 0 && <span className={DIFF_DEL}>−{s.del}</span>}
            </span>
          )}
          {viewedEnabled && (
            <label
              className={utilityClassName(`inline-flex shrink-0 cursor-pointer items-center gap-[5px] pl-1 font-sans text-label select-none ${
                isViewed ? "text-dim" : "text-faint"
              }`)}
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={isViewed}
                onCheckedChange={() => toggleViewed(file, i)}
              />
              Reviewed
            </label>
          )}
          {fileActions && (
            <Menu.Root>
              <Tooltip label="File actions">
                <Menu.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`File actions for ${file.name}`}
                      icon={<IconDotsHorizontal size={18} />}
                    />
                  }
                />
              </Tooltip>
              <Menu.Popup align="end" className={mergeStylexOverrideClassName("", sx.minW230px)}>
                {fileUrl && (
                  <>
                    <Menu.Item
                      onClick={() =>
                        window.open(fileUrl, "_blank", "noopener,noreferrer")
                      }
                    >
                      <IconArrowUpRight size={18} className={MENU_ICON} />
                      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                        Open file on {fileActions.providerName}
                      </span>
                    </Menu.Item>
                    <Menu.Item
                      onClick={() => copyMenuValue(fileUrl, "File link copied")}
                    >
                      <IconLink size={18} className={MENU_ICON} />
                      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                        Copy link to file
                      </span>
                    </Menu.Item>
                    <Menu.Separator />
                  </>
                )}
                <Menu.Item
                  onClick={() => copyMenuValue(file.name, "File path copied")}
                >
                  <IconCopy size={18} className={MENU_ICON} />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>Copy full path</span>
                </Menu.Item>
                <Menu.Item
                  onClick={() => copyMenuValue(base, "Filename copied")}
                >
                  <IconCopy size={18} className={MENU_ICON} />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>Copy filename</span>
                </Menu.Item>
                {fileActions.loadContents &&
                  file.type !== "deleted" &&
                  !IMAGE_EXT.test(file.name) && (
                  <Menu.Item onClick={() => void copyFileContents(file)}>
                    <IconCopy size={18} className={MENU_ICON} />
                    <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                      Copy file contents
                    </span>
                  </Menu.Item>
                )}
              </Menu.Popup>
            </Menu.Root>
          )}
          </div>
        </div>
        {(isOpen || resolved.length > 0) && (
          <div className={FILE_BODY}>
            {isOpen &&
              (imageSrcs && IMAGE_EXT.test(file.name) ? (
                <ImageDiffRow file={file} srcs={imageSrcs(file)} />
              ) : !mounted ? null : (
                <FileDiffRow
                  key={theme}
                  file={file}
                  fileIndex={i}
                  theme={theme}
                  diffStyle={diffStyle}
                  wrapLines={wrapLines}
                  structuralHighlighting={structuralHighlighting}
                  annotations={annotations}
                  selectedLines={isDraftFile ? draft!.range : null}
                  onSelect={handleSelect}
                  renderAnnotation={renderAnnotation}
                  editing={isEditing}
                  createEditor={isEditing ? createEditor : undefined}
                  loadDiffFiles={isEditing ? loadDiffFiles : undefined}
                />
              ))}
            {resolved.length > 0 && (
              <div {...stylex.props(sx.flex, sx.flexCol, sx.gap15, sx.borderT, sx.borderDividerSoft, sx.bgRaised, sx.p2)}>
                {resolved.map((thread) => (
                  <ResolvedReviewThread
                    key={thread.id}
                    thread={thread}
                    repo={commentRepo}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const viewedCount = countViewed(viewed, files);
  const controls = (
    <>
      {showGroupsStatus && groupsLoading && (
        <span className={GROUPS_NOTE} role="status">
          <Spinner className={mergeStylexOverrideClassName("", sx.textFaint)} />
          Organizing files…
        </span>
      )}
      {showGroupsStatus && !groupsLoading && groupedFiles && (
        <span
          className={utilityClassName(`${GROUPS_NOTE} before:size-[5px] before:rounded-full before:bg-accent before:content-['']`)}
        >
          AI organized
        </span>
      )}
      {viewedEnabled && showViewedProgress && (
        <span
          {...mergeStylexProps("tabular-nums", sx.flex, sx.itemsCenter, sx.gap1, sx.textFaint, typography.meta)}
          aria-label={`${viewedCount} of ${files.length} files viewed`}
        >
          <IconEye size={20} />
          {viewedCount} of {files.length}
        </span>
      )}
      {allowExpandAll && (
        <Tooltip label={allOpen ? "Collapse all" : "Expand all"}>
          <Button
            variant="ghost"
            size="sm"
            icon={
              <IconArrowUpToLine
                size={20}
                className={allOpen ? undefined : utilityClassName("rotate-180")}
              />
            }
            aria-label={allOpen ? "Collapse all" : "Expand all"}
            onClick={toggleAll}
          />
        </Tooltip>
      )}
    </>
  );

  return (
    <div ref={setStickyRoot} {...stylex.props(sx.flex, sx.flexCol, sx.gap25)}>
      {confirmation && (
        <div {...mergeStylexProps("text-green", sx.roundedMd, sx.bgGreenSoft, sx.px3, sx.py15, sx.fontSemibold, typography.label)} >
          {confirmation}
        </div>
      )}
      {controlsTarget === undefined ? (
        <div {...stylex.props(sx.Mb1, sx.flex, sx.itemsCenter, sx.justifyEnd)}>{controls}</div>
      ) : controlsTarget ? (
        createPortal(controls, controlsTarget)
      ) : null}
      {groupedFiles
        ? groupedFiles.map((group) => {
            const groupKey = `${group.title}\0${group.indices.join(",")}`;
            const collapsed = collapsedGroups.has(groupKey);
            const totals = group.indices.reduce(
              (sum, index) => ({
                add: sum.add + stats[index].add,
                del: sum.del + stats[index].del,
              }),
              { add: 0, del: 0 },
            );
            return (
              // Group headers are deliberately quieter than file rows: they
              // give scan structure without competing with filenames.
              <section
                {...mergeStylexProps("[section+&]:mt-1", sx.flex, sx.flexCol, sx.gap7px)}
                key={groupKey}
              >
                <button
                  type="button"
                  {...mergeStylexProps("hover:text-fg", sx.flex, sx.wFull, sx.cursorPointer, sx.itemsCenter, sx.gap7px, sx.borderNone, sx.bgTransparent, sx.px3px, sx.py1, sx.textLeft, sx.fontSans, sx.textDim)}
                  data-diff-group-files={JSON.stringify(
                    group.indices.map((index) => files[index].name),
                  )}
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setCollapsedGroups((previous) => {
                      const next = new Set(previous);
                      if (next.has(groupKey)) next.delete(groupKey);
                      else next.add(groupKey);
                      return next;
                    })
                  }
                >
                  <IconChevronRight
                    size={16}
                    className={utilityClassName(`shrink-0 text-faint transition-transform ${collapsed ? "" : "rotate-90"}`)}
                  />
                  <span {...stylex.props(sx.fontSemibold, typography.label)}>
                    {group.title}
                  </span>
                  <span {...stylex.props(sx.textFaint, typography.meta)}>
                    {group.indices.length}
                  </span>
                  {showFileStats && (
                  <span {...stylex.props(sx.mlAuto, sx.flex, sx.gap2, typography.meta)}>
                      {totals.add > 0 && (
                        <span className={DIFF_ADD}>+{totals.add}</span>
                      )}
                      {totals.del > 0 && (
                        <span className={DIFF_DEL}>−{totals.del}</span>
                      )}
                  </span>
                  )}
                </button>
                {!collapsed && (
                  <div {...stylex.props(sx.flex, sx.flexCol, sx.gap7px, sx.borderL, sx.borderLine, sx.pl3)}>
                    {group.indices.map((index) =>
                      renderFile(files[index], index),
                    )}
                  </div>
                )}
              </section>
            );
          })
        : files.map(renderFile)}
      <div {...stylex.props(sx.pb2, sx.textCenter, sx.textFaint, typography.meta)}>
        {disabled
          ? disabledHint || "Commenting is unavailable right now."
          : reviewMode
          ? "Click a line number (drag for a range) to add a comment. They stay pending until you finish the review."
          : "Click a line number (drag for a range) to comment."}
      </div>
    </div>
  );
}

/** A resolved provider-native thread. Its summary stays in the file until the
 * reader asks to expand the full conversation. */
function ResolvedReviewThread({
  thread,
  repo,
}: {
  thread: PrReviewThread;
  repo?: string;
}) {
  const [open, setOpen] = useState(false);
  const comments = thread.comments.flatMap((comment) => {
    const body = stripHtmlComments(comment.body);
    return body ? [{ ...comment, body }] : [];
  });
  if (!comments.length) return null;
  const count = comments.length;
  const author = thread.rootAuthor || comments[0].login || "Unknown";

  return (
    <article {...stylex.props(sx.overflowHidden, sx.roundedMd, sx.border, sx.borderDividerSoft, sx.bgBg)}>
      <button
        type="button"
        {...mergeStylexProps("focus-ring hover:bg-hover", sx.flex, sx.minH11, sx.wFull, sx.cursorPointer, sx.itemsCenter, sx.gap2, sx.border0, sx.bgTransparent, sx.px3, sx.py2, sx.textLeft, sx.textDim, typography.label)}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconCheckCircle size={17} className={mergeStylexOverrideClassName("", sx.shrink0, sx.textDim)} />
        <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
          {count} resolved {count === 1 ? "comment" : "comments"} from {author}
        </span>
        <IconChevronRight
          size={16}
          className={utilityClassName(`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`)}
        />
      </button>
      {open && (
        <div {...stylex.props(sx.borderT, sx.borderDividerSoft)}>
          {comments.map((comment, index) => (
            <div
              key={`${thread.id}-${index}`}
              {...mergeStylexProps("[&+&]:border-t [&+&]:border-divider-soft", sx.px3, sx.py3)}
            >
              <div {...stylex.props(sx.mb2, sx.flex, sx.itemsCenter, sx.gap2)}>
                <UserAvatar
                  name={comment.login || "Unknown"}
                  login={comment.login || null}
                  size={22}
                />
                <span {...stylex.props(sx.fontSemibold, sx.textFg, typography.label)}>
                  {comment.login || "Unknown"}
                </span>
                {index === 0 && thread.isOutdated && (
                  <span {...stylex.props(sx.roundedSm, sx.bgYellowSoft, sx.px15, sx.py05, sx.fontMedium, sx.textYellow, typography.meta)}>
                    Outdated
                  </span>
                )}
              </div>
              <div
                {...mergeStylexProps("markdown", sx.leadingRelaxed, sx.textDim, typography.label)}
                dangerouslySetInnerHTML={{
                  __html: renderPrCommentMarkdown(comment.body, { repo }),
                }}
              />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * A changed image, rendered as the actual pictures: before/after side by side
 * for a modification, a single picture for added/deleted files. Sides that
 * fail to load (e.g. an untracked file not in the base) hide themselves.
 */
function ImageDiffRow({
  file,
  srcs,
}: {
  file: FileDiffMetadata;
  srcs: DiffImageSrcs | null;
}) {
  const [oldErr, setOldErr] = useState(false);
  const [newErr, setNewErr] = useState(false);
  const showOld = !!srcs?.oldSrc && file.type !== "new" && !oldErr;
  const showNew = !!srcs?.newSrc && file.type !== "deleted" && !newErr;
  if (!showOld && !showNew)
    return (
      <div {...stylex.props(sx.p3, sx.textDim, typography.label)}>
        Image not available to preview
      </div>
    );
  return (
    <div {...stylex.props(sx.flex, sx.flexWrap, sx.gap3, sx.p3)}>
      {showOld && (
        <figure className={IMAGE_CELL}>
          <img
            className={`${IMAGE} opacity-80`}
            src={srcs!.oldSrc}
            alt=""
            loading="lazy"
            onError={() => setOldErr(true)}
          />
          <figcaption className={IMAGE_CAPTION}>
            <span {...stylex.props(sx.mr1, sx.textRed)}>−</span>
            {file.type === "deleted" ? "Deleted" : "Before"}
          </figcaption>
        </figure>
      )}
      {showNew && (
        <figure className={IMAGE_CELL}>
          <img
            className={IMAGE}
            src={srcs!.newSrc}
            alt=""
            loading="lazy"
            onError={() => setNewErr(true)}
          />
          <figcaption className={IMAGE_CAPTION}>
            <span {...mergeStylexProps("text-green", sx.mr1)} >+</span>
            {file.type === "new" ? "Added" : "After"}
          </figcaption>
        </figure>
      )}
    </div>
  );
}

/**
 * Inline comment form with its own React state, so keystrokes stay local. A
 * tiny non-rendering store preserves text if a selected-range change remounts
 * the form.
 */
const CommentForm = function CommentForm({
  targetLabel,
  disabled,
  disabledHint,
  placeholder,
  submitLabel,
  textStore,
  onCancel,
  onSubmit,
}: {
  targetLabel: string;
  disabled?: boolean;
  disabledHint?: string;
  placeholder: string;
  submitLabel: string;
  textStore: CommentDraftText;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState(() => textStore.read());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    await onSubmit(body).catch((error: any) => {
      setError(error.message || "Failed to submit");
      setSending(false);
    });
    // Success unmounts this form (parent clears the draft), so do not touch state.
  }

  return (
    <div
      className={utilityClassName(`${CARD} gap-2 border border-accent p-2.5`)}
      onClick={(e) => e.stopPropagation()}
    >
      <div {...stylex.props(sx.textFaint, typography.meta)}>{targetLabel}</div>
      {disabled ? (
        <div {...stylex.props(sx.textFaint, typography.label)}>
          {disabledHint || "Unavailable right now"}
        </div>
      ) : (
        <>
          <textarea
            className={CARD_INPUT}
            autoFocus
            rows={3}
            {...noAutofill}
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              textStore.write(e.target.value);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          {error && <div {...stylex.props(sx.textRed, typography.label)}>{error}</div>}
          <div {...stylex.props(sx.flex, sx.justifyEnd, sx.gap2)}>
            <Button
              variant="soft"
              size="sm"
              className={mergeStylexOverrideClassName("", sx.minH0, sx.px3, sx.py5px, sx.fontNormal, typography.label)}
              onClick={onCancel}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              className={mergeStylexOverrideClassName("shadow-none", sx.minH0, sx.px14px, sx.py6px, sx.fontMedium, typography.supporting)}
              onClick={submit}
              disabled={sending || !text.trim()}
            >
              {sending ? "Sending…" : submitLabel}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

/**
 * One file's diff. Memoized so an unrelated re-render (another file's selection,
 * typing in the comment form) doesn't re-parse/re-render this file.
 */
const FileDiffRow = function FileDiffRow({
  file,
  fileIndex,
  theme,
  diffStyle,
  wrapLines,
  structuralHighlighting,
  annotations,
  selectedLines,
  onSelect,
  renderAnnotation,
  editing,
  createEditor,
  loadDiffFiles,
}: {
  file: FileDiffMetadata;
  fileIndex: number;
  theme: "light" | "dark";
  diffStyle: "unified" | "split";
  wrapLines: boolean;
  structuralHighlighting: boolean;
  annotations: DiffLineAnnotation<Meta>[];
  selectedLines: SelectedLineRange | null;
  onSelect: (
    fileIndex: number,
    path: string,
    range: SelectedLineRange | null,
  ) => void;
  renderAnnotation: (annotation: DiffLineAnnotation<Meta>) => React.ReactNode;
  editing?: boolean;
  createEditor?: (options: EditorOptions<Meta>) => DiffsEditor<Meta>;
  loadDiffFiles?: (fd: FileDiffMetadata) => Promise<FileDiffLoadedFiles>;
}) {
  const options = (({
      ...BASE_OPTIONS,
      diffStyle,
      overflow: wrapLines ? ("wrap" as const) : ("scroll" as const),
      lineDiffType: structuralHighlighting
        ? ("word-alt" as const)
        : ("none" as const),
      theme: theme === "light" ? "pierre-light" : "pierre-dark",
      themeType: theme,
      // Line selection drives commenting; while editing, clicks place the
      // caret instead.
      enableLineSelection: !editing,
      ...(loadDiffFiles ? { loadDiffFiles } : {}),
      onLineSelected: (range: SelectedLineRange | null) =>
        onSelect(fileIndex, file.name, range),
    }));

  const fileDiff = (
    <FileDiff<Meta>
      fileDiff={file}
      options={options}
      edit={editing}
      lineAnnotations={annotations}
      selectedLines={selectedLines}
      renderAnnotation={renderAnnotation}
      // Not the lever it looks like: the prop only decides whether to pass the
      // pool down from @pierre/diffs' WorkerPoolContext, and nothing in this
      // app mounts that provider, so highlighting is on the main thread either
      // way. Wiring the pool needs a workerFactory pointing at a bundled
      // worker script, and Bun's bundler (1.3.14) does not transform
      // `new Worker(new URL(...))` at all, so the URL would ship verbatim and
      // 404. Staged mounting above is what keeps the task short instead.
      disableWorkerPool
    />
  );

  // The provider only matters while editing; keeping the read-only tree
  // identical to before avoids any behavior drift on non-editable surfaces.
  return editing && createEditor ? (
    <EditProvider<Meta> createEditor={createEditor}>{fileDiff}</EditProvider>
  ) : (
    fileDiff
  );
};
