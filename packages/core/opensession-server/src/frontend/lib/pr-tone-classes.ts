import type { GitDotTone } from "./pr-git-tasks";
import type { PrTone } from "./pr-refs";
import type { checkClass } from "./pr-status-derive";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";
import { motionStyles } from "../styles/animations.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

const sx = stylex.create({
	bgGreen: {
		"backgroundColor": "var(--green)"
	},
	bgYellow: {
		"backgroundColor": "var(--yellow)"
	},
	bgRed: {
		"backgroundColor": "var(--red)"
	},
	bgBlue: {
		"backgroundColor": "var(--blue)"
	},
	bgPurple: {
		"backgroundColor": "var(--purple)"
	},
	bgFaint: {
		"backgroundColor": "var(--text-faint)"
	},
	mx05: {
		"marginInline": "2px"
	},
	size15: {
		"width": "6px",
		"height": "6px"
	},
	shrink0: {
		"flexShrink": "0"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	,
		cornerShape: "round"},
	flex: {
		"display": "flex"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap2: {
		"gap": "8px"
	},
	px2: {
		"paddingInline": "8px"
	},
	py1: {
		"paddingBlock": "4px"
	},
	textFg: {
		"color": "var(--text)"
	},
	flex1: {
		"flex": "1"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	textEllipsis: {
		"textOverflow": "ellipsis"
	},
	inlineFlex: {
		"display": "inline-flex"
	},
	minH22px: {
		"minHeight": "22px"
	},
	whitespaceNowrap: {
		"whiteSpace": "nowrap"
	},
	roundedMd: {
		"borderRadius": "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity60: {
		":disabled": {
			"opacity": ".6"
		}
	},
	bgControl: {
		"backgroundColor": "var(--control-surface)"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	gap1: {
		"gap": "4px"
	},
	pr1: {
		"paddingRight": "4px"
	},
	textGreen: {
		"color": "var(--green)"
	},
	textYellow: {
		"color": "var(--yellow)"
	},
	textRed: {
		"color": "var(--red)"
	},
	textBlue: {
		"color": "var(--blue)"
	},
	opacity55: {
		"opacity": ".55"
	},
	pt05: {
		"paddingTop": "2px"
	},
	pb15: {
		"paddingBottom": "6px"
	},
	pl5: {
		"paddingLeft": "20px"
	},
	Container: {
		"containerType": "inline-size"
	},
	minHVarDesktopHeaderH: {
		"minHeight": "var(--desktop-header-h)"
	},
	gap25: {
		"gap": "10px"
	},
	px3: {
		"paddingInline": "12px"
	},
	py2: {
		"paddingBlock": "8px"
	},
	bgGreenSoft: {
		"backgroundColor": "var(--green-soft)"
	},
	bgRedSoft: {
		"backgroundColor": "var(--red-soft)"
	},
	bgPanel: {
		"backgroundColor": "var(--bg-panel)"
	},
	animatePulse16sEaseInOutInfinite: {
		"animation": "1.6s ease-in-out infinite pulse"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	hoverUnderline: {
		"@media (hover: hover)": {
			":hover": {
				"textDecorationLine": "underline"
			}
		}
	},
	textPurple: {
		"color": "var(--purple)"
	},
	maxW180px: {
		"maxWidth": "180px"
	},
	truncate: {
		"textOverflow": "ellipsis",
		"whiteSpace": "nowrap",
		"overflow": "hidden"
	},
	minW0: {
		"minWidth": "0"
	},
	maxW120px: {
		"maxWidth": "120px"
	},
	minH32px: {
		"minHeight": "32px"
	},
	px11px: {
		"paddingInline": "11px"
	},
	gap05: {
		"gap": "2px"
	},
	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	noUnderline: {
		"textDecorationLine": "none"
	},
	transitionBackgroundColor: {
		"transitionProperty": "background-color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	minH30px: {
		"minHeight": "30px"
	},
	roundedSControl: {
		"borderStartStartRadius": "calc(12px * var(--rf))",
		"borderEndStartRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	roundedENone: {
		"borderStartEndRadius": "0",
		"borderEndEndRadius": "0"
	,
		cornerShape: "var(--cs)"},
	px25: {
		"paddingInline": "10px"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	cursorInherit: {
		"cursor": "inherit"
	},
	px7px: {
		"paddingInline": "7px"
	},
	minH26px: {
		"minHeight": "26px"
	},
	borderLine: {
		"borderColor": "var(--border)"
	},
	MlPx: {
		"marginLeft": "-1px"
	},
	justifyCenter: {
		"justifyContent": "center"
	},
	roundedEControl: {
		"borderStartEndRadius": "calc(12px * var(--rf))",
		"borderEndEndRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	roundedSNone: {
		"borderStartStartRadius": "0",
		"borderEndStartRadius": "0"
	,
		cornerShape: "var(--cs)"},
	activeScale096: {
		":active": {
			"scale": ".96"
		}
	},
	size32px: {
		"width": "32px",
		"height": "32px"
	},
	size30px: {
		"width": "30px",
		"height": "30px"
	},
	pr9px: {
		"paddingRight": "9px"
	},
	pl5px: {
		"paddingLeft": "5px"
	},
	pr2: {
		"paddingRight": "8px"
	},
	pl1: {
		"paddingLeft": "4px"
	},
	hoverRelative: {
		"@media (hover: hover)": {
			":hover": {
				"position": "relative"
			}
		}
	},
	hoverZ1: {
		"@media (hover: hover)": {
			":hover": {
				"zIndex": "1"
			}
		}
	},
	focusVisibleRelative: {
		":focusVisible": {
			"position": "relative"
		}
	},
	focusVisibleZ1: {
		":focusVisible": {
			"zIndex": "1"
		}
	},
	size7px: {
		"width": "7px",
		"height": "7px"
	},
	bgDim: {
		"backgroundColor": "var(--text-dim)"
	},
	minH38px: {
		"minHeight": "38px"
	},
	borderT: {
		"borderTopStyle": "var(--tw-border-style)",
		"borderTopWidth": "1px"
	},
	borderDivider: {
		"borderColor": "var(--divider)"
	},
	hoverBrightness108: {
		"@media (hover: hover)": {
			":hover": {
				"--tw-brightness": "brightness(1.08)",
				"filter": "var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)"
			}
		}
	},
	textLeft: {
		"textAlign": "left"
	},
	mlAuto: {
		"marginLeft": "auto"
	},
	overflowXAuto: {
		"overflowX": "auto"
	},
	borderB: {
		"borderBottomStyle": "var(--tw-border-style)",
		"borderBottomWidth": "1px"
	},
	ScrollbarWidthNone: {
		"scrollbarWidth": "none"
	},
	phoneBorderB: {
		"@media (max-width: 720px)": {
			"borderBottomStyle": "var(--tw-border-style)",
			"borderBottomWidth": "1px"
		}
	},
	phoneBorderDivider: {
		"@media (max-width: 720px)": {
			"borderColor": "var(--divider)"
		}
	},
	gap15: {
		"gap": "6px"
	},
	py3px: {
		"paddingBlock": "3px"
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phonePy2: {
		"@media (max-width: 720px)": {
			"paddingBlock": "8px"
		}
	},
	borderTransparent: {
		"borderColor": "transparent"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	Mr1: {
		"marginRight": "-4px"
	},
	size6: {
		"width": "24px",
		"height": "24px"
	},

	flexCol: {
		"flexDirection": "column"
	},
	minH11: {
		"minHeight": "44px"
	},
	shadowVarMobileHeaderControlShadow: {
		"--tw-shadow": "var(--mobile-header-control-shadow)",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},

	transitionColorBackgroundColor: {
		"transitionProperty": "color,background-color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	enabledHoverBgActive: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"backgroundColor": "var(--bg-active)"
				}
			}
		}
	},
	enabledHoverTextFg: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"color": "var(--text)"
				}
			}
		}
	},
	bgColorMixInSrgbVarGreen24VarControlSurface: {
		"backgroundColor": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--green) 24%,var(--control-surface))"
		}
	},
	enabledHoverBgColorMixInSrgbCurrentColor34VarControlSurface: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"backgroundColor": "currentColor"
				}
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":enabled": {
					":hover": {
						"backgroundColor": "color-mix(in srgb,currentColor 34%,var(--control-surface))"
					}
				}
			}
		}
	},
	bgColorMixInSrgbVarYellow24VarControlSurface: {
		"backgroundColor": "var(--yellow)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--yellow) 24%,var(--control-surface))"
		}
	},
	bgColorMixInSrgbVarRed24VarControlSurface: {
		"backgroundColor": "var(--red)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--red) 24%,var(--control-surface))"
		}
	},
	bgColorMixInSrgbVarBlue24VarControlSurface: {
		"backgroundColor": "var(--blue)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--blue) 24%,var(--control-surface))"
		}
	},
	hoverBgColorMixInSrgbCurrentColor12Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "currentColor"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,currentColor 12%,transparent)"
				}
			}
		}
	},
	activeBgColorMixInSrgbCurrentColor18Transparent: {
		":active": {
			"backgroundColor": "currentColor"
		},
		"@supports (color: color-mix(in lab, red, red))": {
			":active": {
				"backgroundColor": "color-mix(in srgb,currentColor 18%,transparent)"
			}
		}
	},
	borderColorMixInSrgbVarGreen22Transparent: {
		"borderColor": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--green) 22%,transparent)"
		}
	},
	hoverBgColorMixInSrgbCurrentColor32VarControlSurface: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "currentColor"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,currentColor 32%,var(--control-surface))"
				}
			}
		}
	},
	borderColorMixInSrgbVarPurple22Transparent: {
		"borderColor": "var(--purple)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--purple) 22%,transparent)"
		}
	},
	bgColorMixInSrgbVarPurple24VarControlSurface: {
		"backgroundColor": "var(--purple)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--purple) 24%,var(--control-surface))"
		}
	},
	borderColorMixInSrgbVarRed22Transparent: {
		"borderColor": "var(--red)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--red) 22%,transparent)"
		}
	},
	borderColorMixInSrgbVarYellow22Transparent: {
		"borderColor": "var(--yellow)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--yellow) 22%,transparent)"
		}
	},
	transitionBackgroundColorScale: {
		"transitionProperty": "background-color,scale",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	hoverBgColorMixInSrgbCurrentColor14Transparent: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "currentColor"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,currentColor 14%,transparent)"
				}
			}
		}
	},
});

