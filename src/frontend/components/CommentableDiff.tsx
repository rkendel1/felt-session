import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { SelectedLineRange, FileDiffMetadata, DiffLineAnnotation } from "@pierre/diffs";
import type { DiffFileGroup } from "../lib/types";
import { IconChevronRight, IconUndo } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { useResolvedTheme } from "./CodeHighlight";
import { PixelSpinner } from "./PixelSpinner";

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
  /** Expand this many leading files on first render (review canvas uses 10). */
  defaultExpandedFiles?: number;
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
  /** PR review canvases use GitHub's side-by-side presentation; workspace diffs stay unified. */
  diffStyle?: "unified" | "split";
  /**
   * Review-batching mode: when provided, already-added comments render inline as
   * pending cards (the parent owns the list and submits them as one review).
   * Without it the component stays single-shot (e.g. session feedback).
   */
  pendingComments?: PendingComment[];
  onRemovePending?: (id: string) => void;
  /**
   * When provided, each file row gets a hover-revealed "Discard" action that
   * resets the file to its base state (removing it from the diff). Only wired
   * where the diff maps to a live, editable worktree (the session Changes tab),
   * never in read-only PR previews. `oldPath` is set for renames.
   */
  onDiscard?: (path: string, oldPath?: string) => Promise<void>;
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
  overflow: "scroll" as const,
  enableLineSelection: true,
};

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
  submitLabel,
  placeholder,
  disabled,
  disabledHint,
  onSubmit,
  pendingComments,
  onRemovePending,
  onDiscard,
  imageSrcs,
  groups,
  groupsLoading,
  diffStyle = "unified",
}: Props) {
  const reviewMode = pendingComments !== undefined;
  const theme = useResolvedTheme();
  const files = useMemo<FileDiffMetadata[]>(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [patch]);

  // Files render collapsed by default (just the header row) — mounting a
  // FileDiff parses + highlights on the main thread, so a large change would
  // otherwise block the tab. `expanded` holds the indices the user opened.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(
    () => new Set(files.slice(0, defaultExpandedFiles).map((_, index) => index)),
  );
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggle = useCallback((i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);
  const allOpen = expanded.size >= files.length && files.length > 0;
  const toggleAll = useCallback(() => {
    setExpanded((prev) => {
      if (prev.size >= files.length) return new Set();
      setCollapsedGroups(new Set());
      return new Set(files.map((_, i) => i));
    });
  }, [files]);

  const stats = useMemo(() => files.map(fileStats), [files]);
  const groupedFiles = useMemo(() => {
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
    const remaining = files.flatMap((_, index) => (used.has(index) ? [] : [index]));
    if (remaining.length) resolved.push({ title: "Other", files: [], indices: remaining });
    return resolved.length >= 2 ? resolved : null;
  }, [files, groups]);

  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [groups]);

  // Discard is destructive + irreversible, so it's a two-click arm/confirm:
  // the first click arms a row (button flips to "Discard changes?"), the second
  // within 4s performs it. `discarding` disables the row while the request runs.
  const [armed, setArmed] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useCallback(() => {
    clearTimeout(disarmTimer.current);
    setArmed(null);
  }, []);
  const handleDiscard = useCallback(
    async (file: FileDiffMetadata) => {
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
      try {
        await onDiscard(file.name, file.prevName);
      } finally {
        setDiscarding(null);
      }
    },
    [onDiscard, armed],
  );
  useEffect(() => () => clearTimeout(disarmTimer.current), []);

  useEffect(() => {
    setExpanded(
      new Set(files.slice(0, defaultExpandedFiles).map((_, index) => index)),
    );
  }, [patch, defaultExpandedFiles]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  // Draft text is held in a ref so it survives the form remounting when the
  // selection range is adjusted, without re-rendering the diff on each keystroke.
  const draftTextRef = useRef("");

  const handleSelect = useCallback((fileIndex: number, path: string, range: SelectedLineRange | null) => {
    if (!range) return; // keep the draft on stray deselects; Cancel closes it
    setConfirmation(null);
    setDraft({ fileIndex, path, range });
  }, []);

  const closeDraft = useCallback(() => {
    draftTextRef.current = "";
    setDraft(null);
  }, []);

  const submitDraft = useCallback(
    async (body: string) => {
      const d = draftRef.current;
      if (!d) return;
      const side: "additions" | "deletions" = d.range.side === "deletions" ? "deletions" : "additions";
      await onSubmit(
        {
          path: d.path,
          startLine: Math.min(d.range.start, d.range.end),
          endLine: Math.max(d.range.start, d.range.end),
          side,
        },
        body,
      );
      draftTextRef.current = "";
      setDraft(null);
      // In review mode the pending card is the confirmation; skip the toast.
      if (!reviewMode) {
        setConfirmation(`${submitLabel} ✓`);
        setTimeout(() => setConfirmation(null), 4000);
      }
    },
    [onSubmit, reviewMode, submitLabel],
  );

  const renderPending = useCallback(
    (comment: PendingComment): React.ReactNode => {
      const lineLabel =
        comment.startLine === comment.endLine
          ? `line ${comment.startLine}`
          : `lines ${comment.startLine}–${comment.endLine}`;
      return (
        <div className="diff-pending-comment m-2 flex flex-col gap-1.5 rounded-md border border-line-strong border-l-[3px] border-l-accent bg-panel px-2.5 py-[9px] font-sans" onClick={(e) => e.stopPropagation()}>
          <div className="diff-pending-head flex items-center justify-between gap-2">
            <span className="diff-comment-target font-mono text-meta text-faint">
              {comment.path} · {lineLabel}
              {comment.side === "deletions" ? " (removed)" : ""}
            </span>
            {onRemovePending && (
              <button
                className="diff-pending-remove border-0 bg-transparent px-1 py-0.5 text-meta text-faint hover:text-red"
                onClick={() => onRemovePending(comment.id)}
                title="Remove this pending comment"
              >
                Remove
              </button>
            )}
          </div>
          <div className="diff-pending-text whitespace-pre-wrap break-words text-control-label leading-[1.45] text-fg">{comment.text}</div>
        </div>
      );
    },
    [onRemovePending],
  );

  // Stable across draft/text changes (reads the current draft from the ref), so
  // memoized rows keep their prop identity while the user selects and types.
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<Meta>): React.ReactNode => {
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
          textRef={draftTextRef}
          onCancel={closeDraft}
          onSubmit={submitDraft}
        />
      );
    },
    [renderPending, disabled, disabledHint, placeholder, submitLabel, closeDraft, submitDraft],
  );

  // Group pending comments by file once per change, so unaffected files reuse a
  // stable annotations array reference (and their memoized row bails out).
  const pendingByFile = useMemo(() => {
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
    return m;
  }, [pendingComments]);

  if (files.length === 0) {
    return <div className="panel-placeholder">Nothing to display</div>;
  }

  const renderFile = (file: FileDiffMetadata, i: number) => {
    const pend = pendingByFile.get(file.name) || NO_ANNOTATIONS;
    const isDraftFile = draft?.fileIndex === i;
    // Keep a file open while it holds a draft (the comment form lives inside
    // the diff) or already-added pending comments (so they stay visible).
    const isOpen = expanded.has(i) || isDraftFile || pend.length > 0;
    const s = stats[i];
    const slash = file.name.lastIndexOf("/");
    const dir = slash >= 0 ? file.name.slice(0, slash + 1) : "";
    const base = slash >= 0 ? file.name.slice(slash + 1) : file.name;
    const annotations = isDraftFile
      ? [
          ...pend,
          {
            side: (draft!.range.side === "deletions" ? "deletions" : "additions") as "additions" | "deletions",
            lineNumber: Math.max(draft!.range.start, draft!.range.end),
            metadata: { kind: "draft" as const },
          },
        ]
      : pend;

    return (
      <div className="diff-file overflow-hidden rounded-md border border-line bg-panel" key={`${file.name}-${i}`} data-diff-file={file.name}>
        <div
          className="diff-file-header relative flex w-full items-center gap-2 border-0 bg-transparent px-2.5 py-2 text-left text-fg hover:bg-hover"
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => {
            disarm();
            toggle(i);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              disarm();
              toggle(i);
            }
          }}
        >
          <IconChevronRight
            size={16}
            className={`diff-file-caret shrink-0 text-faint transition-transform duration-100 ${isOpen ? "diff-file-caret-open rotate-90" : ""}`}
          />
          <span className="diff-file-name flex min-w-0 flex-1 cursor-text select-text overflow-hidden font-mono text-supporting" onClick={(e) => e.stopPropagation()}>
            {dir && <span className="diff-file-dir min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap text-faint">{dir}</span>}
            <span className="diff-file-base shrink-0 whitespace-nowrap font-semibold text-fg">{base}</span>
          </span>
          {pend.length > 0 && <span className="diff-file-comments inline-flex shrink-0 items-center gap-1 font-sans text-meta text-faint before:content-['💬']">{pend.length}</span>}
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
                className={`diff-file-discard absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-sm border-0 bg-transparent p-0.5 text-faint opacity-0 pointer-events-none transition-[color,background,opacity] duration-100 hover:bg-hover hover:text-red focus-visible:opacity-100 focus-visible:pointer-events-auto disabled:pointer-events-auto disabled:opacity-100 disabled:cursor-default ${armed === file.name ? "diff-file-discard-armed pointer-events-auto text-red opacity-100" : ""}`}
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
          <span className="diff-file-stats ml-auto flex shrink-0 gap-2 font-mono text-label group-hover:invisible">
            {s.add > 0 && <span className="diff-add font-semibold text-green">+{s.add}</span>}
            {s.del > 0 && <span className="diff-del font-semibold text-red">−{s.del}</span>}
          </span>
        </div>
        {isOpen &&
          (imageSrcs && IMAGE_EXT.test(file.name) ? (
            <ImageDiffRow file={file} srcs={imageSrcs(file)} />
          ) : (
            <FileDiffRow
              key={theme}
              file={file}
              fileIndex={i}
              theme={theme}
              diffStyle={diffStyle}
              annotations={annotations}
              selectedLines={isDraftFile ? draft!.range : null}
              onSelect={handleSelect}
              renderAnnotation={renderAnnotation}
            />
          ))}
      </div>
    );
  };

  return (
    <div className="commentable-diff flex flex-col gap-2.5">
      {confirmation && <div className="diff-comment-confirmation rounded-sm bg-green-soft px-3 py-1.5 text-supporting font-semibold text-green">{confirmation}</div>}
      <div className="diff-file-toolbar -mb-1 flex items-center justify-end">
        {groupsLoading && (
          <span className="diff-groups-loading mr-auto flex items-center gap-2 text-label text-faint" role="status">
            <PixelSpinner cycling={false} className="text-faint" />
            Organizing files…
          </span>
        )}
        {!groupsLoading && groupedFiles && (
          <span className="diff-groups-ready mr-auto flex items-center gap-2 text-label text-faint before:size-1.5 before:rounded-full before:bg-accent before:content-['']">AI organized</span>
        )}
        <button type="button" className="diff-file-toggle-all border-0 bg-transparent px-1 py-0.5 text-label font-medium text-faint hover:text-fg" onClick={toggleAll}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
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
              <section className="diff-file-group flex flex-col gap-2 [&+&]:mt-1" key={groupKey}>
                <button
                  type="button"
                  className="diff-file-group-header flex w-full items-center gap-2 border-0 bg-transparent px-1 py-1 text-left text-dim hover:text-fg"
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
                    className={`diff-file-caret shrink-0 text-faint transition-transform duration-100 ${collapsed ? "" : "diff-file-caret-open rotate-90"}`}
                  />
                  <span className="diff-file-group-title text-control-label font-semibold">{group.title}</span>
                  <span className="diff-file-group-count text-meta text-faint">{group.indices.length}</span>
                  <span className="diff-file-group-stats ml-auto flex gap-2 font-mono text-meta">
                    {totals.add > 0 && <span className="diff-add font-semibold text-green">+{totals.add}</span>}
                    {totals.del > 0 && <span className="diff-del font-semibold text-red">−{totals.del}</span>}
                  </span>
                </button>
                {!collapsed && (
                  <div className="diff-file-group-files flex flex-col gap-2 border-l border-line pl-3">
                    {group.indices.map((index) => renderFile(files[index], index))}
                  </div>
                )}
              </section>
            );
          })
        : files.map(renderFile)}
      <div className="diff-comment-hint pb-2 text-center text-meta text-faint">
        {reviewMode
          ? "Click a line number (drag for a range) to add a comment. They stay pending until you finish the review."
          : "Click a line number (drag for a range) to comment."}
      </div>
    </div>
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
    return <div className="diff-image-empty p-3 text-label text-dim">Image not available to preview</div>;
  return (
    <div className="diff-image-row flex flex-wrap gap-3 p-3">
      {showOld && (
        <figure className="diff-image-cell diff-image-old m-0 min-w-0 max-w-full flex-[0_1_auto]">
          <img className="block max-h-[360px] max-w-full rounded-sm border border-line bg-[repeating-conic-gradient(rgba(128,128,128,0.18)_0%_25%,transparent_0%_50%)_0_0/16px_16px] opacity-80" src={srcs!.oldSrc} alt="" loading="lazy" onError={() => setOldErr(true)} />
          <figcaption className="mt-1 text-meta text-dim before:mr-1 before:text-red before:content-['−']">{file.type === "deleted" ? "Deleted" : "Before"}</figcaption>
        </figure>
      )}
      {showNew && (
        <figure className="diff-image-cell diff-image-new m-0 min-w-0 max-w-full flex-[0_1_auto]">
          <img className="block max-h-[360px] max-w-full rounded-sm border border-line bg-[repeating-conic-gradient(rgba(128,128,128,0.18)_0%_25%,transparent_0%_50%)_0_0/16px_16px]" src={srcs!.newSrc} alt="" loading="lazy" onError={() => setNewErr(true)} />
          <figcaption className="mt-1 text-meta text-dim before:mr-1 before:text-green before:content-['+']">{file.type === "new" ? "Added" : "After"}</figcaption>
        </figure>
      )}
    </div>
  );
}

