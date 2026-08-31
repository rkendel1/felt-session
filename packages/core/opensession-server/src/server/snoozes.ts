/**
 * Per-user workspace snoozes. Like pins.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file under `~/.opensession-snoozes/` of shape
 * `{ snoozes: { [rowKey]: until } }`, where `rowKey` is a sidebar row key
 * (`workspace:<id>` or a solo session id) and `until` is either an ISO wake
 * time or `"someday"` for an indefinite snooze. Filename, directory resolution
 * and legacy-name fallback come from
 * shared/user-store.ts. Snoozing is attention management (an overlay, like a
 * pin, not a workspace state), so it lives per-user and syncs across devices;
 * the lane derivation is untouched — the frontend parks actively-snoozed rows
 * in the Snoozed section and lets lapsed entries fall back to their derived
 * lane. The server does no time logic: the frontend prunes lapsed entries when
 * it sees them (marking the row unread so the wake is visible).
 */

import { settlementEntries, setSettlementsByKey } from "./settlements";
import { userStore } from "./shared/user-store";

export const SNOOZE_SOMEDAY = "someday";
export type Snoozes = Record<string, string>;

/** Keep only string-key entries whose value is a wake time or Someday. */
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
				(until === SNOOZE_SOMEDAY || !Number.isNaN(Date.parse(until)))
			) {
				out[key] = until;
			}
		}
	}
	return out;
}

const store = userStore<Snoozes>({ name: "snoozes", field: "snoozes", clean });

export function getSnoozes(user: string): Snoozes {
	return store.get(user);
}

export async function migrateLegacySettlementsToSnoozes(): Promise<void> {
	const snoozesByKey = new Map(store.entries());
	for (const [userKey, settlements] of settlementEntries()) {
		if (Object.keys(settlements).length === 0) continue;
		const migrated = { ...(snoozesByKey.get(userKey) || {}) };
		for (const [key, record] of Object.entries(settlements))
			if (record.state === "settled" && !(key in migrated)) migrated[key] = SNOOZE_SOMEDAY;
		await store.setByKey(userKey, migrated);
		await setSettlementsByKey(userKey, {});
	}
}

/** Replace a user's snoozes (validated). Returns the stored map. */
export async function setSnoozes(user: string, snoozes: unknown): Promise<Snoozes> {
	return store.set(user, snoozes);
}
