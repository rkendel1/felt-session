import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import type { UnifiedSession, TranscriptEntry, WSServerMessage, AskQuestion } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { WorkBlock } from "./WorkBlock";
import { TerminalPanel } from "./TerminalPanel";
import { getCurrentUser } from "./UserPicker";
import { deleteSessionApi, fetchModels, type ModelOption } from "../lib/api";
import { Composer } from "./Composer";
import { DiffPanel } from "./DiffPanel";
import { AskCard } from "./AskCard";
import { PrPanel } from "./PrPanel";
import { SpinOffMenu } from "./SpinOffMenu";
import { isPinned, togglePin, onPinsChanged } from "../lib/pins";
import { useChatScroll } from "../hooks/useChatScroll";

interface Props {
  session: UnifiedSession;
  onBack: () => void;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
}

type PanelTab = "changes" | "terminal" | "pr";

type RenderBlock =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "work"; items: TranscriptEntry[] };

/** Upsert incoming entries by id so stream events and the file watcher never duplicate. */
function mergeEntries(prev: TranscriptEntry[], incoming: TranscriptEntry[]): TranscriptEntry[] {
  if (incoming.length === 0) return prev;
  const indexById = new Map(prev.map((e, i) => [e.id, i] as const));
  const next = [...prev];
  for (const entry of incoming) {
    const idx = indexById.get(entry.id);
    if (idx !== undefined) {
      next[idx] = entry;
    } else {
      indexById.set(entry.id, next.length);
      next.push(entry);
    }
  }
  return next;
}

