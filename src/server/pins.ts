/**
 * Per-user pinned tabs. Each user (the self-selected `backstage-user` name from
 * the frontend UserPicker — not an auth identity, team-internal only) gets one
 * JSON file `~/.opensession-pins/<user>.json` of shape `{ pins: string[] }`, where
 * each entry is a session id. Mirrors the flat-file pattern in models.ts.
 *
 * Pins used to live in browser localStorage (per-device, shared by anyone on
 * that browser); moving them here makes them per-user and synced across devices.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { broadcastToAll } from "./ws-hub";

const PINS_DIR = stateDir("pins");

/** Map a free-form user name to a safe filename; empty/odd input → Anonymous. */
function sanitizeUser(user: string): string {
  const cleaned = (user || "").trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "Anonymous";
}

function fileFor(user: string): string {
  return `${PINS_DIR}/${sanitizeUser(user)}.json`;
}

export function getPins(user: string): string[] {
  try {
    const f = fileFor(user);
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(raw?.pins) ? raw.pins.filter((x: unknown) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Drop the given pin keys from EVERY user's pins. Used when a session (or a
 * workspace's last live session) is archived — a pin to archived work is stale
 * for everyone, and would silently resurface the row on unarchive or when a
 * new session joins the pinned workspace.
 */
export function unpinEverywhere(keys: string[]): void {
  const drop = new Set(keys.filter(Boolean));
  if (!drop.size || !existsSync(PINS_DIR)) return;
  for (const file of readdirSync(PINS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const path = `${PINS_DIR}/${file}`;
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const pins: string[] = Array.isArray(raw?.pins)
        ? raw.pins.filter((x: unknown) => typeof x === "string")
        : [];
      const next = pins.filter((p) => !drop.has(p));
      if (next.length !== pins.length) writeJsonAtomic(path, { pins: next });
    } catch {}
  }
}

/** Replace a user's pins (de-duped, strings only). Returns the stored list. */
export function setPins(user: string, pins: unknown): string[] {
  const clean = Array.from(
    new Set((Array.isArray(pins) ? pins : []).filter((x): x is string => typeof x === "string"))
  );
  try {
    if (!existsSync(PINS_DIR)) mkdirSync(PINS_DIR, { recursive: true });
    writeJsonAtomic(fileFor(user), { pins: clean });
  } catch {}
  return clean;
}

/** Add a session to the front of a user's pin list without disturbing order. */
export function pinForUser(user: string, id: string): string[] {
  const pins = getPins(user);
  if (pins.includes(id)) return pins;
  const next = setPins(user, [id, ...pins]);
  broadcastToAll({ type: "pins_changed", user, pins: next });
  return next;
}
