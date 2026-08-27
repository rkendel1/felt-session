import React, { useEffect, useRef, useState } from "react";
import { fetchShippedChangeChannels } from "../lib/api/shipped-changes";
import { imageFilesFromPaste, uploadFile } from "../lib/images";
import { noAutofill } from "../lib/composer-autofill";
import { Button } from "../ui/button";
import { OverlayAction } from "../ui/overlay-action";
import { OptionSelect } from "../ui/select";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { BrandMark } from "./BrandMark";
import { openLightbox } from "./MediaLightbox";
import { IconPlus, IconUndo, IconX } from "./icons";
import { Spinner } from "../ui/spinner";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mxAuto: {
			marginInline: "auto"
	},
	mt2: {
			marginTop: "8px"
	},
	mb6: {
			marginBottom: "24px"
	},
	flex: {
			display: "flex"
	},
	wFull: {
			width: "100%"
	},
	maxWVarSessionCol: {
			maxWidth: "var(--session-col)"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap15: {
			gap: "6px"
	},
	px1: {
			paddingInline: "4px"
	},
	leading5: {
			lineHeight: "20px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	underline: {
			textDecorationLine: "underline"
	},
	underlineOffset2: {
			textUnderlineOffset: "2px"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	gap05: {
			gap: "2px"
	},
	mb2: {
			marginBottom: "8px"
	},
	roundedVarComposerRadius: {
			borderRadius: "var(--composer-radius)"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderColorVarComposerBorder: {
			borderColor: "var(--composer-border)"
	},
	bgVarComposerSurface: {
			backgroundColor: "var(--composer-surface)"
	},
	px35: {
			paddingInline: "14px"
	},
	pt35: {
			paddingTop: "14px"
	},
	pb25: {
			paddingBottom: "10px"
	},
	block: {
			display: "block"
	},
	minH14: {
			minHeight: "56px"
	},
	maxH32: {
			maxHeight: "128px"
	},
	resizeNone: {
			resize: "none"
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
	leading155: {
			lineHeight: "1.55"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	FieldSizingContent: {
			fieldSizing: "content"
	},
	mt05: {
			marginTop: "2px"
	},
	gap2: {
			gap: "8px"
	},
	overflowXAuto: {
			overflowX: "auto"
	},
	pt2: {
			paddingTop: "8px"
	},
	pr2: {
			paddingRight: "8px"
	},
	pb05: {
			paddingBottom: "2px"
	},
	ScrollbarWidthNone: {
			scrollbarWidth: "none"
	},
	relative: {
			position: "relative"
	},
	shrink0: {
			flexShrink: "0"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	h16: {
			height: "64px"
	},
	w24: {
			width: "96px"
	},
	borderLineStrong: {
			borderColor: "var(--border-strong)"
	},
	objectCover: {
			objectFit: "cover"
	},
	objectTop: {
			objectPosition: "top"
	},
	textRed: {
			color: "var(--red)"
	},
	mt25: {
			marginTop: "10px"
	},
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	size8: {
			width: "32px",
			height: "32px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	flex1: {
			flex: "1"
	},
	w28: {
			width: "112px"
	},

	phoneSize10: {
		"@media (max-width: 720px)": {
			"width": "40px",
			"height": "40px"
		}
	},
	phoneMinH10: {
		"@media (max-width: 720px)": {
			"minHeight": "40px"
		}
	},

	decorationLine: {
		"WebkitTextDecorationColor": "var(--border)",
		"textDecorationColor": "var(--border)"
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	hoverDecorationCurrent: {
		"@media (hover: hover)": {
			":hover": {
				"textDecorationColor": "currentColor"
			}
		}
	},
	shadowVarComposerShadow: {
		"--tw-shadow": "var(--composer-shadow)",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	transitionBorderColorBoxShadow: {
		"transitionProperty": "border-color,box-shadow",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	focusWithinBorderAccent: {
		":focusWithin": {
			"borderColor": "var(--accent)"
		}
	},
	desktopBorderTransparent: {
		"@media (min-width: 721px)": {
			"borderColor": "transparent"
		}
	},
	desktopSmoothRingColorVarComposerBorder: {
		"@media (min-width: 721px)": {
			"--smooth-ring-color": "var(--composer-border)"
		}
	},
	desktopSmoothShadowRingSoft: {
		"@media (min-width: 721px)": {
			"--smooth-shadow-color": "var(--tw-shadow-color,black)",
			"boxShadow": "0 3px 10px -3px var(--smooth-shadow-color), 0 20px 56px -16px var(--smooth-shadow-color), 0 0 0 var(--smooth-ring-width,1px) var(--smooth-ring-color)",
			"@supports (color: color-mix(in lab, red, red))": {
				"boxShadow": "0 3px 10px -3px color-mix(in srgb, var(--smooth-shadow-color) 4%, transparent), 0 20px 56px -16px color-mix(in srgb, var(--smooth-shadow-color) 12%, transparent), 0 0 0 var(--smooth-ring-width,1px) color-mix(in srgb, var(--smooth-ring-color) 35%, transparent)"
			}
		}
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phonePt3: {
		"@media (max-width: 720px)": {
			"paddingTop": "12px"
		}
	},
	phonePb2: {
		"@media (max-width: 720px)": {
			"paddingBottom": "8px"
		}
	},
	placeholderTextFaint: {
		"::placeholder": {
			"color": "var(--text-faint)"
		}
	},
	phoneTextInputPhone: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-input-phone)"
		}
	},
	phoneMt2: {
		"@media (max-width: 720px)": {
			"marginTop": "8px"
		}
	},
	transitionBackgroundColorColorScale: {
		"transitionProperty": "background-color,color,scale",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	activeScale096: {
		":active": {
			"scale": ".96"
		}
	},
	disabledOpacity40: {
		":disabled": {
			"opacity": ".4"
		}
	},
	phoneW32: {
		"@media (max-width: 720px)": {
			"width": "128px"
		}
	},
});

const MAX_SLACK_IMAGE_BYTES = 20 * 1024 * 1024;

export interface SlackSent {
	channelName: string;
	permalink?: string;
	receiptKey?: string;
	/** Where the message landed, so the sender can take it back out again. */
	channelId?: string;
	ts?: string;
}

export function SlackSentNotice({
	channelName,
	permalink,
	onSendAnother,
	onUndo,
}: SlackSent & { onSendAnother: () => void; onUndo?: () => void | Promise<void> }) {
	const [undoing, setUndoing] = useState(false);
	return (
		<div {...stylex.props(sx.mxAuto, sx.mt2, sx.mb6, sx.flex, sx.wFull, sx.maxWVarSessionCol, sx.itemsCenter, sx.gap15, sx.px1, sx.leading5, sx.textDim, typography.label)}>
			<BrandMark name="slack" size={12} />
			<span>
				Sent to <span {...stylex.props(sx.fontSemibold, sx.textFg)}>#{channelName}</span>
			</span>
			{permalink && (
				<>
					<span aria-hidden {...stylex.props(sx.textFaint)}>·</span>
					<a {...mergeStylexProps("", sx.decorationLine, sx.hoverTextFg, sx.hoverDecorationCurrent, sx.focusRing, sx.roundedSm, sx.textDim, sx.underline, sx.underlineOffset2, sx.transitionColors)}
						href={permalink}
						target="_blank"
						rel="noreferrer"
					>
						Open in Slack
					</a>
				</>
			)}
			<div {...stylex.props(sx.mlAuto, sx.flex, sx.itemsCenter, sx.gap05)}>
				{onUndo && (
					<Tooltip label="Undo" side="bottom">
						<Button
							variant="ghost"
							size="sm"
							className={mergeStylexOverrideClassName("", sx.phoneSize10)}
							icon={undoing ? <Spinner size="sm" /> : <IconUndo size={16} />}
							aria-label="Undo"
							disabled={undoing}
							onClick={async () => {
								setUndoing(true);
								await (async () => {
await onUndo();
})().finally(async () => {
setUndoing(false);
});
							}}
						/>
					</Tooltip>
				)}
				<Button variant="ghost" size="sm" className={mergeStylexOverrideClassName("", sx.phoneMinH10)} onClick={onSendAnother}>
					Send another
				</Button>
			</div>
		</div>
	);
}

export interface ShippedChangeComposerProps {
	sessionId: string;
	defaultMessage: string;
	screenshot?: string;
	initialScreenshots?: string[];
	reconnectRequired?: boolean;
	status: "idle" | "sharing";
	onShare: (message: string, channel: string, screenshots: string[]) => void;
	onReconnectSlack?: () => void;
	onCancel?: () => void;
	loadChannels?: () => Promise<{
		channels: Array<{ id: string; name: string }>;
		defaultChannel?: string;
		canUploadImages?: boolean;
	}>;
	defaultChannel?: string;
	nextMessage?: string;
	sent?: SlackSent;
	/** Offered on the receipt while the message is still deletable in Slack. */
	onUndo?: () => void | Promise<void>;
}

export function ShippedChangeComposer({
	sessionId,
	defaultMessage,
	screenshot,
	initialScreenshots,
	reconnectRequired = false,
	status,
	onShare,
	onReconnectSlack,
	onCancel,
	loadChannels,
	defaultChannel,
	nextMessage,
	sent,
	onUndo,
}: ShippedChangeComposerProps) {
	const [message, setMessage] = useState(defaultMessage);
	const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
	const [channel, setChannel] = useState("");
	const [screenshots, setScreenshots] = useState<string[]>(() => [
		...(screenshot ? [screenshot] : []),
		...(initialScreenshots || []),
	].filter((path, index, all) => all.indexOf(path) === index).slice(0, 10));
	const [uploading, setUploading] = useState(false);
	const [awaitingSlack, setAwaitingSlack] = useState(false);
	const [canUploadImages, setCanUploadImages] = useState(true);
	const [composingAfterSent, setComposingAfterSent] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const sessionRef = useRef(sessionId);
	const sentKey = sent
		? `${sent.channelName}\0${sent.permalink || ""}\0${sent.receiptKey || ""}`
		: "";

	useEffect(() => {
		setMessage(defaultMessage);
		if (sessionRef.current !== sessionId) {
			sessionRef.current = sessionId;
			setScreenshots([
				...(screenshot ? [screenshot] : []),
				...(initialScreenshots || []),
			].filter((path, index, all) => all.indexOf(path) === index).slice(0, 10));
		}
	}, [defaultMessage, screenshot, initialScreenshots, sessionId]);
	useEffect(() => {
		setScreenshots((current) => screenshot && !current.includes(screenshot)
			? [screenshot, ...current]
			: current);
	}, [screenshot]);
	useEffect(() => {
		setComposingAfterSent(false);
	}, [sentKey]);
	useEffect(() => {
		if (sent && !composingAfterSent) return;
		let current = true;
		(loadChannels ? loadChannels() : fetchShippedChangeChannels(sessionId))
			.then((result) => {
				if (!current) return;
				setChannels(result.channels);
				setCanUploadImages(result.canUploadImages !== false);
				const preferred = defaultChannel || result.defaultChannel;
				setChannel(
					result.channels.some((candidate) => candidate.id === preferred || candidate.name === preferred?.replace(/^#/, ""))
						? result.channels.find((candidate) => candidate.id === preferred || candidate.name === preferred?.replace(/^#/, ""))!.id
						: result.channels[0]?.id || "",
				);
			})
			.catch(() => {
				if (current) setChannels([]);
			});
		return () => {
			current = false;
		};
	}, [sessionId, loadChannels, defaultChannel, sent, composingAfterSent]);
	const addImages = async (files: File[]) => {
		const candidates = files.filter((file) => file.type.startsWith("image/"));
		const oversized = candidates.find((file) => file.size > MAX_SLACK_IMAGE_BYTES);
		if (oversized) {
			toast(`${oversized.name} is larger than Slack's 20 MB image limit`, {
				variant: "error",
			});
		}
		const images = candidates
			.filter((file) => file.size <= MAX_SLACK_IMAGE_BYTES)
			.slice(0, 10 - screenshots.length);
		if (!images.length) return;
		setUploading(true);
		await (async () => {
const uploaded = await Promise.all(images.map((file) => uploadFile(file)));
			setScreenshots((current) => [...new Set([
				...current,
				...uploaded.map((file) => file.path),
			])].slice(0, 10));
})().catch(async (error) => {
toast(error instanceof Error ? error.message : "Couldn't add that image", {
				variant: "error",
			});
}).finally(async () => {
setUploading(false);
});
	};
	const mediaUrl = (path: string) => path.startsWith("/media?")
		? path
		: `/media?path=${encodeURIComponent(path)}`;
	const reconnect = async () => {
		if (!onReconnectSlack) return;
		setAwaitingSlack(true);
		await (async () => {
await onReconnectSlack();
			for (let attempt = 0; attempt < 24; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5_000));
				const result = await (loadChannels ? loadChannels() : fetchShippedChangeChannels(sessionId));
				setChannels(result.channels);
				setCanUploadImages(result.canUploadImages !== false);
				if (result.canUploadImages !== false) return;
			}
			toast("Slack access is still waiting for approval", { variant: "error" });
})().catch(async (error) => {
toast(error instanceof Error ? error.message : "Couldn't reconnect Slack", { variant: "error" });
}).finally(async () => {
setAwaitingSlack(false);
});
	};

	if (sent && !composingAfterSent) {
		return (
			<SlackSentNotice
				{...sent}
				onUndo={onUndo}
				onSendAnother={() => {
					setMessage(nextMessage?.trim().slice(0, 500) || "");
					setScreenshots([]);
					setComposingAfterSent(true);
				}}
			/>
		);
	}

	return (
		<div {...stylex.props(sx.mxAuto, sx.mt2, sx.mb6, sx.wFull, sx.maxWVarSessionCol)}>
			<div {...stylex.props(sx.mb2, sx.flex, sx.itemsCenter, sx.gap15, sx.px1, sx.leading5, sx.textDim, typography.label)}>
				<BrandMark name="slack" size={12} />
				<span {...stylex.props(sx.fontSemibold)}>Send to Slack</span>
				{onCancel && (
					<Tooltip label="Close" side="bottom">
						<Button
							variant="ghost"
							size="md" {...mergeStylexProps("", sx.phoneSize10, sx.mlAuto)}
							icon={<IconX size={18} />}
							aria-label="Close"
							disabled={status !== "idle"}
							onClick={onCancel}
						/>
					</Tooltip>
				)}
			</div>
			{/* `pwa-composer-edge` keeps this card aligned with the shared composer. */}
			<div {...mergeStylexProps("pwa-composer-edge", sx.shadowVarComposerShadow, sx.transitionBorderColorBoxShadow, sx.focusWithinBorderAccent, sx.desktopBorderTransparent, sx.desktopSmoothRingColorVarComposerBorder, sx.desktopSmoothShadowRingSoft, sx.phonePx3, sx.phonePt3, sx.phonePb2, sx.roundedVarComposerRadius, sx.border, sx.borderColorVarComposerBorder, sx.bgVarComposerSurface, sx.px35, sx.pt35, sx.pb25)}
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					if (status === "idle") void addImages(Array.from(event.dataTransfer.files));
				}}
			>
				<textarea {...mergeStylexProps("", sx.placeholderTextFaint, sx.phoneTextInputPhone, sx.block, sx.minH14, sx.maxH32, sx.wFull, sx.resizeNone, sx.border0, sx.bgTransparent, sx.p0, sx.leading155, sx.textFg, sx.outlineNone, sx.FieldSizingContent, typography.body)}
					aria-label="Slack message"
					{...noAutofill}
					value={message}
					maxLength={500}
					disabled={status !== "idle"}
					onChange={(event) => setMessage(event.target.value)}
					onPaste={(event) => {
						const files = imageFilesFromPaste(event);
						if (files.length) {
							event.preventDefault();
							void addImages(files);
						}
					}}
				/>
				{screenshots.length > 0 && (
					<div {...mergeStylexProps("[&::-webkit-scrollbar]:hidden", sx.mt05, sx.flex, sx.gap2, sx.overflowXAuto, sx.pt2, sx.pr2, sx.pb05, sx.ScrollbarWidthNone)}>
						{screenshots.map((path, index) => (
							<div key={path} {...mergeStylexProps("group/overlay-action", sx.relative, sx.shrink0)}>
								<button type="button" aria-label="Open screenshot preview" {...stylex.props(sx.focusRing, sx.block, sx.overflowHidden, sx.roundedMd)} onClick={(event) => openLightbox(screenshots.map((item) => ({ kind: "image", src: mediaUrl(item) })), index, event.currentTarget)}>
									<img {...stylex.props(sx.h16, sx.w24, sx.roundedMd, sx.border, sx.borderLineStrong, sx.objectCover, sx.objectTop)} src={mediaUrl(path)} alt="" />
								</button>
								<OverlayAction
									aria-label="Remove screenshot"
									disabled={status !== "idle"}
									icon={<IconX className={mergeStylexOverrideClassName("", sx.textRed)} size={16} />}
									onClick={() =>
										setScreenshots((current) => current.filter((_, i) => i !== index))
									}
								/>
							</div>
						))}
					</div>
				)}
				<div {...mergeStylexProps("", sx.phoneMt2, sx.mt25, sx.flex, sx.itemsCenter, sx.gap15)}>
					<input ref={fileInputRef} {...stylex.props(sx.srOnly)} type="file" accept="image/*" multiple onChange={(event) => { void addImages(Array.from(event.target.files || [])); event.currentTarget.value = ""; }} />
					<button type="button" aria-label="Add images" title="Add images" {...mergeStylexProps("", sx.transitionBackgroundColorColorScale, sx.hoverBgHover, sx.hoverTextFg, sx.activeScale096, sx.disabledOpacity40, sx.phoneSize10, sx.focusRing, sx.inlineFlex, sx.size8, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.textDim)} disabled={status !== "idle" || uploading || screenshots.length >= 10} onClick={() => fileInputRef.current?.click()}>
						{uploading ? <Spinner size="md" /> : <IconPlus size={20} />}
					</button>
					<div {...stylex.props(sx.flex1)} />
					{/* The app's own select. This was the native one with
					    `appearance-none`, a hand-placed chevron and a wrapper to
					    position it, which is the primitive rebuilt by hand around a
					    control it exists to replace. */}
					<OptionSelect
						label="Slack channel" {...mergeStylexProps("", sx.phoneW32, sx.w28)}
						value={channel}
						options={
							channels.length === 0
								? [{ value: "", label: "No channels available" }]
								: channels.map((candidate) => ({
										value: candidate.id,
										label: `#${candidate.name}`,
									}))
						}
						onChange={setChannel}
						disabled={status !== "idle" || channels.length === 0}
					/>
					<Button variant="primary" size="md" icon={<BrandMark name="slack" size={12} />} disabled={status !== "idle" || awaitingSlack || (!(reconnectRequired || (!canUploadImages && screenshots.length > 0)) && ((!message.trim() && screenshots.length === 0) || !channel || uploading))} onClick={() => reconnectRequired || (!canUploadImages && screenshots.length > 0) ? void reconnect() : onShare(message.trim(), channel, screenshots)}>
						{awaitingSlack ? "Waiting…" : reconnectRequired || (!canUploadImages && screenshots.length > 0) ? "Reconnect" : status === "sharing" ? "Sending…" : "Send"}
					</Button>
				</div>
			</div>
		</div>
	);
}
