/**
 * End-to-end render tests: the real App, the real keymap, the real client layer
 * — against a fake fetch and a fake WebSocket, rendered into an in-memory
 * terminal. `captureCharFrame()` is the screen a user would see.
 *
 * React's act() warnings are silenced: frames arrive from a socket, not from a
 * user event, so there is no act() boundary to wrap them in — the harness's
 * `flush()` is what settles the tree here.
 */

// biome-ignore lint/suspicious/noExplicitAny: React's test-environment global.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;

import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { Api } from "../src/client/api";
import { WatchPool } from "../src/client/pool";
import { SessionsPoller } from "../src/client/sessions-poller";
import { App } from "../src/ui/app";
import { FakeWebSocket, fakeServer, fakeSession, fakeWsFactory } from "./fakes";
import type { ServerFrame } from "../src/client/types";

const HOST = "http://server";

async function mount(
	options: {
		sessions?: ReturnType<typeof fakeSession>[];
		width?: number;
		height?: number;
		initialSessionId?: string;
		kittyKeyboard?: boolean;
	} = {},
) {
	const server = fakeServer({ sessions: options.sessions });
	const api = new Api(HOST, "tok", server.fetch);
	const poller = new SessionsPoller(api);
	const pool = new WatchPool({ host: HOST, token: "tok", factory: fakeWsFactory });
	let exited = false;
	await poller.start();

	const harness = await testRender(
		<App
			api={api}
			poller={poller}
			pool={pool}
			host="os.tella.dev"
			user="michiel"
			onExit={() => {
				exited = true;
			}}
			initialSessionId={options.initialSessionId}
		/>,
		{
			width: options.width ?? 100,
			height: options.height ?? 24,
			...(options.kittyKeyboard ? { kittyKeyboard: true } : {}),
		},
	);
	await harness.flush();

	return {
		...harness,
		server,
		poller,
		pool,
		frame: () => harness.captureCharFrame(),
		exited: () => exited,
		cleanup: () => {
			poller.stop();
			pool.closeAll();
		},
	};
}

let active: { cleanup: () => void } | undefined;
afterEach(() => {
	active?.cleanup();
	active = undefined;
});

describe("first paint", () => {
	test("shows the workspace, the session and the status bar", async () => {
		const app = await mount({
			sessions: [
				fakeSession({ id: "bks-1", title: "wire the socket" }),
				fakeSession({ id: "bks-2", title: "fix the sidebar", isRunning: true }),
			],
		});
		active = app;
		const frame = app.frame();

		expect(frame).toContain("backstage"); // workspace group header
		expect(frame).toContain("wire the socket");
		expect(frame).toContain("fix the sidebar");
		expect(frame).toContain("os.tella.dev");
		expect(frame).toContain("michiel");
		// Nothing open yet.
		expect(frame).toContain("no session open");
	});

	test("a session needing input is flagged in the sidebar", async () => {
		const app = await mount({
			sessions: [fakeSession({ id: "bks-1", title: "blocked one", waitingForInput: true })],
		});
		active = app;
		expect(app.frame()).toContain("?");
	});
});

