import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RuntimeInvestigation,
	RuntimeRequestObservation,
	WorkspaceEventPayload,
} from "@feltdb/core";
import { createFeltDB } from "@feltdb/core";
import { __resetManagedWorkspacesForTest, initializeManagedWorkspaces } from "./workspaces";
import {
	RUNTIME_HANDOFF_COLLECTION,
	RuntimeInvestigationHandoffConsumer,
	createQueuedWorkspaceTask,
	runtimeInvestigationTaskContent,
	validateRuntimeInvestigationHandoff,
	type QueuedRuntimeInvestigationTask,
	type RuntimeHandoffWorkspace,
} from "./runtime-investigation-handoffs";

const originalStateDir = process.env.OPENSESSION_STATE_DIR;
const stateDirs: string[] = [];
beforeEach(async () => {
	__resetManagedWorkspacesForTest();
	await initializeManagedWorkspaces(createFeltDB({ namespace: `runtime-handoff-${crypto.randomUUID()}`, memory: true }));
});
afterEach(() => {
	if (originalStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
	else process.env.OPENSESSION_STATE_DIR = originalStateDir;
	for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const handoff = (patch: Record<string, unknown> = {}) => ({
	entityId: "handoff-1",
	requestKey: "felt-session:devtools:inv-1",
	kind: "runtime_investigation_handoff",
	schemaVersion: 1,
	workspaceId: "workspace-1",
	investigationId: "inv-1",
	target: {
		product: "felt-session",
		repositoryId: "devtools",
		disposition: "queued_task",
	},
	source: {
		product: "feltdb-devtools",
		clientId: "devtools-client",
		localInvestigationId: "local-only-1",
	},
	status: "pending",
	createdAt: 1_787_000_000_000,
	...patch,
});

const observation: RuntimeRequestObservation = {
	observationId: "obs-1",
	workspaceId: "workspace-1",
	method: "get",
	url: "http://127.0.0.1:5173/api/items",
	status: 500,
	timestamp: 1_787_000_000_100,
	durationMs: 42,
	runtime: "browser",
	browser: "Chrome",
	requestCharacteristics: { headers: { authorization: "private" }, body: "private" },
	responseCharacteristics: { body: "private response" },
};

const investigation: RuntimeInvestigation = {
	id: "inv-1",
	workspaceId: "workspace-1",
	observationId: "obs-1",
	observationIds: ["obs-1"],
	remediationContractId: "",
	investigationState: "OBSERVED",
	remediationState: "NOT_STARTED",
	verificationState: "NOT_READY",
	createdAt: 1_787_000_000_100,
	updatedAt: 1_787_000_000_100,
	evidence: [{
		id: "evidence-1",
		investigationId: "inv-1",
		observationId: "obs-1",
		kind: "http_response",
		statement: "The canonical request returned HTTP 500.",
		source: "runtime_observation",
		observedAt: 1_787_000_000_100,
		detail: { headers: "not copied" },
	}],
};

class FakeWorkspace implements RuntimeHandoffWorkspace {
	readonly workspaceId = "workspace-1";
	readonly entities = new Map<string, Map<string, unknown>>();
	readonly updates: Array<{ collection: string; entityId: string; updates: Record<string, unknown> }> = [];
	readonly subscribers = new Map<string, Set<(event: WorkspaceEventPayload<unknown>) => void>>();

	constructor(records: unknown[] = []) {
		this.entities.set(RUNTIME_HANDOFF_COLLECTION, new Map(records.map((item) => [String((item as { entityId: string }).entityId), item])));
		this.entities.set("runtime_investigation", new Map([[investigation.id, investigation]]));
		this.entities.set("runtime_observation", new Map([[observation.observationId, observation]]));
	}

	async query<T>(collection: string): Promise<T[]> {
		return [...(this.entities.get(collection)?.values() || [])] as T[];
	}

	async get<T>(collection: string, entityId: string): Promise<T | null> {
		return (this.entities.get(collection)?.get(entityId) as T | undefined) ?? null;
	}

	async update<T extends object>(collection: string, entityId: string, updates: Partial<T>): Promise<void> {
		this.updates.push({ collection, entityId, updates: updates as Record<string, unknown> });
		const entities = this.entities.get(collection) || new Map<string, unknown>();
		const current = entities.get(entityId) as Record<string, unknown> | undefined;
		entities.set(entityId, { ...(current || { entityId }), ...updates });
		this.entities.set(collection, entities);
	}

	subscribe<T>(collection: string, handler: (event: WorkspaceEventPayload<T>) => void): () => void {
		const handlers = this.subscribers.get(collection) || new Set();
		handlers.add(handler as (event: WorkspaceEventPayload<unknown>) => void);
		this.subscribers.set(collection, handlers);
		return () => handlers.delete(handler as (event: WorkspaceEventPayload<unknown>) => void);
	}

	emit(value: unknown): void {
		const entityId = String((value as { entityId: string }).entityId);
		this.entities.get(RUNTIME_HANDOFF_COLLECTION)?.set(entityId, value);
		for (const handler of this.subscribers.get(RUNTIME_HANDOFF_COLLECTION) || []) {
			handler({
				id: `event-${entityId}`,
				workspaceId: this.workspaceId,
				collection: RUNTIME_HANDOFF_COLLECTION,
				entityId,
				type: "created",
				value,
				timestamp: Date.now(),
				originClientId: "producer",
			});
		}
	}
}

function fixture(options: { records?: unknown[]; repoExists?: boolean; failCreates?: number } = {}) {
	const workspace = new FakeWorkspace(options.records);
	const tasks = new Map<string, QueuedRuntimeInvestigationTask>();
	let creates = 0;
	let failures = options.failCreates || 0;
	const consumer = new RuntimeInvestigationHandoffConsumer({
		workspace,
		repositoryExists: () => options.repoExists !== false,
		createQueuedTask: async (input) => {
			if (failures-- > 0) throw new Error("private database failure");
			const existing = tasks.get(input.requestKey);
			if (existing) return existing;
			creates++;
			const task = { id: "task-1", repo: input.repo, title: input.title, prompt: input.prompt };
			tasks.set(input.requestKey, task);
			return task;
		},
		now: () => 1_787_000_000_999,
	});
	return { consumer, workspace, tasks, creates: () => creates };
}

describe("runtime investigation handoff validation", () => {
	test("accepts the complete v1 envelope and rejects unsupported versions and targets", () => {
		expect(validateRuntimeInvestigationHandoff(handoff()).requestKey).toBe("felt-session:devtools:inv-1");
		expect(() => validateRuntimeInvestigationHandoff(handoff({ schemaVersion: 2 }))).toThrow("Unsupported handoff schema version");
		expect(() => validateRuntimeInvestigationHandoff(handoff({
			target: { product: "another-product", repositoryId: "devtools", disposition: "queued_task" },
		}))).toThrow("Unsupported handoff target product");
		expect(() => validateRuntimeInvestigationHandoff(handoff({ requestKey: "wrong" }))).toThrow("Invalid requestKey");
	});

	test("copies only canonical factual evidence into the task prompt", () => {
		const content = runtimeInvestigationTaskContent(investigation, [observation]);
		expect(content.title).toBe("GET http://127.0.0.1:5173/api/items · 500");
		expect(content.prompt).toContain("Canonical investigation ID: inv-1");
		expect(content.prompt).toContain("evidence-1");
		expect(content.prompt).not.toContain("authorization");
		expect(content.prompt).not.toContain("private response");
		expect(content.prompt).not.toContain("local-only-1");
		expect(content.prompt).not.toContain("not copied");
	});
});

describe("RuntimeInvestigationHandoffConsumer", () => {
	test("durably maps requestKey to one unstarted workspace task", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "runtime-handoff-"));
		stateDirs.push(stateDir);
		process.env.OPENSESSION_STATE_DIR = stateDir;
		const input = {
			requestKey: "felt-session:devtools:inv-1",
			repo: "devtools",
			title: "GET /api/items · 500",
			prompt: "Investigate canonical observation obs-1",
		};
		const first = await createQueuedWorkspaceTask(input);
		const second = await createQueuedWorkspaceTask(input);
		expect(second.id).toBe(first.id);
		expect(second.prompt).toBe(input.prompt);
	});

	test("recovers pending records at startup and acknowledges durable task creation", async () => {
		const { consumer, workspace, tasks } = fixture({ records: [handoff()] });
		await consumer.start();
		expect(tasks.get("felt-session:devtools:inv-1")?.repo).toBe("devtools");
		expect(workspace.updates.at(-1)).toEqual({
			collection: RUNTIME_HANDOFF_COLLECTION,
			entityId: "handoff-1",
			updates: { status: "queued", taskId: "task-1", queuedAt: 1_787_000_000_999 },
		});
	});

	test("consumes a live pending subscription event", async () => {
		const { consumer, workspace, tasks } = fixture();
		await consumer.start();
		workspace.emit(handoff());
		await consumer.drain();
		expect(tasks.has("felt-session:devtools:inv-1")).toBe(true);
	});

	test("rejects repositories outside the registered catalog", async () => {
		const { consumer, workspace } = fixture({ repoExists: false });
		const result = await consumer.process(handoff());
		expect(result).toEqual({ status: "failed", error: "Repository devtools is not registered" });
		expect(workspace.updates.at(-1)?.updates.status).toBe("failed");
	});

	test("deduplicates redelivery by requestKey and returns the existing task", async () => {
		const { consumer, workspace, creates } = fixture();
		await consumer.process(handoff());
		workspace.entities.get(RUNTIME_HANDOFF_COLLECTION)?.set("handoff-1", handoff());
		const second = await consumer.process(handoff());
		expect(second).toEqual({ status: "queued", taskId: "task-1" });
		expect(creates()).toBe(1);
	});

	test("marks processing failures safely and permits a pending retry", async () => {
		const { consumer, workspace, tasks } = fixture({ failCreates: 1 });
		const failed = await consumer.process(handoff());
		expect(failed).toEqual({ status: "failed", error: "Runtime investigation handoff processing failed" });
		expect(workspace.updates.at(-1)?.updates).toEqual({
			status: "failed",
			error: "Runtime investigation handoff processing failed",
			failedAt: 1_787_000_000_999,
		});
		workspace.entities.get(RUNTIME_HANDOFF_COLLECTION)?.set("handoff-1", handoff());
		const retried = await consumer.process(handoff());
		expect(retried).toEqual({ status: "queued", taskId: "task-1" });
		expect(tasks.size).toBe(1);
	});
});
