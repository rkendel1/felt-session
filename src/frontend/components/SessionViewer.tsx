import { BASE_PATH } from "../lib/base";
import React, {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Reorder } from "motion/react";
import { renderMarkdown } from "../lib/markdown";
import { DEFAULT_DOC_TITLE } from "../lib/brand";
import { isGitHubAttribution, parseHumanReply } from "../lib/humanReply";
import type {
	UnifiedSession,
	TranscriptEntry,
	WSServerMessage,
	AskQuestion,
} from "../lib/types";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { SideChatsPanel } from "./SideChatsPanel";
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
import { ComposerAgents } from "./ComposerAgents";
import { UsageMeter } from "./UsageMeter";
import { SchedulePromptButton } from "./SchedulePrompt";
import type { FileAttachment } from "../lib/images";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { DiffPanel, useSessionDiff } from "./DiffPanel";
import { RepoBar } from "./RepoBar";
import { RepoTile } from "./RepoTile";
import { SandboxBadge } from "./SandboxBadge";
import { ModelMenuRow } from "./ModelMenuRow";
import {
	EFFORTS,
	friendlyModelSlug,
	opencodeModelParts,
} from "./ModelEffortSelect";
import { AskCard } from "./AskCard";
import { PrPanel } from "./PrPanel";
import { PrStatusBar } from "./PrStatusBar";

import { TeamChat } from "./TeamChat";
import { PlainThreadPanel } from "./PlainThreadPanel";
import { WorkflowPanel } from "./WorkflowPanel";
import { AssetsPanel, useSessionAssets } from "./AssetsPanel";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import { PreviewButton } from "./PreviewButton";
import { StagingLink } from "./StagingLink";
import { WorkspaceInfo } from "./WorkspaceInfo";
import { SpinOffMenu } from "./SpinOffMenu";
import {
	IconSidebarRight,
	IconTrash,
	IconArchive,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconPlus,
	IconPencil,
	IconArrowUp,
	IconCrosshair,
	IconPin,
	IconPullRequest,
	IconLink,
	IconSparkle,
	IconTerminal,
	IconCopy,
	IconFile,
	IconMessage,
} from "./icons";
import { SessionRelations, type RelatedSession } from "./SessionRelations";
import { PixelSpinner } from "./PixelSpinner";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { CopyCheck, useCopy } from "../ui/copy";
import { toast } from "../ui/toast";
import { copySessionTranscript } from "../lib/transcript-copy";
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
	/** Leading slot inside the mobile top-bar title pill. The repo tile portals
	    here so it sits in front of the title (Slack-header style), rather than
	    inline in the metadata line below. Desktop ignores it. */
	headerRepoEl?: HTMLElement | null;
	/** App-level right-column node (sibling of the left sidebar); when present the
	    workspace/sub-agent panel portals here so it spans the full height from the
	    top, instead of opening only below the chat. */
	rightPanelEl?: HTMLElement | null;
	/** Bumped by the tab-bar + to start a fresh chat in this same session: clears
	    the composer and jumps to the live edge. A visual reset — same thread. */
	newChatSeq?: number;
	/** One-shot pulse set when this session was opened by picking its workspace
	    in the sidebar — focus the composer on open so you can type right away.
	    Ignored on phones (would pop the keyboard over the chat). */
	autoFocusComposer?: boolean;
	/** One-shot draft text appended from another surface, such as Checks. */
	composerPrefillExternal?: { seq: number; text: string } | null;
	onComposerPrefillConsumed?: (seq: number) => void;
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
	/** Every session — powers the Chat tab's @-session tagging. */
	allSessions?: UnifiedSession[];
	/** Workspace names — lets the Chat tab's @-search match workspaces too. */
	allProjects?: Array<{ id: string; name: string }>;
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
	/** Mirror a reviewer pick / sign-off into the app-level session list so the
	    sidebar's review bands flip immediately instead of waiting for a poll. */
	onReviewChange?: (
		id: string,
		req: { to: string; by: string; at: string; accepted?: { by: string; at: string } } | null,
	) => void;
	/**
	 * Whether the Review pane is foregrounded — driven by the top tab strip's
	 * Review view-tab (App state), replacing the old inline Chat|Review toggle.
	 * When false, the chat transcript shows.
	 */
	showReview?: boolean;
	/** Open/foreground this session's Review view-tab (PR/review triggers). */
	onOpenReview?: () => void;
}

type PanelTab =
	| "info"
	| "changes"
	| "terminal"
	| "pr"
	| "chat"
	| "plain"
	| "sidechats"
	| "workflows"
	| "assets";

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

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
	// Opencode ids get their friendly name with no engine suffix — the engine
	// is an implementation detail ("Sonnet 5", not "… · OpenCode").
	const oc = opencodeModelParts(id);
	if (oc) return friendlyModelSlug(oc.model);
	const isCodex = id.startsWith("gpt") || id.startsWith("codex");
	const name = MODEL_NAMES[id] || id;
	return `${name} · ${isCodex ? "Codex" : "Claude"}`;
}
/** Model label for the header/info metadata lines: the registry label, but
 * opencode ids always take the pure friendly-name path (the server's labels
 * for them only refresh on restart). */
