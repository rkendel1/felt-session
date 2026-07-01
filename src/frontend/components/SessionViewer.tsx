import React, {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { renderMarkdown } from "../lib/markdown";
import { parseHumanReply } from "../lib/humanReply";
import type {
	UnifiedSession,
	TranscriptEntry,
	WSServerMessage,
	AskQuestion,
} from "../lib/types";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { SubagentPanel, type SubagentRef } from "./SubagentPanel";
import { TerminalPanel } from "./TerminalPanel";
import { getCurrentUser } from "./UserPicker";
import {
	deleteSessionApi,
	fetchModels,
	fetchFileMentions,
	promoteChatApi,
	type ModelOption,
} from "../lib/api";
import { Composer } from "./Composer";
import type { FileAttachment } from "../lib/images";
import { DiffPanel } from "./DiffPanel";
import { RepoBar } from "./RepoBar";
import { AskCard } from "./AskCard";
import { PrPanel } from "./PrPanel";
import { SlackChatPanel } from "./SlackChatPanel";
import { PlainThreadPanel } from "./PlainThreadPanel";
import { PreviewButton } from "./PreviewButton";
import { SpinOffMenu } from "./SpinOffMenu";
import { IconSidebarRight } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { isPinned, togglePin, onPinsChanged } from "../lib/pins";
import { useChatScroll } from "../hooks/useChatScroll";

interface Props {
	session: UnifiedSession;
	onBack: () => void;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	connected: boolean;
	/** App-level top-bar node above the tab strip; when present the header renders
	    there (name-on-top layout) instead of inline. */
	topbarEl?: HTMLElement | null;
	/** App-level right-column node (sibling of the left sidebar); when present the
	    workspace/sub-agent panel portals here so it spans the full height from the
	    top, instead of opening only below the chat. */
	rightPanelEl?: HTMLElement | null;
	/** Bumped by the tab-bar + to start a fresh chat in this same session: clears
	    the composer and jumps to the live edge. A visual reset — same thread. */
	newChatSeq?: number;
	/** Rename this session (double-click the header title); empty resets it to
	    the derived title. Same handler the tab strip and sidebar use. */
	onRename?: (id: string, title: string) => void;
	/**
	 * The workspace this chat belongs to. When set, the header titles the
	 * WORKSPACE (every sibling chat shows the same name — per-chat titles live
	 * on the tabs) and double-click renames the workspace, not the chat.
	 */
	workspaceName?: string;
	onRenameWorkspace?: (name: string) => void;
}

type PanelTab = "changes" | "terminal" | "pr" | "slack" | "plain";

/** Workspace of the Plain app the tickets live in (for the "jump into Plain" link). */
const PLAIN_WORKSPACE_ID = "w_01J7WXJG68TFDV9RD1C4JE3W6F";
function plainThreadUrl(threadId: string): string {
	return `https://app.plain.com/workspace/${PLAIN_WORKSPACE_ID}/thread/${threadId}/`;
}

/** Upsert incoming entries by id so stream events and the file watcher never duplicate. */
function mergeEntries(
	prev: TranscriptEntry[],
	incoming: TranscriptEntry[],
): TranscriptEntry[] {
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

export function SessionViewer({
	session,
	onBack,
	send,
	addHandler,
	connected,
	topbarEl,
	rightPanelEl,
	newChatSeq,
	onRename,
	workspaceName,
	onRenameWorkspace,
}: Props) {
	const [entries, setEntries] = useState<TranscriptEntry[]>([]);
	// No transcript file yet (a fresh chat that hasn't run) → nothing to load;
	// render the empty chat immediately instead of a "Loading transcript…" flash.
	const [loading, setLoading] = useState(!!session.transcriptPath);
	// The initial transcript is the tail only when the file is large; these drive
	// the "load earlier history" affordance at the top of the conversation.
	const [historyTruncated, setHistoryTruncated] = useState(false);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [input, setInput] = useState("");
	// Pasted/dropped images (data URLs) staged for the next send.
	const [images, setImages] = useState<string[]>([]);
	const [files, setFiles] = useState<FileAttachment[]>([]);
	// When set, the next send forks a new session branching from this message
	// instead of continuing this one.
	const [forkFrom, setForkFrom] = useState<string | null>(null);
	const [isStreaming, setIsStreaming] = useState(false);
	const [isRunningLive, setIsRunningLive] = useState(session.isRunning);
	const [streamText, setStreamText] = useState("");
	const [streamBy, setStreamBy] = useState<string | null>(null);
	const [viewers, setViewers] = useState<string[]>([]);
	const [queued, setQueued] = useState<
		Array<{ content: string; user?: string }>
	>([]);
	// Steered messages folded into the live run — shown as a "folded in" receipt
	// until their turn writes to the transcript (then reconciled away below).
	const [steered, setSteered] = useState<
		Array<{ content: string; user?: string }>
	>([]);
	// Optimistic just-sent messages, shown instantly and reconciled once the real
	// turn lands (transcript) or the server confirms it as queued (busy path).
	const [pending, setPending] = useState<
		Array<{
			id: string;
			content: string;
			user: string;
			sentAt: number;
			images?: string[];
		}>
	>([]);
	const [ask, setAsk] = useState<{
		questionId: string;
		questions: AskQuestion[];
	} | null>(null);
	const [copied, setCopied] = useState(false);
	// Inline rename of the header title (double-click), mirroring the tab strip.
	// `null` = not editing; a string = the working draft.
	const [renameDraft, setRenameDraft] = useState<string | null>(null);
	const [pinned, setPinned] = useState(() => isPinned(session.id));
	// Default to the Plain tab for a Plain-linked session with no code workspace
	// (an ask-mode triage): the conversation timeline is the only panel it has.
	const [panelTab, setPanelTab] = useState<PanelTab>(() => {
		const workspace =
			session.mode !== "ask" &&
			Boolean(session.worktreeDir || session.branch);
		return !workspace && session.plainThreadId ? "plain" : "changes";
	});
	// Sub-agent sidebar: a breadcrumb stack of opened sub-agents (clicking a Task
	// call pushes; nested Task calls push further). Non-empty → the right region
	// shows the sub-agent conversation instead of the Workspace panel.
	const [subagentStack, setSubagentStack] = useState<SubagentRef[]>([]);
	// Stable identity so the memoized TranscriptBlocks bails out on unrelated
	// re-renders (e.g. toggling the workspace panel) instead of re-rendering the
	// whole transcript.
	const openSubagent = useCallback((agentId: string, label: string) => {
		setSubagentStack((prev) =>
			prev.some((s) => s.agentId === agentId)
				? prev
				: [...prev, { agentId, label }],
		);
	}, []);
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
	// Reasoning effort — a composer control mirroring the new-session palette.
	// Threaded through to the runner (forward-compatible; not yet enforced).
	const [effort, setEffort] = useState("high");
	// Optimistic goal: reflects a just-set/cleared goal instantly (the /goal
	// command persists server-side but doesn't broadcast a live session update).
	// `undefined` = defer to session.goal; a string/null = the pending override.
	const [goalOverride, setGoalOverride] = useState<string | null | undefined>(
		undefined,
	);
	// Drop the override once the server-side session catches up (or we switch).
	useEffect(() => setGoalOverride(undefined), [session.id, session.goal]);
	const currentGoal =
		goalOverride !== undefined ? goalOverride : session.goal ?? null;
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
	useEffect(
		() => onPinsChanged(() => setPinned(isPinned(session.id))),
		[session.id],
	);

	const isAsk = session.mode === "ask";
	const hasWorkspace = !isAsk && Boolean(session.worktreeDir || session.branch);
	// Ask→code promotion: creates a worktree and flips the chat to code mode.
	// The 5s session poll picks up the mode change and re-renders with the full
	// code affordances (diff/PR tabs, RepoBar).
	const [promoting, setPromoting] = useState(false);
	const [promoteError, setPromoteError] = useState<string | null>(null);
	async function handlePromote() {
		if (promoting) return;
		setPromoteError(null);
		setPromoting(true);
		try {
			await promoteChatApi(session.id);
		} catch (e) {
			setPromoteError(e instanceof Error ? e.message : "Promote failed");
			setPromoting(false);
		}
	}
	// A linked Plain thread gets a read-only conversation sidebar (+ jump-to-Plain),
	// available even for ask-mode sessions that have no code workspace.
	const hasPlain = Boolean(session.plainThreadId);
	const plainUrl = session.plainThreadId
		? plainThreadUrl(session.plainThreadId)
		: "";
	const panelAvailable = hasWorkspace || hasPlain;
	const isBusy = isRunningLive || isStreaming;

	// Ctrl+R focuses the composer (overrides browser reload while in a session)
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				e.key.toLowerCase() === "r" &&
				e.ctrlKey &&
				!e.metaKey &&
				!e.altKey &&
				!e.shiftKey
			) {
				e.preventDefault();
				composerRef.current?.focus();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// A "new tab" while this session is open is a fresh chat *in this session*:
	// clear the composer and jump to the live edge. We skip the first run (and
	// session switches, which remount this with whatever the counter's at) and
	// only react to real bumps from the tab-bar +.
	const lastNewChatSeq = useRef(newChatSeq);
	useEffect(() => {
		if (newChatSeq === lastNewChatSeq.current) return;
		lastNewChatSeq.current = newChatSeq;
		setInput("");
		setImages([]);
		setFiles([]);
		setForkFrom(null);
		scrollToLatest("smooth");
		composerRef.current?.focus();
	}, [newChatSeq, scrollToLatest]);

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
					const switches: TranscriptEntry[] = (session.modelHistory || []).map(
						(h) => ({
							id: `model-switch-${h.at}`,
							type: "system" as const,
							content: `Model switched to ${h.model}${h.by ? ` by ${h.by}` : ""}`,
							timestamp: h.at,
						}),
					);
					const merged = [...msg.entries, ...switches].sort(
						(a, b) =>
							new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
					);
					setEntries(merged);
					setHistoryTruncated(!!msg.truncated);
					setLoadingHistory(false);
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
					const landed = msg.entries.filter(
						(e) => e.type === "assistant" && e.content,
					);
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
						setAsk((prev) =>
							prev?.questionId === msg.questionId ? null : prev,
						);
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
				.map((e) => ({
					c: e.content.trim(),
					t: new Date(e.timestamp).getTime(),
				}));
			// A just-sent message is confirmed by a queued echo, a steer receipt
			// (busy/fold-in path), or a real transcript user entry.
			const echoPool = [...queued, ...steered].map((q) => q.content.trim());
			const remaining = prev.filter((p) => {
				const c = p.content.trim();
				const qi = echoPool.indexOf(c);
				if (qi >= 0) {
					echoPool.splice(qi, 1);
					return false;
				}
				// Interrupt/steer-path sends land in the transcript with a "[user] "
				// attribution prefix (added server-side), while the optimistic bubble
				// holds the raw text — accept either form so a redirected message's
				// bubble reconciles instead of sticking as "redirecting…".
				const attributed = p.user ? `[${p.user}] ${c}` : c;
				const ui = userPool.findIndex(
					(u) => (u.c === c || u.c === attributed) && u.t >= p.sentAt - 30_000,
				);
				if (ui >= 0) {
					userPool.splice(ui, 1);
					return false;
				}
				return Date.now() - p.sentAt < 120_000;
			});
			return remaining.length === prev.length ? prev : remaining;
		});
	}, [entries, queued, steered]);

	// A steer receipt is reconciled away once its message lands in the transcript
	// (its turn started) — until then it's the only visible record of the fold-in.
	const visibleSteered = useMemo(() => {
		if (steered.length === 0) return steered;
		const userPool = entries
			.filter((e) => e.type === "user")
			.map((e) => e.content.trim());
		return steered.filter((s) => {
			const raw = s.content.trim();
			// Same attribution prefix as the transcript entry — match either form.
			const attributed = s.user ? `[${s.user}] ${raw}` : raw;
			const i = userPool.findIndex((u) => u === raw || u === attributed);
			if (i >= 0) {
				userPool.splice(i, 1);
				return false;
			}
			return true;
		});
	}, [steered, entries]);

	// Forget optimistic bubbles when switching sessions
	useEffect(() => {
		setPending([]);
	}, [session.id]);

	// Reopen where the reader left off. A running session jumps to the live edge to
	// track the stream; an idle one opens at the last user turn so its reply reads
	// from the start, not the absolute bottom (principle 11).
	const didInitialScroll = useRef(false);
	useEffect(() => {
		didInitialScroll.current = false;
	}, [session.id]);
	useEffect(() => {
		const el = messagesRef.current;
		if (!el || didInitialScroll.current || entries.length === 0) return;
		didInitialScroll.current = true;
		if (session.isRunning) {
			scrollToLatest("auto");
		} else {
			const userEls = el.querySelectorAll<HTMLElement>(".msg-user");
			const lastUser = userEls[userEls.length - 1];
			if (lastUser) anchorToTop(lastUser);
			else scrollToLatest("auto");
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
	const isCodexModel =
		effectiveModel.startsWith("gpt") || effectiveModel.startsWith("codex");
	// A backstage chat with no engine ids is a *fresh* chat (e.g. a new sibling
	// from the tab strip's +): the composer stays enabled — its first prompt
	// starts a new engine conversation server-side (see runSessionPrompt). Only
	// non-backstage sources with no engine to resume stay read-only.
	const noEngine =
		!isCodexModel &&
		!session.claudeSessionId &&
		!session.codexThreadId &&
		session.source !== "backstage";
	// Fork uses the SDK's forkSession, which is Claude-only.
	const isClaudeSession = !isCodexModel && !!session.claudeSessionId;

	const handleFork = useCallback((messageId: string) => {
		setForkFrom(messageId);
	}, []);

	function handleSend() {
		const text = input.trim();
		const imgs = images;
		const fls = files;
		if (!text && imgs.length === 0 && fls.length === 0) return;
		if (!connected) return;

		const user = getCurrentUser();
		const filePayload = fls.map((f) => ({ name: f.name, dataUrl: f.dataUrl }));

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
				...(fls.length ? { files: filePayload } : {}),
			});
			setForkFrom(null);
			setInput("");
			setImages([]);
			setFiles([]);
			return;
		}

		if (noEngine) return;
		// Default while busy: interrupt the current turn and redirect right away, so
		// the message lands now instead of waiting (possibly many minutes) for the
		// turn to end. Idle: just run it. (Interrupt/steer follow-ups are text-only,
		// so images ride the idle "prompt" path; they're dropped while busy either
		// way.) The gentle "fold in at the next stopping point" option is the +
		// button → handleSteerSend.
		send(
			isBusy
				? {
						type: "interrupt_prompt",
						sessionId: session.id,
						content: text,
						user,
						effort,
					}
				: {
						type: "prompt",
						sessionId: session.id,
						content: text,
						user,
						effort,
						...(imgs.length ? { images: imgs } : {}),
						...(fls.length ? { files: filePayload } : {}),
					},
		);
		beginTurn(); // pin this new turn near the top so its reply streams in below
		// Show it immediately; reconciled away when the real turn / queue echo lands
		setPending((p) => [
			...p,
			{
				id: `pending-${crypto.randomUUID()}`,
				content: text,
				user,
				sentAt: Date.now(),
				images: !isBusy && imgs.length ? imgs : undefined,
			},
		]);
		setInput("");
		setImages([]);
		setFiles([]);
	}

	// Gentle alternative to handleSend while busy: fold the message into the run at
	// Michael's next stopping point without interrupting the current turn.
	function handleSteerSend() {
		const text = input.trim();
		if (!text) return;
		if (!connected || noEngine) return;

		const user = getCurrentUser();
		send({ type: "prompt", sessionId: session.id, content: text, user });
		beginTurn(); // pin this new turn near the top so its reply streams in below
		setPending((p) => [
			...p,
			{
				id: `pending-${crypto.randomUUID()}`,
				content: text,
				user,
				sentAt: Date.now(),
			},
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
			navigator.clipboard
				.writeText(link)
				.then(flash, () => fallbackCopy(link, flash));
		} else {
			fallbackCopy(link, flash);
		}
	}

	function commitRename() {
		if (renameDraft !== null) {
			// When the header titles the workspace, renaming edits the workspace —
			// every sibling chat picks the new name up. Chat titles live on tabs.
			if (workspaceName && onRenameWorkspace)
				onRenameWorkspace(renameDraft.trim());
			else onRename?.(session.id, renameDraft.trim());
		}
		setRenameDraft(null);
	}

	// Drop an in-progress rename when switching sessions so the draft never bleeds
	// into the next session's header.
	useEffect(() => setRenameDraft(null), [session.id]);

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

	// Pin or clear the session goal from the composer's Goal button. Routed
	// through the /goal slash command (handled backstage-side, not a real turn);
	// optimistically reflected via goalOverride until the session file catches up.
	function handleSetGoal(goal: string | null) {
		setGoalOverride(goal);
		send({
			type: "prompt",
			sessionId: session.id,
			content: goal ? `/goal ${goal}` : "/goal clear",
			user: getCurrentUser(),
		});
	}

	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteLabel, setDeleteLabel] = useState("");

	// Responsive header: when the top bar gets narrow (small window, sidebar +
	// workspace panel both open), the title truncates first (CSS), then the
	// secondary actions (pin, Share, Spin off, Delete) collapse into a ⋯ menu so
	// they never overlap the title. Measured on the header element itself so it
	// tracks the real available width regardless of the surrounding chrome.
	const headerRef = useRef<HTMLDivElement>(null);
	const [headerW, setHeaderW] = useState(0);
	useLayoutEffect(() => {
		const el = headerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) setHeaderW(e.contentRect.width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [topbarEl]);
	// Collapse before the inline row can overrun: the title's non-shrinkable
	// floor (source chip + repo chips + model pill + Working pill) plus all six
	// action buttons needs ~900px, so below that the secondary actions move into
	// the ⋯ menu.
	const compactHeader = headerW > 0 && headerW < 900;

	const [overflowOpen, setOverflowOpen] = useState(false);
	const overflowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!overflowOpen) return;
		const onDoc = (e: MouseEvent) => {
			if (!overflowRef.current?.contains(e.target as Node))
				setOverflowOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [overflowOpen]);
	// A wider header no longer needs the menu — don't leave it stuck open.
	useEffect(() => {
		if (!compactHeader) setOverflowOpen(false);
	}, [compactHeader]);

	const me = getCurrentUser();

	async function handleDelete(cleanWorktree: boolean) {
		setDeleteLabel(
			cleanWorktree ? "Deleting session and worktree…" : "Deleting session…",
		);
		setDeleting(true);
		try {
			await deleteSessionApi(session.id, cleanWorktree);
			// Leave the overlay up through the navigation so it never flashes back to
			// the (now-deleted) session view.
			onBack();
		} catch (e: any) {
			alert(`Delete failed: ${e.message}`);
			setDeleting(false);
			setShowDeleteConfirm(false);
		}
	}

	return (
		<div className="session-viewer">
			{deleting && (
				<div
					className="session-delete-overlay"
					role="status"
					aria-live="polite"
				>
					<div className="session-delete-card">
						<div className="restart-spinner" />
						<span className="session-delete-label">{deleteLabel}</span>
					</div>
				</div>
			)}
			{(() => {
				// Secondary actions that ride inline on a wide header but tuck into
				// the ⋯ overflow menu when it gets narrow.
				const collapsibleActions = (
					<>
						<Tooltip label={pinned ? "Unpin tab" : "Pin as tab"}>
							<button
								className={`btn-viewer-pin ${pinned ? "active" : ""}`}
								onClick={() => togglePin(session.id)}
								aria-pressed={pinned}
							>
								{pinned ? "★" : "☆"}
							</button>
						</Tooltip>
						<button
							className={`btn-viewer-share ${copied ? "btn-viewer-share-done" : ""}`}
							onClick={handleShare}
							title="Copy a link to this session"
						>
							{copied ? "Copied ✓" : "Share"}
						</button>
						<SpinOffMenu
							session={session}
							entries={entries}
							send={send}
							connected={connected}
						/>
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
									<button
										className="btn-delete-wt"
										onClick={() => handleDelete(true)}
										disabled={deleting}
									>
										{deleting ? "…" : "+ Worktree"}
									</button>
								)}
								<button
									className="btn-delete-only"
									onClick={() => handleDelete(false)}
									disabled={deleting}
								>
									{deleting ? "…" : "Session"}
								</button>
								<button
									className="btn-delete-cancel"
									onClick={() => setShowDeleteConfirm(false)}
									disabled={deleting}
								>
									Cancel
								</button>
							</div>
						)}
					</>
				);
				const header = (
					<div
						className={`viewer-header ${compactHeader ? "viewer-header-compact" : ""}`}
						ref={headerRef}
					>
						<div className="viewer-title">
					{isAsk ? (
						<>
							<span className="source-chip source-ask">ask</span>
							<Tooltip
								label={
									promoteError ||
									"Create a worktree for this chat and switch it to code mode"
								}
							>
								<button
									type="button"
									className="viewer-promote-btn"
									onClick={handlePromote}
									disabled={promoting}
								>
									{promoting ? "Creating worktree…" : "Create worktree"}
								</button>
							</Tooltip>
						</>
					) : (
						<span className={`source-chip source-${session.source}`}>
							{session.source}
						</span>
					)}
					{/* Repo chips ride in the header in front of the workspace title —
					    the top bar reads "repo · workspace", no separate repo row. */}
					{session.worktreeDir && !isAsk && (
						<RepoBar
							sessionId={session.id}
							primaryRepo={session.repo || "tella-fusion"}
							branch={session.branch}
							initialAttached={session.attachedRepos || []}
						/>
					)}
					{renameDraft !== null ? (
						<input
							className="viewer-branch-rename"
							value={renameDraft}
							autoFocus
							onChange={(e) => setRenameDraft(e.target.value)}
							onFocus={(e) => e.target.select()}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename();
								else if (e.key === "Escape") setRenameDraft(null);
								e.stopPropagation();
							}}
						/>
					) : (
						<span
							className={`viewer-branch ${onRename ? "viewer-branch-editable" : ""}`}
							title={
								workspaceName
									? `${session.title} — double-click to rename the workspace`
									: onRename
										? "Double-click to rename"
										: session.title
							}
							onDoubleClick={
								onRename
									? () => setRenameDraft(workspaceName || session.title)
									: undefined
							}
						>
							{workspaceName || session.title}
						</span>
					)}
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
					{session.archived && (
						<span className="source-chip source-cli">archived</span>
					)}
					{isBusy && (
						<span className="working-pill">
							<span className="working-dot" />
							<span className="working-label">
								{streamBy ? `Working for ${streamBy}` : "Working"}
							</span>
						</span>
					)}
				</div>
				<div className="viewer-header-actions">
					{viewers.length > 1 && (
						<div className="presence" title={`Viewing: ${viewers.join(", ")}`}>
							{dedupeViewers(viewers).map((v) => (
								<span
									key={v.name}
									className={`presence-avatar ${v.name === me ? "presence-me" : ""}`}
								>
									{v.name.charAt(0).toUpperCase()}
									{v.count > 1 ? (
										<span className="presence-count">{v.count}</span>
									) : null}
								</span>
							))}
						</div>
					)}
					{session.linearIssue?.url && (
						<a
							href={session.linearIssue.url}
							target="_blank"
							rel="noopener"
							className="session-link session-link-linear"
						>
							{session.linearIssue.identifier}
						</a>
					)}
					{hasPlain && (
						<a
							href={plainUrl}
							target="_blank"
							rel="noopener"
							className="session-link session-link-plain"
						>
							Plain ↗
						</a>
					)}
					<PreviewButton session={session} />
					{hasWorkspace && session.prUrl && (
						<button
							className={`btn-panel-toggle btn-pr-header ${
								panelOpen && subagentStack.length === 0 && panelTab === "pr"
									? "active"
									: ""
							}`}
							onClick={() => {
								// Jump straight to the PR tab in the workspace panel — a PR is
								// worth surfacing without first hunting through Workspace.
								setSubagentStack([]);
								setPanelTab("pr");
								setPanelOpen(true);
							}}
							title={`Open PR #${session.prNumber ?? ""} (${(session.prState || "OPEN").toLowerCase()})`}
						>
							<span
								className={`panel-tab-dot pr-dot-${(session.prState || "OPEN").toLowerCase()}`}
							/>
							<span className="btn-pr-label">
								PR{session.prNumber ? ` #${session.prNumber}` : ""}
							</span>
						</button>
					)}
					{/* Pin / Share / Spin off / Delete ride inline when there's room,
					    else collapse behind ⋯ so they never crowd the title. They sit
					    before Workspace so the Workspace toggle stays rightmost. */}
					{compactHeader ? (
						<div className="viewer-overflow" ref={overflowRef}>
							<button
								className={`btn-viewer-overflow ${overflowOpen ? "active" : ""}`}
								onClick={() => setOverflowOpen((o) => !o)}
								title="More actions"
								aria-label="More actions"
								aria-expanded={overflowOpen}
							>
								⋯
							</button>
							{overflowOpen && (
								<div className="viewer-overflow-menu">
									{collapsibleActions}
								</div>
							)}
						</div>
					) : (
						collapsibleActions
					)}
					{panelAvailable && (
						<Tooltip
							label={
								hasWorkspace
									? "Toggle side panel (changes, terminal, PR, Plain)"
									: "Toggle Plain conversation panel"
							}
						>
							<button
								className={`btn-panel-toggle btn-workspace ${panelOpen && subagentStack.length === 0 ? "active" : ""}`}
								onClick={() => {
									// The sub-agent panel and Workspace share the right slot; opening
									// Workspace closes the sub-agent view.
									if (subagentStack.length > 0) {
										setSubagentStack([]);
										setPanelOpen(true);
									} else {
										setPanelOpen(!panelOpen);
									}
								}}
								aria-label="Toggle side panel"
							>
								{/* Iconic sidebar-right glyph — reads as "right side panel". */}
								<IconSidebarRight className="btn-panel-toggle-icon" size={19} />
							</button>
						</Tooltip>
					)}
				</div>
			</div>
				);
				return topbarEl ? createPortal(header, topbarEl) : header;
			})()}

			{(session.goal || session.loop) && (
				<div className="session-banners">
					{session.goal && (
						<span className="session-banner" title="Cleared with /goal clear">
							🎯 {session.goal}
						</span>
					)}
					{session.loop && (
						<span
							className="session-banner"
							title={`"${session.loop.prompt}" — stop with /loop stop`}
						>
							⟳ every {session.loop.intervalMinutes}m —{" "}
							{session.loop.prompt.slice(0, 60)}
							{session.loop.prompt.length > 60 ? "…" : ""}
						</span>
					)}
				</div>
			)}

			<div className="viewer-split">
				<div className="viewer-chat">
					<div className="viewer-messages-region">
						<div
							className="viewer-messages"
							ref={messagesRef}
							onScroll={onScroll}
						>
							{loading ? (
								<div className="loading">Loading transcript…</div>
							) : entries.length === 0 && !session.transcriptPath ? (
								// A fresh chat with no run yet is just an empty conversation —
								// blank canvas, the composer below is the UI. Only a session
								// that *ran* but has no transcript file gets the notice.
								session.claudeSessionId || session.codexThreadId ? (
									<div className="empty">
										No transcript available for this session
									</div>
								) : null
							) : entries.length === 0 ? (
								<div className="empty">Empty transcript</div>
							) : (
								<>
									{historyTruncated && (
										<div className="load-history">
											<button
												className="load-history-btn"
												disabled={loadingHistory}
												onClick={() => {
													setLoadingHistory(true);
													send({ type: "load_history", sessionId: session.id });
												}}
											>
												{loadingHistory
													? "Loading earlier history…"
													: "↑ Load earlier history"}
											</button>
										</div>
									)}
									<TranscriptBlocks
										entries={entries}
										live={isBusy}
										onFork={isClaudeSession ? handleFork : undefined}
										onOpenSubagent={openSubagent}
										// For automation-owned sessions (e.g. a GitHub PR run), the
										// automation never *types* a user turn — humans steer them.
										// So don't credit un-attributed turns to the automation
										// ("GitHub (automation)"); leave the owner unset so they read
										// as "You" (explicit [Name] steers still show the teammate).
										owner={
											session.automation
												? undefined
												: session.startedBy || undefined
										}
									/>
								</>
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

							{visibleSteered.map((s, i) => {
								const hr = parseHumanReply(s.content);
								return (
									<div
										key={`steered-${i}`}
										className={`msg msg-queued ${hr ? "msg-human" : "msg-user"}`}
									>
										<div
											className={`msg-label ${hr ? "msg-label-human" : "msg-label-user"}`}
										>
											{hr ? `💬 ${hr.name} · via Slack` : s.user || "You"} ·
											folded in
										</div>
										<div
											className={`msg-body ${hr ? "msg-body-human" : "msg-body-user"}`}
										>
											{hr ? hr.body : s.content}
										</div>
									</div>
								);
							})}

							{queued.map((q, i) => {
								const hr = parseHumanReply(q.content);
								return (
									<div
										key={`queued-${i}`}
										className={`msg msg-queued ${hr ? "msg-human" : "msg-user"}`}
									>
										<div
											className={`msg-label ${hr ? "msg-label-human" : "msg-label-user"}`}
										>
											{hr ? `💬 ${hr.name} · via Slack` : q.user || "You"} ·
											queued
										</div>
										<div
											className={`msg-body ${hr ? "msg-body-human" : "msg-body-user"}`}
										>
											{hr ? hr.body : q.content}
										</div>
									</div>
								);
							})}

							{pending.map((p) => (
								<div key={p.id} className="msg msg-user msg-sending">
									<div className="msg-label msg-label-user">
										{p.user || "You"} · {isBusy ? "redirecting…" : "sending…"}
									</div>
									{p.content && (
										<div className="msg-body msg-body-user">{p.content}</div>
									)}
									{p.images && p.images.length > 0 && (
										<div className="msg-images">
											{p.images.map((src, i) => (
												<img
													key={i}
													className="md-image"
													src={src}
													alt=""
													loading="lazy"
												/>
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
								{isBusy
									? "Michael is replying"
									: newBelow
										? "New messages"
										: "Jump to latest"}
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
										{streamBy && streamBy !== me
											? `${streamBy} is driving — Michael is working…`
											: "Michael is working…"}
										{(queued.length > 0 || visibleSteered.length > 0) && (
											<span className="queue-count">
												{visibleSteered.length > 0 &&
													`${visibleSteered.length} folded in`}
												{visibleSteered.length > 0 && queued.length > 0 && ", "}
												{queued.length > 0 && `${queued.length} queued`}
											</span>
										)}
										<button
											className="btn-cancel"
											onClick={handleCancel}
											title="Stop the current run"
										>
											<span className="btn-cancel-icon" />
											Stop
										</button>
									</div>
								)}
								{forkFrom && (
									<div className="fork-banner">
										<span>
											⑂ Forking a new session from the selected message — type
											the new direction.
										</span>
										<button
											className="fork-banner-cancel"
											onClick={() => setForkFrom(null)}
										>
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
									files={files}
									onFilesChange={setFiles}
									placeholder={
										!connected
											? "Not connected"
											: forkFrom
												? "New direction for the forked session…"
												: isBusy
													? "Message Michael — interrupts and redirects now (+ folds in instead)…"
													: "Ask Michael to build, fix, or explain…"
									}
									disabled={!connected}
									sendDisabled={
										!input.trim() && images.length === 0 && !forkFrom
									}
									busy={isBusy && !forkFrom}
									onSteerSend={forkFrom ? undefined : handleSteerSend}
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
									effort={effort}
									onEffortChange={setEffort}
									goal={currentGoal}
									onSetGoal={
										session.source === "backstage" ? handleSetGoal : undefined
									}
									mentionFetch={(q) => fetchFileMentions(q, session.id)}
									textareaRef={composerRef}
								/>
							</>
						)}
					</div>
				</div>

				{/* Right region: a sub-agent conversation takes precedence over the
            Workspace panel when one is open. Portaled to an app-level slot so it
            opens as a full-height column beside the left sidebar (not just below
            the chat header). */}
				{(() => {
				const rightRegion = (
					<>
				{(subagentStack.length > 0 || (panelAvailable && panelOpen)) && (
					<div
						className="panel-overlay"
						onClick={() =>
							subagentStack.length > 0
								? setSubagentStack([])
								: setPanelOpen(false)
						}
					/>
				)}
				{subagentStack.length > 0 ? (
					<SubagentPanel
						sessionId={session.id}
						stack={subagentStack}
						onOpenSubagent={openSubagent}
						onBack={() => setSubagentStack((prev) => prev.slice(0, -1))}
						onClose={() => setSubagentStack([])}
					/>
				) : panelAvailable && panelOpen ? (
					<div className="viewer-panel">
						<div className="panel-tabs">
							{hasWorkspace && (
								<>
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
											<span
												className={`panel-tab-dot pr-dot-${session.prState.toLowerCase()}`}
											/>
										)}
									</button>
									<button
										className={`panel-tab ${panelTab === "slack" ? "active" : ""}`}
										onClick={() => setPanelTab("slack")}
									>
										Slack
										{session.slackChannel && <span className="panel-tab-dot" />}
									</button>
								</>
							)}
							{hasPlain && (
								<button
									className={`panel-tab ${panelTab === "plain" ? "active" : ""}`}
									onClick={() => setPanelTab("plain")}
								>
									Plain
									<span className="panel-tab-dot" />
								</button>
							)}
							{session.branch && (
								<span className="panel-branch" title={session.branch}>
									{session.branch}
								</span>
							)}
							<button
								className="panel-close"
								onClick={() => setPanelOpen(false)}
								aria-label="Close panel"
							>
								✕
							</button>
						</div>
						<div className="panel-body">
							{/* Plain-only sessions (no code workspace) show just the timeline. */}
							{(panelTab === "plain" || !hasWorkspace) && hasPlain ? (
								<PlainThreadPanel
									sessionId={session.id}
									threadId={session.plainThreadId!}
									plainUrl={plainUrl}
								/>
							) : panelTab === "changes" ? (
								<DiffPanel
									sessionId={session.id}
									isRunning={isBusy}
									canSend={connected && !isBusy && !noEngine}
									send={send}
								/>
							) : panelTab === "terminal" ? (
								<TerminalPanel entries={entries} />
							) : panelTab === "slack" ? (
								<SlackChatPanel
									sessionId={session.id}
									slackChannel={session.slackChannel}
									user={getCurrentUser()}
									addHandler={addHandler}
								/>
							) : (
								<PrPanel
									sessionId={session.id}
									send={send}
									repos={[
										{
											repo: session.repo || "tella-fusion",
											primary: true,
										},
										...(session.attachedRepos || []).map((r) => ({
											repo: r.repo,
											primary: false,
										})),
									]}
								/>
							)}
						</div>
					</div>
				) : null}
					</>
				);
				return rightPanelEl ? createPortal(rightRegion, rightPanelEl) : rightRegion;
				})()}
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

function dedupeViewers(
	viewers: string[],
): Array<{ name: string; count: number }> {
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