/**
 * The shared vocabulary of the PR surfaces, as finished utility classes.
 *
 * Two things live here rather than on the markup.
 *
 * The tone lookups replace classes the `pr-*` markup used to assemble at
 * render time — `pr-git-dot-${tone}`, `pr-bar-state-${tone}`,
 * `pr-num-chip-${tone}`, `pr-sib-dot-${tone}`. A class built from a fragment
 * can never be proven unused by scripts/css-audit.ts, so those rules were
 * pinned in legacy.css permanently; a lookup that returns the whole class
 * cannot be. Same pattern as TONE_TEXT in lib/sidebar-hover.ts.
 *
 * The row strings are here because two surfaces render the same git-status
 * row from different components — the review canvas (pr/GitStatus.tsx) and the
 * workspace panel (WorkspaceInfo.tsx). They were one legacy class each; a
 * shared constant keeps them one thing rather than two copies that drift.
 */

/** Fill for the small state dot on a git-status row. `muted` keeps the dot's
 *  own default (faint), which is what "no tone class" used to mean. */
export const GIT_DOT_BG: Record<GitDotTone, string> = {
	green: mergeStylexClassName("", sx.bgGreen),
	yellow: mergeStylexClassName("", sx.bgYellow),
	red: mergeStylexClassName("", sx.bgRed),
	blue: mergeStylexClassName("", sx.bgBlue),
	purple: mergeStylexClassName("", sx.bgPurple),
	muted: mergeStylexClassName("", sx.bgFaint),
};

