import { BASE_PATH, stripBasePath } from "./lib/base";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { ToastHost, toast } from "./ui/toast";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { SessionSearch } from "./components/SessionSearch";
import { Home } from "./components/Home";
import { CatchUpDeck } from "./components/CatchUpDeck";
import { PrTinder } from "./components/PrTinder";
import { SupportTinder } from "./components/SupportTinder";
import { Automations } from "./components/Automations";
import { Security } from "./components/Security";
import { Goals } from "./components/Goals";
import { Actions } from "./components/Actions";
import { Notes, type NotesSelection } from "./components/Notes";
import { Archived } from "./components/Archived";
import { Reviews } from "./components/Reviews";
import { TeamChat } from "./components/TeamChat";
import { PrPreview } from "./components/PrPreview";
import { SupportPreview } from "./components/SupportPreview";
import { Reports } from "./components/Reports";
import { UserGate, getCurrentUser } from "./components/UserPicker";
import { PreviewWait, matchPreviewWaitRoute } from "./components/PreviewWait";
import { SettingsMenu } from "./components/SettingsMenu";
import { TitleBar } from "./components/TitleBar";
import { Settings, type SettingsSectionKey } from "./components/Settings";
import { SessionTabs, type ViewTab } from "./components/SessionTabs";
import { RestartOverlay } from "./components/RestartOverlay";
import { MediaLightboxHost } from "./components/MediaLightbox";
import { UpdatePill } from "./components/UpdatePill";
import { IconSearch, IconSidebarLeft } from "./components/icons";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import { useBackSwipe } from "./hooks/useBackSwipe";
import { useIsPhone } from "./hooks/useIsPhone";
import { useInputAlerts } from "./hooks/useInputAlerts";
import { initAlerts } from "./lib/notify";
import { registerServiceWorker } from "./lib/push";
import {
	archiveSessionApi,
	deleteSessionApi,
	renameSessionApi,
	setSessionStatusApi,
	fetchNotes,
	fetchProjects,
	updateProjectApi,
	deleteProjectApi,
	newChatApi,
	fetchChatMessagesApi,
	type NoteMeta,
} from "./lib/api";
import type { Project } from "./lib/types";
import { pushRecent } from "./lib/recents";
import { markRead } from "./lib/reads";
import {
	chatPath,
	prPath,
	absoluteLink,
	copyToClipboard,
} from "./lib/share-link";
import {
	getPins,
	togglePin,
	pin,
	unpin,
	reorderPins,
	onPinsChanged,
	getPinNewSessions,
	getPinNewWorkspaces,
} from "./lib/pins";
import {
	getTabColors,
	setTabColor,
	onTabColorsChanged,
} from "./lib/tab-colors";
import { copySessionTranscript } from "./lib/transcript-copy";
import type { UnifiedSession } from "./lib/types";
import "./styles/global.css";

type Route =
	| { view: "home" }
	| { view: "new"; prompt?: string }
	| { view: "session"; id: string }
	// Session-less PR preview (a sidebar PR row with no chat yet).
	| { view: "pr"; repo: string; branch: string }
	// Session-less support-ticket preview (a Support row with no session yet).
	| { view: "support"; threadId: string }
	| { view: "reports"; automationId?: string; reportId?: string }
	| { view: "reviews"; id?: string }
	// PR Tinder — one-at-a-time swipe triage of the repo's open PRs.
	| { view: "prtinder" }
	// Support Tinder — the same swipe triage over the Plain Todo queue.
	| { view: "supporttinder" }
	// Tool surfaces (Automations/Security/Goals/Actions/Notes) render inside the
	// Settings chrome but keep their own routes, so old links stay deep-linkable.
	| { view: "automations"; id?: string }
	| { view: "security" }
	| { view: "goals"; id?: string }
	| { view: "actions"; id?: string }
	| { view: "notes"; sel: NotesSelection }
	| { view: "settings"; section?: SettingsSectionKey }
	| { view: "archived" }
	| { view: "catchup" }
	// Watercooler — the team-wide native chat room (not Slack).
	| { view: "watercooler" };

// Route views that render as a tool section inside the Settings surface.
const TOOL_VIEWS = [
	"automations",
	"security",
	"goals",
	"actions",
	"notes",
] as const;
type ToolView = (typeof TOOL_VIEWS)[number];
function isToolView(view: string): view is ToolView {
	return (TOOL_VIEWS as readonly string[]).includes(view);
}

// Non-tool settings sections, addressable as <base>/settings/<section>.
const SETTINGS_SECTIONS = new Set<SettingsSectionKey>([
	"notifications",
	"autoArchive",
	"composer",
	"appearance",
	"workspace",
	"model",
	"modelProviders",
	"connections",
	"memory",
	"warmPreviews",
	"papercuts",
	"audit",
]);

