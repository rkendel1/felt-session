/**
 * One scratch asset: how it renders, what you can do to it, and the overlay
 * that lifts it over the conversation.
 *
 * A file an agent wrote is reachable from three places — the chip on the turn
 * that wrote it, the Info panel's list, and the Assets tab — and all three use
 * this preview and action vocabulary, so the file behaves consistently.
 *
 * The overlay is the default way in: an artifact is something you glance at
 * mid-conversation, and an overlay costs nothing to dismiss. The Assets tab
 * stays for when you mean to sit with it — Open in the action bar is the
 * promotion, and the way into the folder around the file.
 */

import React, { useEffect, useState } from "react";
import { marked } from "marked";
import {
	deleteSessionAssetApi,
	sessionAssetDownloadUrl,
	sessionAssetPreviewUrl,
	sessionAssetRawUrl,
	type SessionAssetFile,
} from "../lib/api";
import {
	ASSET_TEXT_CAP,
	adjacentAssetPath,
	assetFileFor,
	assetPreviewKind,
	formatAssetSize,
} from "../lib/asset-preview";
import {
	parseNewSessionLink,
	type NewSessionPrefill,
} from "../lib/new-session-link";
import {
	canUseNativeIOSShare,
	nativeShareWasCancelled,
	saveFileWithNativeShare,
	shareURL,
} from "../lib/native-file-save";
import { absoluteLink, copyToClipboard } from "../lib/share-link";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { Menu } from "../ui/menu";
import { ResponsiveDialog } from "../ui/sheet";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { MarkdownBody } from "./MarkdownBody";
import { openLightbox } from "./MediaLightbox";
import {
	IconArrowDown,
	IconArrowUpRight,
	IconChevronLeft,
	IconChevronRight,
	IconCopy,
	IconDotsHorizontal,
	IconLink,
	IconMessage,
	IconTrash,
	IconX,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minH7: {
			minHeight: "28px"
	},
	shrink0: {
			flexShrink: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	gap1: {
			gap: "4px"
	},
	minW10: {
			minWidth: "40px"
	},
	px1: {
			paddingInline: "4px"
	},
	cursorPointer: {
			cursor: "pointer"
	},
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
	leadingNone: {
			lineHeight: "1"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	textRed: {
			color: "var(--red)"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap05: {
			gap: "2px"
	},
	textCenter: {
			textAlign: "center"
	},
	gap2: {
			gap: "8px"
	},
	textWhite55: {
			color: "#ffffff8c"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	size7: {
			width: "28px",
			height: "28px"
	},
	px0: {
			paddingInline: "0"
	},
	hFull: {
			height: "100%"
	},
	wFull: {
			width: "100%"
	},
	bgWhite: {
			backgroundColor: "var(--color-white)"
	},
	overflowAuto: {
			overflow: "auto"
	},
	p3: {
			padding: "12px"
	},
	maxHFull: {
			maxHeight: "100%"
	},
	cursorZoomIn: {
			cursor: "zoom-in"
	},
	objectContain: {
			objectFit: "contain"
	},
	p4: {
			padding: "16px"
	},
	px4: {
			paddingInline: "16px"
	},
	py3: {
			paddingBlock: "12px"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	breakWords: {
			overflowWrap: "break-word"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	leading15: {
			lineHeight: "1.5"
	},
	minH10: {
			minHeight: "40px"
	},
	px12: {
			paddingInline: "48px"
	},
	pb2: {
			paddingBottom: "8px"
	},
	minH0: {
			minHeight: "0"
	},
	px6: {
			paddingInline: "24px"
	},
	textWhite60: {
			color: "color-mix(in srgb, var(--color-white) 60%, transparent)"
	},
	px5: {
			paddingInline: "20px"
	},
	pt2: {
			paddingTop: "8px"
	},
	pb4: {
			paddingBottom: "16px"
	},
	absolute: {
			position: "absolute"
	},
	right3: {
			right: "12px"
	},
	top3: {
			top: "12px"
	},
	z20: {
			zIndex: "20"
	},
	grid: {
			display: "grid"
	},
	size11: {
			width: "44px",
			height: "44px"
	},
	placeItemsCenter: {
			placeItems: "center"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgWhite15: {
			backgroundColor: "color-mix(in srgb, var(--color-white) 15%, transparent)"
	},
	textWhite: {
			color: "var(--color-white)"
	},
	right0: {
			right: "0"
	},
	top0: {
			top: "0"
	},
	size10: {
			width: "40px",
			height: "40px"
	},
	borderB: { borderBottomStyle: "solid", borderBottomWidth: "1px" },
	borderDivider: { borderColor: "var(--divider)" },
	px3: { paddingInline: "12px" },
	py2: { paddingBlock: "8px" },

	size9: {
		"width": "36px",
		"height": "36px"
	},
	hoverBgWhite15: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "color-mix(in srgb, var(--color-white) 15%, transparent)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in oklab, var(--color-white) 15%, transparent)"
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
	block: {
		"display": "block"
	},
	size15: {
		"width": "6px",
		"height": "6px"
	},
	transitionColors: {
		"transitionProperty": "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	bgFg: {
		"backgroundColor": "var(--text)"
	},
	bgWhite35: {
		"backgroundColor": "#ffffff59",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in oklab, var(--color-white) 35%, transparent)"
		}
	},
	bgLineStrong: {
		"backgroundColor": "var(--border-strong)"
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	top12: {
		"top": "50%"
	},
	TranslateY12: {
		"--tw-translate-y": "calc(calc(1 / 2 * 100%) * -1)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	bgRaised: {
		"backgroundColor": "var(--bg-raised)"
	},
	rightFull: {
		"right": "100%"
	},
	mr3: {
		"marginRight": "12px"
	},
	leftFull: {
		"left": "100%"
	},
	ml3: {
		"marginLeft": "12px"
	},
	activeScale096: {
		":active": {
			"scale": ".96"
		}
	},
	phoneSize11: {
		"@media (max-width: 720px)": {
			"width": "44px",
			"height": "44px"
		}
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
	hoverTextWhite80: {
		"@media (hover: hover)": {
			":hover": {
				"color": "#fffc"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"color": "color-mix(in oklab, var(--color-white) 80%, transparent)"
				}
			}
		}
	},
	bgPanel: {
		"backgroundColor": "var(--bg-panel)"
	},
	activeBgPressed: {
		":active": {
			"backgroundColor": "var(--hover-strong)"
		}
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
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
	textXs: {
		"fontSize": "var(--type-label)",
		"lineHeight": "var(--tw-leading,var(--text-xs--line-height))"
	},
	bgWhite10: {
		"backgroundColor": "color-mix(in srgb, var(--color-white) 10%, transparent)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in oklab, var(--color-white) 10%, transparent)"
		}
	},
	ring1: {
		"--tw-ring-shadow": "var(--tw-ring-inset,) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color,currentcolor)",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	ringWhite10: {
		"--tw-ring-color": "color-mix(in srgb, var(--color-white) 10%, transparent)",
		"@supports (color: color-mix(in lab, red, red))": {
			"--tw-ring-color": "color-mix(in oklab, var(--color-white) 10%, transparent)"
		}
	},
	backdropBlurXl: {
		"--tw-backdrop-blur": "blur(var(--blur-xl))",
		"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
		"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
	},
	left0: {
		"left": "0"
	},
	topFull: {
		"top": "100%"
	},
	mt2: {
		"marginTop": "8px"
	},
	textSm: {
		"fontSize": "var(--type-label)",
		"lineHeight": "var(--tw-leading,var(--text-sm--line-height))"
	},
	lineClamp2: {
		"WebkitLineClamp": "2",
		"WebkitBoxOrient": "vertical",
		"display": "-webkit-box",
		"overflow": "hidden"
	},
	textWhite75: {
		"color": "#ffffffbf",
		"@supports (color: color-mix(in lab, red, red))": {
			"color": "color-mix(in oklab, var(--color-white) 75%, transparent)"
		}
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	bgBlack: {
		"backgroundColor": "var(--color-black)"
	},
	relative: {
		"position": "relative"
	},
	m3: {
		"margin": "12px"
	},
	roundedXl: {
		"borderRadius": "calc(18px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgSurface: {
		"backgroundColor": "var(--bg)"
	},

	transitionTransformBackgroundColorColor: {
		"transitionProperty": "transform,background-color,color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	maxWMin720px90vw: {
		"maxWidth": "min(720px,90vw)"
	},

	transitionTransformBackgroundColor: {
		"transitionProperty": "transform,background-color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
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
});

type AssetNavigation = {
	index: number;
	count: number;
	onPrevious: () => void;
	onNext: () => void;
	onSelect: (index: number) => void;
};

function AssetPager({
	navigation,
	arrows = false,
	onDark = false,
}: {
	navigation: AssetNavigation;
	arrows?: boolean;
	/** Desktop overlays sit directly on the dimmed backdrop, like the media lightbox. */
	onDark?: boolean;
}) {
	const { index, count, onPrevious, onNext, onSelect } = navigation;
	const positionLabel = `Asset ${index + 1} of ${count}`;
	return (
		<nav
			aria-label="Asset navigation"
			{...stylex.props(sx.flex, sx.minH7, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.gap1)}
		>
			{arrows && (
				<Tooltip label="Previous asset (Left arrow)">
					<Button
						variant="ghost"
						size="sm"
						icon={<IconChevronLeft size={16} />}
						aria-label="Previous asset"
						className={cn(
							mergeStylexClassName("", sx.size9),
							onDark && mergeStylexClassName("", sx.textWhite60, sx.hoverBgWhite15, sx.hoverTextWhite),
						)}
						onClick={onPrevious}
					/>
				</Tooltip>
			)}
			<div
				aria-label={positionLabel}
				title={positionLabel}
				{...stylex.props(sx.flex, sx.minW10, sx.itemsCenter, sx.justifyCenter, sx.px1)}
			>
				{count <= 10 ? (
					Array.from({ length: count }, (_, dot) => (
						<button
							key={dot}
							type="button"
							onClick={() => onSelect(dot)}
							aria-label={`Show ${dot + 1} of ${count}`}
							aria-current={dot === index ? "true" : undefined} {...mergeStylexProps("group", sx.shrink0, sx.cursorPointer, sx.border0, sx.bgTransparent, sx.p1, sx.leadingNone)}
						>
							<span
								className={cn(
									mergeStylexClassName("", sx.block, sx.size15, sx.roundedFull, sx.transitionColors),
									dot === index
										? onDark
											? mergeStylexClassName("", sx.bgWhite)
											: mergeStylexClassName("", sx.bgFg)
										: onDark
											? mergeStylexClassName("group-hover:bg-white/70", sx.bgWhite35)
											: mergeStylexClassName("group-hover:bg-dim", sx.bgLineStrong),
								)}
							/>
						</button>
					))
				) : (
					<span
						role="status"
						className={cn(
							mergeStylexClassName("", sx.px1, typography.meta, sx.tabularNums),
							onDark ? mergeStylexClassName("", sx.textWhite60) : mergeStylexClassName("", sx.textFaint),
						)}
					>
						{index + 1} / {count}
					</span>
				)}
			</div>
			{arrows && (
				<Tooltip label="Next asset (Right arrow)">
					<Button
						variant="ghost"
						size="sm"
						icon={<IconChevronRight size={16} />}
						aria-label="Next asset"
						className={cn(
							mergeStylexClassName("", sx.size9),
							onDark && mergeStylexClassName("", sx.textWhite60, sx.hoverBgWhite15, sx.hoverTextWhite),
						)}
						onClick={onNext}
					/>
				</Tooltip>
			)}
		</nav>
	);
}

function AssetSideButton({
	direction,
	onClick,
}: {
	direction: "previous" | "next";
	onClick: () => void;
}) {
	const previous = direction === "previous";
	const label = previous ? "Previous asset" : "Next asset";
	return (
		<Tooltip label={`${label} (${previous ? "Left" : "Right"} arrow)`}>
			<Button
				variant="default"
				size="lg"
				icon={
					previous ? (
						<IconChevronLeft size={22} />
					) : (
						<IconChevronRight size={22} />
					)
				}
				aria-label={label}
				className={cn(
					mergeStylexClassName("smooth-shadow-sm", sx.absolute, sx.top12, sx.z20, sx.size10, sx.TranslateY12, sx.roundedFull, sx.bgRaised),
					previous ? mergeStylexClassName("", sx.rightFull, sx.mr3) : mergeStylexClassName("", sx.leftFull, sx.ml3),
				)}
				onClick={onClick}
			/>
		</Tooltip>
	);
}

function AssetMenu({
	sessionId,
	file,
	refresh,
	onClose,
	phone = false,
	deleteOnly = false,
	bar = false,
}: {
	sessionId: string;
	file: SessionAssetFile;
	refresh?: () => void;
	onClose?: () => void;
	phone?: boolean;
	/** The overlay exposes its safe actions directly and keeps only Delete here. */
	deleteOnly?: boolean;
	/** Match the overlay's centered action-bar controls. */
	bar?: boolean;
}) {
	const rawUrl = sessionAssetPreviewUrl(sessionId, file);
	const stableUrl = sessionAssetRawUrl(sessionId, file.path);
	const nativeShare = canUseNativeIOSShare();
	const name = file.path.split("/").pop() || "asset";

	async function onDownload() {
		await (async () => {
await saveFileWithNativeShare(sessionAssetDownloadUrl(sessionId, file), name);
})().catch(async (error) => {
if (!nativeShareWasCancelled(error)) toast("Could not save that file");
});
	}

	async function onOpen() {
		await (async () => {
await shareURL(rawUrl);
})().catch(async (error) => {
if (!nativeShareWasCancelled(error)) toast("Could not share that link");
});
	}

	async function onDelete() {
		if (!confirm(`Delete ${file.path}?`)) return;
		await (async () => {
await deleteSessionAssetApi(sessionId, file.path);
			refresh?.();
			onClose?.();
})().catch(async () => {
toast("Could not delete that file");
});
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label={deleteOnly ? "More asset actions" : "Asset actions"}
				className={cn(
					mergeStylexClassName("", sx.flex, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.border0),
					bar
						? cn(
								mergeStylexClassName("", sx.transitionTransformBackgroundColorColor, sx.size10, sx.roundedFull, sx.bgTransparent, sx.activeScale096, sx.phoneSize11),
								phone
									? mergeStylexClassName("data-[popup-open]:bg-white/10 data-[popup-open]:text-white/80", sx.textWhite55, sx.hoverBgWhite10, sx.hoverTextWhite80)
									: mergeStylexClassName("data-[popup-open]:bg-white/15 data-[popup-open]:text-white", sx.textWhite60, sx.hoverBgWhite15, sx.hoverTextWhite),
							)
						: phone
							? mergeStylexClassName("data-[popup-open]:bg-pressed data-[popup-open]:text-fg", sx.size11, sx.roundedFull, sx.bgPanel, sx.textDim, sx.activeBgPressed)
							: mergeStylexClassName("data-[popup-open]:bg-hover data-[popup-open]:text-fg", sx.size7, sx.roundedControl, sx.bgTransparent, sx.textDim, sx.hoverBgHover, sx.hoverTextFg),
				)}
			>
				<IconDotsHorizontal size={phone ? 24 : 16} />
			</Menu.Trigger>
			<Menu.Popup align="end">
				{!deleteOnly && (
					<>
						<Menu.Item
							{...(nativeShare
								? { onClick: onDownload }
								: { render: <a href={sessionAssetDownloadUrl(sessionId, file)} /> })}
						>
							<IconArrowDown size={18} className={mergeStylexOverrideClassName("", sx.textFaint)} />
							Download
						</Menu.Item>
						<Menu.Item
							{...(nativeShare
								? { onClick: onOpen }
								: { render: <a href={rawUrl} target="_blank" rel="noreferrer" /> })}
						>
							<IconArrowUpRight size={18} className={mergeStylexOverrideClassName("", sx.textFaint)} />
							{nativeShare ? "Open or share" : "Open in a browser tab"}
						</Menu.Item>
						<Menu.Item
							onClick={() =>
								copyToClipboard(absoluteLink(stableUrl), () => toast("Link copied"))
							}
						>
							<IconCopy size={18} className={mergeStylexOverrideClassName("", sx.textFaint)} />
							Copy link
						</Menu.Item>
						<Menu.Separator />
					</>
				)}
				<Menu.Item onClick={onDelete} className={mergeStylexOverrideClassName("", sx.textRed)}>
					<IconTrash size={18} />
					Delete
				</Menu.Item>
			</Menu.Popup>
		</Menu.Root>
	);
}

/** Safe file actions stay visible in the overlay, matching the media
 * lightbox. Delete remains behind More so a destructive action never reads as
 * a peer of Comment, Download, Copy link, and Open. */
function AssetOverlayActionBar({
	sessionId,
	file,
	refresh,
	onClose,
	onOpenAsTab,
	phone,
}: {
	sessionId: string;
	file: SessionAssetFile;
	refresh: () => void;
	onClose: () => void;
	onOpenAsTab?: () => void;
	phone: boolean;
}) {
	const rawUrl = sessionAssetPreviewUrl(sessionId, file);
	const stableUrl = sessionAssetRawUrl(sessionId, file.path);
	const downloadUrl = sessionAssetDownloadUrl(sessionId, file);
	const nativeShare = canUseNativeIOSShare();
	const name = file.path.split("/").pop() || "asset";
	const commentable = assetPreviewKind(file.path) === "image";
	const actionClass = cn(
		mergeStylexClassName("", sx.shrink0, sx.cursorPointer),
		phone &&
			mergeStylexClassName("", sx.size11, sx.roundedFull, sx.px0, sx.textXs, sx.textWhite55, sx.hoverBgWhite10, sx.hoverTextWhite80),
	);
	const actionSize: "sm" | "md" = phone ? "sm" : "md";
	const actionLabel = (label: string) => (phone ? null : label);

	async function download() {
		await (async () => {
await saveFileWithNativeShare(downloadUrl, name);
})().catch(async (error) => {
if (!nativeShareWasCancelled(error)) toast("Could not save that file");
});
	}

	async function open() {
		await (async () => {
await shareURL(rawUrl);
})().catch(async (error) => {
if (!nativeShareWasCancelled(error)) toast("Could not share that link");
});
	}

	return (
		<div
			role="group"
			aria-label="Asset actions"
			className={cn(
				mergeStylexClassName("", sx.flex, sx.itemsCenter, sx.justifyCenter, sx.gap1),
				phone &&
					mergeStylexClassName("", sx.roundedFull, sx.bgWhite10, sx.p1, sx.ring1, sx.ringWhite10, sx.backdropBlurXl),
			)}
		>
			{commentable && (
				<Button
					variant="overlay"
					size={actionSize}
					icon={<IconMessage size={phone ? 24 : 20} />}
					className={actionClass}
					aria-label={phone ? "Comment" : undefined}
					onClick={() =>
						openLightbox(
							[
								{
									kind: "image",
									src: rawUrl,
									sessionTitle: file.path,
									description: file.description,
									commentSessionId: sessionId,
								},
							],
							0,
							null,
							{ startCommenting: true },
						)
					}
				>
					{actionLabel("Comment")}
				</Button>
			)}
			{nativeShare ? (
				<Button
					variant="overlay"
					size={actionSize}
					icon={<IconArrowDown size={phone ? 24 : 20} />}
					className={actionClass}
					aria-label={phone ? "Download" : undefined}
					onClick={download}
				>
					{actionLabel("Download")}
				</Button>
			) : (
				<Button
					variant="overlay"
					size={actionSize}
					icon={<IconArrowDown size={phone ? 24 : 20} />}
					className={actionClass}
					aria-label={phone ? "Download" : undefined}
					render={<a href={downloadUrl} />}
				>
					{actionLabel("Download")}
				</Button>
			)}
			<Button
				variant="overlay"
				size={actionSize}
				icon={<IconLink size={phone ? 24 : 20} />}
				className={actionClass}
				aria-label={phone ? "Copy link" : undefined}
				onClick={() =>
					copyToClipboard(absoluteLink(stableUrl), () => toast("Link copied"))
				}
			>
				{actionLabel("Copy link")}
			</Button>
			{onOpenAsTab ? (
				<Button
					variant="overlay"
					size={actionSize}
					icon={<IconArrowUpRight size={phone ? 24 : 20} />}
					className={actionClass}
					aria-label={phone ? "Open" : undefined}
					onClick={onOpenAsTab}
				>
					{actionLabel("Open")}
				</Button>
			) : nativeShare ? (
				<Button
					variant="overlay"
					size={actionSize}
					icon={<IconArrowUpRight size={phone ? 24 : 20} />}
					className={actionClass}
					aria-label={phone ? "Open or share" : undefined}
					onClick={open}
				>
					{actionLabel("Open or share")}
				</Button>
			) : (
				<Button
					variant="overlay"
					size={actionSize}
					icon={<IconArrowUpRight size={phone ? 24 : 20} />}
					className={actionClass}
					aria-label={phone ? "Open" : undefined}
					render={<a href={rawUrl} target="_blank" rel="noreferrer" />}
				>
					{actionLabel("Open")}
				</Button>
			)}
			<AssetMenu
				sessionId={sessionId}
				file={file}
				refresh={refresh}
				onClose={onClose}
				phone={phone}
				deleteOnly
				bar
			/>
		</div>
	);
}

/**
 * What you are looking at, under the file — name, then description, then the
 * pager. The same stack the media lightbox puts under a picture, because an
 * asset and a screenshot are the same gesture: glance at one thing lifted over
 * the conversation. Actions stay in their own toolbar, so this stack remains
 * a description rather than another row of controls.
 */
function AssetOverlayFooter({
	file,
	navigation,
	phone,
	showSize,
}: {
	file: SessionAssetFile;
	navigation: AssetNavigation | null;
	phone: boolean;
	showSize: boolean;
}) {
	const name = file.path.split("/").pop() || file.path;
	return (
		<div
			className={cn(
				mergeStylexClassName("", sx.z20, sx.flex, sx.shrink0, sx.flexCol, sx.itemsCenter, sx.gap1, sx.px3, sx.py2),
				!phone && mergeStylexClassName("", sx.absolute, sx.left0, sx.right0, sx.topFull, sx.mt2),
			)}
		>
			<div {...stylex.props(sx.flex, sx.maxWFull, sx.flexCol, sx.itemsCenter, sx.gap05, sx.textCenter)}>
				<div {...stylex.props(sx.flex, sx.maxWFull, sx.itemsCenter, sx.justifyCenter, sx.gap2)}>
					<div
						className={cn(
							mergeStylexClassName("", sx.maxWFull, sx.truncate, sx.fontMedium, sx.textWhite),
							phone ? mergeStylexClassName("", typography.label) : mergeStylexClassName("", sx.textSm),
						)}
						title={file.path}
					>
						{name}
					</div>
					{showSize && (
						<span
							{...stylex.props(sx.shrink0, sx.textWhite55, typography.meta)}
						>
							{formatAssetSize(file.size)}
						</span>
					)}
				</div>
				{file.description && (
					<div
						className={cn(
							mergeStylexClassName("", sx.maxWMin720px90vw, sx.lineClamp2, sx.leadingSnug, sx.textWhite75),
							phone ? mergeStylexClassName("", typography.supporting) : mergeStylexClassName("", sx.textSm),
						)}
					>
						{file.description}
					</div>
				)}
			</div>
			<div {...stylex.props(sx.flex, sx.maxWFull, sx.itemsCenter, sx.justifyCenter, sx.gap2)}>
				{navigation && (
					<AssetPager navigation={navigation} arrows={phone} onDark />
				)}
			</div>
		</div>
	);
}

/**
 * The Assets tab's file header and operations, in one row.
 *
 * The promotion into a tab earns a place on the surface. File operations
 * live behind the overflow, because a header of six
 * peer-looking text links makes the destructive one exactly as easy to hit as
 * the harmless ones. Omit `onOpenAsTab` where the tab IS the surface.
 */
export function AssetActions({
	sessionId,
	file,
	refresh,
	onOpenAsTab,
	onClose,
	showMenu = true,
	showSize = false,
	className,
}: {
	sessionId: string;
	file: SessionAssetFile;
	/** Re-list the folder after a delete. */
	refresh?: () => void;
	/** Optionally promote this file into the workspace's Assets tab. */
	onOpenAsTab?: () => void;
	/** Dismiss the surface — the overlay's ✕. Also called after a delete, since
	 *  there is nothing left to show. */
	onClose?: () => void;
	/** Hide this menu when another row owns the file actions. */
	showMenu?: boolean;
	/** False for a chip path whose folder listing has not caught up yet. */
	showSize?: boolean;
	className?: string;
}) {
	const name = file.path.split("/").pop() || file.path;
	const folder = file.path.includes("/")
		? file.path.slice(0, file.path.lastIndexOf("/"))
		: null;

	return (
		<div {...mergeStylexProps(className, sx.flex, sx.shrink0, sx.itemsCenter, sx.gap2, sx.borderB, sx.borderDivider, sx.px3, sx.py2)}>
			<div {...stylex.props(sx.minW0, sx.flex1)} title={file.path}>
				<div {...stylex.props(sx.truncate, sx.fontMedium, sx.textFg, typography.label)}>{name}</div>
				{file.description && (
					<div {...mergeStylexProps("", sx.lineClamp2, sx.leadingSnug, sx.textDim, typography.supporting)}>
						{file.description}
					</div>
				)}
				{folder && (
					<div {...stylex.props(sx.truncate, sx.textFaint, typography.meta)}>{folder}</div>
				)}
			</div>
			{showSize && (
				<span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>
					{formatAssetSize(file.size)}
				</span>
			)}
			{onOpenAsTab && (
				<Button
					variant="ghost"
					size="sm"
					className={mergeStylexOverrideClassName("", sx.shrink0)}
					onClick={onOpenAsTab}
				>
					Open as tab
				</Button>
			)}
			{showMenu && (
				<AssetMenu
					sessionId={sessionId}
					file={file}
					refresh={refresh}
					onClose={onClose}
				/>
			)}
			{onClose && (
				<Button
					variant="ghost"
					size="sm"
					aria-label="Close"
					className={mergeStylexOverrideClassName("", sx.size7, sx.shrink0, sx.justifyCenter, sx.px0)}
					onClick={onClose}
				>
					<IconX size={16} />
				</Button>
			)}
		</div>
	);
}

/**
 * The file itself. HTML goes in an iframe served from the path-based raw
 * route, so a multi-file artifact's relative references (./style.css,
 * ./data.json) resolve to its siblings.
 */
export function AssetPreview({
	sessionId,
	file,
	onOpenNewSession,
	onBackdropClick,
	className,
}: {
	sessionId: string;
	file: SessionAssetFile;
	/** A link inside an HTML asset that spells out a new session — the artifact
	 *  can hand work back to the app it was written in. */
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
	/** Dismiss an overlay when the letterboxed image canvas is clicked. */
	onBackdropClick?: () => void;
	className?: string;
}) {
	const kind = assetPreviewKind(file.path);
	const rawUrl = sessionAssetPreviewUrl(sessionId, file);

	// Text-ish previews fetch the body themselves.
	const [text, setText] = useState<string | null>(null);
	const [textFailed, setTextFailed] = useState(false);
	useEffect(() => {
		setText(null);
		setTextFailed(false);
		if (kind !== "text" && kind !== "markdown") return;
		let alive = true;
		fetch(rawUrl)
			.then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
			.then((t) => {
				if (alive) setText(t.length > ASSET_TEXT_CAP ? t.slice(0, ASSET_TEXT_CAP) : t);
			})
			.catch(() => {
				if (alive) setTextFailed(true);
			});
		return () => {
			alive = false;
		};
	}, [rawUrl, kind]);

	return (
		<div {...mergeStylexProps(className, sx.minH0, sx.flex1, sx.overflowAuto)}>
			{kind === "html" ? (
				// allow-same-origin so the page can fetch() sibling assets
				// (./data.json); the sandbox still blocks top navigation. The
				// content is our own agents' output on a tailnet-only UI.
				<iframe
					key={rawUrl}
					title={file.path}
					src={rawUrl}
					sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads"
					onLoad={(event) => {
						const document = event.currentTarget.contentDocument;
						if (!document) return;
						document.addEventListener("click", (clickEvent) => {
							const link = (clickEvent.target as Element | null)?.closest?.("a");
							const prefill = link ? parseNewSessionLink(link.href) : null;
							if (!prefill) return;
							clickEvent.preventDefault();
							onOpenNewSession(prefill);
						});
					}}
					{...stylex.props(sx.hFull, sx.wFull, sx.border0, sx.bgWhite)}
				/>
			) : kind === "pdf" ? (
				// No sandbox: Chrome's built-in PDF viewer won't render in a
				// sandboxed iframe.
				<iframe
					key={rawUrl}
					title={file.path}
					src={rawUrl}
					{...stylex.props(sx.hFull, sx.wFull, sx.border0)}
				/>
			) : kind === "image" ? (
				<div
					{...stylex.props(sx.flex, sx.hFull, sx.itemsCenter, sx.justifyCenter, sx.overflowAuto, sx.p3)}
					onClick={onBackdropClick}
				>
					<button
						type="button"
						{...stylex.props(sx.flex, sx.maxHFull, sx.maxWFull, sx.cursorZoomIn, sx.border0, sx.bgTransparent)}
						onClick={(event) => {
							event.stopPropagation();
							openLightbox(
								[
									{
										kind: "image",
										src: rawUrl,
										sessionTitle: file.path,
										description: file.description,
									},
								],
								0,
								event.currentTarget,
							);
						}}
						aria-label={`Zoom ${file.path}`}
					>
						<img
							src={rawUrl}
							alt={file.path}
							{...stylex.props(sx.maxHFull, sx.maxWFull, sx.objectContain)}
						/>
					</button>
				</div>
			) : kind === "video" ? (
				<video src={rawUrl} controls {...stylex.props(sx.hFull, sx.wFull)} />
			) : kind === "audio" ? (
				<div {...stylex.props(sx.p4)}>
					<audio src={rawUrl} controls {...stylex.props(sx.wFull)} />
				</div>
			) : kind === "markdown" ? (
				textFailed ? (
					<div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>Could not load this file.</div>
				) : text === null ? (
					<div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>Loading…</div>
				) : (
					<MarkdownBody {...mergeStylexProps("markdown", sx.px4, sx.py3, typography.label)}
						html={marked.parse(text, { async: false }) as string}
					/>
				)
			) : kind === "text" ? (
				textFailed ? (
					<div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>Could not load this file.</div>
				) : text === null ? (
					<div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>Loading…</div>
				) : (
					<pre {...stylex.props(sx.whitespacePreWrap, sx.breakWords, sx.px4, sx.py3, sx.fontMono, sx.leading15, sx.textFg, typography.label)}>
						{text}
						{file.size > ASSET_TEXT_CAP ? "\n… (truncated preview)" : ""}
					</pre>
				)
			) : (
				<div {...stylex.props(sx.flex, sx.hFull, sx.itemsCenter, sx.justifyCenter, sx.textFaint, typography.label)}>
					No inline preview for this file type. Use Download.
				</div>
			)}
		</div>
	);
}

/**
 * One asset, over the conversation.
 *
 * `path` null means closed; the last file stays rendered while the panel
 * animates away, so a dismissal doesn't blink to an empty box on its way out.
 */
export function AssetOverlay({
	sessionId,
	path,
	files,
	refresh,
	onClose,
	onSelectPath,
	onOpenAsTab,
	onOpenNewSession,
}: {
	sessionId: string;
	path: string | null;
	files: SessionAssetFile[];
	refresh: () => void;
	onClose: () => void;
	/** Show another file in this overlay. */
	onSelectPath: (path: string) => void;
	/** Promote the open file into the Assets tab (and dismiss). */
	onOpenAsTab?: (path: string) => void;
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
	const isPhone = useIsPhone();
	// Survives `path` going null so the exit animation has something to show.
	// While open, render directly from the controlled path so repeated arrow
	// presses never paint the previous asset for a frame.
	const [lastPath, setLastPath] = useState<string | null>(path);
	const [listedPath, setListedPath] = useState<string | null>(null);
	const [missingPath, setMissingPath] = useState<string | null>(null);
	useEffect(() => {
		if (path) {
			setLastPath(path);
			setMissingPath(null);
		}
	}, [path]);
	useEffect(() => {
		if (!path) return;
		if (files.some((candidate) => candidate.path === path)) {
			setListedPath(path);
			setMissingPath(null);
			return;
		}
		if (listedPath === path) {
			onClose();
			return;
		}
		const timeout = window.setTimeout(() => setMissingPath(path), 1_500);
		return () => window.clearTimeout(timeout);
	}, [path, files, listedPath, onClose]);
	useEffect(() => {
		if (!path || files.length < 2) return;
		const paths = files.map((file) => file.path);
		const onKey = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey ||
				(event.key !== "ArrowLeft" && event.key !== "ArrowRight")
			)
				return;
			// Menus and controls use these keys themselves. Embedded HTML/PDF content
			// lives in its own document and keeps its own keyboard interactions too.
			if (document.querySelector(".app-menu-popup")) return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					Boolean(
						target.closest(
							"input, textarea, select, audio, video, [contenteditable='true']",
						),
					))
			)
				return;
			const next = adjacentAssetPath(
				paths,
				path,
				event.key === "ArrowLeft" ? -1 : 1,
			);
			if (!next) return;
			event.preventDefault();
			event.stopPropagation();
			onSelectPath(next);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [path, files, onSelectPath]);
	const shown = path ?? lastPath;
	if (!shown) return null;
	const file = assetFileFor(shown, files);
	const name = file.path.split("/").pop() || file.path;
	const kind = assetPreviewKind(file.path);
	const visual = kind === "image" || kind === "video";
	const listed = files.some((candidate) => candidate.path === shown);
	const listedIndex = files.findIndex((candidate) => candidate.path === shown);
	const navigate = (direction: -1 | 1) => {
		const next = adjacentAssetPath(
			files.map((candidate) => candidate.path),
			shown,
			direction,
		);
		if (next) onSelectPath(next);
	};
	const navigation: AssetNavigation | null =
		listedIndex >= 0 && files.length > 1
			? {
					index: listedIndex,
					count: files.length,
					onPrevious: () => navigate(-1),
					onNext: () => navigate(1),
					onSelect: (index) => {
						const selected = files[index]?.path;
						if (selected) onSelectPath(selected);
					},
				}
			: null;
	const footer = (
		<AssetOverlayFooter
			file={file}
			navigation={navigation}
			phone={isPhone}
			showSize={listed}
		/>
	);
	const actions = (
		<AssetOverlayActionBar
			sessionId={sessionId}
			file={file}
			refresh={refresh}
			onClose={onClose}
			onOpenAsTab={onOpenAsTab ? () => onOpenAsTab(file.path) : undefined}
			phone={isPhone}
		/>
	);

	return (
		<ResponsiveDialog
			open={Boolean(path)}
			onClose={onClose}
			phone={isPhone}
			label={`Preview ${name}`}
			// Assets float directly on the scrim, like transcript media. Files
			// that need a page surface bring their own inside the stage below.
			modalClassName={mergeStylexClassName("[box-shadow:none]!", sharedClassStyles.hMin820px78vh, sharedClassStyles.wMin1120px84vw, sharedClassStyles.maxWNone, sharedClassStyles.overflowVisible, sharedClassStyles.bgTransparent)}
			sheetClassName={mergeStylexClassName("[border-radius:0]! [box-shadow:none]!", sharedClassStyles.top0, sharedClassStyles.h100dvh, sharedClassStyles.maxHNone, sharedClassStyles.bgBlack)}
			backdropClassName={mergeStylexClassName("", sharedClassStyles.bgBlack85)}
			showPhoneGrabber={false}
		>
			<div
				className={cn(
					mergeStylexClassName("", sx.flex, sx.minH0, sx.flex1, sx.flexCol, sx.overflowHidden),
					isPhone && mergeStylexClassName("", sx.bgBlack),
				)}
			>
				{/* Desktop keeps the centered action bar above the asset. Phones put
				    the same controls at the bottom, beside the caption and pager. */}
				{!isPhone && (
					<div {...stylex.props(sx.flex, sx.minH10, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.px12, sx.pb2)}>
						{actions}
					</div>
				)}
				<div
					className={cn(
						mergeStylexClassName("", sx.relative, sx.flex, sx.minH0, sx.flex1),
						!visual && mergeStylexClassName("", sx.m3, sx.overflowHidden, sx.roundedXl, sx.bgSurface, sx.textFg),
					)}
				>
					{missingPath === file.path ? (
						<div {...stylex.props(sx.flex, sx.minH0, sx.flex1, sx.itemsCenter, sx.justifyCenter, sx.px6, sx.textCenter, sx.textWhite60, typography.label)}>
							This file is no longer available.
						</div>
					) : (
						<AssetPreview
							sessionId={sessionId}
							file={file}
							onBackdropClick={onClose}
							onOpenNewSession={(prefill) => {
								onClose();
								onOpenNewSession(prefill);
							}}
						/>
					)}
				</div>
				{isPhone && footer}
				{isPhone && (
					<div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.px5, sx.pt2, sx.pb4)}>
						{actions}
					</div>
				)}
			</div>
			{!isPhone && footer}
			{isPhone ? (
				<button
					type="button"
					aria-label="Close" {...mergeStylexProps("", sx.backdropBlurXl, sx.transitionTransformBackgroundColor, sx.activeScale096, sx.hoverBgWhite20, sx.absolute, sx.right3, sx.top3, sx.z20, sx.grid, sx.size11, sx.placeItemsCenter, sx.roundedFull, sx.border0, sx.bgWhite15, sx.textWhite)}
					onClick={onClose}
				>
					<IconX size={24} />
				</button>
			) : (
				<Tooltip label="Close">
					<button
						type="button"
						aria-label="Close" {...mergeStylexProps("", sx.backdropBlurXl, sx.transitionTransformBackgroundColor, sx.activeScale096, sx.hoverBgWhite20, sx.absolute, sx.right0, sx.top0, sx.z20, sx.grid, sx.size10, sx.placeItemsCenter, sx.roundedFull, sx.border0, sx.bgWhite15, sx.textWhite)}
						onClick={onClose}
					>
						<IconX size={20} />
					</button>
				</Tooltip>
			)}
			{!isPhone && navigation && (
				<>
					<AssetSideButton direction="previous" onClick={navigation.onPrevious} />
					<AssetSideButton direction="next" onClick={navigation.onNext} />
				</>
			)}
		</ResponsiveDialog>
	);
}
