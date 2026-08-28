import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import { audit } from "../audit";
import { configuredIngress } from "../config";
import {
	persistRawConfig,
	rawConfig,
	withConfigMutationLock,
} from "../config-mutation";
import { prepareEnvFileEdits } from "../env-file-edit";
import { githubAppConfigSource } from "../github-auth";
import { commitGithubAppKeyMutation } from "../github-app";
import { GITHUB_APP_GRANT_PERMISSIONS } from "../../shared/github-app-permissions";
import type { RouteContext } from "./context";

const MANIFEST_TTL_MS = 60 * 60_000;
const MAX_PENDING_MANIFESTS = 32;
const GITHUB_API_VERSION = "2022-11-28";

export const GITHUB_APP_MANIFEST_EVENTS = [
	"issue_comment",
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
	"workflow_run",
] as const;

type ManifestOwner =
	| { type: "personal" }
	| { type: "organization"; login: string };

interface PendingManifest {
	createdAt: number;
	origin: string;
	publicPrefix: string;
	owner: ManifestOwner;
	returnTo: "welcome" | "settings";
	returnToApp: boolean;
	authLogin: string | null;
	action: string;
	manifest: string;
	used: boolean;
}

interface ManifestConversion {
	slug?: unknown;
	client_id?: unknown;
	client_secret?: unknown;
	webhook_secret?: unknown;
	pem?: unknown;
	owner?: { login?: unknown };
}

const runtime = globalThis as {
	__opensessionGithubManifestStates?: Map<string, PendingManifest>;
};

function pendingManifests(): Map<string, PendingManifest> {
	return (runtime.__opensessionGithubManifestStates ??= new Map());
}

/** Test seam. Pending registration state contains no credential, but clearing it
 * keeps route tests independent and proves a callback cannot rely on old state. */
export function __resetGithubManifestStatesForTest(): void {
	pendingManifests().clear();
}

function prunePendingManifests(now = Date.now()): void {
	const states = pendingManifests();
	for (const [state, pending] of states) {
		if (now - pending.createdAt > MANIFEST_TTL_MS) states.delete(state);
	}
}

function makeRoomForManifest(): void {
	const states = pendingManifests();
	while (states.size >= MAX_PENDING_MANIFESTS) {
		const oldest = states.keys().next().value;
		if (!oldest) break;
		states.delete(oldest);
	}
}

function githubLogin(value: unknown): string {
	const login = typeof value === "string" ? value.trim() : "";
	if (
		!login ||
		login.length > 39 ||
		!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(login) ||
		login.includes("--")
	) {
		throw new Error("Enter a valid GitHub organization login");
	}
	return login;
}

function manifestCallbackUrl(origin: string, publicPrefix: string): string {
	return `${origin}${publicPrefix}/api/setup/github/manifest/callback`;
}

export function buildGithubAppManifest(input: {
	origin: string;
	publicPrefix: string;
	appName?: string;
	ingressUrl?: string;
}): Record<string, unknown> {
	const ingressUrl = input.ingressUrl?.trim().replace(/\/+$/, "") || "";
	return {
		name:
			input.appName ||
			`Open Session (${Math.random().toString(36).slice(2, 6)})`,
		description: "Private GitHub access for this Open Session server.",
		url: input.origin,
		redirect_url: manifestCallbackUrl(input.origin, input.publicPrefix),
		callback_urls: [`${input.origin}${input.publicPrefix}/`],
		request_oauth_on_install: false,
		public: false,
		default_permissions: GITHUB_APP_GRANT_PERMISSIONS,
		// GitHub rejects loopback webhook URLs even when delivery is inactive.
		// Local-only instances create the App without webhook configuration;
		// Domains can add a reachable HTTPS endpoint later.
		...(ingressUrl
			? {
					default_events: GITHUB_APP_MANIFEST_EVENTS,
					hook_attributes: {
						url: `${ingressUrl}/github/webhook`,
						active: true,
					},
				}
			: {}),
	};
}

function htmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function manifestLaunchPage(pending: PendingManifest): Response {
	const nonce = randomUUID().replaceAll("-", "");
	const body = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Opening GitHub</title></head>
<body><p>Opening GitHub App setup…</p>
<form id="github-app-manifest" method="post" action="${htmlAttribute(pending.action)}">
<input type="hidden" name="manifest" value="${htmlAttribute(pending.manifest)}">
<button type="submit">Continue to GitHub</button></form>
<script nonce="${nonce}">document.getElementById("github-app-manifest").submit();</script>
</body></html>`;
	return new Response(body, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'`,
			"Referrer-Policy": "no-referrer",
		},
	});
}