function parseRoute(pathname: string): Route {
	// Accept both prefixes: /opensession (primary) and /backstage (legacy alias).
	pathname = stripBasePath(pathname);
	// Canonical chat URL: <base>/workspace/<wsId>/chat/<chatId>. The chat id
	// alone identifies the session; the workspace segment makes the hierarchy
	// shareable/readable. Old <base>/session/<id> links keep working and get
	// canonicalized once the session (and its workspace) is known.
	const wsChatMatch = pathname.match(
		/^\/workspace\/[^/]+\/chat\/(.+)$/,
	);
	if (wsChatMatch)
		return { view: "session", id: decodeURIComponent(wsChatMatch[1]) };
	const sessionMatch = pathname.match(/^\/session\/(.+)$/);
	if (sessionMatch)
		return { view: "session", id: decodeURIComponent(sessionMatch[1]) };
	// PR preview: <base>/pr/<repo>/<branch> (branch is fully URI-encoded, so
	// slashes in branch names arrive as %2F and land in one segment).
	const prMatch = pathname.match(/^\/pr\/([^/]+)\/(.+)$/);
	if (prMatch)
		return {
			view: "pr",
			repo: decodeURIComponent(prMatch[1]),
			branch: decodeURIComponent(prMatch[2]),
		};
	// Support-ticket preview: <base>/support/<plain thread id>.
	const supportMatch = pathname.match(/^\/support\/(.+)$/);
	if (supportMatch)
		return { view: "support", threadId: decodeURIComponent(supportMatch[1]) };
	const reportsMatch = pathname.match(/^\/reports(?:\/([^/]+)(?:\/([^/]+))?)?$/);
	if (reportsMatch)
		return {
			view: "reports",
			automationId: reportsMatch[1] ? decodeURIComponent(reportsMatch[1]) : undefined,
			reportId: reportsMatch[2] ? decodeURIComponent(reportsMatch[2]) : undefined,
		};
	if (pathname === "/new") return { view: "new" };
	// <base>/automations/<id-or-name>: the automations page with one selected
	// (its detail drawer open). The segment accepts the automation id or name —
	// the sidebar only knows names.
	const autoMatch = pathname.match(/^\/automations(?:\/(.+))?$/);
	if (autoMatch)
		return {
			view: "automations",
			id: autoMatch[1] ? decodeURIComponent(autoMatch[1]) : undefined,
		};
	if (pathname === "/security") return { view: "security" };
	// Goals/Actions mirror /automations/:id — one selected opens its drawer.
	const goalsMatch = pathname.match(/^\/goals(?:\/(.+))?$/);
	if (goalsMatch)
		return {
			view: "goals",
			id: goalsMatch[1] ? decodeURIComponent(goalsMatch[1]) : undefined,
		};
	const actionsMatch = pathname.match(/^\/actions(?:\/(.+))?$/);
	if (actionsMatch)
		return {
			view: "actions",
			id: actionsMatch[1] ? decodeURIComponent(actionsMatch[1]) : undefined,
		};
	// Back-compat: Connections moved into Settings (a Workspace section).
	if (pathname === "/connections")
		return { view: "settings", section: "connections" };
	// <base>/settings/<section>: a settings section, or a tool key (tools
	// live in the Settings surface but keep their own canonical routes).
	const settingsMatch = pathname.match(/^\/settings(?:\/(.+))?$/);
	if (settingsMatch) {
		const key = settingsMatch[1] as SettingsSectionKey | undefined;
		if (key && isToolView(key))
			return key === "notes" ? { view: "notes", sel: null } : { view: key };
		if (key && SETTINGS_SECTIONS.has(key))
			return { view: "settings", section: key };
		return { view: "settings" };
	}
	if (pathname === "/archived") return { view: "archived" };
	if (pathname === "/catchup") return { view: "catchup" };
	if (pathname === "/pr-tinder") return { view: "prtinder" };
	if (pathname === "/support-tinder") return { view: "supporttinder" };
	if (pathname === "/watercooler") return { view: "watercooler" };
	const reviewsMatch = pathname.match(/^\/reviews(?:\/(.+))?$/);
	if (reviewsMatch)
		return {
			view: "reviews",
			id: reviewsMatch[1] ? decodeURIComponent(reviewsMatch[1]) : undefined,
		};
	const noteMatch = pathname.match(/^\/notes(?:\/(.+))?$/);
	if (noteMatch)
		return {
			view: "notes",
			sel: noteMatch[1]
				? { kind: "note", id: decodeURIComponent(noteMatch[1]) }
				: null,
		};
	const docMatch = pathname.match(/^\/docs\/(.+)$/);
	if (docMatch)
		return {
			view: "notes",
			sel: { kind: "doc", path: decodeURIComponent(docMatch[1]) },
		};
	// Back-compat: the old read-only Wiki lived at <base>/wiki/<path>.
	const wikiMatch = pathname.match(/^\/wiki(?:\/(.+))?$/);
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
			return `${BASE_PATH}/session/${encodeURIComponent(route.id)}`;
		case "pr":
			return `${BASE_PATH}/pr/${encodeURIComponent(route.repo)}/${encodeURIComponent(route.branch)}`;
		case "support":
			return `${BASE_PATH}/support/${encodeURIComponent(route.threadId)}`;
		case "reports":
			return route.automationId
				? `${BASE_PATH}/reports/${encodeURIComponent(route.automationId)}${route.reportId ? `/${encodeURIComponent(route.reportId)}` : ""}`
				: `${BASE_PATH}/reports`;
		case "new":
			return route.prompt
				? `${BASE_PATH}/new?prompt=${encodeURIComponent(route.prompt)}`
				: `${BASE_PATH}/new`;
		case "automations":
			return route.id
				? `${BASE_PATH}/automations/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/automations`;
		case "security":
			return `${BASE_PATH}/security`;
		case "goals":
			return route.id
				? `${BASE_PATH}/goals/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/goals`;
		case "actions":
			return route.id
				? `${BASE_PATH}/actions/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/actions`;
		case "settings":
			return route.section
				? `${BASE_PATH}/settings/${route.section}`
				: `${BASE_PATH}/settings`;
		case "archived":
			return `${BASE_PATH}/archived`;
		case "catchup":
			return `${BASE_PATH}/catchup`;
		case "prtinder":
			return `${BASE_PATH}/pr-tinder`;
		case "supporttinder":
			return `${BASE_PATH}/support-tinder`;
		case "watercooler":
			return `${BASE_PATH}/watercooler`;
		case "reviews":
			return route.id
				? `${BASE_PATH}/reviews/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/reviews`;
		case "notes":
			if (route.sel?.kind === "note")
				return `${BASE_PATH}/notes/${encodeURIComponent(route.sel.id)}`;
			if (route.sel?.kind === "doc")
				return `${BASE_PATH}/docs/${route.sel.path.split("/").map(encodeURIComponent).join("/")}`;
			return `${BASE_PATH}/notes`;
		default:
			return `${BASE_PATH}/`;
	}
}

