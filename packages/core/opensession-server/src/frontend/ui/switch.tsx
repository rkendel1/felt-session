import * as React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	cursorPointer: {
			cursor: "pointer"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},

	relative: {
		"position": "relative"
	},
	inlineFlex: {
		"display": "inline-flex"
	},
	shrink0: {
		"flexShrink": "0"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	,
		cornerShape: "round"},
	bgActive: {
		"backgroundColor": "var(--bg-active)"
	},
	h5: {
		"height": "20px"
	},
	w11: {
		"width": "44px"
	},
	h6: {
		"height": "24px"
	},
	w54px: {
		"width": "54px"
	},
	transitionColors: {
		"transitionProperty": "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	durationVarDurMicro: {
		"--tw-duration": "var(--dur-micro)",
		"transitionDuration": "var(--dur-micro)"
	},
	easeVarEase: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	absolute: {
		"position": "absolute"
	},
	left05: {
		"left": "2px"
	},
	top05: {
		"top": "2px"
	},
	bgWhite: {
		"backgroundColor": "var(--color-white)"
	},
	h4: {
		"height": "16px"
	},
	w26px: {
		"width": "26px"
	},
	w8: {
		"width": "32px"
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

	shadow01px3pxRgba0000220001pxRgba000007: {
		"--tw-shadow": "0 1px 3px var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 22%, transparent)), 0 0 0 1px var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 7%, transparent))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	transitionTranslateBackgroundColor: {
		"transitionProperty": "translate,background-color",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
});

type SwitchSize = "md" | "sm";

/** The track. macOS 26's NSSwitch, measured off a render from the Mac node:
 *  a 54×24pt track with a 2pt inset. A pt is a CSS px here, so these are its
 *  numbers, not a scaled interpretation of them. It is longer and flatter
 *  than the iOS switch (51×31), which is the shape difference you see against
 *  the native app. "sm" is the same switch at 44×20, for dense rows where the
 *  full control would outweigh the row it sits in.
 *
 *  The shape lives in these two strings rather than inside the component
 *  because `SwitchIndicator` below draws the same switch without owning the
 *  press: a switch in a menu row that had drifted from a switch in a settings
 *  row would read as a different control. Both are keyed off `data-checked`,
 *  which Base UI sets on the real thing and the indicator sets by hand. */
const trackClasses = (size: SwitchSize) =>
	cn(
		mergeStylexClassName("", sx.relative, sx.inlineFlex, sx.shrink0, sx.roundedFull, sx.bgActive),
		size === "sm" ? mergeStylexClassName("", sx.h5, sx.w11) : mergeStylexClassName("", sx.h6, sx.w54px),
		// The checked track is the selected app accent, matching native
		// controls, through --accent-control: Black and Honey swap it for
		// a blue in dark mode, where a white or yellow track stops reading
		// as "on". Every other accent resolves straight through.
		mergeStylexClassName("data-[checked]:bg-accent-control", sx.transitionColors, sx.durationVarDurMicro, sx.easeVarEase),
	);

/** The knob is a 32×20 capsule, not a circle. That wider shape is most of
 *  what reads as the current macOS switch. The small size keeps the 2px inset
 *  and the capsule, at 26×16. */
const thumbClasses = (size: SwitchSize) =>
	cn(
		mergeStylexClassName("data-[checked]:bg-on-accent-control", sx.shadow01px3pxRgba0000220001pxRgba000007, sx.transitionTranslateBackgroundColor, sx.absolute, sx.left05, sx.top05, sx.roundedFull, sx.bgWhite, sx.durationVarDurMicro, sx.easeVarEase),
		size === "sm"
			? mergeStylexClassName("data-[checked]:translate-x-[14px]", sx.h4, sx.w26px)
			: mergeStylexClassName("data-[checked]:translate-x-[18px]", sx.h5, sx.w8),
	);

const STRETCH_ANIMATION_ID = "switch-thumb-stretch";

/** Stretch only while the thumb travels, anchored toward its destination. */
function animateThumbTravel(thumb: HTMLElement, checked: boolean) {
	if (
		!thumb.animate ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	)
		return;
	thumb
		.getAnimations()
		.find((animation) => animation.id === STRETCH_ANIMATION_ID)
		?.cancel();
	const origin = checked ? "left center" : "right center";
	const easing =
		getComputedStyle(thumb).getPropertyValue("--ease").trim() || "ease-out";
	const animation = thumb.animate(
		[
			{ scale: "1 1", transformOrigin: origin, easing },
			{ scale: "1.12 1", transformOrigin: origin, easing, offset: 0.4 },
			{ scale: "1 1", transformOrigin: origin },
		],
		{ duration: 150 },
	);
	animation.id = STRETCH_ANIMATION_ID;
}

type SwitchProps = Omit<React.ComponentProps<typeof BaseSwitch.Root>, "size"> & {
	className?: string;
	size?: SwitchSize;
};

export function Switch({
	className,
	size = "md",
	onCheckedChange,
	...props
}: SwitchProps) {
	const thumbRef = React.useRef<HTMLSpanElement>(null);
	return (
		<BaseSwitch.Root {...mergeStylexProps(cn(trackClasses(size), mergeStylexClassName("", sx.focusVisibleRing2, sx.focusVisibleRingAccent50, sx.focusVisibleRingOffset2, sx.focusVisibleRingOffsetBg), "data-[disabled]:cursor-default data-[disabled]:opacity-40", className), sx.cursorPointer, sx.outlineNone)}
			onCheckedChange={(checked, eventDetails) => {
				if (thumbRef.current) animateThumbTravel(thumbRef.current, checked);
				onCheckedChange?.(checked, eventDetails);
			}}
			{...props}
		>
			<BaseSwitch.Thumb ref={thumbRef} className={thumbClasses(size)} />
		</BaseSwitch.Root>
	);
}

/**
 * The switch as a picture of a setting rather than the control for it: for a
 * row that is itself the control, where a real switch would be a button
 * inside a button and would take the press away from the row around it. It
 * holds no focus and answers no pointer, and it is hidden from assistive
 * technology, because the row already says what the setting is and whether it
 * is on.
 */
export function SwitchIndicator({
	on,
	size = "sm",
	className,
}: {
	/** Whether the setting is on. */
	on: boolean;
	size?: SwitchSize;
	className?: string;
}) {
	// Written as an attribute rather than a class so both halves take the same
	// `data-[checked]:` utilities the real control does.
	const checked = on ? "" : undefined;
	return (
		<span
			aria-hidden
			data-checked={checked} {...mergeStylexProps(cn(trackClasses(size), className), sx.pointerEventsNone)}
		>
			<span data-checked={checked} className={thumbClasses(size)} />
		</span>
	);
}
