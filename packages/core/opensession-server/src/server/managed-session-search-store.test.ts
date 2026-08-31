import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { ManagedSessionSearchStore } from "./managed-session-search-store";
import type { SearchRecord } from "./session-search-store";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function record(overrides: Partial<SearchRecord> & { id: string }): SearchRecord {
	return { source: "session", question: "", summary: "", resolution: "", files: "",
		ts: NOW - DAY, activityTs: NOW - DAY, distilled: "mech", ...overrides };
}

async function store(): Promise<ManagedSessionSearchStore> {
	const value = new ManagedSessionSearchStore(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
	await value.initialize();
	return value;
}

describe("managed session search", () => {
	test("persists replacement records and matches punctuation safely", async () => {
		const value = await store();
		await value.upsert(record({ id: "session:a", question: "first version" }));
		await value.upsert(record({ id: "session:a", question: "second version",
			resolution: 'fixed "Failed to execute statement" by retrying' }));
		expect(value.count()).toBe(1);
		expect(value.search("Failed to execute statement", { now: NOW })[0]?.id).toBe("session:a");
	});

	test("falls back to any term and applies filters plus recency", async () => {
		const value = await store();
		await value.upsert(record({ id: "session:old", question: "worktree cleanup", repo: "opensession", ts: NOW - 300 * DAY }));
		await value.upsert(record({ id: "session:new", question: "worktree cleanup", repo: "opensession", ts: NOW - 2 * DAY }));
		expect(value.search("worktree zebra", { repo: "opensession", now: NOW }).map((hit) => hit.id))
			.toEqual(["session:new", "session:old"]);
		expect(value.search("cleanup", { sinceTs: NOW - 10 * DAY, now: NOW }).map((hit) => hit.id))
			.toEqual(["session:new"]);
	});
});