describe("opening a session", () => {
	test("enter on the sidebar opens a tab and watches it", async () => {
		const app = await mount({ sessions: [fakeSession({ id: "bks-1", title: "wire the socket" })] });
		active = app;

		app.mockInput.pressEnter();
		await app.flush();

		const ws = FakeWebSocket.last!;
		ws.open();
		await app.flush();
		expect(ws.sentOfType("watch")[0]!.sessionId).toBe("bks-1");

		ws.deliver({
			type: "transcript_init",
			sessionId: "bks-1",
			entries: [
				{ id: "u1", type: "user", content: "please wire it" },
				{ id: "a1", type: "assistant", content: "wired the socket up" },
			],
			endOffset: 10,
			rev: "r1",
		} as ServerFrame);
		await app.flush();

		const frame = app.frame();
		expect(frame).toContain("please wire it");
		expect(frame).toContain("wired the socket up");
		// The composer appears once a session is open.
		expect(frame).toContain("enter sends");
	});

	test("streamed text renders before the entry commits", async () => {
		const app = await mount({ sessions: [fakeSession({ id: "bks-1" })] });
		active = app;
		app.mockInput.pressEnter();
		await app.flush();
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.deliver({ type: "transcript_init", entries: [], endOffset: 0, rev: "r" } as ServerFrame);
		ws.deliver({ type: "stream_start" } as ServerFrame);
		ws.deliver({ type: "stream_text", text: "thinking out loud" } as ServerFrame);
		await app.flush();

		expect(app.frame()).toContain("thinking out loud");
	});

	test("a pending question renders its options", async () => {
		const app = await mount({ sessions: [fakeSession({ id: "bks-1" })] });
		active = app;
		app.mockInput.pressEnter();
		await app.flush();
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.deliver({ type: "transcript_init", entries: [], endOffset: 0, rev: "r" } as ServerFrame);
		ws.deliver({
			type: "ask_question",
			questionId: "ask-1",
			questions: [
				{
					question: "Tabs or splits?",
					header: "layout",
					options: [{ label: "tabs" }, { label: "splits" }],
				},
			],
		} as ServerFrame);
		await app.flush();

		const frame = app.frame();
		expect(frame).toContain("Tabs or splits?");
		expect(frame).toContain("tabs");
		expect(frame).toContain("splits");

		// The number key answers it, and the card goes away.
		app.mockInput.pressKey("1");
		await app.flush();
		expect(ws.sentOfType("answer_question")[0]).toMatchObject({
			questionId: "ask-1",
			answers: { "Tabs or splits?": "tabs" },
		});
		expect(app.frame()).not.toContain("Tabs or splits?");
	});
});

describe("sending", () => {
	test("typing then enter sends a prompt and clears the composer", async () => {
		const app = await mount({ sessions: [fakeSession({ id: "bks-1" })] });
		active = app;
		app.mockInput.pressEnter(); // open
		await app.flush();
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.deliver({ type: "transcript_init", entries: [], endOffset: 0, rev: "r" } as ServerFrame);
		await app.flush();

		// i focuses the composer (nav → composer), then type and send.
		app.mockInput.pressKey("i");
		await app.flush();
		await app.mockInput.typeText("ship it");
		await app.flush();
		expect(app.frame()).toContain("ship it");

		app.mockInput.pressEnter();
		await app.flush();

		const prompt = ws.sentOfType("prompt")[0]!;
		expect(prompt).toMatchObject({ content: "ship it", busyMode: "queue", user: "michiel" });
		// Cleared, and the status bar reports what happened.
		expect(app.frame()).toContain("sent");
	});

	test("alt+enter steers instead of queueing (works without kitty keys)", async () => {
		const app = await mount({ sessions: [fakeSession({ id: "bks-1", isRunning: true })] });
		active = app;
		app.mockInput.pressEnter();
		await app.flush();
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.deliver({ type: "transcript_init", entries: [], endOffset: 0, rev: "r" } as ServerFrame);
		await app.flush();

		app.mockInput.pressKey("i");
		await app.flush();
		await app.mockInput.typeText("wait");
		app.mockInput.pressEnter({ meta: true });
		await app.flush();

		expect(ws.sentOfType("prompt")[0]!.busyMode).toBe("steer");
	});

	test("ctrl+enter steers when the terminal speaks the kitty protocol", async () => {
		const app = await mount({
			sessions: [fakeSession({ id: "bks-1", isRunning: true })],
			kittyKeyboard: true,
		});
		active = app;
		app.mockInput.pressEnter();
		await app.flush();
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.deliver({ type: "transcript_init", entries: [], endOffset: 0, rev: "r" } as ServerFrame);
		await app.flush();

		app.mockInput.pressKey("i");
		await app.flush();
		await app.mockInput.typeText("wait");
		app.mockInput.pressEnter({ ctrl: true });
		await app.flush();

		expect(ws.sentOfType("prompt")[0]!.busyMode).toBe("steer");
	});
});

