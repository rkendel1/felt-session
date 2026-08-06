/**
 * Frontend team directory — fetched once from GET /api/people (derived
 * server-side from the identity config) and cached module-wide. The portable
 * default is empty; fetched logins are merged into UserAvatar's login map and
 * subscribers re-render via `usePeople()`.
 */

import { useEffect, useState } from "react";
import { BASE_PATH } from "./base";
import { registerGithubLogins } from "../components/UserAvatar";
import type { FileMention } from "./api";

export interface Person {
	/** Picker/display first name. */
	name: string;
	fullName: string;
	github?: string;
	timezone?: string;
}

const CHANGE_EVENT = "opensession-people-changed";
let people: Person[] = [];
let fetched = false;

/** Current roster, synchronously (fallback until the fetch lands). */
export function getPeople(): Person[] {
	void ensurePeople();
	return people;
}

/** Picker first names for the roster. */
export function getPeopleNames(): string[] {
	return getPeople().map((p) => p.name);
}

export function personByName(name?: string | null): Person | undefined {
	if (!name) return undefined;
	const first = name.trim().split(/\s+/)[0]?.toLowerCase();
	return people.find((p) => p.name.toLowerCase() === first);
}

let inflight: Promise<void> | null = null;
export function ensurePeople(): Promise<void> {
	if (fetched) return Promise.resolve();
	if (inflight) return inflight;
	inflight = fetch(`${BASE_PATH}/api/people`)
		.then((r) => (r.ok ? r.json() : null))
		.then((body: { people?: Person[] } | null) => {
			const list =
				body?.people?.filter((p) => p && typeof p.name === "string") ?? [];
			people = list;
			fetched = true;
			registerGithubLogins(
				Object.fromEntries(
					list
						.filter((p) => p.github)
						.map((p) => [p.name.toLowerCase(), p.github as string]),
				),
			);
			window.dispatchEvent(new Event(CHANGE_EVENT));
		})
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/**
 * People rows for the composer's @-mention popup. Only offered once a query
 * is typed (a bare "@" stays the familiar file browser); name matches list
 * before file results. Inserting yields `@Name`, which the server's mention
 * scan (people.ts mentionedUsers) turns into a push when the prompt is sent.
 */
export function peopleMentionMatches(query: string): FileMention[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return getPeople()
		.filter(
			(p) =>
				p.name.toLowerCase().startsWith(q) ||
				p.fullName.toLowerCase().startsWith(q),
		)
		.slice(0, 3)
		.map((p) => ({
			display: p.name,
			insert: p.name,
			kind: "person" as const,
			sub: p.fullName,
		}));
}

/** Reactive roster — triggers the fetch on first use. */
export function usePeople(): Person[] {
	const [list, setList] = useState(people);
	useEffect(() => {
		void ensurePeople();
		const handler = () => setList(people);
		window.addEventListener(CHANGE_EVENT, handler);
		return () => window.removeEventListener(CHANGE_EVENT, handler);
	}, []);
	return list;
}
