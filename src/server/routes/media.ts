/**
 * Inline media streaming for OPENSESSION_VIDEO markers + composer-upload downloads.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { isWithinUploads } from "../uploads";
import { resolveLegacySessionsPath } from "../paths";
const HOME = process.env.HOME || "";

export async function handleMediaRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Stream a local media file referenced by a `OPENSESSION_VIDEO:` marker in a
	// tool's output, so the session viewer can play it inline (tools can't return
	// video blocks the way Read returns images). Path-scoped: absolute path under
	// /tmp or the service user's home, no traversal, known media extension. Range-enabled
	// so the <video> scrubber can seek.
	if (path === "/media" && req.method === "GET") {
		// Records written before the session store was renamed carry absolute
		// paths under its old name, and the URLs built from them outlive the
		// rename in PR descriptions and old transcripts — so resolve those onto
		// the active store before anything else looks at the path.
		const mediaPath = resolveLegacySessionsPath(
			url.searchParams.get("path") || "",
		);
		const mediaTypes: Record<string, string> = {
			".mp4": "video/mp4",
			".webm": "video/webm",
			".mov": "video/quicktime",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
		};
		const ext = mediaPath.slice(mediaPath.lastIndexOf(".")).toLowerCase();
		const scoped =
			mediaPath.startsWith("/tmp/") ||
			(!!HOME && mediaPath.startsWith(`${HOME}/`));
		// Non-media extensions are servable ONLY from the composer-uploads dir
		// (as a download) — anything wider would make this a read-any-file-on-
		// the-box endpoint (tokens live in dotfiles and json configs).
		const isUploadDownload = !mediaTypes[ext] && isWithinUploads(mediaPath);
		if (
			!mediaPath.startsWith("/") ||
			mediaPath.includes("..") ||
			!scoped ||
			(!mediaTypes[ext] && !isUploadDownload)
		) {
			return new Response("forbidden", { status: 403 });
		}
		const file = Bun.file(mediaPath);
		if (!(await file.exists()))
			return new Response("not found", { status: 404 });

		const type = mediaTypes[ext] || "application/octet-stream";
		const size = file.size;
		const range = req.headers.get("range");
		const baseHeaders: Record<string, string> = {
			"Content-Type": type,
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, max-age=60",
			...(isUploadDownload
				? {
						"Content-Disposition": `attachment; filename="${mediaPath
							.split("/")
							.pop()
							?.replace(/[^\w. -]/g, "_")}"`,
					}
				: {}),
		};
		if (range) {
			const m = range.match(/bytes=(\d*)-(\d*)/);
			let start = m && m[1] ? parseInt(m[1], 10) : 0;
			let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
			if (Number.isNaN(start) || start < 0) start = 0;
			if (Number.isNaN(end) || end >= size) end = size - 1;
			if (start > end) {
				return new Response("range not satisfiable", {
					status: 416,
					headers: { "Content-Range": `bytes */${size}` },
				});
			}
			return new Response(file.slice(start, end + 1), {
				status: 206,
				headers: {
					...baseHeaders,
					"Content-Range": `bytes ${start}-${end}/${size}`,
					"Content-Length": String(end - start + 1),
				},
			});
		}
		return new Response(file, {
			headers: { ...baseHeaders, "Content-Length": String(size) },
		});
	}

	return undefined;
}
