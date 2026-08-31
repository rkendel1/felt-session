/**
 * Generic automation outputs. Reports are the durable source artifact; other
 * sinks consume their structured metadata after a successful run. This keeps
 * external delivery server-controlled and means the primary model never needs
 * a Slack write tool.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import type { StateFirstDB } from "@feltdb/core";
import { configuredServer } from "./config";
import { stateDir } from "./paths";
import {
	listReportsForSession,
	type ReportConfidence,
	type ReportMeta,
	type ReportUrgency,
} from "./reports";
import { managedFeltDb } from "./managed-feltdb";

interface AutomationOutputBase {
	id: string;
	type: "report" | "slack";
	enabled?: boolean;
}

export interface ReportAutomationOutput extends AutomationOutputBase {
	type: "report";
	publish?: "always" | "on_findings";
}

export interface SlackAutomationOutput extends AutomationOutputBase {
	type: "slack";
	channel: string;
	source?: "report";
	minUrgency?: ReportUrgency;
	minConfidence?: ReportConfidence;
}

export type AutomationOutput = ReportAutomationOutput | SlackAutomationOutput;

const OUTPUT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const SLACK_CONVERSATION_RE = /^[CDG][A-Z0-9]{6,}$/;
const URGENCY_SCORE: Record<ReportUrgency, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};
const CONFIDENCE_SCORE: Record<ReportConfidence, number> = {
	low: 0,
	medium: 1,
	high: 2,
};
const OUTPUT_STATE_ROOT = stateDir("automation-output-state");

interface OutputState {
	id: string;
	delivered: Record<string, { reportId: string; at: string }>;
	__version?: number;
}

function outputStateFile(automationId: string): string {
	return `${OUTPUT_STATE_ROOT}/${automationId}.json`;
}

const OUTPUT_STATE_COLLECTION = "opensession_automation_output_state";
const OUTPUT_STATE_MIGRATION = "automation-output-state-files-to-managed-feltdb-v1";
let outputStateDb: StateFirstDB | undefined;
const outputStates = new Map<string, OutputState>();

export async function initializeManagedAutomationOutputs(db: StateFirstDB = outputStateDb ?? managedFeltDb()): Promise<void> {
	outputStateDb = db;
	const migrations = db.collection<{ id: string }>("opensession_migrations");
	if (!await migrations.get(OUTPUT_STATE_MIGRATION)) {
		const legacy: OutputState[] = [];
		if (existsSync(OUTPUT_STATE_ROOT)) for (const file of readdirSync(OUTPUT_STATE_ROOT)) {
			if (!file.endsWith(".json")) continue;
			const id = file.slice(0, -5);
			const parsed = JSON.parse(readFileSync(outputStateFile(id), "utf8"));
			legacy.push({ id, delivered: parsed?.delivered && typeof parsed.delivered === "object" ? parsed.delivered : {} });
		}
		await db.transaction((tx) => {
			for (const record of legacy) tx.collection<OutputState>(OUTPUT_STATE_COLLECTION).set(record.id, record, { requireAbsent: true });
			tx.collection("opensession_migrations").set(OUTPUT_STATE_MIGRATION,
				{ id: OUTPUT_STATE_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${OUTPUT_STATE_MIGRATION}` });
	}
	if (existsSync(OUTPUT_STATE_ROOT)) rmSync(OUTPUT_STATE_ROOT, { recursive: true, force: true });
	outputStates.clear();
	for (const record of await db.collection<OutputState>(OUTPUT_STATE_COLLECTION).all()) outputStates.set(record.id, record);
}

function readOutputState(automationId: string): OutputState {
	return outputStates.get(automationId) ?? { id: automationId, delivered: {} };
}

export async function deleteAutomationOutputState(automationId: string): Promise<void> {
	const current = outputStates.get(automationId);
	if (!current) return;
	const db = outputStateDb ?? managedFeltDb();
	await db.transaction((tx) => {
		tx.collection<OutputState>(OUTPUT_STATE_COLLECTION).delete(automationId, { ifVersion: current.__version });
	}, { transactionId: `opensession:automation-output-state:delete:${automationId}` });
	outputStates.delete(automationId);
}

export function sanitizeAutomationOutputs(
	value: unknown,
): AutomationOutput[] | undefined | { error: string } {
	if (value == null) return undefined;
	if (!Array.isArray(value)) return { error: "outputs must be an array" };
	if (value.length > 8) return { error: "outputs supports at most 8 sinks" };
	const ids = new Set<string>();
	const outputs: AutomationOutput[] = [];
	for (let index = 0; index < value.length; index++) {
		const raw = value[index] as any;
		const at = `outputs[${index}]`;
		if (!raw || typeof raw !== "object") return { error: `${at} must be an object` };
		const id = String(raw.id || "").trim().toLowerCase();
		if (!OUTPUT_ID_RE.test(id)) return { error: `${at}.id must be a short slug` };
		if (ids.has(id)) return { error: `duplicate automation output id "${id}"` };
		ids.add(id);
		const enabled = raw.enabled !== false;
		if (raw.type === "report") {
			const publish = raw.publish || "always";
			if (publish !== "always" && publish !== "on_findings")
				return { error: `${at}.publish is invalid` };
			outputs.push({ id, type: "report", enabled, publish });
			continue;
		}
		if (raw.type === "slack") {
			const channel = String(raw.channel || "").trim().toUpperCase();
			if (!SLACK_CONVERSATION_RE.test(channel))
				return {
					error: `${at}.channel must be a Slack C…/D…/G… conversation id`,
				};
			const minUrgency = raw.minUrgency || "high";
			const minConfidence = raw.minConfidence || "high";
			if (!(minUrgency in URGENCY_SCORE))
				return { error: `${at}.minUrgency is invalid` };
			if (!(minConfidence in CONFIDENCE_SCORE))
				return { error: `${at}.minConfidence is invalid` };
			outputs.push({
				id,
				type: "slack",
				enabled,
				channel,
				source: "report",
				minUrgency,
				minConfidence,
			});
			continue;
		}
		return { error: `${at}.type is unsupported` };
	}
	return outputs.length ? outputs : undefined;
}

/** Prompt contract for model-authored report delivery. Disabled sinks stay hidden. */
export function automationOutputInstructions(outputs?: AutomationOutput[]): string {
	const report = outputs?.find(
		(output): output is ReportAutomationOutput =>
			output.type === "report" && output.enabled !== false,
	);
	if (!report) return "";
	return [
		"## Required output",
		report.publish === "always"
			? "Publish exactly one final report with `opensession-report.publish_report` on every successful run."
			: "Publish one final report with `opensession-report.publish_report` when there are material findings or a meaningful change; otherwise call `finish_silently` and explain why no report is warranted.",
		"For analytical findings, pass structured `highlights`. Give every highlight an urgency (time-to-action) and confidence (certainty in the assessment), plus sourceRefs when evidence exists. Also set the report-level urgency and confidence. Do not confuse urgency with confidence.",
	].join("\n\n");
}

