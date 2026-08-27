/**
 * The Settings shell — what used to be the `settings-page` / `settings-back` /
 * `settings-content` / `settings-panel-frame` rules in legacy.css.
 *
 * Settings renders twice from one component file: a full-window page with a
 * side nav (desktop) and a bottom sheet with an iOS-style paged header
 * (phones, `MobileSettings`). The old sheet expressed the second as three
 * descendant overrides under `.settings-sheet`; here each surface names its
 * own finished string, because a descendant override is exactly the shape
 * that breaks when half a subtree migrates.
 *
 * `.settings-sheet` itself is NOT migrated and stays on the BottomSheet: it is
 * a hook, not styling — ui/settings.tsx reads it as `[.settings-sheet_&]:hidden`
 * to drop the page heading the sheet's own header already carries.
 *
 * One inherited quirk is preserved deliberately. A tool section (Automations,
 * Goals, Actions, Security) goes edge-to-edge on desktop, because those panels
 * bring their own padding and scrolling. Inside the sheet it does NOT: the old
 * `.settings-sheet .settings-content` was two class selectors and outranked
 * the single `.settings-content-tool`, so a tool section kept the sheet's 8px
 * gutter. That is almost certainly not what the override intended, but it is
 * what phones have been rendering, so SETTINGS_CONTENT_SHEET is the same
 * string either way rather than quietly re-cutting a layout this change is not
 * about.
 *
 * The desktop nav is not a cousin of the app's sidebar, it is the same design:
 * it takes that rail's surface, vertical scale, 22px glyph rail, hover layer
 * and selected wash from lib/sidebar-classes rather than re-deriving them
 * here. Anything below that reads as a settings-only number is a number the
 * two navs genuinely differ on, and says why.
 */

import { cn } from "../ui/cn";
import { SCROLL_EDGE_DIVIDER } from "./app-shell-classes";
import {
	SIDEBAR_DENSITY_VARS,
	SIDEBAR_GROUP,
	SIDEBAR_HOVER_LAYER,
	SIDEBAR_RAIL,
	SIDEBAR_RAIL_GAP,
} from "./sidebar-classes";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

