import { useIsPhone } from "../../hooks/useIsPhone";
import { useShortcutKeys } from "../../hooks/useShortcutBindings";
import { hasDraft } from "../../lib/drafts";
import { markRead, markUnread } from "../../lib/reads";
import {
	SIDEBAR_HOVER_LAYER,
	SIDEBAR_RAIL,
	SIDEBAR_RAIL_GAP,
	SIDEBAR_RAIL_PAD,
	SIDEBAR_ROW_CHIP,
	SIDEBAR_STATUS_DOT,
	SIDEBAR_SWIPE_ACTION,
	SIDEBAR_SWIPE_ACTION_ARCHIVE,
	SIDEBAR_SWIPE_ACTION_OPEN,
	SIDEBAR_SWIPE_ACTION_STAR,
	SIDEBAR_SWIPE_ACTION_STAR_ON,
	SIDEBAR_SWIPE_ACTION_TRANSITION,
	SIDEBAR_SWIPE_ROW,
	SIDEBAR_WS_DRAFT,
} from "../../lib/sidebar-classes";
import { isClaimed, mineStatus, pinnedLane, runNeedsAttention, stripPrTitlePrefix } from "../../lib/sidebar-lanes";
import { sessionWasAgentStarted } from "../../lib/sidebar-placement";
import { LONG_PRESS_MS, LONG_PRESS_SLOP, SWIPE_AXIS_LOCK_PX, SWIPE_COMMIT_MS, SWIPE_OPEN_THRESHOLD, SWIPE_REVEAL_PX, clampSwipe, fullSwipeThreshold, swipeCommitOffset, type SwipeAction } from "../../lib/sidebar-swipe";
import type { LaneChoice } from "../../lib/sidebar-types";
import type { UnifiedSession } from "../../lib/types";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { BottomSheet, SheetBody, SheetItem, SheetSeparator, SheetTitle } from "../../ui/sheet";
import { Tooltip } from "../../ui/tooltip";
import { RowCardPopup, useRowHoverCard } from "../SidebarRowCards";
import { AutoCreatedMark } from "./AutoCreatedMark";
import {
	LanePickerPage,
	LaneStatusMark,
	SheetDrillInItem,
	lanePickerLabel,
} from "./MobileSheetPages";
import { OriginMark } from "./OriginMark";
import { IconArchive, IconInbox, IconMail, IconPencil, IconPin } from "../icons";
import { SessionCardBody, WsPrStatusMark } from "../sidebar/HoverCards";
import { SidebarCtxMenu } from "../sidebar/SidebarCtxMenu";
import { UserAvatar } from "../UserAvatar";
import React, { useEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	text7b86e8: {
			color: "#7b86e8"
	},
	srOnly: {
			clipPath: "inset(50%)",
			whiteSpace: "nowrap",
			borderWidth: "0",
			width: "1px",
			height: "1px",
			margin: "-1px",
			padding: "0",
			position: "absolute",
			overflow: "hidden"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderAccent: {
			borderColor: "var(--accent)"
	},
	bgBg: {
			backgroundColor: "var(--bg)"
	},
	px3px: {
			paddingInline: "3px"
	},
	py0: {
			paddingBlock: "0"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textInherit: {
			color: "inherit"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	relative: {
			position: "relative"
	},
	ml1: {
			marginLeft: "4px"
	},
	flex: {
			display: "flex"
	},
	shrink0: {
			flexShrink: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	absolute: {
			position: "absolute"
	},
	Right1: {
			right: "-4px"
	},
	Bottom1: {
			bottom: "-4px"
	},
	size3: {
			width: "12px",
			height: "12px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgAccent: {
			backgroundColor: "var(--accent)"
	},
	text8px: {
			fontSize: "8px"
	},
	fontBold: {
			fontWeight: "var(--font-weight-bold)"
	},
	leadingNone: {
			lineHeight: "1"
	},
	textOnAccent: {
			color: "var(--on-accent)"
	},
	ringPanel: { "--tw-ring-color": "var(--bg-panel)" },
	opacity50: {
			opacity: ".5"
	},
	mt3px: {
			marginTop: "3px"
	},
	gap1: {
			gap: "4px"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	pl7: {
			paddingLeft: "28px"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	textFaint: {
			color: "var(--text-faint)"
	},

	top12: {
		"top": "50%"
	},
	hidden: {
		"display": "none"
	},
	TranslateY12: {
		"--tw-translate-y": "calc(calc(1 / 2 * 100%) * -1)",
		"translate": "var(--tw-translate-x) var(--tw-translate-y)"
	},
	text15px: {
		"fontSize": "15px"
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	transitionNone: {
		"transitionProperty": "none"
	},
	z1: {
		"zIndex": "1"
	},
	mt0: {
		"marginTop": "0"
	},
	block: {
		"display": "block"
	},
	touchPanY: {
		"--tw-pan-y": "pan-y",
		"touchAction": "var(--tw-pan-x,) var(--tw-pan-y,) var(--tw-pinch-zoom,)"
	},
	hoverPr68px: {
		"@media (hover: hover)": {
			":hover": {
				"paddingRight": "68px"
			}
		}
	},
	hoverPr38px: {
		"@media (hover: hover)": {
			":hover": {
				"paddingRight": "38px"
			}
		}
	},
	bgSelected: {
		"backgroundColor": "var(--selected)"
	},
	transitionTransform: {
		"transitionProperty": "transform,translate,scale,rotate",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	durationDurMicro: {
		"--tw-duration": "var(--dur-micro)",
		"transitionDuration": "var(--dur-micro)"
	},
	durationDur: {
		"--tw-duration": "var(--dur)",
		"transitionDuration": "var(--dur)"
	},
	willChangeTransform: {
		"willChange": "transform"
	},
	size2: {
		"width": "8px",
		"height": "8px"
	},
	mlAuto: {
		"marginLeft": "auto"
	},
	minW10: {
		"minWidth": "40px"
	},
	justifyEnd: {
		"justifyContent": "flex-end"
	},
	pl25: {
		"paddingLeft": "10px"
	},
	phoneTextLabel: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-label)"
		}
	},
	ml15: {
		"marginLeft": "6px"
	},
	right7px: {
		"right": "7px"
	},

	sizeVarSidebarRowAction26px: {
		"width": "var(--sidebar-row-action,26px)",
		"height": "var(--sidebar-row-action,26px)"
	},
	rightCalcVarSidebarRowAction26px11px: {
		"right": "calc(var(--sidebar-row-action,26px) + 11px)"
	},

	mt05: {
		"marginTop": "2px"
	},
	wFull: {
		"width": "100%"
	},
	roundedRow: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border0: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "0"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	pyVarSidebarRowPad: {
		"paddingBlock": "var(--sidebar-row-pad)"
	},
	pr2: {
		"paddingRight": "8px"
	},
	textLeft: {
		"textAlign": "left"
	},
	textFg: {
		"color": "var(--text)"
	},
	phonePr2: {
		"@media (max-width: 720px)": {
			"paddingRight": "8px"
		}
	},
	phonePlCalcVarSidebarIconLeft16px12px: {
		"@media (max-width: 720px)": {
			"paddingLeft": "calc(var(--sidebar-icon-left,16px) - 12px)"
		}
	},
	phonePy13px: {
		"@media (max-width: 720px)": {
			"paddingBlock": "13px"
		}
	},
	desktopTextItemTitle: {
		"@media (min-width: 721px)": {
			"fontSize": "var(--type-item-title)"
		}
	},
	phoneTextInputPhone: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-input-phone)"
		}
	},
	WebkitMaskImageLinearGradientToRight000Calc10024pxTransparent: {
		"WebkitMaskImage": "linear-gradient(90deg,var(--color-black) calc(100% - 24px),transparent)"
	},
	MaskImageLinearGradientToRight000Calc10024pxTransparent: {
		"WebkitMaskImage": "linear-gradient(90deg,var(--color-black) calc(100% - 24px),transparent)",
		"maskImage": "linear-gradient(90deg,var(--color-black) calc(100% - 24px),transparent)"
	},
	leading135: {
		"--tw-leading": "1.35",
		"lineHeight": "1.35"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	ring2: {
		"--tw-ring-shadow": "var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color,currentcolor)",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
});

/** The sidebar's selectable row — the shape every list family wears: session,
 *  workspace, PR, support, feed and archived rows. Migrated off the
 *  legacy row family, so the state that used to live in `-selected` /
 *  `-waiting` / `-unread` modifier classes now rides `data-*` attributes on
 *  the row itself and descendants read it through `group-data-[…]` variants.
 *  `data-sidebar-row` is the hook the ⌘↑/⌘↓ row walker queries by.
 *
 *  Rows wrapped in a swipe shell add `mt-0` — the wrapper carries the 2px gap
 *  for them — plus the swipe transform; bare rows keep the margin. On phones,
 *  row marks sit on the same 16px rail as tool and repo marks. The inset is
 *  written against `--sidebar-icon-left` (12px at its default 16) rather than
 *  as a flat 4, so a family that nests by overriding that variable, today the
 *  runs under an automation, indents at phone width too and not only on
 *  desktop, where the rail pad already reads it.
 *
 *  `--sidebar-row-pad` around the 22px rail is the sidebar's ITEM height (see
 *  the height scale in lib/sidebar-classes.ts): 7px for a 36px box, and 4px
 *  for the 30px one the compact density asks for. It is the same box the tool
 *  rows and the item headings take at either setting, so a repo band and its
 *  sessions run as one regular column. It was a flat 9px, which made a session
 *  row the tallest thing in the rail and 12px taller than a tool row saying the
 *  same kind of thing.
 *  Phones keep `py-[13px]` at both densities: 36px is a reading height, not a
 *  tap target, so the compact values are gated to desktop where they are set. */
export const SIDEBAR_ROW =
	[mergeStylexClassName("group", sx.relative, sx.mt05, sx.wFull, sx.roundedRow, sx.border0, sx.bgTransparent, sx.pyVarSidebarRowPad, sx.pr2), SIDEBAR_RAIL_PAD, mergeStylexClassName("", sx.textLeft, sx.textFg, sx.phonePr2, sx.phonePlCalcVarSidebarIconLeft16px12px, sx.phonePy13px)].filter(Boolean).join(" ");

/** A row's title: one line that fades smoothly at the available edge instead
 *  of ending in an ellipsis. Read conversations stay quiet; unread ones
 *  brighten like Slack, a blocked one bolds under its blue wash. */
/* Pin + archive, hover-revealed on desktop: on hover they take the metadata's
   place at the far right so they don't crowd the title. Long titles run under
   that spot, and what used to cover them was an opaque plate per button — which
   only ever worked because the row it sat on was opaque too. Now that a row's
   states are translucent ink, a solid chip cuts a hole in the material behind
   it, so the row reserves the space instead (`hover:pr-[68px]` below) and the
   buttons carry nothing but their own hover wash.
   The reveal is `group-hover`, which Tailwind gates to real hover devices for
   us; on touch these actions live behind the swipe gesture and the long-press
   sheet. */
const ROW_ACTION = cn(
	mergeStylexClassName("group-hover:flex", sx.sizeVarSidebarRowAction26px, sx.absolute, sx.top12, sx.hidden, sx.TranslateY12, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.text15px, sx.leadingNone, sx.textFaint, sx.hoverTextFg),
	// Not a wash — a lid. See SIDEBAR_ROW_CHIP.
	SIDEBAR_ROW_CHIP,
);

export const SIDEBAR_ROW_TITLE =
	mergeStylexClassName("group-data-[selected]:text-fg group-data-[waiting]:font-semibold group-data-[unread]:font-semibold group-data-[unread]:text-fg", sx.minW0, sx.flex1, sx.overflowHidden, sx.whitespaceNowrap, sx.WebkitMaskImageLinearGradientToRight000Calc10024pxTransparent, sx.MaskImageLinearGradientToRight000Calc10024pxTransparent, typography.body, sx.fontMedium, sx.leading135, sx.textDim, sx.desktopTextItemTitle);

export function SidebarItem({
	session,
	selected,
	unread,
	mention,
	mine,
	showOwner = !mine,
	onClick,
	onArchive: onArchiveRequest,
	pinned,
	onTogglePin,
	shipsDirectlyToMain = false,
	onRename,
	onSetStatus,
}: {
	session: UnifiedSession;
	selected: boolean;
	/** New activity since this session was last opened — brightens and bolds the
	    title, like an unread Slack conversation. */
	unread: boolean;
	/** Who @-mentioned you in this session, if anyone. Cleared by opening it
	    (lib/mentions.ts), so it only ever marks a session you have not read
	    since being tagged. */
	mention?: string | null;
	/** The current user's own session — the owner name is redundant, so it's
	    dropped and the timestamp moves up onto the title line. */
	mine: boolean;
	/** Show the starter below the title. Person-group rows set this false because
	    their heading already names the starter without claiming the session as mine. */
	showOwner?: boolean;
	onClick: () => void;
	onArchive: (current: HTMLButtonElement | null) => void;
	pinned: boolean;
	onTogglePin: () => void;
	/** The session commits to the repo's default branch, so no PR is expected. */
	shipsDirectlyToMain?: boolean;
	onRename: (title: string) => void;
	/** Pin this session into a sidebar lane (null = back to derived). Present on
	    automation rows — it's how an automation run graduates into your lanes. */
	onSetStatus?: (status: LaneChoice | null) => void;
}) {
	const isPhone = useIsPhone();
	// The row's tooltips advertise whatever the user has these bound to.
	const pinKeys = useShortcutKeys("session-pin");
	const archiveKeys = useShortcutKeys("session-archive");
	const waitingForInput = !!session.waitingForInput;
	const failed = runNeedsAttention(session);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Desktop right-click menu (mobile long-press opens the action sheet).
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (!ctxMenu) return;
		const close = () => setCtxMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [ctxMenu]);

	// Hover card: after a short dwell, the row's detail card — the same one
	// every other sidebar row raises. Held back while renaming (the input the
	// row turns into owns the interaction).
	const btnRef = useRef<HTMLButtonElement>(null);
	const card = useRowHoverCard(editing);
	const closeHover = card.close;
	const onArchive = () => onArchiveRequest(btnRef.current);

	// Mobile long-press → action sheet, and — importantly — the *tap* to open a
	// session is driven from `touchend`, not the synthesized `click`. The row
	// has `:hover` styles (the reveal-on-hover X, the hover background), and iOS
	// treats the first tap on a hover-styled element as a hover-in, swallowing the
	// click — so a click-driven open needs a second tap ("first tap doesn't work").
	// Firing on touchend sidesteps that entirely. A hold that stays roughly in
	// place for LONG_PRESS_MS opens the sheet instead; any real finger travel (a
	// scroll) cancels both.
	const [sheetOpen, setSheetOpen] = useState(false);
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pressOrigin = useRef<{ x: number; y: number } | null>(null);
	const longPressed = useRef(false);
	const moved = useRef(false);
	const swipeOrigin = useRef<{ x: number; y: number; width: number } | null>(
		null,
	);
	const swiping = useRef(false);
	const swipeOffsetRef = useRef(0);
	const [dragging, setDragging] = useState(false);
	const [swipeAction, setSwipeAction] = useState<SwipeAction | null>(null);
	const [swipeOffset, setSwipeOffset] = useState(0);
	useEffect(() => {
		if (selected || !isPhone) {
			setSwipeOffset(0);
			swipeOffsetRef.current = 0;
			setSwipeAction(null);
			setDragging(false);
		}
	}, [isPhone, selected]);

	function clearPress() {
		if (pressTimer.current) clearTimeout(pressTimer.current);
		pressTimer.current = null;
		pressOrigin.current = null;
	}
	function onTouchStart(e: React.TouchEvent) {
		if (editing || e.touches.length !== 1) return;
		const t = e.touches[0];
		longPressed.current = false;
		moved.current = false;
		swiping.current = false;
		clearPress();
		// After clearPress (which nulls it) so it survives to onTouchMove/onTouchEnd.
		pressOrigin.current = { x: t.clientX, y: t.clientY };
		swipeOrigin.current = {
			x: t.clientX - swipeOffset,
			y: t.clientY,
			width: e.currentTarget.clientWidth,
		};
		setSwipeAction(null);
		pressTimer.current = setTimeout(() => {
			longPressed.current = true;
			closeHover();
			navigator.vibrate?.(10);
			setSheetOpen(true);
		}, LONG_PRESS_MS);
	}
	function onTouchMove(e: React.TouchEvent) {
		if (e.touches.length !== 1) return;
		const t = e.touches[0];
		const swipeO = swipeOrigin.current;
		if (swipeO && !longPressed.current) {
			const dx = t.clientX - swipeO.x;
			const dy = t.clientY - swipeO.y;
			if (
				swiping.current ||
				(Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy))
			) {
				swiping.current = true;
				moved.current = true;
				setDragging(true);
				clearPress();
				e.preventDefault();
				const offset = clampSwipe(dx, swipeO.width);
				swipeOffsetRef.current = offset;
				setSwipeOffset(offset);
				return;
			}
		}
		const o = pressOrigin.current;
		if (!o) return;
		if (
			Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
			Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
		) {
			moved.current = true;
			clearPress();
		}
	}
	function onTouchEnd(e: React.TouchEvent) {
		const hadOrigin = pressOrigin.current !== null;
		const wasSwiping = swiping.current;
		const rowWidth = swipeOrigin.current?.width ?? e.currentTarget.clientWidth;
		const currentOffset = swipeOffsetRef.current;
		clearPress();
		swipeOrigin.current = null;
		swiping.current = false;
		setDragging(false);
		if (editing) return;
		if (wasSwiping) {
			e.preventDefault();
			if (Math.abs(currentOffset) >= fullSwipeThreshold(rowWidth)) {
				const action: SwipeAction = currentOffset < 0 ? "archive" : "star";
				setSwipeAction(action);
				setSwipeOffset(swipeCommitOffset(action, rowWidth));
				window.setTimeout(() => {
					if (action === "archive") onArchive();
					else {
						onTogglePin();
						setSwipeOffset(0);
						window.setTimeout(() => setSwipeAction(null), SWIPE_COMMIT_MS);
					}
					swipeOffsetRef.current = 0;
				}, SWIPE_COMMIT_MS);
				return;
			}
			const snapped =
				Math.abs(currentOffset) > SWIPE_OPEN_THRESHOLD
					? currentOffset > 0
						? SWIPE_REVEAL_PX
						: -SWIPE_REVEAL_PX
					: 0;
			swipeOffsetRef.current = snapped;
			setSwipeOffset(snapped);
			return;
		}
		// A clean tap: it started on this row, never became a long-press, and
		// never turned into a scroll. Open now and swallow the ghost click iOS
		// would fire ~300ms later (which the :hover heuristic may drop anyway).
		if (hadOrigin && !longPressed.current && !moved.current) {
			e.preventDefault();
			if (swipeOffset !== 0) {
				setSwipeOffset(0);
				swipeOffsetRef.current = 0;
				return;
			}
			onClick();
		}
	}

	function commitRename() {
		onRename(draft.trim());
		setEditing(false);
	}

	const metaParts: React.ReactNode[] = [];
	// In "My sessions" and under a person's own heading, the owner is already
	// stated by the surrounding list, so repeating it makes every row two lines.
	if (showOwner && session.startedBy && !session.automation) {
		metaParts.push(<span key="u">{session.startedBy}</span>);
	}
	const compactMeta = mine || !showOwner;
	// No idle "time since" here: times only appear while a run is live. The
	// hover card dropped its "Updated 8m ago" for the same reason, and the Info
	// tab is where an exact last-activity stamp belongs.
	if (session.linearIssue) {
		metaParts.push(
			<span key="lin" {...stylex.props(sx.text7b86e8)}>
				{session.linearIssue.identifier}
			</span>,
		);
	}

	const visibleSwipeOffset = isPhone ? swipeOffset : 0;
	// The swipe row is "open" — a revealed action sits behind it, so the slide
	// back and forth runs at the shorter duration.
	const swipeOpen = swipeAction !== null || visibleSwipeOffset !== 0;
	// Which side the gesture has revealed. This used to ride the wrapper as
	// `is-swipe-archive` / `is-swipe-star` for a descendant selector to read;
	// the two actions read it directly now, so each one is handed exactly one
	// `display` instead of competing for it through the cascade.
	const openSide: SwipeAction | null =
		swipeAction === "archive" || visibleSwipeOffset < 0
			? "archive"
			: swipeAction === "star" || visibleSwipeOffset > 0
				? "star"
				: null;

	return (
		<Popover.Root {...card.rootProps}>
		<div
			className={SIDEBAR_SWIPE_ROW}
			data-swipe-row=""
			style={
				visibleSwipeOffset
					? ({
							"--swipe-action-w": `${Math.max(
								SWIPE_REVEAL_PX,
								Math.abs(visibleSwipeOffset),
							)}px`,
						} as React.CSSProperties)
					: undefined
			}
		>
			{isPhone && (
				<button
					className={cn(
						SIDEBAR_SWIPE_ACTION,
						SIDEBAR_SWIPE_ACTION_ARCHIVE,
						openSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
						dragging ? mergeStylexClassName("", sx.transitionNone) : SIDEBAR_SWIPE_ACTION_TRANSITION,
					)}
					data-swipe-action="archive"
					onClick={(e) => {
						e.stopPropagation();
						setSwipeOffset(0);
						onArchive();
					}}
					title="Archive session"
				>
					<IconArchive size={22} />
					<span>Archive</span>
				</button>
			)}
			{isPhone && (
				<button
					className={cn(
						SIDEBAR_SWIPE_ACTION,
						pinned ? SIDEBAR_SWIPE_ACTION_STAR_ON : SIDEBAR_SWIPE_ACTION_STAR,
						openSide === "star" && SIDEBAR_SWIPE_ACTION_OPEN,
						dragging ? mergeStylexClassName("", sx.transitionNone) : SIDEBAR_SWIPE_ACTION_TRANSITION,
					)}
					data-swipe-action="star"
					onClick={(e) => {
						e.stopPropagation();
						setSwipeOffset(0);
						onTogglePin();
					}}
					title={pinned ? "Unpin session" : "Pin session"}
				>
					<IconPin size={22} fill={pinned ? "currentColor" : "none"} />
					<span>{pinned ? "Unpin" : "Pin"}</span>
				</button>
			)}
		<Popover.Trigger
			{...card.triggerProps}
			render={
				<button
					ref={btnRef}
					className={cn(
						SIDEBAR_ROW,
						// Inside a swipe row: the wrapper owns the gap, the row owns the
						// slide. Hover paints over selected/waiting here, as it always
						// has — as a layer now, so it lifts those states rather than
						// replacing them (see SIDEBAR_HOVER_LAYER).
						mergeStylexClassName("", sx.z1, sx.mt0, sx.block, sx.touchPanY),
						SIDEBAR_HOVER_LAYER,
						// On hover the row gives up its right end to the pin +
						// archive pair floating there, the same reserve workspace
						// rows make (SIDEBAR_WS_ROW). It used to be the buttons'
						// own opaque plate that kept a long title out of the way;
						// a solid chip can't sit on a translucent row. `hover:`, not
						// `group-hover:` — this element is the group itself.
						// Two chips' worth while the pin is there to unpin; one
						// chip less (26px + the 4px gap) on an unpinned row, which
						// reveals archive alone.
						pinned ? mergeStylexClassName("", sx.hoverPr68px) : mergeStylexClassName("", sx.hoverPr38px),
						// No trim here for other people's sessions, which stack a meta
						// line under the title. That used to re-state `py-[7px]` against
						// a 9px base; the base is now the shared `--sidebar-row-pad`, and
						// a hard second `py-*` would out-rank it on Tailwind's output
						// order alone and pin those rows at one density.
						// No fill for "needs you" — the blue mark in the rail and the
						// bold title carry it, and the row's one background slot stays
						// with selection (see the workspace row, which matches).
						selected && mergeStylexClassName("", sx.bgSelected),
						dragging
							? mergeStylexClassName("", sx.transitionNone)
							: swipeOpen
								? mergeStylexClassName("", sx.transitionTransform, sx.durationDurMicro)
								: mergeStylexClassName("", sx.transitionTransform, sx.durationDur),
						// One compositor layer for the row under the finger, none for
						// the idle list (dozens of retina-sized layers is a real tax).
						(dragging || swipeOpen) && mergeStylexClassName("", sx.willChangeTransform),
					)}
					data-sidebar-row=""
					data-sidebar-item-key={`session:${session.id}`}
					data-selected={selected || undefined}
					data-waiting={waitingForInput || undefined}
					data-failed={failed || undefined}
					data-running={session.isRunning || undefined}
					data-unread={unread || undefined}
					style={
						visibleSwipeOffset
							? { transform: `translateX(${visibleSwipeOffset}px)` }
							: undefined
					}
					onClick={(e) => {
						// Touch taps are handled on touchend (and their ghost click is
						// preventDefault'd), so this path is the mouse/desktop one. Still
						// swallow a click that ends a long-press, as a belt-and-suspenders.
						if (longPressed.current) {
							longPressed.current = false;
							e.preventDefault();
							return;
						}
						onClick();
					}}
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
					onTouchCancel={() => {
						clearPress();
						swipeOrigin.current = null;
						swiping.current = false;
						setDragging(false);
					}}
					onContextMenu={(e) => {
						// The sidebar's background carries a menu of its own, so this
						// row's has to claim the event rather than let both open.
						e.stopPropagation();
						// On touch this is the long-press callout: the action sheet
						// owns that gesture, so suppress the native text-selection
						// callout rather than stacking both.
						if (longPressed.current || pressOrigin.current) {
							e.preventDefault();
							return;
						}
						e.preventDefault();
						closeHover();
						setCtxMenu({ x: e.clientX, y: e.clientY });
					}}
				/>
			}
		>
			{/* The shared rail gap, as every other family takes it: with the
			    SIDEBAR_RAIL slot in front, that pair is what puts every title on
			    one rail. */}
			<div className={cn(mergeStylexClassName("", sx.flex, sx.minW0, sx.itemsCenter), SIDEBAR_RAIL_GAP)}>
				{/* Questions stay blue. A stopped run is red, so it cannot look as
				    though it is waiting for a reply. */}
				<span className={SIDEBAR_RAIL}>
					{waitingForInput && <span {...stylex.props(sx.srOnly)}>Waiting for your input</span>}
					{failed && <span {...stylex.props(sx.srOnly)}>Last run failed</span>}
					{waitingForInput ? (
						<span
							className={[mergeStylexClassName("", sx.size2, sx.shrink0, sx.roundedFull), SIDEBAR_STATUS_DOT.waiting].filter(Boolean).join(" ")}
						/>
					) : failed ? (
						<span
							className={[mergeStylexClassName("", sx.size2, sx.shrink0, sx.roundedFull), SIDEBAR_STATUS_DOT.failed].filter(Boolean).join(" ")}
						/>
					) : session.isRunning ? (
						<span
							className={[mergeStylexClassName("", sx.size2, sx.shrink0, sx.roundedFull), SIDEBAR_STATUS_DOT.running].filter(Boolean).join(" ")}
						/>
					) : (
						<WsPrStatusMark
							sessions={[session]}
							size={18}
							shipsDirectlyToMain={shipsDirectlyToMain}
						/>
					)}
				</span>
				{editing ? (
					<input {...mergeStylexProps("", sx.desktopTextItemTitle, sx.phoneTextInputPhone, sx.minW0, sx.flex1, sx.roundedMd, sx.border, sx.borderAccent, sx.bgBg, sx.px3px, sx.py0, sx.fontMedium, sx.textInherit, sx.outlineNone, typography.body)}
						value={draft}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onBlur={commitRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							else if (e.key === "Escape") setEditing(false);
							e.stopPropagation();
						}}
					/>
				) : (
					<span
						className={SIDEBAR_ROW_TITLE}
						onDoubleClick={(e) => {
							e.stopPropagation();
							setDraft(session.title);
							setEditing(true);
						}}
					>
						{stripPrTitlePrefix(session.title)}
					</span>
				)}
				{/* Nobody started this one in a composer. The same quiet mark covers
				    automation runs, report tasks, and sessions an agent minted itself. */}
				{!editing && sessionWasAgentStarted(session) && <AutoCreatedMark />}
				{/* Started somewhere else: a Slack thread, a Linear issue. Same slot
				    and ink as the mark above, since both answer "where did this row
				    come from" for a list that mixes origins. */}
				{!editing && <OriginMark source={session.source} />}
				{mention && !editing && (
					// Somebody tagged you here. It takes the slot the unread dot would
					// use and wins over it, because "you were asked" is the stronger
					// signal — and it names who asked, which a dot cannot.
					<span
						{...stylex.props(sx.relative, sx.ml1, sx.flex, sx.shrink0, sx.itemsCenter)}
						title={`${mention} mentioned you`}
						aria-label={`${mention} mentioned you`}
					>
						<UserAvatar name={mention} size={16} className={mergeStylexOverrideClassName("", sx.shrink0)} />
						<span
							aria-hidden="true" {...mergeStylexProps("", sx.ring2, sx.absolute, sx.Right1, sx.Bottom1, sx.flex, sx.size3, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgAccent, sx.text8px, sx.fontBold, sx.leadingNone, sx.textOnAccent, sx.ringPanel)}
						>
							@
						</span>
					</span>
				)}
				{/* Own sessions collapse to one line: the timestamp (+ any PR/Linear
				    badge) rides to the right of the title, flush with the row edge. On
				    hover it fades and the archive button takes its place — but not on a
				    phone, where there is no archive button. */}
				{compactMeta && !editing && metaParts.length > 0 && (
					<span
						className={cn(
							mergeStylexClassName("group-data-[unread]:text-dim", sx.mlAuto, sx.flex, sx.minW10, sx.shrink0, sx.itemsCenter, sx.justifyEnd, sx.gap1, sx.pl25, sx.whitespaceNowrap, typography.meta, sx.textFaint, sx.phoneTextLabel),
							!isPhone && "group-hover:opacity-0",
						)}
					>
						{metaParts.map((part, i) => (
							<React.Fragment key={i}>
								{i > 0 && <span {...stylex.props(sx.opacity50)}>·</span>}
								{part}
							</React.Fragment>
						))}
					</span>
				)}
				{!editing && hasDraft(`session:${session.id}`) && (
					<span
						className={cn(SIDEBAR_WS_DRAFT, mergeStylexClassName("", sx.ml15))}
						data-ws-draft=""
						aria-label="Unsent draft. Return to finish it."
					>
						<IconPencil size={20} />
					</span>
				)}
			</div>
			{/* The block meta lives on its own line below the title. The row itself
			    clears the hover-revealed buttons, so this line needs no reserve of
			    its own. */}
			{!compactMeta && (
				<div {...mergeStylexProps("group-data-[unread]:text-dim", sx.phoneTextLabel, sx.mt3px, sx.flex, sx.itemsCenter, sx.gap1, sx.overflowHidden, sx.pl7, sx.whitespaceNowrap, sx.textFaint, typography.meta)}>
					{metaParts.map((part, i) => (
						<React.Fragment key={i}>
							{i > 0 && <span {...stylex.props(sx.opacity50)}>·</span>}
							{part}
						</React.Fragment>
					))}
				</div>
			)}
			{/* Pin is not one of the row's standing actions. An unpinned row
			    reveals archive alone, and pinning stays on the context menu, the
			    keyboard chord and the swipe. A pinned row gets the chip back,
			    because unpinning has to be reachable from the thing it marks. */}
			{!isPhone && pinned && (
			<Tooltip
				label="Unpin session"
				shortcut={selected ? (pinKeys ?? undefined) : undefined}
			>
				<span
					className={cn(
						ROW_ACTION,
						// One chip's width plus the archive's 7px edge and the 4px
						// between them — the ws rows' `gap-1` cluster, spelled as an
						// offset because these two are positioned rather than laid out.
						// It has to be a calc: the chip narrows with the density.
						mergeStylexClassName("data-[on]:bg-pressed data-[on]:text-fg", sx.rightCalcVarSidebarRowAction26px11px),
					)}
					data-on=""
					role="button"
					aria-label="Unpin session"
					onMouseEnter={closeHover}
					onClick={(e) => {
						e.stopPropagation();
						onTogglePin();
					}}
				>
					<IconPin size={19} fill="currentColor" />
				</span>
			</Tooltip>
			)}
			{!isPhone && (
			<Tooltip
				label="Archive session"
				shortcut={selected ? (archiveKeys ?? undefined) : undefined}
			>
				<span
					className={cn(ROW_ACTION, mergeStylexClassName("", sx.right7px))}
					role="button"
					aria-label="Archive session"
					onMouseEnter={closeHover}
					onClick={(e) => {
						e.stopPropagation();
						onArchive();
					}}
				>
					<svg
						width="20"
						height="20"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
						<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
						<path d="M6.5 8.5h3" strokeLinecap="round" />
					</svg>
				</span>
			</Tooltip>
			)}
		</Popover.Trigger>
		</div>
		<RowCardPopup>
			<SessionCardBody session={session} />
		</RowCardPopup>
			{sheetOpen && (
				<MobileActionSheet
					session={session}
					mine={mine}
					onRename={() => {
						setDraft(session.title);
						setEditing(true);
					}}
					onArchive={onArchive}
					onSetStatus={onSetStatus}
					onClose={() => setSheetOpen(false)}
				/>
			)}
			{ctxMenu && (
				<SidebarCtxMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					onClose={() => setCtxMenu(null)}
					entries={[
						{
							kind: "item",
							icon: <IconMail size={20} />,
							// Offer the move you can actually make, not both directions.
							label: unread ? "Mark as read" : "Mark as unread",
							onClick: () =>
								unread
									? markRead(session.id, session.lastActivity)
									: markUnread(session.id),
						},
						{
							kind: "item",
							icon: (
								<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
							),
							label: pinned ? "Unpin" : "Pin",
							onClick: onTogglePin,
						},
						...(onSetStatus
							? [
									// Claim this run into your own lanes (per-user — it
									// moves only in YOUR sidebar), where it then follows
									// its live state instead of staying parked in the
									// Automations band. Your own sessions are already
									// there, so they don't offer it.
									...(!mine || isClaimed(session)
										? [
												{
													kind: "item",
													icon: <IconInbox size={20} />,
													label: isClaimed(session)
														? "Remove from my workspaces"
														: "Add to my workspaces",
													onClick: () =>
														onSetStatus(isClaimed(session) ? null : "mine"),
												} as const,
											]
										: []),
									{
										kind: "status",
										current: pinnedLane(session) ?? null,
										onPick: onSetStatus,
									} as const,
								]
							: []),
						{
							kind: "item",
							icon: <IconPencil size={20} />,
							label: "Rename",
							onClick: () => {
								setDraft(session.title);
								setEditing(true);
							},
						},
						{ kind: "sep" },
						{
							kind: "item",
							icon: <IconArchive size={20} />,
							label: "Archive",
							onClick: onArchive,
						},
					]}
				/>
			)}
		</Popover.Root>
	);
}

