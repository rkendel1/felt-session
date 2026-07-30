/**
 * The sidebar's data source.
 *
 * The server has no session-list push (the web UI polls too, behind a 2s
 * server-side cache), so we poll `GET /api/sessions` and group by workspace.
 * Same `useSyncExternalStore` contract as WatchedSession.
 */

import type { Api } from "./api";
import { ApiError } from "./api";
import { type Session, sessionStatus, sessionTitle } from "./types";

export type WorkspaceGroup = {
	id: string;
	name: string;
	sessions: Session[];
	/** Sessions in this group that a human has to act on. */
	waiting: number;
	running: number;
};

export type SessionsState = {
	sessions: Session[];
	groups: WorkspaceGroup[];
	/** Set once the first poll lands, so the UI can show "connecting…". */
	loaded: boolean;
	error?: string;
	/** True when the server wants a token we don't have. */
	needsAuth: boolean;
};

const POLL_MS = 2_500;

/** Newest activity first — the same read as the web sidebar's ordering. */
function activityTime(session: Session): number {
	const stamp = session.lastActivity || session.createdAt;
	const parsed = stamp ? Date.parse(stamp) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Group sessions into workspaces. `projectId` is the workspace key; sessions
 * without one are grouped by repo, which is what a session that never got
 * promoted to a workspace actually shares.
 */
export function groupSessions(
	sessions: Session[],
	projectNames: Map<string, string>,
): WorkspaceGroup[] {
	const groups = new Map<string, WorkspaceGroup>();
	for (const session of sessions) {
		const id = session.projectId || `repo:${session.repo || "unknown"}`;
		let group = groups.get(id);
		if (!group) {
			group = {
				id,
				name:
					projectNames.get(id) ||
					(session.projectId ? session.projectId : session.repo || "unknown"),
				sessions: [],
				waiting: 0,
				running: 0,
			};
			groups.set(id, group);
		}
		group.sessions.push(session);
		const status = sessionStatus(session);
		if (status === "waiting") group.waiting++;
		if (status === "running") group.running++;
	}
	for (const group of groups.values()) {
		group.sessions.sort((a, b) => activityTime(b) - activityTime(a));
	}
	// Groups needing attention float up, then by most recent activity.
	return [...groups.values()].sort((a, b) => {
		if (!!b.waiting !== !!a.waiting) return b.waiting - a.waiting;
		if (!!b.running !== !!a.running) return b.running - a.running;
		return activityTime(b.sessions[0] ?? {} as Session) - activityTime(a.sessions[0] ?? {} as Session);
	});
}

export class SessionsPoller {
	private state: SessionsState = {
		sessions: [],
		groups: [],
		loaded: false,
		needsAuth: false,
	};
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private projectNames = new Map<string, string>();
	private stopped = false;

	constructor(private readonly api: Api) {}

	async start(): Promise<void> {
		this.stopped = false;
		// Awaited, not fired-and-forgotten: groups are named from this map, and a
		// first paint that raced it showed raw `prj-…` ids instead of workspace
		// names. Names are near-static, so this is one fetch for the process.
		await this.refreshProjects();
		await this.tick();
	}

	private async refreshProjects(): Promise<void> {
		try {
			const projects = await this.api.projects();
			this.projectNames = new Map(projects.map((p) => [p.id, p.name]));
		} catch {
			// Non-fatal: groups fall back to the raw id / repo name.
		}
	}

	private async tick(): Promise<void> {
		if (this.stopped) return;
		try {
			const sessions = (await this.api.sessions()).filter(
				// Side chats and desk todos aren't standalone sessions in the UI.
				(s) => !s.sideChatOf && !s.desk && !s.archived,
			);
			this.set({
				sessions,
				groups: groupSessions(sessions, this.projectNames),
				loaded: true,
				error: undefined,
				needsAuth: false,
			});
			if (!this.projectNames.size) void this.refreshProjects();
		} catch (e) {
			const error = e instanceof ApiError ? e : new ApiError(0, String(e));
			this.set({
				...this.state,
				loaded: true,
				error: error.message,
				needsAuth: error.needsAuth,
			});
		}
		if (!this.stopped) this.timer = setTimeout(() => void this.tick(), POLL_MS);
	}

	/** Poll now rather than waiting out the interval (after a create/archive). */
	refreshSoon(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.tick(), 150);
	}

	private set(next: SessionsState): void {
		this.state = next;
		for (const listener of this.listeners) listener();
	}

	// Arrow property, not a method: this is handed straight to
	// `useSyncExternalStore`, and an unbound method reference loses `this`.
	getState = (): SessionsState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.listeners.clear();
	}
}

/** Flatten groups into the order the sidebar renders, for cursor movement. */
export function flattenGroups(groups: WorkspaceGroup[]): Session[] {
	return groups.flatMap((g) => g.sessions);
}

export { sessionStatus, sessionTitle };
