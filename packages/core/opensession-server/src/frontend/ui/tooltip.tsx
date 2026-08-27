import * as React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn, mergeStylexClassName } from "./cn";
import { ExclusivePopupProvider } from "./exclusive-popups";
import { FLOATING_OVERLAY_LAYER } from "./popup-classes";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	inlineFlex: {
			display: "inline-flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap3px: {
			gap: "3px"
	},
	h4: {
			height: "16px"
	},
	minW4: {
			minWidth: "16px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px3px: {
			paddingInline: "3px"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-xs--line-height))"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	FontFamilyInherit: {
			fontFamily: "inherit"
	},
	bgWhite20: {
			backgroundColor: "color-mix(in srgb, var(--color-white) 20%, transparent)"
	},
	textWhite75: {
			color: "#ffffffbf"
	},

	pointerEventsNone: {
		"pointerEvents": "none"
	},
	flex: {
		"display": "flex"
	},
	gap2: {
		"gap": "8px"
	},
	originVarTransformOrigin: {
		"transformOrigin": "var(--transform-origin)"
	},
	duration120ms: {
		"--tw-duration": ".12s",
		"transitionDuration": ".12s"
	},
	easeOut: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	roundedPanel: {
		"borderRadius": "calc(var(--radius) * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgTooltip: {
		"backgroundColor": "var(--tooltip-bg)"
	},
	px2: {
		"paddingInline": "8px"
	},
	py1: {
		"paddingBlock": "4px"
	},
	leadingSnug: {
		"--tw-leading": "var(--leading-snug)",
		"lineHeight": "var(--leading-snug)"
	},
	textTooltipFg: {
		"color": "var(--tooltip-fg)"
	},
	maxW360px: {
		"maxWidth": "360px"
	},
	itemsStart: {
		"alignItems": "flex-start"
	},
	whitespacePreWrap: {
		"whiteSpace": "pre-wrap"
	},
	maxW280px: {
		"maxWidth": "280px"
	},
	whitespaceNowrap: {
		"whiteSpace": "nowrap"
	},
	maxH50vh: {
		"maxHeight": "50vh"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	textEllipsis: {
		"textOverflow": "ellipsis"
	},

	transitionTransformOpacity: {
		"transitionProperty": "transform,opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	shadow0px10px38px10pxRgba1418220350px10px20px15pxRgba141822020001pxVarTooltipRing: {
		"--tw-shadow": "0px 10px 38px -10px var(--tw-shadow-color,#0e121659), 0px 10px 20px -15px var(--tw-shadow-color,#0e121633), 0 0 0 1px var(--tw-shadow-color,var(--tooltip-ring))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
});

/**
 * Tooltip on Base UI (Tooltip.Root/Trigger/Positioner/Popup), styled with
 * Tailwind tokens. First component of the ui/ layer —
 * the pattern to copy for new primitives: Base UI parts for behavior
 * (positioning, collision flip, focus/hover semantics, a11y), our classes via
 * cn() with className passthrough.
 *
 * Keeps the exact API of the old hand-rolled components/Tooltip.tsx
 * (label/side/offset/shortcut, single-element child, no wrapper DOM) so call
 * sites didn't change. Open delay + instant group hand-off between adjacent
 * triggers come from <TooltipProvider> at the app root.
 *
 * Animation follows Base UI's lifecycle attributes. In particular,
 * data-instant disables transitions while the provider hands off between two
 * triggers, so the outgoing tooltip cannot remain visible beside the new one.
 */

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/** Mount once at the app root: shared 200ms open delay, and for 300ms after a
 * tooltip closes, neighbouring triggers open instantly (toolbar sweep). */
export function TooltipProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<BaseTooltip.Provider delay={200} timeout={300}>
			<ExclusivePopupProvider>{children}</ExclusivePopupProvider>
		</BaseTooltip.Provider>
	);
}

export function Tooltip({
	label,
	side = "top",
	align = "center",
	offset = 8,
	shortcut,
	multiline,
	popupClassName,
	children,
}: {
	label: React.ReactNode;
	side?: Side;
	/** Where along `side` the popup sits. "start" keeps it by the trigger's
	 *  leading edge — right for a wide block trigger, where centering would
	 *  float the tip far from whatever the cursor is actually over. */
	align?: Align;
	offset?: number;
	/** Optional keyboard-shortcut badges, e.g. ["⌘", "S"]. */
	shortcut?: string[];
	/** Wrap long content instead of the default single nowrap line. */
	multiline?: boolean;
	/** Extend the shared popup surface for richer tooltip content. */
	popupClassName?: string;
	children: React.ReactElement;
}) {
	if (!label) return children;

	return (
		<BaseTooltip.Root>
			<BaseTooltip.Trigger render={children} />
			<BaseTooltip.Portal
				// Base UI otherwise inherits a containing popup's portal target. Mount
				// tooltips at the page root so their floating layer can sit above that
				// popup instead of being trapped inside its stacking context.
				container={typeof document !== "undefined" ? document.body : undefined}
			>
				<BaseTooltip.Positioner
					side={side}
					align={align}
					sideOffset={offset}
					collisionPadding={6}
					className={FLOATING_OVERLAY_LAYER}
				>
					<BaseTooltip.Popup
						className={cn(
							mergeStylexClassName("", sx.pointerEventsNone, sx.flex, sx.itemsCenter, sx.gap2),
							mergeStylexClassName("", sx.transitionTransformOpacity, sx.originVarTransformOrigin, sx.duration120ms, sx.easeOut),
							"data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0",
							"data-[ending-style]:opacity-0 data-[instant]:transition-none",
							// 13px medium text on a near-black chip with
							// its soft `shadow-popup` + our theme ring.
							mergeStylexClassName("", sx.roundedPanel, sx.bgTooltip, sx.px2, sx.py1, typography.label, sx.leadingSnug, sx.fontMedium, sx.textTooltipFg),
							mergeStylexClassName("", sx.shadow0px10px38px10pxRgba1418220350px10px20px15pxRgba141822020001pxVarTooltipRing),
							multiline
								? mergeStylexClassName("", sx.maxW360px, sx.itemsStart, sx.whitespacePreWrap)
								: mergeStylexClassName("", sx.maxW280px, sx.whitespaceNowrap),
							popupClassName,
						)}
					>
						<span
							className={cn(
								multiline
									? mergeStylexClassName("", sx.maxH50vh, sx.overflowYAuto)
									: mergeStylexClassName("", sx.overflowHidden, sx.textEllipsis),
							)}
						>
							{label}
						</span>
						{shortcut && shortcut.length > 0 && (
							<span {...stylex.props(sx.inlineFlex, sx.itemsCenter, sx.gap3px)}>
								{shortcut.map((k, i) => (
									<kbd
										key={i}
										{...stylex.props(sx.inlineFlex, sx.h4, sx.minW4, sx.itemsCenter, sx.justifyCenter, sx.roundedSm, sx.px3px, sx.textXs, sx.fontMedium, sx.FontFamilyInherit, sx.bgWhite20, sx.textWhite75)}
									>
										{k}
									</kbd>
								))}
							</span>
						)}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	);
}
