// Workspace snoozes, stored server-side per user (keyed on the UserPicker
// name) like pins, so they follow you across devices. A snooze is an overlay
// on a sidebar row key (`workspace:<id>` or a solo session id): while its `until`
// is in the future the row parks in the Snoozed section; once lapsed the entry
// is ignored (the row falls back to its derived lane) and the Sidebar prunes
// it, marking the row unread so the wake is visible. The public API stays
// synchronous (an in-memory cache) mirroring pins.ts: hydrated on load and on
// user switch, writes are optimistic — update the cache + fire the change
// event immediately, then PUT the full map.
import { fetchSnoozes, saveSnoozesApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

const CHANGE_EVENT = "opensession-snoozes-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

let cache: Record<string, string> = {};

function emit() {
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

let loadedFor: string | null = null;

async function load(user: string) {
	loadedFor = user;
	let snoozes: Record<string, string> = {};
	try {
		snoozes = await fetchSnoozes(user);
	} catch {
		snoozes = {};
	}
	// A newer load() (user switched mid-flight) wins.
	if (loadedFor !== user) return;
	cache = snoozes;
	emit();
}

void load(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));

export function getSnoozes(): Record<string, string> {
	return cache;
}

/** The active snooze expiry for a row key, or null (lapsed entries excluded). */
export function snoozeUntil(key: string): string | null {
	const until = cache[key];
	if (!until) return null;
	return Date.parse(until) > Date.now() ? until : null;
}

export function setSnooze(key: string, untilIso: string): void {
	cache = { ...cache, [key]: untilIso };
	emit();
	void saveSnoozesApi(getCurrentUser(), cache).catch(() => {});
}

export function clearSnooze(key: string): void {
	if (!(key in cache)) return;
	const next = { ...cache };
	delete next[key];
	cache = next;
	emit();
	void saveSnoozesApi(getCurrentUser(), cache).catch(() => {});
}

export function onSnoozesChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// ── Snooze presets (the right-click flyout) ─────────────────────────────────
// T3-style: each option resolves to a concrete local time, shown in the label.
// "This evening" only offers while it's still meaningfully ahead of 6 PM.

export interface SnoozePreset {
	label: string;
	until: Date;
}

function fmtTime(d: Date): string {
	return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtDay(d: Date): string {
	return d.toLocaleDateString([], { weekday: "short" });
}

export function snoozePresets(now = new Date()): SnoozePreset[] {
	const out: SnoozePreset[] = [];
	const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
	out.push({ label: `In 1 hour (${fmtTime(inOneHour)})`, until: inOneHour });
	const evening = new Date(now);
	evening.setHours(18, 0, 0, 0);
	if (evening.getTime() - now.getTime() > 30 * 60 * 1000)
		out.push({ label: `This evening (${fmtTime(evening)})`, until: evening });
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(9, 0, 0, 0);
	out.push({
		label: `Tomorrow (${fmtDay(tomorrow)} ${fmtTime(tomorrow)})`,
		until: tomorrow,
	});
	const nextWeek = new Date(now);
	// Next Monday 9:00 — always at least a full day out.
	const day = nextWeek.getDay(); // 0 = Sunday
	const daysToMonday = ((8 - day) % 7) || 7;
	nextWeek.setDate(nextWeek.getDate() + daysToMonday);
	nextWeek.setHours(9, 0, 0, 0);
	out.push({
		label: `Next week (${fmtDay(nextWeek)} ${fmtTime(nextWeek)})`,
		until: nextWeek,
	});
	return out;
}

/** Compact time-to-wake for the row badge: "57m", "14h", "6d". */
export function formatRemaining(untilIso: string, nowMs = Date.now()): string {
	const ms = Math.max(0, Date.parse(untilIso) - nowMs);
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(ms / 3_600_000);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}
