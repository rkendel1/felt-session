
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
	Container: {
		"containerType": "inline-size"
	},
	relative: {
		"position": "relative"
	},
	flex: {
		"display": "flex"
	},
	minH0: {
		"minHeight": "0"
	},
	minW320px: {
		"minWidth": "320px"
	},
	shrink0: {
		"flexShrink": "0"
	},
	flexCol: {
		"flexDirection": "column"
	},
	borderL: {
		"borderLeftStyle": "var(--tw-border-style)",
		"borderLeftWidth": "1px"
	},
	borderDivider: {
		"borderColor": "var(--divider)"
	},
	bgPanelSurface: {
		"backgroundColor": "var(--panel-surface)"
	},
	BgPanelVarPanelPlate: {
		"--bg-panel": "var(--panel-plate)"
	},
	max920pxFixed: {
		"@media not all and (min-width: 920px)": {
			"position": "fixed"
		}
	},
	max920pxTopVarHeaderH: {
		"@media not all and (min-width: 920px)": {
			"top": "var(--header-h)"
		}
	},
	max920pxRight0: {
		"@media not all and (min-width: 920px)": {
			"right": "0"
		}
	},
	max920pxBottom0: {
		"@media not all and (min-width: 920px)": {
			"bottom": "0"
		}
	},
	max920pxZ30: {
		"@media not all and (min-width: 920px)": {
			"zIndex": "30"
		}
	},
	max920pxMaxWNone: {
		"@media not all and (min-width: 920px)": {
			"maxWidth": "none"
		}
	},
	max920pxMinW0: {
		"@media not all and (min-width: 920px)": {
			"minWidth": "0"
		}
	},
	absolute: {
		"position": "absolute"
	},
	top0: {
		"top": "0"
	},
	left3px: {
		"left": "-3px"
	},
	z6: {
		"zIndex": "6"
	},
	hFull: {
		"height": "100%"
	},
	w7px: {
		"width": "7px"
	},
	cursorColResize: {
		"cursor": "col-resize"
	},
	phoneHidden: {
		"@media (max-width: 720px)": {
			"display": "none"
		}
	},
	afterAbsolute: {
		"::after": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	afterInsetY0: {
		"::after": {
			"content": "var(--tw-content)",
			"insetBlock": "0"
		}
	},
	afterLeft3px: {
		"::after": {
			"content": "var(--tw-content)",
			"left": "3px"
		}
	},
	afterW05: {
		"::after": {
			"content": "var(--tw-content)",
			"width": "2px"
		}
	},
	afterBgTransparent: {
		"::after": {
			"content": "var(--tw-content)",
			"backgroundColor": "transparent"
		}
	},
	afterTransitionBackgroundColor: {
		"::after": {
			"content": "var(--tw-content)",
			"transitionProperty": "background-color",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
	afterContent: {
		"::after": {
			"--tw-content": "\"\"",
			"content": "var(--tw-content)"
		}
	},
	mx3: {
		"marginInline": "12px"
	},
	mt3: {
		"marginTop": "12px"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	roundedLg: {
		"borderRadius": "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	pt2: {
		"paddingTop": "8px"
	},
	flex1: {
		"flex": "1"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	hVarDesktopHeaderH: {
		"height": "var(--desktop-header-h)"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap1: {
		"gap": "4px"
	},
	borderB: {
		"borderBottomStyle": "var(--tw-border-style)",
		"borderBottomWidth": "1px"
	},
	px2: {
		"paddingInline": "8px"
	},
	focusRing: {
		":focusVisible": {
			"outline": "2px solid var(--accent-ink)",
			"outlineOffset": "2px"
		},
		"@media (forced-colors: active)": {
			":focusVisible": {
				"outlineColor": "highlight"
			}
		}
	},
	minW0: {
		"minWidth": "0"
	},
	gap15: {
		"gap": "6px"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	py1: {
		"paddingBlock": "4px"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	transitionColors: {
		"transitionProperty": "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	Max380pxFlex1: {
		"flex": "1"
	},
	Max380pxJustifyCenter: {
		"justifyContent": "center"
	},
	Max380pxPx1: {
		"paddingInline": "4px"
	},
	hidden: {
		"display": "none"
	},
	max920pxInsetVarHeaderH000: {
		"@media not all and (min-width: 920px)": {
			"inset": "var(--header-h) 0 0 0"
		}
	},
	max920pxZ25: {
		"@media not all and (min-width: 920px)": {
			"zIndex": "25"
		}
	},
	max920pxBlock: {
		"@media not all and (min-width: 920px)": {
			"display": "block"
		}
	},
	phoneInset0: {
		"@media (max-width: 720px)": {
			"inset": "0"
		}
	},
	phoneZ45: {
		"@media (max-width: 720px)": {
			"zIndex": "45"
		}
	},

	wVarPanelW32: {
		"width": "var(--panel-w,32%)"
	},
	maxWMax480pxCalc100vw620px: {
		"maxWidth": "max(480px,100vw - 620px)"
	},
	max920pxWMin480px94vw: {
		"@media not all and (min-width: 920px)": {
			"width": "min(480px,94vw)"
		}
	},
	max920pxBgRgba000045: {
		"@media not all and (min-width: 920px)": {
			"backgroundColor": "color-mix(in srgb, var(--color-black) 45%, transparent)"
		}
	},
	phoneBgRgba00005: {
		"@media (max-width: 720px)": {
			"backgroundColor": "color-mix(in srgb, var(--color-black) 50%, transparent)"
		}
	},
});

/**
 * The session's right-hand workspace panel, as finished utility classes — what
 * used to be the `panel-*` family in legacy.css.
 *
 * The panel is one surface with two shapes: a resizable column beside the
 * transcript on desktop, and a fixed overlay column from 920px down. Both the
 * shell (PANEL_SHELL, shared with WorkspacePane's standing info panel) and the
 * contents — drag handle, tab strip, body, sheet head — live here.
 *
 * It had a third shape, a full-width bottom sheet on phones, and that is gone
 * rather than migrated: neither call site renders below 720px. See PANEL_SHELL
 * for what was measured before dropping it.
 *
 * Two conventions carried over from lib/pr-tone-classes.ts, for the same
 * reasons: a state carries its whole colour set rather than layering one over
 * another (Tailwind resolves same-property collisions by its own output order),
 * and anything that used to be an ancestor-keyed override is an arbitrary
 * variant on the element itself.
 */

/**
 * The panel shell itself — a resizable column beside the transcript, and a
 * fixed overlay column from 920px down. Both of its call sites (SessionViewer's
 * workspace panel and WorkspacePane's standing info panel) render it.
 *
 * `viewer-panel` stays on the markup as a bare hook: lib/pr-tone-classes.ts
 * reaches into it with `[.viewer-panel_&]` to size the PR strip inside the
 * panel, which is a rule about a descendant of an element this file doesn't
 * own.
 *
 * The width is the drag handle's to set — PANEL_RESIZE writes `--panel-w` — so
 * the shell only names the fallback and the bounds. The cap reserves the left
 * sidebar plus a readable session column rather than a fixed pixel width:
 * reviewing code wants real width on a wide display.
 *
 * The fallback is 32% of the pane, which at 1440 gives the transcript a little
 * over twice the panel's width. It was 40%, and at that share the panel read as
 * a second content column rather than a companion to one: most of what it holds
 * is a short Info list, so the extra width came out of the transcript and was
 * spent on empty surface. Anyone who wants the old share drags the handle once
 * and their own width is stored.
 *
 * It paints `bg-panel-surface`, four units off white rather than the tier below
 * it that `bg-raised` gave (#f6f6f6 against a white page): at column height
 * that was a wall of grey next to the content, and the largest flat area in the
 * window whenever the Info tab was short. The panel is a second column of the
 * same page rather than chrome over it, so it sits a shade off the page and
 * lets its seam do the dividing, exactly as the sidebar does on the other side.
 *
 * It also re-points `--bg-panel` at `--panel-plate`, which is the whole reason
 * the sections inside it are not addressed one by one: five or six plates stack
 * down one narrow column, and the page's plate strength repeated that many
 * times reads as a pile of blocks rather than a list of sections. Every
 * `bg-panel` in the subtree steps together instead: the Info sections, the
 * selected tab pill, the Portals cards, the avatar rings that ring themselves
 * in `var(--bg-panel)`.
 *
 * There is deliberately no phone shape here, though the old sheet had one (a
 * full-width bottom sheet: rounded top, `sheet-up` animation, its own shadow).
 * Neither call site renders on a phone — both are gated on `!isPhone`, and the
 * content is reached there as a full-width view tab instead (`session-tab-view`
 * → VIEWER_REVIEW_MAIN). Measured before removing it: at 390px no
 * `.viewer-panel` element exists on either a session or a workspace route, and
 * the toggle that would open one isn't rendered either. Reviving the phone
 * sheet means reviving that JSX first; its styling is not carried here as
 * decoration.
 */
export const PANEL_SHELL =
	mergeStylexClassName("viewer-panel", sx.wVarPanelW32, sx.Container, sx.relative, sx.flex, sx.minH0, sx.minW320px, sx.shrink0, sx.flexCol) + " " +
	mergeStylexClassName("", sx.maxWMax480pxCalc100vw620px, sx.borderL, sx.borderDivider, sx.bgPanelSurface, sx.BgPanelVarPanelPlate) +
	// From 920px down it stops being a column in the layout and becomes an
	// overlay over the session, anchored under the top bar (--header-h is 0 on
	// desktop, the bar's height on a phone) with PANEL_OVERLAY dimming behind it.
	" " + mergeStylexClassName("", sx.max920pxFixed, sx.max920pxTopVarHeaderH, sx.max920pxRight0, sx.max920pxBottom0) + " " +
	mergeStylexClassName("", sx.max920pxWMin480px94vw, sx.max920pxZ30, sx.max920pxMaxWNone, sx.max920pxMinW0) + " " +
	"max-[920px]:shadow-[-12px_0_32px_rgba(0,0,0,0.5)]";

/**
 * Left-edge drag handle — the mirror of the sidebar's. The hairline it paints
 * is a ::after inset from the handle's own box, so the grab area is wider than
 * the line without taking layout width. Hidden on phones, where the panel is a
 * sheet with nothing to drag.
 *
 * The hover paint is scoped to `body:not(.resizing-panel)` rather than left to
 * compete with the dragging paint: during a drag the pointer is also hovering,
 * and which of two same-property utilities wins is Tailwind's output order,
 * not the order they are written. The old sheet resolved it by specificity
 * (0,3,0 over 0,2,0); this makes the two states mutually exclusive instead.
 */
export const PANEL_RESIZE =
	mergeStylexClassName("", sx.absolute, sx.top0, sx.left3px, sx.z6, sx.hFull, sx.w7px, sx.cursorColResize, sx.phoneHidden) + " " +
	mergeStylexClassName("", sx.afterAbsolute, sx.afterInsetY0, sx.afterLeft3px, sx.afterW05, sx.afterBgTransparent) + " " +
	mergeStylexClassName("", sx.afterTransitionBackgroundColor, sx.afterContent) + " " +
	"[body:not(.resizing-panel)_&]:hover:after:bg-line-strong " +
	"[body.resizing-panel_&]:after:bg-faint";

/**
 * The PR strip's plate at the top of the panel.
 *
 * The strip used to run edge to edge with a hairline under it, which made it
 * chrome bolted to the panel's top rather than part of the column. It is a
 * plate now: the same corner as every section under it (`rounded-lg`, matching
 * INFO_LIST_CLASS), so it reads as the first element of the info column instead
 * of a band across it.
 *
 * The margin is the column's own padding rather than a value of its own. The
 * sections below sit 12px off the panel's edges (WorkspaceInfo's `px-2` inside
 * the `px-1` wrapper its two panel call sites give it) and open 12px under the
 * plate (its `pt-3`), so the plate takes the same 12px above and beside it. One
 * padding all the way round the content, not a tighter frame at the top than
 * the gap to the first section.
 *
 * The inset and the corner live here rather than on the strip because only this
 * call site wants them — on a phone the same strip is a row inside the session
 * info card, which supplies its own edge. The clip is what lets a session with
 * several PRs keep its series rows inside the corner: the stack renders as one
 * plate, not a plate followed by loose rows.
 */
export const PANEL_PR_PLATE =
	// `panel-pr-plate` is a hook, not styling: PANEL_INFO_TOP below reads it to
	// tell a column that opens under this plate from one that opens alone.
	"panel-pr-plate " +
	// `empty:hidden` because the strip renders nothing on a session with no pull
	// request to report (see PrStatusBar): the plate is a wrapper, so without it
	// the column would still pay this margin for a row that isn't there.
	mergeStylexClassName("empty:hidden", sx.mx3, sx.mt3, sx.overflowHidden, sx.roundedLg);

/**
 * The info column's own top padding, on top of WorkspaceInfo's 12px.
 *
 * With the plate above it the column opens 12px under a filled surface, the
 * same padding it takes on every other side. On a session with no pull request
 * the strip collapses, and the column's first element is then a bare "Review"
 * label sitting that same 12px off the panel's top edge. A small label needs
 * more air above it than a plate does, so the column opens lower when it stands
 * alone and keeps the matched 12px when it doesn't.
 */
export const PANEL_INFO_TOP = mergeStylexClassName("[.panel-pr-plate:not(:empty)~*_&]:pt-0", sx.pt2);

/** The panel's scrolling content. */
export const PANEL_BODY = mergeStylexClassName("", sx.minH0, sx.flex1, sx.overflowYAuto);

/**
 * The panel's standing tab strip: the places this workspace can open, on one
 * line above their content. It sits outside PANEL_BODY so it stays put while
 * the selected page scrolls, and its bottom rule separates chrome from page.
 */
export const PANEL_TABS =
	mergeStylexClassName("", sx.flex, sx.hVarDesktopHeaderH, sx.shrink0, sx.itemsCenter, sx.gap1, sx.borderB, sx.borderDivider, sx.px2);

/** One tab: an icon, a word, and whatever that destination wants to report. */
export const PANEL_TAB =
	mergeStylexClassName("", sx.focusRing, sx.flex, sx.minW0, sx.itemsCenter, sx.gap15, sx.roundedControl, sx.px2, sx.py1) + " " +
	mergeStylexClassName("", typography.label, sx.textDim, sx.transitionColors, sx.hoverBgHover, sx.hoverTextFg) + " " +
	mergeStylexClassName("", sx.Max380pxFlex1, sx.Max380pxJustifyCenter, sx.Max380pxPx1);

/**
 * The scrim behind the panel once it stops being a column and starts being an
 * overlay. It only exists from 920px down; above that the panel sits in the
 * layout and dims nothing.
 */
export const PANEL_OVERLAY =
	mergeStylexClassName("", sx.hidden) + " " +
	mergeStylexClassName("", sx.max920pxFixed, sx.max920pxInsetVarHeaderH000, sx.max920pxZ25) + " " +
	mergeStylexClassName("", sx.max920pxBgRgba000045, sx.max920pxBlock) + " " +
	mergeStylexClassName("", sx.phoneBgRgba00005, sx.phoneInset0, sx.phoneZ45);
