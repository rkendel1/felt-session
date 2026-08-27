/**
 * The Reports page's list column: the automations down the left, and the
 * header band that column shares with the report beside it.
 *
 * The column used to be the odd surface in the app. It painted `bg-panel`
 * (#f0f0f0) inside DETAIL_PANE, which is already white paper (see
 * app-shell-classes: WORKSPACE_SHELL declares "paper starts here" with a seam
 * and a shadow), so one window read chrome, seam, chrome, paper, and the least
 * important column was the heaviest thing on screen. It is paper now, and a
 * hairline is the only thing between the two. What separates them is the
 * density difference between a list of rows and a document, which is how Mail
 * and Linear separate the same two panes.
 *
 * The rows are the app's own row grammar rather than a second one invented
 * here: the 22px leading rail, its 7px gap, the hover LAYER and the
 * translucent `bg-selected` all come from lib/sidebar-classes, so a report row
 * on this page and the one in the sidebar (components/sidebar/
 * AutomationReportRow) sit on the same left edge and light up the same way.
 * Only the two-line box is local, because a sidebar row is one line.
 *
 * Everything is written as complete literals, and nothing here re-states a
 * property another string in the same `className` already sets. Two utilities
 * for one property are settled by Tailwind's output order rather than by the
 * order they are written, so the time badge below spells its own box instead
 * of appending an override to SIDEBAR_WS_TIME.
 */