/** A state dot, not a step marker: small and filled with the row's own state
 *  colour, so a stack of them doesn't read as a checklist that never
 *  completes. Pair with a GIT_DOT_BG entry. */
export const GIT_DOT = mergeStylexClassName("", sx.mx05, sx.size15, sx.shrink0, sx.roundedFull);
export const GIT_ROW = mergeStylexClassName("", sx.flex, sx.itemsCenter, sx.gap2, sx.px2, sx.py1, typography.label, sx.textFg);
export const GIT_LABEL = mergeStylexClassName("", sx.flex1, sx.overflowHidden, sx.textEllipsis);
/** The one action that clears the row, quiet on the right. 12px in the old
 *  sheet; it is a control label, so it snaps to text-label.
 *
 *  A weak plate rather than bare words: as text it read as part of the row's
 *  own sentence, and the only thing saying "press me" arrived on hover. The
 *  fill is `--control-surface`, one step over whatever the row sits on (the
 *  panel plate, the review canvas), so it reads as a control at the quietest
 *  weight the row can carry — the Button primitive's `soft`, at chip size.
 *  `data-popup-open` keeps the menu triggers ("Request", "Change") lit while
 *  their own menu is open. */
const GIT_ACTION_BOX =
	mergeStylexClassName("", sx.transitionColorBackgroundColor, sx.inlineFlex, sx.minH22px, sx.shrink0, sx.itemsCenter, sx.whitespaceNowrap, sx.roundedMd, sx.px2, typography.label, sx.fontSemibold, sx.disabledCursorDefault, sx.disabledOpacity60);
const GIT_ACTION_NEUTRAL =
	mergeStylexClassName("data-[popup-open]:bg-active data-[popup-open]:text-fg", sx.enabledHoverBgActive, sx.enabledHoverTextFg, sx.bgControl, sx.textDim);
export const GIT_ACTION = [GIT_ACTION_BOX, GIT_ACTION_NEUTRAL].filter(Boolean).join(" ");
/** What the plate adds when the action opens a menu rather than doing the
 *  thing: one trailing chevron, on the Button primitive's caret terms. That is
 *  14px beside a 12px label, `gap-1`, and 4px shaved off the caret's side so
 *  the glyph's own whitespace doesn't push the pair off balance. */
const GIT_ACTION_MENU_BOX = mergeStylexClassName("", sx.gap1, sx.pr1);

