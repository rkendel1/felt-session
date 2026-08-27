import { motion, type HTMLMotionProps } from "motion/react";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { type as typography } from "../styles/typography.stylex";
import * as stylex from "@stylexjs/stylex";

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
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	rounded999px: {
			borderRadius: "999px"
	,
		cornerShape: "var(--cs)"},
	bgPopupGlass: {
			backgroundColor: "var(--popup-glass)"
	},
	px3: {
			paddingInline: "12px"
	},
	py15: {
			paddingBlock: "6px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	leadingTight: {
			lineHeight: "var(--leading-tight)"
	},
	textFg: {
			color: "var(--text)"
	},
	SmoothRingColorVarPopupRing: { "--smooth-ring-color": "var(--popup-ring)" },
	smoothShadowRingSm: {
			boxShadow: "0 1px 3px -1px var(--smooth-shadow-color), 0 4px 10px -4px var(--smooth-shadow-color), 0 0 0 var(--smooth-ring-width,1px) var(--smooth-ring-color)"
	},

	BackdropFilterVarPopupBlur: {
		"WebkitBackdropFilter": "var(--popup-blur)",
		"backdropFilter": "var(--popup-blur)"
	},
});

/** Compact, non-interactive status lifted above the current surface. */
export function FloatingStatus({
	className,
	...props
}: HTMLMotionProps<"div">) {
	return (
		<motion.div {...mergeStylexProps(cn(mergeStylexClassName("", sx.BackdropFilterVarPopupBlur), className), sx.flex, sx.itemsCenter, sx.gap2, sx.whitespaceNowrap, sx.rounded999px, sx.bgPopupGlass, sx.px3, sx.py15, typography.supporting, sx.fontMedium, sx.leadingTight, sx.textFg, sx.SmoothRingColorVarPopupRing, sx.smoothShadowRingSm)}
			{...props}
		/>
	);
}