function App() {
	const { sessions, loading, refresh, inject, unstick, patch, remove } =
		useSessions();
	const { connected, send, addHandler } = useWebSocket();
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;
	type PendingCreateDraft = {
		prompt: string;
		mode: "ask" | "code";
		repo: string;
		branch: string | null;
		projectId?: string;
		model?: string;
		images?: string[];
		startedAt: string;
		user: string;
	};
	const pendingCreateDraftRef = useRef<PendingCreateDraft | null>(null);
	const [pendingInitialPrompts, setPendingInitialPrompts] = useState<
		Record<
			string,
			{ content: string; user: string; sentAt: number; images?: string[] }
		>
	>({});
	// Transient toasts (e.g. "Link copied", "Archived · stopped the running
	// turn") route through the global toast store — stacked, animated, and
	// firable from anywhere without threading a prop. This wrapper keeps the
	// existing `onToast`/`showToast` call sites working.
	const showToast = useCallback((message: string) => {
		toast(message);
	}, []);
	// Watercooler unread badge: messages newer than the locally-stored
	// last-read stamp (own messages never count). Live chat_message events bump
	// it; having the Watercooler open marks read continuously.
	const [chatUnread, setChatUnread] = useState(0);
	useEffect(() => {
		fetchChatMessagesApi("watercooler")
			.then((msgs) => {
				const lastRead = Number(
					localStorage.getItem("opensession-chat-read") ||
						localStorage.getItem("backstage-chat-read") ||
						0,
				);
				const me = getCurrentUser();
				setChatUnread(
					msgs.filter((m) => m.ts > lastRead && m.user !== me).length,
				);
			})
			.catch(() => {});
	}, []);
	// iOS evicts standalone PWAs from memory and relaunches them at the manifest
	// start_url — losing the session you had open. On a cold load
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
	// Track Watercooler reads: while it's open, arriving messages are read
	// immediately; otherwise they bump the sidebar badge.
	const chatOpenRef = useRef(false);
	chatOpenRef.current = route.view === "watercooler";
	useEffect(
		() =>
			addHandler((msg) => {
				if (msg.type !== "chat_message" || msg.channel !== "watercooler")
					return;
				if (chatOpenRef.current) {
					localStorage.setItem("opensession-chat-read", String(msg.message.ts));
				} else if (msg.message.user !== getCurrentUser()) {
					setChatUnread((n) => n + 1);
				}
			}),
		[addHandler],
	);
	useEffect(() => {
		if (route.view !== "watercooler") return;
		localStorage.setItem("opensession-chat-read", String(Date.now()));
		setChatUnread(0);
	}, [route.view]);
	// Register the service worker at boot, not just when enabling push: it also
	// caches the app shell (sw.js), so a cold start on a flaky tailnet paints
	// the app instead of white-screening.
	useEffect(() => registerServiceWorker(), []);
	// Mirror the unread count onto the app-icon badge (iOS/macOS installed PWA,
	// Chrome taskbar). While the app is open this is the source of truth,
	// overwriting whatever notification count sw.js left; no-op where the
	// Badging API is missing.
	useEffect(() => {
		const nav = navigator as Navigator & {
			setAppBadge?: (n?: number) => Promise<void>;
			clearAppBadge?: () => Promise<void>;
		};
		if (!nav.setAppBadge) return;
		if (chatUnread > 0) nav.setAppBadge(chatUnread).catch(() => {});
		else nav.clearAppBadge?.().catch(() => {});
	}, [chatUnread]);
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
	// Centered under the mobile top-bar title: the composer's model pill is hidden
	// on phones, so the session viewer portals a compact tap-to-switch model
	// selector into this slot — the only place a session's model surfaces there.
	const [headerModelEl, setHeaderModelEl] = useState<HTMLElement | null>(null);
	// Leading slot of the mobile title pill: the session viewer portals the repo
	// tile here so it sits in front of the name (Slack-header style).
	const [headerRepoEl, setHeaderRepoEl] = useState<HTMLElement | null>(null);
	// Right slot of the mobile top bar. On phones the session viewer portals its
	// header actions here (single iOS-style nav bar); desktop hides the bar and
	// the actions render in the topbar slot above instead.
	const [headerActionsEl, setHeaderActionsEl] =
		useState<HTMLDivElement | null>(null);
	const [rootListScrolled, setRootListScrolled] = useState(false);
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

	// Drop the pins made stale by archiving `justArchived`, mirroring the
	// server's unpinArchivedSessions: each chat's own id + alias ids, plus a
	// `workspace:<id>` pin once none of that workspace's chats are live anymore.
	// The server already does this, but our pin cache is optimistic and never
	// hears about that write — without this a later savePinsApi re-uploads the
	// stale list and resurrects the archived pin as an unreachable ghost row.
	const dropStalePins = React.useCallback((justArchived: UnifiedSession[]) => {
		if (!justArchived.length) return;
		const archivedIds = new Set(justArchived.map((s) => s.id));
		const all = sessionsRef.current;
		const keys: string[] = [];
		const projectIds = new Set<string>();
		for (const s of justArchived) {
			keys.push(s.id, ...(s.aliasIds || []));
			if (s.projectId) projectIds.add(s.projectId);
		}
		for (const pid of projectIds) {
			const hasLive = all.some(
				(s) => s.projectId === pid && !s.archived && !archivedIds.has(s.id),
			);
			if (!hasLive) keys.push(`workspace:${pid}`);
		}
		setPins(unpin(keys));
	}, []);

	// Track the on-screen keyboard via input focus. It's the only reliable iOS
	// signal: in a standalone PWA visualViewport doesn't shrink, and
	// env(safe-area-inset-bottom) keeps reporting the home-indicator inset even
	// while the keyboard covers that area. A `kb-open` body class lets the
	// composer drop its safe-area bottom padding so it sits snug above the
	// keyboard instead of floating ~34px above it.
	useEffect(() => {
		const isText = (el: Element | null) =>
			!!el &&
			(el.tagName === "TEXTAREA" ||
				(el.tagName === "INPUT" &&
					!["button", "checkbox", "radio", "submit", "file", "range", "color"].includes(
						(el as HTMLInputElement).type,
					)) ||
				(el as HTMLElement).isContentEditable);
		const onIn = (e: FocusEvent) => {
			if (isText(e.target as Element)) document.body.classList.add("kb-open");
		};
		const onOut = () => {
			// activeElement updates a tick after focusout; defer so moving between
			// fields doesn't flicker the class off and back on.
			setTimeout(() => {
				if (!isText(document.activeElement)) document.body.classList.remove("kb-open");
			}, 0);
		};
		document.addEventListener("focusin", onIn);
		document.addEventListener("focusout", onOut);
		return () => {
			document.removeEventListener("focusin", onIn);
			document.removeEventListener("focusout", onOut);
		};
	}, []);
	useEffect(() => {
		const unsub = onTabColorsChanged(() => setTabColors(getTabColors()));
		setTabColors(getTabColors());
		return unsub;
	}, []);

	// Settings (and the tool surfaces it hosts) render as a full page on
	// desktop, but as a bottom sheet over the root list on phones.
	const settingsActive = route.view === "settings" || isToolView(route.view);
	const isPhone = useIsPhone();

	// A pushed detail page is showing (anything but the sidebar-root home view).
	// On phones, Settings is a sheet floating over the root page rather than a
	// pushed page — the bar keeps the brand and the sidebar stays underneath.
	const mobileDetail = route.view !== "home" && !(isPhone && settingsActive);

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
		isMyReview: (s) =>
			s.reviewRequest?.to?.toLowerCase() === getCurrentUser().toLowerCase() &&
			!s.reviewRequest?.accepted,
		onOpen: (id) => navigate({ view: "session", id }),
		connected,
	});

	// The "new session" ⌘K palette. It's an overlay driven by its own state (not a
	// route), so it can open over any view; the <base>/new route still opens it
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
	// Whether the current session's Review pane is foregrounded (the top tab
	// strip's Review view-tab). Reset to chat whenever the open session changes.
	const [reviewActive, setReviewActive] = useState(false);
	// Sessions whose Review view-tab was dismissed (×); onOpenReview re-adds it.
	const [reviewClosed, setReviewClosed] = useState<Set<string>>(() => new Set());

	// Set for the render right after opening a workspace from the sidebar, so the
	// session it lands on autofocuses its composer (you picked the workspace to
	// type in it). Reset immediately after — a one-shot pulse, not a mode — so
	// sessions opened by any other means don't grab focus.
	const [focusComposerOnOpen, setFocusComposerOnOpen] = useState(false);
	const [sessionComposerPrefills, setSessionComposerPrefills] = useState<
		Record<string, { seq: number; text: string }>
	>({});
	const addToSessionInput = React.useCallback((sessionId: string, text: string) => {
		setSessionComposerPrefills((prev) => ({
			...prev,
			[sessionId]: { seq: (prev[sessionId]?.seq ?? 0) + 1, text },
		}));
		setFocusComposerOnOpen(true);
		navigate({ view: "session", id: sessionId });
	}, []);
	useEffect(() => {
		if (focusComposerOnOpen) setFocusComposerOnOpen(false);
	}, [focusComposerOnOpen]);

	// The ⌘K session-search command palette. Like the new-session palette it's an
	// overlay driven by its own state so it can open over any view.
	const [searchOpen, setSearchOpen] = useState(false);
	const searchOpenRef = useRef(searchOpen);
	searchOpenRef.current = searchOpen;
	const closePalette = React.useCallback(() => {
		setPalette({ open: false });
		// A deep link left the URL on <base>/new — return home on close.
		if (stripBasePath(location.pathname) === "/new") goBack();
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

	// The link ⌘⇧C copies: the open chat/workspace, or the open PR preview.
	// Assigned during render (below, once currentSession is known); null when
	// the current view has nothing linkable.
	const copyLinkPathRef = useRef<string | null>(null);

	// ⌘K toggles the session-search palette; ⌘N the new-session palette; ⌘⇧C
	// copies a link to the open chat/PR. Esc closes whichever palette is open
	// (search's own input also handles Esc, but this covers the case where focus
	// has left it).
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
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && k === "b") {
				// Toggle the desktop left sidebar. ⌘B is the panel-toggle
				// convention (VS Code / Slack); ⌘S is left to the browser's Save.
				e.preventDefault();
				toggleSidebarCollapsed();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "c") {
				// Let a real text selection copy normally; only hijack ⌘⇧C when
				// there's a linkable view and nothing is selected.
				if (window.getSelection?.()?.toString()) return;
				const path = copyLinkPathRef.current;
				if (!path) return;
				e.preventDefault();
				copyToClipboard(absoluteLink(path), () => showToast("Link copied"));
				return;
			}
			if (e.key === "Escape") {
				if (searchOpenRef.current) setSearchOpen(false);
				else if (paletteOpenRef.current) closePalette();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openPalette, closePalette, showToast]);

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
				const draft = pendingCreateDraftRef.current;
				pendingCreateDraftRef.current = null;
				// Pin the just-created session for its creator (this WS reply is
				// creator-only, so it never pins a teammate's new chat onto my bar).
				// Per-browser prefs in Settings: new chats/sessions pin on by
				// default; new workspaces are heavier, so they have their own
				// pref that's off by default.
				const shouldPin = msg.newWorkspace
					? getPinNewWorkspaces()
					: getPinNewSessions();
				if (shouldPin) setPins(pin(msg.id));
				if (!sessionsRef.current.some((s) => s.id === msg.id)) {
					const now = new Date().toISOString();
					const user = draft?.user || getCurrentUser();
					const createdAt = draft?.startedAt || now;
					inject({
						id: msg.id,
						claudeSessionId: null,
						source: "backstage",
						branch: draft?.branch ?? null,
						worktreeDir: null,
						startedBy: user,
						title: msg.newWorkspace
							? "New workspace"
							: draft?.projectId
								? "New chat"
								: "New session",
						lastActivity: now,
						createdAt,
						isRunning: true,
						runStartedAt: now,
						transcriptPath: null,
						mode: draft?.mode,
						repo: draft?.repo,
						projectId: msg.workspaceId || draft?.projectId || null,
						model: draft?.model,
						archived: false,
						// Worktree prep still running server-side — the viewer opens
						// straight into its "Waiting for workspace" state.
						workspacePreparing: !!msg.preparingWorkspace,
						},
						// Keep the optimistic copy alive across polls until the server
						// registers it, so the new tab renders straight away instead of
						// flashing "Starting…" — matters most for a new workspace, whose
						// worktree prep can take several polls to land.
						{ sticky: true });
				}
				if (draft?.prompt || draft?.images?.length) {
					setPendingInitialPrompts((prev) => ({
						...prev,
						[msg.id]: {
							content: draft.prompt,
							user: draft.user,
							sentAt: new Date(draft.startedAt).getTime(),
							...(draft.images?.length ? { images: draft.images } : {}),
						},
					}));
					window.setTimeout(() => {
						setPendingInitialPrompts((prev) => {
							if (!prev[msg.id]) return prev;
							const next = { ...prev };
							delete next[msg.id];
							return next;
						});
					}, 120_000);
				}
				// Mark it pending so the viewer shows "Starting…" until the poll
				// catches up; a fallback timeout clears it so a failed create can't
				// stick — including dropping the sticky optimistic copy above.
				setPendingSessionId(msg.id);
				setPendingNewWorkspace(!!msg.newWorkspace);
				clearTimeout(pendingTimer.current);
				pendingTimer.current = setTimeout(() => {
					setPendingSessionId(null);
					unstick(msg.id);
				}, 30000);
				refresh();
				refreshProjects();
				navigate({ view: "session", id: msg.id });
			}
		});
	}, [addHandler, refresh, refreshProjects, unstick]);

	// Follow mode: whenever the followed teammate's session changes, go along.
	// Dropping out is explicit (click again) or implicit — navigating anywhere
	// else yourself (sidebar click, back button) unfollows, so presence updates
	// can't keep yanking you back to their session. followNavRef marks route
	// changes made *by* the follow effect so they don't count as leaving.
	const followNavRef = useRef(false);
	useEffect(() => {
		if (!followUser) return;
		const target = teamViewing.find((v) => v.user === followUser);
		if (!target) return;
		if (route.view === "session" && route.id === target.sessionId) return;
		followNavRef.current = true;
		navigate({ view: "session", id: target.sessionId });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [followUser, teamViewing]);

	// Any route change the follow effect didn't make means the user went
	// somewhere on their own — stop following.
	useEffect(() => {
		if (followNavRef.current) {
			followNavRef.current = false;
			return;
		}
		if (!followUser) return;
		const target = teamViewing.find((v) => v.user === followUser);
		if (target && route.view === "session" && route.id === target.sessionId)
			return;
		setFollowUser(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [route]);

	// Drop the pending flag once we've navigated away from the pending chat (its
	// fallback timeout clears it otherwise). We deliberately DON'T clear it the
	// instant the session first shows up in the list: a poll that predates the
	// create can momentarily drop the just-injected copy again, and clearing here
	// would flash "Session not found" in that gap. Keeping the flag set masks the
	// gap with the "Starting…" state until the next poll re-adds the session (or
	// the timeout fires on a genuinely failed create).
	useEffect(() => {
		if (
			pendingSessionId &&
			!(route.view === "session" && route.id === pendingSessionId)
		) {
			setPendingSessionId(null);
			clearTimeout(pendingTimer.current);
			// Drop its sticky status now that we've left (and cancelled the 30s
			// fallback). A real session is retained by the next poll; a phantom
			// from a failed create is reconciled away instead of lingering.
			unstick(pendingSessionId);
		}
	}, [route, pendingSessionId, unstick]);

	const currentSession: UnifiedSession | null =
		route.view === "session"
			? sessions.find(
					(s) => s.id === route.id || s.aliasIds?.includes(route.id),
				) || null
			: null;

	// The open chat, read by the mount-once tab-shortcut handler (⌘⌥C / ⌘W —
	// see the effect next to closeChat below).
	const currentSessionRef = useRef<UnifiedSession | null>(null);
	// Opening a different session always starts on its chat, never a stale Review.
	useEffect(() => {
		setReviewActive(false);
	}, [currentSession?.id]);
	// The current code session's Review pane, surfaced as a leftmost view-tab in
	// the top strip (siblings share the worktree/PR, so one Review tab suffices).
	const currentHasWorkspace =
		!!currentSession && Boolean(currentSession.worktreeDir || currentSession.branch);
	const reviewViewTabs: ViewTab[] =
		currentSession && currentHasWorkspace && !reviewClosed.has(currentSession.id)
			? [
					{
						id: `review:${currentSession.id}`,
						label: "Review",
						active: reviewActive,
						dotClass: currentSession.prState
							? currentSession.prState === "OPEN" &&
								currentSession.prMergeable === "CONFLICTING"
								? "pr-dot-conflict"
								: `pr-dot-${currentSession.prState.toLowerCase()}`
							: null,
					},
				]
			: [];
	// Foreground/dismiss the Review view-tab; onOpenReview re-adds a dismissed
	// one (fired by the PR status chip / "open PR" affordances in SessionViewer).
	function openReview() {
		if (!currentSession) return;
		const id = currentSession.id;
		setReviewClosed((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
		setReviewActive(true);
	}
	function closeReviewTab() {
		if (currentSession) {
			const id = currentSession.id;
			setReviewClosed((prev) => new Set(prev).add(id));
		}
		setReviewActive(false);
	}
	currentSessionRef.current = currentSession;

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

	// Feed the ⌘⇧C copy-link shortcut: the open chat (workspace-scoped when it
	// has one), the open PR preview, or nothing linkable.
	copyLinkPathRef.current =
		route.view === "session" && currentSession
			? chatPath(currentSession)
			: route.view === "pr"
				? prPath(route.repo, route.branch)
				: null;

	// Canonicalize the open chat's URL to /workspace/<wsId>/chat/<chatId> once
	// its workspace is known (replaceState: same history depth, so Back and the
	// mobile page-stack are unaffected). Workspace-less chats keep /session/<id>.
	useEffect(() => {
		if (route.view !== "session" || !currentSession) return;
		const canonical = activeProjectId
			? `${BASE_PATH}/workspace/${encodeURIComponent(activeProjectId)}/chat/${encodeURIComponent(route.id)}`
			: `${BASE_PATH}/session/${encodeURIComponent(route.id)}`;
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
				.filter(
					(s) =>
						liveTab(s) && s.projectId === activeProjectId && !s.sideChatOf,
				)
				.sort(byCreated)
		: currentSession?.worktreeDir?.startsWith("/home/ubuntu/worktrees/")
			? sessions
					.filter(
						(s) =>
							liveTab(s) &&
							s.worktreeDir === currentSession.worktreeDir &&
							!s.sideChatOf,
					)
					.sort(byCreated)
			: currentSession
				? [currentSession]
				: [];
	// The strip's history menu: archived (closed) chats of the same workspace,
	// newest activity first. The open chat is excluded — if it's archived it
	// already holds a live tab via liveTab().
	const archivedChats: UnifiedSession[] = (
		activeProjectId
			? sessions.filter(
					(s) =>
						s.archived && s.projectId === activeProjectId && !s.sideChatOf,
				)
			: currentSession?.worktreeDir?.startsWith("/home/ubuntu/worktrees/")
				? sessions.filter(
						(s) =>
							s.archived &&
							s.worktreeDir === currentSession.worktreeDir &&
							!s.sideChatOf,
					)
				: []
	)
		.filter((s) => s.id !== currentSession?.id)
		.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));

	async function createNewChatFrom(
		src: UnifiedSession,
		mode: "share" | "stack" | "ask",
	): Promise<string> {
		const { id, session } = await newChatApi(src.id, getCurrentUser(), mode);
		// Inject the created session so the viewer renders the new chat immediately
		// — no "Starting…" flash while the sessions poll catches up. If the
		// server didn't return it, synthesize a close-enough copy from the source
		// chat. Sticky: a poll that was already in flight when the chat was created
		// resolves with a list that predates it and would drop a plain inject —
		// flashing the "Starting…" placeholder until the next poll. The server
		// persisted the chat before responding, so the sticky copy is reconciled
		// away by the first fresh poll either way.
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
			{ sticky: true },
		);
		setPendingSessionId(id);
		// This create adds a chat to an existing workspace — clear a stale flag
		// from an earlier workspace create so any residual pending state words
		// itself as "chat", not "workspace".
		setPendingNewWorkspace(false);
		clearTimeout(pendingTimer.current);
		pendingTimer.current = setTimeout(() => {
			setPendingSessionId(null);
			unstick(id);
		}, 30000);
		refresh();
		navigate({ view: "session", id });
		return id;
	}

	// Start a new chat in the current workspace. The tab strip's + button and the
	// SessionViewer ⋯ menu (the only reachable entry point on a phone, where the
	// strip and its + are hidden/hover-revealed) both call this. It creates the
	// sibling chat instantly (browser-tab feel): shares the workspace worktree by
	// default, or stacks/asks. No engine run until the first prompt.
	const handleNewChat = async (mode: "share" | "stack" | "ask") => {
		const src = currentSession || projectChats[0];
		if (!src) return;
		try {
			await createNewChatFrom(src, mode);
		} catch (e) {
			console.error("New chat failed:", e);
		}
	};
	const handleNewChatRef = useRef(handleNewChat);
	handleNewChatRef.current = handleNewChat;

	// Close a tab = archive the chat: it leaves the strip and the active list,
	// but stays recoverable from Archived. An empty chat that never ran has
	// nothing to recover, so it's deleted outright instead of cluttering
	// Archived. The local list updates before the request returns so closing
	// feels instant. Shared by the tab ×, the tab context menu, and ⌘W.
	const closeChat = async (s: UnifiedSession) => {
		const neverRan =
			s.source === "backstage" &&
			!s.claudeSessionId &&
			!s.codexThreadId &&
			!s.transcriptPath &&
			!s.isRunning &&
			!s.queuedCount;
		const wasOpen = currentSession?.id === s.id;
		const next = wasOpen ? projectChats.find((c) => c.id !== s.id) : null;
		let replacementId: string | null = null;
		if (wasOpen && !next) {
			try {
				replacementId = await createNewChatFrom(s, "share");
			} catch (e) {
				console.error("Replacement chat failed:", e);
				return;
			}
		}
		if (neverRan) {
			remove(s.id);
		} else {
			patch(s.id, { archived: true, archivedReason: "manual" });
		}
		if (wasOpen) {
			if (next) navigate({ view: "session", id: next.id });
		}
		try {
			if (neverRan) await deleteSessionApi(s.id, false);
			else {
				const { stoppedRun } = await archiveSessionApi(s.id, true);
				if (stoppedRun) showToast("Archived · stopped the running turn");
			}
		} catch (e) {
			console.error("Close failed:", e);
			if (neverRan) {
				inject(s);
			} else {
				patch(s.id, { archived: false, archivedReason: undefined });
			}
			if (replacementId) {
				remove(replacementId);
				void deleteSessionApi(replacementId, false).catch((cleanupError) =>
					console.error("Replacement cleanup failed:", cleanupError),
				);
			}
			if (wasOpen) navigate({ view: "session", id: s.id });
			return;
		}
		refresh();
	};
	const closeChatRef = useRef(closeChat);
	closeChatRef.current = closeChat;

	// Tab shortcuts for the open chat, matching its context-menu hints: ⌘⌥C
	// copies the concise transcript, ⌘W closes (archives) the tab, ⌘T opens a
	// new tab (sibling chat) in the workspace. Refs keep this mount-once listener
	// reading fresh state. A browser that reserves ⌘W/⌘T for itself (Chrome)
	// never delivers the keydown — there the browser tab opens/closes as always;
	// where the event does arrive (Safari), we take it.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
			const s = currentSessionRef.current;
			if (!s) return;
			// e.code, not e.key: on macOS ⌥C types "ç".
			if (e.altKey && e.code === "KeyC") {
				e.preventDefault();
				void copySessionTranscript(s, "concise", showToast);
			} else if (!e.altKey && e.key.toLowerCase() === "w") {
				e.preventDefault();
				void closeChatRef.current(s);
			} else if (!e.altKey && e.key.toLowerCase() === "t") {
				e.preventDefault();
				void handleNewChatRef.current("share");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [showToast]);

	const handleSessionRunningChange = (id: string, isRunning: boolean) => {
		// Keep the existing run-start stamp when the session was already running:
		// the viewer relays a session_status on every (re)open, and re-stamping
		// here reset the sidebar's elapsed ticker to zero on each session switch.
		const prev = sessionsRef.current.find((s) => s.id === id);
		patch(id, {
			isRunning,
			runStartedAt: isRunning
				? (prev?.isRunning ? prev.runStartedAt : undefined) ||
					new Date().toISOString()
				: undefined,
		});
	};

	// Plain title shown in the top bar for non-session views (session routes let
	// the SessionViewer portal its own header in instead). Home stays blank so the
	// bar collapses (`.detail-topbar:empty`).
	const topbarTitle: string =
		route.view === "archived"
				? "Archived"
				: route.view === "new"
					? "New session"
					: route.view === "pr"
						? "Pull request"
						: "";

	// Mobile top-bar brand: logo only, as the account/settings sheet trigger.
	// On desktop that menu lives in the footer user row instead, so the top stays
	// just the title + the collapse toggle.
	const brand = (
		<div className="app-brand">
			<SettingsMenu
				variant="brand"
				onOpenSettings={() => navigate({ view: "settings" })}
				connected={connected}
			/>
		</div>
	);

	// The "toggle left sidebar" panel glyph — a framed rectangle with a divider
	// marking the collapsible left column. Reused by the brand-row collapse button
	// and the floating re-open control. Size 28 to match the right-panel toggle
	// (IconSidebarRight) in the session header, and to carry the same visual
	// weight as the fuller play/globe glyphs there (a framed rectangle reads a
	// hair lighter than a filled triangle / globe at the same nominal size).
	const panelIcon = <IconSidebarLeft size={26} />;

	return (
		<UserGate>
			<RestartOverlay connected={connected} addHandler={addHandler} />
			<MediaLightboxHost />
			<ToastHost />
			<div className="app">
					{/* Reclaimed titlebar in installed-PWA Window Controls Overlay
					    mode (desktop). Hidden (display:none) everywhere else. */}
					<TitleBar />
				{/* Mobile-only top bar. On the sidebar-root page it shows the brand;
				    on a pushed page (a session or other view) the brand is replaced by
				    a Back chevron that pops back to the root, iOS-style. On desktop the
				    brand/user live in the sidebar and this bar is hidden. The catch-up
				    deck renders its own header (back + "N Left" + new-workspace), so we
				    suppress this one there to avoid a duplicate back bar. */}
				{route.view !== "catchup" && (
				<header
					className={`app-header${
						!mobileDetail && rootListScrolled ? " app-header-scrolled" : ""
					}${mobileDetail ? " app-header-detail" : ""}${
						route.view === "home" || route.view === "session"
							? " app-header-overlay"
							: ""
					}`}
				>
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
										strokeWidth="2.25"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							</button>
						) : (
							<>
								{brand}
								{/* Update nudge lives in the top bar on phones, right after
								    the brand logo (desktop keeps the sidebar-bottom toast). */}
								<UpdatePill addHandler={addHandler} variant="pill" />
							</>
						)}
					</div>
					{/* Centered page title on pushed pages, iOS-sheet style. Sessions
					    show the workspace name (per-chat titles live on the tabs) plus a
					    working dot while the engine runs; other views show their plain
					    title. Desktop hides the whole bar. */}
					{mobileDetail && (
						<span
							className={`app-header-title ${
								route.view === "session" && currentSession
									? "session-settings-trigger app-header-title-tappable"
									: ""
								}`}
								{...(route.view === "session" && currentSession
									? {
										role: "button",
										tabIndex: 0,
										onClick: () =>
											window.dispatchEvent(
												new Event("backstage:toggle-session-settings"),
											),
									}
									: {})}
						>
							{/* Slack-header layout: the repo tile leads the pill (portaled in
							    by SessionViewer), with the name on top and the model · cost
							    metadata below it in a stacked column. The whole pill is one
							    tap target that opens the session's deeper info page. */}
							{route.view === "session" && currentSession && (
								<span className="app-header-repo" ref={setHeaderRepoEl} />
							)}
							<span className="app-header-title-col">
								<span className="app-header-title-row">
									<span className="app-header-title-text">
										{route.view === "session"
											? (activeProjectId
												? projects.find((p) => p.id === activeProjectId)?.name
												: undefined) ||
											currentSession?.title ||
											""
										: topbarTitle}
									</span>
								</span>
								{route.view === "session" && currentSession && (
									// Filled by SessionViewer's portal (compact model selector).
									<span className="app-header-model" ref={setHeaderModelEl} />
								)}
							</span>
						</span>
					)}
					<div className="app-header-actions" ref={setHeaderActionsEl}>
						{/* On the root page the actions slot is otherwise empty (session
						    actions only portal in on pushed pages) — it carries Search,
						    which lives in the top bar on phones instead of the sidebar. */}
						{!mobileDetail && (
							<button
								className="mobile-search-btn"
								onClick={() => setSearchOpen(true)}
								aria-label="Search sessions"
							>
								<IconSearch size={22} />
							</button>
						)}
					</div>
				</header>
				)}

				{settingsActive && (
					<Settings
						onBack={goBack}
						section={
							route.view === "settings"
								? route.section
								: isToolView(route.view)
									? route.view
									: undefined
						}
						onShowRoot={() => navigate({ view: "settings" })}
						onSelect={(key) =>
							key === "notes"
								? navigate({ view: "notes", sel: null })
								: isToolView(key)
									? navigate({ view: key })
									: navigate({ view: "settings", section: key })
						}
					>
						{route.view === "automations" ? (
							<Automations
								onOpenSession={(id) => navigate({ view: "session", id })}
								selectedId={route.id}
								onSelect={(id) =>
									navigate({ view: "automations", id: id || undefined })
								}
							/>
						) : route.view === "security" ? (
							<Security
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "goals" ? (
							<Goals
								onOpenSession={(id) => navigate({ view: "session", id })}
								selectedId={route.id}
								onSelect={(id) =>
									navigate({ view: "goals", id: id || undefined })
								}
							/>
						) : route.view === "actions" ? (
							<Actions
								onOpenSession={(id) => navigate({ view: "session", id })}
								selectedId={route.id}
								onSelect={(id) =>
									navigate({ view: "actions", id: id || undefined })
								}
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
						) : null}
					</Settings>
				)}
				{/* On phones the app-body stays mounted beneath the Settings sheet
				    (the sheet floats over the root list); on desktop Settings is a
				    full page and replaces it. */}
				{(!settingsActive || isPhone) && (
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
						{/* Desktop brand row: the whole Backstage brand (logo + wordmark)
						    opens the account/settings menu on the left, and the collapse
						    toggle on the right. Hidden on mobile, where the top bar carries
						    the brand instead. */}
						<div className="sidebar-brand">
							<SettingsMenu
								variant="top"
								onOpenSettings={() => navigate({ view: "settings" })}
								connected={connected}
							/>
							<div className="sidebar-brand-actions">
								<Tooltip
									label="Search sessions"
									side="bottom"
									shortcut={["⌘", "K"]}
								>
									<button
										className="sidebar-toggle-btn"
										onClick={() => setSearchOpen(true)}
										aria-label="Search sessions"
									>
										{/* Optically larger than the 28 panel glyph beside it: the
										    magnifier is a small circle + thin handle, so it needs more
										    nominal size to carry the same weight as the globe/play/panel
										    icons in the session header. */}
										<IconSearch size={28} />
									</button>
								</Tooltip>
								<Tooltip
									label="Hide sidebar"
									side="bottom"
									shortcut={["⌘", "B"]}
								>
									<button
										className="sidebar-toggle-btn"
										onClick={toggleSidebarCollapsed}
										aria-label="Hide sidebar"
									>
										{panelIcon}
									</button>
								</Tooltip>
							</div>
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
							reviewsActive={route.view === "reviews"}
							onOpenReviews={() => navigate({ view: "reviews" })}
							onOpenAutomation={(name) =>
								navigate({ view: "automations", id: name })
							}
							prTinderActive={route.view === "prtinder"}
							onOpenPrTinder={() => navigate({ view: "prtinder" })}
							supportTinderActive={route.view === "supporttinder"}
							onOpenSupportTinder={() => navigate({ view: "supporttinder" })}
							watercoolerActive={route.view === "watercooler"}
							onOpenWatercooler={() => navigate({ view: "watercooler" })}
							watercoolerUnread={chatUnread}
							reportsActive={route.view === "reports"}
							onOpenReports={() => navigate({ view: "reports" })}
							onSelect={(s) => navigate({ view: "session", id: s.id })}
							onOpenPr={(repo, branch) =>
								navigate({ view: "pr", repo, branch })
							}
							selectedPr={
								route.view === "pr"
									? { repo: route.repo, branch: route.branch }
									: null
							}
							onOpenSupportThread={(threadId) =>
								navigate({ view: "support", threadId })
							}
							selectedSupportThreadId={
								route.view === "support" ? route.threadId : null
							}
							onNewSession={() => openPalette()}
							onNewSessionInRepo={(repo) =>
								setPalette({ open: true, repo })
							}
							onOpenProject={(id) => {
								// Open the workspace's first chat (oldest, matching the tab
								// strip's order — there's always one post-migration). An empty
								// workspace opens the new-chat palette scoped to it.
								const chats = sessions
									.filter((s) => !s.archived && s.projectId === id)
									.sort((a, b) =>
										(a.createdAt || "").localeCompare(b.createdAt || ""),
									);
								if (chats.length) {
									// Picked a workspace to work in — land in its first chat
									// with the composer focused, ready to type.
									setFocusComposerOnOpen(true);
									navigate({ view: "session", id: chats[0].id });
								} else {
									const p = projects.find((x) => x.id === id);
									// Default the new chat onto the workspace's own branch (share
									// its worktree) when it has one — e.g. all chats archived.
									setPalette({
										open: true,
										projectId: id,
										repo: p?.repo,
										branch: p?.branch,
									});
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
							onToast={showToast}
							onOpenNote={(id) =>
								navigate({ view: "notes", sel: { kind: "note", id } })
							}
							// Only hand the sidebar the top-bar actions slot on the root
							// page — on a pushed page (chat, etc.) the sidebar is still
							// mounted underneath and would portal its filter button into
							// the chat's top bar.
							headerActionsEl={mobileDetail ? null : headerActionsEl}
							onListScrolledChange={setRootListScrolled}
							onOpenArchived={() => navigate({ view: "archived" })}
							onOpenCatchUp={() => navigate({ view: "catchup" })}
							catchUpActive={route.view === "catchup"}
							archivedActive={route.view === "archived"}
							onArchive={async (s, next) => {
								patch(s.id, { archived: true, archivedReason: "manual" });
								const wasOpen = route.view === "session" && route.id === s.id;
								if (wasOpen) {
									if (next) navigate({ view: "session", id: next.id });
									else goBack();
								}
								try {
									const { stoppedRun } = await archiveSessionApi(s.id, true);
									if (stoppedRun)
										showToast("Archived · stopped the running turn");
								} catch (e) {
									console.error("Archive failed:", e);
									patch(s.id, { archived: false, archivedReason: undefined });
									if (wasOpen) navigate({ view: "session", id: s.id });
									return;
								}
								dropStalePins([s]);
								refresh();
							}}
							onArchiveWorkspace={async (chats, next) => {
								// Archive a whole workspace = archive every member chat (the
								// archive registry is per-chat; the workspace row disappears
								// once no live chats remain).
								for (const chat of chats) {
									patch(chat.id, { archived: true, archivedReason: "manual" });
								}
								const openChatId =
									route.view === "session" &&
									chats.some((c) => c.id === route.id)
										? route.id
										: null;
								if (openChatId) {
									if (next) navigate({ view: "session", id: next.id });
									else goBack();
								}
								try {
									const results = await Promise.all(
										chats.map((c) => archiveSessionApi(c.id, true)),
									);
									const stopped = results.filter((r) => r.stoppedRun).length;
									if (stopped > 0)
										showToast(
											`Archived · stopped ${stopped} running turn${stopped === 1 ? "" : "s"}`,
										);
								} catch (e) {
									console.error("Archive workspace failed:", e);
									for (const chat of chats) {
										patch(chat.id, {
											archived: false,
											archivedReason: undefined,
										});
									}
									if (openChatId) navigate({ view: "session", id: openChatId });
									return;
								}
								dropStalePins(chats);
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
							onSetStatus={async (chats, status) => {
								// Optimistically move the row, then persist per chat.
								for (const c of chats)
									patch(c.id, { manualStatus: status ?? undefined });
								try {
									await Promise.all(
										chats.map((c) => setSessionStatusApi(c.id, status)),
									);
								} catch (e) {
									console.error("Set status failed:", e);
								}
								refresh();
							}}
						/>
						{/* Desktop: docked toast at the sidebar bottom. On phones the
						    update nudge moves to the top bar (next to the brand). */}
						{!isPhone && <UpdatePill addHandler={addHandler} />}
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
						<Tooltip label="Show sidebar" side="right" shortcut={["⌘", "B"]}>
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
							archived={archivedChats}
							activeId={reviewActive ? null : currentSession?.id || null}
							colors={tabColors}
							onSelect={(s) => {
								setReviewActive(false);
								navigate({ view: "session", id: s.id });
							}}
							onSetColor={(key, color) => setTabColors(setTabColor(key, color))}
							viewTabs={reviewViewTabs}
							onSelectView={() => setReviewActive(true)}
							onCloseView={closeReviewTab}
							onNewChat={handleNewChat}
							onRename={async (id, title) => {
								try {
									await renameSessionApi(id, title);
								} catch (e) {
									console.error("Rename failed:", e);
								}
								refresh();
							}}
							onClose={closeChat}
							onToast={showToast}
							onRestore={async (s) => {
								try {
									await archiveSessionApi(s.id, false);
								} catch (e) {
									console.error("Restore failed:", e);
								}
								refresh();
							}}
						/>
						{route.view === "pr" ? (
							<PrPreview
								key={`${route.repo}:${route.branch}`}
								repo={route.repo}
								branch={route.branch}
								connected={connected}
								send={send}
								addHandler={addHandler}
								sessions={sessions}
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "reports" ? (
							<Reports
								selectedAutomationId={route.automationId}
								selectedReportId={route.reportId}
								onSelect={(automationId, reportId) =>
									navigate({ view: "reports", automationId, reportId }, { replace: true })
								}
								onBack={() => navigate({ view: "reports" }, { replace: true })}
								onOpenSession={(id) => navigate({ view: "session", id })}
								onOpenSupport={(threadId) => navigate({ view: "support", threadId })}
								addHandler={addHandler}
							/>
						) : route.view === "support" ? (
							<SupportPreview
								key={route.threadId}
								threadId={route.threadId}
								connected={connected}
								send={send}
								addHandler={addHandler}
								onOpenSession={(id) =>
									navigate({ view: "session", id })
								}
							/>
						) : route.view === "reviews" ? (
							<Reviews
								sessions={sessions}
								selectedId={route.id ?? null}
								onSelect={(id) => navigate({ view: "reviews", id })}
								onOpenSession={(id) => navigate({ view: "session", id })}
								onAddToInput={addToSessionInput}
								send={send}
							/>
						) : route.view === "archived" ? (
							<Archived
								sessions={sessions}
								onSelect={(s) => navigate({ view: "session", id: s.id })}
								onChanged={refresh}
							/>
						) : route.view === "prtinder" ? (
							<PrTinder onExit={goBack} />
						) : route.view === "supporttinder" ? (
							<SupportTinder
								onExit={goBack}
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "watercooler" ? (
							<TeamChat
								channel="watercooler"
								user={getCurrentUser()}
								sessions={sessions}
								projects={projects}
								send={send}
								addHandler={addHandler}
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "catchup" ? (
							<CatchUpDeck
								sessions={sessions}
								projects={projects}
								send={send}
								connected={connected}
								onArchive={async (chats) => {
									try {
										await Promise.all(
											chats.map((c) => archiveSessionApi(c.id, true)),
										);
									} catch (e) {
										console.error("Archive failed:", e);
									}
									refresh();
								}}
								onOpenSession={(id) => navigate({ view: "session", id })}
								onNewWorkspace={() => openPalette()}
								onExit={goBack}
							/>
						) : route.view === "session" ? (
							currentSession ? (
								<SessionViewer
									key={currentSession.id}
									session={currentSession}
									onBack={goBack}
									onArchived={(stoppedRun) => {
										if (stoppedRun)
											showToast("Archived · stopped the running turn");
									}}
									send={send}
									addHandler={addHandler}
									connected={connected}
									initialPending={pendingInitialPrompts[currentSession.id]}
									topbarEl={topbarEl}
									headerActionsEl={headerActionsEl}
									headerModelEl={headerModelEl}
									headerRepoEl={headerRepoEl}
									rightPanelEl={rightPanelEl}
									newChatSeq={newChatSeq}
									autoFocusComposer={focusComposerOnOpen}
									composerPrefillExternal={
										sessionComposerPrefills[currentSession.id] ?? null
									}
									onComposerPrefillConsumed={(seq) =>
										setSessionComposerPrefills((prev) => {
											const cur = prev[currentSession.id];
											if (!cur || cur.seq !== seq) return prev;
											const next = { ...prev };
											delete next[currentSession.id];
											return next;
										})
									}
									workspaceChats={projectChats}
									showReview={reviewActive}
									onOpenReview={openReview}
									allSessions={sessions}
									allProjects={projects}
									onNewChat={handleNewChat}
									parentSession={
										currentSession.parentSessionId
											? (() => {
													const p = sessions.find(
														(s) => s.id === currentSession.parentSessionId,
													);
													return p
														? { id: p.id, title: p.title, model: p.model }
														: null;
												})()
											: null
									}
									workerSessions={sessions
										.filter((s) => s.parentSessionId === currentSession.id)
										.map((s) => ({
											id: s.id,
											title: s.title,
											model: s.model,
											isRunning: s.isRunning,
										}))}
									onOpenSession={(id) => navigate({ view: "session", id })}
									onRunningChange={handleSessionRunningChange}
									onReviewChange={(id, req) =>
										patch(id, { reviewRequest: req ?? undefined })
									}
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
								onCreateStarted={(draft) => {
									pendingCreateDraftRef.current = {
										...draft,
										startedAt: new Date().toISOString(),
										user: getCurrentUser(),
									};
								}}
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

				{/* Mobile-only floating + on the root list page — thumb-reach shortcut
				    to the new-session palette (desktop hides it via CSS; the sidebar's
				    own + covers that layout). */}
				{!mobileDetail && (
					<button
						className="mobile-fab"
						onClick={() => openPalette()}
						aria-label="New session"
					>
						<svg
							width="26"
							height="26"
							viewBox="0 0 16 16"
							fill="none"
							aria-hidden="true"
						>
							<path
								d="M8 2.5v11M2.5 8h11"
								stroke="currentColor"
								strokeWidth="1.8"
								strokeLinecap="round"
							/>
						</svg>
					</button>
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
						onCreateStarted={(draft) => {
							pendingCreateDraftRef.current = {
								...draft,
								startedAt: new Date().toISOString(),
								user: getCurrentUser(),
							};
						}}
					/>
				)}
			</div>
		</UserGate>
	);
}

// The preview interstitial renders INSTEAD of the app (and outside UserGate —
// it must work in cold-storage contexts like the iOS PWA's in-app browser).
// The server's SPA fallback serves the shell for this path; see PreviewWait.
const previewWaitSessionId = matchPreviewWaitRoute(location.pathname);

const root = createRoot(document.getElementById("root")!);
root.render(
	previewWaitSessionId ? (
		<PreviewWait sessionId={previewWaitSessionId} />
	) : (
		<TooltipProvider>
			<App />
		</TooltipProvider>
	),
);