export function SessionViewer({ session, onBack, send, addHandler, connected }: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  // Pasted/dropped images (data URLs) staged for the next send.
  const [images, setImages] = useState<string[]>([]);
  // When set, the next send forks a new session branching from this message
  // instead of continuing this one.
  const [forkFrom, setForkFrom] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRunningLive, setIsRunningLive] = useState(session.isRunning);
  const [streamText, setStreamText] = useState("");
  const [streamBy, setStreamBy] = useState<string | null>(null);
  const [viewers, setViewers] = useState<string[]>([]);
  const [queued, setQueued] = useState<Array<{ content: string; user?: string }>>([]);
  // Steered messages folded into the live run — shown as a "folded in" receipt
  // until their turn writes to the transcript (then reconciled away below).
  const [steered, setSteered] = useState<Array<{ content: string; user?: string }>>([]);
  // Optimistic just-sent messages, shown instantly and reconciled once the real
  // turn lands (transcript) or the server confirms it as queued (busy path).
  const [pending, setPending] = useState<
    Array<{ id: string; content: string; user: string; sentAt: number; images?: string[] }>
  >([]);
  const [ask, setAsk] = useState<{ questionId: string; questions: AskQuestion[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(() => isPinned(session.id));
  const [panelTab, setPanelTab] = useState<PanelTab>("changes");
  // Remembered per browser; on phones the panel overlays the chat, so default closed there
  const [panelOpen, setPanelOpenState] = useState(() => {
    const stored = localStorage.getItem("michael-panel-open");
    if (stored !== null) return stored === "true" && window.innerWidth > 920;
    return window.innerWidth > 920;
  });

  function setPanelOpen(open: boolean) {
    setPanelOpenState(open);
    localStorage.setItem("michael-panel-open", String(open));
  }
  // Intent-aware scrolling: stick to the live edge only while the reader is there,
  // pin new turns near the top, and surface a "Jump to latest" affordance.
  const {
    containerRef: messagesRef,
    spacerRef,
    following,
    newBelow,
    scrollToLatest,
    anchorToTop,
    beginTurn,
    endTurn,
    relayout,
    onScroll,
  } = useChatScroll();

  // Per-session model (switchable from the composer; "" = default)
  const [model, setModel] = useState(session.model || "");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    setModel(session.model || "");
  }, [session.id, session.model]);

  // Keep the pin star in sync with the store (changes can come from the tab bar
  // or the Home screen) and reset when switching sessions.
  useEffect(() => setPinned(isPinned(session.id)), [session.id]);
  useEffect(() => onPinsChanged(() => setPinned(isPinned(session.id))), [session.id]);

  const isAsk = session.mode === "ask";
  const hasWorkspace = !isAsk && Boolean(session.worktreeDir || session.branch);
  const isBusy = isRunningLive || isStreaming;

  // Ctrl+R focuses the composer (overrides browser reload while in a session)
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "r" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Browser tab title follows the session
  useEffect(() => {
    document.title = `${session.title} — Michael`;
    return () => {
      document.title = "Michael — Tella";
    };
  }, [session.title]);

  // Subscribe to WebSocket messages
  useEffect(() => {
    if (!connected) return;

    send({ type: "watch", sessionId: session.id, user: getCurrentUser() });

    const unsubscribe = addHandler((msg) => {
      switch (msg.type) {
        case "transcript_init": {
          // Weave persisted model switches into the conversation as dividers
          const switches: TranscriptEntry[] = (session.modelHistory || []).map((h) => ({
            id: `model-switch-${h.at}`,
            type: "system" as const,
            content: `Model switched to ${h.model}${h.by ? ` by ${h.by}` : ""}`,
            timestamp: h.at,
          }));
          const merged = [...msg.entries, ...switches].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          setEntries(merged);
          setLoading(false);
          break;
        }
        case "transcript_append": {
          setEntries((prev) => mergeEntries(prev, msg.entries));
          // The live stream and the transcript tail both carry assistant text.
          // stream_text accumulates whole blocks until stream_done (end of the
          // run), so a mid-run text block would otherwise show twice: as the
          // persisted entry above later tool steps AND in the streaming bubble
          // at the bottom. Once a block lands as an entry, drop it from the
          // stream buffer.
          const landed = msg.entries.filter((e) => e.type === "assistant" && e.content);
          if (landed.length) {
            setStreamText((prev) => {
              let next = prev;
              for (const e of landed) next = next.replace(e.content, "");
              return next.trim() ? next : "";
            });
          }
          break;
        }
        case "presence":
          if (msg.sessionId === session.id) setViewers(msg.viewers);
          break;
        case "queue_update":
          if (msg.sessionId === session.id) {
            setQueued(msg.queued);
            setSteered(msg.steered || []);
          }
          break;
        case "ask_question":
          if (msg.sessionId === session.id) {
            setAsk({ questionId: msg.questionId, questions: msg.questions });
          }
          break;
        case "ask_resolved":
          if (msg.sessionId === session.id) {
            setAsk((prev) => (prev?.questionId === msg.questionId ? null : prev));
          }
          break;
        case "session_status":
          setIsRunningLive(msg.isRunning);
          break;
        case "stream_start":
          setIsStreaming(true);
          setStreamBy(msg.by || null);
          setStreamText("");
          break;
        case "stream_text":
          setStreamText((prev) => prev + msg.text);
          break;
        case "stream_tool_use":
        case "stream_tool_result":
          setEntries((prev) => mergeEntries(prev, [msg.entry]));
          break;
        case "stream_done":
          setIsStreaming(false);
          setStreamBy(null);
          setStreamText("");
          break;
        case "model_changed":
          if (msg.sessionId !== session.id) break;
          setModel(msg.model);
          if (msg.by && msg.by !== getCurrentUser()) {
            setEntries((prev) => [
              ...prev,
              {
                id: `model-switch-${Date.now()}`,
                type: "system",
                content: `Model switched to ${msg.model} by ${msg.by}`,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
          break;
        case "notice":
          setEntries((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              type: "system",
              content: msg.message,
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        case "error":
          setIsStreaming(false);
          // Show the failure where the reply would have been — otherwise a
          // failed run looks like a send that silently went nowhere.
          if (msg.message) {
            setEntries((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                type: "system",
                content: `⚠ Run failed: ${msg.message}`,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
          break;
      }
    });

    return unsubscribe;
    // transcriptPath in deps: new sessions start without a transcript file —
    // re-watch once it appears so the live tail attaches
  }, [session.id, connected, session.transcriptPath]);

  // Drop optimistic bubbles once their real turn shows up. Each pending message
  // is claimed (one-to-one) either by a transcript user entry recorded around or
  // after we sent it, or by a server-confirmed queued entry (the busy path).
  // A long-unmatched bubble is dropped so a dead send never sticks as "sending…".
  useEffect(() => {
    setPending((prev) => {
      if (prev.length === 0) return prev;
      const userPool = entries
        .filter((e) => e.type === "user")
        .map((e) => ({ c: e.content.trim(), t: new Date(e.timestamp).getTime() }));
      // A just-sent message is confirmed by a queued echo, a steer receipt
      // (busy/fold-in path), or a real transcript user entry.
      const echoPool = [...queued, ...steered].map((q) => q.content.trim());
      const remaining = prev.filter((p) => {
        const c = p.content.trim();
        const qi = echoPool.indexOf(c);
        if (qi >= 0) { echoPool.splice(qi, 1); return false; }
        const ui = userPool.findIndex((u) => u.c === c && u.t >= p.sentAt - 30_000);
        if (ui >= 0) { userPool.splice(ui, 1); return false; }
        return Date.now() - p.sentAt < 120_000;
      });
      return remaining.length === prev.length ? prev : remaining;
    });
  }, [entries, queued, steered]);

  // A steer receipt is reconciled away once its message lands in the transcript
  // (its turn started) — until then it's the only visible record of the fold-in.
  const visibleSteered = useMemo(() => {
    if (steered.length === 0) return steered;
    const userPool = entries.filter((e) => e.type === "user").map((e) => e.content.trim());
    return steered.filter((s) => {
      const i = userPool.indexOf(s.content.trim());
      if (i >= 0) { userPool.splice(i, 1); return false; }
      return true;
    });
  }, [steered, entries]);

  // Forget optimistic bubbles when switching sessions
  useEffect(() => { setPending([]); }, [session.id]);

  // Reopen where the reader left off. A running session jumps to the live edge to
  // track the stream; an idle one opens at the last user turn so its reply reads
  // from the start, not the absolute bottom (principle 11).
  const didInitialScroll = useRef(false);
  useEffect(() => { didInitialScroll.current = false; }, [session.id]);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || didInitialScroll.current || entries.length === 0) return;
    didInitialScroll.current = true;
    if (session.isRunning) {
      scrollToLatest("auto");
    } else {
      const userEls = el.querySelectorAll<HTMLElement>(".msg-user");
      const lastUser = userEls[userEls.length - 1];
      if (lastUser) anchorToTop(lastUser); else scrollToLatest("auto");
    }
  }, [entries, session.isRunning, scrollToLatest, anchorToTop]);

  // After any content change: keep a following reader at the live edge, or maintain
  // the pinned-turn spacer for a turn streaming into the space below (principles 4–6).
  // Layout effect so the adjustment happens before the browser paints — no flicker.
  useLayoutEffect(() => {
    relayout();
  }, [entries, streamText, queued, visibleSteered, pending, relayout]);

  // When a turn finishes, release the spacer so the layout settles back.
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (wasBusyRef.current && !isBusy) endTurn();
    wasBusyRef.current = isBusy;
  });

  // Codex-model sessions start fresh threads server-side; only Claude-model
  // sessions need an existing claude session id to resume.
  const effectiveModel = model || defaultModel;
  const isCodexModel = effectiveModel.startsWith("gpt") || effectiveModel.startsWith("codex");
  const noEngine = !isCodexModel && !session.claudeSessionId && !session.codexThreadId;
  // Fork uses the SDK's forkSession, which is Claude-only.
  const isClaudeSession = !isCodexModel && !!session.claudeSessionId;

  function handleFork(messageId: string) {
    setForkFrom(messageId);
  }

  function handleSend() {
    const text = input.trim();
    const imgs = images;
    if (!text && imgs.length === 0) return;
    if (!connected) return;

    const user = getCurrentUser();

    // Fork mode: branch a brand-new session from the selected message, keeping
    // the real conversation history. App navigates into it on session_created.
    if (forkFrom) {
      send({
        type: "create_session",
        branch: "",
        prompt: text || "Continue from here.",
        user,
        forkFrom: { sourceId: session.id, messageId: forkFrom },
        ...(imgs.length ? { images: imgs } : {}),
      });
      setForkFrom(null);
      setInput("");
      setImages([]);
      return;
    }

    if (noEngine) return;
    // While Michael is busy the server queues this and delivers it after the run
    send({
      type: "prompt",
      sessionId: session.id,
      content: text,
      user,
      ...(imgs.length ? { images: imgs } : {}),
    });
    beginTurn(); // pin this new turn near the top so its reply streams in below
    // Show it immediately; reconciled away when the real turn / queue echo lands
    setPending((p) => [
      ...p,
      { id: `pending-${crypto.randomUUID()}`, content: text, user, sentAt: Date.now(), images: imgs.length ? imgs : undefined },
    ]);
    setInput("");
    setImages([]);
  }

  function handleInterruptSend() {
    const text = input.trim();
    if (!text) return;
    if (!connected || noEngine) return;

    const user = getCurrentUser();
    // Stops the current turn and continues right away with this message
    send({ type: "interrupt_prompt", sessionId: session.id, content: text, user });
    beginTurn(); // pin this new turn near the top so its reply streams in below
    setPending((p) => [
      ...p,
      { id: `pending-${crypto.randomUUID()}`, content: text, user, sentAt: Date.now() },
    ]);
    setInput("");
  }

  function handleCancel() {
    send({ type: "cancel" });
  }

  function handleShare() {
    const link = `${location.origin}/backstage/session/${encodeURIComponent(session.id)}`;
    const flash = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    // navigator.clipboard needs a secure context; fall back to a temp textarea
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(flash, () => fallbackCopy(link, flash));
    } else {
      fallbackCopy(link, flash);
    }
  }

  function handleModelChange(next: string) {
    const target = next || defaultModel;
    if (!target || target === (model || defaultModel)) return;
    setModel(next);
    // Routed through the /model slash command so it persists, notices, and
    // broadcasts to other viewers.
    send({
      type: "prompt",
      sessionId: session.id,
      content: `/model ${target}`,
      user: getCurrentUser(),
    });
  }

  // Build tool_use → tool_result map
  const toolResults = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.type === "tool_result" && e.toolUseId) {
      toolResults.set(e.toolUseId, e);
    }
  }

  // Group consecutive tool calls into Devin-style work blocks
  const blocks: RenderBlock[] = [];
  for (const entry of entries) {
    if (entry.type === "tool_use") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "work") last.items.push(entry);
      else blocks.push({ kind: "work", items: [entry] });
    } else if (entry.type === "tool_result") {
      continue; // rendered inside work blocks via toolResults
    } else {
      blocks.push({ kind: "entry", entry });
    }
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const me = getCurrentUser();

  async function handleDelete(cleanWorktree: boolean) {
    setDeleting(true);
    try {
      await deleteSessionApi(session.id, cleanWorktree);
      onBack();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  return (
    <div className="session-viewer">
      <div className="viewer-header">
        <div className="viewer-title">
          {isAsk ? (
            <span className="source-chip source-ask">ask</span>
          ) : (
            <span className={`source-chip source-${session.source}`}>{session.source}</span>
          )}
          <span className="viewer-branch" title={session.title}>{session.title}</span>
          {session.startedBy && (
            <span className="viewer-started-by">by {session.startedBy}</span>
          )}
          {(model || defaultModel) && (
            <span
              className={`model-pill ${isCodexModel ? "model-pill-codex" : "model-pill-claude"}`}
              title={model ? "Model set for this session" : "Default model"}
            >
              {model || defaultModel}
            </span>
          )}
          {session.archived && <span className="source-chip source-cli">archived</span>}
          {isBusy && (
            <span className="working-pill">
              <span className="working-dot" />
              {streamBy ? `Working for ${streamBy}` : "Working"}
            </span>
          )}
        </div>
        <div className="viewer-header-actions">
          {viewers.length > 1 && (
            <div className="presence" title={`Viewing: ${viewers.join(", ")}`}>
              {dedupeViewers(viewers).map((v) => (
                <span key={v.name} className={`presence-avatar ${v.name === me ? "presence-me" : ""}`}>
                  {v.name.charAt(0).toUpperCase()}
                  {v.count > 1 ? <span className="presence-count">{v.count}</span> : null}
                </span>
              ))}
            </div>
          )}
          {session.linearIssue?.url && (
            <a href={session.linearIssue.url} target="_blank" rel="noopener" className="session-link session-link-linear">
              {session.linearIssue.identifier}
            </a>
          )}
          {session.plainThreadId && (
            <a
              href={`https://app.plain.com/workspace/w_01J7WXJG68TFDV9RD1C4JE3W6F/thread/${session.plainThreadId}/`}
              target="_blank"
              rel="noopener"
              className="session-link session-link-plain"
            >
              Plain ↗
            </a>
          )}
          <button
            className={`btn-viewer-pin ${pinned ? "active" : ""}`}
            onClick={() => togglePin(session.id)}
            title={pinned ? "Unpin tab" : "Pin as tab"}
            aria-pressed={pinned}
          >
            {pinned ? "★" : "☆"}
          </button>
          <button
            className={`btn-viewer-share ${copied ? "btn-viewer-share-done" : ""}`}
            onClick={handleShare}
            title="Copy a link to this session"
          >
            {copied ? "Copied ✓" : "Share"}
          </button>
          <SpinOffMenu session={session} entries={entries} send={send} connected={connected} />
          {hasWorkspace && (
            <button
              className={`btn-panel-toggle btn-workspace ${panelOpen ? "active" : ""}`}
              onClick={() => setPanelOpen(!panelOpen)}
              title="Toggle workspace panel (changes, terminal, PR)"
            >
              <span className="btn-panel-toggle-icon">◨</span>
              <span className="btn-panel-toggle-label">Workspace</span>
            </button>
          )}
          {!showDeleteConfirm ? (
            <button
              className="btn-viewer-delete"
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete session"
            >
              Delete
            </button>
          ) : (
            <div className="viewer-delete-confirm">
              {session.worktreeDir && !isAsk && (
                <button className="btn-delete-wt" onClick={() => handleDelete(true)} disabled={deleting}>
                  {deleting ? "…" : "+ Worktree"}
                </button>
              )}
              <button className="btn-delete-only" onClick={() => handleDelete(false)} disabled={deleting}>
                {deleting ? "…" : "Session"}
              </button>
              <button className="btn-delete-cancel" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {(session.goal || session.loop) && (
        <div className="session-banners">
          {session.goal && (
            <span className="session-banner" title="Cleared with /goal clear">
              🎯 {session.goal}
            </span>
          )}
          {session.loop && (
            <span className="session-banner" title={`"${session.loop.prompt}" — stop with /loop stop`}>
              ⟳ every {session.loop.intervalMinutes}m — {session.loop.prompt.slice(0, 60)}
              {session.loop.prompt.length > 60 ? "…" : ""}
            </span>
          )}
        </div>
      )}

      <div className="viewer-split">
        <div className="viewer-chat">
          <div className="viewer-messages-region">
          <div className="viewer-messages" ref={messagesRef} onScroll={onScroll}>
            {loading ? (
              <div className="loading">Loading transcript…</div>
            ) : entries.length === 0 && !session.transcriptPath ? (
              <div className="empty">No transcript available for this session</div>
            ) : entries.length === 0 ? (
              <div className="empty">Empty transcript</div>
            ) : (
              blocks.map((block, i) =>
                block.kind === "work" ? (
                  <WorkBlock
                    key={block.items[0].id}
                    items={block.items}
                    toolResults={toolResults}
                    live={isBusy && i === blocks.length - 1}
                  />
                ) : (
                  <MessageBubble
                    key={block.entry.id}
                    entry={block.entry}
                    onFork={isClaudeSession ? handleFork : undefined}
                  />
                )
              )
            )}

            {streamText && <StreamingMessage text={streamText} />}

            {ask && (
              <AskCard
                key={ask.questionId}
                questions={ask.questions}
                onAnswer={(answers) =>
                  send({
                    type: "answer_question",
                    sessionId: session.id,
                    questionId: ask.questionId,
                    answers,
                  })
                }
              />
            )}

            {visibleSteered.map((s, i) => (
              <div key={`steered-${i}`} className="msg msg-user msg-queued">
                <div className="msg-label msg-label-user">
                  {s.user || "You"} · folded in
                </div>
                <div className="msg-body msg-body-user">{s.content}</div>
              </div>
            ))}

            {queued.map((q, i) => (
              <div key={`queued-${i}`} className="msg msg-user msg-queued">
                <div className="msg-label msg-label-user">
                  {q.user || "You"} · queued
                </div>
                <div className="msg-body msg-body-user">{q.content}</div>
              </div>
            ))}

            {pending.map((p) => (
              <div key={p.id} className="msg msg-user msg-sending">
                <div className="msg-label msg-label-user">
                  {p.user || "You"} · {isBusy ? "queueing…" : "sending…"}
                </div>
                {p.content && <div className="msg-body msg-body-user">{p.content}</div>}
                {p.images && p.images.length > 0 && (
                  <div className="msg-images">
                    {p.images.map((src, i) => (
                      <img key={i} className="md-image" src={src} alt="" loading="lazy" />
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Reserves room so a freshly-sent turn can sit near the top while its
                reply streams into the space below; sized by the scroll hook. */}
            <div ref={spacerRef} className="turn-spacer" aria-hidden="true" />
          </div>

          {!following && entries.length > 0 && (
            <button
              className={`jump-latest ${newBelow ? "jump-latest-new" : ""}`}
              onClick={() => scrollToLatest("smooth")}
              title="Return to the latest reply"
            >
              <span className="jump-latest-arrow">↓</span>
              {isBusy ? "Michael is replying" : newBelow ? "New messages" : "Jump to latest"}
            </button>
          )}
          </div>

          <div className="viewer-input">
            {noEngine ? (
              <div className="input-disabled">No engine session to resume</div>
            ) : (
              <>
                {isBusy && (
                  <div className="input-busy">
                    <span className="pulse-dot" />
                    {streamBy && streamBy !== me ? `${streamBy} is driving — Michael is working…` : "Michael is working…"}
                    {(queued.length > 0 || visibleSteered.length > 0) && (
                      <span className="queue-count">
                        {visibleSteered.length > 0 && `${visibleSteered.length} folded in`}
                        {visibleSteered.length > 0 && queued.length > 0 && ", "}
                        {queued.length > 0 && `${queued.length} queued`}
                      </span>
                    )}
                    <button className="btn-cancel" onClick={handleCancel} title="Stop the current run">
                      <span className="btn-cancel-icon" />
                      Stop
                    </button>
                  </div>
                )}
                {forkFrom && (
                  <div className="fork-banner">
                    <span>⑂ Forking a new session from the selected message — type the new direction.</span>
                    <button className="fork-banner-cancel" onClick={() => setForkFrom(null)}>
                      Cancel
                    </button>
                  </div>
                )}
                <Composer
                  value={input}
                  onChange={setInput}
                  onSend={handleSend}
                  images={images}
                  onImagesChange={setImages}
                  placeholder={
                    !connected
                      ? "Not connected"
                      : forkFrom
                        ? "New direction for the forked session…"
                        : isBusy
                          ? "Message Michael — picked up at the next stopping point…"
                          : "Ask Michael to build, fix, or explain…"
                  }
                  disabled={!connected}
                  sendDisabled={!input.trim() && images.length === 0 && !forkFrom}
                  busy={isBusy && !forkFrom}
                  onInterruptSend={forkFrom ? undefined : handleInterruptSend}
                  models={models}
                  defaultModel={defaultModel}
                  model={model}
                  onModelChange={handleModelChange}
                  modelDisabled={session.source !== "backstage"}
                  modelTitle={
                    session.source !== "backstage"
                      ? "Set the model from the owning agent (/model in the Slack thread)"
                      : "Switch the model for this session"
                  }
                  hint="Enter to send · Shift+Enter for newline · /goal pins a goal · /loop runs on an interval"
                  textareaRef={composerRef}
                />
              </>
            )}
          </div>
        </div>

        {hasWorkspace && panelOpen && (
          <div className="panel-overlay" onClick={() => setPanelOpen(false)} />
        )}
        {hasWorkspace && panelOpen && (
          <div className="viewer-panel">
            <div className="panel-tabs">
              <button
                className={`panel-tab ${panelTab === "changes" ? "active" : ""}`}
                onClick={() => setPanelTab("changes")}
              >
                Changes
              </button>
              <button
                className={`panel-tab ${panelTab === "terminal" ? "active" : ""}`}
                onClick={() => setPanelTab("terminal")}
              >
                Terminal
              </button>
              <button
                className={`panel-tab ${panelTab === "pr" ? "active" : ""}`}
                onClick={() => setPanelTab("pr")}
              >
                PR
                {session.prState && (
                  <span className={`panel-tab-dot pr-dot-${session.prState.toLowerCase()}`} />
                )}
              </button>
              {session.branch && <span className="panel-branch" title={session.branch}>{session.branch}</span>}
              <button
                className="panel-close"
                onClick={() => setPanelOpen(false)}
                aria-label="Close panel"
              >
                ✕
              </button>
            </div>
            <div className="panel-body">
              {panelTab === "changes" ? (
                <DiffPanel
                  sessionId={session.id}
                  isRunning={isBusy}
                  canSend={connected && !isBusy && !noEngine}
                  send={send}
                />
              ) : panelTab === "terminal" ? (
                <TerminalPanel entries={entries} />
              ) : (
                <PrPanel sessionId={session.id} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StreamingMessage({ text }: { text: string }) {
  const html = React.useMemo(() => renderMarkdown(text), [text]);

  return (
    <div className="msg msg-assistant msg-streaming">
      <div className="msg-label msg-label-assistant">Michael</div>
      <div
        className="msg-body msg-body-assistant markdown"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function dedupeViewers(viewers: string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of viewers) counts.set(v, (counts.get(v) || 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, count }));
}

// Clipboard fallback for non-secure contexts (where navigator.clipboard is absent)
function fallbackCopy(text: string, onDone: () => void) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    onDone();
  } catch {
    // Last resort: show the link so it can be copied by hand
    window.prompt("Copy this session link:", text);
  }
}
