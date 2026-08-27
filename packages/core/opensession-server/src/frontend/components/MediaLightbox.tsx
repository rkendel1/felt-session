import React, {
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type WorkspaceMediaItem } from "../lib/api";
import {
	type DiagramMedia,
	diagramDataUrl,
	readDiagramSvg,
} from "../lib/diagram-media";
import {
	canUseNativeIOSShare,
	nativeShareWasCancelled,
	saveFileWithNativeShare,
	shareURL,
} from "../lib/native-file-save";
import { copyImageToClipboard } from "../lib/image-clipboard";
import { copyToClipboard } from "../lib/share-link";
import { fullTime } from "../lib/time";
import {
	WALKTHROUGH_LABEL_CLASS,
	WALKTHROUGH_LABEL_TEXT,
	WALKTHROUGH_LABEL_TONE,
	type WalkthroughMediaLabel,
} from "../lib/walkthrough-label";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { cn, mergeStylexProps, mergeStylexClassName } from "../ui/cn";
import { toast } from "../ui/toast";
import {
	anchoredCommentPosition,
	imageRegionBetween,
	movedImageRegion,
	regionHandleStep,
	resizedImageRegion,
	type ImageRegion,
	type ImageRegionPoint,
	type RegionHandle,
	type ScreenRect,
} from "../lib/image-region-comment";
import {
	canCommentOnImageRegion,
	submitImageRegionComment,
} from "../lib/image-region-comment-registry";
import {
	IconArrowDown,
	IconArrowUp,
	IconArrowUpRight,
	IconCheck,
	IconChevronLeft,
	IconChevronRight,
	IconCopy,
	IconLink,
	IconMessage,
	IconShare,
	IconX,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	boxBorder: {
			boxSizing: "border-box"
	},
	shrink0: {
			flexShrink: "0"
	},
	rounded2xl: {
			borderRadius: "calc(22px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderWhite20: {
			borderColor: "color-mix(in srgb, var(--color-white) 20%, transparent)"
	},
	bgVarDiagramCanvas: {
			backgroundColor: "var(--diagram-canvas)"
	},
	p4: {
			padding: "16px"
	},
	TransformOrigin00: {
			transformOrigin: "0 0"
	},
	minH0: {
			minHeight: "0"
	},
	minW0: {
			minWidth: "0"
	},
	maxHFull: {
			maxHeight: "100%"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	objectContain: {
			objectFit: "contain"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	absolute: {
			position: "absolute"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	cursorMove: {
			cursor: "move"
	},
	touchNone: {
			touchAction: "none"
	},
	rounded3px: {
			borderRadius: "3px"
	,
		cornerShape: "var(--cs)"},
	borderWhite: {
			borderColor: "var(--color-white)"
	},
	fixed: {
			position: "fixed"
	},
	inset0: {
			inset: "0"
	},
	z11000: {
			zIndex: "11000"
	},
	flex: {
			display: "flex"
	},
	flexCol: {
			flexDirection: "column"
	},
	bgBlack85: {
			backgroundColor: "color-mix(in srgb, var(--color-black) 85%, transparent)"
	},
	flex1: {
			flex: "1"
	},
	selfStretch: {
			alignSelf: "stretch"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	gap05: {
			gap: "2px"
	},
	px6: {
			paddingInline: "24px"
	},
	textCenter: {
			textAlign: "center"
	},
	gap2: {
			gap: "8px"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-sm--line-height))"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	textWhite: {
			color: "var(--color-white)"
	},
	textWhite75: {
			color: "#ffffffbf"
	},
	h12: {
			height: "48px"
	},
	snapMandatory: { "--tw-scroll-snap-strictness": "mandatory" },
	gap1: {
			gap: "4px"
	},
	overflowXAuto: {
			overflowX: "auto"
	},
	pxCalc5022px: {
			paddingInline: "calc(50% - 22px)"
	},
	ScrollbarWidthNone: {
			scrollbarWidth: "none"
	},
	grid: {
			display: "grid"
	},
	size11: {
			width: "44px",
			height: "44px"
	},
	snapCenter: {
			scrollSnapAlign: "center"
	},
	placeItemsCenter: {
			placeItems: "center"
	},
	border0: {
			borderStyle: "solid",
			borderWidth: "0"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	p0: {
			padding: "0"
	},
	sizeFull: {
			width: "100%",
			height: "100%"
	},
	objectCover: {
			objectFit: "cover"
	},
	gridCols3: {
			gridTemplateColumns: "repeat(3,minmax(0,1fr))"
	},
	px5: {
			paddingInline: "20px"
	},
	justifySelfStart: {
			justifySelf: "flex-start"
	},
	insetX0: {
			insetInline: "0"
	},
	bottomCalc16pxEnvSafeAreaInsetBottom: {
			bottom: "calc(16px + env(safe-area-inset-bottom))"
	},
	z20: {
			zIndex: "20"
	},
	px4: {
			paddingInline: "16px"
	},
	pointerEventsAuto: {
			pointerEvents: "auto"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	borderWhite10: {
			borderColor: "color-mix(in srgb, var(--color-white) 10%, transparent)"
	},
	bgBlack55: {
			backgroundColor: "color-mix(in srgb, var(--color-black) 55%, transparent)"
	},
	py1: {
			paddingBlock: "4px"
	},
	pl4: {
			paddingLeft: "16px"
	},
	pr1: {
			paddingRight: "4px"
	},
	minH9: {
			minHeight: "36px"
	},
	px3: {
			paddingInline: "12px"
	},
	textWhite70: {
			color: "#ffffffb3"
	},
	cursorText: {
			cursor: "text"
	},
	rounded22px: {
			borderRadius: "22px"
	,
		cornerShape: "var(--cs)"},
	p15: {
			padding: "6px"
	},
	itemsEnd: {
			alignItems: "flex-end"
	},
	block: {
			display: "block"
	},
	wFull: {
			width: "100%"
	},
	resizeNone: {
			resize: "none"
	},
	appearanceNone: {
			appearance: "none"
	},
	px25: {
			paddingInline: "10px"
	},
	py2: {
			paddingBlock: "8px"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	size9: {
			width: "36px",
			height: "36px"
	},
	textWhite60: {
			color: "color-mix(in srgb, var(--color-white) 60%, transparent)"
	},
	bgAccent: {
			backgroundColor: "var(--accent)"
	},
	transitionTransform: {
			transitionProperty: "transform,translate,scale,rotate",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	pb1: {
			paddingBottom: "4px"
	},
	textRed: {
			color: "var(--red)"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	gap15: {
			gap: "6px"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	p1: {
			padding: "4px"
	},
	leadingNone: {
			lineHeight: "1"
	},
	textWhite50: {
			color: "#ffffff80"
	},

	relative: {
		"position": "relative"
	},
	selectNone: {
		"WebkitUserSelect": "none",
		"userSelect": "none"
	},
	dropShadow002pxRgb00005: {
		"--tw-drop-shadow-size": "drop-shadow(0 0 2px var(--tw-drop-shadow-color,color-mix(in srgb, var(--color-black) 50%, transparent)))",
		"--tw-drop-shadow": "var(--tw-drop-shadow-size)",
		"filter": "var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)"
	},
	leftCalc12pxEnvSafeAreaInsetLeft: {
		"left": "calc(12px + env(safe-area-inset-left))"
	},
	rightCalc12pxEnvSafeAreaInsetRight: {
		"right": "calc(12px + env(safe-area-inset-right))"
	},
	topCalc12pxEnvSafeAreaInsetTop: {
		"top": "calc(12px + env(safe-area-inset-top))"
	},
	z10: {
		"zIndex": "10"
	},
	durationVarDur: {
		"--tw-duration": "var(--dur)",
		"transitionDuration": "var(--dur)"
	},
	easeVarEase: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	motionReduceTransitionNone: {
		"@media (prefers-reduced-motion: reduce)": {
			"transitionProperty": "none"
		}
	},
	TranslateY2: {
		"--tw-translate-y": "calc(4px * -2)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	opacity0: {
		"opacity": "0"
	},
	hidden: {
		"display": "none"
	},
	bgWhite15: {
		"backgroundColor": "color-mix(in srgb, var(--color-white) 15%, transparent)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in oklab, var(--color-white) 15%, transparent)"
		}
	},
	right0: {
		"right": "0"
	},
	gap3: {
		"gap": "12px"
	},
	pb2: {
		"paddingBottom": "8px"
	},
	ptCalc56pxEnvSafeAreaInsetTop: {
		"paddingTop": "calc(56px + env(safe-area-inset-top))"
	},
	smPx4: {
		"@media (min-width: 40rem)": {
			"paddingInline": "16px"
		}
	},
	gap0: {
		"gap": "0"
	},
	px0: {
		"paddingInline": "0"
	},
	bottom0: {
		"bottom": "0"
	},
	bgLinearToB: {
		"--tw-gradient-position": "to bottom",
		"@supports (background-image: linear-gradient(in lab, red, red))": {
			"--tw-gradient-position": "to bottom in oklab"
		},
		"backgroundImage": "linear-gradient(var(--tw-gradient-stops))"
	},
	fromTransparent: {
		"--tw-gradient-from": "transparent",
		"--tw-gradient-stops": "var(--tw-gradient-via-stops,var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position))"
	},
	viaBlack85: {
		"--tw-gradient-via": "color-mix(in srgb, var(--color-black) 85%, transparent)",
		"@supports (color: color-mix(in lab, red, red))": {
			"--tw-gradient-via": "color-mix(in oklab, var(--color-black) 85%, transparent)"
		},
		"--tw-gradient-via-stops": "var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-via) var(--tw-gradient-via-position), var(--tw-gradient-to) var(--tw-gradient-to-position)",
		"--tw-gradient-stops": "var(--tw-gradient-via-stops)"
	},
	toBlack: {
		"--tw-gradient-to": "var(--color-black)",
		"--tw-gradient-stops": "var(--tw-gradient-via-stops,var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position))"
	},
	pt8: {
		"paddingTop": "32px"
	},
	translateY3: {
		"--tw-translate-y": "calc(4px * 3)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	roundedSm: {
		"borderRadius": "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	outline: {
		"outlineStyle": "var(--tw-outline-style)",
		"outlineWidth": "1px"
	},
	outline1: {
		"outlineStyle": "var(--tw-outline-style)",
		"outlineWidth": "1px"
	},
	outlineOffset1: {
		"outlineOffset": "1px"
	},
	h11: {
		"height": "44px"
	},
	w11: {
		"width": "44px"
	},
	opacity100: {
		"opacity": "1"
	},
	outlineWhite85: {
		"outlineColor": "#ffffffd9",
		"@supports (color: color-mix(in lab, red, red))": {
			"outlineColor": "color-mix(in oklab, var(--color-white) 85%, transparent)"
		}
	},
	h9: {
		"height": "36px"
	},
	w7: {
		"width": "28px"
	},
	opacity60: {
		"opacity": ".6"
	},
	outlineTransparent: {
		"outlineColor": "transparent"
	},
	justifySelfCenter: {
		"justifySelf": "center"
	},
	colStart3: {
		"gridColumnStart": "3"
	},
	justifySelfEnd: {
		"justifySelf": "flex-end"
	},
	pb4: {
		"paddingBottom": "16px"
	},
	pt4: {
		"paddingTop": "16px"
	},
	size15: {
		"width": "6px",
		"height": "6px"
	},
	scale067: {
		"scale": ".67"
	},
	bgWhite: {
		"backgroundColor": "var(--color-white)"
	},
	bgWhite30: {
		"backgroundColor": "#ffffff4d",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in oklab, var(--color-white) 30%, transparent)"
		}
	},

	cursorCrosshair: {
		"cursor": "crosshair"
	},
	cursorGrab: {
		"cursor": "grab"
	},
	cursorZoomIn: {
		"cursor": "zoom-in"
	},

	transitionOpacityTransform: {
		"transitionProperty": "opacity,transform",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	pbMax14pxEnvSafeAreaInsetBottom: {
		"paddingBottom": "max(14px, env(safe-area-inset-bottom))"
	},
	transitionWidthHeightOpacity: {
		"transitionProperty": "width,height,opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	transitionScaleBackgroundColor: {
		"transitionProperty": "scale,background-color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},

	shadow0009999pxRgb00005: {
		"--tw-shadow": "0 0 0 9999px var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 50%, transparent))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	shadow0001pxRgb000022: {
		"--tw-shadow": "0 0 0 1px var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 22%, transparent))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	phoneH100dvh: {
		"@media (max-width: 720px)": {
			"height": "100dvh"
		}
	},
	phoneBgBlack: {
		"@media (max-width: 720px)": {
			"backgroundColor": "var(--color-black)"
		}
	},
	h10: {
		"height": "40px"
	},
	w10: {
		"width": "40px"
	},
	bgWhite10: {
		"backgroundColor": "color-mix(in srgb, var(--color-white) 10%, transparent)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in oklab, var(--color-white) 10%, transparent)"
		}
	},
	hoverBgWhite20: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "color-mix(in srgb, var(--color-white) 20%, transparent)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in oklab, var(--color-white) 20%, transparent)"
				}
			}
		}
	},
	phoneH11: {
		"@media (max-width: 720px)": {
			"height": "44px"
		}
	},
	phoneW11: {
		"@media (max-width: 720px)": {
			"width": "44px"
		}
	},
	lineClamp2: {
		"WebkitLineClamp": "2",
		"WebkitBoxOrient": "vertical",
		"display": "-webkit-box",
		"overflow": "hidden"
	},
	snapX: {
		"scrollSnapType": "x var(--tw-scroll-snap-strictness)"
	},
	transitionTransformBackgroundColorOpacity: {
		"transitionProperty": "transform,background-color,opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	durationVarDurMicro: {
		"--tw-duration": "var(--dur-micro)",
		"transitionDuration": "var(--dur-micro)"
	},
	activeScale096: {
		":active": {
			"scale": ".96"
		}
	},
	disabledOpacity035: {
		":disabled": {
			"opacity": ".35"
		}
	},
	shadowInset01px0Rgb255255255008012px44pxRgb00005: {
		"--tw-shadow": "inset 0 1px 0 var(--tw-shadow-color,color-mix(in srgb, var(--color-white) 8%, transparent)), 0 12px 44px var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 50%, transparent))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	backdropBlur2xl: {
		"--tw-backdrop-blur": "blur(40px)",
		"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
		"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
	},
	backdropSaturate150: {
		"--tw-backdrop-saturate": "saturate(150%)",
		"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
		"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
	},
	hoverBgWhite10: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "color-mix(in srgb, var(--color-white) 10%, transparent)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in oklab, var(--color-white) 10%, transparent)"
				}
			}
		}
	},
	hoverTextWhite: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--color-white)"
			}
		}
	},
	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
	shadowInset01px0Rgb255255255008016px50pxRgb00005: {
		"--tw-shadow": "inset 0 1px 0 var(--tw-shadow-color,color-mix(in srgb, var(--color-white) 8%, transparent)), 0 16px 50px var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 50%, transparent))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	placeholderTextWhite45: {
		"::placeholder": {
			"color": "color-mix(in srgb, var(--color-white) 45%, transparent)"
		},
		"@supports (color: color-mix(in lab, red, red))": {
			"::placeholder": {
				"color": "color-mix(in oklab, var(--color-white) 45%, transparent)"
			}
		}
	},
	phoneTextInputPhone: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-input-phone)"
		}
	},
	phoneSize11: {
		"@media (max-width: 720px)": {
			"width": "44px",
			"height": "44px"
		}
	},
	activeScale094: {
		":active": {
			"scale": ".94"
		}
	},
	disabledBgWhite15: {
		":disabled": {
			"backgroundColor": "color-mix(in srgb, var(--color-white) 15%, transparent)"
		},
		"@supports (color: color-mix(in lab, red, red))": {
			":disabled": {
				"backgroundColor": "color-mix(in oklab, var(--color-white) 15%, transparent)"
			}
		}
	},
	disabledTextWhite40: {
		":disabled": {
			"color": "color-mix(in srgb, var(--color-white) 40%, transparent)"
		},
		"@supports (color: color-mix(in lab, red, red))": {
			":disabled": {
				"color": "color-mix(in oklab, var(--color-white) 40%, transparent)"
			}
		}
	},
	maxWMin720px90vw: {
		"maxWidth": "min(720px,90vw)"
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
});

