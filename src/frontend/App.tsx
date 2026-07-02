import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { SessionSearch } from "./components/SessionSearch";
import { Home } from "./components/Home";
import { Automations } from "./components/Automations";
import { Security } from "./components/Security";
import { Goals } from "./components/Goals";
import { Actions } from "./components/Actions";
import { Notes, type NotesSelection } from "./components/Notes";
import { Archived } from "./components/Archived";
import { Reviews } from "./components/Reviews";
import { UserGate, getCurrentUser } from "./components/UserPicker";
import { SettingsMenu } from "./components/SettingsMenu";
import { Settings } from "./components/Settings";
import { SessionTabs } from "./components/SessionTabs";
import { RestartOverlay } from "./components/RestartOverlay";
import { UpdateToast } from "./components/UpdateToast";
import { ImageLightbox } from "./components/ImageLightbox";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import { useBackSwipe } from "./hooks/useBackSwipe";
import { useInputAlerts } from "./hooks/useInputAlerts";
import { initAlerts } from "./lib/notify";
import {
	archiveSessionApi,
	deleteSessionApi,
	renameSessionApi,
	fetchNotes,
	fetchProjects,
	updateProjectApi,
	deleteProjectApi,
	setSessionProjectApi,
	newChatApi,
	type NoteMeta,
} from "./lib/api";
import type { Project } from "./lib/types";
import { pushRecent } from "./lib/recents";
import { markRead } from "./lib/reads";
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
	| { view: "security" }
	| { view: "goals" }
	| { view: "actions" }
	| { view: "notes"; sel: NotesSelection }
	| { view: "settings" }
	| { view: "archived" };

