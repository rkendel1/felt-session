/**
 * Per-user pinned tabs. Each user (the self-selected `backstage-user` name from
 * the frontend UserPicker — not an auth identity, team-internal only) gets one
 * JSON file `~/.backstage-pins/<user>.json` of shape `{ pins: string[] }`, where
 * each entry is a session id. Mirrors the flat-file pattern in models.ts.
 *
 * Pins used to live in browser localStorage (per-device, shared by anyone on
 * that browser); moving them here makes them per-user and synced across devices.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const HOME = process.env.HOME || "/home/ubuntu";
const PINS_DIR = `${HOME}/.backstage-pins`;

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

/** Replace a user's pins (de-duped, strings only). Returns the stored list. */
export function setPins(user: string, pins: unknown): string[] {
  const clean = Array.from(
    new Set((Array.isArray(pins) ? pins : []).filter((x): x is string => typeof x === "string"))
  );
  try {
    if (!existsSync(PINS_DIR)) mkdirSync(PINS_DIR, { recursive: true });
    writeFileSync(fileFor(user), JSON.stringify({ pins: clean }, null, 2));
  } catch {}
  return clean;
}