const sx = stylex.create({
	flex: {
		"display": "flex"
	},
	minH0: {
		"minHeight": "0"
	},
	flex1: {
		"flex": "1"
	},
	bgSidebar: {
		"backgroundColor": "var(--sidebar-bg)"
	},
	pb2: {
		"paddingBottom": "8px"
	},
	afterInsetX3: {
		"::after": {
			"content": "var(--tw-content)",
			"insetInline": "-12px"
		}
	},
	Mx15: {
		"marginInline": "-6px"
	},
	flexCol: {
		"flexDirection": "column"
	},
	overflowXHidden: {
		"overflowX": "hidden"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	pt2: {
		"paddingTop": "8px"
	},
	ScrollbarWidthNone: {
		"scrollbarWidth": "none"
	},
	hVarSidebarCapH: {
		"height": "var(--sidebar-cap-h)"
	},
	shrink0: {
		"flexShrink": "0"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	px25: {
		"paddingInline": "10px"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	minW0: {
		"minWidth": "0"
	},
	justifyCenter: {
		"justifyContent": "center"
	},
	borderL: {
		"borderLeftStyle": "var(--tw-border-style)",
		"borderLeftWidth": "1px"
	},
	borderDivider: {
		"borderColor": "var(--divider)"
	},
	bgSurface: {
		"backgroundColor": "var(--bg)"
	},
	px8: {
		"paddingInline": "32px"
	},
	pt11: {
		"paddingTop": "44px"
	},
	desktopBoxShadowVarContentEdgeShadow: {
		"@media (min-width: 721px)": {
			"boxShadow": "var(--content-edge-shadow)"
		}
	},
	p0: {
		"padding": "0"
	},
	px2: {
		"paddingInline": "8px"
	},
	pt4: {
		"paddingTop": "16px"
	},
	wFull: {
		"width": "100%"
	},
	maxW720px: {
		"maxWidth": "720px"
	},
	selfStart: {
		"alignSelf": "flex-start"
	},
	pb22: {
		"paddingBottom": "88px"
	},
	maxW980px: {
		"maxWidth": "980px"
	},
	pb12: {
		"paddingBottom": "48px"
	},
	hFull: {
		"height": "100%"
	},
	px4: {
		"paddingInline": "16px"
	},
	pb72px: {
		"paddingBottom": "72px"
	},
	absolute: {
		"position": "absolute"
	},
	insetX0: {
		"insetInline": "0"
	},
	bottom0: {
		"bottom": "0"
	},
	z1: {
		"zIndex": "1"
	},
	pb25: {
		"paddingBottom": "10px"
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
	beforeInsetX0: {
		"::before": {
			"content": "var(--tw-content)",
			"insetInline": "0"
		}
	},
	beforeBottom0: {
		"::before": {
			"content": "var(--tw-content)",
			"bottom": "0"
		}
	},
	beforeTopAuto: {
		"::before": {
			"content": "var(--tw-content)",
			"top": "auto"
		}
	},
	beforeZ1: {
		"::before": {
			"content": "var(--tw-content)",
			"zIndex": "-1"
		}
	},
	beforeHCalc10030px: {
		"::before": {
			"content": "var(--tw-content)",
			"height": "calc(100% + 30px)"
		}
	},
	beforeContent: {
		"::before": {
			"--tw-content": "\"\"",
			"content": "var(--tw-content)"
		}
	},
	beforeBackdropBlur16px: {
		"::before": {
			"content": "var(--tw-content)",
			"--tw-backdrop-blur": "blur(16px)",
			"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
			"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
		}
	},
	beforeBackdropSaturate135: {
		"::before": {
			"content": "var(--tw-content)",
			"--tw-backdrop-saturate": "saturate(1.35)",
			"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
			"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
		}
	},

	w58: {
		"width": "232px"
	},
	px3: {
		"paddingInline": "12px"
	},
	py4: {
		"paddingBlock": "16px"
	},
	mb2: {
		"marginBottom": "8px"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	roundedRow: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	pyVarSidebarRowPad: {
		"paddingBlock": "var(--sidebar-row-pad)"
	},
	pr2: {
		"paddingRight": "8px"
	},
	pl25: {
		"paddingLeft": "10px"
	},
	textLeft: {
		"textAlign": "left"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	mt05: {
		"marginTop": "2px"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
});

/**
 * The full-window page: side nav + content, filling the app body.
 *
 * It paints the SIDEBAR's surface rather than the page's, which is what
 * APP_BODY does and the first half of why the two navs read as one design. A
 * nav is a column of chrome; what separates it from the content is the seam
 * and the shadow on the content's left edge (see SETTINGS_CONTENT), so the
 * column itself needs no fill and no border of its own.
 */
export const SETTINGS_PAGE = mergeStylexClassName("", sx.flex, sx.minH0, sx.flex1, sx.bgSidebar);

/**
 * The nav column. No fill, no edge: the page under it is already the sidebar
 * surface, exactly as the app's own sidebar sits on APP_BODY's.
 *
 * It also sets the sidebar's vertical scale, so a settings row, its caption
 * and the app's rows run on one set of numbers instead of two copies that
 * drift. The compact overrides in that string key off a `data-density`
 * attribute this element deliberately does not carry: the preference is named
 * "Compact sidebar" and retunes the rail you work in, not a nav you visit.
 */
export const SETTINGS_NAV =
	[mergeStylexClassName("[html.wco_&]:pt-(--desktop-header-h)", sx.flex, sx.w58, sx.shrink0, sx.flexCol, sx.px3, sx.py4), SIDEBAR_DENSITY_VARS].filter(Boolean).join(" ");

/**
 * The nav's search field, and the seam it grows once the section list travels
 * under it.
 *
 * At rest there is no line: the field and the list sit on one fill, so there is
 * nothing between them to close off. Once the list has scrolled there is a cut
 * edge, a row sliced in half at the top of the scrollport, and this closes it.
 * The app's own chrome rows answer their scroller on the same terms; see
 * SCROLL_EDGE_DIVIDER, and hooks/useScrollEdge.ts for why the state arrives as
 * an attribute rather than a scroll timeline.
 *
 * The line runs to the column's own edges rather than the field's, which is
 * where SettingsAccountFooter puts its top border: a seam across the column is
 * as wide as the column. The 8px under the field is the air that keeps a
 * half-scrolled row off the field's edge, and the list's own `pt-2` matches it
 * at rest, so the line lands centred in the gap it appears in.
 */
export const SETTINGS_NAV_SEARCH = cn(SCROLL_EDGE_DIVIDER, mergeStylexClassName("", sx.pb2, sx.afterInsetX3));

/**
 * The scrolling section list, and one group inside it.
 *
 * The list is outdented past the nav's gutter so a row's pill sits 6px from
 * the column edge and its content lands on the app sidebar's 16px rail
 * (6 + the row's own 10px). That overflow is what gives the rail its
 * Conductor-style pill; see SIDEBAR_LIST, which is the same move from the
 * other direction. Its scrollbar is hidden for the reason the app's is: a
 * track down the middle of the window cuts the nav off from the content.
 */
export const SETTINGS_NAV_LIST =
	mergeStylexClassName("[&::-webkit-scrollbar]:hidden", sx.Mx15, sx.flex, sx.minH0, sx.flex1, sx.flexCol, sx.overflowXHidden, sx.overflowYAuto, sx.pt2, sx.ScrollbarWidthNone);

export const SETTINGS_NAV_GROUP = [mergeStylexClassName("", sx.flex, sx.flexCol), SIDEBAR_GROUP].filter(Boolean).join(" ");

/**
 * A group's caption: Personal, Organization. The app's band headings in every
 * respect that shows: the caption height, 13px semibold, and dim ink rather
 * than faint. It was 11px bold with letterspacing, which is a different
 * typographic idea (a small-caps label) from the one the sidebar uses.
 */
export const SETTINGS_NAV_CAPTION =
	mergeStylexClassName("", sx.flex, sx.hVarSidebarCapH, sx.shrink0, sx.itemsCenter, sx.px25, typography.label, sx.fontSemibold, sx.textDim);

/**
 * "Back to app" is the first row of the nav, and now a member of the row family
 * below rather than a smaller control above it: same box, same rail, so its
 * chevron and the section glyphs share a centre line.
 *
 * No `w-full`. It is outdented like the list, and a stretched flex child
 * already measures its container plus those two negative margins; `w-full`
 * would size it to the container alone and pull the pill back in on the right.
 */
export const SETTINGS_BACK =
	[mergeStylexClassName("group", sx.Mx15, sx.mb2, sx.flex, sx.cursorPointer, sx.itemsCenter), SIDEBAR_RAIL_GAP, mergeStylexClassName("", sx.roundedRow, sx.borderNone, sx.bgTransparent, sx.pyVarSidebarRowPad, sx.pr2, sx.pl25, sx.textLeft, typography.itemTitle, sx.fontMedium, sx.textDim, sx.hoverTextFg), SIDEBAR_HOVER_LAYER].filter(Boolean).join(" ");

/**
 * The scrolling content column beside the nav. `tool` sections fill it
 * edge-to-edge; pass the flag through `cn()` so tailwind-merge drops the
 * padding rather than leaving two padding utilities to fight by output order.
 *
 * The seam and the shadow are DETAIL_PANE's, the other half of the pair
 * SETTINGS_PAGE opens: the content is paper laid over the chrome, and the only
 * thing between them is that hairline plus, in light, a little depth. The
 * shadow rides `--content-edge-shadow`, which is `none` in dark.
 *
 * The page has no entrance. Opening Settings was animated twice (a fade and
 * slide, then a seam glide that started the column at the app rail's own edge)
 * and neither earned its place: Settings is somewhere you go, not something
 * that arrives, and any motion here delays a page you already asked for. It
 * cuts.
 */
export const SETTINGS_CONTENT =
	mergeStylexClassName("", sx.flex, sx.minW0, sx.flex1, sx.justifyCenter, sx.overflowYAuto, sx.borderL, sx.borderDivider, sx.bgSurface, sx.px8, sx.pt11, sx.desktopBoxShadowVarContentEdgeShadow);
export const SETTINGS_CONTENT_TOOL = mergeStylexClassName("", sx.minH0, sx.p0);

/** Same column inside the phone sheet — a phone gutter instead of the desktop one. */
export const SETTINGS_CONTENT_SHEET =
	mergeStylexClassName("", sx.flex, sx.minH0, sx.minW0, sx.flex1, sx.justifyCenter, sx.overflowYAuto, sx.px2, sx.pt4);

/** The reading column a settings panel sits in, and its bottom air. */
export const SETTINGS_PANEL_FRAME = mergeStylexClassName("", sx.wFull, sx.maxW720px, sx.selfStart, sx.pb22);

/**
 * The column a settings panel that BROWSES sits in. The Library is a catalog
 * rather than a form: its cards go two up, and at the reading column's 720px
 * a card is narrow enough that the sentence saying what it does gets cut off
 * mid-word. The measure that matters here is the card's, not the paragraph's.
 */
export const SETTINGS_PANEL_FRAME_GALLERY = mergeStylexClassName("", sx.wFull, sx.maxW980px, sx.selfStart, sx.pb22);
export const SETTINGS_PANEL_FRAME_SHEET = mergeStylexClassName("", sx.wFull, sx.maxW720px, sx.selfStart, sx.pb12);

/**
 * The phone sheet's section list and the search bar floating over its bottom
 * edge, where iOS 26 puts a list's search.
 *
 * The bar is glass, in the same terms the phone app header uses (APP_HEADER):
 * a `before:` layer that blurs what passes behind it, tinted with a gradient
 * of the page colour and masked so the blur ends softly instead of on a line.
 * That only reads as glass if there IS something behind it, so the list scrolls
 * the full height of the page and reserves the bar's height as bottom padding —
 * the last row can still be scrolled clear of it.
 *
 * The `before:z-[-1]` needs the bar's own `z-1`: without a stacking context of
 * its own, a negative-z pseudo drops behind the list rather than sitting under
 * its parent's content.
 */
export const SETTINGS_SHEET_LIST = mergeStylexClassName("", sx.hFull, sx.overflowYAuto, sx.px4, sx.pb72px);

export const SETTINGS_SHEET_SEARCH_BAR =
	mergeStylexClassName("", sx.absolute, sx.insetX0, sx.bottom0, sx.z1, sx.px4, sx.pb25, sx.pt2) + " " +
	mergeStylexClassName("", sx.beforePointerEventsNone, sx.beforeAbsolute, sx.beforeInsetX0, sx.beforeBottom0) + " " +
	mergeStylexClassName("", sx.beforeTopAuto, sx.beforeZ1, sx.beforeHCalc10030px, sx.beforeContent) +
	// Translucent all the way down, not opaque at the base: glass that admits
	// nothing is just a panel. It only firms up (88%) at the very bottom edge,
	// where a row would otherwise read THROUGH the field rather than behind it.
	" " + mergeStylexClassName("", sharedClassStyles.beforeBackgroundLinearGradientToTopColorMixInSrgbVarBg88Transparent0ColorMixInSrgbVarBg76Transparent55ColorMixInSrgbVarBg45Transparent78Transparent100) +
	" " + mergeStylexClassName("", sx.beforeBackdropBlur16px, sx.beforeBackdropSaturate135) + " " +
	mergeStylexClassName("", sharedClassStyles.beforeWebkitMaskImageLinearGradientToTopVarColorBlack0VarColorBlack62Transparent100) +
	" " + mergeStylexClassName("", sharedClassStyles.beforeMaskImageLinearGradientToTopVarColorBlack0VarColorBlack62Transparent100);

/**
 * A row in the settings navigation: the section list and the account block
 * under it, which are one list visually and were two copies of this string.
 *
 * This is SIDEBAR_ROW: the same 2px gap between rows, the same
 * `--sidebar-row-pad` box around a 22px rail, the same 7px to the title, the
 * same asymmetric 10/8 gutters.
 *
 * The two fills are the point of the exercise. Selected was `bg-active`
 * (#e0e0e0 in light), an opaque surface from the top of the elevation ramp,
 * which put a grey plate on the one row you are already reading. It takes
 * `--selected` now, the translucent ink the app marks an open session with,
 * and hover is the sidebar's LAYER rather than a colour, so pointing at the
 * selected row lifts it instead of swapping one wash for a lighter one. See
 * SIDEBAR_HOVER_LAYER, which explains why that has to be a layer.
 */
export const SETTINGS_NAV_ROW =
	[mergeStylexClassName("group", sx.mt05, sx.flex, sx.wFull, sx.cursorPointer, sx.itemsCenter), SIDEBAR_RAIL_GAP, mergeStylexClassName("data-active:bg-selected data-active:text-fg", sx.roundedRow, sx.borderNone, sx.bgTransparent, sx.pyVarSidebarRowPad, sx.pr2, sx.pl25, sx.textLeft, typography.itemTitle, sx.fontMedium, sx.textDim, sx.hoverTextFg), SIDEBAR_HOVER_LAYER].filter(Boolean).join(" ");

/**
 * The row's glyph well: the sidebar's 22px rail, not an 18px box. The glyphs
 * themselves use the Iconic set's standard 22px step. The rail is what puts
 * every settings label on the same left edge as every sidebar title, and it
 * centres each mark on that column.
 */
export const SETTINGS_NAV_ICON =
	[SIDEBAR_RAIL, mergeStylexClassName("group-hover:text-fg group-data-active:text-fg", sx.textFaint)].filter(Boolean).join(" ");
