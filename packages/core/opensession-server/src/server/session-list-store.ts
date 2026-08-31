/**
 * Materialized SQLite index for session lists.
 *
 * Session detail remains authoritative in the owning session file. List
 * requests should never rediscover every session by parsing thousands of JSON
 * files, so this store keeps the already-assembled row plus the columns used
 * to select the small set a client can render. The database is opened lazily:
 * importing a server module must not acquire resources.
 */

import { Database } from "bun:sqlite";
import type { StateFirstDB } from "@feltdb/core";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname } from "path";
import { statePath } from "./paths";
import { shareWorkspacePrRefs } from "./session-pr-target";
import type { UnifiedSession } from "./types";
import { ManagedSessionListStore } from "./managed-session-list-store";

export type SessionListSlice = "include" | "exclude" | "only";

type StoredRow = {
	payload: string;
	automation_run_count?: number | null;
};

function activityMs(session: UnifiedSession): number {
	const value = Date.parse(session.lastActivity || session.createdAt || "");
	return Number.isFinite(value) ? value : 0;
}

function decodeRows(rows: StoredRow[]): UnifiedSession[] {
	const sessions: UnifiedSession[] = [];
	for (const row of rows) {
		try {
			const session = JSON.parse(row.payload) as UnifiedSession & {
				automationRunCount?: number;
			};
			if (row.automation_run_count != null)
				session.automationRunCount = Number(row.automation_run_count);
			sessions.push(session);
		} catch {
			// A single damaged materialized row must not take down the list. The
			// next targeted write or full rebuild replaces it.
		}
	}
	// The index stores independently enriched session rows. PRs are workspace
	// state, so restore their cross-tab projection after decoding any list slice;
	// otherwise the indexed fast path regresses to tab-owned PR visibility.
	shareWorkspacePrRefs(sessions);
	return sessions;
}

export class SessionListStore {
	private readonly db: Database;
	private readonly upsertStatement;

