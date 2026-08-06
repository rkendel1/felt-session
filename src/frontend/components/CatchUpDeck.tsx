import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	AnimatePresence,
	motion,
	useMotionValue,
	useTransform,
	type PanInfo,
} from "motion/react";
import type {
	UnifiedSession,
	Workspace,
	TranscriptEntry,
	WSClientMessage,
} from "../lib/types";
import {
	fetchTranscript,
	fetchModels,
	fetchProviderAccounts,
	fetchFileMentions,
	fetchSkillMentions,
	type ModelOption,
	type ProviderAccountOption,
} from "../lib/api";
import { loadDraft, saveDraft } from "../lib/drafts";
import { Button } from "../ui/button";
import type { FileAttachment } from "../lib/images";
import { getReads, isUnread, markRead } from "../lib/reads";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { Composer } from "./Composer";
import { useCurrentUser } from "./UserPicker";
import { shortTime, elapsedClock } from "../lib/time";

/**
 * Catch-up deck — a Slack-style "swipe through your unread" card stack. Each
 * card is one of your unread workspaces: you can read the full conversation and
 * reply inline, then act to advance:
 *   swipe left  / Archive      → archive the workspace, next
 *   swipe right / Mark as Read → mark it read, next
 *   tap up      / Keep Unread  → skip without changing state, next
 *   reply                      → sends the message, marks read, next
 * The queue is snapshotted once (frozen) so marking-read / archiving / live
 * activity doesn't reshuffle the cards out from under you as you go.
 */

const DEFAULT_REPO = "repository";
const SWIPE_DISTANCE = 110; // px of drag past which a release commits
const SWIPE_VELOCITY = 520; // px/s flick that commits regardless of distance

type Action = "archive" | "read" | "keep";

interface CatchupCard {
	key: string;
	workspaceId: string | null;
	name: string;
	sessions: UnifiedSession[]; // createdAt asc
	repo: string;
	owner: string;
	lastActivity: string;
}

/** The session a read/reply lands on: the freshest one in the workspace. */
function replyTarget(card: CatchupCard): UnifiedSession {
	return card.sessions.reduce((best, c) =>
		c.lastActivity > best.lastActivity ? c : best,
	);
}

interface Props {
	sessions: UnifiedSession[];
	workspaces: Workspace[];
	/** WebSocket sender — used to post a reply into a session. */
	send: (msg: WSClientMessage) => void;
	connected: boolean;
	/** Archive every session in a workspace (reuses App's archive handler). */
	onArchive: (sessions: UnifiedSession[]) => void;
	/** Open the real session behind a card. */
	onOpenSession: (id: string) => void;
	/** Start a fresh workspace (opens the new-session palette). */
	onNewWorkspace: () => void;
	/** Leave the deck (back / done). */
	onExit: () => void;
}

