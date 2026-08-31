import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createFeltDB } from "@feltdb/core";
import { tmpdir } from "os";
import { join } from "path";
import {
	appendWorkflowJournal,
	cancelLiveWorkflow,
	createWorkflowRun,
	flushWorkflowWrites,
	getWorkflowRun,
	initializeManagedWorkflows,
	listWorkflowRunsForSession,
	markInterruptedWorkflows,
	readWorkflowJournal,
	readWorkflowScript,
	registerLiveWorkflow,
	unregisterLiveWorkflow,
	updateWorkflowRun,
} from "./workflow-store";
import { WORKFLOW_LIMITS, type WorkflowJournalEntry } from "./workflow-types";

const savedEnv = process.env.OPENSESSION_WORKFLOWS_DIR;
const dirs: string[] = [];
let runCounter = 0;
let workflowDb: ReturnType<typeof createFeltDB>;

beforeEach(async () => {
	const dir = mkdtempSync(join(tmpdir(), "wf-store-test-"));
	dirs.push(dir);
	process.env.OPENSESSION_WORKFLOWS_DIR = dir;
	workflowDb = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
	await initializeManagedWorkflows(workflowDb, dir);
});

afterAll(() => {
	if (savedEnv === undefined) delete process.env.OPENSESSION_WORKFLOWS_DIR;
	else process.env.OPENSESSION_WORKFLOWS_DIR = savedEnv;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRun(overrides?: Partial<Parameters<typeof createWorkflowRun>[0]>) {
	const runId = `wf-test-${++runCounter}-${Math.random().toString(36).slice(2)}`;
	return createWorkflowRun({
		runId,
		sessionId: "bks-session-1",
		name: "test-workflow",
		phases: ["Phase 1"],
		cwd: "/tmp",
		script: 'export const meta = { name: "test-workflow" };\nreturn 1;',
		...overrides,
	});
}

function journalEntry(seq: number, prompt = `prompt ${seq}`): WorkflowJournalEntry {
	return {
		seq,
		hash: `hash-${seq}`,
		prompt,
		opts: {},
		outcome: { ok: true, text: `result ${seq}` },
		startedAt: "2026-07-10T00:00:00.000Z",
		endedAt: "2026-07-10T00:00:01.000Z",
	};
}

describe("workflow store", () => {
	test("createWorkflowRun persists its snapshot and script in the managed projection", () => {
		const snapshot = makeRun({ description: "a test", user: "alex" });
		const dir = join(process.env.OPENSESSION_WORKFLOWS_DIR!, snapshot.runId);
		expect(existsSync(dir)).toBe(false);
		expect(readWorkflowScript(snapshot.runId)).toContain("test-workflow");

		const live = getWorkflowRun(snapshot.runId);
		expect(live?.name).toBe("test-workflow");
		expect(live?.status).toBe("running");
		expect(live?.description).toBe("a test");
		expect(live?.user).toBe("alex");
		expect(live?.phases).toEqual(["Phase 1"]);
		expect(live?.totals).toEqual({ agents: 0, tokensIn: 0, tokensOut: 0 });

		// Still readable from managed state once no longer live.
		unregisterLiveWorkflow(snapshot.runId);
		expect(getWorkflowRun(snapshot.runId)?.name).toBe("test-workflow");
	});

	test("updateWorkflowRun mutates, persists, and returns the snapshot", () => {
		const snapshot = makeRun();
		const updated = updateWorkflowRun(snapshot.runId, (s) => {
			s.currentPhase = "Phase 1";
			s.logs.push({ ts: "2026-07-10T00:00:00.000Z", message: "hello" });
		});
		expect(updated?.currentPhase).toBe("Phase 1");
		unregisterLiveWorkflow(snapshot.runId);
		const fromDisk = getWorkflowRun(snapshot.runId);
		expect(fromDisk?.logs).toEqual([
			{ ts: "2026-07-10T00:00:00.000Z", message: "hello" },
		]);
		expect(updateWorkflowRun("wf-does-not-exist", () => {})).toBeUndefined();
	});

	test("updateWorkflowRun truncates previews and caps log lines", () => {
		const snapshot = makeRun();
		updateWorkflowRun(snapshot.runId, (s) => {
			s.agents.push({
				seq: 0,
				label: "big",
				status: "done",
				promptPreview: "p".repeat(5000),
				resultPreview: "r".repeat(5000),
			});
			for (let i = 0; i < WORKFLOW_LIMITS.maxLogLines + 50; i++) {
				s.logs.push({ ts: "2026-07-10T00:00:00.000Z", message: `line ${i}` });
			}
		});
		const s = getWorkflowRun(snapshot.runId)!;
		expect(s.agents[0].promptPreview.length).toBeLessThanOrEqual(
			WORKFLOW_LIMITS.previewChars + 1,
		);
		expect(s.agents[0].resultPreview!.length).toBeLessThanOrEqual(
			WORKFLOW_LIMITS.previewChars + 1,
		);
		expect(s.logs.length).toBe(WORKFLOW_LIMITS.maxLogLines);
		expect(s.logs[s.logs.length - 1].message).toBe(
			`line ${WORKFLOW_LIMITS.maxLogLines + 49}`,
		);
	});

	test("journal append/read roundtrip preserves order", () => {
		const snapshot = makeRun();
		appendWorkflowJournal(snapshot.runId, journalEntry(0));
		appendWorkflowJournal(snapshot.runId, journalEntry(1));
		const entries = readWorkflowJournal(snapshot.runId) as WorkflowJournalEntry[];
		expect(entries.length).toBe(2);
		expect(entries[0].prompt).toBe("prompt 0");
		expect(entries[1].outcome.text).toBe("result 1");
		expect(readWorkflowJournal("wf-none")).toEqual([]);
	});

	test("reloads snapshots, scripts, and journals from FeltDB", async () => {
		const snapshot = makeRun();
		appendWorkflowJournal(snapshot.runId, journalEntry(0));
		updateWorkflowRun(snapshot.runId, (run) => { run.currentPhase = "persisted"; });
		await flushWorkflowWrites();
		unregisterLiveWorkflow(snapshot.runId);

		const emptyLegacy = mkdtempSync(join(tmpdir(), "wf-store-empty-"));
		dirs.push(emptyLegacy);
		await initializeManagedWorkflows(workflowDb, emptyLegacy);

		expect(getWorkflowRun(snapshot.runId)?.currentPhase).toBe("persisted");
		expect(readWorkflowScript(snapshot.runId)).toContain("test-workflow");
		expect(readWorkflowJournal(snapshot.runId)).toEqual([journalEntry(0)]);
	});

	test("imports the former workflow directory and removes it", async () => {
		const legacyDir = mkdtempSync(join(tmpdir(), "wf-store-legacy-"));
		dirs.push(legacyDir);
		const runId = "wf-legacy";
		mkdirSync(join(legacyDir, runId), { recursive: true });
		const snapshot = makeRun({ runId });
		writeFileSync(join(legacyDir, runId, "run.json"), JSON.stringify(snapshot));
		writeFileSync(join(legacyDir, runId, "script.mjs"), "return 'legacy';");
		writeFileSync(join(legacyDir, runId, "journal.jsonl"), `${JSON.stringify(journalEntry(0))}\n{broken`);
		await initializeManagedWorkflows(
			createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
			legacyDir,
		);
		expect(getWorkflowRun(runId)?.name).toBe("test-workflow");
		expect(readWorkflowScript(runId)).toBe("return 'legacy';");
		expect(readWorkflowJournal(runId)).toHaveLength(1);
		expect(existsSync(legacyDir)).toBe(false);
	});

	test("listWorkflowRunsForSession filters by session, newest first", () => {
		const a = makeRun({ sessionId: "bks-list-test" });
		updateWorkflowRun(a.runId, (s) => {
			s.startedAt = "2026-07-01T00:00:00.000Z";
		});
		const b = makeRun({ sessionId: "bks-list-test" });
		updateWorkflowRun(b.runId, (s) => {
			s.startedAt = "2026-07-09T00:00:00.000Z";
		});
		makeRun({ sessionId: "bks-other" });

		const runs = listWorkflowRunsForSession("bks-list-test");
		expect(runs.map((r) => r.runId)).toEqual([b.runId, a.runId]);
		expect(listWorkflowRunsForSession("bks-nobody")).toEqual([]);
	});

	test("registerLiveWorkflow / cancelLiveWorkflow wiring", () => {
		const snapshot = makeRun();
		let cancelled = 0;
		registerLiveWorkflow(snapshot.runId, () => cancelled++);
		expect(cancelLiveWorkflow(snapshot.runId)).toBe(true);
		expect(cancelled).toBe(1);
		unregisterLiveWorkflow(snapshot.runId);
		expect(cancelLiveWorkflow(snapshot.runId)).toBe(false);
	});

	test("markInterruptedWorkflows flips dead running runs, leaves live ones", () => {
		const dead = makeRun();
		updateWorkflowRun(dead.runId, (s) => {
			s.agents.push({
				seq: 0,
				label: "in flight",
				status: "running",
				promptPreview: "p",
			});
		});
		unregisterLiveWorkflow(dead.runId); // the process that owned it "died"
		const live = makeRun(); // still registered live → untouched
		const finished = makeRun();
		updateWorkflowRun(finished.runId, (s) => {
			s.status = "done";
		});
		unregisterLiveWorkflow(finished.runId);

		markInterruptedWorkflows();

		const deadNow = getWorkflowRun(dead.runId)!;
		expect(deadNow.status).toBe("interrupted");
		expect(deadNow.endedAt).toBeTruthy();
		expect(deadNow.agents[0].status).toBe("cancelled");
		expect(getWorkflowRun(live.runId)?.status).toBe("running");
		expect(getWorkflowRun(finished.runId)?.status).toBe("done");
	});
});
