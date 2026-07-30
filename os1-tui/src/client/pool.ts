/**
 * One WatchedSession per open tab.
 *
 * The server watches a single session per connection, so tabs really are
 * connections. Keeping the pool here (rather than in a component) means tab
 * churn never depends on React's mount order, and a closed tab's socket is
 * closed exactly once.
 */

import { wsUrl } from "./config";
import { WsSessionSocket, type WsFactory } from "./socket";
import { WatchedSession } from "./watched-session";

export type PoolOptions = {
	host: string;
	token?: string;
	/** Injectable for tests — a fake WebSocket needs no server. */
	factory?: WsFactory;
};

export function openWatch(sessionId: string, opts: PoolOptions): WatchedSession {
	// The socket needs a reference to the session it feeds, and the session needs
	// the socket to send on: one of the two has to be late-bound.
	let watched: WatchedSession | undefined;
	const socket = new WsSessionSocket(
		wsUrl(opts.host),
		opts.token,
		{
			onFrame: (frame) => watched?.handleFrame(frame),
			onOpen: () => watched?.handleOpen(),
			onClose: (reason, willRetry) => watched?.handleClose(reason, willRetry),
		},
		opts.factory,
	);
	watched = new WatchedSession(sessionId, socket);
	watched.start();
	return watched;
}

export class WatchPool {
	private open = new Map<string, WatchedSession>();

	constructor(private readonly opts: PoolOptions) {}

	get(sessionId: string): WatchedSession | undefined {
		return this.open.get(sessionId);
	}

	/** Idempotent: watching an already-open session returns the live one. */
	ensure(sessionId: string): WatchedSession {
		const existing = this.open.get(sessionId);
		if (existing) return existing;
		const watched = openWatch(sessionId, this.opts);
		this.open.set(sessionId, watched);
		return watched;
	}

	release(sessionId: string): void {
		const watched = this.open.get(sessionId);
		if (!watched) return;
		this.open.delete(sessionId);
		watched.close();
	}

	closeAll(): void {
		for (const sessionId of [...this.open.keys()]) this.release(sessionId);
	}
}