/**
 * Inline comment form with its OWN text/sending/error state, so keystrokes
 * re-render just this form — not the parent diff. Seeds from `textRef` (which
 * the parent keeps) so text survives the form remounting on range changes.
 */
const CommentForm = React.memo(function CommentForm({
  targetLabel,
  disabled,
  disabledHint,
  placeholder,
  submitLabel,
  textRef,
  onCancel,
  onSubmit,
}: {
  targetLabel: string;
  disabled?: boolean;
  disabledHint?: string;
  placeholder: string;
  submitLabel: string;
  textRef: React.MutableRefObject<string>;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState(textRef.current);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(body);
      // Success unmounts this form (parent clears the draft) — don't touch state.
    } catch (e: any) {
      setError(e.message || "Failed to submit");
      setSending(false);
    }
  }

  return (
    <div className="diff-comment-form m-2 flex flex-col gap-2 rounded-md border border-accent bg-panel p-2.5 font-sans" onClick={(e) => e.stopPropagation()}>
      <div className="diff-comment-target font-mono text-meta text-faint">{targetLabel}</div>
      {disabled ? (
        <div className="diff-comment-disabled text-supporting text-faint">{disabledHint || "Unavailable right now"}</div>
      ) : (
        <>
          <textarea
            className="diff-comment-input resize-y rounded-sm border border-line-strong bg-raised px-2.5 py-2 text-control-label leading-[1.45] text-fg outline-none focus:border-accent"
            autoFocus
            rows={3}
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              textRef.current = e.target.value;
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          {error && <div className="diff-comment-error text-label text-red">{error}</div>}
          <div className="diff-comment-actions flex justify-end gap-2">
            <Button
              variant="default"
              size="sm"
              className="min-h-0 border-line-strong bg-transparent px-3 py-[5px] text-control-label font-normal shadow-none"
              onClick={onCancel}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="min-h-0 px-[14px] py-[6px] text-supporting font-medium shadow-none"
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
});

/**
 * One file's diff. Memoized so an unrelated re-render (another file's selection,
 * typing in the comment form) doesn't re-parse/re-render this file.
 */
const FileDiffRow = React.memo(function FileDiffRow({
  file,
  fileIndex,
  theme,
  diffStyle,
  annotations,
  selectedLines,
  onSelect,
  renderAnnotation,
}: {
  file: FileDiffMetadata;
  fileIndex: number;
  theme: "light" | "dark";
  diffStyle: "unified" | "split";
  annotations: DiffLineAnnotation<Meta>[];
  selectedLines: SelectedLineRange | null;
  onSelect: (fileIndex: number, path: string, range: SelectedLineRange | null) => void;
  renderAnnotation: (annotation: DiffLineAnnotation<Meta>) => React.ReactNode;
}) {
  const options = useMemo(
    () => ({
      ...BASE_OPTIONS,
      diffStyle,
      theme: theme === "light" ? "pierre-light" : "pierre-dark",
      themeType: theme,
      onLineSelected: (range: SelectedLineRange | null) => onSelect(fileIndex, file.name, range),
    }),
    [diffStyle, fileIndex, file.name, onSelect, theme],
  );

  return (
    <FileDiff<Meta>
      fileDiff={file}
      options={options}
      lineAnnotations={annotations}
      selectedLines={selectedLines}
      renderAnnotation={renderAnnotation}
      disableWorkerPool
    />
  );
});
