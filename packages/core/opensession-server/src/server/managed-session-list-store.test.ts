import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { ManagedSessionListStore } from "./managed-session-list-store";
import type { UnifiedSession } from "./types";

function session(id: string, minute: number, patch: Partial<UnifiedSession> = {}): UnifiedSession {
	const at = `2026-08-22T11:${String(minute).padStart(2, "0")}:00.000Z`;
	return { id, source: "opensession", branch: null, worktreeDir: null, createdBy: "Kent",
		startedBy: "Kent", title: id, lastActivity: at, createdAt: at, isRunning: false,
		transcriptPath: null, ...patch } as UnifiedSession;
}

async function store(): Promise<ManagedSessionListStore> {
	const value = new ManagedSessionListStore(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
	await value.initialize();
	return value;
}

describe("managed session list", () => {
	test("persists coverage, archive state, and workspace selection", async () => {
		const value = await store();
		await value.upsertMany([
			session("live", 12, { workspaceId: "one" }),
			session("archived", 11, { workspaceId: "one", archived: true }),
		]);
		await value.markCovered("include");
		expect(value.hasCoverage("exclude")).toBe(true);
		expect(value.activeWorkspaceIds()).toEqual(["one"]);
		await value.setArchived("live", true, "manual");
		expect(value.listWorkspace("one").map((item) => item.id)).toEqual(["live", "archived"]);
	});

	test("keeps the useful automation tail and run count", async () => {
		const value = await store();
		const rows = Array.from({ length: 10 }, (_, index) => session(`auto-${index}`, index, {
			automation: "triage", ...(index === 0 ? { isRunning: true } : {}),
			...(index === 1 ? { waitingForInput: true } : {}),
		}));
		await value.upsertMany(rows);
		const listed = value.listSidebar("auto-2");
		expect(listed.find((item) => item.automation)?.automationRunCount).toBe(10);
		expect(new Set(listed.map((item) => item.id))).toContain("auto-0");
		expect(new Set(listed.map((item) => item.id))).toContain("auto-1");
		expect(new Set(listed.map((item) => item.id))).toContain("auto-2");
	});
});
