import React from "react";
import {
	motion,
	useMotionValue,
	useTransform,
	type PanInfo,
} from "motion/react";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { SWIPE_DISTANCE, SWIPE_VELOCITY } from "../lib/swipe-deck";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	pointerEventsNone: {
			pointerEvents: "none"
	},
	absolute: {
			position: "absolute"
	},
	left4: {
			left: "16px"
	},
	top16: {
			top: "64px"
	},
	z10: {
			zIndex: "10"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border2: {
			borderStyle: "solid",
			borderWidth: "2px"
	},
	borderRed: {
			borderColor: "var(--red)"
	},
	px25: {
			paddingInline: "10px"
	},
	py1: {
			paddingBlock: "4px"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-sm--line-height))"
	},
	fontBold: {
			fontWeight: "var(--font-weight-bold)"
	},
	trackingWide: {
			letterSpacing: "var(--tracking-wide)"
	},
	textRed: {
			color: "var(--red)"
	},
	right4: {
			right: "16px"
	},
	borderGreen: {
			borderColor: "var(--green)"
	},
	textGreen: {
			color: "var(--green)"
	},
	flex: {
			display: "flex"
	},
	flex1: {
			flex: "1"
	},
	flexCol: {
			flexDirection: "column"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	gap3: {
			gap: "12px"
	},
	px6: {
			paddingInline: "24px"
	},
	textCenter: {
			textAlign: "center"
	},
	text4xl: {
			fontSize: "var(--text-4xl)",
			lineHeight: "var(--tw-leading,var(--text-4xl--line-height))"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	maxWXs: {
			maxWidth: "var(--container-xs)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mt2: {
			marginTop: "8px"
	},
	gap2: {
			gap: "8px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	px4: {
			paddingInline: "16px"
	},
	py25: {
			paddingBlock: "10px"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	roundedXl: {
			borderRadius: "calc(18px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	smoothShadowSoft: {
			boxShadow: "0 3px 10px -3px var(--smooth-shadow-color), 0 20px 56px -16px var(--smooth-shadow-color)"
	},

	touchPanY: {
		"--tw-pan-y": "pan-y",
		"touchAction": "var(--tw-pan-x,) var(--tw-pan-y,) var(--tw-pinch-zoom,)"
	},

	hoverBgSurface: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--bg)"
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
});

/**
 * The swipe-card mechanics shared by the decks (Support Tinder, catch-up):
 * drag-to-commit with the same distance/velocity thresholds, the
 * rotate-with-drag tilt, the red/green intent stamps, and the directional
 * exit fling. Each deck supplies its own card content as children and maps
 * its actions to fling directions via `exitFor`.
 */

type SwipeExitDir = "left" | "right" | "up" | null;

