import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { SessionSearch } from "./components/SessionSearch";
import { Home } from "./components/Home";
import { Automations } from "./components/Automations";
import { Goals } from "./components/Goals";
import { Actions } from "./components/Actions";
import { Notes, type NotesSelection } from "./components/Notes";
import { Connections } from "./components/Connections";
import { Archived } from "./components/Archived";
import { Reviews } from "./components/Reviews";
import { UserPicker, UserGate, getCurrentUser } from "./components/UserPicker";
import { SettingsMenu } from "./components/SettingsMenu";
import { SessionTabs, tabKey, type TabItem } from "./components/SessionTabs";
import { RestartOverlay } from "./components/RestartOverlay";
import { UpdateToast } from "./components/UpdateToast";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import { useSidebarSwipe } from "./hooks/useSidebarSwipe";
import {
	archiveSessionApi,
	renameSessionApi,
	fetchNotes,
	type NoteMeta,
} from "./lib/api";
import { pushRecent } from "./lib/recents";
import { getPins, togglePin, reorderPins, onPinsChanged } from "./lib/pins";
import {
	getTabColors,
	setTabColor,
	onTabColorsChanged,
} from "./lib/tab-colors";
import type { UnifiedSession } from "./lib/types";
import "./styles/global.css";

type Route =
	| { view: "home" }
	| { view: "new"; prompt?: string }
	| { view: "session"; id: string }
	| { view: "reviews"; id?: string }
	| { view: "automations" }
	| { view: "goals" }
	| { view: "actions" }
	| { view: "notes"; sel: NotesSelection }
	| { view: "connections" }
	| { view: "archived" };

function parseRoute(pathname: string): Route {
	const sessionMatch = pathname.match(/^\/backstage\/session\/(.+)$/);
	if (sessionMatch)
		return { view: "session", id: decodeURIComponent(sessionMatch[1]) };
	if (pathname === "/backstage/new") return { view: "new" };
	if (pathname === "/backstage/automations") return { view: "automations" };
	if (pathname === "/backstage/goals") return { view: "goals" };
	if (pathname === "/backstage/actions") return { view: "actions" };
	if (pathname === "/backstage/connections") return { view: "connections" };
	if (pathname === "/backstage/archived") return { view: "archived" };
	const reviewsMatch = pathname.match(/^\/backstage\/reviews(?:\/(.+))?$/);
	if (reviewsMatch)
		return {
			view: "reviews",
			id: reviewsMatch[1] ? decodeURIComponent(reviewsMatch[1]) : undefined,
		};
	const noteMatch = pathname.match(/^\/backstage\/notes(?:\/(.+))?$/);
	if (noteMatch)
		return {
			view: "notes",
			sel: noteMatch[1]
				? { kind: "note", id: decodeURIComponent(noteMatch[1]) }
				: null,
		};
	const docMatch = pathname.match(/^\/backstage\/docs\/(.+)$/);
	if (docMatch)
		return {
			view: "notes",
			sel: { kind: "doc", path: decodeURIComponent(docMatch[1]) },
		};
	// Back-compat: the old read-only Wiki lived at /backstage/wiki/<path>.
	const wikiMatch = pathname.match(/^\/backstage\/wiki(?:\/(.+))?$/);
	if (wikiMatch)
		return {
			view: "notes",
			sel: wikiMatch[1]
				? { kind: "doc", path: decodeURIComponent(wikiMatch[1]) }
				: null,
		};
	return { view: "home" };
}

function routePath(route: Route): string {
	switch (route.view) {
		case "session":
			return `/backstage/session/${encodeURIComponent(route.id)}`;
		case "new":
			return route.prompt
				? `/backstage/new?prompt=${encodeURIComponent(route.prompt)}`
				: "/backstage/new";
		case "automations":
			return "/backstage/automations";
		case "goals":
			return "/backstage/goals";
		case "actions":
			return "/backstage/actions";
		case "connections":
			return "/backstage/connections";
		case "archived":
			return "/backstage/archived";
		case "reviews":
			return route.id
				? `/backstage/reviews/${encodeURIComponent(route.id)}`
				: "/backstage/reviews";
		case "notes":
			if (route.sel?.kind === "note")
				return `/backstage/notes/${encodeURIComponent(route.sel.id)}`;
			if (route.sel?.kind === "doc")
				return `/backstage/docs/${route.sel.path.split("/").map(encodeURIComponent).join("/")}`;
			return "/backstage/notes";
		default:
			return "/backstage/";
	}
}

