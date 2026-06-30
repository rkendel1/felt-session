// Per-user session tab colors, stored server-side (keyed on the UserPicker
// name) so they follow you across devices — same model as pins.ts. The public
// API stays synchronous (an in-memory cache) so callers don't await: the cache
// is hydrated from the server on load and on user switch, and writes are
// optimistic — update the cache + fire the change event immediately, then PUT.
import { fetchTabColors, saveTabColorsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

const CHANGE_EVENT = "michael-tab-colors-changed";
const USER_CHANGE_EVENT = "michael-user-changed";

/** The default swatch palette. Keys must stay in sync with server/tab-colors.ts. */
export const TAB_COLORS: { key: string; label: string; hex: string }[] = [
	{ key: "red", label: "Red", hex: "#f85149" },
	{ key: "orange", label: "Orange", hex: "#db8a40" },
	{ key: "yellow", label: "Yellow", hex: "#d29922" },
	{ key: "green", label: "Green", hex: "#3fb950" },
	{ key: "blue", label: "Blue", hex: "#4493f8" },
	{ key: "purple", label: "Purple", hex: "#a371f7" },
	{ key: "pink", label: "Pink", hex: "#db61a2" },
];

export function colorHex(key: string | undefined): string | null {
	return TAB_COLORS.find((c) => c.key === key)?.hex ?? null;
}

let cache: Record<string, string> = {};
let loadedFor: string | null = null;

function emit() {
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

async function load(user: string) {
	loadedFor = user;
	let colors: Record<string, string> = {};
	try {
		colors = await fetchTabColors(user);
	} catch {
		colors = {};
	}
	// A newer load() (user switched mid-flight) wins.
	if (loadedFor !== user) return;
	cache = colors;
	emit();
}

void load(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));

export function getTabColors(): Record<string, string> {
	return cache;
}

export function getTabColor(id: string): string | undefined {
	return cache[id];
}

/** Set (or, with `null`/unknown key, clear) a session's tab color. */
export function setTabColor(
	id: string,
	color: string | null,
): Record<string, string> {
	const next = { ...cache };
	if (color && TAB_COLORS.some((c) => c.key === color)) {
		next[id] = color;
	} else {
		delete next[id];
	}
	cache = next;
	emit();
	void saveTabColorsApi(getCurrentUser(), next).catch(() => {});
	return next;
}

export function onTabColorsChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}
