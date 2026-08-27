import React, {
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	fetchFileMentions,
	fetchMentionSuggestions,
	fetchSkillMentions,
} from "../lib/api";
import { saveDraft, NEW_SESSION_DRAFT_KEY as DRAFT_KEY } from "../lib/drafts";
import { appendDictation } from "../lib/dictation";
import { attachingLabel, type StagingCount } from "../lib/attachments";
import { imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { insertPastedSessionId } from "../lib/session-url";
import { insideOpenFence, isSendCombo, type SendKeyPref } from "../lib/send-key";
import {
	COMPOSER_HIGHLIGHT_MAX_CHARS,
	composerHighlightHtml,
	paintPillHover,
} from "../lib/composer-highlight";
import { noAutofill } from "../lib/composer-autofill";
import { useSessionNameProjection } from "../hooks/useSessionNameProjection";
import { useFileMentions } from "./useFileMentions";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { cn, mergeStylexClassName } from "../ui/cn";
import { getCurrentUser } from "./UserPicker";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},

	pointerEventsNone: {
		"pointerEvents": "none"
	},
	absolute: {
		"position": "absolute"
	},
	inset0: {
		"inset": "0"
	},
	z0: {
		"zIndex": "0"
	},
	hFull: {
		"height": "100%"
	},
	selectNone: {
		"WebkitUserSelect": "none",
		"userSelect": "none"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	breakWords: {
		"overflowWrap": "break-word"
	},
	whitespacePreWrap: {
		"whiteSpace": "pre-wrap"
	},
	Mx4px: {
		"marginInline": "-4px"
	},
	wCalc1008px: {
		"width": "calc(100% + 8px)"
	},
	px6px: {
		"paddingInline": "6px"
	},
	py2px: {
		"paddingBlock": "2px"
	},
	z1: {
		"zIndex": "1"
	},
	textTransparent: {
		"color": "transparent"
	},
	caretVarText: {
		"caretColor": "var(--text)"
	},

	minH0: {
		"minHeight": "0"
	},
	flex1: {
		"flex": "1"
	},
	overflowXHidden: {
		"overflowX": "hidden"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	overscrollContain: {
		"overscrollBehavior": "contain"
	},
	px4: {
		"paddingInline": "16px"
	},
	pt1: {
		"paddingTop": "4px"
	},
	ScrollbarWidthNone: {
		"scrollbarWidth": "none"
	},
	block: {
		"display": "block"
	},
	minH132px: {
		"minHeight": "132px"
	},
	wFull: {
		"width": "100%"
	},
	resizeNone: {
		"resize": "none"
	},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	fontSans: {
		"fontFamily": "var(--sans)"
	},
	leading155: {
		"--tw-leading": "1.55",
		"lineHeight": "1.55"
	},
	textFg: {
		"color": "var(--text)"
	},
	outlineNone: {
		"--tw-outline-style": "none",
		"outlineStyle": "none"
	},
	placeholderTextFaint: {
		"::placeholder": {
			"color": "var(--text-faint)"
		}
	},
	disabledOpacity60: {
		":disabled": {
			"opacity": ".6"
		}
	},
});

/** One scroll surface for the prompt and its attachments. Keeping the image in
 *  this flow means it travels with the text instead of pinning over it.
 *
 *  `pt-1` rather than `pt-3`: the header already carries 11px below its row, so
 *  a 12px reserve here put 28px between the repo picker and the placeholder
 *  while the prompt sat flush against the footer. Now that the hairline only
 *  appears once the prompt scrolls, the header and the prompt read as one
 *  block, and that gap read as a hole in it. */
const BODY =
	mergeStylexClassName("[&::-webkit-scrollbar]:hidden", sx.relative, sx.minH0, sx.flex1, sx.overflowXHidden, sx.overflowYAuto, sx.overscrollContain, sx.px4, sx.pt1, sx.ScrollbarWidthNone);
const TEXTAREA =
	mergeStylexClassName("", sx.block, sx.minH132px, sx.wFull, sx.resizeNone, sx.overflowHidden, sx.borderNone, sx.bgTransparent, sx.fontSans, typography.body, sx.leading155, sx.textFg, sx.outlineNone, sx.placeholderTextFaint, sx.disabledOpacity60);

/** How long the draft has to hold still before the palette is handed it. This
 *  is the branch-name suggestion's debounce, moved down here: the palette is
 *  told once, when typing stops, rather than on every character. */