function parseRoute(pathname: string): Route {
	// Canonical chat URL: /backstage/workspace/<wsId>/chat/<chatId>. The chat id
	// alone identifies the session; the workspace segment makes the hierarchy
	// shareable/readable. Old /backstage/session/<id> links keep working and get
	// canonicalized once the session (and its workspace) is known.
	const wsChatMatch = pathname.match(
		/^\/backstage\/workspace\/[^/]+\/chat\/(.+)$/,
	);
	if (wsChatMatch)
		return { view: "session", id: decodeURIComponent(wsChatMatch[1]) };
	const sessionMatch = pathname.match(/^\/backstage\/session\/(.+)$/);
	if (sessionMatch)
		return { view: "session", id: decodeURIComponent(sessionMatch[1]) };
	if (pathname === "/backstage/new") return { view: "new" };
	if (pathname === "/backstage/automations") return { view: "automations" };
	if (pathname === "/backstage/security") return { view: "security" };
	if (pathname === "/backstage/goals") return { view: "goals" };
	if (pathname === "/backstage/actions") return { view: "actions" };
	// Back-compat: Connections moved into Settings (a Workspace section).
	if (pathname === "/backstage/connections") return { view: "settings" };
	if (pathname === "/backstage/settings") return { view: "settings" };
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
		case "security":
			return "/backstage/security";
		case "goals":
			return "/backstage/goals";
		case "actions":
			return "/backstage/actions";
		case "settings":
			return "/backstage/settings";
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
	const { sessions, loading, refresh, inject } = useSessions();
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
	// On phones the layout is an iOS-style page stack: the sidebar is the root
	// page and any non-home route is a page pushed over it. `mobileDetail` drives
	// that (see the `.mobile-detail` CSS and the back button below). It's inert on
	// desktop, where the sidebar + detail are a static split.
	const detailPaneRef = useRef<HTMLElement | null>(null);
	// Desktop-only: collapse the left sidebar entirely (persisted per browser). On
	// mobile the page-stack (mobileDetail) governs the sidebar instead; this hides
	// the static desktop column and swaps in a floating re-open control.
	const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
		() => localStorage.getItem("michael-sidebar-collapsed") === "1",
	);
	function toggleSidebarCollapsed() {
		setSidebarCollapsed((v) => {
			const next = !v;
			localStorage.setItem("michael-sidebar-collapsed", next ? "1" : "0");
			return next;
		});
	}
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
	// (create → navigate races the async refresh; the server persists the file
	// before session_created, so this window is just one list fetch). While
	// pending, the detail pane shows a "Starting…" state instead of flashing
	// "Session not found". pendingNewWorkspace words it for a brand-new
	// workspace vs. a chat added to an existing one.
	const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
	const [pendingNewWorkspace, setPendingNewWorkspace] = useState(false);
	// Who's viewing what, app-wide (from global_presence), + follow mode: when
	// following a teammate, we navigate wherever they go.
	const [teamViewing, setTeamViewing] = useState<
		Array<{ user: string; sessionId: string }>
	>([]);
	const [followUser, setFollowUser] = useState<string | null>(null);
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

	// Projects (folders that group chats) — powers the sidebar's Projects section
	// and the project-scoped tab strip. Refetched on focus and when sessions change
	// (a new PR chat can auto-create a folder server-side).
	const [projects, setProjects] = useState<Project[]>([]);
	const refreshProjects = React.useCallback(() => {
		fetchProjects()
			.then(setProjects)
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshProjects();
		const onFocus = () => refreshProjects();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshProjects]);

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

	// A pushed detail page is showing (anything but the sidebar-root home view).
	const mobileDetail = route.view !== "home";

	// Keep the latest route readable from stable callbacks — `navigate` is
	// recreated each render, but effects/handlers can capture an older copy.
	const routeRef = useRef(route);
	routeRef.current = route;
	// The mobile layout is an iOS-style navigation stack: the sidebar is the root
	// (depth 0) and every non-home route is a *single* panel pushed over it
	// (depth 1). `rootBehind` tracks whether that root sits beneath us in history
	// so Back can pop (`history.back()`, keeping the browser/OS back button in
	// sync) instead of pushing yet another entry — the "pages within pages" trap.
	// Cold-loading straight into a panel (deep link / restored session) has no
	// root beneath it, so there Back synthesizes a home navigation instead.
	const rootBehind = useRef(false);

	// Navigate the single detail panel. Root→panel pushes one history entry;
	// panel→panel *replaces* (stays at the same depth, so the stack never nests);
	// re-navigating to the current URL replaces (no duplicate entries). Going to
	// the root is done by `goBack` (a pop), not here.
	function navigate(next: Route, opts?: { replace?: boolean }) {
		const path = routePath(next);
		const cur = routeRef.current;
		const toRoot = next.view === "home";
		const fromRoot = cur.view === "home";
		const samePath = path === location.pathname;
		const replace = opts?.replace ?? (samePath || (!toRoot && !fromRoot));
		if (replace) history.replaceState(null, "", path);
		else history.pushState(null, "", path);
		if (!toRoot && fromRoot && !samePath) rootBehind.current = true;
		if (toRoot) rootBehind.current = false;
		setRoute(next);
	}

	// Pop the pushed panel back to the sidebar root. If the root is beneath us in
	// history, a real `history.back()` keeps the browser/OS back button and the
	// app in lockstep; otherwise (cold-launched into a panel) replace to home so
	// we never grow the stack.
	function goBack() {
		if (rootBehind.current) history.back();
		else navigate({ view: "home" }, { replace: true });
	}

	// Edge-swipe-from-left pops the pushed page back to the sidebar on phones.
	useBackSwipe({
		active: mobileDetail,
		onBack: goBack,
		paneRef: detailPaneRef,
	});

	// Arm audio + request notification permission on the first user gesture.
	useEffect(() => initAlerts(), []);

	// Sound + desktop notification whenever one of *my* sessions newly flips into
	// "needs input" (blocked on a question). Scoped to the current user's own
	// non-automation sessions — the same set as the sidebar's "Needs input" bucket.
	useInputAlerts(sessions, {
		isMine: (s) => {
			const me = getCurrentUser().toLowerCase();
			return (
				!s.automation && !!s.startedBy && s.startedBy.toLowerCase() === me
			);
		},
		onOpen: (id) => navigate({ view: "session", id }),
	});

	// The "new session" ⌘K palette. It's an overlay driven by its own state (not a
	// route), so it can open over any view; the /backstage/new route still opens it
	// so old links keep working.
	const [palette, setPalette] = useState<{
		open: boolean;
		prompt?: string;
		// When starting a chat inside a project, prefill the folder + its shared repo
		// and worktree so the new chat lands next to its siblings by default.
		projectId?: string;
		repo?: string;
		branch?: string;
	}>(() =>
		route.view === "new" ? { open: true, prompt: route.prompt } : { open: false },
	);
	const paletteOpenRef = useRef(palette.open);
	paletteOpenRef.current = palette.open;
	const openPalette = React.useCallback((prompt?: string) => {
		setPalette({ open: true, prompt });
	}, []);

	// A "new tab" while a session is open is a *new chat in that same session*, not
	// a whole new session — so it must NOT pop the new-session palette. It's a
	// visual fresh-start (one thread under the hood): bumping this counter tells the
	// open SessionViewer to clear its composer and scroll to the live edge. With no
	// session open there's nothing to stay in, so it falls back to the palette.
	const [newChatSeq, setNewChatSeq] = useState(0);

	// The ⌘K session-search command palette. Like the new-session palette it's an
	// overlay driven by its own state so it can open over any view.
	const [searchOpen, setSearchOpen] = useState(false);
	const searchOpenRef = useRef(searchOpen);
	searchOpenRef.current = searchOpen;
	const closePalette = React.useCallback(() => {
		setPalette({ open: false });
		// A deep link left the URL on /backstage/new — return home on close.
		if (location.pathname === "/backstage/new") goBack();
	}, []);

	useEffect(() => {
		const onPop = () => {
			const r = parseRoute(location.pathname);
			// Landing back on the root means nothing is pushed over it anymore.
			if (r.view === "home") rootBehind.current = false;
			setRoute(r);
		};
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
			if (msg.type === "global_presence") {
				setTeamViewing(msg.viewing);
				return;
			}
			if (msg.type === "session_created") {
				// Mark it pending so the viewer shows "Starting…" until the poll
				// catches up; a fallback timeout clears it so a failed create can't
				// stick.
				setPendingSessionId(msg.id);
				setPendingNewWorkspace(!!msg.newWorkspace);
				clearTimeout(pendingTimer.current);
				pendingTimer.current = setTimeout(
					() => setPendingSessionId(null),
					30000,
				);
				refresh();
				refreshProjects();
				navigate({ view: "session", id: msg.id });
			}
		});
	}, [addHandler, refresh, refreshProjects]);

	// Follow mode: whenever the followed teammate's session changes, go along.
	// Dropping out is explicit (click again) or automatic when they disconnect.
	useEffect(() => {
		if (!followUser) return;
		const target = teamViewing.find((v) => v.user === followUser);
		if (!target) return;
		if (route.view === "session" && route.id === target.sessionId) return;
		navigate({ view: "session", id: target.sessionId });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [followUser, teamViewing]);

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

	// Mark the open session read up to its latest activity — both when it's first
	// opened and as new activity streams in while it stays open — so the sidebar's
	// unread flag clears for whatever you're currently looking at.
	useEffect(() => {
		if (currentSession)
			markRead(currentSession.id, currentSession.lastActivity);
	}, [currentSession?.id, currentSession?.lastActivity]);

	const currentNoteId =
		route.view === "notes" && route.sel?.kind === "note" ? route.sel.id : null;

	// The tab strip is scoped to the open chat's workspace: its sibling chats
	// (same projectId), oldest first. Chats with no workspace (slack/linear
	// sources — their files are read-only, so the migration couldn't wrap them)
	// fall back to grouping by shared isolated worktree, so a bks- sibling made
	// via + shows up next to its slack source. Failing that, the open chat alone
	// still gets a strip (one tab + the + button).
	const activeProjectId = currentSession?.projectId || null;

	// Canonicalize the open chat's URL to /workspace/<wsId>/chat/<chatId> once
	// its workspace is known (replaceState: same history depth, so Back and the
	// mobile page-stack are unaffected). Workspace-less chats keep /session/<id>.
	useEffect(() => {
		if (route.view !== "session" || !currentSession) return;
		const canonical = activeProjectId
			? `/backstage/workspace/${encodeURIComponent(activeProjectId)}/chat/${encodeURIComponent(route.id)}`
			: `/backstage/session/${encodeURIComponent(route.id)}`;
		if (location.pathname !== canonical)
			history.replaceState(null, "", canonical);
	}, [route, currentSession, activeProjectId]);
	const byCreated = (a: UnifiedSession, b: UnifiedSession) =>
		(a.createdAt || "").localeCompare(b.createdAt || "");
	// Archived (closed) chats leave the strip — except the one you're actively
	// viewing (e.g. opened from Archived), which keeps its tab.
	const liveTab = (s: UnifiedSession) =>
		!s.archived || s.id === currentSession?.id;
	const projectChats: UnifiedSession[] = activeProjectId
		? sessions
				.filter((s) => liveTab(s) && s.projectId === activeProjectId)
				.sort(byCreated)
		: currentSession?.worktreeDir?.startsWith("/home/ubuntu/worktrees/")
			? sessions
					.filter(
						(s) => liveTab(s) && s.worktreeDir === currentSession.worktreeDir,
					)
					.sort(byCreated)
			: currentSession
				? [currentSession]
				: [];

	// Plain title shown in the top bar for non-session views (session routes let
	// the SessionViewer portal its own header in instead). Home stays blank so the
	// bar collapses (`.detail-topbar:empty`).
	const topbarTitle: string =
		route.view === "reviews"
			? "Reviews"
			: route.view === "automations"
				? "Automations"
				: route.view === "security"
					? "Security"
				: route.view === "goals"
					? "Goals"
					: route.view === "actions"
						? "Actions"
						: route.view === "archived"
							? "Archived"
							: route.view === "notes"
								? "Notes"
								: route.view === "new"
									? "New session"
									: "";

	const activeView =
		route.view === "automations" ||
		route.view === "security" ||
		route.view === "goals" ||
		route.view === "actions" ||
		route.view === "notes" ||
		route.view === "reviews"
			? route.view === "notes"
				? "wiki"
				: route.view
			: ("sessions" as const);

	// Brand: the Michael title + its dropdown (the "Michael menu"), which now carries
	// the account switcher and connection status that used to sit as a separate chip.
	// Shared between the mobile top bar and the desktop sidebar's brand row.
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
			<SettingsMenu
				onOpenSettings={() => navigate({ view: "settings" })}
				connected={connected}
			/>
		</div>
	);

	// The "toggle left sidebar" panel glyph — a framed rectangle with a divider
	// marking the collapsible left column. Reused by the brand-row collapse button
	// and the floating re-open control.
	const panelIcon = (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect
				x="1.75"
				y="2.75"
				width="12.5"
				height="10.5"
				rx="2"
				stroke="currentColor"
				strokeWidth="1.4"
			/>
			<line
				x1="6.25"
				y1="2.75"
				x2="6.25"
				y2="13.25"
				stroke="currentColor"
				strokeWidth="1.4"
			/>
		</svg>
	);

	return (
		<UserGate>
			<RestartOverlay connected={connected} addHandler={addHandler} />
			<UpdateToast addHandler={addHandler} />
			<div className="app">
				{/* Mobile-only top bar. On the sidebar-root page it shows the brand;
				    on a pushed page (a session or other view) the brand is replaced by
				    a Back chevron that pops back to the root, iOS-style. On desktop the
				    brand/user live in the sidebar and this bar is hidden. */}
				<header className="app-header">
					<div className="app-header-left">
						{mobileDetail ? (
							<button
								className="mobile-back"
								onClick={goBack}
								aria-label="Back to sidebar"
							>
								<svg width="11" height="18" viewBox="0 0 11 18" fill="none">
									<path
										d="M9 1.5L2 9l7 7.5"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
								<span>Back</span>
							</button>
						) : (
							brand
						)}
					</div>
				</header>

				{route.view === "settings" ? (
					<Settings onBack={goBack} />
				) : (
				<div
					className={`app-body ${mobileDetail ? "mobile-detail" : "mobile-root"}${
						sidebarCollapsed ? " sidebar-collapsed" : ""
					}`}
				>
					<div
						className="sidebar-container"
						style={
							{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties
						}
					>
						{/* Desktop brand row: Michael menu on the left, the collapse toggle
						    on the right (hidden on mobile, where the top bar carries the
						    brand instead). */}
						<div className="sidebar-brand">
							{brand}
							<Tooltip label="Hide sidebar" side="bottom">
								<button
									className="sidebar-toggle-btn"
									onClick={toggleSidebarCollapsed}
									aria-label="Hide sidebar"
								>
									{panelIcon}
								</button>
							</Tooltip>
						</div>
						<Sidebar
							sessions={sessions}
							projects={projects}
							notes={notes.map((n) => ({ id: n.id, title: n.title }))}
							teamViewing={teamViewing}
							followUser={followUser}
							onToggleFollow={(user) =>
								setFollowUser(followUser === user ? null : user)
							}
							selectedId={currentSession?.id || null}
							activeNoteId={currentNoteId}
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
							onOpenProject={(id) => {
								// Open the workspace's first chat (oldest, matching the tab
								// strip's order — there's always one post-migration). An empty
								// workspace opens the new-chat palette scoped to it.
								const chats = sessions
									.filter((s) => !s.archived && s.projectId === id)
									.sort((a, b) =>
										(a.createdAt || "").localeCompare(b.createdAt || ""),
									);
								if (chats.length)
									navigate({ view: "session", id: chats[0].id });
								else {
									const p = projects.find((x) => x.id === id);
									setPalette({ open: true, projectId: id, repo: p?.repo });
								}
							}}
							onRenameProject={async (id, name) => {
								try {
									await updateProjectApi(id, { name });
									refreshProjects();
								} catch (e) {
									console.error("Rename project failed:", e);
								}
							}}
							onDeleteProject={async (id) => {
								try {
									await deleteProjectApi(id);
									refreshProjects();
									refresh();
								} catch (e) {
									console.error("Delete project failed:", e);
								}
							}}
							onSetProjectColor={async (id, color) => {
								try {
									await updateProjectApi(id, { color });
									refreshProjects();
								} catch (e) {
									console.error("Set project color failed:", e);
								}
							}}
							onSetSessionProject={async (sessionId, projectId) => {
								try {
									await setSessionProjectApi(sessionId, projectId);
									refresh();
									refreshProjects();
								} catch (e) {
									console.error("Move to project failed:", e);
								}
							}}
							onOpenNote={(id) =>
								navigate({ view: "notes", sel: { kind: "note", id } })
							}
							onOpenSearch={() => setSearchOpen(true)}
							onOpenArchived={() => navigate({ view: "archived" })}
							archivedActive={route.view === "archived"}
							onArchive={async (s, next) => {
								try {
									await archiveSessionApi(s.id, true);
								} catch (e) {
									console.error("Archive failed:", e);
								}
								// Archiving the open session shouldn't strand the viewer on a
								// dead chat — hop to the sidebar's next row instead.
								if (route.view === "session" && route.id === s.id) {
									if (next) navigate({ view: "session", id: next.id });
									else goBack();
								}
								refresh();
							}}
							onArchiveWorkspace={async (chats, next) => {
								// Archive a whole workspace = archive every member chat (the
								// archive registry is per-chat; the workspace row disappears
								// once no live chats remain).
								try {
									await Promise.all(
										chats.map((c) => archiveSessionApi(c.id, true)),
									);
								} catch (e) {
									console.error("Archive workspace failed:", e);
								}
								// Archiving the open workspace shouldn't strand the viewer on
								// a dead chat — hop to the next workspace in the sidebar.
								if (
									route.view === "session" &&
									chats.some((c) => c.id === route.id)
								) {
									if (next) navigate({ view: "session", id: next.id });
									else goBack();
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

					<main className="detail-pane" ref={detailPaneRef}>
						{/* Floating re-open control, shown only while the desktop sidebar
						    is collapsed (CSS-gated). Mirrors the brand-row toggle so the
						    sidebar can always be brought back. */}
						<Tooltip label="Show sidebar" side="right">
							<button
								className="sidebar-reopen"
								onClick={toggleSidebarCollapsed}
								aria-label="Show sidebar"
							>
								{panelIcon}
							</button>
						</Tooltip>
						{/* Top bar: session name + actions (portaled in by SessionViewer)
						    on session routes, a plain title otherwise. Sits above the tab
						    strip so the session identity reads first, tabs below it. */}
						<div className="detail-topbar" ref={setTopbarEl}>
							{route.view !== "session" && topbarTitle && (
								<span className="detail-topbar-title">{topbarTitle}</span>
							)}
						</div>
						<SessionTabs
							tabs={projectChats}
							activeId={currentSession?.id || null}
							colors={tabColors}
							onSelect={(s) => navigate({ view: "session", id: s.id })}
							onSetColor={(key, color) => setTabColors(setTabColor(key, color))}
							onNewChat={async (mode) => {
								// + creates the sibling chat instantly (browser-tab feel): it
								// shares the workspace worktree by default, or stacks/asks via
								// the right-click menu. No engine run until the first prompt.
								const src = currentSession || projectChats[0];
								if (!src) return;
								try {
									const { id, session } = await newChatApi(
										src.id,
										getCurrentUser(),
										mode,
									);
									// Inject the created session so the viewer renders the new
									// chat immediately — no "Loading session…" flash while the
									// sessions poll catches up. If the server didn't return it,
									// synthesize a close-enough copy from the source chat; the
									// next poll replaces it with the real one either way.
									const now = new Date().toISOString();
									inject(
										session ?? {
											...src,
											id,
											source: "backstage",
											claudeSessionId: null,
											codexThreadId: undefined,
											title: "New chat",
											createdAt: now,
											lastActivity: now,
											isRunning: false,
											transcriptPath: null,
											startedBy: getCurrentUser(),
											archived: false,
											waitingForInput: false,
											queuedCount: 0,
											prUrl: undefined,
											prState: undefined,
											automation: undefined,
											plainThreadId: undefined,
											goal: undefined,
											loop: undefined,
											...(mode === "ask"
												? {
														branch: null,
														worktreeDir: null,
														mode: "ask" as const,
													}
												: {}),
										},
									);
									setPendingSessionId(id);
									refresh();
									navigate({ view: "session", id });
								} catch (e) {
									console.error("New chat failed:", e);
								}
							}}
							onRename={async (id, title) => {
								try {
									await renameSessionApi(id, title);
								} catch (e) {
									console.error("Rename failed:", e);
								}
								refresh();
							}}
							onClose={async (s) => {
								// Closing a tab archives the chat: it leaves the strip and the
								// active list, but stays recoverable from Archived. An empty
								// chat that never ran has nothing to recover, so it's deleted
								// outright instead of cluttering Archived. If we just closed
								// the open session, fall back to a sibling tab.
								const neverRan =
									s.source === "backstage" &&
									!s.claudeSessionId &&
									!s.codexThreadId &&
									!s.transcriptPath &&
									!s.isRunning &&
									!s.queuedCount;
								try {
									if (neverRan) await deleteSessionApi(s.id, false);
									else await archiveSessionApi(s.id, true);
								} catch (e) {
									console.error("Close failed:", e);
								}
								if (currentSession?.id === s.id) {
									const next = projectChats.find((c) => c.id !== s.id);
									if (next) navigate({ view: "session", id: next.id });
									else goBack();
								}
								refresh();
							}}
						/>
						{route.view === "automations" ? (
							<Automations
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "security" ? (
							<Security
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
									onBack={goBack}
									send={send}
									addHandler={addHandler}
									connected={connected}
									topbarEl={topbarEl}
									rightPanelEl={rightPanelEl}
									newChatSeq={newChatSeq}
									workspaceChats={projectChats}
									onRename={async (id, title) => {
										try {
											await renameSessionApi(id, title);
										} catch (e) {
											console.error("Rename failed:", e);
										}
										refresh();
									}}
									workspaceName={
										activeProjectId
											? projects.find((p) => p.id === activeProjectId)?.name
											: undefined
									}
									onRenameWorkspace={
										activeProjectId
											? async (name) => {
													try {
														await updateProjectApi(activeProjectId, { name });
													} catch (e) {
														console.error("Rename workspace failed:", e);
													}
													refreshProjects();
												}
											: undefined
									}
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
														{!isLoading
															? "Session not found"
															: route.id === pendingSessionId
																? pendingNewWorkspace
																	? "Starting a new workspace…"
																	: "Starting a new chat…"
																: "Loading session…"}
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
								connected={connected}
								send={send}
								addHandler={addHandler}
								onSelect={(s) => navigate({ view: "session", id: s.id })}
								onNewSession={(prompt) => openPalette(prompt)}
								onOpenReviews={() => navigate({ view: "reviews" })}
								onOpenSessionId={(id) => navigate({ view: "session", id })}
							/>
						)}
					</main>

					{/* Full-height right column beside the detail pane. The active
					    session's workspace/sub-agent panel portals in here. */}
					<div className="right-panel-slot" ref={setRightPanelEl} />
				</div>
				)}

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
						projectId={palette.projectId}
						forceRepo={palette.repo}
						forceBranch={palette.branch}
					/>
				)}
			</div>
		</UserGate>
	);
}

const root = createRoot(document.getElementById("root")!);
root.render(
	<TooltipProvider>
		<App />
		<ImageLightbox />
	</TooltipProvider>,
);
