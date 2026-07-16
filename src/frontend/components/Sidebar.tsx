import React, {
	useState,
	useMemo,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import type { UnifiedSession, Project, SupportThread } from "../lib/types";
import {
	relativeTime,
	fetchOpenPrs,
	fetchSupportThreads,
	setPlainThreadStatusApi,
	type OpenPr,
	type WorkspaceOverview,
} from "../lib/api";
import { loadOverview, overviewCache } from "../lib/workspace-overview";
import { openLightbox } from "./MediaLightbox";
import { useCurrentUser, TEAM } from "./UserPicker";
import { getPins, onPinsChanged, togglePin, reorderPins, pin as pinKey, unpin as unpinKeys } from "../lib/pins";
import {
	getFolders,
	onFoldersChanged,
	createFolder,
	renameFolder,
	deleteFolder,
	moveToFolder,
	reorderFolderKeys,
	reorderFolders,
	type SidebarFolder,
} from "../lib/folders";
import { Reorder, useDragControls } from "motion/react";
import { getRecents, onRecentsChanged } from "../lib/recents";
import { getReads, isUnread, markUnread, onReadsChanged } from "../lib/reads";
import { chatPath, prPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { providerFromUrl } from "../lib/provider";
import { hasDraft, onDraftsChanged } from "../lib/drafts";
import { getWsTimePref, onWsTimeChanged } from "../lib/workspace-time";
import { UserAvatar } from "./UserAvatar";
import { shortTime, elapsedClock } from "../lib/time";
import {
	IconChevronDown,
	IconChevronRight,
	IconArchive,
	IconBell,
	IconFilter,
	IconGear,
	IconGitMerge,
	IconCheck,
	IconClock,
	IconFlame,
	IconInbox,
	IconMessageQuestion,
	IconPencil,
	IconPlus,
	IconPullRequest,
	IconEye,
	IconStack,
	IconPin,
	IconFolder,
	IconFolderPlus,
	IconLink,
	IconMail,
	IconStatusRing,
	IconTrash,
	IconWatercooler,
	IconFile,
} from "./icons";
import { Tooltip } from "../ui/tooltip";
import { RepoTile, swatchColor, repoLabel } from "./RepoTile";
import { useIsPhone } from "../hooks/useIsPhone";

const AUTOMATION_COLOR = "#d29922";

// Archive the active workspace. The viewer's ⌘E/⌘⇧A archives just the open
// chat and bails on Alt, so the Alt-carrying escalation here never
// double-fires it.
const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const ARCHIVE_WS_SHORTCUT_KEYS = isApple
	? ["⌘", "⌥", "⇧", "A"]
	: ["Ctrl", "Alt", "Shift", "A"];
// ⌘E is the advertised archive chord; ⌘⇧A stays alive as a legacy alias.
const ARCHIVE_SHORTCUT_KEYS = isApple ? ["⌘", "E"] : ["Ctrl", "E"];

/** ⌘E (primary) or ⌘⇧A (legacy) — the archive-this-chat chord. */
function isArchiveChord(e: KeyboardEvent): boolean {
	if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
	const k = e.key.toLowerCase();
	return (k === "e" && !e.shiftKey) || (k === "a" && e.shiftKey);
}

// Long-press (touch) tuning for the mobile action sheet.
const LONG_PRESS_MS = 450; // hold before the sheet opens
const LONG_PRESS_SLOP = 10; // px of finger travel that cancels it (a scroll)
const SWIPE_REVEAL_PX = 82;
const SWIPE_OPEN_THRESHOLD = 36;
const SWIPE_FULL_RATIO = 0.45;
const SWIPE_COMMIT_MS = 210;
const SWIPE_AXIS_LOCK_PX = 8;

type SwipeAction = "archive" | "star";
type SwipeState = { key: string; offset: number; action?: SwipeAction };

function clampSwipe(dx: number, rowWidth: number): number {
	const limit = Math.max(SWIPE_REVEAL_PX, rowWidth);
	return Math.max(-limit, Math.min(limit, dx));
}

function fullSwipeThreshold(rowWidth: number): number {
	const usableWidth = Math.max(SWIPE_REVEAL_PX, rowWidth - 28);
	return Math.min(
		Math.max(SWIPE_REVEAL_PX * 1.8, rowWidth * SWIPE_FULL_RATIO),
		usableWidth,
	);
}

function swipeCommitOffset(action: SwipeAction, rowWidth: number): number {
	return action === "archive" ? -rowWidth : rowWidth;
}

// Inline styles for the right-click menus. Kept inline (not in a CSS file)
// because component-imported CSS isn't linked into the served bundle — only
// global.css is — so a separate stylesheet silently doesn't apply.
const CTX_MENU_STYLE: React.CSSProperties = {
	position: "fixed",
	zIndex: 3000,
	minWidth: 210,
	maxWidth: 320,
	maxHeight: "60vh",
	overflowY: "auto",
	padding: 8,
	background: "var(--bg-panel)",
	border: "1px solid var(--border-strong)",
	borderRadius: 14,
	boxShadow: "0 10px 30px rgba(0, 0, 0, 0.32)",
	display: "flex",
	flexDirection: "column",
	gap: 2,
};
const CTX_ITEM_STYLE: React.CSSProperties = {
	display: "block",
	width: "100%",
	textAlign: "left",
	background: "none",
	border: "none",
	color: "var(--text)",
	fontSize: 14,
	padding: "9px 11px",
	borderRadius: 8,
	cursor: "pointer",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis",
};
const CTX_SEP_STYLE: React.CSSProperties = {
	height: 1,
	background: "var(--border-strong)",
	margin: "7px 4px",
};

// Per-person group dots share the repo-tile swatch palette (RepoTile.tsx) —
// the same deterministic hash keeps each teammate's color stable.
const personColor = swatchColor;

// Only recognized people get their own "people" section. Sessions whose
// `startedBy` is something other than a real teammate — test labels
// ("proof-test", "image-test"), action/integration names ("Slack",
// "Make Michiel editor (action)"), or empty — are hidden rather than shown as
// stray sections. "Michael" (the assistant) counts as a person here.
const KNOWN_PEOPLE = new Set([...TEAM, "Michael"].map((n) => n.toLowerCase()));

interface Props {
	sessions: UnifiedSession[];
	/** Project folders that group chats. */
	projects: Project[];
	/** Notes (id + title), to render pinned-note rows. */
	notes: Array<{ id: string; title: string }>;
	selectedId: string | null;
	/** The note currently open (highlights its pinned row), or null. */
	activeNoteId: string | null;
	/** True while the Checks view is open — highlights the Checks entry. */
	reviewsActive: boolean;
	/** Open the Checks view (the sidebar's one non-workspace area). */
	onOpenReviews: () => void;
	/** Open one automation's settings (list + detail). Called with the
	    automation's NAME — session rows only carry the name, not the id. */
	onOpenAutomation: (name: string) => void;
	/** True while the PR Tinder deck is open — highlights its entry. */
	prTinderActive: boolean;
	/** Open PR Tinder (swipe triage of the repo's open PRs). */
	onOpenPrTinder: () => void;
	/** True while the Support Tinder deck is open — highlights its entry. */
	supportTinderActive: boolean;
	/** Open Support Tinder (swipe triage of the Plain Todo queue). */
	onOpenSupportTinder: () => void;
	/** True while the Watercooler (team chat) is open — highlights its entry. */
	watercoolerActive: boolean;
	/** Open the Watercooler — the team-wide native chat room (not Slack). */
	onOpenWatercooler: () => void;
	/** Unread Watercooler messages (badge on its entry). */
	watercoolerUnread: number;
	/** True while the recurring Reports surface is open. */
	reportsActive: boolean;
	/** Open automation-produced recurring reports. */
	onOpenReports: () => void;
	onSelect: (session: UnifiedSession) => void;
	/** Foreground a session's Review view-tab (from a chat row's context menu). */
	onOpenReview: (session: UnifiedSession) => void;
	/** Open the session-less PR preview for a PR row with no chat behind it. */
	onOpenPr: (repo: string, branch: string) => void;
	/** The PR preview currently open (highlights its row), or null. */
	selectedPr?: { repo: string; branch: string } | null;
	/** Open the session-less ticket preview for a Support row with no session. */
	onOpenSupportThread: (threadId: string) => void;
	/** The support preview currently open (highlights its row), or null. */
	selectedSupportThreadId?: string | null;
	onNewSession: () => void;
	/** Start a new session with a repo pre-selected (the repo-band "+" action). */
	onNewSessionInRepo: (repo: string) => void;
	/** Open a project — its chats surface in the top tab strip. */
	onOpenProject: (id: string) => void;
	/** Rename a project folder. */
	onRenameProject: (id: string, name: string) => void;
	/** Delete a project folder (its chats become standalone). */
	onDeleteProject: (id: string) => void;
	/** Open a note (pinned-note row click). */
	onOpenNote: (id: string) => void;
	onOpenArchived: () => void;
	/** True while the archived view is open — highlights the Archived row. */
	archivedActive: boolean;
	/** Open the catch-up swipe deck (walk through your unread workspaces). */
	onOpenCatchUp: () => void;
	/** True while the catch-up deck is open — highlights its entry. */
	catchUpActive: boolean;
	/**
	 * Archive a session. `next` is the session that follows it in the sidebar's
	 * visible order (or the previous one for the last row) — the caller uses it
	 * to keep a live session open when the active one is archived.
	 */
	onArchive: (session: UnifiedSession, next: UnifiedSession | null) => void;
	/**
	 * Archive every chat in a workspace (the row's archive icon). `next` is the
	 * first chat of the workspace row that follows it in the sidebar's visible
	 * order (or the previous one for the last row) — the caller opens it when
	 * the active workspace is archived away.
	 */
	onArchiveWorkspace: (
		chats: UnifiedSession[],
		next: UnifiedSession | null,
	) => void;
	/** Rename a session (double-click its title); empty title resets it. */
	onRename: (session: UnifiedSession, title: string) => void;
	/**
	 * Pin a workspace's chats into a sidebar lane (or clear back to derived with
	 * `null`). Applies to every chat in the row so the aggregated row lands there.
	 */
	onSetStatus: (chats: UnifiedSession[], status: MineStatus | null) => void;
	/** Who's viewing what right now (global presence), for the follow rail. */
	teamViewing?: Array<{ user: string; sessionId: string }>;
	/** Teammate currently being followed (navigation shadows them). */
	followUser?: string | null;
	/** Toggle following a teammate. */
	onToggleFollow?: (user: string) => void;
	/**
	 * The mobile top-bar's right-side actions slot. On phones the sidebar's
	 * filter button lives here (next to Search) instead of in the workspace
	 * header — the header's own filter/+ buttons are hidden on mobile.
	 */
	headerActionsEl?: HTMLElement | null;
	/** True once the scrollable workspace list has moved under its header. */
	onListScrolledChange?: (scrolled: boolean) => void;
	/** Show a transient toast (e.g. "Link copied"). */
	onToast?: (message: string) => void;
}

// Groups are rendered in three visually separated bands (spacing between each):
//   "personal"    — My sessions (split by status), Pinned
//   "people"      — one group per other teammate (+ ownerless source groups)
//   "automations" — one group per automation ("projects")
type GroupBand = "personal" | "people" | "automations";

// The bands below the personal one get a text header ("People" / "Projects").
function bandLabel(band: GroupBand): string | null {
	if (band === "people") return "People";
	if (band === "automations") return "Automations";
	return null;
}

interface Group {
	key: string;
	label: string;
	dotColor: string | null;
	band: GroupBand;
	items: UnifiedSession[];
}

// "My sessions" is split, Conductor-style, into status buckets. Order + labels +
// dot color are defined here; a session is bucketed by the first rule it matches.
type MineStatus =
	| "needsinput"
	| "merged"
	| "pending"
	| "review"
	| "inprogress";

const MINE_STATUS_META: Array<{
	key: MineStatus;
	label: string;
	dotColor: string;
}> = [
	{ key: "needsinput", label: "Needs input", dotColor: "var(--accent)" },
	{ key: "inprogress", label: "In progress", dotColor: "var(--yellow)" },
	{ key: "review", label: "In review", dotColor: "var(--green)" },
	{ key: "merged", label: "Done", dotColor: "var(--purple)" },
	{ key: "pending", label: "Backlog", dotColor: "var(--text-faint)" },
];

// ── Right-click context menu (workspace / chat / PR rows) ──────────────────
// A single presentational menu shared by every sidebar row that has one. Rows
// pass a flat list of entries; a `status` entry renders the "Set status" row
// with a hover flyout (the sub-panel is a sibling of the menu, not a child, so
// the menu's own overflow can't clip it).
type CtxEntry =
	| {
			kind: "item";
			icon?: React.ReactNode;
			label: string;
			shortcut?: string;
			danger?: boolean;
			onClick: () => void;
	  }
	| { kind: "sep" }
	| {
			kind: "status";
			current: MineStatus | null;
			onPick: (status: MineStatus | null) => void;
	  }
	| {
			// "Move to folder" with a hover flyout listing the user's folders —
			// same sub-panel mechanics as "Set status". Picking the current folder
			// removes the row from it (toggle), and "New folder…" creates + moves.
			kind: "folder";
			folders: { id: string; name: string }[];
			currentId: string | null;
			onPick: (folderId: string | null) => void;
			onNew: () => void;
	  };

function CtxItem({
	icon,
	label,
	shortcut,
	danger,
	trailing,
	onClick,
	onMouseEnter,
}: {
	icon?: React.ReactNode;
	label: string;
	shortcut?: string;
	danger?: boolean;
	trailing?: React.ReactNode;
	onClick?: () => void;
	onMouseEnter?: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			type="button"
			style={{
				...CTX_ITEM_STYLE,
				display: "flex",
				alignItems: "center",
				gap: 11,
				...(danger ? { color: "var(--red, #e5534b)" } : {}),
			}}
			onClick={onClick}
			onMouseEnter={onMouseEnter}
		>
			{icon !== undefined && (
				<span
					style={{
						width: 20,
						display: "inline-flex",
						justifyContent: "center",
						flexShrink: 0,
						color: danger ? "inherit" : "var(--text-dim)",
					}}
				>
					{icon}
				</span>
			)}
			<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
				{label}
			</span>
			{shortcut && (
				<span
					style={{
						color: "var(--text-faint)",
						fontSize: 12,
						flexShrink: 0,
						marginLeft: 12,
					}}
				>
					{shortcut}
				</span>
			)}
			{trailing}
		</button>
	);
}

function SidebarCtxMenu({
	x,
	y,
	entries,
	onClose,
}: {
	x: number;
	y: number;
	entries: CtxEntry[];
	onClose: () => void;
}) {
	// Flyout state (status / folder sub-panel) + hover grace so the pointer can
	// cross the gap between the menu and the panel.
	const [sub, setSub] = useState<{
		kind: "status" | "folder";
		rect: DOMRect;
	} | null>(null);
	const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);
	function cancelClose() {
		if (closeT.current) clearTimeout(closeT.current);
		closeT.current = null;
	}
	function scheduleClose() {
		cancelClose();
		closeT.current = setTimeout(() => setSub(null), 160);
	}
	useEffect(() => cancelClose, []);

	const statusEntry = entries.find(
		(e): e is Extract<CtxEntry, { kind: "status" }> => e.kind === "status",
	);
	const folderEntry = entries.find(
		(e): e is Extract<CtxEntry, { kind: "folder" }> => e.kind === "folder",
	);
	const check = (on: boolean) =>
		on ? <IconCheck size={20} style={{ color: "var(--text-dim)" }} /> : undefined;

	const SUB_W = 210;
	const subLeft = sub
		? sub.rect.right + SUB_W + 8 > window.innerWidth
			? sub.rect.left - SUB_W - 4
			: sub.rect.right + 4
		: 0;
	const subTop = sub
		? Math.min(sub.rect.top - 6, window.innerHeight - 280)
		: 0;

	return createPortal(
		<>
			<div
				className="sidebar-ctx-menu"
				style={{ ...CTX_MENU_STYLE, left: x, top: y }}
				onClick={(e) => e.stopPropagation()}
			>
				{entries.map((entry, i) => {
					if (entry.kind === "sep")
						return <div key={i} style={CTX_SEP_STYLE} />;
					if (entry.kind === "status" || entry.kind === "folder") {
						const kind = entry.kind;
						return (
							<button
								key={i}
								type="button"
								style={{
									...CTX_ITEM_STYLE,
									display: "flex",
									alignItems: "center",
									gap: 11,
								}}
								onMouseEnter={(e) => {
									cancelClose();
									setSub({
										kind,
										rect: e.currentTarget.getBoundingClientRect(),
									});
								}}
								onMouseLeave={scheduleClose}
								onClick={(e) => {
									cancelClose();
									setSub({
										kind,
										rect: e.currentTarget.getBoundingClientRect(),
									});
								}}
							>
								<span
									style={{
										width: 20,
										display: "inline-flex",
										justifyContent: "center",
										flexShrink: 0,
										color: "var(--text-dim)",
									}}
								>
									{kind === "status" ? (
										<IconStatusRing size={20} />
									) : (
										<IconFolder size={20} />
									)}
								</span>
								<span style={{ flex: 1 }}>
									{kind === "status" ? "Set status" : "Move to folder"}
								</span>
								<IconChevronRight
									size={20}
									style={{ color: "var(--text-faint)", marginRight: -4 }}
								/>
							</button>
						);
					}
					return (
						<CtxItem
							key={i}
							icon={entry.icon}
							label={entry.label}
							shortcut={entry.shortcut}
							danger={entry.danger}
							onMouseEnter={scheduleClose}
							onClick={() => {
								entry.onClick();
								onClose();
							}}
						/>
					);
				})}
			</div>
			{sub?.kind === "status" && statusEntry && (
				<div
					className="sidebar-ctx-menu"
					style={{
						...CTX_MENU_STYLE,
						left: subLeft,
						top: subTop,
						minWidth: SUB_W,
					}}
					onClick={(e) => e.stopPropagation()}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
				>
					{MINE_STATUS_META.map((m) => (
						<CtxItem
							key={m.key}
							icon={statusMenuIcon(m.key, m.dotColor)}
							label={m.label}
							trailing={check(statusEntry.current === m.key)}
							onClick={() => {
								statusEntry.onPick(
									statusEntry.current === m.key ? null : m.key,
								);
								onClose();
							}}
						/>
					))}
					<div style={CTX_SEP_STYLE} />
					<CtxItem
						icon={<span />}
						label="Auto (default)"
						trailing={check(statusEntry.current === null)}
						onClick={() => {
							statusEntry.onPick(null);
							onClose();
						}}
					/>
				</div>
			)}
			{sub?.kind === "folder" && folderEntry && (
				<div
					className="sidebar-ctx-menu"
					style={{
						...CTX_MENU_STYLE,
						left: subLeft,
						top: subTop,
						minWidth: SUB_W,
					}}
					onClick={(e) => e.stopPropagation()}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
				>
					{folderEntry.folders.map((f) => (
						<CtxItem
							key={f.id}
							icon={<IconFolder size={20} />}
							label={f.name}
							trailing={check(folderEntry.currentId === f.id)}
							onClick={() => {
								folderEntry.onPick(
									folderEntry.currentId === f.id ? null : f.id,
								);
								onClose();
							}}
						/>
					))}
					{folderEntry.currentId && (
						<CtxItem
							icon={<span />}
							label="Remove from folder"
							onClick={() => {
								folderEntry.onPick(null);
								onClose();
							}}
						/>
					)}
					{folderEntry.folders.length > 0 && <div style={CTX_SEP_STYLE} />}
					<CtxItem
						icon={<IconFolderPlus size={20} />}
						label="New folder…"
						onClick={() => {
							folderEntry.onNew();
							onClose();
						}}
					/>
				</div>
			)}
		</>,
		document.body,
	);
}

function SidebarGroupIcon({
	status,
	color,
}: {
	status: MineStatus;
	color: string;
}) {
	const className = "sidebar-group-icon";
	const style = { color };
	if (status === "needsinput")
		return <IconMessageQuestion className={className} style={style} />;
	if (status === "inprogress")
		return <IconClock className={className} style={style} />;
	if (status === "review")
		return <IconEye className={className} style={style} />;
	if (status === "merged")
		return <IconCheck className={className} style={style} />;
	return <IconInbox className={className} style={style} />;
}

// The same status glyphs, sized + colored for a menu row (no group className,
// so the menu controls sizing) — used by the "Set status" flyout.
function statusMenuIcon(status: MineStatus, color: string) {
	const style = { color };
	if (status === "needsinput")
		return <IconMessageQuestion size={20} style={style} />;
	if (status === "inprogress") return <IconClock size={20} style={style} />;
	if (status === "review") return <IconEye size={20} style={style} />;
	if (status === "merged") return <IconCheck size={20} style={style} />;
	return <IconInbox size={20} style={style} />;
}

// A run that died on a terminal failure (usage limits/credits exhausted, API
// errors) needs a human to act, exactly like a blocked question — it must not
// sink quietly into the Backlog. A live run means a retry is underway, so the
// stale flag doesn't override "In progress".
function runNeedsAttention(s: UnifiedSession): boolean {
	return !!s.lastRunError && !s.isRunning;
}

function mineStatus(s: UnifiedSession): MineStatus {
	// A blocked question (or a run that died on an error) needs a human right
	// now — surface it above everything else, even a manual pin or an open PR, so
	// it never hides inside another bucket. This state is transient (it clears the
	// moment the question is answered / the run recovers), so it doesn't stomp the
	// manual pin permanently — it just floats above it while live.
	if (s.waitingForInput || runNeedsAttention(s)) return "needsinput";
	// A human-pinned lane wins over everything derived from PR/run state below.
	if (s.manualStatus) return s.manualStatus;
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "OPEN") return "review";
	if (s.isRunning) return "inprogress";
	// Everything else is idle-but-unfinished: no open/merged PR, not running,
	// not blocked. That's "Pending", not "Done" — finishing a session is an
	// explicit act (Archive), never inferred from a moment of inactivity.
	return "pending";
}

