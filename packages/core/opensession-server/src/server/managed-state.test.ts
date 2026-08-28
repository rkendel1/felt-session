import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { ManagedOpenSessionState } from "./managed-state";
import type { UnifiedSession } from "./types";
import type { Workspace } from "./workspaces";

function state() {
	return new ManagedOpenSessionState(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
}

describe("managed Open Session state", () => {
	test("persists and reloads sessions by canonical id", async () => {
		const store = state();
		const session = {
			id: "os-session-one",
			source: "opensession",
			title: "Managed session",
			createdAt: "2026-08-28T12:00:00.000Z",
			lastActivity: "2026-08-28T12:00:00.000Z",
		} as UnifiedSession;
		expect(await store.putSession(session)).toBe("migrated");
		expect(await store.putSession(session)).toBe("already_present");
		expect(await store.listSessions()).toEqual([session]);
	});

	test("updates the logical payload without creating a duplicate", async () => {
		const store = state();
		const workspace = {
			id: "ws-one",
			name: "Before",
			createdBy: "Randy",
			createdAt: "2026-08-28T12:00:00.000Z",
		} as Workspace;
		expect(await store.putWorkspace(workspace)).toBe("migrated");
		expect(await store.putWorkspace({ ...workspace, name: "After" })).toBe("updated");
		expect(await store.listWorkspaces()).toEqual([{ ...workspace, name: "After" }]);
	});
});
