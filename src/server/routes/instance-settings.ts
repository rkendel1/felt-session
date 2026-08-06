/**
 * Instance-settings routes: the writable slice of ~/.opensession/config.json
 * exposed in Settings → General (identity: agent name, product name).
 * Config reads are mtime-guarded per call, so a write applies to new runs
 * immediately; the frontend rebuild re-injects the instance blob + HTML
 * titles and nudges open tabs via the `frontend_updated` broadcast.
 */

import type { RouteContext } from "./context";
import {
	configPath,
	personaName,
	productName,
	productMark,
	updateIdentityConfig,
} from "../config";
import { scheduleFrontendRebuild } from "../frontend-build";

const MAX_NAME_LENGTH = 80;

function identityDto() {
	return {
		personaName: personaName(),
		productName: productName(),
		productMark: productMark(),
		configPath: configPath(),
	};
}

/** Optional string field: absent → undefined, otherwise a length-capped string. */
function nameField(v: unknown, label: string): string | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw new Error(`${label} must be a string`);
	if (v.trim().length > MAX_NAME_LENGTH) {
		throw new Error(`${label} must be at most ${MAX_NAME_LENGTH} characters`);
	}
	return v;
}

export async function handleInstanceSettingsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;

	if (path === "/api/settings/identity" && req.method === "GET") {
		return Response.json(identityDto());
	}

	if (path === "/api/settings/identity" && req.method === "PUT") {
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body) {
			return Response.json({ error: "expected a JSON body" }, { status: 400 });
		}
		try {
			updateIdentityConfig({
				personaName: nameField(body.personaName, "personaName"),
				productName: nameField(body.productName, "productName"),
				productMark: nameField(body.productMark, "productMark"),
			});
		} catch (e: any) {
			return Response.json({ error: e?.message || String(e) }, { status: 400 });
		}
		scheduleFrontendRebuild("identity settings");
		return Response.json(identityDto());
	}

	return undefined;
}
