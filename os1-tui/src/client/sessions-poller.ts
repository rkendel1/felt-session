/**
 * The sidebar's data source.
 *
 * The server has no session-list push (the web UI polls too, behind a 2s
 * server-side cache), so we poll `GET /api/sessions` and group by workspace.
 * Same `useSyncExternalStore` contract as WatchedSession.
 */

import type { Api } from "./api";
import { ApiError } from "./api";
import {
	type Identity,
	type SessionScope,
	identityTokens,
	inScope,
	nextScope,
} from "./identity";
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
	/** The scope's sessions — what the sidebar and the picker walk. */
	sessions: Session[];
	groups: WorkspaceGroup[];
	/** Which slice of the server's list `sessions` is. */
	scope: SessionScope;
	/** We picked the scope ourselves because the chosen one was empty. */
	scopeAuto: boolean;
	/** How many sessions the server returned, before scoping. */
	totalSessions: number;
	/** How many the scope matched, before the MAX_SESSIONS cap. */
	matched: number;
	/** Scope matched more than MAX_SESSIONS; the oldest were dropped. */
	truncated: boolean;
	/** Set once the first poll lands, so the UI can show "connecting…". */
	loaded: boolean;
	error?: string;
	/** True when the server wants a token we don't have. */
	needsAuth: boolean;
};

const POLL_MS = 2_500;

/**
 * The sidebar renders a row per session, so an unbounded list is a render cost
 * paid every frame — and this server answers `/api/sessions` with ~5k rows.
 * Newest-first means the cap only ever hides sessions you'd have scrolled past.
 */
const MAX_SESSIONS = 200;

/** Newest activity first — the same read as the web sidebar's ordering. */
function activityTime(session: Session): number {
	const stamp = session.lastActivity || session.createdAt;
	const parsed = stamp ? Date.parse(stamp) : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Group sessions into workspaces. `workspaceId` is the workspace key; sessions
 * without one are grouped by repo, which is what a session that never got
 * promoted to a workspace actually shares.
 */
export function groupSessions(
	sessions: Session[],
	workspaceNames: Map<string, string>,
): WorkspaceGroup[] {
	const groups = new Map<string, WorkspaceGroup>();
	for (const session of sessions) {
		const id = session.workspaceId || `repo:${session.repo || "unknown"}`;
		let group = groups.get(id);
		if (!group) {
			group = {
				id,
				name:
					workspaceNames.get(id) ||
					(session.workspaceId ? session.workspaceId : session.repo || "unknown"),
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
	private state: SessionsState;
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private workspaceNames = new Map<string, string>();
	private stopped = false;
	/** Everything the last poll returned, unscoped — re-scoping is local. */
	private raw: Session[] = [];
	private tokens: Set<string>;
	/**
	 * "mine" is the right default and the wrong one to be stuck in: a server
	 * whose sessions carry a name we don't match would render an empty sidebar
	 * with no hint why. Until the user picks a scope themselves, an empty result
	 * widens by itself (and says so).
	 */
	private scopeChosen = false;
	/** What the user asked for; `state.scope` is what they actually got. */
	private preferred: SessionScope;

	constructor(
		private readonly api: Api,
		identity: Identity = {},
		scope: SessionScope = "mine",
		/** Set when the scope came from the user (config), not from the default. */
		scopeExplicit = false,
	) {
		this.tokens = identityTokens(identity);
		this.scopeChosen = scopeExplicit;
		this.preferred = scope;
		this.state = {
			sessions: [],
			groups: [],
			scope,
			scopeAuto: false,
			totalSessions: 0,
			matched: 0,
			truncated: false,
			loaded: false,
			needsAuth: false,
		};
	}

	/** Switch scope without waiting for the next poll. */
	setScope(scope: SessionScope): void {
		this.scopeChosen = true;
		this.preferred = scope;
		this.set({ ...this.state, ...this.scoped(scope, false) });
	}

	cycleScope(): SessionScope {
		const scope = nextScope(this.state.scope);
		this.setScope(scope);
		return scope;
	}

	/** Apply a scope to the last poll's raw list. */
	private scoped(
		scope: SessionScope,
		allowWiden: boolean,
	): Pick<
		SessionsState,
		| "sessions"
		| "groups"
		| "scope"
		| "scopeAuto"
		| "totalSessions"
		| "matched"
		| "truncated"
	> {
		let chosen = scope;
		let auto = false;
		let matched = this.raw.filter((s) => inScope(s, chosen, this.tokens));
		// Widen one step at a time so the sidebar is never mysteriously empty.
		while (allowWiden && !matched.length && chosen !== "all") {
			chosen = nextScope(chosen);
			auto = true;
			matched = this.raw.filter((s) => inScope(s, chosen, this.tokens));
		}
		matched.sort((a, b) => activityTime(b) - activityTime(a));
		const truncated = matched.length > MAX_SESSIONS;
		const sessions = truncated ? matched.slice(0, MAX_SESSIONS) : matched;
		return {
			sessions,
			groups: groupSessions(sessions, this.workspaceNames),
			scope: chosen,
			scopeAuto: auto,
			totalSessions: this.raw.length,
			matched: matched.length,
			truncated,
		};
	}

	async start(): Promise<void> {
		this.stopped = false;
		// Awaited, not fired-and-forgotten: groups are named from this map, and a
		// first paint that raced it showed raw `ws-…` ids instead of workspace
		// names. Names are near-static, so this is one fetch for the process.
		await this.refreshWorkspaces();
		await this.tick();
	}

	private async refreshWorkspaces(): Promise<void> {
		try {
			const workspaces = await this.api.workspaces();
			this.workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));
		} catch {
			// Non-fatal: groups fall back to the raw id / repo name.
		}
	}

	private async tick(): Promise<void> {
		if (this.stopped) return;
		try {
			this.raw = (await this.api.sessions()).filter(
				// Side chats and desk todos aren't standalone sessions in the UI.
				(s) => !s.desk && !s.archived,
			);
			this.set({
				...this.state,
				...this.scoped(this.preferred, !this.scopeChosen),
				loaded: true,
				error: undefined,
				needsAuth: false,
			});
			if (!this.workspaceNames.size) void this.refreshWorkspaces();
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