/** The tone names a Review row's status band uses (WorkspaceInfo's
 *  `REVIEW_ROW_BG`). A structurally identical union, so a row can pass its own
 *  tone straight in. */
export type RowActionTone = "green" | "yellow" | "red" | "blue" | "muted";

/** The row's action, in the row's own colour. The action a Review row offers
 *  is that row's next step — "Fix" belongs to the red reading, "Change" to the
 *  yellow request — so it takes the band's hue rather than sitting on it as a
 *  neutral plate and reading as unrelated chrome. The same soft fill the PR
 *  chips use (the tone mixed into the control surface at 24%), which keeps it
 *  one weight over the band it sits on.
 *
 *  That fill puts the 12px label at ~3.1:1 against its own plate, the same
 *  place the toned PR chips already sit. The row does not lean on it: the
 *  state is spelled out in words beside it, and the label is only the verb.
 *
 *  Each entry carries its whole colour set, resting and hover, because two
 *  colour utilities on one element resolve by Tailwind's output order rather
 *  than the order they are written — and each is spelled out rather than built
 *  from the token name, because Tailwind only compiles class names it can find
 *  in the source. `muted` keeps the neutral plate: a row with nothing to
 *  report has no colour to lend. */
const GIT_ACTION_TONE: Record<RowActionTone, string> = {
	muted: GIT_ACTION_NEUTRAL,
	green:
		mergeStylexClassName("data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]", sx.bgColorMixInSrgbVarGreen24VarControlSurface, sx.enabledHoverBgColorMixInSrgbCurrentColor34VarControlSurface, sx.textGreen),
	yellow:
		mergeStylexClassName("data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]", sx.bgColorMixInSrgbVarYellow24VarControlSurface, sx.enabledHoverBgColorMixInSrgbCurrentColor34VarControlSurface, sx.textYellow),
	red:
		mergeStylexClassName("data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]", sx.bgColorMixInSrgbVarRed24VarControlSurface, sx.enabledHoverBgColorMixInSrgbCurrentColor34VarControlSurface, sx.textRed),
	blue:
		mergeStylexClassName("data-[popup-open]:bg-[color-mix(in_srgb,currentColor_34%,var(--control-surface))]", sx.bgColorMixInSrgbVarBlue24VarControlSurface, sx.enabledHoverBgColorMixInSrgbCurrentColor34VarControlSurface, sx.textBlue),
};

export function gitActionClass(tone: RowActionTone, menu = false): string {
	return [GIT_ACTION_BOX, GIT_ACTION_TONE[tone], menu ? ` ${GIT_ACTION_MENU_BOX}` : ""].filter(Boolean).join(" ");
}
export const GIT_ACTION_CARET = mergeStylexClassName("", sx.shrink0, sx.opacity55);
/** Follow-up line under the rows. Carries no colour: the caller adds
 *  `text-faint` ("Asked … ✓") or `text-red` (an error), because two colour
 *  utilities on one element resolve by Tailwind output order, not by the
 *  order they are written. */
export const GIT_NOTE = mergeStylexClassName("", sx.pt05, sx.pb15, sx.pl5, typography.meta);

/** Ink for a check's mark and its rollup count. Replaces `${checkClass(…)}-text`,
 *  which was built from the rank string at render time. `check-neutral` had no
 *  rule of its own and keeps inheriting the row's colour. */
/** pr-status-derive.ts keeps its rank union private; read it off the function. */
type CheckRank = ReturnType<typeof checkClass>;

export const CHECK_TEXT: Record<CheckRank, string> = {
	"check-success": mergeStylexClassName("", sx.textGreen),
	"check-failure": mergeStylexClassName("", sx.textRed),
	"check-pending": mergeStylexClassName("", sx.textYellow),
	"check-neutral": "",
};

/* ── PR status strip ─────────────────────────────────────────────────────
 *
 * The strip (PrStatusBar) and the series rows under it (PrSeriesRows) are one
 * subtree rendered from two components, so their vocabulary lives here rather
 * than in either file.
 *
 * Two ancestors reach into the strip from SessionViewer — the phone bottom
 * sheet (`.viewer-panel`) and the info page's status card
 * (`.session-info-status`). Those classes belong to a component this family
 * doesn't own, so their overrides stay selectors, as arbitrary variants on the
 * strip itself, instead of becoming props on a component two callers away.
 */

/** The strip: one row of status atop the workspace panel. It is a plate rather
 *  than a band — the panel wraps it in PANEL_PR_PLATE (lib/session-panel-classes),
 *  which supplies the inset, the corner and the clip, so the strip carries no
 *  edge of its own there. The one place it still draws a border is the phone
 *  info card, where consecutive strips are rows of one card.
 *
 *  The markup also keeps the bare `pr-bar` class, and the checking line keeps
 *  `pr-bar-checking`. Neither styles anything any more — they are hooks for the
 *  reduced-motion block in base.css, which kills every animation with
 *  !important and then hands a few liveness signals back. A utility cannot win
 *  against !important, so dropping the hook would silently freeze the
 *  "Checking status…" pulse for anyone on reduced motion. Same reason
 *  `.markdown` stays on the description. Where the strip tops a pane it also
 *  wears `wco-chrome`, which is what makes a row draggable in the desktop
 *  shell. */