// The bottom sheet raised by long-pressing a session row on touch. It gathers
// the per-session actions (rename, archive) into thumb-sized rows on the shared
// `BottomSheet` — backdrop, grabber, drag-to-dismiss and focus handling come
// from the primitive.
function MobileActionSheet({
	session,
	mine,
	onRename,
	onArchive,
	onSetStatus,
	onClose,
}: {
	session: UnifiedSession;
	/** Your own session — it's already in your lanes, so no claim action. */
	mine: boolean;
	onRename: () => void;
	onArchive: () => void;
	/** Pin the session into a lane (see SidebarItem) — automation rows only. */
	onSetStatus?: (status: LaneChoice | null) => void;
	onClose: () => void;
}) {
	const [page, setPage] = useState<"actions" | "status">("actions");
	const currentLane = pinnedLane(session) ?? null;
	const displayedLane = currentLane ?? mineStatus(session);
	// Lock the page behind the sheet so a scroll drags the list, not the page.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	return (
		<BottomSheet label={`Actions for ${session.title}`} onClose={onClose}>
			{(dismiss) => {
				if (page === "status" && onSetStatus) {
					return (
						<LanePickerPage
							current={currentLane}
							onBack={() => setPage("actions")}
							onSelect={(status) => {
								onSetStatus(status);
								dismiss();
							}}
						/>
					);
				}
				return (
				<SheetBody>
					<SheetTitle>{session.title}</SheetTitle>
					<SheetItem
						onClick={() => {
							onRename();
							dismiss();
						}}
					>
						<svg
							width="20"
							height="20"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
						>
							<path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />
						</svg>
						Rename
					</SheetItem>
					{/* Claim this run into your own lanes, where it follows its live
					    state — the phone twin of the row's right-click action. */}
					{onSetStatus && (!mine || isClaimed(session)) && (
						<SheetItem
							onClick={() => {
								onSetStatus(isClaimed(session) ? null : "mine");
								dismiss();
							}}
						>
							<IconInbox size={22} />
							{isClaimed(session)
								? "Remove from my workspaces"
								: "Add to my workspaces"}
						</SheetItem>
					)}
					{onSetStatus && (
						<SheetDrillInItem
							icon={<LaneStatusMark value={displayedLane} />}
							label="Status"
							value={lanePickerLabel(displayedLane)}
							onClick={() => setPage("status")}
						/>
					)}
					<SheetSeparator />
					<SheetItem
						tone="danger"
						onClick={() => {
							onArchive();
							dismiss();
						}}
					>
						<svg
							width="20"
							height="20"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
						>
							<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
							<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
							<path d="M6.5 8.5h3" strokeLinecap="round" />
						</svg>
						Archive
					</SheetItem>
				</SheetBody>
				);
			}}
		</BottomSheet>
	);
}
