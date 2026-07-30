/**
 * The app root: tabs, panes, modes, and the one place actions are executed.
 *
 * Three stores, one direction of flow:
 *   SessionsPoller  — what sessions exist (REST poll)
 *   WatchedSession  — what one session is doing (WebSocket frames)
 *   UiStore         — where the user is (tabs, panes, modes)
 *
 * Keys never mutate anything directly: they resolve to an Action through the
 * keymap, and `runAction` is the only mutator. Reads during key handling go
 * through the stores and refs, never through render-scoped state — a terminal
 * delivers `^b w` as two keypresses in one tick, and React hasn't re-rendered in
 * between (see ui-state.ts).
 */

import type { KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Api } from "../client/api";
import type { WatchPool } from "../client/pool";
import { initialSessionState } from "../client/session-store";
import { flattenGroups, type SessionsPoller } from "../client/sessions-poller";
import { sessionStatus, sessionTitle, type Session } from "../client/types";
import type { WatchedSession, WatchedSnapshot } from "../client/watched-session";
import { Composer, PromptOverlay } from "./composer";
import { Help } from "./help";
import { DEFAULT_PREFIX, resolveKey, type Action, type Pane } from "./keymap";
import { Sidebar } from "./sidebar";
import { StatusBar } from "./status-bar";
import { theme } from "./theme";
import { Transcript } from "./transcript";
import { UiStore } from "./ui-state";

/** The scroll verbs, pulled off the Action union so scrollBy can name them. */
type ScrollBy = Extract<Action, { type: "scroll" }>["by"];

export type AppProps = {
	api: Api;
	poller: SessionsPoller;
	pool: WatchPool;
	host: string;
	user: string;
	prefix?: string;
	/** Called on ^b d — the caller stops the renderer and exits the process. */
	onExit: () => void;
	/** Session to open on launch (`os <session-id>`). */
	initialSessionId?: string;
};

const PANES: Pane[] = ["sidebar", "transcript", "composer"];
const SPINNER_MS = 120;
const MESSAGE_MS = 4000;
const EMPTY_SNAPSHOT: WatchedSnapshot = {
	state: initialSessionState,
	connection: "connecting",
};

const noopSubscribe = () => () => {};

function useWatchedSnapshot(watched: WatchedSession | undefined): WatchedSnapshot {
	return useSyncExternalStore(
		watched?.subscribe ?? noopSubscribe,
		watched?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
	);
}

