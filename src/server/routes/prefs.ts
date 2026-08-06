/**
 * Per-user/system preferences: Web Push, warm preview templates, memory stores, pinned tabs, UI prefs, tab colors.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { frontend } from "../frontend-build";
import { getPins as getUserPins, setPins as setUserPins } from "../pins";
import { getReads as getUserReads, setReads as setUserReads } from "../reads";
import { addSessionMemory, describeScope, forgetSessionMemory, listAllMemory, updateMemoryEntry } from "../session-memory";
import { getLanes as getUserLanes, setLanes as setUserLanes } from "../lanes";
import { getSnoozes as getUserSnoozes, setSnoozes as setUserSnoozes } from "../snoozes";
import { getHides as getUserHides, setHides as setUserHides } from "../hides";
import { getTabColors as getUserTabColors, setTabColors as setUserTabColors } from "../tab-colors";
import { getUiPrefs, patchUiPrefs } from "../ui-prefs";
import { getPersonalPrompt, setPersonalPrompt } from "../personal-prompts";
import { refreshWarmTemplate, setWarmTemplateConfig, warmTemplateStatus } from "../warm-template";
import { previewPoolStatus, refreshGoldenImage, setPreviewPoolConfig } from "../preview-pool";
import { REPOS } from "../worktree";

export async function handlePrefsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Web Push (phone/desktop notifications, app closed) ──
	if (path === "/api/push/vapid-key" && req.method === "GET") {
		const { getVapidPublicKey } = await import("../../server/push");
		return Response.json({ publicKey: getVapidPublicKey() });
	}

	if (path === "/api/push/subscribe" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const { addPushSubscription } = await import("../../server/push");
		const result = addPushSubscription({
			user: body.user,
			subscription: body.subscription,
			userAgent: req.headers.get("user-agent") || undefined,
		});
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	if (path === "/api/push/unsubscribe" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.endpoint !== "string")
			return Response.json({ error: "endpoint required" }, { status: 400 });
		const { removePushSubscription } = await import("../../server/push");
		removePushSubscription(body.endpoint);
		return Response.json({ ok: true });
	}

	// ── Warm preview templates (per-repo prebuilt worktrees, scheduled) ──
	if (path === "/api/warm-templates" && req.method === "GET") {
		return Response.json({ repos: warmTemplateStatus() });
	}

	{
		const m = path.match(
			/^\/api\/warm-templates\/([^/]+)(\/refresh)?$/,
		);
		if (m) {
			const repoId = decodeURIComponent(m[1]);
			if (!(repoId in REPOS))
				return Response.json(
					{ error: `unknown repo "${repoId}"` },
					{ status: 404 },
				);
			if (!m[2] && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const patch: Record<string, unknown> = {};
				if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
				if (
					typeof body.intervalHours === "number" &&
					body.intervalHours >= 1
				)
					patch.intervalHours = Math.floor(body.intervalHours);
				if (Array.isArray(body.warmRoutes))
					patch.warmRoutes = body.warmRoutes.filter(
						(r: unknown): r is string => typeof r === "string",
					);
				setWarmTemplateConfig(repoId, patch);
				return Response.json({ repos: warmTemplateStatus() });
			}
			if (m[2] && req.method === "POST") {
				// Fire-and-forget: a refresh boots a real dev server (minutes);
				// the UI polls GET for progress via `refreshing`.
				void refreshWarmTemplate(repoId, { force: true }).catch(() => {});
				return Response.json({ repos: warmTemplateStatus() });
			}
		}
	}

	// ── Preview pool (warm, pre-booted dev-server containers per repo) ──
	if (path === "/api/preview-pool" && req.method === "GET") {
		return Response.json({ repos: previewPoolStatus() });
	}

	{
		const m = path.match(/^\/api\/preview-pool\/([^/]+)(\/refresh)?$/);
		if (m) {
			const repoId = decodeURIComponent(m[1]);
			if (!(repoId in REPOS))
				return Response.json({ error: `unknown repo "${repoId}"` }, { status: 404 });
			if (!m[2] && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const patch: Record<string, unknown> = {};
				if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
				if (typeof body.devAuthBypass === "boolean") patch.devAuthBypass = body.devAuthBypass;
				if (["docker", "daytona", "microvm"].includes(body.backend)) patch.backend = body.backend;
				for (const k of ["running", "paused", "cpus", "goldenIntervalHours", "claimIdleMinutes"] as const) {
					if (typeof body[k] === "number") patch[k] = body[k];
				}
				if (typeof body.memory === "string") patch.memory = body.memory;
				setPreviewPoolConfig(repoId, patch);
				return Response.json({ repos: previewPoolStatus() });
			}
			if (m[2] && req.method === "POST") {
				// Fire-and-forget: a golden rebuild boots a dev server (minutes);
				// the UI polls GET for progress via `goldenBuilding`. Refill the
				// warm pool right after (the rebuild retires old-image spares).
				void refreshGoldenImage(repoId, true)
					.then(() => import("../preview-pool").then((p) => p.previewPoolSweepNow()))
					.catch(() => {});
				return Response.json({ repos: previewPoolStatus() });
			}
		}
	}

	// ── Memory (Settings → Memory: the same repo/user/team/channel stores
	// the opensession-memory tools + Slack channel memory read/write) ──
	if (path === "/api/memory") {
		if (req.method === "GET") {
			return Response.json({
				scopes: await listAllMemory(Object.keys(REPOS)),
			});
		}
		const body = await req.json().catch(() => null);
		const scope = body?.scopeKey ? describeScope(String(body.scopeKey)) : null;
		if (!scope)
			return Response.json(
				{ error: "unknown or invalid scopeKey" },
				{ status: 400 },
			);
		if (req.method === "POST") {
			const text = String(body?.text || "").trim();
			if (!text)
				return Response.json({ error: "text required" }, { status: 400 });
			const entry = await addSessionMemory(
				scope,
				text,
				String(body?.by || "settings"),
			);
			return Response.json({ entry });
		}
		if (req.method === "PUT") {
			const text = String(body?.text || "").trim();
			if (!text || !body?.id)
				return Response.json(
					{ error: "id and text required" },
					{ status: 400 },
				);
			const entry = await updateMemoryEntry(scope.key, String(body.id), text);
			if (!entry)
				return Response.json({ error: "entry not found" }, { status: 404 });
			return Response.json({ entry });
		}
		if (req.method === "DELETE") {
			if (!body?.id)
				return Response.json({ error: "id required" }, { status: 400 });
			const res = await forgetSessionMemory([scope], String(body.id));
			if (!res.ok)
				return Response.json({ error: res.error }, { status: 404 });
			return Response.json({ ok: true });
		}
	}

	// ── Per-user pinned tabs ──
	// Keyed on the self-selected `user` name (team-internal, not auth). GET reads
	// a user's pins; PUT replaces them wholesale (the frontend sends the full list
	// on every toggle and on first-load localStorage migration).
	if (path === "/api/pins" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ pins: getUserPins(user) });
	}

	if (path === "/api/pins" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			!Array.isArray(body.pins)
		) {
			return Response.json(
				{ error: "user (string) and pins (array) are required" },
				{ status: 400 },
			);
		}
		return Response.json({ pins: setUserPins(body.user, body.pins) });
	}

	// ── Per-user personal system prompt ──
	// An extra standing-instructions block injected into every interactive run
	// the user starts (see personal-prompts.ts). Keyed through the identity
	// table, so all of a teammate's surfaces share one prompt. GET reads it;
	// PUT replaces it wholesale (empty string clears).
	if (path === "/api/personal-prompt" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ prompt: getPersonalPrompt(user) });
	}

	if (path === "/api/personal-prompt" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			typeof body.prompt !== "string"
		) {
			return Response.json(
				{ error: "user (string) and prompt (string) are required" },
				{ status: 400 },
			);
		}
		return Response.json({
			prompt: setPersonalPrompt(body.user, body.prompt),
		});
	}

	// ── Per-user read marks (unread flags) ──
	// The server mirror of the frontend's localStorage read state
	// (src/frontend/lib/reads.ts), so consumers that can't see localStorage —
	// the hardware macropad feed (GET /api/keypad) — can flag sessions with
	// unread activity. GET reads a user's marks; PUT replaces them wholesale
	// (the frontend pushes its full map on every mark change), same shape as pins.
	if (path === "/api/reads" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ reads: getUserReads(user) });
	}

	if (path === "/api/reads" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			!body.reads ||
			typeof body.reads !== "object"
		) {
			return Response.json(
				{ error: "user (string) and reads (object) are required" },
				{ status: 400 },
			);
		}
		return Response.json({ reads: setUserReads(body.user, body.reads) });
	}

	// ── Per-user UI prefs (cross-device view preferences, e.g. the turn-
	// activity fold setting). GET reads a user's map; PUT merges a patch —
	// merge, not replace, so one device can't clobber keys set on another.
	if (path === "/api/ui-prefs" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ prefs: getUiPrefs(user) });
	}

	if (path === "/api/ui-prefs" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			typeof body.prefs !== "object" ||
			body.prefs === null
		) {
			return Response.json(
				{ error: "user (string) and prefs (object) are required" },
				{ status: 400 },
			);
		}
		return Response.json({ prefs: patchUiPrefs(body.user, body.prefs) });
	}

	// ── Per-user sidebar lanes ──
	// Same per-user model as pins: GET reads a user's lane map; PUT replaces
	// it wholesale (the frontend sends the full map on every lane change).
	if (path === "/api/lanes" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ lanes: getUserLanes(user) });
	}

	if (path === "/api/lanes" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			typeof body.lanes !== "object" ||
			body.lanes === null
		) {
			return Response.json(
				{ error: "user (string) and lanes (object) are required" },
				{ status: 400 },
			);
		}
		return Response.json({ lanes: setUserLanes(body.user, body.lanes) });
	}

	// ── Per-user workspace snoozes ──
	// Same per-user model as pins: GET reads a user's snooze map; PUT replaces
	// it wholesale (the frontend sends the full map on every snooze change).
	if (path === "/api/snoozes" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ snoozes: getUserSnoozes(user) });
	}

	if (path === "/api/snoozes" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			typeof body.snoozes !== "object" ||
			body.snoozes === null
		) {
			return Response.json(
				{ error: "user (string) and snoozes (object) are required" },
				{ status: 400 },
			);
		}
		return Response.json({
			snoozes: setUserSnoozes(body.user, body.snoozes),
		});
	}

	// ── Per-user sidebar hides ──
	// The personal counterpart to archiving (which is global, see archive.ts):
	// hiding a row drops it from THIS user's sidebar while the session keeps
	// running for everyone else. Same per-user model as pins: GET reads a
	// user's hide map; PUT replaces it wholesale.
	if (path === "/api/hides" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ hides: getUserHides(user) });
	}

	if (path === "/api/hides" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			typeof body.hides !== "object" ||
			body.hides === null
		) {
			return Response.json(
				{ error: "user (string) and hides (object) are required" },
				{ status: 400 },
			);
		}
		return Response.json({ hides: setUserHides(body.user, body.hides) });
	}

	// ── Per-user session tab colors ──
	// Same per-user model as pins: GET reads a user's tab colors; PUT replaces
	// the whole map (the frontend sends the full map on every color change).
	if (path === "/api/tab-colors" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ colors: getUserTabColors(user) });
	}

	if (path === "/api/tab-colors" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			typeof body.colors !== "object" ||
			body.colors === null
		) {
			return Response.json(
				{ error: "user (string) and colors (object) are required" },
				{ status: 400 },
			);
		}
		return Response.json({
			colors: setUserTabColors(body.user, body.colors),
		});
	}

	return undefined;
}
