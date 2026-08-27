import * as React from "react";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	size15: {
			width: "6px",
			height: "6px"
	},
	shrink0: {
			flexShrink: "0"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgCurrent: {
			backgroundColor: "currentColor"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap1: {
			gap: "4px"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px15: {
			paddingInline: "6px"
	},
	py05: {
			paddingBlock: "2px"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},

	outline: {
		"outlineStyle": "var(--tw-outline-style)",
		"outlineWidth": "1px"
	},

	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	borderLine: {
		"borderColor": "var(--border)"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	borderAccent40: {
		"borderColor": "var(--accent)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in oklab, var(--accent) 40%, transparent)"
		}
	},
	textAccent: {
		"color": "var(--accent-ink)"
	},
	borderGreen40: {
		"borderColor": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in oklab, var(--green) 40%, transparent)"
		}
	},
	textGreen: {
		"color": "var(--green)"
	},
	borderYellow40: {
		"borderColor": "var(--yellow)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in oklab, var(--yellow) 40%, transparent)"
		}
	},
	textYellow: {
		"color": "var(--yellow)"
	},
	borderRed40: {
		"borderColor": "var(--red)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in oklab, var(--red) 40%, transparent)"
		}
	},
	textRed: {
		"color": "var(--red)"
	},
	borderBlue40: {
		"borderColor": "var(--blue)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in oklab, var(--blue) 40%, transparent)"
		}
	},
	textBlue: {
		"color": "var(--blue)"
	},
	bgActive: {
		"backgroundColor": "var(--bg-active)"
	},
	bgAccentSoft: {
		"backgroundColor": "var(--accent-soft)"
	},
	bgGreenSoft: {
		"backgroundColor": "var(--green-soft)"
	},
	bgYellowSoft: {
		"backgroundColor": "var(--yellow-soft)"
	},
	bgRedSoft: {
		"backgroundColor": "var(--red-soft)"
	},
	bgBlueSoft: {
		"backgroundColor": "var(--blue-soft)"
	},
});

/**
 * Badge — a label that reports state, not an action.
 *
 * This is the shape the app kept rebuilding: a dozen surfaces each wrote their
 * own `rounded-* px-1.5 py-0.5 text-meta` chip, and between them they used
 * three radii, four font weights, and six different ways of tinting the same
 * six states (`bg-yellow/15`, `bg-yellow-soft`, and a hand-written
 * `color-mix(… var(--yellow) 16% …)` all appeared for "warning"). Individually
 * each was defensible; together they made one concept look like six.
 *
 * The choices worth knowing:
 *
 *  - `text-meta`, always. A badge sits inside a row it must not outweigh, so
 *    it does not get its own type size or a bolder weight "because this one
 *    matters." The tone carries that.
 *  - `rounded-sm`, matching the majority of what it replaces. A capsule reads
 *    as a control you can press; a badge is not pressable, and the softer rect
 *    also stays concentric inside the `rounded-md`/`rounded-row` boxes these
 *    live in.
 *  - Tones name the *state*, not the colour. A call site asking for `success`
 *    keeps meaning success when the palette moves; one asking for `green`
 *    does not.
 *  - `soft` is the default because a page of outlined chips reads as a form
 *    (see the "do not frame a section in a border" rule in AGENTS.md).
 *    `outline` stays for the few places that sit ON a filled surface, where a
 *    soft fill has nothing to separate itself from.
 *
 * A badge that opens something is not a badge. Use `Button` with `size="sm"`.
 */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
type Variant = "soft" | "outline";

const soft: Record<Tone, string> = {
	neutral: mergeStylexClassName("", sx.bgActive, sx.textDim),
	accent: mergeStylexClassName("", sx.bgAccentSoft, sx.textAccent),
	success: mergeStylexClassName("", sx.bgGreenSoft, sx.textGreen),
	warning: mergeStylexClassName("", sx.bgYellowSoft, sx.textYellow),
	danger: mergeStylexClassName("", sx.bgRedSoft, sx.textRed),
	info: mergeStylexClassName("", sx.bgBlueSoft, sx.textBlue),
};

// The outline set borrows the tone's own ink for its edge at low strength, so
// a warning chip does not read as a neutral box with yellow text in it.
const outline: Record<Tone, string> = {
	// `text-dim`, not `text-faint`: an outlined chip already gives up the fill
	// that a soft badge reads against, and faint ink on top of that leaves the
	// label barely there — which matters most here, since the neutral outline
	// is the one that carries names (a branch, "current") rather than states.
	neutral: mergeStylexClassName("", sx.border, sx.borderLine, sx.textDim),
	accent: mergeStylexClassName("", sx.border, sx.borderAccent40, sx.textAccent),
	success: mergeStylexClassName("", sx.border, sx.borderGreen40, sx.textGreen),
	warning: mergeStylexClassName("", sx.border, sx.borderYellow40, sx.textYellow),
	danger: mergeStylexClassName("", sx.border, sx.borderRed40, sx.textRed),
	info: mergeStylexClassName("", sx.border, sx.borderBlue40, sx.textBlue),
};

export type BadgeProps = React.ComponentPropsWithoutRef<"span"> & {
	tone?: Tone;
	variant?: Variant;
	/** A leading state dot, filled with the tone's ink. */
	dot?: boolean;
};

export function Badge({
	tone = "neutral",
	variant = "soft",
	dot,
	className,
	children,
	...rest
}: BadgeProps) {
	return (
		<span {...mergeStylexProps(cn(variant === mergeStylexClassName("", sx.outline) ? outline[tone] : soft[tone], className), sx.inlineFlex, sx.shrink0, sx.itemsCenter, sx.gap1, sx.roundedSm, sx.px15, sx.py05, typography.meta, sx.whitespaceNowrap)}
			{...rest}
		>
			{dot && (
				<span
					{...stylex.props(sx.size15, sx.shrink0, sx.roundedFull, sx.bgCurrent)}
					aria-hidden="true"
				/>
			)}
			{children}
		</span>
	);
}