function integrationSection(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const integrations =
		config.integrations &&
		typeof config.integrations === "object" &&
		!Array.isArray(config.integrations)
			? (config.integrations as Record<string, unknown>)
			: {};
	config.integrations = integrations;
	const github =
		integrations.github &&
		typeof integrations.github === "object" &&
		!Array.isArray(integrations.github)
			? (integrations.github as Record<string, unknown>)
			: {};
	integrations.github = github;
	return github;
}

function validateConversion(
	body: ManifestConversion,
	owner: ManifestOwner,
): {
	slug: string;
	clientId: string;
	clientSecret: string;
	webhookSecret: string;
	pem: string;
	ownerLogin: string;
} {
	const slug = typeof body.slug === "string" ? body.slug.trim() : "";
	const clientId =
		typeof body.client_id === "string" ? body.client_id.trim() : "";
	const clientSecret =
		typeof body.client_secret === "string" ? body.client_secret.trim() : "";
	const returnedWebhookSecret =
		typeof body.webhook_secret === "string"
			? body.webhook_secret.trim()
			: "";
	const webhookSecret = returnedWebhookSecret || randomBytes(32).toString("hex");
	const pem = typeof body.pem === "string" ? body.pem.trim() : "";
	const ownerLogin =
		typeof body.owner?.login === "string" ? body.owner.login.trim() : "";
	if (
		!slug ||
		!clientId ||
		!clientSecret ||
		!pem ||
		!ownerLogin
	) {
		throw new Error("GitHub returned an incomplete App registration");
	}
	if (
		owner.type === "organization" &&
		ownerLogin.toLowerCase() !== owner.login.toLowerCase()
	) {
		throw new Error(`GitHub created the App under ${ownerLogin}, not ${owner.login}`);
	}
	if (/\s/.test(clientId) || /\s/.test(clientSecret) || /[\r\n\0]/.test(webhookSecret)) {
		throw new Error("GitHub returned malformed App credentials");
	}
	try {
		createPrivateKey(pem);
	} catch {
		throw new Error("GitHub returned an invalid App private key");
	}
	return { slug, clientId, clientSecret, webhookSecret, pem, ownerLogin };
}