import { SIDEBAR_HOVER_LAYER, SIDEBAR_RAIL_GAP } from "./sidebar-classes";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
	flex: {
		"display": "flex"
	},
	minH0: {
		"minHeight": "0"
	},
	flexCol: {
		"flexDirection": "column"
	},
	phoneWFull: {
		"@media (max-width: 720px)": {
			"width": "100%"
		}
	},
	phoneFlex1: {
		"@media (max-width: 720px)": {
			"flex": "1"
		}
	},
	desktopW300px: {
		"@media (min-width: 721px)": {
			"width": "300px"
		}
	},
	desktopShrink0: {
		"@media (min-width: 721px)": {
			"flexShrink": "0"
		}
	},
	desktopBorderR: {
		"@media (min-width: 721px)": {
			"borderRightStyle": "var(--tw-border-style)",
			"borderRightWidth": "1px"
		}
	},
	desktopBorderDivider: {
		"@media (min-width: 721px)": {
			"borderColor": "var(--divider)"
		}
	},
	hVarDesktopHeaderH: {
		"height": "var(--desktop-header-h)"
	},
	shrink0: {
		"flexShrink": "0"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap2: {
		"gap": "8px"
	},
	bgSurface: {
		"backgroundColor": "var(--bg)"
	},
	px4: {
		"paddingInline": "16px"
	},
	desktopBorderB: {
		"@media (min-width: 721px)": {
			"borderBottomStyle": "var(--tw-border-style)",
			"borderBottomWidth": "1px"
		}
	},
	mlAuto: {
		"marginLeft": "auto"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
	m0: {
		"margin": "0"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	textFg: {
		"color": "var(--text)"
	},
	phoneTextSectionTitle: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-section-title)"
		}
	},
	flex1: {
		"flex": "1"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	px15: {
		"paddingInline": "6px"
	},
	pt3: {
		"paddingTop": "12px"
	},
	pb3: {
		"paddingBottom": "12px"
	},
	ScrollbarWidthNone: {
		"scrollbarWidth": "none"
	},
	mt15: {
		"marginTop": "6px"
	},
	wFull: {
		"width": "100%"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	itemsStart: {
		"alignItems": "flex-start"
	},
	roundedRow: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border0: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "0"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	py35: {
		"paddingBlock": "14px"
	},
	pr3: {
		"paddingRight": "12px"
	},
	pl25: {
		"paddingLeft": "10px"
	},
	textLeft: {
		"textAlign": "left"
	},
	minW0: {
		"minWidth": "0"
	},
	itemsBaseline: {
		"alignItems": "baseline"
	},
	truncate: {
		"textOverflow": "ellipsis",
		"whiteSpace": "nowrap",
		"overflow": "hidden"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	phoneText16px: {
		"@media (max-width: 720px)": {
			"fontSize": "16px"
		}
	},
	mt1: {
		"marginTop": "4px"
	},
	block: {
		"display": "block"
	},
	phoneText14px: {
		"@media (max-width: 720px)": {
			"fontSize": "14px"
		}
	},
	textRight: {
		"textAlign": "right"
	},
});

/**
 * The column. Paper, like the pane it sits in, separated by the chrome seam
 * token. Not `border-line`, which it had: that is the token for the edge of a
 * control, and it is part of why the column read as a form field.
 *
 * Phones render this same element as the whole page (the report is a separate
 * pushed page there), so both widths are variants rather than a branch in the
 * component.
 */
export const REPORTS_COLUMN =
	mergeStylexClassName("", sx.flex, sx.minH0, sx.flexCol) + " " +
	mergeStylexClassName("", sx.phoneWFull, sx.phoneFlex1) + " " +
	mergeStylexClassName("", sx.desktopW300px, sx.desktopShrink0, sx.desktopBorderR, sx.desktopBorderDivider);

/**
 * The column's heading, at both widths: a title bar, not a label over a list.
 * It names the page, which nothing else does on this route (App.tsx leaves the
 * top bar empty here), and its right side is a slot for what acts on the whole
 * list.
 *
 * It sits ABOVE the scroller rather than inside it, so it is fixed by
 * construction and the rows disappear under it as they travel. That is the
 * whole reason it is a sibling. Inside the list it could only be as wide as
 * the list's content box, which left the rows showing past both of its ends
 * and read as a label that had been left behind rather than as a bar.
 *
 * `--desktop-header-h` is the app's own bar height, the one DETAIL_TOPBAR_TITLE
 * takes, and the chat header, and the sidebar's brand row. Taking it lines this
 * bar up with them across the top of the window and gives the title its air
 * from a number the app already agrees on rather than from a guess. Desktop
 * keeps its pane divider. On a phone this is the full page surface, so a rule
 * underneath it only cuts the page into two grey bands.
 */
export const REPORTS_COLUMN_HEADER =
	// `wco-chrome`: a row across the top of a pane is where the desktop shell
	// expects to drag the window from, and base.css hangs that off this one name.
	mergeStylexClassName("wco-chrome", sx.flex, sx.hVarDesktopHeaderH, sx.shrink0, sx.itemsCenter, sx.gap2) + " " +
	mergeStylexClassName("", sx.bgSurface, sx.px4, sx.desktopBorderB, sx.desktopBorderDivider);

/**
 * What the column can say about itself, on the heading's right. `text-meta` is
 * the step the scale reserves for a count, and `tabular-nums` keeps it from
 * shifting width as reports land.
 */
export const REPORTS_COLUMN_COUNT =
	mergeStylexClassName("", sx.mlAuto, sx.shrink0, typography.meta, sx.fontMedium, sx.tabularNums, sx.textFaint);

/**
 * The heading itself, set the way the app sets every other title in a bar:
 * `text-item-title` semibold, which is what DETAIL_TOPBAR_TITLE gives a page
 * and what VIEWER_BRANCH gives the chat beside it. It was the 22px page-title
 * step, the right name for what this is and the wrong size for where it sits.
 * A whole workspace is named at 14px in the bar above a chat, so a 300px
 * column announcing itself half again as large read as a poster.
 *
 * Not one value at both widths, though it was for an hour: the rows under it
 * step up to 16px on a phone, so a heading held at 14 came out SMALLER than
 * every row it titles. Whatever the desktop argument, a title cannot be the
 * smallest thing in its own column. The phone takes the section step, which
 * clears its rows and stops short of the 22px this used to be. No tracking
 * override either. The scale sets it, and a third heading style is what this
 * was trying to stop being.
 */
export const REPORTS_COLUMN_TITLE =
	mergeStylexClassName("", sx.m0, typography.itemTitle, sx.fontSemibold, sx.textFg, sx.phoneTextSectionTitle);

/**
 * The scrolling list, outdented past the column's gutter so a row's pill
 * overflows the content edge, Conductor-style. SETTINGS_NAV_LIST and
 * SIDEBAR_LIST make the same move, and it is what lands the row content on the
 * app's 16px rail (6px of outdent plus the row's own 10px).
 *
 * Its scrollbar is hidden for the reason the app's sidebar and the settings
 * nav hide theirs: a track down the middle of the window cuts the list off
 * from the report it indexes. Overlay scrollbars make this invisible on a Mac
 * either way; it is the classic-scrollbar platforms this is for.
 *
 * The top padding is the gap under the title bar above it, which is a
 * sibling rather than the first thing in here: the rows have to be able to
 * travel past the top of this box and out of sight under that bar.
 */
export const REPORTS_LIST =
	mergeStylexClassName("", sx.minH0, sx.flex1, sx.overflowYAuto, sx.px15, sx.pt3, sx.pb3) + " " +
	mergeStylexClassName("[&::-webkit-scrollbar]:hidden", sx.ScrollbarWidthNone);

/**
 * A row: an automation, with the headline of its latest report under it.
 *
 * Two lines, so it sets its own vertical padding instead of taking the
 * sidebar's one-line `--sidebar-row-pad`, and it takes a good deal more of it
 * than a sidebar row does. This column is an index of twenty automations that
 * you read once and then leave, not a rail of fifty sessions you live in, so
 * it is paced for reading rather than for fitting. Everything else is shared:
 * the row corner, the 7px rail gap, the hover layer, and `bg-selected` for the
 * open one. Selected was `bg-active`, an opaque surface from the top of the
 * elevation ramp, which put a grey plate on the row you are already reading.
 * SETTINGS_NAV_ROW's doc has the longer version of that argument.
 */
export const REPORTS_ROW =
	mergeStylexClassName("group", sx.mt15, sx.flex, sx.wFull, sx.cursorPointer, sx.itemsStart, sx.roundedRow, sx.border0) + " " +
	mergeStylexClassName("data-active:bg-selected", sx.bgTransparent, sx.py35, sx.pr3, sx.pl25, sx.textLeft) +
	" " + [SIDEBAR_RAIL_GAP, SIDEBAR_HOVER_LAYER].filter(Boolean).join(" ");

/** The name and the time share the row's first line. */
export const REPORTS_ROW_HEAD = mergeStylexClassName("", sx.flex, sx.minW0, sx.itemsBaseline, sx.gap2);

export const REPORTS_ROW_NAME =
	mergeStylexClassName("", sx.minW0, sx.flex1, sx.truncate, typography.itemTitle, sx.fontMedium, sx.textDim) + " " +
	mergeStylexClassName("group-hover:text-fg group-data-active:text-fg", sx.phoneText16px);

/**
 * The latest report's title, faint under a dim name so the row reads its name
 * first. Both step up one when the row is the open one.
 */
export const REPORTS_ROW_LATEST =
	mergeStylexClassName("", sx.mt1, sx.block, sx.truncate, typography.label, sx.textFaint) + " " +
	mergeStylexClassName("group-data-active:text-dim", sx.phoneText14px);

/**
 * When it landed. SIDEBAR_WS_TIME's box without the gutter that string
 * reserves for the sidebar's pin/archive cluster: these rows have no hover
 * actions, so the digits sit on the row's own right padding.
 */
export const REPORTS_ROW_TIME =
	mergeStylexClassName("", sx.shrink0, sx.textRight, typography.meta, sx.tabularNums, sx.textFaint);
