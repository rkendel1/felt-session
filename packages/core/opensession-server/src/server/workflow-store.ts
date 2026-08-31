/**
 * Workflow persistence + live registry + broadcast.
 *
 * Managed FeltDB stores the run snapshot, source script, and ordered journal.
 * The former per-run disk layout is imported once and removed at boot.
 *
 * Live state is parked on globalThis (same pattern as queue-state.ts /
 * asks.ts) so a `bun --hot` reload keeps running workflows' snapshots and
 * cancel hooks intact. Every snapshot change broadcasts a `workflow_update`
 * to the session's watchers — wrapped in try/catch so ws fan-out can never
 * take down a store write.
 */

import type { StateFirstDB } from "@feltdb/core";
import { readdirSync, readFileSync, rmSync } from "fs";
import { stateDir } from "./paths";
import { managedFeltDb } from "./managed-feltdb";
import { broadcastToSession } from "./ws-hub";
import {
	WORKFLOW_LIMITS,
	type WorkflowJournalRecord,
	type WorkflowRunSnapshot,
} from "./workflow-types";

const g = globalThis as any;

type LiveWorkflow = { snapshot: WorkflowRunSnapshot; cancel: () => void };

/** runId → live snapshot + cancel hook (hot-reload survivable). */
const liveWorkflows: Map<string, LiveWorkflow> = (g.__opensessionWorkflows ??=
	new Map());

function workflowsDir(): string {
	return process.env.OPENSESSION_WORKFLOWS_DIR || stateDir("workflows");
}

type StoredWorkflow = { id: string; snapshot: WorkflowRunSnapshot; script: string };
type StoredJournal = { id: string; runId: string; order: number; entry: WorkflowJournalRecord };
const WORKFLOW_COLLECTION = "opensession_workflows";
const JOURNAL_COLLECTION = "opensession_workflow_journal";
const WORKFLOW_MIGRATION = "workflow-files-to-managed-feltdb-v1";
let workflowDb: StateFirstDB | undefined;
const workflows = new Map<string, StoredWorkflow>();
const journals = new Map<string, StoredJournal[]>();
let persistTail: Promise<void> = Promise.resolve();

function queuePersist(work: (db: StateFirstDB) => Promise<unknown>): void {
	const db = workflowDb ?? managedFeltDb();
	const next = persistTail.then(async () => { await work(db); });
	persistTail = next.catch((error) => console.error("[workflow] managed write failed:", error));
}

export async function flushWorkflowWrites(): Promise<void> {
	await persistTail;
}