/**
 * Full-screen lightbox for all in-app media: workspace-media thumbnails (the
 * sidebar hover card, the mobile sheet, and the WorkspaceInfo panel) and any
 * session media (markdown images, pasted-image attachments, tool-result
 * screenshots and recordings), with prev/next browsing instead of jumping to
 * the raw file in a new tab — which for data:/blob URLs browsers block,
 * leaving an empty window.
 *
 * Images are zoomable: pinch on touch (iOS PWA included — pointer events +
 * touch-action:none, no native gesture dependence), double-tap/double-click
 * to toggle, wheel/trackpad on desktop, one-finger pan while zoomed.
 *
 * Global singleton: the thumbnails live inside transient popovers — the
 * hover card unmounts on mouseleave/scroll — so the modal is hosted once in
 * App and opened imperatively via openLightbox(), surviving its opener.
 * Session media is wired through a delegated capture-phase click listener here
 * (rather than per-component onClicks) because markdown images are injected
 * via dangerouslySetInnerHTML and can't carry React handlers.
 */

export interface LightboxItem {
	kind: "image" | "video" | "diagram";
	src: string;
	/** kind "diagram" only: the live SVG to draw, so that zooming a chart to
	 * read its labels keeps them sharp instead of magnifying pixels. `src` is
	 * the same diagram as a file, which is all Download needs — and being a
	 * data: URL, it also opts the link actions out (see below). */
	diagram?: DiagramMedia;
	walkthroughLabel?: WalkthroughMediaLabel;
	sessionTitle?: string;
	description?: string;
	at?: string;
	/** Session that owns this transcript image. Only these images can send a
	 *  selected region back into chat. */
	commentSessionId?: string;
}

interface LightboxState {
	items: LightboxItem[];
	index: number;
	id: number;
	origin?: HTMLElement;
	originIndex: number;
	useHeroTransition: boolean;
	startCommenting?: boolean;
}

interface LightboxRequest {
	items: LightboxItem[];
	index: number;
	origin?: HTMLElement;
	/** Enter image-region comment mode as soon as the lightbox opens. */
	startCommenting?: boolean;
}

interface ViewTransitionHandle {
	finished: Promise<void>;
	skipTransition(): void;
}

/** `focusVisible` is honoured by Chromium/Firefox but not yet in TypeScript's
 * DOM lib; browsers without it just fall back to their own heuristic. */
type FocusOptionsWithVisible = FocusOptions & { focusVisible?: boolean };

type ViewTransitionDocument = Document & {
	startViewTransition?: (update: () => void) => ViewTransitionHandle;
};

const HERO_TRANSITION_NAME = "lightbox-media";
let nextLightboxId = 0;
let host: ((request: LightboxRequest) => void) | null = null;

const LIGHTBOX_TRANSITION_CSS = `
html[data-lightbox-transition="opening"]::view-transition-old(root),
html[data-lightbox-transition="closing"]::view-transition-new(root) {
  animation: none;
}

html[data-lightbox-transition="opening"]::view-transition-new(root) {
  animation: lightbox-root-in var(--dur) var(--ease) both;
}

/* Exit is a tier faster than the enter: opening is the deliberate act and can
   take its time, closing is the system getting out of the way. */
html[data-lightbox-transition="closing"]::view-transition-old(root) {
  animation: lightbox-root-out var(--dur-micro) var(--ease) both;
}

::view-transition-group(${HERO_TRANSITION_NAME}) {
  z-index: 11001;
  animation-duration: var(--dur-lg);
  animation-timing-function: var(--ease);
}

::view-transition-old(${HERO_TRANSITION_NAME}),
::view-transition-new(${HERO_TRANSITION_NAME}) {
  mix-blend-mode: normal;
}

@keyframes lightbox-root-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes lightbox-root-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
`;

function mediaElement(origin?: Element | null): HTMLElement | undefined {
	if (!(origin instanceof HTMLElement)) return undefined;
	if (origin.matches("img, video")) return origin;
	return origin.querySelector<HTMLElement>("img, video") || origin;
}

function canMorphFrom(origin?: HTMLElement): origin is HTMLElement {
	if (!origin?.isConnected) return false;
	const rect = origin.getBoundingClientRect();
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.right > 0 &&
		rect.bottom > 0 &&
		rect.left < window.innerWidth &&
		rect.top < window.innerHeight
	);
}

function setTransitionName(element: HTMLElement, name: string): () => void {
	const previous = element.style.viewTransitionName;
	let restored = false;
	element.style.viewTransitionName = name;
	return () => {
		if (restored) return;
		restored = true;
		element.style.viewTransitionName = previous;
	};
}

function markTransition(phase: "opening" | "closing", id: number): () => void {
	const root = document.documentElement;
	const token = String(id);
	root.dataset.lightboxTransition = phase;
	root.dataset.lightboxTransitionId = token;
	return () => {
		if (root.dataset.lightboxTransitionId !== token) return;
		delete root.dataset.lightboxTransition;
		delete root.dataset.lightboxTransitionId;
	};
}

