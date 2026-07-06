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
import { isGitHubAttribution, parseHumanReply } from "../lib/humanReply";
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
import { UserAvatar } from "./UserAvatar";
import {
	deleteSessionApi,
	archiveSessionApi,
	fetchModels,
	fetchClaudeAccounts,
	fetchFileMentions,
	fetchSkillMentions,
	promoteChatApi,
	type WorkspaceMediaItem,
	type ModelOption,
	type ClaudeAccountOption,
} from "../lib/api";
import { Composer } from "./Composer";
import { SchedulePromptButton } from "./SchedulePrompt";
import type { FileAttachment } from "../lib/images";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { DiffPanel } from "./DiffPanel";
import { RepoBar } from "./RepoBar";
import { RepoSwitchMenu } from "./RepoSwitchMenu";
import { AskCard } from "./AskCard";
import { PrPanel } from "./PrPanel";
import { PrStatusBar } from "./PrStatusBar";
import { SlackChatPanel } from "./SlackChatPanel";
import { PlainThreadPanel } from "./PlainThreadPanel";
import { PreviewButton } from "./PreviewButton";
import { StagingLink } from "./StagingLink";
import { WorkspaceInfo } from "./WorkspaceInfo";
import { SpinOffMenu } from "./SpinOffMenu";
import {
	IconSidebarRight,
	IconTrash,
	IconArchive,
	IconChevronDown,
	IconPlus,
	IconPencil,
	IconArrowDownRight,
	IconArrowUp,
	IconCrosshair,
	IconStar,
	IconPullRequest,
} from "./icons";
import { SessionRelations, type RelatedSession } from "./SessionRelations";
import { Tooltip } from "../ui/tooltip";
import { isPinned, togglePin, onPinsChanged } from "../lib/pins";
import { useChatScroll } from "../hooks/useChatScroll";
import {
	getBusySendPref,
	onBusySendChanged,
	type BusySendPref,
} from "../lib/send-key";

type QueueReceipt = {
	id?: string;
	content: string;
	user?: string;
	images?: string[];
	files?: unknown;
};

interface Props {
	session: UnifiedSession;
	onBack: () => void;
	/** Called after a successful archive (not unarchive), with whether archiving
	    gracefully stopped an in-flight owned turn — so the parent can toast. */
	onArchived?: (stoppedRun: boolean) => void;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	connected: boolean;
	/** Opening prompt shown while a just-created session is still catching up
	    through the session poll. Reconciles away when the transcript arrives. */
	initialPending?: {
		content: string;
		user: string;
		sentAt: number;
		images?: string[];
	};
	/** App-level top-bar node above the tab strip; when present the header renders
	    there (name-on-top layout) instead of inline. */
	topbarEl?: HTMLElement | null;
	/** Right-side slot inside the mobile top bar (next to the centered title).
	    On phones the header actions portal there — a single iOS-style nav bar —
	    instead of rendering as their own row. Desktop ignores it. */
	headerActionsEl?: HTMLElement | null;
	/** Centered slot under the mobile top-bar title. On phones the composer's
	    model pill is hidden, so a compact tap-to-switch model selector portals
	    here instead. Desktop ignores it. */
	headerModelEl?: HTMLElement | null;
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
	/** Sibling chats in this chat's workspace (the tab strip's list, oldest
	    first) — feeds the floating overview panel's cross-chat media. */
	workspaceChats?: UnifiedSession[];
	/** Start a new chat in this workspace — surfaced in the ⋯ menu so it's
	    reachable on a phone, where the tab strip's + button is hidden. */
	onNewChat?: (mode: "share" | "stack" | "ask") => void;
	/** Orchestrator this session was delegated from (when it's a worker
	    sub-session), and the worker sessions it in turn spawned. Powers the
	    header relationship chips. */
	parentSession?: RelatedSession | null;
	workerSessions?: RelatedSession[];
	/** Navigate to another session (used by the relationship chips). */
	onOpenSession?: (id: string) => void;
	/** Mirror live run state into the app-level session list for sidebar rows. */
	onRunningChange?: (id: string, isRunning: boolean) => void;
}

type PanelTab = "info" | "changes" | "terminal" | "pr" | "slack" | "plain";

/** Workspace of the Plain app the tickets live in (for the "jump into Plain" link). */
const PLAIN_WORKSPACE_ID = "w_01J7WXJG68TFDV9RD1C4JE3W6F";
function plainThreadUrl(threadId: string): string {
	return `https://app.plain.com/workspace/${PLAIN_WORKSPACE_ID}/thread/${threadId}/`;
}

function modelIsCodex(id: string, models: ModelOption[]): boolean {
	const found = models.find((m) => m.id === id);
	if (found) return found.provider === "codex";
	return id.startsWith("gpt") || id.startsWith("codex");
}