export const PR_BAR =
	// A container, so the actions can drop their labels when the panel is
	// dragged narrow. The panel is resizable, so its width is not a function of
	// the viewport and `phone:` cannot see it: at ~465px the headline — the one
	// thing the strip is for — was the part that got squeezed out.
	mergeStylexClassName("", sx.Container, sx.flex, sx.minHVarDesktopHeaderH, sx.itemsCenter, sx.gap25, sx.px3, sx.py2) +
	// The globe (staging) icon rides inside the strip, flush to its padding.
	" " + "[&>.staging-icon]:-ml-0.5 [&>.staging-icon]:shrink-0 " +
	// Phone: a row of the bottom sheet, and a row of the info card.
	"phone:[.viewer-panel_&]:min-h-[50px] phone:[.viewer-panel_&]:px-3.5 " +
	"phone:[.session-info-status_&]:min-h-[46px] phone:[.session-info-status_&]:px-2.5 " +
	// In the info card the strips stack as rows of one card, so there the seam
	// is a rule. Keyed on the card alone rather than on `phone:` as well: the
	// card only ever renders on a phone, and `phone:` is `width < 720px` while
	// the page that draws it means `<= 720px`, so pinning the divider to the
	// breakpoint would drop it at exactly 720.
	"[.session-info-status_&]:border-b [.session-info-status_&]:border-divider " +
	"[.session-info-status_&]:last:border-b-0";

/** Inside the info card the strip (or the stack of strips) is the card's
 *  content, so it takes the card's corner and clips to it. */
export const PR_BAR_IN_CARD =
	"phone:[.session-info-status>&]:overflow-hidden";

/** The strip's tone band. Purple and yellow had no soft token and were frozen
 *  as dark-theme rgba() literals, so both themes got the dark hue; mixing from
 *  the token re-themes them. */
export const PR_BAR_BG: Record<PrTone, string> = {
	green: mergeStylexClassName("", sx.bgGreenSoft),
	purple: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarPurple10Transparent),
	red: mergeStylexClassName("", sx.bgRedSoft),
	yellow: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarYellow9Transparent),
	// The plate fill its neighbours in the panel wear (`--bg-panel` is
	// re-pointed to `--panel-plate` inside the column), so a strip with nothing
	// to report sits in the same family as the sections under it rather than
	// reading as a white band cut across the top. The info card supplies its
	// own surface, so there the strip stays transparent.
	muted: mergeStylexClassName("[.session-info-status_&]:bg-transparent", sx.bgPanel),
};

/** The same band in the workspace summary card, where it plates the PR rows
 *  rather than spanning a pane. Two departures from the strip's map above.
 *  `muted` carries no fill: the card is quiet text on one surface, and a state
 *  with nothing to report has no colour to lend, so it gets no plate. Green and
 *  red drop to a lighter mix than `--*-soft` because the card sits on the
 *  popup's own raised surface, where the strip's weight reads as a highlight
 *  band instead of a tint. */
export const PR_SUMMARY_BAND_BG: Record<PrTone, string> = {
	green: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarGreen11Transparent),
	purple: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarPurple10Transparent),
	red: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarRed11Transparent),
	yellow: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarYellow10Transparent),
	muted: "",
};

/** A session that shipped one feature as several PRs: the primary strip plus a
 *  row per sibling, as one continuous block of status. */
export const PR_BAR_STACK = [mergeStylexClassName("", sx.flex, sx.minW0, sx.flexCol), PR_BAR_IN_CARD].filter(Boolean).join(" ");

/** First-load placeholder ("Checking status…") so the strip holds its place
 *  instead of popping in once /pr and /git-status resolve. */
export const PR_BAR_CHECKING =
	mergeStylexClassName("", typography.label, sx.fontSemibold, sx.textDim, sx.animatePulse16sEaseInOutInfinite);

/** The headline — the one derived line the strip is for. */
export const PR_BAR_STATE =
	mergeStylexClassName("", sx.cursorPointer, sx.overflowHidden, sx.textEllipsis, sx.whitespaceNowrap, typography.label, sx.fontSemibold, sx.hoverUnderline);

/** Ink for the headline and for a series row's state. */
export const PR_STATE_TEXT: Record<PrTone, string> = {
	green: mergeStylexClassName("", sx.textGreen),
	purple: mergeStylexClassName("", sx.textPurple),
	red: mergeStylexClassName("", sx.textRed),
	yellow: mergeStylexClassName("", sx.textYellow),
	muted: mergeStylexClassName("", sx.textDim),
};

