/**
 * Per-user session tab colors. Like pins.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file `~/.backstage-tab-colors/<user>.json` of shape
 * `{ colors: { [sessionId]: colorKey } }`, where `colorKey` is one of the
 * named swatches in the frontend palette (see lib/tab-colors.ts). Colors are
 * a per-user view preference, so they live next to pins and sync across devices.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const HOME = process.env.HOME || "/home/ubuntu";
const COLORS_DIR = `${HOME}/.backstage-tab-colors`;

/** Allowed swatch keys — keep in sync with TAB_COLORS in lib/tab-colors.ts. */
const ALLOWED = new Set([
	"red",
	"orange",
	"yellow",
	"green",
	"blue",
	"purple",
	"pink",
]);

/** Map a free-form user name to a safe filename; empty/odd input → Anonymous. */
function sanitizeUser(user: string): string {
	const cleaned = (user || "")
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.slice(0, 64);
	return cleaned || "Anonymous";
}

function fileFor(user: string): string {
	return `${COLORS_DIR}/${sanitizeUser(user)}.json`;
}

export type TabColors = Record<string, string>;

export function getTabColors(user: string): TabColors {
	try {
		const f = fileFor(user);
		if (!existsSync(f)) return {};
		const raw = JSON.parse(readFileSync(f, "utf8"));
		return clean(raw?.colors);
	} catch {
		return {};
	}
}

/** Keep only string-id → allowed-color entries. */
function clean(input: unknown): TabColors {
	const out: TabColors = {};
	if (input && typeof input === "object") {
		for (const [id, color] of Object.entries(
			input as Record<string, unknown>,
		)) {
			if (
				typeof id === "string" &&
				typeof color === "string" &&
				ALLOWED.has(color)
			) {
				out[id] = color;
			}
		}
	}
	return out;
}

/** Replace a user's tab colors (validated). Returns the stored map. */
export function setTabColors(user: string, colors: unknown): TabColors {
	const cleaned = clean(colors);
	try {
		if (!existsSync(COLORS_DIR)) mkdirSync(COLORS_DIR, { recursive: true });
		writeFileSync(fileFor(user), JSON.stringify({ colors: cleaned }, null, 2));
	} catch {}
	return cleaned;
}
