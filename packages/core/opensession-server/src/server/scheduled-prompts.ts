/**
 * Durable prompts scheduled for an existing session.
 *
 * Managed FeltDB owns the listing and a SessionKernel timer owns delivery.
 */
import { randomUUIDv7 } from "bun";
import { managedFeltDb } from "./managed-feltdb";
import type { StateFirstDB } from "@feltdb/core";
import {
	registerSessionTimerHandler,
	sessionKernel,
} from "./session-kernel";
import { getSessionControl } from "./session-control";

let scheduledPromptDb: StateFirstDB | undefined;
const TIMER_KIND = "scheduled_prompt";
const COLLECTION = "opensession_scheduled_prompts";

export interface ScheduledPrompt {
	id: string;
	sessionId: string;
	prompt: string;
	user: string;
	at: string;
	createdAt: string;
}

type StoredScheduledPrompt = ScheduledPrompt & {
	state: "active" | "deleted";
	dueAt: number;
	updatedAt: number;
	__version?: number;
};
const scheduledPrompts = new Map<string, StoredScheduledPrompt>();
const db = () => scheduledPromptDb ?? managedFeltDb();

export function __setScheduledPromptDbForTest(next: StateFirstDB | undefined): StateFirstDB | undefined {
	const previous = scheduledPromptDb;
	scheduledPromptDb = next;
	scheduledPrompts.clear();
	return previous;
}

async function removeFromListing(id: string): Promise<boolean> {
	const current = scheduledPrompts.get(id);
	if (!current) return false;
	if (!Number.isSafeInteger(current.__version)) throw new Error(`Scheduled prompt ${id} has no FeltDB authority version`);
	const result = await db().collection<StoredScheduledPrompt>(COLLECTION)
		.updateIfVersion(id, current.__version!, { state: "deleted", updatedAt: Date.now() });
	if (!result.updated) throw new Error(`Scheduled prompt ${id} changed during deletion`);
	scheduledPrompts.delete(id);
	return true;
}

async function schedule(prompt: ScheduledPrompt): Promise<void> {
	await sessionKernel(prompt.sessionId).scheduleTimer({
		timerId: prompt.id,
		kind: TIMER_KIND,
		dueAt: Date.parse(prompt.at),
		payload: prompt,
	});
}

registerSessionTimerHandler(TIMER_KIND, async (timer) => {
	const prompt = timer.payload as ScheduledPrompt;
	if (
		!prompt ||
		prompt.id !== timer.timerId ||
		prompt.sessionId !== timer.sessionId ||
		typeof prompt.prompt !== "string"
	)
		throw new Error("Invalid scheduled prompt timer payload");
	const result = await getSessionControl().deliverToSession(
		prompt.sessionId,
		prompt.prompt,
		prompt.user,
		{ deliveryId: prompt.id },
	);
	if (result.status === "error") throw new Error(result.message);
	await removeFromListing(prompt.id);
	console.log(
		`[scheduled-prompts] ${prompt.id} -> ${prompt.sessionId}: ${result.status}`,
	);
});

export async function initializeManagedScheduledPrompts(authority: StateFirstDB = managedFeltDb()): Promise<number> {
	scheduledPromptDb = authority;
	const records = authority.runtime().runtime === "remote"
		? await queryScheduledPrompts(authority)
		: (await authority.collection<StoredScheduledPrompt>(COLLECTION).all()).filter((item) => item.state === "active");
	scheduledPrompts.clear();
	for (const record of records) scheduledPrompts.set(record.id, record);
	return records.length;
}

export async function hydrateScheduledPromptTimers(): Promise<number> {
	const prompts = [...scheduledPrompts.values()];
	await Promise.all(prompts.map(schedule));
	return prompts.length;
}

export function listScheduledPrompts(sessionId?: string): ScheduledPrompt[] {
	const all = [...scheduledPrompts.values()];
	return (sessionId ? all.filter((prompt) => prompt.sessionId === sessionId) : all).sort(
		(a, b) => a.at.localeCompare(b.at),
	);
}

export async function createScheduledPrompt(input: {
	sessionId: string;
	prompt: string;
	at: string;
	user: string;
}): Promise<ScheduledPrompt | { error: string }> {
	if (!input.sessionId?.trim()) return { error: "sessionId required" };
	if (!input.prompt?.trim()) return { error: "Prompt is required" };
	const time = Date.parse(input.at || "");
	if (Number.isNaN(time)) return { error: `Invalid time: "${input.at}"` };
	if (time < Date.now() - 60_000) return { error: "That time is in the past" };
	const prompt: ScheduledPrompt = {
		id: `sched-${randomUUIDv7()}`,
		sessionId: input.sessionId.trim(),
		prompt: input.prompt.trim(),
		user: input.user?.trim() || "Anonymous",
		at: new Date(time).toISOString(),
		createdAt: new Date().toISOString(),
	};
	const record: StoredScheduledPrompt = { ...prompt, state: "active", dueAt: time, updatedAt: Date.now() };
	await db().transaction((tx) => {
		tx.collection<StoredScheduledPrompt>(COLLECTION).set(prompt.id, record, { requireAbsent: true });
	}, { transactionId: `opensession:scheduled-prompt:create:${prompt.id}` });
	const stored = await db().collection<StoredScheduledPrompt>(COLLECTION).get(prompt.id);
	if (!stored) throw new Error(`Scheduled prompt ${prompt.id} did not commit`);
	scheduledPrompts.set(prompt.id, stored);
	await schedule(prompt);
	return prompt;
}

export async function deleteScheduledPrompt(id: string): Promise<boolean> {
	const prompt = scheduledPrompts.get(id);
	if (!prompt) return false;
	const removed = await removeFromListing(id);
	if (removed) await sessionKernel(prompt.sessionId).cancelTimer(prompt.id);
	return removed;
}

/** Compatibility read for old callers. Delivery is no longer destructive. */
export function takeDuePrompts(now = Date.now()): ScheduledPrompt[] {
	return [...scheduledPrompts.values()].filter((prompt) => prompt.dueAt <= now);
}

async function queryScheduledPrompts(authority: StateFirstDB): Promise<StoredScheduledPrompt[]> {
	const records: StoredScheduledPrompt[] = [];
	let cursor: string | undefined;
	do {
		const page = await authority.query<StoredScheduledPrompt>({
			collection: COLLECTION,
			where: [{ field: "state", eq: "active" }],
			orderBy: [{ field: "dueAt", direction: "asc" }],
			limit: 500,
			...(cursor ? { cursor } : {}),
		});
		records.push(...page.records);
		cursor = page.exhausted ? undefined : page.nextCursor;
		if (!page.exhausted && !cursor) throw new Error("FeltDB scheduled prompt cursor is missing");
	} while (cursor);
	return records;
}