/** The same headline inside the strip, where the state is already carried by
 *  the band behind it, the chip and the action. A settled reading keeps the
 *  panel's own ink instead of repeating it a fourth time: "Ready to merge" in
 *  green, on green, beside a green chip and a green Merge button was a whole
 *  row of one colour. A state that wants the reader — a conflict, a failing
 *  check — keeps the tone in the words as well, because that is the one the
 *  eye should be caught by. */
export const PR_BAR_STATE_TEXT: Record<PrTone, string> = {
	...PR_STATE_TEXT,
	green: mergeStylexClassName("", sx.textFg),
	purple: mergeStylexClassName("", sx.textFg),
};

export const PR_BAR_ERROR = mergeStylexClassName("", sx.maxW180px, sx.truncate, typography.meta, sx.textRed);

/** Compact chip + primary action in the session header, shown while the
 *  workspace panel is closed. */
export const PR_HEAD =
	mergeStylexClassName("[.viewer-header-actions_&]:mx-1.5", sx.flex, sx.minW0, sx.itemsCenter, sx.gap2);
/** The header's error/prompted lines are tighter than the strip's — the header
 *  has a title to leave room for. */
export const PR_HEAD_ERROR = mergeStylexClassName("", sx.maxW120px, sx.truncate, typography.meta, sx.textRed);
/** Sized to the header chip so the pair reads as one control. */
export const PR_HEAD_BTN = mergeStylexClassName("", sx.minH32px, sx.px11px);

/** Where a PR chip is rendered. `bar`/`head` are the primary chip (half of the
 *  split button, hence the squared end); `sib` is a sibling chip in the header,
 *  `row` a sibling chip inside a series row, `card` the one a hover card ends
 *  on. */
type ChipSize = "bar" | "head" | "sib" | "row" | "card";

const CHIP_BASE =
	mergeStylexClassName("", sx.inlineFlex, sx.itemsCenter, sx.gap05, sx.whitespaceNowrap, sx.border, sx.fontSemibold, sx.tabularNums, sx.noUnderline, sx.transitionBackgroundColor);

const CHIP_SIZE: Record<ChipSize, string> = {
	bar: mergeStylexClassName("", sx.minH30px, sx.cursorPointer, sx.roundedSControl, sx.roundedENone, sx.px25, typography.label),
	head: mergeStylexClassName("", sx.minH32px, sx.cursorPointer, sx.roundedSControl, sx.roundedENone, sx.px11px, typography.label),
	// A sibling chip in the header was authored as a smaller pill, but the
	// header's own `.pr-head .pr-num-chip` override sat later in the stylesheet
	// and won the tie, so what ships is the primary chip's size minus its
	// shadow. Kept as it ships; making it genuinely smaller is a visual change,
	// not a migration.
	sib: mergeStylexClassName("", sx.minH32px, sx.cursorPointer, sx.roundedControl, sx.px11px, typography.label),
	// Inert markup inside the row button — the whole row is the target.
	row: mergeStylexClassName("", sx.minH22px, sx.cursorInherit, sx.roundedMd, sx.px7px, typography.label),
	// A hover card's footer. Sized and rounded to the action that can sit
	// beside it, which is a <Button size="sm">: 26px, and `rounded-control`
	// like every size in that scale, which goes pill on a box this short.
	card: mergeStylexClassName("", sx.minH26px, sx.shrink0, sx.cursorPointer, sx.roundedControl, sx.px2, typography.label),
};

/** Toned chips take a soft tinted fill rather than the neutral control
 *  surface, so a green "Ready to merge" chip sits as a green pill on the green
 *  strip. Each entry carries its whole colour set — ink, edge, fill and hover
 *  — because two colour utilities on one element resolve by Tailwind's output
 *  order, not by the order they are written. */
const CHIP_TONE: Record<PrTone, string> = {
	muted:
		mergeStylexClassName("", sx.hoverBgColorMixInSrgbCurrentColor12Transparent, sx.activeBgColorMixInSrgbCurrentColor18Transparent, sx.borderLine, sx.bgControl, sx.textDim),
	green:
		mergeStylexClassName("", sx.borderColorMixInSrgbVarGreen22Transparent, sx.bgColorMixInSrgbVarGreen24VarControlSurface, sx.hoverBgColorMixInSrgbCurrentColor32VarControlSurface, sx.textGreen),
	purple:
		mergeStylexClassName("", sx.borderColorMixInSrgbVarPurple22Transparent, sx.bgColorMixInSrgbVarPurple24VarControlSurface, sx.hoverBgColorMixInSrgbCurrentColor32VarControlSurface, sx.textPurple),
	red: mergeStylexClassName("", sx.borderColorMixInSrgbVarRed22Transparent, sx.bgColorMixInSrgbVarRed24VarControlSurface, sx.hoverBgColorMixInSrgbCurrentColor32VarControlSurface, sx.textRed),
	yellow:
		mergeStylexClassName("", sx.borderColorMixInSrgbVarYellow22Transparent, sx.bgColorMixInSrgbVarYellow24VarControlSurface, sx.hoverBgColorMixInSrgbCurrentColor32VarControlSurface, sx.textYellow),
};

