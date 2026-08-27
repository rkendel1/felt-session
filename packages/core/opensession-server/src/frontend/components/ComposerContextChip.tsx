import React from "react";
import { motion } from "motion/react";
import { cn, mergeStylexProps, mergeStylexClassName } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { Tooltip } from "../ui/tooltip";
import { IconX } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	shrink0: {
			flexShrink: "0"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	scale08: {
			scale: ".8"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	mb1: {
			marginBottom: "4px"
	},
	flex: {
			display: "flex"
	},
	originLeft: {
			transformOrigin: "0"
	},

	inlineFlex: {
		"display": "inline-flex"
	},
	h7: {
		"height": "28px"
	},
	maxWFull: {
		"maxWidth": "100%"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap1: {
		"gap": "4px"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	,
		cornerShape: "round"},
	px2: {
		"paddingInline": "8px"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	relative: {
		"position": "relative"
	},
	Mr1: {
		"marginRight": "-4px"
	},
	size5: {
		"width": "20px",
		"height": "20px"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	justifyCenter: {
		"justifyContent": "center"
	},
	beforeAbsolute: {
		"::before": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	beforeInset2: {
		"::before": {
			"content": "var(--tw-content)",
			"inset": "-8px"
		}
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity50: {
		":disabled": {
			"opacity": ".5"
		}
	},

	enabledActiveScale096: {
		":enabled": {
			":active": {
				"scale": ".96"
			}
		}
	},
	enabledTransitionColorTransform: {
		":enabled": {
			"transitionProperty": "color,transform",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},

	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	borderLine60: {
		"borderColor": "var(--border)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in oklab, var(--border) 60%, transparent)"
		}
	},
	bgSurface: {
		"backgroundColor": "var(--bg)"
	},
	textFg: {
		"color": "var(--text)"
	},
	opacity60: {
		"opacity": ".6"
	},
	enabledHoverTextFg: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"color": "var(--text)"
				}
			}
		}
	},
	bgColorMixInSrgbVarYellowTint18Transparent: {
		"backgroundColor": "var(--yellow-tint)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--yellow-tint) 18%,transparent)"
		}
	},
	textYellow: {
		"color": "var(--yellow)"
	},
	textYellow60: {
		"color": "var(--yellow)",
		"@supports (color: color-mix(in lab, red, red))": {
			"color": "color-mix(in oklab, var(--yellow) 60%, transparent)"
		}
	},
	enabledHoverTextYellow: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"color": "var(--yellow)"
				}
			}
		}
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
	textGreen60: {
		"color": "var(--green)",
		"@supports (color: color-mix(in lab, red, red))": {
			"color": "color-mix(in oklab, var(--green) 60%, transparent)"
		}
	},
	enabledHoverTextGreen: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"color": "var(--green)"
				}
			}
		}
	},
});

/** Per-tone colour, spelled out in full: Tailwind scans source as text, so a
 *  class assembled from the tone name would never be generated. Neutral keeps
 *  an edge against the plain composer. Note and Ask use their tinted fills
 *  alone for cleaner labels on the matching composer washes. */
const CHIP_TONE = {
	neutral: {
		box: mergeStylexClassName("", sx.border, sx.borderLine60, sx.bgSurface, sx.textFg),
		icon: mergeStylexClassName("", sx.textFaint, sx.opacity60),
		remove: mergeStylexClassName("", sx.textFaint, sx.enabledHoverTextFg),
	},
	note: {
		box: mergeStylexClassName("", sx.bgColorMixInSrgbVarYellowTint18Transparent, sx.textYellow),
		icon: mergeStylexClassName("", sx.textYellow),
		remove: mergeStylexClassName("", sx.textYellow60, sx.enabledHoverTextYellow),
	},
	ask: {
		box: mergeStylexClassName("", sx.bgColorMixInSrgbVarGreen18Transparent, sx.textGreen),
		icon: mergeStylexClassName("", sx.textGreen),
		remove: mergeStylexClassName("", sx.textGreen60, sx.enabledHoverTextGreen),
	},
} as const;

