/**
 * Per-user sidebar hides. Like snoozes.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file `~/.opensession-hides/<user>.json` of shape
 * `{ hides: { [rowKey]: isoHiddenAt } }`, where `rowKey` is a sidebar row key
 * (`workspace:<id>` or a solo session id).
 *
 * Hiding is the personal counterpart to archiving: archive.ts is a GLOBAL
 * registry, so archiving a session removes it for the whole team — wrong when a
 * teammate is still working in it. A hide only ever affects the one user, and
 * leaves the session running and visible for everyone else.
 *
 * The server does no lifecycle logic (same split as snoozes): the frontend
 * resurfaces a hidden row while any of its sessions is blocked on a question, and
 * consumes the entry when it does, so a hide can never swallow work that needs
 * you.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";

const HIDES_DIR = stateDir("hides");

/** Map a free-form user name to a safe filename; empty/odd input → Anonymous. */
function sanitizeUser(user: string): string {
	const cleaned = (user || "")
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.slice(0, 64);
	return cleaned || "Anonymous";
}

function fileFor(user: string): string {
	return `${HIDES_DIR}/${sanitizeUser(user)}.json`;
}

/** Row key → ISO timestamp of when the user hid it. */
export type Hides = Record<string, string>;

export function getHides(user: string): Hides {
	try {
		const f = fileFor(user);
		if (!existsSync(f)) return {};
		const raw = JSON.parse(readFileSync(f, "utf8"));
		return clean(raw?.hides);
	} catch {
		return {};
	}
}

/** Keep only string-key entries whose value parses as a date. */
function clean(input: unknown): Hides {
	const out: Hides = {};
	if (input && typeof input === "object") {
		for (const [key, at] of Object.entries(input as Record<string, unknown>)) {
			if (
				typeof key === "string" &&
				key.length > 0 &&
				key.length <= 128 &&
				typeof at === "string" &&
				!Number.isNaN(Date.parse(at))
			) {
				out[key] = at;
			}
		}
	}
	return out;
}

/** Replace a user's hides (validated). Returns the stored map. */
export function setHides(user: string, hides: unknown): Hides {
	const cleaned = clean(hides);
	try {
		if (!existsSync(HIDES_DIR)) mkdirSync(HIDES_DIR, { recursive: true });
		writeJsonAtomic(fileFor(user), { hides: cleaned });
	} catch {}
	return cleaned;
}
