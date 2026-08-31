/**
 * Per-user pinned tabs. Each user (the self-selected `backstage-user` name from
 * the frontend UserPicker — not an auth identity, team-internal only) gets one
 * JSON file under `~/.opensession-pins/` of shape `{ pins: string[] }`, where
 * each entry is a session id. The filename, the per-call directory resolution
 * and the legacy-name read fallback all live in shared/user-store.ts, which
 * every per-user store shares.
 *
 * Pins used to live in browser localStorage (per-device, shared by anyone on
 * that browser); moving them here makes them per-user and synced across devices.
 */

import { userStore } from "./shared/user-store";
import { broadcastToAll } from "./ws-hub";

/** Keep session-id strings only, de-duped. Defines the empty list too. */
function clean(input: unknown): string[] {
  return Array.from(
    new Set(
      (Array.isArray(input) ? input : []).filter(
        (x): x is string => typeof x === "string",
      ),
    ),
  );
}

const store = userStore<string[]>({ name: "pins", field: "pins", clean });

export function getPins(user: string): string[] {
  return store.get(user);
}

/**
 * Drop the given pin keys from EVERY user's pins. Used when a session (or a
 * workspace's last live session) is archived — a pin to archived work is stale
 * for everyone, and would silently resurface the row on unarchive or when a
 * new session joins the pinned workspace.
 */
export async function unpinEverywhere(keys: string[]): Promise<void> {
  const drop = new Set(keys.filter(Boolean));
  if (!drop.size) return;
  for (const [userKey, pins] of [...store.entries()]) {
    const next = pins.filter((pin) => !drop.has(pin));
    if (next.length !== pins.length) await store.setByKey(userKey, next);
  }
}

/** Replace a user's pins (de-duped, strings only). Returns the stored list. */
export async function setPins(user: string, pins: unknown): Promise<string[]> {
  return store.set(user, pins);
}

/** Add a session to the front of a user's pin list without disturbing order. */
export async function pinForUser(user: string, id: string): Promise<string[]> {
  const pins = getPins(user);
  if (pins.includes(id)) return pins;
  const next = await setPins(user, [id, ...pins]);
  broadcastToAll({ type: "pins_changed", user, pins: next });
  return next;
}
