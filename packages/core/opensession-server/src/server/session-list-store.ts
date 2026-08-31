/** Managed FeltDB projection for bounded session-list reads. */

import type { StateFirstDB } from "@feltdb/core";
import { ManagedSessionListStore } from "./managed-session-list-store";
import type { UnifiedSession } from "./types";

export type SessionListSlice = "include" | "exclude" | "only";

const g = globalThis as typeof globalThis & {
	__osSessionListStore?: ManagedSessionListStore;
};

export function sessionListStore(): ManagedSessionListStore {
	if (!g.__osSessionListStore)
		throw new Error("Managed session list has not been initialized");
	return g.__osSessionListStore;
}

export async function initializeManagedSessionList(db: StateFirstDB): Promise<void> {
	const store = new ManagedSessionListStore(db);
	await store.initialize();
	g.__osSessionListStore = store;
}

export function __setSessionListStoreForTest(
	store: ManagedSessionListStore | undefined,
): ManagedSessionListStore | undefined {
	const previous = g.__osSessionListStore;
	if (store) g.__osSessionListStore = store;
	else delete g.__osSessionListStore;
	return previous;
}

export function indexedSessions(slice: SessionListSlice = "include"): UnifiedSession[] | null {
	const store = sessionListStore();
	return store.hasCoverage(slice) ? store.list(slice) : null;
}

export function indexedSidebarSessions(selectedSessionId?: string): UnifiedSession[] | null {
	const store = sessionListStore();
	return store.hasCoverage("exclude") ? store.listSidebar(selectedSessionId) : null;
}

export function indexedWorkspaceSessions(
	workspaceId: string,
	worktreeDir?: string | null,
): UnifiedSession[] | null {
	const store = sessionListStore();
	return store.hasCoverage("only") ? store.listWorkspace(workspaceId, worktreeDir) : null;
}

export function indexedActiveWorkspaceIds(): string[] | null {
	const store = sessionListStore();
	return store.hasCoverage("exclude") ? store.activeWorkspaceIds() : null;
}

export async function upsertIndexedSession(session: UnifiedSession): Promise<void> {
	await sessionListStore().upsert(session);
}

export async function upsertIndexedSessions(sessions: UnifiedSession[], slice?: SessionListSlice): Promise<void> {
	const store = sessionListStore();
	if (sessions.length) await store.upsertMany(sessions);
	if (slice) await store.markCovered(slice);
}

export async function rebuildSessionListIndex(sessions: UnifiedSession[]): Promise<void> {
	await sessionListStore().replaceAll(sessions);
}

export async function removeIndexedSession(id: string): Promise<void> {
	await sessionListStore().remove(id);
}

export async function setIndexedSessionArchived(
	id: string,
	archived: boolean,
	reason?: string,
): Promise<void> {
	await sessionListStore().setArchived(id, archived, reason);
}
