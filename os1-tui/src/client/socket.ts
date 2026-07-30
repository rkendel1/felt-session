/**
 * One WebSocket to the server's `/ws`, watching one session.
 *
 * The server watches a single session per connection (`watch` stops any
 * previous watch on that socket), so a tab == a connection. `SocketPool` below
 * owns that mapping.
 *
 * Two behaviours copied deliberately from os1-ios, both of which cost that
 * client a bug before they existed:
 *
 * - **The server never pings.** We send `{"type":"ping"}` and treat a missing
 *   pong as a dead socket. Without it a half-open connection looks alive
 *   forever and the session silently stops updating.
 * - **Resume with the byte cursor.** transcript_init/append carry
 *   `endOffset` + `rev`; re-watching with `sinceOffset`/`sinceRev` replays only
 *   the gap instead of re-sending the whole tail.
 */

import type { ServerFrame } from "./types";

export type SocketEvents = {
	onFrame: (frame: ServerFrame) => void;
	/** Transport came up. Fired on every (re)connect, so callers re-arm state. */
	onOpen?: () => void;
	/** Transport went away; `willRetry` false means we've given up. */
	onClose?: (reason: string, willRetry: boolean) => void;
};

/**
 * The surface the UI drives. Tests substitute a recording fake, so no test
 * needs a real server (the same split os1-ios uses for `SessionSocket`).
 */
export interface SessionSocket {
	connect(): void;
	close(): void;
	watch(sessionId: string, resume?: { offset: number; rev: string }): void;
	prompt(
		sessionId: string,
		content: string,
		user: string,
		opts?: { busyMode?: "queue" | "steer"; effort?: string; fastMode?: boolean },
	): void;
	answer(sessionId: string, questionId: string, answers: Record<string, string>): void;
	cancel(sessionId: string): void;
	steerQueued(sessionId: string, queueId: string): void;
	deleteQueued(sessionId: string, queueId: string): void;
	loadHistory(sessionId: string, beforeOffset: number, beforeRev?: string): void;
}

export type WsFactory = (url: string, protocols?: { headers: Record<string, string> }) => WebSocket;

const PING_MS = 15_000;
const PONG_DEADLINE_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;

export class WsSessionSocket implements SessionSocket {
	private ws: WebSocket | null = null;
	private pinger: ReturnType<typeof setInterval> | null = null;
	private lastPong = Date.now();
	private attempt = 0;
	private closedByUs = false;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Frames sent before the socket opened, replayed on open (the `watch`). */
	private pending: string[] = [];

	constructor(
		private readonly url: string,
		private readonly token: string | undefined,
		private readonly events: SocketEvents,
		private readonly factory: WsFactory = (url, opts) =>
			new WebSocket(url, opts as never),
	) {}

	connect(): void {
		this.closedByUs = false;
		this.open();
	}

	private open(): void {
		const ws = this.factory(
			this.url,
			this.token ? { headers: { authorization: `Bearer ${this.token}` } } : undefined,
		);
		this.ws = ws;
		this.lastPong = Date.now();

		ws.onopen = () => {
			this.attempt = 0;
			for (const frame of this.pending.splice(0)) ws.send(frame);
			this.startPinging();
			this.events.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			const raw = typeof event.data === "string" ? event.data : "";
			if (!raw) return;
			let frame: ServerFrame;
			try {
				frame = JSON.parse(raw) as ServerFrame;
			} catch {
				return;
			}
			if (frame.type === "pong") {
				this.lastPong = Date.now();
				return;
			}
			// Any traffic proves liveness, not just pongs — a busy session may
			// outpace the ping interval with real frames.
			this.lastPong = Date.now();
			this.events.onFrame(frame);
		};
		ws.onerror = () => {
			// onclose always follows; nothing to do but let it.
		};
		ws.onclose = () => {
			this.stopPinging();
			this.ws = null;
			if (this.closedByUs) {
				this.events.onClose?.("closed", false);
				return;
			}
			this.scheduleRetry("connection lost");
		};
	}

	private scheduleRetry(reason: string): void {
		const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempt++, 6));
		this.events.onClose?.(reason, true);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (!this.closedByUs) this.open();
		}, delay);
	}

	private startPinging(): void {
		this.stopPinging();
		this.pinger = setInterval(() => {
			if (Date.now() - this.lastPong > PONG_DEADLINE_MS) {
				// Half-open: the OS thinks the socket is fine, the server is gone.
				// Force the close so the retry path runs.
				try {
					this.ws?.close();
				} catch {}
				return;
			}
			this.send({ type: "ping" });
		}, PING_MS);
	}

	private stopPinging(): void {
		if (this.pinger) clearInterval(this.pinger);
		this.pinger = null;
	}

	close(): void {
		this.closedByUs = true;
		this.stopPinging();
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		try {
			this.ws?.close();
		} catch {}
		this.ws = null;
	}

	private send(msg: object): void {
		const raw = JSON.stringify(msg);
		if (this.ws && this.ws.readyState === 1) {
			try {
				this.ws.send(raw);
				return;
			} catch {}
		}
		// Queue rather than drop: the first `watch` is normally sent before the
		// handshake finishes.
		this.pending.push(raw);
		if (this.pending.length > 32) this.pending.shift();
	}

	watch(sessionId: string, resume?: { offset: number; rev: string }): void {
		this.send({
			type: "watch",
			sessionId,
			...(resume ? { sinceOffset: resume.offset, sinceRev: resume.rev } : {}),
		});
	}

	prompt(
		sessionId: string,
		content: string,
		user: string,
		opts?: { busyMode?: "queue" | "steer"; effort?: string; fastMode?: boolean },
	): void {
		this.send({
			type: "prompt",
			sessionId,
			content,
			user,
			// Match the web composer's default: a send during a run is held as an
			// editable queued message; steering is an explicit gesture.
			busyMode: opts?.busyMode === "steer" ? "steer" : "queue",
			...(opts?.effort ? { effort: opts.effort } : {}),
			...(opts?.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
		});
	}

	answer(sessionId: string, questionId: string, answers: Record<string, string>): void {
		this.send({ type: "answer_question", sessionId, questionId, answers });
	}

	cancel(sessionId: string): void {
		this.send({ type: "cancel", sessionId });
	}

	steerQueued(sessionId: string, queueId: string): void {
		this.send({ type: "steer_queued_prompt", sessionId, queueId });
	}

	deleteQueued(sessionId: string, queueId: string): void {
		this.send({ type: "delete_queued_prompt", sessionId, queueId });
	}

	loadHistory(sessionId: string, beforeOffset: number, beforeRev?: string): void {
		this.send({
			type: "load_history",
			sessionId,
			beforeOffset,
			...(beforeRev ? { beforeRev } : {}),
		});
	}
}
