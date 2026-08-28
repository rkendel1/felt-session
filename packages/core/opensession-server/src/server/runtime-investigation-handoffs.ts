import {
	resolvePairingCode,
	type RuntimeInvestigation,
	type RuntimeRequestObservation,
	type WorkspaceEventPayload,
} from "@feltdb/core";
import { configuredRepos } from "./config";
import { createWorkspace, findWorkspaceByKey } from "./workspaces";
import { managedFeltDb, managedFeltDbConfig, managedFeltDbStatus } from "./managed-feltdb";

export const RUNTIME_HANDOFF_COLLECTION = "runtime_investigation_handoffs";
const RUNTIME_INVESTIGATION_COLLECTION = "runtime_investigation";
const RUNTIME_OBSERVATION_COLLECTION = "runtime_observation";

export interface RuntimeInvestigationHandoff {
	entityId: string;
	requestKey: string;
	kind: "runtime_investigation_handoff";
	schemaVersion: 1;
	workspaceId: string;
	investigationId: string;
	target: {
		product: "felt-session";
		repositoryId: string;
		disposition: "queued_task";
	};
	source: {
		product: "feltdb-devtools";
		clientId: string;
		localInvestigationId?: string;
	};
	status: "pending";
	createdAt: number;
}

export interface RuntimeHandoffWorkspace {
	readonly workspaceId: string;
	query<T>(collection: string): Promise<T[]>;
	get<T>(collection: string, entityId: string): Promise<T | null>;
	update<T extends object>(collection: string, entityId: string, updates: Partial<T>): Promise<void>;
	subscribe<T>(collection: string, handler: (event: WorkspaceEventPayload<T>) => void): () => void;
}

export interface QueuedRuntimeInvestigationTask {
	id: string;
	repo: string;
	title: string;
	prompt: string;
}

interface ConsumerDependencies {
	workspace: RuntimeHandoffWorkspace;
	repositoryExists: (repositoryId: string) => boolean;
	createQueuedTask: (input: Omit<QueuedRuntimeInvestigationTask, "id"> & { requestKey: string }) => Promise<QueuedRuntimeInvestigationTask> | QueuedRuntimeInvestigationTask;
	now?: () => number;
}

type HandoffResult =
	| { status: "ignored" }
	| { status: "queued"; taskId: string }
	| { status: "failed"; error: string };

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;

