/**
 * Reports routes: the Reports view's list/history/raw-HTML surface over the
 * reports store (src/server/reports.ts). Read-only — publishing happens
 * through the opensession-report MCP tool inside automation runs.
 */

import type { RouteContext } from "./context";
import {
	listReportGroups,
	listReports,
	listReportsForSession,
	readReportAsset,
	readReportHtml,
} from "../reports";
import { assetMime } from "../session-assets";

export async function handleReportsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;
	if (req.method !== "GET") return undefined;

	// One row per automation that has published reports (latest + count).
	if (path === "/backstage/api/reports") {
		return Response.json({ groups: listReportGroups() });
	}

	// The reports published by one run, powering its right-sidebar Reports tab.
	const sessionMatch = path.match(
		/^\/backstage\/api\/reports\/session\/([^/]+)$/,
	);
	if (sessionMatch) {
		return Response.json({
			reports: listReportsForSession(decodeURIComponent(sessionMatch[1])),
		});
	}

	// The rendered report itself — served as a document for the detail iframe.
	// `sandbox` keeps agent-authored HTML inert (no scripts, no top navigation)
	// while allow-same-origin lets it be styled/read normally.
	const rawMatch = path.match(
		/^\/backstage\/api\/reports\/([^/]+)\/([^/]+)\/raw$/,
	);
	if (rawMatch) {
		const html = readReportHtml(
			decodeURIComponent(rawMatch[1]),
			decodeURIComponent(rawMatch[2]),
		);
		if (html === null)
			return new Response("Report not found", { status: 404 });
		return new Response(html, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "sandbox allow-same-origin",
			},
		});
	}

	// Durable files referenced by report HTML as assets/<path>.
	const assetMatch = path.match(
		/^\/backstage\/api\/reports\/([^/]+)\/([^/]+)\/assets\/(.+)$/,
	);
	if (assetMatch) {
		const asset = readReportAsset(
			decodeURIComponent(assetMatch[1]),
			decodeURIComponent(assetMatch[2]),
			decodeURIComponent(assetMatch[3]),
		);
		if (!asset) return new Response("Report asset not found", { status: 404 });
		const file = Bun.file(asset.path);
		return new Response(file, {
			headers: {
				"Content-Type": assetMime(asset.rel),
				"Content-Length": String(file.size),
				"Cache-Control": "no-store",
				"Content-Security-Policy": "sandbox",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}

	// A group's history, newest first.
	const groupMatch = path.match(/^\/backstage\/api\/reports\/([^/]+)$/);
	if (groupMatch) {
		return Response.json({
			reports: listReports(decodeURIComponent(groupMatch[1])),
		});
	}

	return undefined;
}
