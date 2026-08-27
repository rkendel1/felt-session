import * as React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { IconCheck, IconChevronDown } from "../components/icons";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "./cn";
import { fieldClasses } from "./input";
import {
	FLOATING_OVERLAY_LAYER,
	POPUP_HOOK,
	popupItemClasses,
	popupScrollClasses,
	popupSurfaceClasses,
} from "./popup-classes";
import { restoreSelectFocusAfterClose } from "./select-focus";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	colStart1: {
			gridColumnStart: "1"
	},
	rowStart1: {
			gridRowStart: "1"
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
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	minW0: {
			minWidth: "0"
	},
	gap2: {
			gap: "8px"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	size17px: {
			width: "17px",
			height: "17px"
	},
	textAccent: {
			color: "var(--accent-ink)"
	},
	invisible: {
			visibility: "hidden"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	colStart3: {
			gridColumnStart: "3"
	},
	colStart2: {
			gridColumnStart: "2"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	minWVarAnchorWidth: {
			minWidth: "var(--anchor-width)"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap3: {
			gap: "12px"
	},
	px2: {
			paddingInline: "8px"
	},
	pb1: {
			paddingBottom: "4px"
	},
	pt15: {
			paddingTop: "6px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	tracking001em: {
			letterSpacing: "-.01em"
	},
	Mx15: {
			marginInline: "-6px"
	},
	my15: {
			marginBlock: "6px"
	},
	hPx: {
			height: "1px"
	},
	bgLine: {
			backgroundColor: "var(--border)"
	},

	inlineGrid: {
		"display": "inline-grid"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	pr2: {
		"paddingRight": "8px"
	},
	textLeft: {
		"textAlign": "left"
	},
	hoverBorderLineStrong: {
		"@media (hover: hover)": {
			":hover": {
				"borderColor": "var(--border-strong)"
			}
		}
	},

	gridColsAutoMinmax01frAuto: {
		"gridTemplateColumns": "auto minmax(0,1fr) auto"
	},
	gridColsMinmax01frAuto: {
		"gridTemplateColumns": "minmax(0,1fr) auto"
	},
	transitionBorderColorBoxShadow: {
		"transitionProperty": "border-color,box-shadow",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	enabledHoverSmoothShadowXs: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"--smooth-shadow-color": "var(--tw-shadow-color,black)",
					"boxShadow": "0 1px 2px -1px var(--smooth-shadow-color), 0 2px 5px -3px var(--smooth-shadow-color)"
				}
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":enabled": {
					":hover": {
						"boxShadow": "0 1px 2px -1px color-mix(in srgb, var(--smooth-shadow-color) 5%, transparent), 0 2px 5px -3px color-mix(in srgb, var(--smooth-shadow-color) 7%, transparent)"
					}
				}
			}
		}
	},
});

/**
 * Select on Base UI parts: a field-shaped trigger that opens the app's own
 * popup instead of the operating system's dropdown.
 *
 * A native `<select>` is the odd control out here. It draws the platform's
 * arrow rather than our icon set, it opens a list styled by the OS, and its
 * rows can carry nothing but text, so a page of settings ends with one
 * control that belongs to a different app. This is the same surface every
 * menu in the product already uses (`ui/popup-classes.ts`), so a select and
 * the ⋯ menu in the row beside it open the same-looking list.
 *
 * Composable parts, like `ui/menu`: assemble Root/Trigger/Popup/Item rather
 * than passing item configs. `components/settings/shared.tsx` wraps these in
 * the options-array API settings rows use.
 *
 * One thing to know: pass `items` to `Root`. The trigger's value text is
 * resolved from that list, so without it a closed select shows the raw value
 * (`pi/anthropic/claude-opus-5`) instead of its label.
 *
 * Reach for `ui/input`'s native `Select` only when you specifically want the
 * OS picker.
 */

type Size = "sm" | "md" | "lg";

const SelectFocusContext = React.createContext<React.RefObject<boolean> | null>(null);

function Root<Value, Multiple extends boolean | undefined = false>({
	onOpenChange,
	onOpenChangeComplete,
	children,
	...props
}: BaseSelect.Root.Props<Value, Multiple>) {
	const restoreFocusRef = React.useRef(true);
	const dismissedElementRef = React.useRef<HTMLElement | null>(null);
	return (
		<SelectFocusContext.Provider value={restoreFocusRef}>
			<BaseSelect.Root
				{...props}
				onOpenChange={(open, eventDetails) => {
					if (!open) {
						restoreFocusRef.current = restoreSelectFocusAfterClose(eventDetails.reason);
						if (!restoreFocusRef.current && document.activeElement instanceof HTMLElement) {
							dismissedElementRef.current = document.activeElement;
							dismissedElementRef.current.blur();
						}
					}
					onOpenChange?.(open, eventDetails);
				}}
				onOpenChangeComplete={(open) => {
					if (!open && !restoreFocusRef.current) {
						dismissedElementRef.current?.blur();
						dismissedElementRef.current = null;
					}
					onOpenChangeComplete?.(open);
				}}
			>
				{children}
			</BaseSelect.Root>
		</SelectFocusContext.Provider>
	);
}

type TriggerProps = Omit<React.ComponentProps<typeof BaseSelect.Trigger>, "className"> & {
	className?: string;
	size?: Size;
	/** Shown when nothing is selected. */
	placeholder?: React.ReactNode;
	/**
	 * A glyph before the value, in its own column so `sizeTo` still governs
	 * the label's width. Pass it (even as `null`) to keep the slot reserved,
	 * so a value with no glyph doesn't shift the text.
	 */
	icon?: React.ReactNode;
	/**
	 * Every label the select can show. The trigger reserves the width of the
	 * widest one, so choosing a longer option doesn't resize the control and
	 * shuffle the row around it. A native select does this for free; a custom
	 * trigger sizes to the current value unless it is told the rest.
	 *
	 * Skip it where the trigger's width is already fixed by its container (a
	 * form grid, a `w-full` field).
	 */
	sizeTo?: React.ReactNode[];
};

function Trigger(triggerProps: TriggerProps) {
	const { className, size = "md", placeholder, sizeTo, icon, children, ...props } = triggerProps;
	// Presence, not truthiness: an icon-bearing list keeps the slot for the
	// values that have no glyph, so the labels stay on one x.
	const iconSlot = "icon" in triggerProps;
	const label = iconSlot ? mergeStylexClassName("", sx.colStart2) : mergeStylexClassName("", sx.colStart1);
	return (
		<BaseSelect.Trigger
			{...props}
			className={cn(
				fieldClasses(
					size,
					// The chevron sits in flow in its own grid column, so the
					// field's own padding is what separates it from the edge.
					cn(
						mergeStylexClassName("", sx.inlineGrid, sx.cursorPointer, sx.itemsCenter, sx.gap2, sx.pr2, sx.textLeft),
						iconSlot
							? mergeStylexClassName("", sx.gridColsAutoMinmax01frAuto)
							: mergeStylexClassName("", sx.gridColsMinmax01frAuto),
					),
				),
				// A select lifts slightly under the pointer; opening still reads like
				// focus, with the border carrying that state as on every other field.
				mergeStylexClassName("data-[popup-open]:border-accent", sx.transitionBorderColorBoxShadow, sx.enabledHoverSmoothShadowXs, sx.hoverBorderLineStrong),
				className,
			)}
		>
			{iconSlot && (
				<span {...stylex.props(sx.colStart1, sx.rowStart1, sx.flex, sx.size4, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textDim)}>
					{icon}
				</span>
			)}
			<span {...mergeStylexProps(cn(label), sx.rowStart1, sx.truncate)}>
				{children ?? <BaseSelect.Value placeholder={placeholder} />}
			</span>
			{sizeTo?.map((text, index) => (
				<span
					key={index}
					aria-hidden {...mergeStylexProps(cn(label), sx.invisible, sx.rowStart1, sx.truncate)}
				>
					{text}
				</span>
			))}
			<IconChevronDown
				size={16}
				className={mergeStylexOverrideClassName("", sx.rowStart1, sx.shrink0, sx.textFaint, iconSlot && sx.colStart3, !(iconSlot) && sx.colStart2)}
			/>
		</BaseSelect.Trigger>
	);
}

function Popup({
	className,
	side,
	align = "start",
	sideOffset = 6,
	children,
}: {
	className?: string;
	side?: React.ComponentProps<typeof BaseSelect.Positioner>["side"];
	align?: React.ComponentProps<typeof BaseSelect.Positioner>["align"];
	sideOffset?: number;
	children: React.ReactNode;
}) {
	const restoreFocusRef = React.useContext(SelectFocusContext);
	return (
		<BaseSelect.Portal>
			<BaseSelect.Positioner
				side={side}
				align={align}
				sideOffset={sideOffset}
				collisionPadding={8}
				// Base UI's default overlays the popup on its trigger so the
				// selected row lands under the cursor. That mode skips the
				// positioning transition and turns itself off on touch, which
				// would give this one popup two open behaviours and no
				// animation. Anchor it below the trigger like every menu.
				alignItemWithTrigger={false} {...mergeStylexProps(cn(FLOATING_OVERLAY_LAYER), sx.outlineNone)}
			>
				<BaseSelect.Popup
					finalFocus={() => restoreFocusRef?.current ?? true} {...mergeStylexProps(cn(POPUP_HOOK, popupSurfaceClasses, className), sx.minWVarAnchorWidth)}
				>
					<BaseSelect.List className={popupScrollClasses}>{children}</BaseSelect.List>
				</BaseSelect.Popup>
			</BaseSelect.Positioner>
		</BaseSelect.Portal>
	);
}

type ItemProps = Omit<React.ComponentProps<typeof BaseSelect.Item>, "className"> & {
	className?: string;
	/** A glyph before the label. Pass it (even as `null`) on every row of a
	 * list where only some rows have one, so the labels stay aligned. */
	icon?: React.ReactNode;
};

function Item(itemProps: ItemProps) {
	const { className, icon, children, ...props } = itemProps;
	const iconSlot = "icon" in itemProps;
	return (
		<BaseSelect.Item
			{...props} {...mergeStylexProps(cn(popupItemClasses, "data-[disabled]:cursor-default data-[disabled]:opacity-40", className), sx.justifyBetween, sx.gap3)}
		>
			<span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
				{iconSlot && (
					<span {...stylex.props(sx.flex, sx.size4, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textDim)}>
						{icon}
					</span>
				)}
				<BaseSelect.ItemText className={mergeStylexOverrideClassName("", sx.minW0, sx.truncate)}>{children}</BaseSelect.ItemText>
			</span>
			{/* The tick's column is reserved on every row, the way `ui/menu`'s
			    `Check` reserves it: an indicator that only takes space while
			    selected makes the picked row wider than the rest, so the popup
			    is a different width depending on what is selected. */}
			<span {...stylex.props(sx.flex, sx.size17px, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.textAccent)}>
				<BaseSelect.ItemIndicator>
					<IconCheck size={17} />
				</BaseSelect.ItemIndicator>
			</span>
		</BaseSelect.Item>
	);
}

function GroupLabel({
	className,
	...props
}: Omit<React.ComponentProps<typeof BaseSelect.GroupLabel>, "className"> & {
	className?: string;
}) {
	return (
		<BaseSelect.GroupLabel
			{...props} {...mergeStylexProps(cn(className), sx.px2, sx.pb1, sx.pt15, typography.meta, sx.fontSemibold, sx.tracking001em, sx.textFaint)}
		/>
	);
}

function Separator({ className }: { className?: string }) {
	return <BaseSelect.Separator {...mergeStylexProps(cn(className), sx.Mx15, sx.my15, sx.hPx, sx.bgLine)} />;
}

export const Select = {
	Root,
	Trigger,
	Value: BaseSelect.Value,
	Popup,
	Item,
	Group: BaseSelect.Group,
	GroupLabel,
	Separator,
};

/**
 * The flat case, which is most of them: a list of `{ value, label }` and the
 * one that is picked. Settings rows and form fields both reach for this;
 * assemble the parts above only when the list needs groups or custom rows.
 */
export function OptionSelect<T extends string>({
	value,
	options,
	onChange,
	label,
	disabled,
	className,
	size,
	triggerRef,
}: {
	value: T;
	/** `icon` is optional per option, but the slot is all-or-nothing: as soon
	 *  as one row carries a glyph, every row and the trigger reserve the
	 *  column, so the labels stay on one x. */
	options: { value: T; label: string; disabled?: boolean; icon?: React.ReactNode }[];
	onChange: (value: T) => void;
	label: string;
	disabled?: boolean;
	className?: string;
	/** The control step, as on `Button` and the fields. Defaults to `md`. */
	size?: Size;
	/** The trigger element, for a dialog that opens with the caret in this
	 *  field (`Modal.Content`'s `initialFocus`). */
	triggerRef?: React.ComponentProps<typeof Trigger>["ref"];
}) {
	const hasIcons = options.some((option) => option.icon != null);
	const selected = options.find((option) => option.value === value);
	return (
		<Select.Root
			// The labels the trigger draws its value from, so a closed select
			// reads "Ask first" rather than "ask".
			items={options}
			value={value}
			disabled={disabled}
			onValueChange={(next) => onChange(next as T)}
		>
			<Select.Trigger
				ref={triggerRef}
				aria-label={label}
				className={className}
				size={size}
				{...(hasIcons ? { icon: selected?.icon ?? null } : {})}
				sizeTo={options.map((option) => option.label)}
			/>
			<Select.Popup align="end">
				{options.map((option) => (
					<Select.Item
						key={option.value}
						value={option.value}
						disabled={option.disabled}
						{...(hasIcons ? { icon: option.icon ?? null } : {})}
					>
						{option.label}
					</Select.Item>
				))}
			</Select.Popup>
		</Select.Root>
	);
}