function metadataModelLabel(effectiveModel: string, models: ModelOption[]): string {
	if (opencodeModelParts(effectiveModel)) return prettyModel(effectiveModel);
	return models.find((m) => m.id === effectiveModel)?.label || prettyModel(effectiveModel);
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
	headerRepoEl,
	headerActionsEl,
	headerModelEl,
	rightPanelEl,
	newChatSeq,
	autoFocusComposer,
	composerPrefillExternal,
	onComposerPrefillConsumed,
	onRename,
	workspaceName,
	onRenameWorkspace,
	workspaceChats,
	allSessions,
	allProjects,
	onNewChat,
	parentSession,
	workerSessions,
	onOpenSession,
	onRunningChange,
	onReviewChange,
	showReview = false,
	onOpenReview,
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
	// Bumped on a `git_pushed` broadcast (server-side auto-push) so the PR status
	// header refetches immediately and drops "Ahead by N commits".
	const [gitRefreshTick, setGitRefreshTick] = useState(0);
	const [streamText, setStreamText] = useState("");
	const [streamBy, setStreamBy] = useState<string | null>(null);
	// Bumped on every stream_start; lets the delayed stream_done cleanup verify
	// it isn't wiping a NEWER run's in-progress text.
	const streamSeqRef = useRef(0);
	const [viewers, setViewers] = useState<string[]>([]);
	// The create run is still preparing this session's worktree (new workspaces
	// announce the session before the slow git work). While true the transcript
	// and workspace panels show "Waiting for workspace" and sends hold in the
	// queue flap. Flipped off by the workspace_status event, kept in sync with
	// the sessions poll otherwise.
	const [workspacePreparing, setWorkspacePreparing] = useState(
		!!session.workspacePreparing,
	);
	useEffect(() => {
		setWorkspacePreparing(!!session.workspacePreparing);
	}, [session.workspacePreparing]);
	const [queued, setQueued] = useState<QueueReceipt[]>([]);
	// Drag-to-reorder bookkeeping. onReorder fires continuously during a drag, so
	// we only reorder locally then flush the final order to the server on drop —
	// broadcasting mid-drag would swap the item references out from under Motion
	// and drop the gesture. draggingQueueRef gates the incoming queue_update the
	// same way, so an unrelated broadcast can't yank the list while dragging.
	const draggingQueueRef = useRef(false);
	const pendingReorderRef = useRef<QueueReceipt[] | null>(null);
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
	// queue flap (as "Queueing…") instead of as a transcript bubble.
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
	const { copied, share: shareLink } = useCopy();
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
		const stored = localStorage.getItem("michael-panel-tab");
		// "workflows" isn't meaningfully restorable (runs seed async, so the tab
		// starts hidden and the body would flash PrPanel) — it, and any stored
		// tab that no longer exists, maps back to Info.
		const restorable: PanelTab[] = ["info", "changes", "terminal", "chat", "plain", "sidechats"];
		const tab: PanelTab | null = restorable.includes(stored as PanelTab)
			? (stored as PanelTab)
			: stored
				? "info"
				: null;
		if (tab) {
			const available =
				tab === "info" ||
				(tab === "plain" ? Boolean(session.plainThreadId) : workspace);
			if (available) return tab;
		}
		return "info";
	});
	function selectPanelTab(tab: PanelTab) {
		setPanelTab(tab);
		localStorage.setItem("michael-panel-tab", tab);
	}
	// Main chat-area view: the transcript+composer vs. the full-width PR review
	// that takes over the whole chat column. Which one shows is now owned by App
	// (the top tab strip's Review view-tab) and passed in as `showReview`; the
	// open triggers call onOpenReview. Only meaningful on a code session
	// (hasWorkspace) — App only offers the Review tab there.
	// Bumped by the ⋯ menu's "New side chat" — tells the SideChatsPanel to
	// create (and open) a fresh side chat as soon as it shows. The panel calls
	// onCreateConsumed to reset it to 0, so tab remounts don't re-create.
	const [sideChatCreateSeq, setSideChatCreateSeq] = useState(0);
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
		return v >= 320 && v <= 2400 ? v : 0;
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
			// Wide enough to review code side-by-side: only reserve room for the
			// left sidebar + a readable chat column instead of a fixed 900px cap.
			const max = Math.max(480, Math.round(window.innerWidth - 620));
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
	// Session scratch assets (Assets tab): fetched once per session + on
	// assets_changed broadcasts; the tab only appears once files exist.
	const { files: assetFiles, refresh: refreshAssets } = useSessionAssets(
		session.id,
		addHandler,
	);
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

	// Immersive reading on phones (Safari-style): scrolling down through the
	// transcript slides the top bar, docked tabs and composer off-screen to
	// maximize the reading area; scrolling back up — or reaching the very top or
	// the live edge — brings them back. Toggles body.chrome-collapsed, which the
	// mobile CSS animates with transforms (inert on desktop / when unscrollable).
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const mq = window.matchMedia("(max-width: 720px)");
		let lastY = el.scrollTop;
		let collapsed = false;
		let ticking = false;
		const set = (v: boolean) => {
			if (v === collapsed) return;
			collapsed = v;
			document.body.classList.toggle("chrome-collapsed", v);
		};
		const onDir = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				ticking = false;
				if (!mq.matches) {
					set(false);
					lastY = el.scrollTop;
					return;
				}
				const y = el.scrollTop;
				const max = el.scrollHeight - el.clientHeight;
				const dy = y - lastY;
				lastY = y;
				// Keep the chrome up near the top and the live edge so the controls
				// stay reachable; otherwise follow the scroll direction (with a small
				// dead-zone so tiny jitters don't flip it).
				if (y < 48 || max - y < 64) set(false);
				else if (dy > 6) set(true);
				else if (dy < -6) set(false);
			});
		};
		el.addEventListener("scroll", onDir, { passive: true });
		return () => {
			el.removeEventListener("scroll", onDir);
			document.body.classList.remove("chrome-collapsed");
		};
	}, [messagesRef, session.id]);

	// Per-session model (switchable from the composer; "" = default)
	const [model, setModel] = useState(session.model || "");
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	// Pinnable Claude subscriptions + this session's pin ("" = auto pool).
	const [accounts, setAccounts] = useState<ClaudeAccountOption[]>([]);
	const [accountId, setAccountId] = useState(session.accountId || "");
	// Live token/cost accounting — seeded from the session, updated per run via
	// the `usage_update` broadcast. Powers the composer cost/context pill.
	const [usage, setUsage] = useState(session.usage);
	// Reasoning effort — a composer control mirroring the new-session palette.
	// Persisted on the session server-side and enforced per run (Claude effort /
	// Codex modelReasoningEffort), so seed from the session's stored value.
	const [effort, setEffort] = useState(session.effort || "high");
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
	useEffect(() => {
		setEffort(session.effort || "high");
	}, [session.id, session.effort]);
	useEffect(() => {
		setUsage(session.usage);
	}, [session.id, session.usage]);

	// Dynamic workflow runs (opensession-workflows MCP): seeded by a fetch on
	// open/session switch, then kept live by workflow_update broadcasts. Powers
	// the Agents tab — hidden entirely while empty.
	const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSnapshot[]>([]);
	// True once the seed fetch for the current session has settled — the
	// runs-vanished fallback below must not flip tabs off an empty [] mid-fetch.
	const [workflowsLoaded, setWorkflowsLoaded] = useState(false);
	useEffect(() => {
		let stale = false;
		setWorkflowRuns([]);
		setWorkflowsLoaded(false);
		fetch(`${BASE_PATH}/api/sessions/${encodeURIComponent(session.id)}/workflows`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (stale) return;
				if (Array.isArray(d?.runs)) {
					const fetched = d.runs as WorkflowRunSnapshot[];
					// WS upserts may have landed while the fetch was in flight — those
					// snapshots are newer than the seed, so keep them and only add
					// fetched runs we don't have yet (the panel re-sorts by startedAt).
					setWorkflowRuns((prev) => {
						const have = new Set(prev.map((r) => r.runId));
						const added = fetched.filter((r) => !have.has(r.runId));
						return added.length ? [...prev, ...added] : prev;
					});
				}
				setWorkflowsLoaded(true);
			})
			.catch(() => {
				if (!stale) setWorkflowsLoaded(true);
			});
		return () => {
			stale = true;
		};
	}, [session.id]);
	function cancelWorkflowRun(runId: string) {
		// Fire-and-forget: the workflow_update echo flips the card to cancelled.
		fetch(`${BASE_PATH}/api/workflows/${encodeURIComponent(runId)}/cancel`, {
			method: "POST",
		}).catch(() => {});
	}

	// Keep the pin star in sync with the store (changes can come from the tab bar
	// or the Home screen) and reset when switching sessions.
	useEffect(() => setPinned(isPinned(session.id)), [session.id]);
	useEffect(
		() => onPinsChanged(() => setPinned(isPinned(session.id))),
		[session.id],
	);

	const isAsk = session.mode === "ask";
	const hasWorkspace = !isAsk && Boolean(session.worktreeDir || session.branch);
	// The Agents tab stays available on any session with a workspace (it shows
	// an empty state that teaches the feature), so only fall back to Info when
	// the tab itself is gone — a session that can't run workflows AND has no
	// runs to show.
	useEffect(() => {
		if (
			workflowsLoaded &&
			panelTab === "workflows" &&
			workflowRuns.length === 0 &&
			!hasWorkspace
		)
			setPanelTab("info");
	}, [workflowsLoaded, panelTab, workflowRuns.length, hasWorkspace]);

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
	// Side chats hang off any normal backstage session (not an automation view,
	// and not a side chat itself — no nesting). Their tab opens the panel even
	// for an ask-mode chat with no workspace.
	const canSideChat =
		session.source === "backstage" && !session.automation && !session.sideChatOf;
	// Workflow runs open the panel too: ask-mode sessions without a workspace
	// or Plain thread still need somewhere to show the Agents tab.
	const panelAvailable =
		hasWorkspace || hasPlain || workflowRuns.length > 0 || canSideChat;
	// A persisted "sidechats" tab is meaningless on a session that can't have
	// side chats (automation view / a side chat itself) — fall back to Info.
	useEffect(() => {
		if (panelTab === "sidechats" && !canSideChat) setPanelTab("info");
	}, [panelTab, canSideChat]);
	const isBusy = isRunningLive || isStreaming;
	// Derived, not the raw flag: transcript content or streaming text means the
	// opening run already started, so the worktree is done — this guards against
	// a stale sessions poll re-asserting the flag after the workspace_status
	// event already cleared it.
	const waitingForWorkspace =
		workspacePreparing && entries.length === 0 && !streamText;

	// Live worktree diff, shared between the Changes-tab file-count badge and the
	// DiffPanel (passed in as `diff=` below so they poll once, not twice). Parked
	// unless the panel is open on a code session.
	const diffState = useSessionDiff(session.id, {
		enabled: hasWorkspace && panelOpen,
		isRunning: isBusy,
	});
	const changesFileCount = React.useMemo(
		() =>
			diffState.repos
				? diffState.repos.reduce(
						(n, r) => n + (r.diff.files?.length || 0),
						0,
					)
				: null,
		[diffState.repos],
	);

	// Anchor for the "Michael is working…" elapsed timer. A run that starts
	// while we're watching anchors to now; opening a session mid-run anchors to
	// the server's journaled run start (runStartedAt — survives switches and
	// refreshes), falling back to the turn's user prompt in the transcript, so
	// the timer shows the run's real age, not time-since-I-opened-the-tab. The
	// ref tracks which case we're in: it stays true until we've observed the
	// session idle.
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
		// The journaled run start is authoritative whenever we have it — for a
		// run that starts while watching it's ~now anyway (App stamps it on the
		// status flip), and mid-run it's the real start even when a stale
		// isRunning=false at mount already flipped the anchor ref.
		if (session.runStartedAt) {
			const t = Date.parse(session.runStartedAt);
			if (Number.isFinite(t)) {
				setBusySince((prev) => prev ?? t);
				return;
			}
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
	}, [isBusy, loading, entries, session.runStartedAt]);

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

	// ⌘⌥↑/⌘⌥↓ step the reasoning effort through the current model's supported
	// levels (up = more thinking), wrapping at the ends. Resolves the same
	// effective effort as the ModelEffortSelect pill (stored value when the
	// model offers it, else "high", else the model's first level), so the step
	// always starts from what the pill displays. Fires with the composer
	// focused too — the Alt modifier keeps it clear of plain ⌘↑/⌘↓ (workspace
	// cycling in the Sidebar, and caret start/end moves in the textarea).
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			// Match e.code too: with Option held, some layouts/browsers alter
			// e.key; the physical-key code never changes.
			const arrow =
				e.key === "ArrowUp" || e.code === "ArrowUp"
					? "ArrowUp"
					: e.key === "ArrowDown" || e.code === "ArrowDown"
						? "ArrowDown"
						: null;
			if (
				e.defaultPrevented ||
				!arrow ||
				!(e.metaKey || e.ctrlKey) ||
				!e.altKey ||
				e.shiftKey
			)
				return;
			const effectiveModel = model || defaultModel;
			const supportedIds =
				models.find((m) => m.id === effectiveModel)?.efforts ?? [];
			const supported = EFFORTS.filter((ef) => supportedIds.includes(ef.id));
			if (supported.length < 2) return;
			const effective = supportedIds.includes(effort)
				? effort
				: supportedIds.includes("high")
					? "high"
					: supported[0].id;
			const idx = supported.findIndex((ef) => ef.id === effective);
			const dir = arrow === "ArrowUp" ? 1 : -1;
			const next =
				supported[(idx + dir + supported.length) % supported.length];
			if (!next) return;
			e.preventDefault();
			setEffort(next.id);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [models, defaultModel, model, effort]);

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
		document.title = session.title || DEFAULT_DOC_TITLE;
		return () => {
			document.title = DEFAULT_DOC_TITLE;
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
				case "workflow_update": {
					// Dynamic workflows: upsert the live run snapshot (already
					// session-filtered by the sessionId gate above).
					const run = msg.run;
					setWorkflowRuns((prev) =>
						prev.some((r) => r.runId === run.runId)
							? prev.map((r) => (r.runId === run.runId ? run : r))
							: [run, ...prev],
					);
					break;
				}
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
						// Don't let a broadcast rewrite the list mid-drag (see
						// draggingQueueRef) — the drop will send our order and the
						// server's echo reconciles it right after.
						if (!draggingQueueRef.current) setQueued(msg.queued);
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
				case "git_pushed":
					if (msg.sessionId === session.id) setGitRefreshTick((t) => t + 1);
					break;
				case "workspace_status":
					if (msg.sessionId === session.id)
						setWorkspacePreparing(!msg.ready);
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
				case "usage_update":
					if (msg.sessionId !== session.id) break;
					setUsage(msg.usage);
					break;
				case "cache_warning":
					if (msg.sessionId !== session.id) break;
					toast("Prompt cache missed; this turn reprocessed the full context.", {
						duration: 6000,
					});
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
			: "Steer — stop the current turn and deliver now";
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

	// "Add chat transcripts" chips on a fresh chat's blank canvas: sibling
	// workspace chats the user can attach as context — selected ids ride the
	// first send as `contextChats` and the server inlines a fenced transcript
	// digest of each. One-shot: cleared once a send consumes them.
	const [contextChats, setContextChats] = useState<string[]>([]);
	const [showAllContextChats, setShowAllContextChats] = useState(false);
	const contextChatOptions = useMemo(() => {
		// Whole workspace, archived chats included — the common case is exactly a
		// closed (archived-after-merge) sibling whose context the new chat needs.
		// workspaceChats (the live tab strip) is the fallback when the chat has no
		// workspace id of its own.
		const siblings = session.projectId
			? (allSessions || []).filter((c) => c.projectId === session.projectId)
			: workspaceChats || [];
		return siblings
			.filter(
				(c) =>
					c.id !== session.id &&
					// Side chats are recalled via their own @mention, not offered here.
					!c.sideChatOf &&
					// Only chats with something to hand over — a transcript or at
					// least a started engine thread.
					(c.transcriptPath || c.claudeSessionId || c.codexThreadId),
			)
			.sort((a, b) =>
				(b.lastActivity || "").localeCompare(a.lastActivity || ""),
			);
	}, [allSessions, workspaceChats, session.id, session.projectId]);
	useEffect(() => {
		setContextChats([]);
		setShowAllContextChats(false);
	}, [session.id]);

	// The review request is stored per chat, but the sidebar's "Awaiting/Needs
	// review" bands group by workspace — so a request set on a sibling chat lit
	// the band while the open chat's Reviewer chip read empty. Surface the
	// workspace's request in the chip: the open chat's own if it has one, else a
	// sibling's, carrying the owner id so clear/re-assign target the right chat.
	const effectiveReview = useMemo(() => {
		if (session.reviewRequest)
			return { req: session.reviewRequest, ownerId: session.id };
		const sib = (workspaceChats || []).find((c) => c.reviewRequest);
		return sib ? { req: sib.reviewRequest!, ownerId: sib.id } : null;
	}, [session.reviewRequest, session.id, workspaceChats]);

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
		// Two follow-up behaviors while busy (per-browser setting): Queue (waits
		// for the next turn) or Steer (folds into the LIVE run at its next step
		// boundary — busyMode:"steer", real in-band steering since 2026-07-12;
		// the server falls back to the queue when nothing is steerable or files
		// are attached). The turn keeps running: no abort, no lost work, none of
		// the announce-then-stop residue interrupts used to cause. ⌘/Ctrl+Enter
		// forces Steer regardless of the default. Idle: just run it. Attachments
		// ride along on every path — images fold into the run as content blocks;
		// files route to the queue server-side.
		const steerNow = isBusy && (!!opts?.interrupt || busySend === "steer");
		send(
			isBusy
				? steerNow
					? {
							type: "prompt" as const,
							sessionId: session.id,
							content: text,
							user,
							effort,
							busyMode: "steer" as const,
							...(imgs.length ? { images: imgs } : {}),
							...(fls.length ? { files: filePayload } : {}),
						}
					: {
							type: "prompt" as const,
							sessionId: session.id,
							content: text,
							user,
							effort,
							busyMode: "queue" as const,
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
						// Attached sibling-chat transcripts (fresh chats are idle, so the
						// chips' selection always leaves through this branch).
						...(contextChats.length ? { contextChats } : {}),
					},
		);
		if (!isBusy) {
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
			// bubble, no beginTurn — a steer folds into the RUNNING turn) — the
			// server's queue_update / steer-receipt echo replaces it.
			setPending((p) => [
				...p,
				{
					id: `pending-${crypto.randomUUID()}`,
					content: text,
					user,
					sentAt: Date.now(),
					images: imgs.length ? imgs : undefined,
					busyMode: steerNow ? ("steer" as const) : ("queue" as const),
				},
			]);
		}
		setImages([]);
		setFiles([]);
		setContextChats([]);
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

	// Append an @session:<id> token to the main composer (from a side chat's
	// "Mention in main thread") so the user can pull that chat's context back in.
	function insertMention(id: string) {
		setComposerPrefill((p) => ({
			seq: (p?.seq ?? 0) + 1,
			text: `@session:${id} `,
		}));
	}

	function handleQueueReorder(next: QueueReceipt[]) {
		pendingReorderRef.current = next;
		setQueued(next);
	}

	function commitQueueReorder() {
		draggingQueueRef.current = false;
		const next = pendingReorderRef.current;
		pendingReorderRef.current = null;
		if (!next) return;
		const order = next
			.map((q) => q.id)
			.filter((id): id is string => typeof id === "string");
		if (order.length > 1) {
			send({ type: "reorder_queued_prompt", sessionId: session.id, order });
		}
	}

	// Busy sends live in the flap from the moment of the send; idle sends are
	// optimistic transcript bubbles. Both reconcile through the same effect.
	// While the worktree is still being prepared, everything holds in the flap —
	// including the create's own first message — until the workspace is ready.
	const pendingQueue = pending.filter((p) => p.busyMode || waitingForWorkspace);
	const pendingBubbles = pending.filter(
		(p) => !p.busyMode && !waitingForWorkspace,
	);
	const hasLiveConversation =
		pendingBubbles.length > 0 || !!streamText || isBusy || !!ask;

	const queueCount = queued.length + visibleSteered.length + pendingQueue.length;
	const attachedQueue =
		queueCount > 0 ? (
			<div className="composer-queue" aria-label="Queued messages">
				<div className="composer-queue-title">
					{waitingForWorkspace
						? `Waiting for workspace · ${queueCount} queued`
						: `${queueCount} queued ${queueCount === 1 ? "message" : "messages"}`}
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
							</div>
							{renderQueueContent(s, { human: hr })}
						</div>
					);
				})}

				<Reorder.Group
					as="div"
					axis="y"
					values={queued}
					onReorder={handleQueueReorder}
					className="composer-queue-list"
				>
				{queued.map((q, i) => {
					const hr = parseHumanReply(q.content);
					const isGitHub = isGitHubAttribution(q.user);
					const id = q.id;
					const key = id || `queued-${i}`;
					const canSteer = !isGitHub && !queueHasFiles(q);
					// A one-item queue has nothing to reorder — leave drag off so the
					// lone message still selects/clicks normally.
					const canReorder = queued.length > 1;
					return (
						<Reorder.Item
							as="div"
							key={key}
							value={q}
							dragListener={canReorder}
							onDragStart={() => {
								draggingQueueRef.current = true;
							}}
							onDragEnd={commitQueueReorder}
							whileDrag={{ scale: 1.01, zIndex: 2 }}
							className={`composer-queue-item ${canReorder ? "is-draggable" : ""} ${hr ? "is-human" : ""} ${isGitHub ? "is-github" : ""}`}
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
									<Tooltip
										label={
											canSteer ? "Steer" : "Messages with files cannot be steered"
										}
									>
										<button
											type="button"
											className="composer-queue-action composer-queue-steer"
											aria-label="Steer"
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
											<IconArrowUp size={24} />
										</button>
									</Tooltip>
								)}
							</div>
							{renderQueueContent(q, { human: hr, github: isGitHub })}
						</Reorder.Item>
					);
				})}
				</Reorder.Group>

				{/* Just-sent while busy: already visually in the queue, awaiting the
				    server's echo (which swaps in the real item with actions). */}
				{pendingQueue.map((p) => (
					<div key={p.id} className="composer-queue-item composer-queue-sending">
						<div className="composer-queue-actions">
							<span className="composer-queue-pill composer-queue-pill-sending">
								{waitingForWorkspace ? "Queued" : "Queueing…"}
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
			? `${BASE_PATH}/workspace/${encodeURIComponent(session.projectId)}/chat/${encodeURIComponent(session.id)}`
			: `${BASE_PATH}/session/${encodeURIComponent(session.id)}`;
		const link = `${location.origin}${path}`;
		// Phone: native share sheet. Desktop: copy, with the inline check on
		// the button + a floating "Link copied" toast.
		shareLink(link, { toast: "Link copied", title: session.title || undefined });
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

	// Compact "agents running" flap above the composer — phone-only. On desktop
	// the Agents panel tab (with its pulsing dot) is always visible; on a phone
	// the right panel overlays the chat and is closed by default, so a running
	// workflow fan-out has no glance. ComposerAgents is the tappable
	// pill → mini-card → full-panel progression. Reuses the queue flap's
	// tuck-under styling.
	const runningWorkflowRuns = workflowRuns.filter((r) => r.status === "running");
	const agentBubble =
		isPhone && runningWorkflowRuns.length > 0 ? (
			<ComposerAgents
				runs={runningWorkflowRuns}
				onOpenPanel={() => {
					selectPanelTab("workflows");
					setPanelOpen(true);
				}}
			/>
		) : null;

	// The composer takes a single `attached` node; stack the agents flap above
	// the queue flap when both are live.
	const attachedComposer =
		agentBubble || attachedQueue ? (
			<>
				{agentBubble}
				{attachedQueue}
			</>
		) : null;

	// Opened by picking this session's workspace in the sidebar: focus the
	// composer so you can start typing immediately. Runs on mount (a new session
	// remounts this component) and when the pulse re-fires for the already-open
	// session. Skipped on phones so we don't shove the keyboard over the chat.
	useEffect(() => {
		if (autoFocusComposer && !isPhone) composerRef.current?.focus();
	}, [autoFocusComposer, isPhone]);

	useEffect(() => {
		if (!composerPrefillExternal) return;
		setComposerPrefill(composerPrefillExternal);
		onComposerPrefillConsumed?.(composerPrefillExternal.seq);
		if (!isPhone) composerRef.current?.focus();
	}, [composerPrefillExternal, onComposerPrefillConsumed, isPhone]);

	const [overflowOpen, setOverflowOpen] = useState(false);
	const overflowRef = useRef<HTMLDivElement>(null);
	// The title (repo tile + name) opens a deeper full-screen info page — a
	// separate surface from the ⋯ quick-actions menu (overflowOpen).
	const [infoPageOpen, setInfoPageOpen] = useState(false);
	useEffect(() => {
		if (!overflowOpen) return;
		const onDoc = (e: MouseEvent) => {
			if (overflowRef.current?.contains(e.target as Node)) return;
			// The Spin off flavor picker is a Base UI popup portaled to <body> —
			// a click inside it must not close the ⋯ menu it was opened from.
			if ((e.target as Element | null)?.closest?.('[role="menu"]')) return;
			// The heading + chat-bar are toggles for this menu (phone): let their
			// own onClick handle open/close instead of this outside-click closing
			// on the same tap that's meant to toggle it.
			if ((e.target as Element | null)?.closest?.(".session-settings-trigger"))
				return;
			setOverflowOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [overflowOpen]);
	// The mobile top-bar title (rendered by App, outside this component) opens the
	// same settings menu — it toggles via a window event so it doesn't need a prop
	// thread through App's render.
	useEffect(() => {
		const toggle = () => setInfoPageOpen((o) => !o);
		window.addEventListener("backstage:toggle-session-settings", toggle);
		return () =>
			window.removeEventListener("backstage:toggle-session-settings", toggle);
	}, []);
	// Closing the menu disarms a half-finished delete confirm — reopening it
	// later shouldn't present the destructive choices without a fresh click.
	useEffect(() => {
		if (!overflowOpen && !infoPageOpen) setShowDeleteConfirm(false);
	}, [overflowOpen, infoPageOpen]);
	// The menu's contents change across the breakpoint — don't leave it stuck open.
	useEffect(() => {
		setOverflowOpen(false);
		setInfoPageOpen(false);
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
			// Only the unarchive toggle lives here now — the sidebar owns ⌘E (and
			// the legacy ⌘⇧A) for archiving a live session (it advances to the next
			// entry, which needs the sidebar's row ordering). An archived session
			// isn't in that list, so the sidebar handler no-ops on it and we handle
			// unarchive here.
			const k = e.key.toLowerCase();
			const archiveChord =
				(e.metaKey || e.ctrlKey) &&
				!e.altKey &&
				((k === "e" && !e.shiftKey) || (k === "a" && e.shiftKey));
			if (archiveChord && !archiving && session.archived) {
				e.preventDefault();
				void handleArchive();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [archiving, handleArchive, session.archived]);


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
				// menu when it gets narrow. Inline it's a bare text chip (the header
				// is already dense with icons); in the menu it takes a leading icon
				// so it lines up with the other icon+label rows.
				const shareAction = (inMenu: boolean) => (
					<button
						className={`btn-viewer-share ${copied ? "btn-viewer-share-done" : ""}`}
						onClick={handleShare}
						title="Copy a link to this session"
					>
						{inMenu && (
							<CopyCheck copied={copied} idle={<IconLink size={20} />} size={20} />
						)}
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
				// New side chat — spawns a durable side chat (shares the repo, ask
				// mode, out of the main thread) and opens it in the side panel.
				// Phone-only like newChatAction above it: on desktop the Side chats
				// tab is the affordance.
				const newSideChatAction = isPhone && canSideChat && (
					<button
						className="btn-viewer-newchat"
						onClick={() => {
							setOverflowOpen(false);
							setSubagentStack([]);
							setPanelOpen(true);
							selectPanelTab("sidechats");
							setSideChatCreateSeq((n) => n + 1);
						}}
						title="Start a side chat that doesn't interrupt the main conversation"
					>
						<IconMessage size={22} />
						New side chat
					</button>
				);
				// Copy transcript. These normally live on a tab's right-click menu,
				// but a lone-chat workspace has no tab strip (and phones hide it at
				// every count), so the only place to grab this chat's full text is the
				// ⋯ menu — surface both modes here when the strip isn't offering them.
				const showTranscriptActions =
					isPhone || (workspaceChats?.length ?? 1) <= 1;
				const transcriptActions = showTranscriptActions && (
					<>
						<button
							className="btn-viewer-newchat"
							onClick={() => {
								setOverflowOpen(false);
								void copySessionTranscript(session, "concise", toast);
							}}
							title="Copy a trimmed transcript of this chat"
						>
							<IconCopy size={20} />
							Copy concise transcript
							<span className="btn-viewer-shortcut">
								{isApple ? "⌘⌥C" : "Ctrl+Alt+C"}
							</span>
						</button>
						<button
							className="btn-viewer-newchat"
							onClick={() => {
								setOverflowOpen(false);
								void copySessionTranscript(session, "full", toast);
							}}
							title="Copy the complete transcript of this chat"
						>
							<IconFile size={20} />
							Copy full transcript
						</button>
					</>
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
							<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
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
								? `Unarchive session (${isApple ? "⌘E" : "Ctrl+E"})`
								: `Archive session (${isApple ? "⌘E" : "Ctrl+E"})`
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
						<span className="btn-viewer-shortcut">
							{isApple ? "⌘E" : "Ctrl+E"}
						</span>
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
				// affordances (Preview, Staging) sit as state-colored icons just left
				// of the panel toggle on desktop; PR status rides its own row.
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
					{/* Sandbox badge: this session's runs execute inside an isolated
					    container (docker/daytona/e2b). Renders nothing for host sessions
					    — purely from session fields, no container polling. */}
					<SandboxBadge sandbox={session.sandbox} />
					{/* Lone-chat "+ New tab": when the workspace has a single chat the
					    tab strip is hidden, so the affordance to spawn a sibling chat
					    lives here beside the title (⌘T does the same). With 2+ chats the
					    strip's own + takes over and this disappears. Phone uses the ⋯
					    menu's newChatAction instead. */}
					{!isPhone && onNewChat && workspaceChats?.length === 1 && (
						<Tooltip
							label="New tab in this workspace"
							shortcut={isApple ? ["⌘", "T"] : ["Ctrl", "T"]}
						>
							<button
								type="button"
								className="viewer-newtab-btn"
								onClick={() => onNewChat("share")}
								aria-label="New tab"
							>
								{/* 25, not the menu-row 22: the IconPlus path only fills ~52%
								    of its box (vs ~60% for the play/sidebar glyphs beside it),
								    so at 22 it read a touch small. 25 nudges it up without the
								    28 that read too big beside the compact ▶ play / ▐ panel
								    toggle — the thin full-box cross carries more optical width
								    than those glyphs at the same size. */}
								<IconPlus size={25} />
							</button>
						</Tooltip>
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
						<button
							type="button"
							className="source-chip source-cli archived-chip"
							onClick={handleArchive}
							disabled={archiving}
							title="Click to unarchive"
						>
							Archived
						</button>
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
					{!compactHeader && !isPhone && shareAction(false)}
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
								{/* iOS-style quick-actions menu. The workspace overview + repo/model
								    settings live on the title’s info page instead; this stays lean. */}
								{isPhone && secondaryActions}
								{(compactHeader || isPhone) && shareAction(true)}
								{newChatAction}
								{newSideChatAction}
								{transcriptActions}
								{overflowActions}
								{archiveAction}
								{deleteAction}
							</div>
						)}
					</div>
					{/* Code-workspace testing affordances as state-colored icons, docked
					    immediately left of the side-panel toggle. Each self-gates
					    (renders null when not applicable). The play button stays put;
					    the globe rides beside it only while the panel is closed —
					    once the panel opens the globe moves into the panel's PR row
					    (to the left of the PR), so it isn't shown twice. */}
					{!isPhone && (
						<PreviewButton
							session={session}
							onAttachImage={(img) => setImages((prev) => [...prev, img])}
							variant="header"
						/>
					)}
					{!isPhone && !panelOpen && (
						<StagingLink session={session} variant="header" />
					)}
					{/* Panel closed → surface the PR chip + its primary action (Merge/
					    Push/Resolve) inline, grouped with the globe directly left of
					    the side-panel toggle, so the header still tells you where the
					    PR stands without opening the Workspace panel. */}
					{!isPhone && hasWorkspace && !panelOpen && (
						<PrStatusBar
							sessionId={session.id}
							repo={session.repo || undefined}
							archived={session.archived}
							send={connected ? send : undefined}
							variant="header"
							running={isRunningLive}
							refreshTick={gitRefreshTick}
						/>
					)}
					{!isPhone && panelAvailable && (
						<Tooltip
							label={
								hasWorkspace
									? "Toggle side panel (changes, terminal, PR, Plain)"
									: hasPlain
										? "Toggle Plain conversation panel"
										: "Toggle side panel (agents)"
							}
						>
							<button
								className="btn-panel-toggle btn-workspace"
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
								{/* Iconic sidebar-right glyph — reads as "right side panel".
								    28 to sit level with the play/globe weight beside it. */}
								<IconSidebarRight className="btn-panel-toggle-icon" size={26} />
							</button>
						</Tooltip>
					)}
				</div>
			</div>
				);
				// Phones: the whole header rides in the top bar's right slot (the
				// title row is CSS-hidden there — the centered bar title replaces
				// it), giving one iOS-style nav bar instead of a second chrome row.
				const phoneInfoPage =
					isPhone && infoPageOpen ? (
						createPortal(
							<div className="session-info-page">
								<div className="session-info-topbar">
									<button
										className="panel-back"
										onClick={() => setInfoPageOpen(false)}
										aria-label="Back to chat"
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
								</div>
								<div className="session-info-hero">
									<RepoTile name={session.repo || "tella-fusion"} size={40} />
									<div className="session-info-name">
										{workspaceName || session.title}
									</div>
									<div className="session-info-sub">
										{[
											session.repo || "tella-fusion",
											models.length > 0
												? metadataModelLabel(effectiveModel, models)
												: null,
										]
										.filter(Boolean)
										.join("  ·  ")}
									</div>
								</div>
								<div className="viewer-overflow-menu session-info-list">
									{panelAvailable && (
										<button
											className="btn-viewer-panelrow"
											onClick={() => {
												setInfoPageOpen(false);
												setSubagentStack([]);
												setPanelOpen(true);
											}}
										>
											<IconSidebarRight size={20} />
											<span>
												{hasWorkspace
													? "Changes, terminal & PR"
													: hasPlain
														? "Plain conversation"
														: "Agents"}
											</span>
											<IconChevronRight className="btn-viewer-panelrow-caret" size={18} />
										</button>
									)}
									{hasWorkspace && (
										<RepoBar
											sessionId={session.id}
											primaryRepo={session.repo || "tella-fusion"}
											branch={session.branch}
											initialAttached={session.attachedRepos || []}
											variant="menu-row"
										/>
									)}
									{session.source === "backstage" && models.length > 0 && (
										<ModelMenuRow
											models={models}
											model={model}
											defaultModel={defaultModel}
											onChange={handleModelChange}
											prettyLabel={prettyModel}
										/>
									)}
								</div>
								<div className="session-info-overview">
									<WorkspaceInfo
										sessionId={session.id}
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
										repo={hasWorkspace ? session.repo || "tella-fusion" : undefined}
										prState={hasWorkspace ? session.prState : undefined}
										sandbox={session.sandbox}
										reviewRequest={effectiveReview?.req ?? null}
										reviewRequestSessionId={effectiveReview?.ownerId}
										onReviewChange={onReviewChange}
										send={connected ? send : undefined}
										onOpenTab={(tab) => {
											setInfoPageOpen(false);
											setSubagentStack([]);
											selectPanelTab(tab);
											setPanelOpen(true);
										}}
										onAddToInput={(text) => {
											setInfoPageOpen(false);
											setComposerPrefill((prev) => ({
												seq: (prev?.seq ?? 0) + 1,
												text,
											}));
										}}
										onOpenSession={(id) => {
											setInfoPageOpen(false);
											onOpenSession?.(id);
										}}
										liveMediaCount={liveMediaCount}
										liveMedia={liveOverviewMedia}
									/>
								</div>
							</div>,
							document.body,
						)
					) : null;
				const placedHeader =
					isPhone && headerActionsEl
						? createPortal(header, headerActionsEl)
						: topbarEl
							? createPortal(header, topbarEl)
							: header;
				return (
					<>
						{placedHeader}
						{phoneInfoPage}
					</>
				);
			})()}

			{/* Repo tile leads the mobile title pill (Slack-header style) — it
			    portals into the pill's leading slot in front of the name. */}
			{isPhone &&
				headerRepoEl &&
				hasWorkspace &&
				createPortal(
					<RepoTile name={session.repo || "tella-fusion"} size={18} round />,
					headerRepoEl,
				)}

			{/* Compact "chat bar" under the mobile top-bar title: it just *shows*
			    the session's model (no per-item dropdowns) — tapping it (or the
			    title above) opens the settings menu where they, and every other
			    workspace/chat setting, can be changed. */}
			{isPhone &&
				headerModelEl &&
				(hasWorkspace || models.length > 0) &&
				createPortal(
					<span
						className="header-chatbar session-settings-trigger"
						role="button"
						tabIndex={0}
						title="Workspace & chat settings"
						onClick={() =>
							// The metadata line is a React portal, so its clicks bubble
							// through this component's tree — not App's title button. Fire
							// the same event so tapping repo/model/cost opens the info page.
							window.dispatchEvent(
								new Event("backstage:toggle-session-settings"),
							)
						}
					>
						{/* The engine-running status dot rides the metadata line on
						    phones (it used to sit next to the title) so the name stays
						    steady and the working state reads alongside model · cost. */}
						{isRunningLive && <span className="working-dot" />}
						{/* Repo now leads the pill (portaled into headerRepoEl in front of
						    the title), so the metadata line is just model · cost. */}
						{models.length > 0 && (
							<span className="header-chatbar-model truncate">
								{/* Drop the "Claude " prefix — "Opus 4.8" reads fine in the
								    thin subtitle and leaves room for the cost meter. */}
								{metadataModelLabel(effectiveModel, models).replace(
									/^Claude[\s-]+/i,
									"",
								)}
							</span>
						)}
						{/* The composer's cost/context meter can't fit in the toolbar on
						    phones, so it rides here after the model. */}
						{usage && usage.turns > 0 && (
							<>
								<span className="header-chatbar-sep" aria-hidden="true">
									·
								</span>
								<UsageMeter usage={usage} className="chatbar-usage" showCacheRate />
							</>
						)}
					</span>,
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
					{showReview && hasWorkspace ? (
						<div className="viewer-review-main">
							<PrPanel
								sessionId={session.id}
								send={send}
								split
								onAddToInput={(text) =>
									setComposerPrefill((p) => ({
										seq: (p?.seq ?? 0) + 1,
										text,
									}))
								}
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
								linkedPrs={session.linkedPrs}
								linkable
								walkthrough={session.walkthrough}
							/>
						</div>
					) : (
					<>
					<div className="viewer-messages-region">
						<div
							className="viewer-messages"
							ref={messagesRef}
							onScroll={onScroll}
							onClick={handleMessagesClick}
						>
							{loading ? (
								<div className="loading">Loading transcript…</div>
							) : waitingForWorkspace ? (
								// Worktree prep in flight — the first message waits in the
								// queue flap below and sends the moment this clears.
								<WorkspaceWaiting
									detail={
										session.branch
											? `Creating a worktree for ${session.branch} — queued messages send when it's ready.`
											: "Creating the worktree — queued messages send when it's ready."
									}
								/>
							) : entries.length === 0 && !session.transcriptPath ? (
								// A fresh chat with no run yet is just an empty conversation —
								// blank canvas, the composer below is the UI. Only a session
								// that *ran* but has no transcript file gets the notice. When
								// the workspace has sibling chats, the canvas offers their
								// transcripts as attachable context for the first message.
								session.claudeSessionId || session.codexThreadId ? (
									<div className="empty">
										No transcript available for this session
									</div>
								) : !hasLiveConversation && contextChatOptions.length > 0 ? (
									// Simple centered empty state: the whole region centers the
									// heading + attachable-context chips so a fresh chat reads as a
									// calm blank canvas rather than a top-left form.
									<div className="min-h-full flex flex-col items-center justify-center text-center w-full max-w-[840px] mx-auto px-4">
										<div className="text-dim mb-4">
											New chat in{" "}
											<span className="text-fg font-medium">
												{workspaceName || session.branch || "this workspace"}
											</span>
											.
										</div>
										<div className="text-dim mb-3">Add chat transcripts</div>
										<div className="flex flex-wrap items-center justify-center gap-2">
											{(showAllContextChats
												? contextChatOptions
												: contextChatOptions.slice(0, 4)
											).map((c) => {
												const selected = contextChats.includes(c.id);
												const codex =
													(c.model || "").startsWith("gpt") ||
													(c.model || "").startsWith("codex");
												const ChipIcon = selected
													? IconCheck
													: codex
														? IconTerminal
														: IconSparkle;
												return (
													<Button
														key={c.id}
														icon={
															<ChipIcon
																size={16}
																className={selected ? "text-green" : undefined}
															/>
														}
														onClick={() =>
															setContextChats((prev) =>
																prev.includes(c.id)
																	? prev.filter((id) => id !== c.id)
																	: [...prev, c.id],
															)
														}
														title={
															selected
																? "Attached — its transcript rides along with your first message"
																: "Attach this chat's transcript as context"
														}
														className={
															selected
																? "border-line-strong bg-active text-fg"
																: undefined
														}
													>
														<span className="max-w-[200px] truncate">
															{c.title || "Untitled chat"}
														</span>
													</Button>
												);
											})}
											{!showAllContextChats && contextChatOptions.length > 4 && (
												<Button
													variant="ghost"
													onClick={() => setShowAllContextChats(true)}
												>
													+{contextChatOptions.length - 4} more
												</Button>
											)}
										</div>
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

							{isBusy && !waitingForWorkspace && (
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
									attached={attachedComposer}
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
									usage={usage}
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
					</>
					)}
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
						{/* Phones open this panel as a full-width bottom sheet, so it
						    carries one clean header row: chevron-back to the chat on the
						    left (the desktop toggle button is hidden there) and the
						    labelled Preview/Staging controls on the right — on desktop
						    those live in the session header as state-colored icons. */}
						{isPhone && (
							<div className="panel-sheet-head">
								<button
									className="panel-back"
									onClick={() => setPanelOpen(false)}
									aria-label="Back to chat"
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
								<div className="panel-sheet-actions">
									<PreviewButton
										session={session}
										onAttachImage={(img) =>
											setImages((prev) => [...prev, img])
										}
									/>
									<StagingLink session={session} />
								</div>
							</div>
						)}
						{hasWorkspace && (
							<PrStatusBar
								sessionId={session.id}
								repo={session.repo || undefined}
								archived={session.archived}
								send={connected ? send : undefined}
								onOpenPrTab={() => onOpenReview?.()}
								running={isRunningLive}
								refreshTick={gitRefreshTick}
								// Globe (staging deploy) rides inside the strip, left of the
								// PR chip, so it shares the strip's tone background — it's
								// pulled out of the header while the panel is open. On phones
								// the globe stays in the sheet-head row above.
								leading={
									!isPhone ? (
										<StagingLink session={session} variant="header" />
									) : undefined
								}
							/>
						)}
						<div className="panel-tabs">
							<button
								className={`panel-tab ${panelTab === "info" ? "active" : ""}`}
								onClick={() => selectPanelTab("info")}
							>
								Info
							</button>
							{canSideChat && (
								<button
									className={`panel-tab ${panelTab === "sidechats" ? "active" : ""}`}
									onClick={() => selectPanelTab("sidechats")}
								>
									Side chats
								</button>
							)}
							{hasWorkspace && (
								<>
									<button
										className={`panel-tab ${panelTab === "changes" ? "active" : ""}`}
										onClick={() => selectPanelTab("changes")}
									>
										Changes
										{changesFileCount ? (
											<span className="panel-tab-count">
												{changesFileCount}
											</span>
										) : null}
									</button>
									<button
										className={`panel-tab ${panelTab === "terminal" ? "active" : ""}`}
										onClick={() => selectPanelTab("terminal")}
									>
										Terminal
									</button>
									<button
										className={`panel-tab ${panelTab === "chat" ? "active" : ""}`}
										onClick={() => selectPanelTab("chat")}
									>
										Chat
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
							{/* Shown whenever the session CAN run workflows (it needs a
							    worktree for the agents' cwd), not only once a run exists —
							    a tab that only appears after the fact is undiscoverable.
							    The panel's empty state explains how to start one. */}
							{(hasWorkspace || workflowRuns.length > 0) && (
								<button
									className={`panel-tab ${panelTab === "workflows" ? "active" : ""}`}
									onClick={() => selectPanelTab("workflows")}
								>
									Agents
									{workflowRuns.some((r) => r.status === "running") ? (
										<span className="panel-tab-dot animate-pulse bg-green" />
									) : workflowRuns.length > 0 ? (
										<span className="panel-tab-count">
											{workflowRuns.length}
										</span>
									) : null}
								</button>
							)}
							{/* Scratch artifacts the agent saved for previewing (works in
							    ask mode too — no workspace needed). Appears once the first
							    file lands; the assets_changed broadcast keeps it live. */}
							{assetFiles.length > 0 && (
								<button
									className={`panel-tab ${panelTab === "assets" ? "active" : ""}`}
									onClick={() => selectPanelTab("assets")}
								>
									Assets
									<span className="panel-tab-count">{assetFiles.length}</span>
								</button>
							)}
						</div>
						<div className="panel-body">
							{/* Plain-only sessions (no code workspace) show just the timeline. */}
							{panelTab === "info" ? (
								<WorkspaceInfo
									sessionId={session.id}
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
									prState={hasWorkspace ? session.prState : undefined}
									sandbox={session.sandbox}
									reviewRequest={effectiveReview?.req ?? null}
									reviewRequestSessionId={effectiveReview?.ownerId}
									onReviewChange={onReviewChange}
									send={connected ? send : undefined}
									onOpenTab={(tab) => (tab === "pr" ? onOpenReview?.() : selectPanelTab(tab))}
									onAddToInput={(text) =>
										setComposerPrefill((p) => ({
											seq: (p?.seq ?? 0) + 1,
											text,
										}))
									}
									onOpenSession={(id) => onOpenSession?.(id)}
									liveMediaCount={liveMediaCount}
									liveMedia={liveOverviewMedia}
								/>
							) : panelTab === "sidechats" ? (
								<SideChatsPanel
									sessionId={session.id}
									onMention={insertMention}
									createSeq={sideChatCreateSeq}
									onCreateConsumed={() => setSideChatCreateSeq(0)}
								/>
							) : panelTab === "workflows" ? (
								// Before the Plain fallthrough: a Plain-only session's
								// Agents tab must win over its default timeline panel.
								// Renders with zero runs too — the panel's empty state is
								// how you discover workflows exist.
								<WorkflowPanel
									sessionId={session.id}
									runs={workflowRuns}
									onCancel={cancelWorkflowRun}
								/>
							) : panelTab === "assets" ? (
								// Also before the Plain fallthrough: assets exist for
								// ask/Plain sessions with no code workspace.
								<AssetsPanel
									sessionId={session.id}
									files={assetFiles}
									refresh={refreshAssets}
								/>
							) : (panelTab === "plain" || !hasWorkspace) && hasPlain ? (
								<PlainThreadPanel
									sessionId={session.id}
									threadId={session.plainThreadId!}
									plainUrl={plainUrl}
								/>
							) : waitingForWorkspace &&
							  (panelTab === "changes" ||
									panelTab === "terminal") ? (
								// These tabs all read the worktree — hold them behind the
								// waiting state until the create run finishes preparing it.
								<WorkspaceWaiting detail="Waiting for the workspace to be ready." />
							) : panelTab === "changes" ? (
								<DiffPanel
									sessionId={session.id}
									isRunning={isBusy}
									canSend={connected && !isBusy && !noEngine}
									send={send}
									diff={diffState}
								/>
							) : panelTab === "terminal" ? (
								<TerminalPanel
									entries={entries}
									sessionId={session.id}
									send={send}
									addHandler={addHandler}
								/>
							) : panelTab === "chat" ? (
								<TeamChat
									channel={`session:${session.id}`}
									user={getCurrentUser()}
									sessions={allSessions || workspaceChats || []}
									projects={allProjects}
									send={send}
									addHandler={addHandler}
									onOpenSession={(id) => onOpenSession?.(id)}
									variant="panel"
								/>
							) : null}
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

// Placeholder for regions that need the session's worktree while the create
// run is still preparing it (new-workspace creates announce the session before
// the slow git work — see create_session in backstage.ts).
function WorkspaceWaiting({ detail }: { detail: string }) {
	return (
		<div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
			<PixelSpinner className="mb-2 text-dim" />
			<div className="text-[14px] font-semibold text-fg">
				Waiting for workspace
			</div>
			<div className="max-w-[340px] text-[13px] font-medium leading-relaxed text-dim">
				{detail}
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
