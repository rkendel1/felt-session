import React, { useMemo } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";

// A Factorio-flavoured overview of everything moving through Michael: sources
// "mine" raw work on the left, sessions get "assembled" in the middle (running /
// waiting / buffer), and anything with a PR floats out to the GitHub island on
// the right. Pure derived view over the polled sessions list — no extra fetch.

interface Props {
  sessions: UnifiedSession[];
  loading: boolean;
  onOpenSession: (id: string) => void;
}

type SrcKey = "slack" | "linear" | "backstage" | "cli" | "automation";

const SOURCE_META: Record<SrcKey, { label: string; color: string; glyph: string }> = {
  slack: { label: "Slack", color: "#a36ba5", glyph: "#" },
  linear: { label: "Linear", color: "#7b86e8", glyph: "◳" },
  backstage: { label: "Backstage", color: "#5eead4", glyph: "▣" },
  cli: { label: "CLI", color: "#8b94a3", glyph: ">_" },
  automation: { label: "Automation", color: "#d29922", glyph: "⚙" },
};

const SOURCE_ORDER: SrcKey[] = ["slack", "linear", "backstage", "cli", "automation"];

const STATION_CAP = 9;
const RECENT_MS = 24 * 60 * 60 * 1000;

function srcKey(s: UnifiedSession): SrcKey {
  if (s.automation) return "automation";
  return (["slack", "linear", "backstage", "cli"].includes(s.source) ? s.source : "cli") as SrcKey;
}

const cssVar = (color: string) => ({ ["--src"]: color } as React.CSSProperties);

export function Factory({ sessions, loading, onOpenSession }: Props) {
  const model = useMemo(() => {
    const active = sessions.filter((s) => !s.archived);

    const waiting = active.filter((s) => s.waitingForInput);
    const running = active.filter((s) => s.isRunning && !s.waitingForInput);
    const queued = active.filter(
      (s) => !s.isRunning && !s.waitingForInput && (s.queuedCount || 0) > 0
    );

    const busy = new Set([...waiting, ...running, ...queued].map((s) => s.id));
    const now = Date.now();
    const idle = active
      .filter((s) => !busy.has(s.id) && now - new Date(s.lastActivity).getTime() < RECENT_MS)
      .sort((a, b) => +new Date(b.lastActivity) - +new Date(a.lastActivity));

    // Per-source drill counts (over all active sessions).
    const counts = new Map<SrcKey, { total: number; running: number }>();
    for (const k of SOURCE_ORDER) counts.set(k, { total: 0, running: 0 });
    for (const s of active) {
      const c = counts.get(srcKey(s))!;
      c.total++;
      if (s.isRunning) c.running++;
    }

    // GitHub island: one crate per distinct PR, freshest session wins.
    const byUrl = new Map<string, UnifiedSession>();
    for (const s of [...active].sort(
      (a, b) => +new Date(b.lastActivity) - +new Date(a.lastActivity)
    )) {
      if (s.prUrl && !byUrl.has(s.prUrl)) byUrl.set(s.prUrl, s);
    }
    const prs = [...byUrl.values()];
    const open = prs.filter((s) => s.prState === "OPEN" || !s.prState);
    const merged = prs.filter((s) => s.prState === "MERGED");
    const closed = prs.filter((s) => s.prState === "CLOSED");

    return { active, waiting, running, queued, idle, counts, open, merged, closed };
  }, [sessions]);

  if (loading && sessions.length === 0) {
    return (
      <div className="factory">
        <div className="fac-boot">⚙ Spinning up the factory…</div>
      </div>
    );
  }

  const { active, waiting, running, queued, idle, counts, open, merged, closed } = model;

  return (
    <div className="factory">
      <div className="fac-scene">
        <header className="fac-hud">
          <div className="fac-hud-title">
            <span className="fac-hud-gear">⚙</span>
            <span>Production Floor</span>
            <span className="fac-hud-sub">{active.length} sessions on the line</span>
          </div>
          <div className="fac-stats">
            <Stat tone="run" label="Assembling" value={running.length} />
            <Stat tone="wait" label="Awaiting input" value={waiting.length} />
            <Stat tone="queue" label="Queued" value={queued.length} />
            <Stat tone="pr" label="PRs open" value={open.length} />
          </div>
        </header>

        <div className="fac-floor">
          {/* ── Intake: a mining drill per source ── */}
          <section className="fac-col fac-col-intake">
            <h3 className="fac-col-label">Intake</h3>
            <div className="fac-drills">
              {SOURCE_ORDER.map((k) => {
                const c = counts.get(k)!;
                return (
                  <div
                    key={k}
                    className={`fac-drill${c.running > 0 ? " is-active" : ""}${
                      c.total === 0 ? " is-cold" : ""
                    }`}
                    style={cssVar(SOURCE_META[k].color)}
                  >
                    <span className="fac-drill-glyph">{SOURCE_META[k].glyph}</span>
                    <span className="fac-drill-name">{SOURCE_META[k].label}</span>
                    <span className="fac-drill-count">{c.total}</span>
                    <span className="fac-drill-bit" aria-hidden />
                  </div>
                );
              })}
            </div>
          </section>

          <Belt />

          {/* ── Assemblers ── */}
          <section className="fac-col fac-col-assembly">
            <Station
              kind="run"
              title="Assembling"
              empty="No active assemblers"
              sessions={running}
              onOpen={onOpenSession}
            />
            <Station
              kind="wait"
              title="Awaiting input"
              empty="All clear — nothing blocked"
              sessions={waiting}
              onOpen={onOpenSession}
            />
            <Station
              kind="idle"
              title="Buffer"
              empty="Belt empty"
              sessions={[...queued, ...idle]}
              onOpen={onOpenSession}
            />
          </section>

          <Belt toIsland />

          {/* ── GitHub island ── */}
          <section className="fac-col fac-col-island">
            <div className="fac-island">
              <div className="fac-island-water" aria-hidden />
              <h3 className="fac-island-label">
                <span className="fac-hex">⬡</span> GitHub Island
              </h3>
              <PrShelf tone="open" label="Open" prs={open} onOpen={onOpenSession} />
              <PrShelf tone="merged" label="Merged" prs={merged} onOpen={onOpenSession} />
              <PrShelf tone="closed" label="Closed" prs={closed} onOpen={onOpenSession} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ tone, label, value }: { tone: string; label: string; value: number }) {
  return (
    <div className={`fac-stat fac-stat-${tone}`}>
      <span className="fac-stat-val">{value}</span>
      <span className="fac-stat-label">{label}</span>
    </div>
  );
}

