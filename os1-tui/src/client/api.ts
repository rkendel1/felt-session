/**
 * REST client. Every path here is one os1-ios already drives (OS1API.swift), so
 * the server needs no new endpoints for this client to exist.
 *
 * Paths are written bare (`/api/…`): the server normalizes them onto its
 * internal `/backstage/api/*` literals, which is what keeps this client working
 * against both the prefix-less deployment and older ones.
 */

import type { Session, TranscriptEntry } from "./types";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
	/** The server has the sign-in gate on and we have no (valid) token. */
	get needsAuth(): boolean {
		return this.status === 401;
	}
}

export type Fetcher = typeof fetch;

export class Api {
	constructor(
		readonly host: string,
		private token?: string,
		private readonly fetcher: Fetcher = fetch,
	) {}

	setToken(token: string | undefined): void {
		this.token = token;
	}

	headers(extra?: Record<string, string>): Record<string, string> {
		return {
			...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
			...extra,
		};
	}

	private async request<T>(
		path: string,
		init?: RequestInit & { raw?: boolean },
	): Promise<T> {
		let response: Response;
		try {
			response = await this.fetcher(`${this.host}${path}`, {
				...init,
				headers: this.headers({
					...(init?.body ? { "content-type": "application/json" } : {}),
					...((init?.headers as Record<string, string>) ?? {}),
				}),
			});
		} catch (e) {
			// Transport failure (DNS, TLS, not-on-the-tailnet) — status 0 so callers
			// can tell "unreachable" from "server said no".
			throw new ApiError(0, `${this.host} unreachable: ${(e as Error).message}`);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			let message = body.slice(0, 300);
			try {
				const parsed = JSON.parse(body);
				if (parsed?.error) message = String(parsed.error);
			} catch {}
			throw new ApiError(
				response.status,
				message || `${response.status} ${response.statusText}`,
			);
		}
		return (await response.json()) as T;
	}

	sessions(): Promise<Session[]> {
		return this.request<Session[]>("/api/sessions");
	}

	async projects(): Promise<{ id: string; name: string }[]> {
		const body = await this.request<{ projects?: { id: string; name: string }[] }>(
			"/api/projects",
		);
		return body.projects ?? [];
	}

	transcript(sessionId: string): Promise<TranscriptEntry[]> {
		return this.request<TranscriptEntry[]>(
			`/api/sessions/${encodeURIComponent(sessionId)}/transcript`,
		);
	}

	/** Full body of an entry the WebSocket delivered clamped. */
	async entry(sessionId: string, entryId: string): Promise<string> {
		const body = await this.request<{ content?: string }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(entryId)}`,
		);
		return body.content ?? "";
	}

	/** Transcript full-text search. Server returns nothing for q shorter than 2. */
	async search(query: string): Promise<{ id: string; snippet: string }[]> {
		const body = await this.request<{
			matches?: { id: string; snippet: string }[];
		}>(`/api/sessions/search?q=${encodeURIComponent(query)}`);
		return body.matches ?? [];
	}

	authStatus(): Promise<{
		authenticated?: boolean;
		login?: string;
		name?: string;
	}> {
		return this.request("/api/auth/status");
	}

	logout(): Promise<unknown> {
		return this.request("/api/auth/logout", {
			method: "POST",
			body: JSON.stringify({}),
		});
	}

	setArchived(sessionId: string, archived: boolean): Promise<unknown> {
		return this.request(
			`/api/sessions/${encodeURIComponent(sessionId)}/archive`,
			{ method: "POST", body: JSON.stringify({ archived }) },
		);
	}

	/** Manual display title; blank clears it back to the derived one. */
	setTitle(sessionId: string, title: string): Promise<unknown> {
		return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
			method: "PUT",
			body: JSON.stringify({ title }),
		});
	}

	createSession(body: {
		prompt: string;
		repo?: string;
		mode?: "ask" | "code";
		model?: string;
		branch?: string;
		user?: string;
	}): Promise<{ sessionId?: string; id?: string }> {
		return this.request("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	repos(): Promise<unknown> {
		return this.request("/api/repos");
	}

	models(): Promise<unknown> {
		return this.request("/api/models");
	}

	/** Cheap reachability probe. Never throws — returns false instead. */
	async reachable(): Promise<boolean> {
		try {
			await this.request("/api/health");
			return true;
		} catch (e) {
			// A 401 still proves a server is there; it just wants a token.
			return e instanceof ApiError && e.status === 401;
		}
	}
}
