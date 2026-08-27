import React, { useEffect, useState } from "react";
import { useIsPhone } from "../hooks/useIsPhone";
import { fetchSupportThreads } from "../lib/api";
import {
	SIDEBAR_GROUP_HEADER,
	SIDEBAR_GROUP_HEADER_INSET,
	SIDEBAR_GROUP_NAME,
	SIDEBAR_HOVER_LAYER,
	SIDEBAR_LANE_COUNT,
	SIDEBAR_LANE_HEADER,
	SIDEBAR_LANE_NAME,
	SIDEBAR_RAIL,
	SIDEBAR_RAIL_GAP,
} from "../lib/sidebar-classes";
import { SUPPORT_PRIORITY_DOT, SUPPORT_PRIORITY_GROUPS } from "../lib/sidebar-filter";
import { SUPPORT_COLUMN_BAR } from "../lib/support-classes";
import { mineStatus } from "../lib/sidebar-lanes";
import { MINE_STATUS_META } from "../lib/sidebar-types";
import { shortTime } from "../lib/time";
import type { SupportThread, UnifiedSession } from "../lib/types";
import { cn, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { ConversationPane } from "./ConversationPane";
import { IconMail } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	size7px: {
			width: "7px",
			height: "7px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	flex: {
			display: "flex"
	},
	minH0: {
			minHeight: "0"
	},
	mt2: {
			marginTop: "8px"
	},
	px3: {
			paddingInline: "12px"
	},
	py6: {
			paddingBlock: "24px"
	},
	textCenter: {
			textAlign: "center"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	flexCol: {
			flexDirection: "column"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	p8: {
			padding: "32px"
	},

	cursorDefault: {
		"cursor": "default"
	},
	hoverTextDim: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text-dim)"
			}
		}
	},

	mt05: {
		"marginTop": "2px"
	},
	wFull: {
		"width": "100%"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	itemsStart: {
		"alignItems": "flex-start"
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
	py25: {
		"paddingBlock": "10px"
	},
	pr3: {
		"paddingRight": "12px"
	},
	pl25: {
		"paddingLeft": "10px"
	},
	textLeft: {
		"textAlign": "left"
	},
	itemsBaseline: {
		"alignItems": "baseline"
	},
	gap2: {
		"gap": "8px"
	},
	truncate: {
		"textOverflow": "ellipsis",
		"whiteSpace": "nowrap",
		"overflow": "hidden"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	phoneText15px: {
		"@media (max-width: 720px)": {
			"fontSize": "15px"
		}
	},
	shrink0: {
		"flexShrink": "0"
	},
	textRight: {
		"textAlign": "right"
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	mt1: {
		"marginTop": "4px"
	},
	block: {
		"display": "block"
	},
	phoneText14px: {
		"@media (max-width: 720px)": {
			"fontSize": "14px"
		}
	},
	phoneWFull: {
		"@media (max-width: 720px)": {
			"width": "100%"
		}
	},
	phoneFlex1: {
		"@media (max-width: 720px)": {
			"flex": "1"
		}
	},
	desktopW320px: {
		"@media (min-width: 721px)": {
			"width": "320px"
		}
	},
	desktopShrink0: {
		"@media (min-width: 721px)": {
			"flexShrink": "0"
		}
	},
	desktopBorderR: {
		"@media (min-width: 721px)": {
			"borderRightStyle": "var(--tw-border-style)",
			"borderRightWidth": "1px"
		}
	},
	desktopBorderDivider: {
		"@media (min-width: 721px)": {
			"borderColor": "var(--divider)"
		}
	},
	m0: {
		"margin": "0"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	textFg: {
		"color": "var(--text)"
	},
	phoneTextSectionTitle: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-section-title)"
		}
	},
	mlAuto: {
		"marginLeft": "auto"
	},
	overflowYAuto: {
		"overflowY": "auto"
	},
	px15: {
		"paddingInline": "6px"
	},
	pt2: {
		"paddingTop": "8px"
	},
	pb3: {
		"paddingBottom": "12px"
	},
	ScrollbarWidthNone: {
		"scrollbarWidth": "none"
	},
});

/**
 * The Plain queue as a place of its own: the tickets in a column beside the
 * sidebar, the one you picked open next to them, and no chat anywhere.
 *
 * It is the second way into the same queue, running beside the Plain band at
 * the bottom of the sidebar rather than replacing it — the two are being tried
 * against each other. The band opens a ticket's workspace, so the answer
 * arrives with a session, a tab strip and a transcript around it; this opens
 * the ticket itself, and a session is something you go to from it — the pane's
 * own "Triage this ticket", or, once a run exists, the pill that replaces it.
 *
 * The list is the sidebar's grammar at a column's width: the same priority
 * lanes, the same 22px rail, the same hover and selected washes, with a second
 * line for the subject because 300px has room for it. The ticket beside it is
 * ConversationPane, the same surface the workspace Conversation tab renders.
 */