// PR state overrides the manual review bands. A merged PR means the work is
// done → the row leaves every review band and falls into the "Done" status
// lane. An approved-but-unmerged PR means the reviewer already signed off on
// GitHub → the review has landed, so the row leaves "Awaiting review" and moves
// to "Reviewed" (same as a manual "Mark as reviewed"). Without this a session
// you sent out sits in "Awaiting review" forever, since the band otherwise only
// clears on a manual accept.
function wsPrMerged(r: { chats: UnifiedSession[] }): boolean {
	return r.chats.some((c) => c.prState === "MERGED");
}
function wsPrApproved(r: { chats: UnifiedSession[] }): boolean {
	return (
		!wsPrMerged(r) && r.chats.some((c) => c.prReviewDecision === "APPROVED")
	);
}

const EXPANDED_KEY = "michael-sidebar-expanded";

const DEFAULT_EXPANDED = [
	"recently",
	"pinned",
	"needsreview",
	"awaitingreview",
	"reviewed",
	"status:needsinput",
	"status:merged",
	"status:pending",
	"status:review",
	"status:inprogress",
];

function readExpanded(): Set<string> {
	try {
		return new Set(
			JSON.parse(
				localStorage.getItem(EXPANDED_KEY) || JSON.stringify(DEFAULT_EXPANDED),
			),
		);
	} catch {
		return new Set(DEFAULT_EXPANDED);
	}
}

// ── Grouping / filtering controls (the filter popover) ─────────────────────
// The sidebar can be organized three ways ("Group by": Status, Repo, or Recently
// opened), narrowed to a single repo ("Repo") or a single person ("Person"), and
// ordered by recency of activity or creation ("Sort by"). The choices persist
// together per browser.
type GroupBy = "status" | "repo" | "recently";
type SortBy = "updated" | "created";
const DEFAULT_PROJECT = "tella-fusion";
const FILTER_KEY = "michael-sidebar-filter";

interface FilterState {
	groupBy: GroupBy;
	repo: string; // a repo id, or "all"
	// "me" (your workspaces — the default), "everyone" (literally all
	// workspaces), or a lowercased person key for a specific teammate.
	person: string;
	sort: SortBy;
}

function readFilter(): FilterState {
	try {
		const v = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
		return {
			groupBy:
				v.groupBy === "repo" || v.groupBy === "recently"
					? v.groupBy
					: "status",
			repo: typeof v.repo === "string" ? v.repo : "all",
			// Legacy stored "all" behaved as "you" in the lanes — map it to "me"
			// so nobody's default flips to everyone.
			person:
				typeof v.person === "string" && v.person && v.person !== "all"
					? v.person
					: "me",
			sort: v.sort === "created" ? "created" : "updated",
		};
	} catch {
		return { groupBy: "status", repo: "all", person: "me", sort: "updated" };
	}
}

function sessionRepo(s: UnifiedSession): string {
	return s.repo || DEFAULT_PROJECT;
}


