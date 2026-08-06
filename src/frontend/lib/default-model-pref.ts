// Per-user default model for NEW sessions (Settings → Composer): what the
// New-session palette (and the workspace/support first-session composers)
// preselect for this user. "" = no preference — fall back to the workspace's
// interactive default from GET /api/models. Stored server-side per user
// (ui-prefs) so it follows you across devices, with a localStorage copy as
// the synchronous cache — the same hydrate pattern as lib/busy-send-pref.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

const LOCAL_KEY = "opensession-default-model-pref";
const PREF_KEY = "default-model"; // key inside the server-side ui-prefs map
const CHANGE_EVENT = "opensession-default-model-pref-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

/** The user's preferred new-session model id, or "" for no preference. */
export function getDefaultModelPref(): string {
	return localStorage.getItem(LOCAL_KEY) || "";
}

function writeLocal(id: string) {
	// No-preference's absence is its stored form.
	if (!id) localStorage.removeItem(LOCAL_KEY);
	else localStorage.setItem(LOCAL_KEY, id);
}

// Bumped on every local set; an in-flight hydration only applies if nothing
// was set while it was fetching (the user's fresh choice beats a stale read).
let writeStamp = 0;

export function setDefaultModelPref(id: string) {
	writeStamp++;
	writeLocal(id);
	window.dispatchEvent(new Event(CHANGE_EVENT));
	// Server stores the explicit value (even "" = no preference) so a reset
	// propagates to other devices instead of leaving their cached value.
	void saveUiPrefsApi(getCurrentUser(), { [PREF_KEY]: id }).catch(() => {});
}

async function hydrate(user: string) {
	const stampAtStart = writeStamp;
	let prefs: Record<string, string>;
	try {
		prefs = await fetchUiPrefs(user);
	} catch {
		return; // offline/error: keep the local cache
	}
	if (writeStamp !== stampAtStart) return; // user changed it mid-fetch
	const server = prefs[PREF_KEY];
	if (typeof server === "string") {
		if (server !== getDefaultModelPref()) {
			writeLocal(server);
			window.dispatchEvent(new Event(CHANGE_EVENT));
		}
	} else if (getDefaultModelPref()) {
		// This browser has a local value the server doesn't know yet.
		void saveUiPrefsApi(user, { [PREF_KEY]: getDefaultModelPref() }).catch(
			() => {},
		);
	}
}

void hydrate(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () => void hydrate(getCurrentUser()));

export function onDefaultModelPrefChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === LOCAL_KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
