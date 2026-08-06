/**
 * A fake server, at both seams: `fetch` for REST and a fake WebSocket for the
 * watch. Together they let the whole app render and be driven by keystrokes with
 * no Open Session running anywhere.
 */

import type { Session, ServerFrame, TranscriptEntry } from "../src/client/types";

export function fakeSession(over: Partial<Session> = {}): Session {
	return {
		id: "bks-1",
		title: "wire the socket",
		repo: "opensession",
		branch: "tui",
		workspaceId: "ws-1",
		mode: "code",
		model: "claude-opus-5",
		isRunning: false,
		lastActivity: new Date().toISOString(),
		...over,
	};
}

export function fakeEntry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
	return { id: "e1", type: "assistant", content: "hello from the server", ...over };
}

export type FakeServer = {
	sessions: Session[];
	workspaces: { id: string; name: string }[];
	/** Every request path this fake saw, for assertions. */
	calls: string[];
	fetch: typeof fetch;
};

export function fakeServer(init?: Partial<Pick<FakeServer, "sessions" | "workspaces">>): FakeServer {
	const server: FakeServer = {
		sessions: init?.sessions ?? [fakeSession()],
		workspaces: init?.workspaces ?? [{ id: "ws-1", name: "opensession" }],
		calls: [],
		fetch: (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			const path = url.replace(/^https?:\/\/[^/]+/, "");
			server.calls.push(path);
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			if (path === "/api/sessions") return json(server.sessions);
			if (path === "/api/workspaces") return json({ workspaces: server.workspaces });
			if (path === "/api/health") return json({ ok: true });
			if (path.startsWith("/api/auth/status")) return json({ authenticated: true, login: "tester" });
			return json({});
		}) as typeof fetch,
	};
	return server;
}

/**
 * A WebSocket stand-in with the three handlers the client sets. `deliver` pushes
 * a frame as if the server sent it; `sent` records what we sent.
 */
export class FakeWebSocket {
	static last: FakeWebSocket | undefined;

	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	sent: Record<string, unknown>[] = [];
	closed = false;

	constructor(
		readonly url: string,
		readonly options?: { headers?: Record<string, string> },
	) {
		FakeWebSocket.last = this;
	}

	/** Complete the handshake — separate so tests can assert pre-open queuing. */
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	send(raw: string): void {
		this.sent.push(JSON.parse(raw) as Record<string, unknown>);
	}

	close(): void {
		this.closed = true;
		this.readyState = 3;
		this.onclose?.();
	}

	deliver(frame: ServerFrame): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	/** Frames of a given type that we sent to the server. */
	sentOfType(type: string): Record<string, unknown>[] {
		return this.sent.filter((frame) => frame.type === type);
	}
}

export const fakeWsFactory = (url: string, options?: { headers: Record<string, string> }) =>
	new FakeWebSocket(url, options) as unknown as WebSocket;
