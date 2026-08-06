/**
 * Per-user workspace snoozes. Like pins.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file `~/.opensession-snoozes/<user>.json` of shape
 * `{ snoozes: { [rowKey]: isoUntil } }`, where `rowKey` is a sidebar row key
 * (`workspace:<id>` or a solo session id) and `isoUntil` is when the snooze
 * lapses. Snoozing is attention management (an overlay, like a pin, not a
 * workspace state), so it lives per-user and syncs across devices; the lane
 * derivation is untouched — the frontend parks actively-snoozed rows in the
 * Snoozed section and lets lapsed entries fall back to their derived lane.
 * The server does no time logic: the frontend prunes lapsed entries when it
 * sees them (marking the row unread so the wake is visible).
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";

const SNOOZES_DIR = stateDir("snoozes");

/** Map a free-form user name to a safe filename; empty/odd input → Anonymous. */
function sanitizeUser(user: string): string {
	const cleaned = (user || "")
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.slice(0, 64);
	return cleaned || "Anonymous";
}

function fileFor(user: string): string {
	return `${SNOOZES_DIR}/${sanitizeUser(user)}.json`;
}

export type Snoozes = Record<string, string>;

export function getSnoozes(user: string): Snoozes {
	try {
		const f = fileFor(user);
		if (!existsSync(f)) return {};
		const raw = JSON.parse(readFileSync(f, "utf8"));
		return clean(raw?.snoozes);
	} catch {
		return {};
	}
}

/** Keep only string-key entries whose value parses as a date. */
function clean(input: unknown): Snoozes {
	const out: Snoozes = {};
	if (input && typeof input === "object") {
		for (const [key, until] of Object.entries(
			input as Record<string, unknown>,
		)) {
			if (
				typeof key === "string" &&
				key.length > 0 &&
				key.length <= 128 &&
				typeof until === "string" &&
				!Number.isNaN(Date.parse(until))
			) {
				out[key] = until;
			}
		}
	}
	return out;
}

/** Replace a user's snoozes (validated). Returns the stored map. */
export function setSnoozes(user: string, snoozes: unknown): Snoozes {
	const cleaned = clean(snoozes);
	try {
		if (!existsSync(SNOOZES_DIR)) mkdirSync(SNOOZES_DIR, { recursive: true });
		writeJsonAtomic(fileFor(user), { snoozes: cleaned });
	} catch {}
	return cleaned;
}
