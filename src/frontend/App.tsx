import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { Home } from "./components/Home";
import { Automations } from "./components/Automations";
import { Wiki } from "./components/Wiki";
import { Connections } from "./components/Connections";
import { Factory } from "./components/Factory";
import { Archived } from "./components/Archived";
import { Reviews } from "./components/Reviews";
import { UserPicker, UserGate } from "./components/UserPicker";
import { SessionTabs } from "./components/SessionTabs";
import { RestartOverlay } from "./components/RestartOverlay";
import { UpdateToast } from "./components/UpdateToast";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import { useSidebarSwipe } from "./hooks/useSidebarSwipe";
import { archiveSessionApi } from "./lib/api";
import { pushRecent } from "./lib/recents";
import { getPins, togglePin, onPinsChanged } from "./lib/pins";
import type { UnifiedSession } from "./lib/types";
import "./styles/global.css";

type Route =
  | { view: "home" }
  | { view: "new"; prompt?: string }
  | { view: "session"; id: string }
  | { view: "reviews"; id?: string }
  | { view: "automations" }
  | { view: "wiki"; path: string | null }
  | { view: "connections" }
  | { view: "factory" }
  | { view: "archived" };

function parseRoute(pathname: string): Route {
  const sessionMatch = pathname.match(/^\/backstage\/session\/(.+)$/);
  if (sessionMatch) return { view: "session", id: decodeURIComponent(sessionMatch[1]) };
  if (pathname === "/backstage/new") return { view: "new" };
  if (pathname === "/backstage/automations") return { view: "automations" };
  if (pathname === "/backstage/connections") return { view: "connections" };
  if (pathname === "/backstage/factory") return { view: "factory" };
  if (pathname === "/backstage/archived") return { view: "archived" };
  const reviewsMatch = pathname.match(/^\/backstage\/reviews(?:\/(.+))?$/);
  if (reviewsMatch) return { view: "reviews", id: reviewsMatch[1] ? decodeURIComponent(reviewsMatch[1]) : undefined };
  const wikiMatch = pathname.match(/^\/backstage\/wiki(?:\/(.*))?$/);
  if (wikiMatch) return { view: "wiki", path: wikiMatch[1] ? decodeURIComponent(wikiMatch[1]) : null };
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
    case "connections":
      return "/backstage/connections";
    case "factory":
      return "/backstage/factory";
    case "archived":
      return "/backstage/archived";
    case "reviews":
      return route.id ? `/backstage/reviews/${encodeURIComponent(route.id)}` : "/backstage/reviews";
    case "wiki":
      return route.path
        ? `/backstage/wiki/${route.path.split("/").map(encodeURIComponent).join("/")}`
        : "/backstage/wiki";
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
  // A session we've just navigated to that may not be in the polled list yet
  // (create → navigate races the async refresh, and the file is only written
  // once the run's `init` lands). While pending, the detail pane shows
  // "Loading…" instead of flashing "Session not found".
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pins, setPins] = useState<string[]>(getPins);

  useEffect(() => onPinsChanged(() => setPins(getPins())), []);

  useSidebarSwipe({ open: sidebarOpen, setOpen: setSidebarOpen, panelRef: sidebarRef });

  function navigate(route: Route) {
    history.pushState(null, "", routePath(route));
    setRoute(route);
    setSidebarOpen(false);
  }

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
        pendingTimer.current = setTimeout(() => setPendingSessionId(null), 30000);
        refresh();
        navigate({ view: "session", id: msg.id });
      }
    });
  }, [addHandler, refresh]);

  // Clear the pending flag once the session shows up in the polled list.
  useEffect(() => {
    if (
      pendingSessionId &&
      sessions.some((s) => s.id === pendingSessionId || s.aliasIds?.includes(pendingSessionId))
    ) {
      setPendingSessionId(null);
      clearTimeout(pendingTimer.current);
    }
  }, [sessions, pendingSessionId]);

  const currentSession: UnifiedSession | null =
    route.view === "session"
      ? sessions.find((s) => s.id === route.id || s.aliasIds?.includes(route.id)) || null
      : null;

  // Pinned sessions shown as tabs above the title (pin order preserved).
  const pinnedTabs = pins
    .map((id) => sessions.find((s) => s.id === id || s.aliasIds?.includes(id)))
    .filter((s): s is UnifiedSession => Boolean(s));

  const activeView =
    route.view === "automations" ||
    route.view === "wiki" ||
    route.view === "connections" ||
    route.view === "factory" ||
    route.view === "reviews"
      ? route.view
      : ("sessions" as const);

  return (
    <UserGate>
      <RestartOverlay connected={connected} addHandler={addHandler} />
      <UpdateToast addHandler={addHandler} />
      <div className="app">
        <header className="app-header">
          <div className="app-header-left">
            <button
              className="hamburger"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label="Toggle sidebar"
            >
              <span /><span /><span />
            </button>
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
          </div>
          <div className="app-header-right">
            <span className={`connection-dot ${connected ? "connected" : "disconnected"}`} />
            <UserPicker />
          </div>
        </header>

        <div className="app-body">
          {/* Overlay to close sidebar on mobile */}
          {sidebarOpen && (
            <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
          )}

          <div ref={sidebarRef} className={`sidebar-container ${sidebarOpen ? "sidebar-open" : ""}`}>
            <Sidebar
              sessions={sessions}
              selectedId={currentSession?.id || null}
              activeView={activeView}
              onNavigate={(view) =>
                navigate(
                  view === "sessions"
                    ? { view: "home" }
                    : view === "wiki"
                      ? { view: "wiki", path: null }
                      : { view }
                )
              }
              onSelect={(s) => navigate({ view: "session", id: s.id })}
              onNewSession={() => navigate({ view: "new" })}
              onOpenArchived={() => navigate({ view: "archived" })}
              onArchive={async (s) => {
                try {
                  await archiveSessionApi(s.id, true);
                } catch (e) {
                  console.error("Archive failed:", e);
                }
                refresh();
              }}
            />
          </div>

          <main className="detail-pane">
            <SessionTabs
              tabs={pinnedTabs}
              activeId={currentSession?.id || null}
              onSelect={(s) => navigate({ view: "session", id: s.id })}
              onUnpin={(id) => setPins(togglePin(id))}
            />
            {route.view === "new" ? (
              <NewSession
                onBack={() => navigate({ view: "home" })}
                send={send}
                addHandler={addHandler}
                connected={connected}
              />
            ) : route.view === "automations" ? (
              <Automations onOpenSession={(id) => navigate({ view: "session", id })} />
            ) : route.view === "connections" ? (
              <Connections />
            ) : route.view === "factory" ? (
              <Factory
                sessions={sessions}
                loading={loading}
                onOpenSession={(id) => navigate({ view: "session", id })}
              />
            ) : route.view === "reviews" ? (
              <Reviews
                sessions={sessions}
                selectedId={route.id ?? null}
                onSelect={(id) => navigate({ view: "reviews", id })}
                onOpenSession={(id) => navigate({ view: "session", id })}
              />
            ) : route.view === "archived" ? (
              <Archived
                sessions={sessions}
                onSelect={(s) => navigate({ view: "session", id: s.id })}
                onChanged={refresh}
              />
            ) : route.view === "wiki" ? (
              <Wiki
                docPath={route.path}
                onNavigate={(path) => navigate({ view: "wiki", path })}
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
                />
              ) : (
                <div className="detail-empty">
                  <div className="detail-empty-inner">
                    {(() => {
                      const isLoading = loading || route.id === pendingSessionId;
                      return (
                        <>
                          <div className="detail-empty-title">
                            {isLoading ? "Loading session…" : "Session not found"}
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
                onNewSession={(prompt) => navigate({ view: "new", prompt })}
              />
            )}
          </main>
        </div>
      </div>
    </UserGate>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