function supportsHeroTransition(): boolean {
	return (
		typeof (document as ViewTransitionDocument).startViewTransition === "function" &&
		!window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

function commentSessionIdFor(element?: Element | null): string | undefined {
	return element
		?.closest<HTMLElement>("[data-lightbox-session-id]")
		?.dataset.lightboxSessionId;
}

export function openLightbox(
	items: (LightboxItem | WorkspaceMediaItem)[],
	index: number,
	origin?: Element | null,
	options: { startCommenting?: boolean } = {},
) {
	const source = mediaElement(origin);
	const fromDom = commentSessionIdFor(source);
	host?.({
		// A workspace-media item names its own session, which is the only hint a
		// gallery outside the transcript (the Shots panel, a hover card) has: the
		// clicked thumbnail has no transcript ancestor to read the id off.
		items: items.map((item) => {
			if (item.kind !== "image") return item;
			const commentSessionId =
				("commentSessionId" in item ? item.commentSessionId : undefined) ||
				("sessionId" in item ? item.sessionId : undefined) ||
				fromDom;
			return commentSessionId ? { ...item, commentSessionId } : item;
		}),
		index,
		origin: source,
		startCommenting: options.startCommenting,
	});
}

/** Every piece of session media currently in the DOM, in document order —
 * markdown images/videos, pasted attachments, tool-result screenshots. */
const GALLERY_SELECTOR = "img.md-image, video.md-video, .md-mermaid > svg";

/** One node as an item, or null when it cannot be shown: a diagram whose
 * markup never says how big it is has nothing to letterbox. */
function galleryItem(node: Element): LightboxItem | null {
	if (node.tagName === "IMG" || node.tagName === "VIDEO") {
		const media = node as HTMLImageElement | HTMLVideoElement;
		return {
			kind: node.tagName === "VIDEO" ? "video" : "image",
			src:
				node.tagName === "IMG"
					? (media as HTMLImageElement).currentSrc || media.src
					: media.src,
			commentSessionId:
				node.tagName === "IMG" ? commentSessionIdFor(node) : undefined,
			// Markdown alt text is the only description these carry; captioning the
			// viewer with it beats a bare counter once you are paging through a
			// dozen screenshots.
			sessionTitle: (node as HTMLImageElement).alt?.trim() || undefined,
		};
	}
	const diagram = readDiagramSvg(node.outerHTML);
	return diagram
		? { kind: "diagram", src: diagramDataUrl(diagram.svg), diagram }
		: null;
}

/** Open the lightbox on `el`, with prev/next browsing across all session media
 * currently on screen (a conversation-wide gallery). */
export function openGalleryFrom(el: Element) {
	const shown = Array.from(document.querySelectorAll(GALLERY_SELECTOR)).flatMap(
		(node) => {
			const item = galleryItem(node);
			return item ? [{ node, item }] : [];
		},
	);
	if (shown.length === 0) return;
	openLightbox(
		shown.map((entry) => entry.item),
		Math.max(
			0,
			shown.findIndex((entry) => entry.node === el),
		),
		el,
	);
}

/** The diagram a click is about: anywhere on the rendered chart, or the expand
 * button beside it (which is also what Enter and Space on that button
 * dispatch). Diagram labels are real text, so a click that ends a selection is
 * someone copying a node name, not asking for a viewer — the button stays
 * unambiguous either way. */
function diagramFor(target: Element): Element | null {
	const svg = target
		.closest?.(".md-mermaid-wrap")
		?.querySelector(".md-mermaid > svg");
	if (!svg) return null;
	if (target.closest?.("button.md-diagram-expand")) return svg;
	const selection = window.getSelection();
	const selecting =
		selection &&
		!selection.isCollapsed &&
		selection.anchorNode &&
		svg.contains(selection.anchorNode);
	return selecting ? null : svg;
}

export function MediaLightboxHost() {
	const [state, setState] = useState<LightboxState | null>(null);
	const activeTransition = useRef<ViewTransitionHandle | null>(null);
	const activeSourceCleanup = useRef<(() => void) | null>(null);
	useEffect(() => {
		const open = (request: LightboxRequest) => {
			nextLightboxId += 1;
			const id = nextLightboxId;
			const origin = mediaElement(request.origin);
			const next: LightboxState = {
				...request,
				id,
				origin,
				originIndex: request.index,
				useHeroTransition: false,
			};
			const item = request.items[request.index];
			if (item?.kind !== "image" || !canMorphFrom(origin) || !supportsHeroTransition()) {
				setState(next);
				return;
			}

			activeTransition.current?.skipTransition();
			activeSourceCleanup.current?.();
			const restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
			activeSourceCleanup.current = restoreOrigin;
			const clearTransitionMark = markTransition("opening", id);
			try {
				const transition = (document as ViewTransitionDocument).startViewTransition!(() => {
					// The source belongs only to the old snapshot. Removing its name before
					// React mounts the destination avoids duplicate named elements.
					restoreOrigin();
					if (activeSourceCleanup.current === restoreOrigin) {
						activeSourceCleanup.current = null;
					}
					flushSync(() => setState({ ...next, useHeroTransition: true }));
				});
				activeTransition.current = transition;
				const finish = () => {
					if (activeTransition.current === transition) activeTransition.current = null;
					clearTransitionMark();
				};
				void transition.finished.then(finish, finish);
			} catch {
				restoreOrigin();
				if (activeSourceCleanup.current === restoreOrigin) {
					activeSourceCleanup.current = null;
				}
				clearTransitionMark();
				setState(next);
			}
		};
		host = open;
		return () => {
			if (host === open) host = null;
			activeTransition.current?.skipTransition();
			activeSourceCleanup.current?.();
		};
	}, []);
	// Delegated capture-phase listener: intercept plain left-clicks on any
	// session image and open the gallery instead of following the wrapping
	// <a target="_blank"> (kept for cmd/middle-click open-in-tab). Videos are
	// not intercepted — clicks there drive the native controls.
	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (
				e.defaultPrevented ||
				e.button !== 0 ||
				e.metaKey ||
				e.ctrlKey ||
				e.shiftKey ||
				e.altKey
			)
				return;
			const target = e.target as HTMLElement;
			// Enter on the focused link dispatches a click whose target is the
			// wrapping <a>, not the <img> inside it — match both, or keyboard
			// activation falls through to the raw file in a new tab.
			const media =
				target.closest?.("img.md-image") ||
				target.closest?.("a.md-image-link")?.querySelector("img.md-image") ||
				diagramFor(target);
			if (!media) return;
			e.preventDefault();
			e.stopPropagation();
			openGalleryFrom(media);
		}
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	function close(current: LightboxState, allowHeroTransition = true) {
		const item = current.items[current.index];
		const origin = current.origin;
		const canReturn =
			allowHeroTransition &&
			current.useHeroTransition &&
			current.index === current.originIndex &&
			item?.kind === "image" &&
			canMorphFrom(origin) &&
			supportsHeroTransition();

		if (!canReturn) {
			// Native transitions don't need Motion's lifecycle. If the source has
			// disappeared (for example, a hover card closed), opt back into the
			// fallback for one frame so the viewer still leaves gracefully.
			activeTransition.current?.skipTransition();
			activeTransition.current = null;
			activeSourceCleanup.current?.();
			activeSourceCleanup.current = null;
			if (document.documentElement.dataset.lightboxTransitionId === String(current.id)) {
				delete document.documentElement.dataset.lightboxTransition;
				delete document.documentElement.dataset.lightboxTransitionId;
			}
			setState({ ...current, useHeroTransition: false });
			requestAnimationFrame(() => {
				setState((latest) => (latest?.id === current.id ? null : latest));
			});
			return;
		}

		activeTransition.current?.skipTransition();
		activeSourceCleanup.current?.();
		activeSourceCleanup.current = null;
		const clearTransitionMark = markTransition("closing", current.id);
		let restoreOrigin: (() => void) | undefined;
		try {
			const transition = (document as ViewTransitionDocument).startViewTransition!(() => {
				// The target belongs only to the old snapshot; name the source after
				// that capture so it becomes the destination in the new snapshot.
				restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
				activeSourceCleanup.current = restoreOrigin;
				flushSync(() => setState(null));
			});
			activeTransition.current = transition;
			const finish = () => {
				restoreOrigin?.();
				if (activeSourceCleanup.current === restoreOrigin) {
					activeSourceCleanup.current = null;
				}
				if (activeTransition.current === transition) activeTransition.current = null;
				clearTransitionMark();
			};
			void transition.finished.then(finish, finish);
		} catch {
			restoreOrigin?.();
			if (activeSourceCleanup.current === restoreOrigin) {
				activeSourceCleanup.current = null;
			}
			clearTransitionMark();
			setState(null);
		}
	}

	const lightbox = state ? (
		<MediaLightbox
			key={state.id}
			items={state.items}
			index={state.index}
			onIndex={(index) =>
				setState((latest) =>
					latest?.id === state.id ? { ...latest, index } : latest,
				)
			}
			onClose={(allowHeroTransition) => close(state, allowHeroTransition)}
			useHeroTransition={state.useHeroTransition}
			startCommenting={state.startCommenting}
			heroTransitionName={
				state.useHeroTransition && state.index === state.originIndex
					? HERO_TRANSITION_NAME
					: undefined
			}
		/>
	) : null;

	return (
		<>
			<style>{LIGHTBOX_TRANSITION_CSS}</style>
			{state?.useHeroTransition ? (
				lightbox
			) : (
				<AnimatePresence initial={false}>{lightbox}</AnimatePresence>
			)}
		</>
	);
}

function extFromMime(mime: string): string {
	const sub = mime.split("/")[1]?.split(";")[0] || "";
	const special: Record<string, string> = {
		jpeg: "jpg",
		"svg+xml": "svg",
		quicktime: "mov",
		"x-matroska": "mkv",
	};
	return special[sub] || sub || "bin";
}

function suggestedName(item: LightboxItem): string {
	if (!item.src.startsWith("data:") && !item.src.startsWith("blob:")) {
		try {
			const url = new URL(item.src, location.href);
			// The media route carries the real file in `?path=`, so its basename
			// is the name the file actually has — the route's own basename is
			// just "media".
			const from = url.searchParams.get("path") || url.pathname;
			const base = decodeURIComponent(from.split("/").pop() || "");
			if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
		} catch {}
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const mime = /^data:([^;,]+)/.exec(item.src)?.[1];
	const ext = mime ? extFromMime(mime) : item.kind === "video" ? "mp4" : "png";
	return `${item.kind}-${stamp}.${ext}`;
}

/**
 * Where Download points. It is a real link, not a fetch→blob→ObjectURL dance:
 * the blob route buffered whole videos in memory, lost the file's own name,
 * and on any failure fell back to window.open(), which a popup blocker eats
 * silently — leaving a Download button that does nothing. `?download=1` asks
 * our own routes for an attachment disposition, so the file saves instead of
 * opening in a tab. Do not also put the `download` attribute on server-backed
 * links: installed iOS PWAs route those through their preview controller
 * instead of the browser's attachment handling.
 */
function downloadHref(item: LightboxItem): string {
	if (item.src.startsWith("data:") || item.src.startsWith("blob:"))
		return item.src;
	try {
		const url = new URL(item.src, location.href);
		if (url.origin === location.origin) url.searchParams.set("download", "1");
		return url.href;
	} catch {
		return item.src;
	}
}

/** The item's own URL, absolute, for pasting somewhere outside the app. */
function shareableSrc(item: LightboxItem): string {
	try {
		return new URL(item.src, location.href).href;
	} catch {
		return item.src;
	}
}

const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;

/** Air between a diagram and its own edge, so the drawing is not flush against
 * the corner of the surface it sits on. */
const DIAGRAM_PADDING = 16;

/** How far a slow downward drag has to travel before letting go closes. A
 * flick gets there sooner. */
const DISMISS_DISTANCE = 120;

/**
 * Pinch/pan/zoom surface for one image, or for one diagram — a mermaid chart
 * keeps its vector markup here rather than arriving as a picture, so the
 * labels stay sharp all the way up. The wrapper (not the letterboxed media)
 * owns the gesture so pinches starting beside the photo still work; transforms
 * are written straight to the media's style (no per-move re-render). A clean
 * tap on the backdrop area of the wrapper closes — unless it's the first half
 * of a double-tap on the media, which zooms instead.
 *
 * At the fit scale a horizontal drag pages to the neighbouring item instead:
 * the picture follows the finger and either carries on to the next one or
 * springs back, which is how every photo viewer on a phone behaves. It only
 * arms once the drag is decidedly horizontal, so a pinch or a vertical flick
 * never steals a page turn, and zoomed in the same drag pans the photo.
 */
/** Corners first, then edges: the corner is what the hand reaches for, and on
 *  a short side it is the only handle that fits. `sx`/`sy` are the directions
 *  the handle lies in from the region's middle, which is both where it sits and
 *  which way it steps when the region is too small to hold it.
 *
 *  `mark` is what the handle draws, which is not the same thing as what it
 *  catches. A corner is a bracket whose two bars run along the edges they
 *  resize, meeting exactly on the corner; an edge is a short bar lying along
 *  the line it moves. Both are white with a soft dark halo, because the picture
 *  underneath is as likely to be a white settings pane as a dark one. */
const REGION_HANDLES: {
	id: RegionHandle;
	/** The side whose length has to be long enough to hold this handle. */
	axis?: "x" | "y";
	position: string;
	cursor: string;
	mark: string;
	sx: -1 | 0 | 1;
	sy: -1 | 0 | 1;
}[] = [
	{ id: "nw", position: "left-0 top-0", sx: -1, sy: -1, cursor: "cursor-nwse-resize", mark: "absolute left-1/2 top-1/2 size-3.5 rounded-tl-[4px] border-l-[3px] border-t-[3px] phone:size-4" },
	{ id: "ne", position: "left-full top-0", sx: 1, sy: -1, cursor: "cursor-nesw-resize", mark: "absolute right-1/2 top-1/2 size-3.5 rounded-tr-[4px] border-r-[3px] border-t-[3px] phone:size-4" },
	{ id: "se", position: "left-full top-full", sx: 1, sy: 1, cursor: "cursor-nwse-resize", mark: "absolute right-1/2 bottom-1/2 size-3.5 rounded-br-[4px] border-r-[3px] border-b-[3px] phone:size-4" },
	{ id: "sw", position: "left-0 top-full", sx: -1, sy: 1, cursor: "cursor-nesw-resize", mark: "absolute left-1/2 bottom-1/2 size-3.5 rounded-bl-[4px] border-l-[3px] border-b-[3px] phone:size-4" },
	{ id: "n", axis: "x", position: "left-1/2 top-0", sx: 0, sy: -1, cursor: "cursor-ns-resize", mark: "h-[3px] w-5 rounded-full bg-white" },
	{ id: "s", axis: "x", position: "left-1/2 top-full", sx: 0, sy: 1, cursor: "cursor-ns-resize", mark: "h-[3px] w-5 rounded-full bg-white" },
	{ id: "w", axis: "y", position: "left-0 top-1/2", sx: -1, sy: 0, cursor: "cursor-ew-resize", mark: "h-5 w-[3px] rounded-full bg-white" },
	{ id: "e", axis: "y", position: "left-full top-1/2", sx: 1, sy: 0, cursor: "cursor-ew-resize", mark: "h-5 w-[3px] rounded-full bg-white" },
];

/** Touch-sized on a phone, pointer-sized otherwise. */
const REGION_HANDLE_HIT = { phone: 36, desktop: 24 };

function ZoomableMedia({
	src,
	diagram,
	onTapBackdrop,
	onTapMedia,
	onZoomChange,
	onSwipe,
	onDismiss,
	onDragProgress,
	enterFrom = 0,
	viewTransitionName,
	commentMode = false,
	selection,
	onSelection,
	onSelectionRect,
}: {
	src: string;
	/** Present for a diagram: draw this markup instead of loading `src`. */
	diagram?: DiagramMedia;
	onTapBackdrop: () => void;
	/** A clean single tap on the media. Omitted on desktop, where a tap keeps
	 * waiting for the existing double-tap zoom gesture. */
	onTapMedia?: () => void;
	onZoomChange: (zoomed: boolean) => void;
	/** Page to the previous (-1) / next (+1) item; absent when there is one. */
	onSwipe?: (direction: -1 | 1) => void;
	/** A touch drag downwards past the threshold closes. Absent on desktop,
	 *  where dragging a picture is not how anything is dismissed. */
	onDismiss?: () => void;
	/** How far that drag has got, 0 to 1, so the scrim can lift with it. */
	onDragProgress?: (progress: number) => void;
	/** Direction the previous item left in, so this one enters from the far
	 * side; 0 for the first item shown. */
	enterFrom?: -1 | 0 | 1;
	viewTransitionName?: string;
	/** Region-comment mode replaces pan/page gestures with a box selection. */
	commentMode?: boolean;
	selection?: ImageRegion | null;
	onSelection?: (region: ImageRegion) => void;
	/** Where the committed selection sits on screen, so the comment card can be
	 *  placed against it. Viewport coordinates. */
	onSelectionRect?: (rect: ScreenRect | null) => void;
}) {
	const isPhone = useIsPhone();
	const wrapRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	/** The element the transform is written to, whichever kind is on screen. */
	const mediaEl = () => (diagram ? boxRef.current : imgRef.current);
	/** Cached layoutOrigin(), see there. Null means "measure on next read". */
	const layout = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
	const t = useRef({ s: 1, tx: 0, ty: 0 });
	/** The in-progress drag written to the wrapper: sideways for a page turn,
	 * downwards for a dismissal. */
	const drag = useRef({ x: 0, y: 0 });
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const gesture = useRef<{
		moved: boolean;
		downTarget: EventTarget | null;
		downAt: number;
		p0: { x: number; y: number };
		t0: { s: number; tx: number; ty: number };
		d0: number;
		m0: { x: number; y: number };
		pinched: boolean;
		/** null while the drag's intent is still undecided. */
		swiping: boolean | null;
		/** Decided at the same moment as `swiping`, and never both. */
		dismissing: boolean;
	} | null>(null);
	const lastTap = useRef<{
		at: number;
		x: number;
		y: number;
		media: boolean;
	} | null>(null);
	const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [zoomed, setZoomed] = useState(false);
	const zoomedRef = useRef(false);
	const regionGesture = useRef<
		| {
				kind: "create";
				pointerId: number;
				start: ImageRegionPoint;
				imageRect: DOMRect;
		  }
		| {
				kind: "adjust";
				handle: RegionHandle;
				origin: ImageRegion;
				pointerId: number;
				start: ImageRegionPoint;
				imageRect: DOMRect;
		  }
		| null
	>(null);
	const [draftRegion, setDraftRegion] = useState<ImageRegion | null>(null);
	const [imageBox, setImageBox] = useState<{
		left: number;
		top: number;
		width: number;
		height: number;
		/** The same box in viewport coordinates, for the fixed comment card. */
		viewLeft: number;
		viewTop: number;
	} | null>(null);
	/** A diagram's box, fitted to the surface. Unlike a photo, a chart has no
	 * natural pixel size to hold it back — its viewBox is arbitrary units — so
	 * it fills the room available rather than stopping at 1:1. Sized here in JS
	 * rather than by CSS on the svg because the gesture code needs a real box
	 * to measure the zoom and pan bounds against. */
	const [fit, setFit] = useState<{ w: number; h: number } | null>(null);

	function cancelSingleTap() {
		if (singleTapTimer.current === null) return;
		clearTimeout(singleTapTimer.current);
		singleTapTimer.current = null;
	}

	useEffect(() => cancelSingleTap, [src, commentMode]);

	useLayoutEffect(() => {
		if (!diagram) return;
		const measure = () => {
			const wrap = wrapRef.current;
			if (!wrap) return;
			const room = {
				w: wrap.clientWidth - DIAGRAM_PADDING * 2,
				h: wrap.clientHeight - DIAGRAM_PADDING * 2,
			};
			const scale = Math.min(room.w / diagram.size.w, room.h / diagram.size.h);
			if (!(scale > 0) || !Number.isFinite(scale)) return;
			setFit({
				w: Math.round(diagram.size.w * scale) + DIAGRAM_PADDING * 2,
				h: Math.round(diagram.size.h * scale) + DIAGRAM_PADDING * 2,
			});
			layout.current = null;
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [diagram]);

	function apply(animate = false) {
		const img = mediaEl();
		if (!img) return;
		const { s, tx, ty } = t.current;
		img.style.transition = animate ? "transform 0.18s ease-out" : "none";
		img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
		const nextZoomed = s > 1;
		if (nextZoomed !== zoomedRef.current) {
			zoomedRef.current = nextZoomed;
			setZoomed(nextZoomed);
			onZoomChange(nextZoomed);
		}
	}

	/** The drag offset, written to the wrapper so it composes with the img's
	 * own zoom transform instead of fighting it. A downward drag also shrinks
	 * the picture, which is what makes it read as being put back rather than
	 * slid aside. */
	function applyDrag(dx: number, dy = 0, animate = false) {
		drag.current = { x: dx, y: dy };
		const wrap = wrapRef.current;
		if (!wrap) return;
		wrap.style.transition = animate
			? "transform 0.24s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.24s ease-out"
			: "none";
		const pull = Math.max(0, dy);
		const scale = 1 - Math.min(pull / 1600, 0.12);
		wrap.style.transform =
			dx || dy ? `translate(${dx}px, ${dy}px) scale(${scale})` : "";
		// A touch of fade sells the hand-off; the picture stays legible enough
		// to see what you are dragging towards, or away from.
		const fade =
			Math.min(Math.abs(dx) / 900, 0.3) + Math.min(pull / 700, 0.45);
		wrap.style.opacity = dx || dy ? String(1 - fade) : "1";
		onDragProgress?.(Math.min(pull / DISMISS_DISTANCE, 1));
	}

	// The item is keyed by src, so a page turn mounts a fresh surface: slide it
	// in from the side the drag was heading, which is the only cue that the
	// picture changed rather than reloaded.
	// Interaction helpers are read through effect events so the effects that
	// reach them keep their narrow triggers without listing unstable closures.
	const effectApplyDrag = useEffectEvent(applyDrag);
	const effectZoomAt = useEffectEvent(zoomAt);
	const effectOnZoomChange = useEffectEvent(onZoomChange);
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!enterFrom || !wrap) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		// The wrapper is translated for the length of this, so the img's rect is
		// in motion and must not be cached from it.
		layout.current = null;
		effectApplyDrag(enterFrom * Math.min(140, window.innerWidth * 0.25));
		const frame = requestAnimationFrame(() => effectApplyDrag(0, 0, true));
		return () => cancelAnimationFrame(frame);
	}, [enterFrom, src]);

	/** The img's layout (untransformed) viewport rect — transform-origin is 0 0,
	 * so the rendered top-left is layout top-left + current translation.
	 *
	 * Cached, because reading it is a layout read and the callers sit between
	 * transform writes: measuring per pointer event forces a synchronous reflow
	 * on every frame of a pinch or pan, at up to the pointer's rate. The value
	 * it returns is by construction independent of the transform, so nothing
	 * a gesture does can invalidate it — only a real layout change can. */
	function layoutOrigin() {
		if (layout.current) return layout.current;
		const img = mediaEl()!;
		const r = img.getBoundingClientRect();
		const { s, tx, ty } = t.current;
		return (layout.current = {
			x: r.left - tx,
			y: r.top - ty,
			w: r.width / s,
			h: r.height / s,
		});
	}
	// The picture's box moves with the viewport, and moves again when a new src
	// decodes at a different aspect. Each gesture also re-measures on its first
	// press: the wrapper carries the page-turn translation, so a box read while
	// that is running describes where the picture was, not where it settles.
	useEffect(() => {
		const forget = () => {
			layout.current = null;
		};
		window.addEventListener("resize", forget);
		return () => window.removeEventListener("resize", forget);
	}, []);
	useEffect(() => {
		layout.current = null;
	}, [src]);

	// Chrome visibility changes the fitted room on a phone. Forget the old
	// geometry throughout that refit so the next pan or zoom starts from what is
	// actually on screen.
	useLayoutEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		const observer = new ResizeObserver(() => {
			layout.current = null;
		});
		observer.observe(wrap);
		return () => observer.disconnect();
	}, []);

	// A region is stored against the image, while its outline is painted against
	// the lightbox wrapper. Keep that projection current when a phone keyboard,
	// a rotation, or a decoded image changes the fitted box.
	useLayoutEffect(() => {
		if (!commentMode || diagram) {
			setImageBox(null);
			return;
		}
		// Reset before measuring. A transformed getBoundingClientRect would map
		// the selection against the old zoom level until the next resize.
		t.current = { s: 1, tx: 0, ty: 0 };
		const media = diagram ? boxRef.current : imgRef.current;
		if (media) {
			media.style.transition = "none";
			media.style.transform = "translate(0px, 0px) scale(1)";
		}
		if (zoomedRef.current) {
			zoomedRef.current = false;
			setZoomed(false);
			effectOnZoomChange(false);
		}
		const measure = () => {
			const wrap = wrapRef.current;
			const image = imgRef.current;
			if (!wrap || !image || !image.complete) return;
			const wrapRect = wrap.getBoundingClientRect();
			const imageRect = image.getBoundingClientRect();
			const next = {
				left: imageRect.left - wrapRect.left,
				top: imageRect.top - wrapRect.top,
				width: imageRect.width,
				height: imageRect.height,
				viewLeft: imageRect.left,
				viewTop: imageRect.top,
			};
			setImageBox((current) =>
				current &&
				Math.abs(current.left - next.left) < 0.25 &&
				Math.abs(current.top - next.top) < 0.25 &&
				Math.abs(current.width - next.width) < 0.25 &&
				Math.abs(current.height - next.height) < 0.25 &&
				Math.abs(current.viewLeft - next.viewLeft) < 0.25 &&
				Math.abs(current.viewTop - next.viewTop) < 0.25
					? current
					: next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		if (wrapRef.current) observer.observe(wrapRef.current);
		if (imgRef.current) observer.observe(imgRef.current);
		window.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("resize", measure);
		};
	}, [commentMode, diagram, src]);

	// Selection needs the fitted, untransformed image. Entering comment mode
	// returns a zoomed or panned image to fit before the first drag.
	useEffect(() => {
		if (!commentMode) {
			regionGesture.current = null;
			setDraftRegion(null);
			return;
		}
		pointers.current.clear();
		gesture.current = null;
		lastTap.current = null;
		cancelSingleTap();
	}, [commentMode, src]);

	/** Keep the scaled image covering the viewport (or centered when smaller).
	 * Bounds are the full screen, not the letterboxed wrapper — a zoomed photo
	 * should spread under the floating chrome like a native photo viewer, not
	 * clip at the wrapper edges. */
	function clamp(next: { s: number; tx: number; ty: number }) {
		if (!mediaEl()) return next;
		const C = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
		const o = layoutOrigin();
		const clampAxis = (
			pos: number, // desired translation on this axis
			origin: number,
			size: number,
			cStart: number,
			cSize: number,
		) => {
			const scaled = size * next.s;
			if (scaled <= cSize) return cStart + (cSize - scaled) / 2 - origin;
			const min = cStart + cSize - scaled - origin;
			const max = cStart - origin;
			return Math.min(max, Math.max(min, pos));
		};
		return {
			s: next.s,
			tx: clampAxis(next.tx, o.x, o.w, C.left, C.width),
			ty: clampAxis(next.ty, o.y, o.h, C.top, C.height),
		};
	}

	/** Rescale to `sNew` keeping the viewport point `p` fixed on the image. */
	function zoomAt(p: { x: number; y: number }, sNew: number, animate = false) {
		const o = layoutOrigin();
		const { s, tx, ty } = t.current;
		const ux = (p.x - o.x - tx) / s;
		const uy = (p.y - o.y - ty) / s;
		t.current = clamp({ s: sNew, tx: p.x - o.x - ux * sNew, ty: p.y - o.y - uy * sNew });
		if (t.current.s <= 1.02) t.current = { s: 1, tx: 0, ty: 0 };
		apply(animate);
	}

	function pointInRegionImage(
		x: number,
		y: number,
		rect: DOMRect,
	): ImageRegionPoint {
		return {
			x: Math.min(1, Math.max(0, (x - rect.left) / Math.max(1, rect.width))),
			y: Math.min(1, Math.max(0, (y - rect.top) / Math.max(1, rect.height))),
		};
	}

	function onPointerDown(e: React.PointerEvent) {
		if (commentMode && !diagram) {
			const image = imgRef.current;
			if (!image || e.button !== 0 || !e.isPrimary || regionGesture.current)
				return;
			const rect = image.getBoundingClientRect();
			// A press on the selection itself moves it, and one on a handle
			// resizes it. Read from the target rather than from coordinates: the
			// handles deliberately overhang the region so a thin selection still
			// has something to take hold of.
			const handle = (e.target as HTMLElement | null)
				?.closest?.("[data-region-handle]")
				?.getAttribute("data-region-handle") as RegionHandle | null;
			// A corner handle sits half outside the picture, so only a fresh
			// selection has to start inside it.
			if (
				!handle &&
				(e.clientX < rect.left ||
					e.clientX > rect.right ||
					e.clientY < rect.top ||
					e.clientY > rect.bottom)
			)
				return;
			e.preventDefault();
			wrapRef.current?.setPointerCapture(e.pointerId);
			const start = pointInRegionImage(e.clientX, e.clientY, rect);
			if (handle && selection) {
				regionGesture.current = {
					kind: "adjust",
					handle,
					origin: selection,
					pointerId: e.pointerId,
					start,
					imageRect: rect,
				};
				setDraftRegion(selection);
				return;
			}
			regionGesture.current = {
				kind: "create",
				pointerId: e.pointerId,
				start,
				imageRect: rect,
			};
			setDraftRegion(imageRegionBetween(start, start));
			return;
		}
		// A second interaction cancels a pending single tap. If this press is the
		// second half of a double tap, pointer-up below will zoom instead.
		cancelSingleTap();
		// One measurement per gesture: nothing that happens between here and the
		// last finger up can move the picture's layout box.
		layout.current = null;
		wrapRef.current?.setPointerCapture(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const pts = [...pointers.current.values()];
		if (pts.length === 2) {
			gesture.current = {
				...(gesture.current || {
					moved: false,
					downTarget: e.target,
					downAt: performance.now(),
				}),
				moved: gesture.current?.moved || false,
				downTarget: gesture.current?.downTarget ?? e.target,
				downAt: gesture.current?.downAt ?? performance.now(),
				p0: pts[0],
				t0: { ...t.current },
				d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
				m0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
				pinched: true,
				swiping: false,
				dismissing: false,
			};
			// A second finger means this was never a page turn or a dismissal.
			if (drag.current.x || drag.current.y) applyDrag(0, 0, true);
		} else if (pts.length === 1) {
			gesture.current = {
				moved: false,
				downTarget: e.target,
				downAt: performance.now(),
				p0: pts[0],
				t0: { ...t.current },
				d0: 0,
				m0: pts[0],
				pinched: false,
				swiping: null,
				dismissing: false,
			};
		}
	}

	/** The region this gesture describes with the pointer where it now is. */
	function regionForGesture(
		selecting: NonNullable<typeof regionGesture.current>,
		clientX: number,
		clientY: number,
	): ImageRegion {
		const point = pointInRegionImage(clientX, clientY, selecting.imageRect);
		if (selecting.kind === "create") {
			return imageRegionBetween(selecting.start, point);
		}
		const dx = point.x - selecting.start.x;
		const dy = point.y - selecting.start.y;
		if (selecting.handle === "move") {
			return movedImageRegion(selecting.origin, dx, dy);
		}
		// The same twelve display pixels a new selection has to clear, so a
		// region cannot be resized into something too small to have drawn.
		return resizedImageRegion(selecting.origin, selecting.handle, dx, dy, {
			x: 12 / Math.max(1, selecting.imageRect.width),
			y: 12 / Math.max(1, selecting.imageRect.height),
		});
	}

	function onPointerMove(e: React.PointerEvent) {
		const selecting = regionGesture.current;
		if (selecting?.pointerId === e.pointerId) {
			const next = regionForGesture(selecting, e.clientX, e.clientY);
			setDraftRegion(next);
			// An adjustment changes a region that already has a comment against
			// it, so the card travels with the pixels it is about.
			if (selecting.kind === "adjust") onSelection?.(next);
			return;
		}
		if (!pointers.current.has(e.pointerId) || !gesture.current) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const g = gesture.current;
		const pts = [...pointers.current.values()];
		if (g.pinched && pts.length >= 2) {
			const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
			const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
			// No clamping mid-pinch — fighting the fingers makes the image slide
			// away from the focal point. Bounds are re-imposed on release.
			const sNew = Math.min(MAX_SCALE, Math.max(0.5, (g.t0.s * d) / (g.d0 || 1)));
			const o = layoutOrigin();
			const ux = (g.m0.x - o.x - g.t0.tx) / g.t0.s;
			const uy = (g.m0.y - o.y - g.t0.ty) / g.t0.s;
			t.current = { s: sNew, tx: m.x - o.x - ux * sNew, ty: m.y - o.y - uy * sNew };
			apply();
			g.moved = true;
		} else if (pts.length === 1) {
			const p = pts[0];
			const dx = p.x - g.p0.x;
			const dy = p.y - g.p0.y;
			if (Math.hypot(dx, dy) > 6) {
				g.moved = true;
				cancelSingleTap();
			}
			if (t.current.s > 1 && !g.pinched) {
				t.current = clamp({ s: g.t0.s, tx: g.t0.tx + dx, ty: g.t0.ty + dy });
				apply();
			} else if ((onSwipe || onDismiss) && !g.pinched && t.current.s === 1) {
				// Decide once, at the threshold: a drag that starts out mostly
				// sideways pages to the neighbouring item, one that starts out
				// vertical puts the picture back. Deciding once means the intent
				// can't flip mid-gesture.
				if (g.swiping === null && Math.hypot(dx, dy) > 8) {
					const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
					g.swiping = !!onSwipe && sideways;
					g.dismissing =
						!!onDismiss && !sideways && e.pointerType !== "mouse";
				}
				if (g.swiping) applyDrag(dx);
				// Up is not a dismissal, so it only rubber-bands.
				else if (g.dismissing) applyDrag(dx, dy > 0 ? dy : dy / 3);
			}
		}
	}

	function clearRegionGesture(pointerId: number): boolean {
		if (regionGesture.current?.pointerId !== pointerId) return false;
		regionGesture.current = null;
		setDraftRegion(null);
		return true;
	}

	function onPointerCancel(e: React.PointerEvent) {
		cancelSingleTap();
		lastTap.current = null;
		if (clearRegionGesture(e.pointerId)) return;
		// Settle the transform without letting a canceled gesture page or count as
		// a tap. A pointer capture can be canceled by app switching or a browser
		// gesture even when the finger barely moved.
		if (gesture.current) {
			gesture.current.moved = true;
			gesture.current.swiping = false;
			gesture.current.dismissing = false;
		}
		if (drag.current.x || drag.current.y) applyDrag(0, 0, true);
		onPointerEnd(e);
	}

	const onPointerEnd = (e: React.PointerEvent) => {
		const selecting = regionGesture.current;
		if (selecting?.pointerId === e.pointerId) {
			const region = regionForGesture(selecting, e.clientX, e.clientY);
			clearRegionGesture(e.pointerId);
			// Twelve display pixels filters taps and shaky starts without making a
			// small button impossible to select. An adjustment is already bounded.
			if (
				selecting.kind === "adjust" ||
				(region.width * selecting.imageRect.width >= 12 &&
					region.height * selecting.imageRect.height >= 12)
			) {
				onSelection?.(region);
			}
			return;
		}
		if (!pointers.current.has(e.pointerId)) return;
		const p = { x: e.clientX, y: e.clientY };
		pointers.current.delete(e.pointerId);
		const g = gesture.current;
		if (!g) return;
		const remaining = [...pointers.current.values()];
		if (remaining.length === 1) {
			// Pinch → one finger left: re-anchor so it pans from here.
			g.p0 = remaining[0];
			g.t0 = { ...t.current };
			g.pinched = false;
			g.moved = true;
			return;
		}
		if (remaining.length > 0) return;
		// A page drag resolves on its own terms: past a fifth of the screen, or
		// a flick of any size, hands over to the neighbouring item — otherwise
		// the picture slides back and nothing changed.
		if (g.swiping) {
			const dx = p.x - g.p0.x;
			const speed = Math.abs(dx) / Math.max(1, performance.now() - g.downAt);
			gesture.current = null;
			if (
				Math.abs(dx) > Math.min(120, window.innerWidth * 0.2) ||
				(speed > 0.45 && Math.abs(dx) > 24)
			) {
				onSwipe?.(dx < 0 ? 1 : -1);
			} else {
				applyDrag(0, 0, true);
			}
			return;
		}
		// A drag downwards resolves on the same terms as a page turn: past a
		// fifth of the screen, or a flick of any size, closes — otherwise the
		// picture springs back and nothing changed.
		if (g.dismissing) {
			const dy = p.y - g.p0.y;
			const speed = dy / Math.max(1, performance.now() - g.downAt);
			gesture.current = null;
			if (
				dy > Math.min(DISMISS_DISTANCE, window.innerHeight * 0.2) ||
				(speed > 0.5 && dy > 32)
			) {
				onDismiss?.();
			} else {
				applyDrag(0, 0, true);
			}
			return;
		}
		// Last pointer up — settle back inside bounds (animated) and check taps.
		if (t.current.s <= 1.05) {
			t.current = { s: 1, tx: 0, ty: 0 };
			apply(true);
		} else {
			t.current = clamp({ ...t.current });
			apply(true);
		}
		const isTap =
			!g.moved && e.pointerType !== "mouse"
				? performance.now() - g.downAt < 400
				: !g.moved; // mouse: any clean click counts
		gesture.current = null;
		if (!isTap) return;
		const mediaTap = g.downTarget === imgRef.current;
		const prevTap = lastTap.current;
		lastTap.current = {
			at: performance.now(),
			x: p.x,
			y: p.y,
			media: mediaTap,
		};
		const isDouble =
			mediaTap &&
			prevTap?.media &&
			performance.now() - prevTap.at < 300 &&
			Math.hypot(p.x - prevTap.x, p.y - prevTap.y) < 40;
		if (isDouble) {
			lastTap.current = null;
			cancelSingleTap();
			zoomAt(p, t.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, true);
			return;
		}
		if (mediaTap && onTapMedia) {
			singleTapTimer.current = setTimeout(() => {
				singleTapTimer.current = null;
				onTapMedia();
			}, 300);
			return;
		}
		// A clean tap beside the media keeps the existing backdrop behavior.
		if (g.downTarget === wrapRef.current && t.current.s === 1) onTapBackdrop();
	};

	// Wheel/trackpad zoom. Native non-passive listener — React's onWheel can be
	// passive, and preventDefault must win or the page behind rubber-bands.
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		function onWheel(e: WheelEvent) {
			e.preventDefault();
			const sNew = Math.min(
				MAX_SCALE,
				Math.max(1, t.current.s * Math.exp(-e.deltaY * 0.0022)),
			);
			effectZoomAt({ x: e.clientX, y: e.clientY }, sNew);
		}
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => wrap.removeEventListener("wheel", onWheel);
	}, []);

	// The comment belongs against the region it is about, so the viewer reports
	// where that region landed. Viewport coordinates rather than wrapper ones:
	// the wrapper carries the page-turn translation, and the card is fixed.
	useEffect(() => {
		if (!onSelectionRect) return;
		if (!commentMode || !selection || !imageBox) {
			onSelectionRect(null);
			return;
		}
		onSelectionRect({
			left: imageBox.viewLeft + selection.x * imageBox.width,
			top: imageBox.viewTop + selection.y * imageBox.height,
			width: selection.width * imageBox.width,
			height: selection.height * imageBox.height,
		});
	}, [commentMode, selection, imageBox, onSelectionRect]);

	const handleHit = isPhone ? REGION_HANDLE_HIT.phone : REGION_HANDLE_HIT.desktop;
	const shownRegion = draftRegion ?? selection ?? null;
	const shownRegionBox =
		shownRegion && imageBox
			? {
					left: imageBox.left + shownRegion.x * imageBox.width,
					top: imageBox.top + shownRegion.y * imageBox.height,
					width: shownRegion.width * imageBox.width,
					height: shownRegion.height * imageBox.height,
				}
			: null;

	// A handle centred on the corner of a small region covers the region. Rather
	// than shrink the target below what a finger can hit, step the handles
	// outward so they frame the selection and leave its middle free to press.
	// Large regions keep them on the corners, which is where the eye expects.
	const handlesOutside =
		!!shownRegionBox &&
		Math.min(shownRegionBox.width, shownRegionBox.height) < handleHit * 2;
	const handleStep = shownRegionBox
		? regionHandleStep(handleHit, shownRegionBox.width, shownRegionBox.height)
		: 0;

	return (
		<div
			ref={wrapRef}
			className={[mergeStylexClassName("", sx.relative, sx.flex, sx.minH0, sx.minW0, sx.flex1, sx.touchNone, sx.selectNone, sx.itemsCenter, sx.justifyCenter, sx.selfStretch), commentMode ? mergeStylexClassName("", sx.cursorCrosshair) : zoomed ? mergeStylexClassName("", sx.cursorGrab) : mergeStylexClassName("", sx.cursorZoomIn)].filter(Boolean).join(" ")}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerCancel}
			onLostPointerCapture={(event) => clearRegionGesture(event.pointerId)}
		>
			{diagram ? (
				<div
					ref={boxRef}
					role="img"
					aria-label="Diagram" {...mergeStylexProps("[&>svg]:block [&>svg]:h-full [&>svg]:w-full", sx.boxBorder, sx.shrink0, sx.rounded2xl, sx.border, sx.borderWhite20, sx.bgVarDiagramCanvas, sx.p4, sx.TransformOrigin00)}
					style={{ width: fit?.w, height: fit?.h, viewTransitionName }}
					// The markup is mermaid's own output, already rendered into the
					// transcript by MarkdownBody; this is the same SVG, resized.
					dangerouslySetInnerHTML={{ __html: diagram.svg }}
				/>
			) : (
				<>
					<img
						ref={imgRef}
						src={src}
						alt=""
						draggable={false}
						// object-contain sizes the box from the decoded picture, so the
						// box before load is not the box after it.
						onLoad={() => {
							layout.current = null;
						}}
						// The scrim is near-black in both themes, so a dark screenshot
						// opened full size has no edge of its own and bleeds into it.
						// A white hairline rather than border-line-strong: this surface
						// is always dark, like the rest of the lightbox chrome.
						// The top of the radius scale, because this is the largest
						// floating surface in the app and a card-sized corner on a
						// screen-sized photo reads as a crop rather than a shape.
						// Anything rounder would leave the scale, and it starts
						// clipping content that sits in a screenshot's own corner.
						{...stylex.props(sx.minH0, sx.minW0, sx.maxHFull, sx.maxWFull, sx.rounded2xl, sx.border, sx.borderWhite20, sx.objectContain, sx.TransformOrigin00)}
						style={{ viewTransitionName }}
					/>
					{commentMode && shownRegionBox && imageBox && (
						/* What you chose stays at full brightness and everything else
						   steps back, rather than the selection wearing a coloured wash.
						   One spread shadow paints the whole surround; the wrapper clips
						   it to the picture's own rounded box so it cannot leak over the
						   scrim and the chrome. */
						<div
							{...stylex.props(sx.pointerEventsNone, sx.absolute, sx.overflowHidden, sx.rounded2xl)}
							style={{
								left: imageBox.left,
								top: imageBox.top,
								width: imageBox.width,
								height: imageBox.height,
							}}
							aria-hidden="true"
						>
							<div {...mergeStylexProps("", sx.shadow0009999pxRgb00005, sx.absolute)}
								style={{
									left: shownRegionBox.left - imageBox.left,
									top: shownRegionBox.top - imageBox.top,
									width: shownRegionBox.width,
									height: shownRegionBox.height,
								}}
							/>
						</div>
					)}
					{commentMode && shownRegionBox && (
						<div
							// The region is a thing you can take hold of, not a mark:
							// press it to move it, press a handle to resize it.
							// Dragging bare picture still starts a new one.
							data-region-handle="move" {...mergeStylexProps("", sx.shadow0001pxRgb000022, sx.absolute, sx.cursorMove, sx.touchNone, sx.rounded3px, sx.border, sx.borderWhite)}
							style={shownRegionBox}
							aria-hidden="true"
						>
							{REGION_HANDLES.filter(
								(handle) =>
									// An edge handle needs a side long enough to hold one
									// without crowding the corners it sits between, and
									// a framed region has no room for one at all.
									!handlesOutside &&
									(handle.axis !== "x" || shownRegionBox.width >= 56) &&
									(handle.axis !== "y" || shownRegionBox.height >= 56),
							)
								.concat(
									handlesOutside
										? REGION_HANDLES.filter((handle) => !handle.axis)
										: [],
								)
								.map((handle) => (
									<span
										key={handle.id}
										data-region-handle={handle.id}
										// The mark stays small so it cannot hide a small
										// region; the square around it is what the finger
										// gets.
										className={cn(
											mergeStylexClassName("", sx.absolute, sx.grid, sx.touchNone, sx.placeItemsCenter),
											handle.position,
											handle.cursor,
										)}
										style={{
											width: handleHit,
											height: handleHit,
											transform: `translate(calc(-50% + ${handle.sx * handleStep}px), calc(-50% + ${handle.sy * handleStep}px))`,
										}}
									>
										<span
											className={cn(
												mergeStylexClassName("", sx.block, sx.borderWhite, sx.dropShadow002pxRgb00005),
												handle.mark,
											)}
										/>
									</span>
								))}
						</div>
					)}
				</>
			)}
		</div>
	);
}

