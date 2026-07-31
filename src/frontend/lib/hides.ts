// Sidebar hides, stored server-side per user (keyed on the UserPicker name)
// like pins and snoozes, so they follow you across devices.
//
// Hiding is the personal counterpart to archiving: archiving is global, so it
// removes a chat for the whole team — wrong when a teammate is still working
// in it. A hide is an overlay on a sidebar row key (`workspace:<id>` or a solo
// chat id) that only ever affects you; the chat keeps running and stays in
// everyone else's sidebar.
//
// There is deliberately no "Hidden" band: hiding means the row is off your
// sidebar, not filed into a drawer you'd never open. A hidden chat stays
// findable in the ⌘K palette (which ignores hides), and the Sidebar always
// shows the OPEN chat's row — so opening one brings its row back and its menu
// offers "Restore to my sidebar". Prompting in a chat clears its hide outright
// (`unhideForChat`): you can't be done with work you're actively doing.
//
// A hide is otherwise sticky (unlike a snooze, it has no expiry), with one
// exception the Sidebar applies: a hidden row resurfaces while any of its chats
// is blocked on a question, and the entry is consumed when that happens — so a
// hide can never swallow work that needs you. The public API stays synchronous (an in-memory
// cache) mirroring snoozes.ts: hydrated on load and on user switch, writes are
// optimistic — update the cache + fire the change event immediately, then PUT
// the full map.
import { fetchHides, saveHidesApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

const CHANGE_EVENT = "opensession-hides-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

let cache: Record<string, string> = {};

function emit() {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

let loadedFor: string | null = null;

async function load(user: string) {
	loadedFor = user;
	let hides: Record<string, string> = {};
	try {
		hides = await fetchHides(user);
	} catch {
		hides = {};
	}
	// A newer load() (user switched mid-flight) wins.
	if (loadedFor !== user) return;
	cache = hides;
	emit();
}

// Guarded so the module stays importable outside a browser — `partitionHidden`
// below carries the rule that keeps a hide from swallowing a blocked chat, and
// it's worth unit-testing without standing up a DOM.
if (typeof window !== "undefined") {
	void load(getCurrentUser());
	window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));
}

export function getHides(): Record<string, string> {
	return cache;
}

export function setHide(key: string): void {
	if (key in cache) return;
	cache = { ...cache, [key]: new Date().toISOString() };
	emit();
	void saveHidesApi(getCurrentUser(), cache).catch(() => {});
}

/**
 * Drop hide entries. Takes a list so the Sidebar can consume several resurfaced
 * rows in one write; idempotent, since multiple tabs race to clear the same key.
 */
export function clearHides(keys: string[]): void {
	const doomed = keys.filter((k) => k in cache);
	if (!doomed.length) return;
	const next = { ...cache };
	for (const k of doomed) delete next[k];
	cache = next;
	emit();
	void saveHidesApi(getCurrentUser(), cache).catch(() => {});
}

/**
 * Clear the hide covering a chat, whichever row key its row uses (a chat can
 * sit under `workspace:<id>`, `wt:<dir>` or its own id — the Sidebar picks).
 * Called when the user PROMPTS in a chat: you can't be done with a chat you're
 * actively working in, and "I replied but it's still gone from my sidebar"
 * reads as a bug. Opening a hidden chat deliberately does NOT unhide it.
 */
export function unhideForChat(chat: {
	id: string;
	projectId?: string | null;
	worktreeDir?: string | null;
}): void {
	clearHides([
		chat.id,
		...(chat.projectId ? [`workspace:${chat.projectId}`] : []),
		...(chat.worktreeDir ? [`wt:${chat.worktreeDir}`] : []),
	]);
}

export function onHidesChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

/**
 * Split rows into "stays hidden" and "resurfaced", applying the one exception
 * to a hide: a row blocked on a question comes back, so hiding can never
 * swallow work that is waiting on a human. The caller consumes `resurfaced`
 * (clear the entries, mark them unread), which is what makes the rule
 * one-shot — the row then stays visible until it's hidden again, instead of
 * flickering as questions get asked and answered.
 */
export function partitionHidden<T extends { key: string; status: string }>(
	rows: T[],
	hides: Record<string, string>,
): { hiddenKeys: Set<string>; resurfaced: T[] } {
	const hiddenKeys = new Set<string>();
	const resurfaced: T[] = [];
	for (const row of rows) {
		if (!(row.key in hides)) continue;
		if (row.status === "needsinput") resurfaced.push(row);
		else hiddenKeys.add(row.key);
	}
	return { hiddenKeys, resurfaced };
}
