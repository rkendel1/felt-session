import * as React from "react";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "./cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	size15: {
			width: "6px",
			height: "6px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgOnAccentControl: {
			backgroundColor: "var(--on-accent-control,var(--on-accent))"
	},
	flex: {
			display: "flex"
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
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
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

type RadioProps = React.ComponentProps<typeof BaseRadio.Root>;
type RadioGroupProps = React.ComponentProps<typeof BaseRadioGroup>;

/** The app's radio control for choosing one option from a visible set. */
export function Radio({ className, ...props }: RadioProps) {
	return (
		<BaseRadio.Root {...mergeStylexProps(cn(mergeStylexClassName("", sx.transitionBackgroundColorBorderColor), mergeStylexClassName("", sx.hoverBorderFaint), "data-[checked]:border-accent-control data-[checked]:bg-accent-control data-[checked]:hover:border-accent-control", mergeStylexClassName("", sx.focusVisibleRing2, sx.focusVisibleRingAccent50, sx.focusVisibleRingOffset2, sx.focusVisibleRingOffsetBg), "data-[disabled]:cursor-default data-[disabled]:opacity-40", className), sx.flex, sx.size4, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.border, sx.borderLineStrong, sx.bgSurface, sx.p0, sx.outlineNone, sx.durationVarDurMicro, sx.easeVarEase)}
			{...props}
		>
			<BaseRadio.Indicator className={mergeStylexOverrideClassName("", sx.size15, sx.roundedFull, sx.bgOnAccentControl)} />
		</BaseRadio.Root>
	);
}

/** Coordinates a visible set of `Radio` controls. */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
	return <BaseRadioGroup className={cn(className)} {...props} />;
}
