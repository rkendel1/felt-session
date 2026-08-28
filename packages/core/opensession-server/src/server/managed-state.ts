import type { Collection, StateFirstDB } from "@feltdb/core";
import type { SearchRecord } from "./session-search-store";
import type { UnifiedSession } from "./types";
import type { Workspace } from "./workspaces";

export const MANAGED_COLLECTIONS = {
	sessions: "opensession_sessions",
	workspaces: "opensession_workspaces",
	worktrees: "opensession_worktrees",
	search: "opensession_session_search",
	migrations: "opensession_migrations",
} as const;

export type ManagedRecord<T> = {
	id: string;
	payload: T;
	updatedAt: number;
	__version?: number;
};

export type ManagedWorktree = {
	id: string;
	workspaceId: string;
	repositoryId: string;
	path: string;
	branch?: string;
	baseCommit?: string;
	state: "active" | "archived" | "removed";
	updatedAt: number;
};

export type ManagedMigrationReceipt = {
	id: string;
	version: number;
	startedAt: number;
	completedAt?: number;
	verification?: "passed" | "failed";
	report: {
		discovered: number;
		migrated: number;
		alreadyPresent: number;
		skipped: number;
		failed: number;
	};
	updatedAt: number;
};

async function putPayload<T>(
	db: StateFirstDB,
	collectionName: string,
	collection: Collection<ManagedRecord<T>>,
	id: string,
	payload: T,
): Promise<"migrated" | "already_present" | "updated"> {
	const now = Date.now();
	let current = await collection.get(id);
	if (!current) {
		try {
			await db.transaction((tx) => {
				tx.collection<ManagedRecord<T>>(collectionName).set(
					id,
					{ id, payload, updatedAt: now },
					{ requireAbsent: true },
				);
			}, { transactionId: `opensession-create:${collectionName}:${id}:${crypto.randomUUID()}` });
			return "migrated";
		} catch (error) {
			// A lost success response and a competing creator are both resolved by
			// reading the authority. If no record exists, this was a real failure.
			current = await collection.get(id);
			if (!current) throw error;
		}
	}
	if (JSON.stringify(current.payload) === JSON.stringify(payload)) return "already_present";
	if (!Number.isInteger(current.__version))
		throw new Error(`Managed record ${id} has no authority version`);
	let observed = current;
	for (let attempt = 0; attempt < 5; attempt++) {
		const version = observed.__version;
		if (!Number.isInteger(version)) throw new Error(`Managed record ${id} has no version`);
		const result = await collection.updateIfVersion(id, version!, { payload, updatedAt: now });
		if (result.updated) return "updated";
		const refreshed = await collection.get(id);
		if (!refreshed) throw new Error(`Managed record ${id} disappeared during update`);
		observed = refreshed;
	}
	throw new Error(`Managed record ${id} remained contended`);
}

export class ManagedOpenSessionState {
	readonly sessions: Collection<ManagedRecord<UnifiedSession>>;
	readonly workspaces: Collection<ManagedRecord<Workspace>>;
	readonly worktrees: Collection<ManagedRecord<ManagedWorktree>>;
	readonly search: Collection<ManagedRecord<SearchRecord>>;
	readonly migrations: Collection<ManagedMigrationReceipt>;

	constructor(readonly db: StateFirstDB) {
		this.sessions = db.collection(MANAGED_COLLECTIONS.sessions);
		this.workspaces = db.collection(MANAGED_COLLECTIONS.workspaces);
		this.worktrees = db.collection(MANAGED_COLLECTIONS.worktrees);
		this.search = db.collection(MANAGED_COLLECTIONS.search);
		this.migrations = db.collection(MANAGED_COLLECTIONS.migrations);
	}

	putSession(session: UnifiedSession) {
		return putPayload(this.db, MANAGED_COLLECTIONS.sessions, this.sessions, session.id, session);
	}

	putWorkspace(workspace: Workspace) {
		return putPayload(this.db, MANAGED_COLLECTIONS.workspaces, this.workspaces, workspace.id, workspace);
	}

	putWorktree(worktree: ManagedWorktree) {
		return putPayload(this.db, MANAGED_COLLECTIONS.worktrees, this.worktrees, worktree.id, worktree);
	}

	putSearchRecord(record: SearchRecord) {
		return putPayload(this.db, MANAGED_COLLECTIONS.search, this.search, record.id, record);
	}

	async listSessions(): Promise<UnifiedSession[]> {
		return (await this.sessions.all()).map((record) => record.payload);
	}

	async listWorkspaces(): Promise<Workspace[]> {
		return (await this.workspaces.all()).map((record) => record.payload);
	}
}
