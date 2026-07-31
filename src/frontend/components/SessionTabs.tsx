import React, { useEffect, useRef, useState } from "react";
import { motion, Reorder } from "motion/react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";
import { hasDraft, onDraftsChanged } from "../lib/drafts";
import { relativeTime } from "../lib/api";
import { Menu, ContextMenu } from "../ui/menu";
import { chatPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { copySessionTranscript } from "../lib/transcript-copy";
import { IconHistory, IconPencil, IconPlus, IconRestore } from "./icons";
import { useIsPhone } from "../hooks/useIsPhone";

/**
 * The tab strip is scoped to ONE Workspace: it shows the sibling chats of the
 * currently-open chat (every session sharing its `projectId`/workspace). It
 * only renders once a workspace has TWO or more chats — a lone chat needs no
 * strip, so the "+ New tab" affordance moves next to the session title in
 * SessionViewer's header instead (and ⌘T does the same thing). A pre-migration
 * standalone chat (empty list) likewise renders nothing.
 *
 * There is no pinning here anymore (pinning moved to the sidebar). Right-click
 * opens a context menu (rename / copy concise or full transcript / copy link /
 * tab color / close); double-click the title also renames the chat. The +
 * button starts a new chat in this workspace sharing its worktree;
 * right-clicking + offers the other modes (stacked worktree / ask).
 */
/** A non-chat pane (Review, …) surfaced after the chat tabs in the strip. */
export type ViewTab = {
	/** Stable id, e.g. `review:<sessionId>`. */
	id: string;
	/** Tab label ("Review"). Also the tooltip/aria label when `icon` is set. */
	label: string;
	/** Whether this pane is the foregrounded tab. */
	active: boolean;
	/** Optional status-dot class (e.g. PR state) shown before the label. */
	dotClass?: string | null;
	/**
	 * Optional glyph shown INSTEAD of the text label — the tab reads as just the
	 * icon (e.g. Staging → a globe). `label` still supplies the tooltip/aria.
	 */
	icon?: React.ReactNode;
};

interface Props {
	/** Sibling chats in the current workspace, in display order. */
	tabs: UnifiedSession[];
	/** Archived (closed) chats of this workspace, newest activity first. */
	archived: UnifiedSession[];
	/** Session id of the active tab. */
	activeId: string | null;
	/** Map of session id → swatch key for colored tabs. */
	colors: Record<string, string>;
	onSelect: (session: UnifiedSession) => void;
	onSetColor: (key: string, color: string | null) => void;
	/**
	 * Commit a new left-to-right order for the chat tabs (desktop drag-drop).
	 * Receives the reordered session ids; the parent persists it per-workspace.
	 */
	onReorderTabs: (orderedIds: string[]) => void;
	/**
	 * Render even when this bar holds a single tab. A split shows one bar per
	 * pane, and each keeps its "+" however few tabs it has.
	 */
	alwaysShow?: boolean;
	/** Show the archived-chats menu — only the rightmost bar does. */
	showHistory?: boolean;
	/** Dragging below the strip previews a left/right split over the content. */
	onSplitDrag?: (id: string | null, point?: { x: number; y: number }) => void;
	/** Return true when the drop created a split instead of committing a reorder. */
	onSplitDrop?: (id: string, point: { x: number; y: number }) => boolean;
	/**
	 * Non-chat "view" tabs (Review, Preview, …) shown after the chat tabs.
	 * Each is bound to a session; selecting one foregrounds that
	 * pane, its × dismisses it. Generalized so more panes (diff, terminal, …)
	 * can drop in later.
	 */
	viewTabs: ViewTab[];
	/** Foreground a view tab (show its pane). */
	onSelectView: (id: string) => void;
	/** Dismiss a view tab from the strip. */
	onCloseView: (id: string) => void;
	/**
	 * Start a new chat in this workspace. share = reuse the workspace worktree
	 * (the + button's plain-click default), stack = new worktree branched off it,
	 * ask = no worktree.
	 */
	onNewChat: (mode: "share" | "stack" | "ask") => void;
	/** Rename a chat (double-click the title); empty title resets it. */
	onRename: (id: string, title: string) => void;
	/** Close (archive) a chat — the × revealed on hover. */
	onClose: (session: UnifiedSession) => void;
	/** Un-archive a chat from the history menu, back into the strip. */
	onRestore: (session: UnifiedSession) => void;
	/** Report a copy action's outcome ("Link copied", …). */
	onToast: (message: string) => void;
}

type NewMenu = { x: number; y: number };
type TabMember =
	| { kind: "chat"; id: string; session: UnifiedSession }
	| { kind: "view"; id: string; view: ViewTab };

const TAB_CLASS =
	"session-tab inline-flex max-w-[200px] shrink-0 items-center gap-1.5 rounded-md border border-transparent bg-panel px-2.5 py-1.5 text-supporting text-dim shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-[background,color] hover:bg-hover hover:text-fg min-[721px]:h-11 min-[721px]:rounded-none min-[721px]:border-0 min-[721px]:bg-transparent min-[721px]:shadow-[inset_0_-2px_0_transparent]";
const ACTIVE_TAB_CLASS =
	"session-tab-active bg-[color-mix(in_srgb,var(--bg-active)_94%,var(--text))] text-fg min-[721px]:bg-transparent min-[721px]:shadow-[inset_0_-3px_0_var(--accent)]";
const TAB_CLOSE_CLASS =
	"session-tab-close inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 font-sans text-[15px] leading-none text-dim hover:bg-pressed hover:text-fg max-[720px]:size-[26px] max-[720px]:-my-0.5 max-[720px]:-mr-1 max-[720px]:opacity-100";

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Right-aligned keyboard-shortcut hint on a menu row. */
function MenuHint({ label }: { label: string }) {
	return <span className="shrink-0 pl-4 text-label text-faint">{label}</span>;
}

export function SessionTabs({
	tabs,
	archived,
	activeId,
	colors,
	onSelect,
	onSetColor,
	onReorderTabs,
	alwaysShow,
	showHistory = true,
	onSplitDrag,
	onSplitDrop,
	viewTabs,
	onSelectView,
	onCloseView,
	onNewChat,
	onRename,
	onClose,
	onRestore,
	onToast,
}: Props) {
	const [newMenu, setNewMenu] = useState<NewMenu | null>(null);
	const [editKey, setEditKey] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	// Re-render when a composer draft appears/disappears — tabs check hasDraft()
	// during render to show the unsent-draft pencil on sibling chats.
	const [, setDraftsRev] = useState(0);
	useEffect(() => onDraftsChanged(() => setDraftsRev((v) => v + 1)), []);
	// On phones the +/history controls ride INSIDE the scroll (see below) so the
	// tab strip claims the full width instead of losing it to pinned chrome; on
	// desktop they stay pinned after the last tab. Icons run a touch bigger on
	// touch for an easier hit.
	const isPhone = useIsPhone();
	const ctrlIconSize = isPhone ? 25 : 22;

	// Drag-to-reorder the chat tabs (desktop only — an x-drag would fight touch
	// scrolling / the phone swipe gestures). `orderDraft` holds the in-flight
	// order during a drag so the strip stays smooth; it's cleared on drop once
	// the parent's reordered `tabs` come back. `justDragged` swallows the click
	// that fires synchronously after a drop so it doesn't select the tab.
	const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
	const orderDraftRef = useRef<string[] | null>(null);
	const justDragged = useRef(false);
	const dragPoint = useRef<{ x: number; y: number } | null>(null);
	const stopPointerTracking = useRef<(() => void) | null>(null);
	const canDragTabs = !isPhone && tabs.length + viewTabs.length > 1;

	// Where the dragged tab will land. Desktop tabs are flat text on the strip's
	// own background, so a dragged one has no surface to separate it from the
	// labels it passes — it lifts into a chip (`is-dragging`) and this ghost
	// marks the gap it left behind. Reorder already opens that gap live; the
	// ghost just makes an otherwise invisible hole readable.
	const [dropSlot, setDropSlot] = useState<{
		key: string;
		left: number;
		width: number;
	} | null>(null);
	const groupRef = useRef<HTMLDivElement | null>(null);
	// Unit widths + inter-tab gap, measured once at drag start: they can't change
	// mid-drag, so the slot's x is arithmetic from the live key order rather than
	// a re-measure of siblings that are still spring-animating into place.
	const dragMetrics = useRef<{
		widths: Map<string, number>;
		gap: number;
		key: string;
	} | null>(null);

	/** Position the ghost at `key`'s slot in the given left-to-right unit order. */
	function placeDropSlot(keys: string[]) {
		const metrics = dragMetrics.current;
		if (!metrics) return;
		const index = keys.indexOf(metrics.key);
		if (index < 0) return setDropSlot(null);
		let left = 0;
		for (let i = 0; i < index; i++) left += (metrics.widths.get(keys[i]) ?? 0) + metrics.gap;
		setDropSlot({ key: metrics.key, left, width: metrics.widths.get(metrics.key) ?? 0 });
	}

	function beginDrag(key: string) {
		const group = groupRef.current;
		if (!group) return;
		// offsetWidth/offsetLeft (layout box) rather than rects: whileDrag's scale
		// is already applied to the dragged item and would inflate its width.
		const items = [...group.children].filter(
			(el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.tabKey,
		);
		const widths = new Map(items.map((el) => [el.dataset.tabKey!, el.offsetWidth] as const));
		const gap =
			items.length > 1
				? Math.max(0, items[1].offsetLeft - (items[0].offsetLeft + items[0].offsetWidth))
				: 0;
		dragMetrics.current = { widths, gap, key };
		placeDropSlot(items.map((el) => el.dataset.tabKey!));
	}

	function endDrag() {
		dragMetrics.current = null;
		setDropSlot(null);
	}

	function trackPointer(
		id: string,
		event: React.PointerEvent,
		dropOnPointerUp = false,
	) {
		stopPointerTracking.current?.();
		const start = { x: event.clientX, y: event.clientY };
		let moved = false;
		dragPoint.current = start;
		const move = (pointer: PointerEvent) => {
			dragPoint.current = { x: pointer.clientX, y: pointer.clientY };
			moved ||= Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) > 5;
			onSplitDrag?.(id, dragPoint.current);
		};
		const finish = (allowDrop: boolean) => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			stopPointerTracking.current = null;
			onSplitDrag?.(null);
			if (dropOnPointerUp) {
				const point = dragPoint.current;
				dragPoint.current = null;
				if (allowDrop && moved && point && onSplitDrop?.(id, point)) {
					justDragged.current = true;
					setTimeout(() => (justDragged.current = false), 0);
				}
			}
		};
		const up = () => finish(true);
		const cancel = () => finish(false);
		stopPointerTracking.current = cancel;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
	}

	useEffect(() => () => stopPointerTracking.current?.(), []);

	// Render order: the in-flight drag draft when dragging, else the parent's
	// (already persisted) order. Any tab absent from the draft is appended so a
	// mid-drag arrival is never dropped.
	const orderedTabs: UnifiedSession[] = React.useMemo(() => {
		if (!orderDraft) return tabs;
		const byId = new Map(tabs.map((s) => [s.id, s] as const));
		const out: UnifiedSession[] = [];
		for (const id of orderDraft) {
			const s = byId.get(id);
			if (s) out.push(s);
		}
		for (const s of tabs) if (!orderDraft.includes(s.id)) out.push(s);
		return out;
	}, [tabs, orderDraft]);
	const activeTopId = activeId ?? viewTabs.find((tab) => tab.active)?.id ?? null;

	// With enough tabs the strip overflows and scrolls, so the tab that just
	// became active can sit outside the visible window — opening a Review pane
	// would foreground a tab you can't see. Nudge it just inside the edge (not
	// centered) so its neighbours stay as context. Keyed on the selection only:
	// re-running as sibling tabs come and go would yank the strip back while
	// someone is scrolled away reading it.
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const box = scrollRef.current;
		if (!box || !activeTopId) return;
		const tab = box.querySelector<HTMLElement>('[aria-selected="true"]');
		if (!tab) return;
		const view = box.getBoundingClientRect();
		const rect = tab.getBoundingClientRect();
		// Clear the edge fade so the tab doesn't come to rest under it.
		const pad = 28;
		const shortLeft = rect.left - (view.left + pad);
		const shortRight = rect.right - (view.right - pad);
		const by = shortLeft < 0 ? shortLeft : shortRight > 0 ? shortRight : 0;
		if (!by) return;
		box.scrollBy({
			left: by,
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}, [activeTopId]);

	// Flag whether the strip actually has anywhere to scroll, which gates its
	// edge fades. Those are driven by a CSS scroll timeline, and a timeline that
	// goes INACTIVE (closing a tab, widening the pane until everything fits)
	// holds its last value instead of reverting — without this gate a strip that
	// no longer scrolls keeps a stale fade dimming its first tab. Written
	// straight to the DOM rather than through state: it's presentation only, and
	// re-rendering the strip on every step of a pane drag would be wasteful.
	useEffect(() => {
		const box = scrollRef.current;
		if (!box) return;
		const sync = () =>
			box.toggleAttribute("data-overflow", box.scrollWidth - box.clientWidth > 1);
		// The box catches pane resizes; its children catch the content growing
		// (a tab added, or a title that got longer).
		const observer = new ResizeObserver(sync);
		observer.observe(box);
		for (const child of box.children) observer.observe(child);
		sync();
		return () => observer.disconnect();
	}, [tabs.length, viewTabs.length]);
	// One unit per chat tab. Units are a holdover from the combined split tab
	// (a pair used to share one unit); the drag code keys off `unit.key`, so the
	// shape stays even though every unit now holds exactly one member.
	const tabUnits = React.useMemo(
		() => ({
			units: orderedTabs.map((session) => ({
				key: session.id,
				members: [{ kind: "chat", id: session.id, session } as TabMember],
			})),
		}),
		[orderedTabs],
	);

	// Drop: hand the new order to the parent (which persists it and feeds it back
	// as the next `tabs`), swallow the trailing click, then release the draft.
	function commitReorder() {
		justDragged.current = true;
		setTimeout(() => {
			justDragged.current = false;
		}, 0);
		const order = orderDraftRef.current;
		orderDraftRef.current = null;
		setOrderDraft(null);
		endDrag();
		if (order) onReorderTabs(order);
	}

	function reorderUnits(keys: string[]) {
		const byKey = new Map(tabUnits.units.map((unit) => [unit.key, unit] as const));
		const units = keys
			.map((key) => byKey.get(key))
			.filter((unit): unit is (typeof tabUnits.units)[number] => !!unit);
		const order = units.flatMap((unit) =>
			unit.members.flatMap((member) =>
				member.kind === "chat" ? [member.session.id] : [],
			),
		);
		orderDraftRef.current = order;
		setOrderDraft(order);
		placeDropSlot(units.map((unit) => unit.key));
	}

	function selectMember(member: TabMember) {
		if (member.kind === "chat") onSelect(member.session);
		else onSelectView(member.view.id);
	}

	function closeMember(member: TabMember) {
		if (member.kind === "chat") onClose(member.session);
		else onCloseView(member.view.id);
	}

	function commitRename() {
		if (editKey !== null) onRename(editKey, draft.trim());
		setEditKey(null);
	}

	useEffect(() => {
		if (!newMenu) return;
		const close = () => setNewMenu(null);
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [newMenu]);

	// One chat and no view tabs → no strip. The lone workspace's "+ New tab"
	// button lives next to the session title in the header instead. But once a
	// non-chat pane (Review) is open, the strip appears so it has somewhere to
	// live — a lone code chat then reads as [chat][Review].
	if (!alwaysShow && tabs.length <= 1 && viewTabs.length === 0) return null;

	// New-tab "+" — plain-click shares the workspace worktree; right-click offers
	// the stacked/ask modes.
	const newTabButton = (
		<button
			type="button"
			className={`${TAB_CLASS} session-tab-new justify-center bg-transparent px-2 py-1.5 text-[15px] shadow-none hover:bg-hover min-[721px]:self-center min-[721px]:px-[5px] min-[721px]:py-[3px] min-[721px]:text-[22px]`}
			aria-label="New chat in this workspace"
			title="New chat. Shares this workspace's worktree (right-click for options)"
			onClick={() => onNewChat("share")}
			onContextMenu={(e) => {
				e.preventDefault();
				setNewMenu({ x: e.clientX, y: e.clientY });
			}}
		>
			<IconPlus size={ctrlIconSize} />
		</button>
	);

	// History: every archived (closed) chat of this workspace, in one list.
	// Clicking a row opens the chat read-only-ish (it gets a tab while viewed);
	// the ⟲ restores it into the strip for good.
	const historyMenu = showHistory && archived.length > 0 && (
		<Menu.Root>
			<Menu.Trigger className={`${TAB_CLASS} session-tab-history bg-transparent px-2.5 py-[7px] shadow-none hover:bg-hover min-[721px]:self-center`} aria-label="Archived chats" title="Archived chats">
				<IconHistory size={ctrlIconSize} />
			</Menu.Trigger>
			<Menu.Popup align="end" sideOffset={4} className="min-w-[240px] max-w-[320px]">
				{archived.map((s) => (
					<Menu.Item key={s.id} onClick={() => onSelect(s)}>
						<span className="min-w-0 flex-1 truncate">{s.title}</span>
						<span className="shrink-0 text-meta text-faint">{relativeTime(s.lastActivity)}</span>
						<button
							type="button"
							className="flex shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent p-0.5 text-dim hover:text-fg"
							aria-label="Restore chat"
							title="Restore to tabs"
							onClick={(e) => {
								e.stopPropagation();
								onRestore(s);
							}}
						>
							<IconRestore size={20} />
						</button>
					</Menu.Item>
				))}
			</Menu.Popup>
		</Menu.Root>
	);

	return (
		<div className="session-tabs flex min-w-0 shrink-0 items-center gap-[3px] bg-[linear-gradient(to_bottom,var(--topbar-bg),var(--bg))] px-2 py-1.5 min-[721px]:-mt-px min-[721px]:h-11 min-[721px]:items-stretch min-[721px]:bg-bg min-[721px]:p-0 min-[721px]:shadow-[inset_0_1px_0_var(--border),inset_0_-1px_0_var(--border)] max-[720px]:absolute max-[720px]:left-0 max-[720px]:right-0 max-[720px]:top-[var(--pane-header-h)] max-[720px]:z-[6] max-[720px]:border-b max-[720px]:border-line max-[720px]:bg-bg max-[720px]:shadow-[0_6px_12px_-8px_rgba(0,0,0,0.22)]" role="tablist">
			<div className="session-tabs-scroll flex min-w-0 flex-1 items-center gap-[3px] overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden min-[721px]:flex-[0_1_auto] min-[721px]:items-stretch" ref={scrollRef}>
				<Reorder.Group
					as="div"
					axis="x"
					ref={groupRef}
					className="session-tabs-chatgroup inline-flex min-w-0 items-center gap-[3px] min-[721px]:self-stretch min-[721px]:items-stretch"
					values={tabUnits.units.map((unit) => unit.key)}
					onReorder={reorderUnits}
				>
					{/* First child so the tabs sliding over it paint on top. */}
					{dropSlot && (
						<div
							className="session-tab-drop-slot"
							style={{ left: dropSlot.left, width: dropSlot.width }}
							aria-hidden="true"
						/>
					)}
					{tabUnits.units.map((unit) => {
						const member = unit.members[0];
						if (member.kind !== "chat") return null;
						const session = member.session;
						const key = session.id;
						const waiting = !!session.waitingForInput;
						const hex = colorHex(colors[key]);
						return (
							<Reorder.Item
								as="div"
								key={key}
								value={key}
								data-tab-key={key}
								dragListener={canDragTabs && editKey !== key}
								onPointerDown={(event) => {
									if (canDragTabs && editKey !== key) trackPointer(key, event);
								}}
								onDragStart={() => beginDrag(key)}
								onDragEnd={() => {
									onSplitDrag?.(null);
									const point = dragPoint.current;
									dragPoint.current = null;
									if (point && onSplitDrop?.(key, point)) {
										orderDraftRef.current = null;
										setOrderDraft(null);
										endDrag();
										justDragged.current = true;
										setTimeout(() => (justDragged.current = false), 0);
										return;
									}
									commitReorder();
								}}
								whileDrag={{ scale: 1.02, zIndex: 3 }}
								onClickCapture={(e) => {
									if (justDragged.current) {
										e.stopPropagation();
										e.preventDefault();
									}
								}}
								className={`session-tab-reorder relative inline-flex shrink-0 items-center min-[721px]:self-stretch min-[721px]:items-stretch ${dropSlot?.key === key ? "is-dragging" : ""}`}
							>
								<ContextMenu.Root>
									<ContextMenu.Trigger
										render={
											<div
												role="tab"
												aria-selected={key === activeId}
											className={`${TAB_CLASS} ${key === activeId ? ACTIVE_TAB_CLASS : ""} ${
													waiting ? "session-tab-waiting" : ""
												} ${hex ? "session-tab-colored" : ""}`}
												style={hex ? ({ "--tab-color": hex } as React.CSSProperties) : undefined}
												onClick={() => onSelect(session)}
												title={session.title}
											/>
										}
									>
										{waiting ? (
											<span className="session-tab-dot session-tab-dot-waiting" />
										) : (
											session.isRunning && <span className="session-tab-dot" />
										)}
										{editKey === key ? (
											<input
												className="session-tab-rename max-w-[150px] rounded-xs border border-accent bg-bg px-[3px] py-0 text-inherit outline-none"
												value={draft}
												autoFocus
												onChange={(e) => setDraft(e.target.value)}
												onClick={(e) => e.stopPropagation()}
												onDoubleClick={(e) => e.stopPropagation()}
												onBlur={commitRename}
												onKeyDown={(e) => {
													if (e.key === "Enter") commitRename();
													else if (e.key === "Escape") setEditKey(null);
													e.stopPropagation();
												}}
											/>
										) : (
											<span
											className="session-tab-title max-w-[150px] truncate"
												onDoubleClick={(e) => {
													e.stopPropagation();
													setDraft(session.title);
													setEditKey(key);
												}}
											>
												{session.title}
											</span>
										)}
										{/* Unsent draft in a sibling chat (the active tab's draft is
							    already on screen in the composer — no pencil needed). */}
										{key !== activeId && hasDraft(`chat:${key}`) && (
											<span className="session-tab-draft" title="Unsent draft">
												<IconPencil size={20} />
											</span>
										)}
										<button
											type="button"
										className={TAB_CLOSE_CLASS}
											aria-label="Close chat"
											title="Close chat"
											onClick={(e) => {
												e.stopPropagation();
												onClose(session);
											}}
										>
											×
										</button>
									</ContextMenu.Trigger>
									{/* finalFocus=false: "Rename chat" mounts the inline rename
							    input (autoFocus) — the closing menu must not steal focus
							    back to the tab. */}
									<ContextMenu.Popup className="min-w-[250px]" finalFocus={false}>
										<ContextMenu.Item
											onClick={() => {
												setDraft(session.title);
												setEditKey(key);
											}}
										>
											<span className="grow">Rename chat</span>
										</ContextMenu.Item>
										<ContextMenu.Separator />
										<ContextMenu.Item onClick={() => void copySessionTranscript(session, "concise", onToast)}>
											<span className="grow">Copy concise transcript</span>
											{key === activeId && <MenuHint label={isApple ? "⌘ ⌥ C" : "Ctrl+Alt+C"} />}
										</ContextMenu.Item>
										<ContextMenu.Item onClick={() => void copySessionTranscript(session, "full", onToast)}>
											<span className="grow">Copy full transcript</span>
										</ContextMenu.Item>
										<ContextMenu.Item
											onClick={() => copyToClipboard(absoluteLink(chatPath(session)), () => onToast("Link copied"))}
										>
											<span className="grow">Copy link</span>
										</ContextMenu.Item>
										<ContextMenu.Separator />
										{/* Tab color. A swatch click bubbles to the Item, which
								    closes the menu — the Item itself does nothing. */}
										<ContextMenu.Item className="data-[highlighted]:bg-transparent">
											{TAB_COLORS.map((c) => (
												<button
													key={c.key}
													type="button"
													className={`tab-color-swatch ${colors[key] === c.key ? "tab-color-swatch-on" : ""}`}
													style={{ background: c.hex }}
													aria-label={c.label}
													title={c.label}
													onClick={() => onSetColor(key, c.key)}
												/>
											))}
											<button
												type="button"
												className="tab-color-swatch tab-color-swatch-none"
												aria-label="No color"
												title="No color"
												onClick={() => onSetColor(key, null)}
											/>
										</ContextMenu.Item>
										<ContextMenu.Separator />
										<ContextMenu.Item onClick={() => onClose(session)}>
											<span className="grow">Close tab</span>
											{key === activeId && <MenuHint label={isApple ? "⌘ W" : "Ctrl+W"} />}
										</ContextMenu.Item>
									</ContextMenu.Popup>
								</ContextMenu.Root>
							</Reorder.Item>
						);
					})}
				</Reorder.Group>
				{/* Non-chat panes (Review, …) ride at the END of the strip: the main
				    chat leads, sibling chats follow, panes close the row. */}
				{viewTabs.map((v) => (
					<motion.div
						key={v.id}
						role="tab"
						aria-selected={v.active}
						aria-label={v.icon ? v.label : undefined}
						className={`${TAB_CLASS} session-tab-view ${v.icon ? "session-tab-view-icon" : ""} ${v.active ? ACTIVE_TAB_CLASS : ""}`}
						drag={!isPhone}
						dragMomentum={false}
						dragSnapToOrigin
						dragElastic={0.08}
						onPointerDown={(event) => {
							if (!isPhone) trackPointer(v.id, event, true);
						}}
						onClickCapture={(event) => {
							if (justDragged.current) {
								event.stopPropagation();
								event.preventDefault();
							}
						}}
						onClick={() => onSelectView(v.id)}
						title={v.label}
					>
						{v.dotClass && <span className={`panel-tab-dot ${v.dotClass}`} />}
						{v.icon ? (
							<span className="session-tab-vicon" aria-hidden="true">
								{v.icon}
							</span>
						) : (
							<span className="session-tab-title">{v.label}</span>
						)}
						<button
							type="button"
							className={TAB_CLOSE_CLASS}
							aria-label={`Close ${v.label}`}
							title={`Close ${v.label}`}
							onClick={(e) => {
								e.stopPropagation();
								onCloseView(v.id);
							}}
						>
							×
						</button>
					</motion.div>
				))}
				{/* Phone: the +/history controls scroll WITH the tabs so the strip
					    uses the full width — nothing pinned eating horizontal room. */}
				{isPhone && newTabButton}
				{isPhone && historyMenu}
			</div>
			{/* Desktop: the "+" sits OUTSIDE the scroll so it's pinned and always
				    visible — never scrolled off when the tabs overflow a narrow pane. */}
			{!isPhone && newTabButton}
			{!isPhone && <div className="session-tabs-actions ml-auto flex shrink-0 items-center gap-[3px]">{historyMenu}</div>}

			{newMenu && (
				<div
					className="tab-color-menu session-tab-new-menu fixed z-[1000] flex gap-2 rounded-xl border border-line-strong bg-panel px-2.5 py-[9px] shadow-[0_10px_30px_rgba(0,0,0,0.32)]"
					style={{ left: newMenu.x, top: newMenu.y }}
					onClick={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						className="session-tab-new-menu-item rounded-sm px-2 py-1 text-control-label text-dim hover:bg-hover hover:text-fg"
						onClick={() => {
							setNewMenu(null);
							onNewChat("share");
						}}
					>
						New chat — share worktree
					</button>
					<button
						type="button"
						className="session-tab-new-menu-item rounded-sm px-2 py-1 text-control-label text-dim hover:bg-hover hover:text-fg"
						onClick={() => {
							setNewMenu(null);
							onNewChat("stack");
						}}
					>
						New chat — stacked worktree
					</button>
					<button
						type="button"
						className="session-tab-new-menu-item rounded-sm px-2 py-1 text-control-label text-dim hover:bg-hover hover:text-fg"
						onClick={() => {
							setNewMenu(null);
							onNewChat("ask");
						}}
					>
						New chat — ask (no worktree)
					</button>
				</div>
			)}
		</div>
	);
}
