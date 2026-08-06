import { describe, expect, test } from "bun:test";
import { WsSessionSocket } from "../src/client/socket";
import { WatchedSession } from "../src/client/watched-session";
import { FakeWebSocket, fakeWsFactory } from "./fakes";
import type { ServerFrame } from "../src/client/types";

function wire() {
	let watched: WatchedSession | undefined;
	const socket = new WsSessionSocket(
		"ws://server/ws",
		"tok",
		{
			onFrame: (frame) => watched?.handleFrame(frame),
			onOpen: () => watched?.handleOpen(),
			onClose: (reason, retry) => watched?.handleClose(reason, retry),
		},
		fakeWsFactory,
	);
	watched = new WatchedSession("bks-1", socket);
	watched.start();
	const ws = FakeWebSocket.last!;
	return { watched, socket, ws };
}

describe("connection lifecycle", () => {
	test("the token rides on the upgrade request", () => {
		const { ws } = wire();
		expect(ws.options?.headers?.authorization).toBe("Bearer tok");
	});

	test("watch is sent once, on open — not twice", () => {
		const { ws } = wire();
		// Nothing before the handshake completes…
		expect(ws.sentOfType("watch")).toHaveLength(0);
		ws.open();
		expect(ws.sentOfType("watch")).toHaveLength(1);
		expect(ws.sentOfType("watch")[0]!.sessionId).toBe("bks-1");
	});

	test("a reconnect re-watches from the byte cursor", () => {
		const { watched, ws } = wire();
		ws.open();
		ws.deliver({
			type: "transcript_init",
			sessionId: "bks-1",
			entries: [],
			endOffset: 4096,
			rev: "rev-9",
		} as ServerFrame);

		// Simulate the transport coming back up (same socket object here; the real
		// one makes a new WebSocket, which routes to the same handleOpen).
		watched.handleOpen();
		const resume = ws.sentOfType("watch").at(-1)!;
		expect(resume.sinceOffset).toBe(4096);
		expect(resume.sinceRev).toBe("rev-9");
	});

	test("connection status reaches the snapshot", () => {
		const { watched, ws } = wire();
		expect(watched.getSnapshot().connection).toBe("connecting");
		ws.open();
		expect(watched.getSnapshot().connection).toBe("open");
		watched.handleClose("lost", true);
		expect(watched.getSnapshot().connection).toBe("retrying");
	});

	test("subscribers fire on frames and on connection changes", () => {
		const { watched, ws } = wire();
		let notifications = 0;
		watched.subscribe(() => notifications++);
		ws.open();
		expect(notifications).toBe(1); // connection → open
		ws.deliver({ type: "session_status", isRunning: true } as ServerFrame);
		expect(notifications).toBe(2);
		// A frame that changes nothing must not wake React.
		ws.deliver({ type: "session_status", isRunning: true } as ServerFrame);
		expect(notifications).toBe(2);
	});
});

describe("outbound frames", () => {
	test("prompt defaults to queueing behind a busy run", () => {
		const { watched, ws } = wire();
		ws.open();
		watched.send("do the thing", "alex");
		const prompt = ws.sentOfType("prompt")[0]!;
		expect(prompt).toMatchObject({
			sessionId: "bks-1",
			content: "do the thing",
			user: "alex",
			busyMode: "queue",
		});
	});

	test("steer is opt-in", () => {
		const { watched, ws } = wire();
		ws.open();
		watched.send("actually, stop", "alex", "steer");
		expect(ws.sentOfType("prompt")[0]!.busyMode).toBe("steer");
	});

	test("answering clears the card optimistically and sends the answers", () => {
		const { watched, ws } = wire();
		ws.open();
		ws.deliver({
			type: "ask_question",
			questionId: "ask-7",
			questions: [{ question: "Ship?", options: [{ label: "yes" }] }],
		} as ServerFrame);
		expect(watched.getState().ask).not.toBeNull();

		watched.answer({ Ship: "yes" });
		expect(watched.getState().ask).toBeNull();
		expect(ws.sentOfType("answer_question")[0]).toMatchObject({
			questionId: "ask-7",
			answers: { Ship: "yes" },
		});
	});

	test("load-earlier is a no-op unless there IS earlier history", () => {
		const { watched, ws } = wire();
		ws.open();
		watched.loadEarlier();
		expect(ws.sentOfType("load_history")).toHaveLength(0);

		ws.deliver({
			type: "transcript_init",
			entries: [],
			truncated: true,
			startOffset: 500,
			endOffset: 900,
			rev: "r1",
		} as ServerFrame);
		watched.loadEarlier();
		expect(ws.sentOfType("load_history")[0]).toMatchObject({
			beforeOffset: 500,
			beforeRev: "r1",
		});
	});

	test("frames sent before the handshake are queued, not dropped", () => {
		const { watched, ws } = wire();
		watched.send("early", "alex");
		expect(ws.sent).toHaveLength(0);
		ws.open();
		expect(ws.sentOfType("prompt")).toHaveLength(1);
	});
});
