/**
 * Composer attachments: image data-URL parsing and non-image file staging.
 * Non-image attachments are staged to disk (the vision path only takes
 * images), then the agent is handed their absolute paths in the opening
 * prompt. Large files (a packed .crx, a zip, a PDF) stream straight to disk
 * over a dedicated HTTP endpoint (POST /api/upload) and only their
 * {name,path} reference rides the WebSocket — base64-over-WS can't carry them
 * (frame cap + memory). The legacy inline {name,dataUrl}-over-WS path is still
 * accepted for small files and older clients.
 */

import {
	existsSync,
	mkdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "fs";
import type { ImageInput } from "./run-events";
import { SESSIONS_DIR } from "./session-cache";

/** Keep only the string `data:` URLs from a composer `images` payload — the
 *  display/queue form (parsed to ImageInput at delivery via parseImageDataUrls). */
export function asDataUrlList(urls?: unknown): string[] | undefined {
	if (!Array.isArray(urls)) return undefined;
	const out = urls.filter((u): u is string => typeof u === "string");
	return out.length ? out : undefined;
}

/** Decode composer `data:<mediatype>;base64,<data>` URLs into runner ImageInputs. */
export function parseImageDataUrls(urls?: unknown): ImageInput[] | undefined {
	if (!Array.isArray(urls)) return undefined;
	const out: ImageInput[] = [];
	for (const u of urls) {
		if (typeof u !== "string") continue;
		const m = u.match(/^data:([^;]+);base64,(.+)$/s);
		if (m && m[1].startsWith("image/"))
			out.push({ mediaType: m[1], data: m[2] });
	}
	return out.length ? out : undefined;
}

export const UPLOADS_DIR = `${SESSIONS_DIR}/uploads`;
// The HTTP endpoint stages here — a brand-new session has no session id yet, so the
// reference is resolved back (and validated) at send time.
const STAGED_UPLOADS_DIR = `${UPLOADS_DIR}/staged`;
// Cap so a single upload can't OOM the process. The HTTP path streams, but the
// inline base64/WS path buffers, so keep it modest.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Images still ride the WebSocket frame base64-encoded (~+33%) inside the JSON
// envelope, and Bun's default WS `maxPayloadLength` is only 16 MB — below the
// base64 size of a max upload — so a large image silently blew the frame
// (close 1009). Size the frame cap off the upload cap + base64 overhead + slack.
export const WS_MAX_PAYLOAD_BYTES =
	Math.ceil(MAX_UPLOAD_BYTES * (4 / 3)) + 8 * 1024 * 1024;

// A composer attachment arrives either pre-staged on disk (HTTP upload — carries a
// `path`) or inline as base64 over the WS frame (legacy — carries a data URL).
type ParsedUpload =
	| { kind: "staged"; name: string; path: string }
	| { kind: "inline"; name: string; data: string };

/** Normalize composer `files` entries into staged-path refs or inline base64. */
export function parseFileUploads(raw?: unknown): ParsedUpload[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: ParsedUpload[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const name = typeof (f as any).name === "string" ? (f as any).name : "";
		const path = typeof (f as any).path === "string" ? (f as any).path : "";
		if (path) {
			out.push({ kind: "staged", name, path });
			continue;
		}
		const url = typeof (f as any).dataUrl === "string" ? (f as any).dataUrl : "";
		const m = url.match(/^data:[^;]*;base64,(.+)$/s);
		if (!m) continue;
		out.push({ kind: "inline", name, data: m[1] });
	}
	return out.length ? out : undefined;
}

/** Keep a user-supplied filename to a safe basename (no traversal, no exotic chars). */
function sanitizeFilename(name: string): string {
	const base = (name.split(/[\\/]/).pop() || "file").replace(/^\.+/, "");
	const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 120);
	return cleaned || "file";
}

/** Resolve `p` and confirm it lives inside UPLOADS_DIR — guards against a
 *  client-supplied {name,path} ref pointing the agent at an arbitrary file. */
export function isWithinUploads(p: string): boolean {
	try {
		const real = realpathSync(p);
		const base = realpathSync(UPLOADS_DIR);
		return real === base || real.startsWith(base + "/");
	} catch {
		return false;
	}
}