export function CatchUpDeck({
	sessions,
	workspaces,
	send,
	connected,
	onArchive,
	onOpenSession,
	onNewWorkspace,
	onExit,
}: Props) {
	const currentUser = useCurrentUser();

	// Model / subscription options for the reply composer (fetched once, shared
	// across cards). Empty until they load — the composer degrades gracefully.
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
	useEffect(() => {
		fetchModels()
			.then((m) => {
				setModels(m.models);
				setDefaultModel(m.default);
			})
			.catch(() => {});
		fetchProviderAccounts()
			.then(setAccounts)
			.catch(() => {});
	}, []);

	// The unread queue is snapshotted once and then frozen — subsequent refreshes
	// (from our own mark-read / archive / reply, or live WS activity) must not
	// reorder or drop cards mid-swipe. It's frozen on the first render where the
	// session list has actually loaded, NOT on the very first mount: a deep-link
	// to <base>/catchup mounts before `sessions` arrives, and freezing []
	// there would strand the deck on "All caught up" forever.
	const frozen = useRef<CatchupCard[] | null>(null);
	const cards = useMemo<CatchupCard[]>(() => {
		if (frozen.current) return frozen.current;
		const reads = getReads();
		const me = currentUser.toLowerCase();
		const unread = sessions.filter(
			(s) =>
				!s.archived &&
				!s.automation &&
				!!s.startedBy &&
				s.startedBy.toLowerCase() === me &&
				isUnread(s.id, s.lastActivity, reads),
		);
		const groups = new Map<string, UnifiedSession[]>();
		const order: string[] = [];
		for (const s of unread) {
			const key = s.workspaceId ? `ws:${s.workspaceId}` : `session:${s.id}`;
			if (!groups.has(key)) {
				groups.set(key, []);
				order.push(key);
			}
			groups.get(key)!.push(s);
		}
		const out = order.map((key): CatchupCard => {
			const sessions = groups
				.get(key)!
				.slice()
				.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			const wsId = key.startsWith("ws:") ? key.slice(3) : null;
			const ws = wsId ? workspaces.find((p) => p.id === wsId) : null;
			return {
				key,
				workspaceId: wsId,
				name: ws?.name || sessions[0].title,
				sessions,
				repo: sessions[0].repo || DEFAULT_REPO,
				owner: sessions[0].startedBy || "",
				lastActivity: sessions.reduce(
					(m, c) => (c.lastActivity > m ? c.lastActivity : m),
					"",
				),
			};
		});
		out.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
		// Freeze once the list has loaded (even to an empty queue — that's a
		// genuine "all caught up"). While it's still empty we keep recomputing.
		if (sessions.length > 0) frozen.current = out;
		return out;
	}, [sessions, currentUser, workspaces]);

	const [index, setIndex] = useState(0);
	const [dir, setDir] = useState<Action | null>(null);
	const card = cards[index];
	const total = cards.length;
	const remaining = total - index;

	function act(action: Action) {
		if (!card) return;
		if (action === "read") {
			for (const c of card.sessions) markRead(c.id, c.lastActivity);
		} else if (action === "archive") {
			onArchive(card.sessions);
		}
		setDir(action);
		setIndex((i) => i + 1);
	}

	// After a reply is sent (by the card's composer, into the freshest session),
	// mark the workspace read and advance — same as a right-swipe.
	function onReplied() {
		if (card) act("read");
	}

	// Keyboard: ←/→ act, ↑ skip, esc leaves. (Space is left for the composer.)
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") return onExit();
			if (!card) return;
			// Don't hijack arrows while typing a reply.
			const el = e.target as HTMLElement | null;
			if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				act("archive");
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				act("read");
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				act("keep");
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [card, index]);

	const done = index >= total;
	const next = cards[index + 1];

	return (
		<div className="flex min-h-0 flex-1 flex-col items-center bg-surface">
			{/* Header: back + "N Left" counter + new-workspace (Slack-style). This is
			    the deck's only top bar — the app's mobile back bar is suppressed for
			    the catch-up view — so it carries the safe-area top inset itself.
			    The chevron is that suppressed bar's stand-in and stays phone-only:
			    on desktop the sidebar (and its ‹ caret) is always there, no other
			    view offers a back control, and the pane's left edge belongs to the
			    collapsed-sidebar controls. Esc still leaves the deck. */}
			<div className="deck-header flex w-full items-center justify-between px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
				<button
					className="hidden h-10 w-10 items-center justify-center rounded-md bg-transparent text-dim hover:bg-panel hover:text-fg max-[720px]:flex"
					onClick={onExit}
					title="Back"
					aria-label="Back"
				>
					<svg width="26" height="26" viewBox="0 0 16 16" fill="none">
						<path
							d="M10 3.5 5.5 8l4.5 4.5"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
				<div className="deck-header-title text-sm font-semibold text-fg">
					{done ? "All caught up" : `${remaining} Left`}
				</div>
				{/* ml-auto, not just justify-between: with the chevron hidden this is
				    the row's only in-flow child (the counter is absolutely centered),
				    and justify-between would pack it against the left edge. */}
				<button
					className="ml-auto flex h-10 w-10 items-center justify-center rounded-md bg-transparent text-dim hover:bg-panel hover:text-fg"
					onClick={onNewWorkspace}
					title="New workspace (⌘N)"
					aria-label="New workspace"
				>
					<svg width="26" height="26" viewBox="0 0 24 24" fill="none">
						<path
							d="M12 5.75V18.25M18.25 12H5.75"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</div>

			{done ? (
				<CaughtUp total={total} onExit={onExit} />
			) : (
				<div className="relative flex w-full max-w-[860px] flex-1 items-center justify-center px-4 pb-4">
					{/* Peek of the next card behind the top one, for depth. */}
					{next && (
						<div
							className="absolute inset-x-4 top-1 bottom-5 scale-[0.97] rounded-lg border border-line bg-panel opacity-60"
							aria-hidden
						/>
					)}
					<AnimatePresence initial={false} custom={dir}>
						<SwipeCard
							key={card.key}
							card={card}
							custom={dir}
							connected={connected}
							models={models}
							defaultModel={defaultModel}
							accounts={accounts}
							send={send}
							currentUser={currentUser}
							onArchive={() => act("archive")}
							onMarkRead={() => act("read")}
							onOpen={() => onOpenSession(replyTarget(card).id)}
							onReplied={onReplied}
						/>
					</AnimatePresence>
				</div>
			)}

			{/* Action bar (works without gestures; mirrors the screenshot). */}
			{!done && (
				<div className="flex w-full max-w-[860px] items-stretch gap-2.5 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
					<Button
						size="lg"
						className="flex-1 py-3 text-sm"
						onClick={() => act("keep")}
						title="Keep unread (↑)"
					>
						Keep Unread
					</Button>
					<Button
						variant="danger"
						size="lg"
						/* The soft fill is always on here rather than only on hover:
						   this is a standing choice in a triage deck, not a
						   warning you hover into. */
						className="bg-red-soft py-3 text-sm"
						onClick={() => act("archive")}
						title="Archive (←)"
						aria-label="Archive"
					>
						<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
							<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
							<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
							<path d="M6.5 8.5h3" strokeLinecap="round" />
						</svg>
					</Button>
					<Button
						/* `success` (not `primary`) — this is the affirmative half of
						   the pair, not the app's accent CTA. It takes the family's
						   solid fill rather than its outline because it's the deck's
						   dominant action; everything else comes from the variant. */
						variant="success"
						size="lg"
						className="flex-1 bg-green py-3 text-sm text-white hover:bg-green hover:brightness-110"
						onClick={() => act("read")}
						title="Mark as read (→)"
					>
						Mark as Read
					</Button>
				</div>
			)}
		</div>
	);
}

