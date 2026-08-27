import * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
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
	textOnAccentControl: {
			color: "var(--on-accent-control,var(--on-accent))"
	},
	size3: {
			width: "12px",
			height: "12px"
	},
	size4: {
			width: "16px",
			height: "16px"
	},
	shrink0: {
			flexShrink: "0"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderLineStrong: {
			borderColor: "var(--border-strong)"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	p0: {
			padding: "0"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	durationVarDurMicro: {
			transitionDuration: "var(--dur-micro)"
	},
	easeVarEase: {
			transitionTimingFunction: "var(--ease)"
	},

	hoverBorderFaint: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--text-faint)"
			}
		}
	},
	focusVisibleRing2: {
		":focusVisible": {
			"--tw-ring-shadow": "var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color,currentcolor)",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
	focusVisibleRingAccent50: {
		":focusVisible": {
			"--tw-ring-color": "var(--accent)"
		},
		"@supports (color: color-mix(in lab, red, red))": {
			":focusVisible": {
				"--tw-ring-color": "color-mix(in oklab, var(--accent) 50%, transparent)"
			}
		}
	},
	focusVisibleRingOffset2: {
		":focusVisible": {
			"--tw-ring-offset-width": "2px",
			"--tw-ring-offset-shadow": "var(--tw-ring-inset,) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color)"
		}
	},
	focusVisibleRingOffsetBg: {
		":focusVisible": {
			"--tw-ring-offset-color": "var(--bg)"
		}
	},

	transitionBackgroundColorBorderColor: {
		"transitionProperty": "background-color,border-color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
});

type CheckboxProps = Omit<React.ComponentProps<typeof BaseCheckbox.Root>, "size"> & {
	className?: string;
};

/**
 * The app's checkbox: a form option you pick, as opposed to `Switch`, which
 * turns a setting on. It replaces the browser's own `input[type=checkbox]`,
 * whose fill is the UA accent rather than ours and whose box ignores the
 * corner and border scales every other control follows.
 *
 * It is labelable, so the existing pattern still works and the whole row stays
 * clickable:
 *
 *   <label {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
 *     <Checkbox checked={x} onCheckedChange={setX} />
 *     Include thread replies
 *   </label>
 */
export function Checkbox({ className, ...props }: CheckboxProps) {
	return (
		<BaseCheckbox.Root {...mergeStylexProps(cn(mergeStylexClassName("", sx.transitionBackgroundColorBorderColor), mergeStylexClassName("", sx.hoverBorderFaint), "data-[checked]:border-accent-control data-[checked]:bg-accent-control data-[checked]:hover:border-accent-control", mergeStylexClassName("", sx.focusVisibleRing2, sx.focusVisibleRingAccent50, sx.focusVisibleRingOffset2, sx.focusVisibleRingOffsetBg), "data-[disabled]:cursor-default data-[disabled]:opacity-40", className), sx.flex, sx.size4, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedSm, sx.border, sx.borderLineStrong, sx.bgSurface, sx.p0, sx.outlineNone, sx.durationVarDurMicro, sx.easeVarEase)}
			{...props}
		>
			<BaseCheckbox.Indicator {...mergeStylexProps("data-[unchecked]:hidden", sx.flex, sx.textOnAccentControl)}>
				<svg
					viewBox="0 0 12 12"
					{...stylex.props(sx.size3)}
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden
				>
					<path d="M2.4 6.3 4.7 8.6 9.6 3.5" />
				</svg>
			</BaseCheckbox.Indicator>
		</BaseCheckbox.Root>
	);
}
