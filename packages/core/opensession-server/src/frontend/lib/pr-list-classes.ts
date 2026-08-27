
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

const sx = stylex.create({
	Mx3: {
		"marginInline": "-12px"
	},
	m0: {
		"margin": "0"
	},
	mb35: {
		"marginBottom": "14px"
	},
	flex: {
		"display": "flex"
	},
	itemsBaseline: {
		"alignItems": "baseline"
	},
	gap2: {
		"gap": "8px"
	},
	px3: {
		"paddingInline": "12px"
	},
	fontTitle: {
		"--tw-font-weight": "var(--title-weight)",
		"fontWeight": "var(--title-weight)"
	},
	tracking001em: {
		"--tw-tracking": "-.01em",
		"letterSpacing": "-.01em"
	},
	textFg: {
		"color": "var(--text)"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	textFaint: {
		"color": "var(--text-faint)"
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
	relative: {
		"position": "relative"
	},
	grid: {
		"display": "grid"
	},
	wFull: {
		"width": "100%"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap25: {
		"gap": "10px"
	},
	roundedControl: {
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
	py3: {
		"paddingBlock": "12px"
	},
	textLeft: {
		"textAlign": "left"
	},
	transitionColors: {
		"transitionProperty": "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
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
	afterLeft46px: {
		"::after": {
			"content": "var(--tw-content)",
			"left": "46px"
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
	afterLeft78px: {
		"::after": {
			"content": "var(--tw-content)",
			"left": "78px"
		}
	},

	pb15: {
		"paddingBottom": "6px"
	},
	pb2: {
		"paddingBottom": "8px"
	},

	gridCols24pxMinmax01fr130px44px: {
		"gridTemplateColumns": "24px minmax(0,1fr) 130px 44px"
	},
	gridCols22px24pxMinmax01fr130px44px: {
		"gridTemplateColumns": "22px 24px minmax(0,1fr) 130px 44px"
	},
});

/**
 * The pull request list's geometry.
 *
 * Deliberately the archived list's idiom (lib/archived-classes.ts): one
 * page-wide list rather than a bordered card, inset hairlines carrying the
 * structure, and a rounded hover wash that the separators clear out of the way
 * for. This page lists the same kind of thing those pages do — a session's
 * work, one row at a time — so it should not invent a second row look.
 */

/** The shared page column. The pull-request top bar uses the same width so its
 *  title and trailing controls align with the list below. */
export const PR_PAGE_COLUMN = "mx-auto w-full max-w-[920px] px-6";

/** Labels and row contents share the page's content edge; the list itself runs
 *  12px past it so a hovered row's wash has room to breathe. */
export const PR_LIST = mergeStylexClassName("", sx.Mx3);

/** The state a block of rows is in: Open, Merged, Closed. Sized as the heading
 *  it is. A state owns hundreds of rows across several date groups, and at the
 *  13px interface step it read as one more label in a stack of labels rather
 *  than as the thing they all hang under.
 *
 *  Weight is the page title's, not a step above it. This label and `PageTitle`
 *  sit at the same 19px, so a heavier state heading reads as the page's real
 *  title and pushes "Pull requests" into looking like a caption over it. */
export const PR_SECTION_LABEL =
	mergeStylexClassName("", sx.m0, sx.mb35, sx.flex, sx.itemsBaseline, sx.gap2, sx.px3, typography.sectionTitle, sx.fontTitle, sx.tracking001em, sx.textFg);

/** A date group: the same quiet label the archived list gives its own. The
 *  `px-3` pays back the list's outdent, so every label on the page and the row
 *  content under it share one x. */
const GROUP_LABEL = mergeStylexClassName("", sx.m0, sx.flex, sx.itemsBaseline, sx.gap2, sx.px3, sx.fontSemibold, sx.textFaint);

/** A date belongs to the rows under it rather than to the state above it, so it
 *  stays on the content edge with them and sits tight to them: the air goes
 *  above it, under the state heading. Size is what separates the two, not an
 *  indent. */
export const PR_GROUP_LABEL = [GROUP_LABEL, mergeStylexClassName("", sx.pb15, typography.meta)].filter(Boolean).join(" ");

/** The same label in the feed, one step up the scale. The feed is grouped by
 *  day and nothing else, so the day is the heading a reader navigates by; on
 *  the pull request list a date sits under Open or Merged, which is the heading
 *  there, and stays the quieter of the two. */
export const PR_FEED_GROUP_LABEL = [GROUP_LABEL, mergeStylexClassName("", sx.pb2, typography.label)].filter(Boolean).join(" ");

/**
 * A pull request row.
 *
 * `relative` is for the separator: the row's own `::after`, inset past the
 * state glyph and the tile so it starts at the title, and gone on the last row.
 * It also clears out around the highlight — the hovered row hides its own and
 * `:has(+ button:hover)` hides the one above it — so a lit row reads as a clean
 * slab instead of a strip with a line cutting its corner.
 */
/**
 * The same row, in the People page's shipped feed.
 *
 * One column narrower: everything in the feed has merged, so the state glyph
 * would be the same mark on every line. The face takes its place, because who
 * shipped it is the one thing the feed is sorted around.
 */
/**
 * Both rows are one line now, and a one-line row wants more padding than a
 * two-line one did: `py-2.5` was set when a branch or a repo name sat under
 * every title, and once that went the rows read as a tighter list than the
 * rest of the app. `py-3` puts a row at the 44px the sidebar and the settings
 * rows already stand at. The column gap goes up with it, so the separator
 * offsets below are `px-3` plus the leading columns plus `gap-2.5`.
 */
export const PR_FEED_ROW =
	mergeStylexClassName("group", sx.gridCols24pxMinmax01fr130px44px, sx.focusRing, sx.relative, sx.grid, sx.wFull) + " " +
	mergeStylexClassName("", sx.cursorPointer, sx.itemsCenter, sx.gap25, sx.roundedControl, sx.border0, sx.bgTransparent, sx.px3, sx.py3) + " " +
	mergeStylexClassName("", sx.textLeft, sx.transitionColors, sx.durationVarDurMicro, sx.easeVarEase, sx.hoverBgHover) + " " +
	mergeStylexClassName("", sx.afterPointerEventsNone, sx.afterAbsolute, sx.afterRight3, sx.afterBottom0, sx.afterLeft46px) + " " +
	mergeStylexClassName("", sx.afterHPx, sx.afterBgLine, sx.afterTransitionOpacity, sx.afterDurationVarDurMicro) + " " +
	mergeStylexClassName("last:after:opacity-0", sx.hoverAfterOpacity0) + " " +
	"[&:has(+button:hover)]:after:opacity-0 " +
	mergeStylexClassName("", sharedClassStyles.phoneGridCols24pxMinmax01fr44px);

export const PR_ROW =
	mergeStylexClassName("group", sx.gridCols22px24pxMinmax01fr130px44px, sx.focusRing, sx.relative, sx.grid, sx.wFull) + " " +
	mergeStylexClassName("", sx.cursorPointer, sx.itemsCenter, sx.gap25, sx.roundedControl, sx.border0, sx.bgTransparent, sx.px3, sx.py3) + " " +
	mergeStylexClassName("", sx.textLeft, sx.transitionColors, sx.durationVarDurMicro, sx.easeVarEase, sx.hoverBgHover) + " " +
	mergeStylexClassName("", sx.afterPointerEventsNone, sx.afterAbsolute, sx.afterRight3, sx.afterBottom0, sx.afterLeft78px) + " " +
	mergeStylexClassName("", sx.afterHPx, sx.afterBgLine, sx.afterTransitionOpacity, sx.afterDurationVarDurMicro) + " " +
	mergeStylexClassName("last:after:opacity-0", sx.hoverAfterOpacity0) + " " +
	"[&:has(+button:hover)]:after:opacity-0 " +
	mergeStylexClassName("", sharedClassStyles.phoneGridCols22px24pxMinmax01fr44px);