export async function initializeManagedWorkflows(
	db: StateFirstDB = workflowDb ?? managedFeltDb(),
	legacyDir = workflowsDir(),
): Promise<void> {
	await flushWorkflowWrites();
	workflowDb = db;
	const migrations = db.collection<{ id: string }>("opensession_migrations");
	const migrationComplete = !!await migrations.get(WORKFLOW_MIGRATION);
	const legacyRuns: StoredWorkflow[] = [];
	const legacyJournals: StoredJournal[] = [];
	let names: string[] = [];
	try { names = readdirSync(legacyDir).filter((name) => name.startsWith("wf-")); } catch {}
	for (const runId of names) {
		try {
			const snapshot = JSON.parse(readFileSync(`${legacyDir}/${runId}/run.json`, "utf8"));
			const script = readFileSync(`${legacyDir}/${runId}/script.mjs`, "utf8");
			legacyRuns.push({ id: runId, snapshot, script });
		} catch { continue; }
		try {
			let order = 0;
			for (const line of readFileSync(`${legacyDir}/${runId}/journal.jsonl`, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					legacyJournals.push({ id: `${runId}-${order}`, runId, order, entry: JSON.parse(line) });
					order++;
				} catch {}
			}
		} catch {}
	}
	if (!migrationComplete || legacyRuns.length > 0) {
		for (const record of legacyRuns) {
			const runJournal = legacyJournals.filter((entry) => entry.runId === record.id);
			await db.transaction((tx) => {
				tx.collection<StoredWorkflow>(WORKFLOW_COLLECTION).set(record.id, record);
			}, { transactionId: `opensession:workflow-import:${record.id}:${crypto.randomUUID()}` });
			for (let offset = 0; offset < runJournal.length; offset += 100) {
				const batch = runJournal.slice(offset, offset + 100);
				await db.transaction((tx) => {
					for (const entry of batch)
						tx.collection<StoredJournal>(JOURNAL_COLLECTION).set(entry.id, entry);
				}, { transactionId: `opensession:workflow-journal-import:${record.id}:${offset}:${crypto.randomUUID()}` });
			}
		}
		if (!migrationComplete) await db.transaction((tx) => {
			tx.collection("opensession_migrations").set(WORKFLOW_MIGRATION,
				{ id: WORKFLOW_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${WORKFLOW_MIGRATION}` });
	}
	workflows.clear();
	for (const record of await db.collection<StoredWorkflow>(WORKFLOW_COLLECTION).all())
		workflows.set(record.id, record);
	journals.clear();
	for (const record of await db.collection<StoredJournal>(JOURNAL_COLLECTION).all()) {
		const entries = journals.get(record.runId) ?? [];
		entries.push(record);
		journals.set(record.runId, entries);
	}
	for (const entries of journals.values()) entries.sort((a, b) => a.order - b.order);
	rmSync(legacyDir, { recursive: true, force: true });
}

function persistSnapshot(snapshot: WorkflowRunSnapshot): void {
	const existing = workflows.get(snapshot.runId);
	if (!existing) throw new Error(`Managed workflow ${snapshot.runId} is missing`);
	existing.snapshot = snapshot;
	const record = structuredClone(existing);
	queuePersist(async (db) => db.transaction((tx) => {
		tx.collection<StoredWorkflow>(WORKFLOW_COLLECTION).set(record.id, record);
	}, { transactionId: `opensession:workflow:${record.id}:${crypto.randomUUID()}` }));
}

function broadcastSnapshot(snapshot: WorkflowRunSnapshot): void {
	// ws-hub must never crash a store write.
	try {
		broadcastToSession(snapshot.sessionId, {
			type: "workflow_update",
			sessionId: snapshot.sessionId,
			run: snapshot,
		});
	} catch {}
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Keep snapshot payloads bounded no matter what a mutator wrote — the
 *  snapshot is persisted AND re-broadcast to every session watcher on each
 *  mutation, so every string a script can influence (labels, log lines,
 *  errors, phase titles) gets capped here, not just the previews. */
function enforceSnapshotLimits(snapshot: WorkflowRunSnapshot): void {
	for (const agent of snapshot.agents) {
		agent.label = truncate(agent.label || "", 200);
		agent.promptPreview = truncate(
			agent.promptPreview || "",
			WORKFLOW_LIMITS.previewChars,
		);
		if (agent.resultPreview !== undefined) {
			agent.resultPreview = truncate(
				agent.resultPreview,
				WORKFLOW_LIMITS.previewChars,
			);
		}
		if (agent.error !== undefined) agent.error = truncate(agent.error, 1000);
	}
	if (snapshot.error !== undefined)
		snapshot.error = truncate(snapshot.error, 2000);
	if (snapshot.phases.length > 100) snapshot.phases = snapshot.phases.slice(0, 100);
	if (snapshot.logs.length > WORKFLOW_LIMITS.maxLogLines) {
		snapshot.logs = snapshot.logs.slice(-WORKFLOW_LIMITS.maxLogLines);
	}
	for (const l of snapshot.logs) l.message = truncate(l.message, 500);
}

export function createWorkflowRun(init: {
	runId: string;
	sessionId: string;
	name: string;
	description?: string;
	phases: string[];
	user?: string;
	cwd: string;
	script: string;
}): WorkflowRunSnapshot {
	const snapshot: WorkflowRunSnapshot = {
		runId: init.runId,
		sessionId: init.sessionId,
		name: init.name,
		...(init.description !== undefined ? { description: init.description } : {}),
		status: "running",
		phases: [...init.phases],
		agents: [],
		logs: [],
		startedAt: new Date().toISOString(),
		totals: { agents: 0, tokensIn: 0, tokensOut: 0 },
		...(init.user !== undefined ? { user: init.user } : {}),
		cwd: init.cwd,
	};
	const record: StoredWorkflow = { id: init.runId, snapshot, script: init.script };
	workflows.set(init.runId, record);
	queuePersist(async (db) => db.transaction((tx) => {
		tx.collection<StoredWorkflow>(WORKFLOW_COLLECTION).set(record.id, structuredClone(record),
			{ requireAbsent: true });
	}, { transactionId: `opensession:workflow:create:${record.id}` }));
	// Park the snapshot in the live map now; registerLiveWorkflow fills in the
	// real cancel hook once the runner has one.
	const existing = liveWorkflows.get(init.runId);
	liveWorkflows.set(init.runId, {
		snapshot,
		cancel: existing?.cancel ?? (() => {}),
	});
	broadcastSnapshot(snapshot);
	return snapshot;
}

/** Apply a mutation, persist the managed snapshot, and broadcast it. */
export function updateWorkflowRun(
	runId: string,
	mutate: (s: WorkflowRunSnapshot) => void,
): WorkflowRunSnapshot | undefined {
	const snapshot = liveWorkflows.get(runId)?.snapshot ?? workflows.get(runId)?.snapshot;
	if (!snapshot) return undefined;
	mutate(snapshot);
	enforceSnapshotLimits(snapshot);
	persistSnapshot(snapshot);
	broadcastSnapshot(snapshot);
	return snapshot;
}

export function getWorkflowRun(runId: string): WorkflowRunSnapshot | undefined {
	return liveWorkflows.get(runId)?.snapshot ?? workflows.get(runId)?.snapshot;
}

/** The run's managed script source, for resume without a new script. */
export function readWorkflowScript(runId: string): string | undefined {
	return workflows.get(runId)?.script;
}

/** All of a session's runs, newest first. */
export function listWorkflowRunsForSession(
	sessionId: string,
): WorkflowRunSnapshot[] {
	const runs: WorkflowRunSnapshot[] = [];
	for (const [runId, stored] of workflows) {
		const snapshot = liveWorkflows.get(runId)?.snapshot ?? stored.snapshot;
		if (snapshot?.sessionId === sessionId) runs.push(snapshot);
	}
	runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
	return runs;
}

export function appendWorkflowJournal(
	runId: string,
	entry: WorkflowJournalRecord,
): void {
	const entries = journals.get(runId) ?? [];
	const record: StoredJournal = {
		id: crypto.randomUUID(),
		runId,
		order: entries.length,
		entry: structuredClone(entry),
	};
	entries.push(record);
	journals.set(runId, entries);
	queuePersist(async (db) => db.transaction((tx) => {
		tx.collection<StoredJournal>(JOURNAL_COLLECTION).set(record.id, record, { requireAbsent: true });
	}, { transactionId: `opensession:workflow-journal:${record.id}` }));
}

/** Journal entries in append order; a partial/corrupt trailing line (crash
 *  mid-append) is skipped, not fatal. */
export function readWorkflowJournal(runId: string): WorkflowJournalRecord[] {
	return (journals.get(runId) ?? []).map((record) => structuredClone(record.entry));
}

export function registerLiveWorkflow(runId: string, cancel: () => void): void {
	const existing = liveWorkflows.get(runId);
	if (existing) {
		existing.cancel = cancel;
		return;
	}
	const snapshot = workflows.get(runId)?.snapshot;
	if (snapshot) liveWorkflows.set(runId, { snapshot, cancel });
}

export function unregisterLiveWorkflow(runId: string): void {
	liveWorkflows.delete(runId);
}

/** Invoke a live run's cancel hook. False when the run isn't live here. */
export function cancelLiveWorkflow(runId: string): boolean {
	const live = liveWorkflows.get(runId);
	if (!live) return false;
	try {
		live.cancel();
	} catch (e) {
		console.warn(`[workflow] cancel hook for ${runId} threw:`, e);
	}
	return true;
}

/** Boot pass: a managed run still "running" with no live entry died with the
 *  previous process — mark it interrupted so the UI doesn't show a zombie.
 *  (Callers guard this behind the boot flag; the function itself is safe to
 *  re-run.) */
export function markInterruptedWorkflows(): void {
	for (const [runId, stored] of workflows) {
		if (liveWorkflows.has(runId)) continue;
		const snapshot = stored.snapshot;
		if (!snapshot || snapshot.status !== "running") continue;
		snapshot.status = "interrupted";
		snapshot.endedAt = new Date().toISOString();
		for (const agent of snapshot.agents) {
			if (agent.status === "pending" || agent.status === "running") {
				agent.status = "cancelled";
				agent.endedAt = snapshot.endedAt;
			}
		}
		try {
			persistSnapshot(snapshot);
		} catch (e) {
			console.warn(`[workflow] failed to mark ${runId} interrupted:`, e);
			continue;
		}
		broadcastSnapshot(snapshot);
	}
}