function reportMeetsThreshold(
	report: ReportMeta,
	output: SlackAutomationOutput,
): boolean {
	if (!report.urgency || !report.confidence) return false;
	return (
		URGENCY_SCORE[report.urgency] >= URGENCY_SCORE[output.minUrgency || "high"] &&
		CONFIDENCE_SCORE[report.confidence] >=
			CONFIDENCE_SCORE[output.minConfidence || "high"]
	);
}

/** Neutralize Slack mrkdwn mention syntax in fallback text. */
function neutralText(value: string, max: number): string {
	return value.replace(/</g, "‹").replace(/>/g, "›").trim().slice(0, max);
}

export function automationSlackBlocks(
	report: ReportMeta,
	reportUrl: string,
): any[] {
	const title = neutralText(report.title, 150);
	const summary = neutralText(
		report.summary || "Open the report for details.",
		1200,
	);
	const signal = `${report.urgency} urgency · ${report.confidence} confidence`;
	const actions: any[] = [];
	if (report.tasks?.length) {
		actions.push({
			type: "button",
			text: { type: "plain_text", text: "Fix these" },
			style: "primary",
			action_id: "report-fix-all",
			value: JSON.stringify({
				automationId: report.automationId,
				reportId: report.id,
			}),
		});
	}
	actions.push({
		type: "button",
		text: { type: "plain_text", text: "Open report" },
		url: reportUrl,
	});
	return [
		{ type: "header", text: { type: "plain_text", text: title } },
		{
			type: "section",
			text: { type: "plain_text", text: `${signal}\n${summary}` },
		},
		{ type: "actions", elements: actions },
	];
}

/**
 * Validate required reports and deliver enabled downstream sinks. Disabled
 * Slack outputs make no network calls. Receipts dedupe successful deliveries.
 */
export async function deliverAutomationOutputs(opts: {
	automationId: string;
	outputs?: AutomationOutput[];
	sessionId: string;
	startedAt: Date;
}): Promise<void> {
	if (!opts.outputs?.length) return;
	const reports = listReportsForSession(opts.sessionId).filter(
		(report) => Date.parse(report.createdAt) >= opts.startedAt.getTime(),
	);
	const latest = reports[0];
	const requiredReport = opts.outputs.find(
		(output): output is ReportAutomationOutput =>
			output.type === "report" &&
			output.enabled !== false &&
			(output.publish || "always") === "always",
	);
	if (requiredReport && !latest)
		throw new Error("Required report output was not published");
	if (!latest) return;

	for (const output of opts.outputs) {
		if (output.type !== "slack" || output.enabled === false) continue;
		if (!reportMeetsThreshold(latest, output)) continue;
		const state = readOutputState(opts.automationId);
		if (state.delivered[output.id]?.reportId === latest.id) continue;
		const reportUrl = `${configuredServer().publicBaseUrl.replace(/\/+$/, "")}/reports/${encodeURIComponent(latest.automationId)}/${encodeURIComponent(latest.id)}`;
		const title = neutralText(latest.title, 150);
		const summary = neutralText(
			latest.summary || "Open the report for details.",
			1200,
		);
		const signal = `${latest.urgency} urgency · ${latest.confidence} confidence`;
		const { postSlackBlocks } = await import("../agents/slack/slack-api");
		const response = await postSlackBlocks(
			output.channel,
			`${title}: ${signal}\n${summary}\n${reportUrl}`,
			automationSlackBlocks(latest, reportUrl),
		);
		if (!response?.ok)
			throw new Error(`Slack output failed: ${response?.error || "unknown error"}`);
		const next = readOutputState(opts.automationId);
		next.delivered[output.id] = {
			reportId: latest.id,
			at: new Date().toISOString(),
		};
		const db = outputStateDb ?? managedFeltDb();
		await db.transaction((tx) => {
			tx.collection<OutputState>(OUTPUT_STATE_COLLECTION).set(opts.automationId, next,
				next.__version ? { ifVersion: next.__version } : { requireAbsent: true });
		}, { transactionId: `opensession:automation-output-state:${opts.automationId}:${crypto.randomUUID()}` });
		const saved = await db.collection<OutputState>(OUTPUT_STATE_COLLECTION).get(opts.automationId);
		if (!saved) throw new Error(`Automation output state ${opts.automationId} disappeared after save`);
		outputStates.set(opts.automationId, saved);
	}
}