function SwipeCard({
	card,
	custom,
	connected,
	models,
	defaultModel,
	accounts,
	send,
	currentUser,
	onArchive,
	onMarkRead,
	onOpen,
	onReplied,
}: {
	card: CatchupCard;
	custom: Action | null;
	connected: boolean;
	models: ModelOption[];
	defaultModel: string;
	accounts: ProviderAccountOption[];
	send: (msg: WSClientMessage) => void;
	currentUser: string;
	onArchive: () => void;
	onMarkRead: () => void;
	onOpen: () => void;
	onReplied: () => void;
}) {
	const x = useMotionValue(0);
	const rotate = useTransform(x, [-260, 260], [-9, 9]);
	const archiveTint = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
	const readTint = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);

	function onDragEnd(_: unknown, info: PanInfo) {
		if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY)
			onArchive();
		else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY)
			onMarkRead();
	}

	// Exit is a function variant so AnimatePresence's `custom` (the action taken)
	// picks the fling direction — left for archive, right for read, up for skip.
	const variants = {
		exit: (a: Action | null) => ({
			x: a === "archive" ? -560 : a === "read" ? 560 : 0,
			y: a === "keep" ? -560 : 0,
			rotate: a === "archive" ? -12 : a === "read" ? 12 : 0,
			opacity: 0,
			transition: { duration: 0.26 },
		}),
	};

	return (
		<motion.div
			className="absolute inset-x-4 top-1 bottom-5 flex touch-pan-y flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-[0_8px_30px_rgba(0,0,0,0.28)]"
			style={{ x, rotate }}
			drag="x"
			dragConstraints={{ left: 0, right: 0 }}
			dragElastic={0.7}
			onDragEnd={onDragEnd}
			variants={variants}
			initial={{ scale: 0.97, opacity: 0, y: 12 }}
			animate={{ scale: 1, opacity: 1, y: 0 }}
			exit="exit"
			custom={custom}
			transition={{ type: "spring", stiffness: 400, damping: 34 }}
		>
			{/* Swipe intent stamps. */}
			<motion.div
				className="pointer-events-none absolute left-4 top-16 z-10 rounded-md border-2 border-red px-2.5 py-1 text-sm font-bold tracking-wide text-red"
				style={{ opacity: archiveTint, rotate: -12 }}
			>
				Archive
			</motion.div>
			<motion.div
				className="pointer-events-none absolute right-4 top-16 z-10 rounded-md border-2 border-green px-2.5 py-1 text-sm font-bold tracking-wide text-green"
				style={{ opacity: readTint, rotate: 12 }}
			>
				Read
			</motion.div>

			<CardBody
				card={card}
				connected={connected}
				models={models}
				defaultModel={defaultModel}
				accounts={accounts}
				send={send}
				currentUser={currentUser}
				onOpen={onOpen}
				onReplied={onReplied}
			/>
		</motion.div>
	);
}

