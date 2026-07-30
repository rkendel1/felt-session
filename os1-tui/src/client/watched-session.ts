/**
 * A socket + its reduced state + subscribers — one per open tab.
 *
 * `subscribe`/`getState` is deliberately the `useSyncExternalStore` contract:
 * frames arrive on the socket's callback, not in React's world, and this is the
 * supported way to bridge that without tearing.
 */

import { applyFrame, initialSessionState, type SessionState } from "./session-store";
import type { SessionSocket } from "./socket";
import type { ServerFrame } from "./types";

export type Connection = "connecting" | "open" | "retrying";

/**
 * What the UI reads. State AND transport status live in one immutable object
 * because `useSyncExternalStore` re-renders on snapshot identity: a connection
 * change that didn't produce a new snapshot would never reach the screen.
 */
export type WatchedSnapshot = { state: SessionState; connection: Connection };

export class WatchedSession {
	private snapshot: WatchedSnapshot = {
		state: initialSessionState,
		connection: "connecting",
	};
	private listeners = new Set<() => void>();

	constructor(
		readonly sessionId: string,
		private readonly socket: SessionSocket,
	) {}

	/**
	 * Connect. The `watch` itself is sent from `handleOpen`, not here — one code
	 * path for first connect and every reconnect, so a session can't end up
	 * double-watched (which costs a redundant full transcript_init).
	 */
	start(): void {
		this.socket.connect();
	}

	/** Called by the socket owner on every frame. */
	handleFrame(frame: ServerFrame): void {
		const next = applyFrame(this.snapshot.state, frame);
		if (next !== this.snapshot.state) {
			this.snapshot = { ...this.snapshot, state: next };
			this.emit();
		}
	}

	handleOpen(): void {
		// Re-watch on every open, resuming from the byte cursor when we have one
		// so the server replays just the gap instead of the whole tail.
		const cursor = this.snapshot.state.cursor;
		this.socket.watch(
			this.sessionId,
			cursor ? { offset: cursor.endOffset, rev: cursor.rev } : undefined,
		);
		this.setConnection("open");
	}

	handleClose(_reason: string, willRetry: boolean): void {
		this.setConnection(willRetry ? "retrying" : "connecting");
	}

	private setConnection(next: Connection): void {
		if (this.snapshot.connection === next) return;
		this.snapshot = { ...this.snapshot, connection: next };
		this.emit();
	}

	getSnapshot = (): WatchedSnapshot => this.snapshot;

	getState = (): SessionState => this.snapshot.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	// ── Actions ──────────────────────────────────────────────────────────────

	send(content: string, user: string, busyMode: "queue" | "steer" = "queue"): void {
		this.socket.prompt(this.sessionId, content, user, { busyMode });
	}

	answer(answers: Record<string, string>): void {
		const ask = this.snapshot.state.ask;
		if (!ask) return;
		this.socket.answer(this.sessionId, ask.questionId, answers);
		// Optimistic: the card goes away now, ask_resolved confirms.
		this.snapshot = {
			...this.snapshot,
			state: { ...this.snapshot.state, ask: null },
		};
		this.emit();
	}

	cancel(): void {
		this.socket.cancel(this.sessionId);
	}

	steerQueued(queueId: string): void {
		this.socket.steerQueued(this.sessionId, queueId);
	}

	deleteQueued(queueId: string): void {
		this.socket.deleteQueued(this.sessionId, queueId);
	}

	/** "Load earlier": one page before the oldest entry we hold. */
	loadEarlier(): void {
		const { truncated, startOffset, cursor } = this.snapshot.state;
		if (!truncated || startOffset === undefined) return;
		this.socket.loadHistory(this.sessionId, startOffset, cursor?.rev);
	}

	close(): void {
		this.socket.close();
		this.listeners.clear();
	}
}
