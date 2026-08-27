import { IconCopy } from "../components/icons";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { CopyCheck, useCopy } from "./copy";
import { Tooltip } from "./tooltip";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	translateY05px: {
			translate: "0 .5px"
	},
	tracking014em: {
			letterSpacing: ".14em"
	},
	Mr014em: {
			marginRight: "-.14em"
	},
	TextBoxTrimBothCapAlphabetic: {
			textBox: "trim-both cap alphabetic"
	},
	opacity45: {
			opacity: ".45"
	},
	transitionOpacity: {
			transitionProperty: "opacity",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap15: {
			gap: "6px"
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
	bgControl: {
			backgroundColor: "var(--control-surface)"
	},
	px25: {
			paddingInline: "10px"
	},
	py1: {
			paddingBlock: "4px"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	fontBold: {
			fontWeight: "var(--font-weight-bold)"
	},
	textFg: {
			color: "var(--text)"
	},
	smoothShadowSm: {
			boxShadow: "0 1px 3px -1px var(--smooth-shadow-color), 0 4px 10px -4px var(--smooth-shadow-color)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},

	activeScale098: {
		":active": {
			"scale": ".98"
		}
	},
	hoverBorderLineStrong: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--border-strong)"
			}
		}
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},

	transitionBackgroundColorBorderColorScale: {
		"transitionProperty": "background-color,border-color,scale",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
});

/**
 * A one-time device code (GitHub, ChatGPT) that someone has to enter on
 * another site — rendered as the button it always wanted to be. Retyping
 * `4A56-C7AE` by hand is most of what a device flow costs the person doing it,
 * and the code was previously plain text on three separate surfaces, so the
 * copy affordance lives here rather than being re-invented per flow.
 *
 * Wide tracking is what keeps an ambiguous code readable (0/O, 1/I), but
 * letter-spacing also pads the glyph *after* the last character; the negative
 * margin pulls that phantom column back off the copy glyph so the pair isn't
 * lopsided.
 */
export function DeviceCode({
	code,
	className,
	/** Accessible/tooltip verb — override only if "code" is the wrong noun. */
	label = "Copy code",
}: {
	code: string;
	className?: string;
	label?: string;
}) {
	const { copied, copy } = useCopy();
	return (
		<Tooltip label={copied ? "Copied" : label}>
			<button
				type="button"
				aria-label={`${label} ${code}`}
				onClick={() => copy(code, { toast: "Code copied" })} {...mergeStylexProps(cn("group", mergeStylexClassName("", sx.transitionBackgroundColorBorderColorScale, sx.activeScale098), mergeStylexClassName("", sx.hoverBorderLineStrong, sx.hoverBgHover), className), sx.inlineFlex, sx.itemsCenter, sx.gap15, sx.roundedControl, sx.border, sx.borderLine, sx.bgControl, sx.px25, sx.py1, sx.fontMono, typography.itemTitle, sx.fontBold, sx.textFg, sx.smoothShadowSm, sx.focusRing)}
			>
				{/* Cap-band centered against the copy glyph: `text-box` trims the
				    line box to cap height and baseline, so the code's own ink sits
				    on the button's middle whatever font the platform picks, plus
				    the half pixel the PR strip's labels carry (a word reads a touch
				    high at the geometric center). */}
				<span {...stylex.props(sx.translateY05px, sx.tracking014em, sx.Mr014em, sx.TextBoxTrimBothCapAlphabetic)}>
					{code}
				</span>
				<CopyCheck
					copied={copied}
					size={20}
					idle={
						<IconCopy
							size={20} {...mergeStylexProps("group-hover:opacity-80", sx.opacity45, sx.transitionOpacity)}
						/>
					}
				/>
			</button>
		</Tooltip>
	);
}