function Belt({ toIsland }: { toIsland?: boolean }) {
  return (
    <div className={`fac-belt${toIsland ? " fac-belt-island" : ""}`} aria-hidden>
      <div className="fac-belt-lane" />
      <span className="fac-belt-item" style={{ animationDelay: "0s" }} />
      <span className="fac-belt-item" style={{ animationDelay: "-1.1s" }} />
      <span className="fac-belt-item" style={{ animationDelay: "-2.2s" }} />
    </div>
  );
}

function Station({
  kind,
  title,
  empty,
  sessions,
  onOpen,
}: {
  kind: "run" | "wait" | "idle";
  title: string;
  empty: string;
  sessions: UnifiedSession[];
  onOpen: (id: string) => void;
}) {
  const shown = sessions.slice(0, STATION_CAP);
  const overflow = sessions.length - shown.length;
  return (
    <div className={`fac-station fac-station-${kind}`}>
      <div className="fac-machine-head">
        <span className={`fac-lamp fac-lamp-${kind}`} />
        <span className="fac-machine-title">{title}</span>
        {kind === "run" && <span className="fac-gear">⚙</span>}
        <span className="fac-machine-count">{sessions.length}</span>
      </div>
      <div className="fac-machine-body">
        {shown.length === 0 ? (
          <div className="fac-empty">{empty}</div>
        ) : (
          shown.map((s) => <Crate key={s.id} session={s} onOpen={onOpen} />)
        )}
        {overflow > 0 && <div className="fac-more">+{overflow} more on the belt</div>}
      </div>
    </div>
  );
}

function Crate({ session, onOpen }: { session: UnifiedSession; onOpen: (id: string) => void }) {
  const k = srcKey(session);
  const meta = SOURCE_META[k];
  const sub =
    session.automation || session.startedBy || meta.label;
  return (
    <button
      className="fac-crate"
      style={cssVar(meta.color)}
      onClick={() => onOpen(session.id)}
      title={session.title}
    >
      <span className="fac-crate-glyph">{meta.glyph}</span>
      <span className="fac-crate-main">
        <span className="fac-crate-title">{session.title}</span>
        <span className="fac-crate-meta">
          {sub} · {relativeTime(session.lastActivity)}
          {session.branch ? ` · ${session.branch}` : ""}
        </span>
      </span>
      {session.waitingForInput ? (
        <span className="fac-crate-flag fac-crate-flag-wait">!</span>
      ) : session.isRunning ? (
        <span className="fac-crate-flag fac-crate-flag-run" />
      ) : (session.queuedCount || 0) > 0 ? (
        <span className="fac-crate-flag fac-crate-flag-queue">{session.queuedCount}</span>
      ) : null}
    </button>
  );
}

function PrShelf({
  tone,
  label,
  prs,
  onOpen,
}: {
  tone: "open" | "merged" | "closed";
  label: string;
  prs: UnifiedSession[];
  onOpen: (id: string) => void;
}) {
  const shown = prs.slice(0, STATION_CAP);
  const overflow = prs.length - shown.length;
  return (
    <div className={`fac-shelf fac-shelf-${tone}`}>
      <div className="fac-shelf-head">
        <span className={`fac-lamp fac-lamp-${tone}`} />
        <span className="fac-shelf-label">{label}</span>
        <span className="fac-shelf-count">{prs.length}</span>
      </div>
      <div className="fac-shelf-body">
        {shown.length === 0 ? (
          <div className="fac-empty">—</div>
        ) : (
          shown.map((s) => (
            <button
              key={s.id}
              className="fac-pr"
              onClick={() => onOpen(s.id)}
              title={s.title}
            >
              <span className="fac-pr-hex">⬡</span>
              <span className="fac-pr-title">{s.title}</span>
              {s.linearIssue && <span className="fac-pr-tag">{s.linearIssue.identifier}</span>}
            </button>
          ))
        )}
        {overflow > 0 && <div className="fac-more">+{overflow} more</div>}
      </div>
    </div>
  );
}
