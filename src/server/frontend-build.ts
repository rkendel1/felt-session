/**
 * In-process prod SPA bundle: build (or rebuild) the frontend without a
 * process restart, so a CSS/frontend change never interrupts a live run.
 * Serving stays in the HTTP layer; this module owns the bundle state
 * (globalThis-parked, mutated in place) and the debounced rebuild.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "path";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { envAlias } from "./rename-compat";
import { activeRunRecords } from "./run-journal";
import { writeFileAtomic } from "./shared/atomic-write";
import { broadcastToAll } from "./ws-hub";
import { isLocalProfile } from "./profile";
import { configuredServer, defaultRepo, githubBotLogins, personaName, productMark, productName } from "./config";

const g = globalThis as any;

export const IS_DEV = envAlias("OPENSESSION_DEV", "BACKSTAGE_DEV") === "1";
const REPO_ROOT = join(import.meta.dir, "..", "..");
export const FRONTEND_DIST = join(REPO_ROOT, ".frontend-dist");
export const FRONTEND_SRC = join(REPO_ROOT, "src", "frontend");

export type FrontendBundle = {
	indexHtml: string;
	gzip: Map<string, Blob>;
	version: string;
};

// Build (or rebuild) the prod SPA bundle in-process. The result object on
// globalThis is MUTATED in place (never reassigned) so the long-lived `frontend`
// reference + route closures pick up a rebuild without a process restart —
// which is the whole point: a CSS/frontend change no longer needs a `systemctl
// restart` that would interrupt every in-flight Claude run. `version` changes
// whenever the entry or CSS hash changes, so clients know to refresh.
export async function buildFrontend(): Promise<string> {
	if (isLocalProfile()) {
		throw new Error("Local profile uses the hosted frontend");
	}
	// Stamped before the build so edits landing mid-build hash as "changed" on
	// the next boot rather than being masked by a post-build stamp.
	const inputsHash = frontendInputsHash();
	const result = await Bun.build({
		entrypoints: [`${FRONTEND_SRC}/App.tsx`],
		outdir: FRONTEND_DIST,
		minify: true,
		splitting: true,
		sourcemap: "none",
		// Root-relative assets: the app is served at the bare domain root
		// (os.tella.dev); old /opensession + /backstage page URLs 301 there, and
		// prefixed asset requests still normalize in the fetch preamble.
		publicPath: "/",
		naming: {
			entry: "[name]-[hash].[ext]",
			chunk: "[name]-[hash].[ext]",
			asset: "[name]-[hash].[ext]",
		},
	});
	if (!result.success) {
		throw new AggregateError(result.logs, "frontend build failed");
	}
	// Bun's HTML-entry splitting mis-points the bootstrap <script> at a leaf
	// chunk, so we build the JS entry and stitch index.html ourselves: keep the
	// source shell (icons, splash, manifest links) and point it at the hashed
	// entry + the extracted CSS.
	const entry = result.outputs.find((o) => o.kind === "entry-point");
	if (!entry) throw new Error("frontend build produced no entry point");
	const entryName = entry.path.split("/").pop()!;

	// ghostty-web's WASM VT engine (the Shell tab's terminal) rides along too:
	// the bundled chunk can't resolve the package-relative wasm, so it's copied
	// out and served at a stable name (static-assets.ts; the shell passes the
	// explicit path to Ghostty.load, with an xterm.js fallback if this fails).
	try {
		const tmp = `${FRONTEND_DIST}/.ghostty-vt.wasm.tmp`;
		await Bun.write(
			tmp,
			Bun.file(`${REPO_ROOT}/node_modules/ghostty-web/dist/ghostty-vt.wasm`),
		);
		renameSync(tmp, `${FRONTEND_DIST}/ghostty-vt.wasm`);
	} catch (e) {
		console.error(
			"[frontend] ghostty-vt.wasm copy failed — Shell falls back to xterm.js:",
			e,
		);
	}

	// Tailwind owns the complete stylesheet (see styles/tailwind.css). Bun can't
	// compile it, so the real compiler runs as a subprocess. A CSS failure must
	// fail the rebuild now: there is no second legacy sheet to fall back to.
	let twName: string;
	try {
		const twTmp = `${FRONTEND_DIST}/.tailwind-build.css`;
		const twProc = Bun.spawn(
			[
				`${REPO_ROOT}/node_modules/.bin/tailwindcss`,
				"-i",
				`${FRONTEND_SRC}/styles/tailwind.css`,
				"-o",
				twTmp,
				"--minify",
			],
			{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		if ((await twProc.exited) !== 0) {
			throw new Error(await new Response(twProc.stderr).text());
		}
		let twCss = await Bun.file(twTmp).text();
		// The Shell tab's xterm stylesheet is vendored from the installed package
		// so its CSS cannot drift from the JS version.
		try {
			const xtermCss = await Bun.file(
				`${REPO_ROOT}/node_modules/@xterm/xterm/css/xterm.css`,
			).text();
			twCss += `\n\n/* vendored @xterm/xterm/css/xterm.css */\n${xtermCss}`;
		} catch {}
		twName = `tailwind-${Bun.hash(twCss).toString(36)}.css`;
		writeFileAtomic(`${FRONTEND_DIST}/${twName}`, twCss);
	} catch (e) {
		console.error("[frontend] Tailwind build FAILED:", e);
		throw e;
	}

	let indexHtml = await Bun.file(`${FRONTEND_SRC}/index.html`).text();
	const instance = JSON.stringify({
		productName: productName(),
		productMark: productMark(),
		personaName: personaName(),
		publicBaseUrl: configuredServer().publicBaseUrl,
		githubBotLogins: githubBotLogins(),
		defaultRepoId: defaultRepo().id,
	}).replace(/</g, "\\u003c");
	const htmlProductName = productName()
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	indexHtml = indexHtml.replace(
		"window.__OPENSESSION_INSTANCE__ = window.__OPENSESSION_INSTANCE__ || {};",
		`window.__OPENSESSION_INSTANCE__ = ${instance};`,
	);
	indexHtml = indexHtml
		.replaceAll("<title>OpenSession</title>", `<title>${htmlProductName}</title>`)
		.replaceAll('content="OpenSession"', `content="${htmlProductName}"`);
	indexHtml = indexHtml.replace(
		'<script type="module" src="./App.tsx"></script>',
		`<script type="module" crossorigin src="/${entryName}"></script>`,
	);
	indexHtml = indexHtml.replace(
		"</head>",
		`  <link rel="stylesheet" href="/${twName}">\n</head>`,
	);
	const version = `${entryName}|${twName}`;

	const store: FrontendBundle = (g.__backstageFrontend ??= {
		indexHtml: "",
		gzip: new Map<string, Blob>(),
		version: "",
	});
	store.indexHtml = indexHtml;
	store.gzip.clear(); // stale gzipped blobs were keyed by the old hashed names
	store.version = version;
	try {
		writeFileAtomic(
			BUNDLE_META,
			JSON.stringify({ inputsHash, version, indexHtml, assets: [entryName, twName] }),
		);
	} catch {}
	console.log(
		`Frontend built: ${result.outputs.length} files → ${FRONTEND_DIST} (v=${version})`,
	);
	return version;
}

// ── Boot-time build skip ─────────────────────────────────────────────────────
// The bundle only depends on src/frontend/**, bun.lock (vendored xterm css /
// ghostty wasm / the tailwind compiler all live in node_modules) and the Bun
// version — verified: no frontend import reaches outside src/frontend. When
// none of that changed since the last build, boot reuses .frontend-dist
// instead of paying the ~3.5s rebuild; every restart used to eat it even with
// zero frontend changes. The in-process watcher still rebuilds on any edit.

const BUNDLE_META = join(FRONTEND_DIST, ".bundle-meta.json");

function frontendInputsHash(): string {
	const parts: string[] = [
		`bun:${Bun.version}`,
		`instance:${productName()}:${productMark()}:${personaName()}:${configuredServer().publicBaseUrl}:${githubBotLogins().join(",")}:${defaultRepo().id}`,
	];
	try {
		const lock = statSync(join(REPO_ROOT, "bun.lock"));
		parts.push(`lock:${lock.mtimeMs}:${lock.size}`);
	} catch {}
	const entries = readdirSync(FRONTEND_SRC, { recursive: true, withFileTypes: true });
	for (const e of entries) {
		if (!e.isFile()) continue;
		const p = join((e as { parentPath?: string }).parentPath ?? String((e as { path?: string }).path ?? FRONTEND_SRC), e.name);
		try {
			const s = statSync(p);
			parts.push(`${p}:${s.mtimeMs}:${s.size}`);
		} catch {}
	}
	parts.sort();
	return Bun.hash(parts.join("\n")).toString(36);
}

/** Rehydrate the served bundle from an unchanged .frontend-dist. False on any
 *  doubt (missing meta, hash drift, missing asset file) → caller rebuilds. */
function tryReuseFrontendDist(): boolean {
	try {
		const meta = JSON.parse(readFileSync(BUNDLE_META, "utf8")) as {
			inputsHash?: string;
			version?: string;
			indexHtml?: string;
			assets?: string[];
		};
		if (!meta.inputsHash || !meta.version || !meta.indexHtml) return false;
		if (meta.inputsHash !== frontendInputsHash()) return false;
		for (const a of meta.assets ?? []) {
			if (!existsSync(join(FRONTEND_DIST, a))) return false;
		}
		const store: FrontendBundle = (g.__backstageFrontend ??= {
			indexHtml: "",
			gzip: new Map<string, Blob>(),
			version: "",
		});
		store.indexHtml = meta.indexHtml;
		store.gzip.clear();
		store.version = meta.version;
		console.log(`Frontend bundle unchanged — reusing ${FRONTEND_DIST} (v=${meta.version})`);
		return true;
	} catch {
		return false;
	}
}

if (!IS_DEV && !isLocalProfile() && !g.__backstageFrontend) {
	if (!tryReuseFrontendDist()) {
		console.log("Building frontend (split + minified)…");
		await buildFrontend();
	}
}

export const frontend: FrontendBundle | null = IS_DEV
	? null
	: isLocalProfile()
		? null
		: (g.__backstageFrontend as FrontendBundle);

export const SPA_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy": "frame-ancestors 'none'",
	"X-Frame-Options": "DENY",
};

// SPA entry: the HMR bundle in dev, the prebuilt index.html in prod. Reads
// `frontend.indexHtml` fresh on each request so an in-process rebuild is served
// immediately (the object is mutated, not replaced).
const homepage = IS_DEV && !isLocalProfile()
	? (await import("../frontend/index.html")).default
	: null;

export const spaEntry = frontend
	? () =>
			new Response(frontend.indexHtml, {
				headers: SPA_HEADERS,
			})
	: homepage ?? (() => new Response("Hosted frontend unavailable", { status: 503 }));

function sessionTitle(id: string | undefined): string | undefined {
	if (!id) return undefined;
	try {
		const raw = readFileSync(join(OPENSESSION_CHATS_DIR, `${id}.json`), "utf8");
		const title = JSON.parse(raw)?.title;
		return typeof title === "string" && title.trim()
			? title.trim().slice(0, 60)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Best-effort "who caused this" label for update/restart notices. Backstage
 * sessions all work in THIS shared checkout, so when the file-watch fires (or
 * a session runs `systemctl restart`), the culprit is an in-flight run whose
 * cwd is this checkout — the run journal knows those, with user + session id.
 * Edits from a CLI/tmux Claude or a human editor aren't journaled here, so no
 * candidates → undefined, never a guess. `writeCapableOnly` skips ask-mode
 * runs (they have no Write/Edit, so they can't have fired the file-watch).
 */
export function sharedCheckoutEditors(writeCapableOnly = false): string | undefined {
	try {
		const checkout = resolve(REPO_ROOT);
		const labels: string[] = [];
		const seen = new Set<string>();
		for (const run of activeRunRecords()) {
			if (!run.cwd || resolve(run.cwd) !== checkout) continue;
			if (writeCapableOnly && run.mode === "ask") continue;
			const user = (run.user || "").trim();
			const title = sessionTitle(run.bksSessionId);
			const label = user && title ? `${user} · ${title}` : user || title || "";
			if (!label || seen.has(label)) continue;
			seen.add(label);
			labels.push(label);
		}
		if (!labels.length) return undefined;
		const shown = labels.slice(0, 2).join(", ");
		return labels.length > 2 ? `${shown} +${labels.length - 2}` : shown;
	} catch {
		return undefined;
	}
}

// Debounced in-process rebuild + client nudge. Triggered by the frontend
// file-watch, a SIGUSR2 signal, or POST /backstage/api/rebuild-frontend — all of
// which replace the "systemctl restart to see my CSS change" habit that was
// interrupting every live Claude run. Clients get a non-intrusive refresh toast;
// the bundle is served from the mutated `frontend` object with no restart.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildInFlight = false;
export function scheduleFrontendRebuild(reason: string, debounceMs = 300): void {
	if (IS_DEV || !frontend) return;
	if (rebuildTimer) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(async () => {
		rebuildTimer = null;
		if (rebuildInFlight) return scheduleFrontendRebuild(reason, 300); // coalesce
		rebuildInFlight = true;
		const before = frontend.version;
		try {
			const version = await buildFrontend();
			if (version !== before) {
				const by = sharedCheckoutEditors(true);
				console.log(
					`[frontend] Rebuilt (${reason}); notifying clients (v=${version}${by ? `, by ${by}` : ""})`,
				);
				broadcastToAll({ type: "frontend_updated", version, ...(by ? { by } : {}) });
			}
		} catch (e) {
			console.error(`[frontend] Rebuild failed (${reason}):`, e);
			broadcastToAll({
				type: "notice",
				message: `Frontend rebuild failed — see logs. (${e})`,
			});
		} finally {
			rebuildInFlight = false;
		}
	}, debounceMs);
}
