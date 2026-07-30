import { describe, expect, test } from "bun:test";
import {
	applyFrame,
	applyFrames,
	initialSessionState,
} from "../src/client/session-store";
import type { ServerFrame, TranscriptEntry } from "../src/client/types";

const entry = (id: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
	id,
	type: "assistant",
	content: `body ${id}`,
	...over,
});

describe("transcript reduction", () => {
	test("init replaces, append merges, ids never duplicate", () => {
		let state = applyFrame(initialSessionState, {
			type: "transcript_init",
			entries: [entry("a"), entry("b")],
			startOffset: 10,
			endOffset: 400,
			rev: "r1",
			truncated: true,
		} as ServerFrame);

		expect(state.loaded).toBe(true);
		expect(state.entries.map((e) => e.id)).toEqual(["a", "b"]);
		expect(state.cursor).toEqual({ endOffset: 400, rev: "r1" });
		expect(state.truncated).toBe(true);
		expect(state.startOffset).toBe(10);

		// The reconnect gap-fill re-sends `b` alongside the new `c`.
		state = applyFrame(state, {
			type: "transcript_append",
			entries: [entry("b"), entry("c")],
			endOffset: 620,
			rev: "r1",
		} as ServerFrame);

		expect(state.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
		expect(state.cursor).toEqual({ endOffset: 620, rev: "r1" });
	});

	test("a clamped re-send never truncates content we already hold", () => {
		let state = applyFrame(initialSessionState, {
			type: "transcript_init",
			entries: [entry("a", { content: "the whole long body" })],
		} as ServerFrame);

		state = applyFrame(state, {
			type: "transcript_append",
			entries: [entry("a", { content: "the whole", contentClamped: true })],
		} as ServerFrame);

		expect(state.entries[0]!.content).toBe("the whole long body");
	});

	test("history prepends and moves the paging cursor back", () => {
		let state = applyFrame(initialSessionState, {
			type: "transcript_init",
			entries: [entry("c")],
			startOffset: 900,
			truncated: true,
		} as ServerFrame);

		state = applyFrame(state, {
			type: "transcript_history",
			entries: [entry("a"), entry("b")],
			startOffset: 100,
			truncated: true,
		} as ServerFrame);

		expect(state.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
		expect(state.startOffset).toBe(100);
	});

	test("an init after an engine-id rotation drops the old entries", () => {
		let state = applyFrame(initialSessionState, {
			type: "transcript_init",
			entries: [entry("old-1"), entry("old-2")],
			rev: "r1",
			endOffset: 100,
		} as ServerFrame);

		state = applyFrame(state, {
			type: "transcript_init",
			entries: [entry("new-1")],
			rev: "r2",
			endOffset: 20,
		} as ServerFrame);

		expect(state.entries.map((e) => e.id)).toEqual(["new-1"]);
		expect(state.cursor).toEqual({ endOffset: 20, rev: "r2" });
	});
});

describe("streaming", () => {
	test("text accumulates, then the committed entry takes over", () => {
		let state = applyFrames(initialSessionState, [
			{ type: "transcript_init", entries: [] } as ServerFrame,
			{ type: "stream_start" } as ServerFrame,
			{ type: "stream_text", text: "Wiring " } as ServerFrame,
			{ type: "stream_text", text: "the socket" } as ServerFrame,
		]);

		expect(state.streaming).toBe(true);
		expect(state.streamText).toBe("Wiring the socket");
		expect(state.isRunning).toBe(true);

		// stream_done alone must NOT blank the text — the entry hasn't landed yet,
		// and clearing here flashes an empty answer.
		state = applyFrame(state, { type: "stream_done" } as ServerFrame);
		expect(state.streamText).toBe("Wiring the socket");
		expect(state.streaming).toBe(false);

		state = applyFrame(state, {
			type: "transcript_append",
			entries: [entry("x", { content: "Wiring the socket" })],
		} as ServerFrame);
		expect(state.streamText).toBe("");
		expect(state.entries).toHaveLength(1);
	});

	test("streamed tool entries upsert into the transcript", () => {
		const state = applyFrames(initialSessionState, [
			{
				type: "stream_tool_use",
				entry: entry("t1", { type: "tool_use", toolName: "read" }),
			} as ServerFrame,
			{
				type: "stream_tool_result",
				entry: entry("t1", { type: "tool_result", content: "done" }),
			} as ServerFrame,
		]);

		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]!.type).toBe("tool_result");
	});

	test("session_status false stops the spinner and the stream", () => {
		let state = applyFrames(initialSessionState, [
			{ type: "stream_start" } as ServerFrame,
			{ type: "stream_text", text: "half a sentence" } as ServerFrame,
		]);
		state = applyFrame(state, {
			type: "session_status",
			isRunning: false,
		} as ServerFrame);
		expect(state.isRunning).toBe(false);
		expect(state.streaming).toBe(false);
	});
});

describe("queue and questions", () => {
	test("queue_update replaces both lists", () => {
		const state = applyFrame(initialSessionState, {
			type: "queue_update",
			queued: [{ id: "q1", content: "next thing" }],
			steered: [{ id: "s1", content: "actually" }],
		} as ServerFrame);
		expect(state.queued).toHaveLength(1);
		expect(state.steered[0]!.content).toBe("actually");
	});

	test("ask_question shows a card, ask_resolved clears the matching one", () => {
		let state = applyFrame(initialSessionState, {
			type: "ask_question",
			questionId: "ask-1",
			questions: [{ question: "Ship it?", options: [{ label: "yes" }] }],
		} as ServerFrame);
		expect(state.ask?.questionId).toBe("ask-1");

		// A resolution for a different question must not clear this card.
		state = applyFrame(state, {
			type: "ask_resolved",
			questionId: "ask-0",
		} as ServerFrame);
		expect(state.ask?.questionId).toBe("ask-1");

		state = applyFrame(state, {
			type: "ask_resolved",
			questionId: "ask-1",
		} as ServerFrame);
		expect(state.ask).toBeNull();
	});
});

test("unknown frames are ignored by identity", () => {
	const state = applyFrame(initialSessionState, { type: "presence" } as ServerFrame);
	expect(state).toBe(initialSessionState);
});