/**
 * The row of context that sits directly above the composer's field: a small
 * pill naming something attached to the next send, with an ✕ that detaches it.
 *
 * Three things live here: the transcript selection ("Selected text"), note
 * mode ("Team note") and ask mode ("Ask"). They are the same object as
 * far as a reader is concerned, *this composer is not in its ordinary state,
 * and here is what that state is*, so they share one shape rather than each
 * inventing a marker. That is also what keeps two tinted surfaces apart: the
 * wash says something is different, the chip says which, and no state paints
 * the box without naming itself here.
 *
 * The ✕ is optional, because it has to be honest. Ask mode's exit cuts a
 * worktree and only the server can say whether this session may promote at
 * all; where it cannot, the chip renders as a label with no ✕ rather than
 * offering an exit that does not exist.
 */
export function ComposerContextChip({
	icon,
	label,
	meta,
	title,
	tone = "neutral",
	onRemove,
	removeLabel,
	disabled,
}: {
	/** Leading glyph, sized by the caller (15px is the house size here). */
	icon: React.ReactNode;
	label: string;
	/** Optional compact detail shown after the label, e.g. "+20 lines". */
	meta?: string;
	/** Text shown in the shared tooltip instead of a native `title` popup. */
	title?: string;
	/** `note` and `ask` tint the pill, because each sits on a surface that is
	 *  already tinted in its own ink: a neutral chip on the yellow or green
	 *  writing surface reads as a hole in it rather than as a label on it. */
	tone?: keyof typeof CHIP_TONE;
	/** Omit to render the chip as a label. See the note on the ✕ above. */
	onRemove?: () => void;
	/** Accessible name for the ✕: "Remove selected text", "Leave note mode". */
	removeLabel?: string;
	disabled?: boolean;
}) {
	const colours = CHIP_TONE[tone];
	const chip = (
		<div
			className={cn(
				mergeStylexClassName("", sx.inlineFlex, sx.h7, sx.maxWFull, sx.itemsCenter, sx.gap1, sx.roundedFull, sx.px2, typography.label, sx.fontMedium),
				colours.box,
			)}
		>
			{/* No optical nudge on either glyph. Every icon this chip carries is
			    drawn on the shared 24 grid with its ink centred (IconEye, IconNote,
			    IconX all span 4.75-19.25 about y=12), and a brand tile is a solid
			    square, so a translate here only pushes the mark off the row's
			    centre: measured, it sat 1px below while the label's ink sat 0.5px
			    above, which is the 1.5px step you can see at Retina. */}
			<span className={cn(mergeStylexClassName("", sx.inlineFlex, sx.shrink0, sx.itemsCenter), colours.icon)}>
				{icon}
			</span>
			<span {...stylex.props(sx.truncate)}>{label}</span>
			{meta && (
				<span {...stylex.props(sx.shrink0, sx.fontNormal, sx.textFaint)}>{meta}</span>
			)}
			{onRemove && (
				<button
					type="button"
					onClick={onRemove}
					disabled={disabled}
					aria-label={removeLabel}
					className={cn(
						// `before:-inset-2` grows the hit area past the 20px box without
						// growing the pill around it.
						mergeStylexClassName("", sx.enabledActiveScale096, sx.enabledTransitionColorTransform, sx.relative, sx.Mr1, sx.flex, sx.size5, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.beforeAbsolute, sx.beforeInset2, sx.disabledCursorDefault, sx.disabledOpacity50),
						colours.remove,
					)}
				>
					<IconX size={20} {...mergeStylexProps("[&_path]:stroke-2", sx.scale08)} />
				</button>
			)}
		</div>
	);
	return (
		// Two boxes, because the chip is what changes the composer's height and
		// the composer no longer animates its own size (see the note on the box
		// in Composer.tsx). The outer one collapses its height, so the composer
		// grows and shrinks with the chip on every frame rather than snapping
		// once the ✕ has already faded the chip out; `overflow-hidden` both clips
		// the collapse and keeps the inner margin inside the measured height. The
		// inner one carries the chip's own arrival.
		<motion.div
			initial={{ height: 0, opacity: 0 }}
			animate={{ height: "auto", opacity: 1 }}
			exit={{ height: 0, opacity: 0 }}
			transition={{ type: "tween", duration: duration.base, ease }}
			{...stylex.props(sx.overflowHidden)}
		>
			<motion.div
				initial={{ y: 2, scale: 0.98 }}
				animate={{ y: 0, scale: 1 }}
				transition={{ type: "tween", duration: duration.micro, ease }}
				{...stylex.props(sx.mb1, sx.flex, sx.originLeft)}
			>
				{title ? <Tooltip label={title}>{chip}</Tooltip> : chip}
			</motion.div>
		</motion.div>
	);
}