const SETTLE_MS = 700;

/** How long the draft has to hold still before it is written to the store.
 *  Short enough that it is never the reason a draft is lost — every way out of
 *  the palette flushes it first — and long enough that a burst of typing costs
 *  one write instead of one per character. */
const DRAFT_MS = 300;

export interface NewSessionPromptHandle {
	/** Replace the draft — the reset after a create. */
	setText: (next: string) => void;
	/** Add dictated text to the end of the draft. */
	appendText: (add: string) => void;
	/** Throw away a pending draft write. The create paths clear the stored
	 *  draft once the prompt has been consumed, and a debounced write landing
	 *  after that would put the whole thing straight back. */
	dropPendingDraftWrite: () => void;
}

interface Props {
	/** Read once, at mount: the prefill, the deep link, or the restored draft. */
	initialText: string;
	/** The field itself. The palette focuses it and hands it to the dialog as
	 *  its initial focus, so the ref is created there and passed down. */
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	/** The draft, written on every commit. This is what a create reads: the
	 *  palette does not hold the text, so that typing cannot re-render it. */
	valueRef: React.RefObject<string>;
	/** Dictation and the post-create reset, which are the palette's to trigger
	 *  and this field's to carry out. */
	handle: React.RefObject<NewSessionPromptHandle | null>;
	/** Which repo "@" searches for files in. */
	repo: string;
	/** A non-empty selection narrows which connected tools "@" offers. */
	mcpServers?: string[];
	placeholder: string;
	disabled: boolean;
	images: string[];
	files: FileAttachment[];
	/** What is still being written to disk. A pasted screenshot is not attached
	 *  until its upload lands, and during a slow load that is seconds of a card
	 *  that looks like it ignored the paste, so each one holds its place in the
	 *  attachment row as a ghost. */
	staging: StagingCount;
	onRemoveImage: (index: number) => void;
	onRemoveFile: (index: number) => void;
	onRemovePendingImage?: (index: number) => void;
	onRemovePendingFile?: (index: number) => void;
	onAddAttachments: (picked: FileList | File[]) => void;
	sendKey: SendKeyPref;
	/** Whether the send key has anything to create, so it can decline the key
	 *  and let the newline land instead. */
	canCreate: boolean;
	onCreate: () => void;
	/** The draft went from empty to holding something, or back. The one thing
	 *  about the text the palette needs on every edit. */
	onHasTextChange: (hasText: boolean) => void;
	/** The draft, once it has held still: the branch name is suggested from it.
	 *  One report per typing burst, never per character. */
	onDraftSettled: (text: string) => void;
	onEdgesChange: (edges: { top: boolean; bottom: boolean }) => void;
	onMentionOpenChange: (open: boolean) => void;
}

/**
 * The new-session palette's prompt: the field, its session-reference mirror,
 * the "@" and "/" pickers, and the attachments that scroll with it.
 *
 * It owns the draft rather than taking it as a prop, and that is the whole
 * point of the split. The palette around it is a repo picker, a model picker,
 * two menus and a split button — some 20ms of render — and every one of those
 * re-rendered on every character while the text lived at the top of the card.
 * What the palette actually needs is far less than the text: whether there is
 * any (`onHasTextChange`, for the Create button), the text once typing stops
 * (`onDraftSettled`, for the branch name), and the text itself at the moment a
 * create is submitted, which it reads from `valueRef`.
 */