function App() {
	const { sessions, loading, refresh } = useSessions();
	const { connected, send, addHandler } = useWebSocket();
	// iOS evicts standalone PWAs from memory and relaunches them at the manifest
	// start_url (/backstage/) — losing the session you had open. On a cold load
	// that lands on home, restore the last session so it isn't dropped. This only
	// runs on a fresh document load (never on in-app navigation, which uses
	// pushState), so tapping the logo to go home still works.
	const [route, setRoute] = useState<Route>(() => {
		const parsed = parseRoute(location.pathname);
		if (parsed.view === "home") {
			const lastId = localStorage.getItem("michael-last-session");
			if (lastId) {
				const restored: Route = { view: "session", id: lastId };
				history.replaceState(null, "", routePath(restored));
				return restored;
			}
		}
		return parsed;
	});
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const sidebarRef = useRef<HTMLDivElement | null>(null);
	// The top bar above the tab strip. The session viewer portals its header
	// (session name + actions, incl. the workspace-panel toggle) into this slot so
	// the layout reads name-on-top / tabs-below; other views render a plain title.
	const [topbarEl, setTopbarEl] = useState<HTMLDivElement | null>(null);
	// Right-column slot (sibling of the left sidebar). The session viewer portals
	// its workspace/sub-agent panel here so it opens as a full-height column from
	// the very top, at the same level as the left sidebar (Conductor-style).
	const [rightPanelEl, setRightPanelEl] = useState<HTMLDivElement | null>(null);
	// Desktop sidebar width (px), drag-resizable and persisted per browser. The
	// mobile drawer keeps its own fixed width (CSS media query wins there), so
	// this only takes effect on the static desktop column.
	const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
		const v = Number(localStorage.getItem("michael-sidebar-w"));
		return v >= 200 && v <= 480 ? v : 252;
	});
	const sidebarWidthRef = useRef(sidebarWidth);
	sidebarWidthRef.current = sidebarWidth;
	function startSidebarResize(e: React.MouseEvent) {
		e.preventDefault();
		document.body.classList.add("resizing-x");
		const onMove = (ev: MouseEvent) => {
			// The sidebar is the leftmost element, so the pointer's x is its width.
			const w = Math.min(480, Math.max(200, ev.clientX));
			sidebarWidthRef.current = w;
			setSidebarWidth(w);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-x");
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			localStorage.setItem(
				"michael-sidebar-w",
				String(Math.round(sidebarWidthRef.current)),
			);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}
	// A session we've just navigated to that may not be in the polled list yet
	// (create → navigate races the async refresh, and the file is only written
	// once the run's `init` lands). While pending, the detail pane shows
	// "Loading…" instead of flashing "Session not found".
	const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
	const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const [pins, setPins] = useState<string[]>(getPins);
	const [tabColors, setTabColors] =
		useState<Record<string, string>>(getTabColors);
	// Shared notes list — resolves note-tab titles and the Notes view sidebar.
	const [notes, setNotes] = useState<NoteMeta[]>([]);
	const refreshNotes = React.useCallback(() => {
		fetchNotes()
			.then(setNotes)
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshNotes();
		const onFocus = () => refreshNotes();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshNotes]);

	// Subscribe to the per-user pin/color stores. Both hydrate async at module
	// load, and on a fast localhost that load() can resolve (and emit) before
	// this effect ever subscribes — so re-sync once here, or the initial empty
	// state sticks and pinned tabs vanish until the next change event.
	useEffect(() => {
		const unsub = onPinsChanged(() => setPins(getPins()));
		setPins(getPins());
		return unsub;
	}, []);
	useEffect(() => {
		const unsub = onTabColorsChanged(() => setTabColors(getTabColors()));
		setTabColors(getTabColors());
		return unsub;
	}, []);

	useSidebarSwipe({
		open: sidebarOpen,
		setOpen: setSidebarOpen,
		panelRef: sidebarRef,
	});

	function navigate(route: Route) {
		history.pushState(null, "", routePath(route));
		setRoute(route);
		setSidebarOpen(false);
	}

	// The "new session" ⌘K palette. It's an overlay driven by its own state (not a
	// route), so it can open over any view; the /backstage/new route still opens it
	// so old links keep working.
	const [palette, setPalette] = useState<{ open: boolean; prompt?: string }>(() =>
		route.view === "new" ? { open: true, prompt: route.prompt } : { open: false },
	);
	const paletteOpenRef = useRef(palette.open);
	paletteOpenRef.current = palette.open;
	const openPalette = React.useCallback((prompt?: string) => {
		setPalette({ open: true, prompt });
		setSidebarOpen(false);
	}, []);

	// The ⌘K session-search command palette. Like the new-session palette it's an
	// overlay driven by its own state so it can open over any view.
	const [searchOpen, setSearchOpen] = useState(false);
	const searchOpenRef = useRef(searchOpen);
	searchOpenRef.current = searchOpen;
	const closePalette = React.useCallback(() => {
		setPalette({ open: false });
		// A deep link left the URL on /backstage/new — return home on close.
		if (location.pathname === "/backstage/new")
			navigate({ view: "home" });
	}, []);

	useEffect(() => {
		const onPop = () => setRoute(parseRoute(location.pathname));
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// ⌘K toggles the session-search palette; ⌘N the new-session palette. Esc
	// closes whichever is open (search's own input also handles Esc, but this
	// covers the case where focus has left it).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const k = e.key.toLowerCase();
			if ((e.metaKey || e.ctrlKey) && k === "k") {
				e.preventDefault();
				setSearchOpen((o) => !o);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && k === "n") {
				e.preventDefault();
				paletteOpenRef.current ? closePalette() : openPalette();
				return;
			}
			if (e.key === "Escape") {
				if (searchOpenRef.current) setSearchOpen(false);
				else if (paletteOpenRef.current) closePalette();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openPalette, closePalette]);

	// Remember the last session so a cold relaunch can restore it (see above);
	// clear it when the user deliberately goes home so we don't force them back in.
	// Also feed the sidebar's "Recently opened" list.
	useEffect(() => {
		if (route.view === "session") {
			localStorage.setItem("michael-last-session", route.id);
			pushRecent(route.id);
		} else if (route.view === "home") {
			localStorage.removeItem("michael-last-session");
		}
	}, [route]);

	// Tear down the launch splash (rendered in index.html) once the app has mounted.
	useEffect(() => {
		const splash = document.getElementById("splash");
		if (!splash) return;
		splash.classList.add("splash-hide");
		const t = setTimeout(() => splash.remove(), 400);
		return () => clearTimeout(t);
	}, []);

	// When a session is created from the New Session form or Ask box, jump straight into it
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "session_created") {
				// Mark it pending so the viewer shows "Loading…" until the poll catches
				// up; a fallback timeout clears it so a failed create can't stick.
				setPendingSessionId(msg.id);
				clearTimeout(pendingTimer.current);
				pendingTimer.current = setTimeout(
					() => setPendingSessionId(null),
					30000,
				);
				refresh();
				navigate({ view: "session", id: msg.id });
			}
		});
	}, [addHandler, refresh]);

	// Clear the pending flag once the session shows up in the polled list.
	useEffect(() => {
		if (
			pendingSessionId &&
			sessions.some(
				(s) =>
					s.id === pendingSessionId || s.aliasIds?.includes(pendingSessionId),
			)
		) {
			setPendingSessionId(null);
			clearTimeout(pendingTimer.current);
		}
	}, [sessions, pendingSessionId]);

	const currentSession: UnifiedSession | null =
		route.view === "session"
			? sessions.find(
					(s) => s.id === route.id || s.aliasIds?.includes(route.id),
				) || null
			: null;

	const currentNoteId =
		route.view === "notes" && route.sel?.kind === "note" ? route.sel.id : null;

	// Pinned tabs (sessions and notes) above the title, pin order preserved. Each
	// pin entry is either a bare session id or `note:<id>`.
	const pinnedTabs: TabItem[] = pins
		.map((entry): TabItem | null => {
			if (entry.startsWith("note:")) {
				const id = entry.slice(5);
				const note = notes.find((n) => n.id === id);
				return note ? { kind: "note", id, title: note.title } : null;
			}
			const s = sessions.find(
				(x) => x.id === entry || x.aliasIds?.includes(entry),
			);
			return s ? { kind: "session", session: s } : null;
		})
		.filter((t): t is TabItem => t !== null);

	// The currently-open session/note also gets a transient tab even when unpinned
	// (Chrome-style): it closes the moment you navigate away; the ☆ promotes it.
	const pinnedKeys = new Set(pinnedTabs.map(tabKey));
	const activeKey = currentSession
		? currentSession.id
		: currentNoteId
			? `note:${currentNoteId}`
			: null;
	let tabs = pinnedTabs;
	if (activeKey && !pinnedKeys.has(activeKey)) {
		if (currentSession)
			tabs = [...pinnedTabs, { kind: "session", session: currentSession }];
		else if (currentNoteId) {
			const note = notes.find((n) => n.id === currentNoteId);
			tabs = [
				...pinnedTabs,
				{
					kind: "note",
					id: currentNoteId,
					title: note?.title || currentNoteId,
				},
			];
		}
	}

	// Plain title shown in the top bar for non-session views (session routes let
	// the SessionViewer portal its own header in instead). Home stays blank so the
	// bar collapses (`.detail-topbar:empty`).
	const topbarTitle: string =
		route.view === "reviews"
			? "Reviews"
			: route.view === "automations"
				? "Automations"
				: route.view === "goals"
					? "Goals"
					: route.view === "actions"
						? "Actions"
						: route.view === "connections"
							? "Connections"
							: route.view === "archived"
								? "Archived"
								: route.view === "notes"
									? "Notes"
									: route.view === "new"
										? "New session"
										: "";

	const activeView =
		route.view === "automations" ||
		route.view === "goals" ||
		route.view === "actions" ||
		route.view === "notes" ||
		route.view === "connections" ||
		route.view === "reviews"
			? route.view === "notes"
				? "wiki"
				: route.view
			: ("sessions" as const);

	// Brand (Michael + settings chevron) and the connection/user controls. Shared
	// between the mobile top bar and the desktop sidebar's brand row, so they read
	// identically in both layouts.
	const brand = (
		<div className="app-brand">
			<a
				className="app-title"
				href="/backstage/"
				onClick={(e) => {
					e.preventDefault();
					navigate({ view: "home" });
				}}
			>
				<span className="app-logo">M</span>
				<span className="app-title-text">Michael</span>
			</a>
			<SettingsMenu />
		</div>
	);
	const userControls = (
		<div className="app-header-right">
			<span
				className={`connection-dot ${connected ? "connected" : "disconnected"}`}
			/>
			<UserPicker />
		</div>
	);

	return (
		<UserGate>
			<RestartOverlay connected={connected} addHandler={addHandler} />
			<UpdateToast addHandler={addHandler} />
			<div className="app">
				{/* Mobile-only top bar: the hamburger to open the drawer, brand + user.
				    On desktop the brand/user move into the sidebar (below) and this is
				    hidden. */}
				<header className="app-header">
					<div className="app-header-left">
						<button
							className="hamburger"
							onClick={() => setSidebarOpen(!sidebarOpen)}
							aria-label="Toggle sidebar"
						>
							<span />
							<span />
							<span />
						</button>
						{brand}
					</div>
					{userControls}
				</header>

				<div className="app-body">
					{/* Overlay to close sidebar on mobile */}
					{sidebarOpen && (
						<div
							className="sidebar-overlay"
							onClick={() => setSidebarOpen(false)}
						/>
					)}

					<div
						ref={sidebarRef}
						className={`sidebar-container ${sidebarOpen ? "sidebar-open" : ""}`}
						style={
							{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties
						}
					>
						{/* Desktop brand row: Michael left, user right (hidden on mobile,
						    where the top bar carries these instead). */}
						<div className="sidebar-brand">
							{brand}
							{userControls}
						</div>
						<Sidebar
							sessions={sessions}
							selectedId={currentSession?.id || null}
							activeView={activeView}
							onNavigate={(view) =>
								navigate(
									view === "sessions"
										? { view: "home" }
										: view === "wiki"
											? { view: "notes", sel: null }
											: { view },
								)
							}
							onSelect={(s) => navigate({ view: "session", id: s.id })}
							onNewSession={() => openPalette()}
							onNewProject={() => openPalette()}
							onOpenArchived={() => navigate({ view: "archived" })}
							onArchive={async (s) => {
								try {
									await archiveSessionApi(s.id, true);
								} catch (e) {
									console.error("Archive failed:", e);
								}
								refresh();
							}}
							onRename={async (s, title) => {
								try {
									await renameSessionApi(s.id, title);
								} catch (e) {
									console.error("Rename failed:", e);
								}
								refresh();
							}}
						/>
						{/* Drag the right edge to resize (desktop only; hidden on mobile). */}
						<div
							className="sidebar-resize"
							onMouseDown={startSidebarResize}
							aria-hidden="true"
						/>
					</div>

					<main className="detail-pane">
						{/* Top bar: session name + actions (portaled in by SessionViewer)
						    on session routes, a plain title otherwise. Sits above the tab
						    strip so the session identity reads first, tabs below it. */}
						<div className="detail-topbar" ref={setTopbarEl}>
							{route.view !== "session" && topbarTitle && (
								<span className="detail-topbar-title">{topbarTitle}</span>
							)}
						</div>
						<SessionTabs
							tabs={tabs}
							activeKey={activeKey}
							pinnedKeys={pinnedKeys}
							colors={tabColors}
							onSelect={(tab) =>
								navigate(
									tab.kind === "session"
										? { view: "session", id: tab.session.id }
										: { view: "notes", sel: { kind: "note", id: tab.id } },
								)
							}
							onTogglePin={(key) => setPins(togglePin(key))}
							onSetColor={(key, color) => setTabColors(setTabColor(key, color))}
							onNewSession={() => openPalette()}
							onReorder={(keys) => setPins(reorderPins(keys))}
							onRename={async (key, title) => {
								try {
									await renameSessionApi(key, title);
								} catch (e) {
									console.error("Rename failed:", e);
								}
								refresh();
							}}
						/>
						{route.view === "automations" ? (
							<Automations
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "goals" ? (
							<Goals
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "actions" ? (
							<Actions
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "connections" ? (
							<Connections />
						) : route.view === "reviews" ? (
							<Reviews
								sessions={sessions}
								selectedId={route.id ?? null}
								onSelect={(id) => navigate({ view: "reviews", id })}
								onOpenSession={(id) => navigate({ view: "session", id })}
								user={getCurrentUser()}
								addHandler={addHandler}
								onRefresh={refresh}
								send={send}
							/>
						) : route.view === "archived" ? (
							<Archived
								sessions={sessions}
								onSelect={(s) => navigate({ view: "session", id: s.id })}
								onChanged={refresh}
							/>
						) : route.view === "notes" ? (
							<Notes
								sel={route.sel}
								notes={notes}
								refreshNotes={refreshNotes}
								pinnedNoteIds={
									new Set(
										pins
											.filter((p) => p.startsWith("note:"))
											.map((p) => p.slice(5)),
									)
								}
								onTogglePinNote={(id) => setPins(togglePin(`note:${id}`))}
								onSelectNote={(id) =>
									navigate({ view: "notes", sel: { kind: "note", id } })
								}
								onSelectDoc={(path) =>
									navigate({
										view: "notes",
										sel: path ? { kind: "doc", path } : null,
									})
								}
								sessions={sessions.map((s) => ({ id: s.id, title: s.title }))}
								onOpenSession={(id) => navigate({ view: "session", id })}
								user={getCurrentUser()}
								connected={connected}
								send={send}
								addHandler={addHandler}
							/>
						) : route.view === "session" ? (
							currentSession ? (
								<SessionViewer
									key={currentSession.id}
									session={currentSession}
									onBack={() => navigate({ view: "home" })}
									send={send}
									addHandler={addHandler}
									connected={connected}
									topbarEl={topbarEl}
									rightPanelEl={rightPanelEl}
								/>
							) : (
								<div className="detail-empty">
									<div className="detail-empty-inner">
										{(() => {
											const isLoading =
												loading || route.id === pendingSessionId;
											return (
												<>
													<div className="detail-empty-title">
														{isLoading
															? "Loading session…"
															: "Session not found"}
													</div>
													<div className="detail-empty-sub">
														{isLoading ? "" : "It may have been deleted."}
													</div>
												</>
											);
										})()}
									</div>
								</div>
							)
						) : (
							<Home
								sessions={sessions}
								loading={loading}
								connected={connected}
								send={send}
								onSelect={(s) => navigate({ view: "session", id: s.id })}
								onNewSession={(prompt) => openPalette(prompt)}
							/>
						)}
					</main>

					{/* Full-height right column beside the detail pane. The active
					    session's workspace/sub-agent panel portals in here. */}
					<div className="right-panel-slot" ref={setRightPanelEl} />
				</div>

				{/* ⌘K session-search palette — overlays every view. */}
				{searchOpen && (
					<SessionSearch
						sessions={sessions}
						onSelect={(id) => {
							setSearchOpen(false);
							navigate({ view: "session", id });
						}}
						onClose={() => setSearchOpen(false)}
					/>
				)}

				{/* ⌘N new-session palette — overlays every view. */}
				{palette.open && (
					<NewSession
						onBack={closePalette}
						send={send}
						addHandler={addHandler}
						connected={connected}
						prefillPrompt={palette.prompt}
					/>
				)}
			</div>
		</UserGate>
	);
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
