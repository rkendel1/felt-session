import { MOBILE_CONTROL_GLASS_EFFECTS } from "./app-header-classes";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";
import { motionStyles } from "../styles/animations.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

const sx = stylex.create({
	roundedCalc8pxVarRf: {
		"borderRadius": "calc(8px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	desktopRoundedMd: {
		"@media (min-width: 721px)": {
			"borderRadius": "calc(7px * var(--rf))"
		}
	},
	desktopCornerShapeSquircle: {
		"@media (min-width: 721px)": {
			"cornerShape": "squircle"
		}
	},
	relative: {
		"position": "relative"
	},
	flex: {
		"display": "flex"
	},
	minW0: {
		"minWidth": "0"
	},
	shrink0: {
		"flexShrink": "0"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap3px: {
		"gap": "3px"
	},
	px2: {
		"paddingInline": "8px"
	},
	desktopBgSurface: {
		"@media (min-width: 721px)": {
			"backgroundColor": "var(--bg)"
		}
	},
	phoneBgTransparent: {
		"@media (max-width: 720px)": {
			"backgroundColor": "transparent"
		}
	},
	phonePointerEventsNone: {
		"@media (max-width: 720px)": {
			"pointerEvents": "none"
		}
	},
	desktopAfterPointerEventsNone: {
		"@media (min-width: 721px)": {
			"::after": {
				"content": "var(--tw-content)",
				"pointerEvents": "none"
			}
		}
	},
	desktopAfterAbsolute: {
		"@media (min-width: 721px)": {
			"::after": {
				"content": "var(--tw-content)",
				"position": "absolute"
			}
		}
	},
	desktopAfterInsetX0: {
		"@media (min-width: 721px)": {
			"::after": {
				"content": "var(--tw-content)",
				"insetInline": "0"
			}
		}
	},
	desktopAfterBottom0: {
		"@media (min-width: 721px)": {
			"::after": {
				"content": "var(--tw-content)",
				"bottom": "0"
			}
		}
	},
	desktopAfterHPx: {
		"@media (min-width: 721px)": {
			"::after": {
				"content": "var(--tw-content)",
				"height": "1px"
			}
		}
	},
	desktopAfterBgDivider: {
		"@media (min-width: 721px)": {
			"::after": {
				"content": "var(--tw-content)",
				"backgroundColor": "var(--divider)"
			}
		}
	},
	desktopAfterContent: {
		"@media (min-width: 721px)": {
			"::after": {
				"--tw-content": "\"\"",
				"content": "var(--tw-content)"
			}
		}
	},
	desktopH10: {
		"@media (min-width: 721px)": {
			"height": "40px"
		}
	},
	desktopPy0: {
		"@media (min-width: 721px)": {
			"paddingBlock": "0"
		}
	},
	phoneAbsolute: {
		"@media (max-width: 720px)": {
			"position": "absolute"
		}
	},
	phoneInsetX0: {
		"@media (max-width: 720px)": {
			"insetInline": "0"
		}
	},
	phoneTopVarPaneHeaderH: {
		"@media (max-width: 720px)": {
			"top": "var(--pane-header-h)"
		}
	},
	phoneZ6: {
		"@media (max-width: 720px)": {
			"zIndex": "6"
		}
	},
	phoneM0: {
		"@media (max-width: 720px)": {
			"margin": "0"
		}
	},
	phonePy5px: {
		"@media (max-width: 720px)": {
			"paddingBlock": "5px"
		}
	},
	phoneTransitionTransformVarDurLgVarEase: {
		"@media (max-width: 720px)": {
			"transition": "transform var(--dur-lg) var(--ease)"
		}
	},
	flex11Auto: {
		"flex": "auto"
	},
	overflowXAuto: {
		"overflowX": "auto"
	},
	overscrollXContain: {
		"overscrollBehaviorX": "contain"
	},
	ScrollbarWidthNone: {
		"scrollbarWidth": "none"
	},
	desktopFlex01Auto: {
		"@media (min-width: 721px)": {
			"flex": "0 auto"
		}
	},
	inlineFlex: {
		"display": "inline-flex"
	},
	flexNone: {
		"flex": "none"
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
	afterTop12: {
		"::after": {
			"content": "var(--tw-content)",
			"top": "50%"
		}
	},
	afterRight05: {
		"::after": {
			"content": "var(--tw-content)",
			"right": "-2px"
		}
	},
	afterH3: {
		"::after": {
			"content": "var(--tw-content)",
			"height": "12px"
		}
	},
	afterWPx: {
		"::after": {
			"content": "var(--tw-content)",
			"width": "1px"
		}
	},
	afterTranslateY12: {
		"::after": {
			"content": "var(--tw-content)",
			"--tw-translate-y": "calc(calc(1 / 2 * 100%) * -1)",
			"translate": "var(--tw-translate-x) var(--tw-translate-y)"
		}
	},
	afterBgDivider: {
		"::after": {
			"content": "var(--tw-content)",
			"backgroundColor": "var(--divider)"
		}
	},
	afterContent: {
		"::after": {
			"--tw-content": "\"\"",
			"content": "var(--tw-content)"
		}
	},
	phoneAfterHidden: {
		"@media (max-width: 720px)": {
			"::after": {
				"content": "var(--tw-content)",
				"display": "none"
			}
		}
	},
	pointerEventsNone: {
		"pointerEvents": "none"
	},
	absolute: {
		"position": "absolute"
	},
	insetY2: {
		"insetBlock": "8px"
	},
	z5: {
		"zIndex": "5"
	},
	AnimationTabDropSlotInVarDurMicroVarEase: {
		"animation": "tab-drop-slot-in var(--dur-micro) var(--ease)"
	},
	TransitionLeftVarDurVarEase: {
		"transition": "left var(--dur) var(--ease)"
	},
	motionReduceAnimateNone: {
		"@media (prefers-reduced-motion: reduce)": {
			"animation": "none"
		}
	},
	motionReduceTransitionNone: {
		"@media (prefers-reduced-motion: reduce)": {
			"transitionProperty": "none"
		}
	},
	afterInsetY0: {
		"::after": {
			"content": "var(--tw-content)",
			"insetBlock": "0"
		}
	},
	afterLeft0: {
		"::after": {
			"content": "var(--tw-content)",
			"left": "0"
		}
	},
	afterW05: {
		"::after": {
			"content": "var(--tw-content)",
			"width": "2px"
		}
	},
	afterRounded1px: {
		"::after": {
			"content": "var(--tw-content)",
			"borderRadius": "1px"
		}
	},
	afterBgAccent: {
		"::after": {
			"content": "var(--tw-content)",
			"backgroundColor": "var(--accent)"
		}
	},
	mlAuto: {
		"marginLeft": "auto"
	},
	maxW200px: {
		"maxWidth": "200px"
	},
	maxWMin200px100cqw: {
		maxWidth: "min(200px, 100cqw)",
	},
	containerTypeInlineSize: {
		containerType: "inline-size",
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	gap15: {
		"gap": "6px"
	},
	whitespaceNowrap: {
		"whiteSpace": "nowrap"
	},
	phoneRoundedFull: {
		"@media (max-width: 720px)": {
			"borderRadius": "3.40282e38px"
		}
	},
	phoneBorder: {
		"@media (max-width: 720px)": {
			"borderStyle": "var(--tw-border-style)",
			"borderWidth": "1px"
		}
	},
	phoneBorderColorVarMobileHeaderControlBorder: {
		"@media (max-width: 720px)": {
			"borderColor": "var(--mobile-header-control-border)"
		}
	},
	textFg: {
		"color": "var(--text)"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	bgPanel: {
		"backgroundColor": "var(--bg-panel)"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	phoneBgVarMobileTabSurfaceSelected: {
		"@media (max-width: 720px)": {
			"backgroundColor": "var(--mobile-tab-surface-selected)"
		}
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	phoneBgVarMobileTabSurface: {
		"@media (max-width: 720px)": {
			"backgroundColor": "var(--mobile-tab-surface)"
		}
	},
	block: {
		"display": "block"
	},
	maxW150px: {
		"maxWidth": "150px"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	desktopMaxW166px: {
		"@media (min-width: 721px)": {
			"maxWidth": "166px"
		}
	},
	justifyCenter: {
		"justifyContent": "center"
	},
	leadingNone: {
		"--tw-leading": "1",
		"lineHeight": "1"
	},
	MediaHoverHoverAndPointerFineTransitionTransform: {
		"@media (hover: hover) and (pointer: fine)": {
			"transitionProperty": "transform,translate,scale,rotate",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
	gap05: {
		"gap": "2px"
	},
	my1px: {
		"marginBlock": "-1px"
	},
	roundedXs: {
		"borderRadius": "calc(2px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	borderAccent: {
		"borderColor": "var(--accent)"
	},
	bgSurface: {
		"backgroundColor": "var(--bg)"
	},
	px3px: {
		"paddingInline": "3px"
	},
	fontInherit: {
		"fontFamily": "inherit"
	},
	textInherit: {
		"color": "inherit"
	},
	outlineNone: {
		"--tw-outline-style": "none",
		"outlineStyle": "none"
	},
	size15: {
		"width": "6px",
		"height": "6px"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	,
		cornerShape: "round"},
	motionReduceAnimationDuration12s: {
		"@media (prefers-reduced-motion: reduce)": {
			"animationDuration": "1.2s"
		}
	},
	motionReduceAnimationIterationCountInfinite: {
		"@media (prefers-reduced-motion: reduce)": {
			"animationIterationCount": "infinite"
		}
	},
	motionReduceAnimationDuration14s: {
		"@media (prefers-reduced-motion: reduce)": {
			"animationDuration": "1.4s"
		}
	},
	size7px: {
		"width": "7px",
		"height": "7px"
	},
	bgGreen: {
		"backgroundColor": "var(--green)"
	},
	bgPurple: {
		"backgroundColor": "var(--purple)"
	},
	bgRed: {
		"backgroundColor": "var(--red)"
	},
	bgYellow: {
		"backgroundColor": "var(--yellow)"
	},
	My05: {
		"marginBlock": "-2px"
	},
	Mr3px: {
		"marginRight": "-3px"
	},
	size4: {
		"width": "16px",
		"height": "16px"
	},
	roundedSm: {
		"borderRadius": "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border0: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "0"
	},
	p0: {
		"padding": "0"
	},
	hoverBgPressed: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover-strong)"
			}
		}
	},
	MediaHoverNoneSize26px: {
		"@media (hover: none)": {
			"width": "26px",
			"height": "26px"
		}
	},
	MediaHoverNoneMr1: {
		"@media (hover: none)": {
			"marginRight": "-4px"
		}
	},
	MediaHoverHoverAndPointerFineAbsolute: {
		"@media (hover: hover) and (pointer: fine)": {
			"position": "absolute"
		}
	},
	MediaHoverHoverAndPointerFineRight1: {
		"@media (hover: hover) and (pointer: fine)": {
			"right": "4px"
		}
	},
	MediaHoverHoverAndPointerFineTop12: {
		"@media (hover: hover) and (pointer: fine)": {
			"top": "50%"
		}
	},
	MediaHoverHoverAndPointerFineZ1: {
		"@media (hover: hover) and (pointer: fine)": {
			"zIndex": "1"
		}
	},
	MediaHoverHoverAndPointerFineM0: {
		"@media (hover: hover) and (pointer: fine)": {
			"margin": "0"
		}
	},
	MediaHoverHoverAndPointerFineTranslateY12: {
		"@media (hover: hover) and (pointer: fine)": {
			"--tw-translate-y": "calc(calc(1 / 2 * 100%) * -1)",
			"translate": "var(--tw-translate-x) var(--tw-translate-y)"
		}
	},
	MediaHoverHoverAndPointerFineTransitionOpacity: {
		"@media (hover: hover) and (pointer: fine)": {
			"transitionProperty": "opacity",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
	MediaHoverHoverAndPointerFinePointerEventsNone: {
		"@media (hover: hover) and (pointer: fine)": {
			"pointerEvents": "none"
		}
	},
	MediaHoverHoverAndPointerFineOpacity0: {
		"@media (hover: hover) and (pointer: fine)": {
			"opacity": "0"
		}
	},
	MediaHoverHoverAndPointerFineFocusVisiblePointerEventsAuto: {
		"@media (hover: hover) and (pointer: fine)": {
			":focusVisible": {
				"pointerEvents": "auto"
			}
		}
	},
	MediaHoverHoverAndPointerFineFocusVisibleOpacity100: {
		"@media (hover: hover) and (pointer: fine)": {
			":focusVisible": {
				"opacity": "1"
			}
		}
	},
	size26px: {
		"width": "26px",
		"height": "26px"
	},
	Mr1: {
		"marginRight": "-4px"
	},
	minH36px: {
		"minHeight": "36px"
	},
	desktopSize7: {
		"@media (min-width: 721px)": {
			"width": "28px",
			"height": "28px"
		}
	},
	desktopMinHAuto: {
		"@media (min-width: 721px)": {
			"minHeight": "auto"
		}
	},
	desktopSelfCenter: {
		"@media (min-width: 721px)": {
			"alignSelf": "center"
		}
	},
	desktopP0: {
		"@media (min-width: 721px)": {
			"padding": "0"
		}
	},
	size22px: {
		"width": "22px",
		"height": "22px"
	},
	transitionTransform: {
		"transitionProperty": "transform,translate,scale,rotate",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	hoverScale118: {
		"@media (hover: hover)": {
			":hover": {
				"scale": "1.18"
			}
		}
	},
	bgActive: {
		"backgroundColor": "var(--bg-active)"
	},
	afterInset3px: {
		"::after": {
			"content": "var(--tw-content)",
			"inset": "3px"
		}
	},
	afterRotate45: {
		"::after": {
			"content": "var(--tw-content)",
			"rotate": "45deg"
		}
	},
	afterBorderT: {
		"::after": {
			"content": "var(--tw-content)",
			"borderTopStyle": "var(--tw-border-style)",
			"borderTopWidth": "1px"
		}
	},
	afterBorderTFaint: {
		"::after": {
			"content": "var(--tw-content)",
			"borderTopColor": "var(--text-faint)"
		}
	},

	cursorGrabbing: {
		"cursor": "grabbing"
	},
	px25: {
		"paddingInline": "10px"
	},
	py15: {
		"paddingBlock": "6px"
	},
	shadowNone: {
		"--tw-shadow": "0 0 transparent",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	phoneShadowVarMobileHeaderControlShadow: {
		"@media (max-width: 720px)": {
			"--tw-shadow": "var(--mobile-header-control-shadow)",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
	bgBlue: {
		"backgroundColor": "var(--blue)"
	},
	shadow006pxVarBlue: {
		"--tw-shadow": "0 0 6px var(--tw-shadow-color,var(--blue))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	animatePulse12sEaseInOutInfinite: {
		"animation": "1.2s ease-in-out infinite pulse"
	},
	animatePulse14sEaseInOutInfinite: {
		"animation": "1.4s ease-in-out infinite pulse"
	},
	borderTransparent: {
		"borderColor": "transparent"
	},
	px35: {
		"paddingInline": "14px"
	},
	text15px: {
		"fontSize": "15px"
	},
	desktopText22px: {
		"@media (min-width: 721px)": {
			"fontSize": "22px"
		}
	},

	transitionBackgroundColorColor: {
		"transitionProperty": "background-color,color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	borderRgba255255255015: {
		"borderColor": "color-mix(in srgb, var(--color-white) 15%, transparent)"
	},
});

/**
 * The session tab strip's vocabulary, as finished utility classes. This used
 * to be the `session-tab*` family in legacy.css.
 *
 * Two things shape everything here.
 *
 * 1. Desktop keeps quiet labels separated by short rules. On the phone PWA,
 *    every tab uses the same glass capsule as the top bar, while the active tab
 *    keeps a stronger filled surface.
 *
 * 2. Each tab state carries its whole colour set. A colored tab does not layer
 *    a fill over the plain tab's fill; `tabClass` returns exactly one background
 *    per state. The states stay resolved in JS because the old cascade picked a
 *    winner by rule order, and a stack of utilities cannot reproduce that
 *    reliably.
 *
 * A few class names survive on the markup as bare hooks with no styling of
 * their own, because things OUTSIDE this file name them:
 *
 *   · `session-tabs`: app-shell-classes.ts suppresses the top bar's scroll
 *     divider while the strip overlaps that edge, and SessionSplit sizes the
 *     bar with `[&>.session-tabs]:shrink-0`;
 *   · `session-tab-view` / `session-tab-reorder`: `.app:has(.session-tab-view)
 *     .app-header-overlay` and `.detail-pane:has(.session-tab-reorder ~
 *     .session-tab-reorder)` set the phone header's fill and
 *     `--strip-clearance` on elements that belong to other components.
 *
 * The dots used to be a third pair of hooks, for base.css's reduced-motion
 * exception list; they now carry that exception themselves — see `tabDotClass`.
 */

/** 8px, the compact trailing controls' corner. Authored the way base.css
 * authors every corner; there is no 8px step in the radius scale. */
const PILL = mergeStylexClassName("", sx.roundedCalc8pxVarRf);
/** Desktop tabs use the standard medium squircle; phones become round pills. */
const TAB_SHAPE = mergeStylexClassName("", sx.desktopRoundedMd, sx.desktopCornerShapeSquircle);

/* ── The strip ──────────────────────────────────────────────────────────── */

/**
 * The bar itself. `group/strip` reveals history, which stays quiet until the
 * strip is pointed at. The new-tab + remains visible whenever the strip exists.
 *
 * The old rule painted a `linear-gradient(var(--topbar-bg), var(--bg))` here,
 * but BOTH breakpoints set `background: var(--bg)` over it, so the gradient
 * never reached a screen; the same is true of its 6px/8px padding. Neither is
 * carried over.
 */
export const TAB_STRIP =
	mergeStylexClassName("session-tabs group/strip", sx.relative, sx.flex, sx.minW0, sx.shrink0, sx.itemsCenter, sx.gap3px, sx.px2) + " " +
	mergeStylexClassName("", sx.desktopBgSurface, sx.phoneBgTransparent) + " " +
	mergeStylexClassName("phone:*:pointer-events-auto", sx.phonePointerEventsNone) +
	// Every desktop tab bar has one closing hairline. A pseudo-element avoids
	// changing its height. Phones stay borderless so fixed chrome never becomes
	// a grey rule across the screen.
	" " + mergeStylexClassName("", sx.desktopAfterPointerEventsNone, sx.desktopAfterAbsolute, sx.desktopAfterInsetX0) + " " +
	mergeStylexClassName("", sx.desktopAfterBottom0, sx.desktopAfterHPx, sx.desktopAfterBgDivider, sx.desktopAfterContent) +
	// Desktop: a compact band. The active tab's own surface supplies the
	// selection boundary, so the line closes the bar rather than underlining it.
	//
	// The non-split bar takes its 11px header overlap at the call site. The
	// session header above is a fixed 48px row whose title is centred in it, and
	// the tab labels are centred in this 40px band, so the two words sit far
	// apart while neither box looks generous. Neither row can be trimmed on its
	// own because the header's height lines it up with the sidebar's brand row.
	// The strip closes the distance by climbing into the header's slack. Split
	// bars start at the top of an overflow-clipped column, so their full box stays
	// in flow instead of losing its top edge outside that column.
	" " + mergeStylexClassName("", sx.desktopH10, sx.desktopPy0) +
	// When overflowing tabs pass under the pinned +, pointing at the control
	// softens enough of the edge to reach the adjacent label. TAB_SCROLL gates
	// the mask itself on data-overflow, so tabs that fit never fade.
	" " + "desktop:[&:has(.session-tab-new:hover)]:[--tabs-control-fade-end:64px] " +
	// Phone: pulled out of flow and pinned flush under the header's bottom edge,
	// so it reads as fixed chrome rather than a strip the transcript scrolls by.
	// The header's scroll-edge blur continues behind these glass controls.
	mergeStylexClassName("", sx.phoneAbsolute, sx.phoneInsetX0, sx.phoneTopVarPaneHeaderH, sx.phoneZ6) + " " +
	mergeStylexClassName("", sx.phoneM0, sx.phonePy5px) +
	// Immersive reading: SessionViewer sets body.chrome-collapsed from the
	// transcript's scroll direction and this secondary strip slides away while
	// the navigation bar remains pinned. `transform`, not the `translate`
	// property, because that is what the transition names.
	" " + mergeStylexClassName("", sx.phoneTransitionTransformVarDurLgVarEase) + " " +
	"phone:[body.chrome-collapsed_&]:[transform:translateY(calc(-100%_-_var(--pane-header-h)_-_8px))] " +
	// A lone session with no view tabs has nothing to switch between, so the
	// strip is pure chrome on a phone — every tab is a .session-tab-reorder
	// wrapper, so "2+ sessions" reads as two adjacent wrappers.
	"phone:[&:not(:has(.session-tab-view)):not(:has(.session-tab-reorder~.session-tab-reorder))]:hidden";

/**
 * The scrolling half of the strip. Its edge fades are driven by a CSS scroll
 * timeline — no scroll listeners, no re-renders — and are gated on the
 * `data-overflow` attribute the component writes, because a timeline that goes
 * INACTIVE holds its last value instead of reverting.
 */
export const TAB_SCROLL =
	// `flex-[1_1_auto]`, not `flex-1`: Tailwind's shorthand is `1 1 0%`, and a
	// zero basis sizes the scroll from nothing rather than from its tabs.
	// Only split strips become size containers: inline-size containment on the
	// intrinsic-width desktop strip would erase the tabs from its flex basis and
	// collapse the whole scroller. A split instead fills its available width so
	// TAB_BASE can safely use that definite query size.
	mergeStylexClassName("", sx.flex, sx.minW0, sx.flex11Auto, sx.itemsCenter, sx.gap3px, sx.overflowXAuto, sx.overscrollXContain) + " " +
	"data-[split]:[container-type:inline-size] data-[split]:desktop:flex-[1_1_auto] " +
	mergeStylexClassName("[&::-webkit-scrollbar]:hidden", sx.ScrollbarWidthNone) +
	// Hug the content on desktop so the pinned "+" sits right after the last tab
	// rather than being pushed to the far right. The group keeps its intrinsic
	// height so the selected tab floats vertically inside the 40px band.
	" " + mergeStylexClassName("", sx.desktopFlex01Auto) + " " +
	"supports-[animation-timeline:scroll()]:[animation:session-tabs-fade-start_1ms_both,session-tabs-fade-end_1ms_both] " +
	"supports-[animation-timeline:scroll()]:[animation-timeline:scroll(self_inline),scroll(self_inline)] " +
	"supports-[animation-timeline:scroll()]:[animation-range:0_24px,calc(100%_-_24px)_100%] " +
	"supports-[animation-timeline:scroll()]:data-[overflow]:[mask-image:linear-gradient(to_right,transparent_0,var(--color-black)_var(--tabs-fade-start),var(--color-black)_calc(100%_-_max(var(--tabs-fade-end),var(--tabs-control-fade-end,0px))),transparent_100%)]";

/**
 * The drag-to-reorder group wraps EVERY tab — sessions and view panes alike —
 * so a pane can be dragged in among the sessions. `flex-none` is load-bearing:
 * the tabs inside never shrink, so a group allowed to shrink would collapse
 * below its content and the last tab would paint over whatever the scroll laid
 * out after the shrunken box. Sizing to content pushes the overflow out to the
 * scroll, which is the thing that scrolls.
 */
export const TAB_GROUP = mergeStylexClassName("", sx.relative, sx.inlineFlex, sx.flexNone, sx.itemsCenter, sx.gap3px);

/** Each tab's Reorder.Item wrapper. `relative` lets whileDrag's z-index lift
 *  the dragged tab over its siblings. Desktop uses a short rule between quiet
 *  inactive tabs. Phone capsules separate themselves. */
export const TAB_ITEM =
	mergeStylexClassName("session-tab-reorder", sx.relative, sx.inlineFlex, sx.shrink0, sx.itemsCenter) + " " +
	mergeStylexClassName("", sx.afterPointerEventsNone, sx.afterAbsolute, sx.afterTop12) + " " +
	mergeStylexClassName("", sx.afterRight05, sx.afterH3, sx.afterWPx, sx.afterTranslateY12) + " " +
	mergeStylexClassName("last:after:hidden", sx.afterBgDivider, sx.afterContent, sx.phoneAfterHidden) +
	// The active surface supplies both edges. Hide the trailing divider when
	// either this item or its next sibling is active.
	" " + "[&:has(>[aria-selected=true])]:after:hidden data-[next-active]:after:hidden";

/** Picked up: an inactive desktop tab has no surface of its own and would smear
 *  over every label it passes. It lifts into an opaque chip while dragging. */
export const TAB_ITEM_DRAGGING =
	[TAB_SHAPE, mergeStylexClassName("smooth-shadow-ring-sm", sx.cursorGrabbing, sx.bgPanel)].filter(Boolean).join(" ");

/**
 * Where the dragged tab will land. Reorder already opens the gap live, but an
 * empty hole between two bare labels reads as nothing, so this paints a thin
 * insertion rule at the slot's leading edge — a caret, not a second chip
 * competing with the tab in hand. Above the dragged chip on purpose: the chip
 * follows the pointer while the slot snaps to whole positions, so a caret
 * painted underneath would vanish exactly when the order changes.
 */
export const TAB_DROP_SLOT =
	mergeStylexClassName("", sx.pointerEventsNone, sx.absolute, sx.insetY2, sx.z5) + " " +
	mergeStylexClassName("", sx.AnimationTabDropSlotInVarDurMicroVarEase, sx.TransitionLeftVarDurVarEase) + " " +
	mergeStylexClassName("", sx.motionReduceAnimateNone, sx.motionReduceTransitionNone) + " " +
	mergeStylexClassName("", sx.afterAbsolute, sx.afterInsetY0, sx.afterLeft0, sx.afterW05, sx.afterRounded1px, sx.afterBgAccent, sx.afterContent);

/** Trailing controls pinned after the scroll on desktop. */
export const TAB_ACTIONS = mergeStylexClassName("", sx.mlAuto, sx.flex, sx.flexNone, sx.itemsCenter, sx.gap3px);

/* ── A tab ──────────────────────────────────────────────────────────────── */

/**
 * Everything a tab is regardless of state: box, type and the interaction
 * transition. The label was 12px, which is not a step on the type scale; it is
 * interface copy, so it snaps UP to `text-label` (13px) — which is also what
 * the phone rule already set on the title, so the two viewports now agree
 * instead of differing by a pixel.
 */
const TAB_BASE =
	mergeStylexClassName("", sx.relative, sx.inlineFlex, sx.maxWMin200px100cqw, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.gap15, sx.whitespaceNowrap) +
	" " + [TAB_SHAPE, mergeStylexClassName("", sx.border0, sx.px25, sx.py15, typography.label, sx.shadowNone)].filter(Boolean).join(" ") +
	" " + mergeStylexClassName("", sharedClassStyles.transitionBackgroundColorColor) +
	" " + mergeStylexClassName("", sx.phoneRoundedFull, sx.phoneBorder, sx.phoneBorderColorVarMobileHeaderControlBorder) +
	" " + [mergeStylexClassName("", sx.phoneShadowVarMobileHeaderControlShadow), MOBILE_CONTROL_GLASS_EFFECTS].filter(Boolean).join(" ");

export type TabState = {
	active: boolean;
	waiting: boolean;
	/** A user-chosen swatch, supplied inline as `--tab-color`. */
	colored: boolean;
};

/**
 * The selected tab is the only ordinary desktop tab with a surface. Phone tabs
 * are all glass: the selected one is the bright plate, the rest a dimmer wash.
 * Custom colours stay visible as an explicit exception, but use a quieter mix
 * while inactive.
 */
export function tabClass(state: TabState): string {
	const { active, waiting, colored } = state;
	const ink = active || waiting ? mergeStylexClassName("", sx.textFg) : mergeStylexClassName("", sx.textDim, sx.hoverTextFg);
	const surface = colored
		? active
			? mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarTabColor22VarBgPanel) +
				" " + mergeStylexClassName("", sharedClassStyles.hoverBgColorMixInSrgbVarTabColor28VarBgPanel) +
				" " + mergeStylexClassName("", sharedClassStyles.phoneBgColorMixInSrgbVarTabColor22VarMobileTabSurfaceSelected)
			: mergeStylexClassName("", sharedClassStyles.bgColorMixInSrgbVarTabColor9Transparent) +
				" " + mergeStylexClassName("", sharedClassStyles.hoverBgColorMixInSrgbVarTabColor16Transparent) +
				" " + mergeStylexClassName("", sharedClassStyles.phoneBgColorMixInSrgbVarTabColor9VarMobileTabSurface)
		: active
			? mergeStylexClassName("", sx.bgPanel, sx.hoverBgHover, sx.phoneBgVarMobileTabSurfaceSelected)
			: mergeStylexClassName("", sx.bgTransparent, sx.hoverBgHover, sx.phoneBgVarMobileTabSurface);

	return [TAB_BASE, ink, surface].filter(Boolean).join(" ");
}

/** The label uses the close control's space while the tab is idle. Hovering
 *  reveals close over the title, with a wider fade keeping both legible. */
export const TAB_TITLE =
	mergeStylexClassName("session-tab-title", sx.block, sx.minW0, sx.maxW150px, sx.overflowHidden) + " " +
	"data-[overflow]:[mask-image:linear-gradient(to_right,var(--color-black)_0,var(--color-black)_calc(100%_-_10px),transparent_100%)] " +
	mergeStylexClassName("", sx.desktopMaxW166px) + " " +
	"desktop:group-hover/tab:[mask-image:linear-gradient(to_right,var(--color-black)_0,var(--color-black)_calc(100%_-_36px),transparent_100%)] " +
	"desktop:group-focus-within/tab:[mask-image:linear-gradient(to_right,var(--color-black)_0,var(--color-black)_calc(100%_-_36px),transparent_100%)]";

/** An icon-only view tab (Staging → a globe): drop the label's text metrics so
 *  the tab sizes to the glyph. */
export const TAB_VICON = mergeStylexClassName("", sx.inlineFlex, sx.itemsCenter, sx.justifyCenter, sx.leadingNone);

/** Unsent draft in a sibling session. The title already reserves 14px for the
 * close control, so the pencil uses that room on hover instead of sitting
 * underneath the control as it appears. */
export const TAB_DRAFT =
	mergeStylexClassName("", sx.inlineFlex, sx.flexNone, sx.itemsCenter, sx.textDim) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineTransitionTransform) + " " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:-translate-x-3.5 " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-focus-within/tab:-translate-x-3.5 " +
	mergeStylexClassName("", sx.motionReduceTransitionNone);

/**
 * Teammates who have THIS tab open. The sidebar answers "someone is in this
 * workspace"; a workspace is a strip of tabs, so the strip is where that
 * answers "which one".
 *
 * The faces sit in a row with a small gap rather than an overlapping pile:
 * a pile needs a gap ring painted in the surface behind it, and a tab has
 * five of those (plain, hover, active, waiting, coloured, and none of them on
 * desktop, where the tab is flat on the strip). Two faces plus a count is
 * also all a 200px tab has room for.
 */
export const TAB_FACES = mergeStylexClassName("", sx.flex, sx.flexNone, sx.itemsCenter, sx.gap05);

/** One face. Small enough to read as a marker beside the label, not a
 *  participant list. */
export const TAB_FACE = mergeStylexClassName("", sx.shrink0);

/** "+2" when more people are here than the strip shows faces for. */
export const TAB_FACES_MORE = mergeStylexClassName("", typography.meta, sx.leadingNone, sx.textDim);

/** Inline rename input, sized to sit in place of the title. */
export const TAB_RENAME =
	mergeStylexClassName("", sx.my1px, sx.maxW150px, sx.roundedXs, sx.border, sx.borderAccent, sx.bgSurface, sx.px3px, sx.fontInherit, sx.textInherit, sx.outlineNone);

/* ── Liveness dots ──────────────────────────────────────────────────────── */

/**
 * The running / needs-you dot. "Needs you" is blue throughout — the sidebar
 * already resolved it that way.
 *
 * base.css's reduced-motion block kills every animation with `!important` and
 * then hands a handful of liveness signals back BY CLASS NAME — these two dots
 * among them. That list is the one thing a migration can break silently: the
 * rule stays valid, it just stops matching, and the "still running" pulse
 * freezes for anyone with the preference set with nothing to detect it. So the
 * exception rides the element instead of the list, where it travels with the
 * component; it wins on equal specificity because the utility sheet is linked
 * last, and `!` matches the block it is arguing with.
 *
 * `pulse` is defined by BOTH legacy.css and the utility sheet, and keyframes
 * don't cascade by specificity: the later definition wins document-wide, so
 * every legacy `animation: pulse` has in fact been running the utility sheet's
 * 1 → 0.5 fade rather than the authored 1 → 0.35. Naming the same keyframes
 * here keeps exactly what ships; this is not the place to change it.
 */
const DOT_BASE = mergeStylexClassName("", sx.size15, sx.shrink0, sx.roundedFull);

export const tabDotClass = (waiting: boolean) =>
	waiting
		? [DOT_BASE, mergeStylexClassName("", sx.bgBlue, sx.shadow006pxVarBlue, sx.animatePulse12sEaseInOutInfinite)].filter(Boolean).join(" ") +
			" " + mergeStylexClassName("", sx.motionReduceAnimationDuration12s, sx.motionReduceAnimationIterationCountInfinite)
		: [DOT_BASE, mergeStylexClassName("", sx.bgYellow, sx.animatePulse14sEaseInOutInfinite)].filter(Boolean).join(" ") +
			" " + mergeStylexClassName("", sx.motionReduceAnimationDuration14s, sx.motionReduceAnimationIterationCountInfinite);

/** A view tab's status dot (PR state). Shared with the right panel's tabs,
 *  which render the same mark. The caller adds the tone's fill. */
export const PANEL_TAB_DOT = mergeStylexClassName("", sx.size7px, sx.roundedFull);

/**
 * What that dot means on a Review view-tab: the PR's state, plus the conflict
 * case, which is a mergeability flag rather than a state of its own.
 *
 * A lookup of literal strings because the old spelling was
 * `` `pr-dot-${prState.toLowerCase()}` `` — a class assembled at runtime, which
 * no utility can ever be (Tailwind only compiles names it can find in source).
 * Same tones the rule set, and the same ones lib/sidebar-hover gives these
 * states in the row hover cards.
 */
export const PR_DOT_TONE: Record<string, string> = {
	OPEN: mergeStylexClassName("", sx.bgGreen),
	MERGED: mergeStylexClassName("", sx.bgPurple),
	CLOSED: mergeStylexClassName("", sx.bgRed),
	CONFLICT: mergeStylexClassName("", sx.bgYellow),
};

/* ── Per-tab close, and the trailing controls ───────────────────────────── */

const CLOSE_BASE =
	mergeStylexClassName("", sx.My05, sx.Mr3px, sx.inlineFlex, sx.size4, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter) + " " +
	mergeStylexClassName("", sx.roundedSm, sx.border0, sx.bgTransparent, sx.p0, sx.textDim) + " " +
	mergeStylexClassName("", sx.hoverBgPressed, sx.hoverTextFg, sx.MediaHoverNoneSize26px, sx.MediaHoverNoneMr1);

/** Desktop close controls share one absolute position, so revealing one never
 * changes its width and never asks Motion to shuffle every sibling. */
const CLOSE_OVERLAY_POSITION =
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineAbsolute) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineRight1, sx.MediaHoverHoverAndPointerFineTop12) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineZ1, sx.MediaHoverHoverAndPointerFineM0) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineTranslateY12) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineTransitionOpacity);

const CLOSE_OVERLAY_HIDDEN =
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFinePointerEventsNone) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineOpacity0) + " " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:opacity-100 " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineFocusVisiblePointerEventsAuto) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineFocusVisibleOpacity100);

/** Phones have no hover, so close stays in flow with a finger-sized hit area. */
const CLOSE_TOUCH = mergeStylexClassName("", sx.size26px, sx.Mr1);

export const tabCloseClass = (phone: boolean) =>
	[CLOSE_BASE, phone ? CLOSE_TOUCH : `${CLOSE_OVERLAY_POSITION} ${CLOSE_OVERLAY_HIDDEN}`].filter(Boolean).join(" ");

/**
 * The trailing controls use quiet chrome with no pill fill or shadow. History
 * reveals with the strip, on focus, and while its menu is open.
 */
const CTRL_REVEAL =
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFinePointerEventsNone) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineOpacity0) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineTransitionOpacity) + " " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/strip:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/strip:opacity-100 " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineFocusVisiblePointerEventsAuto) + " " +
	mergeStylexClassName("", sx.MediaHoverHoverAndPointerFineFocusVisibleOpacity100) + " " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[menu-open]:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[menu-open]:opacity-100 " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[popup-open]:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[popup-open]:opacity-100";

