import React, { useState, useMemo, useEffect } from "react";
import type { UnifiedSession, SessionSource } from "../lib/types";
import { relativeTime } from "../lib/api";
import { useCurrentUser } from "./UserPicker";
import { getPins, onPinsChanged } from "../lib/pins";
import { getRecents, onRecentsChanged } from "../lib/recents";

const RECENTLY_OPENED_COUNT = 6;

const SOURCE_COLORS: Record<string, string> = {
  slack: "#a36ba5",
  linear: "#7b86e8",
  backstage: "#5eead4",
  cli: "#6B7280",
};

const AUTOMATION_COLOR = "#d29922";

const SOURCE_ORDER: SessionSource[] = ["slack", "linear", "backstage", "cli"];

export type NavView = "sessions" | "reviews" | "automations" | "wiki" | "connections" | "factory";

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  activeView: NavView;
  onNavigate: (view: NavView) => void;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
  onOpenArchived: () => void;
  onArchive: (session: UnifiedSession) => void;
}

const NAV_ITEMS: Array<{ view: NavView; label: string; icon: React.ReactNode }> = [
  {
    view: "sessions",
    label: "Sessions",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M2.5 4h11M2.5 8h11M2.5 12h7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: "reviews",
    label: "Reviews",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="4" cy="4" r="1.6" />
        <circle cx="4" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <path d="M4 5.6v4.8M12 10.4V8a2.4 2.4 0 0 0-2.4-2.4H7.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.8 4.2L7.2 5.6l1.6 1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    view: "automations",
    label: "Automations",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    view: "wiki",
    label: "Wiki",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M3 2.5h7a2 2 0 0 1 2 2v9l-3-1.8-3 1.8-3-1.8V2.5z" strokeLinejoin="round" transform="translate(0.5,0)" />
      </svg>
    ),
  },
  {
    view: "connections",
    label: "Connections",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="4.5" cy="8" r="2" />
        <circle cx="11.5" cy="4" r="2" />
        <circle cx="11.5" cy="12" r="2" />
        <path d="M6.3 7.1l3.4-2.2M6.3 8.9l3.4 2.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: "factory",
    label: "Factory",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M2 13.5h12M2.5 13.5V7l3.5 2.2V7l3.5 2.2V4.2l3.5-1v10.3" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    ),
  },
];

interface Group {
  key: string;
  label: string;
  dotColor: string | null;
  items: UnifiedSession[];
}

const EXPANDED_KEY = "michael-sidebar-expanded";

function readExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '["recently","pinned","mine"]'));
  } catch {
    return new Set(["recently", "pinned", "mine"]);
  }
}

