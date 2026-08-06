/**
 * In-process prod SPA bundle: build (or rebuild) the frontend without a
 * process restart, so a CSS/frontend change never interrupts a live run.
 * Serving stays in the HTTP layer; this module owns the bundle state
 * (globalThis-parked, mutated in place) and the debounced rebuild.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "path";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { activeRunRecords } from "./run-journal";
import { writeFileAtomic } from "./shared/atomic-write";
import { broadcastToAll } from "./ws-hub";
import { isLocalProfile } from "./profile";
import { configuredServer, defaultRepo, githubBotLogins, personaName, plainWorkspaceId, productMark, productName } from "./config";

const g = globalThis as any;

export const IS_DEV = process.env.OPENSESSION_DEV === "1";
const REPO_ROOT = join(import.meta.dir, "..", "..");
export const FRONTEND_DIST = join(REPO_ROOT, ".frontend-dist");
export const FRONTEND_SRC = join(REPO_ROOT, "src", "frontend");

export type FrontendBundle = {
	indexHtml: string;
	gzip: Map<string, Blob>;
	version: string;
};

/**
 * Compile src/frontend/styles/tailwind.css with the real Tailwind CLI. Bun
 * cannot compile Tailwind, so this subprocess (~100ms) is the only way to get
 * the utilities layer — in the prod bundle AND in dev, where the UI is served
 * by Bun's HMR server and therefore had NO utilities at all until 2026-08-05
 * (Home, the composer and every Tailwind-styled component rendered unstyled,
 * which reads as a broken app rather than a missing stylesheet).
 * Throws on a failed compile; callers decide how to fail soft.
 */
