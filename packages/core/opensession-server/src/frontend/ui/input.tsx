import * as React from "react";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	flex: {
			display: "flex"
	},
	minW0: {
			minWidth: "0"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap15: {
			gap: "6px"
	},
	grid: {
			display: "grid"
	},
	gridCols2: {
			gridTemplateColumns: "repeat(2,minmax(0,1fr))"
	},
	gap3: {
			gap: "12px"
	},

	resizeY: {
		"resize": "vertical"
	},
	py2: {
		"paddingBlock": "8px"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	phoneGridCols1: {
		"@media (max-width: 720px)": {
			"gridTemplateColumns": "repeat(1,minmax(0,1fr))"
		}
	},

	wFull: {
		"width": "100%"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	borderLine: {
		"borderColor": "var(--border)"
	},
	bgSurface: {
		"backgroundColor": "var(--bg)"
	},
	textFg: {
		"color": "var(--text)"
	},
	outlineNone: {
		"--tw-outline-style": "none",
		"outlineStyle": "none"
	},
	transitionColors: {
		"transitionProperty": "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	placeholderTextFaint: {
		"::placeholder": {
			"color": "var(--text-faint)"
		}
	},
	focusBorderAccent: {
		":focus": {
			"borderColor": "var(--accent)"
		}
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity40: {
		":disabled": {
			"opacity": ".4"
		}
	},
	minH26px: {
		"minHeight": "26px"
	},
	px2: {
		"paddingInline": "8px"
	},
	textXs: {
		"fontSize": "var(--type-label)",
		"lineHeight": "var(--tw-leading,var(--text-xs--line-height))"
	},
	minH8: {
		"minHeight": "32px"
	},
	px25: {
		"paddingInline": "10px"
	},
	textSm: {
		"fontSize": "var(--type-label)",
		"lineHeight": "var(--tw-leading,var(--text-sm--line-height))"
	},
	minH9: {
		"minHeight": "36px"
	},
	px3: {
		"paddingInline": "12px"
	},
	textBase: {
		"fontSize": "var(--type-body)",
		"lineHeight": "var(--tw-leading,var(--text-base--line-height))"
	},
});

/**
 * Field primitive — the shared optics for single-line inputs, multi-line
 * editors, and native selects.
 *
 * The app had no field primitive at all: 95 raw `<input>`s each carried their
 * own class list, and they had settled on `rounded-md` (7px) while every
 * button in the app is `rounded-control` (10px). A field and the button that
 * submits it therefore sat side by side with visibly different corners — the
 * single loudest reason a form here reads as assembled from parts rather than
 * designed.
 *
 * So the scale is deliberately Button's scale, step for step: same heights,
 * same horizontal padding, same one radius. A field and a button of the same
 * size are the same box; only the fill and the border differ, which is the
 * distinction that should carry (a well you type into vs. a plate you press).
 *
 * The fill is `bg-surface` — the page's own surface, so a field reads as a
 * well cut into the group it sits in rather than another raised card. Focus
 * moves the border to the accent instead of adding a ring: the accent is ink
 * now, so a full-strength border is legible in both themes and costs no
 * layout.
 */

type Size = "sm" | "md" | "lg";

/** Height/padding/type per step — mirrors `Button`'s `sizes`.
 * Inputs take the exact step height rather than only a minimum, so their
 * single line can be centered consistently across Chromium and WebKit. */
const sizes: Record<Size, string> = {
	sm: mergeStylexClassName("[&:where(input)]:h-[26px]", sx.minH26px, sx.px2, sx.textXs),
	md: mergeStylexClassName("[&:where(input)]:h-8", sx.minH8, sx.px25, sx.textSm),
	lg: mergeStylexClassName("[&:where(input)]:h-9", sx.minH9, sx.px3, sx.textBase),
};

/**
 * Everything a field shares regardless of element: corner, fill, border,
 * placeholder, focus, disabled. Exported for the few natively-styled controls
 * that cannot be one of the components below (a `<select>` needing its own
 * appearance reset, a contenteditable).
 */
export const fieldClass =
	// Block padding and a one-line box center input text vertically. The element
	// selector deliberately leaves multiline textareas and native selects alone.
	mergeStylexClassName("[&:where(input)]:py-0 [&:where(input)]:leading-none", sx.wFull, sx.roundedControl, sx.border, sx.borderLine, sx.bgSurface, sx.textFg, sx.outlineNone, sx.transitionColors, sx.placeholderTextFaint, sx.focusBorderAccent, sx.disabledCursorDefault, sx.disabledOpacity40);

export function fieldClasses(size: Size = "md", className?: string) {
	return cn(fieldClass, sizes[size], className);
}

// `ComponentProps` rather than `ComponentPropsWithoutRef`: under React 19 a ref
// is an ordinary prop, so this is all it takes for a caller to hold onto the
// element (focus it, measure it, autosize a textarea). Written without it, the
// four sites in the app that need a ref had to fall back to `fieldClasses()` on
// a raw element — the exact copy-the-classes pattern this primitive exists to
// end.
type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
	size?: Size;
};

export function Input({ className, size = "md", ...props }: InputProps) {
	return <input className={fieldClasses(size, className)} {...props} />;
}

type TextareaProps = React.ComponentProps<"textarea"> & {
	size?: Size;
};

/** Multi-line entry. Vertically resizable and padded like a paragraph rather
 *  than a single line, but the same well as `Input` in every other respect. */
export function Textarea({ className, size = "md", ...props }: TextareaProps) {
	return <textarea className={fieldClasses(size, cn(mergeStylexClassName("", sx.resizeY, sx.py2), className))} {...props} />;
}

type SelectProps = Omit<React.ComponentProps<"select">, "size"> & {
	size?: Size;
};

/** Native select in the field shape. `ui/select` is the default now: it wears
 *  the same field, and it opens the app's popup rather than the platform's
 *  dropdown. Reach for this one only when you specifically want the OS picker
 *  or a native select's own keyboard behaviour (see `PaletteSelect`,
 *  `SessionSearch`). */
export function Select({ className, size = "md", ...props }: SelectProps) {
	return <select className={fieldClasses(size, cn(mergeStylexClassName("", sx.cursorPointer), className))} {...props} />;
}

/**
 * A labelled field: the label sitting 6px above its control, wrapped in a
 * `<label>` so the text is part of the control's hit area and name.
 *
 * Four surfaces had each written this same recipe by hand (`SetupTeam`'s
 * `dialogFieldLabelClass`, `SpinOffMenu`'s `fieldLabelCls`, `ProjectsSection`'s
 * `labelCls`, settings' own `SettingsField`), which is how their labels drifted
 * apart. Field vocabulary rather than dialog vocabulary — a settings form and a
 * dialog form want the identical shape, so it lives here with the field itself.
 */
export function Field({
	label,
	className,
	children,
	...props
}: Omit<React.ComponentPropsWithoutRef<"label">, "children"> & {
	label: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<label {...mergeStylexProps(cn(className), sx.flex, sx.minW0, sx.flexCol, sx.gap15)} {...props}>
			<span {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>{label}</span>
			{children}
		</label>
	);
}

/** Two `Field`s side by side, stacking on a phone. Only for genuinely short
 *  values (an id, a login) — a column is ~half a dialog wide, so anything the
 *  length of an email address clips at every viewport. */
export function FieldGrid({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div {...mergeStylexProps(cn(mergeStylexClassName("", sx.phoneGridCols1), className), sx.grid, sx.gridCols2, sx.gap3)} {...props} />
	);
}
