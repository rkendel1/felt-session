
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

const sx = stylex.create({
	Mx3: {
		"marginInline": "-12px"
	},
	pointerEventsNone: {
		"pointerEvents": "none"
	},
	fixed: {
		"position": "fixed"
	},
	insetX0: {
		"insetInline": "0"
	},
	bottom0: {
		"bottom": "0"
	},
	z30: {
		"zIndex": "30"
	},
	hidden: {
		"display": "none"
	},
	px35: {
		"paddingInline": "14px"
	},
	pt6: {
		"paddingTop": "24px"
	},
	phoneBlock: {
		"@media (max-width: 720px)": {
			"display": "block"
		}
	},
	beforePointerEventsNone: {
		"::before": {
			"content": "var(--tw-content)",
			"pointerEvents": "none"
		}
	},
	beforeAbsolute: {
		"::before": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	beforeInset0: {
		"::before": {
			"content": "var(--tw-content)",
			"inset": "0"
		}
	},
	beforeZ1: {
		"::before": {
			"content": "var(--tw-content)",
			"zIndex": "calc(1 * -1)"
		}
	},
	m0: {
		"margin": "0"
	},
	px3: {
		"paddingInline": "12px"
	},
	pb15: {
		"paddingBottom": "6px"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
	listNone: {
		"listStyleType": "none"
	},
	p0: {
		"padding": "0"
	},
	relative: {
		"position": "relative"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	SwipeActionW0px: {
		"--swipe-action-w": "0px"
	},
	absolute: {
		"position": "absolute"
	},
	insetY0: {
		"insetBlock": "0"
	},
	right0: {
		"right": "0"
	},
	wVarSwipeActionW: {
		"width": "var(--swipe-action-w)"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	justifyCenter: {
		"justifyContent": "center"
	},
	gap15: {
		"gap": "6px"
	},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgAccent: {
		"backgroundColor": "var(--accent)"
	},
	textOnAccent: {
		"color": "var(--on-accent)"
	},
	opacity0: {
		"opacity": "0"
	},
	phoneFlex: {
		"@media (max-width: 720px)": {
			"display": "flex"
		}
	},
	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
	phoneTouchManipulation: {
		"@media (max-width: 720px)": {
			"touchAction": "manipulation"
		}
	},
	flex: {
		"display": "flex"
	},
	itemsStart: {
		"alignItems": "flex-start"
	},
	gap3: {
		"gap": "12px"
	},
	py25: {
		"paddingBlock": "10px"
	},
	durationVarDurMicro: {
		"--tw-duration": "var(--dur-micro)",
		"transitionDuration": "var(--dur-micro)"
	},
	easeVarEase: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	focusWithinBgHover: {
		":focusWithin": {
			"backgroundColor": "var(--hover)"
		}
	},
	afterPointerEventsNone: {
		"::after": {
			"content": "var(--tw-content)",
			"pointerEvents": "none"
		}
	},
	afterAbsolute: {
		"::after": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	afterRight3: {
		"::after": {
			"content": "var(--tw-content)",
			"right": "12px"
		}
	},
	afterBottom0: {
		"::after": {
			"content": "var(--tw-content)",
			"bottom": "0"
		}
	},
	afterLeft42px: {
		"::after": {
			"content": "var(--tw-content)",
			"left": "42px"
		}
	},
	afterHPx: {
		"::after": {
			"content": "var(--tw-content)",
			"height": "1px"
		}
	},
	afterBgLine: {
		"::after": {
			"content": "var(--tw-content)",
			"backgroundColor": "var(--border)"
		}
	},
	afterTransitionOpacity: {
		"::after": {
			"content": "var(--tw-content)",
			"transitionProperty": "opacity",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
	afterDurationVarDurMicro: {
		"::after": {
			"content": "var(--tw-content)",
			"--tw-duration": "var(--dur-micro)",
			"transitionDuration": "var(--dur-micro)"
		}
	},
	hoverAfterOpacity0: {
		"@media (hover: hover)": {
			":hover": {
				"::after": {
					"content": "var(--tw-content)",
					"opacity": "0"
				}
			}
		}
	},
	focusWithinAfterOpacity0: {
		":focusWithin": {
			"::after": {
				"content": "var(--tw-content)",
				"opacity": "0"
			}
		}
	},
	phoneZ1: {
		"@media (max-width: 720px)": {
			"zIndex": "1"
		}
	},
	phoneGap25: {
		"@media (max-width: 720px)": {
			"gap": "10px"
		}
	},
	phoneTouchPanY: {
		"@media (max-width: 720px)": {
			"--tw-pan-y": "pan-y",
			"touchAction": "var(--tw-pan-x,) var(--tw-pan-y,) var(--tw-pinch-zoom,)"
		}
	},
	phoneBgSurface: {
		"@media (max-width: 720px)": {
			"backgroundColor": "var(--bg)"
		}
	},
	phonePx18px: {
		"@media (max-width: 720px)": {
			"paddingInline": "18px"
		}
	},
	phonePy4: {
		"@media (max-width: 720px)": {
			"paddingBlock": "16px"
		}
	},
	phoneAfterLeft46px: {
		"@media (max-width: 720px)": {
			"::after": {
				"content": "var(--tw-content)",
				"left": "46px"
			}
		}
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
	flex1: {
		"flex": "1"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	roundedSm: {
		"borderRadius": "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	textLeft: {
		"textAlign": "left"
	},
	afterInset0: {
		"::after": {
			"content": "var(--tw-content)",
			"inset": "0"
		}
	},
	afterContent: {
		"::after": {
			"--tw-content": "\"\"",
			"content": "var(--tw-content)"
		}
	},
	block: {
		"display": "block"
	},
	truncate: {
		"textOverflow": "ellipsis",
		"whiteSpace": "nowrap",
		"overflow": "hidden"
	},
	textFg: {
		"color": "var(--text)"
	},
	phoneTextBody: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-body)"
		}
	},
	mt1: {
		"marginTop": "4px"
	},
	gap25: {
		"gap": "10px"
	},
	shrink0: {
		"flexShrink": "0"
	},
	gap05: {
		"gap": "2px"
	},
	transitionOpacity: {
		"transitionProperty": "opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	phoneHidden: {
		"@media (max-width: 720px)": {
			"display": "none"
		}
	},
	w62px: {
		"width": "62px"
	},
	textRight: {
		"textAlign": "right"
	},
	leadingNone: {
		"--tw-leading": "1",
		"lineHeight": "1"
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	right3: {
		"right": "12px"
	},
	top15: {
		"top": "6px"
	},
	z1: {
		"zIndex": "1"
	},
	focusVisibleOpacity100: {
		":focusVisible": {
			"opacity": "1"
		}
	},

	pbMax12pxEnvSafeAreaInsetBottom0px: {
		"paddingBottom": "max(12px, env(safe-area-inset-bottom,0px))"
	},
	transitionColorBackgroundColorTransform: {
		"transitionProperty": "color,background-color,transform",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	phoneTransformTranslateXVarSwipeX0: {
		"@media (max-width: 720px)": {
			"transform": "translateX(var(--swipe-x,0))"
		}
	},
});

/**
 * A plain list rather than a bordered card. At 200 rows an outer border is a
 * box around the page itself; inset row separators carry the useful structure.
 */
export const ARCHIVED_LIST = mergeStylexClassName("", sx.Mx3);

/**
 * Phone Search lives at the thumb edge instead of spending permanent room
 * under the navigation bar. The fade keeps rows legible as they pass behind
 * the floating field without drawing a hard toolbar divider.
 */
export const ARCHIVED_PHONE_SEARCH_DOCK =
	mergeStylexClassName("", sx.pointerEventsNone, sx.fixed, sx.insetX0, sx.bottom0, sx.z30, sx.hidden, sx.px35, sx.pt6) + " " +
	mergeStylexClassName("", sx.pbMax12pxEnvSafeAreaInsetBottom0px, sx.phoneBlock) + " " +
	"phone:[body.kb-open_&]:pb-3 " +
	mergeStylexClassName("", sx.beforePointerEventsNone, sx.beforeAbsolute, sx.beforeInset0, sx.beforeZ1) + " " +
	mergeStylexClassName("", sharedClassStyles.beforeBgLinearGradientToBottomTransparent0VarBg48) +
	" " + "[&>input]:pointer-events-auto";

/** Section labels and row contents share the page's content edge. The list
 * itself extends 12px beyond it so the hover wash has room to breathe. */
export const ARCHIVED_SECTION_LABEL =
	mergeStylexClassName("", sx.m0, sx.px3, sx.pb15, typography.meta, sx.fontSemibold, sx.textFaint);

export const ARCHIVED_SECTION_ROWS = mergeStylexClassName("", sx.m0, sx.listNone, sx.p0);

/** Mobile swipe frame. The Restore action sits behind the opaque row surface. */
export const ARCHIVED_SWIPE_ROW =
	mergeStylexClassName("", sx.relative, sx.overflowHidden, sx.roundedControl, sx.SwipeActionW0px) + " " +
	"last:[&>.archived-row]:after:opacity-0 " +
	"[&:has(+li:hover)>.archived-row]:after:opacity-0 " +
	"[&:has(+li:focus-within)>.archived-row]:after:opacity-0";

export const ARCHIVED_SWIPE_ACTION =
	mergeStylexClassName("", sx.absolute, sx.insetY0, sx.right0, sx.hidden, sx.wVarSwipeActionW, sx.itemsCenter, sx.justifyCenter, sx.gap15) + " " +
	mergeStylexClassName("", sx.borderNone, sx.bgAccent, sx.px3, typography.label, sx.fontSemibold, sx.textOnAccent, sx.opacity0) + " " +
	mergeStylexClassName("data-[open]:opacity-100 phone:[&_svg]:shrink-0", sx.phoneFlex, sx.phoneMinH11, sx.phoneTouchManipulation);

/**
 * A row. `relative` positions three things: the separator below it, the
 * open-button's full-bleed overlay (see ROW_OPEN) and the action that has to
 * sit above that overlay.
 *
 * `focus-within:bg-hover` matters as much as the hover: with the whole row
 * clickable through an overlay, keyboard focus lands on a button whose visible
 * text is only the title — lighting the row is what says how far the target
 * reaches.
 *
 * The separator is the row's own `::after`, inset past the repo tile and gone
 * on the last row. It also clears out around the highlight: the
 * hovered row hides its own, and `:has(+ li:hover)` hides the one above it, so
 * a lit row is a clean slab rather than a strip with a line cutting its corner
 * — the same tidying an iOS list does around a highlighted cell.
 */
export const ARCHIVED_ROW =
	mergeStylexClassName("archived-row group", sx.relative, sx.flex, sx.itemsStart, sx.gap3, sx.roundedControl, sx.px3, sx.py25) + " " +
	mergeStylexClassName("", sx.transitionColorBackgroundColorTransform, sx.durationVarDurMicro, sx.easeVarEase) + " " +
	mergeStylexClassName("", sx.hoverBgHover, sx.focusWithinBgHover) + " " +
	mergeStylexClassName("", sx.afterPointerEventsNone, sx.afterAbsolute, sx.afterRight3, sx.afterBottom0, sx.afterLeft42px) + " " +
	mergeStylexClassName("", sx.afterHPx, sx.afterBgLine, sx.afterTransitionOpacity, sx.afterDurationVarDurMicro) + " " +
	mergeStylexClassName("", sx.hoverAfterOpacity0, sx.focusWithinAfterOpacity0) + " " +
	mergeStylexClassName("", sx.phoneZ1, sx.phoneGap25, sx.phoneTouchPanY, sx.phoneBgSurface, sx.phonePx18px, sx.phonePy4) + " " +
	mergeStylexClassName("", sx.phoneTransformTranslateXVarSwipeX0, sx.phoneAfterLeft46px);

/**
 * The open action, stretched over the whole row by its own `::after` so a click
 * anywhere opens the session — including on the repo tile and the timestamp,
 * which are not themselves interactive. The ring stays on the title (the thing
 * a reader is aiming at); the row's `focus-within` wash carries the rest.
 */
export const ARCHIVED_ROW_OPEN =
	mergeStylexClassName("", sx.focusRing, sx.minW0, sx.flex1, sx.cursorPointer, sx.roundedSm, sx.borderNone, sx.bgTransparent, sx.p0) + " " +
	mergeStylexClassName("", sx.textLeft, sx.afterAbsolute, sx.afterInset0, sx.afterContent);

export const ARCHIVED_ROW_TITLE =
	mergeStylexClassName("", sx.block, sx.truncate, typography.label, sx.textFg, sx.phoneTextBody);

/** The line under the title, and only when it has something to say — see the
 *  meta rules in the component: a field the current filter already fixes is
 *  the same word on every row. */
export const ARCHIVED_ROW_META =
	mergeStylexClassName("", sx.mt1, sx.flex, sx.minW0, sx.itemsCenter, sx.gap25, typography.meta, sx.textFaint);

/** The timestamp and disclosure affordance step aside for Restore on hover. */
export const ARCHIVED_ROW_TRAIL =
	mergeStylexClassName("", sx.flex, sx.shrink0, sx.itemsCenter, sx.gap05, sx.textFaint, sx.transitionOpacity) + " " +
	mergeStylexClassName("group-hover:opacity-0", sx.durationVarDurMicro, sx.easeVarEase) + " " +
	mergeStylexClassName("group-focus-within:opacity-0", sx.phoneHidden);

export const ARCHIVED_ROW_TIME =
	mergeStylexClassName("", sx.w62px, sx.textRight, typography.meta, sx.leadingNone, sx.tabularNums);

/**
 * Desktop Restore replaces the timestamp on hover or keyboard focus. Phones
 * reveal the labelled swipe action instead, so every row stays visually quiet.
 */
export const ARCHIVED_ROW_ACTION =
	mergeStylexClassName("", sx.absolute, sx.right3, sx.top15, sx.z1, sx.opacity0, sx.transitionOpacity) + " " +
	mergeStylexClassName("group-hover:opacity-100", sx.durationVarDurMicro, sx.easeVarEase) + " " +
	mergeStylexClassName("", sx.focusVisibleOpacity100, sx.phoneHidden);