function CardBody({
	card,
	connected,
	models,
	defaultModel,
	accounts,
	send,
	currentUser,
	onOpen,
	onReplied,
}: {
	card: CatchupCard;
	connected: boolean;
	models: ModelOption[];
	defaultModel: string;
	accounts: ProviderAccountOption[];
	send: (msg: WSClientMessage) => void;
	currentUser: string;
	onOpen: () => void;
	onReplied: () => void;
}) {
	const target = replyTarget(card);
	const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		setEntries(null);
		fetchTranscript(target.id)
			.then((e) => {
				if (alive) setEntries(e);
			})
			.catch(() => {
				if (alive) setEntries([]);
			});
		return () => {
			alive = false;
		};
	}, [target.id]);

	// Open on the newest message (the unread part), like Slack lands you at the
	// bottom of the thread.
	useEffect(() => {
		if (entries && scrollRef.current)
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [entries, target.isRunning]);

	const meta = [
		card.repo,
		card.sessions.length > 1 ? `${card.sessions.length} sessions` : null,
		card.lastActivity ? shortTime(card.lastActivity) : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<>
			<button
				className="flex w-full shrink-0 flex-col items-start gap-0.5 border-b border-line bg-transparent px-5 py-3.5 text-left"
				onClick={onOpen}
				title="Open the full session"
			>
				<span className="line-clamp-1 text-item-title font-semibold text-fg">
					{card.name}
				</span>
				<span className="text-xs text-faint">{meta}</span>
			</button>

			{/* touch-pan-y so vertical gestures scroll the transcript but horizontal
			    ones bubble up to the card's drag handler (otherwise the scroll
			    container eats the swipe on touch devices). */}
			<div
				ref={scrollRef}
				className="catchup-scroll min-h-0 flex-1 touch-pan-y overflow-y-auto px-4 py-3"
			>
				{entries === null ? (
					<div className="space-y-2">
						<div className="h-3 w-1/3 animate-pulse rounded bg-surface" />
						<div className="h-3 w-full animate-pulse rounded bg-surface" />
						<div className="h-3 w-4/5 animate-pulse rounded bg-surface" />
					</div>
				) : entries.length === 0 ? (
					<div className="text-sm text-faint">No messages yet.</div>
				) : (
					<TranscriptBlocks entries={entries} owner={card.owner} />
				)}
				{/* Live "still working" ticker: while the session we're reading is mid-run,
				    show a pulsing dot + elapsed clock at the bottom of the transcript so
				    the card reads as in-progress (mirrors SessionViewer's busy row). */}
				{target.isRunning && <CatchupWorking target={target} />}
			</div>

			<CatchUpComposer
				target={target}
				connected={connected}
				models={models}
				defaultModel={defaultModel}
				accounts={accounts}
				send={send}
				currentUser={currentUser}
				onReplied={onReplied}
			/>
		</>
	);
}

/**
 * The catch-up reply box is the full shared Composer, wired to the card's
 * reply-target session — so a reply from the deck has the same reach as one
 * from the session view: attach images/files, switch the model + reasoning
 * effort, pin a subscription, set a goal, dictate, and @-mention repo files.
 * Model / subscription / goal changes route through the /model, /sub and /goal
 * slash commands (persisted + broadcast server-side), exactly like SessionViewer.
 * Slack sessions can switch models too (the /model command syncs the loop's
 * store server-side); Linear-owned sessions keep the model fixed — that's the
 * owning agent's call — but still get attachments and effort.
 */