	constructor(path: string) {
		if (path !== ":memory:") {
			const dir = dirname(path);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}
		this.db = new Database(path);
		if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_list_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_list (
				id TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				archived INTEGER NOT NULL,
				last_activity_ms INTEGER NOT NULL,
				workspace_id TEXT,
				worktree_dir TEXT,
				automation TEXT,
				repo TEXT,
				started_by TEXT,
				created_by TEXT,
				desk INTEGER NOT NULL DEFAULT 0,
				is_running INTEGER NOT NULL DEFAULT 0,
				waiting_for_input INTEGER NOT NULL DEFAULT 0,
				manual_status TEXT,
				payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_session_list_archive_activity
				ON session_list(archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_live_automation_activity
				ON session_list(archived, automation, last_activity_ms DESC)
				WHERE archived = 0;
			CREATE INDEX IF NOT EXISTS idx_session_list_workspace_activity
				ON session_list(workspace_id, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_archive_workspace
				ON session_list(archived, workspace_id)
				WHERE workspace_id IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_session_list_worktree_activity
				ON session_list(worktree_dir, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_repo_activity
				ON session_list(repo, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_started_by_activity
				ON session_list(started_by, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_created_by_activity
				ON session_list(created_by, archived, last_activity_ms DESC);
		`);
		if (path !== ":memory:") {
			for (const file of [path, `${path}-wal`, `${path}-shm`]) {
				if (existsSync(file)) chmodSync(file, 0o600);
			}
		}
		this.upsertStatement = this.db.prepare(`
			INSERT INTO session_list (
				id, source, archived, last_activity_ms, workspace_id, worktree_dir,
				automation, repo, started_by, created_by, desk, is_running,
				waiting_for_input, manual_status, payload
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				source = excluded.source,
				archived = excluded.archived,
				last_activity_ms = excluded.last_activity_ms,
				workspace_id = excluded.workspace_id,
				worktree_dir = excluded.worktree_dir,
				automation = excluded.automation,
				repo = excluded.repo,
				started_by = excluded.started_by,
				created_by = excluded.created_by,
				desk = excluded.desk,
				is_running = excluded.is_running,
				waiting_for_input = excluded.waiting_for_input,
				manual_status = excluded.manual_status,
				payload = excluded.payload
		`);
	}

	private write(session: UnifiedSession): void {
		const signals = session as UnifiedSession & { waitingForInput?: boolean };
		this.upsertStatement.run(
			session.id,
			session.source,
			session.archived ? 1 : 0,
			activityMs(session),
			session.workspaceId || null,
			session.worktreeDir || null,
			session.automation || null,
			session.repo || null,
			session.startedBy || null,
			session.createdBy || null,
			session.desk ? 1 : 0,
			session.isRunning ? 1 : 0,
			signals.waitingForInput ? 1 : 0,
			session.manualStatus || null,
			JSON.stringify(session),
		);
	}

	upsert(session: UnifiedSession): void {
		this.write(session);
	}

	upsertMany(sessions: UnifiedSession[]): void {
		this.db.transaction((rows: UnifiedSession[]) => {
			for (const session of rows) this.write(session);
		})(sessions);
	}

	replaceAll(sessions: UnifiedSession[]): void {
		this.db.transaction((rows: UnifiedSession[]) => {
			this.db.run("DELETE FROM session_list");
			for (const session of rows) this.write(session);
			this.markCovered("include");
		})(sessions);
	}

	markCovered(slice: SessionListSlice): void {
		const slices =
			slice === "include" ? (["include", "exclude", "only"] as const) : [slice];
		for (const covered of slices)
			this.db.run(
				"INSERT OR REPLACE INTO session_list_meta(key, value) VALUES (?, ?)",
				[`covered:${covered}`, String(Date.now())],
			);
	}

	hasCoverage(slice: SessionListSlice): boolean {
		return !!this.db
			.query("SELECT 1 FROM session_list_meta WHERE key = ?")
			.get(`covered:${slice}`);
	}

	remove(id: string): void {
		this.db.run("DELETE FROM session_list WHERE id = ?", [id]);
	}

	setArchived(id: string, archived: boolean, reason?: string): void {
		const row = this.db
			.query("SELECT payload FROM session_list WHERE id = ?")
			.get(id) as { payload: string } | null;
		if (!row) return;
		try {
			const session = JSON.parse(row.payload) as UnifiedSession;
			if (archived) {
				session.archived = true;
				if (reason) session.archivedReason = reason as UnifiedSession["archivedReason"];
			} else {
				delete session.archived;
				delete session.archivedReason;
			}
			this.write(session);
		} catch {
			this.remove(id);
		}
	}

	count(): number {
		const row = this.db.query("SELECT count(*) AS n FROM session_list").get() as {
			n: number;
		};
		return Number(row?.n || 0);
	}

	migrationSnapshot(): { sessions: UnifiedSession[]; coverage: SessionListSlice[] } {
		const sessions = decodeRows(this.db.query("SELECT payload FROM session_list").all() as StoredRow[]);
		const coverage = (["include", "exclude", "only"] as SessionListSlice[]).filter((slice) => this.hasCoverage(slice));
		return { sessions, coverage };
	}

	list(slice: SessionListSlice = "include"): UnifiedSession[] {
		const where =
			slice === "include" ? "" : slice === "only" ? "WHERE archived = 1" : "WHERE archived = 0";
		const rows = this.db
			.query(`SELECT payload FROM session_list ${where} ORDER BY last_activity_ms DESC, id`)
			.all() as StoredRow[];
		return decodeRows(rows);
	}

	listWorkspace(
		workspaceId: string,
		worktreeDir?: string | null,
	): UnifiedSession[] {
		const isolatedWorktree = worktreeDir?.includes("/worktrees/")
			? worktreeDir
			: null;
		const rows = isolatedWorktree
			? (this.db
					.query(`
						SELECT payload FROM session_list
						WHERE archived = 1 AND (workspace_id = ? OR worktree_dir = ?)
						ORDER BY last_activity_ms DESC
					`)
					.all(workspaceId, isolatedWorktree) as StoredRow[])
			: (this.db
					.query(`
						SELECT payload FROM session_list
						WHERE workspace_id = ? AND archived = 1
						ORDER BY last_activity_ms DESC
					`)
					.all(workspaceId) as StoredRow[]);
		return decodeRows(rows);
	}

	/** Workspace ids that can produce a live sidebar row, without decoding the
	 * session payloads behind them. */
	activeWorkspaceIds(): string[] {
		return (
			this.db
				.query(
					"SELECT DISTINCT workspace_id FROM session_list WHERE archived = 0 AND workspace_id IS NOT NULL",
				)
				.all() as Array<{ workspace_id: string }>
		).map((row) => row.workspace_id);
	}

	/**
	 * Return every human-created live row and only the useful automation tail.
	 * Ranking and counting stay inside SQLite, so JavaScript never parses the
	 * thousands of automation payloads a collapsed sidebar cannot display.
	 */
	listSidebar(selectedSessionId?: string): UnifiedSession[] {
		const rows = this.db
			.query(`
				WITH ranked_automation AS (
					SELECT payload, id, last_activity_ms, is_running,
						waiting_for_input, manual_status,
						row_number() OVER (
							PARTITION BY automation
							ORDER BY last_activity_ms DESC, id
						) AS automation_rank,
						count(*) OVER (PARTITION BY automation) AS automation_run_count
					FROM session_list
					WHERE archived = 0 AND automation IS NOT NULL
				), selected AS (
					SELECT payload, last_activity_ms, NULL AS automation_run_count
					FROM session_list
					WHERE archived = 0 AND automation IS NULL
					UNION ALL
					SELECT payload, last_activity_ms, automation_run_count
					FROM ranked_automation
					WHERE automation_rank <= 5 OR is_running = 1
						OR waiting_for_input = 1 OR manual_status IS NOT NULL OR id = ?
				)
				SELECT payload, automation_run_count
				FROM selected
				ORDER BY last_activity_ms DESC
			`)
			.all(selectedSessionId || "") as StoredRow[];
		return decodeRows(rows);
	}

	queryPlan(sql: string, ...params: Array<string | number>): string[] {
		return (
			this.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
				detail: string;
			}>
		).map((row) => row.detail);
	}

	close(): void {
		this.db.close();
	}
}

const g = globalThis as typeof globalThis & {
	__osSessionListStore?: SessionListStore | ManagedSessionListStore;
};

export function sessionListStore(): SessionListStore | ManagedSessionListStore {
	if (!g.__osSessionListStore) throw new Error("Managed session list has not been initialized");
	return g.__osSessionListStore;
}

const LIST_PATH = statePath(".opensession-session-list.db");
const LIST_MIGRATION = "session-list-sqlite-to-managed-feltdb-v1";

export async function initializeManagedSessionList(db: StateFirstDB): Promise<void> {
	const store = new ManagedSessionListStore(db);
	await store.initialize();
	if (!await db.collection<{ id: string }>("opensession_migrations").get(LIST_MIGRATION)) {
		if (existsSync(LIST_PATH)) {
			const legacy = new SessionListStore(LIST_PATH);
			try {
				const snapshot = legacy.migrationSnapshot();
				await store.upsertMany(snapshot.sessions);
				for (const slice of snapshot.coverage) await store.markCovered(slice);
			} finally { legacy.close(); }
		}
		await db.transaction((tx) => {
			tx.collection("opensession_migrations").set(LIST_MIGRATION,
				{ id: LIST_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${LIST_MIGRATION}` });
	}
	for (const path of [LIST_PATH, `${LIST_PATH}-wal`, `${LIST_PATH}-shm`]) if (existsSync(path)) unlinkSync(path);
	g.__osSessionListStore = store;
}

/** Swap the process-wide store without opening the default state DB. */
export function __setSessionListStoreForTest(
	store: SessionListStore | ManagedSessionListStore | undefined,
): SessionListStore | ManagedSessionListStore | undefined {
	const previous = g.__osSessionListStore;
	if (store) g.__osSessionListStore = store;
	else delete g.__osSessionListStore;
	return previous;
}

export function indexedSessions(
	slice: SessionListSlice = "include",
): UnifiedSession[] | null {
	const store = sessionListStore();
	return store.hasCoverage(slice) ? store.list(slice) : null;
}

export function indexedSidebarSessions(
	selectedSessionId?: string,
): UnifiedSession[] | null {
	const store = sessionListStore();
	return store.hasCoverage("exclude")
		? store.listSidebar(selectedSessionId)
		: null;
}

export function indexedWorkspaceSessions(
	workspaceId: string,
	worktreeDir?: string | null,
): UnifiedSession[] | null {
	const store = sessionListStore();
	return store.hasCoverage("only")
		? store.listWorkspace(workspaceId, worktreeDir)
		: null;
}

export function indexedActiveWorkspaceIds(): string[] | null {
	const store = sessionListStore();
	return store.hasCoverage("exclude") ? store.activeWorkspaceIds() : null;
}

export async function upsertIndexedSession(session: UnifiedSession): Promise<void> {
	await sessionListStore().upsert(session);
}

export async function upsertIndexedSessions(
	sessions: UnifiedSession[],
	slice?: SessionListSlice,
): Promise<void> {
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
