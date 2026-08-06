/**
 * Static app shell assets: icons, service worker, splash images, hashed SPA assets, PWA manifest.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { existsSync } from "fs";
import type { RouteContext } from "./context";
import { configuredIntegration, configuredRepos, productName } from "../config";
import { FRONTEND_DIST, FRONTEND_SRC, devTailwindCss, frontend } from "../frontend-build";
import { isLocalProfile } from "../profile";

// GitHub owner avatars for the repo-icon route, fetched once and kept warm for
// a day. Avatar PNGs are public and served off GitHub's CDN (not the API
// quota); on a fetch failure we serve the stale copy so tiles don't flicker
// back to letter swatches when github.com hiccups.
const avatarCache = new Map<
	string,
	{ at: number; bytes: ArrayBuffer; type: string }
>();
const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;

async function ownerAvatar(
	owner: string,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
	const cached = avatarCache.get(owner);
	if (cached && Date.now() - cached.at < AVATAR_TTL_MS) return cached;
	try {
		const res = await fetch(
			`https://github.com/${encodeURIComponent(owner)}.png?size=128`,
			{ redirect: "follow", signal: AbortSignal.timeout(5000) },
		);
		if (!res.ok) return cached ?? null;
		const entry = {
			at: Date.now(),
			bytes: await res.arrayBuffer(),
			type: res.headers.get("content-type") || "image/png",
		};
		avatarCache.set(owner, entry);
		return entry;
	} catch {
		return cached ?? null;
	}
}

/** A tile icon that lives on disk, or undefined when the file isn't there. */
function localIcon(iconPath: string): Response | undefined {
	if (!existsSync(iconPath)) return undefined;
	return new Response(Bun.file(iconPath), {
		headers: {
			"Content-Type": "image/png",
			// These are editable assets: a day-long hard cache pins a redrawn
			// icon on every client that already fetched it.
			"Cache-Control": "public, max-age=3600, must-revalidate",
		},
	});
}

