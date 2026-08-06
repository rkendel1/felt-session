// How a turn's folded work (tool calls + intermediate assistant messages)
// displays in the session: "collapsed" is the default and keeps work folded;
// "auto" opens the turn fold while it is running, while "expanded" keeps it
// open. Individual tool rows are separate disclosures and remain closed.
// Stored server-side per user (ui-prefs) so it follows you across devices —
// MacBook, iPhone Safari and the installed PWA all have separate localStorage,
// which is why "I set it but it's still collapsed sometimes" happened. The
// localStorage copy is just a synchronous cache of the server value: reads
// stay sync (right on first paint), the server hydrates on load / user switch
// and emits the change event so open transcripts re-fold live.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

export type TurnActivityPref = "auto" | "expanded" | "collapsed";

const KEY = "opensession-turn-activity";
const PREF_KEY = "turn-activity"; // key inside the server-side ui-prefs map
const CHANGE_EVENT = "opensession-turn-activity-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";
const DEFAULT_TURN_ACTIVITY_PREF: TurnActivityPref = "collapsed";

export function getTurnActivityPref(): TurnActivityPref {
	const v = localStorage.getItem(KEY);
	return v === "auto" || v === "expanded" || v === "collapsed"
		? v
		: DEFAULT_TURN_ACTIVITY_PREF;
}

function writeLocal(pref: TurnActivityPref) {
	// The folded state is the default, so its absence is the stored form.
	if (pref === DEFAULT_TURN_ACTIVITY_PREF) localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, pref);
}

// Bumped on every local set; an in-flight hydration only applies if nothing
// was set while it was fetching (the user's fresh choice beats a stale read).
let writeStamp = 0;

export function setTurnActivityPref(pref: TurnActivityPref) {
	writeStamp++;
	writeLocal(pref);
	window.dispatchEvent(new Event(CHANGE_EVENT));
	// Server stores the explicit value (even "auto") so a reset propagates to
	// other devices instead of leaving their old cached value in place.
	void saveUiPrefsApi(getCurrentUser(), { [PREF_KEY]: pref }).catch(() => {});
}

// Pull the user's server-side value into the local cache. First run on a
// browser that has a local value the server doesn't know yet (the pre-sync
// localStorage-only era) pushes that value up instead, so nobody's setting is
// lost by the migration.
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
	if (server === "auto" || server === "expanded" || server === "collapsed") {
		if (server !== getTurnActivityPref()) {
			writeLocal(server);
			window.dispatchEvent(new Event(CHANGE_EVENT));
		}
	} else {
		const local = getTurnActivityPref();
		if (local !== DEFAULT_TURN_ACTIVITY_PREF)
			void saveUiPrefsApi(user, { [PREF_KEY]: local }).catch(() => {});
	}
}

void hydrate(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () =>
	void hydrate(getCurrentUser()),
);

export function onTurnActivityChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
