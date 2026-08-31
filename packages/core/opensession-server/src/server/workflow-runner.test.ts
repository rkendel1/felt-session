import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFeltDB } from "@feltdb/core";
import {
	cancelWorkflow,
	checkScriptSyntax,
	parseWorkflowMeta,
	startWorkflow,
	type StartWorkflowOpts,
} from "./workflow-runner";
import { getWorkflowRun, initializeManagedWorkflows, readWorkflowJournal } from "./workflow-store";
import {
	WORKFLOW_LIMITS,
	isMcpJournalEntry,
	type WorkflowAgentOutcome,
	type WorkflowAgentRequest,
	type WorkflowExecCtx,
	type WorkflowExecutor,
	type WorkflowJournalEntry,
	type WorkflowRunSnapshot,
} from "./workflow-types";
import type { WorkflowMcpHost } from "./workflow-mcp";

const savedEnv = process.env.OPENSESSION_WORKFLOWS_DIR;
const dirs: string[] = [];

beforeEach(async () => {
	const dir = mkdtempSync(join(tmpdir(), "wf-runner-test-"));
	dirs.push(dir);
	process.env.OPENSESSION_WORKFLOWS_DIR = dir;
	await initializeManagedWorkflows(
		createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
		dir,
	);
});

afterAll(() => {
	if (savedEnv === undefined) delete process.env.OPENSESSION_WORKFLOWS_DIR;
	else process.env.OPENSESSION_WORKFLOWS_DIR = savedEnv;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecCall = { req: WorkflowAgentRequest; ctx: WorkflowExecCtx };

function fakeExecutor(
	fn: (
		req: WorkflowAgentRequest,
		ctx: WorkflowExecCtx,
	) => WorkflowAgentOutcome | Promise<WorkflowAgentOutcome>,
): WorkflowExecutor & { calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	return {
		calls,
		async execute(req, ctx) {
			calls.push({ req, ctx });
			return fn(req, ctx);
		},
	};
}

/** Echo executor: resolves every prompt to "R:<prompt>". */
function echoExecutor(tokens?: { input: number; output: number }) {
	return fakeExecutor((req) => ({ ok: true, text: `R:${req.prompt}`, ...(tokens ? { tokens } : {}) }));
}

async function waitUntil<T>(
	fn: () => T | undefined | false | null,
	timeoutMs = 8_000,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

function waitForFinished(runId: string): Promise<WorkflowRunSnapshot> {
	return waitUntil(() => {
		const s = getWorkflowRun(runId);
		return s && s.status !== "running" ? s : undefined;
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function start(overrides: Partial<StartWorkflowOpts> & { script: string; executor: WorkflowExecutor }) {
	return startWorkflow({
		sessionId: "bks-wf-test",
		cwd: "/tmp",
		...overrides,
	});
}

// ── parseWorkflowMeta ────────────────────────────────────────────────────────

describe("parseWorkflowMeta", () => {
	test("valid meta parses and the export is stripped from the body", () => {
		const script = `export const meta = { name: "audit", description: "check things" };\nreturn 1;`;
		const { meta, body } = parseWorkflowMeta(script);
		expect(meta.name).toBe("audit");
		expect(meta.description).toBe("check things");
		expect(body).not.toContain("export");
		expect(body).toContain("return 1;");
	});

	test("nested object literals (phases) survive the balanced-brace scan", () => {
		const script = [
			"export const meta = {",
			'\tname: "nested",',
			"\tphases: [",
			'\t\t{ title: "One", detail: "curly } in a string" },',
			'\t\t{ title: "Two" },',
			"\t],",
			"};",
			'return "body";',
		].join("\n");
		const { meta, body } = parseWorkflowMeta(script);
		expect(meta.phases?.map((p) => p.title)).toEqual(["One", "Two"]);
		expect(body.trim()).toBe('return "body";');
	});

	test("missing meta throws", () => {
		expect(() => parseWorkflowMeta("return 1;")).toThrow(/export const meta/);
	});

	test("non-literal meta throws", () => {
		expect(() =>
			parseWorkflowMeta("export const meta = buildMeta();\nreturn 1;"),
		).toThrow(/object literal/);
		expect(() =>
			parseWorkflowMeta("export const meta = { name: undefinedRef() };\nreturn 1;"),
		).toThrow(/object literal/);
		expect(() =>
			parseWorkflowMeta('export const meta = { name: "" };\nreturn 1;'),
		).toThrow(/meta\.name/);
	});
});

// ── Workflow execution ───────────────────────────────────────────────────────

describe("workflow runner", () => {
	test("happy path: phases, agents, logs, journal, result", async () => {
		const executor = echoExecutor({ input: 5, output: 7 });
		const { runId } = start({
			script: [
				'export const meta = { name: "happy", phases: [{ title: "Gather" }, { title: "Summarize" }] };',
				'phase("Gather");',
				'log("starting");',
				'const a = await agent("list things", { label: "lister" });',
				'phase("Summarize");',
				'const b = await agent("summarize: " + a);',
				"return { a, b };",
			].join("\n"),
			executor,
			user: "alex",
			defaultModel: "claude-sonnet-5",
		});

		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual({
			a: "R:list things",
			b: "R:summarize: R:list things",
		});
		expect(s.name).toBe("happy");
		expect(s.phases).toEqual(["Gather", "Summarize"]);
		expect(s.currentPhase).toBe("Summarize");
		expect(s.logs.map((l) => l.message)).toEqual(["starting"]);
		expect(s.agents.length).toBe(2);
		expect(s.agents[0].label).toBe("lister");
		expect(s.agents[0].phase).toBe("Gather");
		expect(s.agents[0].status).toBe("done");
		expect(s.agents[1].phase).toBe("Summarize");
		expect(s.agents[1].status).toBe("done");
		expect(s.agents[1].label).toBe("summarize: R:list things");
		expect(s.totals).toEqual({ agents: 2, tokensIn: 10, tokensOut: 14 });
		expect(s.endedAt).toBeTruthy();

		// Executor got the run context.
		expect(executor.calls[0].ctx.sessionId).toBe("bks-wf-test");
		expect(executor.calls[0].ctx.cwd).toBe("/tmp");
		expect(executor.calls[0].ctx.user).toBe("alex");
		expect(executor.calls[0].ctx.defaultModel).toBe("claude-sonnet-5");

		const journal = readWorkflowJournal(runId) as WorkflowJournalEntry[];
		expect(journal.length).toBe(2);
		expect(journal[0].prompt).toBe("list things");
		expect(journal[0].outcome.text).toBe("R:list things");
		expect(journal[0].hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("parallel: a thrown thunk resolves to null, others land", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "par" };',
				"return await parallel([",
				'\t() => agent("one"),',
				'\t() => { throw new Error("boom"); },',
				'\t() => agent("two"),',
				"]);",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual(["R:one", null, "R:two"]);
		expect(executor.calls.length).toBe(2);
	});

	test("pipeline: no barrier between stages", async () => {
		const seen: string[] = [];
		const holdS1B = deferred<WorkflowAgentOutcome>();
		const executor = fakeExecutor((req) => {
			seen.push(req.prompt);
			if (req.prompt === "s1:B") return holdS1B.promise;
			return { ok: true, text: `R:${req.prompt}` };
		});
		const { runId } = start({
			script: [
				'export const meta = { name: "pipe" };',
				"return await pipeline(args.items,",
				'\t(item) => agent("s1:" + item),',
				'\t(prev, item) => agent("s2:" + item + ":" + prev),',
				");",
			].join("\n"),
			args: { items: ["A", "B"] },
			executor,
		});

		// Item A reaches stage 2 while item B's stage 1 is still in flight —
		// that's the no-barrier property.
		await waitUntil(() => seen.includes("s2:A:R:s1:A"));
		expect(seen).toContain("s1:B");
		expect(getWorkflowRun(runId)?.status).toBe("running");
		holdS1B.resolve({ ok: true, text: "R:s1:B" });

		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual(["R:s2:A:R:s1:A", "R:s2:B:R:s1:B"]);
	});

	test("pipeline: a throwing stage drops the item to null and skips its remaining stages", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "pipe-throw" };',
				'return await pipeline(["A", "B"],',
				'\t(item) => { if (item === "A") throw new Error("nope"); return agent("s1:" + item); },',
				'\t(prev) => agent("s2:" + prev),',
				");",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual([null, "R:s2:R:s1:B"]);
		// Item A never reached the executor at all.
		expect(executor.calls.map((c) => c.req.prompt).sort()).toEqual([
			"s1:B",
			"s2:R:s1:B",
		]);
	});

	test("schema pass-through: structured outcome reaches the script as an object", async () => {
		const executor = fakeExecutor(() => ({
			ok: true,
			text: '{"answer":42}',
			structured: { answer: 42 },
		}));
		const { runId } = start({
			script: [
				'export const meta = { name: "schema" };',
				'const r = await agent("q", { schema: { type: "object" } });',
				"return r.answer;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toBe(42);
		expect(s.agents[0].structured).toBe(true);
		expect(executor.calls[0].req.opts.schema).toEqual({ type: "object" });
	});

	test("agent error: script receives null, snapshot marks error, run completes", async () => {
		const executor = fakeExecutor(() => ({ ok: false, error: "boom" }));
		const { runId } = start({
			script: [
				'export const meta = { name: "err" };',
				'const r = await agent("bad");',
				"return r === null;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toBe(true);
		expect(s.agents[0].status).toBe("error");
		expect(s.agents[0].error).toBe("boom");
	});

	test("semaphore: concurrent executor calls never exceed the limit", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const executor = fakeExecutor(async (req) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 15));
			inFlight--;
			return { ok: true, text: `R:${req.prompt}` };
		});
		const { runId } = start({
			script: [
				'export const meta = { name: "sem" };',
				"const thunks = [];",
				'for (let i = 0; i < 20; i++) thunks.push(() => agent("job " + i));',
				"const out = await parallel(thunks);",
				"return out.length;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toBe(20);
		expect(executor.calls.length).toBe(20);
		expect(maxInFlight).toBeLessThanOrEqual(WORKFLOW_LIMITS.maxConcurrentAgents);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	test("Date.now / argless new Date / Math.random throw inside scripts; new Date(ms) works", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "poison" };',
				"const out = [];",
				'try { Date.now(); out.push("now-ok"); } catch { out.push("now-threw"); }',
				'try { new Date(); out.push("date-ok"); } catch { out.push("date-threw"); }',
				'try { Math.random(); out.push("rand-ok"); } catch { out.push("rand-threw"); }',
				'out.push(new Date(0).getTime() === 0 ? "date-ms-ok" : "date-ms-bad");',
				"return out;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual([
			"now-threw",
			"date-threw",
			"rand-threw",
			"date-ms-ok",
		]);
	});

	test("script throw → run status error with the message", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: 'export const meta = { name: "throws" };\nthrow new Error("script exploded");',
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("error");
		expect(s.error).toBe("script exploded");
	});

	test("budget: total/spent/remaining track executor output tokens", async () => {
		const executor = echoExecutor({ input: 10, output: 250 });
		const { runId } = start({
			script: [
				'export const meta = { name: "budget" };',
				"const before = budget.remaining();",
				'await agent("a");',
				"return { total: budget.total, spent: budget.spent(), before, after: budget.remaining() };",
			].join("\n"),
			executor,
			budgetTotal: 1000,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual({ total: 1000, spent: 250, before: 1000, after: 750 });
	});

	test("budget: unbounded when no total given", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "budget-unbounded" };',
				"return { total: budget.total, unbounded: budget.remaining() === Infinity };",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.result).toEqual({ total: null, unbounded: true });
	});

	test("cancelWorkflow mid-run: status cancelled, signal aborted, worker gone", async () => {
		let capturedCtx: WorkflowExecCtx | undefined;
		const executor = fakeExecutor(
			(_req, ctx) =>
				new Promise<WorkflowAgentOutcome>((resolve) => {
					capturedCtx = ctx;
					ctx.signal.addEventListener("abort", () =>
						resolve({ ok: false, error: "aborted" }),
					);
				}),
		);
		const { runId } = start({
			script: [
				'export const meta = { name: "cancel-me" };',
				'await agent("block forever");',
				'return "never";',
			].join("\n"),
			executor,
		});

		await waitUntil(() => executor.calls.length === 1);
		expect(cancelWorkflow(runId)).toBe(true);

		const s = await waitForFinished(runId);
		expect(s.status).toBe("cancelled");
		expect(s.result).toBeUndefined();
		expect(s.agents[0].status).toBe("cancelled");
		expect(capturedCtx?.signal.aborted).toBe(true);
		// Unregistered: a second cancel finds no live run.
		expect(cancelWorkflow(runId)).toBe(false);
	});

	test("startWorkflow validates script size", () => {
		expect(() =>
			start({
				script:
					'export const meta = { name: "big" };\n' +
					"//".padEnd(WORKFLOW_LIMITS.maxScriptChars, "x"),
				executor: echoExecutor(),
			}),
		).toThrow(/too large/);
	});

	test("journal replay: identical resume answers every call from the journal", async () => {
		const script = [
			'export const meta = { name: "replay" };',
			'const a = await agent("first");',
			'const b = await agent("second:" + a);',
			"return [a, b];",
		].join("\n");
		const executor1 = echoExecutor();
		const { runId } = start({ script, executor: executor1 });
		const first = await waitForFinished(runId);
		expect(first.status).toBe("done");
		expect(executor1.calls.length).toBe(2);

		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.status).toBe("done");
		expect(resumed.result).toEqual(first.result);
		expect(executor2.calls.length).toBe(0);
		expect(resumed.agents.map((a) => a.cached)).toEqual([true, true]);
		// Cached entries were re-journaled, so resuming the resumed run works too.
		expect(readWorkflowJournal(resumedId).length).toBe(2);
	});

	test("journal replay: a changed prompt re-executes from the changed call, unrelated calls stay cached", async () => {
		const scriptV1 = [
			'export const meta = { name: "replay2" };',
			'const a = await agent("alpha");',
			'const b = await agent("beta");',
			'const c = await agent("gamma:" + a);',
			"return [a, b, c];",
		].join("\n");
		const executor1 = echoExecutor();
		const { runId } = start({ script: scriptV1, executor: executor1 });
		await waitForFinished(runId);
		expect(executor1.calls.length).toBe(3);

		const scriptV2 = scriptV1.replace('"alpha"', '"alpha-v2"');
		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script: scriptV2,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.status).toBe("done");
		expect(resumed.result).toEqual(["R:alpha-v2", "R:beta", "R:gamma:R:alpha-v2"]);
		// The changed call and its downstream re-executed; the untouched one
		// replayed from the journal.
		expect(executor2.calls.map((c) => c.req.prompt).sort()).toEqual([
			"alpha-v2",
			"gamma:R:alpha-v2",
		]);
		const bySeq = new Map(resumed.agents.map((a) => [a.seq, a]));
		expect(bySeq.get(0)?.cached).toBeUndefined();
		expect(bySeq.get(1)?.cached).toBe(true);
		expect(bySeq.get(2)?.cached).toBeUndefined();
	});
});

// ── Review-pass fixes (2026-07-10) ───────────────────────────────────────────

describe("hostile meta (static parser, zero evaluation)", () => {
	test("IIFE in a value is rejected and never executes", () => {
		(globalThis as any).__wfMetaPwned = undefined;
		expect(() =>
			parseWorkflowMeta(
				'export const meta = { name: (() => { globalThis.__wfMetaPwned = 1; return "x"; })() };\nreturn 1;',
			),
		).toThrow(/pure object literal/);
		expect((globalThis as any).__wfMetaPwned).toBeUndefined();
	});

	test("getters, computed keys, assignments, templates and identifier values are rejected", () => {
		const hostile = [
			'export const meta = { get name() { return "x"; } };',
			'export const meta = { ["na" + "me"]: "x" };',
			'export const meta = { name: globalThis.__x = "y" };',
			"export const meta = { name: `tpl${1}` };",
			"export const meta = { name: process.env.HOME };",
			'export const meta = { name: "ok", phases: [{ title: Date }] };',
		];
		for (const script of hostile) {
			expect(() => parseWorkflowMeta(script + "\nreturn 1;")).toThrow(
				/pure object literal/,
			);
		}
	});

	test("prototype-polluting keys are dropped, comments and trailing commas parse", () => {
		const { meta } = parseWorkflowMeta(
			[
				"export const meta = {",
				"\t// a comment",
				'\tname: "safe", /* inline */',
				'\t__proto__: { polluted: true },',
				"};",
				"return 1;",
			].join("\n"),
		);
		expect(meta.name).toBe("safe");
		expect(({} as any).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
	});
});

describe("journal replay determinism", () => {
	const RACY_SCRIPT = [
		'export const meta = { name: "racy" };',
		"const [x, y] = await parallel([",
		'\tasync () => { const a1 = await agent("a1"); return agent("a2:" + a1); },',
		'\tasync () => { const b1 = await agent("b1"); return agent("b2:" + b1); },',
		"]);",
		"return [x, y];",
	].join("\n");

	test("parallel dependent chains replay fully even when live completion order differed", async () => {
		// Live run: a1 deliberately slow, so b's chain finishes first and the
		// journal's call order is a1, b1, b2, a2 — NOT replay call order.
		const executor1 = fakeExecutor(async (req) => {
			if (req.prompt === "a1") await new Promise((r) => setTimeout(r, 120));
			return { ok: true, text: `R:${req.prompt}` };
		});
		const { runId } = start({ script: RACY_SCRIPT, executor: executor1 });
		const first = await waitForFinished(runId);
		expect(first.status).toBe("done");
		expect(executor1.calls.length).toBe(4);

		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script: RACY_SCRIPT,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.status).toBe("done");
		expect(resumed.result).toEqual(first.result);
		expect(executor2.calls.length).toBe(0);
		expect(resumed.agents.every((a) => a.cached)).toBe(true);
	});

	test("identical parallel agent calls replay in invocation order", async () => {
		const script = [
			'export const meta = { name: "identical-agents" };',
			'return await parallel([() => agent("same"), () => agent("same")]);',
		].join("\n");
		const firstResult = deferred<WorkflowAgentOutcome>();
		let invocation = 0;
		const executor1 = fakeExecutor(() => {
			const current = invocation++;
			return current === 0
				? firstResult.promise
				: { ok: true, text: "second" };
		});
		const { runId } = start({ script, executor: executor1 });
		await waitUntil(() => readWorkflowJournal(runId).length === 1);
		firstResult.resolve({ ok: true, text: "first" });
		const first = await waitForFinished(runId);
		expect(first.result).toEqual(["first", "second"]);
		// The faster second call is physically appended first.
		expect(
			readWorkflowJournal(runId)
				.filter((entry): entry is WorkflowJournalEntry => !isMcpJournalEntry(entry))
				.map((entry) => entry.seq),
		).toEqual([1, 0]);

		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.result).toEqual(first.result);
		expect(executor2.calls).toHaveLength(0);
	});

	test("failed outcomes are journaled but re-executed on resume", async () => {
		const script = [
			'export const meta = { name: "retry" };',
			'const bad = await agent("flaky");',
			'const good = await agent("solid");',
			"return [bad, good];",
		].join("\n");
		const executor1 = fakeExecutor((req) =>
			req.prompt === "flaky"
				? { ok: false, error: "transient" }
				: { ok: true, text: `R:${req.prompt}` },
		);
		const { runId } = start({ script, executor: executor1 });
		const first = await waitForFinished(runId);
		expect(first.result).toEqual([null, "R:solid"]);
		// Both outcomes are journaled (audit trail)…
		expect(readWorkflowJournal(runId).length).toBe(2);

		// …but only the ok one replays; the failure gets a fresh execution.
		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.result).toEqual(["R:flaky", "R:solid"]);
		expect(executor2.calls.map((c) => c.req.prompt)).toEqual(["flaky"]);
	});

	test("budget.spent() replays identically (original tokensOut reported for cached calls)", async () => {
		const script = [
			'export const meta = { name: "budgeted" };',
			'await agent("one");',
			'await agent("two");',
			"return budget.spent();",
		].join("\n");
		const executor1 = echoExecutor({ input: 10, output: 100 });
		const { runId } = start({ script, executor: executor1, budgetTotal: 1000 });
		const first = await waitForFinished(runId);
		expect(first.result).toBe(200);

		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script,
			executor: executor2,
			resumeFromRunId: runId,
			budgetTotal: 1000,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.result).toBe(200);
		expect(executor2.calls.length).toBe(0);
		// Display totals stay this-run-only (cached calls cost nothing now).
		expect(resumed.totals.tokensOut).toBe(0);
	});
});

describe("worker containment & lifecycle", () => {
	test("script sees no Bun/process/fetch/WebSocket/globalThis (exfil/spawn surface shadowed)", async () => {
		const script = [
			'export const meta = { name: "scrubbed" };',
			"return [typeof Bun, typeof process, typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof globalThis].join(',');",
		].join("\n");
		const { runId } = start({ script, executor: echoExecutor() });
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("done");
		expect(snap.result).toBe(
			"undefined,undefined,undefined,undefined,undefined,undefined",
		);
	});

	test("a script cannot exit the worker process (process/globalThis unreachable)", async () => {
		// The containment that makes the close-handler's uncommanded-exit case
		// rare: a script has no reachable path to process.exit / self.close.
		const script = [
			'export const meta = { name: "no-exit" };',
			'try { process.exit(0); } catch (e) { return "blocked:" + e.constructor.name; }',
			'return "escaped";',
		].join("\n");
		const { runId } = start({ script, executor: echoExecutor() });
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("done");
		expect(String(snap.result)).toMatch(/^blocked:TypeError/);
	});
});

describe("snapshot payload bounds", () => {
	test("log lines, labels and errors are truncated in the snapshot", async () => {
		const script = [
			'export const meta = { name: "bounded" };',
			'log("x".repeat(10_000));',
			'await agent("p".repeat(5_000), { label: "L".repeat(5_000) });',
			"return 1;",
		].join("\n");
		const executor = fakeExecutor(() => ({ ok: false, error: "E".repeat(50_000) }));
		const { runId } = start({ script, executor });
		const snap = await waitForFinished(runId);
		expect(snap.logs[0].message.length).toBeLessThanOrEqual(501);
		expect(snap.agents[0].label.length).toBeLessThanOrEqual(201);
		expect((snap.agents[0].error || "").length).toBeLessThanOrEqual(1001);
	});
});

// ── Script syntax pre-check (2026-07-11: truncated scripts failed cryptically) ─

describe("checkScriptSyntax", () => {
	test("valid body passes", () => {
		expect(checkScriptSyntax('phase("x"); return await agent("hi");')).toBeNull();
	});

	test("a truncated body (cut mid-statement) is flagged as likely-truncated", () => {
		// Exactly the real-world failure: the run_workflow arg was cut off.
		const msg = checkScriptSyntax('const findings = results.filter(');
		expect(msg).toBeTruthy();
		expect(msg).toMatch(/syntax error/i);
		expect(msg).toMatch(/truncated/i);
	});

	test("unbalanced brace is flagged", () => {
		const msg = checkScriptSyntax('if (x) { log("a")');
		expect(msg).toMatch(/syntax error/i);
	});

	test("a plain (non-truncation) syntax error omits the truncation hint", () => {
		const msg = checkScriptSyntax("return 1 2 3;");
		expect(msg).toBeTruthy();
		expect(msg).not.toMatch(/truncated/i);
	});

	test("startWorkflow throws synchronously on a truncated script (no run created)", () => {
		expect(() =>
			startWorkflow({
				sessionId: "bks-x",
				cwd: "/tmp",
				executor: echoExecutor(),
				script:
					'export const meta = { name: "broken" };\nconst r = await parallel([() => agent("hi"',
			}),
		).toThrow(/truncated/i);
	});
});

// ── mcp.* (direct tool calls from the script) ────────────────────────────────

/** Fake MCP host: records calls, no transport. */
function fakeMcpHost(
	call: (server: string, tool: string, args: unknown) => unknown,
	servers: string[] = ["grafana", "linear"],
): WorkflowMcpHost & {
	calls: Array<{ server: string; tool: string; args: unknown }>;
	isClosed: () => boolean;
} {
	const calls: Array<{ server: string; tool: string; args: unknown }> = [];
	let closed = false;
	return {
		calls,
		isClosed: () => closed,
		servers: () => servers,
		async tools(server: string) {
			return [{ name: `${server}_probe`, description: "probe" }];
		},
		async call(server: string, tool: string, args: unknown) {
			calls.push({ server, tool, args });
			return call(server, tool, args);
		},
		async close() {
			closed = true;
		},
	};
}

describe("workflow mcp.*", () => {
	test("mcp.<server>.<tool>(args) reaches the host and resolves its value", async () => {
		const mcpHost = fakeMcpHost(() => [{ id: 1 }, { id: 2 }]);
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost,
			script: [
				'export const meta = { name: "mcp-basic" };',
				'const rows = await mcp.grafana.query_prometheus({ expr: "up" });',
				"return rows.length;",
			].join("\n"),
		});
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("done");
		expect(snap.result).toBe(2);
		expect(mcpHost.calls).toEqual([
			{ server: "grafana", tool: "query_prometheus", args: { expr: "up" } },
		]);
		// No agent was spent on the lookup — that's the whole point.
		expect(snap.agents.length).toBe(0);
		expect(snap.totals.mcpCalls).toBe(1);
	});

	test("a failing tool call REJECTS in the script (and parallel degrades it to null)", async () => {
		const mcpHost = fakeMcpHost((_s, tool) => {
			if (tool === "boom") throw new Error("upstream 500");
			return "fine";
		});
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost,
			script: [
				'export const meta = { name: "mcp-error" };',
				"const batch = await parallel([",
				"  () => mcp.grafana.ok({}),",
				"  () => mcp.grafana.boom({}),",
				"]);",
				'let caught = "";',
				"try { await mcp.grafana.boom({}); } catch (e) { caught = e.message; }",
				"return { batch, caught };",
			].join("\n"),
		});
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("done");
		const result = snap.result as { batch: unknown[]; caught: string };
		expect(result.batch).toEqual(["fine", null]);
		expect(result.caught).toContain("upstream 500");
		expect(snap.totals.mcpCalls).toBe(3);
		expect(snap.totals.mcpErrors).toBe(2);
		const failed = (snap.mcpCalls || []).filter((c) => !c.ok);
		expect(failed.length).toBe(2);
		expect(failed[0].tool).toBe("boom");
	});

	test("calls are journaled as kind:mcp, with args and value", async () => {
		const mcpHost = fakeMcpHost(() => ({ status: "ok" }));
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost,
			script: [
				'export const meta = { name: "mcp-journal" };',
				'return await mcp.linear.list_issues({ team: "ENG" });',
			].join("\n"),
		});
		await waitForFinished(runId);
		const entries = readWorkflowJournal(runId).filter(isMcpJournalEntry);
		expect(entries.length).toBe(1);
		expect(entries[0].server).toBe("linear");
		expect(entries[0].tool).toBe("list_issues");
		expect(entries[0].args).toEqual({ team: "ENG" });
		expect(entries[0].ok).toBe(true);
		expect(entries[0].value).toEqual({ status: "ok" });
		expect(entries[0].hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("resume REPLAYS a tool call from the journal instead of re-firing it", async () => {
		const script = [
			'export const meta = { name: "mcp-resume" };',
			'return await mcp.linear.create_issue({ title: "once" });',
		].join("\n");
		const first = fakeMcpHost(() => "ISSUE-1");
		const { runId } = start({ executor: echoExecutor(), mcpHost: first, script });
		const done = await waitForFinished(runId);
		expect(done.result).toBe("ISSUE-1");

		// A host that would answer differently — it must never be asked.
		const second = fakeMcpHost(() => "ISSUE-2");
		const { runId: resumedId } = start({
			executor: echoExecutor(),
			mcpHost: second,
			script,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.result).toBe("ISSUE-1");
		expect(second.calls.length).toBe(0);
		expect((resumed.mcpCalls || [])[0]?.cached).toBe(true);
		// The replayed record carries into the new run's journal, so resuming
		// the resumed run replays too.
		expect(readWorkflowJournal(resumedId).filter(isMcpJournalEntry).length).toBe(1);
	});

	test("identical parallel tool calls replay in invocation order", async () => {
		const script = [
			'export const meta = { name: "mcp-identical" };',
			"return await parallel([",
			"  () => mcp.linear.create_issue({ title: 'same' }),",
			"  () => mcp.linear.create_issue({ title: 'same' }),",
			"]);",
		].join("\n");
		const firstResult = deferred<string>();
		let invocation = 0;
		const firstHost = fakeMcpHost(() => {
			const current = invocation++;
			return current === 0 ? firstResult.promise : "ISSUE-2";
		});
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost: firstHost,
			script,
		});
		await waitUntil(() => readWorkflowJournal(runId).length === 1);
		firstResult.resolve("ISSUE-1");
		const first = await waitForFinished(runId);
		expect(first.result).toEqual(["ISSUE-1", "ISSUE-2"]);
		expect(
			readWorkflowJournal(runId).filter(isMcpJournalEntry).map((entry) => entry.seq),
		).toEqual([1, 0]);

		const secondHost = fakeMcpHost(() => "must not run");
		const { runId: resumedId } = start({
			executor: echoExecutor(),
			mcpHost: secondHost,
			script,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.result).toEqual(first.result);
		expect(secondHost.calls).toHaveLength(0);
	});

	test("a failed call is NOT replayed — resume retries it", async () => {
		const script = [
			'export const meta = { name: "mcp-retry" };',
			'try { return await mcp.grafana.flaky({}); } catch (e) { return "failed: " + e.message; }',
		].join("\n");
		const failing = fakeMcpHost(() => {
			throw new Error("timeout");
		});
		const { runId } = start({ executor: echoExecutor(), mcpHost: failing, script });
		expect((await waitForFinished(runId)).result).toBe("failed: timeout");

		const healthy = fakeMcpHost(() => "recovered");
		const { runId: resumedId } = start({
			executor: echoExecutor(),
			mcpHost: healthy,
			script,
			resumeFromRunId: runId,
		});
		expect((await waitForFinished(resumedId)).result).toBe("recovered");
		expect(healthy.calls.length).toBe(1);
	});

	test("mcp.servers() and mcp.tools(server) enumerate without journaling", async () => {
		const mcpHost = fakeMcpHost(() => null, ["grafana", "plain"]);
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost,
			script: [
				'export const meta = { name: "mcp-discovery" };',
				"const servers = await mcp.servers();",
				"const tools = await mcp.tools(servers[0]);",
				"return { servers, first: tools[0].name };",
			].join("\n"),
		});
		const snap = await waitForFinished(runId);
		expect(snap.result).toEqual({
			servers: ["grafana", "plain"],
			first: "grafana_probe",
		});
		// Discovery is config, not an observation — nothing to replay.
		expect(readWorkflowJournal(runId).filter(isMcpJournalEntry).length).toBe(0);
		expect(snap.totals.mcpCalls).toBeUndefined();
	});

	test("the proxy is thenable-safe: awaiting mcp or a server does not hang", async () => {
		const mcpHost = fakeMcpHost(() => "ok");
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost,
			script: [
				'export const meta = { name: "mcp-thenable" };',
				"const server = await mcp.grafana;",
				"return {",
				"  mcpThen: mcp.then === undefined,",
				"  serverThen: mcp.grafana.then === undefined,",
				'  stillCallable: typeof server.query === "function",',
				"};",
			].join("\n"),
		});
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("done");
		expect(snap.result).toEqual({
			mcpThen: true,
			serverThen: true,
			stillCallable: true,
		});
	});

	test("the host is closed when the run finishes (stdio servers are processes)", async () => {
		const mcpHost = fakeMcpHost(() => "ok");
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost,
			script: [
				'export const meta = { name: "mcp-teardown" };',
				"return await mcp.grafana.ping({});",
			].join("\n"),
		});
		await waitForFinished(runId);
		await waitUntil(() => mcpHost.isClosed());
		expect(mcpHost.isClosed()).toBe(true);
	});

	test("a cancelled workflow settles in-flight tool calls instead of hanging", async () => {
		const gate = deferred<void>();
		const mcpHost = fakeMcpHost(() => {
			// Never resolves until the run is cancelled out from under it.
			return gate.promise.then(() => "late");
		});
		const { runId } = start({
			executor: echoExecutor(),
			mcpHost,
			script: [
				'export const meta = { name: "mcp-cancel" };',
				'try { await mcp.grafana.slow({}); return "resolved"; }',
				'catch (e) { return "rejected"; }',
			].join("\n"),
		});
		await waitUntil(() => mcpHost.calls.length > 0);
		expect(cancelWorkflow(runId)).toBe(true);
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("cancelled");
		gate.resolve();
	});
});