/** The same chip on a plain row: the primary chip fills with its tone because
 *  it sits on a matching band, and on a bare row that fill reads as a badge and
 *  out-shouts the strip. Toned ink and edge, no fill, no hover — the state on
 *  the right is where the colour carries. */
const CHIP_TONE_FLAT: Record<PrTone, string> = {
	muted: mergeStylexClassName("", sx.borderLine, sx.bgControl, sx.textDim),
	green: mergeStylexClassName("", sx.borderColorMixInSrgbVarGreen22Transparent, sx.bgControl, sx.textGreen),
	purple:
		mergeStylexClassName("", sx.borderColorMixInSrgbVarPurple22Transparent, sx.bgControl, sx.textPurple),
	red: mergeStylexClassName("", sx.borderColorMixInSrgbVarRed22Transparent, sx.bgControl, sx.textRed),
	yellow:
		mergeStylexClassName("", sx.borderColorMixInSrgbVarYellow22Transparent, sx.bgControl, sx.textYellow),
};

export function prChipClass(tone: PrTone, size: ChipSize): string {
	// A card's chip goes flat for the same reason a row's does: it sits on the
	// popup's own surface rather than on a band already in its colour, and a
	// tinted fill there reads as a badge beside the card's one real action.
	const flat = size === "row" || size === "card";
	// Only the neutral chip keeps the control shadow: a toned pill is already
	// separated from the strip by its fill, and a sibling chip is too small to
	// carry one.
	const shadow = tone === "muted" && (size === "bar" || size === "head");
	// Unlike a row's chip, a card's is the link itself, so it answers the
	// pointer. Mixed from its own ink so a green chip washes green.
	const hover =
		size === "card"
			? mergeStylexClassName("", sharedClassStyles.hoverBgColorMixInSrgbCurrentColor12Transparent, sharedClassStyles.activeBgColorMixInSrgbCurrentColor18Transparent)
			: "";
	return [CHIP_BASE, CHIP_SIZE[size], flat ? CHIP_TONE_FLAT[tone] : CHIP_TONE[tone], shadow ? " smooth-shadow-sm" : "", hover].filter(Boolean).join(" ");
}

/** The phone top bar's PR chip.
 *
 *  Phones get no workspace panel and no status strip, so this is the only
 *  place a session's PR state is shown: the number in the PR's own colour,
 *  in the bar's right slot. Same toned pill as a sibling chip in the header,
 *  resized to the 44px touch height and given the same shadow as every other
 *  control in that bar. Both ends are its own because it is one target rather
 *  than half of a split button. */
export function prPhoneChipClass(tone: PrTone): string {
	return [CHIP_BASE, CHIP_TONE[tone], mergeStylexClassName("", sx.minH11, sx.shrink0, sx.cursorPointer, sx.roundedFull, sx.px25, typography.label, sx.shadowVarMobileHeaderControlShadow)].filter(Boolean).join(" ");
}

/** The outbound half of the split button: same tone, square inner corner, and
 *  it presses rather than washes. */
export function prChipExternalClass(tone: PrTone, size: "bar" | "head"): string {
	const geometry =
		// -ml-px collapses the shared seam to a single hairline.
		mergeStylexClassName("", sx.transitionBackgroundColorScale, sx.MlPx, sx.inlineFlex, sx.itemsCenter, sx.justifyCenter, sx.roundedEControl, sx.roundedSNone, sx.border, sx.noUnderline, sx.activeScale096);
	const colour =
		tone === "muted"
			? // No ink of its own: the neutral half is an <a>, so its arrow takes
				// the link colour, and the hover wash mixes from it.
				mergeStylexClassName("smooth-shadow-sm", sx.hoverBgColorMixInSrgbCurrentColor12Transparent, sx.borderLine, sx.bgControl)
			: CHIP_TONE[tone];
	return [geometry, size === "head" ? mergeStylexClassName("", sx.size32px) : mergeStylexClassName("", sx.size30px), colour].filter(Boolean).join(" ");
}

/** The stack chip — `position/size` with the layers glyph, sitting left of the
 *  PR chip. A pill rather than half of a split button: it opens one popup, so
 *  both of its ends are its own. Sized to whichever strip it rides in, and it
 *  runs tighter than a PR chip because the glyph already fills its left. */