const CTRL_BASE =
	mergeStylexClassName("", sx.inlineFlex, sx.minH36px, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.whitespaceNowrap) +
	" " + [mergeStylexClassName("", sx.border, sx.borderTransparent, sx.bgTransparent, sx.px35, sx.py15), PILL].filter(Boolean).join(" ") +
	" " + mergeStylexClassName("", sx.transitionBackgroundColorColor, sx.fontInherit, sx.leadingNone, sx.textDim) + " " +
	mergeStylexClassName("", sx.hoverBgHover, sx.hoverTextFg);

/** Desktop trailing controls match the tabs' 28px box and medium radius. */
const CTRL_DESKTOP =
	mergeStylexClassName("", sx.desktopSize7, sx.desktopMinHAuto, sx.desktopSelfCenter, sx.desktopRoundedMd, sx.desktopP0);

/**
 * New-tab "+". Always visible once there is a strip, so adding a sibling does
 * not depend on discovering a hover state. It keeps a comfortable square hit
 * area on touch and matches the tabs on desktop.
 */
export const TAB_NEW =
	[mergeStylexClassName("session-tab-new"), CTRL_BASE, CTRL_DESKTOP, mergeStylexClassName("", sx.justifyCenter, sx.text15px, sx.desktopText22px)].filter(Boolean).join(" ");