async function compileTailwind(outPath: string): Promise<string> {
	mkdirSync(dirname(outPath), { recursive: true });
	const proc = Bun.spawn(
		[
			`${REPO_ROOT}/node_modules/.bin/tailwindcss`,
			"-i",
			`${FRONTEND_SRC}/styles/tailwind.css`,
			"-o",
			outPath,
			"--minify",
		],
		{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
	);
	if ((await proc.exited) !== 0) {
		throw new Error(await new Response(proc.stderr).text());
	}
	return await Bun.file(outPath).text();
}

// Dev-mode utilities sheet, compiled on first request and cached until a
// frontend edit invalidates it (scheduleFrontendRebuild). Prod never uses
// this path — there the hashed sheet is part of the built bundle.
let devTailwind: string | null = null;

/** The dev-mode Tailwind sheet, or null in prod / on a failed compile. */
export async function devTailwindCss(): Promise<string | null> {
	if (!IS_DEV || isLocalProfile()) return null;
	if (devTailwind !== null) return devTailwind;
	try {
		devTailwind = await compileTailwind(`${FRONTEND_DIST}/.tailwind-dev.css`);
		return devTailwind;
	} catch (e) {
		console.error("[frontend] Tailwind (dev) build FAILED:", e);
		return null;
	}
}

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

	// Bun 1.3.14's CSS minifier strips the space after var(...) and breaks the
	// .panel-overlay / .sidebar-overlay inset (and a few color-mix percentages),
	// which knocks out the mobile overlay layer. Bypass it: write the source CSS
	// unmodified with a content-hashed name and serve it ourselves.
	let cssSrc = await Bun.file(`${FRONTEND_SRC}/styles/global.css`).text();
	// xterm stylesheet (the Shell tab) rides along in the same file, vendored
	// straight from the installed package so it can't drift from the JS.
	try {
		const xtermCss = await Bun.file(
			`${REPO_ROOT}/node_modules/@xterm/xterm/css/xterm.css`,
		).text();
		cssSrc += `\n\n/* ── vendored @xterm/xterm/css/xterm.css (Shell tab) ── */\n${xtermCss}`;
	} catch {}
	const cssHash = Bun.hash(cssSrc).toString(36);
	const cssName = `global-${cssHash}.css`;
	// Atomic: a mid-write bundle file has shipped corrupt before ("useState is
	// not defined") — never serve a torn asset.
	writeFileAtomic(`${FRONTEND_DIST}/${cssName}`, cssSrc);

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

	// Tailwind pass (see styles/tailwind.css). Bun can't compile Tailwind, so
	// the real compiler runs as a subprocess (~50ms); its lightningcss minifier
	// doesn't have the var() bug above. Linked after global.css so utilities win
	// source-order ties against legacy rules. Fail-soft: a broken Tailwind
	// compile ships the bundle without utilities rather than taking down the
	// whole server (this build also runs at boot, before Bun.serve).
	let twName: string | null = null;
	try {
		const twCss = await compileTailwind(`${FRONTEND_DIST}/.tailwind-build.css`);
		twName = `tailwind-${Bun.hash(twCss).toString(36)}.css`;
		writeFileAtomic(`${FRONTEND_DIST}/${twName}`, twCss);
	} catch (e) {
		console.error(
			"[frontend] Tailwind build FAILED — serving without utilities:",
			e,
		);
	}

	let indexHtml = await Bun.file(`${FRONTEND_SRC}/index.html`).text();
	const instance = JSON.stringify({
		productName: productName(),
		productMark: productMark(),
		personaName: personaName(),
		publicBaseUrl: configuredServer().publicBaseUrl,
		githubBotLogins: githubBotLogins(),
		defaultRepoId: defaultRepo().id,
		plainWorkspaceId: plainWorkspaceId() || undefined,
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
	// The literals below are the default wordmark as it appears in
	// src/frontend/index.html (title + apple-mobile-web-app/og/twitter titles).
	// Keep them byte-identical to that file: a mismatch silently ships the
	// default name instead of the instance's configured one.
	indexHtml = indexHtml
		.replaceAll("<title>Open Session</title>", `<title>${htmlProductName}</title>`)
		.replaceAll('content="Open Session"', `content="${htmlProductName}"`);
	indexHtml = indexHtml.replace(
		'<script type="module" src="./App.tsx"></script>',
		`<script type="module" crossorigin src="/${entryName}"></script>`,
	);
	const twLink = twName
		? `\n  <link rel="stylesheet" href="/${twName}">`
		: "";
	// Inject before the LAST head close: the first "</head>" in the source can
	// legitimately appear inside inline-script comment text (2026-08-05: a
	// comment literal ate the stylesheet links and broke the boot script).
	const headClose = indexHtml.lastIndexOf("</head>");
	indexHtml =
		indexHtml.slice(0, headClose) +
		`  <link rel="stylesheet" href="/${cssName}">${twLink}\n` +
		indexHtml.slice(headClose);
	const version = `${entryName}|${cssName}|${twName ?? "no-tw"}`;

	const store: FrontendBundle = (g.__opensessionFrontend ??= {
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
			JSON.stringify({ inputsHash, version, indexHtml, assets: [entryName, cssName, twName].filter(Boolean) }),
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
		const store: FrontendBundle = (g.__opensessionFrontend ??= {
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

if (!IS_DEV && !isLocalProfile() && !g.__opensessionFrontend) {
	if (!tryReuseFrontendDist()) {
		console.log("Building frontend (split + minified)…");
		await buildFrontend();
	}
}

export const frontend: FrontendBundle | null = IS_DEV
	? null
	: isLocalProfile()
		? null
		: (g.__opensessionFrontend as FrontendBundle);

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
		const raw = readFileSync(join(OPENSESSION_SESSIONS_DIR, `${id}.json`), "utf8");
		const title = JSON.parse(raw)?.title;
		return typeof title === "string" && title.trim()
			? title.trim().slice(0, 60)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Best-effort "who caused this" label for update/restart notices. Open Session
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
			const title = sessionTitle(run.osSessionId);
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
// file-watch, a SIGUSR2 signal, or POST /api/rebuild-frontend — all of
// which replace the "systemctl restart to see my CSS change" habit that was
// interrupting every live Claude run. Clients get a non-intrusive refresh toast;
// the bundle is served from the mutated `frontend` object with no restart.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildInFlight = false;
// The shared checkout means agents save half-finished edits constantly; every
// save while the tree is broken re-fails the build. Broadcasting each failure
// storms every connected client with identical toasts, so failures are keyed
// by their error text and only a NEW error is announced; success clears the key.
let lastBuildErrorKey: string | null = null;
let lastAutoInstallAt = 0;
const AUTO_INSTALL_COOLDOWN_MS = 5 * 60_000;

/** Pull the human-readable cause out of Bun.build's AggregateError. */
function buildFailureSummary(e: unknown): {
	key: string;
	summary: string;
	needsInstall: boolean;
} {
	const msgs: string[] = [];
	let file: string | undefined;
	if (e instanceof AggregateError) {
		for (const err of e.errors ?? []) {
			const m = String((err as { message?: string })?.message ?? err).trim();
			if (m) msgs.push(m);
			const pos = (err as { position?: { file?: string } })?.position;
			if (!file && pos?.file) file = String(pos.file);
		}
	}
	if (!msgs.length) msgs.push(String(e).split("\n")[0] ?? "unknown error");
	const needsInstall = msgs.some((m) => m.includes('"bun install"'));
	const shortFile = file?.split("/").pop();
	const summary = `${shortFile ? `${shortFile}: ` : ""}${msgs[0]}${msgs.length > 1 ? ` (+${msgs.length - 1} more)` : ""}`;
	return { key: msgs.join("\n"), summary, needsInstall };
}

/** Missing-package failures (a session touched package.json without installing,
 *  or a dep gained a new subpath) are self-healable: install once, rebuild. */
async function autoInstallAndRetry(): Promise<void> {
	console.log(
		"[frontend] Build failed on unresolved imports — running bun install, then retrying",
	);
	try {
		const proc = Bun.spawn(["bun", "install"], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		if ((await proc.exited) === 0) {
			scheduleFrontendRebuild("post-bun-install", 100);
		} else {
			console.error(
				"[frontend] bun install failed:",
				await new Response(proc.stderr).text(),
			);
		}
	} catch (e) {
		console.error("[frontend] bun install failed:", e);
	}
}

export function scheduleFrontendRebuild(reason: string, debounceMs = 300): void {
	if (IS_DEV) {
		// Dev serves JS/CSS through Bun's HMR server; only the Tailwind sheet is
		// ours to keep fresh, so drop it and let the next request recompile.
		devTailwind = null;
		return;
	}
	if (!frontend) return;
	if (rebuildTimer) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(async () => {
		rebuildTimer = null;
		if (rebuildInFlight) return scheduleFrontendRebuild(reason, 300); // coalesce
		rebuildInFlight = true;
		const before = frontend.version;
		try {
			const version = await buildFrontend();
			lastBuildErrorKey = null;
			if (version !== before) {
				const by = sharedCheckoutEditors(true);
				console.log(
					`[frontend] Rebuilt (${reason}); notifying clients (v=${version}${by ? `, by ${by}` : ""})`,
				);
				broadcastToAll({ type: "frontend_updated", version, ...(by ? { by } : {}) });
			}
		} catch (e) {
			console.error(`[frontend] Rebuild failed (${reason}):`, e);
			const fail = buildFailureSummary(e);
			if (fail.key !== lastBuildErrorKey) {
				lastBuildErrorKey = fail.key;
				broadcastToAll({
					type: "notice",
					message: "App update paused. No action needed.",
				});
			}
			if (fail.needsInstall && Date.now() - lastAutoInstallAt > AUTO_INSTALL_COOLDOWN_MS) {
				lastAutoInstallAt = Date.now();
				void autoInstallAndRetry();
			}
		} finally {
			rebuildInFlight = false;
		}
	}, debounceMs);
}