// Apple's page control keeps a small moving window for long galleries instead
// of dropping the dots entirely. Edge dots shrink to hint that more lie beyond.
const MAX_VISIBLE_DOTS = 7;

// Download / Open: quiet buttons in the top action cluster, matching the asset
// preview's separation between actions above and descriptions below.
const lightboxAction = mergeStylexClassName("", sx.shrink0, sx.cursorPointer);

const PREVIEW_LABEL: Record<LightboxItem["kind"], string> = {
	image: "Image preview",
	video: "Video preview",
	diagram: "Diagram preview",
};

function MediaLightbox({
	items,
	index,
	onIndex,
	onClose,
	useHeroTransition,
	startCommenting = false,
	heroTransitionName,
}: {
	items: LightboxItem[];
	index: number;
	onIndex: (i: number) => void;
	onClose: (allowHeroTransition?: boolean) => void;
	useHeroTransition: boolean;
	startCommenting?: boolean;
	heroTransitionName?: string;
}) {
	const isPhone = useIsPhone();
	const item = items[index];
	const many = items.length > 1;
	const [chromeVisible, setChromeVisible] = useState(true);
	const [phoneBottomHeight, setPhoneBottomHeight] = useState(0);
	const phoneBottomRef = useRef<HTMLDivElement>(null);
	const filmstripRef = useRef<HTMLDivElement>(null);
	const filmstripIndexRef = useRef(index);
	const dotStart = Math.min(
		Math.max(0, index - Math.floor(MAX_VISIBLE_DOTS / 2)),
		Math.max(0, items.length - MAX_VISIBLE_DOTS),
	);
	const dotIndexes = Array.from(
		{ length: Math.min(items.length, MAX_VISIBLE_DOTS) },
		(_, offset) => dotStart + offset,
	);
	const [imageZoomed, setImageZoomed] = useState(false);
	// Which file the copy receipt belongs to, so a page turn shows the fresh
	// "Copy link" for the item now on screen rather than a stale "Copied".
	const [copiedSrc, setCopiedSrc] = useState<string | null>(null);
	const copied = !!item && copiedSrc === item.src;
	const [savingSrc, setSavingSrc] = useState<string | null>(null);
	const nativeShare = canUseNativeIOSShare();
	const saving = savingSrc === item.src;
	// Which way the last page turn went, so the arriving item slides in from
	// the side it came from — set by the arrows and the keyboard too, not just
	// by the drag, so every route through the gallery reads the same.
	const [direction, setDirection] = useState<-1 | 0 | 1>(0);
	const [commenting, setCommenting] = useState(startCommenting);
	const [selection, setSelection] = useState<ImageRegion | null>(null);
	/** Where that selection sits on screen, reported by the viewer. */
	const [selectionRect, setSelectionRect] = useState<ScreenRect | null>(null);
	const [commentCardSize, setCommentCardSize] = useState<{
		width: number;
		height: number;
	} | null>(null);
	const [viewport, setViewport] = useState(() => ({
		width: typeof window === "undefined" ? 0 : window.innerWidth,
		height: typeof window === "undefined" ? 0 : window.innerHeight,
	}));
	const [commentText, setCommentText] = useState("");
	const [commentError, setCommentError] = useState<string | null>(null);
	const [sendingComment, setSendingComment] = useState(false);
	const sendingCommentRef = useRef(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const commentInputRef = useRef<HTMLTextAreaElement>(null);
	const commentCardRef = useRef<HTMLFormElement>(null);
	/** The field is as tall as its own text, between one line and a bar that
	 *  would start to cover the picture. Measured from scrollHeight, so it is
	 *  the wrapped line count rather than the character count that decides. */
	const fitCommentField = (field: HTMLTextAreaElement) => {
		const min = isPhone ? 44 : 36;
		// Zero, not "auto": a textarea's auto height is its `rows` height, so
		// scrollHeight read against it never falls back below one row and the bar
		// cannot shrink again when the text is deleted.
		field.style.height = "0px";
		field.style.height = `${Math.min(Math.max(field.scrollHeight, min), 132)}px`;
	};
	const effectFitCommentField = useEffectEvent(fitCommentField);
	const reduceMotion = useReducedMotion();
	const resetComment = () => {
		setChromeVisible(true);
		setCommenting(false);
		setSelection(null);
		setSelectionRect(null);
		setCommentCardSize(null);
		setCommentText("");
		setCommentError(null);
	};
	const prev = () => {
		setImageZoomed(false);
		resetComment();
		setDirection(-1);
		onIndex((index - 1 + items.length) % items.length);
	};
	const next = () => {
		setImageZoomed(false);
		resetComment();
		setDirection(1);
		onIndex((index + 1) % items.length);
	};
	const go = (i: number) => {
		if (i === index) return;
		setImageZoomed(false);
		resetComment();
		setDirection(i > index ? 1 : -1);
		onIndex(i);
	};
	const requestClose = () => onClose(!imageZoomed);
	// The scrim lifts with a dismissal drag, so what is underneath is already
	// showing through before the finger leaves the glass. Written straight to
	// the element like the drag transform itself: a re-render per pointer move
	// is what this whole surface is built to avoid. A rejected drag restores the
	// scrim over the same quarter-second that returns the picture.
	const dragScrim = (progress: number) => {
		const el = dialogRef.current;
		if (!el) return;
		el.style.transition =
			progress === 0 && !reduceMotion
				? "background-color 0.24s ease-out"
				: "none";
		el.style.backgroundColor = progress
			? `rgb(0 0 0 / ${(1 - progress * 0.55).toFixed(3)})`
			: "";
	};
	const togglePhoneChrome = () => {
		if (!isPhone || commenting) return;
		setChromeVisible((visible) => !visible);
	};
	const saveItem = async () => {
		if (saving) return;
		setSavingSrc(item.src);
		await (async () => {
await saveFileWithNativeShare(downloadHref(item), suggestedName(item));
})().catch(async (error) => {
if (!nativeShareWasCancelled(error)) toast("Could not save that file");
}).finally(async () => {
setSavingSrc(null);
});
	};
	const openItem = async () => {
		await (async () => {
await shareURL(item.src);
})().catch(async (error) => {
if (!nativeShareWasCancelled(error)) toast("Could not share that link");
});
	};
	const copyImage = () => {
		void copyImageToClipboard(item.src).then(
			() => setCopiedSrc(item.src),
			() => toast("Could not copy that image"),
		);
	};
	const commentable =
		item.kind === "image" &&
		canCommentOnImageRegion(item.commentSessionId);
	const sendRegionComment = async () => {
		const text = commentText.trim();
		const { commentSessionId, src } = item;
		if (!commentSessionId || !selection || !text || sendingCommentRef.current)
			return;
		sendingCommentRef.current = true;
		setSendingComment(true);
		setCommentError(null);
		await (async () => {
await submitImageRegionComment({
				sessionId: commentSessionId,
				src,
				region: selection,
				text,
			});
			onClose(false);
})().catch(async (error) => {
setCommentError(
				error instanceof Error ? error.message : "Could not send this comment",
			);
}).finally(async () => {
sendingCommentRef.current = false;
			setSendingComment(false);
});
	};

	useEffect(() => {
		if (!copiedSrc) return;
		const t = setTimeout(() => setCopiedSrc(null), 1600);
		return () => clearTimeout(t);
	}, [copiedSrc]);

	// The image fits above the phone bar, whose height changes with captions and
	// the home indicator. Measure the rendered bar instead of assuming one size.
	useLayoutEffect(() => {
		if (!isPhone) return;
		const bar = phoneBottomRef.current;
		if (!bar) return;
		const measure = () => {
			const height = bar.getBoundingClientRect().height;
			setPhoneBottomHeight((current) =>
				Math.abs(current - height) < 0.5 ? current : height,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(bar);
		return () => observer.disconnect();
	}, [isPhone]);

	// Swiping the main image and tapping a thumbnail keep the active still in
	// the middle of the strip. The first positioning is immediate.
	useEffect(() => {
		if (!isPhone) return;
		const changed = filmstripIndexRef.current !== index;
		filmstripIndexRef.current = index;
		filmstripRef.current
			?.querySelector<HTMLElement>(`[data-lightbox-thumb="${index}"]`)
			?.scrollIntoView({
				behavior: changed && !reduceMotion ? "smooth" : "auto",
				block: "nearest",
				inline: "center",
			});
	}, [index, isPhone, reduceMotion]);

	// A hidden toolbar must not retain focus. Focus the dialog itself so Enter,
	// Space, or a fresh tap can reveal the controls again.
	useEffect(() => {
		if (!isPhone || chromeVisible) return;
		dialogRef.current?.focus({ preventScroll: true });
	}, [chromeVisible, isPhone]);

	// The card is placed against the selection, so it needs the room it is being
	// placed in. visualViewport rather than innerHeight: an open phone keyboard
	// shrinks the first and not the second, and a card measured against the
	// second would sit under the keys the person is typing on.
	useEffect(() => {
		const measure = () =>
			setViewport((current) => {
				const next = {
					width: window.visualViewport?.width ?? window.innerWidth,
					height: window.visualViewport?.height ?? window.innerHeight,
				};
				return Math.abs(current.width - next.width) < 0.5 &&
					Math.abs(current.height - next.height) < 0.5
					? current
					: next;
			});
		measure();
		window.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("resize", measure);
		return () => {
			window.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("resize", measure);
		};
	}, []);

	// Its own height decides whether it fits below the region, and that height
	// changes as an error appears or the text wraps.
	useLayoutEffect(() => {
		const el = commentCardRef.current;
		if (!el) return;
		const measure = () => {
			const rect = el.getBoundingClientRect();
			setCommentCardSize((current) =>
				current &&
				Math.abs(current.width - rect.width) < 0.5 &&
				Math.abs(current.height - rect.height) < 0.5
					? current
					: { width: rect.width, height: rect.height },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
		// selectionRect too: the card only mounts once the viewer has reported
		// where the region is, which is a render after the selection itself.
	}, [commenting, selection, selectionRect]);

	useEffect(() => {
		// The card mounts one render after the selection, once the viewer has
		// reported its viewport position. Waiting for that position keeps this
		// focus attempt from running while the textarea ref is still null.
		if (!selection || !selectionRect) return;
		const frame = requestAnimationFrame(() => {
			const field = commentInputRef.current;
			if (!field) return;
			// Before focus, so the bar is never one frame taller or shorter than
			// the words already in it.
			effectFitCommentField(field);
			field.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [selection, selectionRect]);

	useEffect(() => {
		const previousFocus = document.activeElement as HTMLElement | null;
		// Focus returns to whatever opened the viewer, but the ring only comes
		// back if it was there to begin with: a mouse click on a session image
		// focuses its wrapping <a> silently, and closing with Escape puts the
		// browser in keyboard modality, so a plain focus() would leave an
		// outline around an image nobody deliberately focused.
		const restore: FocusOptionsWithVisible = {
			preventScroll: true,
			focusVisible: !!previousFocus?.matches?.(":focus-visible"),
		};
		const frame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
		return () => {
			cancelAnimationFrame(frame);
			if (previousFocus?.isConnected) previousFocus.focus(restore);
		};
	}, []);

	// Capture-phase so the arrows/Escape don't also drive whatever is behind
	// the modal (composer, session viewer shortcuts).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const target = e.target as HTMLElement | null;
			const editingText = Boolean(
				target?.matches("input, textarea, [contenteditable='true']"),
			);
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				requestClose();
			} else if (
				isPhone &&
				!chromeVisible &&
				!editingText &&
				(e.key === "Enter" || e.key === " ")
			) {
				e.preventDefault();
				e.stopPropagation();
				setChromeVisible(true);
			} else if (!editingText && e.key === "ArrowLeft" && many) {
				e.stopPropagation();
				e.preventDefault();
				prev();
			} else if (!editingText && e.key === "ArrowRight" && many) {
				e.stopPropagation();
				e.preventDefault();
				next();
			} else if (e.key === "Tab") {
				const focusable = Array.from(
					dialogRef.current?.querySelectorAll<HTMLElement>(
						'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
					) || [],
				).filter(
					(element) =>
						element.getClientRects().length > 0 && !element.closest("[inert]"),
				);
				if (focusable.length === 0) {
					e.preventDefault();
					return;
				}
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				const active = document.activeElement;
				if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
					e.preventDefault();
					first.focus();
				}
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	if (!item) return null;
	// When it was taken, the way the rest of the app says it — "Today at 14:32",
	// "Jul 12 at 09:05" — rather than a raw locale stamp with seconds in it.
	const caption = [item.sessionTitle, item.at ? fullTime(item.at) : null]
		.filter(Boolean)
		.join(" · ");
	const description = item.description?.trim();
	// z-10 keeps the chrome floating above a zoomed image, which is free to
	// spread under it across the whole viewport (z-index applies to flex items
	// without needing position).
	const navBtn =
		mergeStylexClassName("", sx.z10, sx.grid, sx.h10, sx.w10, sx.shrink0, sx.placeItemsCenter, sx.roundedFull, sx.border0, sx.bgWhite10, sx.p0, sx.textWhite, sx.hoverBgWhite20, sx.phoneH11, sx.phoneW11);
	// Wide enough for a sentence, never wider than the screen it floats on.
	const commentCardWidth = Math.min(340, Math.max(220, viewport.width - 24));
	const commentAnchor =
		commenting && selection && selectionRect
			? anchoredCommentPosition(
					selectionRect,
					{ width: commentCardWidth, height: commentCardSize?.height ?? 0 },
					viewport,
				)
			: null;
	const phoneStageInset = chromeVisible || imageZoomed || commenting;
	// Photos keeps the still centered on the screen and floats its chrome over it.
	// Using the full bottom bar as one-sided padding made tall images look pulled
	// upward. Preserve the same fitted size, but share that clearance between the
	// top and bottom so the image's center stays at the viewport's center.
	const phoneStagePadding = (68 + phoneBottomHeight) / 2;
	const phoneAction =
		mergeStylexClassName("", sx.grid, sx.size11, sx.shrink0, sx.placeItemsCenter, sx.roundedFull, sx.border0, sx.bgTransparent, sx.p0, sx.textWhite, sx.transitionTransformBackgroundColorOpacity, sx.durationVarDurMicro, sx.easeVarEase, sx.activeScale096, sx.disabledOpacity035);

	return (
		<motion.div
			ref={dialogRef}
			data-media-lightbox="" {...mergeStylexProps("", sx.phoneH100dvh, sx.phoneBgBlack, sx.fixed, sx.inset0, sx.z11000, sx.flex, sx.flexCol, sx.bgBlack85)}
			role="dialog"
			tabIndex={-1}
			aria-modal="true"
			aria-label={PREVIEW_LABEL[item.kind]}
			initial={useHeroTransition ? false : { opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={useHeroTransition ? { opacity: 1 } : { opacity: 0 }}
			transition={useHeroTransition ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) requestClose();
			}}
		>
			<div
				className={cn(
					mergeStylexClassName("", sx.pointerEventsNone, sx.absolute, sx.leftCalc12pxEnvSafeAreaInsetLeft, sx.rightCalc12pxEnvSafeAreaInsetRight, sx.topCalc12pxEnvSafeAreaInsetTop, sx.z10, sx.flex, sx.itemsCenter, sx.justifyCenter),
					isPhone &&
						mergeStylexClassName("", sx.transitionOpacityTransform, sx.durationVarDur, sx.easeVarEase, sx.motionReduceTransitionNone),
					isPhone && !chromeVisible && mergeStylexClassName("", sx.TranslateY2, sx.opacity0),
				)}
				inert={isPhone && !chromeVisible ? true : undefined}
				aria-hidden={isPhone && !chromeVisible ? true : undefined}
			>
				{/* Keep the actions on the viewport's centerline while Close owns the
				    right corner. Grouping both at the edge made the row read like loose
				    header controls rather than one action bar. */}
				<div
					role="group"
					aria-label="Media actions"
					className={isPhone ? mergeStylexClassName("", sx.hidden) : mergeStylexClassName("", sx.pointerEventsAuto, sx.flex, sx.itemsCenter, sx.gap1)}
				>
					{commentable && (
						<Button
							variant="overlay"
							size="md"
							icon={<IconMessage size={20} />}
							className={cn(
								lightboxAction,
								commenting && mergeStylexClassName("", sx.bgWhite15, sx.textWhite),
							)}
							onClick={() => {
								if (commenting) resetComment();
								else {
									setCommenting(true);
									setCommentError(null);
								}
							}}
							aria-pressed={commenting}
							aria-label={commenting ? "Cancel image comment" : "Comment on image"}
						>
							Comment
						</Button>
					)}
					{nativeShare ? (
						<Button
							variant="overlay"
							size="md"
							icon={<IconArrowDown size={20} />}
							className={lightboxAction}
							onClick={saveItem}
							disabled={saving}
							aria-label={saving ? "Preparing download" : "Download"}
						>
							{saving ? "Preparing…" : "Download"}
						</Button>
					) : (
						<Button
							variant="overlay"
							size="md"
							icon={<IconArrowDown size={20} />}
							className={lightboxAction}
							aria-label="Download"
							render={
								<a
									href={downloadHref(item)}
									download={
										item.src.startsWith("data:") || item.src.startsWith("blob:")
											? suggestedName(item)
											: undefined
									}
								/>
							}
						>
							Download
						</Button>
					)}
					{!item.src.startsWith("data:") && (
						<>
							{/* The file's own URL: what you paste into an upload, a
							    ticket, or a message to someone who can reach this instance. */}
							<Button
								variant="overlay"
								size="md"
								icon={copied ? <IconCheck size={20} /> : <IconLink size={20} />}
								className={lightboxAction}
								aria-label={copied ? "Link copied" : "Copy link"}
								onClick={() =>
									copyToClipboard(shareableSrc(item), () =>
										setCopiedSrc(item.src),
									)
								}
							>
								{copied ? "Copied" : "Copy link"}
							</Button>
							{nativeShare ? (
								<Button
									variant="overlay"
									size="md"
									icon={<IconArrowUpRight size={20} />}
									className={lightboxAction}
									onClick={openItem}
									aria-label="Open or share"
								>
									Open or share
								</Button>
							) : (
								<Button
									variant="overlay"
									size="md"
									icon={<IconArrowUpRight size={20} />}
									className={lightboxAction}
									aria-label="Open"
									render={
										<a
											href={item.src}
											target="_blank"
											rel="noopener noreferrer"
										/>
									}
								>
									Open
								</Button>
							)}
						</>
					)}
				</div>
				<button
					ref={closeRef}
					type="button"
					className={cn(navBtn, mergeStylexClassName("", sx.pointerEventsAuto, sx.absolute, sx.right0))}
					onClick={requestClose}
					aria-label="Close"
				>
					<IconX size={22} />
				</button>
			</div>

			<div
				className={cn(
					mergeStylexClassName("", sx.flex, sx.minH0, sx.flex1, sx.itemsCenter, sx.justifyCenter, sx.gap3, sx.px3, sx.pb2, sx.ptCalc56pxEnvSafeAreaInsetTop, sx.smPx4),
					isPhone && mergeStylexClassName("", sx.gap0, sx.px0),
				)}
				style={
					isPhone
						? {
								paddingTop: phoneStageInset ? phoneStagePadding : 0,
								paddingBottom: phoneStageInset ? phoneStagePadding : 0,
								transition: reduceMotion
									? "none"
									: "padding 0.25s cubic-bezier(0.77, 0, 0.175, 1)",
							}
						: undefined
				}
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) requestClose();
				}}
			>
				{many && !isPhone && (
					<button
						type="button"
						className={navBtn}
						onClick={prev}
						aria-label="Previous"
					>
						<IconChevronLeft size={24} />
					</button>
				)}
				<motion.div
					{...stylex.props(sx.flex, sx.minH0, sx.minW0, sx.flex1, sx.selfStretch)}
					initial={
						useHeroTransition
							? false
							: { opacity: 0, scale: reduceMotion ? 1 : 0.96 }
					}
					animate={{ opacity: 1, scale: 1 }}
					exit={
						useHeroTransition
							? { opacity: 1, scale: 1 }
							: { opacity: 0, scale: reduceMotion ? 1 : 0.985 }
					}
					transition={
						useHeroTransition
							? { duration: 0 }
							: reduceMotion
								? { duration: 0.14, ease: "easeOut" }
								: { type: "spring", duration: 0.28, bounce: 0 }
					}
				>
					{item.kind !== "video" ? (
						<ZoomableMedia
							key={item.src}
							src={item.src}
							diagram={item.diagram}
							onTapBackdrop={isPhone ? togglePhoneChrome : requestClose}
							onTapMedia={
								isPhone && item.kind === "image" && !commenting
									? togglePhoneChrome
									: undefined
							}
							onZoomChange={(zoomed) => {
								setImageZoomed(zoomed);
								if (isPhone && zoomed) setChromeVisible(false);
							}}
							onSwipe={
								many && !commenting
									? (d) => (d === 1 ? next() : prev())
									: undefined
							}
							// Drag down to close, the way every photo viewer on a
							// phone does. The picture has already left its thumbnail
							// behind by then, so it fades out from where the finger
							// dropped it rather than flying back.
							onDismiss={
								isPhone && !commenting ? () => onClose(false) : undefined
							}
							onDragProgress={isPhone ? dragScrim : undefined}
							enterFrom={direction}
							viewTransitionName={heroTransitionName}
							commentMode={commenting}
							selection={selection}
							onSelection={(region) => {
								setSelection(region);
								setCommentError(null);
							}}
							onSelectionRect={setSelectionRect}
						/>
					) : (
						// The video never fills the stage, so the space beside it has to
						// close too. Without this, only the thin strip outside this
						// wrapper was a backdrop and the lightbox felt stuck.
						<div
							{...stylex.props(sx.flex, sx.minH0, sx.minW0, sx.flex1, sx.itemsCenter, sx.justifyCenter, sx.selfStretch)}
							onMouseDown={(e) => {
								if (e.target === e.currentTarget) requestClose();
							}}
						>
							<video
								key={item.src}
								src={item.src}
								controls
								autoPlay
								muted
								playsInline
								// Same hairline as the photo: a dark first frame needs
								// an edge against the scrim just as much.
								{...stylex.props(sx.minH0, sx.minW0, sx.maxHFull, sx.maxWFull, sx.rounded2xl, sx.border, sx.borderWhite20)}
							/>
						</div>
					)}
				</motion.div>
				{many && !isPhone && (
					<button
						type="button"
						className={navBtn}
						onClick={next}
						aria-label="Next"
					>
						<IconChevronRight size={24} />
					</button>
				)}
			</div>

			{isPhone && (
				<div
					ref={phoneBottomRef}
					className={cn(
						mergeStylexClassName("", sx.pbMax14pxEnvSafeAreaInsetBottom, sx.transitionOpacityTransform, sx.absolute, sx.insetX0, sx.bottom0, sx.z10, sx.flex, sx.flexCol, sx.gap3, sx.bgLinearToB, sx.fromTransparent, sx.viaBlack85, sx.toBlack, sx.px0, sx.pt8, sx.durationVarDur, sx.easeVarEase, sx.motionReduceTransitionNone),
						!chromeVisible && mergeStylexClassName("", sx.pointerEventsNone, sx.translateY3, sx.opacity0),
					)}
					inert={!chromeVisible ? true : undefined}
					aria-hidden={!chromeVisible ? true : undefined}
				>
					{!commenting && (item.walkthroughLabel || caption || description) && (
						<div {...stylex.props(sx.flex, sx.maxWFull, sx.flexCol, sx.itemsCenter, sx.gap05, sx.px6, sx.textCenter)}>
							<div {...stylex.props(sx.flex, sx.maxWFull, sx.itemsCenter, sx.justifyCenter, sx.gap2)}>
								{caption && (
									<div {...mergeStylexProps("", sx.lineClamp2, sx.minW0, sx.maxWFull, sx.textSm, sx.fontMedium, sx.leadingSnug, sx.textWhite)}>
										{caption}
									</div>
								)}
								{item.walkthroughLabel && (
									<span
										className={cn(
											WALKTHROUGH_LABEL_CLASS,
											WALKTHROUGH_LABEL_TONE[item.walkthroughLabel],
										)}
									>
										{WALKTHROUGH_LABEL_TEXT[item.walkthroughLabel]}
									</span>
								)}
							</div>
							{description && (
								<div {...mergeStylexProps("", sx.lineClamp2, sx.maxWFull, sx.textSm, sx.leadingSnug, sx.textWhite75)}>
									{description}
								</div>
							)}
						</div>
					)}

					{many && (
						<div
							ref={filmstripRef} {...mergeStylexProps("[&::-webkit-scrollbar]:hidden", sx.snapX, sx.flex, sx.h12, sx.snapMandatory, sx.itemsCenter, sx.gap1, sx.overflowXAuto, sx.pxCalc5022px, sx.ScrollbarWidthNone)}
							role="group"
							aria-label="Media filmstrip"
						>
							{items.map((thumb, thumbIndex) => {
								const active = thumbIndex === index;
								return (
									<button
										key={`${thumb.src}-${thumbIndex}`}
										type="button"
										data-lightbox-thumb={thumbIndex}
										{...stylex.props(sx.grid, sx.size11, sx.shrink0, sx.snapCenter, sx.placeItemsCenter, sx.border0, sx.bgTransparent, sx.p0)}
										onClick={() => go(thumbIndex)}
										aria-label={`Show ${thumb.kind} ${thumbIndex + 1} of ${items.length}`}
										aria-current={active ? "true" : undefined}
									>
										<span
											className={cn(
												mergeStylexClassName("", sx.transitionWidthHeightOpacity, sx.block, sx.overflowHidden, sx.roundedSm, sx.outline, sx.outline1, sx.outlineOffset1, sx.durationVarDur, sx.easeVarEase, sx.motionReduceTransitionNone),
												active
													? mergeStylexClassName("", sx.h11, sx.w11, sx.opacity100, sx.outlineWhite85)
													: mergeStylexClassName("", sx.h9, sx.w7, sx.opacity60, sx.outlineTransparent),
											)}
										>
											{thumb.kind === "video" ? (
												<video
													src={thumb.src}
													muted
													playsInline
													preload="metadata"
													{...stylex.props(sx.sizeFull, sx.objectCover)}
												/>
											) : (
												<img
													src={thumb.src}
													alt=""
													loading="lazy"
													{...stylex.props(sx.sizeFull, sx.objectCover)}
												/>
											)}
										</span>
									</button>
								);
							})}
						</div>
					)}

					<div {...stylex.props(sx.grid, sx.gridCols3, sx.itemsCenter, sx.px5)}>
						<div {...stylex.props(sx.justifySelfStart)}>
							{nativeShare ? (
								<button
									type="button"
									className={phoneAction}
									onClick={saveItem}
									disabled={saving}
									aria-label={saving ? "Preparing image" : "Share image"}
								>
									<IconShare size={21} />
								</button>
							) : (
								<a
									href={downloadHref(item)}
									download={
										item.src.startsWith("data:") || item.src.startsWith("blob:")
											? suggestedName(item)
											: undefined
									}
									className={phoneAction}
									aria-label="Download"
								>
									<IconArrowDown size={21} />
								</a>
							)}
						</div>

						{commentable && (
							<button
								type="button"
								className={cn(phoneAction, mergeStylexClassName("", sx.justifySelfCenter), commenting && mergeStylexClassName("", sx.bgWhite15))}
								onClick={() => {
									if (commenting) resetComment();
									else {
										setChromeVisible(true);
										setCommenting(true);
										setCommentError(null);
									}
								}}
								aria-pressed={commenting}
								aria-label={commenting ? "Cancel image comment" : "Comment on image"}
							>
								<IconMessage size={21} />
							</button>
						)}

						<button
							type="button"
							className={cn(phoneAction, mergeStylexClassName("", sx.colStart3, sx.justifySelfEnd))}
							onClick={copyImage}
							disabled={item.kind === "video"}
							aria-label={copied ? "Image copied" : "Copy image"}
						>
							{copied ? <IconCheck size={21} /> : <IconCopy size={21} />}
						</button>
					</div>
				</div>
			)}

			{commenting && !selection && (
				<div {...stylex.props(sx.pointerEventsNone, sx.absolute, sx.insetX0, sx.bottomCalc16pxEnvSafeAreaInsetBottom, sx.z20, sx.flex, sx.justifyCenter, sx.px4)}>
					<div {...mergeStylexProps("", sx.shadowInset01px0Rgb255255255008012px44pxRgb00005, sx.backdropBlur2xl, sx.backdropSaturate150, sx.pointerEventsAuto, sx.flex, sx.itemsCenter, sx.gap1, sx.roundedFull, sx.border, sx.borderWhite10, sx.bgBlack55, sx.py1, sx.pl4, sx.pr1)}>
						<span {...stylex.props(sx.fontMedium, sx.textWhite, typography.label)}>
							Drag over the part you mean
						</span>
						<button
							type="button" {...mergeStylexProps("", sx.hoverBgWhite10, sx.hoverTextWhite, sx.phoneMinH11, sx.minH9, sx.roundedFull, sx.px3, sx.fontMedium, sx.textWhite70, typography.label)}
							onClick={resetComment}
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			{commentAnchor && (
				<motion.form
					ref={commentCardRef} {...mergeStylexProps("", sx.shadowInset01px0Rgb255255255008016px50pxRgb00005, sx.backdropBlur2xl, sx.backdropSaturate150, sx.fixed, sx.z20, sx.flex, sx.cursorText, sx.flexCol, sx.gap1, sx.rounded22px, sx.bgBlack55, sx.p15)}
					// It grows out of the corner of the region it belongs to, rather
					// than fading in beside it.
					initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
					animate={{ opacity: 1, scale: 1 }}
					transition={{ type: "spring", duration: 0.3, bounce: 0.12 }}
					style={{
						left: commentAnchor.left,
						top: commentAnchor.top,
						width: commentCardWidth,
						transformOrigin:
							commentAnchor.placement === "above" ? "bottom left" : "top left",
						// One frame of measurement before it knows which side of the
						// region it fits on. Showing it first would place it, then move it.
						visibility: commentCardSize ? undefined : "hidden",
					}}
					onSubmit={(event) => {
						event.preventDefault();
						void sendRegionComment();
					}}
					// The whole bar is the field, the way a text input is: pressing
					// the padding beside the words puts the caret in them rather than
					// doing nothing. The buttons keep their own presses.
					onPointerDown={(event) => {
						if ((event.target as HTMLElement).closest("button, textarea")) return;
						event.preventDefault();
						commentInputRef.current?.focus({ preventScroll: true });
					}}
				>
					<div {...stylex.props(sx.flex, sx.itemsEnd, sx.gap1)}>
						<textarea
							ref={commentInputRef}
							value={commentText}
							onChange={(event) => {
								setCommentText(event.target.value);
								fitCommentField(event.target);
							}}
							onKeyDown={(event) => {
								if (
									event.key === "Enter" &&
									!event.shiftKey &&
									!event.nativeEvent.isComposing &&
									window.matchMedia("(hover: hover) and (pointer: fine)").matches
								) {
									event.preventDefault();
									void sendRegionComment();
								}
							}}
							rows={1}
							placeholder="What should change here?" {...mergeStylexProps("[&::-webkit-scrollbar]:hidden", sx.placeholderTextWhite45, sx.phoneTextInputPhone, sx.block, sx.wFull, sx.flex1, sx.resizeNone, sx.appearanceNone, sx.border0, sx.bgTransparent, sx.px25, sx.py2, sx.leadingSnug, sx.textWhite, sx.outlineNone, sx.ScrollbarWidthNone, typography.body)}
							disabled={sendingComment}
						/>
						<button
							type="button" {...mergeStylexProps("", sx.hoverBgWhite10, sx.hoverTextWhite, sx.phoneSize11, sx.grid, sx.size9, sx.shrink0, sx.placeItemsCenter, sx.roundedFull, sx.border0, sx.bgTransparent, sx.p0, sx.textWhite60)}
							onClick={resetComment}
							disabled={sendingComment}
							aria-label="Cancel comment"
						>
							<IconX size={16} />
						</button>
						<button
							type="submit" {...mergeStylexProps("", sx.activeScale094, sx.disabledBgWhite15, sx.disabledTextWhite40, sx.phoneSize11, sx.grid, sx.size9, sx.shrink0, sx.placeItemsCenter, sx.roundedFull, sx.border0, sx.bgAccent, sx.p0, sx.textWhite, sx.transitionTransform)}
							disabled={!commentText.trim() || sendingComment}
							aria-label={sendingComment ? "Sending comment" : "Send comment"}
						>
							<IconArrowUp size={17} />
						</button>
					</div>
					{commentError && (
						<div {...stylex.props(sx.px25, sx.pb1, sx.textRed, typography.label)} role="alert">
							{commentError}
						</div>
					)}
				</motion.form>
			)}

			{/* What you are looking at gets its own line directly under the
			    picture, in plain white. Actions live above with Close, so a
			    "Before"/"After" label cannot read as another link. */}
			{!isPhone && (
				<div
					className={cn(
						mergeStylexClassName("", sx.z10, sx.flex, sx.flexCol, sx.itemsCenter, sx.gap15, sx.px4, sx.pb4, sx.pt4),
					(commenting ||
						(!item.walkthroughLabel && !caption && !description && !many)) &&
						mergeStylexClassName("", sx.hidden),
				)}
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) requestClose();
				}}
			>
				{(item.walkthroughLabel || caption || description) && (
					<div {...stylex.props(sx.flex, sx.maxWFull, sx.flexCol, sx.itemsCenter, sx.gap05, sx.textCenter)}>
						<div {...stylex.props(sx.flex, sx.maxWFull, sx.itemsCenter, sx.justifyCenter, sx.gap2)}>
							{caption && (
								<div {...stylex.props(sx.minW0, sx.maxWFull, sx.truncate, sx.textSm, sx.fontMedium, sx.textWhite)}>
									{caption}
								</div>
							)}
							{item.walkthroughLabel && (
								<span
									className={cn(
										WALKTHROUGH_LABEL_CLASS,
										WALKTHROUGH_LABEL_TONE[item.walkthroughLabel],
									)}
								>
									{WALKTHROUGH_LABEL_TEXT[item.walkthroughLabel]}
								</span>
							)}
						</div>
						{description && (
							<div {...mergeStylexProps("", sx.maxWMin720px90vw, sx.lineClamp2, sx.textSm, sx.leadingSnug, sx.textWhite75)}>
								{description}
							</div>
						)}
					</div>
				)}
				<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
					{many && (
						// Dots provide direct jumps; the counter beside them gives the
						// exact position without making the reader count circles.
						<div {...stylex.props(sx.flex, sx.itemsCenter)}>
							{dotIndexes.map((dot, position) => (
								<button
									key={`${dot}-${items[dot].src}`}
									type="button"
									onClick={() => go(dot)}
									aria-label={`Show ${dot + 1} of ${items.length}`}
									aria-current={dot === index ? "true" : undefined} {...mergeStylexProps("group", sx.shrink0, sx.cursorPointer, sx.border0, sx.bgTransparent, sx.p1, sx.leadingNone)}
								>
									<span
										className={cn(
											mergeStylexClassName("", sx.transitionScaleBackgroundColor, sx.block, sx.size15, sx.roundedFull),
											((position === 0 && dotStart > 0) ||
												(position === dotIndexes.length - 1 &&
													dotStart + dotIndexes.length < items.length)) &&
												mergeStylexClassName("", sx.scale067),
											dot === index
												? mergeStylexClassName("", sx.bgWhite)
												: mergeStylexClassName("group-hover:bg-white/60", sx.bgWhite30),
										)}
									/>
								</button>
							))}
						</div>
					)}
					{many && (
						<span {...mergeStylexProps("", sx.tabularNums, sx.fontMedium, sx.textWhite50, typography.meta)}>
							{index + 1} of {items.length}
						</span>
					)}
					</div>
				</div>
			)}
		</motion.div>
	);
}
