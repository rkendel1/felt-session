/**
 * opensession-workflows — dynamic workflows: run a model-authored JS script
 * that fans out lightweight agent runs deterministically (map-reduce over a
 * codebase, N-way audits, comparative research) and calls MCP tools directly.
 * The script executes in a
 * contained Bun Worker (env-scrubbed, exfil/spawn globals stripped — see
 * workflow-worker.ts; exposure gating is the real boundary); each agent()
 * call becomes a plain opencode run in ask mode, while mcp.* calls go through
 * workflow-mcp.ts — a round trip, not a model turn, scoped by the
 * ctx.mcpAllowlist/deniedTools this server was built with (see
 * src/server/workflow-types.ts for the contract, workflow-runner.ts for
 * orchestration). Interactive sessions, plus automations a HUMAN flagged
 * with `workflows: true` (automations.ts registers the instance per run —
 * e.g. the morning support digest, whose cron prompt is our own text).
 * Never set that flag on automations triggered by untrusted event/ticket
 * text (Plain triage, channel watches): model-authored code execution must
 * not be steerable from a ticket. The fail-closed gate in interactive-mcp.ts
 * still withholds the interactive builder from automation-owned sessions;
 * flagged automations only get the instance automations.ts explicitly
 * registers (human-authorized).
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { startWorkflow, cancelWorkflow } from "../../server/workflow-runner";
import {
	getWorkflowRun,
	listWorkflowRunsForSession,
	readWorkflowScript,
} from "../../server/workflow-store";
import { WORKFLOW_LIMITS } from "../../server/workflow-types";
import { selectableModels } from "../../server/models";
import type {
	WorkflowAgentSnapshot,
	WorkflowRunSnapshot,
} from "../../server/workflow-types";

/**
 * The model workflow agents run on when the script doesn't name one.
 * Deliberately NOT the session's model: a fan-out inherits whatever the
 * orchestrator happens to be on (Fable), which is both expensive and not
 * obviously the right worker. Opus is the strong default — intelligence first,
 * cost only a tie-breaker (CLAUDE.md's priority rule). A script can still route
 * per agent via opts.model when it has a reason to.
 */
export const WORKFLOW_DEFAULT_MODEL = "claude-opus-5";

export interface WorkflowsToolContext {
	sessionId: string;
	user?: string;
	/** Resolved lazily per call — repos can attach or switch mid-run. */
	workspace: (
		repo?: string,
		hint?: string,
	) => { cwd: string; repo?: string; baseBranch?: string } | undefined;
	/** Overrides WORKFLOW_DEFAULT_MODEL for agent() calls that name no model.
	 *  Left unset in production — agents default to Opus, not the session's model. */
	defaultModel?: () => string | undefined;
	/** MCP allowlist for the script's mcp.* calls. Omitted (interactive
	 *  sessions) = every server this user's own runs may see; an automation
	 *  passes its own least-privilege list so a script can't widen it. */
	mcpAllowlist?: string[];
	/** Per-call tool denials for mcp.* (automation runs: Plain customer-facing
	 *  writes, WorkOS identity mutation). */
	deniedTools?: Record<string, string>;
}

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