export function App({
	api,
	poller,
	pool,
	host,
	user,
	prefix = DEFAULT_PREFIX,
	onExit,
	initialSessionId,
}: AppProps) {
	const { width, height } = useTerminalDimensions();
	const sessions = useSyncExternalStore(poller.subscribe, poller.getState);

	const [uiStore] = useState(() => new UiStore(initialSessionId));
	const ui = useSyncExternalStore(uiStore.subscribe, uiStore.getState);

	const [spinnerFrame, setSpinnerFrame] = useState(0);
	const composerRef = useRef<TextareaRenderable>(null);
	const overlayRef = useRef<TextareaRenderable>(null);
	const scrollRef = useRef<ScrollBoxRenderable>(null);

	const flat = useMemo(() => flattenGroups(sessions.groups), [sessions.groups]);
	const byId = useMemo(
		() => new Map(sessions.sessions.map((s) => [s.id, s])),
		[sessions.sessions],
	);
	/** Read by key handlers, which must never see a stale session list. */
	const flatRef = useRef(flat);
	flatRef.current = flat;

	const activeSessionId = ui.tabs[ui.activeTab];
	const [watched, setWatched] = useState<WatchedSession>();
	const watchedRef = useRef<WatchedSession>(undefined);
	watchedRef.current = watched;

	// One live watch per open tab; the active tab's is the one we render.
	useEffect(() => {
		if (!activeSessionId) {
			setWatched(undefined);
			return;
		}
		setWatched(pool.ensure(activeSessionId));
	}, [activeSessionId, pool]);

	const snapshot = useWatchedSnapshot(watched);
	const state = snapshot.state;
	const stateRef = useRef(state);
	stateRef.current = state;
	const session = activeSessionId ? byId.get(activeSessionId) : undefined;

	const waiting = sessions.sessions.filter((s) => sessionStatus(s) === "waiting").length;
	const running = sessions.sessions.filter((s) => sessionStatus(s) === "running").length;

	// The spinner only ticks when something is actually spinning: an idle `os`
	// should cost nothing, especially over ssh.
	const animating = running > 0 || state.isRunning || state.streaming;
	useEffect(() => {
		if (!animating) return;
		const timer = setInterval(() => setSpinnerFrame((f) => f + 1), SPINNER_MS);
		return () => clearInterval(timer);
	}, [animating]);

	// A pending question is the one thing that should pull focus: it blocks a run
	// until a human acts. Typing is never interrupted — only nav mode yields.
	useEffect(() => {
		const current = uiStore.getState();
		if (state.ask && current.mode === "nav") uiStore.set({ mode: "ask" });
		if (!state.ask && current.mode === "ask") uiStore.set({ mode: "nav" });
	}, [state.ask, uiStore]);

	useEffect(() => {
		if (!ui.message) return;
		const timer = setTimeout(() => uiStore.set({ message: undefined }), MESSAGE_MS);
		return () => clearTimeout(timer);
	}, [ui.message, uiStore]);

	function note(text: string, kind: "info" | "error" = "info"): void {
		uiStore.set({ message: { text, kind } });
	}

	function closeActiveTab(): void {
		const sessionId = uiStore.activeSessionId;
		if (!sessionId) return;
		pool.release(sessionId);
		uiStore.closeTab(sessionId);
	}

	function submitPrompt(busyMode: "queue" | "steer"): void {
		const input = composerRef.current;
		const text = input?.plainText.trim() ?? "";
		if (!text) return;
		const target = watchedRef.current;
		if (!target) {
			note("open a session first", "error");
			return;
		}
		target.send(text, user, busyMode);
		input?.clear();
		note(
			busyMode === "steer"
				? "steered into the running turn"
				: stateRef.current.isRunning
					? "queued behind the running turn"
					: "sent",
		);
	}

	function answerOption(index: number): void {
		const ask = stateRef.current.ask;
		const question = ask?.questions[0];
		const option = question?.options?.[index];
		if (!ask || !question || !option) return;
		watchedRef.current?.answer({ [question.question]: option.label });
		note(`answered: ${option.label}`);
	}

	function scrollBy(by: ScrollBy): void {
		const box = scrollRef.current;
		if (!box) return;
		const page = Math.max(1, box.viewport.height - 1);
		switch (by) {
			case "line-up":
				box.scrollBy(-1);
				break;
			case "line-down":
				box.scrollBy(1);
				break;
			case "page-up":
				box.scrollBy(-page);
				break;
			case "page-down":
				box.scrollBy(page);
				break;
			case "top":
				box.scrollTo(0);
				break;
			case "bottom":
				box.scrollTo(box.scrollHeight);
				break;
		}
	}

	function createSession(prompt: string): void {
		note("creating session…");
		void api
			.createSession({ prompt, user, mode: "ask" })
			.then((created) => {
				poller.refreshSoon();
				const id = created.sessionId ?? created.id;
				if (id) uiStore.openTab(id);
				note("session created");
			})
			.catch((e) => note(String(e?.message ?? e), "error"));
	}

	function renameSession(title: string): void {
		const sessionId = uiStore.activeSessionId;
		if (!sessionId) return;
		void api
			.setTitle(sessionId, title)
			.then(() => {
				poller.refreshSoon();
				note(title ? `renamed to “${title}”` : "title cleared");
			})
			.catch((e) => note(String(e?.message ?? e), "error"));
	}

	function submitOverlay(): void {
		const value = overlayRef.current?.plainText.trim() ?? "";
		const overlay = uiStore.getState().overlay;
		uiStore.set({ overlay: null, mode: stateRef.current.ask ? "ask" : "nav" });
		if (!overlay) return;

		switch (overlay.kind) {
			case "picker": {
				const chosen = pickerMatches(flatRef.current, value)[overlay.selected];
				if (chosen) uiStore.openTab(chosen.id);
				return;
			}
			case "rename":
				renameSession(value);
				return;
			case "new":
				if (value) createSession(value);
				return;
			case "command":
				runCommand(value);
				return;
		}
	}

	function runCommand(raw: string): void {
		const [verb = "", ...rest] = raw.replace(/^:/, "").split(/\s+/);
		const argument = rest.join(" ");
		switch (verb) {
			case "":
				return;
			case "archive":
				runAction({ type: "archive" });
				return;
			case "new":
				if (argument) createSession(argument);
				else note("usage: new <prompt>", "error");
				return;
			case "rename":
				renameSession(argument);
				return;
			case "cancel":
				runAction({ type: "cancel-run" });
				return;
			case "reconnect":
				runAction({ type: "reconnect" });
				return;
			case "close":
				closeActiveTab();
				return;
			case "quit":
			case "detach":
				onExit();
				return;
			default: {
				// A bare `:some text` is a prompt — the most common thing you reach the
				// command line for once the verbs are in muscle memory.
				const target = watchedRef.current;
				if (target) {
					target.send(raw, user, "queue");
					note("sent");
				} else {
					note(`unknown command: ${verb}`, "error");
				}
			}
		}
	}

	function runAction(action: Action): void {
		const current = uiStore.getState();
		switch (action.type) {
			case "next-tab":
				if (current.tabs.length) {
					uiStore.set({ activeTab: (current.activeTab + 1) % current.tabs.length });
				}
				return;
			case "prev-tab":
				if (current.tabs.length) {
					uiStore.set({
						activeTab: (current.activeTab - 1 + current.tabs.length) % current.tabs.length,
					});
				}
				return;
			case "jump-tab": {
				// tmux numbers windows from 1 and puts 10 on `0`.
				const target = action.index === 0 ? 9 : action.index - 1;
				if (target < current.tabs.length) uiStore.set({ activeTab: target });
				return;
			}
			case "focus-pane": {
				const at = PANES.indexOf(current.pane);
				const next =
					PANES[(at + (action.direction === "next" ? 1 : PANES.length - 1)) % PANES.length]!;
				// Focusing the composer with no session open would leave the user
				// typing into nothing.
				if (next === "composer" && !uiStore.activeSessionId) {
					uiStore.set({ pane: "sidebar", mode: "nav" });
					return;
				}
				uiStore.set({
					pane: next,
					mode: next === "composer" ? "composer" : stateRef.current.ask ? "ask" : "nav",
				});
				return;
			}
			case "move-cursor":
				if (current.overlay?.kind === "picker") {
					const matches = pickerMatches(flatRef.current, overlayRef.current?.plainText ?? "");
					uiStore.set({
						overlay: {
							kind: "picker",
							selected: clamp(current.overlay.selected + action.delta, 0, matches.length - 1),
						},
					});
					return;
				}
				uiStore.set({
					cursor: clamp(current.cursor + action.delta, 0, Math.max(0, flatRef.current.length - 1)),
					pane: "sidebar",
				});
				return;
			case "open-selected": {
				if (current.overlay) {
					submitOverlay();
					return;
				}
				const chosen = flatRef.current[current.cursor];
				if (chosen) uiStore.openTab(chosen.id);
				return;
			}
			case "new-session":
				uiStore.set({ overlay: { kind: "new" }, mode: "command" });
				return;
			case "close-tab":
				closeActiveTab();
				return;
			case "cancel-run": {
				const target = watchedRef.current;
				if (!target) return;
				target.cancel();
				note("interrupting the current turn…");
				return;
			}
			case "rename":
				if (!uiStore.activeSessionId) {
					note("no session open", "error");
					return;
				}
				uiStore.set({ overlay: { kind: "rename" }, mode: "command" });
				return;
			case "archive": {
				const sessionId = uiStore.activeSessionId;
				if (!sessionId) {
					note("no session open", "error");
					return;
				}
				void api
					.setArchived(sessionId, true)
					.then(() => {
						pool.release(sessionId);
						uiStore.closeTab(sessionId);
						poller.refreshSoon();
						note("archived");
					})
					.catch((e) => note(String(e?.message ?? e), "error"));
				return;
			}
			case "detach":
				onExit();
				return;
			case "reconnect": {
				const sessionId = uiStore.activeSessionId;
				if (!sessionId) return;
				pool.release(sessionId);
				setWatched(pool.ensure(sessionId));
				note("reconnecting…");
				return;
			}
			case "toggle-help":
				uiStore.set({ mode: current.mode === "help" ? "nav" : "help" });
				return;
			case "open-picker":
				uiStore.set({ overlay: { kind: "picker", selected: 0 }, mode: "picker" });
				return;
			case "open-command":
				uiStore.set({ overlay: { kind: "command" }, mode: "command" });
				return;
			case "enter-scroll":
				uiStore.set({ pane: "transcript", mode: "scroll" });
				return;
			case "exit-mode":
				uiStore.set({
					overlay: null,
					mode: stateRef.current.ask ? "ask" : "nav",
					pane: current.mode === "composer" ? "transcript" : current.pane,
				});
				return;
			case "scroll":
				scrollBy(action.by);
				return;
			case "load-earlier":
				watchedRef.current?.loadEarlier();
				note("loading earlier history…");
				return;
			case "focus-composer":
				if (!uiStore.activeSessionId) {
					note("open a session first", "error");
					return;
				}
				uiStore.set({ pane: "composer", mode: "composer" });
				return;
			case "submit":
				submitPrompt(action.busyMode);
				return;
			case "answer-option":
				answerOption(action.index);
				return;
			case "toggle-zoom":
				uiStore.set({ zoom: !current.zoom });
				return;
		}
	}

	/** Single entry point for every key, whichever component received it. */
	function dispatch(key: KeyEvent): boolean {
		const { mode, pane, prefixArmed } = uiStore.getState();
		const resolution = resolveKey(key, { mode, pane, prefixArmed }, prefix);
		if (resolution.prefixArmed !== prefixArmed) {
			uiStore.set({ prefixArmed: resolution.prefixArmed });
		}
		if (resolution.action) runAction(resolution.action);
		return resolution.consumed;
	}

	// Modes where a textarea holds focus route keys through its own onKeyDown (it
	// runs before the default insert, so `preventDefault` really suppresses
	// typing). Everywhere else the global handler owns the keyboard. Exactly one
	// of the two is live at a time — that's what stops double-handling.
	const textFocused =
		ui.mode === "composer" || ui.mode === "command" || ui.mode === "picker";
	useKeyboard((key) => {
		if (textFocused) return;
		dispatch(key);
	});

	function onTextKey(key: KeyEvent): void {
		if (dispatch(key)) key.preventDefault();
	}

	const sidebarWidth = clamp(Math.floor(width * 0.28), 22, 34);
	const showSidebar = !ui.zoom && width >= 60;
	const tabSessions = ui.tabs.map((id) => byId.get(id) ?? ({ id } as Session));
	const pickerSelected = ui.overlay?.kind === "picker" ? ui.overlay.selected : 0;
	const pickerQuery =
		ui.overlay?.kind === "picker" ? (overlayRef.current?.plainText ?? "") : "";

	return (
		<box flexDirection="column" width={width} height={height}>
			<box flexDirection="row" flexGrow={1}>
				{showSidebar ? (
					<Sidebar
						groups={sessions.groups}
						cursor={ui.cursor}
						openTabs={ui.tabs}
						activeSessionId={activeSessionId}
						focused={ui.pane === "sidebar"}
						width={sidebarWidth}
						spinnerFrame={spinnerFrame}
						loaded={sessions.loaded}
						error={sessions.needsAuth ? "run `os login`" : sessions.error}
					/>
				) : null}
				<Transcript
					session={session}
					state={state}
					focused={ui.pane === "transcript"}
					scrollMode={ui.mode === "scroll"}
					spinnerFrame={spinnerFrame}
					connection={snapshot.connection}
					scrollRef={scrollRef}
				/>
			</box>

			{session ? (
				<Composer
					focused={ui.mode === "composer"}
					busy={state.isRunning}
					queuedCount={state.queued.length}
					placeholder={
						state.ask
							? "answer with a number, or type a reply…"
							: `message ${sessionTitle(session).slice(0, 24)}…`
					}
					onKeyDown={onTextKey}
					inputRef={composerRef}
					notice={session.workspacePreparing ? "workspace still being created…" : undefined}
				/>
			) : null}

			<StatusBar
				host={host}
				user={user}
				tabs={tabSessions}
				activeIndex={ui.activeTab}
				waiting={waiting}
				running={running}
				prefixArmed={ui.prefixArmed}
				mode={ui.mode}
				message={ui.message?.text}
				messageKind={ui.message?.kind}
				spinnerFrame={spinnerFrame}
				width={width}
			/>

			{ui.mode === "help" ? <Help height={height} /> : null}

			{ui.overlay?.kind === "picker" ? (
				<PromptOverlay
					title="sessions"
					value={pickerQuery}
					hint="↑/↓ to move · enter opens · esc cancels"
					rows={pickerMatches(flat, pickerQuery).map((s, index) => ({
						label: sessionTitle(s),
						detail: [s.repo, sessionStatus(s)].filter(Boolean).join(" · "),
						selected: index === pickerSelected,
					}))}
					inputRef={overlayRef}
					onKeyDown={onTextKey}
				/>
			) : null}

			{ui.overlay?.kind === "command" ? (
				<PromptOverlay
					title="command"
					value=""
					hint="archive · rename <title> · new <prompt> · cancel · reconnect · close · quit"
					inputRef={overlayRef}
					onKeyDown={onTextKey}
				/>
			) : null}

			{ui.overlay?.kind === "rename" ? (
				<PromptOverlay
					title="rename session"
					value=""
					hint="empty clears the manual title · enter saves"
					inputRef={overlayRef}
					onKeyDown={onTextKey}
				/>
			) : null}

			{ui.overlay?.kind === "new" ? (
				<PromptOverlay
					title="new session"
					value=""
					hint="what should it work on? · enter starts it (ask mode)"
					inputRef={overlayRef}
					onKeyDown={onTextKey}
				/>
			) : null}
		</box>
	);
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.min(max, Math.max(min, value));
}

/** Substring match over title/repo/branch — enough for a 30-session list. */
export function pickerMatches(sessions: Session[], query: string): Session[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return sessions.slice(0, 10);
	return sessions
		.filter((s) =>
			[sessionTitle(s), s.repo, s.branch, s.id]
				.filter(Boolean)
				.some((field) => String(field).toLowerCase().includes(needle)),
		)
		.slice(0, 10);
}

export { theme };
