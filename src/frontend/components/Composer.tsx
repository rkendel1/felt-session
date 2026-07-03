import React, { useEffect, useRef, useState } from "react";
import type { ModelOption, FileMention } from "../lib/api";
import { splitAttachments, imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { loadDraft, saveDraft } from "../lib/drafts";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { useFileMentions } from "./useFileMentions";
import {
  IconArrowUp,
  IconBolt,
  IconArrowDownRight,
  IconPlus,
  IconPaperclip,
  IconAtSign,
  IconCrosshair,
  IconChevronDown,
} from "./icons";
import { Tooltip } from "../ui/tooltip";
import { BottomSheet } from "../ui/sheet";
import { VoiceInput } from "./VoiceInput";
import { useIsPhone } from "../hooks/useIsPhone";

interface Props {
  /**
   * Controlled draft text. Omit it (with `onChange`) to let the Composer own
   * the draft internally — the parent then receives the text via `onSend` and
   * stops re-rendering on every keystroke (the CommentableDiff draft-text
   * lesson). In uncontrolled mode the draft clears when `onSend`/`onSteerSend`
   * returns true (i.e. the message was actually consumed).
   */
  value?: string;
  onChange?: (value: string) => void;
  /**
   * Uncontrolled mode only: persist the text draft under this key (lib/drafts)
   * so it survives the component unmounting — switching to another chat,
   * workspace or view. Restored on mount; cleared when a send is consumed.
   * Controlled parents own their value and persist it themselves.
   */
  draftKey?: string;
  onSend: (text: string) => boolean | void;
  placeholder?: string;
  disabled?: boolean;
  /** Boolean, or a predicate on the current draft (for uncontrolled mode,
   * where the parent can't read the text). */
  sendDisabled?: boolean | ((text: string) => boolean);
  /** Shows on the send button tooltip when busy-queueing. */
  sendTitle?: string;
  busy?: boolean;
  models: ModelOption[];
  defaultModel: string;
  /** Current model id; "" = default. */
  model: string;
  onModelChange: (model: string) => void;
  modelDisabled?: boolean;
  modelTitle?: string;
  /**
   * Reasoning-effort control (stowed as a compact pill, mirroring the new-session
   * palette). Forward-compatible: threaded through but not yet consumed
   * server-side. When omitted, the effort pill is hidden.
   */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  /**
   * Session goal (pinned via /goal, rides along with every prompt). When
   * `onSetGoal` is wired, a target button lets you set/clear it inline; it lights
   * up and grows a "Goal" label while a goal is pinned.
   */
  goal?: string | null;
  onSetGoal?: (goal: string | null) => void;
  /** Extra control rendered in the toolbar, left of the send button. */
  leftExtra?: React.ReactNode;
  /**
   * Optional caret control fused onto the right of the send button as a Slack-style
   * split button (e.g. "send later"). Rendered inside `.composer-send-split`; it
   * should style its trigger with `composer-send-caret` and anchor its own popover.
   * Given the current draft `text`, the shared `disabled` state (same as the send
   * button — so the whole split greys out on an empty draft), and `onScheduled` to
   * clear the draft once the message has been handed off.
   */
  sendMenu?: (ctx: {
    text: string;
    disabled: boolean;
    onScheduled: () => void;
  }) => React.ReactNode;
  /**
   * When set and busy, renders an extra "fold in" send button — the gentle
   * option that queues the message for Michael's next stopping point instead of
   * interrupting (the main send button interrupts immediately when busy).
   */
  onSteerSend?: (text: string) => boolean | void;
  hint?: string;
  autoFocus?: boolean;
  /** Exposes the textarea so parents can focus it (e.g. keyboard shortcuts). */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Attached images as `data:` URLs. When `onImagesChange` is provided, the
   * composer accepts pasted/dropped screenshots and renders thumbnails.
   */
  images?: string[];
  onImagesChange?: (images: string[]) => void;
  /**
   * Non-image attachments (staged to disk server-side). When `onFilesChange` is
   * provided, the composer accepts any dropped/picked file, not just images.
   */
  files?: FileAttachment[];
  onFilesChange?: (files: FileAttachment[]) => void;
  /**
   * Enables "@"-mention file autocomplete. Given the text typed after the "@",
   * returns matching files (primary repo + any attached repos). When omitted,
   * "@" is inert.
   */
  mentionFetch?: (query: string) => Promise<FileMention[]>;
}

const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

function modelShortLabel(id: string, models: ModelOption[]): string {
  const m = models.find((x) => x.id === id);
  return m ? m.label : id;
}

function modelIsCodex(id: string, models: ModelOption[]): boolean {
  const found = models.find((x) => x.id === id);
  if (found) return found.provider === "codex";
  return id.startsWith("gpt") || id.startsWith("codex");
}

/** Inline set/clear editor for the session goal. */
function GoalPopover({
  initial,
  onSubmit,
  onClose,
}: {
  initial: string;
  onSubmit: (goal: string | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="composer-menu composer-goal-pop">
      <div className="composer-goal-pop-title">Session goal</div>
      <input
        ref={inputRef}
        className="composer-goal-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(text.trim() || null);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Pin a goal — rides along with every prompt…"
      />
      <div className="composer-goal-pop-actions">
        {initial && (
          <button
            type="button"
            className="composer-menu-item composer-goal-clear"
            onClick={() => onSubmit(null)}
          >
            Clear goal
          </button>
        )}
        <button
          type="button"
          className="composer-goal-set"
          onClick={() => onSubmit(text.trim() || null)}
          disabled={text.trim() === initial}
        >
          {initial ? "Update" : "Set goal"}
        </button>
      </div>
    </div>
  );
}

/**
 * Shared chat composer (Claude/Codex-style): rounded container with an
 * auto-growing textarea and a bottom toolbar carrying compact model/effort pills,
 * a Goal target, a "+" add menu and the send button. Enter sends, Shift+Enter
 * newlines. With `mentionFetch`, typing "@" opens a file-path autocomplete.
 */
export function Composer({
  value,
  onChange,
  draftKey,
  onSend,
  placeholder,
  disabled,
  sendDisabled,
  sendTitle,
  busy,
  models,
  defaultModel,
  model,
  onModelChange,
  modelDisabled,
  modelTitle,
  effort,
  onEffortChange,
  goal,
  onSetGoal,
  leftExtra,
  sendMenu,
  onSteerSend,
  hint,
  autoFocus,
  textareaRef: externalRef,
  images,
  onImagesChange,
  files,
  onFilesChange,
  mentionFetch,
}: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Uncontrolled mode (no `value` prop): the draft lives here so keystrokes
  // re-render only the Composer, not the whole parent view. With a `draftKey`
  // it seeds from — and mirrors into — the draft store, so navigating away
  // and back doesn't lose typed work.
  const [innerValue, setInnerValue] = useState(() =>
    draftKey ? loadDraft(draftKey).text : "",
  );
  const isControlled = value !== undefined;
  const text = isControlled ? value : innerValue;
  const setText = isControlled ? onChange ?? (() => {}) : setInnerValue;
  useEffect(() => {
    if (!isControlled && draftKey) saveDraft(draftKey, { text: innerValue });
  }, [isControlled, draftKey, innerValue]);
  // Fire a send handler with the current draft; in uncontrolled mode a `true`
  // return means "consumed" — clear the draft (falsy keeps it, e.g. offline).
  function fireSend(handler: (t: string) => boolean | void) {
    const consumed = handler(text);
    if (!isControlled && consumed === true) setInnerValue("");
  }
  const isSendDisabled =
    typeof sendDisabled === "function" ? sendDisabled(text) : sendDisabled;
  const imgs = images || [];
  const fls = files || [];
  // Any attachment affordance (paste/drop/pick + thumbnails) is enabled when the
  // parent wired up either channel.
  const canAttach = !!onImagesChange || !!onFilesChange;

  const isPhone = useIsPhone();

  // Which toolbar popover is open ("add" menu or "goal" editor). Closed on an
  // outside click or after an action.
  const [menu, setMenu] = useState<null | "add" | "goal">(null);
  useEffect(() => {
    if (!menu) return;
    // The phone "add" sheet is a portal that owns its own dismissal (backdrop,
    // Esc, drag) — an outside-click listener would fire on every sheet tap.
    if (isPhone && menu === "add") return;
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest(".composer-pop-wrap")) setMenu(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu, isPhone]);

  // "@"-mention file autocomplete (shared with the New-session prompt field).
  const mentions = useFileMentions({
    value: text,
    onChange: setText,
    textareaRef,
    mentionFetch,
  });

  async function addFiles(picked: FileList | File[]) {
    if (!canAttach) return;
    const { images: newImgs, files: newFls, rejected } = await splitAttachments(picked);
    // Images ride the vision channel; other files need a dedicated file channel
    // (if the parent only wired images, non-image files are simply ignored).
    if (newImgs.length) onImagesChange?.([...imgs, ...newImgs]);
    if (newFls.length && onFilesChange) onFilesChange([...fls, ...newFls]);
    // Fail loudly rather than dropping oversized/failed uploads silently.
    if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (!canAttach) return;
    const pasted = imageFilesFromPaste(e);
    if (pasted.length) {
      e.preventDefault();
      void addFiles(pasted);
    }
  }

  function handleDrop(e: React.DragEvent) {
    if (!canAttach || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    void addFiles(e.dataTransfer.files);
  }

  function removeImage(i: number) {
    onImagesChange?.(imgs.filter((_, idx) => idx !== i));
  }

  function removeFile(i: number) {
    onFilesChange?.(fls.filter((_, idx) => idx !== i));
  }

  // Insert an "@" at the caret and focus the textarea, opening the mention popup.
  function startMention() {
    const el = textareaRef.current;
    const at = el ? el.selectionStart : text.length;
    const next = text.slice(0, at) + "@" + text.slice(at);
    setText(next);
    queueMicrotask(() => {
      const t = textareaRef.current;
      if (t) {
        t.focus();
        t.selectionStart = t.selectionEnd = at + 1;
      }
      mentions.sync();
    });
  }

  // Auto-grow between a resting floor and the CSS max-height. Phones get a
  // one-line floor (ChatGPT-style lightweight bar); desktop keeps the tall
  // inviting field.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, isPhone ? 44 : 120), 320)}px`;
  }, [text, isPhone]);

  // Dictated text lands at the end of the draft (with a joining space) and
  // focus returns to the textarea so you can touch it up and send.
  function insertDictation(t: string) {
    const next = text.trim() ? `${text.replace(/\s+$/, "")} ${t}` : t;
    setText(next);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = next.length;
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (mentions.handleKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
      e.preventDefault();
      if (!disabled && !isSendDisabled) fireSend(onSend);
    }
  }

  const effectiveModel = model || defaultModel;
  const isCodex = modelIsCodex(effectiveModel, models);

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${disabled ? "composer-disabled" : ""}`}
        onDrop={handleDrop}
        onDragOver={(e) => canAttach && e.preventDefault()}
      >
        <ImageThumbs images={imgs} onRemove={removeImage} disabled={disabled} />
        <FileChips files={fls} onRemove={removeFile} disabled={disabled} />
        <div className="composer-input-wrap" ref={mentions.inputWrapRef}>
          {mentions.popup}
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Caret has moved to the new value; re-evaluate after React commits.
              queueMicrotask(mentions.sync);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={mentions.sync}
            onClick={mentions.sync}
            onBlur={() => {
              // Let a click on a suggestion (mousedown) win the race first.
              setTimeout(mentions.close, 120);
            }}
            onPaste={handlePaste}
            disabled={disabled}
            rows={1}
            autoFocus={autoFocus}
          />
        </div>
        <div className="composer-toolbar" ref={toolbarRef}>
          {canAttach && (
            <div className="composer-pop-wrap">
              <Tooltip label="Add files or a file reference">
                <button
                  type="button"
                  className="palette-icon-btn composer-add-btn"
                  onClick={() => setMenu(menu === "add" ? null : "add")}
                  disabled={disabled}
                  aria-label="Add"
                  aria-expanded={menu === "add"}
                >
                  <IconPlus size={24} />
                </button>
              </Tooltip>
              {menu === "add" &&
                (isPhone ? (
                  <BottomSheet label="Add" onClose={() => setMenu(null)}>
                    {(dismiss) => (
                      <div className="px-4 pb-4 pt-1">
                        <div className="overflow-hidden rounded-xl border border-line bg-panel">
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 border-x-0 border-b border-t-0 border-solid border-line bg-transparent px-3.5 py-3.5 text-left last:border-b-0 active:bg-hover"
                            onClick={() => {
                              dismiss();
                              fileInputRef.current?.click();
                            }}
                          >
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
                              <IconPaperclip size={20} />
                            </span>
                            <span className="min-w-0 flex-1 text-[15px] font-medium text-fg">
                              {onFilesChange ? "Attach files" : "Attach an image"}
                            </span>
                          </button>
                          {mentionFetch && (
                            <button
                              type="button"
                              className="flex w-full items-center gap-3 border-x-0 border-b border-t-0 border-solid border-line bg-transparent px-3.5 py-3.5 text-left last:border-b-0 active:bg-hover"
                              onClick={() => {
                                dismiss();
                                startMention();
                              }}
                            >
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
                                <IconAtSign size={20} />
                              </span>
                              <span className="min-w-0 flex-1 text-[15px] font-medium text-fg">
                                Reference a file
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </BottomSheet>
                ) : (
                  <div className="composer-menu">
                    <button
                      type="button"
                      className="composer-menu-item"
                      onClick={() => {
                        setMenu(null);
                        fileInputRef.current?.click();
                      }}
                    >
                      <span className="composer-menu-icon">
                        <IconPaperclip size={22} />
                      </span>
                      {onFilesChange ? "Attach files" : "Attach an image"}
                    </button>
                    {mentionFetch && (
                      <button
                        type="button"
                        className="composer-menu-item"
                        onClick={() => {
                          setMenu(null);
                          startMention();
                        }}
                      >
                        <span className="composer-menu-icon">
                          <IconAtSign size={22} />
                        </span>
                        Reference a file
                      </button>
                    )}
                  </div>
                ))}
              <input
                ref={fileInputRef}
                type="file"
                {...(onFilesChange ? {} : { accept: "image/*" })}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  // Reset so picking the same file again still fires onChange.
                  e.target.value = "";
                }}
              />
            </div>
          )}

          <div className="palette-pill" title={modelTitle || "Model for this session"}>
            <span className={`composer-model-dot ${isCodex ? "dot-codex" : "dot-claude"}`} />
            <span className="palette-pill-label">{modelShortLabel(effectiveModel, models)}</span>
            <IconChevronDown className="palette-chevron" size={20} />
            <select
              className="palette-select-overlay"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              disabled={disabled || modelDisabled}
              aria-label="Model"
            >
              <option value="">{modelShortLabel(defaultModel, models)}</option>
              {models
                .filter((m) => m.id !== defaultModel)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
          </div>

          {onEffortChange && (
            <div
              className="palette-pill"
              title="Reasoning effort — applies to new turns (not yet enforced server-side)"
            >
              <span className="palette-effort-icon" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="palette-pill-label">
                {EFFORTS.find((e) => e.id === effort)?.label ?? "High"}
              </span>
              <IconChevronDown className="palette-chevron" size={20} />
              <select
                className="palette-select-overlay"
                value={effort ?? "high"}
                onChange={(e) => onEffortChange(e.target.value)}
                disabled={disabled}
                aria-label="Reasoning effort"
              >
                {EFFORTS.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {onSetGoal && (
            <div className="composer-pop-wrap">
              <Tooltip label={goal ? `Goal: ${goal}` : "Pin a goal for this session"}>
                <button
                  type="button"
                  className={`palette-icon-btn composer-goal-btn ${goal ? "is-on" : ""}`}
                  onClick={() => setMenu(menu === "goal" ? null : "goal")}
                  disabled={disabled}
                  aria-pressed={!!goal}
                >
                  <IconCrosshair size={24} />
                  {goal && <span className="composer-goal-label">Goal</span>}
                </button>
              </Tooltip>
              {menu === "goal" && (
                <GoalPopover
                  initial={goal || ""}
                  onClose={() => setMenu(null)}
                  onSubmit={(g) => {
                    onSetGoal(g);
                    setMenu(null);
                  }}
                />
              )}
            </div>
          )}

          {leftExtra}
          <div className="composer-spacer" />

          <VoiceInput onText={insertDictation} disabled={disabled} />

          {busy && onSteerSend && (
            <Tooltip label="Fold in at Michael's next stopping point — don't interrupt the current turn">
              <button
                className="composer-send composer-send-queue"
                onClick={() => fireSend(onSteerSend)}
                disabled={disabled || isSendDisabled}
              >
                <IconArrowDownRight size={24} />
              </button>
            </Tooltip>
          )}
          {/* When a `sendMenu` is wired, the send button fuses with a caret into a
              Slack-style split button (send now / send later). Without it, the
              send button stands alone as a plain circle. */}
          <div className={`composer-send-split ${sendMenu ? "has-menu" : ""} ${busy ? "is-interrupt" : ""}`}>
            <Tooltip
              label={
                sendTitle ||
                (busy ? "Send now — interrupts the current turn and redirects Michael (Enter)" : "Send (Enter)")
              }
            >
              <button
                className={`composer-send ${busy ? "composer-send-interrupt" : ""}`}
                onClick={() => fireSend(onSend)}
                disabled={disabled || isSendDisabled}
              >
                {busy ? <IconBolt size={24} /> : <IconArrowUp size={24} />}
              </button>
            </Tooltip>
            {sendMenu?.({
              text,
              disabled: !!(disabled || isSendDisabled),
              onScheduled: () => {
                if (!isControlled) setInnerValue("");
              },
            })}
          </div>
        </div>
      </div>
      {hint && <div className="composer-hint">{hint}</div>}
    </div>
  );
}