function elapsed(run: WorkflowRunSnapshot): string {
	const start = Date.parse(run.startedAt);
	const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
	const s = Math.max(0, Math.round((end - start) / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

function countByStatus(agents: WorkflowAgentSnapshot[]): string {
	const counts = new Map<string, number>();
	for (const a of agents) counts.set(a.status, (counts.get(a.status) || 0) + 1);
	return ["done", "running", "pending", "error", "cancelled"]
		.filter((st) => counts.get(st))
		.map((st) => `${counts.get(st)} ${st}`)
		.join(", ");
}

/** Built per server so the MODEL line lists the CURRENT selectable models
 *  (from the live registry — see selectableModels), never a hardcoded set. */
function runWorkflowDescription(): string {
	const models = selectableModels();
	const modelLine = models.length
		? `MODEL: pick whichever model fits each agent — pass opts.model with any of the currently available ids: ${models
				.map((m) => `${m.id} (${m.label})`)
				.join(
					", ",
				)}. Agents default to ${WORKFLOW_DEFAULT_MODEL} when you don't set one. Choose per task — intelligence and taste first.`
		: `MODEL: agents default to ${WORKFLOW_DEFAULT_MODEL}; pass opts.model to pick another available model per agent.`;
	return RUN_WORKFLOW_DESCRIPTION_TEMPLATE.replace("__MODEL_LINE__", modelLine);
}

const RUN_WORKFLOW_DESCRIPTION_TEMPLATE = `Run a dynamic workflow: a JS script YOU author that fans out many lightweight read/analyze agents deterministically and combines their results — map-reduce over a codebase, N-way file audits, comparative research. Progress streams live to this session's Agents panel; poll workflow_status for the outcome.

Script shape — plain JavaScript (NOT TypeScript), no imports; the API below is injected as globals. A meta export is required, then the async body follows (top-level await AND top-level return are allowed):

export const meta = {
  name: "route-audit",                              // required, short slug
  description: "Audit every route for auth checks", // optional
  phases: [{ title: "List" }, { title: "Audit" }],  // optional, pre-seeds the progress UI
};

Injected globals:
- agent(prompt, opts?) → Promise — run one focused agent (ask mode: reads files / runs read-only commands in this session's worktree; its final message is the return value). Resolves to the final text; with opts.schema (a JSON Schema) resolves to the parsed, validated object instead; resolves to null when the agent errored — filter with .filter(Boolean). opts: { label, phase, schema, model }.
- parallel([...thunks]) → Promise — run zero-arg thunks concurrently and wait for all; a thrown thunk becomes null, never rejects the batch. E.g. await parallel(files.map(f => () => agent("Audit " + f)))
- pipeline(items, ...stages) → Promise — per-item stage chain with NO barrier between stages (item B can run stage 1 while item A is in stage 2). Each stage gets (prevResult, originalItem, index); a throwing stage drops that item to null and skips its remaining stages.
- mcp.<server>.<tool>(args) → Promise — call an MCP tool DIRECTLY from the script (no model turn: one round trip). Resolves to the tool's structured result, or its text auto-parsed as JSON when it parses. REJECTS on failure (unlike agent(), which resolves null) — try/catch it, or let parallel() degrade the throw to null. Also: mcp.call(server, tool, args) (same thing, dynamic names), mcp.servers() → string[], mcp.tools(server) → [{name, description, inputSchema}].
- phase(title) — set the current progress group for subsequent agent calls.
- log(message) — narrator line in the progress feed.
- args — your args_json, parsed, verbatim.
- budget — { total, spent(), remaining() } in output tokens.

AGENT OR TOOL? An agent() is a model turn — use it when the work needs judgement (reading code, summarizing, ranking, deciding). An mcp.* call is a function call — use it whenever you just need DATA from a connected server. Don't spend an agent on "query Prometheus for X" or "fetch that Linear issue": call the tool, filter the rows in the script, and spend agents only on the parts that need thinking. Tool names and argument shapes are the same ones in your own tool list; mcp.servers() / mcp.tools(server) enumerate them at runtime. The surface is exactly what YOUR runs may use (per-user restrictions apply, confirm-gated servers like stripe are never reachable from a script).

__MODEL_LINE__

Rules:
- Date.now(), argless new Date(), and Math.random() THROW inside scripts (they break resume replay determinism) — pass timestamps/seeds via args.
- Agents start fresh with ZERO context from this session — make every prompt self-contained (paths, constraints, what to return).
- Agents are read-only by default (ask mode). Pass opts.write to let one edit code (see below).
- Limits: ${WORKFLOW_LIMITS.maxConcurrentAgents} agents run concurrently (extras queue), ${WORKFLOW_LIMITS.maxAgents} agent() calls per run lifetime, ${Math.round(WORKFLOW_LIMITS.agentTimeoutMs / 60_000)}min per agent, ${Math.round(WORKFLOW_LIMITS.workflowTimeoutMs / 60_000)}min per workflow. mcp.* is cheaper and its own lane: ${WORKFLOW_LIMITS.maxConcurrentMcp} concurrent, ${WORKFLOW_LIMITS.maxMcpCalls} per run, ${Math.round(WORKFLOW_LIMITS.mcpCallTimeoutMs / 1000)}s per call.
- Both agent() and mcp.* calls are journaled, so resume_workflow REPLAYS them instead of re-firing — a resumed script won't create the same Linear issue twice.

Example (no opts.model set → agents run on the default):

export const meta = { name: "route-audit", phases: [{ title: "List" }, { title: "Audit" }, { title: "Rank" }] };
phase("List");
const files = await agent(
  "List every .ts file in src/server/routes of this repo. Reply with ONLY the basenames.",
  { schema: { type: "array", items: { type: "string" } } },
);
if (!files) return "listing failed";
phase("Audit");
const findings = await pipeline(
  files,
  (f) => agent("Read src/server/routes/" + f + " and report missing auth/validation checks. Reply 'none' if clean.", { label: f }),
  (prev, f) => (prev && prev !== "none" ? f + ": " + prev : null),
);
log(findings.filter(Boolean).length + " files with findings");
phase("Rank");
const real = findings.filter(Boolean);
if (!real.length) return "all clean";
return await agent(
  "Rank these route-audit findings by real-world severity and drop the false positives:\\n" + real.join("\\n"),
  { label: "rank findings" },
);

Example of mixing tools and agents (data by tool, judgement by agent):

export const meta = { name: "alert-triage" };
const alerts = await mcp.grafana.list_alert_groups({ state: "new" });
const issues = await mcp.linear.list_issues({ team: "ENG", state: "started" });
// Reduce HERE — every row dropped in the script is a model turn not spent.
const unclaimed = alerts.filter((a) => !issues.some((i) => i.title.includes(a.title)));
log(unclaimed.length + " unclaimed of " + alerts.length);
return await parallel(
  unclaimed.map((a) => () => agent("Assess this alert and say who should own it: " + JSON.stringify(a), { label: a.id })),
);`;

export function createWorkflowsMcpServer(ctx: WorkflowsToolContext) {
	const tools = [
		tool(
			"run_workflow",
			runWorkflowDescription(),
			{
				script: z
					.string()
					.describe(
						"The workflow script: `export const meta = {...}` + plain-JS async body using the injected globals.",
					),
				args_json: z
					.string()
					.optional()
					.describe(
						"JSON string exposed to the script as `args` (parameters, file lists, timestamps — anything the script needs).",
					),
				budget_tokens: z
					.number()
					.optional()
					.describe(
						"Optional output-token budget the script can consult via `budget` (advisory: spent()/remaining()).",
					),
				repo: z
					.string()
					.optional()
					.describe(
						"Repo context for every workflow agent. Pass this when auditing an attached repo so agents start in that exact worktree and can see current/uncommitted changes.",
					),
			},
			async (args: {
				script: string;
				args_json?: string;
				budget_tokens?: number;
				repo?: string;
			}) => {
				let parsedArgs: unknown;
				if (args.args_json !== undefined) {
					try {
						parsedArgs = JSON.parse(args.args_json);
					} catch (e: any) {
						return text(
							`args_json is not valid JSON (${e?.message || String(e)}) — pass a JSON string, e.g. '{"files": ["a.ts"]}'.`,
						);
					}
				}
				const workspace = ctx.workspace(args.repo, args.script);
				if (!workspace) {
					return text(
						args.repo
							? `Repo "${args.repo}" is not attached to this session — attach it first (opensession-repos attach_repo), or choose one of the session's repos.`
							: "This session has no worktree — workflow agents need a working directory. Attach a repo first (opensession-repos attach_repo).",
					);
				}
				try {
					const { runId } = startWorkflow({
						script: args.script,
						args: parsedArgs,
						sessionId: ctx.sessionId,
						user: ctx.user,
						cwd: workspace.cwd,
						repo: workspace.repo,
						baseBranch: workspace.baseBranch,
						defaultModel: ctx.defaultModel?.() || WORKFLOW_DEFAULT_MODEL,
						budgetTotal: args.budget_tokens,
						mcpAllowlist: ctx.mcpAllowlist,
						deniedTools: ctx.deniedTools,
					});
					return text(
						`Workflow started: ${runId}. Poll workflow_status for progress; it also streams live to this session's Agents panel.`,
					);
				} catch (e: any) {
					return text(`Couldn't start workflow: ${e?.message || String(e)}`);
				}
			},
		),
		tool(
			"workflow_status",
			"Progress of a workflow run: status, elapsed, per-phase agent counts, currently-running agents, recent logs — and the script's return value once done. Poll this after run_workflow (the UI panel updates live, but this is how YOU read the result).",
			{
				run_id: z.string().describe("The wf-… run id from run_workflow."),
				include_result: z
					.boolean()
					.optional()
					.describe(
						"Include the script's return value when the run is done (default true).",
					),
			},
			async (args: { run_id: string; include_result?: boolean }) => {
				const run = getWorkflowRun(args.run_id);
				if (!run) return text(`No workflow run ${args.run_id}.`);
				const lines: string[] = [];
				const totals = countByStatus(run.agents);
				lines.push(
					`${run.name} (${run.runId}): ${run.status} · ${elapsed(run)} · ${run.agents.length} agents${totals ? ` (${totals})` : ""}`,
				);
				// Per-phase counts, in first-seen order (+ any agents without a phase).
				const phases = [...run.phases];
				for (const a of run.agents)
					if (a.phase && !phases.includes(a.phase)) phases.push(a.phase);
				const groups: Array<[string, WorkflowAgentSnapshot[]]> = phases.map(
					(p) => [p, run.agents.filter((a: WorkflowAgentSnapshot) => a.phase === p)],
				);
				const unphased = run.agents.filter(
					(a: WorkflowAgentSnapshot) => !a.phase,
				);
				if (unphased.length) groups.push(["(no phase)", unphased]);
				for (const [title, agents] of groups) {
					if (!agents.length) continue;
					const running = agents
						.filter((a) => a.status === "running")
						.map((a) => a.label)
						.slice(0, 5);
					lines.push(
						`  ${title}: ${countByStatus(agents)}${running.length ? ` — running: ${running.join(", ")}` : ""}`,
					);
				}
				if (run.totals.mcpCalls) {
					const errs = run.totals.mcpErrors || 0;
					// Which servers the script actually hit — cheap signal that it's
					// reaching the right data (and where it's erroring).
					const byServer = new Map<string, number>();
					for (const c of run.mcpCalls || [])
						byServer.set(c.server, (byServer.get(c.server) || 0) + 1);
					const servers = [...byServer.entries()]
						.sort((a, b) => b[1] - a[1])
						.slice(0, 5)
						.map(([s, n]) => `${s}×${n}`)
						.join(", ");
					lines.push(
						`  tool calls: ${run.totals.mcpCalls}${errs ? `, ${errs} failed` : ""}${servers ? ` — recent: ${servers}` : ""}`,
					);
					const failures = (run.mcpCalls || []).filter((c) => !c.ok).slice(-3);
					for (const f of failures)
						lines.push(`    ✗ ${f.server}.${f.tool}: ${f.error || "failed"}`);
				}
				if (run.error) lines.push(`Error: ${run.error}`);
				if (run.logs.length) {
					lines.push("Recent logs:");
					for (const l of run.logs.slice(-5))
						lines.push(`  [${l.ts.slice(11, 19)}] ${l.message}`);
				}
				if (run.status === "done" && args.include_result !== false) {
					let result: string;
					try {
						result =
							typeof run.result === "string"
								? run.result
								: JSON.stringify(run.result, null, 2);
					} catch {
						result = String(run.result);
					}
					lines.push("Result:");
					if (result.length > 20_000) {
						// Spill the full value to a scratch file so it isn't lost to
						// the tool-output cap. /tmp/opencode/** is readable by the
						// Read tool in BOTH shell and ask-mode runs (see
						// ASK_EXTERNAL_DIR_PERMISSIONS in opencode-runner.ts), so the
						// agent can read the untruncated result instead of replaying
						// the whole workflow with a compacted return shape (the
						// "resume_workflow just to reshape the return" papercut).
						let spillPath = "";
						try {
							const dir = "/tmp/opencode/workflow-results";
							mkdirSync(dir, { recursive: true });
							spillPath = `${dir}/${run.runId}.txt`;
							writeFileSync(spillPath, result);
						} catch {
							spillPath = "";
						}
						lines.push(
							result.slice(0, 20_000) + "\n… (truncated at 20,000 chars)",
						);
						if (spillPath)
							lines.push(
								`Full result (${result.length} chars) written to ${spillPath} — Read that file for the complete value instead of re-running the workflow.`,
							);
					} else {
						lines.push(result);
					}
				}
				return text(lines.join("\n"));
			},
		),
		tool(
			"list_workflows",
			"List this session's workflow runs, newest first — one line each with run id, name, status and agent count.",
			{},
			async () => {
				const runs = listWorkflowRunsForSession(ctx.sessionId);
				if (!runs.length)
					return text("No workflow runs in this session yet.");
				const lines = runs.map(
					(r: WorkflowRunSnapshot) =>
						`- ${r.runId} ${r.name} — ${r.status}, ${r.agents.length} agents, ${elapsed(r)}, started ${r.startedAt.slice(0, 16).replace("T", " ")}`,
				);
				return text(lines.join("\n"));
			},
		),
		tool(
			"cancel_workflow",
			"Cancel a running workflow: aborts in-flight agents, terminates the script, marks the run cancelled.",
			{
				run_id: z.string().describe("The wf-… run id to cancel."),
			},
			async (args: { run_id: string }) => {
				const ok = cancelWorkflow(args.run_id);
				return text(
					ok
						? `Cancelled ${args.run_id}.`
						: `No live workflow ${args.run_id} — it may have already finished (check workflow_status).`,
				);
			},
		),
		tool(
			"resume_workflow",
			"Re-launch a done/error/interrupted/cancelled workflow run as a NEW run that replays completed agent() calls from the old run's journal (identical prompt+opts resolve instantly as cached) and only re-executes what changed or never finished. Optionally pass a fixed script — unchanged calls still replay from the journal.",
			{
				run_id: z
					.string()
					.describe("The finished wf-… run id to resume from."),
				script: z
					.string()
					.optional()
					.describe(
						"Replacement script (e.g. with a bug fixed). Omit to re-run the original script.",
					),
				args_json: z
					.string()
					.optional()
					.describe(
						"JSON string for the script's `args`. Omit to run with no args — note agent() calls whose prompts derive from args only replay when the prompts come out identical.",
					),
				repo: z
					.string()
					.optional()
					.describe(
						"Repo context for the resumed workflow. Omit to reuse the original run's cwd.",
					),
			},
			async (args: {
				run_id: string;
				script?: string;
				args_json?: string;
				repo?: string;
			}) => {
				const old = getWorkflowRun(args.run_id);
				if (!old) return text(`No workflow run ${args.run_id}.`);
				if (old.status === "running")
					return text(
						`${args.run_id} is still running — cancel_workflow it first, or wait for it to finish.`,
					);
				const script = args.script ?? readWorkflowScript(args.run_id);
				if (!script)
					return text(
						`Couldn't read the original script for ${args.run_id} — pass one explicitly via the script param.`,
					);
				let parsedArgs: unknown;
				if (args.args_json !== undefined) {
					try {
						parsedArgs = JSON.parse(args.args_json);
					} catch (e: any) {
						return text(
							`args_json is not valid JSON (${e?.message || String(e)}).`,
						);
					}
				}
				// New runs persist cwd but older snapshots do not carry repo id.
				// Re-resolve the old cwd as a hint so an attached-repo workflow
				// resumes with the correct repo/base branch for write agents too.
				const workspace = args.repo
					? ctx.workspace(args.repo, script)
					: ctx.workspace(undefined, old.cwd);
				if (args.repo && !workspace)
					return text(`Repo "${args.repo}" is not attached to this session.`);
				try {
					const { runId } = startWorkflow({
						script,
						args: parsedArgs,
						sessionId: ctx.sessionId,
						user: ctx.user,
						cwd: workspace?.cwd || old.cwd,
						repo: workspace?.repo,
						baseBranch: workspace?.baseBranch,
						defaultModel: ctx.defaultModel?.() || WORKFLOW_DEFAULT_MODEL,
						resumeFromRunId: args.run_id,
						mcpAllowlist: ctx.mcpAllowlist,
						deniedTools: ctx.deniedTools,
					});
					return text(
						`Resumed as ${runId} (journal replay from ${args.run_id}). Poll workflow_status; progress streams to the Agents panel.`,
					);
				} catch (e: any) {
					return text(`Couldn't resume workflow: ${e?.message || String(e)}`);
				}
			},
		),
	];

	return createSdkMcpServer({
		name: "opensession-workflows",
		version: "1.0.0",
		tools,
	});
}
