import type { ReactNode } from "react";
import {
	TopBar,
	TopBarActions,
	TopBarBack,
	TopBarTitle,
} from "../ui/top-bar";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	sticky: {
			position: "sticky"
	},
	top0: {
			top: "0"
	},
	z3: {
			zIndex: "3"
	},
	gap1: {
			gap: "4px"
	},
	bgPanelSurface: {
			backgroundColor: "var(--panel-surface)"
	},
	px2: {
			paddingInline: "8px"
	},
	pt3: {
			paddingTop: "12px"
	},
	pb2: {
			paddingBottom: "8px"
	},
	shrink0: {
			flexShrink: "0"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	textDim: {
			color: "var(--text-dim)"
	},
	flex1: {
			flex: "1"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},

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
});

/**
 * The shared top bar for a page one level deeper than the workspace panel's
 * overview. It stays above the panel's own sticky tabs and file headers.
 */
export function PanelPageHeader({
	title,
	onBack,
	trailing,
}: {
	title: string;
	onBack: () => void;
	trailing?: ReactNode;
}) {
	return (
		<TopBar
			as="header"
			className={mergeStylexOverrideClassName("", sx.sticky, sx.top0, sx.z3, sx.gap1, sx.bgPanelSurface, sx.px2, sx.pt3, sx.pb2)}
		>
			<TopBarBack
				onClick={onBack}
				aria-label="Back to workspace"
				iconSize={18} {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.shrink0, sx.roundedControl, sx.textDim)}
			/>
			<TopBarTitle className={mergeStylexOverrideClassName("", sx.flex1, sx.truncate, sx.fontSemibold, sx.textFg, typography.supporting)}>
				{title}
			</TopBarTitle>
			{trailing && <TopBarActions>{trailing}</TopBarActions>}
		</TopBar>
	);
}