/** Pick a collision-free absolute path under `dir` for the sanitized `wanted`. */
function uniqueUploadPath(
	dir: string,
	wanted: string,
	used?: Set<string>,
): string {
	let fname = wanted;
	let i = 1;
	while (used?.has(fname) || existsSync(`${dir}/${fname}`)) {
		const dot = wanted.lastIndexOf(".");
		fname =
			dot > 0
				? `${wanted.slice(0, dot)}-${i}${wanted.slice(dot)}`
				: `${wanted}-${i}`;
		i++;
	}
	used?.add(fname);
	return `${dir}/${fname}`;
}

/**
 * Stream one HTTP upload body to the staging dir and return the {name, path} the
 * client echoes back in its next turn. Size cap enforced (the route rejects on
 * Content-Length first; this re-checks the actual bytes).
 */
export async function stageHttpUpload(
	name: string,
	req: Request,
): Promise<{ name: string; path: string }> {
	mkdirSync(STAGED_UPLOADS_DIR, { recursive: true });
	const wanted = sanitizeFilename(name);
	const p = uniqueUploadPath(STAGED_UPLOADS_DIR, wanted);
	const buf = Buffer.from(await req.arrayBuffer());
	if (buf.length === 0) throw new Error("empty upload");
	if (buf.length > MAX_UPLOAD_BYTES)
		throw new Error(
			`file too large (${buf.length} bytes, max ${MAX_UPLOAD_BYTES})`,
		);
	writeFileSync(p, buf);
	return { name: name || wanted, path: p };
}

/**
 * Turn normalized uploads into on-disk {name, path} pairs the agent can read.
 * Pre-staged refs (HTTP) are validated (confined to UPLOADS_DIR, exists, within
 * cap) and passed through; inline base64 is written to a per-session dir (outside
 * any repo, so it never pollutes git). Collisions de-duped, oversized skipped.
 */
function stageUploads(
	sessionId: string,
	uploads: ParsedUpload[],
): { name: string; path: string }[] {
	const dir = `${UPLOADS_DIR}/${sessionId}`;
	mkdirSync(dir, { recursive: true });
	const staged: { name: string; path: string }[] = [];
	const used = new Set<string>();
	for (const up of uploads) {
		if (up.kind === "staged") {
			if (!isWithinUploads(up.path) || !existsSync(up.path)) {
				console.warn(
					`[uploads] Dropping staged ref outside uploads dir: ${up.path}`,
				);
				continue;
			}
			let sz = 0;
			try {
				sz = statSync(up.path).size;
			} catch {
				continue;
			}
			if (sz === 0 || sz > MAX_UPLOAD_BYTES) {
				console.warn(`[uploads] Skipping ${up.name || up.path} — ${sz} bytes`);
				continue;
			}
			staged.push({
				name: up.name || up.path.split("/").pop() || "file",
				path: up.path,
			});
			continue;
		}
		const buf = Buffer.from(up.data, "base64");
		if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
			console.warn(
				`[uploads] Skipping ${up.name || "(unnamed)"} for ${sessionId} — ${buf.length} bytes`,
			);
			continue;
		}
		const wanted = sanitizeFilename(up.name);
		const p = uniqueUploadPath(dir, wanted, used);
		writeFileSync(p, buf);
		staged.push({ name: up.name || wanted, path: p });
	}
	return staged;
}

/** Append a note listing staged upload paths so the agent knows to read them. */
export function withUploadsNote(
	prompt: string,
	staged: { name: string; path: string }[],
): string {
	if (!staged.length) return prompt;
	const lines = staged.map((s) => `- ${s.name}: ${s.path}`).join("\n");
	return `${prompt}\n\n[The user attached ${staged.length} file(s), saved to disk — read them with your file tools if relevant:\n${lines}\n]`;
}

/** Parse + stage composer file attachments in one step; returns the prompt note-augmenter. */
export function stageFileAttachments(
	sessionId: string,
	raw?: unknown,
): { name: string; path: string }[] {
	const uploads = parseFileUploads(raw);
	if (!uploads) return [];
	return stageUploads(sessionId, uploads);
}
