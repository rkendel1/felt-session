import { describe, expect, test } from "bun:test";
import {
	type Key,
	type KeymapState,
	resolveKey,
} from "../src/ui/keymap";

const key = (name: string, mods: Partial<Key> = {}): Key => ({ name, ...mods });
const state = (over: Partial<KeymapState> = {}): KeymapState => ({
	mode: "nav",
	pane: "sidebar",
	prefixArmed: false,
	...over,
});

describe("the prefix", () => {
	test("ctrl+b arms, the next key runs a command", () => {
		const armed = resolveKey(key("b", { ctrl: true }), state());
		expect(armed.prefixArmed).toBe(true);
		expect(armed.action).toBeUndefined();
		expect(armed.consumed).toBe(true);

		const next = resolveKey(key("c"), state({ prefixArmed: true }));
		expect(next.action).toEqual({ type: "new-session" });
		expect(next.prefixArmed).toBe(false);
	});

	test("^b digit jumps to a tab", () => {
		expect(resolveKey(key("3"), state({ prefixArmed: true })).action).toEqual({
			type: "jump-tab",
			index: 3,
		});
	});

	test("an unknown prefix key is swallowed, not typed into the composer", () => {
		const result = resolveKey(key("q"), state({ prefixArmed: true, mode: "composer" }));
		expect(result.consumed).toBe(true);
		expect(result.action).toBeUndefined();
		expect(result.prefixArmed).toBe(false);
	});

	test("prefix commands work mid-typing — ^b d detaches from the composer", () => {
		expect(
			resolveKey(key("d"), state({ prefixArmed: true, mode: "composer" })).action,
		).toEqual({ type: "detach" });
	});
});

describe("global movement", () => {
	test("ctrl+arrows switch tabs and panes from any mode", () => {
		for (const mode of ["nav", "composer", "scroll"] as const) {
			expect(resolveKey(key("left", { ctrl: true }), state({ mode })).action).toEqual({
				type: "prev-tab",
			});
			expect(resolveKey(key("right", { ctrl: true }), state({ mode })).action).toEqual({
				type: "next-tab",
			});
			expect(resolveKey(key("down", { ctrl: true }), state({ mode })).action).toEqual({
				type: "focus-pane",
				direction: "next",
			});
		}
	});
});

describe("composer", () => {
	test("enter queues, ctrl+enter steers, shift+enter is a newline", () => {
		const composer = state({ mode: "composer", pane: "composer" });
		expect(resolveKey(key("return"), composer).action).toEqual({
			type: "submit",
			busyMode: "queue",
		});
		expect(resolveKey(key("return", { ctrl: true }), composer).action).toEqual({
			type: "submit",
			busyMode: "steer",
		});
		const newline = resolveKey(key("return", { shift: true }), composer);
		expect(newline.consumed).toBe(false);
		expect(newline.action).toBeUndefined();
	});

	test("printable keys are left for the input", () => {
		const result = resolveKey(key("x"), state({ mode: "composer" }));
		expect(result.consumed).toBe(false);
	});

	test("escape leaves the composer", () => {
		expect(resolveKey(key("escape"), state({ mode: "composer" })).action).toEqual({
			type: "exit-mode",
		});
	});
});

describe("nav", () => {
	test("arrows move the sidebar cursor, or scroll the transcript", () => {
		expect(resolveKey(key("down"), state({ pane: "sidebar" })).action).toEqual({
			type: "move-cursor",
			delta: 1,
		});
		expect(resolveKey(key("down"), state({ pane: "transcript" })).action).toEqual({
			type: "scroll",
			by: "line-down",
		});
	});

	test("enter opens from the sidebar and focuses the composer elsewhere", () => {
		expect(resolveKey(key("return"), state({ pane: "sidebar" })).action).toEqual({
			type: "open-selected",
		});
		expect(resolveKey(key("return"), state({ pane: "transcript" })).action).toEqual({
			type: "focus-composer",
		});
	});
});

describe("scroll mode", () => {
	test("tmux copy-mode keys, and q exits", () => {
		const scroll = state({ mode: "scroll", pane: "transcript" });
		expect(resolveKey(key("k"), scroll).action).toEqual({
			type: "scroll",
			by: "line-up",
		});
		expect(resolveKey(key("space"), scroll).action).toEqual({
			type: "scroll",
			by: "page-down",
		});
		expect(resolveKey(key("g"), scroll).action).toEqual({ type: "scroll", by: "top" });
		expect(resolveKey(key("g", { shift: true }), scroll).action).toEqual({
			type: "scroll",
			by: "bottom",
		});
		expect(resolveKey(key("b"), scroll).action).toEqual({ type: "load-earlier" });
		expect(resolveKey(key("q"), scroll).action).toEqual({ type: "exit-mode" });
	});
});

describe("ask mode", () => {
	test("number keys answer, i escapes to free text", () => {
		const ask = state({ mode: "ask" });
		expect(resolveKey(key("2"), ask).action).toEqual({
			type: "answer-option",
			index: 1,
		});
		expect(resolveKey(key("i"), ask).action).toEqual({ type: "focus-composer" });
	});
});

test("help is dismissed by any key", () => {
	expect(resolveKey(key("z"), state({ mode: "help" })).action).toEqual({
		type: "toggle-help",
	});
});
