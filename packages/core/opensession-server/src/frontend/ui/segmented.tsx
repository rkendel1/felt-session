import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { motion } from "motion/react";
import * as React from "react";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { duration, ease } from "./motion";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap15: {
			gap: "6px"
	},
	absolute: {
			position: "absolute"
	},
	inset0: {
			inset: "0"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderVarSegmentedKnobEdge: {
			borderColor: "var(--segmented-knob-edge)"
	},
	bgVarSegmentedKnobSurface: {
			backgroundColor: "var(--segmented-knob-surface)"
	},
	smoothShadowSm: {
			boxShadow: "0 1px 3px -1px var(--smooth-shadow-color), 0 4px 10px -4px var(--smooth-shadow-color)"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgHover: {
			backgroundColor: "var(--hover)"
	},
	p05: {
			padding: "2px"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	border0: {
			borderStyle: "solid",
			borderWidth: "0"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	durationVarDurMicro: {
			transitionDuration: "var(--dur-micro)"
	},
	easeVarEase: {
			transitionTimingFunction: "var(--ease)"
	},
	textFg: {
			color: "var(--text)"
	},
	textDim: {
			color: "var(--text-dim)"
	},

	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phonePy2: {
		"@media (max-width: 720px)": {
			"paddingBlock": "8px"
		}
	},
	phoneTextItemTitle: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-item-title)"
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledTextFaint: {
		":disabled": {
			"color": "var(--text-faint)"
		}
	},
	disabledHoverTextFaint: {
		"@media (hover: hover)": {
			":disabled": {
				":hover": {
					"color": "var(--text-faint)"
				}
			}
		}
	},

	justifyCenter: {
			justifyContent: "center"
	},
	textCenter: {
			textAlign: "center"
	},
	px2: {
		"paddingInline": "8px"
	},
	py05: {
		"paddingBlock": "2px"
	},
	px25: {
		"paddingInline": "10px"
	},
	py1: {
		"paddingBlock": "4px"
	},
});

/**
 * Segmented control — a short, exclusive choice shown in full, where every
 * option is worth reading at a glance: Default / Compact, 7d / 14d / 30d / 90d.
 *
 * Recessed track, raised knob: the option in effect sits ON the group rather
 * than being a darker hole cut into it. A plate sitting IN a well is not the
 * same problem as one sitting on the page, so the knob does not borrow the
 * Button plate's `border-line`: that hairline is darker than the `bg-hover`
 * track it lies on, which made the knob read as an outline drawn around the
 * option, its top edge unjustified by any shadow (light falls downward). The
 * knob's surface and edge are per-theme tokens instead, `--segmented-knob-*`
 * in base.css: paper and no edge in light, where the cast shadow separates it,
 * and in dark a fill well above the ramp's last step with a hair-lighter edge,
 * because a shadow on a near-black track does nothing and a plate at or below
 * the track's own tier reads as a hole rather than a knob. The
 * track is `bg-hover` — one of the few places that absolute surface is right,
 * because here it is a real surface (a well the options sit in) rather than an
 * interaction wash. Concentric corners: the knob's `rounded-control` (12) plus
 * the track's 2px padding is the track's `rounded-lg` (14).
 *
 * The knob is one element that MOVES between options (Motion's `layoutId`), not
 * a background that blinks on and off, so the control says which way the value
 * went. Each mounted group gets its own id from `useId`, or two segmented
 * controls on one page would trade a single knob back and forth across the
 * screen. Trading it IS right where a control beside the group holds the same
 * value — the date range next to the presets in `ui/date-picker` — so `knobId`
 * can be passed in and the knob rendered from `SegmentedKnob` out there.
 *
 * Built on Base UI's ToggleGroup, which is what makes the keyboard right:
 * arrow keys move between the options, the group is one tab stop, and each
 * option announces through `aria-pressed` whether it is the one in effect.
 * Re-pressing the current option is ignored — a segmented control always has a
 * value, so there is nothing for it to mean.
 *
 * Reach for it only for two or three short options that all deserve to be
 * visible. A longer list (every repo on the instance) belongs in a `Select` or
 * a menu — spelled out, it wraps to a second line and outweighs the content it
 * is choosing for.
 */
/** Two densities, one shape. `sm` only tightens the option's padding, so the
 *  knob keeps `rounded-control` and the track its `rounded-lg` — the same
 *  concentric pair at both sizes, and the same "goes pill when short" the
 *  Button primitive relies on. Use it where the control is chrome beside the
 *  content it filters rather than a setting being read on its own. */
type Size = "sm" | "md";

const optionSizes: Record<Size, string> = {
	sm: mergeStylexClassName("", sx.px2, sx.py05),
	md: mergeStylexClassName("", sx.px25, sx.py1),
};

const SegmentedContext = React.createContext<{
	knobId: string;
	value: string | null;
	size: Size;
}>({
	knobId: "",
	value: null,
	size: "md",
});

export function Segmented({
	label,
	value,
	onValueChange,
	size = "md",
	knobId: knobIdProp,
	className,
	children,
	...props
}: Omit<
	React.ComponentPropsWithoutRef<"div">,
	"value" | "onChange" | "defaultValue"
> & {
	label: string;
	/** The option in effect. `null` leaves every option unpressed — for a
	 *  control whose value can also be set from outside it (a custom date
	 *  range that matches no preset). */
	value: string | null;
	onValueChange: (value: string) => void;
	size?: Size;
	/** Share the knob with a control outside the group that holds the same
	 *  value, so it travels between the two instead of blinking across. Pass
	 *  the same id to `SegmentedKnob` over there. */
	knobId?: string;
}) {
	const ownId = React.useId();
	const knobId = knobIdProp ?? ownId;
	return (
		<SegmentedContext.Provider value={{ knobId, value, size }}>
			<ToggleGroup
				aria-label={label}
				value={value === null ? [] : [value]}
				onValueChange={(next) => {
					const picked = next[0];
					if (picked !== undefined && picked !== value) onValueChange(picked);
				}} {...mergeStylexProps(cn(className), sx.inlineFlex, sx.roundedLg, sx.bgHover, sx.p05)}
				{...props}
			>
				{children}
			</ToggleGroup>
		</SegmentedContext.Provider>
	);
}

export function SegmentedOption({
	value,
	className,
	children,
	...props
}: Omit<React.ComponentPropsWithoutRef<"button">, "value"> & { value: string }) {
	const { knobId, value: current, size } = React.useContext(SegmentedContext);
	const selected = current === value;
	return (
		<Toggle
			value={value} {...mergeStylexProps(cn(optionSizes[size], mergeStylexClassName("", sx.phonePx3, sx.phonePy2, sx.phoneTextItemTitle), selected ? "" : mergeStylexClassName("", sx.hoverTextFg), mergeStylexClassName("", sx.disabledCursorDefault, sx.disabledTextFaint, sx.disabledHoverTextFaint), className), sx.relative, sx.inlineFlex, sx.itemsCenter, sx.justifyCenter, sx.textCenter, sx.cursorPointer, sx.roundedControl, sx.border0, sx.bgTransparent, typography.controlLabel, sx.fontMedium, sx.whitespaceNowrap, sx.transitionColors, sx.durationVarDurMicro, sx.easeVarEase, selected && sx.textFg, !(selected) && sx.textDim)}
			{...props}
		>
			{selected && <SegmentedKnob knobId={knobId} />}
			{/* Above the knob, which is absolutely positioned over the option. */}
			<span {...stylex.props(sx.relative, sx.flex, sx.itemsCenter, sx.gap15)}>{children}</span>
		</Toggle>
	);
}

/**
 * The knob itself. Rendered by whichever option is in effect, and exported so a
 * control sitting on the same track outside the group can hold it too: one
 * element with one `layoutId` means the knob travels to it rather than blinking
 * off one plate and on to another.
 *
 * Its host needs `relative` and a `rounded-control` corner of its own, since
 * the knob fills the box it is dropped into.
 */
export function SegmentedKnob({ knobId }: { knobId: string }) {
	return (
		<motion.span
			layoutId={knobId}
			aria-hidden
			{...stylex.props(sx.absolute, sx.inset0, sx.roundedControl, sx.border, sx.borderVarSegmentedKnobEdge, sx.bgVarSegmentedKnobSurface, sx.smoothShadowSm)}
			transition={{ type: "tween", duration: duration.base, ease }}
		/>
	);
}
