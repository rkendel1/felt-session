import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, {
	useState,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import type {
	UnifiedSession,
	Workspace,
	SupportThread,
	FeedDescriptor,
	FeedItem,
} from "../lib/types";
import {
	SIDEBAR_ATTN_COUNT,
	SIDEBAR_BAND_CHEVRON,
	SIDEBAR_BAND_CHEVRON_COLLAPSED,
	SIDEBAR_BAND_LABEL,
	SIDEBAR_BAND_TOGGLE,
	SIDEBAR_BAND_TOGGLE_INSET,
	SIDEBAR_AUTO_COG,
	SIDEBAR_AUTOMATION_RUNS,
	SIDEBAR_GROUP,
	SIDEBAR_GROUP_CHEVRON,
	SIDEBAR_GROUP_CHEVRON_COLLAPSED,
	SIDEBAR_GROUP_COUNT,
	SIDEBAR_GROUP_DOT,
	SIDEBAR_GROUP_HEADER,
	SIDEBAR_GROUP_HEADER_INSET,
	SIDEBAR_GROUP_NAME,
	SIDEBAR_LANE_COUNT,
	SIDEBAR_LANE_HEADER,
	SIDEBAR_LANE_NAME,
	SIDEBAR_DENSITY_VARS,
	SIDEBAR_HEADER_BTN,
	SIDEBAR_HEADER_BTN_DESKTOP,
	SIDEBAR_HEADER_BTN_PHONE,
	SIDEBAR_HEADER_ROW,
	SIDEBAR_HOVER_LAYER,
	SIDEBAR_INDEPENDENT_SCROLL,
	SIDEBAR_INDEPENDENT_SECTION,
	SIDEBAR_LANE_DROP_HOVER,
	SIDEBAR_LANE_EMPTY,
	SIDEBAR_LIST,
	SIDEBAR_NAV_X,
	SIDEBAR_PIN_DRAG_ACTIVE,
	SIDEBAR_PIN_ENTRY,
	SIDEBAR_PIN_ENTRY_DRAGGING,
	SIDEBAR_RAIL,
	SIDEBAR_RAIL_GAP,
	SIDEBAR_REPO_TILE,
	SIDEBAR_STATUS_DOT,
	SIDEBAR_STATUS_GROUP,
	SIDEBAR_STICKY_BAND,
	SIDEBAR_STICKY_BAND_ROW,
	SIDEBAR_STICKY_LANE,
	SIDEBAR_STICKY_LANE_NESTED,
	SIDEBAR_STUCK_BACKING,
	SIDEBAR_SWIPE_ACTION,
	SIDEBAR_SWIPE_ACTION_ARCHIVE,
	SIDEBAR_SWIPE_ACTION_OPEN,
	SIDEBAR_SWIPE_ACTION_STAR,
	SIDEBAR_SWIPE_ACTION_STAR_ON,
	SIDEBAR_SWIPE_ACTION_TRANSITION,
	SIDEBAR_SWIPE_ROW,
	SIDEBAR_WS_ACTION,
	SIDEBAR_WS_ACTIONS,
	SIDEBAR_WS_ACTIONS_HOVER,
	SIDEBAR_WS_ACTIONS_TOUCH,
	SIDEBAR_WS_FACE,
	SIDEBAR_WS_FACES,
	SIDEBAR_WS_ROW,
	SIDEBAR_WS_TIME,
	SIDEBAR_WS_TIME_HOVER,
} from "../lib/sidebar-classes";
import { mobileFilterBtn } from "../lib/app-header-classes";
import {
	ASK_BAND,
	activeSubagentsForWorkspace,
	isAskWorkspace,
	isScratchWorkspace,
	spawnedSessionBelongsInSidebar,
	workspaceMainSession,
	workspaceRowOwnsSelection,
} from "../lib/sidebar-workspaces";
import type { ReviewQueueItem } from "../lib/review-queue";
import {
	fetchOpenPrs,
	fetchFeeds,
	fetchFeedItems,
	closePrPreviewApi,
	PR_CLOSED_EVENT,
	PR_REVIEW_SUBMITTED_EVENT,
	setPlainThreadStatusApi,
	type PrClosedDetail,
	type OpenPr,
} from "../lib/api";
import { sameOpenPrSnapshot } from "../lib/open-pr-snapshot";
import { useCurrentUser } from "./UserPicker";
import { getLane, getLanes, onLanesChanged } from "../lib/lanes";
import { getPins, onPinsChanged, togglePin, reorderPins, unpin } from "../lib/pins";
import {
	SNOOZE_SOMEDAY,
	clearSnooze,
	getSnoozes,
	onSnoozesChanged,
	setSnooze,
	snoozeIsActive,
} from "../lib/snoozes";
import { activityBandFor, type ActivityBand } from "../lib/sidebar-activity";
import { sortInboxByCreation } from "../lib/sidebar-inbox";
import {
	clearHides,
	getHides,
	onHidesChanged,
	partitionHidden,
	setHide,
} from "../lib/hides";
import { Reorder } from "motion/react";
import { getRecents, onRecentsChanged } from "../lib/recents";
import { getReads, isUnread, markRead, markUnread, onReadsChanged } from "../lib/reads";
import { pickUnreadWorkspaceSession } from "../lib/sidebar-unread-session";
import { mentionFor, onMentionsChanged } from "../lib/mentions";
import { TeamLensMenu, useTeamPresence } from "./TeamPresence";
import { sessionPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { getWsTimePref, onWsTimeChanged } from "../lib/workspace-time";
import {
	getSidebarDensity,
	onSidebarDensityChanged,
} from "../lib/sidebar-density";
import {
	getRepoOrder,
	mergeRepoOrder,
	normalizeRepoOrder,
	onRepoOrderChanged,
	replaceVisibleRepoOrder,
	setRepoOrder,
} from "../lib/repo-order";
import { UserAvatar, githubLoginFor } from "./UserAvatar";
import { facepileAvatarStyle, otherViewers } from "../lib/presence";
import { shortTime } from "../lib/time";
import {
	IconChevronDown,
	IconArchive,
	IconMoon,
	IconFilter,
	IconX,
	IconSliders,
	IconCheck,
	IconInbox,
	IconPencil,
	IconPlus,
	IconRobot,
	IconEye,
	IconEyeOff,
	IconStack,
	IconPin,
	IconLink,
	IconMail,
	IconTrash,
	IconChart,
	IconFile,
	IconGlobe,
	IconListCircles,
	IconMessages,
	IconFeed,
	IconPeople,
	IconPullRequest,
} from "./icons";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/confirm";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu, MENU_ICON, Menu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import { RowCardPopup } from "./SidebarRowCards";
import { pointerCanHover } from "../lib/pointer";
import { RepoTile, repoLabel } from "./RepoTile";
import { useIsPhone } from "../hooks/useIsPhone";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
import { matchesShortcut, shortcutLabel } from "../lib/shortcuts";
import { PrRow } from "./PrRow";
import {
	buildReviewQueue,
	personKey,
	reviewAskerFor,
	wsPrRequestsReviewFrom,
} from "../lib/review-queue";
import { personNameForKey, usePeople } from "../lib/people";
import {
	canonicalNames,
	ownerKey,
	ownerKeyOf,
	sessionOwners,
} from "../lib/session-owner";
import {
	PERSON_RECENT_ACTIVITY_MS,
	sidebarPersonSessions,
} from "../lib/sidebar-people";
import {
	placeSidebarRows,
	rowAutoCreatedInLens,
	rowOriginSource,
	rowWasAgentStarted,
	rowWasAutoCreated,
	rowsAtPlacement,
} from "../lib/sidebar-placement";
import { ReviewAskerFace } from "./ReviewAskerFace";
import {
	readHiddenSidebarTools,
	getSidebarToolOrder,
	mergeSidebarToolOrder,
	replaceVisibleSidebarToolOrder,
	setSidebarToolOrder,
	setSidebarToolVisible,
	onSidebarToolsChanged,
	toolFitsViewport,
	SIDEBAR_TOOL_LABELS,
	type SidebarToolId,
} from "../lib/sidebar-tools";
import {
	onSidebarFeedsChanged,
	readHiddenSidebarFeeds,
	setSidebarFeedVisible,
} from "../lib/sidebar-feeds";
import {
	PLAIN_ID,
	SUPPORT_SURFACE_OPTIONS,
	setSupportSurface,
	supportSurfaceOf,
} from "../lib/support-surface";
import {
	DEFAULT_PROJECT,
	EXPANDED_KEY,
	FEED_FILTERS_KEY,
	SUPPORT_PRIORITY_GROUPS,
	dget,
	includesEmptyRepoBands,
	personLensFilter,
	personLensValue,
	readExpanded,
	readFeedFilters,
	setFilter,
	useSidebarFilter,
	sessionPrKeys,
	sessionRepo,
	type FeedFilterValues,
} from "../lib/sidebar-filter";
import {
	AGENT_PERSON_KEY,
	automationInPersonLens,
	automationInRepoLens,
	HOUSE_AUTOMATION,
} from "../lib/automation-audience";
import { AGENT_NAME } from "../lib/brand";
import { useAutomationOverview } from "../lib/automation-overview";
import {
	isClaimed,
	mineStatus,
	ownedBy,
	pinnedLane,
	prLaneForSessions,
	stripPrTitlePrefix,
	workspaceRunNeedingAttention,
} from "../lib/sidebar-lanes";
import { sessionCarriesPr, sessionHasPr } from "../lib/session-prs";
import { sessionHasWorkspace } from "../lib/session-workspace";
import { workspaceCarriesPr } from "../lib/pr-workspace";
import {
	nextRenderedSidebarChat,
	nextRenderedSidebarItem,
	nextUnreadRenderedWorkspaceItem,
} from "../lib/sidebar-next";
import { previewSidebarSelection } from "../lib/sidebar-selection";
import {
	LONG_PRESS_MS,
	LONG_PRESS_SLOP,
	SWIPE_AXIS_LOCK_PX,
	SWIPE_COMMIT_MS,
	SWIPE_OPEN_THRESHOLD,
	SWIPE_REVEAL_PX,
	clampSwipe,
	editableOwnsCaretChord,
	editableSwallowsArchiveChord,
	fullSwipeThreshold,
	swipeActionForOffset,
	swipeCommitOffset,
	type SwipeAction,
	type SwipeState,
} from "../lib/sidebar-swipe";
import {
	MINE_STATUS_META,
	type CtxEntry,
	type Group,
	type GroupBand,
	type MineStatus,
	type OpenNextSidebarItem,
	type Props,
	type SidebarHandle,
	type WsRow,
} from "../lib/sidebar-types";
import { FeedFilterMenu, FeedRow, SupportRow } from "./sidebar/FeedRows";
import { FilterPopover, RepoFilterChip } from "./sidebar/Filters";
import {
	RunTicker,
	SnoozeBadge,
	WsCardBody,
	WsMobileSheet,
	WsPrStatusMark,
	WsStatusMark,
} from "./sidebar/HoverCards";
import { AutoCreatedMark } from "./sidebar/AutoCreatedMark";
import { OriginMark } from "./sidebar/OriginMark";
import { AutomationReportRow } from "./sidebar/AutomationReportRow";
import { ActiveSubagentRows } from "./sidebar/ActiveSubagentRows";
import { DraftRow } from "./sidebar/DraftRow";
import { WorkspaceDraftIndicator } from "./sidebar/WorkspaceDraftIndicator";
import { SidebarCtxMenu } from "./sidebar/SidebarCtxMenu";
import { SidebarToolRows, SidebarToolsMenu } from "./sidebar/SidebarToolsMenu";
import { SidebarCustomizeDialog } from "./sidebar/SidebarCustomizeDialog";
import { SetupWidget } from "./sidebar/SetupWidget";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { EmptyState, ListSkeleton } from "../ui/state";
import {
	SIDEBAR_ROW,
	SIDEBAR_ROW_TITLE,
	SidebarItem,
} from "./sidebar/SidebarItem";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	translateXPx: {
			translate: "1px 0"
	},
	TranslateYPx: {
			translate: "0 -1px"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))",

		cornerShape: "var(--cs)",},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	bgBg: {
			backgroundColor: "var(--bg)"
	},
	px3px: {
			paddingInline: "3px"
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
			right: "calc(4px * -1)"
	},
	Bottom1: {
			bottom: "calc(4px * -1)"
	},
	size3: {
			width: "calc(4px * 3)",
			height: "calc(4px * 3)"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)",

		cornerShape: "round",},
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
	mb2: {
			marginBottom: "calc(4px * 2)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	flex01Auto: {
			flex: "0 1 auto"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	gap15: {
			gap: "calc(4px * 1.5)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	size7: {
			width: "calc(4px * 7)",
			height: "calc(4px * 7)"
	},
	opacity100: {
			opacity: "100%"
	},
	duration150: {
			transitionDuration: "150ms"
	},
	mt05: {
			marginTop: "calc(4px * 0.5)"
	},
	px3: {
			paddingInline: "calc(4px * 3)"
	},
	py2: {
			paddingBlock: "calc(4px * 2)"
	},
	px7px: {
			paddingInline: "7px"
	},
	pyPx: {
			paddingBlock: "1px"
	},
	leading15: {
			lineHeight: "1.5"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	truncate: {
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
	},
	right2: {
			right: "calc(4px * 2)"
	},
	top12: {
			top: "calc(1 / 2 * 100%)"
	},
	TranslateY12: {
			translate: "0 calc(calc(1 / 2 * 100%) * -1)"
	},
	gap2: {
			gap: "calc(4px * 2)"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading, var(--text-sm--line-height))"
	},
	textFg: {
			color: "var(--text)"
	},
	translateY05px: {
			translate: "0 0.5px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	size10: {
			width: "calc(4px * 10)",
			height: "calc(4px * 10)"
	},
	border0: {
			borderStyle: "solid",
			borderWidth: "0px"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	block: {
			display: "block"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	flexNone: {
			flex: "none"
	},
	mx4: {
			marginInline: "calc(4px * 4)"
	},
	mt2px: {
			marginTop: "-2px"
	},
	my7: {
			marginBlock: "calc(4px * 7)"
	},
	py0: {
			paddingBlock: "0"
	},
	textRed: {
			color: "var(--red)"
	},
	textCenter: {
			textAlign: "center"
	},
	leading14: {
			lineHeight: "1.4"
	},
	minH360px: {
			minHeight: "360px"
	},
	flexCol: {
			flexDirection: "column"
	},
	px7: {
			paddingInline: "calc(4px * 7)"
	},
	py12: {
			paddingBlock: "calc(4px * 12)"
	},
	mb3: {
			marginBottom: "calc(4px * 3)"
	},
	leading115: {
			lineHeight: "1.15"
	},
	tracking002em: {
			letterSpacing: "-0.02em"
	},
	mt1: {
			marginTop: "4px"
	},
	maxW26ch: {
			maxWidth: "26ch"
	},
	leading145: {
			lineHeight: "1.45"
	},
	textPretty: {
			textWrap: "pretty"
	},
	mt4: {
			marginTop: "calc(4px * 4)"
	},
	gap1: {
			gap: "4px"
	},
	px4: {
			paddingInline: "calc(4px * 4)"
	},
	pb1: {
			paddingBottom: "4px"
	},
	pt05: {
			paddingTop: "calc(4px * 0.5)"
	},
});

// Re-exported for App.tsx, which holds the sidebar ref.
export type { SidebarHandle } from "../lib/sidebar-types";

const AUTOMATION_COLOR = "#d29922";

type WorkspaceMenuTarget = {
	id: string;
	x: number;
	y: number;
	source: HTMLButtonElement;
};

function WorkspaceContextMenu({
	menu,
	workspace,
	row,
	pins,
	currentUser,
	activeSnoozeKeys,
	snoozes,
	hiddenRowKeys,
	onPinsChange,
	onSetStatus,
	onSnooze,
	onStartWorkspaceRename,
	onStartSessionRename,
	onToast,
	onOpenReview,
	onHide,
	onArchive,
	onDeleteDraft,
	onClose,
}: {
	menu: WorkspaceMenuTarget;
	workspace?: Workspace;
	row?: WsRow;
	pins: string[];
	currentUser: string;
	activeSnoozeKeys: Set<string>;
	snoozes: Record<string, string>;
	hiddenRowKeys: Set<string>;
	onPinsChange: (pins: string[]) => void;
	onSetStatus: Props["onSetStatus"];
	onSnooze: (row: WsRow, until: string | null) => void;
	onStartWorkspaceRename: (workspace: Workspace) => void;
	onStartSessionRename: (session: UnifiedSession) => void;
	onToast?: (message: string) => void;
	onOpenReview: (session: UnifiedSession) => void;
	onHide: (row: WsRow, hidden: boolean) => void;
	onArchive: (row: WsRow, source: HTMLButtonElement) => void;
	onDeleteDraft: (workspace: Workspace) => void;
	onClose: () => void;
}) {
	const sessions = row?.sessions ?? [];
	const first = sessions[0];
	const pinKey = workspace ? `workspace:${workspace.id}` : menu.id;
	const pinnedKeys = [
		pinKey,
		...(row
			? [
					row.key,
					...row.sessions.flatMap((session) => [
						session.id,
						...(session.aliasIds || []),
					]),
				]
			: []),
	].filter((key, index, all) => pins.includes(key) && all.indexOf(key) === index);
	const pinned = pinnedKeys.length > 0;
	const togglePinNow = () => {
		if (!pinned) {
			onPinsChange(togglePin(pinKey));
			return;
		}
		let next = pins;
		for (const key of pinnedKeys) next = togglePin(key);
		onPinsChange(next);
	};
	const anyManual = sessions.some((session) => pinnedLane(session));
	const sharedManual =
		anyManual &&
		sessions.every((session) => pinnedLane(session) === pinnedLane(sessions[0]))
			? (pinnedLane(sessions[0]) ?? null)
			: null;
	const entries: CtxEntry[] = [];
	const rowUnread = row?.unread ?? false;
	if (sessions.length > 0)
		entries.push({
			kind: "item",
			icon: <IconMail size={20} />,
			label: rowUnread ? "Mark as read" : "Mark as unread",
			onClick: () =>
				sessions.forEach((session) =>
					rowUnread
						? markRead(session.id, session.lastActivity)
						: markUnread(session.id),
				),
		});
	const rowClaimed = sessions.some((session) => isClaimed(session));
	const rowMine = sessions.some((session) => ownedBy(session, currentUser));
	if (sessions.length > 0 && (!rowMine || rowClaimed))
		entries.push({
			kind: "item",
			icon: <IconInbox size={20} />,
			label: rowClaimed ? "Remove from my workspaces" : "Add to my workspaces",
			onClick: () => onSetStatus(sessions, rowClaimed ? null : "mine"),
		});
	entries.push({
		kind: "item",
		icon: <IconPin size={20} fill={pinned ? "currentColor" : "none"} />,
		label: pinned ? "Unpin" : "Pin",
		onClick: togglePinNow,
	});
	if (sessions.length > 0)
		entries.push({
			kind: "status",
			current: sharedManual,
			onPick: (status) => onSetStatus(sessions, status),
		});
	if (row && sessions.length > 0)
		entries.push({
			kind: "snooze",
			until: activeSnoozeKeys.has(row.key) ? (snoozes[row.key] ?? null) : null,
			onPick: (until) => onSnooze(row, until),
		});
	if (workspace)
		entries.push({
			kind: "item",
			icon: <IconPencil size={20} />,
			label: "Rename",
			onClick: () => onStartWorkspaceRename(workspace),
		});
	else if (first)
		entries.push({
			kind: "item",
			icon: <IconPencil size={20} />,
			label: "Rename",
			onClick: () => onStartSessionRename(first),
		});
	if (first)
		entries.push({
			kind: "item",
			icon: <IconLink size={20} />,
			label: "Copy link",
			shortcut: shortcutLabel("session-copy-link") ?? undefined,
			onClick: () =>
				copyToClipboard(absoluteLink(sessionPath(first)), () => onToast?.("Link copied")),
		});
	if (first && (first.worktreeDir || first.branch))
		entries.push({
			kind: "item",
			icon: <IconEye size={20} />,
			label: "Open review",
			onClick: () => onOpenReview(first),
		});
	if (row && sessions.length > 0) {
		entries.push({ kind: "sep" });
		const hidden = hiddenRowKeys.has(row.key);
		entries.push({
			kind: "item",
			icon: hidden ? <IconEye size={20} /> : <IconEyeOff size={20} />,
			label: hidden ? "Restore to my sidebar" : "Hide from my sidebar",
			onClick: () => onHide(row, hidden),
		});
		entries.push({
			kind: "item",
			icon: <IconArchive size={20} />,
			label: "Archive",
			onClick: () => onArchive(row, menu.source),
		});
	} else if (workspace) {
		entries.push({ kind: "sep" });
		entries.push({
			kind: "item",
			icon: <IconTrash size={20} />,
			danger: true,
			label: "Delete draft",
			onClick: () => onDeleteDraft(workspace),
		});
	}
	return (
		<SidebarCtxMenu
			x={menu.x}
			y={menu.y}
			entries={entries}
			onClose={onClose}
		/>
	);
}

export const Sidebar = React.forwardRef<SidebarHandle, Props>(function Sidebar({
	sessions,
	registeredRepos,
	directToMainBranches,
	sessionsError,
	sessionsLoading,
	onRetrySessions,
	workspaceDataReady,
	workspaces,
	selectedId,
	prsActive,
	onOpenPrs,
	feedActive,
	onOpenFeed,
	connected,
	onOpenSettings,
	tasksActive,
	onOpenTasks,
	taskCount = 0,
	onOpenAutomation,
	onOpenPrItem,
	selectedWorkspaceId = null,
	plainActive,
	onOpenPlain,
	supportTinderActive,
	onOpenSupportTinder,
	reportsActive,
	onOpenReports,
	analyticsActive,
	onOpenAnalytics,
	onSelect,
	onOpenReview,
	onOpenTicket,
	onOpenFeedItem,
	onNewSession,
	onNewSessionInRepo,
	showDraftRow,
	draftRowActive,
	onOpenDraft,
	onOpenWorkspace,
	onRenameWorkspace,
	onDeleteWorkspace,
	onOpenArchived,
	archivedActive,
	onOpenCatchUp,
	catchUpActive,
	onNextChatAvailableChange,
	onArchive,
	onArchiveWorkspace,
	onRename,
	onSetStatus,
	teamViewing = [],
	headerActionsEl = null,
	onToast,
}, ref) {
	const isPhone = useIsPhone();
	const [search, setSearch] = useState("");
	// The compact People list has one real-time boundary: an idle run leaves it
	// fifteen minutes after its last activity. Wake only at the next boundary
	// rather than polling and rebuilding this large sidebar every minute.
	const [peopleActivityNow, setPeopleActivityNow] = useState(Date.now);
	useEffect(() => {
		const now = Date.now();
		let nextExpiry = Number.POSITIVE_INFINITY;
		for (const session of sessions) {
			if (session.isRunning || !session.ran) continue;
			const lastActivity = Date.parse(session.lastActivity || "");
			if (!Number.isFinite(lastActivity)) continue;
			const expiry = lastActivity + PERSON_RECENT_ACTIVITY_MS;
			if (expiry > now && expiry < nextExpiry) nextExpiry = expiry;
		}
		if (!Number.isFinite(nextExpiry)) return;
		const timer = window.setTimeout(
			() => setPeopleActivityNow(Date.now()),
			Math.min(2_147_483_647, Math.max(0, nextExpiry - now + 50)),
		);
		return () => window.clearTimeout(timer);
	}, [sessions, peopleActivityNow]);
	// Groups are collapsed by default; the expanded set persists per browser
	const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
	const [hiddenTools, setHiddenTools] = useState(readHiddenSidebarTools);
	const [toolOrder, setToolOrderState] = useState(getSidebarToolOrder);
	const [hiddenFeeds, setHiddenFeeds] = useState(readHiddenSidebarFeeds);
	const [savedRepoOrder, setSavedRepoOrder] = useState(getRepoOrder);
	useEffect(
		() => onRepoOrderChanged(() => setSavedRepoOrder(getRepoOrder())),
		[],
	);
	const [repoOrderDraft, setRepoOrderDraft] = useState<string[] | null>(null);
	const repoOrderAtDragStart = useRef<string[] | null>(null);
	const repoOrderPending = useRef<string[] | null>(null);
	const repoVisualOrder = useRef<string[] | null>(null);
	const repoDragging = useRef<string | null>(null);
	const [repoDragKey, setRepoDragKey] = useState<string | null>(null);
	const repoAutoScrollFrame = useRef<number | null>(null);
	const repoAutoScrollSpeed = useRef(0);
	const repoAutoScrollContainer = useRef<HTMLElement | null>(null);
	const repoJustDragged = useRef(false);
	const stopRepoAutoScroll = () => {
		if (repoAutoScrollFrame.current !== null)
			cancelAnimationFrame(repoAutoScrollFrame.current);
		repoAutoScrollFrame.current = null;
		repoAutoScrollSpeed.current = 0;
		repoAutoScrollContainer.current = null;
	};
	const tickRepoAutoScroll = () => {
		const container = repoAutoScrollContainer.current;
		if (!container || repoAutoScrollSpeed.current === 0) {
			repoAutoScrollFrame.current = null;
			return;
		}
		container.scrollTop += repoAutoScrollSpeed.current;
		repoAutoScrollFrame.current = requestAnimationFrame(tickRepoAutoScroll);
	};
	const handleRepoAutoScroll = (event: React.DragEvent<HTMLDivElement>) => {
		if (!repoDragging.current) return;
		event.preventDefault();
		const container = event.currentTarget;
		const rect = container.getBoundingClientRect();
		const edge = Math.min(96, rect.height * 0.18);
		const fromTop = event.clientY - rect.top;
		const fromBottom = rect.bottom - event.clientY;
		const maxSpeed = 18;
		let speed = 0;
		if (fromTop < edge)
			speed = -Math.ceil(maxSpeed * (1 - Math.max(0, fromTop) / edge));
		else if (fromBottom < edge)
			speed = Math.ceil(maxSpeed * (1 - Math.max(0, fromBottom) / edge));
		if (speed === 0) {
			stopRepoAutoScroll();
			return;
		}
		repoAutoScrollContainer.current = container;
		repoAutoScrollSpeed.current = speed;
		if (repoAutoScrollFrame.current === null)
			repoAutoScrollFrame.current = requestAnimationFrame(tickRepoAutoScroll);
	};
	useEffect(
		() => () => {
			if (repoAutoScrollFrame.current !== null)
				cancelAnimationFrame(repoAutoScrollFrame.current);
		},
		[],
	);
	const [pins, setPins] = useState<string[]>(getPins);
	// Per-user workspace snoozes (row key → ISO until). An overlay like pins:
	// actively-snoozed rows park in the Snoozed section; the wake sweep below
	// prunes lapsed entries and marks their rows unread.
	const [snoozes, setSnoozesState] = useState<Record<string, string>>(
		getSnoozes,
	);
	// Per-user sidebar hides (row key → ISO hidden-at). The personal
	// counterpart to Archive, which is global: a hidden row leaves only THIS
	// user's sidebar, and the session keeps running for everyone else.
	const [hides, setHidesState] = useState<Record<string, string>>(getHides);
	// Drag-to-reorder in the Pinned band. onReorder fires continuously during a
	// drag, so the in-flight order lives in local state (pinOrderDraft) and only
	// commits to the pins store on drop — mirroring the composer queue's pattern.
	// pinDragKey marks the floating row (background + stacking); pinJustDragged
	// swallows the click that lands on the row right after a drop.
	const [pinOrderDraft, setPinOrderDraft] = useState<string[] | null>(null);
	const pinOrderPending = useRef<string[] | null>(null);
	const [pinDragKey, setPinDragKey] = useState<string | null>(null);
	const pinJustDragged = useRef(false);
	// Drag-into-lane: while a Pinned row is mid-drag, the status lanes below
	// double as drop targets (per-repo lanes only for the row's own repo).
	// pinDragMeta carries the dragged entry's sessions/repo/pin keys; laneDropHover
	// marks the lane under the pointer. Both keep a ref twin so the drag-end
	// commit never reads a stale closure mid-batch.
	type PinDragMeta = {
		repo: string | null;
		sessions: UnifiedSession[];
		pinKeys: string[];
	};
	type LaneDropTarget = { gkey: string; lane: MineStatus };
	const [pinDragMeta, setPinDragMeta] = useState<PinDragMeta | null>(null);
	const pinDragMetaRef = useRef<PinDragMeta | null>(null);
	const [laneDropHover, setLaneDropHover] = useState<LaneDropTarget | null>(
		null,
	);
	const laneDropHoverRef = useRef<LaneDropTarget | null>(null);

	// The lane rects, in DOM order, taken once per drag. Motion writes the
	// dragged row's transform on every pointer frame, so measuring the 40-odd
	// targets inside the move handler forced a fresh layout on each of them.
	// Nothing under the pointer moves during a drag: the lanes materialize
	// before it starts, and a hover only repaints (ring + fill).
	type LaneDropRect = LaneDropTarget & { repo: string; rect: DOMRect };
	const laneDropRectsRef = useRef<LaneDropRect[] | null>(null);
	function measureLaneDropTargets() {
		const targets =
			sidebarScrollRef.current?.querySelectorAll<HTMLElement>(
				"[data-lane-drop]",
			) ?? [];
		const rects: LaneDropRect[] = [];
		for (const el of targets)
			rects.push({
				gkey: el.dataset.laneDrop!,
				lane: el.dataset.laneStatus as MineStatus,
				repo: el.dataset.laneRepo || "",
				rect: el.getBoundingClientRect(),
			});
		laneDropRectsRef.current = rects;
	}

	// Hit-test the pointer against the lane drop targets below the Pinned band
	// (they carry data-lane-* attributes while a drag is live). Geometric rect
	// checks instead of elementFromPoint — the dragged row itself rides under
	// the pointer and would swallow the hit.
	function updateLaneDropHover(clientX: number, clientY: number) {
		const meta = pinDragMetaRef.current;
		let next: LaneDropTarget | null = null;
		if (meta && meta.sessions.length > 0) {
			// Null only for a move that beat the snapshot effect below.
			if (!laneDropRectsRef.current) measureLaneDropTargets();
			for (const target of laneDropRectsRef.current ?? []) {
				const r = target.rect;
				const inside =
					clientX >= r.left &&
					clientX <= r.right &&
					clientY >= r.top &&
					clientY <= r.bottom;
				if (!inside) continue;
				// Per-repo lanes only take rows of their own repo; the global
				// lanes (no data-lane-repo) take anything.
				if (target.repo && target.repo !== meta.repo) continue;
				next = { gkey: target.gkey, lane: target.lane };
				break;
			}
		}
		if (laneDropHoverRef.current?.gkey !== next?.gkey) {
			laneDropHoverRef.current = next;
			setLaneDropHover(next);
		}
	}
	// The targets exist only once pinDragMeta has rendered them (empty lanes
	// materialize with it), so the snapshot waits for that commit. Scrolling or
	// resizing the rail underneath a live drag is what can move them.
	useEffect(() => {
		if (!pinDragMeta || pinDragMeta.sessions.length === 0) {
			laneDropRectsRef.current = null;
			return;
		}
		measureLaneDropTargets();
		const root = sidebarScrollRef.current;
		// Drop the snapshot rather than re-take it here: the next move re-takes
		// it, so a burst of scrolling or row updates costs one measurement
		// instead of one each. A poll landing mid-drag can move a row between
		// lanes, which is why the rows are watched at all.
		const invalidate = () => {
			laneDropRectsRef.current = null;
		};
		root?.addEventListener("scroll", invalidate, { passive: true });
		window.addEventListener("resize", invalidate);
		const rowObserver = new MutationObserver(invalidate);
		if (root) rowObserver.observe(root, { childList: true, subtree: true });
		return () => {
			root?.removeEventListener("scroll", invalidate);
			window.removeEventListener("resize", invalidate);
			rowObserver.disconnect();
			laneDropRectsRef.current = null;
		};
	}, [pinDragMeta]);
	const [recents, setRecents] = useState<string[]>(getRecents);
	// Per-session last-read marks, driving the unread dot. Kept in sync via the
	// same event the viewer fires when it marks a session read.
	const [reads, setReads] = useState(getReads);
	const currentUser = useCurrentUser();
	// The team with live status attached, for the Home entry's face pile.
	const team = useTeamPresence({ sessions, teamViewing, currentUser });
	useEffect(
		() =>
			onSidebarToolsChanged(() => {
				setHiddenTools(readHiddenSidebarTools());
				setToolOrderState(getSidebarToolOrder());
			}),
		[],
	);
	useEffect(
		() => onSidebarFeedsChanged(() => setHiddenFeeds(readHiddenSidebarFeeds())),
		[],
	);
	const sidebarScrollRef = useRef<HTMLDivElement>(null);

	// CSS has no interoperable :stuck selector. Track the shared sidebar
	// scrollport instead so section/lane labels can stay transparent in-flow and
	// gain an opaque surface only while position:sticky is actively pinning them.
	useLayoutEffect(() => {
		const root = sidebarScrollRef.current;
		if (!root) return;
		let frame = 0;
		// Every heading that can pin marks itself with `data-sticky-head`, so
		// this listener never has to know which family it belongs to (band,
		// lane, repo, status) — or survive the class names being restyled.
		const selector = "[data-sticky-head]";
		// What a header's own styles say: whether it pins at all, and the offset
		// it pins at. A scroll frame cannot change either, and reading them is a
		// style recalc per header, so they are cached here and re-read only when
		// the list, the rail or the density actually changes. `stuck` is the
		// class as last applied, so an unchanged header costs no write.
		type StickyHead = {
			el: HTMLElement;
			parent: HTMLElement;
			sticky: boolean;
			top: number;
			stuck: boolean;
		};
		let heads: StickyHead[] = [];
		let stale = true;
		const rescan = () => {
			stale = false;
			const applied = new Map(heads.map((h) => [h.el, h.stuck]));
			heads = [];
			for (const el of root.querySelectorAll<HTMLElement>(selector)) {
				const style = getComputedStyle(el);
				const parent = el.parentElement;
				heads.push({
					el,
					parent: parent ?? el,
					sticky: style.position === "sticky" && !!parent,
					top: Number.parseFloat(style.top) || 0,
					stuck: applied.get(el) ?? el.classList.contains("is-stuck"),
				});
			}
		};

		const update = () => {
			frame = 0;
			if (stale) rescan();
			// One read pass, then one write pass. A toggle between two rect
			// reads dirties layout for every header still to be measured, which
			// is what made a scroll frame over ~80 headers cost as much as it
			// did.
			const rootTop = root.getBoundingClientRect().top;
			const next: boolean[] = [];
			for (const head of heads) {
				if (!head.sticky) {
					next.push(false);
					continue;
				}
				const rect = head.el.getBoundingClientRect();
				const pinned = rect.top <= rootTop + head.top + 0.5;
				// Pin-line position alone also matches a header that naturally
				// RESTS at its sticky offset (the first section at scrollTop 0 —
				// the solid-pill-while-unscrolled bug), so additionally require
				// real displacement from the parent. All of these headers sit
				// flush with their parent's top in static layout, so a positive
				// delta means sticky is actively holding the header back. (Don't
				// try offsetTop for this: Chromium reports the displaced sticky
				// position there, not static layout.)
				const displaced =
					rect.top - head.parent.getBoundingClientRect().top > 1.5;
				next.push(pinned && displaced);
			}
			for (let i = 0; i < heads.length; i++) {
				const head = heads[i]!;
				const stuck = next[i]!;
				if (head.stuck === stuck) continue;
				head.stuck = stuck;
				head.el.classList.toggle("is-stuck", stuck);
			}
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		// Mark rather than re-read: a burst of row updates in one frame then
		// costs one scan at rAF time instead of one per mutation record.
		const invalidate = () => {
			stale = true;
			schedule();
		};

		update();
		root.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", invalidate);
		const resizeObserver = new ResizeObserver(invalidate);
		resizeObserver.observe(root);
		const mutationObserver = new MutationObserver(invalidate);
		mutationObserver.observe(root, { childList: true, subtree: true });
		// Density retunes the offsets these headers pin at (--sidebar-band-slot)
		// without touching the list, so the cache has to be re-read for it too.
		const densityObserver = new MutationObserver(invalidate);
		densityObserver.observe(root, {
			attributes: true,
			attributeFilter: ["data-density"],
		});

		return () => {
			root.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", invalidate);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			densityObserver.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, []);

	// Filter popover (group by / repo / sort) — its choices persist together.
	// The person lens is shared with Home's facepile (lib/sidebar-filter), so
	// a face picked there is the sidebar you come back to.
	const filter = useSidebarFilter();
	const [filterOpen, setFilterOpen] = useState(false);
	const [customizeOpen, setCustomizeOpen] = useState(false);
	const [filterButton, setFilterButton] = useState<HTMLButtonElement | null>(null);
	// The phone stand-in for the header filter button (portaled into the top
	// bar next to Search). The popover anchors to whichever button is live.
	const [mobileFilterButton, setMobileFilterButton] =
		useState<HTMLButtonElement | null>(null);
	// The active repo-filter chip prefers to sit inline in the "My sessions"
	// header (right after the title); it drops to its own row only when the
	// sidebar is too narrow to fit it there. `repoInline` is decided by measuring
	// the header against an off-layout probe copy of the chip, so toggling it can't
	// feed back into the measurement (title/actions/probe widths don't depend on
	// where the real chip lands).
	const [repoInline, setRepoInline] = useState(true);
	const headRef = useRef<HTMLDivElement>(null);
	// The heading's own width, whatever is standing in for it: the caption in
	// your own sidebar, the whole person strip in someone else's.
	const titleRef = useRef<HTMLElement | null>(null);
	const actionsRef = useRef<HTMLDivElement>(null);
	const probeRef = useRef<HTMLSpanElement>(null);
	// Client-observed run starts, keyed by workspace-row key — the fallback when
	// the server hasn't stamped runStartedAt yet (external CLI runs, or the brief
	// gap between isRunning flipping via WS and the next sessions poll). Entries
	// are pruned once a row stops running so a later run starts its clock fresh.
	const [runStartSeen, setRunStartSeen] = useState<Map<string, number>>(
		() => new Map(),
	);
	useLayoutEffect(() => {
		if (filter.repo === "all") return;
		const measure = () => {
			const head = headRef.current;
			const title = titleRef.current;
			const actions = actionsRef.current;
			const probe = probeRef.current;
			if (!head || !title || !actions || !probe) return;
			const GAP = 6; // the header row's own gap-1.5, in px
			const MARGIN = 8; // breathing room so it never crowds the buttons
			const avail =
				head.clientWidth -
				title.offsetWidth -
				actions.offsetWidth -
				GAP * 2 -
				MARGIN;
			setRepoInline(probe.offsetWidth <= avail);
		};
		measure();
		const ro = new ResizeObserver(measure);
		if (headRef.current) ro.observe(headRef.current);
		return () => ro.disconnect();
		// filter.person changes the title text ("X's workspaces"), so re-measure.
	}, [filter.repo, filter.person]);

	useEffect(() => onPinsChanged(() => setPins(getPins())), []);
	useEffect(() => onSnoozesChanged(() => setSnoozesState(getSnoozes())), []);
	useEffect(() => onHidesChanged(() => setHidesState(getHides())), []);
	// Per-user lanes (lib/lanes.ts). mineStatus/pinnedLane read the lib cache
	// directly; this state exists to re-render (and re-derive the memos below)
	// when your lanes change.
	const [lanes, setLanesState] = useState<Record<string, string>>(getLanes);
	useEffect(() => onLanesChanged(() => setLanesState(getLanes())), []);
	useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);
	useEffect(() => onReadsChanged(() => setReads(getReads())), []);
	// Sessions where a teammate tagged you. Server-owned, so it re-renders on
	// the socket push as well as on your own clears. The counter is a render
	// trigger: the rows read mentionFor() during render, so a push that
	// changes nothing else must still rebuild them.
	const [mentionsRev, setMentionsRev] = useState(0);
	useEffect(() => onMentionsChanged(() => setMentionsRev((n) => n + 1)), []);
	// Draft pencils subscribe per workspace row, so typing into one composer does
	// not rebuild the complete sidebar inventory.
	// Opt-in "last used" time badge on workspace rows (off / always / on hover).
	const [wsTimePref, setWsTimePref] = useState(getWsTimePref);
	useEffect(() => onWsTimeChanged(() => setWsTimePref(getWsTimePref())), []);
	const [density, setDensity] = useState(getSidebarDensity);
	useEffect(
		() => onSidebarDensityChanged(() => setDensity(getSidebarDensity())),
		[],
	);

	// Right-click menu on a workspace row (mark unread / pin / status / rename /
	// copy link / delete), and inline rename (double-click the project name).
	const [workspaceMenu, setWorkspaceMenu] = useState<{
		id: string;
		x: number;
		y: number;
		source: HTMLButtonElement;
	} | null>(null);
	const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
	const [workspaceDraft, setWorkspaceDraft] = useState("");
	function commitWorkspaceRename() {
		if (editingWorkspaceId) {
			const name = workspaceDraft.trim();
			if (name) onRenameWorkspace(editingWorkspaceId, name);
		}
		setEditingWorkspaceId(null);
	}
	// Inline rename for workspace-less rows (slack/linear/solo sessions). These
	// used window.prompt(), which iOS standalone PWAs silently suppress —
	// Rename tapped, nothing happened. Same inline editor as workspace rows;
	// an empty commit clears the manual title back to the derived one.
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [sessionDraft, setSessionDraft] = useState("");
	function startSessionRename(session: { id: string; title: string }) {
		setSessionDraft(session.title);
		setEditingSessionId(session.id);
	}
	function commitSessionRename(session: UnifiedSession) {
		if (editingSessionId) onRename(session, sessionDraft.trim());
		setEditingSessionId(null);
	}
	/** Is this row's title currently being inline-edited (workspace or session)? */
	function rowRenameEditing(row: WsRow): boolean {
		return row.workspace
			? editingWorkspaceId === row.workspace.id
			: !!row.sessions[0] && editingSessionId === row.sessions[0].id;
	}
	useEffect(() => {
		if (!workspaceMenu) return;
		const close = () => setWorkspaceMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [workspaceMenu]);

	// Right-click menu on the sidebar itself — a band heading, the gap between
	// rows, the empty space under the list — listing every tool and source so a
	// hidden one can come back. Rows own their own menus and stop the event
	// before it gets here. Without this, hiding the last tool takes the Tools
	// band and its ••• menu off screen with it, and Settings is the only way
	// back. It is a Base UI ContextMenu around the scrollport (SidebarToolsMenu
	// is its popup), so opening, dismissal and the Support submenu are the
	// primitive's rather than a hand-written pair of window listeners.

	// Catch-up badge: how many of *my* unread workspaces the deck would walk
	// through (distinct workspace groups, same grouping the deck uses) — so the
	// count matches the "N Left" it opens on.
	const catchUpCount = (() => {
		const user = currentUser.toLowerCase();
		const groups = new Set<string>();
		for (const s of sessions) {
			if (s.archived || s.automation) continue;
			if (!s.startedBy || s.startedBy.toLowerCase() !== user) continue;
			if (!isUnread(s.id, s.lastActivity, reads)) continue;
			groups.add(s.workspaceId ? `ws:${s.workspaceId}` : `session:${s.id}`);
		}
		return groups.size;
	})();

	// The repo-wide open-PR list (every open PR, session or not), from the
	// server's batched cache. Null until the first fetch lands — the rows memo
	// falls back to session-derived PRs so the section still renders if the
	// endpoint is unreachable.
	const [openPrs, setOpenPrs] = useState<OpenPr[] | null>(null);
	const prCloseGeneration = useRef(0);
	const closedPrTombstones = useRef(new Map<string, number>());
	const openPrRequestSequence = useRef(0);
	const latestOpenPrResponse = useRef(0);
	useEffect(() => {
		let alive = true;
		const load = () => {
			if (document.hidden) return Promise.resolve();
			const requestSequence = ++openPrRequestSequence.current;
			const requestGeneration = prCloseGeneration.current;
			return (
				fetchOpenPrs()
					.then((prs) => {
						if (!alive) return;
						if (requestSequence < latestOpenPrResponse.current) return;
						latestOpenPrResponse.current = requestSequence;
						for (const [url, closeGeneration] of closedPrTombstones.current) {
							if (closeGeneration <= requestGeneration)
								closedPrTombstones.current.delete(url);
						}
						const next = prs.filter(
							(pr) => !closedPrTombstones.current.has(pr.url),
						);
						setOpenPrs((current) =>
							sameOpenPrSnapshot(current, next) ? current : next,
						);
					})
					.catch(() => {})
			);
		};
		load();
		const onReviewSubmitted = () => void load();
		window.addEventListener(PR_REVIEW_SUBMITTED_EVENT, onReviewSubmitted);
		// The response is backed by the server's PR cache, but also carries live
		// Open Session review state. Poll it often enough that a PR moves in and out
		// of "Review running" promptly without triggering extra GitHub requests.
		const onVisibilityChange = () => {
			if (!document.hidden) void load();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		const t = setInterval(load, 15_000);
		return () => {
			alive = false;
			clearInterval(t);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener(PR_REVIEW_SUBMITTED_EVENT, onReviewSubmitted);
		};
	}, []);
	useEffect(() => {
		const onClosed = (event: Event) => {
			const { repo, branch, url } = (event as CustomEvent<PrClosedDetail>).detail;
			if (url) {
				prCloseGeneration.current++;
				closedPrTombstones.current.set(url, prCloseGeneration.current);
			}
			setOpenPrs((current) =>
				current?.filter(
					(pr) =>
						!(url && pr.url === url) &&
						!(!url && repo === pr.repo && branch === pr.branch),
				) ?? null,
			);
		};
		window.addEventListener(PR_CLOSED_EVENT, onClosed);
		return () => window.removeEventListener(PR_CLOSED_EVENT, onClosed);
	}, []);

	// Generic feed bands (videos, dashboards, … the feeds design): descriptors
	// once on mount. Hidden feeds remain available to Settings but do not poll.
	const [feeds, setFeeds] = useState<FeedDescriptor[]>([]);
	const [feedItems, setFeedItems] = useState<Record<string, FeedItem[]>>({});
	useEffect(() => {
		let alive = true;
		fetchFeeds()
			.then((descriptors) => {
				if (!alive) return;
				setFeeds(descriptors);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	const visibleFeeds = feeds.filter((feed) => !hiddenFeeds.has(feed.id));

	// The Support queue now arrives through the generic feeds poll: the plain
	// feed's items carry the full SupportThreadSummary in meta, so all the
	// bespoke Support UI (SupportRow, filters, Tinder hand-offs) keeps working
	// off the same derived shape (the feeds design W5).
	const supportThreads = (() => {
		const items = feedItems["plain"];
		if (!items) return null;
		return items.map((i) => i.meta as unknown as SupportThread);
	})();

	// Newest live session per feed item (keyed `<kind>:<id>`) — a feed row with
	// one wears that session's status dot.
	const feedSessionByRef = (() => {
		const m = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived || !s.externalRefs?.length) continue;
			for (const r of s.externalRefs) {
				const key = `${r.kind}:${r.id}`;
				const prev = m.get(key);
				if (!prev || s.lastActivity > prev.lastActivity) m.set(key, s);
			}
		}
		return m;
	})();

	// Per-feed filter selections (generic — see FeedFilterMenu). Arg-mode
	// changes refetch that feed immediately; meta/builtin ones just re-derive.
	const [feedFilters, setFeedFiltersState] = useState<
		Record<string, FeedFilterValues>
	>(readFeedFilters);
	const argFiltersFor = (feed: FeedDescriptor, all: Record<string, FeedFilterValues>) =>
		Object.fromEntries(
			(feed.filters || [])
				.filter((f) => f.mode !== "meta")
				.map((f) => [f.key, (all[feed.id] || {})[f.key] || ""])
				.filter(([, v]) => v),
		) as Record<string, string>;
	const setFeedFilter = (feed: FeedDescriptor, key: string, value: string) => {
		setFeedFiltersState((prev) => {
			const next = {
				...prev,
				[feed.id]: { ...(prev[feed.id] || {}), [key]: value },
			};
			try {
				localStorage.setItem(FEED_FILTERS_KEY, JSON.stringify(next));
			} catch {}
			const spec = (feed.filters || []).find((f) => f.key === key);
			if (spec && spec.mode !== "meta")
				fetchFeedItems(feed.id, argFiltersFor(feed, next))
					.then((items) =>
						setFeedItems((p) => ({ ...p, [feed.id]: items })),
					)
					.catch(() => {});
			return next;
		});
	};
	// Items use the same gentle 60s cadence as Support (the server caches ~60s).
	// Re-enabling a source loads it immediately; hiding one tears its timer down.
	// Filter changes already fetch their feed in setFeedFilter; interval ticks
	// read the latest filters without restarting every feed's timer.
	const refreshEnabledFeeds = useEffectEvent(
		(enabledFeeds: FeedDescriptor[], isAlive: () => boolean) => {
			for (const feed of enabledFeeds) {
				fetchFeedItems(feed.id, argFiltersFor(feed, feedFilters))
					.then((items) => {
						if (isAlive())
							setFeedItems((prev) => ({ ...prev, [feed.id]: items }));
					})
					.catch(() => {});
			}
		},
	);
	useEffect(() => {
		const enabledFeeds = feeds.filter((feed) => !hiddenFeeds.has(feed.id));
		if (enabledFeeds.length === 0) return;
		let alive = true;
		const load = () => refreshEnabledFeeds(enabledFeeds, () => alive);
		load();
		const timer = setInterval(load, 60_000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [feeds, hiddenFeeds]);

	// Newest live session per Plain thread — a Support row with one opens that
	// session instead of the session-less ticket preview.
	const supportSessionByThread = (() => {
		const m = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived || !s.plainThreadId) continue;
			const prev = m.get(s.plainThreadId);
			if (!prev || s.lastActivity > prev.lastActivity)
				m.set(s.plainThreadId, s);
		}
		return m;
	})();

	// Distinct repos across the (non-archived) sessions, most-used first, for the
	// Repo filter dropdown. Built off every session (not the search-filtered set)
	// so the options don't churn while you type.
	const discoveredRepos = (() => {
		const counts = new Map<string, number>();
		for (const repo of registeredRepos) counts.set(repo, 0);
		for (const s of sessions) {
			// Repo-less sessions (scratch, repo-less Ask) would otherwise each
			// add a vote for whatever repo sessionRepo falls back to.
			if (s.archived || s.repoLess) continue;
			const p = sessionRepo(s);
			counts.set(p, (counts.get(p) || 0) + 1);
		}
		for (const pr of openPrs || [])
			counts.set(pr.repo, (counts.get(pr.repo) || 0) + 1);
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([name]) => name);
	})();
	const repos = (mergeRepoOrder(repoOrderDraft ?? savedRepoOrder, discoveredRepos));
	const completeRepoOrder = (() => {
		const next = normalizeRepoOrder(savedRepoOrder);
		const seen = new Set(next);
		for (const repo of discoveredRepos) {
			if (!seen.has(repo)) {
				seen.add(repo);
				next.push(repo);
			}
		}
		return next;
	})();
	useEffect(() => {
		if (
			savedRepoOrder.length > 0 &&
			JSON.stringify(completeRepoOrder) !== JSON.stringify(savedRepoOrder)
		)
			setRepoOrder(completeRepoOrder);
	}, [savedRepoOrder, completeRepoOrder]);

	// Workspace members who started sessions, most-active first, for the Person
	// filter. The team directory decides who is a person and merges one
	// person's spellings (lib/session-owner): `startedBy` also carries workers,
	// goal names and integration senders, and the same teammate arrives as a
	// first name from the web and a full name from chat. Built off every
	// session so options don't churn on search.
	const roster = usePeople();
	const canonical = (canonicalNames(roster));
	const people = (() => {
		const entries = sessionOwners(
			sessions.filter((s) => !s.archived),
			canonical,
		);
		const seen = new Set(entries.map((e) => e.key));
		// Someone whose only work here is a pull request is still someone whose
		// lanes you can look at, so they are offered even with no session.
		for (const pr of openPrs || []) {
			if (!pr.person || seen.has(pr.person)) continue;
			seen.add(pr.person);
			entries.push({ key: pr.person, label: personNameForKey(pr.person) });
		}
		return entries;
	})();

	// A borrowed sidebar: someone else's lanes, everyone's, or the unassigned
	// pile. It looks exactly like your own, so the rail changes shape while you
	// are in one — the tools go, and the person strip becomes the heading.
	const borrowedLens = filter.person !== "me";

	// Whose lanes these are, for the header title and its reset button. The
	// facepile's roster is asked first, so a teammate picked on Home is named
	// even before anything of theirs has landed in this list.
	const personLensName =
		filter.person === "me"
			? "You"
			: filter.person === "everyone"
				? "All workspaces"
				: filter.person === "unassigned"
					? "Unassigned"
					: filter.person === AGENT_PERSON_KEY
						? AGENT_NAME
						: team.find((m) => m.key === filter.person)?.person.name ||
							people.find((p) => p.key === filter.person)?.label ||
							filter.person;

	// Who each automation reports to, where it files, and what its last run
	// concluded. Re-read when automation activity moves rather than on a timer:
	// a report is published by a run, so a run landing in the list is the only
	// thing that can have produced a new one.
	const automationActivityKey = (() => {
		let newest = "";
		let count = 0;
		for (const s of sessions) {
			if (!s.automation || s.archived) continue;
			count++;
			if (s.lastActivity > newest) newest = s.lastActivity;
		}
		return `${count}:${newest}`;
	})();
	const automationOverview = useAutomationOverview(automationActivityKey);

	// The agent is a person in the picker as well as a name on a row: it holds
	// every automation nobody has taken, and those are still editing the
	// codebase unattended. Offered only once there is something behind it, and
	// merged with the agent's own sessions where it has started any.
	const peopleWithAgent = (() => {
		const unowned = Array.from(automationOverview.values()).some(
			(a) => !a.owner,
		);
		if (!unowned || people.some((p) => p.key === AGENT_PERSON_KEY))
			return people;
		return [...people, { key: AGENT_PERSON_KEY, label: AGENT_NAME }];
	})();

	// Child sessions are contextual navigation for the workspace that is open,
	// not another person/status lane. Derive them from the complete live list so
	// a teammate or search lens cannot cut a running worker out from under its
	// selected parent row.
	const activeWorkspaceSubagents = (activeSubagentsForWorkspace(sessions, selectedWorkspaceId));
	const activeWorkspaceSubagentIds = (new Set(activeWorkspaceSubagents.map(({ session }) => session.id)));

	// Every non-archived session, narrowed by the repo/person filters and search.
	// Rows are built per-workspace below; a session matching the filter surfaces its
	// whole workspace row.
	const filtered = (() => {
		let visible = sessions.filter((s) => !s.archived);
		if (filter.repo !== "all") {
			// A workspace can span repos, and a session's own repo is just the
			// checkout it runs from — so a session also matches when its workspace
			// is the filtered repo. Without this, narrowing to a repo hides the
			// very workspaces that belong to it.
			const wsRepo = new Map(workspaces.map((p) => [p.id, p.repo]));
			visible = visible.filter(
				(s) =>
					// Narrowing to a repo must not surface sessions that have none:
					// sessionRepo's fallback would hand them the default repo.
					!s.repoLess &&
					(sessionRepo(s) === filter.repo ||
						(!!s.workspaceId && wsRepo.get(s.workspaceId) === filter.repo)),
			);
		}
		// Only a specific teammate narrows the sessions themselves. "me" and
		// "everyone" keep every session so workspace rows stay whole (your
		// workspaces can contain teammates' sessions, and pinned rows survive) —
		// the owner lens is applied per-row in focusWsRows instead.
		if (
			filter.person !== "me" &&
			filter.person !== "everyone" &&
			filter.person !== "unassigned"
		)
			visible = visible.filter((s) =>
				// An automation run has no teammate to compare: it belongs to
				// whoever the automation reports to, which the Automations band
				// answers for itself below. Excluding them here instead is what
				// used to empty that band the moment you looked at a colleague.
				s.automation
					? true
					: !!s.startedBy && ownerKeyOf(s, canonical) === filter.person,
			);
		if (!search) return visible;
		const q = search.toLowerCase();
		return visible.filter(
			(s) =>
				s.title.toLowerCase().includes(q) ||
				(s.branch || "").toLowerCase().includes(q) ||
				(s.startedBy || "").toLowerCase().includes(q) ||
				(s.automation || "").toLowerCase().includes(q),
		);
	})();

	// Sort order applied to every group's items: newest activity or newest
	// creation first. Groups read from this pre-sorted list so ordering is uniform.
	const sorted = (() => {
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		return [...filtered].sort(
			(a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
		);
	})();

	// Team activity is deliberately independent of the workspace lens above it:
	// repo/person/search filters must not make a running teammate disappear from
	// the complete live list at the bottom. The server's sidebar projection adds
	// every live or just-finished run to `sessions`; the directory boundary here
	// turns only real teammates into headings and files unowned automations under
	// the Agent person.
	const activePersonGroups = sidebarPersonSessions(
		sessions,
		roster,
		currentUser,
		peopleActivityNow,
		new Map(
			Array.from(automationOverview, ([name, overview]) => [
				name,
				overview.owner,
			]),
		),
	);

	// PRs with an automated Open Session review in flight, keyed `repo\nbranch`
	// — the same signal the PR rows spell out as "Review running". The review
	// itself runs in a `bks-ghpr-*` session that lives in the Automations band, so
	// the workspace lanes below can't see it in their own sessions.
	const activeReviewPrKeys = (() => {
		const keys = new Set<string>();
		for (const pr of openPrs || [])
			if (pr.reviewActive) keys.add(`${pr.repo}\n${pr.branch}`);
		return keys;
	})();

	// ── Workspace rows ──────────────────────────────────────────────────────
	// The row shape itself is WsRow in lib/sidebar-types.
	const selectedSession = sessions.find((session) => session.id === selectedId) || null;

	// Most-urgent-first for the row dot: a blocked question beats everything,
	// a live run beats a ready-to-merge PR, merged/pending are quiet states.
	const STATUS_PRIORITY: MineStatus[] = [
		"needsinput",
		"inprogress",
		"review",
		"merged",
		"pending",
	];
	const STATUS_DOT: Record<MineStatus, string> = Object.fromEntries(
		MINE_STATUS_META.map((m) => [m.key, m.dotColor]),
	) as Record<MineStatus, string>;

	const allWsRows = (() => {
		const rows: WsRow[] = [];
		const byWs = new Map<string, UnifiedSession[]>();
		const solo: UnifiedSession[] = [];
		for (const s of filtered) {
			// An active child linked out to its own temporary workspace is rendered
			// under the selected parent workspace below. Do not mint a second row for
			// the same session elsewhere in this visible hierarchy. A child already in
			// the selected workspace stays in the aggregate so its activity still
			// contributes to the parent row.
			if (
				activeWorkspaceSubagentIds.has(s.id) &&
				s.workspaceId !== selectedWorkspaceId
			)
				continue;
			// Automations render in their own band — EXCEPT runs YOU claimed
			// (right-click → Add to my workspaces / Set status): those graduate
			// into the workspace rows and take part in your lanes like your own
			// work, sitting in In progress while they run and Backlog once idle.
			// Lanes are per-user, so a claimed run moves only for the user who
			// claimed it (legacy global overrides still count for all).
			if (s.automation && !isClaimed(s)) continue;
			if (s.desk) continue; // the Desk session lives in the ⌘J overlay, not the sidebar
			// A session an agent started for its own purposes (create_session
			// from inside a run — a throwaway fixture, a probe) belongs to that
			// run, not to you: it gets a workspace like anything else, but not a
			// row here. It surfaces the moment it needs a human — a blocked
			// question — or when you explicitly add it through the viewer. Work
			// the Desk delegates on your behalf is never marked this way (server:
			// session-control-wiring).
			if (
				!spawnedSessionBelongsInSidebar(
					s,
					mineStatus(s) === "needsinput",
					isClaimed(s),
				)
			)
				continue;
			if (s.workspaceId) {
				const list = byWs.get(s.workspaceId) || [];
				list.push(s);
				byWs.set(s.workspaceId, list);
			} else solo.push(s);
		}
		const mkRow = (
			key: string,
			workspace: Workspace | null,
			name: string,
			sessions: UnifiedSession[],
		): WsRow => {
			sessions.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			// Spawned workers are implementation details of their parent session. A failed
			// oracle/task must not leave the whole workspace looking blocked after the
			// parent recovered, but live workers still make the workspace actively busy.
			// Fall back for an unusual child-only workspace.
			const stateSessions = sessions.filter((c) => !c.parentSessionId);
			const statusSources = stateSessions.length > 0 ? stateSessions : sessions;
			const workerRunning = sessions.some((c) => c.parentSessionId && c.isRunning);
			// Automated PR reviews run in a separate bks-ghpr-* automation session,
			// so the workspace's own sessions never carry isRunning for that work.
			// The PR feed is the authoritative live signal for both its lane and
			// its leading spinner.
			const reviewRunning = sessions.some((c) =>
				sessionPrKeys(c).some((k) => activeReviewPrKeys.has(k)),
			);
			let status =
				STATUS_PRIORITY.find((st) =>
					statusSources.some((c) => mineStatus(c) === st),
				) ||
				"pending";
			// A running worker is live workspace activity even though child failures and
			// blocked states stay isolated from the parent. Needs-input and explicit
			// human lanes still win, matching mineStatus's priority rules.
			if (
				workerRunning &&
				status !== "needsinput" &&
				!sessions.some((c) => pinnedLane(c))
			)
				status = "inprogress";
			// An idle row's lane follows its PR lifecycle (merged → Done, ready
			// → Ready to merge). A human-pinned lane wins — deliberately
			// parking a row in Backlog must stick.
			if (status === "pending" && !sessions.some((c) => pinnedLane(c))) {
				// …unless an automated review is still running. The row already
				// wears the spinner for it (see `running` below), and a spinning
				// row parked outside In progress reads as a contradiction. The
				// review can still come back requesting changes, so no PR lane is
				// trustworthy until it lands — including when the live review is
				// on a sibling PR (a cross-repo port, say) while the fronting PR
				// has already merged.
				status = reviewRunning
					? "inprogress"
					: (prLaneForSessions(statusSources) ?? status);
			}
			return {
				key,
				workspace,
				name,
				sessions,
				status,
				lastActivity: sessions.reduce(
					(m, c) => (c.lastActivity > m ? c.lastActivity : m),
					"",
				),
				// The workspace owns the row's stable position. A later session joining
				// old work must not make the whole row look newly created.
				createdAt: workspace?.createdAt || sessions[0]?.createdAt || "",
				// Workers are left out here for the same reason they are left out of
				// `status`, plus one of their own: a worker gets no tab in the strip
				// (App's naturalSessions keeps it behind its parent), so opening the
				// workspace marks every tab read and never the worker. Counting one
				// left the row bold with nothing you could open to clear it.
				unread: !!pickUnreadWorkspaceSession(sessions, selectedId, reads),
				// A tag on any session in the workspace marks the whole row: the
				// person who wrote it asked for you, not for a particular tab.
				mention: sessions
					.filter((c) => c.id !== selectedId)
					.map((c) => mentionFor(c.id))
					.find(Boolean)?.by,
				running: sessions.some((c) => c.isRunning) || reviewRunning,
				// Canonical, so the row files under the person the Person filter
				// names however this workspace spelled them.
				owner: ownerKey(workspace?.createdBy || sessions[0]?.startedBy, canonical),
			};
		};
		for (const [wsId, sessions] of byWs) {
			const ws = workspaces.find((p) => p.id === wsId) || null;
			// A row is named after its workspace, never after one of its tabs.
			// The workspace list is its own fetch and lands seconds after the
			// sessions on a cold load, so when it isn't here yet the name comes
			// from the sessions themselves (the server stamps it on every row).
			// A session title is the last resort, for a workspace this client
			// has no name for at all.
			const named = sessions.find((c) => c.workspaceName);
			rows.push(
				mkRow(
					`workspace:${wsId}`,
					ws,
					ws?.name || named?.workspaceName || sessions[0].title,
					sessions,
				),
			);
		}
		// A draft workspace (an unsent prompt, no session yet) is the one
		// sessionless exception below: it earns a row of its own, since
		// it IS a place to start work. The composer is sitting there prefilled,
		// waiting to be sent. mkRow's activity/creation dates default to a
		// session that doesn't exist here, so they're patched from the
		// workspace + draft record instead.
		for (const ws of workspaces) {
			if (!ws.draft || byWs.has(ws.id)) continue;
			rows.push({
				...mkRow(`workspace:${ws.id}`, ws, ws.name, []),
				lastActivity: ws.draft.updatedAt,
				createdAt: ws.createdAt,
			});
		}
		// A workspace with no sessions and no draft gets NO row. Workspaces are
		// minted with their first session (or by the PR/ticket resolvers, which
		// park them under Pull requests / Support until a session joins), so a
		// sessionless one is a leftover (its sessions were archived or deleted),
		// not a place to start work.
		//
		// Automation runs are the one session kind that lives outside a workspace: a
		// workspace per run would bury every real one, so they render in the
		// Automations band instead. A *claimed* run is pulled into this list, and
		// groups by shared isolated worktree — the SAME rule the tab strip uses —
		// so the sidebar and tabs agree on what belongs together. Every other session
		// carries a workspace (server-side invariant: see session-workspace.ts), so
		// these fallback rows stay empty in practice.
		const byWorktree = new Map<string, UnifiedSession[]>();
		const loose: UnifiedSession[] = [];
		for (const s of solo) {
			if (s.worktreeDir?.includes("/worktrees/")) {
				const list = byWorktree.get(s.worktreeDir) || [];
				list.push(s);
				byWorktree.set(s.worktreeDir, list);
			} else loose.push(s);
		}
		for (const [dir, sessions] of byWorktree) {
			sessions.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			// The branch is the row's stable name (session titles drift as generated
			// titles land; the branch names the shared piece of work). A manual
			// rename is explicit user intent though — it wins over the branch,
			// otherwise renaming a slack/linear session looks like a no-op.
			const renamed = sessions.find((c) => c.titleOverridden);
			rows.push(
				mkRow(
					`wt:${dir}`,
					null,
					renamed?.title || sessions[0].branch || sessions[0].title,
					sessions,
				),
			);
		}
		for (const s of loose) rows.push(mkRow(s.id, null, s.title, [s]));
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		rows.sort((a, b) => (b[key] || "").localeCompare(a[key] || ""));
		return rows;
		// `lanes` feeds mineStatus/pinnedLane (read via the lib cache), and
		// `mentionsRev` the @-mention badge (mentionFor, same cache pattern).
	})();
	const rowOwnsSelection = (row: WsRow) =>
		workspaceRowOwnsSelection(row, selectedSession, selectedWorkspaceId);
	const selectionBelongsToWorkspaceRow = allWsRows.some(rowOwnsSelection);
	const automationRowSelected = (session: UnifiedSession) =>
		session.id === selectedId && !selectionBelongsToWorkspaceRow;

	/** An automation group is keyed by name; its report comes from the overview. */
	const latestReportFor = (name: string) =>
		automationOverview.get(name)?.latestReport;

	/** Someone owns it, rather than it being a house routine nobody has taken. */
	const reportsToSomeone = (name: string) =>
		!!automationOverview.get(name)?.owner;

	// ── Hidden rows ─────────────────────────────────────────────────────────
	// "Hide from my sidebar" is the personal counterpart to Archive: archiving
	// is global (archive.ts), so it's the wrong tool when a teammate is still
	// working in the session. A hide drops the row from THIS user's sidebar only,
	// and every band below derives from `wsRows` — so hiding removes it from
	// pins, lanes, review and snoozed in one go.
	//
	// The one exception: a hidden row resurfaces while any of its sessions is
	// blocked on a question, so a hide can never swallow work waiting on you.
	// Resurfacing consumes the entry (see the sweep below), which keeps the
	// rule "it came back because it needed me, and stays back until I hide it
	// again" instead of flickering as questions get asked and answered.
	//
	// Otherwise the viewer offers "Add to sidebar" when you open a hidden
	// session through a link or ⌘K. There is no Hidden band: hiding is removal
	// from your sidebar, not a folder to browse.
	const { hiddenKeys: hiddenRowKeys, resurfaced: resurfacedRows } = (partitionHidden(allWsRows, hides));
	// Opening a deep link must not undo a personal hide. The viewer owns the
	// recovery action while the row stays absent.
	const wsRows = (allWsRows.filter((r) => !hiddenRowKeys.has(r.key)));
	useEffect(() => {
		setRunStartSeen((current) => {
			const next = new Map(current);
			let changed = false;
			for (const row of wsRows) {
				const hasServerStart = row.sessions.some(
					(session) => session.isRunning && session.runStartedAt,
				);
				if (row.running && !hasServerStart && !next.has(row.key)) {
					next.set(row.key, Date.now());
					changed = true;
				} else if ((!row.running || hasServerStart) && next.delete(row.key)) {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [wsRows]);
	// Consume the hide of any row that just resurfaced (blocked on a question),
	// marking its sessions unread so the return reads as fresh activity — the same
	// shape as the snooze wake above. Idempotent: clearHides ignores keys that
	// another tab already dropped.
	useEffect(() => {
		if (!resurfacedRows.length) return;
		for (const r of resurfacedRows) r.sessions.forEach((c) => markUnread(c.id));
		clearHides(resurfacedRows.map((r) => r.key));
	}, [resurfacedRows]);

	// Automations keep their own collapsible band, one group per automation —
	// hundreds of one-shot runs would drown the Workspaces list otherwise.
	// The band narrows with the same person and repo lenses the rest of the
	// sidebar uses, read off the automation rather than off its runs: a run is
	// started by nobody, so the audience is the automation's own.
	const groups = (() => {
		const out: Group[] = [];
		const byAutomation = new Map<string, UnifiedSession[]>();
		for (const s of sorted) {
			// Session files predate this field's string contract, and a malformed
			// legacy/test row must not take down the whole sidebar while sorting.
			const automation =
				typeof s.automation === "string" ? s.automation.trim() : "";
			if (!automation) continue;
			if (activeWorkspaceSubagentIds.has(s.id)) continue;
			// A run you claimed (or a legacy global override) lives in the
			// workspace rows instead — don't render it twice.
			if (isClaimed(s)) continue;
			const list = byAutomation.get(automation) || [];
			list.push(s);
			byAutomation.set(automation, list);
		}
		// Case-insensitive, or ASCII order files every lowercase name after
		// every capitalised one: "iOS parity check" and "deepsec daily scan"
		// landed past "Weekly changelog", at the bottom of a band of thirty.
		const byName = Array.from(byAutomation.keys()).sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" }),
		);
		for (const name of byName) {
			// An automation the overview doesn't describe is a deleted one whose
			// runs outlived it, and there are a dozen of those here. It reads as
			// a house routine: still in your band, out of a teammate's, which is
			// what "show me Kent's" should mean. Before the overview lands there
			// is nothing to narrow by, so the band stays whole.
			const overview = automationOverview.get(name) ?? HOUSE_AUTOMATION;
			if (
				automationOverview.size > 0 &&
				(!automationInPersonLens(overview, filter.person, currentUser) ||
					!automationInRepoLens(overview, filter.repo))
			)
				continue;
			const items = byAutomation.get(name)!;
			out.push({
				key: `auto:${name}`,
				label: name,
				dotColor: AUTOMATION_COLOR,
				band: "automations",
				items,
				totalItems: Math.max(
					items.length,
					...items.map((session) => session.automationRunCount || 0),
				),
			});
		}
		return out;
		// `lanes` feeds pinnedLane (read via the lib cache).
	})();

	// The DOM is the source of truth for visual order. Section mode, project
	// grouping, collapse state, pins, PRs and feeds can all put rendered rows in
	// an order that no single data array represents.
	function openNextSidebarItem(
		currentKey: string,
		current: HTMLButtonElement | null = null,
	): OpenNextSidebarItem {
		return () => {
			const root = sidebarScrollRef.current;
			if (!root) return false;
			const items = Array.from(
				root.querySelectorAll<HTMLButtonElement>("button[data-sidebar-row]"),
			);
			const next = nextRenderedSidebarItem(
				items,
				current?.isConnected ? current : null,
				currentKey,
			);
			if (!next) return false;
			next.click();
			return true;
		};
	}

	function archiveWithNext(
		session: UnifiedSession,
		current: HTMLButtonElement | null = null,
	) {
		onArchive(
			session,
			openNextSidebarItem(`session:${session.id}`, current),
		);
	}
	function sessionPinState(s: UnifiedSession) {
		const keys = [s.id, ...(s.aliasIds || [])].filter(
			(k, i, a) => pins.includes(k) && a.indexOf(k) === i,
		);
		const pinned = keys.length > 0;
		const toggle = () => {
			if (pinned) {
				let next = pins;
				for (const k of keys) next = togglePin(k);
				setPins(next);
			} else {
				setPins(togglePin(s.id));
			}
		};
		return { pinned, toggle };
	}
	function workspacePinState(row: WsRow) {
		const pinKey = row.workspace ? `workspace:${row.workspace.id}` : row.key;
		const keys = [
			pinKey,
			row.key,
			...row.sessions.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
		].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
		const pinned = keys.length > 0;
		const toggle = () => {
			if (pinned) {
				let next = pins;
				for (const k of keys) next = togglePin(k);
				setPins(next);
			} else {
				setPins(togglePin(pinKey));
			}
		};
		return { pinned, toggle };
	}

	// Pinned rows (pinned via their own key or a legacy pin on a member session)
	// and the focus person's rows — shared by the list rendering below and by
	// archive-next, so both always agree on what's actually in the sidebar.
	// Rows a teammate flagged for YOUR review (the info panel's Reviewer picker).
	// Explicit teammate filters stay owner-scoped, while the default "Me" view
	// also includes cross-owner work that was sent to or requested by you.
	// ── Snoozed rows ────────────────────────────────────────────────────────
	// A row with an active snooze leaves every band (review, pinned, status
	// lanes) and parks in the Snoozed section, soonest wake first. The sweep
	// below prunes lapsed entries — marking the row's sessions unread first, so
	// the wake surfaces like fresh activity — which re-derives membership.
	const activeSnoozeKeys = (() => {
		const now = Date.now();
		return new Set(
			Object.entries(snoozes)
				.filter(([, until]) => snoozeIsActive(until, now))
				.map(([key]) => key),
		);
	})();
	useEffect(() => {
		if (Object.keys(snoozes).length === 0) return;
		const sweep = () => {
			const now = Date.now();
			for (const [key, until] of Object.entries(snoozes)) {
				if (snoozeIsActive(until, now)) continue;
				const row = wsRows.find((r) => r.key === key);
				row?.sessions.forEach((c) => markUnread(c.id));
				clearSnooze(key);
			}
		};
		sweep();
		const t = setInterval(sweep, 30_000);
		return () => clearInterval(t);
	}, [snoozes, wsRows]);

	// Your person key ("Kent de Bruin" → "kent") is what GitHub's reviewer
	// lists use, unlike the display name used by the Reviewer picker.
	const mePersonKey = personKey(currentUser);
	// Feed workspaces only join status lanes when they demand attention. Idle
	// rows are already represented by their feed band.
	const feedRefKinds = (new Set(feeds.map((f) => f.refKind)));
	const rowIsFeedOnly = (r: WsRow) =>
		!r.workspace?.repo &&
		!!r.workspace?.externalRefs?.length &&
		feedRefKinds.has(r.workspace.externalRefs[0].kind);

	// Every row receives exactly one primary placement. Pinned remains an
	// orthogonal quick-access facet and is derived separately below.
	const { placedWsRows, autoCreatedRows } = (() => {
		const focus =
			filter.person === "me" ? currentUser.toLowerCase() : filter.person;
		// Whether a row belongs in the lanes at all, asked twice: once as the
		// filter has it, and once as if machine-started work were shown, which is
		// what the count of what is being held back is measured against.
		//
		// "Hide" only ever removes a row that is here BECAUSE the machine made
		// it. The row you have open still shows, whatever the filter says: the
		// sidebar has to keep showing where you are. A review being asked of you
		// survives too, in classifySidebarPlacement, which reads the review
		// bands before it reads this scope: an ask is not something you were
		// browsing. And a run you claimed into your own lanes stays, because
		// `getLane` below is your own explicit act.
		const inScope = (r: WsRow, showAutoCreated: boolean) =>
			(rowOwnsSelection(r) ||
				(focus === "everyone" && (showAutoCreated || !rowWasAutoCreated(r))) ||
				(showAutoCreated && rowAutoCreatedInLens(r, filter.person)) ||
				(focus === "unassigned"
					? r.status === "pending"
					: (r.owner === focus &&
							(showAutoCreated || !rowWasAutoCreated(r))) ||
						(!!r.mention && focus === currentUser.toLowerCase()) ||
						r.sessions.some(
							(c) =>
								!c.automation &&
								(c.startedBy || "").toLowerCase() === focus,
						) ||
						((r.owner === "" || focus === currentUser.toLowerCase()) &&
							r.sessions.some((c) => isClaimed(c))))) &&
			(!rowIsFeedOnly(r) || r.running || r.status === "needsinput");
		const showAutoCreated = filter.autoCreated !== "hide";
		const placed = placeSidebarRows(wsRows, (r) => ({
			currentUser,
			personFilter: filter.person,
			snoozed: activeSnoozeKeys.has(r.key),
			inStatusScope: inScope(r, showAutoCreated),
		}));
		// How many rows the switch at the foot of the list moves: held back
		// right now, or on the page and only there because the machine's work is
		// shown. Only the status lanes can change. Every earlier branch of
		// classifySidebarPlacement (snoozed, the review bands) ignores this
		// scope, so a review being asked of you is counted by neither side.
		// A filter that removes rows silently is one you forget you set, and on
		// this instance the machine makes most of the work, so the number stays
		// on the page either way.
		const moved = placed.filter((entry) =>
			rowWasAutoCreated(entry.row) &&
			(showAutoCreated
				? entry.placement === "status" && !inScope(entry.row, false)
				: entry.placement === "outside" && inScope(entry.row, true)),
		).length;
		return { placedWsRows: placed, autoCreatedRows: moved };
	})();
	const needsReviewRows = rowsAtPlacement(placedWsRows, "needs-review");
	const approvedReviewRows = rowsAtPlacement(placedWsRows, "approved-review");
	const awaitingReviewRows = rowsAtPlacement(placedWsRows, "awaiting-review");
	const focusWsRows = rowsAtPlacement(placedWsRows, "status");
	const snoozedWsRows = rowsAtPlacement(placedWsRows, "snoozed").sort(
		(a, b) => {
			const aUntil = snoozes[a.key];
			const bUntil = snoozes[b.key];
			if (aUntil === SNOOZE_SOMEDAY && bUntil !== SNOOZE_SOMEDAY) return 1;
			if (bUntil === SNOOZE_SOMEDAY && aUntil !== SNOOZE_SOMEDAY) return -1;
			return Date.parse(aUntil || "") - Date.parse(bUntil || "");
		},
	);
	const pinnedWsRows = (() => {
		const pinSet = new Set(pins);
		const pinIdx = new Map(pins.map((p, i) => [p, i] as const));
		// Pinned is quick access, not a status: review rows stay visible here as
		// well as in Needs/Awaiting review. Snooze is the deliberate exception,
		// it temporarily removes a row from every active band.
		// A row's slot in the band = its first matching key's position in the
		// pins array (rows can be pinned via their workspace key or a legacy
		// member-session pin). Pins order is user-controlled (drag-to-reorder), so
		// it wins over wsRows' recency order.
		const rowIdx = (r: WsRow) => {
			const hits = [r.key, ...r.sessions.map((c) => c.id)]
				.map((k) => pinIdx.get(k))
				.filter((i): i is number => i !== undefined);
			return hits.length ? Math.min(...hits) : Infinity;
		};
		return wsRows
			.filter(
				(r) =>
					!activeSnoozeKeys.has(r.key) &&
					(pinSet.has(r.key) || r.sessions.some((c) => pinSet.has(c.id))),
			)
			.sort((a, b) => rowIdx(a) - rowIdx(b));
	})();

	// ── Inbox rows ──────────────────────────────────────────────────────────
	// Snoozed rows already left `focusWsRows` through placement. The remaining
	// inbox stays stable by creation time. Pinned is an orthogonal quick-access
	// facet, so a pinned row still keeps its primary Active/status placement.
	const activeFocusWsRows = sortInboxByCreation(focusWsRows);
	// ── PR rows in the project lanes ────────────────────────────────────────
	// The retired standalone Pull-requests band dissolved into the project
	// groups: every open PR classifies into a lane (ready → Ready to merge,
	// attention → In progress, drafts → Backlog, the rest → In progress).
	const githubLogin = githubLoginFor(currentUser);
	const reviewQueueItems = (buildReviewQueue(openPrs || [], sessions, currentUser, githubLogin));
	const workspaceRowsInView = ([
			...activeFocusWsRows,
			...pinnedWsRows,
			...snoozedWsRows,
			...needsReviewRows,
			...awaitingReviewRows,
			...approvedReviewRows,
		]);
	// A PR already represented by a workspace belongs to that workspace row.
	// Match both the workspace's own PR identity and every PR carried by its
	// sessions, including linked and cross-repo PRs. Dedupe is against rows in
	// view so a teammate's hidden workspace can still surface through the PR
	// filter.
	const workspaceCoveredPrUrls = (() => {
		const covered = new Set<string>();
		for (const item of reviewQueueItems) {
			if (
				workspaceRowsInView.some(
					(row) =>
						(!!row.workspace && workspaceCarriesPr(row.workspace, item.pr)) ||
						row.sessions.some((session) => sessionCarriesPr(session, item.pr)),
				)
			)
				covered.add(item.pr.url);
		}
		return covered;
	})();
	const prRowItems = (() => {
		if (!workspaceDataReady || filter.prs === "none") return [];
		const q = search.trim().toLowerCase();
		return reviewQueueItems.filter((item) => {
			if (workspaceCoveredPrUrls.has(item.pr.url)) return false;
			if (filter.repo !== "all" && item.pr.repo !== filter.repo)
				return false;
			if (
				q &&
				![item.pr.title, item.pr.branch, item.pr.author].some((v) =>
					v.toLowerCase().includes(q),
				)
			)
				return false;
			// The person lens: a specific teammate shows their PRs; the
			// aggregate Backlog lens has no authored-PR meaning. "Me" and
			// "Everyone" fall through to the PR-source preset.
			if (filter.person === "unassigned") return false;
			if (filter.person !== "me" && filter.person !== "everyone")
				return item.pr.person === filter.person;
			if (filter.prs === "all") return true;
			return item.source === "mine" || item.source === "requested";
		});
	})();

	// Which lane a PR row files under: ready → Ready to merge, everything else
	// → Backlog. In progress is reserved for live runs — a PR that needs a
	// hand signals through its red/yellow glyph and hover card instead.
	function prItemLane(item: ReviewQueueItem): MineStatus {
		return item.bucket === "ready" ? "review" : "pending";
	}

	const [confirm, confirmDialog] = useConfirm();

	// Every draft entry point uses the same styled confirmation instead of the
	// browser's native alert.
	function confirmDeleteDraft(onConfirm: () => void) {
		confirm({
			title: "Delete this draft?",
			description: "This removes the unsent message.",
			confirmLabel: "Delete",
			destructive: true,
			onConfirm,
		});
	}

	// Closing a PR from a row's context menu — optimistic spinner per URL; the
	// PR_CLOSED_EVENT listener above prunes the open-PR list on success.
	const [closingPrUrls, setClosingPrUrls] = useState<Set<string>>(
		() => new Set(),
	);
	function closePrRow(item: ReviewQueueItem) {
		confirm({
			title: `Close PR #${item.pr.number}?`,
			description: "This closes the pull request without merging it.",
			confirmLabel: "Close PR",
			destructive: true,
			onConfirm: () => {
				setClosingPrUrls((current) => new Set(current).add(item.pr.url));
				void closePrPreviewApi(item.pr.repo, item.pr.branch)
					.catch((error: any) => {
						onToast?.(
							error.message || `Failed to close PR #${item.pr.number}.`,
						);
					})
					.finally(() => {
						setClosingPrUrls((current) => {
							const next = new Set(current);
							next.delete(item.pr.url);
							return next;
						});
					});
			},
		});
	}

	// A PR row is selected while the open workspace carries its PR.
	function prRowSelected(item: ReviewQueueItem): boolean {
		const ws = selectedWorkspaceId
			? workspaces.find((p) => p.id === selectedWorkspaceId)
			: null;
		return (
			!!ws &&
			(ws.repo || DEFAULT_PROJECT) === item.pr.repo &&
			(ws.prNumber === item.pr.number || ws.branch === item.pr.branch)
		);
	}

	function renderPrRow(item: ReviewQueueItem) {
		const pinKey = `pr:${item.pr.url}`;
		return (
			<PrRow
				key={item.pr.url}
				item={item}
				selected={prRowSelected(item)}
				pinned={pins.includes(pinKey)}
				onTogglePin={() => setPins(togglePin(pinKey))}
				onOpen={() => onOpenPrItem(item)}
				onClose={() => void closePrRow(item)}
				closing={closingPrUrls.has(item.pr.url)}
			/>
		);
	}

	// GitHub review requests pointed at YOU are a notification, not a lane
	// item: they render in the "Needs review" band at the top, alongside the
	// internal review requests (both are the same ask of you), and stay out of
	// the project lanes below.
	const requestedPrItems = prRowItems.filter(
		(item) => item.source === "requested",
	);
	const lanePrItems = prRowItems.filter(
		(item) => item.source !== "requested",
	);

	// Workspace rows in their primary placement order. This supports operations
	// that need row membership; archive navigation reads the rendered DOM below.
	const wsRowOrder = (() => {
			// Review placements can still overlap Pinned; dedupe by key so the
			// archive-next walk sees each workspace once.
			const seen = new Set<string>();
			return [
				...needsReviewRows,
				...approvedReviewRows,
				...awaitingReviewRows,
				...pinnedWsRows,
				...MINE_STATUS_META.flatMap((meta) =>
					activeFocusWsRows.filter((r) => r.status === meta.key),
				),
				...snoozedWsRows,
			].filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
		})();
	// Project bands are independent from the section mode. Inbox, Activity,
	// and Status can each render globally or inside every project.
	const groupsByRepo = filter.byProject;
	const hasWorkspaceFilter =
		!!search ||
		filter.repo !== "all" ||
		filter.person !== "me" ||
		// Hiding auto-created work can empty the list on an instance where most
		// of the work is the agent's, and "no matching workspaces" is the honest
		// thing to say then. "Nothing here yet" would not be.
		filter.autoCreated === "hide";
	const workspaceListEmpty =
		needsReviewRows.length === 0 &&
		awaitingReviewRows.length === 0 &&
		approvedReviewRows.length === 0 &&
		pinnedWsRows.length === 0 &&
		activeFocusWsRows.length === 0 &&
		snoozedWsRows.length === 0 &&
		prRowItems.length === 0;
	const productEmpty = sessions.length === 0 && workspaces.length === 0;
	// The unstarted session's row. App decides WHEN there is nothing at all
	// (its flag waits for the first list request to settle, which the local
	// `productEmpty` above cannot know); this decides where it can be shown.
	const draftRow = !!showDraftRow && !isPhone && !sessionsError;

	// A draft workspace row (the composer sitting there prefilled, no session
	// yet) has nothing to archive: see mkRow's draft loop above, the only
	// place a sessionless row is ever pushed. Its removal action is delete,
	// not archive.
	function isDraftWsRow(row: WsRow): boolean {
		return !!row.workspace?.draft && row.sessions.length === 0;
	}

	const wsSwipeOffset = useRef(0);

	function deleteDraftWsRow(row: WsRow) {
		const ws = row.workspace;
		if (!ws) return;
		Promise.resolve(onDeleteWorkspace(ws.id)).catch(() => {
			// Delete failed: bring the row back instead of leaving it slid
			// off-screen and pointing at a workspace that is still there.
			setWsSwipe(null);
			wsSwipeOffset.current = 0;
		});
	}

	function rowIsSnoozed(row: WsRow): boolean {
		return activeSnoozeKeys.has(row.key);
	}

	function toggleWorkspaceSnooze(row: WsRow) {
		if (rowIsSnoozed(row)) clearSnooze(row.key);
		else setSnooze(row.key, SNOOZE_SOMEDAY);
	}

	function archiveWorkspaceWithNext(
		row: WsRow,
		current: HTMLButtonElement | null = null,
	) {
		onArchiveWorkspace(
			row.sessions,
			openNextSidebarItem(`workspace:${row.key}`, current),
		);
	}

	/**
	 * Hide a row from THIS user's sidebar, leaving the sessions untouched for
	 * everyone else (the point of the feature — see `hiddenRowKeys`). Drops the
	 * row's pins and any snooze first: a pinned-but-hidden row would snap to the
	 * top of Pinned the moment it resurfaced, and a snooze wake would resurface
	 * a row the user just hid. Lane membership is deliberately kept, so a
	 * restored row returns to where it was.
	 */
	function hideRow(row: WsRow) {
		const pinnedKeys = [
			row.key,
			...row.sessions.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
		].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
		if (pinnedKeys.length) {
			let next = pins;
			for (const k of pinnedKeys) next = togglePin(k);
			setPins(next);
		}
		clearSnooze(row.key);
		// Keep something open if the row being hidden owns the active session.
		if (row.sessions.some((c) => c.id === selectedId)) {
			const candidates = wsRowOrder.filter((r) => r.sessions.length > 0);
			const idx = candidates.findIndex((r) => r.key === row.key);
			const rest = candidates.filter((r) => r.key !== row.key);
			const next =
				idx >= 0
					? (rest[Math.min(idx, rest.length - 1)] ?? null)
					: (rest[0] ?? null);
			if (next) onSelect(next.sessions[0]);
		}
		setHide(row.key);
	}

	// Archive just the open session and pick what becomes active. A workspace
	// with another tab stays on that workspace. When its last tab goes away, the
	// rendered list decides what opens next.
	function archiveOpenSessionWithNext() {
		const row = wsRowOrder.find((candidate) =>
			candidate.sessions.some((session) => session.id === selectedId),
		);
		if (!row) {
			// The open session can be hidden by the current person/repo/search lens.
			// Archiving the active session must not depend on it being rendered.
			const session = sessions.find((s) => s.id === selectedId && !s.archived);
			if (session)
				onArchive(
					session,
					openNextSidebarItem(`session:${session.id}`),
				);
			return;
		}
		const session = row.sessions.find((candidate) => candidate.id === selectedId);
		if (!session) return;
		const siblings = row.sessions.filter((candidate) => candidate.id !== selectedId);
		if (siblings.length > 0) {
			const sessionIdx = row.sessions.findIndex(
				(candidate) => candidate.id === selectedId,
			);
			const sibling = siblings[Math.min(sessionIdx, siblings.length - 1)] ?? null;
			onArchive(
				session,
				sibling
					? () => {
						onSelect(sibling);
						return true;
					}
					: null,
			);
			return;
		}
		onArchive(
			session,
			openNextSidebarItem(`workspace:${row.key}`),
		);
	}

	React.useImperativeHandle(ref, () => ({
		archiveSelected: archiveOpenSessionWithNext,
	}));

	const reportedNextChatAvailable = useRef<boolean | null>(null);
	useLayoutEffect(() => {
		const sidebar = sidebarScrollRef.current?.querySelector("[data-sidebar-list]");
		const workspaceItems = Array.from(
			sidebar?.querySelectorAll<HTMLButtonElement>("button[data-ws-row]") ?? [],
		);
		const renderedItems = Array.from(
			sidebar?.querySelectorAll<HTMLButtonElement>("button[data-sidebar-row]") ??
				[],
		);
		const available = !!(
			nextUnreadRenderedWorkspaceItem(workspaceItems) ??
			nextRenderedSidebarChat(renderedItems)
		);
		if (reportedNextChatAvailable.current === available) return;
		reportedNextChatAvailable.current = available;
		onNextChatAvailableChange?.(available);
	});

	// Advertised keycaps, read through the registry so a rebind in Settings
	// repaints the hints instead of leaving them describing the old chord.
	const newSessionKeys = useShortcutKeys("session-new");
	const pinShortcutKeys = useShortcutKeys("session-pin");
	const archiveShortcutKeys = useShortcutKeys("session-archive");

	// ── Workspace hover card ────────────────────────────────────────────────
	// The same card every sidebar row raises, driven by hand: workspace rows
	// come out of a render function rather than a component, so one card serves
	// the whole list (only one row can be dwelled on at a time) and the hovered
	// row is its anchor. The card carries actions (Archive, PR link,
	// thumbnails), so leaving the row schedules the close with a short grace
	// period and entering the card cancels it — the pointer can travel the 8px
	// gap without the card vanishing under it.
	const wsHoverOpenT = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wsHoverCloseT = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The row element itself is the anchor — the popover tracks it, so a
	// scrolling list repositions the card instead of dropping it.
	const [wsHover, setWsHover] = useState<{ row: WsRow; el: HTMLElement } | null>(
		null,
	);
	// Mobile long-press sheet (the touch stand-in for the hover card).
	const [wsSheet, setWsSheet] = useState<{
		row: WsRow;
		source: HTMLButtonElement;
	} | null>(null);

	const cancelWsHoverTimers = () => {
		if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
		if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
		wsHoverOpenT.current = null;
		wsHoverCloseT.current = null;
	};
	function wsRowHoverEnter(row: WsRow, el: HTMLElement) {
		if (rowRenameEditing(row) || !pointerCanHover()) return;
		cancelWsHoverTimers();
		if (wsHover) {
			setWsHover({ row, el });
			return;
		}
		wsHoverOpenT.current = setTimeout(() => {
			setWsHover({ row, el });
		}, 380);
	}
	function scheduleWsHoverClose() {
		if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
		wsHoverOpenT.current = null;
		if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
		wsHoverCloseT.current = setTimeout(() => setWsHover(null), 140);
	}
	function closeWsHover() {
		cancelWsHoverTimers();
		setWsHover(null);
	}
	useEffect(() => cancelWsHoverTimers, []);


	// ⌘E (or the legacy ⌘⇧A) archives the open session and lands on the next entry
	// in the sidebar, rather than dropping back to Home. This lives here (not in
	// the viewer) because the sidebar owns the row ordering that defines "next".
	// The viewer keeps the same chord only for the unarchive toggle on an
	// already-archived session — that session isn't in this list, so this
	// handler no-ops on it and the two never both fire. ⌘⌥⇧A below escalates to
	// the whole workspace.
	const handleArchiveSessionKey = useEffectEvent((e: KeyboardEvent) => {
		if (e.defaultPrevented || !matchesShortcut(e, "session-archive")) return;
		if (blockingOverlayOpen()) return;
		if (editableSwallowsArchiveChord(e.target)) return;
		const canArchive = sessions.some(
			(s) => s.id === selectedId && !s.archived,
		);
		if (!canArchive) return;
		e.preventDefault();
		closeWsHover();
		archiveOpenSessionWithNext();
	});
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => handleArchiveSessionKey(e);
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// ⌘⌥⇧A escalates the session archive (⌘E/⌘⇧A) to the whole active workspace.
	// The Alt modifier is the only thing that separates the two handlers, so
	// exactly one fires. Targets the workspace holding the open session.
	const handleArchiveWorkspaceKey = useEffectEvent((e: KeyboardEvent) => {
		if (e.defaultPrevented || !matchesShortcut(e, "workspace-archive"))
			return;
		if (editableSwallowsArchiveChord(e.target)) return;
		const row = wsRowOrder.find(
			(r) => r.sessions.length > 0 && r.sessions.some((c) => c.id === selectedId),
		);
		if (!row) return;
		e.preventDefault();
		closeWsHover();
		archiveWorkspaceWithNext(row);
	});
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => handleArchiveWorkspaceKey(e);
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// ⌘P pins the open session's workspace ROW, so the chord and the row's own
	// pin button move the same pin. They used to move different ones: the button
	// pins the workspace key (plus any legacy member-session pins), the viewer's
	// chord pins the session id, so a row pinned by click and then unpinned by
	// chord stayed pinned and the keypress looked dead.
	// The viewer keeps the chord for sessions this list doesn't render — an
	// archived one, or one the current lens filters out. Capture phase, so this
	// runs before the viewer's window listener whatever order they mounted in,
	// and `preventDefault` is what tells it we took the key.
	const handlePinWorkspaceKey = useEffectEvent((e: KeyboardEvent) => {
		if (e.defaultPrevented || !matchesShortcut(e, "session-pin")) return;
		if (blockingOverlayOpen()) return;
		// Decline inside a text field rather than swallowing the key: the
		// viewer's own handler still sees it, so this only ever adds row
		// semantics, never removes the chord from where it worked before.
		if (editableSwallowsArchiveChord(e.target)) return;
		const row = wsRowOrder.find(rowOwnsSelection);
		if (!row) return;
		e.preventDefault();
		workspacePinState(row).toggle();
	});
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => handlePinWorkspaceKey(e);
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);

	// ⌘↓/⌘↑ cycle through the sidebar's rendered items in visual order (down =
	// next row), wrapping at the ends. Reading the DOM here is intentional: each
	// section owns its filtering and collapsed state, so rendered buttons are the
	// single source of truth for what keyboard navigation can reach.
	// Declines inside a text field, the composer included: there ⌘↑/⌘↓ are the
	// caret's own moves to the start and end of the draft, and taking them for
	// workspace cycling costs more than it gives. An empty composer is the one
	// exception, and editableOwnsCaretChord carries the reason. Alt is excluded
	// so ⌘⌥ arrows stay free for the reasoning-effort chord (SessionViewer);
	// Shift so ⌘⇧-arrow text selection keeps working.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.defaultPrevented) return;
			const dir = matchesShortcut(e, "sidebar-next")
				? 1
				: matchesShortcut(e, "sidebar-prev")
					? -1
					: 0;
			if (dir === 0) return;
			if (editableOwnsCaretChord(e.target)) return;
			if (blockingOverlayOpen()) return;
			const candidates = Array.from(
				document.querySelectorAll<HTMLButtonElement>(
					"[data-sidebar-list] button[data-sidebar-row]",
				),
			);
			if (candidates.length === 0) return;
			const idx = candidates.findIndex((item) =>
				item.hasAttribute("data-selected"),
			);
			// No selected sidebar item (e.g. Home): enter from the edge.
			const next =
				idx < 0
					? dir === 1
						? candidates[0]
						: candidates[candidates.length - 1]
					: candidates[(idx + dir + candidates.length) % candidates.length];
			if (!next) return;
			e.preventDefault();
			closeWsHover();
			next.scrollIntoView({ block: "nearest" });
			next.click();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);


	// Mobile: tap-to-open a workspace row fires from `touchend`, not the
	// synthesized click — same trick as SessionRow. The row has :hover styles
	// (the reveal-on-hover pin/archive swap, the hover background) plus a
	// mouseenter hover card, and iOS treats the first tap on such an element as
	// a hover-in, swallowing the click — so a click-driven open needs a second
	// tap. A hold that stays roughly in place for LONG_PRESS_MS opens the
	// workspace menu (the touch stand-in for right-click); real finger travel
	// (a scroll) cancels both. Only one touch happens at a time, so one set of
	// refs serves every row.
	const wsPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wsPressOrigin = useRef<{ x: number; y: number } | null>(null);
	const wsLongPressed = useRef(false);
	const wsMoved = useRef(false);
	const wsSwipeOrigin = useRef<{ x: number; y: number; width: number } | null>(
		null,
	);
	const wsSwiping = useRef(false);
	const [wsSwipe, setWsSwipe] = useState<SwipeState | null>(null);
	const [wsDraggingKey, setWsDraggingKey] = useState<string | null>(null);
	// Which action the in-flight drag is revealing. Split from wsSwipe so a
	// touchmove only re-renders when the side FLIPS — the per-frame offset is
	// written straight to the DOM in wsRowTouchMove.
	const [wsDragSide, setWsDragSide] = useState<SwipeAction | null>(null);
	useEffect(() => {
		if (!isPhone) {
			setWsSwipe(null);
			wsSwipeOffset.current = 0;
			setWsDraggingKey(null);
			setWsDragSide(null);
		}
	}, [isPhone]);
	useEffect(() => {
		setWsSwipe(null);
		wsSwipeOffset.current = 0;
		setWsDraggingKey(null);
		setWsDragSide(null);
	}, [selectedId]);

	function clearWsPress() {
		if (wsPressTimer.current) clearTimeout(wsPressTimer.current);
		wsPressTimer.current = null;
		wsPressOrigin.current = null;
	}
	function wsRowTouchStart(row: WsRow, e: React.TouchEvent) {
		if (rowRenameEditing(row)) return;
		if (e.touches.length !== 1) return;
		const t = e.touches[0];
		wsLongPressed.current = false;
		wsMoved.current = false;
		wsSwiping.current = false;
		clearWsPress();
		if (wsSwipe?.key && wsSwipe.key !== row.key) setWsSwipe(null);
		// After clearWsPress (which nulls it) so it survives to move/end.
		wsPressOrigin.current = { x: t.clientX, y: t.clientY };
		wsSwipeOrigin.current = {
			x: t.clientX - (wsSwipe?.key === row.key ? wsSwipe.offset : 0),
			y: t.clientY,
			width: e.currentTarget.clientWidth,
		};
		const source = e.currentTarget as HTMLButtonElement;
		wsPressTimer.current = setTimeout(() => {
			wsLongPressed.current = true;
			closeWsHover();
			navigator.vibrate?.(10);
			// The touch stand-in for both the hover card AND right-click: a
			// bottom sheet with the overview block plus every workspace action.
			setWsSheet({ row, source });
		}, LONG_PRESS_MS);
	}
	function wsRowTouchMove(row: WsRow, e: React.TouchEvent) {
		if (e.touches.length !== 1) return;
		const t = e.touches[0];
		const swipeO = wsSwipeOrigin.current;
		if (swipeO && !wsLongPressed.current) {
			const dx = t.clientX - swipeO.x;
			const dy = t.clientY - swipeO.y;
			if (
				wsSwiping.current ||
				(Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy))
			) {
				wsSwiping.current = true;
				wsMoved.current = true;
				setWsDraggingKey(row.key);
				clearWsPress();
				e.preventDefault();
				const offset = clampSwipe(dx, swipeO.width);
				wsSwipeOffset.current = offset;
				// Per-frame position goes straight to the DOM: a setState here
				// re-rendered the entire sidebar on every touchmove, which
				// phones can't do at 60fps. React only hears about drag start
				// and side flips; touchend reconciles the committed state.
				const btn = e.currentTarget as HTMLElement;
				btn.style.setProperty("--swipe-x", `${offset}px`);
				btn.parentElement?.style.setProperty(
					"--swipe-action-w",
					`${Math.max(SWIPE_REVEAL_PX, Math.abs(offset))}px`,
				);
				setWsDragSide(swipeActionForOffset(offset));
				return;
			}
		}
		const o = wsPressOrigin.current;
		if (!o) return;
		if (
			Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
			Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
		) {
			wsMoved.current = true;
			clearWsPress();
		}
	}
	// A bold row points to unread activity, so that tab wins over the row's lane
	// or remembered tab. Rows with no unread activity keep their normal routing.
	function openWsRow(row: WsRow, review: boolean) {
		const mainSession = workspaceMainSession(row);
		const unreadSession = pickUnreadWorkspaceSession(row.sessions, selectedId, reads);
		if (unreadSession) {
			if (row.workspace) onOpenWorkspace(row.workspace.id, unreadSession.id);
			else onSelect(unreadSession);
			return;
		}
		// Only open Review when there is something to inspect: a PR, or a branch or
		// worktree that can produce a diff. Otherwise use the normal workspace path.
		const reviewable =
			row.workspace?.prNumber !== undefined ||
			row.sessions.some((s) => sessionHasPr(s) || sessionHasWorkspace(s));
		if (review && reviewable && mainSession) onOpenReview(mainSession);
		else if (row.workspace) onOpenWorkspace(row.workspace.id);
		// Pre-migration grouped rows have no workspace record to restore through.
		else if (mainSession) onSelect(mainSession);
	}
	function wsRowTouchEnd(row: WsRow, e: React.TouchEvent, review = false) {
		const hadOrigin = wsPressOrigin.current !== null;
		const wasSwiping = wsSwiping.current;
		const rowWidth = wsSwipeOrigin.current?.width ?? e.currentTarget.clientWidth;
		// Read the committed distance straight off the ref (like SessionRow),
		// gated on the `wasSwiping` ref — NOT the `wsSwipe` state. Touch events are
		// continuous, so React can batch the last touchmove's setWsSwipe and not
		// re-render before touchend; a `wsSwipe?.key === row.key` gate would then
		// read stale state, collapse the offset to 0, and silently drop the swipe
		// (the intermittent "slide didn't archive"). The ref is always current.
		const swipeOffset = isPhone && wasSwiping ? wsSwipeOffset.current : 0;
		clearWsPress();
		wsSwipeOrigin.current = null;
		wsSwiping.current = false;
		setWsDraggingKey(null);
		setWsDragSide(null);
		// The drag wrote --swipe-x / --swipe-action-w straight onto the DOM;
		// React never owned them, so a re-render with an undefined style prop
		// won't remove them. Clear here; the committed wsSwipe state (if any)
		// re-applies them through the style props on this same flush.
		const rowEl = e.currentTarget as HTMLButtonElement;
		rowEl.style.removeProperty("--swipe-x");
		rowEl.parentElement?.style.removeProperty("--swipe-action-w");
		if (rowRenameEditing(row)) return;
		if (wasSwiping) {
			e.preventDefault();
			if (Math.abs(swipeOffset) >= fullSwipeThreshold(rowWidth)) {
				const action = swipeActionForOffset(swipeOffset);
				if (!action) return;
				setWsSwipe({
					key: row.key,
					offset: swipeCommitOffset(action, rowWidth),
					action,
				});
				window.setTimeout(() => {
					if (action === "archive") {
						if (isDraftWsRow(row)) deleteDraftWsRow(row);
						else archiveWorkspaceWithNext(row, rowEl);
					} else {
						workspacePinState(row).toggle();
						setWsSwipe({ key: row.key, offset: 0, action });
						window.setTimeout(() => setWsSwipe(null), SWIPE_COMMIT_MS);
					}
					wsSwipeOffset.current = 0;
				}, SWIPE_COMMIT_MS);
				return;
			}
			setWsSwipe(
				(() => {
					const snapped =
						Math.abs(swipeOffset) > SWIPE_OPEN_THRESHOLD
							? swipeOffset > 0
								? SWIPE_REVEAL_PX
								: -SWIPE_REVEAL_PX
							: 0;
					wsSwipeOffset.current = snapped;
					return snapped ? { key: row.key, offset: snapped } : null;
				})(),
			);
			return;
		}
		// A clean tap: started on this row, never became a long-press, never
		// turned into a scroll. Open now and swallow the ghost click — which
		// also keeps the synthesized mouseenter from opening the hover card.
		if (hadOrigin && !wsLongPressed.current && !wsMoved.current) {
			e.preventDefault();
			if (wsSwipe?.key === row.key && wsSwipe.offset !== 0) {
				setWsSwipe(null);
				wsSwipeOffset.current = 0;
				return;
			}
			openWsRow(row, review);
		} else if (wsLongPressed.current) {
			// Release after a long-press: the workspace sheet is already up —
			// swallow any ghost click so it can't land on the sheet (or its
			// backdrop's close handler) and immediately dismiss it.
			e.preventDefault();
		}
	}

	// Repo, review, project and support groups are open by default (grouping is
	// itself the point), so we track their *collapsed* state under a
	// "collapsed:" key; every other group is closed by default and tracked
	// directly. This list must match isOpen's — a key toggled here but read
	// bare there (or vice versa) makes its chevron a no-op.
	const collapseKey = (key: string) =>
		key.startsWith("repo:") ||
		key.startsWith("review:") ||
		key.startsWith("project:") ||
		key.startsWith("support:") ||
		key.startsWith("lifecycle:") ||
		key.startsWith("inbox:")
			? `collapsed:${key}`
			: key;

	function toggleGroup(key: string) {
		const stored = collapseKey(key);
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(stored)) next.delete(stored);
			else next.add(stored);
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	// While searching, show everything that matched.
	const isOpen = (key: string) => {
		if (search.trim().length > 0) return true;
		if (
			key.startsWith("repo:") ||
			key.startsWith("review:") ||
			key.startsWith("support:") ||
			key.startsWith("lifecycle:") ||
			key.startsWith("project:") ||
			key.startsWith("inbox:")
		)
			return !expanded.has(`collapsed:${key}`);
		return expanded.has(key);
	};

	// Collapsible bands are open by default, so — like
	// repo groups — their *collapsed* state is what's persisted. Collapsing one
	// hides every group within that band. Searching forces them open.
	const bandOpen = (band: GroupBand | "workspaces") =>
		search.trim().length > 0 ? true : !expanded.has(`collapsed:band:${band}`);
	// A borrowed sidebar is its workspaces list: the tools are gone and the
	// heading is the strip that gets you back out, so there is no caption left
	// to click and nothing to leave behind if the band stayed collapsed. Your
	// own collapse comes back with your own sidebar.
	const workspacesOpen = bandOpen("workspaces") || borrowedLens;
	// Assignee/label/session filter over the Plain queue; free text rides the
	// sidebar-wide search box (title/customer/preview).
	// Generic feed filtering: sidebar search (title/preview + descriptor
	// searchMeta paths), meta-mode filter specs over item.meta, and the
	// builtin linked-session filter. Arg-mode specs were already applied
	// server-side by the fetch. Replaces filteredSupportThreads.
	function sessionForItem(feed: FeedDescriptor, item: FeedItem) {
		return feed.id === "plain"
			? supportSessionByThread.get(item.id)
			: feedSessionByRef.get(`${feed.refKind}:${item.id}`);
	}
	function applyFeedFilters(feed: FeedDescriptor, items: FeedItem[]) {
		let list = items;
		const q = search.trim().toLowerCase();
		if (q)
			list = list.filter((i) =>
				[
					i.title,
					i.preview,
					...(feed.searchMeta || []).map((p) => dget(i.meta, p)),
				].some(
					(v) => typeof v === "string" && v.toLowerCase().includes(q),
				),
			);
		const vals = feedFilters[feed.id] || {};
		for (const spec of feed.filters || []) {
			if (spec.mode !== "meta") continue;
			const sel = vals[spec.key];
			if (!sel) continue;
			list = list.filter((i) => {
				const v = dget(i.meta, spec.field);
				if (v == null || (Array.isArray(v) && v.length === 0))
					return sel === "__unassigned__";
				const els = Array.isArray(v) ? v : [v];
				return els.some(
					(el) =>
						String(dget(el, spec.optionsFromItems?.value) ?? el) === sel,
				);
			});
		}
		if (vals.__session === "with")
			list = list.filter((i) => !!sessionForItem(feed, i));
		else if (vals.__session === "without")
			list = list.filter((i) => !sessionForItem(feed, i));
		return list;
	}
	const automationsOpen = bandOpen("automations");
	const visibleAutomationGroups = automationsOpen ? groups : [];
	const peopleOpen = bandOpen("people");
	function toggleBand(band: GroupBand | "tools" | "workspaces") {
		const key = `collapsed:band:${band}`;
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	// The rows below call `onClick()` with no arguments rather than handing the
	// reference to the button. A handler that takes an optional argument is
	// assignable to `() => void`, so wiring one straight to a DOM `onClick`
	// type-checks and then receives the click event: that is what left Reports
	// dead, because a mouse event carries `view` (the window, from UIEvent) and
	// it overwrote the route's own view.
	const tools: Array<{
		id: SidebarToolId;
		label: string;
		icon: React.ReactNode;
		active: boolean;
		onClick: () => void;
		title?: string;
		count?: number;
	}> = [
		{
			id: "feed",
			label: SIDEBAR_TOOL_LABELS.feed,
			icon: <IconFeed />,
			active: feedActive,
			onClick: onOpenFeed,
			title: "What the team has been shipping",
		},
		{
			id: "prs",
			label: SIDEBAR_TOOL_LABELS.prs,
			icon: <IconPullRequest className={mergeStylexOverrideClassName("", sx.translateXPx, sx.TranslateYPx)} />,
			active: prsActive,
			onClick: onOpenPrs,
			title: "Pull request worktrees",
		},
		{
			id: "tasks",
			label: SIDEBAR_TOOL_LABELS.tasks,
			icon: <IconListCircles />,
			active: tasksActive,
			onClick: onOpenTasks,
			title: "Your open tasks",
			count: taskCount,
		},
		{
			id: "plain",
			label: SIDEBAR_TOOL_LABELS.plain,
			icon: <IconMail />,
			active: plainActive,
			onClick: onOpenPlain,
			title: "Support tickets waiting in Plain",
		},
		{
			id: "catchup",
			label: SIDEBAR_TOOL_LABELS.catchup,
			icon: <IconStack />,
			active: catchUpActive,
			onClick: onOpenCatchUp,
			title: "Swipe through your unread workspaces",
			count: catchUpCount,
		},
		{
			id: "supporttinder",
			label: SIDEBAR_TOOL_LABELS.supporttinder,
			icon: <IconInbox />,
			active: supportTinderActive,
			onClick: onOpenSupportTinder,
			title: "Swipe through the Plain Todo queue",
		},
		{
			id: "reports",
			label: SIDEBAR_TOOL_LABELS.reports,
			icon: <IconFile />,
			active: reportsActive,
			// Called with no target: the row opens the list of reports, while an
			// automation's own report row below passes the one it names.
			onClick: () => onOpenReports(),
			title: "Recurring automation reports",
		},
		{
			id: "analytics",
			label: SIDEBAR_TOOL_LABELS.analytics,
			icon: <IconChart />,
			active: analyticsActive,
			onClick: onOpenAnalytics,
			title: "Sessions, tokens, models & PRs over time",
		},
	];
	// Tools this width offers at all — the switches below only choose among
	// these, so a tool that doesn't fit the viewport is never listed as off.
	const viewportTools = tools.filter((tool) => toolFitsViewport(tool.id, isPhone));
	const fittingTools = mergeSidebarToolOrder(
		toolOrder,
		viewportTools.map((tool) => tool.id),
	).flatMap((id) => {
		const tool = viewportTools.find((candidate) => candidate.id === id);
		return tool ? [tool] : [];
	});
	// None of the tools belong to the person whose sidebar you are borrowing:
	// Tasks and Catch up are yours, and Feed, Pull requests and Analytics are
	// the whole team's. Under a heading with someone else's name on it they
	// read as theirs, so a borrowed sidebar is their workspaces and nothing
	// else. Another teammate, or your own sidebar back, is a click away in
	// "Group, filter & sort" — and the strip at the top is the way out.
	// Support is the one tool whose visibility is not its own: it and the Plain
	// band are two doors onto one queue, and both at once would list the same
	// tickets twice. The tool wins when the independent stored lists say both,
	// because it is the default placement and the band is the alternate.
	const supportSurface = supportSurfaceOf(
		!hiddenTools.has(PLAIN_ID),
		!hiddenFeeds.has(PLAIN_ID),
	);
	const visibleTools = borrowedLens
		? []
		: fittingTools.filter(
				(tool) =>
					!hiddenTools.has(tool.id) &&
					!(productEmpty && tool.id === "prs") &&
					!(tool.id === PLAIN_ID && supportSurface !== "page"),
			);

	const setToolVisible = setSidebarToolVisible;

	// What the sidebar's own right-click menu offers (SidebarToolsMenu): every
	// tool and every source, ticked when it's showing.
	//
	// Support is the exception, and the reason that menu is a real one: where
	// the others tick on or off, it names which of two surfaces its queue lives
	// on, so it is a submenu of three states rather than a tick. No Plain feed
	// means no queue to place, so the row drops out entirely.
	const plainQueueExists = feeds.some((feed) => feed.id === PLAIN_ID);
	const sidebarMenuTools = fittingTools
		.filter((tool) => tool.id !== PLAIN_ID || plainQueueExists)
		.map((tool) => ({
			id: tool.id,
			label: tool.label,
			icon: tool.icon,
			shown: !hiddenTools.has(tool.id),
			...(tool.id === PLAIN_ID ? { surface: supportSurface } : {}),
		}));
	const sidebarMenuSources = feeds
		.filter((feed) => feed.id !== PLAIN_ID)
		.map((feed) => ({
			id: feed.id,
			label: feed.title,
			icon: <RepoTile name={feed.id} className={SIDEBAR_REPO_TILE} />,
			shown: !hiddenFeeds.has(feed.id),
		}));

	// Archived is a destination, not another live workspace group. Keeping it to
	// one row means the sidebar never needs the archive index or its inline rows.
	// The shared rail centres its 20px glyph on the same line as the 18px repo tiles.
	const archivedLink = (
		<button
			className={cn(
				SIDEBAR_GROUP_HEADER,
				SIDEBAR_GROUP_HEADER_INSET,
				SIDEBAR_HEADER_ROW,
				// The one heading that navigates, so the one heading that paints a
				// fill. Its neighbours in the rail collapse a group instead and
				// deliberately take none. See the two signals in sidebar-classes.ts.
				SIDEBAR_HOVER_LAYER,
				utilityClassName("transition-colors"),
				archivedActive && utilityClassName("bg-selected text-fg"),
			)}
			data-selected={archivedActive || undefined}
			onClick={onOpenArchived}
			title="View archived sessions"
		>
			<span className={SIDEBAR_RAIL}>
				<IconArchive size={20} />
			</span>
			<span className={cn(SIDEBAR_GROUP_NAME, utilityClassName("font-semibold"))}>Archived</span>
		</button>
	);

	// One sidebar row per workspace: status dot (most urgent session), name, session
	// count, unread dot. Click opens the first session (or the workspace itself for
	// real workspaces — App resolves that to its first session / scoped New palette).
	// Right-click opens the workspace menu (pin / color / rename / delete);
	// double-click renames inline.
	function renderWsRow(row: WsRow) {
		return renderWsRowImpl(row, false);
	}

	// The "Needs review" band's rows: identical in every way except that a click
	// opens the workspace's Review tab (see openWsRow).
	function renderReviewWsRow(row: WsRow) {
		return renderWsRowImpl(row, false, true);
	}

	// Pinned is the row's visible placement while it is pinned. Its children stay
	// hidden here, keeping one visible subagent row per session.
	function renderPinnedWsRow(row: WsRow) {
		return renderWsRowImpl(row, false, false, false);
	}

	// `inbox` renders the Inbox-mode variant of the same row — a repo tile in
	// front of the title, idle timestamp on every row — with identical behavior
	// (click, swipe, context menu, pin, archive).
	// Separate impl rather than an optional param because `.map(renderWsRow)`
	// callers would pass the array index into it.
	//
	// `review` marks a row under the "Needs review" band, whose click opens the
	// Review tab instead of the session.
	function renderWsRowImpl(
		row: WsRow,
		inbox: boolean,
		review = false,
		includeSubagents = true,
	) {
		const active = rowOwnsSelection(row);
		const editing = rowRenameEditing(row);
		const hasQuestion = row.sessions.some((session) => session.waitingForInput);
		const failed =
			!hasQuestion && !!workspaceRunNeedingAttention(row.sessions);
		// A manually pinned Needs input lane remains blue, but a failed top-level
		// run gets its own red marker rather than masquerading as a question.
		const waiting = !failed && row.status === "needsinput";
		// A review GitHub is still asking you for. Blocked on you, like an
		// unanswered question, so it wears the same blue mark — and it wears it in
		// every band, not only under Needs review, because the whole point is that
		// you can see you were asked without opening anything.
		const needsMyReview = wsPrRequestsReviewFrom(row, mePersonKey);
		// Who is waiting. Covers the Reviewer picker's request as well as the
		// GitHub one: "somebody is waiting on you" is a poor prompt to act on
		// until you know which somebody.
		const reviewAsker = reviewAskerFor(row, currentUser);
		// The "in progress" ticker start: the earliest running session's start, so a
		// workspace with several live sessions shows how long it's been busy overall.
		// Done/idle sessions don't count — only sessions actually running feed the clock.
		// Prefer the server's runStartedAt (survives refresh); fall back to the
		// first moment we saw this row running. Pruned when the row goes idle.
		let runStartMs: number | null = null;
		if (row.running) {
			const stamps = row.sessions
				.filter((c) => c.isRunning && c.runStartedAt)
				.map((c) => Date.parse(c.runStartedAt!))
				.filter((n) => !Number.isNaN(n));
			if (stamps.length) runStartMs = Math.min(...stamps);
			else runStartMs = runStartSeen.get(row.key) ?? null;
		}
		// The yellow duration is a live status, not a sort key. Stable creation
		// ordering makes that distinction honest without taking the useful timer
		// away from Inbox and Project layouts.
		const showRunDuration = runStartMs !== null;
		const snoozed = rowIsSnoozed(row);
		const swipeOffset = isPhone && wsSwipe?.key === row.key ? wsSwipe.offset : 0;
		const swipeAction = isPhone && wsSwipe?.key === row.key ? wsSwipe.action : null;
		const draggingRow = wsDraggingKey === row.key;
		// Which underlay to show: the in-flight drag reveals its side via
		// wsDragSide (per-frame offsets live only in the DOM now), an open or
		// committing row falls back to the reconciled wsSwipe state.
		const swipeSide: SwipeAction | null = draggingRow
			? wsDragSide
			: swipeAction === "archive" || swipeOffset < 0
				? "archive"
				: swipeAction === "star" || swipeOffset > 0
					? "star"
					: null;
		const rowPin = workspacePinState(row);
		const pinned = rowPin.pinned;
		const toggleRowPin = rowPin.toggle;
		// Active snooze → the row wears a wake countdown instead of the idle time.
		const snoozeIso = activeSnoozeKeys.has(row.key)
			? (snoozes[row.key] ?? null)
			: null;
		// Scratch workspaces are the one group with no heading over them (they
		// have no project, and they sit above the bands rather than in one), so
		// their rows carry a full status mark instead of the plain dot.
		const noSectionHeading = rowIsScratch(row);
		const subagents =
			includeSubagents && row.workspace?.id === selectedWorkspaceId
				? activeWorkspaceSubagents
				: [];
		const workspaceRow = (
			<div
				key={row.key}
				className={SIDEBAR_SWIPE_ROW}
				data-swipe-row=""
				style={
					swipeOffset
						? ({
								"--swipe-action-w": `${Math.max(
									SWIPE_REVEAL_PX,
									Math.abs(swipeOffset),
								)}px`,
							} as React.CSSProperties)
						: undefined
				}
			>
				{isPhone && row.sessions.length > 0 && (
					<button
						className={cn(
							SIDEBAR_SWIPE_ACTION,
							SIDEBAR_SWIPE_ACTION_ARCHIVE,
							swipeSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
							draggingRow ? utilityClassName("transition-none") : SIDEBAR_SWIPE_ACTION_TRANSITION,
						)}
						data-swipe-action="archive"
						onClick={(e) => {
							e.stopPropagation();
							setWsSwipe(null);
							archiveWorkspaceWithNext(row);
						}}
						title="Archive workspace"
					>
						<IconArchive size={22} />
						<span>Archive</span>
					</button>
				)}
				{/* A draft row's left swipe deletes instead: it has no session
				    lifecycle yet, and the confirm-on-delete elsewhere (right-click,
				    long-press sheet) would defeat the point of a swipe. */}
				{isPhone && isDraftWsRow(row) && (
					<button
						className={cn(
							SIDEBAR_SWIPE_ACTION,
							SIDEBAR_SWIPE_ACTION_ARCHIVE,
							swipeSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
							draggingRow ? utilityClassName("transition-none") : SIDEBAR_SWIPE_ACTION_TRANSITION,
						)}
						data-swipe-action="delete"
						onClick={(e) => {
							e.stopPropagation();
							setWsSwipe(null);
							deleteDraftWsRow(row);
						}}
						title="Delete draft"
					>
						<IconTrash size={22} />
						<span>Delete</span>
					</button>
				)}
				{isPhone && (
					<button
						className={cn(
							SIDEBAR_SWIPE_ACTION,
							pinned ? SIDEBAR_SWIPE_ACTION_STAR_ON : SIDEBAR_SWIPE_ACTION_STAR,
							swipeSide === "star" && SIDEBAR_SWIPE_ACTION_OPEN,
							draggingRow ? utilityClassName("transition-none") : SIDEBAR_SWIPE_ACTION_TRANSITION,
						)}
						data-swipe-action="star"
						onClick={(e) => {
							e.stopPropagation();
							setWsSwipe(null);
							toggleRowPin();
						}}
						title={pinned ? "Unpin workspace" : "Pin workspace"}
					>
						<IconPin size={22} fill={pinned ? "currentColor" : "none"} />
						<span>{pinned ? "Unpin" : "Pin"}</span>
					</button>
				)}
				<button
					className={cn(
						SIDEBAR_ROW,
						// Inside a swipe row: the wrapper carries the 2px gap and the
						// row carries the slide. The drag writes --swipe-x straight onto
						// the node, so the transform reads it rather than a React style.
						SIDEBAR_WS_ROW,
						// The reserve follows the chips that actually appear: an
						// unpinned row reveals snooze + archive, not the pin, so it
						// gives up one chip less of its right end (26px + the 4px gap).
						!pinned && utilityClassName("hover:pr-[68px]"),
						utilityClassName("z-1 mt-0 touch-pan-y transform-[translateX(var(--swipe-x,0))]"),
						SIDEBAR_HOVER_LAYER,
						// "Needs you" paints no fill of its own: it is a question
						// waiting, not a failure, and the row's one background slot
						// belongs to selection. The blue mark in the rail and the bold
						// title carry it — same as the native app.
						active && utilityClassName("bg-selected"),
						draggingRow
							? utilityClassName("transition-none")
							: swipeSide
								? utilityClassName("transition-transform duration-(--dur-micro)")
								: utilityClassName("transition-transform duration-(--dur)"),
						(draggingRow || swipeSide) && utilityClassName("will-change-transform"),
					)}
					data-sidebar-row=""
					data-ws-row=""
					data-sidebar-item-key={`workspace:${row.key}`}
					data-selected={active || undefined}
					data-waiting={waiting || undefined}
					data-running={row.running || undefined}
					data-unread={row.unread || undefined}
					style={
						swipeOffset
							? ({ "--swipe-x": `${swipeOffset}px` } as React.CSSProperties)
							: undefined
					}
					onClick={(e) => {
					// Touch taps open from touchend (their ghost click is
					// preventDefault'd), so this is the mouse/desktop path. Still
					// swallow a click that ends a long-press, belt-and-suspenders.
					if (wsLongPressed.current) {
						wsLongPressed.current = false;
						e.preventDefault();
						return;
					}
					if (editing) return;
					// Keyboard activation has no mousedown. Give it the same immediate
					// selection feedback before the route render reconciles the sidebar.
					previewSidebarSelection(sidebarScrollRef.current, e.currentTarget);
					openWsRow(row, review);
				}}
					onMouseEnter={(e) => wsRowHoverEnter(row, e.currentTarget)}
					onMouseLeave={scheduleWsHoverClose}
					onMouseDown={(e) => {
					closeWsHover();
					if (e.button === 0 && !editing)
						previewSidebarSelection(sidebarScrollRef.current, e.currentTarget);
				}}
					onTouchStart={(e) => wsRowTouchStart(row, e)}
					onTouchMove={(e) => wsRowTouchMove(row, e)}
					onTouchEnd={(e) => wsRowTouchEnd(row, e, review)}
					onTouchCancel={(e) => {
						clearWsPress();
						wsSwipeOrigin.current = null;
						wsSwiping.current = false;
						setWsDraggingKey(null);
						setWsDragSide(null);
						const rowEl = e.currentTarget as HTMLElement;
						rowEl.style.removeProperty("--swipe-x");
						rowEl.parentElement?.style.removeProperty("--swipe-action-w");
					}}
					onContextMenu={(e) => {
					e.preventDefault();
					// The sidebar's background carries a menu of its own, so this
					// row's has to claim the event rather than let both open.
					e.stopPropagation();
					// On touch this is the long-press callout: our long-press already
					// opened the menu, so don't stack a second one (or the native
					// text-selection callout) on top of it.
					if (wsLongPressed.current || wsPressOrigin.current) return;
					closeWsHover();
					setWorkspaceMenu({
						id: row.workspace ? row.workspace.id : row.key,
						x: e.clientX,
						y: e.clientY,
						source: e.currentTarget,
					});
					}}
					// The button's label replaces its content for assistive tech, so
					// the blocked state — now carried visually by the row's wash —
					// rides here rather than on a marker element.
					aria-label={
						failed
							? `${row.name}, last run failed`
							: waiting
								? `${row.name}, needs your attention`
							: needsMyReview
								? `${row.name}, needs your review`
								: row.name
					}
				>
				{/* A question or requested review is blue. A stopped run is red, so
				    the marker states what happened instead of implying a reply exists. */}
				<span className={SIDEBAR_RAIL}>
					{waiting || needsMyReview ? (
						<span
							className={utilityClassName(`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.waiting}`)}
						/>
					) : failed ? (
						<span
							className={utilityClassName(`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.failed}`)}
						/>
					) : noSectionHeading ? (
						<WsStatusMark row={row} size={18} />
					) : row.running ? (
						<span
							className={utilityClassName(`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.running}`)}
						/>
					) : (
						<WsPrStatusMark
							sessions={row.sessions}
							size={18}
							workspace={row.workspace}
							shipsDirectlyToMain={rowShipsDirectlyToMain(row)}
						/>
					)}
				</span>
				{/* Inbox rows name their repo with the tile alone, in front of the
				    title — the repo/branch meta line it replaces cost a second line
				    per row for two words most of the list repeats. */}
				{inbox && !editing && !rowIsScratch(row) && (
					<RepoTile name={wsRowRepo(row)} size={14} />
				)}
				{editing ? (
					<input
						{...mergeStylexProps("border-[var(--accent,#6b8afd)] desktop:text-item-title", sx.minW0, sx.flex1, sx.roundedMd, sx.border, sx.bgBg, sx.px3px, sx.fontMedium, sx.textInherit, sx.outlineNone, typography.body)}
						value={row.workspace ? workspaceDraft : sessionDraft}
						autoFocus
						onChange={(e) =>
							row.workspace
								? setWorkspaceDraft(e.target.value)
								: setSessionDraft(e.target.value)
						}
						onClick={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onBlur={() =>
							row.workspace
								? commitWorkspaceRename()
								: commitSessionRename(row.sessions[0])
						}
						onKeyDown={(e) => {
							if (e.key === "Enter")
								row.workspace
									? commitWorkspaceRename()
									: commitSessionRename(row.sessions[0]);
							else if (e.key === "Escape")
								row.workspace
									? setEditingWorkspaceId(null)
									: setEditingSessionId(null);
							e.stopPropagation();
						}}
					/>
				) : (
					<span
						// Same class as a session row's title, so workspace rows pick up
						// the shared type scale (incl. the phone bump) and the
						// selected/waiting/unread emphasis from the row's data attributes.
						className={SIDEBAR_ROW_TITLE}
						onDoubleClick={(e) => {
							e.stopPropagation();
							if (row.workspace) {
								setWorkspaceDraft(row.workspace.name);
								setEditingWorkspaceId(row.workspace.id);
							} else if (row.sessions[0]) {
								// Solo session rows rename the session itself.
								startSessionRename(row.sessions[0]);
							}
						}}
					>
						{stripPrTitlePrefix(row.name)}
					</span>
				)}
				{/* Keep machine origin beside the row whether it came from the
				    automation identity, an automation run, or a report's Fix action. */}
				{!editing && rowWasAgentStarted(row) && <AutoCreatedMark />}
				{/* Where the work came from, when the whole row came from one place:
				    a Slack thread, a Linear issue. Same slot and ink as the mark
				    above (SidebarItem carries the session-row half). */}
				{!editing && <OriginMark source={rowOriginSource(row)} />}
				{row.mention && !editing && (
					// Same badge as a session row (SidebarItem): the face of whoever
					// tagged you, with an accent @ so it can't read as a viewer.
					<span
						{...stylex.props(sx.relative, sx.ml1, sx.flex, sx.shrink0, sx.itemsCenter)}
						title={`${row.mention} mentioned you`}
						aria-label={`${row.mention} mentioned you`}
					>
						<UserAvatar name={row.mention} size={16} className={mergeStylexOverrideClassName("", sx.shrink0)} />
						<span
							aria-hidden="true"
							{...mergeStylexProps("ring-2 ring-panel", sx.absolute, sx.Right1, sx.Bottom1, sx.flex, sx.size3, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgAccent, sx.text8px, sx.fontBold, sx.leadingNone, sx.textOnAccent)}
						>
							@
						</span>
					</span>
				)}
				{reviewAsker && !editing && (
					<ReviewAskerFace asker={reviewAsker} />
				)}
				{/* Teammates currently focused on a session in this workspace. */}
				{!editing &&
					(() => {
						const viewers = otherViewers(
							teamViewing
								.filter((v) =>
									row.sessions.some((session) => session.id === v.sessionId),
								)
								.map((v) => v.user),
							currentUser,
						);
						if (!viewers.length) return null;
						return (
							<span
								className={SIDEBAR_WS_FACES}
								aria-label={`Viewing: ${viewers.join(", ")}`}
							>
								{viewers.slice(0, 3).map((viewer, index, shown) => (
									<UserAvatar
										key={viewer}
										name={viewer}
										size={16}
										className={SIDEBAR_WS_FACE}
										style={facepileAvatarStyle(
											index,
											shown.length,
											"var(--sidebar-face-ring)",
										)}
										title={`${viewer} is here`}
									/>
								))}
							</span>
						);
					})()}
				{/* The yellow timer is live status in every layout. It no longer
				    competes with a moving activity sort because Active is creation-stable. */}
				{showRunDuration && runStartMs !== null && (
					<RunTicker startMs={runStartMs} />
				)}
				{snoozeIso && !editing && (
					// A ticker ahead of it has already pushed the cluster right; a
					// second auto margin would split the free space between them.
					<SnoozeBadge
						until={snoozeIso}
						className={showRunDuration ? utilityClassName("ml-1.5") : undefined}
					/>
				)}
				{/* The optional last-used preference remains useful context, but it is
				    no longer the Active list's sort key. A running row gives this slot
				    to its yellow duration instead. */}
				{(inbox || groupsByRepo || !row.workspace) &&
					!snoozeIso &&
					wsTimePref !== "off" &&
					row.lastActivity && (
						<span
							className={cn(
								SIDEBAR_WS_TIME,
								wsTimePref === "hover" && SIDEBAR_WS_TIME_HOVER,
								// The "hover" mode (the default) shows the badge only under
								// the pointer. On touch there is no hover, so it shows inline
								// like "always". A running row keeps its duration instead.
								showRunDuration && utilityClassName("hidden"),
								wsTimePref === "hover" &&
									!showRunDuration &&
									"[@media(hover:none)]:inline-flex",
							)}
							data-ws-time=""
							aria-label={new Date(row.lastActivity).toLocaleString()}
						>
							{shortTime(row.lastActivity)}
						</span>
					)}
				{/* Slack-style pencil: a session here holds an unsent draft — come back
				    and finish it. Yields to the hover actions like the count/time. */}
				<WorkspaceDraftIndicator
					sessionIdsKey={row.sessions.map((session) => session.id).join("\0")}
					pushed={showRunDuration || Boolean(snoozeIso)}
				/>
				{/* Hover actions stay in one predictable order: Pin, Snooze, Archive. */}
				<span
					className={cn(
						SIDEBAR_WS_ACTIONS,
						// A revealed swipe action owns the row's right edge, so the
						// hover cluster stays out of it entirely rather than being
						// hidden again by a more specific rule further down the sheet.
						swipeSide ? utilityClassName("hidden") : SIDEBAR_WS_ACTIONS_HOVER,
					)}
					data-ws-actions=""
				>
					{/* Pin is not one of the row's standing actions: an unpinned row
					    offers snooze and archive, the two moves you make constantly,
					    and pinning stays in the context menu, the ⌘P chord and the
					    swipe. Once a row IS pinned the chip comes back, because
					    unpinning has to be reachable from the thing it marks. */}
					{pinned && (
					<Tooltip
						label="Unpin workspace"
						// Only on the row the chord would actually hit: ⌘P pins the
						// workspace holding the OPEN session, so advertising it on
						// every row would promise a key that lands elsewhere.
						shortcut={active ? (pinShortcutKeys ?? undefined) : undefined}
					>
						<span
							role="button"
							tabIndex={0}
							// One colour, picked here rather than stacking two `text-*`
							// utilities, whose winner would be Tailwind's ordering: a
							// pinned action keeps its accent under the pointer.
							className={cn(SIDEBAR_WS_ACTION, "text-accent")}
							aria-label="Unpin workspace"
							onClick={(e) => {
								e.stopPropagation();
								toggleRowPin();
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.stopPropagation();
									toggleRowPin();
								}
							}}
						>
							<IconPin size={19} fill="currentColor" />
						</span>
					</Tooltip>
					)}
					{row.sessions.length > 0 ? (
						<>
							<Tooltip
								label={snoozed ? "Unsnooze workspace" : "Snooze workspace until Someday"}
							>
								<span
									role="button"
									tabIndex={0}
									className={cn(SIDEBAR_WS_ACTION, utilityClassName("text-faint hover:text-fg"))}
									aria-label={snoozed ? "Unsnooze workspace" : "Snooze workspace"}
									onClick={(e) => {
										e.stopPropagation();
										toggleWorkspaceSnooze(row);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.stopPropagation();
											toggleWorkspaceSnooze(row);
										}
									}}
								>
									<IconMoon size={19} />
								</span>
							</Tooltip>
							<Tooltip
								label="Archive workspace"
								shortcut={
									active ? (archiveShortcutKeys ?? undefined) : undefined
								}
							>
								<span
									role="button"
									tabIndex={0}
									className={cn(SIDEBAR_WS_ACTION, utilityClassName("text-faint hover:text-fg"))}
									aria-label="Archive workspace"
									onClick={(e) => {
										e.stopPropagation();
										archiveWorkspaceWithNext(
											row,
											e.currentTarget.closest<HTMLButtonElement>(
												"button[data-sidebar-row]",
											),
										);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.stopPropagation();
											archiveWorkspaceWithNext(
												row,
												e.currentTarget.closest<HTMLButtonElement>(
													"button[data-sidebar-row]",
												),
											);
										}
									}}
								>
									<IconArchive size={19} />
								</span>
							</Tooltip>
						</>
					) : row.workspace?.draft ? (
						<Tooltip label="Delete draft">
							<span
								role="button"
								tabIndex={0}
								className={cn(SIDEBAR_WS_ACTION, utilityClassName("text-faint hover:text-red"))}
								aria-label="Delete draft"
								onClick={(e) => {
									e.stopPropagation();
									confirmDeleteDraft(() => deleteDraftWsRow(row));
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.stopPropagation();
										confirmDeleteDraft(() => deleteDraftWsRow(row));
									}
								}}
							>
								<IconTrash size={19} />
							</span>
						</Tooltip>
					) : null}
				</span>
				</button>
			</div>
		);
		return (
			<React.Fragment key={row.key}>
				{workspaceRow}
				<ActiveSubagentRows
					items={subagents}
					selectedId={selectedId}
					onSelect={onSelect}
				/>
			</React.Fragment>
		);
	}

	// Quick "mark done" straight from a Support row — optimistic removal (the
	// ticket leaves Plain's Todo queue), restored by a refetch if Plain says no.
	async function markSupportRowDone(threadId: string) {
		setFeedItems((prev) => ({
			...prev,
			plain: (prev.plain || []).filter((x) => x.id !== threadId),
		}));
		await (async () => {
await setPlainThreadStatusApi(threadId, "done", { user: currentUser });
})().catch(async () => {
fetchFeedItems("plain")
				.then((items) =>
					setFeedItems((prev) => ({ ...prev, plain: items })),
				)
				.catch(() => {});
});
	}

	// A Support row: one TODO Plain ticket. The dot wears the linked session's
	// status (faint when no session exists yet); click opens the session, or the
	// session-less ticket preview when there isn't one. Hovering reveals the
	// one-click "mark done" button at the row's right edge.
	function supportThreadActive(t: SupportThread) {
		// The ticket's workspace is open (session-less route or one of its sessions)…
		if (selectedWorkspaceId) {
			const ws = workspaces.find((p) => p.id === selectedWorkspaceId);
			if (ws?.plainThreadId === t.id) return true;
		}
		// …or its linked session is the open session (pre-workspace sessions).
		const session = supportSessionByThread.get(t.id);
		return !!session && session.id === selectedId;
	}

	// A Support row in the workspace rows' shape — see SupportRow for the
	// markup; this binds it to the sidebar's state and handlers.
	function renderSupportRow(t: SupportThread) {
		const pinKey = `support:${t.id}`;
		const linked = supportSessionByThread.get(t.id) || null;
		return (
			<SupportRow
				key={pinKey}
				thread={t}
				session={linked}
				active={supportThreadActive(t)}
				pinned={pins.includes(pinKey)}
				onTogglePin={() => setPins(togglePin(pinKey))}
				onOpen={() => onOpenTicket(t)}
				onMarkDone={() => markSupportRowDone(t.id)}
				onSetStatus={
					linked ? (status) => onSetStatus([linked], status) : undefined
				}
			/>
		);
	}

	// The repo band a workspace row files under. The workspace's own repo wins:
	// it's what the work is *about*, while a session's repo is only the checkout it
	// happens to run from: a PR workspace for one repo whose session runs in
	// another repo's worktree files under the repo it is about. A workspace spanning
	// repos still files under one band (a row in two bands double-counts and
	// reads as two pieces of work); the repo *filter* honours every repo it
	// touches, so it stays findable from the others.
	function wsRowRepo(row: WsRow): string {
		return (
		row.workspace?.repo ||
		row.workspace?.externalRefs?.[0]?.kind ||
		row.sessions[0]?.repo ||
		sessionRepo(row.sessions[0] || ({} as UnifiedSession))
	);
	}
	function shipsDirectlyToMain(
		repo: string | undefined,
		branch: string | null | undefined,
	) {
		const defaultBranch = repo ? directToMainBranches[repo] : undefined;
		return !!defaultBranch && (!branch || branch === defaultBranch);
	}
	function rowShipsDirectlyToMain(row: WsRow) {
		const repo = wsRowRepo(row);
		const branch =
			row.workspace?.branch ||
			row.sessions.find((session) => session.repo === repo)?.branch;
		return shipsDirectlyToMain(repo, branch);
	}
	const rowIsScratch = (row: WsRow) => isScratchWorkspace(row.sessions);
	// Repo-less Ask workspaces get their own band above the projects. Checked
	// BEFORE wsRowRepo's fallbacks, which would otherwise file them under the
	// default project (lib/session-repo).
	const rowIsAsk = (row: WsRow) => isAskWorkspace(row.sessions);

	// A repo band only holds rows that file under a project: renderRepoGroups
	// drops feed-only and scratch rows from every per-repo bucket, and the loose
	// scratch list it renders instead is drawn from the status lanes, which no
	// review row reaches. So under a repo grouping those rows keep the top-level
	// review band. A review being asked of you must not be what vanishes.
	const rowNestsInRepoBand = (row: WsRow) =>
		!rowIsFeedOnly(row) && !rowIsScratch(row);
	const topBandRows = (rows: WsRow[]) =>
		groupsByRepo ? rows.filter((row) => !rowNestsInRepoBand(row)) : rows;

	// The Snoozed group — the quiet zone, shared by the status lanes (slotted
	// just above Backlog) and the inbox bands (appended last, after Earlier).
	// `ns` keeps each repo's copy collapsible on its own.
	function renderSnoozedGroup(rows: WsRow[], ns = "") {
		const gkey = `${ns}status:snoozed`;
		const open = isOpen(gkey);
		return (
			<div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
				<button
					className={cn(
						SIDEBAR_GROUP_HEADER,
						SIDEBAR_GROUP_HEADER_INSET,
						SIDEBAR_LANE_HEADER,
						utilityClassName("transition-colors"),
						SIDEBAR_STICKY_LANE,
						ns && SIDEBAR_STICKY_LANE_NESTED,
						SIDEBAR_STUCK_BACKING,
					)}
					data-sticky-head
					onClick={() => toggleGroup(gkey)}
				>
					<span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>Snoozed</span>
					<span className={SIDEBAR_LANE_COUNT}>{rows.length}</span>
					<IconChevronDown
						className={cn(
							SIDEBAR_GROUP_CHEVRON,
							!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
						)}
						size={12}
						style={{ transform: open ? "none" : "rotate(-90deg)" }}
					/>
				</button>
				{rows
					.filter((r) => open || rowOwnsSelection(r))
					.map(renderWsRow)}
			</div>
		);
	}

	// A labeled flat lane: a caption, a count, its rows. The review lanes
	// (Needs review, Approved, Awaiting review). Under a repo
	// grouping each one rides inside its project's band, beside that project's
	// status lanes, rather than stacked above every band, so the work sits with
	// the rest of the project it belongs to. The repo-less groupings have no
	// band to nest in, so there the same lane stands on its own
	// (renderLabeledBand). `ns` keeps each repo's copy collapsible on its own.
	// Needs review draws its rows with renderReviewWsRow, whose click opens the
	// Review tab, and is the only lane that also carries session-less PR rows:
	// the GitHub review requests pointed at you.
	function renderLabeledLane({
		label,
		name,
		rows,
		prs = [],
		ns = "",
		renderRow = renderWsRow,
	}: {
		label: string;
		name: string;
		rows: WsRow[];
		prs?: ReviewQueueItem[];
		ns?: string;
		renderRow?: (row: WsRow) => React.ReactNode;
	}) {
		if (rows.length === 0 && prs.length === 0) return null;
		const gkey = `${ns}${name}`;
		const open = isOpen(gkey);
		return (
			<div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
				<button
					className={cn(
						SIDEBAR_GROUP_HEADER,
						SIDEBAR_GROUP_HEADER_INSET,
						SIDEBAR_LANE_HEADER,
						utilityClassName("transition-colors"),
						SIDEBAR_STICKY_LANE,
						ns && SIDEBAR_STICKY_LANE_NESTED,
						SIDEBAR_STUCK_BACKING,
					)}
					data-sticky-head
					onClick={() => toggleGroup(gkey)}
				>
					<span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
						{label}
					</span>
					<span className={SIDEBAR_LANE_COUNT}>{rows.length + prs.length}</span>
					<IconChevronDown
						className={cn(
							SIDEBAR_GROUP_CHEVRON,
							!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
						)}
						size={12}
						style={{ transform: open ? "none" : "rotate(-90deg)" }}
					/>
				</button>
				{rows
					.filter((r) => open || rowOwnsSelection(r))
					.map((r) => renderRow(r))}
				{prs.filter((i) => open || prRowSelected(i)).map(renderPrRow)}
			</div>
		);
	}

	// The same lane standing on its own above the project bands: the shape the
	// repo-less groupings use, and what holds the rows no band can (topBandRows).
	// Renders nothing when empty, so a group's gap never opens on an absent band.
	function renderLabeledBand(params: Parameters<typeof renderLabeledLane>[0]) {
		const lane = renderLabeledLane(params);
		return lane && <div className={SIDEBAR_GROUP}>{lane}</div>;
	}

	// The Conductor-style status lanes (Needs input / In progress / …) over a set
	// of workspace rows. `ns` keeps each repo's lane collapse state independent.
	// `snoozedRows` (when given) render as a Snoozed group slotted just above
	// the final Backlog lane: the quiet zone, per the T3-style snooze design.
	function renderStatusLanes(
		rows: WsRow[],
		ns = "",
		snoozedRows?: WsRow[],
		laneRepo?: string,
		prItems: ReviewQueueItem[] = [],
	) {
		// While an eligible Pinned row is mid-drag these lanes double as drop
		// targets: per-repo lanes only for the row's own repo, and empty lanes
		// materialize (dimmed) so every status can take the drop.
		const dropEligible =
			!!pinDragMeta &&
			pinDragMeta.sessions.length > 0 &&
			(!laneRepo || laneRepo === pinDragMeta.repo);
		const lanes = MINE_STATUS_META.map((meta) => {
			const items = rows.filter((r) => r.status === meta.key);
			// Session-less PR rows share the lanes since the PR-band dissolution.
			const prs = prItems.filter((i) => prItemLane(i) === meta.key);
			if (items.length === 0 && prs.length === 0 && !dropEligible)
				return null;
			const gkey = `${ns}status:${meta.key}`;
			const open = isOpen(gkey);
			const dropHover = dropEligible && laneDropHover?.gkey === gkey;
			return (
				<div
					className={cn(
						SIDEBAR_STATUS_GROUP,
						dropEligible &&
							items.length === 0 &&
							prs.length === 0 &&
							SIDEBAR_LANE_EMPTY,
						dropHover && SIDEBAR_LANE_DROP_HOVER,
					)}
					data-status-group
					key={gkey}
					data-lane-drop={dropEligible ? gkey : undefined}
					data-lane-status={dropEligible ? meta.key : undefined}
					data-lane-repo={dropEligible && laneRepo ? laneRepo : undefined}
				>
					<button
						className={cn(
							SIDEBAR_GROUP_HEADER,
							SIDEBAR_GROUP_HEADER_INSET,
							SIDEBAR_LANE_HEADER,
							utilityClassName("transition-colors"),
							SIDEBAR_STICKY_LANE,
							ns && SIDEBAR_STICKY_LANE_NESTED,
							SIDEBAR_STUCK_BACKING,
						)}
						data-sticky-head
						onClick={() => toggleGroup(gkey)}
					>
						<span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>{meta.label}</span>
						<span className={SIDEBAR_LANE_COUNT}>{items.length + prs.length}</span>
						<IconChevronDown
							className={cn(
								SIDEBAR_GROUP_CHEVRON,
								!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
							)}
							size={12}
							style={{ transform: open ? "none" : "rotate(-90deg)" }}
						/>
					</button>
					{items
						.filter((r) => open || rowOwnsSelection(r))
						.map((r) => renderWsRowImpl(r, false))}
					{prs
						.filter((i) => open || prRowSelected(i))
						.map(renderPrRow)}
				</div>
			);
		});
		if (snoozedRows && snoozedRows.length > 0) {
			// Snoozed slots directly after Backlog ("pending") — the quiet zone
			// sits with the parked work, ahead of Ready to merge / Done.
			lanes.splice(
				MINE_STATUS_META.findIndex((m) => m.key === "pending") + 1,
				0,
				renderSnoozedGroup(snoozedRows, ns),
			);
		}
		return lanes;
	}

	// Activity sections separate live work from idle work, then keep attention and
	// draft rows ahead of the date bands. Rows rank by activity inside each band.
	function renderInboxBands(
		rows: WsRow[],
		ns = "",
		snoozedRows: WsRow[] = [],
		prItems: ReviewQueueItem[] = [],
	) {
		const sorted = [...rows].sort((a, b) =>
			(b.lastActivity || "").localeCompare(a.lastActivity || ""),
		);
		const dayStart = new Date();
		dayStart.setHours(0, 0, 0, 0);
		const todayMs = dayStart.getTime();
		const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
		const bands: Array<{
			key: ActivityBand;
			label: string;
			rows: WsRow[];
			prs: ReviewQueueItem[];
		}> = [
			{ key: "inprogress", label: "In progress", rows: [], prs: [] },
			{ key: "needsaction", label: "Needs action", rows: [], prs: [] },
			{ key: "drafts", label: "Drafts", rows: [], prs: [] },
			{ key: "recent", label: "Recent", rows: [], prs: [] },
			{ key: "yesterday", label: "Yesterday", rows: [], prs: [] },
			{ key: "earlier", label: "Earlier", rows: [], prs: [] },
		];
		const bandFor = (key: ActivityBand) =>
			bands.find((band) => band.key === key)!;
		for (const row of sorted) {
			const key = activityBandFor(row, todayMs, isDraftWsRow(row));
			bandFor(key).rows.push(row);
		}
		for (const item of [...prItems].sort((a, b) =>
			(b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""),
		)) {
			const time = Date.parse(item.pr.updatedAt || "");
			if (time >= todayMs) bandFor("recent").prs.push(item);
			else if (time >= yesterdayMs) bandFor("yesterday").prs.push(item);
			else bandFor("earlier").prs.push(item);
		}
		const nodes = bands
			.filter((band) => band.rows.length > 0 || band.prs.length > 0)
			.map((band) => {
				const gkey = `${ns}inbox:${band.key}`;
				const open = isOpen(gkey);
				return (
					<div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
						<button
							className={cn(
								SIDEBAR_GROUP_HEADER,
								SIDEBAR_GROUP_HEADER_INSET,
								SIDEBAR_LANE_HEADER,
								utilityClassName("transition-colors"),
								SIDEBAR_STICKY_LANE,
								ns && SIDEBAR_STICKY_LANE_NESTED,
								SIDEBAR_STUCK_BACKING,
							)}
							data-sticky-head
							onClick={() => toggleGroup(gkey)}
						>
							<span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
								{band.label}
							</span>
							<span className={SIDEBAR_LANE_COUNT}>
								{band.rows.length + band.prs.length}
							</span>
							<IconChevronDown
								className={cn(
									SIDEBAR_GROUP_CHEVRON,
									!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
								)}
								size={12}
								style={{ transform: open ? "none" : "rotate(-90deg)" }}
							/>
						</button>
						{band.rows
							.filter((row) => open || rowOwnsSelection(row))
							.map((row) => renderWsRowImpl(row, !ns))}
						{band.prs.filter((item) => open || prRowSelected(item)).map(renderPrRow)}
					</div>
				);
			});
		if (snoozedRows.length > 0)
			nodes.push(renderSnoozedGroup(snoozedRows, ns));
		return nodes;
	}

	// ── Inbox Active section ───────────────────────────────────────────────
	// Snoozed uses the shared section below; Active keeps its stable creation
	// order and the same compact row density.
	function renderActiveSection(rows: WsRow[], ns = "") {
		const label = "Active";
		if (rows.length === 0) return null;
		const gkey = `${ns}inbox:${label.toLowerCase()}`;
		const open = isOpen(gkey);
		return (
			<div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
				<button
					className={cn(
						SIDEBAR_GROUP_HEADER,
						SIDEBAR_GROUP_HEADER_INSET,
						SIDEBAR_LANE_HEADER,
						utilityClassName("transition-colors"),
						SIDEBAR_STICKY_LANE,
						ns && SIDEBAR_STICKY_LANE_NESTED,
						SIDEBAR_STUCK_BACKING,
					)}
					data-sticky-head
					onClick={() => toggleGroup(gkey)}
				>
					<span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
						{label}
					</span>
					<span className={SIDEBAR_LANE_COUNT}>{rows.length}</span>
					<IconChevronDown
						className={cn(
							SIDEBAR_GROUP_CHEVRON,
							!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
						)}
						size={12}
						style={{ transform: open ? "none" : "rotate(-90deg)" }}
					/>
				</button>
				{rows
					.filter((row) => open || rowOwnsSelection(row))
					.map((row) => renderWsRowImpl(row, !ns))}
			</div>
		);
	}

	function renderWorkspaceGrouping(
		rows: WsRow[],
		ns = "",
		snoozedRows: WsRow[] = [],
		laneRepo?: string,
		prItems: ReviewQueueItem[] = [],
	) {
		if (filter.groupBy === "activity")
			return renderInboxBands(rows, ns, snoozedRows, prItems);
		if (filter.groupBy === "status")
			return renderStatusLanes(rows, ns, snoozedRows, laneRepo, prItems);
		const active = sortInboxByCreation(rows);
		return [
			renderActiveSection(active, ns),
			...prItems.map(renderPrRow),
			...(snoozedRows.length > 0 ? [renderSnoozedGroup(snoozedRows, ns)] : []),
		];
	}

	// Project grouping is independent from the section mode. Each collapsible
	// repo repeats Inbox, Activity, or Status according to the other control.
	// Scratch workspaces stay in one unlabelled group above them:
	// they have no project, even when an older workspace record carries a stale
	// repo. A collapsed band wears a count of the urgent rows it hides. Repos
	// Drag handlers stay outside the render helper so refs are reached only from
	// deferred browser events, never while the helper builds its JSX.
	function moveDraggedRepo(
		targetRepo: string,
		order: string[],
		fullOrder: string[],
		event: React.DragEvent<HTMLDivElement>,
	) {
		const draggedRepo = repoDragging.current;
		if (!draggedRepo || targetRepo === ASK_BAND) return;
		event.preventDefault();
		if (draggedRepo === targetRepo) return;
		const visibleOrder = [
			...(repoVisualOrder.current ?? order.filter((repo) => repo !== ASK_BAND)),
		];
		const from = visibleOrder.indexOf(draggedRepo);
		if (from < 0) return;
		visibleOrder.splice(from, 1);
		let target = visibleOrder.indexOf(targetRepo);
		if (target < 0) return;
		const header = event.currentTarget.querySelector<HTMLElement>(
			":scope > [data-sticky-head]",
		);
		const rect = (header ?? event.currentTarget).getBoundingClientRect();
		if (event.clientY > rect.top + rect.height / 2) target++;
		visibleOrder.splice(target, 0, draggedRepo);
		if (JSON.stringify(visibleOrder) === JSON.stringify(repoVisualOrder.current)) return;
		repoVisualOrder.current = visibleOrder;
		const baseline = repoOrderAtDragStart.current ?? fullOrder;
		const next = replaceVisibleRepoOrder(baseline, visibleOrder);
		repoOrderPending.current = next;
		setRepoOrderDraft(next);
	}
	function finishRepoDrag(commit: boolean) {
		stopRepoAutoScroll();
		repoJustDragged.current = true;
		setTimeout(() => {
			repoJustDragged.current = false;
		}, 0);
		repoOrderAtDragStart.current = null;
		repoVisualOrder.current = null;
		repoDragging.current = null;
		setRepoDragKey(null);
		const pending = repoOrderPending.current;
		repoOrderPending.current = null;
		setRepoOrderDraft(null);
		if (commit && pending) setRepoOrder(pending);
	}
	function startRepoDrag(
		repo: string,
		fullOrder: string[],
		order: string[],
		event: React.DragEvent<HTMLButtonElement>,
	) {
		repoDragging.current = repo;
		setRepoDragKey(repo);
		repoOrderAtDragStart.current = [...fullOrder];
		repoOrderPending.current = null;
		repoVisualOrder.current = order.filter((item) => item !== ASK_BAND);
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", repo);
	}
	function swallowRepoDragClick(event: React.MouseEvent) {
		if (!repoJustDragged.current) return;
		event.preventDefault();
		event.stopPropagation();
	}

	// are ordered by the user's shared preference (`repos`), with newly seen
	// repositories appended in frequency order; a band is force-open while it
	// holds the selected row so the open session never hides inside a collapsed repo.
	function renderRepoGroups() {
		const byRepo = new Map<string, WsRow[]>();
		const snoozedByRepo = new Map<string, WsRow[]>();
		const scratchRows = activeFocusWsRows.filter(
			(row) => !rowIsFeedOnly(row) && rowIsScratch(row),
		);
		const scratchSnoozedRows = snoozedWsRows.filter(
			(row) => !rowIsFeedOnly(row) && rowIsScratch(row),
		);
		const bucket = (map: Map<string, WsRow[]>, repo: string) => {
			let b = map.get(repo);
			if (!b) {
				b = [];
				map.set(repo, b);
			}
			return b;
		};
		// Feed workspaces are represented by their feed band's item rows —
		// don't also mint a pseudo-repo band for them (rowIsFeedOnly above).
		// Repo-less Ask rows bucket under ASK_BAND: wsRowRepo would otherwise
		// file them under the default project, which is the one place they
		// certainly don't belong.
		const bandOf = (r: WsRow) => (rowIsAsk(r) ? ASK_BAND : wsRowRepo(r));
		for (const r of activeFocusWsRows)
			if (!rowIsFeedOnly(r) && !rowIsScratch(r))
				bucket(byRepo, bandOf(r)).push(r);
		// Each repo's snoozed rows stay in that repo's own band, as a Snoozed
		// group beside its other bands — a global Snoozed group would strand
		// them away from their repo.
		for (const r of snoozedWsRows)
			if (!rowIsFeedOnly(r) && !rowIsScratch(r))
				bucket(snoozedByRepo, bandOf(r)).push(r);
		// Session-less PR rows file into their repo's band alongside the
		// workspace rows (the dissolved Pull-requests band). Review requests
		// pointed at you are excluded — they ride the notification band under
		// Pinned instead.
		const prByRepo = new Map<string, ReviewQueueItem[]>();
		for (const item of lanePrItems) {
			const list = prByRepo.get(item.pr.repo) || [];
			list.push(item);
			prByRepo.set(item.pr.repo, list);
		}
		// The review rows sit in their repo's band as lanes of their own. They're
		// absent from focusWsRows (every review-band key is), so they're bucketed
		// separately, and a repo whose only work is a review still earns a band.
		const reviewByRepo = (source: WsRow[]) => {
			const map = new Map<string, WsRow[]>();
			for (const r of source)
				if (rowNestsInRepoBand(r)) bucket(map, bandOf(r)).push(r);
			return map;
		};
		const needsReviewByRepo = reviewByRepo(needsReviewRows);
		const approvedByRepo = reviewByRepo(approvedReviewRows);
		const awaitingReviewByRepo = reviewByRepo(awaitingReviewRows);
		// The GitHub requests pointed at you ride the Needs review lane, keyed by
		// the PR's own repo. They stay out of prByRepo, which files its rows into
		// the status lanes by prItemLane.
		const requestedPrByRepo = new Map<string, ReviewQueueItem[]>();
		for (const item of requestedPrItems) {
			const list = requestedPrByRepo.get(item.pr.repo) || [];
			list.push(item);
			requestedPrByRepo.set(item.pr.repo, list);
		}
		const present = new Set([
			...byRepo.keys(),
			...snoozedByRepo.keys(),
			...needsReviewByRepo.keys(),
			...approvedByRepo.keys(),
			...awaitingReviewByRepo.keys(),
			...prByRepo.keys(),
			...requestedPrByRepo.keys(),
		]);
		// A fresh registered repo still earns its project band in the default
		// lens. Its existing + action is the shortest path to the first session.
		// Search and teammate lenses stay result-driven rather than filling with
		// unrelated empty projects, and so does the whole list once "Empty
		// projects" is set to hidden — except when the list is scoped to one
		// project, where the band is what was asked for rather than clutter.
		if (includesEmptyRepoBands(filter, search)) {
			for (const repo of registeredRepos) {
				if (filter.repo === "all" || filter.repo === repo) present.add(repo);
			}
		}
		const order = [
			...repos.filter((r) => present.has(r)),
			...Array.from(present).filter((r) => !repos.includes(r) && r !== ASK_BAND),
		];
		// Ask is pinned above every project and takes no part in the reorder:
		// it is a band, not a repo. Everything below reads `order` for layout
		// and `fullOrder` for the saved pref, so keeping the sentinel out of
		// the second is what keeps it out of the user's stored repo order.
		const fullOrder = normalizeRepoOrder([
			...normalizeRepoOrder(savedRepoOrder),
			...repos.filter((repo) => !savedRepoOrder.includes(repo)),
			...order.filter((repo) => !repos.includes(repo)),
		]);
		if (present.has(ASK_BAND)) order.unshift(ASK_BAND);
		const canReorder =
			!isPhone &&
			filter.repo === "all" &&
			order.filter((r) => r !== ASK_BAND).length > 1;
		return (
			<>
				{(scratchRows.length > 0 || scratchSnoozedRows.length > 0) && (
					<div {...stylex.props(sx.mb2)} data-sidebar-scratch-workspaces>
						{renderWorkspaceGrouping(
							scratchRows,
							"scratch::",
							scratchSnoozedRows,
						)}
					</div>
				)}
				{/* Every band after the first opens with whitespace, whatever
				    precedes it: a sibling band, this drag-reorder list, or the loose
				    workspace rows above it. `+ band` only matched two bands with the
				    same parent, so the feed projects (Plain, Slack) — which follow
				    this list rather than sit inside it — started flush against the
				    last workspace row of the band above and read as one more of its
				    rows. The gap is wider than a band's own rows (2px) and its lane
				    headers (8px) by enough to separate one project from the next. */}
				<div className="[&:not(:first-child)]:mt-4">
				{order.map((repo) => {
				const rows = byRepo.get(repo) || [];
				const snoozedRows = snoozedByRepo.get(repo) || [];
				const needsReviewRepoRows = needsReviewByRepo.get(repo) || [];
				const approvedRows = approvedByRepo.get(repo) || [];
				const awaitingRepoRows = awaitingReviewByRepo.get(repo) || [];
				const prs = prByRepo.get(repo) || [];
				const requestedPrs = requestedPrByRepo.get(repo) || [];
				// What a collapsed band must not swallow. A row waiting for input
				// and a review being asked of you are both blocked on you, and
				// neither is visible once the band is shut. A question is a
				// question whoever minted the session, so machine-started rows
				// count here too, which they now do by sitting in `rows`.
				const urgent =
					rows.filter((r) => r.status === "needsinput").length +
					needsReviewRepoRows.length +
					requestedPrs.length;
				const gkey = `repo:${repo}`;
				const open = isOpen(gkey);
				// A collapsed band still surfaces the selected row(s) so the
				// open session never hides, without force-opening the band
				// (which made its chevron a frustrating no-op). Review rows keep
				// their own renderer here too, so a click still opens the Review
				// tab rather than the session.
				const selectedRows = open
					? []
					: [...rows, ...snoozedRows, ...awaitingRepoRows].filter(
							rowOwnsSelection,
						);
				const selectedReviewRows = open
					? []
					: [...needsReviewRepoRows, ...approvedRows].filter(rowOwnsSelection);
				const selectedPrs = open
					? []
					: [...prs, ...requestedPrs].filter(prRowSelected);
				return (
					<div
						className={cn(
							"[&:not(:first-child)]:mt-4",
							canReorder && utilityClassName("cursor-grab active:cursor-grabbing"),
							repoDragKey === repo &&
								"[&>[data-sticky-head]]:rounded-md [&>[data-sticky-head]]:bg-hover [&>[data-sticky-head]]:opacity-50 [&>[data-sticky-head]]:ring-1 [&>[data-sticky-head]]:ring-inset [&>[data-sticky-head]]:ring-line-strong",
						)}
						key={gkey}
						data-repo-id={repo}
						onDragOver={(event) => moveDraggedRepo(repo, order, fullOrder, event)}
						onDrop={(event) => {
							event.preventDefault();
							finishRepoDrag(true);
						}}
						onClickCapture={swallowRepoDragClick}
					>
						<button
							className={cn(
								SIDEBAR_GROUP_HEADER,
								SIDEBAR_GROUP_HEADER_INSET,
								SIDEBAR_HEADER_ROW,
								utilityClassName("group transition-colors"),
								SIDEBAR_STICKY_LANE,
								SIDEBAR_STUCK_BACKING,
							)}
							data-sticky-head
							draggable={canReorder && repo !== ASK_BAND}
							title={
								canReorder && repo !== ASK_BAND
									? "Drag to reorder repositories"
									: undefined
							}
							onDragStart={(event) => startRepoDrag(repo, fullOrder, order, event)}
							onDragEnd={() => finishRepoDrag(false)}
							onClick={() => toggleGroup(gkey)}
						>
							{/* The rail holds the tile on the same column (and text rail)
							    as every other header's mark; the tile rides centred in it. */}
							<span className={SIDEBAR_RAIL}>
								{/* Ask has no repo and so no tile. The eye is the same mark
								    the palette's mode picker and the composer use for the
								    mode, so the band reads as "these are Ask sessions"
								    rather than as a project called Ask. */}
								{repo === ASK_BAND ? (
									<IconEye size={16} className={mergeStylexOverrideClassName("", sx.textFaint)} />
								) : (
									<RepoTile name={repo} className={SIDEBAR_REPO_TILE} />
								)}
							</span>
							{/* The differently sized name and count share a baseline, while the
							    pair stays vertically centred against the tile. */}
							<span {...mergeStylexProps("desktop:gap-[9px]", sx.flex, sx.minW0, sx.flex01Auto, sx.itemsBaseline, sx.gap15)} >
								<span className={cn(SIDEBAR_GROUP_NAME, utilityClassName("flex-[0_1_auto] font-semibold"))}>
									{repo === ASK_BAND ? "Ask" : repoLabel(repo)}
								</span>
								<span className={cn(SIDEBAR_GROUP_COUNT, utilityClassName("shrink-0"))}>
									{rows.length +
										snoozedRows.length +
										needsReviewRepoRows.length +
										approvedRows.length +
										awaitingRepoRows.length +
										prs.length +
										requestedPrs.length}
								</span>
							</span>
							{/* Work blocked on you must not vanish into a closed band: a
							    collapsed header wears the count of rows waiting for input
							    and of reviews being asked of you. */}
							{!open && urgent > 0 && (
								<span
									className={cn(SIDEBAR_ATTN_COUNT, utilityClassName("bg-blue"))}
									aria-label={`${urgent} waiting on you`}
								>
									{urgent}
								</span>
							)}
							<IconChevronDown
								className={cn(
									SIDEBAR_GROUP_CHEVRON,
									!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
								)}
								size={22}
								style={{ transform: open ? "none" : "rotate(-90deg)" }}
							/>
							{/* Hover action at the far end: start a new session with this
							    repo already selected. role=button (not a nested <button>).
							    The 28px box is the pointer target; the wash is a ::before
							    inset by 2px, since filling all 28px in a 30px row read as a
							    slab the height of the header. 24px around a 20px glyph is
							    the same proportion `paletteIconBtn` keeps — the step below
							    (20px, i.e. `inset-1` on a 24px glyph) crowds the plus
							    against its own wash. `corner-shape` has to be restated
							    because it does not inherit into a pseudo-element. */}
							{!borrowedLens && (
								<span
									role="button"
									tabIndex={0}
									{...mergeStylexProps("transition-[opacity,color] hover:text-fg focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 before:absolute before:inset-0.5 before:z-0 before:rounded-sm before:[corner-shape:var(--cs)] before:transition-[background] before:content-[''] hover:before:bg-hover [&>*]:relative [&>*]:z-[1]", sx.relative, sx.mlAuto, sx.inlineFlex, sx.size7, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.textFaint, sx.opacity100, sx.duration150)}
									title={
										repo === ASK_BAND
											? "New Ask session, no repo"
											: `New session in ${repoLabel(repo)}`
									}
									onClick={(e) => {
										e.stopPropagation();
										onNewSessionInRepo(repo);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.stopPropagation();
											onNewSessionInRepo(repo);
										}
									}}
								>
									<IconPlus size={20} />
								</span>
							)}
						</button>
						{open ? (
							<div {...stylex.props(sx.mt05)}>
								{renderLabeledLane({
									label: "Needs review",
									name: "needsreview",
									rows: needsReviewRepoRows,
									prs: requestedPrs,
									ns: `repo:${repo}::`,
									renderRow: renderReviewWsRow,
								})}
								{renderLabeledLane({
									label: "Approved",
									name: "approvedreview",
									rows: approvedRows,
									ns: `repo:${repo}::`,
									renderRow: renderReviewWsRow,
								})}
								{renderLabeledLane({
									label: "Awaiting review",
									name: "awaitingreview",
									rows: awaitingRepoRows,
									ns: `repo:${repo}::`,
								})}
								{renderWorkspaceGrouping(
									rows,
									`repo:${repo}::`,
									snoozedRows,
									repo,
									prs,
								)}
							</div>
						) : (
							(selectedReviewRows.length > 0 ||
								selectedRows.length > 0 ||
								selectedPrs.length > 0) && (
								<div {...stylex.props(sx.mt05)}>
									{selectedReviewRows.map(renderReviewWsRow)}
									{selectedRows.map(renderWsRow)}
									{selectedPrs.map(renderPrRow)}
								</div>
							)
						)}
					</div>
				);
				})}
				</div>
			</>
		);
	}

	// ── Plain (support) as a project ────────────────────────────────────────
	// The Plain TODO queue rendered as a sibling of the repo bands: a project
	// whose lanes are priorities (Urgent/High/Normal/Low) instead of statuses.
	// Hidden while a repo filter narrows the list — tickets belong to no repo.
	const plainFeedDesc = visibleFeeds.find((f) => f.id === "plain");
	const plainThreadsInView =
		filter.repo === "all" && plainFeedDesc
			? applyFeedFilters(plainFeedDesc, feedItems.plain || []).map(
					(i) => i.meta as unknown as SupportThread,
				)
			: [];

	// The priority lanes, shared by the Plain project band (nested under it)
	// and the flat "Group by: Status" view (appended after the status lanes).
	// `nested` = rendered inside the Plain project band rather than appended to
	// the flat status list; a nested lane pins one row lower, under that band's
	// own header.
	function renderSupportLanes(threads: SupportThread[], nested = false) {
		return SUPPORT_PRIORITY_GROUPS.map((group) => {
			const items = threads.filter((t) => (t.priority ?? 2) === group.p);
			if (items.length === 0) return null;
			const gkey = `support:prio:${group.p}`;
			const groupIsOpen = isOpen(gkey);
			return (
				<div
					className={SIDEBAR_STATUS_GROUP}
					data-status-group
					key={`support-prio-${group.p}`}
				>
					<button
						className={cn(
							SIDEBAR_GROUP_HEADER,
							SIDEBAR_GROUP_HEADER_INSET,
							SIDEBAR_LANE_HEADER,
							SIDEBAR_STICKY_LANE,
							nested && SIDEBAR_STICKY_LANE_NESTED,
							SIDEBAR_STUCK_BACKING,
						)}
						data-sticky-head
						onClick={() => toggleGroup(gkey)}
					>
						<span
							className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME, group.p <= 1 && group.cls)}
						>
							{group.label}
						</span>
						<span className={cn(SIDEBAR_LANE_COUNT, group.cls)}>
							{items.length}
						</span>
						<IconChevronDown
							className={cn(
								SIDEBAR_GROUP_CHEVRON,
								utilityClassName("ml-auto"),
								!groupIsOpen && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
							)}
							size={20}
							style={{
								transform: groupIsOpen ? "none" : "rotate(-90deg)",
							}}
						/>
					</button>
					{items
						.filter((t) => groupIsOpen || supportThreadActive(t))
						.map(renderSupportRow)}
				</div>
			);
		});
	}

	// The Plain queue filter (assignee / label / has-session) — rides the
	// project band's header as a span-rendered menu trigger (the header itself
	// is a button, so a nested <button> trigger is off the table). Free text
	// rides the sidebar-wide search box.
	// Is a feed item's workspace (or its linked session) the open surface?
	function feedItemActive(feed: FeedDescriptor, item: FeedItem) {
		if (selectedWorkspaceId) {
			const ws = workspaces.find((p) => p.id === selectedWorkspaceId);
			if (
				ws?.externalRefs?.some(
					(r) => r.kind === feed.refKind && r.id === item.id,
				)
			)
				return true;
		}
		const session = feedSessionByRef.get(`${feed.refKind}:${item.id}`);
		return !!session && session.id === selectedId;
	}

	// A generic feed band (videos, dashboards, …) styled like the Plain project band:
	// brand tile + name + count, newest-first rows nested under
	// (the feeds design). Hidden while a repo filter is active, like Plain.
	function renderFeedBand(feed: FeedDescriptor, withLanes = false) {
		const isPlain = feed.id === "plain";
		const sortSel =
			(feedFilters[feed.id] || {}).__sort ||
			feed.sortOptions?.[0]?.value ||
			"recent";
		const metaSortPath = sortSel.startsWith("meta:")
			? sortSel.slice(5)
			: null;
		const items = applyFeedFilters(feed, feedItems[feed.id] || []).sort(
			(a, b) =>
				metaSortPath
					? (Number(dget(b.meta, metaSortPath)) || 0) -
						(Number(dget(a.meta, metaSortPath)) || 0)
					: sortSel === "title"
						? a.title.localeCompare(b.title)
						: sortSel === "oldest"
							? (a.ts || 0) - (b.ts || 0)
							: (b.ts || 0) - (a.ts || 0),
		);
		// Plain rows render through the bespoke SupportRow pipeline (hover
		// card, mark-done, filters) inside this generic band container; the
		// filtered thread list is the source of truth for it.
		const plainThreads = isPlain ? plainThreadsInView : null;
		const count = isPlain ? plainThreads!.length : items.length;
		// An active filter (or search) must never hide the band — zero matches
		// with no visible filter menu is a trap you can't click out of. Only a
		// genuinely empty feed (no raw items, nothing filtered away) hides.
		const vals = feedFilters[feed.id] || {};
		const hasActiveFilter =
			Object.entries(vals).some(([k, v]) => v && k !== "__sort") ||
			!!search.trim();
		const rawCount = (feedItems[feed.id] || []).length;
		if ((count === 0 && rawCount === 0 && !hasActiveFilter) || filter.repo !== "all")
			return null;
		const gkey = isPlain ? "project:plain" : `project:feed-${feed.id}`;
		const open = isOpen(gkey);
		const renderRow = (item: FeedItem) => {
			const pinKey = `feed:${feed.refKind}:${item.id}`;
			const linked = feedSessionByRef.get(`${feed.refKind}:${item.id}`) || null;
			return (
				<FeedRow
					key={`${feed.id}:${item.id}`}
					feed={feed}
					item={item}
					session={linked}
					active={feedItemActive(feed, item)}
					pinned={pins.includes(pinKey)}
					onTogglePin={() => setPins(togglePin(pinKey))}
					onOpen={() => onOpenFeedItem(feed, item)}
					onSetStatus={
						linked ? (status) => onSetStatus([linked], status) : undefined
					}
				/>
			);
		};
		// Collapsed band still surfaces the active item/ticket (same rule as
		// the repo bands' selected rows).
		const activeItems = open
			? []
			: items.filter((i) => feedItemActive(feed, i));
		const activeThreads =
			open || !isPlain ? [] : plainThreads!.filter(supportThreadActive);
		// Attention badge on a collapsed band (e.g. Plain's Urgent lane).
		const attentionCount = feed.attentionLane
			? isPlain
				? plainThreads!.filter((t) => (t.priority ?? 2) === 0).length
				: items.filter((i) => i.lane === feed.attentionLane).length
			: 0;
		const noMatches = (
			<div {...stylex.props(sx.px3, sx.py2, sx.textFaint, typography.label)}>
				No items match the filters
			</div>
		);
		const openBody = isPlain ? (
			<div {...stylex.props(sx.mt05)}>
				{count === 0
					? noMatches
					: withLanes
						? renderSupportLanes(plainThreads!, true)
						: [...plainThreads!]
								.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
								.map(renderSupportRow)}
			</div>
		) : (
			<div {...stylex.props(sx.mt05)}>
				{count === 0 ? noMatches : items.map(renderRow)}
			</div>
		);
		const collapsedBody = isPlain
			? activeThreads.length > 0 && (
					<div {...stylex.props(sx.mt05)}>
						{activeThreads.map(renderSupportRow)}
					</div>
				)
			: activeItems.length > 0 && (
					<div {...stylex.props(sx.mt05)}>
						{activeItems.map(renderRow)}
					</div>
				);
		return (
			<div className="[&:not(:first-child)]:mt-4" key={gkey}>
				<ContextMenu.Root>
					<ContextMenu.Trigger
						render={
							<button
								className={cn(
									SIDEBAR_GROUP_HEADER,
									SIDEBAR_GROUP_HEADER_INSET,
									SIDEBAR_HEADER_ROW,
									utilityClassName("group transition-colors"),
									SIDEBAR_STICKY_LANE,
									SIDEBAR_STUCK_BACKING,
								)}
								data-sticky-head
								onClick={() => toggleGroup(gkey)}
							/>
						}
					>
						<span className={SIDEBAR_RAIL}>
							<RepoTile name={feed.id} className={SIDEBAR_REPO_TILE} />
						</span>
						<span {...mergeStylexProps("desktop:gap-[9px]", sx.flex, sx.minW0, sx.flex01Auto, sx.itemsBaseline, sx.gap15)} >
							<span className={cn(SIDEBAR_GROUP_NAME, utilityClassName("flex-[0_1_auto] font-semibold"))}>{feed.title}</span>
							<span className={cn(SIDEBAR_GROUP_COUNT, utilityClassName("shrink-0"))}>{count}</span>
						</span>
						{!open && attentionCount > 0 && (
							<span
								className={cn(SIDEBAR_ATTN_COUNT, utilityClassName("bg-red"))}
								aria-label={`${attentionCount} urgent`}
							>
								{attentionCount}
							</span>
						)}
						<IconChevronDown
							className={cn(
								SIDEBAR_GROUP_CHEVRON,
								!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
							)}
							size={22}
							style={{ transform: open ? "none" : "rotate(-90deg)" }}
						/>
						<FeedFilterMenu
							feed={feed}
							values={feedFilters[feed.id] || {}}
							rawItems={feedItems[feed.id] || []}
							currentUser={currentUser}
							onSet={(k, v) => setFeedFilter(feed, k, v)}
							onHide={() => setSidebarFeedVisible(feed.id, false)}
						/>
					</ContextMenu.Trigger>
					<ContextMenu.Popup>
						<ContextMenu.Item
							onClick={() => setSidebarFeedVisible(feed.id, false)}
						>
							Hide from sidebar
						</ContextMenu.Item>
					</ContextMenu.Popup>
				</ContextMenu.Root>
				{open ? openBody : collapsedBody}
			</div>
		);
	}

	// The sidebar's fixed head: the organization row, the tool rows, and the
	// Workspaces band heading with its filter and new-session buttons.
	//
	// On desktop this whole block is chrome — it holds its place under the window
	// chrome while only the workspace list below it scrolls, so the top of the
	// rail never slides away and there is no edge for a hairline to mark. The
	// strip that used to name whose sidebar this is went with the same move: the
	// Workspaces band heading says it once.
	//
	// The band used to earn its place by pinning (SIDEBAR_STICKY_BAND, still on
	// it for the phone layout). Out here it does not have to: it is simply above
	// the scrollport, which is what pinning was imitating. That also means the
	// tier-2 lane headers inside the list pin at the scroll's own top rather than
	// one band-slot down — see the `--sidebar-band-slot` override on SIDEBAR_LIST.
	//
	// Phones keep the whole sidebar as one page, so there the same markup is the
	// scroll's first child and scrolls away with the list.
	const sidebarChrome = (
	<div
		// Desktop lifts this strip out of the scrollport, so it sets the rail's
		// own scales here rather than inheriting them from the scroll root. On
		// phones it is still the scroll's first child and reads the same values
		// twice, which costs nothing: they are one string either way.
		data-density={density}
		className={cn(
			utilityClassName("block max-w-full min-w-0 flex-none"),
			SIDEBAR_DENSITY_VARS,
			SIDEBAR_NAV_X,
		)}
		style={{ order: 0 }}
	>
	{/* The tools carry no heading. "Tools" named a handful of self-evident
	    destinations (Home, Reviews, Tasks) sitting at the very top of the
	    rail, where nothing else can be confused for them, and it cost a
	    caption plus the gap around it before the first thing you can
	    click. Phones already listed them bare; desktop matches now.

	    Its two jobs moved rather than went: the collapse is gone (it hid
	    at most a few rows and a collapsed band left the top of the
	    sidebar looking empty), and the ••• menu that chose which tools
	    show is now in the right-click menu on any tool row, beside the
	    "Remove from toolbar" that already lived there. Take the last
	    tool off and the organization selector remains; the sidebar's own
	    right-click menu still lists every tool. */}
	<nav
			className={cn(
				// `--sidebar-nav-x` is the sidebar's own (SIDEBAR_NAV_X); the strip
				// reads it rather than setting one, so the tools sit on the same
				// edges as the lists under them.
				//
				// One vertical list at every width. Phones used to get a
				// horizontally-scrolling line of Slack-home style tap cards, which
				// put the tools in a different language from everything under
				// them: the sidebar is a column of rows, and the cards were a
				// sideways shelf that kept its own tail off the right edge. A list
				// reads the same on both clients, shows every tool at once without
				// a gesture, and takes a quarter of the height per tool.
				//
				// The organization row leads this rail on desktop now that the old
				// heading is gone. Pull it slightly closer to the fixed top bar there;
				// phones keep the original spacing because their first row is a tool.
				utilityClassName("flex flex-col gap-0.5 px-[var(--sidebar-nav-x)] pt-2 pb-1.5 desktop:pt-0.5"),
			)}
		>
			<div className={utilityClassName("phone:hidden")}>
				<OrganizationSwitcher
					connected={connected}
					onOpenSettings={onOpenSettings}
				/>
			</div>
			{visibleTools.map((tool) => {
				const rowClass = cn(
					// One look at both widths. Only the box changes, and only
					// because a phone row is pressed rather than read.
					utilityClassName("group flex items-center text-left transition-colors"),
					// Rows use control-label type, with glyphs matching the
					// sidebar's standard 22px leading rail.
					// `--sidebar-tool-pad` is 5px for a 32px box: the tools are a
					// short utility strip above the work lists, and at the session
					// rows' 36px the four of them took more of the rail than what
					// they lead to. The glyph and the label's left rail are
					// untouched, so they still line up with the rows below; only
					// the air around them is tighter.
					// Don't take it below 30. At 28 (`py-[3px]`, the pre-ffd11ffc
					// value) the 22px glyph has 3px of margin and the hover pill
					// stops reading as a row; the compact density's 4px stops at
					// 30, level with the rows under it rather than below them.
					// Phones override it to the 13px the session rows take
					// (SIDEBAR_ROW, lib/sidebar-classes.ts) for a 48px box: 32px is
					// a reading height, not a tap target.
					utilityClassName(`w-full ${SIDEBAR_RAIL_GAP} rounded-row bg-transparent px-[calc(var(--sidebar-icon-left)-var(--sidebar-nav-x))] py-[var(--sidebar-tool-pad)] phone:py-[13px] text-body font-medium text-dim desktop:text-item-title hover:text-fg`),
					SIDEBAR_HOVER_LAYER,
					tool.active && utilityClassName("bg-selected text-fg"),
				);
				const rowBody = (
					<>
						<span
							className={cn(
								utilityClassName("inline-flex text-faint [&_svg]:size-[22px]"),
								tool.active ? utilityClassName("text-dim") : "group-hover:text-dim",
							)}
						>
							{tool.icon}
						</span>
						{tool.label}
						{!!tool.count && (
							// `rounded-full`, not `rounded-[999px]`: this pill never
							// carried a corner-shape, and rounded-full is the one
							// radius spelling base.css does NOT squircle.
							<span {...stylex.props(sx.mlAuto, sx.roundedFull, sx.bgAccent, sx.px7px, sx.pyPx, sx.leading15, sx.fontSemibold, sx.textOnAccent, typography.meta)}>
								{tool.count}
							</span>
						)}
					</>
				);
				// Right-click drops this tool from the strip, the same gesture
				// the feed headers use to hide themselves, and opens the chooser
				// that puts any of them back. Desktop only: phones have no
				// right-click, and the chooser is itself desktop-only, so a
				// stray long-press there would only be recoverable from
				// Settings.
				const row = isPhone ? (
					<button
						key={tool.id}
						className={rowClass}
						onClick={() => tool.onClick()}
						title={tool.title}
					>
						{rowBody}
					</button>
				) : (
					<ContextMenu.Root key={tool.id}>
						<ContextMenu.Trigger
							render={
								<button
									className={rowClass}
									onClick={() => tool.onClick()}
									title={tool.title}
								/>
							}
						>
							{rowBody}
						</ContextMenu.Trigger>
						{/* This menu is now the only place that chooses which tools
						    show, since the band heading that held the ••• is gone.
						    "Remove from toolbar" leads, about the row you opened the
						    menu on: the list under it can do the same thing by
						    unticking that row, but the command names the tool you
						    already aimed at, which is the common case and the one
						    worth a click rather than a read. "Hide tools from
						    sidebar" used to close the menu, and it went: it was the
						    same decision as unticking every row, a step further than
						    anyone reaches for by accident. */}
						<ContextMenu.Popup>
							<ContextMenu.Item
								onClick={() => setToolVisible(tool.id, false)}
							>
								<IconEyeOff size={20} className={MENU_ICON} />
								<span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
									Remove from toolbar
								</span>
							</ContextMenu.Item>
							<ContextMenu.Separator />
							<ContextMenu.Group>
								<ContextMenu.GroupLabel>
									Show in toolbar
								</ContextMenu.GroupLabel>
								{/* The same rows the sidebar's own right-click menu lists
								    (SidebarToolRows), so the two menus cannot drift: each
								    wears the mark it wears in the sidebar, the tick sits
								    at the trailing edge, and Support stays a submenu of
								    surfaces rather than a tick. */}
								<SidebarToolRows
									tools={sidebarMenuTools}
									onToggleTool={setToolVisible}
									onSetSupport={setSupportSurface}
								/>
							</ContextMenu.Group>
						</ContextMenu.Popup>
					</ContextMenu.Root>
				);
				// Feed carries the team at its right edge, with every face shown
				// neutrally, and lets you pick up someone's sidebar without
				// leaving the row you're on. The pile opens the same lens menu
				// the Feed page's own chips write, so the row is both a way in
				// and the shortcut past it. It has to be a sibling of the row,
				// not a child: a button can't nest one. Phones carry it too,
				// now that the tools are rows there rather than cards: the row
				// has the width for a pile at its right edge, and the pile is
				// its own target laid over it rather than a hover reveal, so a
				// tap on a face opens the lens and a tap anywhere else opens
				// Feed.
				if (tool.id !== "feed" || team.length === 0) return row;
				return (
					<div key={tool.id} {...mergeStylexProps("group/team-lens", sx.relative)} >
						{row}
						<TeamLensMenu
							members={team}
							size={20}
							max={4}
							// The ring is opaque so the face behind cannot bleed into
							// the gap. Match whichever sidebar surface the trigger is
							// currently painted on.
							ring="var(--team-face-ring)"
							compact
							side="right"
							align="start"
							value={personLensValue(filter.person, currentUser)}
							label={personLensName}
							onPick={(next) =>
								setFilter({ person: personLensFilter(next, currentUser) })
							}
							// Phones pad the trigger out to the row's own height so
							// the faces are a thumb-sized target rather than a 24px
							// one. It stays a pill either way, so the padding is only
							// reach: nothing about it reads larger at rest.
							className={mergeStylexOverrideClassName("phone:py-2.5 [--team-face-ring:var(--sidebar-bg)] group-hover/team-lens:[--team-face-ring:var(--row-chip)] data-[popup-open]:[--team-face-ring:var(--row-chip)]", sx.absolute, sx.right2, sx.top12, sx.TranslateY12)}
						/>
					</div>
				);
			})}
		</nav>

	<div
		className={cn(
			// SIDEBAR_STICKY_BAND_ROW folds this into one fixed slot, but it is
			// desktop-gated, so on phones the raw `mt-1 pt-3` stands. With the
			// caption hidden and the chevron invisible-but-in-layout, that was a
			// near-empty band between the tool cards and the first project, which
			// read as the strip being bottom-heavy. Nothing to set off there.
			utilityClassName("mt-1 pb-0.5 pt-3 phone:mt-0 phone:pt-0"),
			// A borrowed lens hides the tools strip, so this bar becomes the
			// first thing in the phone scroll. Give it enough air to clear the
			// floating top bar's fade instead of letting its top edge wash out.
			borrowedLens && utilityClassName("phone:pt-4"),
			// A caption starts on the rail's 16px text column; the borrowed
			// lens's strip is a filled bar, so it takes the rows' own 8px
			// inset instead and lines up with the workspace pills under it.
			borrowedLens ? utilityClassName("px-2") : utilityClassName("px-[16px] pr-[7px]"),
			SIDEBAR_STICKY_BAND,
			SIDEBAR_STICKY_BAND_ROW,
			SIDEBAR_STUCK_BACKING,
		)}
		data-sticky-head
	>
		<div
			className={cn(
				utilityClassName("group/wshead flex min-w-0 items-center gap-1.5 desktop:w-full"),
				// In someone else's sidebar this row IS the strip: one bar that
				// names whose lanes these are, takes you back out, and carries
				// the header's own actions. The name was being said twice —
				// once by a strip above the tools, once by this heading — and
				// each said it with its own ✕.
				borrowedLens &&
					utilityClassName("min-h-10 w-full rounded-row bg-blue-soft pl-3 pr-1 phone:min-h-12 phone:pl-3.5 desktop:h-full desktop:min-h-0"),
			)}
			ref={headRef}
		>
			{borrowedLens ? (
				<>
					{/* The bar reports the active lens. Closing it is a separate
					    action at the far edge, so the label stays visually stable and
					    the close control gets a full touch target. */}
					<div
						{...mergeStylexProps("phone:text-base", sx.flex, sx.minW0, sx.flex1, sx.itemsCenter, sx.gap2, sx.textSm, sx.textFg)}
						ref={titleRef as React.RefObject<HTMLDivElement | null>}
					>
						{filter.person === "everyone" ? (
							<IconPeople
								size={20}
								className={mergeStylexOverrideClassName("phone:-translate-y-px", sx.shrink0, sx.translateY05px, sx.textDim)}
							/>
						) : (
							filter.person !== "unassigned" && (
								<UserAvatar
									name={personLensName}
									size={20}
									className={mergeStylexOverrideClassName("", sx.shrink0)}
								/>
							)
						)}
						<span {...stylex.props(sx.minW0, sx.truncate, sx.fontSemibold)}>
							{filter.person === "everyone"
								? "Everyone"
								: filter.person === "unassigned"
									? "Unassigned"
									: personLensName}
						</span>
					</div>
					<Tooltip label="Back to your workspaces">
						<button
							{...mergeStylexProps("transition-[color,scale] before:absolute before:inset-2 before:rounded-md before:transition-colors before:content-[''] hover:text-fg hover:before:bg-hover active:scale-[0.96] phone:size-11 motion-reduce:transform-none [&>*]:relative [&>*]:z-[1]", sx.relative, sx.flex, sx.size10, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.border0, sx.bgTransparent, sx.textDim)}
							onClick={() => setFilter({ person: "me" })}
							aria-label="Back to your workspaces"
						>
							<IconX size={18} aria-hidden="true" />
						</button>
					</Tooltip>
				</>
			) : (
			<button
				className={cn(
					utilityClassName("group/wstoggle flex min-w-0 items-center gap-[5px] [font:inherit]"),
					// On phones the caption is hidden and the chevron only paints on
					// hover, so while the band is open this button is a 22px row of
					// nothing between the tool cards and the first project. That row
					// is most of what made the strip read bottom-heavy, and an
					// invisible tap target is not an affordance worth its space.
					// Collapsed it stays: the chevron IS visible then
					// (SIDEBAR_BAND_CHEVRON_COLLAPSED), and it is the only way to
					// open the band back up.
					isPhone && workspacesOpen && utilityClassName("hidden"),
				)}
				onClick={() => toggleBand("workspaces")}
				aria-expanded={workspacesOpen}
				title={workspacesOpen ? "Collapse workspaces" : "Expand workspaces"}
			>
				{/* The heading takes the same inset every other glyphless label
				    does, so it starts on the column its repo tiles and lane
				    captions do (see
				    the band toggle). The sidebar header already reads as
				    "Workspaces" on phones, so the in-header title is redundant
				    there. */}
				<span
					className={cn(
						// The band caption, same as SIDEBAR_BAND_LABEL wears one
						// section down: this heading is written inline rather than
						// composed from it only because of the strip above.
						utilityClassName("shrink-0 text-label font-semibold text-dim group-hover/wshead:text-fg"),
						isPhone && utilityClassName("hidden"),
					)}
					ref={titleRef as React.RefObject<HTMLSpanElement | null>}
				>
					Workspaces
				</span>
				<IconChevronDown
					className={cn(
						SIDEBAR_BAND_CHEVRON,
						"group-hover/wstoggle:visible",
						!workspacesOpen && SIDEBAR_BAND_CHEVRON_COLLAPSED,
					)}
					size={18}
					style={{
						transform: workspacesOpen ? "none" : "rotate(-90deg)",
					}}
				/>
			</button>
			)}
			{/* Repo filter chip, inline behind the title when it fits. */}
			{filter.repo !== "all" && repoInline && (
				<RepoFilterChip
					repo={filter.repo}
					repos={repos}
					onClear={() => setFilter({ repo: "all" })}
					onSelect={(v) => setFilter({ repo: v })}
					variant="inline"
				/>
			)}
			{/* The active lens label already grows to push its close control to
			    this edge. Your own sidebar still needs the flexible spacer. */}
			{!borrowedLens && <div {...stylex.props(sx.minW0, sx.flex1)} />}
			{/* Grouped so the pair's combined width can be measured when deciding
			    whether the repo chip fits inline. Gone on phones, where filter
			    moves to the top bar and the red FAB covers new-session. Gone in a
			    borrowed lens too: both act on YOUR sidebar, so grouping or
			    starting a session from inside someone else's bar is either a
			    no-op you can't see or work filed somewhere you didn't mean. The
			    bar keeps the one action that belongs to it, which is leaving. */}
			<div
				className={cn(
					utilityClassName("shrink-0 items-center gap-1.5"),
					isPhone || borrowedLens ? utilityClassName("hidden") : utilityClassName("flex"),
				)}
				ref={actionsRef}
			>
				<Tooltip label="Group, filter & sort">
				<button
					ref={setFilterButton}
					className={cn(
						SIDEBAR_HEADER_BTN,
						isPhone
							? cn(SIDEBAR_HEADER_BTN_PHONE, utilityClassName("min-h-[38px] min-w-[38px]"))
							: SIDEBAR_HEADER_BTN_DESKTOP,
						utilityClassName("inline-flex items-center justify-center"),
						// The open state paints the stronger wash and the hover now
						// layers OVER it (SIDEBAR_HOVER_LAYER), so the button no
						// longer has to withhold its hover to keep from washing
						// itself back out while open.
						SIDEBAR_HOVER_LAYER,
						filterOpen && utilityClassName("border-line-strong bg-pressed"),
						// A set filter is already spelled out in the header (the repo
						// chip) and in the popover itself, so the button stays a plain
						// glyph: full contrast under the pointer or while open.
						filterOpen ? utilityClassName("text-fg") : utilityClassName("text-dim hover:text-fg"),
					)}
					// A Base UI tooltip is a DESCRIPTION, not a name, so an
					// icon-only trigger still needs one of its own. The phone twin
					// below always carried this; the desktop button did not.
					aria-label="Group, filter & sort"
					onClick={() => setFilterOpen((o) => !o)}
				>
					{/* 22, the scale's standalone step: these are section-header
					    actions, not the primary buttons or window chrome that take
					    24. At 24 the plus drew a 16px span against the 15.5 of the
					    search glyph in the titlebar row right above, and the filter
					    is filled bars, so the pair read a step larger than the row
					    they sit under. */}
					<IconFilter size={22} />
				</button>
				</Tooltip>
				{/* ⌘S, not the ⌘⌥N this used to advertise: that chord opens a
				    sibling session inside the workspace you have open, while
				    this button (onNewSession → the palette) starts one in a new
				    workspace. */}
				<Tooltip
					label="New session"
					shortcut={newSessionKeys ?? undefined}
				>
				<button
					className={cn(
						SIDEBAR_HEADER_BTN,
						isPhone
							? SIDEBAR_HEADER_BTN_PHONE
							: SIDEBAR_HEADER_BTN_DESKTOP,
						utilityClassName("inline-flex items-center justify-center text-dim hover:bg-hover hover:text-fg"),
					)}
					onClick={onNewSession}
				>
					<IconPlus size={22} />
				</button>
				</Tooltip>
			</div>
			{/* Off-layout probe: measures the chip's natural width so the effect
			    above can decide whether it fits inline (never rendered visibly). */}
			{filter.repo !== "all" && (
				<RepoFilterChip repo={filter.repo} variant="probe" ref={probeRef} />
			)}
		</div>
	</div>
	</div>
	);

	const workspaceMenuWorkspace = workspaceMenu
		? workspaces.find((workspace) => workspace.id === workspaceMenu.id)
		: undefined;
	const workspaceMenuRow = workspaceMenu
		? wsRows.find((row) =>
				workspaceMenuWorkspace
					? row.workspace?.id === workspaceMenuWorkspace.id
					: row.key === workspaceMenu.id,
			)
		: undefined;

	return (
		<>
		{/* Desktop: fixed chrome above the scrollport. It is a sibling of the
		    scroll rather than its first child, so the organization row, the tools
		    and the Workspaces heading hold their place while the list runs under
		    them. */}
		{!isPhone && sidebarChrome}
		{/* The scrollport is the right-click target for the sidebar's own menu.
		    Only the background reaches it, since every row stops the event on its
		    way up to open its own menu. Phones are left alone because row sheets
		    own the long-press gesture there. */}
		<ContextMenu.Root disabled={isPhone}>
		<ContextMenu.Trigger
			render={
		<div
			// One element sets the rail's whole vertical scale and carries the
			// attribute the compact values key off, so density is a property the
			// rows inherit rather than a flag every family has to be handed.
			data-density={density}
			className={cn(
				utilityClassName("flex w-full min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"),
				SIDEBAR_DENSITY_VARS,
				SIDEBAR_NAV_X,
				// The whole sidebar scrolls as one on phones, so the tools (and the
				// Workspaces header) scroll away with the list instead of staying
				// pinned above a separately-scrolling list. The top bar floats over
				// it (.app-header-overlay), so pad the scroll's top by the bar height.
				// The tools clear the pills at rest and the list scrolls under them.
				// Fade the list into the bar with a mask, and keep the last section
				// clear of the home indicator.
				isPhone &&
					utilityClassName("pt-[var(--header-h)] pb-[max(24px,env(safe-area-inset-bottom,0px))] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_var(--header-h))] [mask-image:linear-gradient(to_bottom,transparent_0,#000_var(--header-h))]"),
			)}
			ref={sidebarScrollRef}
			onDragOver={handleRepoAutoScroll}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null))
					stopRepoAutoScroll();
			}}
		/>
			}
		>
			{isPhone && sidebarChrome}

			<div {...stylex.props(sx.block, sx.maxWFull, sx.minW0, sx.flexNone)}>

				{/* Fallback row: only when the chip doesn't fit inline. */}
				{filter.repo !== "all" && !repoInline && (
					<div {...mergeStylexProps("md:mr-2 md:ml-4", sx.mx4, sx.mt2px, sx.mb2, sx.flex, sx.minW0)} >
						<RepoFilterChip
							repo={filter.repo}
							repos={repos}
							onClear={() => setFilter({ repo: "all" })}
							onSelect={(v) => setFilter({ repo: v })}
							variant="row"
						/>
					</div>
				)}

			{/* On phones the filter button lives in the top bar (next to Search);
			    its popover anchors there. Desktop keeps it in the header. */}
			{isPhone &&
				!borrowedLens &&
				headerActionsEl &&
				createPortal(
					<>
						<button
							ref={setMobileFilterButton}
							className={mobileFilterBtn(filterOpen)}
							onClick={() => setFilterOpen((o) => !o)}
							aria-label="Group, filter & sort"
						>
							<IconFilter size={22} />
						</button>
					</>,
					headerActionsEl,
				)}

			{filterOpen && (
				<FilterPopover
					anchor={isPhone ? mobileFilterButton : filterButton}
					filter={filter}
					repos={repos}
					people={peopleWithAgent}
					currentUser={currentUser}
					onChange={setFilter}
					onClose={() => setFilterOpen(false)}
					onCustomize={() => {
						setFilterOpen(false);
						setCustomizeOpen(true);
					}}
				/>
			)}

			{workspaceMenu && (
				<WorkspaceContextMenu
					menu={workspaceMenu}
					workspace={workspaceMenuWorkspace}
					row={workspaceMenuRow}
					pins={pins}
					currentUser={currentUser}
					activeSnoozeKeys={activeSnoozeKeys}
					snoozes={snoozes}
					hiddenRowKeys={hiddenRowKeys}
					onPinsChange={setPins}
					onSetStatus={onSetStatus}
					onSnooze={(row, until) =>
						until ? setSnooze(row.key, until) : clearSnooze(row.key)
					}
					onStartWorkspaceRename={(workspace) => {
						setWorkspaceDraft(workspace.name);
						setEditingWorkspaceId(workspace.id);
					}}
					onStartSessionRename={startSessionRename}
					onToast={onToast}
					onOpenReview={onOpenReview}
					onHide={(row, hidden) =>
						hidden ? clearHides([row.key]) : hideRow(row)
					}
					onArchive={archiveWorkspaceWithNext}
					onDeleteDraft={(workspace) =>
						confirmDeleteDraft(() => onDeleteWorkspace(workspace.id))
					}
					onClose={() => setWorkspaceMenu(null)}
				/>
			)}
			{workspacesOpen && (
				<div
					className={cn(
						SIDEBAR_LIST,
						// The band heading these lanes sit under is fixed chrome above the
						// scrollport on desktop, not a pinned row inside it, so there is no
						// band slot for them to clear: a lane pins at the scroll's own top.
						// Scoped here rather than on the scroll root because the bands BELOW
						// this list (Automations, People) still pin inside it and their lanes
						// still have to clear them.
						"desktop:[--sidebar-band-slot:0px]",
					)}
					data-sidebar-list
				>
				{sessionsLoading && sessions.length === 0 && (
					<ListSkeleton
						variant="bare"
						rows={8}
						label="Loading sessions"
						className={mergeStylexOverrideClassName("", sx.py2)}
						rowClassName={utilityClassName("px-2.5 py-[9px] phone:px-2 phone:py-[13px]")}
					/>
				)}
				{/* A list that failed to fetch is an empty list with a reason, not a
				    validation error: it takes the same quiet centred treatment as
				    "No matching workspaces" below, one step up in ink, plus the
				    button that fixes it. The red alert box this replaced framed the
				    sidebar's own column in a border and outshouted the rows. */}
				{sessionsError && sessions.length === 0 && !sessionsLoading && (
					<EmptyState
						className={mergeStylexOverrideClassName("", sx.mx4, sx.my7, sx.gap15, sx.py0)}
						action={
							<Button size="sm" onClick={onRetrySessions}>
								Try again
							</Button>
						}
					>
						{/* The one red thing: the sentence itself carries the hue, so
						    the failure is legible at a glance without a box around
						    it. EmptyState's own copy colour is `text-dim`, which a
						    class on the wrapper would not beat. */}
						<span {...stylex.props(sx.textRed)}>Couldn't load sessions</span>
					</EmptyState>
				)}
				{workspaceListEmpty &&
					!sessionsLoading &&
					!sessionsError &&
					hasWorkspaceFilter && (
					<div {...stylex.props(sx.mx4, sx.my7, sx.textCenter, sx.leading14, sx.textFaint, typography.label)}>
						No matching workspaces
					</div>
				)}
				{/* One row even with nothing in the list: the session you have not
				    started yet, whose input is the main panel. It stands in for the
				    "No workspaces yet" line, which said the same thing without
				    offering anything to do about it. Phones keep their own empty
				    state below, where the sidebar is the whole screen and the panel
				    it would point at is a nav push away. */}
				{draftRow && (
					<DraftRow
						active={!!draftRowActive}
						onClick={() => onOpenDraft?.()}
					/>
				)}
				{workspaceListEmpty &&
					!sessionsLoading &&
					!sessionsError &&
					!hasWorkspaceFilter &&
					!draftRow &&
					(!isPhone || !productEmpty) && (
					<div {...stylex.props(sx.mx4, sx.my7, sx.textCenter, sx.leading14, sx.textFaint, typography.label)}>
						No workspaces yet
					</div>
				)}
				{productEmpty &&
					!sessionsLoading &&
					!sessionsError &&
					!hasWorkspaceFilter &&
					isPhone && (
					<div {...stylex.props(sx.flex, sx.minH360px, sx.flexCol, sx.itemsCenter, sx.justifyCenter, sx.px7, sx.py12, sx.textCenter)}>
						<IconMessages size={30} className={mergeStylexOverrideClassName("", sx.mb3, sx.textDim)} />
						<div {...stylex.props(sx.leading115, sx.fontSemibold, sx.tracking002em, sx.textFg, typography.sectionTitle)}>
							No sessions
						</div>
						<p {...mergeStylexProps("m-0", sx.mt1, sx.maxW26ch, sx.leading145, sx.textDim, sx.textPretty, typography.body)} >
							Start one and it shows up here.
						</p>
						<div {...stylex.props(sx.mt4, sx.flex, sx.flexCol, sx.itemsCenter, sx.gap1)}>
							<Button
								variant="soft"
								size="md"
								className={mergeStylexOverrideClassName("", sx.roundedFull, sx.px4)}
								onClick={onNewSession}
							>
								New session
							</Button>
							<Button variant="ghost" size="sm" onClick={onOpenArchived}>
								Archived
							</Button>
						</div>
					</div>
				)}

				{/* ── Needs review: everything waiting on YOUR review, both the
				    sessions a teammate asked you to look at (the info panel's
				    Reviewer picker) and the GitHub PRs that requested you. Both are
				    the same ask, so they share one band, and it rides above
				    everything like a blocked question. Under a repo grouping each
				    project's reviews ride that project's own band instead
				    (renderRepoGroups); what stays here is the rows no band can hold.
				    PRs already covered by a workspace row in view are filtered out
				    of prRowItems, so nothing appears twice. ── */}
				{renderLabeledBand({
					label: "Needs review",
					name: "needsreview",
					rows: topBandRows(needsReviewRows),
					prs: groupsByRepo ? [] : requestedPrItems,
					renderRow: renderReviewWsRow,
				})}

				{/* ── Approved: reviews you asked for that came back with a yes and
				    are still open. An approval belongs with the rest of that
				    project's work rather than stacked above every band, so under a
				    repo grouping it rides its repo's band as a lane. ── */}
				{renderLabeledBand({
					label: "Approved",
					name: "approvedreview",
					rows: topBandRows(approvedReviewRows),
					renderRow: renderReviewWsRow,
				})}

				{/* ── Awaiting review: sessions YOU asked a teammate to review (the
				    mirror of Needs review). Grouped so a session you've sent out for
				    review moves out of the status lanes into one place. ── */}
				{renderLabeledBand({
					label: "Awaiting review",
					name: "awaitingreview",
					rows: topBandRows(awaitingReviewRows),
				})}

				{/* ── Pinned (workspaces, sessions, tickets, PRs, feed items) ── */}
				{(() => {
					const pinnedRows = pinnedWsRows;
					// Pinned sessions that don't map to a workspace row (automation runs).
					const rowSessionIds = new Set(
						wsRows.flatMap((r) => r.sessions.map((c) => c.id)),
					);
					const pinnedLoose = pins
						.filter((e) => !e.startsWith("workspace:"))
						.filter((id) => !rowSessionIds.has(id))
						.map((id) =>
							sessions.find(
								(s) => s.id === id || s.aliasIds?.includes(id),
							),
						)
						// An archived session must never surface in Pinned — its pin is
						// stale (archiving drops it server-side, but a resurrected or
						// legacy pin can still point at it). Skip it so it can't render
						// as an un-archivable ghost row.
						.filter((s): s is UnifiedSession => !!s && !s.archived)
						.filter((s) => !activeWorkspaceSubagentIds.has(s.id))
						// Honor the repo filter — a pinned session from another repo
						// shouldn't leak into a repo-scoped view (workspace pins
						// already drop out via wsRows/filtered).
						.filter(
							(s) => filter.repo === "all" || sessionRepo(s) === filter.repo,
						);
					// Pinned Plain tickets and PRs — resolved against the live
					// queues, so a done ticket / closed PR just stops rendering
					// (its stale pin key is harmless, like an archived session's).
					const pinnedTickets = pins
						.filter((e) => e.startsWith("support:"))
						.map((e) =>
							(supportThreads || []).find((t) => t.id === e.slice(8)),
						)
						.filter((t): t is SupportThread => !!t);
					// Pinned feed items (videos, dashboards):
					// resolved against the live feed items like tickets are.
					const pinnedFeedItems = pins
						.filter((e) => e.startsWith("feed:"))
						.map((e) => {
							const [, refKind, ...idParts] = e.split(":");
							const id = idParts.join(":");
							const feed = feeds.find((f) => f.refKind === refKind);
							const item = feed
								? (feedItems[feed.id] || []).find((i) => i.id === id)
								: undefined;
							return feed && item ? { feed, item } : null;
						})
						.filter(
							(x): x is { feed: FeedDescriptor; item: FeedItem } => !!x,
						);
					const pinnedPrs = pins
						.filter((e) => e.startsWith("pr:"))
						.map((e) =>
							reviewQueueItems.find((i) => i.pr.url === e.slice(3)),
						)
						.filter((i): i is ReviewQueueItem => !!i)
						// Once a workspace carries this PR, the workspace row is the
						// single place for it, even if an older standalone PR pin remains.
						.filter((item) => !workspaceCoveredPrUrls.has(item.pr.url));
					if (
						!pinnedRows.length &&
						!pinnedLoose.length &&
						!pinnedTickets.length &&
						!pinnedFeedItems.length &&
						!pinnedPrs.length
					)
						return null;
					const pinnedOpen = isOpen("pinned");

					// One flat drag-to-reorder list: every pinned thing (workspace row,
					// loose session, ticket) becomes an entry slotted by its first key's
					// position in the pins array, so reordering is just rewriting that
					// array (reorderPins). `pinKeys` is everything in `pins` that maps
					// to the entry — a workspace can be pinned via its own key AND
					// legacy member-session pins — so a drop moves them as one unit.
					type PinEntry = {
						key: string;
						pinKeys: string[];
						/** Lane-drop payload: the sessions a lane drop re-lanes (empty
						    = not droppable, e.g. a pinned ticket) + the entry's repo
						    for the same-repo rule under per-repo lanes. */
						repo: string | null;
						sessions: UnifiedSession[];
						node: React.ReactNode;
					};
					const pinIdx = new Map(pins.map((p, i) => [p, i] as const));
					const entries: PinEntry[] = [];
					for (const row of pinnedRows) {
						entries.push({
							key: `ws:${row.key}`,
							pinKeys: [row.key, ...row.sessions.map((c) => c.id)].filter((k) =>
								pinIdx.has(k),
							),
							repo: wsRowRepo(row),
							sessions: row.sessions,
							node: renderPinnedWsRow(row),
						});
					}
					const seenLoose = new Set<string>();
					for (const s of pinnedLoose) {
						// A session pinned via both its id and an alias maps to the same
						// session twice — render (and reorder) it once.
						if (seenLoose.has(s.id)) continue;
						seenLoose.add(s.id);
						const pin = sessionPinState(s);
						entries.push({
							key: `session:${s.id}`,
							pinKeys: [s.id, ...(s.aliasIds ?? [])].filter((k) =>
								pinIdx.has(k),
							),
							repo: sessionRepo(s),
							sessions: [s],
							node: (
								<SidebarItem
									session={s}
									selected={automationRowSelected(s)}
									unread={
										s.id !== selectedId &&
										isUnread(s.id, s.lastActivity, reads)
									}
									mention={
										s.id !== selectedId ? mentionFor(s.id)?.by : undefined
									}
									mine={
										!!s.startedBy &&
										!s.automation &&
										s.startedBy.toLowerCase() === currentUser.toLowerCase()
									}
									onClick={() => onSelect(s)}
									onArchive={(current) => archiveWithNext(s, current)}
									pinned={pin.pinned}
									onTogglePin={pin.toggle}
									shipsDirectlyToMain={shipsDirectlyToMain(s.repo, s.branch)}
									onRename={(title) => onRename(s, title)}
									onSetStatus={(st) => onSetStatus([s], st)}
								/>
							),
						});
					}
					for (const t of pinnedTickets) {
						entries.push({
							key: `support:${t.id}`,
							pinKeys: [`support:${t.id}`],
							repo: null,
							sessions: [],
							node: renderSupportRow(t),
						});
					}
					for (const { feed, item } of pinnedFeedItems) {
						const pinKey = `feed:${feed.refKind}:${item.id}`;
						const linked =
							feedSessionByRef.get(`${feed.refKind}:${item.id}`) || null;
						entries.push({
							key: pinKey,
							pinKeys: [pinKey],
							repo: null,
							sessions: [],
							node: (
								<FeedRow
									key={pinKey}
									feed={feed}
									item={item}
									session={linked}
									active={feedItemActive(feed, item)}
									pinned
									onTogglePin={() => setPins(togglePin(pinKey))}
									onOpen={() => onOpenFeedItem(feed, item)}
									onSetStatus={
										linked
											? (status) => onSetStatus([linked], status)
											: undefined
									}
								/>
							),
						});
					}
					for (const item of pinnedPrs) {
						entries.push({
							key: `pr:${item.pr.url}`,
							pinKeys: [`pr:${item.pr.url}`],
							repo: null,
							sessions: [],
							node: renderPrRow(item),
						});
					}
					const firstIdx = (e: PinEntry) =>
						e.pinKeys.length
							? Math.min(...e.pinKeys.map((k) => pinIdx.get(k)!))
							: Infinity;
					entries.sort((a, b) => firstIdx(a) - firstIdx(b));
					// Mid-drag, Motion's in-flight order wins until the drop commits it.
					if (pinOrderDraft) {
						const draftIdx = new Map(
							pinOrderDraft.map((k, i) => [k, i] as const),
						);
						entries.sort(
							(a, b) =>
								(draftIdx.get(a.key) ?? Infinity) -
								(draftIdx.get(b.key) ?? Infinity),
						);
					}
					const entryMap = new Map(entries.map((e) => [e.key, e] as const));
					// Whole-row y-drag would fight touch scrolling and the swipe
					// gestures, so drag reorder is desktop-only; the order itself is
					// per-user server state, so a desktop reorder shows up on the phone.
					// (>0, not >1: even a lone pinned row can be dragged into a lane.)
					const canDragPins = !isPhone && entries.length > 0;
					const commitPinReorder = () => {
						setPinDragKey(null);
						pinJustDragged.current = true;
						// The drop's click fires synchronously after pointerup; clear the
						// swallow flag right after so the next real click works.
						setTimeout(() => {
							pinJustDragged.current = false;
						}, 0);
						// A drop onto a status lane wins over the reorder: lane-pin the
						// row's sessions there and unpin it — dragging OUT of Pinned reads
						// as a move, unlike right-click Set-status which keeps the pin
						// (the row shows in both the Pinned band and its lane).
						const laneDrop = laneDropHoverRef.current;
						const dragMeta = pinDragMetaRef.current;
						pinDragMetaRef.current = null;
						setPinDragMeta(null);
						laneDropHoverRef.current = null;
						setLaneDropHover(null);
						if (laneDrop && dragMeta && dragMeta.sessions.length > 0) {
							pinOrderPending.current = null;
							setPinOrderDraft(null);
							setPins(unpin(dragMeta.pinKeys));
							onSetStatus(dragMeta.sessions, laneDrop.lane);
							return;
						}
						const orderKeys = pinOrderPending.current;
						pinOrderPending.current = null;
						setPinOrderDraft(null);
						if (!orderKeys) return;
						// New pins array: the visible entries' keys take the slots that
						// visible keys already occupy (in the new order), so pins hidden
						// from the band (archived, repo-filtered, review-band rows) keep
						// their exact positions instead of getting shoved to the end.
						const flat = orderKeys.flatMap(
							(k) => entryMap.get(k)?.pinKeys ?? [],
						);
						const visible = new Set(flat);
						const queue = [...flat];
						setPins(
							reorderPins(
								pins.map((p) => (visible.has(p) ? (queue.shift() ?? p) : p)),
							),
						);
					};
					const pinnedCount = entries.length;
					return (
						<div className={SIDEBAR_GROUP}>
							{/* Same header treatment as the status lanes below. */}
							<button
								className={cn(
									SIDEBAR_GROUP_HEADER,
									SIDEBAR_GROUP_HEADER_INSET,
									SIDEBAR_LANE_HEADER,
									SIDEBAR_STICKY_LANE,
									SIDEBAR_STUCK_BACKING,
								)}
								data-sticky-head
								onClick={() => toggleGroup("pinned")}
							>
								<span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
									Pinned
								</span>
								<span className={SIDEBAR_LANE_COUNT}>{pinnedCount}</span>
								<IconChevronDown
									className={cn(
										SIDEBAR_GROUP_CHEVRON,
										!pinnedOpen && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
									)}
									size={12}
									style={{ transform: pinnedOpen ? "none" : "rotate(-90deg)" }}
								/>
							</button>
							{pinnedOpen && (
								<Reorder.Group
									as="div"
									axis="y"
									values={entries.map((e) => e.key)}
									onReorder={(keys: string[]) => {
										pinOrderPending.current = keys;
										setPinOrderDraft(keys);
									}}
								>
									{entries.map((e) => (
										<Reorder.Item
											as="div"
											key={e.key}
											value={e.key}
											dragListener={canDragPins}
											transition={{ duration: 0 }}
											onDragStart={() => {
												setPinDragKey(e.key);
												const meta = {
													repo: e.repo,
													sessions: e.sessions,
													pinKeys: e.pinKeys,
												};
												pinDragMetaRef.current = meta;
												setPinDragMeta(meta);
											}}
											onDrag={(
												ev: MouseEvent | TouchEvent | PointerEvent,
											) => {
												if ("clientX" in ev)
													updateLaneDropHover(ev.clientX, ev.clientY);
											}}
											onDragEnd={commitPinReorder}
											whileDrag={{ scale: 1.01 }}
											className={cn(
												SIDEBAR_PIN_ENTRY,
												pinDragKey && SIDEBAR_PIN_DRAG_ACTIVE,
												pinDragKey === e.key && SIDEBAR_PIN_ENTRY_DRAGGING,
											)}
											onClickCapture={(ev: React.MouseEvent) => {
												// Swallow the click that lands on the row when a drag
												// is dropped — it would open the session under the
												// cursor.
												if (pinJustDragged.current) {
													ev.preventDefault();
													ev.stopPropagation();
												}
											}}
										>
											{e.node}
										</Reorder.Item>
									))}
								</Reorder.Group>
							)}
						</div>
					);
				})()}

				{/* ── Workspaces: status lanes live directly under the Workspaces
				    header above (which carries the filter, new-workspace and
				    new-session actions) — no second in-list heading. ── */}
				<div className={SIDEBAR_GROUP}>
					{/* Inbox, Activity, and Status choose the row sections. Project
					    independently decides whether those sections repeat per repo. */}
					{/* Snoozed rows sit out of focusWsRows, so each layout places
					    them itself: under a project band every band gets its own
					    Snoozed group (renderRepoGroups), the ungrouped inbox renders
					    a single global one after the rows, and the status lanes slot
					    it above Backlog via renderStatusLanes. */}
					{/* Plain (support tickets) renders as one more project: a band
					    beside the repos with priority lanes nested under it — or,
					    under ungrouped status lanes, its priority lanes appended
					    after them so everything reads as one list. */}
					{/* Session-less PR and feed rows keep their project-shaped sections;
					    Active/Snoozed applies to workspace rows with resumable sessions. */}
					{groupsByRepo ? (
						<>
							{renderRepoGroups()}
							{visibleFeeds.map((d) => renderFeedBand(d, true))}
						</>
					) : (
						[
							...renderWorkspaceGrouping(
								activeFocusWsRows,
								"",
								snoozedWsRows,
								undefined,
								filter.groupBy === "status" ? lanePrItems : [],
							),
							...(filter.groupBy === "status"
								? [
										...renderSupportLanes(plainThreadsInView),
										...visibleFeeds
											.filter((d) => d.id !== "plain")
											.map((d) => renderFeedBand(d, false)),
									]
								: visibleFeeds.map((d) => renderFeedBand(d, true))),
						]
					)}
				</div>

				{/* The agent's own workspaces, switched from the foot of the list
				    it is adding to or taking from: after the rows it counts, where
				    the list runs out and you would wonder what is missing. It says
				    which way it goes, so it is always its own undo. Faint: it is
				    a note about the list, not a row in it.

				    It does not say "auto created". The Automations band sits
				    directly under this switch, and one word for two different
				    things reads as though this controls that: an automation is a
				    job somebody configured, while these are one-off workspaces an
				    agent opened for itself with no automation behind them. */}
				{autoCreatedRows > 0 && (
					<button
						className={cn(
							utilityClassName("mb-1 flex w-full items-center gap-1.5 rounded-row px-4 py-1.5 text-left text-label text-faint"),
							SIDEBAR_HOVER_LAYER,
							utilityClassName("hover:text-dim"),
						)}
						onClick={() =>
							setFilter({
								autoCreated:
									filter.autoCreated === "hide" ? "show" : "hide",
							})
						}
					>
						<IconRobot size={20} className={mergeStylexOverrideClassName("", sx.shrink0)} />
						<span {...stylex.props(sx.minW0, sx.truncate)}>
							{filter.autoCreated === "hide" ? "Show" : "Hide"}{" "}
							{autoCreatedRows} started by an agent
						</span>
					</button>
				)}

				</div>
			)}
			</div>

				{/* ── Automations (one collapsible band, one group per automation) ── */}
				{groups.length > 0 && (
					<div
						className={cn(
							SIDEBAR_INDEPENDENT_SECTION,
							utilityClassName("mt-2"),
							activePersonGroups.length > 0 ? utilityClassName("pb-2") : utilityClassName("pb-7"),
						)}
					>
						<div
							className={cn(
								SIDEBAR_BAND_LABEL,
								// A band heading carries no leading mark, so on phones it
								// takes the 8px a 22px glyph spends on its own padding
								// before the ink starts — see the toggle's inset below.
								utilityClassName("py-0 pl-0 pr-2 desktop:pr-0"),
								SIDEBAR_STICKY_BAND,
								SIDEBAR_STICKY_BAND_ROW,
								SIDEBAR_STUCK_BACKING,
							)}
							data-sticky-head
						>
							<button
								className={cn(SIDEBAR_BAND_TOGGLE, SIDEBAR_BAND_TOGGLE_INSET)}
								onClick={() => toggleBand("automations")}
								title={
									automationsOpen
										? "Collapse automations"
										: "Expand automations"
								}
							>
								<span {...stylex.props(sx.minW0, sx.truncate)}>Automations</span>
								{/* The count sits right after the heading, not pinned to the
								    far right; any future action can still be pushed there
								    with ml-auto. */}
								<span className={SIDEBAR_GROUP_COUNT}>
									{groups.reduce((n, g) => n + (g.totalItems || g.items.length), 0)}
								</span>
								<IconChevronDown
									className={cn(
										SIDEBAR_BAND_CHEVRON,
										"group-hover/band:visible group-hover/band:text-dim",
										!automationsOpen && SIDEBAR_BAND_CHEVRON_COLLAPSED,
									)}
									size={18}
									style={{ transform: automationsOpen ? "none" : "rotate(-90deg)" }}
								/>
							</button>
						</div>
						{visibleAutomationGroups.length > 0 && (
							<div className={SIDEBAR_INDEPENDENT_SCROLL}>
								{visibleAutomationGroups.map((group) => {
									const open = isOpen(group.key);
									return (
									<React.Fragment key={group.key}>
										<button
											className={cn(
												SIDEBAR_GROUP_HEADER,
												SIDEBAR_GROUP_HEADER_INSET,
												SIDEBAR_HEADER_ROW,
											)}
											onClick={() => toggleGroup(group.key)}
										>
											{/* The dot is 7px but the header's leading column is a
											    rail, so its name lands where every other one does. */}
											<span className={SIDEBAR_RAIL}>
												{group.dotColor && (
													<span
														className={SIDEBAR_GROUP_DOT}
														style={{ backgroundColor: group.dotColor }}
													/>
												)}
											</span>
											<span className={SIDEBAR_GROUP_NAME}>{group.label}</span>
											{/* The count belongs to the name, not to the end of
											    the row: an automation heading titles the runs
											    under it, so it reads "iOS parity check, 5" the
											    way every band above it does. Pinned right it read
											    as a column of its own, and it had to disappear on
											    hover to hand the slot to the settings glyph. */}
											<span className={cn(SIDEBAR_GROUP_COUNT, utilityClassName("shrink-0"))}>
												{group.totalItems || group.items.length}
											</span>
											{/* Collapsed, the chevron shows at rest, as it does
											    on every other heading in the sidebar: a closed
											    automation still lists its latest report, so
											    without it nothing said whether the rows under
											    the heading were all of them or one of eight. */}
											<IconChevronDown
												className={cn(
													SIDEBAR_GROUP_CHEVRON,
													!open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
												)}
												size={22}
												style={{
													transform: open ? "none" : "rotate(-90deg)",
												}}
											/>
											{/* The sliders glyph that jumps to this automation in
											    Settings, alone at the end of the row (span, not
											    button, since we're inside the header button). Its
											    target is the row's full height, so the click can
											    land anywhere along the end of the row. */}
											<span
												role="button"
												className={SIDEBAR_AUTO_COG}
												title="Automation settings"
												onClick={(e) => {
													e.stopPropagation();
													onOpenAutomation(group.label);
												}}
											>
												<IconSliders size={20} />
											</span>
										</button>
										{/* The automation's own work, a step inside its
										    heading. See SIDEBAR_AUTOMATION_RUNS. The step
										    means "belongs to the heading above", so it holds
										    for a collapsed group's report too; what says the
										    group is CLOSED is the heading's own chevron. */}
										<div className={SIDEBAR_AUTOMATION_RUNS}>
										{/* What the automation last concluded, above the runs
										    that produced it: the runs are named by their
										    timestamp, so without this the band says an
										    automation ran and never what it found.
										    An automation someone is named on shows this even
										    collapsed: you asked to hear from it, so it
										    answers without being opened. The house routines
										    stay quiet, or thirty of them would each add a
										    line to a band you scroll past. */}
										{(open || reportsToSomeone(group.label)) &&
											latestReportFor(group.label) && (
											<AutomationReportRow
												report={latestReportFor(group.label)!}
												onOpen={() => {
													const overview = automationOverview.get(group.label);
													if (overview?.latestReport)
														onOpenReports({
															automationId: overview.id,
															reportId: overview.latestReport.id,
														});
												}}
											/>
										)}
										{open &&
											(group.totalItems || group.items.length) > group.items.length && (
												<div {...mergeStylexProps("tabular-nums", sx.px4, sx.pb1, sx.pt05, sx.textFaint, typography.meta)} >
													Latest {group.items.length} of {group.totalItems} runs
												</div>
											)}
										{group.items
											.filter(() => open)
											.map((s) => {
												const pin = sessionPinState(s);
												return (
													<SidebarItem
														key={s.id}
														session={s}
														selected={automationRowSelected(s)}
														unread={
															s.id !== selectedId &&
															isUnread(s.id, s.lastActivity, reads)
														}
														mention={
															s.id !== selectedId
																? mentionFor(s.id)?.by
																: undefined
														}
														mine={
															!!s.startedBy &&
															!s.automation &&
															s.startedBy.toLowerCase() ===
																currentUser.toLowerCase()
														}
														onClick={() => onSelect(s)}
														onArchive={(current) => archiveWithNext(s, current)}
														pinned={pin.pinned}
														onTogglePin={pin.toggle}
														shipsDirectlyToMain={shipsDirectlyToMain(s.repo, s.branch)}
														onRename={(title) => onRename(s, title)}
														onSetStatus={(st) => onSetStatus([s], st)}
													/>
												);
											})}
										</div>
									</React.Fragment>
									);
								})}
							</div>
						)}
					</div>
				)}

			{/* ── People: teammates with a running or just-finished session. Each
			    person starts with only that active window visible; their chevron
			    expands the same heading to every matching session they own. ── */}
			{activePersonGroups.length > 0 && (
				<div className={cn(SIDEBAR_INDEPENDENT_SECTION, utilityClassName("mt-2 pb-7"))}>
					<div
						className={cn(
							SIDEBAR_BAND_LABEL,
							utilityClassName("py-0 pl-0 pr-2 desktop:pr-0"),
							SIDEBAR_STICKY_BAND,
							SIDEBAR_STICKY_BAND_ROW,
							SIDEBAR_STUCK_BACKING,
						)}
						data-sticky-head
					>
						<button
							className={cn(SIDEBAR_BAND_TOGGLE, SIDEBAR_BAND_TOGGLE_INSET)}
							onClick={() => toggleBand("people")}
							title={peopleOpen ? "Collapse team" : "Expand team"}
							aria-expanded={peopleOpen}
						>
							<span className={utilityClassName("min-w-0 truncate")}>Team</span>
							<span className={SIDEBAR_GROUP_COUNT}>
								{activePersonGroups.reduce(
									(count, group) => count + group.activeSessions.length,
									0,
								)}
							</span>
							<IconChevronDown
								className={cn(
									SIDEBAR_BAND_CHEVRON,
									"group-hover/band:visible group-hover/band:text-dim",
									!peopleOpen && SIDEBAR_BAND_CHEVRON_COLLAPSED,
								)}
								size={18}
								style={{ transform: peopleOpen ? "none" : "rotate(-90deg)" }}
							/>
						</button>
					</div>
					{peopleOpen && (
						<div className={SIDEBAR_INDEPENDENT_SCROLL}>
							{activePersonGroups.map((group) => {
								const groupKey = `person:${group.key}`;
								const hasMore =
									group.allSessions.length > group.activeSessions.length;
								const showAll = hasMore && isOpen(groupKey);
								const visibleSessions = showAll
									? group.allSessions
									: group.activeSessions;
								const personHeaderBody = (
									<>
										<span className={SIDEBAR_RAIL}>
											<UserAvatar name={group.label} size={20} />
										</span>
										<span className={SIDEBAR_GROUP_NAME}>{group.label}</span>
										<span className={cn(SIDEBAR_GROUP_COUNT, utilityClassName("shrink-0"))}>
											{group.allSessions.length}
										</span>
										{hasMore && (
											<IconChevronDown
												className={cn(
													SIDEBAR_GROUP_CHEVRON,
													!showAll && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
												)}
												size={22}
												style={{
													transform: showAll ? "none" : "rotate(-90deg)",
												}}
											/>
										)}
									</>
								);
								const personHeaderClass = cn(
									SIDEBAR_GROUP_HEADER,
									SIDEBAR_GROUP_HEADER_INSET,
									SIDEBAR_HEADER_ROW,
								);
								return (
									<React.Fragment key={group.key}>
										{hasMore ? (
											<button
												className={personHeaderClass}
												onClick={() => toggleGroup(groupKey)}
												aria-expanded={showAll}
												title={
													showAll
														? `Show only ${group.label}'s active sessions`
														: `Show all ${group.label}'s sessions`
												}
											>
												{personHeaderBody}
											</button>
										) : (
											<div className={personHeaderClass}>{personHeaderBody}</div>
										)}
										<div className={SIDEBAR_AUTOMATION_RUNS}>
											{visibleSessions.map((session) => {
												const pin = sessionPinState(session);
												return (
													<SidebarItem
														key={session.id}
														session={session}
														selected={session.id === selectedId}
														unread={
															session.id !== selectedId &&
															isUnread(session.id, session.lastActivity, reads)
														}
														mention={
															session.id !== selectedId
																? mentionFor(session.id)?.by
																: undefined
														}
														mine={false}
														showOwner={false}
														onClick={() => onSelect(session)}
														onArchive={(current) =>
															archiveWithNext(session, current)
														}
														pinned={pin.pinned}
														onTogglePin={pin.toggle}
														shipsDirectlyToMain={shipsDirectlyToMain(
															session.repo,
															session.branch,
														)}
														onRename={(title) => onRename(session, title)}
														onSetStatus={(status) =>
															onSetStatus([session], status)
														}
													/>
												);
											})}
										</div>
									</React.Fragment>
								);
							})}
						</div>
					)}
				</div>
			)}

			{/* Archived closes the sidebar, below every section rather than inside
			    the workspace list. It is the end of the list, so anything ordered
			    after the workspaces (Automations and People) used to render past it,
			    which read as "the sidebar ended, and then there was more". */}
			{(!isPhone || !productEmpty || hasWorkspaceFilter) && (
				<div
					// It sits outside the workspace list, so it takes the same inset
					// its other out-of-list siblings do. Without it the row is the one
					// thing in the sidebar whose fill runs edge to edge.
					className={cn(SIDEBAR_INDEPENDENT_SECTION, SIDEBAR_GROUP, utilityClassName("mt-1"))}
					style={{ order: 99 }}
				>
					{archivedLink}
				</div>
			)}

			{/* Phones keep setup in the sidebar's normal scroll flow. The bottom
			    margin clears the paired new-session and Desk controls. */}
			{isPhone && (
				<SetupWidget
					placement="phone"
					hasCreatedSession={sessions.length > 0}
					onOpenSettings={onOpenSettings}
					onNewSession={onNewSession}
				/>
			)}

			{/* One card for the whole workspace list: the rows come out of a plain
			    render function, not a component, so they can't each own a popover.
			    The hovered row is the anchor instead — same shell, same card. */}
			<Popover.Root
				open={!!wsHover}
				onOpenChange={(open) => {
					if (!open) closeWsHover();
				}}
			>
				{wsHover && (
					<RowCardPopup anchor={wsHover.el}>
						<div
							onMouseEnter={cancelWsHoverTimers}
							onMouseLeave={scheduleWsHoverClose}
						>
							<WsCardBody
								row={wsHover.row}
								snoozed={rowIsSnoozed(wsHover.row)}
								onToggleSnooze={() => {
									closeWsHover();
									toggleWorkspaceSnooze(wsHover.row);
								}}
								onOpen={(session) => {
									closeWsHover();
									onSelect(session);
								}}
							/>
						</div>
					</RowCardPopup>
				)}
			</Popover.Root>
			{wsSheet &&
				(() => {
					const { row, source } = wsSheet;
					const ws = row.workspace;
					// Same pin resolution as the row's star and the right-click menu: a
					// row can be pinned via its own key or a legacy pin on any member
					// session (incl. alias ids) — unpin must clear all of them.
					const pinKey = ws ? `workspace:${ws.id}` : row.key;
					const pinnedKeys = [
						pinKey,
						row.key,
						...row.sessions.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
					].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
					const pinned = pinnedKeys.length > 0;
					return (
						<WsMobileSheet
							row={row}
							pinned={pinned}
							onTogglePin={() => {
								if (pinned) {
									let next = pins;
									for (const k of pinnedKeys) next = togglePin(k);
									setPins(next);
								} else {
									setPins(togglePin(pinKey));
								}
							}}
							onClose={() => setWsSheet(null)}
							onArchive={() => archiveWorkspaceWithNext(row, source)}
							onSetStatus={(status) => onSetStatus(row.sessions, status)}
							snoozeUntil={
								activeSnoozeKeys.has(row.key)
									? (snoozes[row.key] ?? null)
									: null
							}
							onSnooze={(until) =>
								until ? setSnooze(row.key, until) : clearSnooze(row.key)
							}
							onOpen={(session) => onSelect(session)}
							onRename={() => {
								if (ws) {
									setWorkspaceDraft(ws.name);
									setEditingWorkspaceId(ws.id);
								} else if (row.sessions[0]) {
									// Solo session rows rename the session itself.
									startSessionRename(row.sessions[0]);
								}
							}}
							claimed={
								row.sessions.length === 0
									? null
									: row.sessions.some((c) => isClaimed(c))
										? true
										: row.sessions.some((c) => ownedBy(c, currentUser))
											? null
											: false
							}
							unread={row.unread}
							onToggleRead={
								row.sessions.length > 0
									? () =>
											row.sessions.forEach((c) =>
												row.unread
													? markRead(c.id, c.lastActivity)
													: markUnread(c.id),
											)
									: null
							}
							onCopyLink={
								row.sessions[0]
									? () =>
											copyToClipboard(
												absoluteLink(sessionPath(row.sessions[0])),
												() => onToast?.("Link copied"),
											)
									: null
							}
							onDelete={
								ws
									? () => {
											if (row.sessions.length === 0) {
												confirmDeleteDraft(() => onDeleteWorkspace(ws.id));
												return;
											}
											confirm({
												title: `Delete workspace "${ws.name}"?`,
												description: "All sessions in this workspace will be permanently deleted.",
												confirmLabel: "Delete",
												destructive: true,
												onConfirm: () => onDeleteWorkspace(ws.id),
											});
										}
									: null
							}
						/>
					);
				})()}
		</ContextMenu.Trigger>
		<SidebarToolsMenu
			tools={sidebarMenuTools}
			sources={sidebarMenuSources}
			onToggleTool={setToolVisible}
			onSetSupport={setSupportSurface}
			onToggleSource={setSidebarFeedVisible}
			onCustomize={() => setCustomizeOpen(true)}
		/>
		</ContextMenu.Root>
		{/* The desktop prompt is a compact footer in the sidebar, like the
		    “View in the app” prompt, rather than floating over the composer. */}
		{!isPhone && (
			<SetupWidget
				placement="desktop"
				hasCreatedSession={sessions.length > 0}
				onOpenSettings={onOpenSettings}
				onNewSession={onNewSession}
			/>
		)}
		<SidebarCustomizeDialog
			open={customizeOpen}
			onOpenChange={setCustomizeOpen}
			tools={sidebarMenuTools.map((tool) => ({
				id: tool.id,
				label: tool.label,
				icon: tool.icon,
				shown: tool.surface ? tool.surface === "page" : tool.shown,
				onShownChange: (shown: boolean) =>
					tool.surface
						? setSupportSurface(shown ? "page" : "off")
						: setToolVisible(tool.id, shown),
			}))}
			repositories={repos}
			onToolOrderChange={(next) =>
				setSidebarToolOrder(
					replaceVisibleSidebarToolOrder(getSidebarToolOrder(), next),
				)
			}
			onRepositoryOrderChange={setRepoOrder}
		/>
		{confirmDialog}
		</>
	);
});
