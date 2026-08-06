import React from "react";
import { repoLetter } from "../lib/repo-label";

// Deterministic swatch palette shared by the sidebar's person dots and the
// per-repo tiles. The (lowercased) key hashes to a stable color, so each
// teammate/repo keeps the same color everywhere it appears.
export const SWATCH_COLORS = [
	"#e8836b",
	"#6ba5e8",
	"#8ed99c",
	"#e8c46b",
	"#c06be8",
	"#6be8d2",
	"#e86b9c",
	"#a3b86b",
];

export function swatchColor(key: string): string {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return SWATCH_COLORS[Math.abs(hash) % SWATCH_COLORS.length];
}

export function repoColor(key: string): string {
	return swatchColor(key);
}

// The display-name map lives in lib/repo-label so lib-level formatters can
// use it too; re-exported here because most callers reach it alongside the
// tile. The tile color stays keyed on the raw id (via repoColor) so it's
// stable across the rename.
export { repoLabel } from "../lib/repo-label";

// Bumped when the icons behind /repo-icon/<id>.png are redrawn: the response
// is cacheable, so without a new URL an installed PWA keeps painting the old
// art until its copy expires.
const ICON_VERSION = 2;

// A repo's icon tile (sidebar Repo dropdown, session-header breadcrumb, repo
// menus): the server's /repo-icon/<id>.png — a product mark where the repo or
// its owner ships one, else the repo's GitHub org avatar — falling back to the
// colored letter tile when no icon resolves (unregistered/local repos). Every
// icon arrives drawn to the same proportions (see the route), so the tile
// scales them all identically. `size` (px)
// shrinks it for tight spots like the phone header's model line; omitted =
// the 18px default. `round` makes it a full circle (e.g. the phone title
// pill, where it sits against the pill's own rounding).
export function RepoTile({
	name,
	size,
	round,
}: {
	name: string;
	size?: number;
	round?: boolean;
}) {
	// Failure is tracked per name so a tile that switches repo retries the img.
	const [failedFor, setFailedFor] = React.useState<string | null>(null);
	const style: React.CSSProperties = {};
	if (size) {
		style.width = size;
		style.height = size;
		style.fontSize = Math.round(size * 0.6);
		style.borderRadius = round ? "50%" : Math.max(3, Math.round(size * 0.28));
	} else if (round) {
		style.borderRadius = "50%";
	}
	if (failedFor !== name) {
		return (
			<span className="repo-tile repo-tile--img" style={style}>
				<img
					src={`/repo-icon/${encodeURIComponent(name)}.png?v=${ICON_VERSION}`}
					alt=""
					loading="lazy"
					onError={() => setFailedFor(name)}
				/>
			</span>
		);
	}
	style.background = repoColor(name);
	const letter = repoLetter(name);
	return (
		<span className="repo-tile" style={style}>
			{letter}
		</span>
	);
}
