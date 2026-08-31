import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import {
	SessionKernelStore,
	__setSessionKernelStoreForTest,
} from ".";
import {
	__setScheduledPromptDbForTest,
	createScheduledPrompt,
	deleteScheduledPrompt,
	hydrateScheduledPromptTimers,
	initializeManagedScheduledPrompts,
	listScheduledPrompts,
} from "../scheduled-prompts";

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let authority: StateFirstDB;
let previousAuthority: StateFirstDB | undefined;

beforeEach(async () => {
	authority = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
	previousAuthority = __setScheduledPromptDbForTest(authority);
	await initializeManagedScheduledPrompts(authority);
	store = new SessionKernelStore(":memory:");
	previousStore = __setSessionKernelStoreForTest(store);
});

afterEach(() => {
	__setScheduledPromptDbForTest(previousAuthority);
	__setSessionKernelStoreForTest(previousStore);
	store.close();
});

describe("scheduled prompt kernel timers", () => {
	test("creation and deletion update the durable timer", async () => {
		const created = await createScheduledPrompt({
			sessionId: "s1",
			prompt: "continue",
			user: "Jaap",
			at: new Date(Date.now() + 60_000).toISOString(),
		});
		if ("error" in created) throw new Error(created.error);
		expect(store.timer("s1", created.id)?.kind).toBe("scheduled_prompt");
		expect(listScheduledPrompts("s1")).toHaveLength(1);
		expect(await deleteScheduledPrompt(created.id)).toBe(true);
		expect(store.timer("s1", created.id)).toBeUndefined();
	});

	test("boot hydration reconstructs missing timer rows", async () => {
		const created = await createScheduledPrompt({
			sessionId: "s1",
			prompt: "continue",
			user: "Jaap",
			at: new Date(Date.now() + 60_000).toISOString(),
		});
		if ("error" in created) throw new Error(created.error);
		store.cancelTimer("s1", created.id);
		expect(await hydrateScheduledPromptTimers()).toBe(1);
		expect(store.timer("s1", created.id)).toBeDefined();
	});
});