export function SwipeCard<A extends string>({
	className,
	custom,
	exitFor,
	exitDistance,
	popOnExit = false,
	stampLeft,
	stampRight,
	onSwipeLeft,
	onSwipeRight,
	children,
}: {
	/** Positioning classes for the card — the deck decides flow vs overlay. */
	className?: string;
	/** The action that dismissed the card (mirrors AnimatePresence `custom`). */
	custom: A | null;
	/** Maps the dismissing action to its fling direction (null = fade in place). */
	exitFor: (a: A | null) => SwipeExitDir;
	/** Px the exiting card travels. */
	exitDistance: number;
	/**
	 * Pop the exiting card to absolute for its fling. Needed when the card
	 * lives in normal flow (auto height) — otherwise it would hold layout and
	 * shove the incoming card down while both are mounted.
	 */
	popOnExit?: boolean;
	/** Left-swipe intent stamp (red). */
	stampLeft: string;
	/** Right-swipe intent stamp (green). */
	stampRight: string;
	onSwipeLeft: () => void;
	onSwipeRight: () => void;
	children: React.ReactNode;
}) {
	const x = useMotionValue(0);
	const rotate = useTransform(x, [-260, 260], [-9, 9]);
	const leftTint = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
	const rightTint = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);

	function onDragEnd(_: unknown, info: PanInfo) {
		if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY)
			onSwipeLeft();
		else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY)
			onSwipeRight();
	}

	// Exit is a function variant so AnimatePresence's `custom` (the action
	// taken) picks the fling direction.
	const variants = {
		exit: (a: A | null) => {
			const dir = exitFor(a);
			return {
				...(popOnExit
					? { position: "absolute" as const, top: 0, left: 0, right: 0 }
					: {}),
				x: dir === "left" ? -exitDistance : dir === "right" ? exitDistance : 0,
				y: dir === "up" ? -exitDistance : 0,
				rotate: dir === "left" ? -12 : dir === "right" ? 12 : 0,
				opacity: 0,
				transition: { duration: 0.26 },
			};
		},
	};

	return (
		<motion.div {...mergeStylexProps(cn(mergeStylexClassName("", sx.touchPanY), className), sx.flex, sx.flexCol, sx.overflowHidden, sx.roundedXl, sx.bgPanel, sx.smoothShadowSoft)}
			style={{ x, rotate }}
			drag="x"
			dragConstraints={{ left: 0, right: 0 }}
			dragElastic={0.7}
			onDragEnd={onDragEnd}
			variants={variants}
			initial={{ scale: 0.97, opacity: 0, y: 12 }}
			animate={{ scale: 1, opacity: 1, y: 0 }}
			exit="exit"
			custom={custom}
			transition={{ type: "spring", stiffness: 400, damping: 34 }}
		>
			{/* Swipe intent stamps. */}
			<motion.div
				{...stylex.props(sx.pointerEventsNone, sx.absolute, sx.left4, sx.top16, sx.z10, sx.roundedMd, sx.border2, sx.borderRed, sx.px25, sx.py1, sx.textSm, sx.fontBold, sx.trackingWide, sx.textRed)}
				style={{ opacity: leftTint, rotate: -12 }}
			>
				{stampLeft}
			</motion.div>
			<motion.div
				{...stylex.props(sx.pointerEventsNone, sx.absolute, sx.right4, sx.top16, sx.z10, sx.roundedMd, sx.border2, sx.borderGreen, sx.px25, sx.py1, sx.textSm, sx.fontBold, sx.trackingWide, sx.textGreen)}
				style={{ opacity: rightTint, rotate: 12 }}
			>
				{stampRight}
			</motion.div>

			{children}
		</motion.div>
	);
}

/**
 * The end-of-deck screen shared by the tinder decks: emoji, headline, a recap
 * of how many cards were dealt with, and a Done button (plus an optional
 * secondary action, e.g. "Deal N kept PRs").
 */
export function DeckDone({
	emoji,
	title,
	message,
	secondary,
	onExit,
}: {
	emoji: string;
	title: string;
	message: string;
	/** Optional extra action rendered before Done. */
	secondary?: { label: string; onClick: () => void };
	onExit: () => void;
}) {
	return (
		<div {...stylex.props(sx.flex, sx.flex1, sx.flexCol, sx.itemsCenter, sx.justifyCenter, sx.gap3, sx.px6, sx.textCenter)}>
			<div {...stylex.props(sx.text4xl)}>{emoji}</div>
			<div {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}>{title}</div>
			<div {...stylex.props(sx.maxWXs, sx.textSm, sx.textDim)}>{message}</div>
			<div {...stylex.props(sx.mt2, sx.flex, sx.gap2)}>
				{secondary && (
					<button {...mergeStylexProps("", sx.hoverBgSurface, sx.hoverTextFg, sx.roundedControl, sx.border, sx.borderLine, sx.bgPanel, sx.px4, sx.py25, sx.textSm, sx.fontSemibold, sx.textDim)}
						onClick={secondary.onClick}
					>
						{secondary.label}
					</button>
				)}
				<button {...mergeStylexProps("", sx.hoverBgSurface, sx.roundedControl, sx.bgPanel, sx.px4, sx.py25, sx.textSm, sx.fontSemibold, sx.textFg)}
					onClick={onExit}
				>
					Done
				</button>
			</div>
		</div>
	);
}