export function NewSessionPrompt({
	initialText,
	textareaRef,
	valueRef,
	handle,
	repo,
	mcpServers,
	placeholder,
	disabled,
	images,
	files,
	staging,
	onRemoveImage,
	onRemoveFile,
	onRemovePendingImage,
	onRemovePendingFile,
	onAddAttachments,
	sendKey,
	canCreate,
	onCreate,
	onHasTextChange,
	onDraftSettled,
	onEdgesChange,
	onMentionOpenChange,
}: Props) {
	const [text, setText] = useState(initialText);
	// The palette re-renders far less often than this field does now, so its
	// callbacks are held rather than depended on: a repo switch mid-sentence
	// would otherwise restart the settle timer.
	const callbacks = useRef({
		onHasTextChange,
		onDraftSettled,
		onEdgesChange,
		onMentionOpenChange,
	});

	// The draft store, so a dismissed palette can restore the work. Written on a
	// debounce rather than per character, and flushed by every way out of the
	// palette, so what the store misses is only ever the last few hundred
	// milliseconds of a burst that is still being typed.
	//
	// A pending write always reads from this ref, never from a captured value:
	// a flush that landed a keystroke behind would be worse than no flush.
	//
	// The text is all this writes. Attachments are staged asynchronously and
	// commit to the store themselves (lib/attachments.ts), because that upload
	// outlives the palette; a second writer here would put the pre-upload array
	// back over a completion that landed between the last render and the flush.
	const draft = useRef({ text });
	// Publish one coherent committed snapshot for every event path that reads
	// outside this field. Speculative concurrent renders never leak into refs.
	useLayoutEffect(() => {
		valueRef.current = text;
		callbacks.current = {
			onHasTextChange,
			onDraftSettled,
			onEdgesChange,
			onMentionOpenChange,
		};
		draft.current = { text };
	});
	// Non-null exactly while the store is behind the field, which is what makes
	// "nothing pending" a safe reason for a flush to do nothing.
	const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Stable identity: only refs and the module-level draft store are touched.
	const writeDraftNow = useCallback(() => {
		if (draftTimer.current == null) return;
		clearTimeout(draftTimer.current);
		draftTimer.current = null;
		saveDraft(DRAFT_KEY, draft.current);
	}, []);
	const dropPendingDraftWrite = useCallback(() => {
		if (draftTimer.current == null) return;
		clearTimeout(draftTimer.current);
		draftTimer.current = null;
	}, []);

	useEffect(() => {
		if (draftTimer.current != null) clearTimeout(draftTimer.current);
		draftTimer.current = setTimeout(() => {
			draftTimer.current = null;
			saveDraft(DRAFT_KEY, draft.current);
		}, DRAFT_MS);
	}, [text]);

	// Every exit that is not a create: the palette being dismissed or navigated
	// away from (the cleanup), the tab being closed, reloaded or backgrounded.
	//
	// `visibilitychange` is the one that carries a tab close, not `pagehide`:
	// lib/drafts mirrors its own map to sessionStorage on pagehide, and that
	// listener is registered at import time, so it runs before this one and
	// would mirror a draft this write had not reached yet. Browsers turn the
	// page hidden before they fire pagehide, so writing there puts the text in
	// the map in time. pagehide stays as the backstop for the memory copy.
	useEffect(() => {
		const onHidden = () => {
			if (document.visibilityState === "hidden") writeDraftNow();
		};
		window.addEventListener("pagehide", writeDraftNow);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			window.removeEventListener("pagehide", writeDraftNow);
			document.removeEventListener("visibilitychange", onHidden);
			writeDraftNow();
		};
	}, [writeDraftNow]);

	useImperativeHandle(
		handle,
		() => ({
			setText: (next: string) => setText(next),
			appendText: (add: string) =>
				setText((prev) => appendDictation(prev, add)),
			dropPendingDraftWrite,
		}),
		[dropPendingDraftWrite],
	);

	// A pasted session link is stored as its id and shown as that session's
	// name, exactly as in the session composer. The palette is where most links
	// are dropped, and a first prompt that reads as forty characters of uuid says
	// nothing about what it points at.
	const sessionNames = useSessionNameProjection({
		text,
		setText,
		textareaRef,
	});
	// Only session references paint here. The palette has no `inline code` tint
	// and no mention pills, and a reference is the one thing in this field whose
	// text is not what will be sent, so it is the one thing that has to say so.
	const hlRef = useRef<HTMLDivElement>(null);
	const hoveredPill = useRef<HTMLElement | null>(null);
	// Same cap the session composer's mirror takes: this one is rebuilt and
	// re-parsed on every keystroke too, so past that length the pill costs more
	// than it is worth and the plain field takes over.
	const sessionPill =
		sessionNames.sessions.length > 0 &&
		sessionNames.displayText.length <= COMPOSER_HIGHLIGHT_MAX_CHARS;
	const sessionHighlightHtml = sessionPill
		? composerHighlightHtml(sessionNames.displayText, [], sessionNames.sessions)
		: "";
	// Every keystroke rewrites the mirror's innerHTML, so the hovered span is a
	// dangling node from the render before it.
	useEffect(() => {
		hoveredPill.current = null;
		if (textareaRef.current) textareaRef.current.style.cursor = "";
	}, [sessionHighlightHtml, textareaRef]);
	const mentions = useFileMentions({
		value: sessionNames.displayText,
		onChange: sessionNames.setDisplayText,
		textareaRef,
		mentionFetch: (q) => fetchFileMentions(q, undefined, repo),
		paletteFetch: (q) =>
			fetchMentionSuggestions(q, undefined, getCurrentUser(), mcpServers),
		skillsFetch: (q) => fetchSkillMentions(q, undefined, repo),
	});

	// Emptiness rather than the text: the Create button is the only part of the
	// palette that has to answer on the keystroke that changes it, and it only
	// ever asks whether there is anything to create.
	const hasText = /\S/.test(text);
	useLayoutEffect(() => {
		callbacks.current.onHasTextChange(hasText);
	}, [hasText]);

	useEffect(() => {
		const timer = setTimeout(
			() => callbacks.current.onDraftSettled(text),
			SETTLE_MS,
		);
		return () => clearTimeout(timer);
	}, [text]);

	useEffect(() => {
		callbacks.current.onMentionOpenChange(mentions.open);
	}, [mentions.open]);

	// The prompt grows naturally; once the palette reaches its viewport cap the
	// BODY becomes the single scroller, carrying attachments with the text. Each
	// edge's hairline marks content continuing beyond the visible area.
	function updatePromptFade(el: HTMLDivElement) {
		// Each hairline earns its place only while content sits beyond that edge:
		// a short prompt that fits gets a clean, undivided card.
		const hidden = el.scrollHeight - el.clientHeight;
		callbacks.current.onEdgesChange({
			top: el.scrollTop > 1,
			bottom: hidden > 1 && hidden - el.scrollTop > 1,
		});
	}

	// Both effects below key on the scroller NODE rather than on a render pass.
	// Base UI mounts the popup's children in a later commit than the one that
	// opens the dialog, so an effect keyed on the text (or on `open`) has already
	// run and bailed on a null ref by the time the textarea exists. That left a
	// prefilled or restored prompt clipped at its 132px minimum and unscrollable.
	const [promptBody, setPromptBody] = useState<HTMLDivElement | null>(null);
	const attachPromptBody = (node: HTMLDivElement | null) => {
		mentions.setInputWrap(node);
		setPromptBody(node);
	};

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea || !promptBody) return;
		textarea.style.height = "0px";
		textarea.style.height = `${textarea.scrollHeight}px`;
		updatePromptFade(promptBody);
	}, [promptBody, sessionNames.displayText, images.length, files.length, textareaRef]);

	useEffect(() => {
		if (!promptBody) return;
		const observer = new ResizeObserver(() => updatePromptFade(promptBody));
		observer.observe(promptBody);
		return () => observer.disconnect();
	}, [promptBody]);

	function handlePaste(e: React.ClipboardEvent) {
		// A session link goes in as the id it carries, which is the same reference
		// in a third of the room and chips the same way (lib/session-url.ts).
		if (insertPastedSessionId(e)) return;
		const imgs = imageFilesFromPaste(e);
		if (imgs.length) {
			e.preventDefault();
			onAddAttachments(imgs);
		}
	}

	return (
		<div
			className={BODY}
			onDrop={(e) => {
				if (e.dataTransfer?.files?.length) {
					e.preventDefault();
					onAddAttachments(e.dataTransfer.files);
				}
			}}
			onDragOver={(e) => e.preventDefault()}
			onScroll={(e) => updatePromptFade(e.currentTarget)}
			ref={attachPromptBody}
		>
			{mentions.popup}
			<div {...stylex.props(sx.relative)}>
				{sessionPill && (
					// `composer-hl` stays as a hook: the pill spans inside this
					// mirror are written as innerHTML by lib/composer-highlight.ts,
					// so their rules can only be reached through it. Same trick as
					// the session composer: a metrics-identical layer paints the
					// pill behind a transparent-text field, which keeps the native
					// caret, selection and undo.
					<div
						ref={hlRef}
						className={cn(
							"composer-hl",
							TEXTAREA,
							mergeStylexClassName("", sx.pointerEventsNone, sx.absolute, sx.inset0, sx.z0, sx.hFull, sx.selectNone, sx.overflowHidden, sx.breakWords, sx.whitespacePreWrap),
							// Padding here is two things added together, and both are
							// load-bearing. 4px of it is clearance: a pill's wash reaches
							// past its own box (base.css), so one at either end of a line
							// would be clipped by this box, and the negative margin plus
							// the width give that room back outside the content. The
							// other 2px is the browser's own textarea padding, which this
							// field keeps, unlike the session composer, which zeroes it.
							// Without it every glyph here sits two pixels left of the one
							// it paints over, which puts the wash off the word.
							mergeStylexClassName("", sx.Mx4px, sx.wCalc1008px, sx.px6px, sx.py2px),
						)}
						aria-hidden="true"
						dangerouslySetInnerHTML={{ __html: sessionHighlightHtml }}
					/>
				)}
				<textarea
					ref={textareaRef}
					{...mentions.inputProps}
					className={cn(
						TEXTAREA,
						sessionPill &&
							mergeStylexClassName("", sx.relative, sx.z1, sx.breakWords, sx.textTransparent, sx.caretVarText),
					)}
					value={sessionNames.displayText}
					onBeforeInput={sessionNames.handleBeforeInput}
					onChange={(e) => {
						// A token undo/redo is replayed against canonical state and the
						// caret is already placed, so nothing else is owed here.
						// The picker re-syncs from the committed value in its own effect,
						// which is both later and more reliable than a microtask queued
						// from here (see useFileMentions).
						sessionNames.handleChange(e);
					}}
					onCopy={sessionNames.handleCopy}
					onCut={sessionNames.handleCut}
					onMouseMove={(e) =>
						paintPillHover(
							hlRef.current,
							textareaRef.current,
							e.clientX,
							e.clientY,
							hoveredPill,
						)
					}
					onMouseLeave={() =>
						paintPillHover(hlRef.current, textareaRef.current, -1, -1, hoveredPill)
					}
					onKeyDown={(e) => {
						// An undo that has to cross a session token replays canonical
						// state; every other ⌘Z is left to the field's own history.
						if (sessionNames.handleUndoRedoKey(e)) return;
						// ⌘/Ctrl+Enter creates whatever the send-key preference is.
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							onCreate();
							return;
						}
						// The @/slash popup claims plain Enter to accept a suggestion.
						if (mentions.handleKeyDown(e)) return;
						// A reference reads as one object, so it erases like one.
						if (
							(e.key === "Backspace" || e.key === "Delete") &&
							!e.metaKey &&
							!e.ctrlKey &&
							!e.altKey &&
							textareaRef.current &&
							sessionNames.deleteTokenAtEdge(e.key, textareaRef.current)
						) {
							e.preventDefault();
							return;
						}
						// Otherwise the send key creates, exactly as it sends in the session
						// composer — including the unclosed-``` fence exception, so a
						// multi-line code block can still be typed into the first prompt.
						// Nothing to create yet? Let the newline land rather than eating
						// the keystroke.
						if (!isSendCombo(e, sendKey) || !canCreate) return;
						// The caret is an offset into the DISPLAYED text, and a fence is
						// a fact about the draft, so the two have to be read in the same
						// terms.
						const caret = sessionNames.canonicalOffset(
							textareaRef.current?.selectionStart ??
								sessionNames.displayText.length,
						);
						if (insideOpenFence(text, caret)) return;
						e.preventDefault();
						onCreate();
					}}
					onKeyUp={mentions.sync}
					onClick={(e) => {
						// Pressing a reference removes it, the way the pill says it will.
						if (sessionNames.removeTokenAtCaret(e.currentTarget)) return;
						mentions.sync();
					}}
					onBlur={() => setTimeout(mentions.close, 120)}
					onPaste={handlePaste}
					placeholder={placeholder}
					disabled={disabled}
					{...noAutofill}
				/>
			</div>
			<ImageThumbs
				images={images}
				pending={staging.images}
				onRemove={onRemoveImage}
				onRemovePending={onRemovePendingImage}
				disabled={disabled}
			/>
			<FileChips
				files={files}
				pending={staging.files}
				onRemove={onRemoveFile}
				onRemovePending={onRemovePendingFile}
				disabled={disabled}
			/>
			{/* The ghost tiles are the whole message on screen, and they say
			    nothing out loud. This is the same news for a reader who cannot
			    see them. */}
			{attachingLabel(staging) && (
				<span {...stylex.props(sx.srOnly)} role="status">
					{attachingLabel(staging)}
				</span>
			)}
		</div>
	);
}