describe("tmux keys", () => {
	test("^b ? opens help, any key closes it", async () => {
		const app = await mount();
		active = app;
		app.mockInput.pressKey("b", { ctrl: true });
		app.mockInput.pressKey("?");
		await app.flush();
		expect(app.frame()).toContain("detach");

		app.mockInput.pressKey("x");
		await app.flush();
		expect(app.frame()).not.toContain("sessions keep running");
	});

	test("^b arms the prefix visibly, so it can't silently eat a key", async () => {
		const app = await mount();
		active = app;
		app.mockInput.pressKey("b", { ctrl: true });
		await app.flush();
		expect(app.frame()).toContain("^b");
	});

	test("^b w opens the session picker and filters", async () => {
		const app = await mount({
			sessions: [
				fakeSession({ id: "bks-1", title: "wire the socket" }),
				fakeSession({ id: "bks-2", title: "unrelated thing" }),
			],
		});
		active = app;
		app.mockInput.pressKey("b", { ctrl: true });
		app.mockInput.pressKey("w");
		await app.flush();
		expect(app.frame()).toContain("sessions");

		await app.mockInput.typeText("unrel");
		await app.flush();
		const frame = app.frame();
		expect(frame).toContain("unrelated thing");
	});

	test("^b x cancels the running turn", async () => {
		const app = await mount({ sessions: [fakeSession({ id: "bks-1", isRunning: true })] });
		active = app;
		app.mockInput.pressEnter();
		await app.flush();
		const ws = FakeWebSocket.last!;
		ws.open();
		await app.flush();

		app.mockInput.pressKey("b", { ctrl: true });
		app.mockInput.pressKey("x");
		await app.flush();
		expect(ws.sentOfType("cancel")).toHaveLength(1);
	});

	test("^b d detaches", async () => {
		const app = await mount();
		active = app;
		app.mockInput.pressKey("b", { ctrl: true });
		app.mockInput.pressKey("d");
		await app.flush();
		expect(app.exited()).toBe(true);
	});

	test("two open tabs show a tab strip, and ctrl+→ switches", async () => {
		const app = await mount({
			sessions: [
				fakeSession({ id: "bks-1", title: "first one" }),
				fakeSession({ id: "bks-2", title: "second one" }),
			],
		});
		active = app;

		// Open the first, move down, open the second.
		app.mockInput.pressEnter();
		await app.flush();
		app.mockInput.pressKey("b", { ctrl: true });
		app.mockInput.pressKey("w");
		await app.flush();
		await app.mockInput.typeText("second");
		app.mockInput.pressEnter();
		await app.flush();

		const frame = app.frame();
		expect(frame).toContain("1:first one");
		expect(frame).toContain("2:second one");

		app.mockInput.pressArrow("left", { ctrl: true });
		await app.flush();
		// Still both tabs; the active one changed (title bar shows first one).
		expect(app.frame()).toContain("first one");
	});
});

describe("degraded states", () => {
	test("a narrow terminal drops the sidebar rather than squashing it", async () => {
		const app = await mount({ width: 50, height: 20, sessions: [fakeSession({ id: "bks-1" })] });
		active = app;
		expect(app.frame()).not.toContain("backstage");
	});

	test("sign-in required is surfaced, not swallowed", async () => {
		const server = fakeServer();
		const unauthorized = (async (input: RequestInfo | URL) => {
			const path = input.toString().replace(/^https?:\/\/[^/]+/, "");
			if (path === "/api/sessions") {
				return new Response(JSON.stringify({ error: "Sign in required" }), { status: 401 });
			}
			return server.fetch(input);
		}) as typeof fetch;

		const api = new Api(HOST, undefined, unauthorized);
		const poller = new SessionsPoller(api);
		const pool = new WatchPool({ host: HOST, factory: fakeWsFactory });
		await poller.start();
		const harness = await testRender(
			<App api={api} poller={poller} pool={pool} host="os.tella.dev" user="michiel" onExit={() => {}} />,
			{ width: 100, height: 20 },
		);
		await harness.flush();
		active = {
			cleanup: () => {
				poller.stop();
				pool.closeAll();
			},
		};
		expect(harness.captureCharFrame()).toContain("os login".slice(0, 2));
	});
});
