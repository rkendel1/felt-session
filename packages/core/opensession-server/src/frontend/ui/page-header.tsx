import * as React from "react";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { type as typography } from "../styles/typography.stylex";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mb22px: {
			marginBottom: "22px"
	},
	flex: {
			display: "flex"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap4: {
			gap: "16px"
	},
	m0: {
			margin: "0"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)",
		"--settings-leading": "1.1"
	},
	tracking001em: {
			letterSpacing: "-.01em"
	},
	textFg: {
			color: "var(--text)"
	},
	mt1: {
			marginTop: "4px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},

	phoneFlexCol: {
		"@media (max-width: 720px)": {
			"flexDirection": "column"
		}
	},
	phoneGap25: {
		"@media (max-width: 720px)": {
			"gap": "10px"
		}
	},
});

export function PageHeader({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div {...mergeStylexProps(cn(mergeStylexClassName("", sx.phoneFlexCol, sx.phoneGap25), className), sx.mb22px, sx.flex, sx.itemsStart, sx.justifyBetween, sx.gap4)}
			{...props}
		/>
	);
}

export function PageTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"h2">) {
	return (
		<h2
			// The anchor for the iOS large-title handoff: while this heading is on
			// screen it is the page's name, and the chrome row above stays quiet;
			// once it has scrolled under that row, the row picks the name up. Read
			// by hooks/useLargeTitle.ts, which the app's top bar and the Analytics
			// range bar both call. Nothing else reads it, and it styles nothing.
			data-large-title="" {...mergeStylexProps(cn(className), sx.m0, typography.sectionTitle, sx.fontTitle, sx.tracking001em, sx.textFg)}
			{...props}
		/>
	);
}

export function PageDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn(className), sx.mt1, typography.supporting, sx.textFaint)} {...props} />;
}
