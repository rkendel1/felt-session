import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "./cn";
import { IconX } from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	m0: {
			margin: "0"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	textBalance: {
			textWrap: "balance"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	leadingTight: {
			lineHeight: "var(--leading-tight)"
	},
	tracking001em: {
			letterSpacing: "-.01em"
	},
	textFg: {
			color: "var(--text)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	relative: {
			position: "relative"
	},
	Mr15: {
			marginRight: "-6px"
	},
	Mt1: {
			marginTop: "-4px"
	},
	flex: {
			display: "flex"
	},
	size8: {
			width: "32px",
			height: "32px"
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
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	p0: {
			padding: "0"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	Mt05: {
			marginTop: "-2px"
	},
	textPretty: {
			textWrap: "pretty"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	fixed: {
			position: "fixed"
	},
	inset0: {
			inset: "0"
	},
	transitionOpacity: {
			transitionProperty: "opacity",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	easeOut: {
			transitionTimingFunction: "var(--ease)"
	},
	z6000: {
			zIndex: "6000"
	},
	bgBlack22: {
			backgroundColor: "color-mix(in srgb, var(--color-black) 22%, transparent)"
	},
	durationVarDurMicro: {
			transitionDuration: "var(--dur-micro)"
	},
	z10000: {
			zIndex: "10000"
	},
	bgBlack25: {
			backgroundColor: "color-mix(in srgb, var(--color-black) 25%, transparent)"
	},
	durationVarDur: {
			transitionDuration: "var(--dur)"
	},
	z6001: {
			zIndex: "6001"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	px4: {
			paddingInline: "16px"
	},
	pb4: {
			paddingBottom: "16px"
	},
	pt11vh: {
			paddingTop: "11vh"
	},
	sticky: {
			position: "sticky"
	},
	Top6: {
			top: "-24px"
	},
	z10: {
			zIndex: "10"
	},
	gap3: {
			gap: "12px"
	},
	bgRaised: {
			backgroundColor: "var(--bg-raised)"
	},
	Mx6: {
			marginInline: "-24px"
	},
	Mb3: {
			marginBottom: "-12px"
	},
	Mt6: {
			marginTop: "-24px"
	},
	px6: {
			paddingInline: "24px"
	},
	pb3: {
			paddingBottom: "12px"
	},
	pt6: {
			paddingTop: "24px"
	},
	transitionBoxShadow: {
			transitionProperty: "box-shadow",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	mt2: {
			marginTop: "8px"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	gap25: {
			gap: "10px"
	},

	flexCol: {
		"flexDirection": "column"
	},
	overflowHidden: {
		"overflow": "hidden"
	},
	outlineNone: {
		"--tw-outline-style": "none",
		"outlineStyle": "none"
	},
	roundedCalc22pxVarRf: {
		"borderRadius": "calc(22px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgPaletteGlass: {
		"backgroundColor": "var(--palette-glass)"
	},
	BackdropFilterVarPopupBlur: {
		"WebkitBackdropFilter": "var(--popup-blur)",
		"backdropFilter": "var(--popup-blur)"
	},
	SmoothRingColorVarDialogRing: {
		"--smooth-ring-color": "var(--dialog-ring)"
	},
	originTop: {
		"transformOrigin": "top"
	},
	easeVarEase: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	left12: {
		"left": "50%"
	},
	top12: {
		"top": "50%"
	},
	z10001: {
		"zIndex": "10001"
	},
	w90vw: {
		"width": "90vw"
	},
	TranslateX12: {
		"--tw-translate-x": "calc(calc(1 / 2 * 100%) * -1)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	TranslateY12: {
		"--tw-translate-y": "calc(calc(1 / 2 * 100%) * -1)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	maxW28rem: {
		"maxWidth": "28rem"
	},
	maxH85dvh: {
		"maxHeight": "85dvh"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	overscrollContain: {
		"overscrollBehavior": "contain"
	},
	p6: {
		"padding": "24px"
	},
	gap4: {
		"gap": "16px"
	},
	originCenter: {
		"transformOrigin": "50%"
	},
	backdropBlur6px: {
		"--tw-backdrop-blur": "blur(6px)",
		"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
		"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
	},
	backdropBlur1px: {
		"--tw-backdrop-blur": "blur(1px)",
		"WebkitBackdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)",
		"backdropFilter": "var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,)"
	},
	max560pxPt7vh: {
		"@media not all and (min-width: 560px)": {
			"paddingTop": "7vh"
		}
	},
	shadowInset01px0VarDivider: {
		"--tw-shadow": "inset 0 -1px 0 var(--tw-shadow-color,var(--divider))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},

	transitionTransformOpacity: {
		"transitionProperty": "transform,opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	wMin820px100: {
		"width": "min(820px,100%)"
	},

	afterAbsolute: {
		"::after": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	afterInset1: {
		"::after": {
			"content": "var(--tw-content)",
			"inset": "-4px"
		}
	},
	afterContent: {
		"::after": {
			"--tw-content": "\"\"",
			"content": "var(--tw-content)"
		}
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
});

/**
 * Centered modal dialog on Base UI parts, styled with Tailwind tokens. The
 * shared standard for confirm/edit dialogs: a soft squircle shell, a
 * title/description header with a top-right close, a body, and a
 * right-aligned footer of actions.
 *
 * Like ui/menu.tsx (and unlike ui/tooltip.tsx) this animates with CSS
 * transitions on Base UI's [data-starting-style]/[data-ending-style] lifecycle
 * attributes — never a Motion render prop, which drops the injected role/data-*
 * a focus-managed dialog needs. Enter AND exit both animate; keyboard nav +
 * focus trapping stay intact.
 *
 * Composable: assemble <Modal.Root>/<Modal.Content> yourself, or reach for the
 * <Modal.Header>/<Modal.Footer> helpers for the common shape.
 *
 *   <Modal.Root open={open} onOpenChange={setOpen}>
 *     <Modal.Content>
 *       <Modal.Header title="Session goal"
 *         description="Rides along with every prompt." />
 *       <textarea … />
 *       <Modal.Footer>
 *         <Modal.Close render={<button className="…">Cancel</button>} />
 *         <button className="…">Set goal</button>
 *       </Modal.Footer>
 *     </Modal.Content>
 *   </Modal.Root>
 *
 * The command palettes use `variant="palette"`: the same mechanics in a
 * top-anchored, wider, full-bleed shell whose own rows
 * carry the padding and dividers. Pair it with `useEnterOnMount()` when the
 * parent mounts the dialog conditionally.
 */

/** Geometry of the dialog shell.
 *  - `centered` — the standard confirm/edit dialog: vertically centered, ~28rem,
 *    padded body, `gap-4` between header/body/footer.
 *  - `palette` — the command-palette shape: anchored near the top of the
 *    viewport (via Base UI's Viewport), wider, and full-bleed. No padding and no
 *    gap, because a palette's rows (search field, scrolling results, hint
 *    footer) run edge to edge and own their own spacing and dividers. */
export type ModalVariant = "centered" | "palette";

export type ModalContentProps = Omit<
	React.ComponentPropsWithoutRef<"div">,
	"children"
> & {
	children: React.ReactNode;
	/** Width (a Tailwind width utility). Defaults to ~28rem for `centered` and
	 *  min(820px, 100%) for `palette` — override with e.g. "max-w-[34rem]". */
	widthClassName?: string;
	/** Element to focus when the dialog opens (Base UI otherwise focuses the
	 *  first tabbable). Pass the ref of the field you want the caret in. */
	initialFocus?: React.RefObject<HTMLElement | null>;
	/** Element to focus when the dialog closes. Pass `false` when closing the
	 *  dialog also replaces the surface that opened it. */
	finalFocus?: React.ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
	/** Palette only: adjust the viewport that positions the popup. Useful for a
	 *  phone sheet that rests on the bottom edge instead of below the top bar. */
	viewportClassName?: string;
	/** Keep the dialog subtree mounted while closed. Use for live surfaces whose
	 *  sockets and local state must survive dismissal. */
	keepMounted?: boolean;
	variant?: ModalVariant;
};

/** Portal + backdrop + popup. Children are the dialog body; pair with
 *  Modal.Header / Modal.Footer for the standard shape. Remaining props land on
 *  the popup, so a title-less dialog can name itself with `aria-label` and a
 *  palette can own its own `onKeyDown`.
 *  (Backdrop-dismiss is on by default; pass `disablePointerDismissal` to
 *  Modal.Root for confirmations that demand an explicit choice.) */
function Content({
	className,
	children,
	widthClassName,
	initialFocus,
	viewportClassName,
	keepMounted = false,
	variant = "centered",
	...popupProps
}: ModalContentProps) {
	const palette = variant === "palette";
	const popup = (
		<BaseDialog.Popup
			// Centered via a single composed transform so the enter/exit
			// scale (Tailwind writes translate + scale into one transform) keeps
			// the dialog pinned to the middle while it pops. The palette variant
			// is laid out by the Viewport instead, so it only owns its own size.
			className={cn(
				// Base UI's keepMounted popup receives `hidden` when closed. This
				// explicit rule outranks display utilities such as `flex`.
				"[&[hidden]]:hidden",
				palette
					? [
							// `relative` anchors overlays a palette draws inside itself
							// (the dictation HUD); `overflow-hidden` keeps the rows'
							// dividers inside the rounded shell.
							mergeStylexClassName("", sx.relative, sx.flex, sx.flexCol, sx.overflowHidden, sx.outlineNone),
							// A 22px base rather than the scale's `rounded-xl`: an
							// overlay this size carries a rounder corner than the
							// controls inside it. Same corner as the centered dialog,
							// one step up from the 18px it used to carry.
							mergeStylexClassName("", sx.roundedCalc22pxVarRf),
							// The same glass the menus and hover cards are made of
							// (ui/menu.tsx), so the palette reads as one more floating
							// surface rather than an opaque card — just denser, because
							// this one sits over a dimming backdrop. --palette-glass
							// falls back to the opaque fill without backdrop-filter and
							// under prefers-reduced-transparency (base.css).
							mergeStylexClassName("", sx.bgPaletteGlass, sx.BackdropFilterVarPopupBlur),
							// --dialog-ring, not --popup-ring: a shell on a scrim needs a
							// firmer hairline than a menu over the page (base.css). In
							// light the two resolve to the same line.
							mergeStylexClassName("smooth-shadow-ring-lg", sx.SmoothRingColorVarDialogRing),
							// Drops in from just above its resting place, the way a
							// palette summoned by a keystroke should.
							mergeStylexClassName("", sx.transitionTransformOpacity, sx.originTop, sx.durationVarDurMicro, sx.easeVarEase),
							"data-[starting-style]:-translate-y-1.5 data-[starting-style]:scale-[0.99] data-[starting-style]:opacity-0",
							"data-[ending-style]:-translate-y-1.5 data-[ending-style]:scale-[0.99] data-[ending-style]:opacity-0",
							widthClassName ?? mergeStylexClassName("", sx.wMin820px100),
						]
					: [
							mergeStylexClassName("", sx.fixed, sx.left12, sx.top12, sx.z10001, sx.w90vw, sx.TranslateX12, sx.TranslateY12),
							widthClassName ?? mergeStylexClassName("", sx.maxW28rem),
							mergeStylexClassName("", sx.maxH85dvh, sx.overflowYAuto, sx.overscrollContain, sx.outlineNone),
							// A restrained dialog shell: lifted surface, soft edge,
							// and enough radius to read as a modal without becoming a card.
							// The edge is --dialog-ring rather than the shared hairline: on
							// a scrim the fill's step above the page all but disappears, so
							// the line is what holds the shape (base.css).
							mergeStylexClassName("", sx.roundedCalc22pxVarRf, sx.bgRaised),
							mergeStylexClassName("smooth-shadow-ring-lg", sx.SmoothRingColorVarDialogRing),
							mergeStylexClassName("", sx.p6),
							mergeStylexClassName("", sx.flex, sx.flexCol, sx.gap4),
							mergeStylexClassName("", sx.transitionTransformOpacity, sx.originCenter, sx.durationVarDur, sx.easeVarEase),
							"data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0",
							"data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
						],
				className,
			)}
			initialFocus={initialFocus}
			{...popupProps}
		>
			{children}
		</BaseDialog.Popup>
	);
	return (
		<BaseDialog.Portal keepMounted={keepMounted}>
			<BaseDialog.Backdrop {...mergeStylexProps(cn("data-[starting-style]:opacity-0 data-[ending-style]:opacity-0", palette ? mergeStylexClassName("", sx.backdropBlur6px) : mergeStylexClassName("", sx.backdropBlur1px), palette && "palette-backdrop"), sx.fixed, sx.inset0, sx.transitionOpacity, sx.easeOut, palette && sx.z6000, palette && sx.bgBlack22, palette && sx.durationVarDurMicro, !(palette) && sx.z10000, !(palette) && sx.bgBlack25, !(palette) && sx.durationVarDur)}
			/>
			{palette ? (
				<BaseDialog.Viewport {...mergeStylexProps(cn(mergeStylexClassName("[&[hidden]]:hidden", sx.max560pxPt7vh), viewportClassName), sx.fixed, sx.inset0, sx.z6001, sx.flex, sx.itemsStart, sx.justifyCenter, sx.px4, sx.pb4, sx.pt11vh)}
				>
					{popup}
				</BaseDialog.Viewport>
			) : (
				popup
			)}
		</BaseDialog.Portal>
	);
}

/** `open` state for a dialog whose PARENT mounts it only while it should be
 *  open (`{searchOpen && <SessionSearch/>}`). Base UI skips
 *  [data-starting-style] for a popup that mounts already-open, so the enter
 *  animation needs one frame at `open={false}` first.
 *
 *  Exit animation still can't run under conditional mounting — the parent
 *  unmounts the tree the moment it closes — but the popup carries the
 *  [data-ending-style] classes anyway, so it animates out for free if the
 *  parent ever keeps it mounted. */
export function useEnterOnMount(): boolean {
	const [open, setOpen] = React.useState(false);
	React.useEffect(() => setOpen(true), []);
	return open;
}

/** True once the dialog's own scroll container has moved off the top, so a
 *  sticky header can take the hairline that separates a bar from its content.
 *  Takes the header NODE rather than a ref: Base UI mounts a popup's children
 *  in a later commit than the one that opens it, so a ref-based effect has
 *  already run and bailed on null by the time the DOM exists. */
function useScrolledUnder(node: HTMLElement | null): boolean {
	const [scrolled, setScrolled] = React.useState(false);
	React.useEffect(() => {
		// The popup itself is the scroller (`overflow-y-auto` on Modal.Content),
		// and the header is its first child.
		const scroller = node?.parentElement;
		if (!scroller) return;
		const read = () => setScrolled(scroller.scrollTop > 1);
		read();
		scroller.addEventListener("scroll", read, { passive: true });
		return () => scroller.removeEventListener("scroll", read);
	}, [node]);
	return scrolled;
}

/**
 * Title with a close (✕) beside it, and the description on its own full-width
 * line underneath: the standard dialog header.
 *
 * The TITLE ROW is a top bar, not a heading that scrolls away. A tall dialog
 * scrolls inside its own shell, so that row sticks to the top of it and bleeds
 * out to the shell's edges to carry the fill that hides what passes under it.
 * The negative margins cancel the shell's `p-6`, so nothing moves at rest and
 * a dialog short enough not to scroll looks exactly as it did. The hairline
 * only appears once there is something underneath.
 *
 * The description is NOT in the bar. It scrolls away with the content it
 * describes: it is read once, on arrival, and a bar is for what you still need
 * on the twentieth field, which is the title you are in and the way out.
 *
 * Two things it deliberately does NOT do. It carries no tinted icon badge: the
 * glyph repeated what the title already said, and the 54px it indented the
 * column with is what wrapped a one-sentence description onto three lines in a
 * 28rem dialog. And the ✕ shares a row with the title only, not with the
 * description, so a long title is the only thing it can ever shorten.
 *
 * The description is `text-supporting` at normal weight — the same treatment
 * `SettingsHeader` gives its own, so a dialog and a settings page open on one
 * rhythm. At the medium weight it used to carry it read at the same strength
 * as the field labels below it, and the header and the form mushed together.
 */
function Header({
	title,
	description,
	className,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	className?: string;
}) {
	const [node, setNode] = React.useState<HTMLDivElement | null>(null);
	const scrolled = useScrolledUnder(node);
	return (
		// Two children of the shell rather than a wrapper around both: a sticky
		// box only sticks while its PARENT is in view, so a bar nested in a
		// header wrapper leaves with it after ~60px of scrolling (measured). The
		// scroll container has to be the parent, which means the shell's `gap-4`
		// now falls between the bar and the description, and the description
		// pulls 10px of it back to keep its own 6px.
		<>
			<div
				ref={setNode} {...mergeStylexProps(cn(scrolled && mergeStylexClassName("", sx.shadowInset01px0VarDivider), className), sx.sticky, sx.Top6, sx.z10, sx.flex, sx.itemsStart, sx.gap3, sx.bgRaised, sx.Mx6, sx.Mb3, sx.Mt6, sx.px6, sx.pb3, sx.pt6, sx.transitionBoxShadow, sx.durationVarDurMicro)}
			>
				{/* Base UI renders Title as <h2> and Description as <p>; preflight
				    isn't imported (base.css owns resets), so zero their UA margins
				    or the <h2> top margin reads as phantom padding above the head. */}
				<BaseDialog.Title className={mergeStylexOverrideClassName("", sx.m0, sx.minW0, sx.flex1, sx.textBalance, sx.fontSemibold, sx.leadingTight, sx.tracking001em, sx.textFg, typography.dialogTitle)}>
					{title}
				</BaseDialog.Title>
				<BaseDialog.Close
					aria-label="Close" {...mergeStylexProps("", sx.afterAbsolute, sx.afterInset1, sx.afterContent, sx.hoverBgHover, sx.hoverTextFg, sx.focusRing, sx.relative, sx.Mr15, sx.Mt1, sx.flex, sx.size8, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.p0, sx.textFaint, sx.transitionColors)}
				>
					<IconX size={20} />
				</BaseDialog.Close>
			</div>
			{/* `font-normal` is load-bearing, not decoration: base.css runs the app
			    at weight 500, so a description that merely drops `font-medium`
			    still renders at the field labels' exact size, weight and colour.
			    The header's -mb-3 already reclaims 12px of the shell's gap. Pulling
			    this line back only 2px leaves it 2px below the sticky bar's painted
			    edge; the old -mt-2.5 moved its first 6px behind that opaque bar and
			    clipped the tops of every standard modal description. */}
			{description && (
				<BaseDialog.Description className={mergeStylexOverrideClassName("", sx.m0, sx.Mt05, sx.textPretty, sx.fontNormal, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
					{description}
				</BaseDialog.Description>
			)}
		</>
	);
}

/** Right-aligned action row (Cancel / confirm). The extra `mt-2` on top of the
 *  shell's `gap-4` is what separates the actions from the body — 24px reads as
 *  its own zone, and the settings surfaces this borrows from deliberately have
 *  no dividers. A leading element (a destructive "Clear") sits left of the
 *  actions with `mr-auto`; the older `<div {...stylex.props(sx.flex1)} />` spacer keeps
 *  working under `justify-end`. */
function Footer({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div {...mergeStylexProps(cn(className), sx.mt2, sx.flex, sx.flexWrap, sx.itemsCenter, sx.justifyEnd, sx.gap25)}
		>
			{children}
		</div>
	);
}

export const Modal = {
	Root: BaseDialog.Root,
	Trigger: BaseDialog.Trigger,
	Close: BaseDialog.Close,
	Title: BaseDialog.Title,
	Description: BaseDialog.Description,
	Viewport: BaseDialog.Viewport,
	Content,
	Header,
	Footer,
};