function CatchUpComposer({
	target,
	connected,
	models,
	defaultModel,
	accounts,
	send,
	currentUser,
	onReplied,
}: {
	target: UnifiedSession;
	connected: boolean;
	models: ModelOption[];
	defaultModel: string;
	accounts: ProviderAccountOption[];
	send: (msg: WSClientMessage) => void;
	currentUser: string;
	onReplied: () => void;
}) {
	// Share the session's draft with the main session view (same key), so a reply
	// half-typed here shows up there and vice-versa. Images/files are parked in
	// the same draft record (Composer only owns the text).
	const draftKey = `session:${target.id}`;
	const [images, setImages] = useState<string[]>(() => loadDraft(draftKey).images);
	const [files, setFiles] = useState<FileAttachment[]>(
		() => loadDraft(draftKey).files,
	);
	useEffect(() => {
		saveDraft(draftKey, { images, files });
	}, [draftKey, images, files]);

	const [model, setModel] = useState(target.model || "");
	const [accountId, setAccountId] = useState(target.accountId || "");
	const [effort, setEffort] = useState("high");
	// Optimistic goal (the /goal command persists but doesn't broadcast a live
	// update); `undefined` defers to the session's stored goal.
	const [goalOverride, setGoalOverride] = useState<string | null | undefined>(
		undefined,
	);
	const currentGoal =
		goalOverride !== undefined ? goalOverride : target.goal ?? null;

	const isNative = target.source === "opensession";
	// Send the reply into the target session (images fold in as content blocks;
	// files route to the queue server-side), then advance the deck.
	function handleSend(raw: string): boolean {
		const text = raw.trim();
		if (!text && images.length === 0 && files.length === 0) return false;
		if (!connected) return false;
		// Prefer the staged disk path (HTTP upload); fall back to inline dataUrl.
		const filePayload = files.map((f) =>
			f.path ? { name: f.name, path: f.path } : { name: f.name, dataUrl: f.dataUrl },
		);
		send({
			type: "prompt",
			sessionId: target.id,
			content: text,
			user: currentUser,
			effort,
			...(images.length ? { images } : {}),
			...(files.length ? { files: filePayload } : {}),
		});
		setImages([]);
		setFiles([]);
		onReplied();
		return true;
	}

	// Model / account / goal all route through their slash commands (they
	// persist, notice, and broadcast to other viewers) — mirrors SessionViewer.
	function handleModelChange(next: string) {
		const targetModel = next || defaultModel;
		if (!targetModel || targetModel === (model || defaultModel)) return;
		setModel(next);
		send({
			type: "prompt",
			sessionId: target.id,
			content: `/model ${targetModel}`,
			user: currentUser,
		});
	}
	function handleAccountChange(next: string) {
		if (next === (accountId || "")) return;
		setAccountId(next);
		const acct = next ? accounts.find((a) => a.id === next) : null;
		send({
			type: "prompt",
			sessionId: target.id,
			content: next ? `/account ${acct?.id || next}` : "/account auto",
			user: currentUser,
		});
	}
	function handleSetGoal(goal: string | null) {
		setGoalOverride(goal);
		send({
			type: "prompt",
			sessionId: target.id,
			content: goal ? `/goal ${goal}` : "/goal clear",
			user: currentUser,
		});
	}

	return (
		// Stop pointerdown from reaching the card's drag handler so typing, the
		// menus and text selection in the composer never start a swipe.
		<div
			className="shrink-0 border-t border-line p-2.5"
			onPointerDownCapture={(e) => e.stopPropagation()}
		>
			<Composer
				draftKey={draftKey}
				onSend={handleSend}
				placeholder={connected ? "Reply…" : "Not connected"}
				disabled={!connected}
				sendDisabled={(text) =>
					!text.trim() && images.length === 0 && files.length === 0
				}
				images={images}
				onImagesChange={setImages}
				files={files}
				onFilesChange={setFiles}
				models={models}
				defaultModel={defaultModel}
				model={model}
				onModelChange={handleModelChange}
				modelDisabled={!isNative && target.source !== "slack"}
				modelTitle={
					isNative || target.source === "slack"
						? "Switch the model for this session"
						: "Set the model from the owning agent (its session file is agent-owned)"
				}
				effort={effort}
				onEffortChange={setEffort}
				accounts={isNative ? accounts : undefined}
				accountId={accountId}
				onAccountChange={isNative ? handleAccountChange : undefined}
				goal={currentGoal}
				onSetGoal={isNative ? handleSetGoal : undefined}
				mentionFetch={(q) => fetchFileMentions(q, target.id)}
				skillsFetch={(q) => fetchSkillMentions(q, target.id)}
			/>
		</div>
	);
}

/**
 * Live "still working" ticker shown at the tail of a card's transcript while the
 * session is mid-run. Self-ticks once a second so the re-render stays inside this
 * tiny node. Anchors to the run's start (runStartedAt, which survives a refresh),
 * falling back to lastActivity for external runs that never stamped one.
 */
function CatchupWorking({ target }: { target: UnifiedSession }) {
	const since = useMemo(() => {
		const raw = target.runStartedAt || target.lastActivity;
		const t = raw ? Date.parse(raw) : NaN;
		return Number.isNaN(t) ? Date.now() : t;
	}, [target.runStartedAt, target.lastActivity]);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	return (
		<div className="mt-2 flex items-center gap-2 px-1 text-xs text-faint">
			<span className="pulse-dot" />
			<span>Working</span>
			<span className="tabular-nums">{elapsedClock(since, now)}</span>
		</div>
	);
}

function CaughtUp({ total, onExit }: { total: number; onExit: () => void }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
			<div className="text-4xl">✨</div>
			<div className="text-item-title font-semibold text-fg">All caught up</div>
			<div className="max-w-xs text-sm text-dim">
				{total > 0
					? `You went through ${total} workspace${total === 1 ? "" : "s"}.`
					: "Nothing unread right now."}
			</div>
			<Button
				size="lg"
				className="mt-2 text-sm"
				onClick={onExit}
			>
				Done
			</Button>
		</div>
	);
}
