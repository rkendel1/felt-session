import { useState, useEffect, useRef, useCallback } from "react";
import type { WSServerMessage, WSClientMessage } from "../lib/types";
import { API_BASE, getWebSocketUrl } from "../lib/api";
import { countSessionPerf } from "../lib/session-performance";

// Liveness probe cadence. iOS/Safari kills backgrounded sockets without firing
// onclose, leaving a half-open socket that reads as OPEN but delivers nothing —
// the "session frozen until refresh" trap. We ping over the app protocol (browsers
// can't send WS protocol pings) and force-close if nothing arrives back, which
// triggers the normal reconnect + re-watch path.
const HEARTBEAT_MS = 20_000;
// Tighter deadline for the visibility-resume probe: coming back to a
// backgrounded PWA is exactly when the socket is most likely dead.
const RESUME_PROBE_MS = 4_000;
// How long a visible-but-untouched tab still counts as "here". Long enough to
// read a transcript without your face blinking off, short enough that a session
// left open behind another window stops claiming you.
const IDLE_MS = 5 * 60_000;
// What proves a person is at the keyboard. Passive and cheap: the handler
// throttles itself to one call a second.
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<((msg: WSServerMessage) => void)[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Set on unmount so a straggling onclose (close() fires it async) can't
  // schedule a fresh reconnect into a dead component — the zombie-loop trap.
  const disposedRef = useRef(false);
  // Flipped true by ANY inbound message (pong or otherwise); the heartbeat
  // flips it false after each ping. Still false at the next beat = dead socket.
  const aliveRef = useRef(true);
  // Presence, tracked separately from the watch: a hidden or idle tab keeps
  // streaming its session (unread counts, notifications) but must stop telling
  // teammates its owner is looking at that session.
  const awayRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Outbound messages issued while the socket wasn't OPEN (wifi switch, server
  // restart, PWA resume): held here and flushed in order on the next onopen, so
  // a transient drop doesn't silently swallow intent like create_session — the
  // "I clicked create, nothing happened after switching networks" bug. Bounded
  // so a long outage can't replay a stale flood.
  const outboxRef = useRef<{ msg: WSClientMessage; at: number }[]>([]);
  const feedCursorsRef = useRef(
    new Map<string, { feedEpoch: string; feedSeq: number }>(),
  );
  const OUTBOX_MAX = 50;
  const OUTBOX_TTL_MS = 30_000;

  const connect = useCallback(() => {
    // Already open OR mid-handshake — don't stack a second socket.
    const state = wsRef.current?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(getWebSocketUrl());
    wsRef.current = ws;
    aliveRef.current = true;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setConnected(true);
      // Flush anything queued while we were down. FIFO preserves the order the
      // user issued them; skip messages that have gone stale.
      const now = Date.now();
      const pending = outboxRef.current;
      outboxRef.current = [];
      for (const item of pending) {
        if (now - item.at > OUTBOX_TTL_MS) continue;
        try {
          ws.send(JSON.stringify(item.msg));
        } catch {}
      }
      // Away state lives on the socket, so a fresh one starts present — a tab
      // that went away while the connection was down has to say so again.
      if (awayRef.current) {
        try {
          ws.send('{"type":"away","away":true}');
        } catch {}
      }
    };

    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return; // superseded socket — ignore stragglers
      aliveRef.current = true;
      countSessionPerf(
        "ws_bytes_received",
        typeof e.data === "string" ? e.data.length : (e.data?.byteLength ?? 0),
      );
      try {
        const msg = JSON.parse(e.data) as WSServerMessage;
        if (msg.type === "pong") return; // liveness only — not for handlers
        let delivered: WSServerMessage | null = msg;
        if (msg.type === "session_feed") {
          const cursor = feedCursorsRef.current.get(msg.sessionId);
          if (
            cursor?.feedEpoch === msg.feedEpoch &&
            msg.feedSeq <= cursor.feedSeq
          ) {
            delivered = null;
          } else {
            feedCursorsRef.current.set(msg.sessionId, {
              feedEpoch: msg.feedEpoch,
              feedSeq: msg.feedSeq,
            });
            delivered = msg.event as WSServerMessage;
          }
        } else if (msg.type === "feed_snapshot") {
          feedCursorsRef.current.set(msg.sessionId, {
            feedEpoch: msg.feedEpoch,
            feedSeq: msg.feedSeq,
          });
          // A stale cursor gets one cumulative active snapshot. Recreate the
          // ordinary stream events so every conversation surface shares the
          // same rendering path.
          if (msg.active) {
            const start: WSServerMessage = {
              type: "stream_start",
              sessionId: msg.sessionId,
              by: msg.active.by,
            };
            for (const handler of handlersRef.current) handler(start);
            if (msg.active.text) {
              const text: WSServerMessage = {
                type: "stream_text",
                sessionId: msg.sessionId,
                text: msg.active.text,
              };
              for (const handler of handlersRef.current) handler(text);
            }
          }
          delivered = null;
        }
        if (delivered) {
          for (const handler of handlersRef.current) {
            handler(delivered);
          }
        }
      } catch {}
    };

    ws.onclose = async (event) => {
      // A close from an already-replaced socket must not flip `connected` or
      // schedule a competing reconnect — only the current socket owns state.
      if (wsRef.current !== ws) return;
      setConnected(false);
      if (disposedRef.current) return;
      if (event.code === 4001) {
        window.location.reload();
        return;
      }
      if (event.code === 1006) {
        try {
          const response = await fetch(`${API_BASE}/auth/status`);
          const status = response.ok ? await response.json() : null;
          if (status?.local && !status.authenticated) return;
        } catch {}
      }
      if (disposedRef.current || wsRef.current !== ws) return;
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();

    // Steady-state heartbeat: ping every beat; a socket that answered nothing
    // since the previous ping is dead — close it so onclose reconnects.
    const heartbeat = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!aliveRef.current) {
        try {
          ws.close();
        } catch {}
        return;
      }
      aliveRef.current = false;
      try {
        ws.send('{"type":"ping"}');
      } catch {}
    }, HEARTBEAT_MS);

    // Foregrounding the tab/PWA (or the network coming back): reconnect a
    // closed socket immediately (skip the 2s backoff), and probe an "open" one
    // right away — if the probe gets no answer, close → reconnect.
    const resync = () => {
      if (disposedRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer.current);
        connect();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return; // handshake in flight
      aliveRef.current = false;
      try {
        ws.send('{"type":"ping"}');
      } catch {}
      setTimeout(() => {
        // Only judge the same socket we probed — it may have been replaced.
        if (wsRef.current === ws && !aliveRef.current) {
          try {
            ws.close();
          } catch {}
        }
      }, RESUME_PROBE_MS);
    };
    // Presence: "here" means this tab is visible AND its owner has touched it
    // recently. The watch deliberately outlives both — a backgrounded tab still
    // streams — so presence needs its own signal, or a session left open on a
    // second monitor keeps claiming someone is reading it.
    const sendAway = (away: boolean) => {
      if (awayRef.current === away) return;
      awayRef.current = away;
      const ws = wsRef.current;
      // Never queued: a stale "I'm back" replayed after an outage would lie.
      // A reconnect starts present, and onopen re-sends away if we still are.
      if (ws?.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "away", away }));
      } catch {}
    };
    let lastActivity = 0;
    const onActivity = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      // Pointer moves fire continuously: only the first per second does work.
      // While away the point is to come back at once, so it skips the throttle.
      if (!awayRef.current && now - lastActivity < 1000) return;
      lastActivity = now;
      sendAway(false);
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => sendAway(true), IDLE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        resync();
        onActivity();
        return;
      }
      clearTimeout(idleTimer.current);
      sendAway(true);
    };
    if (document.visibilityState === "hidden") sendAway(true);
    else onActivity();
    for (const type of ACTIVITY_EVENTS)
      window.addEventListener(type, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", resync);
    window.addEventListener("pageshow", resync);

    return () => {
      disposedRef.current = true;
      clearTimeout(reconnectTimer.current);
      clearInterval(heartbeat);
      clearTimeout(idleTimer.current);
      for (const type of ACTIVITY_EVENTS)
        window.removeEventListener(type, onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", resync);
      window.removeEventListener("pageshow", resync);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback(
    (msg: WSClientMessage) => {
      if (msg.type === "watch") {
        const cursor = feedCursorsRef.current.get(msg.sessionId);
        msg = {
          ...msg,
          supportsFeed: true,
          ...(cursor
            ? {
                sinceFeedSeq: cursor.feedSeq,
                feedEpoch: cursor.feedEpoch,
              }
            : {}),
        };
      }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
          return;
        } catch {
          // send threw mid-drop — fall through and queue it for the reconnect.
        }
      }
      // Liveness pings are worthless once stale — never queue them.
      if ((msg as { type?: string }).type === "ping") return;
      const box = outboxRef.current;
      box.push({ msg, at: Date.now() });
      // Keep only the most recent OUTBOX_MAX (drop oldest intent first).
      if (box.length > OUTBOX_MAX) box.splice(0, box.length - OUTBOX_MAX);
      // Don't wait out the 2s backoff — try to reconnect right now so the
      // queued message goes out as soon as possible.
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer.current);
        connect();
      }
    },
    [connect],
  );

  const addHandler = useCallback((handler: (msg: WSServerMessage) => void) => {
    handlersRef.current.push(handler);
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler);
    };
  }, []);

  return { connected, send, addHandler };
}