export function prStackChipClass(tone: PrTone, size: "bar" | "head"): string {
	const box =
		size === "head"
			? mergeStylexClassName("", sx.minH32px, sx.pr9px, sx.pl5px)
			: mergeStylexClassName("", sx.minH30px, sx.pr2, sx.pl1);
	return [CHIP_BASE, box, mergeStylexClassName("", sx.cursorPointer, sx.roundedControl, typography.label), CHIP_TONE[tone]].filter(Boolean).join(" ");
}

/** The split button's two halves lift over each other on hover/focus so the
 *  shared seam doesn't clip the active one's edge. */
export const PR_CHIP_SEAM =
	mergeStylexClassName("", sx.hoverRelative, sx.hoverZ1, sx.focusVisibleRelative, sx.focusVisibleZ1);

/** Sibling PRs in the header's overflow menu: a dot in each PR's own tone. */
export const PR_SIB_DOT = mergeStylexClassName("", sx.size7px, sx.shrink0, sx.roundedFull);
export const PR_SIB_DOT_BG: Record<PrTone, string> = {
	green: mergeStylexClassName("", sx.bgGreen),
	purple: mergeStylexClassName("", sx.bgPurple),
	red: mergeStylexClassName("", sx.bgRed),
	yellow: mergeStylexClassName("", sx.bgYellow),
	muted: mergeStylexClassName("", sx.bgDim),
};

/** A series row: repo · number · title · state. It repeats the primary row one
 * weight down and paints the whole row in its own state colour. */
export const PR_ROW =
	mergeStylexClassName("", sx.flex, sx.minH38px, sx.itemsCenter, sx.gap05, sx.borderT, sx.borderDivider, sx.pr2, sx.hoverBrightness108);
export const PR_ROW_BG: Record<PrTone, string> = {
	green: mergeStylexClassName("", sx.bgGreenSoft),
	purple: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarPurple10Transparent),
	red: mergeStylexClassName("", sx.bgRedSoft),
	yellow: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarYellow9Transparent),
	muted: mergeStylexClassName("", sx.bgPanel),
};
export const PR_ROW_MAIN =
	mergeStylexClassName("", sx.flex, sx.minW0, sx.flex1, sx.cursorPointer, sx.itemsCenter, sx.gap2, sx.px3, sx.py1, sx.textLeft, typography.label);
/** The title takes what's left and gives it up first — the state on the right
 *  is the part you scan for. */
export const PR_ROW_TITLE = mergeStylexClassName("", sx.minW0, sx.truncate, sx.textDim);
export const PR_ROW_STATE =
	mergeStylexClassName("", sx.mlAuto, sx.shrink0, sx.whitespaceNowrap, typography.label, sx.fontSemibold);
/* ── Per-repo tabs (a multi-repo session's PR panel) ─────────────────────
 *
 * Selected and unselected each carry their whole colour set. Layering the
 * selected one over a default would leave two border-color utilities on one
 * element, and which wins is Tailwind's output order rather than the order
 * they are written. Phone keeps the bigger tap target it already had.
 */
export const PR_REPO_TABS =
	mergeStylexClassName("", sx.flex, sx.gap1, sx.overflowXAuto, sx.borderB, sx.borderDivider, sx.px3, sx.py2);
/* The row inside ReviewToolbar when a branch has no pull request yet. Desktop
 * gets its edge from the shared floating toolbar; phone keeps the divider used
 * by its edge-to-edge review chrome. */
export const PR_NO_PR_BAR =
	mergeStylexClassName("[&>*]:shrink-0 [&::-webkit-scrollbar]:hidden", sx.flex, sx.shrink0, sx.itemsCenter, sx.gap2, sx.overflowXAuto, sx.px3, sx.py2, sx.whitespaceNowrap, sx.ScrollbarWidthNone, sx.phoneBorderB, sx.phoneBorderDivider);
const PR_REPO_TAB =
	mergeStylexClassName("", sx.inlineFlex, sx.cursorPointer, sx.itemsCenter, sx.gap15, sx.whitespaceNowrap, sx.roundedMd, sx.border, sx.px25, sx.py3px, typography.label, sx.phonePx3, sx.phonePy2);
export const prRepoTabClass = (selected: boolean) =>
	[PR_REPO_TAB, selected ? mergeStylexClassName("", sx.borderLine, sx.bgPanel, sx.textFg) : mergeStylexClassName("", sx.borderTransparent, sx.bgTransparent, sx.textDim, sx.hoverTextFg)].filter(Boolean).join(" ");
/** Unlink (×) inside the selected linked-PR tab. */
export const PR_REPO_TAB_X = mergeStylexClassName("", sx.Mr1, sx.inlineFlex, sx.itemsCenter, sx.textDim, sx.hoverTextFg);

export const PR_ROW_OUT =
	mergeStylexClassName("", sx.hoverBgColorMixInSrgbCurrentColor14Transparent, sx.inlineFlex, sx.size6, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.textDim, sx.hoverTextFg);