export async function handleStaticAssetsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	// Local servers proxy the hosted shell and every matching asset so the Mac
	// app never runs frontend code from a stale checkout.
	if (isLocalProfile()) return undefined;

	const { req, url, path, publicPrefix } = ctx;

	// Dev-mode Tailwind sheet. In prod the utilities ride in the built bundle
	// as a hashed asset and index.html links it directly; under
	// OPENSESSION_DEV=1 the UI comes from Bun's HMR server, which can't compile
	// Tailwind — index.html's bootstrap script requests this instead when it
	// finds no hashed sheet. 404 in prod, so the request never happens twice.
	if (path === "/tailwind.css" && req.method === "GET") {
		const css = await devTailwindCss();
		if (!css) return new Response("Not found", { status: 404 });
		return new Response(css, {
			headers: {
				"Content-Type": "text/css; charset=utf-8",
				// Recompiled on every frontend edit — never let a reload keep an
				// old sheet.
				"Cache-Control": "no-store",
			},
		});
	}

	// App icons (red yin-yang, gen by scripts/gen-icons.py) — real PNGs so iOS home-screen and PWA installs
	// pick them up; data-URI apple-touch-icons don't work on iOS. Short cache
	// + must-revalidate so a refreshed design isn't pinned by a stale copy.
	const iconFiles: Record<string, string> = {
		"/apple-touch-icon.png": `${FRONTEND_SRC}/apple-touch-icon.png`, // 180×180
		"/icon-192.png": `${FRONTEND_SRC}/icon-192.png`,
		"/icon.png": `${FRONTEND_SRC}/icon.png`, // 512×512
		"/mac-app-icon.png": `${FRONTEND_SRC}/../../os1-mac/build/icon-512.png`,
	};
	if (iconFiles[path]) {
		return new Response(
			Bun.file(iconFiles[path]),
			{
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=3600, must-revalidate",
				},
			},
		);
	}

	// Per-repo icons for the RepoTile UI: a repo's configured `icon` PNG when
	// set, else its owner's local mark, else the repo's GitHub org avatar,
	// fetched server-side and cached. Unregistered ids 404 — the client falls
	// back to its colored letter tile.
	//
	// Every icon served from src/frontend is drawn to the same proportions
	// (artwork on ~80% of a square canvas, corners rounded to match the tile's
	// own clip), because nothing downstream can normalize them: the tiles sit
	// side by side in the sidebar, in the phone app and in the PWA, and a mark
	// with more built-in padding than its neighbour just reads as a smaller
	// icon. Keep new icons on those proportions.
	const repoIcon = path.match(/^\/repo-icon\/([\w.-]+)\.png$/);
	if (repoIcon && req.method === "GET") {
		const id = repoIcon[1];
		// Feed bands (the feeds design) and the Plain project band ride the
		// same tile pipeline: any `<id>-icon.png` dropped in src/frontend
		// serves generically.
		if (/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) {
			const generic = localIcon(`${FRONTEND_SRC}/${id}-icon.png`);
			if (generic) return generic;
		}
		// A repo's optional `icon` (absolute path, or relative to its checkout)
		// overrides the owner and org-avatar defaults below.
		const repo = configuredRepos()[id];
		if (repo?.icon) {
			const configured = localIcon(
				repo.icon.startsWith("/") ? repo.icon : `${repo.repo}/${repo.icon}`,
			);
			if (configured) return configured;
		}
		const owner = repo?.ghRepo?.split("/")[0];
		if (!owner) return new Response("Not found", { status: 404 });
		// An owner's own mark, as `owner-<owner>-icon.png`. Worth having
		// because a GitHub avatar is uploaded art with whatever padding its
		// author chose — tellahq's leaves 38% of its canvas empty — so the
		// repos that fall through to it would wear tiles that read smaller
		// than every icon beside them.
		if (/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner)) {
			const ownerIcon = localIcon(`${FRONTEND_SRC}/owner-${owner}-icon.png`);
			if (ownerIcon) return ownerIcon;
		}
		const icon = await ownerAvatar(owner);
		if (!icon) return new Response("Not found", { status: 404 });
		return new Response(icon.bytes, {
			headers: {
				"Content-Type": icon.type,
				"Cache-Control": "public, max-age=86400",
			},
		});
	}

	// Service worker (Web Push + app-shell cache). Must precede the hashed-asset
	// matcher — sw.js is served from source, never cached hard (the browser
	// refetches it on its own schedule and applies updates).
	if (path === "/sw.js") {
		return new Response(Bun.file(`${FRONTEND_SRC}/sw.js`), {
			headers: {
				"Content-Type": "text/javascript; charset=utf-8",
				"Cache-Control": "no-cache",
				// Scope follows the prefix this registration lives under.
				"Service-Worker-Allowed": `${publicPrefix}/`,
			},
		});
	}

	// iOS PWA launch images (apple-touch-startup-image). One PNG per device
	// resolution, generated by scripts/gen-splash.py. Filename is locked to the
	// apple-splash-<w>-<h>.png pattern so the path can't escape the folder.
	const splashMatch = path.match(
		/^\/splash\/(apple-splash-\d+-\d+\.png)$/,
	);
	if (splashMatch) {
		return new Response(
			Bun.file(`${FRONTEND_SRC}/splash/${splashMatch[1]}`),
			{
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=86400",
				},
			},
		);
	}

	// ghostty-web's WASM VT engine (the Shell tab's terminal). buildFrontend
	// copies it into FRONTEND_DIST; application/wasm keeps
	// WebAssembly.instantiateStreaming happy. Stable (unhashed) name — the
	// shell requests a fixed path — so revalidate instead of immutable.
	if (path === "/ghostty-vt.wasm") {
		const wasm = Bun.file(`${FRONTEND_DIST}/ghostty-vt.wasm`);
		if (await wasm.exists()) {
			return new Response(wasm, {
				headers: {
					"Content-Type": "application/wasm",
					"Cache-Control": "public, max-age=3600, must-revalidate",
				},
			});
		}
	}

	// Built SPA assets (prod only). Content-hashed filenames → cache forever.
	// Served gzipped (computed once, then memoised) since the JS is large.
	const assetMatch =
		frontend && path.match(/^\/([\w.-]+\.(?:js|css|map))$/);
	if (assetMatch && frontend) {
		const name = assetMatch[1];
		const file = Bun.file(`${FRONTEND_DIST}/${name}`);
		if (await file.exists()) {
			const type = name.endsWith(".css")
				? "text/css"
				: name.endsWith(".map")
					? "application/json"
					: "text/javascript";
			const headers: Record<string, string> = {
				"Content-Type": `${type}; charset=utf-8`,
				"Cache-Control": "public, max-age=31536000, immutable",
			};
			if ((req.headers.get("accept-encoding") || "").includes("gzip")) {
				let gz = frontend.gzip.get(name);
				if (!gz) {
					gz = new Blob([
						Bun.gzipSync(new Uint8Array(await file.arrayBuffer())),
					]);
					frontend.gzip.set(name, gz);
				}
				headers["Content-Encoding"] = "gzip";
				headers["Vary"] = "Accept-Encoding";
				return new Response(gz, { headers });
			}
			return new Response(file, { headers });
		}
	}
	if (path === "/manifest.webmanifest") {
		return Response.json(
			{
				name: productName(),
				short_name: productName(),
				// Per-prefix PWA identity: installs from the legacy /backstage
				// pages keep their identity; /opensession installs get the new
				// start_url. One re-install event max, never a broken one.
				start_url: `${publicPrefix}/`,
				display: "standalone",
				// On desktop, take over the OS titlebar: the window controls
				// overlay our own chrome instead of a separate OS bar with a
				// centered title. Falls back to plain standalone where WCO
				// isn't supported (iOS, older browsers). CSS handles the
				// controls inset + drag region under (display-mode:
				// window-controls-overlay).
				display_override: ["window-controls-overlay"],
				background_color: "#0b0809",
				theme_color: "#0b0809",
				icons: [
					{
						src: `${publicPrefix}/icon-192.png?v=4`,
						sizes: "192x192",
						type: "image/png",
						purpose: "any",
					},
					{
						src: `${publicPrefix}/icon.png?v=4`,
						sizes: "512x512",
						type: "image/png",
						purpose: "any",
					},
				],
			},
			{ headers: { "Content-Type": "application/manifest+json" } },
		);
	}

	// Universal links for the OS¹ desktop app (tellahq/os1-mac): lets plain
	// https://os.tella.dev/… links open the app once it's signed with the
	// associated-domains entitlement. Both spec locations, since Apple has
	// probed the bare path historically. Caveat: os.tella.dev resolves to a
	// tailnet IP, so Apple's AASA CDN can't fetch this — team devices need the
	// entitlement's `?mode=developer` alternate (direct fetch) for links to
	// activate; harmless for everyone else.
	if (
		path === "/.well-known/apple-app-site-association" ||
		path === "/apple-app-site-association"
	) {
		const configuredIds = configuredIntegration("clients").appleAppIds;
		const appIDs = Array.isArray(configuredIds)
			? configuredIds.filter((id): id is string => typeof id === "string")
			: [];
		return Response.json(
			{
				applinks: {
					apps: [],
					details: [
						{
							appIDs,
							components: [{ "/": "/*" }],
						},
					],
				},
			},
			{ headers: { "Cache-Control": "public, max-age=3600" } },
		);
	}

	return undefined;
}