const requiredString = (value: unknown, field: string): string => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${field}`);
	return value;
};

/** Strictly validate the producer envelope before any canonical state is read. */
export function validateRuntimeInvestigationHandoff(value: unknown): RuntimeInvestigationHandoff {
	const input = record(value);
	if (!input) throw new Error("Invalid handoff envelope");
	const target = record(input.target);
	const source = record(input.source);
	const entityId = requiredString(input.entityId, "entityId");
	const workspaceId = requiredString(input.workspaceId, "workspaceId");
	const investigationId = requiredString(input.investigationId, "investigationId");
	const repositoryId = requiredString(target?.repositoryId, "target.repositoryId");
	const requestKey = requiredString(input.requestKey, "requestKey");
	if (input.kind !== "runtime_investigation_handoff") throw new Error("Unsupported handoff kind");
	if (input.schemaVersion !== 1) throw new Error("Unsupported handoff schema version");
	if (input.status !== "pending") throw new Error("Handoff is not pending");
	if (target?.product !== "felt-session") throw new Error("Unsupported handoff target product");
	if (target.disposition !== "queued_task") throw new Error("Unsupported handoff disposition");
	if (source?.product !== "feltdb-devtools") throw new Error("Unsupported handoff source product");
	const clientId = requiredString(source.clientId, "source.clientId");
	if (source.localInvestigationId !== undefined && typeof source.localInvestigationId !== "string")
		throw new Error("Invalid source.localInvestigationId");
	if (typeof input.createdAt !== "number" || !Number.isFinite(input.createdAt) || input.createdAt <= 0)
		throw new Error("Invalid createdAt");
	const expectedKey = `felt-session:${repositoryId}:${investigationId}`;
	if (requestKey !== expectedKey) throw new Error("Invalid requestKey");
	return {
		entityId,
		requestKey,
		kind: "runtime_investigation_handoff",
		schemaVersion: 1,
		workspaceId,
		investigationId,
		target: { product: "felt-session", repositoryId, disposition: "queued_task" },
		source: {
			product: "feltdb-devtools",
			clientId,
			...(source.localInvestigationId !== undefined
				? { localInvestigationId: source.localInvestigationId }
				: {}),
		},
		status: "pending",
		createdAt: input.createdAt,
	};
}

function canonicalObservationIds(investigation: RuntimeInvestigation): string[] {
	return [...new Set([
		investigation.observationId,
		...(investigation.observationIds || []),
	].filter(Boolean))];
}

function validateCanonicalObservation(observation: RuntimeRequestObservation, observationId: string): void {
	if (
		observation.observationId !== observationId ||
		typeof observation.method !== "string" ||
		typeof observation.url !== "string" ||
		typeof observation.status !== "number" ||
		typeof observation.timestamp !== "number"
	) throw new Error(`Invalid canonical runtime observation ${observationId}`);
}

/** Build a deliberately narrow prompt. Browser-local diagnoses and request
 * bodies, headers, screenshots, and characteristic maps never enter it. */
export function runtimeInvestigationTaskContent(
	investigation: RuntimeInvestigation,
	observations: RuntimeRequestObservation[],
): { title: string; prompt: string } {
	const primary = observations.find((item) => item.observationId === investigation.observationId)
		|| observations[0];
	if (!primary) throw new Error("Canonical investigation has no observations");
	const status = primary.networkFailure ? "network failure" : String(primary.status);
	const title = `${primary.method.toUpperCase()} ${primary.url} · ${status}`.slice(0, 120);
	const observationFacts = observations.map((item) => {
		const facts = [
			`${item.observationId}: ${item.method.toUpperCase()} ${item.url} returned ${item.status}`,
			`observed at ${new Date(item.timestamp).toISOString()}`,
			...(typeof item.durationMs === "number" ? [`duration ${item.durationMs} ms`] : []),
			...(item.networkFailure ? ["network failure"] : []),
			...(item.runtime ? [`runtime ${item.runtime}`] : []),
			...(item.browser ? [`browser ${item.browser}`] : []),
			...(item.engine ? [`engine ${item.engine}`] : []),
		];
		return `- ${facts.join("; ")}`;
	});
	const evidence = (investigation.evidence || [])
		.filter((item) =>
			item.investigationId === investigation.id &&
			item.source === "runtime_observation" &&
			typeof item.statement === "string" &&
			item.statement.trim(),
		)
		.map((item) => `- ${item.id} (${item.observationId}): ${item.statement.trim()}`);
	return {
		title,
		prompt: [
			"Investigate and fix this canonical FeltDB runtime issue.",
			"",
			`Canonical investigation ID: ${investigation.id}`,
			`Canonical observation IDs: ${observations.map((item) => item.observationId).join(", ")}`,
			"",
			"Observed runtime facts:",
			...observationFacts,
			...(evidence.length ? ["", "Canonical investigation evidence:", ...evidence] : []),
			"",
			"Use the canonical investigation and observations as evidence. Reproduce the problem where practical, identify the root cause, implement the fix, and run relevant tests. Do not rely on browser-local diagnoses or private DevTools data.",
		].join("\n"),
	};
}

function safeFailure(error: unknown): string {
	if (!(error instanceof Error)) return "Runtime investigation handoff processing failed";
	if (/^(Invalid|Unsupported|Handoff|Canonical|Runtime observation|Repository)/.test(error.message))
		return error.message.slice(0, 240);
	return "Runtime investigation handoff processing failed";
}

export class RuntimeInvestigationHandoffConsumer {
	readonly #deps: ConsumerDependencies;
	readonly #inFlight = new Map<string, Promise<HandoffResult>>();
	readonly #pending = new Set<Promise<unknown>>();
	#unsubscribe: (() => void) | null = null;

	constructor(dependencies: ConsumerDependencies) {
		this.#deps = dependencies;
	}

	async start(): Promise<void> {
		if (this.#unsubscribe) return;
		// Subscribe before the recovery query. Durable requestKey deduplication
		// closes the overlap while this startup snapshot is in flight.
		this.#unsubscribe = this.#deps.workspace.subscribe<unknown>(
			RUNTIME_HANDOFF_COLLECTION,
			(event) => {
				if (record(event.value)?.status !== "pending") return;
				this.#enqueue(event.value, event.entityId);
			},
		);
		const recovered = await this.#deps.workspace.query<unknown>(RUNTIME_HANDOFF_COLLECTION);
		await Promise.all(recovered
			.filter((item) => record(item)?.status === "pending")
			.map((item) => this.process(item)));
	}

	stop(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	async drain(): Promise<void> {
		while (this.#pending.size) await Promise.all([...this.#pending]);
	}

	async process(value: unknown, eventEntityId?: string): Promise<HandoffResult> {
		const raw = record(value);
		if (raw?.status !== "pending") return { status: "ignored" };
		const acknowledgmentId = typeof raw.entityId === "string" ? raw.entityId : eventEntityId;
		let handoff: RuntimeInvestigationHandoff | null = null;
		try {
			handoff = validateRuntimeInvestigationHandoff(value);
			if (eventEntityId && eventEntityId !== handoff.entityId)
				throw new Error("Invalid entityId");
			if (handoff.workspaceId !== this.#deps.workspace.workspaceId)
				throw new Error("Invalid workspaceId");
			const current = this.#inFlight.get(handoff.requestKey);
			if (current) return await current;
			const processing = this.#processValidated(handoff).finally(() => {
				this.#inFlight.delete(handoff!.requestKey);
			});
			this.#inFlight.set(handoff.requestKey, processing);
			return await processing;
		} catch (error) {
			const message = safeFailure(error);
			if (acknowledgmentId) {
				await this.#deps.workspace.update(
					RUNTIME_HANDOFF_COLLECTION,
					acknowledgmentId,
					{ status: "failed", error: message, failedAt: (this.#deps.now || Date.now)() },
				).catch((ackError) => console.error("[runtime-handoff] failure acknowledgment failed:", ackError));
			}
			return { status: "failed", error: message };
		}
	}

	#enqueue(value: unknown, entityId: string): void {
		const pending = this.process(value, entityId);
		this.#pending.add(pending);
		void pending.finally(() => this.#pending.delete(pending));
	}

	async #processValidated(handoff: RuntimeInvestigationHandoff): Promise<HandoffResult> {
		if (!this.#deps.repositoryExists(handoff.target.repositoryId))
			throw new Error(`Repository ${handoff.target.repositoryId} is not registered`);
		const investigation = await this.#deps.workspace.get<RuntimeInvestigation>(
			RUNTIME_INVESTIGATION_COLLECTION,
			handoff.investigationId,
		);
		if (!investigation || investigation.id !== handoff.investigationId)
			throw new Error(`Canonical investigation ${handoff.investigationId} was not found`);
		if (investigation.workspaceId !== handoff.workspaceId)
			throw new Error("Canonical investigation belongs to another workspace");
		const observationIds = canonicalObservationIds(investigation);
		if (!observationIds.length) throw new Error("Canonical investigation has no observations");
		const observations = await Promise.all(observationIds.map(async (observationId) => {
			const observation = await this.#deps.workspace.get<RuntimeRequestObservation>(
				RUNTIME_OBSERVATION_COLLECTION,
				observationId,
			);
			if (!observation) throw new Error(`Runtime observation ${observationId} was not found`);
			validateCanonicalObservation(observation, observationId);
			return observation;
		}));
		const content = runtimeInvestigationTaskContent(investigation, observations);
		const task = await this.#deps.createQueuedTask({
			requestKey: handoff.requestKey,
			repo: handoff.target.repositoryId,
			title: content.title,
			prompt: content.prompt,
		});
		await this.#deps.workspace.update(
			RUNTIME_HANDOFF_COLLECTION,
			handoff.entityId,
			{ status: "queued", taskId: task.id, queuedAt: (this.#deps.now || Date.now)() },
		);
		return { status: "queued", taskId: task.id };
	}
}

export async function createQueuedWorkspaceTask(input: Omit<QueuedRuntimeInvestigationTask, "id"> & { requestKey: string }): Promise<QueuedRuntimeInvestigationTask> {
	const existing = findWorkspaceByKey(input.requestKey);
	if (existing) return {
		id: existing.id,
		repo: existing.repo || input.repo,
		title: existing.name,
		prompt: existing.draft?.text || input.prompt,
	};
	const now = new Date().toISOString();
	const workspace = await createWorkspace({
		key: input.requestKey,
		name: input.title,
		repo: input.repo,
		createdBy: "FeltDB runtime investigation",
		draft: { text: input.prompt, updatedAt: now, autoName: false },
	});
	return { id: workspace.id, repo: input.repo, title: workspace.name, prompt: workspace.draft!.text };
}

let activeConsumer: RuntimeInvestigationHandoffConsumer | null = null;
let activeWorkspaceId = "";

export interface FeltDbHandoffConnectionStatus {
	connected: boolean;
	configured: boolean;
	managedByEnvironment: boolean;
	workspaceId: string;
	endpoint: string;
}

function configuredConnection() {
	const managed = managedFeltDbStatus();
	const environmentWorkspaceId = process.env.OPENSESSION_FELTDB_WORKSPACE_ID
		|| process.env.FELTDB_WORKSPACE_ID
		|| process.env.VITE_FELTDB_WORKSPACE_ID || "";
	return {
		workspaceId: environmentWorkspaceId,
		endpoint: managed.url || "",
		managedByEnvironment: true,
	};
}

function managedWorkspace(workspaceId: string): RuntimeHandoffWorkspace {
	const db = managedFeltDb();
	return {
		workspaceId,
		async query<T>(collection: string): Promise<T[]> {
			return db.collection<T>(collection).all();
		},
		async get<T>(collection: string, entityId: string): Promise<T | null> {
			return db.collection<T>(collection).get(entityId);
		},
		async update<T extends object>(collection: string, entityId: string, updates: Partial<T>): Promise<void> {
			await db.collection<T>(collection).update(entityId, updates);
		},
		subscribe<T>(collection: string, handler: (event: WorkspaceEventPayload<T>) => void): () => void {
			return db.collection<T>(collection).subscribe((items) => {
			for (const item of items) {
				const record = item as T & { entityId?: unknown };
				const entityId = typeof record.entityId === "string" ? record.entityId : "";
				if (entityId) handler({ entityId, value: item } as WorkspaceEventPayload<T>);
			}
			});
		},
	};
}

export function runtimeInvestigationHandoffConnectionStatus(): FeltDbHandoffConnectionStatus {
	const configured = configuredConnection();
	return {
		connected: !!activeConsumer,
		configured: !!(configured.workspaceId && configured.endpoint),
		managedByEnvironment: configured.managedByEnvironment,
		workspaceId: activeWorkspaceId || configured.workspaceId,
		endpoint: configured.endpoint,
	};
}

export async function stopRuntimeInvestigationHandoffConsumer(): Promise<void> {
	activeConsumer?.stop();
	activeConsumer = null;
	activeWorkspaceId = "";
}

export async function connectRuntimeInvestigationHandoffConsumer(input: {
	workspaceId: string;
	endpoint: string;
	token?: string;
}): Promise<RuntimeInvestigationHandoffConsumer> {
	await stopRuntimeInvestigationHandoffConsumer();
	const managed = managedFeltDbConfig();
	if (input.endpoint.replace(/\/$/, "") !== managed.url)
		throw new Error("Pairing resolved a different FeltDB authority than Open Session");
	const consumer = new RuntimeInvestigationHandoffConsumer({
		workspace: managedWorkspace(input.workspaceId),
		repositoryExists: (repositoryId) => Object.hasOwn(configuredRepos(), repositoryId),
		createQueuedTask: createQueuedWorkspaceTask,
	});
	try {
		await consumer.start();
		activeConsumer = consumer;
		activeWorkspaceId = input.workspaceId;
		console.log(`[runtime-handoff] connected to FeltDB workspace ${input.workspaceId}`);
		return consumer;
	} catch (error) {
		consumer.stop();
		throw error;
	}
}

export async function resolveFeltDbPairingCode(
	pairingCode: string,
	discoveryEndpoint?: string,
): Promise<{ workspaceId: string; endpoint: string }> {
	const resolution = await resolvePairingCode(pairingCode, {
		...(discoveryEndpoint ? { endpoint: discoveryEndpoint } : {}),
	});
	return { workspaceId: resolution.workspaceId, endpoint: resolution.endpoint };
}

/** Optional boot hook. The standard FeltDB development environment variables
 * take precedence; integrations.feltdbRuntimeHandoffs provides the same
 * connection details for a long-running self-hosted service. */
export async function startRuntimeInvestigationHandoffConsumer(): Promise<RuntimeInvestigationHandoffConsumer | null> {
	if (activeConsumer) return null;
	const { workspaceId, endpoint } = configuredConnection();
	if (!workspaceId || !endpoint) return null;
	return connectRuntimeInvestigationHandoffConsumer({ workspaceId, endpoint });
}
