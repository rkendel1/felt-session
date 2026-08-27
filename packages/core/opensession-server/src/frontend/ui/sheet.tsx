import * as React from "react";
import { createPortal } from "react-dom";
import { cn, mergeStylexProps, mergeStylexClassName } from "./cn";
import { PhoneTopBarAction } from "./top-bar";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	shrink0: {
			flexShrink: "0"
	},
	touchNone: {
			touchAction: "none"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	pb15: {
			paddingBottom: "6px"
	},
	pt25: {
			paddingTop: "10px"
	},
	h5px: {
			height: "5px"
	},
	w9: {
			width: "36px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgActive: {
			backgroundColor: "var(--bg-active)"
	},
	fixed: {
			position: "fixed"
	},
	inset0: {
			inset: "0"
	},
	z10000: {
			zIndex: "10000"
	},
	invisible: {
			visibility: "hidden"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	absolute: {
			position: "absolute"
	},
	bgBlack45: {
			backgroundColor: "color-mix(in srgb, var(--color-black) 45%, transparent)"
	},
	flexCol: {
			flexDirection: "column"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	CornerShapeSquircle: {
			cornerShape: "squircle"
	},
	minH0: {
			minHeight: "0"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	overscrollContain: {
			overscrollBehavior: "contain"
	},
	px25: {
			paddingInline: "10px"
	},
	pb35: {
			paddingBottom: "14px"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	px3: {
			paddingInline: "12px"
	},
	pb2: {
			paddingBottom: "8px"
	},
	pt15: {
			paddingTop: "6px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	mx25: {
			marginInline: "10px"
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
	wFull: {
			width: "100%"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap13px: {
			gap: "13px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px35: {
			paddingInline: "14px"
	},
	py15px: {
			paddingBlock: "15px"
	},
	textLeft: {
			textAlign: "left"
	},

	transitionOpacity: {
		"transitionProperty": "opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	durationVarDurLg: {
		"--tw-duration": "var(--dur-lg)",
		"transitionDuration": "var(--dur-lg)"
	},
	durationVarDur: {
		"--tw-duration": "var(--dur)",
		"transitionDuration": "var(--dur)"
	},
	opacity100: {
		"opacity": "1"
	},
	opacity0: {
		"opacity": "0"
	},
	hDvh: {
		"height": "100dvh"
	},
	maxHNone: {
		"maxHeight": "none"
	},
	roundedNone: {
		"borderRadius": "0"
	,
		cornerShape: "var(--cs)"},
	bgSurface: {
		"backgroundColor": "var(--bg)"
	},
	pbEnvSafeAreaInsetBottom: {
		"paddingBottom": "env(safe-area-inset-bottom)"
	},
	ptEnvSafeAreaInsetTop: {
		"paddingTop": "env(safe-area-inset-top)"
	},
	shadowNone: {
		"--tw-shadow": "0 0 transparent",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	insetX0: {
		"insetInline": "0"
	},
	bottom0: {
		"bottom": "0"
	},
	maxH94dvh: {
		"maxHeight": "94dvh"
	},
	left12: {
		"left": "50%"
	},
	top12: {
		"top": "50%"
	},
	maxH85vh: {
		"maxHeight": "85vh"
	},
	w92vw: {
		"width": "92vw"
	},
	maxW30rem: {
		"maxWidth": "30rem"
	},
	TranslateX12: {
		"--tw-translate-x": "calc(calc(1 / 2 * 100%) * -1)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	TranslateY12: {
		"--tw-translate-y": "calc(calc(1 / 2 * 100%) * -1)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	roundedCalc18pxVarRf: {
		"borderRadius": "calc(18px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgRaised: {
		"backgroundColor": "var(--bg-raised)"
	},
	transitionTransform: {
		"transitionProperty": "transform,translate,scale,rotate",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	easeVarEase: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	translateY0: {
		"--tw-translate-y": "0",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	translateYFull: {
		"--tw-translate-y": "100%",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	originCenter: {
		"transformOrigin": "50%"
	},
	scale100: {
		"--tw-scale-x": "100%",
		"--tw-scale-y": "100%",
		"--tw-scale-z": "100%",
		"scale": "var(--tw-scale-x) var(--tw-scale-y)"
	},
	scale096: {
		"scale": ".96"
	},
	activeBgPressed: {
		":active": {
			"backgroundColor": "var(--hover-strong)"
		}
	},

	roundedTCalcVarSheetRadius34pxVarRf: {
		"borderTopLeftRadius": "calc(var(--sheet-radius,34px) * var(--rf))",
		"borderTopRightRadius": "calc(var(--sheet-radius,34px) * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	shadow012px40pxRgba000035: {
		"--tw-shadow": "0 -12px 40px var(--tw-shadow-color,color-mix(in srgb, var(--color-black) 35%, transparent))",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	transitionTransformOpacity: {
		"transitionProperty": "transform,opacity",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},

	textFg: {
		"color": "var(--text)"
	},
	textRed: {
		"color": "var(--red)"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	textAccent: {
		"color": "var(--accent-ink)"
	},
	textGreen: {
		"color": "var(--green)"
	},
	textPurple: {
		"color": "var(--purple)"
	},
});

/**
 * The app's sheet/dialog language for surfaces that own their own open state —
 * summoned by a route or a keyboard shortcut rather than hung off a trigger
 * element (Settings, the account menu, the Desk).
 *
 * `ResponsiveDialog` is the primitive: one piece of content rendered as a
 * centered modal on desktop and an iOS-style bottom sheet on phone, with the
 * same dismissal, animation and focus behaviour on both. `BottomSheet` is the
 * phone-only shorthand over it.
 *
 * Deliberately not a Base UI wrapper (unlike ui/modal.tsx): these popups have
 * no trigger to anchor to, and one of them — the Desk — has to stay mounted
 * while closed so its socket keeps streaming, which Base UI's `keepMounted`
 * only does via `display: none` (that would zero the transcript's scrollHeight
 * and lose the reader's place). See `keepMounted`.
 *
 * Dismissal (backdrop tap, Esc, dragging the grabber down, or a child calling
 * the render-prop `dismiss`) always plays the exit animation before the owner
 * is told to close, so owners never manage animation themselves.
 */

/** Kept in sync with the panel transition durations below. */
const SHEET_MS = 300;
const MODAL_MS = 150;

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Phase = "closed" | "entering" | "open" | "exiting";

/**
 * Enter/exit as a four-state machine, so one render path serves both the
 * unmount-when-closed sheets and the Desk's stay-mounted overlay: `entering`
 * paints the start state for a frame so the transition has somewhere to come
 * from, `exiting` holds the panel around long enough to animate away.
 */
function usePhase(open: boolean, animated: boolean, durationMs: number): Phase {
	const [phase, setPhase] = React.useState<Phase>("closed");

	React.useEffect(() => {
		if (!animated) {
			setPhase(open ? "open" : "closed");
			return;
		}
		setPhase((p) =>
			open
				? p === "open"
					? p
					: "entering"
				: p === "closed"
					? p
					: "exiting",
		);
	}, [open, animated]);

	React.useEffect(() => {
		if (phase === "entering") {
			const raf = requestAnimationFrame(() => setPhase("open"));
			return () => cancelAnimationFrame(raf);
		}
		if (phase === "exiting") {
			const t = window.setTimeout(() => setPhase("closed"), durationMs);
			return () => window.clearTimeout(t);
		}
	}, [phase, durationMs]);

	return phase;
}

export function ResponsiveDialog({
	open,
	onClose,
	phone,
	label,
	keepMounted = false,
	desktopTransition = "pop",
	sheetClassName,
	modalClassName,
	backdropClassName,
	showPhoneGrabber = true,
	phonePresentation = "sheet",
	children,
}: {
	open: boolean;
	/** Close was requested (backdrop, Esc, drag, `dismiss`) — flip `open`. */
	onClose: () => void;
	/** Phone viewport: render the bottom sheet instead of the centered modal. */
	phone: boolean;
	/** Accessible dialog label. */
	label: string;
	/**
	 * Keep the panel mounted (hidden) once it has been opened, instead of
	 * unmounting on close. For overlays whose children hold live state —
	 * sockets, scroll position — that must survive a dismiss.
	 */
	keepMounted?: boolean;
	/** `"none"` for overlays that toggle like a HUD rather than open like a dialog. */
	desktopTransition?: "pop" | "none";
	/** Extra classes for the phone sheet panel (e.g. a fixed height). */
	sheetClassName?: string;
	/** Extra classes for the desktop modal panel (e.g. a fixed size). */
	modalClassName?: string;
	/** Override the shared backdrop when a surface needs stronger separation. */
	backdropClassName?: string;
	/** Full-screen phone lightboxes close explicitly and have no sheet grabber. */
	showPhoneGrabber?: boolean;
	/** A page covers the viewport without sheet chrome, a backdrop, or drag dismissal. */
	phonePresentation?: "sheet" | "page";
	children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
}) {
	const phonePage = phone && phonePresentation === "page";
	// Phone surfaces always animate. Desktop HUD-style overlays can opt out.
	const animated = phone || desktopTransition !== "none";
	const phase = usePhase(open, animated, phone ? SHEET_MS : MODAL_MS);
	const panelRef = React.useRef<HTMLDivElement>(null);

	const [booted, setBooted] = React.useState(open);
	React.useEffect(() => {
		if (open) setBooted(true);
	}, [open]);

	const mounted = keepMounted ? booted : phase !== "closed";
	const shown = phase === "open";

	// Esc dismisses. Capture phase so it wins over page-level Esc handlers
	// (the app's palette/back handlers) while the dialog is up.
	React.useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// This capture listener runs before a portalled Base UI menu. Let the
				// menu consume the first Escape instead of closing the whole dialog.
				if (document.querySelector(".app-menu-popup")) return;
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	// Park focus inside the dialog on open — unless a child already claimed it
	// (the Desk drops the caret in its composer on desktop) — and hand it back
	// to whatever opened us on close.
	React.useEffect(() => {
		if (!open || !mounted) return;
		// A local in effect scope (not a ref) so teardown hands focus back to
		// exactly the element this open parked.
		let restoreTo = document.activeElement as HTMLElement | null;
		const raf = requestAnimationFrame(() => {
			const panel = panelRef.current;
			if (!panel || panel.contains(document.activeElement)) return;
			panel.focus();
		});
		// Setup-scope helper so teardown reads the latest panel node without
		// touching `.current` directly inside the cleanup body.
		const handBackFocus = () => {
			const prev = restoreTo;
			if (!prev || !document.body.contains(prev)) return;
			// Only take focus back if it was still ours — the user may have
			// clicked into the page behind us.
			const inside =
				panelRef.current?.contains(document.activeElement) ?? false;
			if (inside || document.activeElement === document.body) prev.focus();
		};
		return () => {
			cancelAnimationFrame(raf);
			handBackFocus();
		};
	}, [open, mounted]);

	// Keep Tab from wandering behind the backdrop. Bubble phase and only when
	// nothing else claimed the key, so a composer's @-mention popup can still
	// accept its completion with Tab.
	React.useEffect(() => {
		if (!open || !mounted) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || e.defaultPrevented) return;
			const panel = panelRef.current;
			const activeEl = document.activeElement as HTMLElement | null;
			// Focus that has legitimately left the panel (a portalled menu
			// popup) manages its own tabbing.
			if (!panel || !activeEl || !panel.contains(activeEl)) return;
			const items = Array.from(
				panel.querySelectorAll<HTMLElement>(FOCUSABLE),
			).filter((el) => el.getClientRects().length > 0);
			if (!items.length) return;
			const [first] = items;
			const last = items[items.length - 1];
			if (activeEl !== (e.shiftKey ? first : last)) return;
			e.preventDefault();
			(e.shiftKey ? last : first).focus();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, mounted]);

	// Drag the grabber down to dismiss: the sheet follows the finger (transition
	// suspended), and a decent pull flicks it away on release.
	const drag = React.useRef<{ startY: number; dy: number } | null>(null);
	function onTouchStart(e: React.TouchEvent) {
		drag.current = { startY: e.touches[0].clientY, dy: 0 };
		if (panelRef.current) panelRef.current.style.transition = "none";
	}
	function onTouchMove(e: React.TouchEvent) {
		if (!drag.current) return;
		const dy = Math.max(0, e.touches[0].clientY - drag.current.startY);
		drag.current.dy = dy;
		if (panelRef.current)
			panelRef.current.style.transform = `translateY(${dy}px)`;
	}
	function onTouchEnd() {
		const dy = drag.current?.dy ?? 0;
		drag.current = null;
		const el = panelRef.current;
		if (el) {
			el.style.transition = "";
			el.style.transform = "";
		}
		if (dy > 80) onClose();
	}

	if (!mounted) return null;

	// Only reachable with keepMounted: parked out of sight and out of the tab
	// order, still mounted and still streaming.
	const parked = phase === "closed";

	return createPortal(
		<div
			{...stylex.props(sx.fixed, sx.inset0, sx.z10000, parked && sx.invisible, parked && sx.pointerEventsNone)}
			role="dialog"
			aria-modal={parked ? undefined : "true"}
			aria-label={label}
			aria-hidden={parked || undefined}
		>
			{!phonePage && (
				<div {...mergeStylexProps(cn(backdropClassName, animated && [
							mergeStylexClassName("", sx.transitionOpacity),
							phone
								? mergeStylexClassName("", sx.durationVarDurLg)
								: mergeStylexClassName("", sx.durationVarDur),
							shown ? mergeStylexClassName("", sx.opacity100) : mergeStylexClassName("", sx.opacity0),
						]), sx.absolute, sx.inset0, sx.bgBlack45)}
					onClick={onClose}
				/>
			)}
			<div
				ref={panelRef}
				tabIndex={-1} {...mergeStylexProps(cn(phone
						? phonePage
							? mergeStylexClassName("", sx.inset0, sx.hDvh, sx.maxHNone, sx.roundedNone, sx.bgSurface, sx.pbEnvSafeAreaInsetBottom, sx.ptEnvSafeAreaInsetTop, sx.shadowNone)
							: mergeStylexClassName("", sx.roundedTCalcVarSheetRadius34pxVarRf, sx.shadow012px40pxRgba000035, sx.insetX0, sx.bottom0, sx.maxH94dvh, sx.bgSurface, sx.pbEnvSafeAreaInsetBottom)
						: mergeStylexClassName("smooth-shadow-ring-lg", sx.left12, sx.top12, sx.maxH85vh, sx.w92vw, sx.maxW30rem, sx.TranslateX12, sx.TranslateY12, sx.roundedCalc18pxVarRf, sx.bgRaised), animated &&
						(phone
							? [
									mergeStylexClassName("", sx.transitionTransform, sx.durationVarDurLg, sx.easeVarEase),
									shown ? mergeStylexClassName("", sx.translateY0) : mergeStylexClassName("", sx.translateYFull),
								]
							: [
									mergeStylexClassName("", sx.transitionTransformOpacity, sx.originCenter, sx.durationVarDur, sx.easeVarEase),
									shown ? mergeStylexClassName("", sx.scale100, sx.opacity100) : mergeStylexClassName("", sx.scale096, sx.opacity0),
								]), phone ? sheetClassName : modalClassName), sx.absolute, sx.flex, sx.flexCol, sx.overflowHidden, sx.outlineNone, sx.CornerShapeSquircle)}
			>
				{phone && !phonePage && showPhoneGrabber && (
					<div
						{...stylex.props(sx.flex, sx.shrink0, sx.touchNone, sx.justifyCenter, sx.pb15, sx.pt25)}
						onTouchStart={onTouchStart}
						onTouchMove={onTouchMove}
						onTouchEnd={onTouchEnd}
					>
						<div {...stylex.props(sx.h5px, sx.w9, sx.roundedFull, sx.bgActive)} />
					</div>
				)}
				{typeof children === "function" ? children(onClose) : children}
			</div>
		</div>,
		document.body,
	);
}

/** Shared iOS-style chrome for icon actions in a phone sheet header. */
export function SheetIconButton({
	className,
	children,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<PhoneTopBarAction
			className={className}
			icon={children}
			{...props}
		/>
	);
}

/**
 * The scrolling, padded interior of a bottom sheet. `ResponsiveDialog` clips
 * its panel at 94dvh, so a sheet whose action list can grow has its own
 * scroller so every action stays reachable.
 */
export function SheetBody({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div {...mergeStylexProps(cn(className), sx.minH0, sx.overflowYAuto, sx.overscrollContain, sx.px25, sx.pb35)}
		>
			{children}
		</div>
	);
}

/** The sheet's own heading — the object the actions below it act on. */
export function SheetTitle({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div {...mergeStylexProps(cn(className), sx.truncate, sx.px3, sx.pb2, sx.pt15, typography.label, sx.textFaint)}>
			{children}
		</div>
	);
}

/** Hairline between two groups of sheet actions. */
export function SheetSeparator({ className }: { className?: string }) {
	return <div {...mergeStylexProps(cn(className), sx.mx25, sx.my15, sx.hPx, sx.bgLine)} />;
}

/**
 * A sheet action row. Thumb-sized and full-bleed, pressed rather than hovered
 * — a sheet only ever appears on touch.
 *
 * `tone` exists instead of a colour className because the row colours its icon
 * as well as its label: two `text-*` utilities aimed at the same subject don't
 * compose, so each variant has to name both of its colours in one place.
 */
const SHEET_ITEM_TONE = {
	/** Icons stay quiet against the label — the legacy sheet's look. */
	default: mergeStylexClassName("[&_svg]:text-faint", sx.textFg),
	danger: mergeStylexClassName("[&_svg]:text-red", sx.textRed),
	accent: mergeStylexClassName("[&_svg]:text-faint", sx.fontSemibold, sx.textAccent),
	green: mergeStylexClassName("[&_svg]:text-faint", sx.fontSemibold, sx.textGreen),
	purple: mergeStylexClassName("[&_svg]:text-faint", sx.fontSemibold, sx.textPurple),
} as const;

export type SheetItemTone = keyof typeof SHEET_ITEM_TONE;

export function SheetItem({
	tone = "default",
	className,
	children,
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: SheetItemTone }) {
	return (
		<button
			type="button" {...mergeStylexProps(cn(mergeStylexClassName("[&_svg]:shrink-0", sx.activeBgPressed), SHEET_ITEM_TONE[tone], className), sx.flex, sx.wFull, sx.itemsCenter, sx.gap13px, sx.roundedControl, sx.px35, sx.py15px, sx.textLeft, typography.body)}
			{...rest}
		>
			{children}
		</button>
	);
}

type PhoneSurfaceProps = {
	/** Called after the exit animation. Unmount the surface here. */
	onClose: () => void;
	/** Accessible dialog label. */
	label: string;
	/** Extra classes for the phone surface. */
	className?: string;
	children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
};

function DismissiblePhoneSurface({
	onClose,
	label,
	className,
	presentation,
	children,
}: PhoneSurfaceProps & { presentation: "sheet" | "page" }) {
	const [open, setOpen] = React.useState(true);
	const closingRef = React.useRef(false);

	const dismiss = () => {
		if (closingRef.current) return;
		closingRef.current = true;
		setOpen(false);
		setTimeout(onClose, SHEET_MS);
	};

	return (
		<ResponsiveDialog
			open={open}
			onClose={dismiss}
			phone
			label={label}
			phonePresentation={presentation}
			sheetClassName={className}
		>
			{children}
		</ResponsiveDialog>
	);
}

/** Phone-only bottom sheet with a self-closing contract. */
export function BottomSheet(props: PhoneSurfaceProps) {
	return <DismissiblePhoneSurface {...props} presentation="sheet" />;
}

/** Full-screen phone page that covers the current app surface. */
export function PhonePage(props: PhoneSurfaceProps) {
	return <DismissiblePhoneSurface {...props} presentation="page" />;
}
