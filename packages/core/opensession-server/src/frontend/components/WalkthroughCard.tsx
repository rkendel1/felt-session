import React, { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { SessionWalkthrough } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { relativeTime } from "../lib/api";
import {
	WALKTHROUGH_LABEL_CLASS,
	WALKTHROUGH_LABEL_TEXT,
	WALKTHROUGH_LABEL_TONE,
} from "../lib/walkthrough-label";
import { walkthroughLede } from "../lib/walkthrough-lede";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { ease } from "../ui/motion";
import { IconChevronDown, IconPlay, IconPlayRectangle } from "./icons";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import { openLightbox, type LightboxItem } from "./MediaLightbox";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	M1: {
			margin: "-4px"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border0: {
			borderStyle: "solid",
			borderWidth: "0"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	p1: {
			padding: "4px"
	},
	textLeft: {
			textAlign: "left"
	},
	fontSans: {
			fontFamily: "var(--sans)"
	},
	leading5: {
			lineHeight: "20px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	flexShrink0: {
			flexShrink: "0"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	maxW40: {
			maxWidth: "160px"
	},
	flexShrink: {
			flexShrink: "1"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	leading4: {
			lineHeight: "16px"
	},
	block: {
			display: "block"
	},
	mb2: {
			marginBottom: "8px"
	},
	gap15: {
			gap: "6px"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-xs--line-height))"
	},
	m0: {
			margin: "0"
	},
	mt2: {
			marginTop: "8px"
	},
	OverflowWrapAnywhere: {
			overflowWrap: "anywhere"
	},
	TextWrapPretty: {
			textWrap: "pretty"
	},
	absolute: {
			position: "absolute"
	},
	inset0: {
			inset: "0"
	},
	grid: {
			display: "grid"
	},
	placeItemsCenter: {
			placeItems: "center"
	},
	bgBlack25: {
			backgroundColor: "color-mix(in srgb, var(--color-black) 25%, transparent)"
	},
	textWhite: {
			color: "var(--color-white)"
	},
	ml05: {
			marginLeft: "2px"
	},
	px05: {
			paddingInline: "2px"
	},
	mb15: {
			marginBottom: "6px"
	},
	maxW68ch: {
			maxWidth: "68ch"
	},
	minH5: {
			minHeight: "20px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	size15: {
			width: "6px",
			height: "6px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgBlue: {
			backgroundColor: "var(--blue)"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},
	pb2: {
			paddingBottom: "8px"
	},
	relative: {
			position: "relative"
	},
	wFull: {
			width: "100%"
	},
	cursorZoomIn: {
			cursor: "zoom-in"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	p0: {
			padding: "0"
	},
	transitionFilter: {
			transitionProperty: "filter",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},

	pointerEventsNone: {
		"pointerEvents": "none"
	},
	left2: {
		"left": "8px"
	},
	top2: {
		"top": "8px"
	},
	maxWFull: {
		"maxWidth": "100%"
	},
	TileH320px: {
		"--tile-h": "320px"
	},
	desktopTileH384px: {
		"@media (min-width: 721px)": {
			"--tile-h": "384px"
		}
	},
	TileH100px: {
		"--tile-h": "100px"
	},
	desktopTileH160px: {
		"@media (min-width: 721px)": {
			"--tile-h": "160px"
		}
	},
	roundedXl: {
		"borderRadius": "calc(18px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	borderLine60: {
		"borderColor": "var(--border)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in oklab, var(--border) 60%, transparent)"
		}
	},
	p4: {
		"padding": "16px"
	},
	mxAuto: {
		"marginInline": "auto"
	},
	mb6: {
		"marginBottom": "24px"
	},
	maxWVarSessionCol: {
		"maxWidth": "var(--session-col)"
	},
	mb4: {
		"marginBottom": "16px"
	},
	size5: {
		"width": "20px",
		"height": "20px"
	},
	leadingNone: {
		"--tw-leading": "1",
		"lineHeight": "1"
	},
	duration150: {
		"--tw-duration": ".15s",
		"transitionDuration": ".15s"
	},
	Rotate90: {
		"rotate": "-90deg"
	},
	Mx4: {
		"marginInline": "-16px"
	},
	overflowXAuto: {
		"overflowX": "auto"
	},
	px4: {
		"paddingInline": "16px"
	},
	ScrollbarWidthNone: {
		"scrollbarWidth": "none"
	},
	gap4: {
		"gap": "16px"
	},
	wMax: {
		"width": "max-content"
	},
	shrink0: {
		"flexShrink": "0"
	},
	bgBlack: {
		"backgroundColor": "var(--color-black)"
	},
	focusVisibleShadow0003pxVarAccentSoft: {
		":focusVisible": {
			"--tw-shadow": "0 0 0 3px var(--tw-shadow-color,var(--accent-soft))",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
	hFull: {
		"height": "100%"
	},
	objectContain: {
		"objectFit": "contain"
	},
	objectCover: {
		"objectFit": "cover"
	},
	gap1: {
		"gap": "4px"
	},
	objectTop: {
		"objectPosition": "top"
	},
	mt4: {
		"marginTop": "16px"
	},
	mt3: {
		"marginTop": "12px"
	},
	shadow0001pxVarBorder: {
		"--tw-shadow": "0 0 0 1px var(--tw-shadow-color,var(--border))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	maxH60vh: {
		"maxHeight": "60vh"
	},
	gap25: {
		"gap": "10px"
	},
	gridCols2: {
		"gridTemplateColumns": "repeat(2,minmax(0,1fr))"
	},
	phoneGridCols1: {
		"@media (max-width: 720px)": {
			"gridTemplateColumns": "repeat(1,minmax(0,1fr))"
		}
	},
	gridCols1: {
		"gridTemplateColumns": "repeat(1,minmax(0,1fr))"
	},
	maxH96: {
		"maxHeight": "384px"
	},

	transitionTransformColor: {
		"transitionProperty": "transform,color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},

	hoverBgHover40: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in oklab, var(--hover) 40%, transparent)"
				}
			}
		}
	},
	phoneMaxW24: {
		"@media (max-width: 720px)": {
			"maxWidth": "96px"
		}
	},
	lineClamp3: {
		"WebkitLineClamp": "3",
		"WebkitBoxOrient": "vertical",
		"display": "-webkit-box",
		"overflow": "hidden"
	},
	w40: {
		"width": "160px"
	},
	desktopW64: {
		"@media (min-width: 721px)": {
			"width": "256px"
		}
	},
	desktopW56: {
		"@media (min-width: 721px)": {
			"width": "224px"
		}
	},
	aspect1610: {
		"aspectRatio": "16/10"
	},
	hoverBrightness098: {
		"@media (hover: hover)": {
			":hover": {
				"--tw-brightness": "brightness(.98)",
				"filter": "var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)"
			}
		}
	},
	focusVisibleShadowInset0003pxVarAccentSoft: {
		":focusVisible": {
			"--tw-shadow": "inset 0 0 0 3px var(--tw-shadow-color,var(--accent-soft))",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
});

/** Stream server-side media (staged under the uploads dir) through the
 *  existing scoped media route — same URL shape MessageBubble uses. */
const mediaUrl = (path: string) => `/media?path=${encodeURIComponent(path)}`;

/**
 * The Before/After label: the app's own status pill, resting in the tile's top
 * left. Panel surface, a --red-soft/--green-soft tint, --red/--green ink and a
 * hairline — the same parts every other pill in the product is made of, so it
 * reads as a caption the app put on the picture rather than as a sticker.
 *
 * Because it is opaque it reads on a white screenshot and on a dark one alike,
 * so it can simply follow the app theme instead of sampling the image under
 * it. A tight shadow under the hairline is what lifts it off the picture, now
 * that the tile's corner no longer holds it in place.
 *
 * `rounded-[999px]`, not `rounded-full`: base.css grants squircle corners to
 * every `rounded-*` except that one spelling, and a pill is where the squircle
 * belongs.
 *
 * The tint is a gradient because it has to sit ON the panel fill: --red-soft
 * is translucent ink, and painted straight onto the picture it is the wash
 * that let a white screenshot through in the first place.
 */
const SHOT_LABEL = cn(
	WALKTHROUGH_LABEL_CLASS,
	mergeStylexClassName("", sx.pointerEventsNone, sx.absolute, sx.left2, sx.top2),
);

/**
 * The agent-published walkthrough (opensession-walkthrough): demo video +
 * before/after screenshot pairs + writeup. Rendered at the top of the PR info
 * column in the Review tab (`panel`), and inline in the session where the agent
 * published it (`session`) — the video plays right there instead of only living
 * behind a tab. Both are the inline counterpart of the link-only section
 * mirrored into the GitHub PR description.
 *
 * In the session it stays in the transcript's reading column and expands only
 * downward. In the Review tab the card IS the content of the column, so it
 * stays open.
 */
export function WalkthroughCard({
	walkthrough,
	variant = "panel",
}: {
	walkthrough: SessionWalkthrough;
	variant?: "panel" | "session";
}) {
	const session = variant === "session";
	const [expanded, setExpanded] = useState(!session);
	// Natural ratio of any folded tile whose picture the tile shape would crop
	// too much of (see tileBox). Learned on load; media the tile already suits
	// never lands here, so it never re-renders.
	const [ownRatio, setOwnRatio] = useState<Record<string, number>>({});
	const reduceMotion = useReducedMotion();
	const repo = useMarkdownRepo();
	const summaryHtml = (renderMarkdown(walkthrough.summary, { repo }));
	// Every piece of media in the card, in render order, so clicking one opens
	// the shared lightbox (Escape/arrows/pinch-zoom/download) browsing
	// demo→before→after across all the pairs.
	const gallery = (() => {
		const items: LightboxItem[] = [];
		const at = new Map<string, number>();
		if (walkthrough.video) {
			at.set("video", items.length);
			items.push({
				kind: "video",
				src: mediaUrl(walkthrough.video),
				walkthroughLabel: "demo",
				sessionTitle: walkthrough.videoTitle,
			});
		}
		let stillCount = 0;
		(walkthrough.shots || []).forEach((shot, i) => {
			for (const side of ["before", "after"] as const) {
				const path = shot[side];
				if (!path) continue;
				at.set(`${i}:${side}`, items.length);
				stillCount += 1;
				items.push({
					kind: "image",
					src: mediaUrl(path),
					walkthroughLabel: side,
					sessionTitle: shot.caption,
				});
			}
		});
		return { items, at, stillCount };
	})();

	// What the card holds, for the folded header — the one thing a reader needs
	// to decide whether to open it. Open, they can see that for themselves, so
	// the slot goes back to saying when it was published.
	const contentsLabel =
		[
			walkthrough.video ? "Demo" : "",
			gallery.stillCount
				? `${gallery.stillCount} still${gallery.stillCount === 1 ? "" : "s"}`
				: "",
		]
			.filter(Boolean)
			.join(" · ") || (walkthrough.summary ? "Writeup" : "");
	// What the folded card says above its pictures, so a reader learns what
	// changed without opening it (see walkthroughLede).
	const lede = walkthroughLede(walkthrough.summary);
	const open = (key: string, target: HTMLElement) =>
		openLightbox(gallery.items, gallery.at.get(key) ?? 0, target);

	// How big a folded tile gets, set by how many there are. A thumbnail of a UI
	// is a picture of small things, so a tile only answers "what changed" once
	// it is big enough to read — and a card with one or two pieces of media has
	// the whole card to give them. There it stops being a strip at all: the
	// tiles divide the card's width, which is both the largest they can be and
	// the only size that never cuts the second one off. Past that the card has
	// more than it can show at once, so the tiles go back to a scrolling strip
	// at a fixed size, stepping down as the count goes up. The phone keeps the
	// small tile throughout — the card is narrow enough there that a wide one
	// shows a picture and a half.
	const fill = gallery.items.length <= 2;
	const tile =
		gallery.items.length <= 4 ? mergeStylexClassName("", sx.w40, sx.desktopW64) : mergeStylexClassName("", sx.w40, sx.desktopW56);

	// What a folded tile does with a picture that is not the shape of the tile.
	// Cropping to 16/10 is honest for a landscape screenshot and useless for a
	// phone one: cropped that way it is a status bar and a header, and at the
	// fill size it is that sliver blown up to the width of the card. So a tile
	// crops only while it still shows three quarters of the picture, which it
	// does from 1.2 (a portrait shot) to 2.13 (a wide strip of UI); outside
	// that the media keeps its own ratio and is shown whole.
	const TILE_RATIO = 16 / 10;
	const noteRatio = (key: string, w: number, h: number) => {
		if (!w || !h) return;
		const ratio = w / h;
		const shown = ratio < TILE_RATIO ? ratio / TILE_RATIO : TILE_RATIO / ratio;
		if (shown >= 0.75) return;
		setOwnRatio((prev) => (prev[key] ? prev : { ...prev, [key]: ratio }));
	};
	// A tall tile is sized off a height, which is what keeps it at the scale of
	// its neighbours instead of running the card; a wide one keeps the width it
	// was given and is simply shorter. The height goes through a variable so the
	// width can be derived from it in the same declaration: `aspect-ratio` with
	// `width: auto` resolves against the caption whenever the caption is the
	// wider of the two, which lands the picture in a letterboxed tile.
	const isTall = (key: string) => (ownRatio[key] ?? TILE_RATIO) < TILE_RATIO;
	const tileBox = (key: string) => {
		const ratio = ownRatio[key];
		if (!ratio) return { className: mergeStylexClassName("", sx.aspect1610, sx.wFull), style: undefined };
		if (!isTall(key))
			return {
				className: mergeStylexClassName("", sx.wFull),
				style: { aspectRatio: String(ratio) } as React.CSSProperties,
			};
		return {
			className: cn(
				mergeStylexClassName("", sx.maxWFull),
				fill
					? mergeStylexClassName("", sx.TileH320px, sx.desktopTileH384px)
					: mergeStylexClassName("", sx.TileH100px, sx.desktopTileH160px),
			),
			style: {
				height: "var(--tile-h)",
				width: `calc(var(--tile-h) * ${ratio})`,
			} as React.CSSProperties,
		};
	};

	return (
		<div
			className={cn(
				// White in light mode, with only a close edge shadow. The walkthrough
				// should read as finished proof, not a panel floating over the transcript.
				mergeStylexClassName("smooth-shadow-xs", sx.roundedXl, sx.border, sx.borderLine60, sx.bgSurface, sx.p4),
				// In the session the card is a transcript block like any other, so it
				// takes the same centered reading column the turns and footers use
				// (mx-auto + --session-col) instead of spanning the whole pane. It
				// trails more space than it leads: unlike the neighbouring blocks
				// it ends in media, which otherwise butts straight into the next
				// message.
				session && mergeStylexClassName("", sx.mxAuto, sx.mb6, sx.mt2, sx.wFull, sx.maxWVarSessionCol),
				!session && mergeStylexClassName("", sx.mb4),
			)}
		>
			{session ? (
				<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
					<button
						type="button"
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)} {...mergeStylexProps("group", sx.hoverBgHover40, sx.focusVisibleShadow0003pxVarAccentSoft, sx.M1, sx.flex, sx.minW0, sx.flex1, sx.cursorPointer, sx.itemsCenter, sx.gap2, sx.roundedControl, sx.border0, sx.bgTransparent, sx.p1, sx.textLeft, sx.fontSans, sx.leading5, sx.textDim, sx.outlineNone, sx.transitionColors, typography.itemTitle)}
					>
						{/* The walkthrough's own icon leads the line, so the row is
					    named before it is operated; the chevron trails at the far
					    edge, where it reads as this card's disclosure rather than
					    as another indent level in the transcript. */}
						<IconPlayRectangle size={20} className={mergeStylexOverrideClassName("", sx.flexShrink0, sx.textFaint)} />
						<span {...stylex.props(sx.flexShrink0, sx.fontSemibold, sx.textFg)}>
							Walkthrough
						</span>
						<span {...mergeStylexProps("", sx.phoneMaxW24, sx.mlAuto, sx.maxW40, sx.flexShrink, sx.truncate, sx.leading4, sx.textFaint, typography.label)}>
							{expanded
								? walkthrough.publishedAt
									? relativeTime(walkthrough.publishedAt)
									: ""
								: contentsLabel}
						</span>
						<span
							className={cn(
								mergeStylexClassName("group-hover:text-dim", sx.transitionTransformColor, sx.grid, sx.size5, sx.flexShrink0, sx.placeItemsCenter, sx.leadingNone, sx.textFaint, sx.duration150),
								!expanded && mergeStylexClassName("", sx.Rotate90),
							)}
						>
							<IconChevronDown size={20} className={mergeStylexOverrideClassName("", sx.block)} />
						</span>
					</button>
				</div>
			) : (
				<div {...stylex.props(sx.mb2, sx.flex, sx.itemsCenter, sx.gap15)}>
					<IconPlayRectangle size={20} className={mergeStylexOverrideClassName("", sx.textFaint)} />
					<span {...stylex.props(sx.textXs, sx.fontSemibold, sx.textDim)}>Walkthrough</span>
				</div>
			)}

			{!expanded && lede && (
				// The writeup's first line, above the strip. Folded, the card used
				// to be a row of thumbnails with nothing saying what they were of,
				// so seeing what changed meant opening every walkthrough in the
				// transcript. Three lines is what the paragraph usually is; the
				// rest of the writeup stays behind the fold, which is what the
				// fold is for.
				<p {...mergeStylexProps("", sx.lineClamp3, sx.m0, sx.mt2, sx.leading5, sx.textDim, sx.OverflowWrapAnywhere, sx.TextWrapPretty, typography.supporting)}>
					{lede}
				</p>
			)}

			{!expanded && gallery.items.length > 0 && (
				// The folded card's media. One or two pieces of it share the card's
				// width and there is nothing to scroll; more than that keeps the
				// scrolling strip, where the demo and every still are one size —
				// flexing each comparison group independently made an unpaired image
				// twice as wide as either side of a pair. Tight within a pair and
				// loose between them keeps the relationship without changing scale.
				// The strip runs to the card's edges rather than stopping at its
				// padding — a tile cut off by the padding looks like a rendering bug,
				// one that runs under the edge reads as "there is more this way".
				<div
					className={cn(
						mergeStylexClassName("", sx.mt2),
						!fill &&
							mergeStylexClassName("[&::-webkit-scrollbar]:hidden", sx.Mx4, sx.overflowXAuto, sx.px4, sx.ScrollbarWidthNone),
					)}
				>
					<div className={cn(mergeStylexClassName("", sx.flex, sx.itemsStart, sx.gap4), !fill && mergeStylexClassName("", sx.wMax))}>
						{walkthrough.video && (
							<figure
								className={cn(
									mergeStylexClassName("", sx.m0),
									isTall("video")
										? mergeStylexClassName("", sx.shrink0)
										: fill
											? mergeStylexClassName("", sx.minW0, sx.flex1)
											: cn(mergeStylexClassName("", sx.shrink0), tile),
								)}
							>
								<button
									type="button"
									className={cn(
										mergeStylexClassName("", sx.relative, sx.block, sx.cursorZoomIn, sx.overflowHidden, sx.roundedMd, sx.border, sx.borderLine, sx.bgBlack, sx.p0, sx.outlineNone, sx.focusVisibleShadow0003pxVarAccentSoft),
										tileBox("video").className,
									)}
									style={tileBox("video").style}
									aria-label="Open demo in media viewer"
									onClick={(event) => open("video", event.currentTarget)}
								>
									<video
										className={cn(
											mergeStylexClassName("", sx.hFull, sx.wFull),
											ownRatio.video ? mergeStylexClassName("", sx.objectContain) : mergeStylexClassName("", sx.objectCover),
										)}
										src={`${mediaUrl(walkthrough.video)}#t=0.1`}
										preload="metadata"
										muted
										tabIndex={-1}
										onLoadedMetadata={(event) =>
											noteRatio(
												"video",
												event.currentTarget.videoWidth,
												event.currentTarget.videoHeight,
											)
										}
									/>
									<span {...stylex.props(sx.absolute, sx.inset0, sx.grid, sx.placeItemsCenter, sx.bgBlack25, sx.textWhite)}>
										<IconPlay size={18} className={mergeStylexOverrideClassName("", sx.ml05)} />
									</span>
									{/* After the scrim, so the pill keeps its own contrast
									    rather than sitting under a wash of black. */}
									<span className={cn(SHOT_LABEL, WALKTHROUGH_LABEL_TONE.demo)}>
										{WALKTHROUGH_LABEL_TEXT.demo}
									</span>
								</button>
							</figure>
						)}
						{(walkthrough.shots || []).map((shot, i) => (
							<div
								className={cn(
									mergeStylexClassName("", sx.flex, sx.gap1),
									fill &&
										!(isTall(`${i}:before`) || isTall(`${i}:after`)) &&
										mergeStylexClassName("", sx.minW0, sx.flex1),
									(!fill || isTall(`${i}:before`) || isTall(`${i}:after`)) &&
										mergeStylexClassName("", sx.shrink0),
								)}
								key={i}
							>
								{(["before", "after"] as const).map(
									(side) =>
										shot[side] && (
											<figure
												// One tile size for the demo and every still,
												// wider where there is room for it: a thumbnail
												// of a UI is a picture of small things, and two
												// 160px tiles of the same screen are hard to
												// tell apart — which makes the folded strip
												// decorative rather than the answer to "what
												// changed". How wide is `fill`/`tile`, above.
												className={cn(
													mergeStylexClassName("", sx.m0),
													isTall(`${i}:${side}`)
														? mergeStylexClassName("", sx.shrink0)
														: fill
															? mergeStylexClassName("", sx.minW0, sx.flex1)
															: cn(mergeStylexClassName("", sx.shrink0), tile),
												)}
												key={side}
											>
												<button
													type="button"
													// A landscape tile is sized by width, and takes
													// no height cap on top of the ratio: that would
													// silently letterbox the wide sizes. A narrow
													// one is sized by height instead (tileBox).
													className={cn(
														mergeStylexClassName("", sx.relative, sx.block, sx.cursorZoomIn, sx.overflowHidden, sx.roundedMd, sx.border, sx.borderLine, sx.bgTransparent, sx.p0, sx.outlineNone, sx.focusVisibleShadow0003pxVarAccentSoft),
														tileBox(`${i}:${side}`).className,
													)}
													style={tileBox(`${i}:${side}`).style}
													onClick={(e) => open(`${i}:${side}`, e.currentTarget)}
												>
													{/* The alt names the button. An aria-label here
													    would replace the caption with six identical
													    "Open before image preview"s. */}
													<img
														className={cn(
															mergeStylexClassName("", sx.hFull, sx.wFull),
															ownRatio[`${i}:${side}`]
																? mergeStylexClassName("", sx.objectContain)
																: mergeStylexClassName("", sx.objectCover, sx.objectTop),
														)}
														src={mediaUrl(shot[side]!)}
														alt={`${shot.caption || "Change"} · ${side}`}
														loading="lazy"
														onLoad={(event) =>
															noteRatio(
																`${i}:${side}`,
																event.currentTarget.naturalWidth,
																event.currentTarget.naturalHeight,
															)
														}
													/>
													<span
														className={cn(
															SHOT_LABEL,
															WALKTHROUGH_LABEL_TONE[side],
														)}
													>
														{WALKTHROUGH_LABEL_TEXT[side]}
													</span>
												</button>
											</figure>
										),
								)}
							</div>
						))}
					</div>
				</div>
			)}

			<AnimatePresence initial={false}>
				{expanded && (
					<motion.div
						key="walkthrough-body"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={
							reduceMotion
								? { duration: 0 }
								: {
									// Height carries the spatial change. A critically damped
									// spring makes a quick reversal continue from the live size
									// instead of restarting a fixed tween. Opacity lands sooner
									// so the content feels attached to the opening surface.
									height: { type: "spring", duration: 0.36, bounce: 0 },
									opacity: { type: "tween", duration: 0.2, ease },
								}
						}
						className={session ? mergeStylexClassName("", sx.overflowHidden) : undefined}
					>
						{/* No rule under the header: the card is already one surface,
						    and open, the header and the writeup read as parts of it.
						    The gap does the separating. */}
						<div className={cn("space-y-5", session ? mergeStylexClassName("", sx.mt4) : mergeStylexClassName("", sx.mt3))}>
							<section {...stylex.props(sx.px05)}>
								<h3 {...stylex.props(sx.m0, sx.mb15, sx.fontSemibold, sx.leading4, sx.textFaint, typography.meta)}>
									Summary
								</h3>
								<MarkdownBody
									html={summaryHtml} {...mergeStylexProps("markdown", sx.maxW68ch, sx.leading5, sx.textDim, sx.OverflowWrapAnywhere, sx.TextWrapPretty, typography.label)}
								/>
							</section>

							{walkthrough.video && (
								<figure {...stylex.props(sx.m0)}>
									<figcaption {...stylex.props(sx.mb2, sx.flex, sx.minH5, sx.itemsCenter, sx.gap2, sx.px05, sx.textXs, sx.fontMedium, sx.textFg)}>
										<span {...stylex.props(sx.size15, sx.flexShrink0, sx.roundedFull, sx.bgBlue)} />
										<span {...stylex.props(sx.flexShrink0)}>Demo</span>
										{walkthrough.videoTitle && (
											<span {...stylex.props(sx.minW0, sx.truncate, sx.fontNormal, sx.textFaint)}>
												{walkthrough.videoTitle}
											</span>
										)}
									</figcaption>
									<video
										className={cn(
											mergeStylexClassName("", sx.wFull, sx.roundedMd, sx.bgBlack, sx.shadow0001pxVarBorder),
											session && mergeStylexClassName("", sx.maxH60vh, sx.objectContain),
										)}
										src={mediaUrl(walkthrough.video)}
										controls
										preload="metadata"
										title={walkthrough.videoTitle || "Demo video"}
									/>
								</figure>
							)}

							{(walkthrough.shots || []).map((shot, i) => {
								const paired = Boolean(shot.before && shot.after);
								return (
									<section key={i}>
										{shot.caption && (
											<h3 {...stylex.props(sx.m0, sx.px05, sx.pb2, sx.textXs, sx.fontMedium, sx.leading5, sx.textFg)}>
												{shot.caption}
											</h3>
										)}
										<div
											className={cn(
												mergeStylexClassName("", sx.grid, sx.gap25),
												paired
													? mergeStylexClassName("", sx.gridCols2, sx.phoneGridCols1)
													: mergeStylexClassName("", sx.gridCols1),
											)}
										>
											{(["before", "after"] as const).map(
												(side) =>
													shot[side] && (
														<figure {...stylex.props(sx.m0, sx.minW0)} key={side}>
															<button
																type="button" {...mergeStylexProps("", sx.hoverBrightness098, sx.focusVisibleShadowInset0003pxVarAccentSoft, sx.relative, sx.flex, sx.wFull, sx.cursorZoomIn, sx.itemsStart, sx.justifyCenter, sx.overflowHidden, sx.roundedMd, sx.border, sx.borderLine, sx.bgSurface, sx.p0, sx.textLeft, sx.outlineNone, sx.transitionFilter)}
																onClick={(event) =>
																	open(`${i}:${side}`, event.currentTarget)
																}
															>
																<img
																	className={cn(
																		mergeStylexClassName("", sx.block, sx.objectContain, sx.objectTop),
																		// A cap on HEIGHT costs a PORTRAIT shot its
																		// width too: a phone screenshot is about
																		// twice as tall as it is wide, so every
																		// point off the ceiling takes half a point
																		// off the picture. At 256px one rendered
																		// ~120px across — a column of grey. 384
																		// still leaves the pair, the writeup above
																		// it and the next block in view.
																		session ? mergeStylexClassName("", sx.maxH96, sx.maxWFull) : mergeStylexClassName("", sx.wFull),
																	)}
																	src={mediaUrl(shot[side]!)}
																	alt={`${shot.caption || "change"} · ${side}`}
																	loading="lazy"
																/>
															<span
																className={cn(
																	SHOT_LABEL,
																	WALKTHROUGH_LABEL_TONE[side],
																)}
															>
																{WALKTHROUGH_LABEL_TEXT[side]}
															</span>
															</button>
														</figure>
													),
											)}
										</div>
									</section>
								);
							})}
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
