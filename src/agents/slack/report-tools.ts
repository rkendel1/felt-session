/**
 * opensession-report — publish_report: lets a run publish an HTML report and
 * optional staged assets into the Reports store (~/.opensession-reports, see
 * src/server/reports.ts), grouped per automation and browsed in the frontend
 * Reports view (latest + history per automation).
 *
 * Wired into EVERY automation run (automations.ts), like the papercuts
 * sibling, and held to the same automation in-process bar: publish-only
 * (append into its own automation's group), nothing sensitive readable, no
 * control surface. The automation identity is baked in here — a run can never
 * publish into another automation's group.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
	publishReport,
	MAX_REPORT_ASSETS,
	MAX_REPORT_ASSET_BYTES,
	MAX_REPORT_BYTES,
} from "../../server/reports";
import { assetsDirFor, resolveAssetPath } from "../../server/session-assets";
import { lstatSync, readFileSync, realpathSync, statSync } from "fs";

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

export function createReportMcpServer(ctx: {
	automationId: string;
	automationName: string;
	sessionId?: string;
}) {
	const stagingDir = ctx.sessionId ? assetsDirFor(ctx.sessionId) : null;
	const tools = [
		tool(
			"publish_report",
			"Publish this run's HTML report with optional durable assets shown in the Reports view — latest per automation, with history. Keep CSS inline, but store image/media evidence as assets instead of base64 data URLs. Use it when the task's outcome is a recurring readable report; each publish adds a new entry, so publish once per run with the final document.",
			{
				title: z
					.string()
					.describe(
						'Human title for this report, e.g. "Support digest — 2026-07-12".',
					),
				html: z
					.string()
					.describe(
						`The full HTML document (max ${Math.floor(MAX_REPORT_BYTES / 1024 / 1024)} MB). Keep CSS inline. Reference staged files as assets/<path> and list those paths in assets.`,
					),
				assets: z
					.array(z.string())
					.max(MAX_REPORT_ASSETS)
					.optional()
					.describe(
						`Relative file paths staged in this run's assets folder${stagingDir ? ` (${stagingDir})` : ""}. They are copied into durable report storage and served at assets/<path>. Combined max ${Math.floor(MAX_REPORT_ASSET_BYTES / 1024 / 1024)} MB.`,
					),
				summary: z
					.string()
					.optional()
					.describe(
						"Short plain-text gist (1-3 sentences) shown in report lists.",
					),
			},
			async (args: {
				title: string;
				html: string;
				assets?: string[];
				summary?: string;
			}) => {
				try {
					if (args.assets?.length && !ctx.sessionId)
						throw new Error("Report assets require a session id");
					const realStagingDir = args.assets?.length
						? realpathSync(stagingDir!)
						: null;
					let assetBytes = 0;
					const assetPaths = new Set<string>();
					const sources = (args.assets || []).map((path) => {
						const source = resolveAssetPath(ctx.sessionId!, path);
						if (assetPaths.has(source.rel))
							throw new Error(`Duplicate report asset: ${source.rel}`);
						assetPaths.add(source.rel);
						if (!lstatSync(source.abs).isFile())
							throw new Error(`Not a file: ${path}`);
						const realPath = realpathSync(source.abs);
						if (!realPath.startsWith(`${realStagingDir!}/`))
							throw new Error(`Asset resolves outside the session folder: ${path}`);
						assetBytes += statSync(realPath).size;
						if (assetBytes > MAX_REPORT_ASSET_BYTES)
							throw new Error(
								`Report assets too large (${assetBytes} bytes > ${MAX_REPORT_ASSET_BYTES})`,
							);
						return { path: source.rel, realPath };
					});
					const assets = sources.map((source) => ({
						path: source.path,
						data: readFileSync(source.realPath),
					}));
					const meta = publishReport({
						automationId: ctx.automationId,
						automationName: ctx.automationName,
						sessionId: ctx.sessionId,
						title: args.title,
						html: args.html,
						summary: args.summary,
						assets,
					});
					return text(
						`Published report "${meta.title}" (${meta.id}). It's now the latest report for "${ctx.automationName}" in the Reports view.`,
					);
				} catch (e: any) {
					return text(`Failed to publish report: ${e?.message || e}`);
				}
			},
		),
	];
	return createSdkMcpServer({ name: "opensession-report", tools });
}