/** The column. Paper like the pane it sits in, separated by the chrome seam —
 *  the Reports page's list column, whose doc argues that shape at length. On a
 *  phone the two panes are separate pages, so it is the whole width there. */
const COLUMN =
	mergeStylexClassName("", sx.flex, sx.minH0, sx.flexCol) +
	" " + mergeStylexClassName("", sx.phoneWFull, sx.phoneFlex1) +
	" " + mergeStylexClassName("", sx.desktopW320px, sx.desktopShrink0, sx.desktopBorderR, sx.desktopBorderDivider);

const COLUMN_TITLE = mergeStylexClassName("", sx.m0, typography.itemTitle, sx.fontSemibold, sx.textFg, sx.phoneTextSectionTitle);

const COLUMN_COUNT = mergeStylexClassName("", sx.mlAuto, sx.shrink0, typography.meta, sx.fontMedium, sx.tabularNums, sx.textFaint);

const LIST =
	mergeStylexClassName("", sx.minH0, sx.flex1, sx.overflowYAuto, sx.px15, sx.pt2, sx.pb3) +
	" " + mergeStylexClassName("[&::-webkit-scrollbar]:hidden", sx.ScrollbarWidthNone);

/** A ticket. Two lines, so it sets its own vertical rhythm rather than taking
 *  the sidebar's one-line row padding; everything else — corner, rail gap,
 *  hover layer, `bg-selected` for the open one — is the shared row grammar. */
const ROW =
	mergeStylexClassName("group", sx.mt05, sx.flex, sx.wFull, sx.cursorPointer, sx.itemsStart, sx.roundedRow, sx.border0) +
	" " + mergeStylexClassName("data-active:bg-selected", sx.bgTransparent, sx.py25, sx.pr3, sx.pl25, sx.textLeft) +
	" " + `${SIDEBAR_RAIL_GAP} ${SIDEBAR_HOVER_LAYER}`;

const ROW_HEAD = mergeStylexClassName("", sx.flex, sx.minW0, sx.itemsBaseline, sx.gap2);

const ROW_NAME =
	mergeStylexClassName("", sx.minW0, sx.flex1, sx.truncate, typography.label, sx.fontMedium, sx.textDim) +
	" " + mergeStylexClassName("group-hover:text-fg group-data-active:text-fg", sx.phoneText15px);

const ROW_TIME = mergeStylexClassName("", sx.shrink0, sx.textRight, typography.meta, sx.tabularNums, sx.textFaint);

const ROW_SUBJECT =
	mergeStylexClassName("", sx.mt1, sx.block, sx.truncate, typography.label, sx.textFaint) +
	" " + mergeStylexClassName("group-data-active:text-dim", sx.phoneText14px);

interface Props {
	/** The open ticket, or null for the list on its own. */
	threadId: string | null;
	/** Live sessions, for the rail dot: a ticket already being worked on wears
	 *  its session's status instead of its priority. */
	sessions: UnifiedSession[];
	/** Open a ticket (drives the route, so the pane is deep-linkable). */
	onSelectThread: (threadId: string) => void;
	/** Navigate into a session — what the pane's triage button resolves to. */
	onOpenSession: (id: string) => void;
}

