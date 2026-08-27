import React, { useState } from "react";
import { IconChevronDown, IconCheckCircle, IconX } from "./icons";
import type { ReviewLoopResult } from "../lib/review-loop";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { motionStyles } from "../styles/animations.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mxAuto: {
			marginInline: "auto"
	},
	mb3: {
			marginBottom: "12px"
	},
	wFull: {
			width: "100%"
	},
	maxWVarSessionCol: {
			maxWidth: "var(--session-col)"
	},
	Mx2: {
			marginInline: "-8px"
	},
	flex: {
			display: "flex"
	},
	wCalc10016px: {
			width: "calc(100% + 16px)"
	},
	minW0: {
			minWidth: "0"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	gap2: {
			gap: "8px"
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
	px3: {
			paddingInline: "12px"
	},
	py1: {
			paddingBlock: "4px"
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
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	block: {
			display: "block"
	},
	shrink0: {
			flexShrink: "0"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	leading4: {
			lineHeight: "16px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	hidden: {
			display: "none"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	size11px: {
			width: "11px",
			height: "11px"
	},
	flexNone: {
			flex: "none"
	},
	selfCenter: {
			alignSelf: "center"
	},
	animateSpin: {
			animation: "var(--animate-spin)"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderBLineStrong: {
			borderBottomColor: "var(--border-strong)"
	},
	borderLLineStrong: {
			borderLeftColor: "var(--border-strong)"
	},
	borderRLineStrong: {
			borderRightColor: "var(--border-strong)"
	},
	borderTDim: {
			borderTopColor: "var(--text-dim)"
	},
	mt05: {
			marginTop: "2px"
	},
	pl2: {
			paddingLeft: "8px"
	},
	mt1: {
			marginTop: "4px"
	},
	px1: {
			paddingInline: "4px"
	},
	py3px: { paddingBlock: "3px" },
	grid: { display: "grid" },
	size5: { width: "20px", height: "20px" },
	placeItemsCenter: { placeItems: "center" },
	leadingNone: { lineHeight: 1 },
	transitionTransform: { transitionProperty: "transform" },
	duration150: { transitionDuration: "150ms" },
	translateUpPx: { transform: "translateY(-1px)" },
	rotateNeg90: { transform: "rotate(-90deg)" },
	relative: { position: "relative" },
	z1: { zIndex: 1 },
	size22px: { width: "22px", height: "22px" },
	justifyCenter: { justifyContent: "center" },
	textRed: { color: "var(--red)" },
	itemsCenter: { alignItems: "center" },

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
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	phoneMinH10: {
		"@media (max-width: 720px)": {
			"minHeight": "40px"
		}
	},
	desktopBlock: {
		"@media (min-width: 721px)": {
			"display": "block"
		}
	},
});

/**
 * A review handoff and the work it triggered, folded like a normal turn. Once
 * settled, the closed row says what the loop concluded; opening it reveals the
 * same icon-led work rows as any other worker, followed by the final verdict.
 */
export function ReviewLoopBlock({
	prNumber,
	rounds,
	live,
	result,
	children,
	defaultOpen = false,
	onOpenChange,
}: {
	prNumber: number | null;
	rounds: number;
	live: boolean;
	result?: ReviewLoopResult;
	children: React.ReactNode;
	/** Preview/test hook; the transcript never passes it, so sessions stay folded. */
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const status = live ? "pending" : result?.status;
	const resultDetail = reviewLoopDetail(status, rounds);
	const visibleDetail = open && status !== "pending"
		? `${rounds} ${rounds === 1 ? "round" : "rounds"}`
		: resultDetail;
	const label = ["Review loop", resultDetail, prNumber ? `PR #${prNumber}` : null]
		.filter(Boolean)
		.join(", ");

	return (
		<section {...stylex.props(sx.mxAuto, sx.mb3, sx.wFull, sx.maxWVarSessionCol)} aria-label="Review loop">
			<button
				type="button"
				aria-expanded={open}
				aria-label={label}
				onClick={() =>
					setOpen((value) => {
						const next = !value;
						onOpenChange?.(next);
						return next;
					})
				} {...mergeStylexProps("", sx.hoverBgHover40, sx.hoverTextFg, sx.phoneMinH10, sx.Mx2, sx.flex, sx.wCalc10016px, sx.minW0, sx.cursorPointer, sx.itemsBaseline, sx.gap2, sx.roundedControl, sx.border0, sx.bgTransparent, sx.px3, sx.py1, sx.textLeft, sx.fontSans, sx.leading5, sx.textDim, sx.transitionColors, typography.itemTitle)}
			>
				<span
					{...stylex.props(sx.grid, sx.size5, sx.flexNone, sx.selfCenter, sx.placeItemsCenter, sx.leadingNone, sx.textFaint, sx.transitionTransform, sx.duration150, open ? sx.translateUpPx : sx.rotateNeg90)}
				>
					<IconChevronDown size={20} className={mergeStylexOverrideClassName("", sx.block)} />
				</span>
				<span {...stylex.props(sx.shrink0, sx.fontMedium)}>Review loop</span>
				<span {...stylex.props(sx.minW0, sx.truncate, sx.leading4, sx.textFaint, typography.label)}>{visibleDetail}</span>
				{prNumber && (
					<span {...mergeStylexProps("", sx.desktopBlock, sx.hidden, sx.shrink0, sx.leading4, sx.textFaint, typography.label)}>PR #{prNumber}</span>
				)}
				{live && (
					<span
						{...stylex.props(sx.mlAuto, sx.size11px, sx.flexNone, sx.selfCenter, motionStyles.spin, sx.roundedFull, sx.border, sx.borderBLineStrong, sx.borderLLineStrong, sx.borderRLineStrong, sx.borderTDim)}
						aria-label="Review in progress"
					/>
				)}
			</button>
			{open && (
				<div {...mergeStylexProps("[&>*:last-child]:mb-0", sx.mt05, sx.pl2)}>
					{children}
					{result && !live && result.status !== "pending" && (
						<ReviewLoopResultRow result={result} rounds={rounds} />
					)}
				</div>
			)}
		</section>
	);
}

function reviewLoopDetail(
	status: ReviewLoopResult["status"] | undefined,
	rounds: number,
): string {
	if (status === "passed") return "Ready to merge";
	if (status === "failed") return "Needs changes";
	if (status === "pending") return "Working";
	return `${rounds} ${rounds === 1 ? "round" : "rounds"}`;
}

function ReviewLoopResultRow({
	result,
	rounds,
}: {
	result: ReviewLoopResult;
	rounds: number;
}) {
	const facts = [
		`${rounds} ${rounds === 1 ? "round" : "rounds"}`,
		typeof result.confidence === "number" ? `${result.confidence}/5` : null,
		result.blocking ? `${result.blocking} blocking` : null,
		result.checksFailed
			? `${result.checksFailed} ${result.checksFailed === 1 ? "check" : "checks"} failed`
			: null,
		result.checksPassed ? `${result.checksPassed} checks passed` : null,
	]
		.filter(Boolean)
		.join(" · ");
	const passed = result.status === "passed";
	return (
		<div
			{...stylex.props(sx.mt1, sx.flex, sx.wFull, sx.minW0, sx.itemsBaseline, sx.gap2, sx.roundedControl, sx.bgTransparent, sx.px1, sx.py3px, sx.fontSans)}
			aria-label={passed ? "Review passed" : "Review failed"}
		>
			<span
				{...stylex.props(sx.relative, sx.z1, sx.flex, sx.size22px, sx.flexNone, sx.selfCenter, sx.itemsCenter, sx.justifyCenter, passed ? sx.textFaint : sx.textRed)}
			>
				{passed ? <IconCheckCircle size={20} /> : <IconX size={20} />}
			</span>
			<span {...stylex.props(sx.shrink0, sx.fontMedium, sx.leading5, sx.textDim, typography.itemTitle)}>
				{passed ? "Ready to merge" : "Needs changes"}
			</span>
			<span {...stylex.props(sx.minW0, sx.truncate, sx.leading4, sx.textFaint, typography.label)}>{facts}</span>
		</div>
	);
}
