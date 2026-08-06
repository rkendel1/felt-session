import { beforeEach, describe, expect, test } from "bun:test";
import { readHiddenSidebarTools, SIDEBAR_TOOL_IDS } from "./sidebar-tools";

const store = new Map<string, string>();
// Enough of the Storage surface for the read path.
(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => {
		store.set(key, value);
	},
};

beforeEach(() => store.clear());

describe("readHiddenSidebarTools", () => {
	// A tool added to SIDEBAR_TOOL_IDS must not switch itself on for everyone
	// who has never touched the setting — new accounts start with Home only.
	test("a new account sees Home and nothing else", () => {
		const hidden = readHiddenSidebarTools();
		expect([...SIDEBAR_TOOL_IDS].filter((id) => !hidden.has(id))).toEqual([
			"home",
		]);
	});

	test("an explicit empty list means the user showed everything", () => {
		store.set("opensession-sidebar-hidden-tools", "[]");
		expect(readHiddenSidebarTools().size).toBe(0);
	});

	test("stored ids that are no longer tools are dropped", () => {
		store.set(
			"opensession-sidebar-hidden-tools",
			JSON.stringify(["notes", "retired-tool"]),
		);
		expect([...readHiddenSidebarTools()]).toEqual(["notes"]);
	});

	test("unreadable storage falls back to the new-account default", () => {
		store.set("opensession-sidebar-hidden-tools", "{not json");
		expect(readHiddenSidebarTools().has("desk")).toBe(true);
	});
});