/**
 * Archived-sessions menu. Same desktop footprint as the "+" it sits beside:
 * the two are one pair of quiet square controls after the last tab. Stays lit
 * while its menu is open (`data-popup-open`).
 */
export const TAB_HISTORY =
	[CTRL_BASE, CTRL_DESKTOP, mergeStylexClassName("", sx.justifyCenter)].filter(Boolean).join(" ") +
	" " + "data-[popup-open]:bg-hover data-[popup-open]:text-fg " +
	CTRL_REVEAL;

/* ── Tab colour swatches ─────────────────────────────────────────────────────
   The row of colour chips in a tab's context menu. Each chip carries its colour
   as an inline style (the palette is data, see lib/tab-colors), so what's left
   here is the ring, the box and the grow-on-hover.

   `rounded-full` is right on these and only these: the rule spelled a bare
   `border-radius: 50%` with no `corner-shape`, so a chip is a true circle
   rather than one of the app's squircles. The hairline stays the untokenized
   15% white it has always been — it reads as a highlight on a saturated chip,
   not as a chrome border, so `border-line` would be a visual change rather
   than a translation. */
export const TAB_SWATCH =
	mergeStylexClassName("", sx.borderRgba255255255015, sx.size22px, sx.roundedFull, sx.border, sx.transitionTransform, sx.hoverScale118);

/** The chip for the colour the tab currently wears: a ring in the page ink,
 *  gapped off the chip by the panel it sits on. */
export const TAB_SWATCH_ON = "shadow-[0_0_0_2px_var(--bg-panel),0_0_0_3px_var(--text)]";

/** The "no colour" chip: an empty ring with a diagonal strike. */
export const TAB_SWATCH_NONE =
	mergeStylexClassName("", sx.relative, sx.bgActive, sx.afterAbsolute, sx.afterInset3px, sx.afterRotate45, sx.afterBorderT) + " " +
	mergeStylexClassName("", sx.afterBorderTFaint, sx.afterContent);