export function SupportInbox({
	threadId,
	sessions,
	onSelectThread,
	onOpenSession,
}: Props) {
	const isPhone = useIsPhone();
	const [threads, setThreads] = useState<SupportThread[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The same gentle cadence the sidebar polls Plain on (the server caches
	// ~60s). A poll that fails while tickets are already on screen keeps them:
	// the list is the queue as of the last good answer, not an error page.
	useEffect(() => {
		let alive = true;
		const load = () =>
			fetchSupportThreads()
				.then((t) => {
					if (!alive) return;
					setThreads(t);
					setError(null);
				})
				.catch((e) => {
					if (alive) setError(e?.message || "Failed to load the queue");
				});
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			void load();
		}, 60_000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, []);

	// Newest live session per thread — the same rule the sidebar's Support rows
	// use to decide what their dot says.
	const sessionByThread = (() => {
		const m = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived || !s.plainThreadId) continue;
			const prev = m.get(s.plainThreadId);
			if (!prev || s.lastActivity > prev.lastActivity) m.set(s.plainThreadId, s);
		}
		return m;
	})();

	// Phone: list and ticket are separate pages, with a back button between.
	const showList = !isPhone || !threadId;
	const showTicket = !isPhone || !!threadId;

	function renderRow(t: SupportThread) {
		const session = sessionByThread.get(t.id) || null;
		const customer = t.customer.name || t.customer.email || "Unknown";
		const dot =
			(session
				? MINE_STATUS_META.find((m) => m.key === mineStatus(session))?.dotColor
				: SUPPORT_PRIORITY_DOT[t.priority ?? 2]) || "var(--text-faint)";
		const stamp = t.statusChangedAt || t.createdAt;
		return (
			<button
				key={t.id}
				type="button"
				className={ROW}
				data-active={(threadId === t.id && !isPhone) || undefined}
				onClick={() => onSelectThread(t.id)}
			>
				<span className={SIDEBAR_RAIL}>
					<span
						{...stylex.props(sx.size7px, sx.roundedFull)}
						style={{ backgroundColor: dot }}
					/>
				</span>
				<span {...stylex.props(sx.minW0, sx.flex1)}>
					<span className={ROW_HEAD}>
						<span className={ROW_NAME}>{customer}</span>
						{stamp && (
							<span
								className={ROW_TIME}
								title={new Date(stamp).toLocaleString()}
							>
								{shortTime(stamp)}
							</span>
						)}
					</span>
					<span className={ROW_SUBJECT}>
						{t.title || t.previewText || "No subject"}
					</span>
				</span>
			</button>
		);
	}

	return (
		<div {...stylex.props(sx.flex, sx.minH0, sx.flex1)}>
			{showList && (
				<aside className={COLUMN}>
					<div className={SUPPORT_COLUMN_BAR}>
						<h1 className={COLUMN_TITLE}>Support</h1>
						{threads && (
							<span className={COLUMN_COUNT}>{threads.length}</span>
						)}
					</div>
					<div className={LIST}>
						{threads === null ? (
							<LoadingState>Loading tickets…</LoadingState>
						) : error && threads.length === 0 ? (
							<InlineAlert className={mergeStylexOverrideClassName("", sx.mt2)}>{error}</InlineAlert>
						) : threads.length === 0 ? (
							<div {...stylex.props(sx.px3, sx.py6, sx.textCenter, sx.textFaint, typography.label)}>
								Nothing waiting in Plain.
							</div>
						) : (
							SUPPORT_PRIORITY_GROUPS.map((group) => {
								const items = threads.filter(
									(t) => (t.priority ?? 2) === group.p,
								);
								if (items.length === 0) return null;
								return (
									<div key={group.p}>
										{/* The sidebar's lane caption, not a heading of its
										    own: same tokens, same colour per priority. */}
										<div
											className={cn(
												SIDEBAR_GROUP_HEADER,
												SIDEBAR_GROUP_HEADER_INSET,
												SIDEBAR_LANE_HEADER,
												mergeStylexClassName("", sx.cursorDefault, sx.hoverTextDim),
											)}
										>
											<span
												className={cn(
													SIDEBAR_GROUP_NAME,
													SIDEBAR_LANE_NAME,
													group.p <= 1 && group.cls,
												)}
											>
												{group.label}
											</span>
											<span className={cn(SIDEBAR_LANE_COUNT, group.cls)}>
												{items.length}
											</span>
										</div>
										{items.map(renderRow)}
									</div>
								);
							})
						)}
					</div>
				</aside>
			)}

			{showTicket && (
				<section {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.flexCol)}>
					{/* An open ticket brings its own bar, with its subject and
					    customer in it. This is the one for when nothing is open, and
					    for phones, where the app's floating back control sits here
					    and the ticket keeps its header inline — a second back button
					    would be the same gesture twice. Either way the two columns
					    start on one line. */}
					{(!threadId || isPhone) && <div className={SUPPORT_COLUMN_BAR} />}
					{threadId ? (
						<ConversationPane
							key={threadId}
							threadId={threadId}
							onOpenSession={onOpenSession}
							session={sessionByThread.get(threadId) || null}
							headerInBar
						/>
					) : (
						<div {...stylex.props(sx.flex, sx.minH0, sx.flex1, sx.itemsCenter, sx.justifyCenter, sx.p8)}>
							<EmptyState
								icon={<IconMail size={22} />}
								title="No ticket selected"
							>
								Pick a ticket to read the conversation, reply, and set its
								status without leaving this page.
							</EmptyState>
						</div>
					)}
				</section>
			)}
		</div>
	);
}
