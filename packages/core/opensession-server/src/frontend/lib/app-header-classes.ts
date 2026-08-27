
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

const sx = stylex.create({
	hidden: {
		"display": "none"
	},
	hVarHeaderH: {
		"height": "var(--header-h)"
	},
	shrink0: {
		"flexShrink": "0"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	justifyBetween: {
		"justifyContent": "space-between"
	},
	bgSidebar: {
		"backgroundColor": "var(--sidebar-bg)"
	},
	px4: {
		"paddingInline": "16px"
	},
	pb0: {
		"paddingBottom": "0"
	},
	phoneFlex: {
		"@media (max-width: 720px)": {
			"display": "flex"
		}
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phoneBgTransparent: {
		"@media (max-width: 720px)": {
			"backgroundColor": "transparent"
		}
	},
	phoneFixed: {
		"@media (max-width: 720px)": {
			"position": "fixed"
		}
	},
	phoneInsetX0: {
		"@media (max-width: 720px)": {
			"insetInline": "0"
		}
	},
	phoneTop0: {
		"@media (max-width: 720px)": {
			"top": "0"
		}
	},
	phoneZ40: {
		"@media (max-width: 720px)": {
			"zIndex": "40"
		}
	},
	phonePointerEventsNone: {
		"@media (max-width: 720px)": {
			"pointerEvents": "none"
		}
	},
	phoneBeforeAbsolute: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"position": "absolute"
			}
		}
	},
	phoneBeforeInsetX0: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"insetInline": "0"
			}
		}
	},
	phoneBeforeTop0: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"top": "0"
			}
		}
	},
	phoneBeforeBottomAuto: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"bottom": "auto"
			}
		}
	},
	phoneBeforeZ1: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"zIndex": "-1"
			}
		}
	},
	phoneBeforeHCalc10030px: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"height": "calc(100% + 30px)"
			}
		}
	},
	phoneBeforePointerEventsNone: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"pointerEvents": "none"
			}
		}
	},
	phoneBeforeContent: {
		"@media (max-width: 720px)": {
			"::before": {
				"--tw-content": "\"\"",
				"content": "var(--tw-content)"
			}
		}
	},
	phoneBeforeBackdropBlur20px: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"--tw-backdrop-blur": "blur(20px)",
				"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
				"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
			}
		}
	},
	phoneBeforeBackdropSaturate14: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"--tw-backdrop-saturate": "saturate(1.4)",
				"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
				"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
			}
		}
	},
	phoneRelative: {
		"@media (max-width: 720px)": {
			"position": "relative"
		}
	},
	flex: {
		"display": "flex"
	},
	gap2: {
		"gap": "8px"
	},
	phoneBackdropFilterVarMobileHeaderControlBlur: {
		"@media (max-width: 720px)": {
			"WebkitBackdropFilter": "var(--mobile-header-control-blur)",
			"backdropFilter": "var(--mobile-header-control-blur)"
		}
	},
	phoneWebkitBackdropFilterVarMobileHeaderControlBlur: {
		"@media (max-width: 720px)": {
			"WebkitBackdropFilter": "var(--mobile-header-control-blur)"
		}
	},
	phoneBgVarMobileHeaderControlSurface: {
		"@media (max-width: 720px)": {
			"backgroundColor": "var(--mobile-header-control-surface)"
		}
	},
	phoneM0: {
		"@media (max-width: 720px)": {
			"margin": "0"
		}
	},
	phoneInlineFlex: {
		"@media (max-width: 720px)": {
			"display": "inline-flex"
		}
	},
	phoneSize11: {
		"@media (max-width: 720px)": {
			"width": "44px",
			"height": "44px"
		}
	},
	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
	phoneItemsCenter: {
		"@media (max-width: 720px)": {
			"alignItems": "center"
		}
	},
	phoneJustifyCenter: {
		"@media (max-width: 720px)": {
			"justifyContent": "center"
		}
	},
	phoneTextFg: {
		"@media (max-width: 720px)": {
			"color": "var(--text)"
		}
	},
	phoneShadowVarMobileHeaderControlShadow: {
		"@media (max-width: 720px)": {
			"--tw-shadow": "var(--mobile-header-control-shadow)",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
	phoneCursorPointer: {
		"@media (max-width: 720px)": {
			"cursor": "pointer"
		}
	},
	phoneTouchManipulation: {
		"@media (max-width: 720px)": {
			"touchAction": "manipulation"
		}
	},
	phoneWebkitTapHighlightColorTransparent: {
		"@media (max-width: 720px)": {
			"WebkitTapHighlightColor": "transparent"
		}
	},
	phoneTransitionPropertyOpacity: {
		"@media (max-width: 720px)": {
			"transitionProperty": "opacity"
		}
	},
	phoneDurationVarDur: {
		"@media (max-width: 720px)": {
			"--tw-duration": "var(--dur)",
			"transitionDuration": "var(--dur)"
		}
	},
	phoneEaseVarEase: {
		"@media (max-width: 720px)": {
			"--tw-ease": "var(--ease)",
			"transitionTimingFunction": "var(--ease)"
		}
	},
	phoneActiveScale100: {
		"@media (max-width: 720px)": {
			":active": {
				"--tw-scale-x": "100%",
				"--tw-scale-y": "100%",
				"--tw-scale-z": "100%",
				"scale": "var(--tw-scale-x) var(--tw-scale-y)"
			}
		}
	},
	phoneActiveOpacity40: {
		"@media (max-width: 720px)": {
			":active": {
				"opacity": ".4"
			}
		}
	},
	phoneActiveDuration0: {
		"@media (max-width: 720px)": {
			":active": {
				"--tw-duration": "0s",
				"transitionDuration": "0s"
			}
		}
	},
	absolute: {
		"position": "absolute"
	},
	Right05: {
		"right": "-2px"
	},
	Bottom05: {
		"bottom": "-2px"
	},
	size25: {
		"width": "10px",
		"height": "10px"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	,
		cornerShape: "round"},
	border2: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "2px"
	},
	borderRaised: {
		"borderColor": "var(--bg-raised)"
	},
	phoneFlex01Auto: {
		"@media (max-width: 720px)": {
			"flex": "0 auto"
		}
	},
	phoneMinW0: {
		"@media (max-width: 720px)": {
			"minWidth": "0"
		}
	},
	phoneJustifyStart: {
		"@media (max-width: 720px)": {
			"justifyContent": "flex-start"
		}
	},
	phoneGap9px: {
		"@media (max-width: 720px)": {
			"gap": "9px"
		}
	},
	phoneMl2: {
		"@media (max-width: 720px)": {
			"marginLeft": "8px"
		}
	},
	phoneMrAuto: {
		"@media (max-width: 720px)": {
			"marginRight": "auto"
		}
	},
	phonePy5px: {
		"@media (max-width: 720px)": {
			"paddingBlock": "5px"
		}
	},
	phonePr4: {
		"@media (max-width: 720px)": {
			"paddingRight": "16px"
		}
	},
	phonePl11px: {
		"@media (max-width: 720px)": {
			"paddingLeft": "11px"
		}
	},
	phonePointerEventsAuto: {
		"@media (max-width: 720px)": {
			"pointerEvents": "auto"
		}
	},
	phoneAbsolute: {
		"@media (max-width: 720px)": {
			"position": "absolute"
		}
	},
	phoneLeft12: {
		"@media (max-width: 720px)": {
			"left": "50%"
		}
	},
	phoneMl0: {
		"@media (max-width: 720px)": {
			"marginLeft": "0"
		}
	},
	phoneMr0: {
		"@media (max-width: 720px)": {
			"marginRight": "0"
		}
	},
	phoneTransformTranslateX50: {
		"@media (max-width: 720px)": {
			"transform": "translate(-50%)"
		}
	},
	motionReduceTransitionNone: {
		"@media (prefers-reduced-motion: reduce)": {
			"transitionProperty": "none"
		}
	},
	phoneTranslateY1: {
		"@media (max-width: 720px)": {
			"--tw-translate-y": "4px",
			"translate": "var(--tw-translate-x) var(--tw-translate-y)"
		}
	},
	phoneOpacity0: {
		"@media (max-width: 720px)": {
			"opacity": "0"
		}
	},
	phoneFlexNone: {
		"@media (max-width: 720px)": {
			"flex": "none"
		}
	},
	phoneFlexCol: {
		"@media (max-width: 720px)": {
			"flexDirection": "column"
		}
	},
	phoneItemsStart: {
		"@media (max-width: 720px)": {
			"alignItems": "flex-start"
		}
	},
	phoneGapPx: {
		"@media (max-width: 720px)": {
			"gap": "1px"
		}
	},
	phoneMaxWFull: {
		"@media (max-width: 720px)": {
			"maxWidth": "100%"
		}
	},
	phoneGap7px: {
		"@media (max-width: 720px)": {
			"gap": "7px"
		}
	},
	phoneTextBase: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-body)",
			"lineHeight": "var(--tw-leading,var(--text-base--line-height))"
		}
	},
	phoneLeading4: {
		"@media (max-width: 720px)": {
			"--tw-leading": "calc(4px * 4)",
			"lineHeight": "16px"
		}
	},
	phoneFontSemibold: {
		"@media (max-width: 720px)": {
			"--tw-font-weight": "var(--font-weight-semibold)",
			"fontWeight": "var(--font-weight-semibold)"
		}
	},
	phoneFlex1: {
		"@media (max-width: 720px)": {
			"flex": "1"
		}
	},
	phoneTruncate: {
		"@media (max-width: 720px)": {
			"textOverflow": "ellipsis",
			"whiteSpace": "nowrap",
			"overflow": "hidden"
		}
	},
	phoneTextMeta: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-meta)",
			"fontWeight": "var(--tw-font-weight,var(--font-weight-normal))"
		}
	},
	phoneFontMedium: {
		"@media (max-width: 720px)": {
			"--tw-font-weight": "var(--font-weight-medium)",
			"fontWeight": "var(--font-weight-medium)"
		}
	},
	phoneLeading11: {
		"@media (max-width: 720px)": {
			"--tw-leading": "1.1",
			"lineHeight": "1.1"
		}
	},
	phoneTextFaint: {
		"@media (max-width: 720px)": {
			"color": "var(--text-faint)"
		}
	},
	phoneMinH4: {
		"@media (max-width: 720px)": {
			"minHeight": "16px"
		}
	},
	phoneGap15: {
		"@media (max-width: 720px)": {
			"gap": "6px"
		}
	},
	phoneActiveOpacity60: {
		"@media (max-width: 720px)": {
			":active": {
				"opacity": ".6"
			}
		}
	},
	phoneShrink0: {
		"@media (max-width: 720px)": {
			"flexShrink": "0"
		}
	},
	phoneText16px: {
		"@media (max-width: 720px)": {
			"fontSize": "16px"
		}
	},
	phoneTextDim: {
		"@media (max-width: 720px)": {
			"color": "var(--text-dim)"
		}
	},
	truncate: {
		"textOverflow": "ellipsis",
		"whiteSpace": "nowrap",
		"overflow": "hidden"
	},
	phoneMaxW45vw: {
		"@media (max-width: 720px)": {
			"maxWidth": "45vw"
		}
	},
	minH0: {
		"minHeight": "0"
	},
	gap1: {
		"gap": "4px"
	},
	p0: {
		"padding": "0"
	},
	phoneH10: {
		"@media (max-width: 720px)": {
			"height": "40px"
		}
	},
	phoneW13: {
		"@media (max-width: 720px)": {
			"width": "52px"
		}
	},
	phoneRoundedNone: {
		"@media (max-width: 720px)": {
			"borderRadius": "0"
		}
	},
	phoneBorderNone: {
		"@media (max-width: 720px)": {
			"--tw-border-style": "none",
			"borderStyle": "none"
		}
	},
	phoneP0: {
		"@media (max-width: 720px)": {
			"padding": "0"
		}
	},
	phoneShadowNone: {
		"@media (max-width: 720px)": {
			"--tw-shadow": "0 0 transparent",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
	phoneActiveOpacity35: {
		"@media (max-width: 720px)": {
			":active": {
				"opacity": ".35"
			}
		}
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
	phoneMlAuto: {
		"@media (max-width: 720px)": {
			"marginLeft": "auto"
		}
	},
	phoneGap0: {
		"@media (max-width: 720px)": {
			"gap": "0"
		}
	},
	phoneOverflowHidden: {
		"@media (max-width: 720px)": {
			"overflow": "hidden"
		}
	},
	phoneMl25: {
		"@media (max-width: 720px)": {
			"marginLeft": "10px"
		}
	},
	phoneGap25: {
		"@media (max-width: 720px)": {
			"gap": "10px"
		}
	},
	phoneOrder1: {
		"@media (max-width: 720px)": {
			"order": "calc(1 * -1)"
		}
	},

	ptEnvSafeAreaInsetTop0px: {
		"paddingTop": "env(safe-area-inset-top,0px)"
	},
	phonePtMaxEnvSafeAreaInsetTop0px8px: {
		"@media (max-width: 720px)": {
			"paddingTop": "max(env(safe-area-inset-top,0px), 8px)"
		}
	},
	phoneTransitionOpacityTranslate: {
		"@media (max-width: 720px)": {
			"transitionProperty": "opacity,translate",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
});

/**
 * The phone top bar — one iOS-style nav bar, and everything that rides in it.
 *
 * The bar is a single `<header>` in App.tsx that wears three different faces:
 * `display:none` on desktop (the brand and user controls live in the sidebar
 * there), a solid band in flow on ordinary pushed routes, and a fixed
 * transparent overlay on the routes that scroll under it (home, Feed, and a
 * session). The faces are one element, so they migrate together: splitting
 * them would leave the overlay's `position:fixed` fighting the band's
 * `height` across two stylesheets.
 *
 * Two class names survive as bare hooks, carrying no styling of their own:
 *
 * - `app-header-overlay` — the only marker of "the bar is floating over this
 *   route". Two other modules read it from outside this tree:
 *   `lib/app-shell-classes.ts` zeroes `--pane-header-h` with
 *   `.app:not(:has(.app-header-overlay))`, and `lib/session-tab-classes.ts`
 *   offsets the docked tab strip with `.app:has(.app-header-overlay)`. Drop
 *   the name and the transcript's top inset and the tab strip both break, in
 *   opposite directions.
 * - `app-header-actions` — `lib/session-viewer-classes.ts` flattens the
 *   session header into the bar through `[.app-header-actions_&]` when
 *   SessionViewer portals it in here.
 *
 * `header-sessionbar` is kept on the markup too, but only as prose insurance:
 * nothing selects it any more (the `flex-shrink` fixes it used to carry are
 * folded into `ui/status.tsx`'s PulseDot, and its `.repo-tile` rule matched
 * nothing once the tile moved to the pill's leading slot). It can go with the
 * two stale comments that still name it, in `ui/status.tsx` and
 * `components/RepoTile.tsx`.
 *
 * Everything below is `phone:`-scoped wherever the rule it replaces lived in
 * the `max-width: 720px` block, even on elements that only ever render inside
 * this bar. The bar is `hidden`, not unmounted, on desktop — its subtree still
 * resolves computed styles there — so dropping the prefix would quietly change
 * what those elements compute at desktop width.
 */

/**
 * The bar. `justify-between` is the fallback distribution; on a pushed page
 * the title pill's `mr-auto` and the actions cluster's fixed gap take over.
 * Padding is authored twice on purpose: 16px edges are what the desktop rule
 * spelled (inert under `hidden`, but it is what the element computes), 12px is
 * the phone edge that lines up with the content column below. The top pad
 * keeps a small gap on a flat-top device while a notched one still gets its
 * full safe-area inset.
 */
const APP_HEADER_BASE =
	mergeStylexClassName("", sx.hidden, sx.hVarHeaderH, sx.shrink0, sx.itemsCenter, sx.justifyBetween, sx.bgSidebar) + " " +
	mergeStylexClassName("", sx.ptEnvSafeAreaInsetTop0px, sx.px4, sx.pb0) + " " +
	mergeStylexClassName("", sx.phonePtMaxEnvSafeAreaInsetTop0px8px, sx.phoneFlex, sx.phonePx3);

/**
 * Pushed pages (a session, a PR…): the band itself goes invisible so its
 * controls read as floating bubbles over the page — Back, the title pill, the
 * actions. No chrome band, no divider.
 *
 * The rule this replaces also set `border-bottom-color: transparent`. Nothing
 * draws a border on this element (no rule in base.css or here targets it), so
 * that declaration only ever moved a computed value; it is not carried over.
 */
const APP_HEADER_DETAIL = mergeStylexClassName("", sx.phoneBgTransparent);

/**
 * Home, Feed, and a session: the bar floats over the content instead of
 * reserving a band above it, so the list / the transcript fill the full height
 * and scroll UNDER the pills. Taps fall through the gaps between the pills to the content
 * underneath — `*:pointer-events-auto` hands them back to the pills themselves.
 *
 * `::before` is the scroll edge, and it is the reason this works at all: a blur
 * that fades out downward over a fade of the page colour, both masked so the
 * band ends by disappearing rather than by drawing a line. Without it a
 * transcript line or a dark screenshot slides up into the gaps and the bar
 * reads as three stickers dropped on a page. It sits at `z-index:-1` — inside
 * the bar's own stacking context, so still above the page, but below the pills,
 * which are positioned siblings that would otherwise be washed out by it.
 *
 * When the docked tab strip is present, the scroll edge stops at the header so
 * it cannot wash over the tab labels. The tabs carry their own glass material.
 * The header is a sibling of the pane, so that state is keyed off the nearest
 * common ancestor.
 *
 * SessionViewer can still collapse lower chat chrome while reading, but this
 * navigation bar stays pinned so Back and its actions never scroll away.
 */
const APP_HEADER_OVERLAY =
	"app-header-overlay " +
	mergeStylexClassName("", sx.phoneFixed, sx.phoneInsetX0, sx.phoneTop0, sx.phoneZ40, sx.phoneBgTransparent) + " " +
	mergeStylexClassName("phone:*:pointer-events-auto", sx.phonePointerEventsNone) + " " +
	mergeStylexClassName("", sx.phoneBeforeAbsolute, sx.phoneBeforeInsetX0, sx.phoneBeforeTop0) + " " +
	mergeStylexClassName("", sx.phoneBeforeBottomAuto, sx.phoneBeforeZ1, sx.phoneBeforeHCalc10030px) + " " +
	"phone:[.app:has(.session-tabs)_&]:before:h-full " +
	mergeStylexClassName("", sx.phoneBeforePointerEventsNone, sx.phoneBeforeContent) +
	// The fade is thinned deliberately. It used to be SOLID `--bg` for its first
	// half, which is exactly the band the controls sit in, so each control was
	// backed by an opaque plate of the page colour and had nothing to be
	// translucent against. Full strength survives only across the status-bar
	// strip, where the clock has to stay legible; from there down the blur is
	// what does the work, which is how an iOS scroll edge behaves.
	" " + mergeStylexClassName("", sharedClassStyles.phoneBeforeBackgroundLinearGradientToBottomVarBg0ColorMixInSrgbVarBg55Transparent52ColorMixInSrgbVarBg18Transparent78Transparent100) +
	" " + mergeStylexClassName("", sx.phoneBeforeBackdropBlur20px, sx.phoneBeforeBackdropSaturate14) + " " +
	mergeStylexClassName("", sharedClassStyles.phoneBeforeWebkitMaskImageLinearGradientToBottomVarColorBlack0VarColorBlack62Transparent100) +
	" " + mergeStylexClassName("", sharedClassStyles.phoneBeforeMaskImageLinearGradientToBottomVarColorBlack0VarColorBlack62Transparent100);

/**
 * The bar's three faces, assembled so that only one of them is ever on the
 * markup. That is not tidiness: `position` is a single Tailwind utility group,
 * so a `phone:relative` and a `phone:fixed` on one element are resolved by the
 * order Tailwind EMITS them (static, fixed, absolute, relative, sticky) rather
 * than the order they were written — `relative` wins, and the floating bar
 * silently drops back into flow. The stylesheet this replaces got the opposite
 * answer for free, by source order. So the in-flow face and the floating face
 * each spell their own position, and the caller picks one.
 *
 * `detail`: a pushed page with no chrome band. `floating`: home, Feed, or a
 * session, out of flow over the scrolling content.
 */
export function appHeader({
	detail,
	floating,
}: {
	detail: boolean;
	floating: boolean;
}): string {
	return [
		APP_HEADER_BASE,
		floating ? APP_HEADER_OVERLAY : mergeStylexClassName("", sx.phoneRelative),
		detail ? APP_HEADER_DETAIL : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** Leading slot: the brand on the root page, the Back bubble on a pushed one. */
export const APP_HEADER_LEFT = mergeStylexClassName("", sx.flex, sx.shrink0, sx.itemsCenter, sx.gap2);

/**
 * What every floating control in this bar is made of: a thinned fill over a
 * blur, so the page passing underneath tints it. This is the whole difference
 * between an iOS toolbar item and a white pill sitting on a page, and it is one
 * string rather than four copies because the four controls are one material:
 * Back, the title pill, the grouped actions capsule, and the session header's
 * ⋯ trigger (components/SessionViewer.tsx, which imports it).
 *
 * The `-webkit-` spelling is not legacy dressing: iOS Safari, and the installed
 * PWA with it, still ships `backdrop-filter` only under the prefix, so dropping
 * it turns the glass back into a flat wash on the exact client this is for.
 * base.css collapses the fill back to an opaque `--bg` where the browser has no
 * backdrop-filter at all, and for reduced transparency.
 */
export const MOBILE_CONTROL_GLASS_EFFECTS =
	mergeStylexClassName("", sx.phoneBackdropFilterVarMobileHeaderControlBlur) + " " +
	mergeStylexClassName("", sx.phoneWebkitBackdropFilterVarMobileHeaderControlBlur);

export const MOBILE_CONTROL_GLASS =
	mergeStylexClassName("", sx.phoneBgVarMobileHeaderControlSurface) +
	" " + MOBILE_CONTROL_GLASS_EFFECTS;

/**
 * One circular mobile top-bar control: Back, More and future page actions all
 * share this material, size, neutral ink and press response. `rounded-full`,
 * not `rounded-[999px]`, keeps the platform's true-circle toolbar shape.
 */
export const MOBILE_TOP_BAR_CONTROL =
	mergeStylexClassName("", sx.phoneM0, sx.phoneInlineFlex, sx.phoneSize11, sx.phoneMinH11, sx.phoneItemsCenter, sx.phoneJustifyCenter) +
	" " + [mergeStylexClassName("", sx.phoneRoundedFull, sx.phoneBorder, sx.phoneBorderColorVarMobileHeaderControlBorder), MOBILE_CONTROL_GLASS, mergeStylexClassName("", sx.phoneP0)].filter(Boolean).join(" ") +
	" " + mergeStylexClassName("", sx.phoneTextFg, sx.phoneShadowVarMobileHeaderControlShadow) + " " +
	mergeStylexClassName("", sx.phoneCursorPointer, sx.phoneTouchManipulation) + " " +
	mergeStylexClassName("", sx.phoneWebkitTapHighlightColorTransparent) + " " +
	mergeStylexClassName("", sx.phoneTransitionPropertyOpacity, sx.phoneDurationVarDur) + " " +
	mergeStylexClassName("", sx.phoneEaseVarEase, sx.phoneActiveScale100, sx.phoneActiveOpacity40, sx.phoneActiveDuration0) + " " +
	"phone:[&_svg]:size-[26px] phone:[&_svg]:shrink-0";

/** Back adds only its PWA hook and the chevron's optical left nudge. */
export const MOBILE_BACK =
	[mergeStylexClassName("pwa-header-back"), MOBILE_TOP_BAR_CONTROL].filter(Boolean).join(" ") +
	" " + "phone:[&_svg]:size-[34px] phone:[&_svg]:-ml-px";

/**
 * Live connection dot on the organization mark in the sidebar selector. It
 * rides a relative wrapper because the tile itself can clip its image. The
 * colour is set inline from the socket state.
 */
export const APP_LOGO_STATUS =
	mergeStylexClassName("", sx.absolute, sx.Right05, sx.Bottom05, sx.size25, sx.roundedFull, sx.border2, sx.borderRaised);

/**
 * The title pill on a pushed page: the repo tile leads, then the name over a
 * model · cost subtitle, in a capsule that matches the Back bubble beside it.
 *
 * This replaces two rules — a centred, absolutely-positioned `.app-header-title`
 * and the `.app-header-detail` override that turned it into this pill. The
 * centred one is unreachable: the title only renders when the bar is in its
 * detail face, so the override always won. What survived of the base rule is
 * folded in here (the flex box and `text-fg`); its `bottom: 0` did not, being
 * inert on a statically-positioned element.
 *
 * `rounded-full` rather than `rounded-[999px]`: the rule set no `corner-shape`,
 * so this capsule is a round one. Both radii clamp to the same half-height
 * anyway; spelling it `999px` would hand it a squircle it never had.
 */
export const HEADER_TITLE_PILL =
	mergeStylexClassName("", sx.phoneFlex, sx.phoneMinH11, sx.phoneFlex01Auto, sx.phoneMinW0, sx.phoneItemsCenter) + " " +
	mergeStylexClassName("", sx.phoneJustifyStart, sx.phoneGap9px, sx.phoneMl2, sx.phoneMrAuto) + " " +
	mergeStylexClassName("", sx.phonePy5px, sx.phonePr4, sx.phonePl11px) +
	" " + [mergeStylexClassName("", sx.phoneRoundedFull, sx.phoneBorder, sx.phoneBorderColorVarMobileHeaderControlBorder), MOBILE_CONTROL_GLASS].filter(Boolean).join(" ") +
	" " + mergeStylexClassName("", sx.phoneShadowVarMobileHeaderControlShadow, sx.phoneTextFg) + " " +
	mergeStylexClassName("", sx.phonePointerEventsAuto);

/** Center a plain page title independently of the leading and trailing controls. */
export const HEADER_TITLE_PILL_CENTERED =
	mergeStylexClassName("", sx.phoneAbsolute, sx.phoneLeft12, sx.phoneMl0, sx.phoneMr0, sx.phoneTransformTranslateX50);

/**
 * Archived keeps Search at the phone's bottom edge. While that field is
 * focused, the controls recede and the page rises into their space. Both
 * directions are transitions so a quick focus change reverses from its current
 * position instead of restarting. Overflow stays visible while resting so the
 * floating controls' shadows can extend below the header box. Archived also
 * keeps the shadow inside the bar: 16px above and below the controls when
 * there is no status-bar safe area.
 */
export const ARCHIVED_SEARCH_HEADER =
	"phone:h-[calc(max(env(safe-area-inset-top,0px),16px)+60px)]! " +
	"phone:pt-[max(env(safe-area-inset-top,0px),16px)]! " +
	mergeStylexClassName("", sharedClassStyles.phoneTransitionHeightPaddingTopOpacityTransform) +
	" " + mergeStylexClassName("", sx.phoneDurationVarDur, sx.phoneEaseVarEase) + " " +
	"phone:[body.kb-open_&]:h-0! phone:[body.kb-open_&]:pt-0! " +
	"phone:[body.kb-open_&]:pointer-events-none phone:[body.kb-open_&]:opacity-0 " +
	mergeStylexClassName("phone:[body.kb-open_&]:[transform:translateY(-8px)]", sx.motionReduceTransitionNone);

/**
 * The pill on a page that names itself, which is every page but a session: it
 * is not there until that name has scrolled up under the bar, and then it is.
 * The iOS large title, on the surface the pattern comes from. `data-shown` is
 * set by hooks/useLargeTitle.ts.
 *
 * The whole lozenge fades, not just the word inside it. This one is a floating
 * pill rather than a band across the top, so an empty one is a blank white
 * capsule sitting in the header with nothing in it, which is worse than the
 * duplicate title it was there to avoid.
 */
export const HEADER_TITLE_PILL_FADE =
	mergeStylexClassName("", sx.phoneTransitionOpacityTranslate, sx.phoneTranslateY1, sx.phoneOpacity0) + " " +
	"phone:data-[shown]:translate-y-0 phone:data-[shown]:opacity-100";

/**
 * On a session the pill is the tap target for the settings menu, and the name
 * dims on press to say so. The group name is what carries that press down to
 * the name; it is only on the markup when the pill is actually tappable, so
 * the plain title can't dim on a stray press.
 */
export const HEADER_TITLE_PILL_TAPPABLE =
	[HEADER_TITLE_PILL, mergeStylexClassName("group/titlepill")].filter(Boolean).join(" ") +
	" " + mergeStylexClassName("", sx.phoneCursorPointer, sx.phoneWebkitTapHighlightColorTransparent);

/**
 * Leading repo tile — a fixed square spanning both text rows. It is filled by
 * SessionViewer's portal, so it hides while empty rather than holding open the
 * pill's 9px gap in front of a name that has no tile yet.
 */
export const HEADER_TITLE_REPO =
	mergeStylexClassName("", sx.phoneInlineFlex, sx.phoneFlexNone, sx.phoneItemsCenter, sx.phoneJustifyCenter) + " " +
	"phone:empty:hidden";

/** Name over metadata, stacked to the right of the repo tile. */
export const HEADER_TITLE_COL =
	mergeStylexClassName("", sx.phoneFlex, sx.phoneMinW0, sx.phoneFlexCol, sx.phoneItemsStart, sx.phoneJustifyCenter) + " " +
	mergeStylexClassName("", sx.phoneGapPx);

/**
 * The name's row. The leading is pinned rather than left at `normal` (~1.21):
 * the name and the metadata line below it are a stacked pair, so the space
 * between them should be the 1px column gap plus a known half-leading, not
 * whatever the font's default line box happens to be.
 */
export const HEADER_TITLE_ROW =
	mergeStylexClassName("", sx.phoneFlex, sx.phoneMinW0, sx.phoneMaxWFull, sx.phoneItemsCenter, sx.phoneGap7px) + " " +
	mergeStylexClassName("", sx.phoneTextBase, sx.phoneLeading4, sx.phoneFontSemibold);

/** The name itself, softly faded if clipped and dimming while pressed. */
export const HEADER_TITLE_TEXT =
	mergeStylexClassName("phone:group-active/titlepill:opacity-60", sx.phoneFlex1);

/**
 * The metadata line's slot under the name — filled by SessionViewer's portal.
 * A touch lighter than the name so the subtitle recedes (Slack-header). Pointer
 * events are re-enabled here because the bar turns them off wholesale.
 */
export const HEADER_TITLE_MODEL =
	mergeStylexClassName("", sx.phoneMaxWFull, sx.phoneTruncate, sx.phoneTextMeta, sx.phoneFontMedium) + " " +
	mergeStylexClassName("", sx.phoneLeading11, sx.phoneTextFaint, sx.phonePointerEventsAuto);

/**
 * The session bar: the line under the title that just *shows* repo · model ·
 * cost. Tapping it (or the name above) opens the settings menu where those are
 * changed. `min-h-4` holds the line at full height whether or not the cost
 * meter has landed yet, so the pill doesn't grow a few px on the first turn.
 *
 * `header-sessionbar` leads the string as a bare hook — see the module note.
 */
export const HEADER_SESSIONBAR =
	mergeStylexClassName("header-sessionbar", sx.phoneInlineFlex, sx.phoneMinH4, sx.phoneMinW0) + " " +
	mergeStylexClassName("", sx.phoneMaxWFull, sx.phoneItemsCenter, sx.phoneJustifyStart, sx.phoneGap15) + " " +
	mergeStylexClassName("", sx.phoneCursorPointer, sx.phonePointerEventsAuto) + " " +
	mergeStylexClassName("", sx.phoneWebkitTapHighlightColorTransparent, sx.phoneActiveOpacity60);

/**
 * The middot between repo · model · cost. Bigger than the text around it, but
 * its line box is capped at the metadata line's own height: at 20px/1 the dot
 * was the tallest thing on the line and set the row height by itself, opening
 * a gap under the title that nothing visible filled.
 */
/* The 16px is glyph geometry, not a step of the scale: it sizes the middle dot
   between two runs of metadata so the dot lands optically centred against
   11px text. See the scale note in styles/tailwind.css. */
export const HEADER_SESSIONBAR_SEP =
	mergeStylexClassName("", sx.phoneShrink0, sx.phoneText16px, sx.phoneLeading4, sx.phoneTextDim);

export const HEADER_SESSIONBAR_MODEL =
	mergeStylexClassName("", sx.truncate, sx.phoneMinW0, sx.phoneMaxW45vw, sx.phoneTextMeta) + " " +
	mergeStylexClassName("", sx.phoneFontMedium, sx.phoneTextDim);

/**
 * The cost meter, restyled for the subtitle line: the model's size and colour,
 * a smaller context ring, and none of the toolbar button's padding. `min-h-0`
 * drops the meter's 32px touch box — as a subtitle it only needs its own line,
 * and the extra height was padding the gap under the title open.
 *
 * The two `[&_…]` reaches are what the ancestor rules did: the cost figure ships
 * `text-fg` for the toolbar, and the ring's `<svg>` carries its own size
 * attributes. The cache rate is dropped through the meter's own
 * `showCacheRate` prop instead of being hidden after the fact.
 */
export const HEADER_SESSIONBAR_USAGE =
	mergeStylexClassName("[&_span]:text-dim [&_svg]:size-2.5", sx.minH0, sx.gap1, sx.p0, typography.meta);

/**
 * The trailing slot. On the root page it carries Search and the portaled
 * filter; on a pushed page SessionViewer portals its whole header in here.
 *
 * `app-header-actions` stays on the markup as a hook — see the module note.
 *
 * The gap belongs to each variant rather than here: the two faces want
 * different spacing, and two `gap-*` utilities on one element are resolved by
 * Tailwind's OUTPUT order rather than the order they are written, so a `gap-0`
 * appended after this string silently loses to a `gap-2.5` inside it.
 */
const HEADER_ACTIONS_BASE =
	mergeStylexClassName("app-header-actions", sx.phoneFlex, sx.phoneMinW0, sx.phoneItemsCenter);

/**
 * On the root page the two glyphs in this slot — Filter and Search — are one
 * control, the way adjacent bar-button items group on iOS: a single capsule
 * carrying both, split by a hairline, rather than two separate circles floating
 * next to each other. So the surface (edge, fill, shadow, radius) lives here
 * on the container and the segments inside it are transparent; `gap-0` closes
 * the 10px the loose pair sat on, and `overflow-hidden` keeps a segment's press
 * dim inside the capsule's own curve.
 *
 * It is white (`bg-surface`) and undivided, which is what the native app's own
 * grouped toolbar item looks like — glass over the page, holding two glyphs
 * with no rule between them. That also lines it up with the Back bubble and
 * title pill on a pushed page, which are the same white capsule on the same
 * bar. The segments inside are wide rather than square for the same reason:
 * the glyph is ~22pt and the air around it is what makes the group read as one
 * control instead of two buttons that happen to touch.
 *
 * Only the root variant groups. A pushed page portals SessionViewer's whole
 * header into this slot, which is a row of unrelated controls and keeps the
 * loose spacing.
 */
export const APP_HEADER_ACTIONS =
	[HEADER_ACTIONS_BASE, mergeStylexClassName("", sx.phoneMlAuto, sx.phoneGap0, sx.phoneOverflowHidden)].filter(Boolean).join(" ") +
	" " + [mergeStylexClassName("", sx.phoneRoundedFull, sx.phoneBorder, sx.phoneBorderColorVarMobileHeaderControlBorder), MOBILE_CONTROL_GLASS].filter(Boolean).join(" ") +
	" " + mergeStylexClassName("", sx.phoneShadowVarMobileHeaderControlShadow);

/**
 * On a pushed page the title pill already carries `mr-auto` to shove this
 * cluster to the right edge. Two competing auto margins both collapse to 0 on a
 * long title, so the pill butts straight against the actions — a fixed gap, and
 * no shrinking, keeps air between them.
 */
export const APP_HEADER_ACTIONS_DETAIL =
	[HEADER_ACTIONS_BASE, mergeStylexClassName("", sx.phoneMl25, sx.phoneFlexNone, sx.phoneGap25)].filter(Boolean).join(" ");

/**
 * A segment of the grouped bar control (see `APP_HEADER_ACTIONS`): 40pt tall
 * and wider than it is high, with no chrome of its own. The capsule around it
 * draws the edge, fill and shadow. The glyph is thickened past its 1.5 stroke
 * because iOS nav-bar glyphs are bold and it reads spindly at this size
 * otherwise. `--header-h` in base.css leaves this control 40px below the bar's
 * 8px top inset. Move the two together.
 *
 * 40 rather than 44: the segment is wider than it is tall, so the target the
 * thumb actually meets stays past 44pt across, and the bar reads as chrome
 * rather than as the tallest thing on the screen.
 */
const MOBILE_BAR_SEGMENT =
	mergeStylexClassName("", sx.phoneRelative, sx.phoneInlineFlex, sx.phoneH10, sx.phoneW13, sx.phoneShrink0) + " " +
	mergeStylexClassName("", sx.phoneItemsCenter, sx.phoneJustifyCenter, sx.phoneRoundedNone) + " " +
	mergeStylexClassName("", sx.phoneBorderNone, sx.phoneBgTransparent, sx.phoneP0, sx.phoneShadowNone) + " " +
	mergeStylexClassName("", sx.phoneCursorPointer, sx.phoneTouchManipulation) + " " +
	mergeStylexClassName("", sx.phoneWebkitTapHighlightColorTransparent) + " " +
	mergeStylexClassName("", sx.phoneActiveOpacity35, sx.phoneActiveDuration0) + " " +
	"phone:[&_svg]:size-[23px] phone:[&_svg]:[stroke-width:2]";

/**
 * Search — the trailing half of the pair. No rule divides it from the filter:
 * the two glyphs sit in one undivided capsule, as they do in the native app's
 * grouped toolbar item. The air between them is the separation.
 */
export const MOBILE_SEARCH_BTN =
	[MOBILE_BAR_SEGMENT, mergeStylexClassName("", sx.phoneTextFg)].filter(Boolean).join(" ") +
	" " + mergeStylexClassName("", sx.phoneTransitionPropertyOpacity, sx.phoneDurationVarDur) + " " +
	mergeStylexClassName("", sx.phoneEaseVarEase);

/**
 * Filter, portaled out of the sidebar header into the same capsule. `-order-1`
 * seats it to Search's left. Muted until a filter is actually set, then raised
 * to the neutral foreground used by the other bar actions.
 *
 * Two whole strings rather than a shared base plus a colour: two `text-*`
 * utilities on one element are resolved by Tailwind's OUTPUT order, not the
 * order they were written in. Read them through `mobileFilterBtn()`, never
 * build the class name.
 */
const MOBILE_FILTER_BTN_BASE =
	[MOBILE_BAR_SEGMENT, mergeStylexClassName("", sx.phoneOrder1)].filter(Boolean).join(" ") +
	" " + "phone:[transition:opacity_var(--dur)_var(--ease),color_var(--dur-micro)_var(--ease)] ";

const MOBILE_FILTER_BTN = {
	muted: [MOBILE_FILTER_BTN_BASE, mergeStylexClassName("", sx.phoneTextDim)].filter(Boolean).join(" "),
	active: [MOBILE_FILTER_BTN_BASE, mergeStylexClassName("", sx.phoneTextFg)].filter(Boolean).join(" "),
} as const;

/** Raised to the neutral foreground while the popover is open or filtered. */
export function mobileFilterBtn(active: boolean): string {
	return active ? MOBILE_FILTER_BTN.active : MOBILE_FILTER_BTN.muted;
}