export function Sidebar({
	sessions,
	projects,
	notes,
	selectedId,
	activeNoteId,
	reviewsActive,
	onOpenReviews,
	onOpenAutomation,
	prTinderActive,
	onOpenPrTinder,
	supportTinderActive,
	onOpenSupportTinder,
	watercoolerActive,
	onOpenWatercooler,
	watercoolerUnread,
	reportsActive,
	onOpenReports,
	onSelect,
	onOpenReview,
	onOpenPr,
	selectedPr = null,
	onOpenSupportThread,
	selectedSupportThreadId = null,
	onNewSession,
	onNewSessionInRepo,
	onOpenProject,
	onRenameProject,
	onDeleteProject,
	onOpenNote,
	onOpenArchived,
	archivedActive,
	onOpenCatchUp,
	catchUpActive,
	onArchive,
	onArchiveWorkspace,
	onRename,
	onSetStatus,
	teamViewing = [],
	followUser = null,
	onToggleFollow,
	headerActionsEl = null,
	onListScrolledChange,
	onToast,
}: Props) {
	const isPhone = useIsPhone();
	const [search, setSearch] = useState("");
	// Groups are collapsed by default; the expanded set persists per browser
	const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
	const [pins, setPins] = useState<string[]>(getPins);
	// Drag-to-reorder in the Pinned band. onReorder fires continuously during a
	// drag, so the in-flight order lives in local state (pinOrderDraft) and only
	// commits to the pins store on drop — mirroring the composer queue's pattern.
	// pinDragKey marks the floating row (background + stacking); pinJustDragged
	// swallows the click that lands on the row right after a drop.
	const [pinOrderDraft, setPinOrderDraft] = useState<string[] | null>(null);
	const pinOrderPending = useRef<string[] | null>(null);
	const [pinDragKey, setPinDragKey] = useState<string | null>(null);
	const pinJustDragged = useRef(false);
	// Sidebar folders (per-user sections between Pinned and the status lanes).
	const [folders, setFoldersState] = useState<SidebarFolder[]>(getFolders);
	const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
	const [folderDraft, setFolderDraft] = useState("");
	const [folderMenu, setFolderMenu] = useState<{
		id: string;
		x: number;
		y: number;
	} | null>(null);
	// Drag-to-reorder the folder sections themselves (header is the handle) —
	// same draft/commit pattern as the pinned rows.
	const [folderOrderDraft, setFolderOrderDraft] = useState<string[] | null>(
		null,
	);
	const folderOrderPending = useRef<string[] | null>(null);
	const [folderDragId, setFolderDragId] = useState<string | null>(null);
	const folderJustDragged = useRef(false);
	// Cross-section drag: every folder section (and the Pinned band) registers
	// itself as a drop zone; while a row drags, the zone under the pointer other
	// than the row's own is highlighted, and the drop moves the row there
	// instead of committing a same-list reorder. Ref mirrors the state so drop
	// handlers (closures from the drag's start render) read the latest value.
	const dropZones = useRef(new Map<string, HTMLElement>());
	const [dragOverZone, setDragOverZone] = useState<string | null>(null);
	const dragOverZoneRef = useRef<string | null>(null);
	const dragSourceZone = useRef<string | null>(null);
	const [recents, setRecents] = useState<string[]>(getRecents);
	// Per-session last-read marks, driving the unread dot. Kept in sync via the
	// same event the viewer fires when it marks a session read.
	const [reads, setReads] = useState(getReads);
	const currentUser = useCurrentUser();

	// Filter popover (group by / repo / sort) — its choices persist together.
	const [filter, setFilterState] = useState<FilterState>(readFilter);
	const [filterOpen, setFilterOpen] = useState(false);
	const filterBtnRef = useRef<HTMLButtonElement>(null);
	// The phone stand-in for the header filter button (portaled into the top
	// bar next to Search). The popover anchors to whichever button is live.
	const mobileFilterBtnRef = useRef<HTMLButtonElement>(null);
	function setFilter(patch: Partial<FilterState>) {
		setFilterState((prev) => {
			const next = { ...prev, ...patch };
			localStorage.setItem(FILTER_KEY, JSON.stringify(next));
			return next;
		});
	}

	// The active repo-filter chip prefers to sit inline in the "My sessions"
	// header (right after the title); it drops to its own row only when the
	// sidebar is too narrow to fit it there. `repoInline` is decided by measuring
	// the header against an off-layout probe copy of the chip, so toggling it can't
	// feed back into the measurement (title/actions/probe widths don't depend on
	// where the real chip lands).
	const [repoInline, setRepoInline] = useState(true);
	const headRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLSpanElement>(null);
	const actionsRef = useRef<HTMLDivElement>(null);
	const probeRef = useRef<HTMLSpanElement>(null);
	// Client-observed run starts, keyed by workspace-row key — the fallback when
	// the server hasn't stamped runStartedAt yet (external CLI runs, or the brief
	// gap between isRunning flipping via WS and the next sessions poll). Entries
	// are pruned once a row stops running so a later run starts its clock fresh.
	const runStartSeen = useRef<Map<string, number>>(new Map());
	// Divider under the Sessions header, shown only once the list is scrolled off
	// the top — a scroll-shadow cue that there's content tucked under the header.
	const [listScrolled, setListScrolled] = useState(false);
	useLayoutEffect(() => {
		if (filter.repo === "all") return;
		const measure = () => {
			const head = headRef.current;
			const title = titleRef.current;
			const actions = actionsRef.current;
			const probe = probeRef.current;
			if (!head || !title || !actions || !probe) return;
			const GAP = 6; // .sidebar-workspace-head gap
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
	useEffect(() => onFoldersChanged(() => setFoldersState(getFolders())), []);
	useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);

	// ── Cross-section drag helpers ──
	const registerDropZone = (id: string) => (el: HTMLElement | null) => {
		if (el) dropZones.current.set(id, el);
		else dropZones.current.delete(id);
	};
	function trackRowDrag(e: unknown) {
		const ev = e as { clientY?: number; touches?: { clientY: number }[] };
		const y =
			typeof ev?.clientY === "number" ? ev.clientY : ev?.touches?.[0]?.clientY;
		if (typeof y !== "number") return;
		let zone: string | null = null;
		for (const [id, el] of dropZones.current) {
			const r = el.getBoundingClientRect();
			if (y >= r.top && y <= r.bottom) {
				zone = id;
				break;
			}
		}
		const next = zone && zone !== dragSourceZone.current ? zone : null;
		if (dragOverZoneRef.current !== next) {
			dragOverZoneRef.current = next;
			setDragOverZone(next);
		}
	}
	/** Read + clear the cross-section drop target (called from drop handlers). */
	function takeDropZone(): string | null {
		const target = dragOverZoneRef.current;
		dragOverZoneRef.current = null;
		dragSourceZone.current = null;
		setDragOverZone(null);
		return target;
	}
	useEffect(() => onReadsChanged(() => setReads(getReads())), []);
	// Re-render when a composer draft appears/disappears — rows check hasDraft()
	// during render to show the Slack-style "unsent draft" pencil.
	const [, setDraftsRev] = useState(0);
	useEffect(() => onDraftsChanged(() => setDraftsRev((v) => v + 1)), []);
	// Opt-in "last used" time badge on workspace rows (off / always / on hover).
	const [wsTimePref, setWsTimePref] = useState(getWsTimePref);
	useEffect(() => onWsTimeChanged(() => setWsTimePref(getWsTimePref())), []);

	// Right-click menu on a workspace row (mark unread / pin / status / rename /
	// copy link / delete), and inline rename (double-click the project name).
	const [projectMenu, setProjectMenu] = useState<{
		id: string;
		x: number;
		y: number;
	} | null>(null);
	// Right-click menu on a PR-lane row (copy link / open on GitHub) — PR rows
	// that no chat represents yet, so they have no workspace menu.
	const [prMenu, setPrMenu] = useState<{
		pr: PrRow;
		x: number;
		y: number;
	} | null>(null);
	const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
	const [projectDraft, setProjectDraft] = useState("");
	function commitProjectRename() {
		if (editingProjectId) {
			const name = projectDraft.trim();
			if (name) onRenameProject(editingProjectId, name);
		}
		setEditingProjectId(null);
	}
	// Inline rename for workspace-less rows (slack/linear/solo chats). These
	// used window.prompt(), which iOS standalone PWAs silently suppress —
	// Rename tapped, nothing happened. Same inline editor as workspace rows;
	// an empty commit clears the manual title back to the derived one.
	const [editingChatId, setEditingChatId] = useState<string | null>(null);
	const [chatDraft, setChatDraft] = useState("");
	function startChatRename(chat: { id: string; title: string }) {
		setChatDraft(chat.title);
		setEditingChatId(chat.id);
	}
	function commitChatRename(chat: UnifiedSession) {
		if (editingChatId) onRename(chat, chatDraft.trim());
		setEditingChatId(null);
	}
	/** Is this row's title currently being inline-edited (workspace or chat)? */
	function rowRenameEditing(row: WsRow): boolean {
		return row.workspace
			? editingProjectId === row.workspace.id
			: !!row.chats[0] && editingChatId === row.chats[0].id;
	}
	function commitFolderRename() {
		if (editingFolderId) {
			const name = folderDraft.trim();
			if (name) renameFolder(editingFolderId, name);
		}
		setEditingFolderId(null);
	}
	useEffect(() => {
		if (!projectMenu) return;
		const close = () => setProjectMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [projectMenu]);
	useEffect(() => {
		if (!prMenu) return;
		const close = () => setPrMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [prMenu]);
	useEffect(() => {
		if (!folderMenu) return;
		const close = () => setFolderMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [folderMenu]);

	// The Archived row counts *my* archived sessions (Michiel's scope), and honors
	// the active repo filter — same lens as the archived page it opens.
	const archivedCount = useMemo(() => {
		const user = currentUser.toLowerCase();
		return sessions.filter(
			(s) =>
				s.archived &&
				!s.automation &&
				s.startedBy &&
				s.startedBy.toLowerCase() === user &&
				(filter.repo === "all" || sessionRepo(s) === filter.repo),
		).length;
	}, [sessions, currentUser, filter.repo]);

	// Catch-up badge: how many of *my* unread workspaces the deck would walk
	// through (distinct workspace groups, same grouping the deck uses) — so the
	// count matches the "N Left" it opens on.
	const catchUpCount = useMemo(() => {
		const user = currentUser.toLowerCase();
		const groups = new Set<string>();
		for (const s of sessions) {
			if (s.archived || s.automation) continue;
			if (!s.startedBy || s.startedBy.toLowerCase() !== user) continue;
			if (!isUnread(s.id, s.lastActivity, reads)) continue;
			groups.add(s.projectId ? `ws:${s.projectId}` : `chat:${s.id}`);
		}
		return groups.size;
	}, [sessions, currentUser, reads]);

	// The repo-wide open-PR list (every open PR, session or not), from the
	// server's batched cache. Null until the first fetch lands — the rows memo
	// falls back to session-derived PRs so the section still renders if the
	// endpoint is unreachable.
	const [openPrs, setOpenPrs] = useState<OpenPr[] | null>(null);
	useEffect(() => {
		let alive = true;
		const load = () =>
			fetchOpenPrs()
				.then((prs) => {
					if (alive) setOpenPrs(prs);
				})
				.catch(() => {});
		load();
		const t = setInterval(load, 120_000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);

	// The Plain TODO queue for the Support band, polled gently (the server
	// caches ~30s, so every open browser sharing one fetch is fine). Null until
	// the first fetch lands; fetch errors (Plain not configured, API down) just
	// keep the band hidden.
	const [supportThreads, setSupportThreads] = useState<SupportThread[] | null>(
		null,
	);
	useEffect(() => {
		let alive = true;
		const load = () =>
			fetchSupportThreads()
				.then((threads) => {
					if (alive) setSupportThreads(threads);
				})
				.catch(() => {});
		load();
		const t = setInterval(load, 60_000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);

	// Newest live session per Plain thread — a Support row with one opens that
	// session instead of the session-less ticket preview.
	const supportSessionByThread = useMemo(() => {
		const m = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived || !s.plainThreadId) continue;
			const prev = m.get(s.plainThreadId);
			if (!prev || s.lastActivity > prev.lastActivity)
				m.set(s.plainThreadId, s);
		}
		return m;
	}, [sessions]);

	// A PR row in the "In review" lane. Chats that own a PR (their branch is
	// its head branch) are already lane rows wearing the PR's status — these
	// rows cover every OTHER open PR: `session` set means a chat owns the PR
	// through an attached repo (the row opens that chat); null means no chat
	// anywhere — the row opens the session-less PR preview, where the first
	// message creates a session on the PR's branch.
	interface PrRow {
		url: string;
		repo: string;
		branch: string;
		number?: number;
		title: string;
		isDraft: boolean;
		checksFailed: boolean;
		updatedAt: string;
		session: UnifiedSession | null;
	}

	// Open PRs of the focus person (the Person filter, defaulting to you;
	// "everyone" lifts the person lens) that no chat row already represents,
	// honoring the repo filter and search. A PR is a person's when their GitHub
	// account authored it (identity table, resolved server-side), or — for
	// bot-authored PRs, which Michael opens as tella-butler — when they started
	// the chat that owns it.
	const prLaneRows = useMemo(() => {
		const focus =
			filter.person === "me" ? currentUser.toLowerCase() : filter.person;
		const q = search.toLowerCase();

		// PRs represented by a live chat row already: any non-archived session
		// whose primary repo+branch is the PR's head. Attached-repo branches get
		// their own PR row that opens the owning chat (its row only wears the
		// primary PR).
		const primaryKeys = new Set<string>();
		const attachedByKey = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived) continue;
			// A human's chat owns its PR and represents it in the sidebar, so we drop
			// that PR from the PR lane. Automation sessions (e.g. github-pr-review)
			// are different: they claim the author's branch but show under "GitHub
			// (automation)", not the author — so letting them suppress the row hides
			// the PR from its own author's default "me" view (it's in neither lane).
			// Don't let an automation session claim a PR-lane row; the PR then shows
			// attributed to its author (pr.person).
			if (s.branch && !s.automation)
				primaryKeys.add(`${sessionRepo(s)}:${s.branch}`);
			for (const ar of s.attachedRepos || []) {
				const key = `${ar.repo}:${ar.branch}`;
				const prev = attachedByKey.get(key);
				if (!prev || s.lastActivity > prev.lastActivity)
					attachedByKey.set(key, s);
			}
		}

		const rows: PrRow[] = [];
		for (const pr of openPrs || []) {
			const key = `${pr.repo}:${pr.branch}`;
			if (primaryKeys.has(key)) continue;
			const session = attachedByKey.get(key) || null;
			const person =
				pr.person ||
				(session && !session.automation && session.startedBy
					? session.startedBy.toLowerCase()
					: null);
			if (focus !== "everyone" && person !== focus) continue;
			rows.push({
				url: pr.url,
				repo: pr.repo,
				branch: pr.branch,
				number: pr.number,
				title: pr.title,
				isDraft: pr.isDraft,
				checksFailed: (pr.checks?.failed || 0) > 0,
				updatedAt: pr.updatedAt,
				session,
			});
		}

		let visible = rows;
		if (filter.repo !== "all")
			visible = visible.filter((r) => r.repo === filter.repo);
		if (q)
			visible = visible.filter(
				(r) =>
					r.title.toLowerCase().includes(q) ||
					r.branch.toLowerCase().includes(q) ||
					String(r.number || "").includes(q.replace(/^#/, "")),
			);
		// "Created" sorts by PR number (creation order); "Updated" by activity.
		return visible.sort((a, b) =>
			filter.sort === "created"
				? (b.number || 0) - (a.number || 0)
				: (b.updatedAt || "").localeCompare(a.updatedAt || ""),
		);
	}, [
		sessions,
		openPrs,
		currentUser,
		search,
		filter.person,
		filter.repo,
		filter.sort,
	]);

	// Distinct repos across the (non-archived) sessions, most-used first, for the
	// Repo filter dropdown. Built off every session (not the search-filtered set)
	// so the options don't churn while you type.
	const repos = useMemo(() => {
		const counts = new Map<string, number>();
		for (const s of sessions) {
			if (s.archived) continue;
			const p = sessionRepo(s);
			counts.set(p, (counts.get(p) || 0) + 1);
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([name]) => name);
	}, [sessions]);

	// Distinct people who started sessions, most-active first, for the Person
	// filter dropdown. Only recognized teammates (see KNOWN_PEOPLE) are offered;
	// keyed by lowercased name to merge casing, with the first-seen spelling as
	// the display label. Built off every session so options don't churn on search.
	const people = useMemo(() => {
		const entries = new Map<string, { label: string; count: number }>();
		for (const s of sessions) {
			if (s.archived || s.automation || !s.startedBy) continue;
			const key = s.startedBy.toLowerCase();
			if (!KNOWN_PEOPLE.has(key)) continue;
			const e = entries.get(key) || { label: s.startedBy, count: 0 };
			e.count++;
			entries.set(key, e);
		}
		// Teammates whose GitHub account has open PRs get an option too, even
		// with no sessions — the Open PRs section can still show their work.
		for (const pr of openPrs || []) {
			if (!pr.person || entries.has(pr.person)) continue;
			const label = [...TEAM, "Michael"].find(
				(n) => n.toLowerCase() === pr.person,
			);
			if (label) entries.set(pr.person, { label, count: 0 });
		}
		return Array.from(entries.entries())
			.sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
			.map(([key, { label }]) => ({ key, label }));
	}, [sessions, openPrs]);

	// Every non-archived chat, narrowed by the repo/person filters and search.
	// Rows are built per-workspace below; a chat matching the filter surfaces its
	// whole workspace row.
	const filtered = useMemo(() => {
		let visible = sessions.filter((s) => !s.archived);
		if (filter.repo !== "all")
			visible = visible.filter((s) => sessionRepo(s) === filter.repo);
		// Only a specific teammate narrows the chats themselves. "me" and
		// "everyone" keep every chat so workspace rows stay whole (your
		// workspaces can contain teammates' chats, and pinned rows survive) —
		// the owner lens is applied per-row in focusWsRows instead.
		if (filter.person !== "me" && filter.person !== "everyone")
			visible = visible.filter(
				(s) =>
					!s.automation &&
					!!s.startedBy &&
					s.startedBy.toLowerCase() === filter.person,
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
	}, [sessions, search, filter.repo, filter.person]);

	// Sort order applied to every group's items: newest activity or newest
	// creation first. Groups read from this pre-sorted list so ordering is uniform.
	const sorted = useMemo(() => {
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		return [...filtered].sort(
			(a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
		);
	}, [filtered, filter.sort]);

	// ── Workspace rows ──────────────────────────────────────────────────────
	// The sidebar's main list is Workspaces (not individual chats): one row per
	// workspace, plus one implicit row per not-yet-wrapped standalone chat (the
	// pre-migration case — the data migration wraps those 1:1). A row's status
	// dot is derived from its most urgent chat; clicking opens the first chat.
	interface WsRow {
		/** Pin/menu key: `workspace:<id>` for real workspaces, the chat id solo. */
		key: string;
		/** Real workspace record, or null for an implicit single-chat row. */
		workspace: Project | null;
		name: string;
		chats: UnifiedSession[]; // createdAt asc — chats[0] is "the first chat"
		status: MineStatus;
		lastActivity: string;
		createdAt: string;
		unread: boolean;
		running: boolean;
		/** Lowercased owner (workspace creator, else the first chat's starter). */
		owner: string;
	}

	// Most-urgent-first for the row dot: a blocked question beats everything,
	// active review beats work-in-progress, merged/pending are quiet states.
	const STATUS_PRIORITY: MineStatus[] = [
		"needsinput",
		"review",
		"inprogress",
		"merged",
		"pending",
	];
	const STATUS_DOT: Record<MineStatus, string> = Object.fromEntries(
		MINE_STATUS_META.map((m) => [m.key, m.dotColor]),
	) as Record<MineStatus, string>;

	const wsRows = useMemo(() => {
		const rows: WsRow[] = [];
		const byWs = new Map<string, UnifiedSession[]>();
		const solo: UnifiedSession[] = [];
		for (const s of filtered) {
			if (s.automation) continue; // automations render in their own band
			if (s.sideChatOf) continue; // side chats live in the parent's panel, not the sidebar
			if (s.projectId) {
				const list = byWs.get(s.projectId) || [];
				list.push(s);
				byWs.set(s.projectId, list);
			} else solo.push(s);
		}
		const mkRow = (
			key: string,
			workspace: Project | null,
			name: string,
			chats: UnifiedSession[],
		): WsRow => {
			chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			const status =
				STATUS_PRIORITY.find((st) => chats.some((c) => mineStatus(c) === st)) ||
				"pending";
			return {
				key,
				workspace,
				name,
				chats,
				status,
				lastActivity: chats.reduce(
					(m, c) => (c.lastActivity > m ? c.lastActivity : m),
					"",
				),
				createdAt: chats[0]?.createdAt || "",
				unread: chats.some(
					(c) => c.id !== selectedId && isUnread(c.id, c.lastActivity, reads),
				),
				running: chats.some((c) => c.isRunning),
				owner: (workspace?.createdBy || chats[0]?.startedBy || "").toLowerCase(),
			};
		};
		for (const [wsId, chats] of byWs) {
			const ws = projects.find((p) => p.id === wsId) || null;
			rows.push(
				mkRow(`workspace:${wsId}`, ws, ws?.name || chats[0].title, chats),
			);
		}
		// Truly chatless workspaces still get a row — clicking opens the scoped New
		// palette. A workspace whose chats are all *automation* runs is NOT chatless
		// (those render in the Automations band), and neither is one whose chats
		// are all *archived* (archiving a workspace must not resurrect it as an
		// empty row) — so both get no row here.
		if (!search && filter.repo === "all") {
			const hasAnyChat = new Set(
				sessions.filter((s) => s.projectId).map((s) => s.projectId),
			);
			for (const p of projects) {
				if (!byWs.has(p.id) && !hasAnyChat.has(p.id))
					rows.push({
						key: `workspace:${p.id}`,
						workspace: p,
						name: p.name,
						chats: [],
						status: "pending",
						lastActivity: p.createdAt,
						createdAt: p.createdAt,
						unread: false,
						running: false,
						owner: (p.createdBy || "").toLowerCase(),
					});
			}
		}
		// Workspace-less chats (slack/linear sources + their bks- siblings) group
		// by shared isolated worktree — the SAME rule the tab strip uses — so the
		// sidebar and tabs always agree on what belongs together. Chats with no
		// isolated worktree stay solo rows.
		const byWorktree = new Map<string, UnifiedSession[]>();
		const loose: UnifiedSession[] = [];
		for (const s of solo) {
			if (s.worktreeDir?.startsWith("/home/ubuntu/worktrees/")) {
				const list = byWorktree.get(s.worktreeDir) || [];
				list.push(s);
				byWorktree.set(s.worktreeDir, list);
			} else loose.push(s);
		}
		for (const [dir, chats] of byWorktree) {
			chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			// The branch is the row's stable name (chat titles drift as generated
			// titles land; the branch names the shared piece of work). A manual
			// rename is explicit user intent though — it wins over the branch,
			// otherwise renaming a slack/linear session looks like a no-op.
			const renamed = chats.find((c) => c.titleOverridden);
			rows.push(
				mkRow(
					`wt:${dir}`,
					null,
					renamed?.title || chats[0].branch || chats[0].title,
					chats,
				),
			);
		}
		for (const s of loose) rows.push(mkRow(s.id, null, s.title, [s]));
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		rows.sort((a, b) => (b[key] || "").localeCompare(a[key] || ""));
		return rows;
	}, [filtered, sessions, projects, selectedId, reads, search, filter]);

	// Automations keep their own collapsible band, one group per automation —
	// hundreds of one-shot runs would drown the Workspaces list otherwise.
	const groups = useMemo(() => {
		const out: Group[] = [];
		const byAutomation = new Map<string, UnifiedSession[]>();
		for (const s of sorted) {
			if (!s.automation) continue;
			const list = byAutomation.get(s.automation) || [];
			list.push(s);
			byAutomation.set(s.automation, list);
		}
		for (const name of Array.from(byAutomation.keys()).sort()) {
			out.push({
				key: `auto:${name}`,
				label: name,
				dotColor: AUTOMATION_COLOR,
				band: "automations",
				items: byAutomation.get(name)!,
			});
		}
		return out;
	}, [sorted]);

	// Sessions in sidebar order (pinned rows first, then each group's items) —
	// used to hand onArchive the row that should become active when the open
	// session is archived away.
	const flatOrder = useMemo(() => {
		const pinned = pins
			.filter((e) => !e.startsWith("note:"))
			.map((id) =>
				sessions.find((s) => s.id === id || s.aliasIds?.includes(id)),
			)
			.filter((s): s is UnifiedSession => !!s);
		return [...pinned, ...groups.flatMap((g) => g.items)];
	}, [pins, sessions, groups]);

	function archiveWithNext(s: UnifiedSession) {
		const idx = flatOrder.findIndex((x) => x.id === s.id);
		const rest = flatOrder.filter((x) => x.id !== s.id);
		const next =
			idx >= 0 ? (rest[Math.min(idx, rest.length - 1)] ?? null) : (rest[0] ?? null);
		onArchive(s, next);
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
			...row.chats.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
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

	// ── Folder membership ──
	// Folder keys use the same vocabulary as pins (`workspace:<id>` / chat id),
	// so a row matches a folder through any of its identity keys — same aliasing
	// rules as pin matching above.
	const folderKeyToId = useMemo(() => {
		const m = new Map<string, string>();
		for (const f of folders) for (const k of f.keys) m.set(k, f.id);
		return m;
	}, [folders]);
	/** Every key a row could be filed under (canonical first, then legacy). */
	function rowIdentityKeys(row: WsRow): string[] {
		return [
			...(row.workspace ? [`workspace:${row.workspace.id}`] : []),
			row.key,
			...row.chats.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
		].filter((k, i, a) => a.indexOf(k) === i);
	}
	/** The one key we file/pin a row under going forward. */
	const rowCanonicalKey = (row: WsRow) =>
		row.workspace ? `workspace:${row.workspace.id}` : row.key;
	function rowFolderId(row: WsRow): string | null {
		for (const k of rowIdentityKeys(row)) {
			const id = folderKeyToId.get(k);
			if (id) return id;
		}
		return null;
	}
	/** Move a row into a folder (or out of all folders when null). Filing a
	    pinned row also unpins it — a row lives in exactly one section. */
	function moveRowToFolder(row: WsRow, folderId: string | null) {
		const allKeys = rowIdentityKeys(row);
		if (folderId) {
			const pinnedKeys = allKeys.filter((k) => pins.includes(k));
			if (pinnedKeys.length) setPins(unpinKeys(pinnedKeys));
			moveToFolder(allKeys, [rowCanonicalKey(row)], folderId);
		} else {
			moveToFolder(allKeys, [], null);
		}
	}
	/** Prompt-create a folder and file the row in it (the flyout's "New
	    folder…" — also the mobile path for creating folders). */
	function createFolderWithRow(row: WsRow) {
		const name = window.prompt("Folder name", "New folder")?.trim();
		if (!name) return;
		const f = createFolder(name);
		moveRowToFolder(row, f.id);
	}

	// Pinned rows (pinned via their own key or a legacy pin on a member chat)
	// and the focus person's rows — shared by the list rendering below and by
	// archive-next, so both always agree on what's actually in the sidebar.
	// Rows a teammate flagged for YOUR review (the info panel's Reviewer picker).
	// They get their own band at the very top: they're usually someone else's
	// workspaces, so the owner lens below would otherwise hide them entirely.
	const needsReviewRows = useMemo(() => {
		const me = currentUser.toLowerCase();
		return wsRows.filter(
			(r) =>
				!wsPrMerged(r) &&
				!wsPrApproved(r) &&
				r.chats.some(
					(c) =>
						c.reviewRequest?.to?.toLowerCase() === me &&
						!c.reviewRequest?.accepted,
				),
		);
	}, [wsRows, currentUser]);
	// The mirror of "Needs review": workspaces where YOU asked a teammate to
	// review (the info panel's Reviewer picker, `reviewRequest.by === me`). They
	// get their own band so a session you've sent out for review moves out of the
	// status lanes and into one place you can track what you're waiting on. A row
	// where you're also the reviewer stays in Needs review (a direct ask of you
	// wins), so we exclude those keys.
	const awaitingReviewRows = useMemo(() => {
		const me = currentUser.toLowerCase();
		const needsKeys = new Set(needsReviewRows.map((r) => r.key));
		return wsRows.filter(
			(r) =>
				!needsKeys.has(r.key) &&
				!wsPrMerged(r) &&
				!wsPrApproved(r) &&
				r.chats.some(
					(c) =>
						c.reviewRequest?.by?.toLowerCase() === me &&
						!c.reviewRequest?.accepted,
				),
		);
	}, [wsRows, currentUser, needsReviewRows]);
	// Reviewed: the request landed — the reviewer signed off, either via the info
	// panel's "Mark as reviewed" (`reviewRequest.accepted`) or by approving the
	// PR on GitHub (`prReviewDecision === "APPROVED"`, wsPrApproved). Shown to
	// both parties (asker or reviewer) so a session you sent out reads as done
	// instead of vanishing back into the status lanes, and the reviewer sees their
	// sign-off confirmed. Accepted/approved rows leave Needs / Awaiting and land
	// here instead. A merged PR skips this band entirely — it's fully done, so it
	// belongs in the "Done" status lane, not "Reviewed".
	const reviewedRows = useMemo(() => {
		const me = currentUser.toLowerCase();
		return wsRows.filter((r) => {
			if (wsPrMerged(r)) return false;
			const mineRequest = r.chats.some((c) => {
				const rq = c.reviewRequest;
				return (
					rq && (rq.by.toLowerCase() === me || rq.to.toLowerCase() === me)
				);
			});
			if (!mineRequest) return false;
			return r.chats.some((c) => c.reviewRequest?.accepted) || wsPrApproved(r);
		});
	}, [wsRows, currentUser]);
	// Every workspace pulled into a review band (Needs / Awaiting / Reviewed) —
	// excluded from the pinned/status lanes below so it lives in exactly one place.
	const reviewBandKeys = useMemo(
		() =>
			new Set([
				...needsReviewRows.map((r) => r.key),
				...awaitingReviewRows.map((r) => r.key),
				...reviewedRows.map((r) => r.key),
			]),
		[needsReviewRows, awaitingReviewRows, reviewedRows],
	);
	const pinnedWsRows = useMemo(() => {
		const pinSet = new Set(pins);
		const pinIdx = new Map(pins.map((p, i) => [p, i] as const));
		// A row's slot in the band = its first matching key's position in the
		// pins array (rows can be pinned via their workspace key or a legacy
		// member-chat pin) — pins order is user-controlled (drag-to-reorder), so
		// it wins over wsRows' recency order.
		const rowIdx = (r: WsRow) => {
			const hits = [r.key, ...r.chats.map((c) => c.id)]
				.map((k) => pinIdx.get(k))
				.filter((i): i is number => i !== undefined);
			return hits.length ? Math.min(...hits) : Infinity;
		};
		return wsRows
			.filter(
				(r) =>
					!reviewBandKeys.has(r.key) &&
					(pinSet.has(r.key) || r.chats.some((c) => pinSet.has(c.id))),
			)
			.sort((a, b) => rowIdx(a) - rowIdx(b));
	}, [wsRows, pins, reviewBandKeys]);
	const focusWsRows = useMemo(() => {
		const pinSet = new Set(pins);
		const focus =
			filter.person === "me" ? currentUser.toLowerCase() : filter.person;
		return wsRows.filter(
			(r) =>
				(focus === "everyone" || r.owner === focus) &&
				!reviewBandKeys.has(r.key) &&
				!pinSet.has(r.key) &&
				!r.chats.some((c) => pinSet.has(c.id)) &&
				// Foldered rows live in their folder section, not the lanes.
				!rowFolderId(r),
		);
	}, [wsRows, pins, filter.person, currentUser, reviewBandKeys, folderKeyToId]);

	// One section per folder: its rows in the folder's manual key order. Review
	// bands and Pinned win over folder membership (same "a row lives in one
	// place" rule as the lanes) — unpinning drops the row back into its folder.
	const folderSections = useMemo(() => {
		const pinSet = new Set(pins);
		const focus =
			filter.person === "me" ? currentUser.toLowerCase() : filter.person;
		return folders.map((folder) => {
			const keyIdx = new Map(folder.keys.map((k, i) => [k, i] as const));
			const rowIdx = (r: WsRow) => {
				const hits = rowIdentityKeys(r)
					.map((k) => keyIdx.get(k))
					.filter((i): i is number => i !== undefined);
				return hits.length ? Math.min(...hits) : Infinity;
			};
			const rows = wsRows
				.filter(
					(r) =>
						rowFolderId(r) === folder.id &&
						(focus === "everyone" || r.owner === focus) &&
						!reviewBandKeys.has(r.key) &&
						!pinSet.has(r.key) &&
						!r.chats.some((c) => pinSet.has(c.id)),
				)
				.sort((a, b) => rowIdx(a) - rowIdx(b));
			return { folder, rows };
		});
	}, [
		folders,
		wsRows,
		pins,
		filter.person,
		currentUser,
		reviewBandKeys,
		folderKeyToId,
	]);

	// Workspace rows in the sidebar's visual order (Pinned band first, then the
	// status lanes) — archiveWorkspaceWithNext walks this to pick the row that
	// should open when the active workspace is archived away.
	const wsRowOrder = useMemo(
		() => [
			...needsReviewRows,
			...awaitingReviewRows,
			...reviewedRows,
			...pinnedWsRows,
			...folderSections.flatMap((s) => s.rows),
			...MINE_STATUS_META.flatMap((meta) =>
				focusWsRows.filter((r) => r.status === meta.key),
			),
		],
		[
			needsReviewRows,
			awaitingReviewRows,
			reviewedRows,
			pinnedWsRows,
			folderSections,
			focusWsRows,
		],
	);
	const hasWorkspaceFilter =
		!!search || filter.repo !== "all" || filter.person !== "me";
	const workspaceListEmpty =
		needsReviewRows.length === 0 &&
		awaitingReviewRows.length === 0 &&
		reviewedRows.length === 0 &&
		pinnedWsRows.length === 0 &&
		focusWsRows.length === 0 &&
		prLaneRows.length === 0 &&
		folders.length === 0;

	function archiveWorkspaceWithNext(row: WsRow) {
		// Chatless rows can't be opened, so they're not "next" candidates.
		const candidates = wsRowOrder.filter((r) => r.chats.length > 0);
		const idx = candidates.findIndex((r) => r.key === row.key);
		const rest = candidates.filter((r) => r.key !== row.key);
		const next =
			idx >= 0 ? (rest[Math.min(idx, rest.length - 1)] ?? null) : (rest[0] ?? null);
		onArchiveWorkspace(row.chats, next?.chats[0] ?? null);
	}

	// Archive just the open chat and pick what becomes active. We resolve the open
	// session through wsRowOrder (the rendered workspace rows) rather than flatOrder
	// — flatOrder only carries pinned + automation chats, so a normal open session
	// isn't in it. If the chat has siblings in its workspace, land on one of them;
	// otherwise the row empties out, so land on the next workspace's first chat.
	function archiveOpenChatWithNext() {
		const candidates = wsRowOrder.filter((r) => r.chats.length > 0);
		const rowIdx = candidates.findIndex((r) =>
			r.chats.some((c) => c.id === selectedId),
		);
		if (rowIdx < 0) return;
		const row = candidates[rowIdx];
		const chat = row.chats.find((c) => c.id === selectedId);
		if (!chat) return;
		let next: UnifiedSession | null;
		const siblings = row.chats.filter((c) => c.id !== selectedId);
		if (siblings.length > 0) {
			const chatIdx = row.chats.findIndex((c) => c.id === selectedId);
			next = siblings[Math.min(chatIdx, siblings.length - 1)] ?? null;
		} else {
			const rest = candidates.filter((r) => r.key !== row.key);
			next = rest[Math.min(rowIdx, rest.length - 1)]?.chats[0] ?? null;
		}
		onArchive(chat, next);
	}

	// ⌘E (or the legacy ⌘⇧A) archives the open chat and lands on the next entry
	// in the sidebar, rather than dropping back to Home. This lives here (not in
	// the viewer) because the sidebar owns the row ordering that defines "next".
	// The viewer keeps the same chord only for the unarchive toggle on an
	// already-archived session — that session isn't in this list, so this
	// handler no-ops on it and the two never both fire. ⌘⌥⇧A below escalates to
	// the whole workspace.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.defaultPrevented || !isArchiveChord(e)) return;
			if (
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			)
				return;
			const target = e.target as HTMLElement | null;
			if (
				target?.closest(
					"input, textarea, select, [contenteditable='true'], [contenteditable='']",
				)
			)
				return;
			const inList = wsRowOrder.some(
				(r) => r.chats.length > 0 && r.chats.some((c) => c.id === selectedId),
			);
			if (!inList) return;
			e.preventDefault();
			closeWsHover();
			archiveOpenChatWithNext();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [wsRowOrder, selectedId, onArchive]);

	// ⌘⌥⇧A escalates the chat archive (⌘E/⌘⇧A) to the whole active workspace.
	// The Alt modifier is the only thing that separates the two handlers, so
	// exactly one fires. Targets the workspace holding the open session.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				e.defaultPrevented ||
				e.key.toLowerCase() !== "a" ||
				!(e.metaKey || e.ctrlKey) ||
				!e.shiftKey ||
				!e.altKey
			)
				return;
			const target = e.target as HTMLElement | null;
			if (
				target?.closest(
					"input, textarea, select, [contenteditable='true'], [contenteditable='']",
				)
			)
				return;
			const row = wsRowOrder.find(
				(r) => r.chats.length > 0 && r.chats.some((c) => c.id === selectedId),
			);
			if (!row) return;
			e.preventDefault();
			closeWsHover();
			archiveWorkspaceWithNext(row);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [wsRowOrder, selectedId, onArchiveWorkspace]);

	// ⌘↓/⌘↑ cycle the open session through the sidebar's workspace rows in
	// visual order (down = next row), wrapping at the ends. Chatless rows are
	// skipped — same candidate set as the archive-with-next handlers above.
	// Deliberately fires while the composer is focused (unlike the archive
	// chords): jumping workspaces without leaving the keyboard is the point,
	// and that costs the textarea its ⌘-arrow caret-to-start/end moves. Alt is
	// excluded so ⌘⌥ arrows stay free for the reasoning-effort chord
	// (SessionViewer); Shift so ⌘⇧-arrow text selection keeps working.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				e.defaultPrevented ||
				(e.key !== "ArrowUp" && e.key !== "ArrowDown") ||
				!(e.metaKey || e.ctrlKey) ||
				e.altKey ||
				e.shiftKey
			)
				return;
			if (
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			)
				return;
			const candidates = wsRowOrder.filter((r) => r.chats.length > 0);
			if (candidates.length === 0) return;
			const idx = candidates.findIndex((r) =>
				r.chats.some((c) => c.id === selectedId),
			);
			const dir = e.key === "ArrowDown" ? 1 : -1;
			// No open session in the list (e.g. Home): enter from the edge.
			const next =
				idx < 0
					? dir === 1
						? candidates[0]
						: candidates[candidates.length - 1]
					: candidates[(idx + dir + candidates.length) % candidates.length];
			if (!next) return;
			e.preventDefault();
			closeWsHover();
			if (next.workspace) onOpenProject(next.workspace.id);
			else if (next.chats[0]) onSelect(next.chats[0]);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [wsRowOrder, selectedId, onOpenProject, onSelect]);

	// ── Workspace hover card ────────────────────────────────────────────────
	// One card for the whole list (only one row can be dwelled on at a time).
	// Unlike the info-only SessionHoverCard it carries actions (Archive, PR
	// link, thumbnails), so leaving the row schedules the close with a short
	// grace period and entering the card cancels it — the pointer can travel
	// the 8px gap without the card vanishing under it.
	const wsHoverOpenT = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wsHoverCloseT = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [wsHover, setWsHover] = useState<{ row: WsRow; anchor: DOMRect } | null>(
		null,
	);
	// Mobile long-press sheet (the touch stand-in for the hover card).
	const [wsSheet, setWsSheet] = useState<WsRow | null>(null);

	function cancelWsHoverTimers() {
		if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
		if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
		wsHoverOpenT.current = null;
		wsHoverCloseT.current = null;
	}
	function wsRowHoverEnter(row: WsRow, el: HTMLElement) {
		if (rowRenameEditing(row)) return;
		cancelWsHoverTimers();
		wsHoverOpenT.current = setTimeout(() => {
			setWsHover({ row, anchor: el.getBoundingClientRect() });
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
	// The anchor rect goes stale the moment the list scrolls — just close.
	useEffect(() => {
		if (!wsHover) return;
		const close = () => closeWsHover();
		window.addEventListener("scroll", close, true);
		return () => window.removeEventListener("scroll", close, true);
	}, [wsHover]);

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
	const wsSwipeOffset = useRef(0);
	const [wsSwipe, setWsSwipe] = useState<SwipeState | null>(null);
	const [wsDraggingKey, setWsDraggingKey] = useState<string | null>(null);
	useEffect(() => {
		if (!isPhone) {
			setWsSwipe(null);
			wsSwipeOffset.current = 0;
			setWsDraggingKey(null);
		}
	}, [isPhone]);
	useEffect(() => {
		setWsSwipe(null);
		wsSwipeOffset.current = 0;
		setWsDraggingKey(null);
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
		wsPressTimer.current = setTimeout(() => {
			wsLongPressed.current = true;
			closeWsHover();
			navigator.vibrate?.(10);
			// The touch stand-in for both the hover card AND right-click: a
			// bottom sheet with the overview block plus every workspace action.
			setWsSheet(row);
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
				setWsSwipe({ key: row.key, offset });
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
	function wsRowTouchEnd(row: WsRow, e: React.TouchEvent) {
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
		if (rowRenameEditing(row)) return;
		if (wasSwiping) {
			e.preventDefault();
			if (Math.abs(swipeOffset) >= fullSwipeThreshold(rowWidth)) {
				const action: SwipeAction = swipeOffset < 0 ? "archive" : "star";
				setWsSwipe({
					key: row.key,
					offset: swipeCommitOffset(action, rowWidth),
					action,
				});
				window.setTimeout(() => {
					if (action === "archive") archiveWorkspaceWithNext(row);
					else {
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
			if (row.workspace) onOpenProject(row.workspace.id);
			else if (row.chats[0]) onSelect(row.chats[0]);
		} else if (wsLongPressed.current) {
			// Release after a long-press: the workspace sheet is already up —
			// swallow any ghost click so it can't land on the sheet (or its
			// backdrop's close handler) and immediately dismiss it.
			e.preventDefault();
		}
	}

	// Repo groups and folder sections are open by default (grouping is itself
	// the point), so we track their *collapsed* state under a "collapsed:" key;
	// every other group is closed by default and tracked directly.
	const collapseKey = (key: string) =>
		key.startsWith("repo:") || key.startsWith("folder:")
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
		if (key.startsWith("repo:") || key.startsWith("folder:"))
			return !expanded.has(`collapsed:${key}`);
		return expanded.has(key);
	};

	// The People / Automations bands are open by default, so — like
	// repo groups — their *collapsed* state is what's persisted. Collapsing one
	// hides every group within that band. Searching forces them open.
	const bandOpen = (band: GroupBand | "support") =>
		search.trim().length > 0 ? true : !expanded.has(`collapsed:band:${band}`);
	function toggleBand(band: GroupBand | "support") {
		const key = `collapsed:band:${band}`;
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	// Checks-tab badge: distinct open PRs (deduped by URL) where the CURRENT
	// user has a pending review request — "PRs waiting on you", not every open
	// PR. Sourced from both the session PRs and the repo-wide open-PR list, so
	// a teammate's PR with no Backstage session still counts.
	const openPrCount = useMemo(() => {
		const me = currentUser.toLowerCase();
		const urls = new Set<string>();
		for (const s of sessions) {
			if (
				s.prUrl &&
				s.prState === "OPEN" &&
				!s.prIsDraft &&
				!s.archived &&
				s.prReviewRequested?.includes(me)
			)
				urls.add(s.prUrl);
		}
		for (const pr of openPrs || []) {
			if (!pr.isDraft && pr.reviewRequested?.includes(me)) urls.add(pr.url);
		}
		return urls.size;
	}, [sessions, openPrs, currentUser]);

	// "Archived" reads as a peer of the My-sessions status buckets (Needs input /
	// Done …): an icon-led row that sits flush under them. Unlike those, it doesn't
	// expand inline — it navigates to the archived page, and highlights while that
	// page is open.
	const archivedBand =
		archivedCount > 0 ? (
			<button
				className={`sidebar-group-header sidebar-archived-row${
					archivedActive ? " active" : ""
				}`}
				onClick={onOpenArchived}
				title="View archived sessions"
			>
				<span className="sidebar-archived-icon">
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
				<span className="sidebar-group-name">Archived</span>
				<span className="sidebar-group-count">{archivedCount}</span>
			</button>
		) : null;

	// One sidebar row per workspace: status dot (most urgent chat), name, chat
	// count, unread dot. Click opens the first chat (or the workspace itself for
	// real workspaces — App resolves that to its first chat / scoped New palette).
	// Right-click opens the workspace menu (pin / color / rename / delete);
	// double-click renames inline.
	function renderWsRow(row: WsRow) {
		const active = row.chats.some((s) => s.id === selectedId);
		const editing = rowRenameEditing(row);
		const waiting = row.status === "needsinput";
		// The "in progress" ticker start: the earliest running chat's start, so a
		// workspace with several live chats shows how long it's been busy overall.
		// Done/idle chats don't count — only chats actually running feed the clock.
		// Prefer the server's runStartedAt (survives refresh); fall back to the
		// first moment we saw this row running. Pruned when the row goes idle.
		let runStartMs: number | null = null;
		if (row.running) {
			const stamps = row.chats
				.filter((c) => c.isRunning && c.runStartedAt)
				.map((c) => Date.parse(c.runStartedAt!))
				.filter((n) => !Number.isNaN(n));
			if (stamps.length) {
				runStartMs = Math.min(...stamps);
				runStartSeen.current.set(row.key, runStartMs);
			} else {
				runStartMs = runStartSeen.current.get(row.key) ?? Date.now();
				runStartSeen.current.set(row.key, runStartMs);
			}
		} else {
			runStartSeen.current.delete(row.key);
		}
		const swipeOffset = isPhone && wsSwipe?.key === row.key ? wsSwipe.offset : 0;
		const swipeAction = isPhone && wsSwipe?.key === row.key ? wsSwipe.action : null;
		const rowPin = workspacePinState(row);
		const pinned = rowPin.pinned;
		const toggleRowPin = rowPin.toggle;
		return (
			<div
				key={row.key}
				className={`sidebar-swipe-row${
					swipeAction === "archive" || swipeOffset < 0
						? " is-open is-swipe-archive"
						: swipeAction === "star" || swipeOffset > 0
							? " is-open is-swipe-star"
							: ""
				}${wsDraggingKey === row.key ? " is-dragging" : ""}`}
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
				{isPhone && row.chats.length > 0 && (
					<button
						className="sidebar-swipe-action sidebar-swipe-action--archive"
						onClick={(e) => {
							e.stopPropagation();
							setWsSwipe(null);
							archiveWorkspaceWithNext(row);
						}}
						title={
							row.chats.length > 1
								? `Archive workspace (${row.chats.length} chats)`
								: "Archive"
						}
					>
						<IconArchive size={22} />
						<span>Archive</span>
					</button>
				)}
				{isPhone && (
					<button
						className={`sidebar-swipe-action sidebar-swipe-action--star${pinned ? " is-on" : ""}`}
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
					className={`sidebar-item sidebar-ws-row ${active ? "sidebar-item-selected" : ""} ${waiting ? "sidebar-item-waiting" : ""} ${row.unread ? "sidebar-item-unread" : ""}`}
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
					if (row.workspace) onOpenProject(row.workspace.id);
					else if (row.chats[0]) onSelect(row.chats[0]);
				}}
					onMouseEnter={(e) => wsRowHoverEnter(row, e.currentTarget)}
					onMouseLeave={scheduleWsHoverClose}
					onMouseDown={closeWsHover}
					onTouchStart={(e) => wsRowTouchStart(row, e)}
					onTouchMove={(e) => wsRowTouchMove(row, e)}
					onTouchEnd={(e) => wsRowTouchEnd(row, e)}
					onTouchCancel={() => {
						clearWsPress();
						wsSwipeOrigin.current = null;
						wsSwiping.current = false;
						setWsDraggingKey(null);
					}}
					onContextMenu={(e) => {
					e.preventDefault();
					// On touch this is the long-press callout: our long-press already
					// opened the menu, so don't stack a second one (or the native
					// text-selection callout) on top of it.
					if (wsLongPressed.current || wsPressOrigin.current) return;
					closeWsHover();
					setProjectMenu({
						id: row.workspace ? row.workspace.id : row.key,
						x: e.clientX,
						y: e.clientY,
					});
					}}
					title={row.name}
				>
				{/* 22px slot — same as the group-header pin/eye icon (a 22px box at
				    6px pad, center 17/27px) so a row's PR/merge mark sits on the exact
				    icon column of its lane header, not 1px left in a smaller box.
				    Backlog/pending rows carry no mark: they show the unread dot in
				    that slot when unread, else an empty placeholder — either way the
				    title lines up with the iconned rows (a left indent). */}
				{(() => {
					const showUnreadDot =
						row.unread &&
						!waiting &&
						!row.running &&
						row.status !== "review" &&
						row.status !== "merged";
					if (showUnreadDot)
						return (
							<span
								className="flex shrink-0 items-center justify-center"
								style={{ width: 22, height: 22 }}
							>
								<span className="sidebar-item-status sidebar-status-unread" />
							</span>
						);
					return <WsStatusMark row={row} size={22} placeholder />;
				})()}
				{editing ? (
					<input
						className="sidebar-item-rename"
						value={row.workspace ? projectDraft : chatDraft}
						autoFocus
						onChange={(e) =>
							row.workspace
								? setProjectDraft(e.target.value)
								: setChatDraft(e.target.value)
						}
						onClick={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onBlur={() =>
							row.workspace
								? commitProjectRename()
								: commitChatRename(row.chats[0])
						}
						onKeyDown={(e) => {
							if (e.key === "Enter")
								row.workspace
									? commitProjectRename()
									: commitChatRename(row.chats[0]);
							else if (e.key === "Escape")
								row.workspace
									? setEditingProjectId(null)
									: setEditingChatId(null);
							e.stopPropagation();
						}}
					/>
				) : (
					<span
						className="sidebar-item-title"
						onDoubleClick={(e) => {
							e.stopPropagation();
							if (row.workspace) {
								setProjectDraft(row.workspace.name);
								setEditingProjectId(row.workspace.id);
							} else if (row.chats[0]) {
								// Solo chat rows rename the chat itself.
								startChatRename(row.chats[0]);
							}
						}}
					>
						{stripPrTitlePrefix(row.name)}
					</span>
				)}
				{row.chats.length > 1 && (
					<span className="sidebar-group-count">{row.chats.length}</span>
				)}
				{/* A live run always earns its elapsed ticker. The idle "last used"
				    time is opt-in (Settings → Appearance): revealed on hover by
				    default, or pinned always. It's shown on hover in every mode —
				    including while a run is live (the --running modifier keeps it
				    hidden until then, so the ticker owns the resting slot). */}
				{runStartMs !== null && <RunTicker startMs={runStartMs} />}
				{wsTimePref !== "off" && row.lastActivity && (
					<span
						className={`sidebar-ws-time${
							wsTimePref === "hover" ? " sidebar-ws-time--hover" : ""
						}${runStartMs !== null ? " sidebar-ws-time--running" : ""}`}
						title={new Date(row.lastActivity).toLocaleString()}
					>
						{shortTime(row.lastActivity)}
					</span>
				)}
				{/* Slack-style pencil: a chat here holds an unsent draft — come back
				    and finish it. Yields to the hover actions like the count/time. */}
				{row.chats.some((c) => hasDraft(`chat:${c.id}`)) && (
					<span className="sidebar-ws-draft" title="Unsent draft. Return to finish it.">
						<IconPencil size={20} />
					</span>
				)}
				{/* Hover actions: pin + archive, side by side (replace the count). */}
				<span className="sidebar-ws-actions">
					<span
						role="button"
						tabIndex={0}
						className={`sidebar-ws-action${pinned ? " is-on" : ""}`}
						title={pinned ? "Unpin workspace" : "Pin workspace"}
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
						<IconPin size={21} fill={pinned ? "currentColor" : "none"} />
					</span>
					{row.chats.length > 0 && (
						<Tooltip
							label={
								row.chats.length > 1
									? `Archive workspace (${row.chats.length} chats)`
									: "Archive workspace"
							}
							shortcut={
								// Single-chat workspace: archiving the workspace ≡ archiving
								// the open chat, so advertise the short ⌘E chord. The ⌘⌥⇧A
								// escalation only matters when there's more than one chat.
								active
									? row.chats.length > 1
										? ARCHIVE_WS_SHORTCUT_KEYS
										: ARCHIVE_SHORTCUT_KEYS
									: undefined
							}
						>
							<span
								role="button"
								tabIndex={0}
								className="sidebar-ws-action"
								aria-label="Archive workspace"
								onClick={(e) => {
									e.stopPropagation();
									archiveWorkspaceWithNext(row);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.stopPropagation();
										archiveWorkspaceWithNext(row);
									}
								}}
							>
								<IconArchive size={21} />
							</span>
						</Tooltip>
					)}
				</span>
				</button>
			</div>
		);
	}

	// A PR row in the "In review" lane: a chat-owned (attached-repo) PR opens
	// its chat; an unowned PR opens the session-less PR preview, where the
	// first message creates a session on the PR's head branch.
	function renderPrRow(r: PrRow) {
		const selected = r.session
			? r.session.id === selectedId
			: !!selectedPr &&
				selectedPr.repo === r.repo &&
				selectedPr.branch === r.branch;
		return (
			<button
				key={`pr:${r.url}`}
				className={`sidebar-item group flex items-center gap-2 min-w-0 ${
					selected ? "sidebar-item-selected" : ""
				}`}
				onClick={() => {
					if (r.session) onSelect(r.session);
					else onOpenPr(r.repo, r.branch);
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					setProjectMenu(null);
					setPrMenu({ pr: r, x: e.clientX, y: e.clientY });
				}}
				title={`${r.number ? `#${r.number} ` : ""}${r.title} — ${r.repo}`}
			>
				<IconPullRequest
					size={22}
					className={`shrink-0 ${
						r.checksFailed
							? "text-red"
							: r.isDraft
								? "text-faint"
								: "text-green"
					}`}
				/>
				{filter.repo === "all" && <RepoTile name={r.repo} />}
				<span className="sidebar-item-title">{r.title}</span>
				{r.isDraft && (
					<span className="text-faint text-[10.5px] max-[720px]:text-[12px] tracking-[-0.01em] shrink-0">
						draft
					</span>
				)}
				<span
					role="button"
					tabIndex={0}
					className="ml-auto hidden group-hover:inline-flex items-center shrink-0 text-faint hover:text-fg"
					title={`Open PR on ${providerFromUrl(r.url).name}`}
					onClick={(e) => {
						e.stopPropagation();
						window.open(r.url, "_blank", "noopener");
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.stopPropagation();
							window.open(r.url, "_blank", "noopener");
						}
					}}
				>
					<svg
						width="17"
						height="17"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<path
							d="M6.5 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v7.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5"
							strokeLinecap="round"
						/>
						<path
							d="M9.5 2.5h4v4M13.2 2.8L7.5 8.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</span>
			</button>
		);
	}

	// Quick "mark done" straight from a Support row — optimistic removal (the
	// ticket leaves Plain's Todo queue), restored by a refetch if Plain says no.
	async function markSupportRowDone(threadId: string) {
		setSupportThreads((prev) =>
			prev ? prev.filter((x) => x.id !== threadId) : prev,
		);
		try {
			await setPlainThreadStatusApi(threadId, "done", { user: currentUser });
		} catch {
			fetchSupportThreads()
				.then(setSupportThreads)
				.catch(() => {});
		}
	}

	// A Support row: one TODO Plain ticket. The dot wears the linked session's
	// status (faint when no session exists yet); click opens the session, or the
	// session-less ticket preview when there isn't one. Hovering swaps the
	// timestamp for a one-click "mark done".
	function renderSupportRow(t: SupportThread) {
		const session = supportSessionByThread.get(t.id) || null;
		const active = session
			? session.id === selectedId
			: selectedSupportThreadId === t.id;
		const customer = t.customer.name || t.customer.email || "Unknown";
		const label = t.title || customer;
		return (
			<button
				key={`support:${t.id}`}
				className={`sidebar-item group/support flex items-center gap-1.5 min-w-0 ${
					active ? "sidebar-item-selected" : ""
				}`}
				onClick={() =>
					session ? onSelect(session) : onOpenSupportThread(t.id)
				}
				title={`${customer} — ${label}${
					t.previewText ? `\n${t.previewText.slice(0, 200)}` : ""
				}`}
			>
				<span
					className="sidebar-group-dot"
					style={{
						backgroundColor: session
							? STATUS_DOT[mineStatus(session)]
							: "var(--text-faint)",
					}}
				/>
				<span className="sidebar-item-title">{label}</span>
				{t.statusChangedAt && (
					<span
						className="sidebar-ws-time group-hover/support:hidden"
						title={new Date(t.statusChangedAt).toLocaleString()}
					>
						{shortTime(t.statusChangedAt)}
					</span>
				)}
				<span
					role="button"
					className="sidebar-ws-time hidden group-hover/support:inline cursor-pointer hover:text-green font-semibold"
					title="Mark done in Plain"
					onClick={(e) => {
						e.stopPropagation();
						markSupportRowDone(t.id);
					}}
				>
					✓
				</span>
			</button>
		);
	}

	// The repo a workspace row belongs to when grouping by repo — its first
	// chat's primary repo (chats share a workspace, so they share a repo in
	// practice); chatless workspace rows fall back to the default repo.
	function wsRowRepo(row: WsRow): string {
		return row.chats[0] ? sessionRepo(row.chats[0]) : DEFAULT_PROJECT;
	}

	// The Conductor-style status lanes (Needs input / In progress / …) over a set
	// of workspace rows. `ns` namespaces the per-lane collapse keys so the same
	// lane can appear once per repo with independent open/closed state; the
	// default (status grouping) passes "" to keep the original `status:<key>`
	// keys and their persisted state. The review lane also absorbs the PR rows.
	function renderStatusLanes(rows: WsRow[], prRows: PrRow[], ns: string) {
		return MINE_STATUS_META.map((meta) => {
			const items = rows.filter((r) => r.status === meta.key);
			const lanePrRows = meta.key === "review" ? prRows : [];
			if (items.length === 0 && lanePrRows.length === 0) return null;
			const gkey = `${ns}status:${meta.key}`;
			const open = isOpen(gkey);
			return (
				<div className="sidebar-status-group" key={gkey}>
					<button
						className="sidebar-group-header"
						onClick={() => toggleGroup(gkey)}
					>
						<SidebarGroupIcon status={meta.key} color={meta.dotColor} />
						<span className="sidebar-group-name">{meta.label}</span>
						{/* Count rides directly behind the lane name, not pinned right. */}
						<span className="sidebar-group-count">
							{items.length + lanePrRows.length}
						</span>
						<IconChevronDown
							className="sidebar-group-chevron"
							size={22}
							style={{ transform: open ? "none" : "rotate(-90deg)" }}
						/>
					</button>
					{items
						.filter((r) => open || r.chats.some((c) => c.id === selectedId))
						.map(renderWsRow)}
					{lanePrRows
						.filter(
							(r) =>
								open ||
								(r.session
									? r.session.id === selectedId
									: !!selectedPr &&
										selectedPr.repo === r.repo &&
										selectedPr.branch === r.branch),
						)
						.map(renderPrRow)}
				</div>
			);
		});
	}

	// "Group by: Repo" — one collapsible band per repo, each holding that repo's
	// status lanes. Repos are ordered by the sidebar's frequency list (`repos`),
	// with any stragglers appended; a band is force-open while it holds the
	// selected row so the open session never hides inside a collapsed repo.
	function renderRepoGroups() {
		const byRepo = new Map<string, { rows: WsRow[]; prs: PrRow[] }>();
		const bucket = (repo: string) => {
			let b = byRepo.get(repo);
			if (!b) {
				b = { rows: [], prs: [] };
				byRepo.set(repo, b);
			}
			return b;
		};
		for (const r of focusWsRows) bucket(wsRowRepo(r)).rows.push(r);
		for (const pr of prLaneRows) bucket(pr.repo).prs.push(pr);
		const order = [
			...repos,
			...Array.from(byRepo.keys()).filter((r) => !repos.includes(r)),
		];
		return order
			.filter((repo) => byRepo.has(repo))
			.map((repo) => {
				const b = byRepo.get(repo)!;
				const gkey = `repo:${repo}`;
				const hasSelected =
					b.rows.some((r) => r.chats.some((c) => c.id === selectedId)) ||
					b.prs.some((r) =>
						r.session
							? r.session.id === selectedId
							: !!selectedPr &&
								selectedPr.repo === r.repo &&
								selectedPr.branch === r.branch,
					);
				const open = isOpen(gkey) || hasSelected;
				return (
					<div className="sidebar-repo-group" key={gkey}>
						<button
							className="sidebar-group-header sidebar-repo-head"
							onClick={() => toggleGroup(gkey)}
						>
							<RepoTile name={repo} />
							<span className="sidebar-group-name">{repoLabel(repo)}</span>
							{/* Count rides directly behind the repo name, not pinned right. */}
							<span className="sidebar-group-count">
								{b.rows.length + b.prs.length}
							</span>
							<IconChevronDown
								className="sidebar-group-chevron"
								size={22}
								style={{ transform: open ? "none" : "rotate(-90deg)" }}
							/>
							{/* Hover action at the far end: start a new session with this
							    repo already selected. role=button (not a nested <button>). */}
							<span
								role="button"
								tabIndex={0}
								className="sidebar-repo-new"
								title={`New session in ${repo}`}
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
								<IconPlus size={24} />
							</span>
						</button>
						{open && (
							<div className="sidebar-repo-lanes">
								{renderStatusLanes(b.rows, b.prs, `repo:${repo}::`)}
							</div>
						)}
					</div>
				);
			});
	}

	return (
		<div className="sidebar">
			{/* Checks — the only non-workspace area in the sidebar. Every other
			    tool (Automations, Goals, Actions, Security, Notes) lives in
			    Settings now. */}
			<nav className="sidebar-nav">
				<button
					className={`sidebar-nav-item ${watercoolerActive ? "active" : ""}`}
					onClick={onOpenWatercooler}
					title="Team chat. @ a teammate to ping them, or a session to link it."
				>
					<span className="sidebar-nav-icon">
						<IconWatercooler />
					</span>
					Watercooler
					{watercoolerUnread > 0 && (
						<span className="sidebar-nav-count">{watercoolerUnread}</span>
					)}
				</button>
				<button
					className={`sidebar-nav-item ${catchUpActive ? "active" : ""}`}
					onClick={onOpenCatchUp}
					title="Swipe through your unread workspaces"
				>
					<span className="sidebar-nav-icon">
						<IconStack />
					</span>
					Catch up
					{catchUpCount > 0 && (
						<span className="sidebar-nav-count">{catchUpCount}</span>
					)}
				</button>
				<button
					className={`sidebar-nav-item ${reviewsActive ? "active" : ""}`}
					onClick={onOpenReviews}
				>
					<span className="sidebar-nav-icon">
						<IconEye />
					</span>
					Reviews
					{openPrCount > 0 && (
						<span className="sidebar-nav-count">{openPrCount}</span>
					)}
				</button>
				<button
					className={`sidebar-nav-item ${prTinderActive ? "active" : ""}`}
					onClick={onOpenPrTinder}
					title="Swipe through the repo's open PRs"
				>
					<span className="sidebar-nav-icon">
						<IconFlame />
					</span>
					PR Tinder
				</button>
				<button
					className={`sidebar-nav-item ${supportTinderActive ? "active" : ""}`}
					onClick={onOpenSupportTinder}
					title="Swipe through the Plain Todo queue"
				>
					<span className="sidebar-nav-icon">
						<IconInbox />
					</span>
					Support Tinder
				</button>
				<button
					className={`sidebar-nav-item ${reportsActive ? "active" : ""}`}
					onClick={onOpenReports}
					title="Recurring automation reports"
				>
					<span className="sidebar-nav-icon">
						<IconFile />
					</span>
					Reports
				</button>
			</nav>

			<div
				className={`sidebar-workspace${listScrolled ? " sidebar-workspace--scrolled" : ""}`}
			>
				<div className="sidebar-workspace-head" ref={headRef}>
					<span className="sidebar-workspace-title" ref={titleRef}>
						{filter.person === "me"
							? "Workspaces"
							: filter.person === "everyone"
								? "All workspaces"
								: `${people.find((p) => p.key === filter.person)?.label || filter.person}'s workspaces`}
					</span>
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
					<div className="sidebar-workspace-spacer" />
					<div className="sidebar-workspace-actions" ref={actionsRef}>
						<Tooltip label="Group, filter & sort">
						<button
							ref={filterBtnRef}
							className={`sidebar-new-btn sidebar-filter-btn${
								filterOpen ? " active" : ""
							}${
								filter.groupBy !== "status" ||
								filter.repo !== "all" ||
								filter.person !== "me"
									? " has-filter"
									: ""
							}`}
							onClick={() => setFilterOpen((o) => !o)}
						>
							<IconFilter size={24} />
						</button>
						</Tooltip>
						<Tooltip label="New folder">
						<button
							className="sidebar-new-btn inline-flex items-center justify-center"
							aria-label="New folder"
							onClick={() => {
								const f = createFolder("New folder");
								setFolderDraft(f.name);
								setEditingFolderId(f.id);
							}}
						>
							<IconFolderPlus size={24} />
						</button>
						</Tooltip>
						<Tooltip
							label="New session"
							shortcut={
								/Mac|iPhone|iPad|iPod/.test(navigator.platform)
									? ["⌘", "N"]
									: ["Ctrl", "N"]
							}
						>
						<button
							className="sidebar-new-btn inline-flex items-center justify-center"
							onClick={onNewSession}
						>
							<IconPlus size={24} />
						</button>
						</Tooltip>
					</div>
					{/* Off-layout probe: measures the chip's natural width so the effect
					    above can decide whether it fits inline (never rendered visibly). */}
					{filter.repo !== "all" && (
						<RepoFilterChip repo={filter.repo} variant="probe" ref={probeRef} />
					)}
				</div>

				{/* Fallback row: only when the chip doesn't fit inline. */}
				{filter.repo !== "all" && !repoInline && (
					<div className="sidebar-repo-row">
						<RepoFilterChip
							repo={filter.repo}
							repos={repos}
							onClear={() => setFilter({ repo: "all" })}
							onSelect={(v) => setFilter({ repo: v })}
							variant="row"
						/>
					</div>
				)}
			</div>

			{/* On phones the filter button lives in the top bar (next to Search);
			    its popover anchors there. Desktop keeps it in the header. */}
			{isPhone &&
				headerActionsEl &&
				createPortal(
					<button
						ref={mobileFilterBtnRef}
						className={`mobile-filter-btn${filterOpen ? " active" : ""}${
							filter.groupBy !== "status" ||
							filter.repo !== "all" ||
							filter.person !== "me"
								? " has-filter"
								: ""
						}`}
						onClick={() => setFilterOpen((o) => !o)}
						aria-label="Group, filter & sort"
					>
						<IconFilter size={22} />
					</button>,
					headerActionsEl,
				)}

			{filterOpen && (
				<FilterPopover
					anchor={
						isPhone
							? mobileFilterBtnRef.current
							: filterBtnRef.current
					}
					filter={filter}
					repos={repos}
					people={people}
					currentUser={currentUser}
					onChange={setFilter}
					onClose={() => setFilterOpen(false)}
				/>
			)}

			{projectMenu &&
				(() => {
					// The menu id is a real workspace id, or a row key for a
					// workspace-less row (solo chat / shared-worktree group).
					const ws = projects.find((p) => p.id === projectMenu.id);
					const menuRow = wsRows.find((r) =>
						ws ? r.workspace?.id === ws.id : r.key === projectMenu.id,
					);
					const chats = menuRow?.chats ?? [];
					const first = chats[0];
					const pinKey = ws ? `workspace:${ws.id}` : projectMenu.id;
					// A row can be pinned via its own key or a legacy pin on any member
					// chat (incl. alias ids) — unpin clears all of them.
					const pinnedKeys = [
						pinKey,
						...(menuRow
							? [
									menuRow.key,
									...menuRow.chats.flatMap((c) => [
										c.id,
										...(c.aliasIds || []),
									]),
								]
							: []),
					].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
					const pinned = pinnedKeys.length > 0;
					const togglePinNow = () => {
						if (pinned) {
							let next = pins;
							for (const k of pinnedKeys) next = togglePin(k);
							setPins(next);
						} else {
							setPins(togglePin(pinKey));
						}
					};
					const anyManual = chats.some((c) => c.manualStatus);
					const sharedManual =
						anyManual &&
						chats.every((c) => c.manualStatus === chats[0].manualStatus)
							? (chats[0].manualStatus ?? null)
							: null;

					const entries: CtxEntry[] = [];
					if (chats.length > 0)
						entries.push({
							kind: "item",
							icon: <IconMail size={20} />,
							label: "Mark as unread",
							onClick: () => chats.forEach((c) => markUnread(c.id)),
						});
					entries.push({
						kind: "item",
						icon: (
							<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
						),
						label: pinned ? "Unpin" : "Pin",
						onClick: togglePinNow,
					});
					if (menuRow)
						entries.push({
							kind: "folder",
							folders: folders.map((f) => ({ id: f.id, name: f.name })),
							currentId: rowFolderId(menuRow),
							onPick: (fid) => moveRowToFolder(menuRow, fid),
							onNew: () => createFolderWithRow(menuRow),
						});
					if (chats.length > 0)
						entries.push({
							kind: "status",
							current: sharedManual,
							// Applies the pin to every chat so the aggregated row lands
							// in the chosen lane; "Auto" clears it back to the derived one.
							onPick: (s) => onSetStatus(chats, s),
						});
					if (ws)
						entries.push({
							kind: "item",
							icon: <IconPencil size={20} />,
							label: "Rename",
							onClick: () => {
								setProjectDraft(ws.name);
								setEditingProjectId(ws.id);
							},
						});
					else if (first)
						entries.push({
							kind: "item",
							icon: <IconPencil size={20} />,
							label: "Rename",
							onClick: () => startChatRename(first),
						});
					if (first)
						entries.push({
							kind: "item",
							icon: <IconLink size={20} />,
							label: "Copy link",
							shortcut: "⌘⇧C",
							onClick: () =>
								copyToClipboard(absoluteLink(chatPath(first)), () =>
									onToast?.("Link copied"),
								),
						});
					// A chat that owns a worktree/branch (and thus a PR/diff) can open
					// its Review tab here — it's off by default in the viewer.
					if (first && (first.worktreeDir || first.branch))
						entries.push({
							kind: "item",
							icon: <IconEye size={20} />,
							label: "Open review",
							onClick: () => onOpenReview(first),
						});
					// Archive is the removal action here (a chat/workspace is finished
					// by archiving, never inferred-deleted). A chatless workspace has
					// nothing to archive, so it keeps Delete as its only removal.
					if (menuRow && chats.length > 0) {
						entries.push({ kind: "sep" });
						entries.push({
							kind: "item",
							icon: <IconArchive size={20} />,
							label: "Archive",
							onClick: () => archiveWorkspaceWithNext(menuRow),
						});
					} else if (ws) {
						entries.push({ kind: "sep" });
						entries.push({
							kind: "item",
							icon: <IconTrash size={20} />,
							danger: true,
							label: "Delete workspace",
							onClick: () => {
								if (
									window.confirm(
										`Delete workspace "${ws.name}"? Its chats become standalone.`,
									)
								)
									onDeleteProject(ws.id);
							},
						});
					}

					return (
						<SidebarCtxMenu
							x={projectMenu.x}
							y={projectMenu.y}
							entries={entries}
							onClose={() => setProjectMenu(null)}
						/>
					);
				})()}
			{prMenu &&
				(() => {
					const r = prMenu.pr;
					const link = r.session
						? absoluteLink(chatPath(r.session))
						: absoluteLink(prPath(r.repo, r.branch));
					const entries: CtxEntry[] = [
						{
							kind: "item",
							icon: <IconLink size={20} />,
							label: "Copy link",
							shortcut: "⌘⇧C",
							onClick: () =>
								copyToClipboard(link, () => onToast?.("Link copied")),
						},
						{
							kind: "item",
							icon: <IconPullRequest size={20} />,
							label: `Open PR on ${providerFromUrl(r.url).name}`,
							onClick: () => window.open(r.url, "_blank", "noopener"),
						},
					];
					return (
						<SidebarCtxMenu
							x={prMenu.x}
							y={prMenu.y}
							entries={entries}
							onClose={() => setPrMenu(null)}
						/>
					);
				})()}
			{folderMenu &&
				(() => {
					const f = folders.find((x) => x.id === folderMenu.id);
					if (!f) return null;
					const idx = folders.findIndex((x) => x.id === f.id);
					const rowCount =
						folderSections.find((s) => s.folder.id === f.id)?.rows.length ?? 0;
					const swap = (a: number, b: number) => {
						const ids = folders.map((x) => x.id);
						[ids[a], ids[b]] = [ids[b], ids[a]];
						reorderFolders(ids);
					};
					const entries: CtxEntry[] = [
						{
							kind: "item",
							icon: <IconPencil size={20} />,
							label: "Rename",
							onClick: () => {
								setFolderDraft(f.name);
								setEditingFolderId(f.id);
							},
						},
					];
					// Keyboard-free reordering — the touch path (drag is desktop-only),
					// and a quick fallback on desktop too.
					if (idx > 0)
						entries.push({
							kind: "item",
							icon: (
								<IconChevronDown
									size={20}
									style={{ transform: "rotate(180deg)" }}
								/>
							),
							label: "Move up",
							onClick: () => swap(idx, idx - 1),
						});
					if (idx < folders.length - 1)
						entries.push({
							kind: "item",
							icon: <IconChevronDown size={20} />,
							label: "Move down",
							onClick: () => swap(idx, idx + 1),
						});
					entries.push({ kind: "sep" });
					entries.push({
						kind: "item",
						icon: <IconTrash size={20} />,
						danger: true,
						label: "Delete folder",
						onClick: () => {
							if (
								rowCount === 0 ||
								window.confirm(
									`Delete folder "${f.name}"? Its ${rowCount} session${rowCount === 1 ? "" : "s"} return to the lanes.`,
								)
							)
								deleteFolder(f.id);
						},
					});
					return (
						<SidebarCtxMenu
							x={folderMenu.x}
							y={folderMenu.y}
							entries={entries}
							onClose={() => setFolderMenu(null)}
						/>
					);
				})()}

			<div
				className="sidebar-list"
				onScroll={(e) => {
					const scrolled = e.currentTarget.scrollTop > 0;
					setListScrolled((prev) => {
						if (prev === scrolled) return prev;
						onListScrolledChange?.(scrolled);
						return scrolled;
					});
				}}
			>
				{workspaceListEmpty && (
					<div className="sidebar-workspace-empty">
						{hasWorkspaceFilter
							? "No matching workspaces"
							: "No workspaces yet"}
					</div>
				)}

				{/* ── Needs review: sessions a teammate asked YOU to look at (the info
				    panel's Reviewer picker). Rides above everything — it's a direct
				    request, like a blocked question. ── */}
				{needsReviewRows.length > 0 &&
					(() => {
						const open = isOpen("needsreview");
						return (
							<div className="sidebar-group sidebar-group--review">
								<button
									className="sidebar-group-header"
									onClick={() => toggleGroup("needsreview")}
								>
									<IconBell
										className="sidebar-group-icon"
										style={{ color: "var(--accent)" }}
									/>
									<span className="sidebar-group-name">Needs review</span>
									<span className="sidebar-group-count">
										{needsReviewRows.length}
									</span>
									<IconChevronDown
										className="sidebar-group-chevron"
										size={22}
										style={{ transform: open ? "none" : "rotate(-90deg)" }}
									/>
								</button>
								{needsReviewRows
									.filter(
										(r) => open || r.chats.some((c) => c.id === selectedId),
									)
									.map(renderWsRow)}
							</div>
						);
					})()}

				{/* ── Awaiting review: sessions YOU asked a teammate to review (the
				    mirror of Needs review). Grouped here so a session you've sent out
				    for review moves out of the status lanes into one place. ── */}
				{awaitingReviewRows.length > 0 &&
					(() => {
						const open = isOpen("awaitingreview");
						return (
							<div className="sidebar-group sidebar-group--review">
								<button
									className="sidebar-group-header"
									onClick={() => toggleGroup("awaitingreview")}
								>
									<IconEye
										className="sidebar-group-icon"
										style={{ color: "var(--yellow)" }}
									/>
									<span className="sidebar-group-name">Awaiting review</span>
									<span className="sidebar-group-count">
										{awaitingReviewRows.length}
									</span>
									<IconChevronDown
										className="sidebar-group-chevron"
										size={22}
										style={{ transform: open ? "none" : "rotate(-90deg)" }}
									/>
								</button>
								{awaitingReviewRows
									.filter(
										(r) => open || r.chats.some((c) => c.id === selectedId),
									)
									.map(renderWsRow)}
							</div>
						);
					})()}

				{/* ── Reviewed: the request landed — the reviewer signed off. Shown to
				    both the asker and the reviewer so a session sent out for review
				    reads as done rather than dropping back into the status lanes. ── */}
				{reviewedRows.length > 0 &&
					(() => {
						const open = isOpen("reviewed");
						return (
							<div className="sidebar-group sidebar-group--review">
								<button
									className="sidebar-group-header"
									onClick={() => toggleGroup("reviewed")}
								>
									<IconCheck
										className="sidebar-group-icon"
										style={{ color: "var(--green)" }}
									/>
									<span className="sidebar-group-name">Reviewed</span>
									<span className="sidebar-group-count">
										{reviewedRows.length}
									</span>
									<IconChevronDown
										className="sidebar-group-chevron"
										size={22}
										style={{ transform: open ? "none" : "rotate(-90deg)" }}
									/>
								</button>
								{reviewedRows
									.filter(
										(r) => open || r.chats.some((c) => c.id === selectedId),
									)
									.map(renderWsRow)}
							</div>
						);
					})()}

				{/* ── Pinned (workspaces + notes, mixed) ── */}
				{(() => {
					const pinnedRows = pinnedWsRows;
					// Pinned chats that don't map to a workspace row (automation runs).
					const rowChatIds = new Set(
						wsRows.flatMap((r) => r.chats.map((c) => c.id)),
					);
					const pinnedLoose = pins
						.filter((e) => !e.startsWith("note:") && !e.startsWith("workspace:"))
						.filter((id) => !rowChatIds.has(id))
						.map((id) =>
							sessions.find(
								(s) => s.id === id || s.aliasIds?.includes(id),
							),
						)
						// An archived chat must never surface in Pinned — its pin is
						// stale (archiving drops it server-side, but a resurrected or
						// legacy pin can still point at it). Skip it so it can't render
						// as an un-archivable ghost row.
						.filter((s): s is UnifiedSession => !!s && !s.archived)
						// Honor the repo filter — a pinned chat from another repo
						// shouldn't leak into a repo-scoped view (workspace pins
						// already drop out via wsRows/filtered).
						.filter(
							(s) => filter.repo === "all" || sessionRepo(s) === filter.repo,
						);
					const pinnedNotes = pins
						.filter((e) => e.startsWith("note:"))
						.map((e) => notes.find((n) => n.id === e.slice(5)))
						.filter((n): n is { id: string; title: string } => !!n);
					if (!pinnedRows.length && !pinnedLoose.length && !pinnedNotes.length)
						return null;
					const pinnedOpen = isOpen("pinned");

					// One flat drag-to-reorder list: every pinned thing (workspace row,
					// loose chat, note) becomes an entry slotted by its first key's
					// position in the pins array, so reordering is just rewriting that
					// array (reorderPins). `pinKeys` is everything in `pins` that maps
					// to the entry — a workspace can be pinned via its own key AND
					// legacy member-chat pins — so a drop moves them as one unit.
					type PinEntry = {
						key: string;
						pinKeys: string[];
						node: React.ReactNode;
					};
					const pinIdx = new Map(pins.map((p, i) => [p, i] as const));
					const entries: PinEntry[] = [];
					for (const row of pinnedRows) {
						entries.push({
							key: `ws:${row.key}`,
							pinKeys: [row.key, ...row.chats.map((c) => c.id)].filter((k) =>
								pinIdx.has(k),
							),
							node: renderWsRow(row),
						});
					}
					const seenLoose = new Set<string>();
					for (const s of pinnedLoose) {
						// A chat pinned via both its id and an alias maps to the same
						// session twice — render (and reorder) it once.
						if (seenLoose.has(s.id)) continue;
						seenLoose.add(s.id);
						const pin = sessionPinState(s);
						entries.push({
							key: `chat:${s.id}`,
							pinKeys: [s.id, ...(s.aliasIds ?? [])].filter((k) =>
								pinIdx.has(k),
							),
							node: (
								<SidebarItem
									session={s}
									selected={s.id === selectedId}
									unread={
										s.id !== selectedId &&
										isUnread(s.id, s.lastActivity, reads)
									}
									mine={
										!!s.startedBy &&
										!s.automation &&
										s.startedBy.toLowerCase() === currentUser.toLowerCase()
									}
									onClick={() => onSelect(s)}
									onArchive={() => archiveWithNext(s)}
									pinned={pin.pinned}
									onTogglePin={pin.toggle}
									onRename={(title) => onRename(s, title)}
								/>
							),
						});
					}
					for (const n of pinnedNotes) {
						entries.push({
							key: `note:${n.id}`,
							pinKeys: [`note:${n.id}`],
							node: (
								<button
									className={`sidebar-item ${n.id === activeNoteId ? "sidebar-item-selected" : ""}`}
									onClick={() => onOpenNote(n.id)}
									title={n.title}
								>
									<span style={{ marginRight: 6, opacity: 0.9 }}>📝</span>
									<span className="sidebar-item-title">{n.title}</span>
								</button>
							),
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
					const canDragPins = !isPhone && entries.length > 1;
					const commitPinReorder = () => {
						const draggedKey = pinDragKey;
						const dropZone = takeDropZone();
						setPinDragKey(null);
						pinJustDragged.current = true;
						// The drop's click fires synchronously after pointerup; clear the
						// swallow flag right after so the next real click works.
						setTimeout(() => {
							pinJustDragged.current = false;
						}, 0);
						const orderKeys = pinOrderPending.current;
						pinOrderPending.current = null;
						setPinOrderDraft(null);
						// Dropped over a folder section: file the row there instead of
						// reordering — unpin it (a row lives in one section) and add its
						// canonical key to the folder. Only workspace rows can be filed:
						// notes and loose chats (automation runs) don't exist in wsRows,
						// so a folder entry for them would render nothing.
						if (dropZone?.startsWith("folder:") && draggedKey?.startsWith("ws:")) {
							const entry = entryMap.get(draggedKey);
							if (entry) {
								const canonical = draggedKey.slice(3);
								setPins(unpinKeys(entry.pinKeys));
								moveToFolder(
									[...entry.pinKeys, canonical],
									[canonical],
									dropZone.slice("folder:".length),
								);
								return;
							}
						}
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
						<div
							className={`sidebar-group sidebar-group--pinned${
								dragOverZone === "pinned" ? " is-drop-target" : ""
							}`}
							ref={registerDropZone("pinned")}
						>
							{/* Same header treatment as the status lanes below. */}
							<button
								className="sidebar-group-header"
								onClick={() => toggleGroup("pinned")}
							>
								<IconPin
									className="sidebar-group-icon"
									style={{ color: "var(--text-faint)" }}
								/>
								<span className="sidebar-group-name">Pinned</span>
								<span className="sidebar-group-count">{pinnedCount}</span>
								<IconChevronDown
									className="sidebar-group-chevron"
									size={22}
									style={{ transform: pinnedOpen ? "none" : "rotate(-90deg)" }}
								/>
							</button>
							{pinnedOpen && (
								<Reorder.Group
									as="div"
									axis="y"
									className={`sidebar-pin-list${pinDragKey ? " is-drag-active" : ""}`}
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
											onDragStart={() => {
												setPinDragKey(e.key);
												dragSourceZone.current = "pinned";
											}}
											onDrag={trackRowDrag}
											onDragEnd={commitPinReorder}
											whileDrag={{ scale: 1.01 }}
											className={`sidebar-pin-entry${pinDragKey === e.key ? " is-reordering" : ""}`}
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

				{/* ── Folders: user-made sections between Pinned and the lanes.
				    Section order and each folder's row order are per-user server
				    state; headers drag to reorder sections (desktop), rows drag
				    within/between sections and to/from Pinned. ── */}
				{folders.length > 0 &&
					(() => {
						const searching = search.trim().length > 0;
						// While searching, hide sections with no matching rows — empty
						// "name ———" kickers would just be noise between results.
						const visibleSections = folderSections.filter(
							(s) => !searching || s.rows.length > 0,
						);
						if (!visibleSections.length) return null;
						const displaySections = folderOrderDraft
							? [...visibleSections].sort((a, b) => {
									const ai = folderOrderDraft.indexOf(a.folder.id);
									const bi = folderOrderDraft.indexOf(b.folder.id);
									return (
										(ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi)
									);
								})
							: visibleSections;
						const canDragFolders =
							!isPhone && !searching && visibleSections.length > 1;
						const commitFolderOrder = () => {
							setFolderDragId(null);
							folderJustDragged.current = true;
							setTimeout(() => {
								folderJustDragged.current = false;
							}, 0);
							const order = folderOrderPending.current;
							folderOrderPending.current = null;
							setFolderOrderDraft(null);
							if (!order) return;
							// Visible sections take the slots visible sections already
							// occupy; sections hidden by a search keep their positions.
							const visibleIds = new Set(
								visibleSections.map((s) => s.folder.id),
							);
							const queue = order.filter((id) => visibleIds.has(id));
							reorderFolders(
								folders.map((f) =>
									visibleIds.has(f.id) ? (queue.shift() ?? f.id) : f.id,
								),
							);
						};
						const handleRowDrop = (
							folderId: string,
							row: WsRow,
							orderedKeys: string[] | null,
						) => {
							const dropZone = takeDropZone();
							const allKeys = rowIdentityKeys(row);
							const canonical = rowCanonicalKey(row);
							// Dropped on the Pinned band: pinning relocates the row (it
							// leaves its folder — a row lives in one section).
							if (dropZone === "pinned") {
								moveToFolder(allKeys, [], null);
								setPins(pinKey(canonical));
								return;
							}
							// Dropped on another folder: refile it there.
							if (dropZone?.startsWith("folder:")) {
								const fid = dropZone.slice("folder:".length);
								if (fid !== folderId) {
									moveToFolder(allKeys, [canonical], fid);
									return;
								}
							}
							if (!orderedKeys) return;
							// Same-folder reorder: visible rows' keys take the slots that
							// visible keys already occupy in the folder, so keys hidden by
							// filters keep their exact positions (same trick as pins).
							const section = folderSections.find(
								(s) => s.folder.id === folderId,
							);
							const folder = folders.find((f) => f.id === folderId);
							if (!section || !folder) return;
							const inFolder = new Set(folder.keys);
							const rowByKey = new Map(
								section.rows.map((r) => [r.key, r] as const),
							);
							const flat = orderedKeys.flatMap((k) => {
								const r = rowByKey.get(k);
								return r
									? rowIdentityKeys(r).filter((x) => inFolder.has(x))
									: [];
							});
							const visible = new Set(flat);
							const queue = [...flat];
							reorderFolderKeys(
								folderId,
								folder.keys.map((k) =>
									visible.has(k) ? (queue.shift() ?? k) : k,
								),
							);
						};
						return (
							<Reorder.Group
								as="div"
								axis="y"
								className="sidebar-folders"
								values={displaySections.map((s) => s.folder.id)}
								onReorder={(ids: string[]) => {
									folderOrderPending.current = ids;
									setFolderOrderDraft(ids);
								}}
							>
								{displaySections.map(({ folder, rows }) => (
									<FolderSection
										key={folder.id}
										folder={folder}
										rows={rows}
										open={isOpen(`folder:${folder.id}`)}
										onToggle={() => toggleGroup(`folder:${folder.id}`)}
										editing={editingFolderId === folder.id}
										draft={folderDraft}
										onDraftChange={setFolderDraft}
										onCommitRename={commitFolderRename}
										onCancelRename={() => setEditingFolderId(null)}
										isPhone={isPhone}
										canDragFolder={
											canDragFolders && editingFolderId !== folder.id
										}
										canDragRows={!isPhone}
										dragging={folderDragId === folder.id}
										isDropTarget={dragOverZone === `folder:${folder.id}`}
										justDraggedRef={folderJustDragged}
										registerZone={registerDropZone(`folder:${folder.id}`)}
										onFolderDragStart={() => setFolderDragId(folder.id)}
										onFolderDragEnd={commitFolderOrder}
										onMenu={(x, y) => setFolderMenu({ id: folder.id, x, y })}
										onRowDragStart={() => {
											dragSourceZone.current = `folder:${folder.id}`;
										}}
										onRowDrag={trackRowDrag}
										onRowDrop={(row, orderedKeys) =>
											handleRowDrop(folder.id, row, orderedKeys)
										}
										renderRow={renderWsRow}
									/>
								))}
							</Reorder.Group>
						);
					})()}

				{/* ── Workspaces: status lanes live directly under the Workspaces
				    header above (which carries the filter, new-workspace and
				    new-session actions) — no second in-list heading. ── */}
				<div className="sidebar-group">
					{/* Status groups over the focus person's workspaces. The Person
					    filter defaults to you; picking a teammate shows their groups
					    instead, and "Everyone" shows all workspaces. "Group by: Repo"
					    nests those same status lanes under one band per repo. Empty
					    lanes/bands are hidden — only groups with sessions render. */}
					{filter.groupBy === "repo"
						? renderRepoGroups()
						: renderStatusLanes(focusWsRows, prLaneRows, "")}
				</div>

				{archivedBand && (
					<div className="sidebar-group">{archivedBand}</div>
				)}

				{/* ── Support: the Plain TODO queue, newest status change first (the
				    same ordering as Plain's Todo inbox). Rows with a linked session
				    open it; the rest open the session-less ticket preview. ── */}
				{(supportThreads?.length || 0) > 0 &&
					(() => {
						const open = bandOpen("support");
						return (
							<div className="sidebar-group sidebar-group--band-start">
								<div className="sidebar-band-label">
									<button
										className="sidebar-band-toggle"
										onClick={() => toggleBand("support")}
										title={open ? "Collapse support" : "Expand support"}
									>
										<span className="sidebar-band-name">Support</span>
										<span className="sidebar-group-count">{supportThreads!.length}</span>
										<IconChevronDown
											className="sidebar-band-chevron"
											size={18}
											style={{ transform: open ? "none" : "rotate(-90deg)" }}
										/>
									</button>
								</div>
								{open && supportThreads!.map(renderSupportRow)}
							</div>
						);
					})()}

				{/* ── People: teammates who are looking at a session right now. Click
				    to follow along (your navigation shadows theirs); click again to
				    stop. Band hides itself when nobody else is around. ── */}
				{(() => {
					const others = teamViewing.filter((v) => v.user !== currentUser);
					if (others.length === 0) return null;
					const titleFor = (id: string) =>
						sessions.find((s) => s.id === id)?.title || id;
					const open = bandOpen("people");
					return (
						<div className="sidebar-group sidebar-group--band-start">
							<div className="sidebar-band-label">
								<button
									className="sidebar-band-toggle"
									onClick={() => toggleBand("people")}
									title={open ? "Collapse people" : "Expand people"}
								>
									<span className="sidebar-band-name">People</span>
									<span className="sidebar-group-count">{others.length}</span>
									<IconChevronDown
										className="sidebar-band-chevron"
										size={18}
										style={{ transform: open ? "none" : "rotate(-90deg)" }}
									/>
								</button>
							</div>
							{open &&
								others.map((v) => (
									<button
										key={v.user}
										className={`flex items-center gap-2 w-full min-w-0 text-left text-[14px] max-[720px]:text-[16px] bg-transparent border-0 cursor-pointer rounded-md px-2 py-2 max-[720px]:py-2.5 hover:bg-hover ${
											followUser === v.user ? "bg-active" : ""
										}`}
										onClick={() => onToggleFollow?.(v.user)}
										title={
											followUser === v.user
												? `Following ${v.user}. Click to stop.`
												: `${v.user} is viewing “${titleFor(v.sessionId)}.” Click to follow along.`
										}
									>
										<UserAvatar
											name={v.user}
											size={20}
											className="shrink-0 ring-2"
											style={{ "--tw-ring-color": personColor(v.user) } as React.CSSProperties}
										/>
										<span className="text-fg shrink-0">{v.user}</span>
										<span className="text-faint truncate">
											{titleFor(v.sessionId)}
										</span>
										{followUser === v.user && (
											<span className="text-accent text-[11px] max-[720px]:text-[12px] tracking-[-0.01em] ml-auto shrink-0">
												following
											</span>
										)}
									</button>
								))}
						</div>
					);
				})()}

				{/* People browsing lives in the Person filter (funnel icon) — pick a
				    teammate there to see their status lanes instead of yours. */}
				{/* ── Automations (one collapsible band, one group per automation) ── */}
				{groups.length > 0 && (
					<div className="sidebar-group sidebar-group--automations sidebar-group--band-start">
						<div className="sidebar-band-label">
							<button
								className="sidebar-band-toggle"
								onClick={() => toggleBand("automations")}
								title={
									bandOpen("automations")
										? "Collapse automations"
										: "Expand automations"
								}
							>
								<span className="sidebar-band-name">Automations</span>
								<span className="sidebar-group-count">{groups.reduce((n, g) => n + g.items.length, 0)}</span>
								<IconChevronDown
									className="sidebar-band-chevron"
									size={18}
									style={{ transform: bandOpen("automations") ? "none" : "rotate(-90deg)" }}
								/>
							</button>
						</div>
						{bandOpen("automations") &&
							groups.map((group) => {
								const open = isOpen(group.key);
								return (
									<React.Fragment key={group.key}>
										<button
											className="sidebar-group-header"
											onClick={() => toggleGroup(group.key)}
										>
											{group.dotColor && (
												<span
													className="sidebar-group-dot"
													style={{ backgroundColor: group.dotColor }}
												/>
											)}
											<span className="sidebar-group-name">{group.label}</span>
											<IconChevronDown
												className="sidebar-group-chevron"
												size={22}
												style={{
													transform: open ? "none" : "rotate(-90deg)",
												}}
											/>
											<span className="sidebar-group-count">
												{group.items.length}
											</span>
											{/* Hover swaps the count for a cog that jumps to this
											    automation in Settings (span, not button — we're
											    inside the header button). */}
											<span
												role="button"
												className="sidebar-auto-cog"
												title="Automation settings"
												onClick={(e) => {
													e.stopPropagation();
													onOpenAutomation(group.label);
												}}
											>
												<IconGear size={17} />
											</span>
										</button>
										{/* When collapsed, still surface the actively selected
										    session so it never disappears behind a closed header. */}
										{group.items
											.filter((s) => open || s.id === selectedId)
											.map((s) => {
												const pin = sessionPinState(s);
												return (
													<SidebarItem
														key={s.id}
														session={s}
														selected={s.id === selectedId}
														unread={
															s.id !== selectedId &&
															isUnread(s.id, s.lastActivity, reads)
														}
														mine={
															!!s.startedBy &&
															!s.automation &&
															s.startedBy.toLowerCase() ===
																currentUser.toLowerCase()
														}
														onClick={() => onSelect(s)}
														onArchive={() => archiveWithNext(s)}
														pinned={pin.pinned}
														onTogglePin={pin.toggle}
														onRename={(title) => onRename(s, title)}
													/>
												);
											})}
									</React.Fragment>
								);
							})}
					</div>
				)}
			</div>
			{wsHover && (
				<WsHoverCard
					row={wsHover.row}
					anchor={wsHover.anchor}
					onEnter={cancelWsHoverTimers}
					onLeave={scheduleWsHoverClose}
					onArchive={() => {
						closeWsHover();
						archiveWorkspaceWithNext(wsHover.row);
					}}
					onOpen={(chat) => {
						closeWsHover();
						onSelect(chat);
					}}
				/>
			)}
			{wsSheet &&
				(() => {
					const row = wsSheet;
					const ws = row.workspace;
					// Same pin resolution as the row's star and the right-click menu: a
					// row can be pinned via its own key or a legacy pin on any member
					// chat (incl. alias ids) — unpin must clear all of them.
					const pinKey = ws ? `workspace:${ws.id}` : row.key;
					const pinnedKeys = [
						pinKey,
						row.key,
						...row.chats.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
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
							onArchive={() => archiveWorkspaceWithNext(row)}
							onSetStatus={(status) => onSetStatus(row.chats, status)}
							onOpen={(chat) => onSelect(chat)}
							onRename={() => {
								if (ws) {
									setProjectDraft(ws.name);
									setEditingProjectId(ws.id);
								} else if (row.chats[0]) {
									// Solo chat rows rename the chat itself.
									startChatRename(row.chats[0]);
								}
							}}
							onMarkUnread={
								row.chats.length > 0
									? () => row.chats.forEach((c) => markUnread(c.id))
									: null
							}
							onCopyLink={
								row.chats[0]
									? () =>
											copyToClipboard(
												absoluteLink(chatPath(row.chats[0])),
												() => onToast?.("Link copied"),
											)
									: null
							}
							onDelete={
								ws
									? () => {
											if (
												window.confirm(
													`Delete workspace "${ws.name}"? Its chats become standalone.`,
												)
											)
												onDeleteProject(ws.id);
										}
									: null
							}
						/>
					);
				})()}
		</div>
	);
}

// ── Filter popover ─────────────────────────────────────────────────────────
// A small floating panel (anchored under the filter button) with three controls:
// Group by (Status / Repo), Repo (All repos + one per repo), and Sort by
// (Updated / Created). Rendered in a portal so it can overflow the narrow sidebar.

interface SelectOption {
	value: string;
	label: string;
	icon?: React.ReactNode;
}

function FilterPopover({
	anchor,
	filter,
	repos,
	people,
	currentUser,
	onChange,
	onClose,
}: {
	anchor: HTMLElement | null;
	filter: FilterState;
	repos: string[];
	people: Array<{ key: string; label: string }>;
	currentUser: string;
	onChange: (patch: Partial<FilterState>) => void;
	onClose: () => void;
}) {
	if (!anchor) return null;
	const r = anchor.getBoundingClientRect();
	const width = 290;
	const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
	const top = r.bottom + 6;

	const repoOptions: SelectOption[] = [
		{ value: "all", label: "All repos" },
		...repos.map((name) => ({
			value: name,
			label: repoLabel(name),
			icon: <RepoTile name={name} />,
		})),
	];

	// You first (the default), then teammates, "Everyone" last — selecting
	// Everyone literally shows all workspaces, which is rarely what you want,
	// so it never leads the list.
	const meKey = currentUser.toLowerCase();
	const personDot = (key: string) => (
		<span
			className="sidebar-group-dot"
			style={{ backgroundColor: personColor(key) }}
		/>
	);
	const personOptions: SelectOption[] = [
		{ value: "me", label: `${currentUser} (you)`, icon: personDot(meKey) },
		...people
			.filter(({ key }) => key !== meKey)
			.map(({ key, label }) => ({
				value: key,
				label,
				icon: personDot(key),
			})),
		{ value: "everyone", label: "Everyone" },
	];

	return createPortal(
		<>
			<div className="menu-backdrop" onClick={onClose} />
			<div className="filter-popover" style={{ left, top, width }}>
				<div className="filter-row">
					<span className="filter-row-label">Group by</span>
					<MiniSelect
						value={filter.groupBy}
						options={[
							{ value: "status", label: "Status" },
							{ value: "repo", label: "Repo" },
						]}
						onSelect={(v) => onChange({ groupBy: v as GroupBy })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Repo</span>
					<MiniSelect
						value={filter.repo}
						options={repoOptions}
						onSelect={(v) => onChange({ repo: v })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Person</span>
					<MiniSelect
						value={filter.person}
						options={personOptions}
						onSelect={(v) => onChange({ person: v })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Sort by</span>
					<MiniSelect
						value={filter.sort}
						options={[
							{ value: "updated", label: "Updated" },
							{ value: "created", label: "Created" },
						]}
						onSelect={(v) => onChange({ sort: v as SortBy })}
					/>
				</div>
			</div>
		</>,
		document.body,
	);
}

// A styled dropdown used by the filter popover. Its menu is portaled so it can
// escape both the popover and the sidebar; a transparent backdrop closes it.
function MiniSelect({
	value,
	options,
	onSelect,
}: {
	value: string;
	options: SelectOption[];
	onSelect: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const current = options.find((o) => o.value === value);
	const r = open && btnRef.current ? btnRef.current.getBoundingClientRect() : null;

	let menu: React.ReactNode = null;
	if (open && r) {
		const menuW = Math.max(r.width, 150);
		const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
		menu = createPortal(
			<>
				<div
					className="menu-backdrop menu-backdrop--nested"
					onClick={() => setOpen(false)}
				/>
				<div
					className="mini-select-menu"
					style={{ left, top: r.bottom + 4, minWidth: menuW }}
				>
					{options.map((o) => (
						<button
							key={o.value}
							className={`mini-select-item${o.value === value ? " selected" : ""}`}
							onClick={() => {
								onSelect(o.value);
								setOpen(false);
							}}
						>
							{o.icon}
							<span className="mini-select-item-text">{o.label}</span>
							{o.value === value && (
								<svg
									className="mini-select-check"
									width="17"
									height="17"
									viewBox="0 0 16 16"
									fill="none"
								>
									<path
										d="M3.5 8.5l3 3 6-7"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							)}
						</button>
					))}
				</div>
			</>,
			document.body,
		);
	}

	return (
		<div className="mini-select-wrap">
			<button
				ref={btnRef}
				className="mini-select"
				onClick={() => setOpen((o) => !o)}
			>
				<span className="mini-select-value">
					{current?.icon}
					<span className="mini-select-text">{current?.label ?? value}</span>
				</span>
				<svg
					className="mini-select-caret"
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
				>
					<path
						d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{menu}
		</div>
	);
}

// The removable "active repo filter" chip. Rendered in three variants:
// "inline" (in the header, behind the title), "row" (its own line under the
// header) and "probe" (an off-layout copy used only to measure natural width —
// non-interactive and hidden from a11y).
const RepoFilterChip = React.forwardRef<
	HTMLSpanElement,
	{
		repo: string;
		repos?: string[];
		onClear?: () => void;
		onSelect?: (repo: string) => void;
		variant: "inline" | "row" | "probe";
	}
>(function RepoFilterChip({ repo, repos = [], onClear, onSelect, variant }, ref) {
	const probe = variant === "probe";
	const [open, setOpen] = useState(false);
	const bodyRef = useRef<HTMLButtonElement>(null);
	const r = open && bodyRef.current ? bodyRef.current.getBoundingClientRect() : null;

	// Repo dropdown, opened straight off the chip body (no detour through the
	// filter popover). "All repos" clears the filter; reuses the MiniSelect menu.
	let menu: React.ReactNode = null;
	if (open && r) {
		const options: SelectOption[] = [
			{ value: "all", label: "All repos" },
			...repos.map((name) => ({
				value: name,
				label: repoLabel(name),
				icon: <RepoTile name={name} />,
			})),
		];
		const menuW = Math.max(r.width, 170);
		const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
		menu = createPortal(
			<>
				<div className="menu-backdrop" onClick={() => setOpen(false)} />
				<div
					className="mini-select-menu"
					style={{ left, top: r.bottom + 5, minWidth: menuW }}
				>
					{options.map((o) => (
						<button
							key={o.value}
							className={`mini-select-item${o.value === repo ? " selected" : ""}`}
							onClick={() => {
								onSelect?.(o.value);
								setOpen(false);
							}}
						>
							{o.icon}
							<span className="mini-select-item-text">{o.label}</span>
							{o.value === repo && (
								<svg
									className="mini-select-check"
									width="17"
									height="17"
									viewBox="0 0 16 16"
									fill="none"
								>
									<path
										d="M3.5 8.5l3 3 6-7"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							)}
						</button>
					))}
				</div>
			</>,
			document.body,
		);
	}

	return (
		<span
			ref={ref}
			className={`sidebar-repo-chip sidebar-repo-chip--${variant}${
				open ? " open" : ""
			}`}
			aria-hidden={probe || undefined}
		>
			{/* Body opens the repo dropdown; the × clears the filter. */}
			<button
				type="button"
				ref={bodyRef}
				className="sidebar-repo-chip-open"
				title="Switch repo"
				tabIndex={probe ? -1 : undefined}
				onClick={probe ? undefined : () => setOpen((o) => !o)}
			>
				<RepoTile name={repo} />
				<span className="sidebar-repo-chip-name">{repoLabel(repo)}</span>
			</button>
			<button
				type="button"
				className="sidebar-repo-chip-x"
				title="Clear repo filter"
				tabIndex={probe ? -1 : undefined}
				onClick={probe ? undefined : onClear}
			>
				×
			</button>
			{menu}
		</span>
	);
});

// ── Folder section ──────────────────────────────────────────────────────────
// One sidebar folder: a quiet kicker header (name + hairline + count/chevron,
// per the Pinned-band's visual language but section-styled, not indented) over
// a drag-to-reorder row list. The section itself is a Reorder.Item in the
// folders Reorder.Group — the header is its drag handle (desktop) — and each
// row is a Reorder.Item in the section's own Reorder.Group. Cross-section
// moves are the parent's job: rows report drags via onRowDrag and the parent
// resolves the drop zone in onRowDrop. Generic over the row shape so the
// component can live at module level while WsRow stays private to Sidebar.
function FolderSection<Row extends { key: string }>({
	folder,
	rows,
	open,
	onToggle,
	editing,
	draft,
	onDraftChange,
	onCommitRename,
	onCancelRename,
	isPhone,
	canDragFolder,
	canDragRows,
	dragging,
	isDropTarget,
	justDraggedRef,
	registerZone,
	onFolderDragStart,
	onFolderDragEnd,
	onMenu,
	onRowDragStart,
	onRowDrag,
	onRowDrop,
	renderRow,
}: {
	folder: SidebarFolder;
	rows: Row[];
	open: boolean;
	onToggle: () => void;
	editing: boolean;
	draft: string;
	onDraftChange: (v: string) => void;
	onCommitRename: () => void;
	onCancelRename: () => void;
	isPhone: boolean;
	canDragFolder: boolean;
	canDragRows: boolean;
	dragging: boolean;
	isDropTarget: boolean;
	justDraggedRef: React.MutableRefObject<boolean>;
	registerZone: (el: HTMLElement | null) => void;
	onFolderDragStart: () => void;
	onFolderDragEnd: () => void;
	onMenu: (x: number, y: number) => void;
	onRowDragStart: (row: Row) => void;
	onRowDrag: (e: unknown) => void;
	onRowDrop: (row: Row, orderedKeys: string[] | null) => void;
	renderRow: (row: Row) => React.ReactNode;
}) {
	const controls = useDragControls();
	const sectionEl = useRef<HTMLDivElement | null>(null);
	const renameInput = useRef<HTMLInputElement | null>(null);
	// Entering edit mode (create or rename): focus the input ourselves and
	// scroll the section into view. The folders region can sit well below the
	// fold (big review/pinned bands above it), and mount-time autoFocus doesn't
	// reliably scroll a transformed Reorder.Item into view in Safari — which
	// made the header's New-folder button look like a no-op.
	useEffect(() => {
		if (!editing) return;
		renameInput.current?.focus({ preventScroll: true });
		sectionEl.current?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [editing]);
	// In-flight row order during a drag (same draft/commit pattern as Pinned).
	const [rowOrderDraft, setRowOrderDraft] = useState<string[] | null>(null);
	const rowOrderPending = useRef<string[] | null>(null);
	const [rowDragKey, setRowDragKey] = useState<string | null>(null);
	const rowJustDragged = useRef(false);
	// Touch long-press on the header opens the folder menu (rename/reorder/
	// delete) — same tuning as the row long-press sheet.
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pressOrigin = useRef<{ x: number; y: number } | null>(null);
	const longPressed = useRef(false);
	const clearPress = () => {
		if (pressTimer.current) clearTimeout(pressTimer.current);
		pressTimer.current = null;
		pressOrigin.current = null;
	};

	const orderedRows = useMemo(() => {
		if (!rowOrderDraft) return rows;
		const idx = new Map(rowOrderDraft.map((k, i) => [k, i] as const));
		return [...rows].sort(
			(a, b) => (idx.get(a.key) ?? Infinity) - (idx.get(b.key) ?? Infinity),
		);
	}, [rows, rowOrderDraft]);

	return (
		<Reorder.Item
			as="div"
			value={folder.id}
			dragListener={false}
			dragControls={controls}
			onDragStart={onFolderDragStart}
			onDragEnd={onFolderDragEnd}
			className={`sidebar-folder-section${open ? " is-open" : ""}${
				dragging ? " is-reordering" : ""
			}${isDropTarget ? " is-drop-target" : ""}`}
			ref={(el: HTMLDivElement | null) => {
				sectionEl.current = el;
				registerZone(el);
			}}
		>
			<button
				type="button"
				className="sidebar-folder-header"
				onPointerDown={(e) => {
					// The header doubles as the section's drag handle on desktop.
					if (canDragFolder && !editing) controls.start(e);
				}}
				onClick={(e) => {
					if (justDraggedRef.current || longPressed.current) {
						longPressed.current = false;
						e.preventDefault();
						return;
					}
					if (!editing) onToggle();
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					if (longPressed.current || pressOrigin.current) return;
					onMenu(e.clientX, e.clientY);
				}}
				onTouchStart={(e) => {
					const t = e.touches[0];
					if (!t) return;
					pressOrigin.current = { x: t.clientX, y: t.clientY };
					longPressed.current = false;
					pressTimer.current = setTimeout(() => {
						longPressed.current = true;
						onMenu(t.clientX, t.clientY);
					}, LONG_PRESS_MS);
				}}
				onTouchMove={(e) => {
					const t = e.touches[0];
					const o = pressOrigin.current;
					if (!t || !o) return;
					if (Math.hypot(t.clientX - o.x, t.clientY - o.y) > LONG_PRESS_SLOP)
						clearPress();
				}}
				onTouchEnd={(e) => {
					clearPress();
					// Release after a long-press: the menu is up — swallow the ghost
					// click so it can't immediately toggle the section under it.
					if (longPressed.current) e.preventDefault();
				}}
				onTouchCancel={clearPress}
				title={folder.name}
			>
				{editing ? (
					<input
						ref={renameInput}
						className="sidebar-item-rename sidebar-folder-rename"
						value={draft}
						onFocus={(e) => e.currentTarget.select()}
						onChange={(e) => onDraftChange(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onPointerDown={(e) => e.stopPropagation()}
						onBlur={onCommitRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") onCommitRename();
							else if (e.key === "Escape") onCancelRename();
							e.stopPropagation();
						}}
					/>
				) : (
					<span className="sidebar-folder-name">{folder.name}</span>
				)}
				<span className="sidebar-folder-rule" />
				<span className="sidebar-folder-count">{rows.length}</span>
				<IconChevronRight
					className="sidebar-folder-chevron"
					size={20}
					style={{ transform: open ? "rotate(90deg)" : "none" }}
				/>
			</button>
			{open && (
				<Reorder.Group
					as="div"
					axis="y"
					className={`sidebar-pin-list sidebar-folder-list${
						rowDragKey ? " is-drag-active" : ""
					}`}
					values={orderedRows.map((r) => r.key)}
					onReorder={(keys: string[]) => {
						rowOrderPending.current = keys;
						setRowOrderDraft(keys);
					}}
				>
					{orderedRows.map((row) => (
						<Reorder.Item
							as="div"
							key={row.key}
							value={row.key}
							dragListener={canDragRows}
							onDragStart={() => {
								setRowDragKey(row.key);
								onRowDragStart(row);
							}}
							onDrag={onRowDrag}
							onDragEnd={() => {
								setRowDragKey(null);
								rowJustDragged.current = true;
								setTimeout(() => {
									rowJustDragged.current = false;
								}, 0);
								const order = rowOrderPending.current;
								rowOrderPending.current = null;
								setRowOrderDraft(null);
								onRowDrop(row, order);
							}}
							whileDrag={{ scale: 1.01 }}
							className={`sidebar-pin-entry${
								rowDragKey === row.key ? " is-reordering" : ""
							}`}
							onClickCapture={(ev: React.MouseEvent) => {
								// Swallow the click that lands on the row right after a drop.
								if (rowJustDragged.current) {
									ev.preventDefault();
									ev.stopPropagation();
								}
							}}
						>
							{renderRow(row)}
						</Reorder.Item>
					))}
					{rows.length === 0 && (
						<div className="sidebar-folder-empty">
							{isPhone
								? "Empty — long-press a session to move it here"
								: "Empty — drag sessions here"}
						</div>
					)}
				</Reorder.Group>
			)}
		</Reorder.Item>
	);
}

function SidebarItem({
	session,
	selected,
	unread,
	mine,
	onClick,
	onArchive,
	pinned,
	onTogglePin,
	onRename,
}: {
	session: UnifiedSession;
	selected: boolean;
	/** New activity since this session was last opened — draws an iMessage-style
	    unread dot and bolds the title. */
	unread: boolean;
	/** The current user's own session — the owner name is redundant, so it's
	    dropped and the timestamp moves up onto the title line. */
	mine: boolean;
	onClick: () => void;
	onArchive: () => void;
	pinned: boolean;
	onTogglePin: () => void;
	onRename: (title: string) => void;
}) {
	const isPhone = useIsPhone();
	const running = session.isRunning;
	const waiting = !!session.waitingForInput || runNeedsAttention(session);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");

	// Hover card: after a short dwell, anchor a detail popover to this row's right
	// edge. Suppressed while renaming (the input owns the interaction).
	const btnRef = useRef<HTMLButtonElement>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);

	function openHover() {
		if (editing) return;
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = setTimeout(() => {
			const el = btnRef.current;
			if (el) setAnchor(el.getBoundingClientRect());
		}, 380);
	}
	function closeHover() {
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = null;
		setAnchor(null);
	}
	useEffect(
		() => () => {
			if (hoverTimer.current) clearTimeout(hoverTimer.current);
		},
		[],
	);

	// Mobile long-press → action sheet, and — importantly — the *tap* to open a
	// session is driven from `touchend`, not the synthesized `click`. `.sidebar-item`
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
	// In "My sessions" the owner is always the current user, so hide it.
	if (!mine && session.startedBy && !session.automation) {
		metaParts.push(<span key="u">{session.startedBy}</span>);
	}
	// No idle "time since" here — times only appear while a run is live (the
	// hovercard/details still carry last activity).
	if (session.prUrl) {
		metaParts.push(
			<span
				key="pr"
				className={
					session.prState === "MERGED"
						? "sidebar-meta-merged"
						: session.prState === "CLOSED"
							? "sidebar-meta-closed"
							: "sidebar-meta-pr"
				}
			>
				{session.prState === "MERGED"
					? "merged"
					: session.prState === "CLOSED"
						? "closed"
						: "PR open"}
			</span>,
		);
	}
	if (session.linearIssue) {
		metaParts.push(
			<span key="lin" className="sidebar-meta-linear">
				{session.linearIssue.identifier}
			</span>,
		);
	}

	const visibleSwipeOffset = isPhone ? swipeOffset : 0;

	return (
		<>
		<div
			className={`sidebar-swipe-row${
				swipeAction === "archive" || visibleSwipeOffset < 0
					? " is-open is-swipe-archive"
					: swipeAction === "star" || visibleSwipeOffset > 0
						? " is-open is-swipe-star"
						: ""
			}${dragging ? " is-dragging" : ""}`}
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
					className="sidebar-swipe-action sidebar-swipe-action--archive"
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
					className={`sidebar-swipe-action sidebar-swipe-action--star${pinned ? " is-on" : ""}`}
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
		<button
			ref={btnRef}
			className={`sidebar-item ${!mine ? "sidebar-item--twoline" : ""} ${selected ? "sidebar-item-selected" : ""} ${waiting ? "sidebar-item-waiting" : ""} ${unread ? "sidebar-item-unread" : ""}`}
			style={
				visibleSwipeOffset
					? ({ "--swipe-x": `${visibleSwipeOffset}px` } as React.CSSProperties)
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
			onMouseEnter={openHover}
			onMouseLeave={closeHover}
			onMouseDown={closeHover}
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
				// On touch this is the long-press callout: the action sheet
				// owns that gesture, so suppress the native text-selection
				// callout rather than stacking both.
				if (longPressed.current || pressOrigin.current) e.preventDefault();
			}}
		>
			<div className="sidebar-item-top">
				{/* Leading 22px slot — the same status-icon column the workspace rows
				    use, so a chat row's #number/title line up under them (and under the
				    lane header) instead of sitting flush-left when it carries no dot.
				    The live/unread dot rides centered in it; empty otherwise. */}
				<span
					className="flex shrink-0 items-center justify-center"
					style={{ width: 22 }}
				>
					{waiting || running ? (
						<span
							className={`sidebar-item-status ${
								waiting
									? "sidebar-status-waiting"
									: "sidebar-status-running"
							}`}
						/>
					) : unread ? (
						/* Unread dot — only when there's no live status dot already
						   drawing the eye (a running/waiting session isn't "unread" in
						   the same sense). */
						<span className="sidebar-item-status sidebar-status-unread" />
					) : null}
				</span>
				{editing ? (
					<input
						className="sidebar-item-rename"
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
						className="sidebar-item-title"
						onDoubleClick={(e) => {
							e.stopPropagation();
							setDraft(session.title);
							setEditing(true);
						}}
					>
						{stripPrTitlePrefix(session.title)}
					</span>
				)}
				{mine && !editing && metaParts.length > 0 && (
					<span className="sidebar-item-inline-meta">
						{metaParts.map((part, i) => (
							<React.Fragment key={i}>
								{i > 0 && <span className="sidebar-meta-sep">·</span>}
								{part}
							</React.Fragment>
						))}
					</span>
				)}
				{!editing && hasDraft(`chat:${session.id}`) && (
					<span className="sidebar-ws-draft" title="Unsent draft. Return to finish it.">
						<IconPencil size={20} />
					</span>
				)}
			</div>
			{!mine && (
				<div className="sidebar-item-meta pl-[28px]">
					{metaParts.map((part, i) => (
						<React.Fragment key={i}>
							{i > 0 && <span className="sidebar-meta-sep">·</span>}
							{part}
						</React.Fragment>
					))}
				</div>
			)}
			<Tooltip
				label="Archive session"
				shortcut={selected ? ARCHIVE_SHORTCUT_KEYS : undefined}
			>
				<span
					className="sidebar-item-x"
					role="button"
					aria-label="Archive session"
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
		</button>
		</div>
		{anchor && <SessionHoverCard session={session} anchor={anchor} />}
			{sheetOpen && (
				<MobileActionSheet
					session={session}
					onRename={() => {
						setDraft(session.title);
						setEditing(true);
					}}
					onArchive={onArchive}
					onClose={() => setSheetOpen(false)}
				/>
			)}
		</>
	);
}

// The bottom sheet raised by long-pressing a session row on touch. It gathers
// the per-session actions (rename, archive) into thumb-sized rows. Rendered in
// a portal over a dimmed, tap-to-dismiss backdrop.
function MobileActionSheet({
	session,
	onRename,
	onArchive,
	onClose,
}: {
	session: UnifiedSession;
	onRename: () => void;
	onArchive: () => void;
	onClose: () => void;
}) {
	// Lock the page behind the sheet so a scroll drags the list, not the page.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	return createPortal(
		<div className="mobile-action-sheet-backdrop" onClick={onClose}>
			<div
				className="mobile-action-sheet"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mobile-sheet-grip" />
				<div className="mobile-sheet-title">{session.title}</div>
				<button
					className="mobile-sheet-item"
					onClick={() => {
						onRename();
						onClose();
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
				</button>
				<div className="mobile-sheet-sep" />
				<button
					className="mobile-sheet-item mobile-sheet-item--danger"
					onClick={() => {
						onArchive();
						onClose();
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
				</button>
			</div>
		</div>,
		document.body,
	);
}

const CARD_W = 300;

// A detail popover shown after dwelling on a sidebar row. Content is
// state-dependent: the prominent status line and the rows that render depend on
// whether the session is waiting/running/merged/etc. and which of its optional
// facets (PR, Linear issue, goal, loop, extra repos) are populated. Everything
// comes off the already-loaded UnifiedSession — the card fetches nothing.
function SessionHoverCard({
	session: s,
	anchor,
}: {
	session: UnifiedSession;
	anchor: DOMRect;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
		left: anchor.right + 8,
		top: anchor.top,
	}));

	// Clamp into the viewport once we know the rendered height. Prefer the right
	// of the row; flip to the left if it would overflow the right edge.
	useEffect(() => {
		const el = cardRef.current;
		const h = el ? el.offsetHeight : 200;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = anchor.right + 8;
		if (left + CARD_W > vw - 8) left = anchor.left - CARD_W - 8;
		left = Math.max(8, left);
		const top = Math.min(Math.max(8, anchor.top), vh - h - 8);
		setPos({ left, top });
	}, [anchor]);

	const state = hoverState(s);
	const rows: Array<[string, React.ReactNode]> = [];

	const owner = s.automation || s.startedBy;
	if (owner) rows.push([s.automation ? "Automation" : "Started by", owner]);
	if (s.model) rows.push(["Model", s.model]);
	if (s.mode) rows.push(["Mode", s.mode]);

	const repoName = repoLabel(s.repo || "tella-fusion");
	const extra = s.attachedRepos?.length || 0;
	rows.push(["Repo", extra ? `${repoName} +${extra} more` : repoName]);
	if (s.branch)
		rows.push([
			"Branch",
			<span className="hovercard-mono">{s.branch}</span>,
		]);

	if (s.linearIssue)
		rows.push([
			"Linear",
			<span>
				<span className="hovercard-mono">{s.linearIssue.identifier}</span>{" "}
				{s.linearIssue.title}
			</span>,
		]);
	if (s.goal) rows.push(["Goal", "Autonomous goal session"]);
	if (s.loop)
		rows.push(["Loop", `Every ${s.loop.intervalMinutes} min`]);

	rows.push(["Last active", relativeTime(s.lastActivity)]);
	rows.push(["Created", relativeTime(s.createdAt)]);

	const card = (
		<div
			ref={cardRef}
			className="sidebar-hovercard"
			style={{ left: pos.left, top: pos.top, width: CARD_W }}
		>
			<div className="hovercard-head">
				<span
					className={`sidebar-item-status hovercard-dot ${state.dotClass}`}
				/>
				<span className="hovercard-branch">
					{s.branch || s.title}
				</span>
				{s.prAdditions != null && s.prDeletions != null && (
					<span className="hovercard-diff">
						<span className="hovercard-add">
							+{compactNum(s.prAdditions)}
						</span>{" "}
						<span className="hovercard-del">
							-{compactNum(s.prDeletions)}
						</span>
					</span>
				)}
			</div>

			<div className="hovercard-title">{s.title}</div>

			<div className={`hovercard-state hovercard-state-${state.tone}`}>
				{state.label}
			</div>

			{s.waitingForInput && (
				<div className="hovercard-callout">
					Blocked on a question — open the session to answer.
				</div>
			)}
			{!s.waitingForInput && runNeedsAttention(s) && (
				<div className="hovercard-callout">
					Run failed: {s.lastRunError!.message.slice(0, 200)}
				</div>
			)}
			{!s.waitingForInput && (s.queuedCount ?? 0) > 0 && (
				<div className="hovercard-callout">
					{s.queuedCount} prompt{s.queuedCount === 1 ? "" : "s"} queued.
				</div>
			)}

			<div className="hovercard-rows">
				{rows.map(([label, value], i) => (
					<div className="hovercard-row" key={i}>
						<span className="hovercard-label">{label}</span>
						<span className="hovercard-value">{value}</span>
					</div>
				))}
			</div>

			{s.prUrl && (
				<div className="hovercard-pr">
					<span className="hovercard-mono">
						{s.prNumber ? `#${s.prNumber}` : "PR"}
					</span>
					<span className={`hovercard-pr-state hovercard-pr-${prTone(s)}`}>
						{prStateLabel(s)}
					</span>
					{s.prReviewDecision && (
						<span className="hovercard-pr-review">
							{prettyReview(s.prReviewDecision)}
						</span>
					)}
					{s.prChecks && s.prChecks.total > 0 && (
						<span className="hovercard-checks">
							{s.prChecks.failed > 0
								? `${s.prChecks.failed} failing`
								: s.prChecks.pending > 0
									? `${s.prChecks.pending} pending`
									: "checks pass"}
						</span>
					)}
				</div>
			)}
		</div>
	);

	return createPortal(card, document.body);
}

// The single prominent status line + its dot/tone. Ordering mirrors how a person
// triages: a blocked question first, then live activity, then PR/lifecycle.
function hoverState(s: UnifiedSession): {
	label: string;
	tone: "accent" | "green" | "purple" | "yellow" | "dim";
	dotClass: string;
} {
	if (s.waitingForInput)
		return {
			label: "Waiting for your input",
			tone: "accent",
			dotClass: "sidebar-status-waiting",
		};
	if (runNeedsAttention(s))
		return {
			label: "Last run failed. Needs attention.",
			tone: "accent",
			dotClass: "sidebar-status-waiting",
		};
	if (s.isRunning)
		return {
			label: "Running",
			tone: "green",
			dotClass: "sidebar-status-running",
		};
	if (s.prState === "MERGED")
		return { label: "Merged", tone: "purple", dotClass: "hovercard-dot-purple" };
	if (s.prState === "CLOSED")
		return { label: "PR closed", tone: "dim", dotClass: "hovercard-dot-red" };
	if (s.prState === "OPEN")
		return {
			label: s.prIsDraft ? "Draft PR — in review" : "In review",
			tone: "green",
			dotClass: "hovercard-dot-green",
		};
	return { label: "Idle", tone: "dim", dotClass: "hovercard-dot-dim" };
}

function prStateLabel(s: UnifiedSession): string {
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "CLOSED") return "closed";
	return s.prIsDraft ? "draft" : "open";
}
function prTone(s: UnifiedSession): string {
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "CLOSED") return "closed";
	return "open";
}
function prettyReview(d: string): string {
	if (d === "APPROVED") return "approved";
	if (d === "CHANGES_REQUESTED") return "changes requested";
	if (d === "REVIEW_REQUIRED") return "review required";
	return d.toLowerCase().replace(/_/g, " ");
}
function compactNum(n: number): string {
	if (n >= 10000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

// ── Workspace hover card ────────────────────────────────────────────────────
// Structural subset of WsRow (declared inside Sidebar) that the card reads.
interface WsCardRow {
	key: string;
	workspace: Project | null;
	name: string;
	chats: UnifiedSession[];
	status: MineStatus;
	lastActivity: string;
	running: boolean;
}

// Leading status mark for a workspace, Conductor-style: the live dots
// (blocked question, running) keep their animated form, then the PR lifecycle
// gets an icon — open PR (green, faint while still a draft) or merged
// (purple). Backlog rows get nothing; quiet is the signal there. Shared by
// the sidebar row and the hover card head so they always read the same.
// Live "in progress" ticker: counts up from when the run started, in the
// in-progress color (yellow). Ticks once a second, isolated to this tiny node
// so the whole sidebar doesn't re-render every second. `startMs` is the earliest
// running chat's start (see runStartMs) — the workspace's been busy for that long.
function RunTicker({ startMs }: { startMs: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	return (
		<span className="sidebar-ws-ticker" title="How long this run has been working">
			{elapsedClock(startMs, now)}
		</span>
	);
}

// Workspaces adopted from a PR inherit names like "PR #3662: Rehome setup
// controls" — in the sidebar the PR icon already carries that identity, so the
// row shows just the human title. Display-only: the tooltip, rename field and
// hovercard keep the full name (and the PR number lives there + in the PR tab).
function stripPrTitlePrefix(name: string): string {
	return name.replace(/^PR\s*#\d+(:|\s*[—–-])\s*/i, "");
}

function WsStatusMark({
	row,
	size = 20,
	placeholder = false,
}: {
	row: { status: MineStatus; running: boolean; chats: UnifiedSession[] };
	size?: number;
	/** When a row carries no status icon (Backlog/pending), still occupy the
	    icon-width slot so its title lines up with the iconned rows and the lane
	    header above — a left indent, Conductor-style, instead of flush-left. */
	placeholder?: boolean;
}) {
	// Every mark rides in the same `size`-wide (20px) flex slot so #number/title
	// line up at one x whichever mark the row carries. It also gives the icons a
	// real CSS box: an SVG sized only by its width/height *attributes* collapses
	// to a 0 flex-basis in iOS Safari and paints on top of the title — the slot's
	// inline-styled span dodges that (the dots were always immune for this reason).
	const slot = (child: React.ReactNode) => (
		<span
			className="flex shrink-0 items-center justify-center"
			style={{ width: size, height: size }}
		>
			{child}
		</span>
	);
	const dot = (cls: string) => slot(<span className={`sidebar-item-status ${cls}`} />);
	if (row.status === "needsinput") return dot("sidebar-status-waiting");
	if (row.running) return dot("sidebar-status-running");
	if (row.status === "review") {
		const open = row.chats.filter((c) => c.prState === "OPEN");
		const allDraft = open.length > 0 && open.every((c) => c.prIsDraft);
		return slot(
			<IconPullRequest
				size={size}
				className={allDraft ? "text-faint" : "text-green"}
			/>,
		);
	}
	if (row.status === "merged")
		return slot(<IconGitMerge size={size} className="text-purple" />);
	return placeholder ? slot(null) : null;
}

// Footer action button base — the color variant carries the status meaning
// (green = ready to merge, purple = merged/archive, accent = needs an answer).
const WS_ACTION =
	"flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium no-underline";

// Overview (description + thumbnails) for a workspace row. Same cache (and
// key) as the right panel's WorkspaceInfo block, so a workspace that's been
// opened paints instantly and vice versa. Shared by the hover card (desktop)
// and the long-press sheet (mobile).
function useWsOverview(row: WsCardRow): WorkspaceOverview | null {
	const cacheKey =
		row.workspace?.id || `chats:${row.chats.map((c) => c.id).join(",")}`;
	const activityKey = row.lastActivity || row.chats.map((c) => c.lastActivity).join(",");
	const [ov, setOv] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	useEffect(() => {
		let alive = true;
		const cached = overviewCache.get(cacheKey);
		setOv(cached?.data ?? null);
		if (row.chats.length === 0) return;
		const activityAt = activityKey ? new Date(activityKey).getTime() : 0;
		if (
			cached &&
			Date.now() - cached.at < 30_000 &&
			(!activityAt || cached.at >= activityAt)
		)
			return;
		loadOverview(
			cacheKey,
			row.workspace?.id ?? null,
			row.chats.map((c) => ({
				id: c.id,
				title: c.title,
				createdAt: c.createdAt,
				lastActivity: c.lastActivity,
			})),
		)
			.then((d) => {
				if (alive) setOv(d);
			})
			.catch(() => {
				// The view just stays without a description/thumbnails.
			});
		return () => {
			alive = false;
		};
	}, [cacheKey, activityKey]);
	return ov;
}

// The PR that fronts the workspace (the newest chat that has one) and how to
// present it: "basically ready to be merged" (open, not draft, checks green,
// no changes requested) turns the main action green; the status bits spell
// out draft/merged/closed, the review decision, and a checks summary.
function wsPrInfo(row: WsCardRow) {
	const newestFirst = [...row.chats].sort((a, b) =>
		(b.lastActivity || "").localeCompare(a.lastActivity || ""),
	);
	const prChat = newestFirst.find((c) => c.prUrl);
	const branch = prChat?.branch || newestFirst.find((c) => c.branch)?.branch;
	const prReady =
		!!prChat &&
		prChat.prState === "OPEN" &&
		!prChat.prIsDraft &&
		prChat.prReviewDecision !== "CHANGES_REQUESTED" &&
		(!prChat.prChecks ||
			prChat.prChecks.total === 0 ||
			(prChat.prChecks.failed === 0 && prChat.prChecks.pending === 0));
	const prStatusBits = prChat
		? [
				prChat.prState === "OPEN" && prChat.prIsDraft ? "draft" : null,
				prChat.prState === "MERGED" ? "merged" : null,
				prChat.prState === "CLOSED" ? "closed" : null,
				prChat.prReviewDecision
					? prettyReview(prChat.prReviewDecision)
					: null,
				prChat.prChecks && prChat.prChecks.total > 0
					? prChat.prChecks.failed > 0
						? `${prChat.prChecks.failed} failing`
						: prChat.prChecks.pending > 0
							? `${prChat.prChecks.pending} pending`
							: "checks pass"
					: null,
			].filter((b): b is string => !!b)
		: [];
	return { prChat, branch, prReady, prStatusBits };
}

// The info half of the workspace card: branch + diff + status mark, title,
// blocked-question callout, latest-message description, media thumbnails.
// Rendered inside the hover card (desktop) and the long-press sheet (mobile).
function WsOverviewInfo({
	row,
	ov,
}: {
	row: WsCardRow;
	ov: WorkspaceOverview | null;
}) {
	const { prChat, branch } = wsPrInfo(row);
	const meta = MINE_STATUS_META.find((m) => m.key === row.status);
	const desc = (ov?.lastMessage?.content || ov?.prompt?.content || "")
		.replace(/\s+/g, " ")
		.trim();
	const media = ov?.media || [];
	return (
		<>
			<div className="hovercard-head">
				<span className="hovercard-branch">
					{branch || row.chats[0]?.repo || "tella-fusion"}
				</span>
				{prChat?.prAdditions != null && prChat?.prDeletions != null && (
					<span className="hovercard-diff">
						<span className="hovercard-add">
							+{compactNum(prChat.prAdditions)}
						</span>{" "}
						<span className="hovercard-del">
							-{compactNum(prChat.prDeletions)}
						</span>
					</span>
				)}
				<span className="flex shrink-0 items-center" title={meta?.label}>
					<WsStatusMark row={row} size={22} />
				</span>
			</div>

			<div className="hovercard-title">{row.name}</div>

			{row.status === "needsinput" &&
				(row.chats.some((c) => c.waitingForInput) ? (
					<div className="hovercard-callout">
						Blocked on a question — open to answer.
					</div>
				) : (
					<div className="hovercard-callout">
						Run failed:{" "}
						{row.chats
							.find((c) => runNeedsAttention(c))
							?.lastRunError?.message.slice(0, 200) || "needs attention"}
					</div>
				))}

			{desc && (
				<div className="selectable mt-1 text-xs leading-snug text-dim line-clamp-2">
					{desc}
				</div>
			)}

			{media.length > 0 && (
				<div className="mt-2 flex gap-1.5">
					{media.slice(0, 4).map((m, i) => (
						<button
							key={`${m.sessionId}:${m.at}:${i}`}
							type="button"
							onClick={() => openLightbox(media, i)}
							className="relative block h-[58px] w-[62px] shrink-0 overflow-hidden rounded-sm border border-line bg-surface p-0"
							title={[m.chatTitle, new Date(m.at).toLocaleString()]
								.filter(Boolean)
								.join(" · ")}
						>
							{m.kind === "image" ? (
								<img
									src={m.src}
									alt=""
									loading="lazy"
									className="h-full w-full object-cover"
								/>
							) : (
								<>
									<video
										src={m.src}
										muted
										playsInline
										preload="metadata"
										className="h-full w-full object-cover"
									/>
									<span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white drop-shadow">
										▶
									</span>
								</>
							)}
							{i === 3 && media.length > 4 && (
								<span className="absolute inset-0 grid place-items-center bg-black/55 text-xs font-semibold text-white">
									+{media.length - 4}
								</span>
							)}
						</button>
					))}
				</div>
			)}
		</>
	);
}

// The workspace counterpart of SessionHoverCard: branch + diff stats + status
// at a glance, the latest assistant message as a "where things stand" line,
// screenshot thumbnails from the workspace's chats, and quick actions
// (Archive, PR link). Interactive — the parent keeps it open while the
// pointer is over it (onEnter/onLeave), unlike the info-only session card.
function WsHoverCard({
	row,
	anchor,
	onEnter,
	onLeave,
	onArchive,
	onOpen,
}: {
	row: WsCardRow;
	anchor: DOMRect;
	onEnter: () => void;
	onLeave: () => void;
	onArchive: () => void;
	/** Open a chat (the "Answer" action jumps to the blocked one). */
	onOpen: (chat: UnifiedSession) => void;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
		left: anchor.right + 8,
		top: anchor.top,
	}));

	const ov = useWsOverview(row);

	// Clamp into the viewport once the rendered height is known; re-clamp when
	// the overview lands (description/thumbnails change the height). Prefer the
	// right of the row; flip to the left if it would overflow the right edge.
	useEffect(() => {
		const el = cardRef.current;
		const h = el ? el.offsetHeight : 200;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = anchor.right + 8;
		if (left + CARD_W > vw - 8) left = anchor.left - CARD_W - 8;
		left = Math.max(8, left);
		const top = Math.min(Math.max(8, anchor.top), vh - h - 8);
		setPos({ left, top });
	}, [anchor, ov]);

	const { prChat, prReady, prStatusBits } = wsPrInfo(row);

	const card = (
		<div
			ref={cardRef}
			className="sidebar-hovercard pointer-events-auto"
			style={{ left: pos.left, top: pos.top, width: CARD_W }}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
		>
			<WsOverviewInfo row={row} ov={ov} />

			<div className="mt-2.5 flex min-w-0 items-center gap-2 border-t border-line pt-2">
				{/* The single main action, colored by what the workspace needs next:
				    answer the blocked question (accent), merge the ready PR (green),
				    review the not-ready PR (neutral), or archive merged work (purple). */}
				{row.status === "needsinput" && row.chats.length > 0 ? (
					<button
						className={`${WS_ACTION} bg-accent text-white hover:opacity-90`}
						onClick={() =>
							onOpen(
								row.chats.find((c) => c.waitingForInput) ||
									row.chats.find((c) => runNeedsAttention(c)) ||
									row.chats[0],
							)
						}
					>
						{row.chats.some((c) => c.waitingForInput) ? "Answer" : "Open"}
					</button>
				) : row.status === "merged" ? (
					<button
						className={`${WS_ACTION} bg-purple text-white hover:opacity-90`}
						onClick={onArchive}
					>
						<svg
							width="15"
							height="15"
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
					</button>
				) : row.status === "review" && prChat?.prUrl ? (
					<a
						href={prChat.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className={
							prReady
								? `${WS_ACTION} bg-green text-white hover:opacity-90`
								: `${WS_ACTION} border border-line bg-surface text-dim hover:bg-hover hover:text-fg`
						}
					>
						{prReady ? "Merge" : "Review"} ↗
					</a>
				) : null}
				{prChat?.prUrl && (
					<a
						href={prChat.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className={`hovercard-mono shrink-0 text-xs hover:underline hovercard-pr-${prTone(prChat)}`}
					>
						{prChat.prNumber ? `#${prChat.prNumber}` : "PR"} ↗
					</a>
				)}
				{prStatusBits.length > 0 && (
					<span className="min-w-0 truncate text-[11px] text-faint">
						{prStatusBits.join(" · ")}
					</span>
				)}
				<span
					className="ml-auto shrink-0 text-[11px] text-faint"
					title={new Date(row.lastActivity).toLocaleString()}
				>
					{relativeTime(row.lastActivity)}
				</span>
			</div>
		</div>
	);

	return createPortal(card, document.body);
}

// The touch counterpart of WsHoverCard: long-pressing a workspace row raises
// a bottom sheet with the same overview block (branch + diff + status, title,
// latest message, thumbnails) followed by thumb-sized action rows — the
// status-colored main action first (answer / merge / review / archive), then
// the workspace chores that live behind right-click on desktop (pin, rename,
// color, archive, delete). Replaces the old long-press → context-menu path.
function WsMobileSheet({
	row,
	pinned,
	onTogglePin,
	onClose,
	onArchive,
	onSetStatus,
	onOpen,
	onRename,
	onMarkUnread,
	onCopyLink,
	onDelete,
}: {
	row: WsCardRow;
	pinned: boolean;
	onTogglePin: () => void;
	onClose: () => void;
	onArchive: () => void;
	/** Pin the workspace into a lane, or clear back to derived with `null`. */
	onSetStatus: (status: MineStatus | null) => void;
	onOpen: (chat: UnifiedSession) => void;
	onRename: () => void;
	/** Mark every chat in the row unread; null for chatless rows. */
	onMarkUnread: (() => void) | null;
	/** Copy a link to the row's first chat; null for chatless rows. */
	onCopyLink: (() => void) | null;
	onDelete: (() => void) | null;
}) {
	const ov = useWsOverview(row);
	const { prChat, prReady, prStatusBits } = wsPrInfo(row);
	// Lock the page behind the sheet so a scroll drags the list, not the page.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	const closing = (fn: () => void) => () => {
		fn();
		onClose();
	};
	const archiveGlyph = (
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
	);
	return createPortal(
		<div className="mobile-action-sheet-backdrop" onClick={onClose}>
			<div
				className="mobile-action-sheet"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mobile-sheet-grip" />
				<div className="px-2 pb-2.5 pt-1">
					<WsOverviewInfo row={row} ov={ov} />
					{(prStatusBits.length > 0 || row.lastActivity) && (
						<div className="mt-2 flex min-w-0 items-center gap-2 text-[11px] text-faint">
							{prChat?.prNumber != null && (
								<span
									className={`hovercard-mono shrink-0 hovercard-pr-${prTone(prChat)}`}
								>
									#{prChat.prNumber}
								</span>
							)}
							{prStatusBits.length > 0 && (
								<span className="min-w-0 truncate">
									{prStatusBits.join(" · ")}
								</span>
							)}
							{row.lastActivity && (
								<span className="ml-auto shrink-0">
									{relativeTime(row.lastActivity)}
								</span>
							)}
						</div>
					)}
				</div>
				<div className="mobile-sheet-sep" />
				{/* Main action, colored by what the workspace needs next. */}
				{row.status === "needsinput" && row.chats.length > 0 && (
					<button
						className="mobile-sheet-item"
						style={{ color: "var(--accent)", fontWeight: 600 }}
						onClick={closing(() =>
							onOpen(
								row.chats.find((c) => c.waitingForInput) ||
									row.chats.find((c) => runNeedsAttention(c)) ||
									row.chats[0],
							),
						)}
					>
						<WsStatusMark row={row} size={22} />
						{row.chats.some((c) => c.waitingForInput)
							? "Answer question"
							: "Check failed run"}
					</button>
				)}
				{row.status === "review" && prChat?.prUrl && (
					<button
						className="mobile-sheet-item"
						style={
							prReady ? { color: "var(--green)", fontWeight: 600 } : undefined
						}
						onClick={closing(() =>
							window.open(prChat.prUrl, "_blank", "noopener"),
						)}
					>
						<IconPullRequest size={22} />
						{prReady ? `Merge on ${providerFromUrl(prChat.prUrl).name}` : "Review PR"}
						{prChat.prNumber != null && ` #${prChat.prNumber}`}
					</button>
				)}
				{row.status === "merged" && row.chats.length > 0 && (
					<button
						className="mobile-sheet-item"
						style={{ color: "var(--purple)", fontWeight: 600 }}
						onClick={closing(onArchive)}
					>
						{archiveGlyph}
						Archive workspace
					</button>
				)}
				{prChat?.prUrl && row.status !== "review" && (
					<button
						className="mobile-sheet-item"
						onClick={closing(() =>
							window.open(prChat.prUrl, "_blank", "noopener"),
						)}
					>
						<IconPullRequest size={22} />
						Open PR{prChat.prNumber != null ? ` #${prChat.prNumber}` : ""}
					</button>
				)}
				{onMarkUnread && (
					<button
						className="mobile-sheet-item"
						onClick={closing(onMarkUnread)}
					>
						<IconMail size={22} />
						Mark as unread
					</button>
				)}
				<button className="mobile-sheet-item" onClick={closing(onTogglePin)}>
					<IconPin size={22} fill={pinned ? "currentColor" : "none"} />
					{pinned ? "Unpin" : "Pin"}
				</button>
				<button className="mobile-sheet-item" onClick={closing(onRename)}>
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
				</button>
				{onCopyLink && (
					<button className="mobile-sheet-item" onClick={closing(onCopyLink)}>
						<IconLink size={22} />
						Copy link
					</button>
				)}
				{/* Pin the workspace into a lane manually — tap a chip to move it there
				    (tap the active one, or Auto, to release it back to the derived lane). */}
				{row.chats.length > 0 &&
					(() => {
						const anyManual = row.chats.some((c) => c.manualStatus);
						const sharedManual =
							anyManual &&
							row.chats.every(
								(c) => c.manualStatus === row.chats[0].manualStatus,
							)
								? (row.chats[0].manualStatus ?? null)
								: null;
						return (
							<div className="px-4 py-2">
								<div className="mb-1.5 text-[11px] font-semibold text-faint">
									Move to lane
								</div>
								<div className="flex flex-wrap gap-1.5">
									{MINE_STATUS_META.map((m) => {
										const on = sharedManual === m.key;
										return (
											<button
												key={m.key}
												type="button"
												className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px]"
												style={{
													borderColor: on ? m.dotColor : "var(--border)",
													color: on ? "var(--text)" : "var(--text-dim)",
													background: on
														? "color-mix(in srgb, var(--bg-panel), transparent)"
														: "transparent",
												}}
												onClick={closing(() =>
													onSetStatus(on ? null : m.key),
												)}
											>
												<span
													style={{
														width: 8,
														height: 8,
														borderRadius: "50%",
														background: m.dotColor,
														flexShrink: 0,
													}}
												/>
												{m.label}
											</button>
										);
									})}
									<button
										type="button"
										className="rounded-md border px-2 py-1 text-[13px]"
										style={{
											borderColor: !anyManual
												? "var(--text-dim)"
												: "var(--border)",
											color: !anyManual ? "var(--text)" : "var(--text-dim)",
										}}
										onClick={closing(() => onSetStatus(null))}
									>
										Auto
									</button>
								</div>
							</div>
						);
					})()}
				{((row.status !== "merged" && row.chats.length > 0) || onDelete) && (
					<div className="mobile-sheet-sep" />
				)}
				{/* Archiving stays reachable pre-merge from the explicit menu — the
				    status coloring only governs which action gets top billing. */}
				{row.status !== "merged" && row.chats.length > 0 && (
					<button
						className="mobile-sheet-item mobile-sheet-item--danger"
						onClick={closing(onArchive)}
					>
						{archiveGlyph}
						Archive
					</button>
				)}
				{onDelete && (
					<button
						className="mobile-sheet-item mobile-sheet-item--danger"
						onClick={closing(onDelete)}
					>
						<svg
							width="20"
							height="20"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
						>
							<path d="M3 4.5h10M6.5 4.5V3.25a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1V4.5M4.25 4.5l.6 8.25a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.25" />
						</svg>
						Delete workspace
					</button>
				)}
			</div>
		</div>,
		document.body,
	);
}