// Friendly "<name> · <engine>" for the model-switch divider, so a cross-provider
// switch reads unmistakably as e.g. "Sonnet · Claude → GPT-5.5 · Codex". Pure
// (no models list needed) so it works in the transcript_init weave before the
// models endpoint has loaded.
const MODEL_NAMES: Record<string, string> = {
	"claude-fable-5": "Fable",
	"claude-opus-4-8": "Opus 4.8",
	"claude-sonnet-5": "Sonnet",
	"claude-haiku-4-5-20251001": "Haiku",
	"gpt-5.5": "GPT-5.5",
	"gpt-5": "GPT-5",
	codex: "Codex",
};
function prettyModel(id: string): string {
	const isCodex = id.startsWith("gpt") || id.startsWith("codex");
	const name = MODEL_NAMES[id] || id;
	return `${name} · ${isCodex ? "Codex" : "Claude"}`;
}
function switchDividerText(model: string, from?: string, by?: string): string {
	const head = from
		? `Switched ${prettyModel(from)} → ${prettyModel(model)}`
		: `Switched to ${prettyModel(model)}`;
	return by ? `${head} · ${by}` : head;
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
	onArchived,
	send,
	addHandler,
	connected,
	initialPending,
	topbarEl,
	headerActionsEl,
	headerModelEl,
	rightPanelEl,
	newChatSeq,
	onRename,
	workspaceName,
	onRenameWorkspace,
	workspaceChats,
	onNewChat,
	parentSession,
	workerSessions,
	onOpenSession,
	onRunningChange,
}: Props) {
	const [entries, setEntries] = useState<TranscriptEntry[]>([]);
	// No transcript file yet (a fresh chat that hasn't run) → nothing to load;
	// render the empty chat immediately instead of a "Loading transcript…" flash.
	const [loading, setLoading] = useState(!!session.transcriptPath);
	// The initial transcript is the tail only when the file is large; these drive
	// the "load earlier history" affordance at the top of the conversation.
	const [historyTruncated, setHistoryTruncated] = useState(false);
	const [loadingHistory, setLoadingHistory] = useState(false);
	// Scroll anchor for "Load earlier history": older entries prepend above the
	// viewport, so keep the reader on the same content by offsetting scrollTop
	// by the height the prepended history added.
	const historyAnchor = useRef<{ height: number; top: number } | null>(null);
	// The composer draft lives INSIDE Composer (uncontrolled mode) so keystrokes
	// don't re-render this whole component; the text arrives via handleSend.
	// Same fix as the CommentableDiff draft-text gotcha.
	// Text + attachments persist in the draft store (keyed per chat) so
	// switching to another chat/workspace — which remounts this component —
	// doesn't lose typed work. Text rides Composer's `draftKey`; the staged
	// images/files live here, seeded from and mirrored into the same draft.
	const draftKey = `chat:${session.id}`;
	const [images, setImages] = useState<string[]>(() => loadDraft(draftKey).images);
	const [files, setFiles] = useState<FileAttachment[]>(() => loadDraft(draftKey).files);
	useEffect(() => {
		saveDraft(draftKey, { images, files });
	}, [draftKey, images, files]);
	// When set, the next send forks a new session branching from this message
	// instead of continuing this one.
	const [forkFrom, setForkFrom] = useState<string | null>(null);
	const [isStreaming, setIsStreaming] = useState(false);
	const [isRunningLive, setIsRunningLive] = useState(session.isRunning);
	const [streamText, setStreamText] = useState("");
	const [streamBy, setStreamBy] = useState<string | null>(null);
	// Bumped on every stream_start; lets the delayed stream_done cleanup verify
	// it isn't wiping a NEWER run's in-progress text.
	const streamSeqRef = useRef(0);
	const [viewers, setViewers] = useState<string[]>([]);
	const [queued, setQueued] = useState<QueueReceipt[]>([]);
	// Steered messages routed into the live run — shown as a steering receipt
	// until their turn writes to the transcript (then reconciled away below).
	const [steered, setSteered] = useState<QueueReceipt[]>([]);
	// One-shot draft injection into the Composer (bump seq to apply) — how
	// "edit queued message" puts the text back into the input.
	const [composerPrefill, setComposerPrefill] = useState<{
		seq: number;
		text: string;
	} | null>(null);
	const [busySend, setBusySend] = useState<BusySendPref>(getBusySendPref);
	useEffect(
		() => onBusySendChanged(() => setBusySend(getBusySendPref())),
		[],
	);
	// Optimistic just-sent messages, shown instantly and reconciled once the real
	// turn lands (transcript) or the server confirms it as queued (busy path).
	// `busyMode` marks a send made while the run was busy: it renders inside the
	// queue flap (as "Queueing…"/"Steering…") instead of as a transcript bubble.
	const [pending, setPending] = useState<
		Array<{
			id: string;
			content: string;
			user: string;
			sentAt: number;
			images?: string[];
			busyMode?: "queue" | "steer";
		}>
	>(() =>
		initialPending
			? [{ id: `pending-initial-${session.id}`, ...initialPending }]
			: [],
	);
	useEffect(() => {
		if (!initialPending) return;
		const content = initialPending.content.trim();
		setPending((prev) => {
			if (prev.some((p) => p.id === `pending-initial-${session.id}`))
				return prev;
			if (
				entries.some(
					(e) => e.type === "user" && (!content || e.content.trim() === content),
				)
			) {
				return prev;
			}
			return [
				...prev,
				{
					id: `pending-initial-${session.id}`,
					...initialPending,
				},
			];
		});
	}, [entries, initialPending, session.id]);
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
	// Otherwise restore the last tab picked in any workspace (remembered per
	// browser), so switching workspaces keeps you on e.g. PR instead of
	// resetting to Changes — but only if this session actually has that tab.
	const [panelTab, setPanelTab] = useState<PanelTab>(() => {
		const workspace =
			session.mode !== "ask" &&
			Boolean(session.worktreeDir || session.branch);
		const stored = localStorage.getItem("michael-panel-tab") as PanelTab | null;
		if (stored) {
			const available =
				stored === "info" ||
				(stored === "plain" ? Boolean(session.plainThreadId) : workspace);
			if (available) return stored;
		}
		return "info";
	});
	function selectPanelTab(tab: PanelTab) {
		setPanelTab(tab);
		localStorage.setItem("michael-panel-tab", tab);
	}
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
	// Right-panel width (px), drag-resizable from its left edge and persisted
	// per browser; 0 = the CSS default (44%). Mirrors the left sidebar's resize.
	// Shared by the Workspace and sub-agent panels via the --panel-w var.
	const [panelW, setPanelW] = useState<number>(() => {
		const v = Number(localStorage.getItem("michael-panel-w"));
		return v >= 320 && v <= 900 ? v : 0;
	});
	const panelWRef = useRef(panelW);
	panelWRef.current = panelW;
	function startPanelResize(e: React.MouseEvent) {
		e.preventDefault();
		// The panel is the rightmost column, so its right edge tracks the pointer's
		// distance from the container's right side.
		const right =
			(e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect()
				.right ?? window.innerWidth;
		document.body.classList.add("resizing-x");
		const onMove = (ev: MouseEvent) => {
			const max = Math.min(900, Math.round(window.innerWidth * 0.72));
			const w = Math.min(max, Math.max(320, Math.round(right - ev.clientX)));
			panelWRef.current = w;
			setPanelW(w);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-x");
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			localStorage.setItem(
				"michael-panel-w",
				String(Math.round(panelWRef.current)),
			);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}
	const panelStyle = panelW
		? ({ "--panel-w": `${panelW}px` } as React.CSSProperties)
		: undefined;
	const panelResizeHandle = (
		<div
			className="panel-resize"
			onMouseDown={startPanelResize}
			aria-hidden="true"
		/>
	);
	// Intent-aware scrolling: stick to the live edge only while the reader is there,
	// pin new turns near the top, and surface a "Jump to latest" affordance.
	const {
		containerRef: messagesRef,
		spacerRef,
		newBelow,
		showScrollToBottom,
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
	// Pinnable Claude subscriptions + this session's pin ("" = auto pool).
	const [accounts, setAccounts] = useState<ClaudeAccountOption[]>([]);
	const [accountId, setAccountId] = useState(session.accountId || "");
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
		fetchClaudeAccounts()
			.then(setAccounts)
			.catch(() => {});
	}, []);
	useEffect(() => {
		setModel(session.model || "");
	}, [session.id, session.model]);
	useEffect(() => {
		setAccountId(session.accountId || "");
	}, [session.id, session.accountId]);

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

	// Anchor for the "Michael is working…" elapsed timer. A run that starts
	// while we're watching anchors to now; opening a session mid-run anchors to
	// the user prompt that started the turn (from the transcript) so the timer
	// shows the run's real age, not time-since-I-opened-the-tab. The ref tracks
	// which case we're in: it stays true until we've observed the session idle.
	const [busySince, setBusySince] = useState<number | null>(null);
	const anchorFromTranscript = useRef(session.isRunning);
	useEffect(() => {
		anchorFromTranscript.current = true;
		setBusySince(null);
	}, [session.id]);
	useEffect(() => {
		if (!isBusy) {
			anchorFromTranscript.current = false;
			setBusySince(null);
			return;
		}
		// Mid-run open: wait for the transcript so we can find the turn's prompt.
		if (anchorFromTranscript.current && loading) return;
		setBusySince((prev) => {
			if (prev != null) return prev;
			if (anchorFromTranscript.current) {
				for (let i = entries.length - 1; i >= 0; i--) {
					if (entries[i].type !== "user") continue;
					const t = new Date(entries[i].timestamp).getTime();
					if (Number.isFinite(t)) return t;
					break;
				}
			}
			return Date.now();
		});
	}, [isBusy, loading, entries]);

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
	// Drop the persisted draft during render, before the key={newChatSeq}
	// remount below re-reads it — in an effect the fresh Composer's state
	// initializer would already have restored the old text. Idempotent, so
	// running on the renders between the bump and the effect below is fine.
	if (newChatSeq !== lastNewChatSeq.current) clearDraft(draftKey);
	useEffect(() => {
		if (newChatSeq === lastNewChatSeq.current) return;
		lastNewChatSeq.current = newChatSeq;
		// The composer's text draft resets via its key={newChatSeq} remount.
		setImages([]);
		setFiles([]);
		setForkFrom(null);
		scrollToLatest("smooth");
		composerRef.current?.focus();
	}, [newChatSeq, scrollToLatest]);

	// Browser tab title follows the session
	useEffect(() => {
		document.title = `${session.title} — Backstage`;
		return () => {
			document.title = "Backstage — Tella";
		};
	}, [session.title]);

	// Subscribe to WebSocket messages
	useEffect(() => {
		if (!connected) return;

		send({ type: "watch", sessionId: session.id, user: getCurrentUser() });

		const unsubscribe = addHandler((msg) => {
			// Session-scoped messages carry the session id — drop anything meant
			// for a different chat. Without this, a socket race (or a lingering
			// creator-side direct send from a chat you navigated away from) bleeds
			// another session's stream into this view. Messages without a
			// sessionId (direct replies like slash-command notices) pass through.
			if (
				"sessionId" in msg &&
				msg.sessionId &&
				msg.sessionId !== session.id
			) {
				return;
			}
			switch (msg.type) {
				case "transcript_init": {
					// Weave persisted model switches into the conversation as dividers
					const switches: TranscriptEntry[] = (session.modelHistory || []).map(
						(h) => ({
							id: `model-switch-${h.at}`,
							type: "system" as const,
							content: switchDividerText(h.model, h.from, h.by),
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
					onRunningChange?.(session.id, msg.isRunning);
					break;
				case "stream_start":
					streamSeqRef.current++;
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
				case "stream_done": {
					setIsStreaming(false);
					setStreamBy(null);
					// Don't wipe the streamed text yet: its persisted transcript entry
					// usually lands a beat later (the 1s file-watcher poll) and the
					// transcript_append handler strips it then — clearing here made the
					// reply blink out and back in (or vanish entirely when the watcher
					// wasn't attached). The timeout is only the fallback for text that
					// never lands as an entry.
					const seq = streamSeqRef.current;
					window.setTimeout(() => {
						if (streamSeqRef.current === seq) setStreamText("");
					}, 5000);
					break;
				}
				case "model_changed":
					if (msg.sessionId !== session.id) break;
					setModel(msg.model);
					if (msg.by && msg.by !== getCurrentUser()) {
						setEntries((prev) => [
							...prev,
							{
								id: `model-switch-${Date.now()}`,
								type: "system",
								content: switchDividerText(msg.model, msg.from, msg.by),
								timestamp: new Date().toISOString(),
							},
						]);
					}
					break;
				case "subscription_changed":
					// Keep every viewer's Subscription submenu in sync; the /sub
					// notice in the transcript carries the human-readable detail.
					if (msg.sessionId !== session.id) break;
					setAccountId(msg.accountId || "");
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

		return () => {
			unsubscribe();
			// Tell the server we stopped watching, so it can drop the transcript
			// stream and our presence entry (otherwise we linger as a ghost viewer).
			// send() is a no-op unless the socket is OPEN, so a dropped connection
			// (the usual reason this effect re-runs) never throws here.
			send({ type: "unwatch", sessionId: session.id });
		};
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
				// Steers pending at the same turn boundary get joined into ONE user
				// turn ("\n\n"-separated, each with its attribution prefix), possibly
				// alongside a harness nudge — so the exact match above never fires.
				// The "[user] " prefix is distinctive enough to claim by containment.
				// Don't splice: the same joined entry may cover other bubbles too.
				if (
					p.user &&
					userPool.some(
						(u) => u.c.includes(attributed) && u.t >= p.sentAt - 30_000,
					)
				) {
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
			// Same composite case as the pending reconcile: co-released steers land
			// joined in one user turn — claim by containment (no splice; one joined
			// entry can cover several receipts).
			if (s.user && userPool.some((u) => u.includes(attributed))) return false;
			return true;
		});
	}, [steered, entries]);

	// Forget optimistic bubbles and any leftover stream state when switching
	// sessions — the component isn't remounted per session, so a streaming
	// bubble (now kept alive briefly past stream_done) would otherwise bleed
	// into the next session's view.
	useEffect(() => {
		setPending(
			initialPending
				? [{ id: `pending-initial-${session.id}`, ...initialPending }]
				: [],
		);
		streamSeqRef.current++;
		setStreamText("");
		setIsStreaming(false);
		setStreamBy(null);
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

	// "Load earlier history" prepends the older transcript above the viewport:
	// restore the reader to the content they were on by adding the prepended
	// height to scrollTop. Declared after relayout() so this write wins the
	// paint. Layout effect: adjusting before paint avoids a jump-to-top flash.
	useLayoutEffect(() => {
		const anchor = historyAnchor.current;
		const el = messagesRef.current;
		if (!anchor || !el) return;
		historyAnchor.current = null;
		el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
	}, [entries, messagesRef]);

	// When a turn finishes, release the spacer so the layout settles back.
	const wasBusyRef = useRef(false);
	useEffect(() => {
		if (wasBusyRef.current && !isBusy) endTurn();
		wasBusyRef.current = isBusy;
	});

	// Codex-model sessions start fresh threads server-side; only Claude-model
	// sessions need an existing claude session id to resume.
	const effectiveModel = model || defaultModel;
	const isCodexModel = modelIsCodex(effectiveModel, models);
	// A backstage chat with no engine ids is a *fresh* chat (e.g. a new sibling
	// from the tab strip's +): the composer stays enabled — its first prompt
	// starts a new engine conversation server-side (see runSessionPrompt). Only
	// non-backstage sources with no engine to resume stay read-only.
	const noEngine =
		!isCodexModel &&
		!session.claudeSessionId &&
		!session.codexThreadId &&
		session.source !== "backstage";
	const busySendLabel =
		busySend === "queue"
			? "Queue for Michael's next turn"
			: "Steer into Michael's current run";
	// Exact engine-state forks use Claude's SDK forkSession. Other backends can
	// still fork as a new sibling with a transcript handoff.
	const canForkSession =
		session.source === "backstage" &&
		!!(session.claudeSessionId || session.codexThreadId || session.transcriptPath);

	const handleFork = useCallback((messageId: string) => {
		setForkFrom(messageId);
	}, []);

	// Session-id links (rendered by markdown.ts into message/tool HTML via
	// dangerouslySetInnerHTML, so they can't carry React handlers) navigate on a
	// delegated click — e.g. jump from an orchestrator into the worker it spawned.
	const handleMessagesClick = useCallback(
		(e: React.MouseEvent) => {
			const el = (e.target as HTMLElement).closest?.(
				".session-link",
			) as HTMLElement | null;
			const id = el?.dataset.sessionId;
			if (!id || !onOpenSession) return;
			e.preventDefault();
			onOpenSession(id);
		},
		[onOpenSession],
	);

	// Returns true when the message was consumed, so the (uncontrolled)
	// Composer knows to clear its draft; false keeps it for a retry.
	// `opts.interrupt` is the per-send override (⌘/Ctrl+Enter while busy):
	// abort the current turn and deliver this message right away.
	function handleSend(raw: string, opts?: { interrupt?: boolean }): boolean {
		const text = raw.trim();
		const imgs = images;
		const fls = files;
		if (!text && imgs.length === 0 && fls.length === 0) return false;
		if (!connected) return false;

		const user = getCurrentUser();
		// Prefer the staged disk path (HTTP upload); fall back to inline dataUrl.
		const filePayload = fls.map((f) =>
			f.path ? { name: f.name, path: f.path } : { name: f.name, dataUrl: f.dataUrl },
		);

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
			setImages([]);
			setFiles([]);
			return true;
		}

		if (noEngine) return false;
		// While busy, respect the per-browser follow-up setting: steer into the
		// live run at its next stopping point (default) or queue for the next
		// turn. `opts.interrupt` (⌘/Ctrl+Enter) aborts the current turn and
		// delivers this send right away instead (the server falls back to the
		// queue when nothing is interruptible or files are attached).
		// Idle: just run it. Attachments ride along on every path — images fold
		// into the run as content blocks; files route to the queue server-side.
		const interrupting = isBusy && !!opts?.interrupt;
		send(
			isBusy
				? interrupting
					? {
							type: "interrupt_prompt" as const,
							sessionId: session.id,
							content: text,
							user,
							effort,
							...(imgs.length ? { images: imgs } : {}),
							...(fls.length ? { files: filePayload } : {}),
						}
					: {
							type: "prompt" as const,
							sessionId: session.id,
							content: text,
							user,
							effort,
							busyMode:
								busySend === "queue" ? ("queue" as const) : ("steer" as const),
							...(imgs.length ? { images: imgs } : {}),
							...(fls.length ? { files: filePayload } : {}),
						}
				: {
						type: "prompt" as const,
						sessionId: session.id,
						content: text,
						user,
						effort,
						...(imgs.length ? { images: imgs } : {}),
						...(fls.length ? { files: filePayload } : {}),
					},
		);
		if (!isBusy || interrupting) {
			setIsRunningLive(true);
			onRunningChange?.(session.id, true);
			beginTurn(); // pin this new turn near the top so its reply streams in below
			// Show it immediately; it reconciles away when the real transcript entry
			// arrives (or the queue echo, if the server turns out to be busy).
			setPending((p) => [
				...p,
				{
					id: `pending-${crypto.randomUUID()}`,
					content: text,
					user,
					sentAt: Date.now(),
					images: imgs.length ? imgs : undefined,
				},
			]);
		} else {
			// Busy send: show it in the queue flap right away (no transcript
			// bubble) — the server's queue_update / steer-receipt echo replaces it.
			setPending((p) => [
				...p,
				{
					id: `pending-${crypto.randomUUID()}`,
					content: text,
					user,
					sentAt: Date.now(),
					images: imgs.length ? imgs : undefined,
					busyMode:
						busySend === "queue" ? ("queue" as const) : ("steer" as const),
				},
			]);
		}
		setImages([]);
		setFiles([]);
		return true;
	}

	function queueHasFiles(item: QueueReceipt): boolean {
		return Array.isArray(item.files) && item.files.length > 0;
	}

	function renderQueueContent(
		item: QueueReceipt,
		opts: { human?: ReturnType<typeof parseHumanReply>; github?: boolean },
	) {
		const firstImage = item.images?.[0];
		const extraImages = Math.max(0, (item.images?.length ?? 0) - 1);
		const body = opts.human ? opts.human.body : item.content;
		return (
			<div className="composer-queue-content">
				{firstImage && (
					<div className="composer-queue-image">
						<img src={firstImage} alt="" />
						{extraImages > 0 && (
							<span className="composer-queue-image-count">+{extraImages}</span>
						)}
					</div>
				)}
				<div className="composer-queue-body">
					{opts.human && (
						<span className="composer-queue-from">💬 {opts.human.name}</span>
					)}
					{opts.github && <span className="composer-queue-from">GitHub</span>}
					{body}
				</div>
			</div>
		);
	}

	// "Edit" pulls the message back into the composer: drop it from the queue
	// and hand its parts (text, images, files) to the draft — sending simply
	// re-queues the edited version.
	function editQueuedInComposer(q: QueueReceipt, index: number) {
		send({
			type: "delete_queued_prompt",
			sessionId: session.id,
			queueId: q.id,
			queueIndex: index,
		});
		if (q.images?.length) {
			const imgs = q.images;
			setImages((prev) => [...prev, ...imgs]);
		}
		if (Array.isArray(q.files) && q.files.length > 0) {
			const fls = q.files as FileAttachment[];
			setFiles((prev) => [...prev, ...fls]);
		}
		setComposerPrefill((p) => ({ seq: (p?.seq ?? 0) + 1, text: q.content }));
	}

	// Busy sends live in the flap from the moment of the send; idle sends are
	// optimistic transcript bubbles. Both reconcile through the same effect.
	const pendingQueue = pending.filter((p) => p.busyMode);
	const pendingBubbles = pending.filter((p) => !p.busyMode);
	const hasLiveConversation =
		pendingBubbles.length > 0 || !!streamText || isBusy || !!ask;

	const queueCount = queued.length + visibleSteered.length + pendingQueue.length;
	const attachedQueue =
		queueCount > 0 ? (
			<div className="composer-queue" aria-label="Queued messages">
				<div className="composer-queue-title">
					{queueCount} queued {queueCount === 1 ? "message" : "messages"}
				</div>
				{visibleSteered.map((s, i) => {
					const hr = parseHumanReply(s.content);
					return (
						<div
							key={`steered-${i}`}
							className={`composer-queue-item composer-queue-steered ${hr ? "is-human" : ""}`}
						>
							<div className="composer-queue-actions">
								<span className="composer-queue-pill">
									<IconCrosshair size={20} />
									Steering
								</span>
								{s.id && (
									<Tooltip label="Dismiss — the run keeps going; this message won't be re-sent">
										<button
											type="button"
											className="composer-queue-action danger"
											onClick={() =>
												send({
													type: "delete_queued_prompt",
													sessionId: session.id,
													queueId: s.id,
												})
											}
										>
											<IconTrash size={24} />
										</button>
									</Tooltip>
								)}
								{s.id && (
									<Tooltip label="Interrupt — stop the current work and deliver this now">
										<button
											type="button"
											className="composer-queue-action composer-queue-steer"
											aria-label="Interrupt"
											onClick={() =>
												send({
													type: "interrupt_queued_prompt",
													sessionId: session.id,
													queueId: s.id,
												})
											}
										>
											<IconArrowDownRight size={24} />
										</button>
									</Tooltip>
								)}
							</div>
							{renderQueueContent(s, { human: hr })}
						</div>
					);
				})}

				{queued.map((q, i) => {
					const hr = parseHumanReply(q.content);
					const isGitHub = isGitHubAttribution(q.user);
					const id = q.id;
					const key = id || `queued-${i}`;
					const canSteer = !isGitHub && !queueHasFiles(q);
					return (
						<div
							key={key}
							className={`composer-queue-item ${hr ? "is-human" : ""} ${isGitHub ? "is-github" : ""}`}
						>
							<div className="composer-queue-actions">
								{isGitHub ? (
									<span className="composer-queue-pill composer-queue-pill-github">
										<IconPullRequest size={20} />
										FYI
									</span>
								) : (
									<>
										<Tooltip label="Edit — puts the message back into the composer">
											<button
												type="button"
												className="composer-queue-action"
												onClick={() => editQueuedInComposer(q, i)}
											>
												<IconPencil size={24} />
											</button>
										</Tooltip>
									</>
								)}
								<Tooltip label="Delete queued message">
									<button
										type="button"
										className="composer-queue-action danger"
										onClick={() =>
											send({
												type: "delete_queued_prompt",
												sessionId: session.id,
												queueId: id,
												queueIndex: i,
											})
										}
									>
										<IconTrash size={24} />
									</button>
								</Tooltip>
								{!isGitHub && (
									<>
										<Tooltip
											label={
												canSteer
													? "Steer — folds in when the current work pauses"
													: "Messages with files cannot be steered"
											}
										>
											<button
												type="button"
												className="composer-queue-action composer-queue-steer"
												aria-label="Steer"
												disabled={!canSteer}
												onClick={() =>
													send({
														type: "steer_queued_prompt",
														sessionId: session.id,
														queueId: id,
														queueIndex: i,
													})
												}
											>
												<IconArrowUp size={24} />
											</button>
										</Tooltip>
										<Tooltip
											label={
												canSteer
													? "Interrupt — stop the current work and deliver this now"
													: "Messages with files cannot interrupt"
											}
										>
											<button
												type="button"
												className="composer-queue-action composer-queue-steer"
												aria-label="Interrupt"
												disabled={!canSteer}
												onClick={() =>
													send({
														type: "interrupt_queued_prompt",
														sessionId: session.id,
														queueId: id,
														queueIndex: i,
													})
												}
											>
												<IconArrowDownRight size={24} />
											</button>
										</Tooltip>
									</>
								)}
							</div>
							{renderQueueContent(q, { human: hr, github: isGitHub })}
						</div>
					);
				})}

				{/* Just-sent while busy: already visually in the queue, awaiting the
				    server's echo (which swaps in the real item with actions). */}
				{pendingQueue.map((p) => (
					<div key={p.id} className="composer-queue-item composer-queue-sending">
						<div className="composer-queue-actions">
							<span className="composer-queue-pill composer-queue-pill-sending">
								{p.busyMode === "steer" ? "Steering…" : "Queueing…"}
							</span>
						</div>
						{renderQueueContent(p, {})}
					</div>
				))}
			</div>
		) : null;

	function handleCancel() {
		send({ type: "cancel" });
	}

	function handleShare() {
		// Match the canonical URL App maintains: workspace-scoped when the chat
		// belongs to one, legacy /session/<id> only for workspace-less chats.
		const path = session.projectId
			? `/backstage/workspace/${encodeURIComponent(session.projectId)}/chat/${encodeURIComponent(session.id)}`
			: `/backstage/session/${encodeURIComponent(session.id)}`;
		const link = `${location.origin}${path}`;
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

	// Pin (or clear, "" = auto) the Claude subscription for this session's runs.
	// Same shape as the model switch: the /sub slash command persists, notices,
	// and broadcasts subscription_changed to every viewer.
	function handleAccountChange(next: string) {
		if (next === (accountId || "")) return;
		setAccountId(next);
		const target = next ? accounts.find((a) => a.id === next) : null;
		send({
			type: "prompt",
			sessionId: session.id,
			// The name reads better in the transcript; the command matches by
			// id first, then case-insensitive name, so either form works.
			content: next ? `/sub ${target?.name || next}` : "/sub auto",
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
	const [archiving, setArchiving] = useState(false);
	const [deleteLabel, setDeleteLabel] = useState("");

	// Responsive header: when the top bar gets narrow (small window, sidebar +
	// workspace panel both open), the title truncates first (CSS), then the
	// Share button collapses into the ⋯ menu so it never overlaps the title.
	// (Pin and Spin off live in the ⋯ menu at every width.) Measured on the
	// header element itself so it tracks the real available width regardless
	// of the surrounding chrome.
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
	// floor (source chip + Working pill) plus the inline actions (facepile,
	// links, Share) needs ~740px, so below that Share moves into the ⋯ menu.
	const compactHeader = headerW > 0 && headerW < 740;

	// Phone layout (same 720px breakpoint as the CSS page-stack): the header
	// actions portal into the top bar next to the centered title, and every
	// secondary action folds into the ⋯ menu so the bar holds just ⋯ + Workspace.
	const [isPhone, setIsPhone] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(max-width: 720px)").matches,
	);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 720px)");
		const onChange = () => setIsPhone(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	const [overflowOpen, setOverflowOpen] = useState(false);
	const overflowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!overflowOpen) return;
		const onDoc = (e: MouseEvent) => {
			if (overflowRef.current?.contains(e.target as Node)) return;
			// The Spin off flavor picker is a Base UI popup portaled to <body> —
			// a click inside it must not close the ⋯ menu it was opened from.
			if ((e.target as Element | null)?.closest?.('[role="menu"]')) return;
			setOverflowOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [overflowOpen]);
	// Closing the menu disarms a half-finished delete confirm — reopening it
	// later shouldn't present the destructive choices without a fresh click.
	useEffect(() => {
		if (!overflowOpen) setShowDeleteConfirm(false);
	}, [overflowOpen]);
	// The menu's contents change across the breakpoint — don't leave it stuck open.
	useEffect(() => {
		setOverflowOpen(false);
	}, [compactHeader]);

	const me = getCurrentUser();

	// Media items in the live transcript — bumping this refreshes the floating
	// overview panel as new screenshots land during a run.
	const liveMediaCount = useMemo(
		() =>
			entries.reduce(
				(n, e) => n + (e.images?.length || 0) + (e.videos?.length || 0),
				0,
			),
		[entries],
	);
	const liveOverviewMedia = useMemo<WorkspaceMediaItem[]>(() => {
		const fromImages = (
			items: Array<{ images?: string[]; sentAt?: number }>,
		): WorkspaceMediaItem[] =>
			items.flatMap((item) =>
				(item.images || []).map((src, i) => ({
					kind: "image" as const,
					src,
					sessionId: session.id,
					chatTitle: session.title,
					at: new Date((item.sentAt || Date.now()) + i).toISOString(),
				})),
			);
		return [
			...fromImages(pending),
			...fromImages(queued),
			...fromImages(visibleSteered),
		];
	}, [pending, queued, visibleSteered, session.id, session.title]);

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

	// Archive is the reversible "I'm done with this" — unlike delete it keeps the
	// session (and worktree) and just tucks it into the Archived view, so no
	// confirm step. Unarchiving from here (viewing an already-archived session)
	// brings it back. Either way we hop out to the list the same way delete does.
	const handleArchive = useCallback(async () => {
		const next = !session.archived;
		setArchiving(true);
		setOverflowOpen(false);
		try {
			const { stoppedRun } = await archiveSessionApi(session.id, next);
			if (next) onArchived?.(stoppedRun);
			onBack();
		} catch (e: any) {
			alert(`${next ? "Archive" : "Unarchive"} failed: ${e.message}`);
			setArchiving(false);
		}
	}, [onArchived, onBack, session.archived, session.id]);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				e.defaultPrevented ||
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			) {
				return;
			}
			const target = e.target as HTMLElement | null;
			if (
				target?.closest(
					"input, textarea, select, [contenteditable='true'], [contenteditable='']",
				)
			) {
				return;
			}
			if (
				e.key.toLowerCase() === "a" &&
				(e.metaKey || e.ctrlKey) &&
				e.shiftKey &&
				!e.altKey &&
				!archiving
			) {
				e.preventDefault();
				void handleArchive();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [archiving, handleArchive, session.archived]);

	// Preview / Staging / PR — the code-workspace affordances, docked at the
	// bottom of the right panel (the "right sidebar") so they stay visible on
	// every tab, rather than the main header bar. Each self-gates (renders null
	// when not applicable), so on a plain/ask session the row collapses to
	// nothing (`.panel-actions:empty`).
	const panelActions = (
		<>
			<PreviewButton
				session={session}
				onAttachImage={(img) => setImages((prev) => [...prev, img])}
			/>
			<StagingLink session={session} />
			{hasWorkspace && session.prUrl && (
				<a
					className="btn-panel-toggle btn-pr-header"
					href={session.prUrl}
					target="_blank"
					rel="noreferrer"
					title={`Open PR #${session.prNumber ?? ""} on GitHub (${(session.prState || "OPEN").toLowerCase()})`}
				>
					<span
						className={`panel-tab-dot pr-dot-${(session.prState || "OPEN").toLowerCase()}`}
					/>
					<span className="btn-pr-label">PR ↗</span>
				</a>
			)}
		</>
	);

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
				// Share rides inline on a wide header but tucks into the ⋯ overflow
				// menu when it gets narrow.
				const collapsibleActions = (
					<button
						className={`btn-viewer-share ${copied ? "btn-viewer-share-done" : ""}`}
						onClick={handleShare}
						title="Copy a link to this session"
					>
						{copied ? "Copied" : "Share"}
					</button>
				);
				// New chat in this workspace — phone-only, since desktop has the
				// always-visible + in the tab strip. On a phone the strip (and its
				// hover-revealed +) is hidden, so the ⋯ menu is the only way to add a
				// sibling chat. Shares the workspace worktree, like the + default.
				const newChatAction = isPhone && onNewChat && (
					<button
						className="btn-viewer-newchat"
						onClick={() => {
							setOverflowOpen(false);
							onNewChat("share");
						}}
						title="Start a new chat in this workspace"
					>
						<IconPlus size={22} />
						New chat in workspace
					</button>
				);
				// Switch the primary repo from the ⋯ menu — phone-only, since the
				// inline header RepoBar is hidden on phones. Skipped for ask
				// sessions (no primary repo) and sessions without a worktree.
				const repoAction = isPhone && session.worktreeDir && !isAsk && (
					<RepoSwitchMenu
						sessionId={session.id}
						primaryRepo={session.repo || "tella-fusion"}
						branch={session.branch}
						onSwitched={() => setOverflowOpen(false)}
					/>
				);
				// Star (pin) and Spin off live in the ⋯ menu at every width,
				// alongside Delete — occasional actions, not header chrome.
				const overflowActions = (
					<>
						<button
							className={`btn-viewer-pin ${pinned ? "active" : ""}`}
							onClick={() => togglePin(session.id)}
							aria-pressed={pinned}
						>
							<IconStar size={20} fill={pinned ? "currentColor" : "none"} />
							{pinned ? "Unpin tab" : "Pin as tab"}
						</button>
						<SpinOffMenu
							session={session}
							entries={entries}
							send={send}
							connected={connected}
						/>
					</>
				);
				// Archive is the reversible primary "done with this" action — it sits
				// above Delete in the menu so the safe choice reads first. When the
				// session is already archived this becomes Unarchive.
				const archiveAction = (
					<button
						className="btn-viewer-archive"
						onClick={handleArchive}
						disabled={archiving}
						title={
							session.archived
								? "Unarchive session (⌘⇧A)"
								: "Archive session (⌘⇧A)"
						}
					>
						<IconArchive size={22} />
						<span>
							{archiving
								? session.archived
									? "Unarchiving…"
									: "Archiving…"
								: session.archived
									? "Unarchive session"
									: "Archive session"}
						</span>
						<span className="btn-viewer-shortcut">⌘⇧A</span>
					</button>
				);
				// Delete is destructive, so it never rides in the visible action bar —
				// it always lives inside the ⋯ menu, one deliberate hop away.
				const deleteAction = !showDeleteConfirm ? (
					<button
						className="btn-viewer-delete"
						onClick={() => setShowDeleteConfirm(true)}
						title="Delete session"
					>
						<IconTrash size={22} />
						Delete session
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
				);
				// Secondary header controls (Linear/Plain links). Inline on desktop;
				// on phones they fold into the ⋯ menu so the single top bar holds only
				// ⋯ + the Workspace toggle beside the centered title. The code
				// affordances (Preview, Staging, PR) moved to the right panel's action
				// row (`panelActions`) to keep this bar quiet.
				const secondaryActions = (
					<>
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
						// "backstage" is the default origin (web UI) — as a chip it's noise,
						// and for backstage-repo sessions it read as the repo said twice.
						// Only surface the unusual origins (slack/linear/cli).
						session.source !== "backstage" && (
							<span className={`source-chip source-${session.source}`}>
								{session.source}
							</span>
						)
					)}
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
					{onOpenSession && (parentSession || (workerSessions && workerSessions.length > 0)) && (
						<SessionRelations
							parent={parentSession}
							workers={workerSessions}
							models={models}
							onOpen={onOpenSession}
						/>
					)}
					{session.archived && (
						<span className="source-chip source-cli">archived</span>
					)}
				</div>
				<div className="viewer-header-actions">
					{!isPhone && secondaryActions}
					{/* Everyone with the session open, Figma/Notion-style, right
					    before Share. You're always in it (rightmost); others stack
					    in front with their GitHub picture. */}
					{!isPhone && viewers.length > 0 && (
						<div className="presence" title={`Viewing: ${viewers.join(", ")}`}>
							{dedupeViewers(viewers, me).map((v) => (
								<UserAvatar
									key={v.name}
									name={v.name}
									size={28}
									className={`presence-avatar ${v.name === me ? "presence-me" : ""}`}
								>
									{v.count > 1 ? (
										<span className="presence-count">{v.count}</span>
									) : null}
								</UserAvatar>
							))}
						</div>
					)}
					{/* Share rides inline when there's room, else collapses behind ⋯
					    so it never crowds the title. It sits before Workspace so the
					    Workspace toggle stays rightmost. On phones the secondary
					    controls fold in too. The ⋯ menu is always present — Star,
					    Spin off and Delete live only in there. */}
					{!compactHeader && !isPhone && collapsibleActions}
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
								{isPhone && secondaryActions}
								{(compactHeader || isPhone) && collapsibleActions}
								{newChatAction}
								{repoAction}
								{overflowActions}
								{archiveAction}
								{deleteAction}
							</div>
						)}
					</div>
					{/* Panel closed → surface the PR chip + its primary action (Merge/
					    Push/Resolve) inline, so the header still tells you where the
					    PR stands without opening the Workspace panel. */}
					{!isPhone && hasWorkspace && !panelOpen && (
						<PrStatusBar
							sessionId={session.id}
							repo={session.repo || undefined}
							archived={session.archived}
							send={connected ? send : undefined}
							variant="header"
						/>
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
								<IconSidebarRight className="btn-panel-toggle-icon" size={24} />
							</button>
						</Tooltip>
					)}
				</div>
			</div>
				);
				// Phones: the whole header rides in the top bar's right slot (the
				// title row is CSS-hidden there — the centered bar title replaces
				// it), giving one iOS-style nav bar instead of a second chrome row.
				return isPhone && headerActionsEl
					? createPortal(header, headerActionsEl)
					: topbarEl
						? createPortal(header, topbarEl)
						: header;
			})()}

			{/* Line under the mobile top-bar title: `repo · model`. The repo is the
			    read-only session context (switch it from the ⋯ menu, where the
			    inline header RepoBar folds on phones); the model is a tap target —
			    the composer's model pill is hidden on phones, so this small label
			    doubles as one: a native <select> overlays it and opens the OS
			    picker. Backstage sessions only; Slack/Linear-owned sessions set
			    their model from the owning thread. */}
			{isPhone &&
				headerModelEl &&
				(models.length > 0 || (session.worktreeDir && !isAsk)) &&
				createPortal(
					<>
						{session.worktreeDir && !isAsk && (
							<span
								className="header-repo-label"
								title="Repo for this session — change it from the ⋯ menu"
							>
								{session.repo || "tella-fusion"}
							</span>
						)}
						{session.worktreeDir && !isAsk && models.length > 0 && (
							<span className="header-model-sep" aria-hidden="true">
								·
							</span>
						)}
						{models.length > 0 && (
							<span
								className="header-model-select"
								title={
									session.source !== "backstage"
										? "Set the model from the owning agent (/model in the Slack thread)"
										: "Switch the model for this session"
								}
							>
								<span className="header-model-label">
									{models.find((m) => m.id === effectiveModel)?.label ||
										prettyModel(effectiveModel)}
								</span>
								<IconChevronDown className="header-model-chevron" size={14} />
								{session.source === "backstage" && (
									<select
										className="palette-select-overlay"
										value={model}
										onChange={(e) => handleModelChange(e.target.value)}
										aria-label="Model"
									>
										<option value="">
											{models.find((m) => m.id === defaultModel)?.label ||
												prettyModel(defaultModel)}
										</option>
										{models
											.filter((m) => m.id !== defaultModel)
											.map((m) => (
												<option key={m.id} value={m.id}>
													{m.label}
												</option>
											))}
									</select>
								)}
							</span>
						)}
					</>,
					headerModelEl,
				)}

			{(session.goal || session.loop || (session.lastRunError && !isBusy)) && (
				<div className="session-banners">
					{/* The last run died on a terminal failure (usage limits/credits
					    exhausted, API errors) — say why the session stopped; the error
					    itself was only ever a transient toast. Hidden while a retry
					    runs; cleared server-side by the next clean run. */}
					{session.lastRunError && !isBusy && (
						<span
							className="session-banner text-red"
							title={session.lastRunError.message}
						>
							⚠ Last run failed: {session.lastRunError.message.slice(0, 160)}
							{session.lastRunError.message.length > 160 ? "…" : ""}
						</span>
					)}
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
							onClick={handleMessagesClick}
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
							) : entries.length === 0 && !hasLiveConversation ? (
								<div className="empty">Empty transcript</div>
							) : (
								<>
									{historyTruncated && (
										<div className="load-history">
											<button
												className="load-history-btn"
												disabled={loadingHistory}
												onClick={() => {
													const el = messagesRef.current;
													if (el)
														historyAnchor.current = {
															height: el.scrollHeight,
															top: el.scrollTop,
														};
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
										onFork={canForkSession ? handleFork : undefined}
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

							{isBusy && (
								<BusyInline
									since={busySince}
								/>
							)}

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

								{pendingBubbles.map((p) => (
									<div key={p.id} className="msg msg-user msg-sending">
										{/* No name: the bubble is right-aligned, so authorship is
										    already clear — just the transient status. Busy sends
										    render in the queue flap, never as a bubble. */}
										<div className="msg-label msg-label-user">
											<span className="msg-label-status">Sending…</span>
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

						{showScrollToBottom && entries.length > 0 && (
							<button
								className={`jump-latest ${newBelow ? "jump-latest-new" : ""}`}
								onClick={() => scrollToLatest("smooth")}
								title="Scroll to the bottom"
							>
								<span className="jump-latest-arrow">↓</span>
								{newBelow ? "New messages" : "Scroll to bottom"}
							</button>
						)}
					</div>

					<div className="viewer-input">
						{noEngine ? (
							<div className="input-disabled">No engine session to resume</div>
						) : (
							<>
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
									// Uncontrolled: the draft lives in the Composer (persisted
									// per chat via draftKey). Remount on the tab-bar +
									// (newChatSeq) to clear it for the fresh chat.
									key={newChatSeq ?? 0}
									draftKey={draftKey}
									onSend={handleSend}
									images={images}
									onImagesChange={setImages}
									files={files}
									onFilesChange={setFiles}
									placeholder={
										!connected
											? "Not connected"
											: forkFrom
												? "New direction…"
												: isBusy
													? busySend === "steer"
														? "Steer this run…"
														: "Queue for later…"
													: "Ask Michael…"
									}
									disabled={!connected}
									sendDisabled={(text) =>
										!text.trim() &&
										images.length === 0 &&
										files.length === 0 &&
										!forkFrom
									}
									busy={isBusy && !forkFrom}
									busySendMode={busySend}
									onStop={handleCancel}
									sendTitle={isBusy ? busySendLabel : undefined}
									attached={attachedQueue}
									prefill={composerPrefill}
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
									// Subscription pinning is a backstage-session affordance
									// (routed through /sub), and only meaningful on Claude
									// models — Codex has its own account pool.
									accounts={
										session.source === "backstage" && !isCodexModel
											? accounts
											: undefined
									}
									accountId={accountId}
									onAccountChange={
										session.source === "backstage"
											? handleAccountChange
											: undefined
									}
									goal={currentGoal}
									onSetGoal={
										session.source === "backstage" ? handleSetGoal : undefined
									}
									mentionFetch={(q) => fetchFileMentions(q, session.id)}
									skillsFetch={(q) => fetchSkillMentions(q, session.id)}
									textareaRef={composerRef}
									sendMenu={
										session.source === "backstage"
											? ({ text, disabled, onScheduled }) => (
													<SchedulePromptButton
														sessionId={session.id}
														text={text}
														disabled={disabled}
														onScheduled={onScheduled}
														variant="menu-item"
													/>
												)
											: undefined
									}
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
						style={panelStyle}
						resizeHandle={panelResizeHandle}
					/>
				) : panelAvailable && panelOpen ? (
					<div className="viewer-panel" style={panelStyle}>
						{panelResizeHandle}
						{hasWorkspace && (
							<PrStatusBar
								sessionId={session.id}
								repo={session.repo || undefined}
								archived={session.archived}
								send={connected ? send : undefined}
								onOpenPrTab={() => setPanelTab("pr")}
							/>
						)}
						<div className="panel-tabs">
							<button
								className={`panel-tab ${panelTab === "info" ? "active" : ""}`}
								onClick={() => selectPanelTab("info")}
							>
								Info
							</button>
							{hasWorkspace && (
								<>
									<button
										className={`panel-tab ${panelTab === "changes" ? "active" : ""}`}
										onClick={() => selectPanelTab("changes")}
									>
										Changes
									</button>
									<button
										className={`panel-tab ${panelTab === "terminal" ? "active" : ""}`}
										onClick={() => selectPanelTab("terminal")}
									>
										Terminal
									</button>
									<button
										className={`panel-tab ${panelTab === "pr" ? "active" : ""}`}
										onClick={() => selectPanelTab("pr")}
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
										onClick={() => selectPanelTab("slack")}
									>
										Slack
										{session.slackChannel && <span className="panel-tab-dot" />}
									</button>
								</>
							)}
							{hasPlain && (
								<button
									className={`panel-tab ${panelTab === "plain" ? "active" : ""}`}
									onClick={() => selectPanelTab("plain")}
								>
									Plain
									<span className="panel-tab-dot" />
							</button>
							)}
						</div>
						<div className="panel-body">
							{/* Plain-only sessions (no code workspace) show just the timeline. */}
							{panelTab === "info" ? (
								<WorkspaceInfo
									workspaceId={session.projectId || null}
									workspaceName={workspaceName}
									chats={(workspaceChats?.length ? workspaceChats : [session]).map(
										(s) => ({
											id: s.id,
											title: s.title,
											createdAt: s.createdAt || "",
											startedBy: s.startedBy,
										}),
									)}
									repo={
										hasWorkspace ? session.repo || "tella-fusion" : undefined
									}
									liveMediaCount={liveMediaCount}
									liveMedia={liveOverviewMedia}
								/>
							) : (panelTab === "plain" || !hasWorkspace) && hasPlain ? (
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
								<TerminalPanel
									entries={entries}
									sessionId={session.id}
									send={send}
									addHandler={addHandler}
								/>
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
						<div className="panel-actions">{panelActions}</div>
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

// Ticking elapsed-time label for the busy dot row. Self-ticking
// so the 10Hz re-render stays inside this tiny span, not the whole viewer.
function BusyElapsed({ since }: { since: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(t);
	}, []);
	const s = Math.max(0, now - since) / 1000;
	let label: string;
	if (s < 60) label = `${s.toFixed(1)}s`;
	else if (s < 3600)
		label = `${Math.floor(s / 60)}m, ${(s % 60).toFixed(1)}s`;
	else label = `${Math.floor(s / 3600)}h, ${Math.floor((s % 3600) / 60)}m`;
	return <span className="busy-elapsed">{label}</span>;
}

function BusyInline({
	since,
}: {
	since: number | null;
}) {
	return (
		<div className="msg msg-busy-inline">
			<span className="pulse-dot" />
			{since != null && <BusyElapsed since={since} />}
		</div>
	);
}

function StreamingMessage({ text }: { text: string }) {
	const html = React.useMemo(() => renderMarkdown(text), [text]);

	return (
		<div className="msg msg-assistant msg-streaming">
			<div
				className="msg-body msg-body-assistant markdown"
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</div>
	);
}

function dedupeViewers(
	viewers: string[],
	me?: string,
): Array<{ name: string; count: number }> {
	const counts = new Map<string, number>();
	for (const v of viewers) counts.set(v, (counts.get(v) || 0) + 1);
	const list = Array.from(counts, ([name, count]) => ({ name, count }));
	// Others first, you last (nearest Share) — the Figma/Notion facepile order.
	if (me) list.sort((a, b) => Number(a.name === me) - Number(b.name === me));
	return list;
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
