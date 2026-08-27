/**
 * A Plain thread's status, as the app draws it: label, tone and glyph.
 *
 * Three statuses come out of Plain: TODO, SNOOZED, DONE. Anything else the
 * API sends falls through to a grey unknown rather than rendering a raw enum
 * name in a coloured chip.
 *
 * It was a word in a coloured pill until 2026-08. The pill's width was its
 * label's, so the three were 40/42/60px and the badge moved the layout around
 * it as a ticket changed state; now the badge is a fixed square, which is what
 * lets it lead a row (ConversationPane's top bar) instead of trailing the
 * title. The word survives as the tooltip and the accessible name, because a
 * glyph on a tint is quick to scan but not self-naming.
 *
 * A lookup rather than the old `plain-status-${status.toLowerCase()}`: a class
 * assembled at render time can never be proven unused, so it pins its rules in
 * the stylesheet permanently, and the whole point of the migration is to be
 * able to delete what nothing reaches.
 *
 * Snoozed was authored against `var(--amber, #d29922)`, and `--amber` is not a
 * token this app defines, so it always resolved to the literal fallback and
 * stayed the dark-theme yellow even in light mode. It uses the real `--yellow`
 * token now, which does re-resolve per theme.
 */
import {
	IconCheck,
	IconInbox,
	IconMoon,
	IconStatusRing,
} from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";

const sx = stylex.create({
	inlineFlex: {
		"display": "inline-flex"
	},
	size26px: {
		"width": "26px",
		"height": "26px"
	},
	shrink0: {
		"flexShrink": "0"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	justifyCenter: {
		"justifyContent": "center"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgColorMixInSrgbVarBlue18Transparent: {
		"backgroundColor": "var(--blue)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--blue) 18%,transparent)"
		}
	},
	textBlue: {
		"color": "var(--blue)"
	},
	bgColorMixInSrgbVarGreen18Transparent: {
		"backgroundColor": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--green) 18%,transparent)"
		}
	},
	textGreen: {
		"color": "var(--green)"
	},
	bgColorMixInSrgbVarYellow20Transparent: {
		"backgroundColor": "var(--yellow)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--yellow) 20%,transparent)"
		}
	},
	textYellow: {
		"color": "var(--yellow)"
	},
	bgActive: {
		"backgroundColor": "var(--bg-active)"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
});

export const STATUS_LABEL: Record<string, string> = {
	TODO: "Todo",
	SNOOZED: "Snoozed",
	DONE: "Done",
};

/**
 * The box. 26px is the `sm` Button's height, so in the Support bar the badge
 * sits level with the Done / Snooze / priority controls beside it rather than
 * setting a second height, and `rounded-control` is their corner. The glyph
 * inside is the icon set's own 20px floor, which draws ~12px of ink and leaves
 * the tint reading as a disc around it.
 */
const BASE =
	mergeStylexClassName("", sx.inlineFlex, sx.size26px, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedControl);

const TONES: Record<string, string> = {
	todo: mergeStylexClassName("", sx.bgColorMixInSrgbVarBlue18Transparent, sx.textBlue),
	done: mergeStylexClassName("", sx.bgColorMixInSrgbVarGreen18Transparent, sx.textGreen),
	snoozed: mergeStylexClassName("", sx.bgColorMixInSrgbVarYellow20Transparent, sx.textYellow),
};

/**
 * The glyphs. None of them is a circle: the badge is a rounded tint and a ring
 * or a clock face inside it reads as two concentric circles rather than as a
 * state. Todo is the inbox the queue is named after, Snoozed is asleep rather
 * than the clock its own Snooze button wears, and Done is the bare check.
 */
const ICONS: Record<string, typeof IconCheck> = {
	todo: IconInbox,
	done: IconCheck,
	snoozed: IconMoon,
};

export function plainStatusClass(status: string): string {
	const tone = TONES[status.toLowerCase()] ?? mergeStylexClassName("", sx.bgActive, sx.textFaint);
	return `${BASE} ${tone}`;
}

export function plainStatusIcon(status: string): typeof IconCheck {
	return ICONS[status.toLowerCase()] ?? IconStatusRing;
}