export function Sidebar({
  sessions,
  selectedId,
  activeView,
  onNavigate,
  onSelect,
  onNewSession,
  onOpenArchived,
  onArchive,
}: Props) {
  const [search, setSearch] = useState("");
  // Groups are collapsed by default; the expanded set persists per browser
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [pins, setPins] = useState<string[]>(getPins);
  const [recents, setRecents] = useState<string[]>(getRecents);
  const currentUser = useCurrentUser();

  useEffect(() => onPinsChanged(() => setPins(getPins())), []);
  useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);

  const archivedCount = useMemo(() => sessions.filter((s) => s.archived).length, [sessions]);

  const filtered = useMemo(() => {
    const visible = sessions.filter((s) => !s.archived);
    if (!search) return visible;
    const q = search.toLowerCase();
    return visible.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.branch || "").toLowerCase().includes(q) ||
        (s.startedBy || "").toLowerCase().includes(q) ||
        (s.automation || "").toLowerCase().includes(q)
    );
  }, [sessions, search]);

  const groups = useMemo(() => {
    const out: Group[] = [];
    const user = currentUser.toLowerCase();
    const pinSet = new Set(pins);

    // "Recently opened": a quick-access shortcut to the sessions you last opened
    // (newest first). Hidden while searching; items still appear in their normal
    // groups below. Only the freshest few are shown.
    if (!search.trim()) {
      const byId = new Map(filtered.map((s) => [s.id, s] as const));
      const recentItems = recents
        .map((id) => byId.get(id))
        .filter((s): s is UnifiedSession => Boolean(s))
        .slice(0, RECENTLY_OPENED_COUNT);
      if (recentItems.length > 0) {
        out.push({ key: "recently", label: "Recently opened", dotColor: null, items: recentItems });
      }
    }

    const pinned = filtered.filter((s) => pinSet.has(s.id));
    if (pinned.length > 0) {
      out.push({ key: "pinned", label: "Pinned", dotColor: null, items: pinned });
    }

    // "Mine": sessions started by the current user (automations excluded)
    const mine = filtered.filter(
      (s) =>
        !s.automation &&
        !pinSet.has(s.id) &&
        s.startedBy &&
        s.startedBy.toLowerCase() === user
    );
    if (mine.length > 0) {
      out.push({ key: "mine", label: "My sessions", dotColor: null, items: mine });
    }

    // One group per automation
    const byAutomation = new Map<string, UnifiedSession[]>();
    for (const s of filtered) {
      if (!s.automation || pinSet.has(s.id)) continue;
      const list = byAutomation.get(s.automation) || [];
      list.push(s);
      byAutomation.set(s.automation, list);
    }
    for (const name of Array.from(byAutomation.keys()).sort()) {
      out.push({
        key: `auto:${name}`,
        label: name,
        dotColor: AUTOMATION_COLOR,
        items: byAutomation.get(name)!,
      });
    }

    // Source groups (automation sessions live in their own groups above)
    for (const source of SOURCE_ORDER) {
      const items = filtered.filter(
        (s) => s.source === source && !s.automation && !pinSet.has(s.id)
      );
      if (items.length > 0) {
        out.push({
          key: source,
          label: source,
          dotColor: SOURCE_COLORS[source] || "#6B7280",
          items,
        });
      }
    }
    return out;
  }, [filtered, currentUser, pins, recents, search]);

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  // While searching, show everything that matched
  const isOpen = (key: string) => search.trim().length > 0 || expanded.has(key);

  // Distinct open PRs (deduped by URL) — shown as a badge on the Reviews tab.
  const openPrCount = useMemo(() => {
    const urls = new Set<string>();
    for (const s of sessions) {
      if (s.prUrl && s.prState === "OPEN" && !s.archived) urls.add(s.prUrl);
    }
    return urls.size;
  }, [sessions]);

  return (
    <div className="sidebar">
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            className={`sidebar-nav-item ${activeView === item.view ? "active" : ""}`}
            onClick={() => onNavigate(item.view)}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            {item.label}
            {item.view === "reviews" && openPrCount > 0 && (
              <span className="sidebar-nav-count">{openPrCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-section-label">Sessions</div>

      <div className="sidebar-header">
        <div className="sidebar-search-wrap">
          <svg className="sidebar-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 14L10.7 10.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            className="sidebar-search"
            type="text"
            placeholder="Search sessions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button className="sidebar-new-btn" onClick={onNewSession} title="New session">
          +
        </button>
      </div>

      <div className="sidebar-list">
        {groups.length === 0 && <div className="sidebar-empty">No sessions</div>}
        {groups.map((group) => (
          <div key={group.key} className="sidebar-group">
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
              <span className="sidebar-group-count">{group.items.length}</span>
              <span className="sidebar-group-chevron">
                {isOpen(group.key) ? "▾" : "▸"}
              </span>
            </button>

            {isOpen(group.key) &&
              group.items.map((s) => (
                <SidebarItem
                  key={s.id}
                  session={s}
                  selected={s.id === selectedId}
                  onClick={() => onSelect(s)}
                  onArchive={() => onArchive(s)}
                />
              ))}
          </div>
        ))}

        {archivedCount > 0 && (
          <button className="sidebar-archived-link" onClick={onOpenArchived}>
            Archived ({archivedCount}) →
          </button>
        )}
      </div>
    </div>
  );
}

function SidebarItem({
  session,
  selected,
  onClick,
  onArchive,
}: {
  session: UnifiedSession;
  selected: boolean;
  onClick: () => void;
  onArchive: () => void;
}) {
  const running = session.isRunning;
  const recent = isRecent(session.lastActivity);

  const metaParts: React.ReactNode[] = [];
  if (session.startedBy && !session.automation) {
    metaParts.push(<span key="u">{session.startedBy}</span>);
  }
  metaParts.push(<span key="t">{relativeTime(session.lastActivity)}</span>);
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
        {session.prState === "MERGED" ? "merged" : session.prState === "CLOSED" ? "closed" : "PR open"}
      </span>
    );
  }
  if (session.linearIssue) {
    metaParts.push(
      <span key="lin" className="sidebar-meta-linear">
        {session.linearIssue.identifier}
      </span>
    );
  }

  return (
    <button
      className={`sidebar-item ${selected ? "sidebar-item-selected" : ""}`}
      onClick={onClick}
    >
      <div className="sidebar-item-top">
        {(running || recent) && (
          <span
            className={`sidebar-item-status ${running ? "sidebar-status-running" : "sidebar-status-recent"}`}
          />
        )}
        <span className="sidebar-item-title">{session.title}</span>
      </div>
      <div className="sidebar-item-meta">
        {metaParts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sidebar-meta-sep">·</span>}
            {part}
          </React.Fragment>
        ))}
      </div>
      <span
        className="sidebar-item-x"
        role="button"
        aria-label="Archive session"
        title="Archive session"
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
      >
        ×
      </span>
    </button>
  );
}

function isRecent(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 3_600_000;
}
