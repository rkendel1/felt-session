import type { StateFirstDB } from "@feltdb/core";
import { shareWorkspacePrRefs } from "./session-pr-target";
import type { SessionListSlice } from "./session-list-store";
import type { UnifiedSession } from "./types";

const SESSIONS = "opensession_session_list";
const META = "opensession_session_list_meta";

function activityMs(session: UnifiedSession): number {
	const value = Date.parse(session.lastActivity || session.createdAt || "");
	return Number.isFinite(value) ? value : 0;
}

function sorted(sessions: UnifiedSession[]): UnifiedSession[] {
	const copy = sessions.map((session) => structuredClone(session));
	copy.sort((left, right) => activityMs(right) - activityMs(left) || left.id.localeCompare(right.id));
	shareWorkspacePrRefs(copy);
	return copy;
}

export class ManagedSessionListStore {
	private readonly sessions = new Map<string, UnifiedSession>();
	private readonly coverage = new Set<SessionListSlice>();

	constructor(private readonly db: StateFirstDB) {}

	async initialize(): Promise<void> {
		this.sessions.clear();
		for (const session of await this.db.collection<UnifiedSession>(SESSIONS).all()) this.sessions.set(session.id, session);
		this.coverage.clear();
		for (const record of await this.db.collection<{ id: SessionListSlice }>(META).all()) this.coverage.add(record.id);
	}

	async upsert(session: UnifiedSession): Promise<void> {
		await this.db.transaction((tx) => {
			tx.collection<UnifiedSession>(SESSIONS).set(session.id, session);
		}, { transactionId: `opensession:session-list:upsert:${crypto.randomUUID()}` });
		this.sessions.set(session.id, structuredClone(session));
	}

	async upsertMany(sessions: UnifiedSession[]): Promise<void> {
		for (let index = 0; index < sessions.length; index += 100) {
			const chunk = sessions.slice(index, index + 100);
			await this.db.transaction((tx) => {
				const collection = tx.collection<UnifiedSession>(SESSIONS);
				for (const session of chunk) collection.set(session.id, session);
			}, { transactionId: `opensession:session-list:upsert-many:${crypto.randomUUID()}` });
			for (const session of chunk) this.sessions.set(session.id, structuredClone(session));
		}
	}

	async replaceAll(sessions: UnifiedSession[]): Promise<void> {
		const incoming = new Set(sessions.map((session) => session.id));
		const removed = [...this.sessions.keys()].filter((id) => !incoming.has(id));
		for (let index = 0; index < removed.length; index += 100) {
			const chunk = removed.slice(index, index + 100);
			await this.db.transaction((tx) => {
				const collection = tx.collection<UnifiedSession>(SESSIONS);
				for (const id of chunk) collection.delete(id);
			}, { transactionId: `opensession:session-list:remove-many:${crypto.randomUUID()}` });
			for (const id of chunk) this.sessions.delete(id);
		}
		await this.upsertMany(sessions);
		await this.markCovered("include");
	}

	async markCovered(slice: SessionListSlice): Promise<void> {
		const slices: SessionListSlice[] = slice === "include" ? ["include", "exclude", "only"] : [slice];
		await this.db.transaction((tx) => {
			const collection = tx.collection<{ id: SessionListSlice; updatedAt: number }>(META);
			for (const covered of slices) collection.set(covered, { id: covered, updatedAt: Date.now() });
		}, { transactionId: `opensession:session-list:coverage:${crypto.randomUUID()}` });
		for (const covered of slices) this.coverage.add(covered);
	}

	hasCoverage(slice: SessionListSlice): boolean { return this.coverage.has(slice); }

	async remove(id: string): Promise<void> {
		await this.db.transaction((tx) => { tx.collection<UnifiedSession>(SESSIONS).delete(id); },
			{ transactionId: `opensession:session-list:remove:${crypto.randomUUID()}` });
		this.sessions.delete(id);
	}

	async setArchived(id: string, archived: boolean, reason?: string): Promise<void> {
		const current = this.sessions.get(id);
		if (!current) return;
		const next = structuredClone(current);
		if (archived) {
			next.archived = true;
			if (reason) next.archivedReason = reason as UnifiedSession["archivedReason"];
		} else {
			delete next.archived;
			delete next.archivedReason;
		}
		await this.upsert(next);
	}

	count(): number { return this.sessions.size; }

	list(slice: SessionListSlice = "include"): UnifiedSession[] {
		return sorted([...this.sessions.values()].filter((session) =>
			slice === "include" || (slice === "only" ? !!session.archived : !session.archived)));
	}

	listWorkspace(workspaceId: string, worktreeDir?: string | null): UnifiedSession[] {
		const isolated = worktreeDir?.includes("/worktrees/") ? worktreeDir : null;
		return sorted([...this.sessions.values()].filter((session) => !!session.archived &&
			(session.workspaceId === workspaceId || (!!isolated && session.worktreeDir === isolated))));
	}

	activeWorkspaceIds(): string[] {
		return [...new Set([...this.sessions.values()].filter((session) => !session.archived && session.workspaceId)
			.map((session) => session.workspaceId!))];
	}

	listSidebar(selectedSessionId?: string): UnifiedSession[] {
		const live = [...this.sessions.values()].filter((session) => !session.archived);
		const humans = live.filter((session) => !session.automation);
		const automations = new Map<string, UnifiedSession[]>();
		for (const session of live.filter((item) => !!item.automation)) {
			const group = automations.get(session.automation!) ?? [];
			group.push(session);
			automations.set(session.automation!, group);
		}
		const selected = [...humans];
		for (const group of automations.values()) {
			const ordered = sorted(group);
			const count = ordered.length;
			for (const [index, session] of ordered.entries()) {
				const signals = session as UnifiedSession & { waitingForInput?: boolean; automationRunCount?: number };
				if (index < 5 || session.isRunning || signals.waitingForInput || session.manualStatus || session.id === selectedSessionId) {
					signals.automationRunCount = count;
					selected.push(signals);
				}
			}
		}
		return sorted(selected);
	}

	close(): void {}
}