async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
	const response = await fetch(
		`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": GITHUB_API_VERSION,
				"User-Agent": "opensession",
			},
			signal: AbortSignal.timeout(15_000),
		},
	);
	const body = (await response.json().catch(() => null)) as
		| ManifestConversion
		| { message?: unknown }
		| null;
	if (!response.ok || !body) {
		const message =
			typeof (body as { message?: unknown } | null)?.message === "string"
				? String((body as { message: string }).message).slice(0, 180)
				: `GitHub manifest exchange failed (${response.status})`;
		throw new Error(message);
	}
	return body as ManifestConversion;
}

function callbackRedirect(
	pending: PendingManifest,
	result: "created" | "error",
): Response {
	const path =
		pending.returnTo === "settings"
			? `${pending.publicPrefix}/settings/integrations`
			: `${pending.publicPrefix}/welcome`;
	const target = new URL(path, pending.origin);
	if (pending.returnTo === "welcome") target.searchParams.set("step", "github");
	target.searchParams.set("github_manifest", result);
	if (!pending.returnToApp) return Response.redirect(target, 303);
	const nonce = randomUUID().replaceAll("-", "");
	const deepLink = `os1://${pending.returnTo === "settings" ? "settings/integrations" : "welcome"}?${target.searchParams.toString()}`;
	const body = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Return to Open Session</title></head>
<body><p>Returning to Open Session…</p>
<p><a href="${htmlAttribute(deepLink)}">Open Open Session</a></p>
<script nonce="${nonce}">window.location.href=${JSON.stringify(deepLink)};</script>
</body></html>`;
	return new Response(body, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
			"Referrer-Policy": "no-referrer",
		},
	});
}

export async function handleSetupGithubManifestRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;
	if (path === "/api/setup/github/manifest" && req.method === "POST") {
		if (githubAppConfigSource() === "env" || process.env.OPENSESSION_GITHUB_APP_KEY) {
			return Response.json(
				{
					error:
						"A GitHub App is managed through environment settings and cannot be replaced here",
				},
				{ status: 409 },
			);
		}
		const current = integrationSection(rawConfig());
		if (typeof current.oauthClientId === "string" && current.oauthClientId.trim()) {
			return Response.json(
				{ error: "A GitHub App is already configured" },
				{ status: 409 },
			);
		}
		const body = (await req.json().catch(() => null)) as {
			owner?: unknown;
			organization?: unknown;
			returnTo?: unknown;
			desktop?: unknown;
		} | null;
		let owner: ManifestOwner;
		try {
			owner =
				body?.owner === "personal"
					? { type: "personal" }
					: body?.owner === "organization"
						? { type: "organization", login: githubLogin(body.organization) }
						: (() => {
								throw new Error("Choose who will own the GitHub App");
							})();
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 400 },
			);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return Response.json({ error: "Open Session needs an HTTP address" }, { status: 400 });
		}
		prunePendingManifests();
		makeRoomForManifest();
		const state = `${randomUUID()}${randomUUID()}`;
		const pending: PendingManifest = {
			createdAt: Date.now(),
			origin: url.origin,
			publicPrefix,
			owner,
			returnTo: body?.returnTo === "settings" ? "settings" : "welcome",
			returnToApp: body?.desktop === true,
			authLogin: ctx.authUser?.login ?? null,
			action: "",
			manifest: "",
			used: false,
		};
		const base =
			owner.type === "organization"
				? `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/new`
				: "https://github.com/settings/apps/new";
		const action = new URL(base);
		action.searchParams.set("state", state);
		pending.action = action.toString();
		pending.manifest = JSON.stringify(
			buildGithubAppManifest({
				origin: url.origin,
				publicPrefix,
				ingressUrl: configuredIngress().publicBaseUrl,
			}),
		);
		pendingManifests().set(state, pending);
		return Response.json({
			action: pending.action,
			manifest: pending.manifest,
			launchUrl: `${url.origin}${publicPrefix}/api/setup/github/manifest/launch?state=${encodeURIComponent(state)}`,
		});
	}

	if (path === "/api/setup/github/manifest/launch" && req.method === "GET") {
		prunePendingManifests();
		const pending = pendingManifests().get(url.searchParams.get("state") || "");
		if (
			!pending ||
			pending.used ||
			pending.authLogin !== (ctx.authUser?.login ?? null)
		) {
			return new Response("This GitHub App setup link is missing or expired.", {
				status: 400,
			});
		}
		return manifestLaunchPage(pending);
	}

	if (
		path === "/api/setup/github/manifest/callback" &&
		req.method === "GET"
	) {
		prunePendingManifests();
		const state = url.searchParams.get("state") || "";
		const code = url.searchParams.get("code") || "";
		const pending = pendingManifests().get(state);
		if (
			!pending ||
			pending.used ||
			!code ||
			pending.authLogin !== (ctx.authUser?.login ?? null)
		) {
			return Response.json(
				{ error: "This GitHub App registration is missing, expired, or already used" },
				{ status: 400 },
			);
		}
		pending.used = true;
		try {
			const converted = validateConversion(
				await exchangeManifestCode(code),
				pending.owner,
			);
			await withConfigMutationLock(async () => {
				const config = rawConfig();
				const github = integrationSection(config);
				github.oauthClientId = converted.clientId;
				github.oauthClientSecret = converted.clientSecret;
				github.appSlug = converted.slug;
				github.installationOwner = converted.ownerLogin;
				// App setup is also sign-in setup. Arm the connect-time bootstrap for
				// both personal and organization-owned Apps, but do not enable the gate
				// yet: the device-flow account must be rostered and receive its session
				// first, or the operator would be locked out.
				github.authOnConnect = true;
				if (pending.owner.type === "organization") {
					github.appOrg = converted.ownerLogin;
				} else {
					delete github.appOrg;
				}
				const envEdit = prepareEnvFileEdits({
					GITHUB_WEBHOOK_SECRET: converted.webhookSecret,
				});
				envEdit.commit();
				try {
					await commitGithubAppKeyMutation(converted.pem, () =>
						persistRawConfig(config),
					);
				} catch (error) {
					envEdit.rollback();
					throw error;
				}
			});
			pendingManifests().delete(state);
			audit({
				kind: "setup_github_manifest_complete",
				owner: converted.ownerLogin,
				by: ctx.authUser?.login || null,
			});
			return callbackRedirect(pending, "created");
		} catch (error) {
			console.error(
				`[setup] GitHub App manifest completion failed: ${String((error as Error)?.message || error).slice(0, 200)}`,
			);
			return callbackRedirect(pending, "error");
		}
	}

	return undefined;
}
