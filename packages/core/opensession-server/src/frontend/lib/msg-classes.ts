
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
	mxAuto: {
		"marginInline": "auto"
	},
	flex: {
		"display": "flex"
	},
	wFull: {
		"width": "100%"
	},
	maxWVarSessionCol: {
		"maxWidth": "var(--session-col)"
	},
	flexCol: {
		"flexDirection": "column"
	},
	mt1: {
		"marginTop": "4px"
	},
	mb125: {
		"marginBottom": "5px"
	},
	flexRowReverse: {
		"flexDirection": "row-reverse"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap175: {
		"gap": "7px"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	tracking001em: {
		"--tw-tracking": "-.01em",
		"letterSpacing": "-.01em"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
	text1f9e8a: {
		"color": "#1f9e8a"
	},
	itemsStretch: {
		"alignItems": "stretch"
	},
	leading6: {
		"--tw-leading": "calc(4px * 6)",
		"lineHeight": "24px"
	},
	breakWords: {
		"overflowWrap": "break-word"
	},
	block: {
		"display": "block"
	},
	selfEnd: {
		"alignSelf": "flex-end"
	},
	textFg: {
		"color": "var(--text)"
	},
	OverflowAnchorNone: {
		"overflowAnchor": "none"
	},
	inlineBlock: {
		"display": "inline-block"
	},
	selfCenter: {
		"alignSelf": "center"
	},
	py15: {
		"paddingBlock": "6px"
	},
	textCenter: {
		"textAlign": "center"
	},
	leading145: {
		"--tw-leading": "1.45",
		"lineHeight": "1.45"
	},
	mt15: {
		"marginTop": "6px"
	},
	flexWrap: {
		"flexWrap": "wrap"
	},
	gap2: {
		"gap": "8px"
	},
	ml15: {
		"marginLeft": "6px"
	},
	cursorDefault: {
		"cursor": "default"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	trackingNormal: {
		"--tw-tracking": "0",
		"letterSpacing": "0"
	},

	mb45: {
		"marginBottom": "18px"
	},
	mb3: {
		"marginBottom": "12px"
	},
	roundedLg: {
		"borderRadius": "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgPanel: {
		"backgroundColor": "var(--bg-panel)"
	},
	px35: {
		"paddingInline": "14px"
	},
	py25: {
		"paddingBlock": "10px"
	},
	roundedRow: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	py225: {
		"paddingBlock": "9px"
	},

	maxWMin600px90: {
		"maxWidth": "min(600px,90%)"
	},
	bgRgba31158138012: {
		"backgroundColor": "#1f9e8a1f"
	},
	maxWMin560px100: {
		"maxWidth": "min(560px,100%)"
	},
});

/**
 * Transcript message classes — what used to be the `msg-*` family in
 * legacy.css.
 *
 * A message row is rendered from four surfaces (MessageBubble, SessionViewer's
 * optimistic and streaming bubbles, TurnBlock's intermediate replies, the Desk
 * pane), so the shared shapes live here instead of being re-typed — and
 * re-drifted — at each call site.
 *
 * A handful of `msg-*` names survive on the markup as bare hooks with no
 * styling of their own, because things OUTSIDE this migration name them:
 *
 *   · base.css's selection policy (`chrome isn't selectable, content is`)
 *     names .msg, .msg-label, .msg-body and .msg-system-text;
 *   · base.css owns the streaming caret animation that hangs off the
 *     `.msg-streaming` ancestor and names it again in reduced-motion rules;
 *   · useSessionScroll queries `.msg` and `.msg-user` to find turn boundaries.
 *
 * Dropping one of those class names breaks copy/paste or scroll-to-turn
 * behaviour silently, so they stay.
 */

/**
 * The shared reading column every row sits in. Flex — not block — because
 * WebKit paints selection as full-width bands across block gaps; a flex column
 * makes the highlight hug the words (same reason as .viewer-messages).
 */
const msgRowBase = mergeStylexClassName("msg", sx.mxAuto, sx.flex, sx.wFull, sx.maxWVarSessionCol, sx.flexCol);

/** A normal turn: assistant answer, user bubble, teammate reply. */
export const msgRow = [msgRowBase, mergeStylexClassName("", sx.mb45)].filter(Boolean).join(" ");

/**
 * A centered notice pill. Tighter bottom margin than a turn, and no top margin
 * at all: flex margins don't collapse, so the previous row's 18px is the gap.
 */
export const msgSystemRow = [msgRowBase, mergeStylexClassName("", sx.mb3, sx.textCenter)].filter(Boolean).join(" ");

/**
 * Your own and a teammate's turns start 4px lower — the old 22px collapsed
 * against the previous sibling's bottom margin, which flex margins don't do.
 */
export const msgOwnTurn = mergeStylexClassName("", sx.mt1);

/**
 * Speaker label. Right-aligned (row-reverse) so the identity dot lands on the
 * outer edge, mirroring the assistant side. The ::selection masks are WebKit
 * only: it paints a highlight over unselectable label text caught inside a
 * selection range, and a fully transparent background is ignored — 1% sticks.
 *
 * Teammate labels put a UserAvatar on the outer edge. The identity mark used
 * to be `.msg-label::before`; that rule is gone from legacy.css.
 */
export const msgLabel =
	mergeStylexClassName("msg-label selection:bg-[rgba(0,0,0,0.01)] [&_*::selection]:bg-[rgba(0,0,0,0.01)]", sx.mb125, sx.flex, sx.flexRowReverse, sx.itemsCenter, sx.gap175, typography.meta, sx.fontSemibold, sx.tracking001em, sx.textFaint);

/** A teammate's reply routed back into the session — a warm teal, so it reads
 *  as someone else stepping in rather than the driver's own words. */
export const msgLabelHuman = mergeStylexClassName("", sx.text1f9e8a);

/**
 * Prose body. Flex column for the same WebKit selection-band reason as the row.
 * Bubbles use `msgBubbleUser` / `msgBubbleHuman` instead, which stay block —
 * they have a surface of their own, so there is no gap to band-paint.
 */
export const msgBody =
	mergeStylexClassName("msg-body", sx.flex, sx.flexCol, sx.itemsStretch, typography.body, sx.leading6, sx.breakWords);

/** Bubble bodies: shrink-wrapped to their words and hugging the right edge,
 *  capped short of the column so a long message still reads right-aligned. */
const msgBubble =
	mergeStylexClassName("msg-body", sx.maxWMin600px90, sx.block, sx.selfEnd, typography.body, sx.leading6, sx.breakWords, sx.textFg);
export const msgBubbleUser = [msgBubble, mergeStylexClassName("", sx.roundedLg, sx.bgPanel, sx.px35, sx.py25)].filter(Boolean).join(" ");
export const msgBubbleHuman = [msgBubble, mergeStylexClassName("", sx.bgRgba31158138012, sx.roundedRow, sx.px35, sx.py225)].filter(Boolean).join(" ");

/**
 * The row a live turn streams into. `overflow-anchor: none` keeps the browser's
 * scroll anchoring off the growing tail, which would otherwise fight a
 * glued-to-bottom follow as tokens append.
 */
export const msgStreamingRow = mergeStylexClassName("msg-streaming", sx.OverflowAnchorNone);

/** Assistant prose. Block while streaming so the caret ::after (base.css, with
 *  the reduced-motion exception that keeps it blinking) stays on the text's
 *  line — as a flex child it would wrap onto its own row. */
export const msgBodyStreaming =
	mergeStylexClassName("msg-body msg-body-assistant", sx.block, typography.body, sx.leading6, sx.breakWords, sx.textFg);

/**
 * Type and measure shared by every notice line, pill or not. The
 * `.msg-system-text` name stays on both variants: base.css's selection policy
 * names it.
 */
const msgSystemBase =
	mergeStylexClassName("msg-system-text", sx.maxWMin560px100, sx.inlineBlock, sx.selfCenter, sx.py15, sx.textCenter, typography.meta, sx.leading145, sx.textFaint);

/** The centered notice pill itself. */
export const msgSystemText = [msgSystemBase, mergeStylexClassName("", sx.roundedRow, sx.bgPanel, sx.px35)].filter(Boolean).join(" ");

/** A catch-up line, meaning a recap, reads as an aside in the transcript
 *  rather than as a card: the muted type, with no surface under it. It takes
 *  the full reading column rather than the pill's narrower cap, so a recap
 *  wraps on the same measure as the turns around it, inside the same row. */
export const msgSystemInline =
	mergeStylexClassName("msg-system-text", sx.block, sx.wFull, sx.py15, typography.meta, sx.leading145, sx.textFaint);

/**
 * A toned notice reads as a sentence, not a banner: everything the server and
 * the runner write lands in this one pill, so "switched account and retried"
 * and "your run died 40 minutes ago" used to be typographically identical.
 *
 * Every utility here is written as a `data-[tone…]:` variant, and that is
 * load-bearing rather than decorative. The pill it overrides sets `bg-panel`,
 * `inline-block` and `text-center` as plain single-class utilities, so a plain
 * tone utility only wins by Tailwind's OUTPUT ORDER — and it doesn't always:
 * deleting legacy.css's `.msg-system-text[data-tone="warn"]` (0,1,1, so it had
 * always won) dropped the warn pill straight back to the neutral panel wash,
 * measured, while the error pill happened to keep its red. Matching the
 * attribute restores the specificity legacy had, so which one wins stops
 * depending on where the compiler happened to emit them.
 */
export const msgSystemToned =
	"data-[tone]:inline-flex data-[tone]:items-start data-[tone]:gap-1.5 data-[tone]:text-left";

/**
 * The colour a toned notice wears — a LOOKUP of literal strings, never a built
 * `` `tone-${x}` ``: Tailwind only compiles class names it can find in the
 * source, so an assembled one compiles to nothing at all. Same shape as
 * `sourceChipTone` in lib/source-chip-classes.
 */
const SYSTEM_TONE: Record<string, string> = {
	error: "data-[tone=error]:bg-red-soft data-[tone=error]:text-red",
	warn:
		"data-[tone=warn]:bg-[color-mix(in_srgb,var(--yellow)_12%,transparent)] " +
		"data-[tone=warn]:text-yellow",
};

/** `info` deliberately resolves to nothing: it is the pill's resting look. */
export function msgSystemTone(tone: string): string {
	return SYSTEM_TONE[tone] ?? "";
}

/** Inline attachments under a turn. Right-aligned inside a bubble's column. */
export const msgMedia = mergeStylexClassName("", sx.mt15, sx.flex, sx.flexWrap, sx.gap2);

/** Short relative time in a label row (hover for the real one). */
export const msgTime =
	mergeStylexClassName("", sx.ml15, sx.cursorDefault, typography.meta, sx.fontMedium, sx.trackingNormal, sx.textFaint);
