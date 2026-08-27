import * as React from "react";
import { IconChevronRight } from "../components/icons";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { Collapsible, collapsiblePanelClasses } from "./collapsible";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minW0: {
			minWidth: "0"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gapX3: {
			columnGap: "12px"
	},
	gapY15: {
			rowGap: "6px"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	Mx2: {
			marginInline: "-8px"
	},
	gap15: {
			gap: "6px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px2: {
			paddingInline: "8px"
	},
	py1: {
			paddingBlock: "4px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	shrink0: {
			flexShrink: "0"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	transitionTransform: {
			transitionProperty: "transform,translate,scale,rotate",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	durationVarDurMicro: {
			transitionDuration: "var(--dur-micro)"
	},
	easeVarEase: {
			transitionTimingFunction: "var(--ease)"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	pt3: {
			paddingTop: "12px"
	},

	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
});

/**
 * Disclosure — a titled block that opens and closes in place.
 *
 * For reference material that a surface should offer without spending its
 * first screen on: a provider's setup recipe, a generated config snippet, the
 * long tail of options behind a form. The closed state is one quiet row, so
 * the thing the person actually came to do stays above the fold.
 *
 * Built on Base UI's Collapsible rather than a raw `<details>`: the panel's
 * height is measured, so the block animates open instead of snapping, and the
 * trigger keeps its aria-expanded/aria-controls wiring. Reduced motion is
 * handled globally in base.css, which flattens the transition to ~0ms.
 *
 * `actions` sits BESIDE the trigger, never inside it. A disclosure's shoulder
 * usually carries a link out to whatever it documents, and an `<a>` nested in
 * a `<button>` is neither valid nor clickable.
 */
export function Disclosure({
	title,
	actions,
	defaultOpen,
	className,
	panelClassName,
	children,
}: {
	title: React.ReactNode;
	/** Rendered on the trigger's right, outside its hit area. */
	actions?: React.ReactNode;
	defaultOpen?: boolean;
	className?: string;
	panelClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<Collapsible.Root defaultOpen={defaultOpen} {...mergeStylexProps(cn(className), sx.minW0)}>
			<div {...stylex.props(sx.flex, sx.minW0, sx.flexWrap, sx.itemsCenter, sx.justifyBetween, sx.gapX3, sx.gapY15)}>
				{/* -mx-2 lets the row's hover wash bleed past the text without
				    indenting the title away from the content it labels. */}
				<Collapsible.Trigger {...mergeStylexProps("group", sx.hoverBgHover, sx.focusRing, sx.Mx2, sx.flex, sx.minW0, sx.itemsCenter, sx.gap15, sx.roundedControl, sx.px2, sx.py1, sx.fontSemibold, sx.textFg, sx.transitionColors, typography.label)}>
					<IconChevronRight
						size={14} {...mergeStylexProps("group-data-[panel-open]:rotate-90", sx.shrink0, sx.textFaint, sx.transitionTransform, sx.durationVarDurMicro, sx.easeVarEase)}
					/>
					<span {...stylex.props(sx.minW0, sx.truncate)}>{title}</span>
				</Collapsible.Trigger>
				{actions}
			</div>
			<Collapsible.Panel className={cn(collapsiblePanelClasses, panelClassName)}>
				<div {...stylex.props(sx.pt3)}>{children}</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
