import { describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import type { SlackSession } from "./state";

const {
	loadSession,
	saveSession,
	getSessionKey,
} = await import("./state");

function testDb() {
	return createFeltDB({ namespace: crypto.randomUUID(), memory: true });
}

function session(patch: Partial<SlackSession> = {}): SlackSession {
	return {
		channel: "C1",
		threadTs: "1700000000.000100",
		userId: "U1",
		claudeSessionId: null,
		worktreeDir: null,
		branch: null,
		createdAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...patch,
	} as SlackSession;
}

describe("saveSession", () => {
	test("round-trips repoId", async () => {
		const db = testDb();
		const s = session({ threadTs: "1.1", repoId: "opensession" });
		await saveSession(s, db);
		const loaded = await loadSession(getSessionKey(s.channel, s.threadTs), db);
		expect(loaded?.repoId).toBe("opensession");
	});

	test("keeps fields written by other writers, e.g. piSessionId", async () => {
		const db = testDb();
		const s = session({ threadTs: "2.2", piSessionId: "pi-abc" } as Partial<SlackSession>);
		const key = getSessionKey(s.channel, s.threadTs);
		(s as SlackSession & { message: string }).message = "written by another writer";
		await saveSession(s, db);

		const loopCopy = session({ threadTs: "2.2" });
		await saveSession(loopCopy, db);

		const loaded = await loadSession(key, db);
		expect(loaded?.piSessionId).toBe("pi-abc");
		expect((loaded as any).message).toBe("written by another writer");
	});

	test("an undefined in-memory field doesn't erase the stored one, null does", async () => {
		const db = testDb();
		const s = session({ threadTs: "3.3", model: "pi/anthropic/claude-opus-5" });
		const key = getSessionKey(s.channel, s.threadTs);
		await saveSession(s, db);
		await saveSession(session({ threadTs: "3.3", claudeSessionId: null }), db);
		const loaded = await loadSession(key, db);
		expect(loaded?.model).toBe("pi/anthropic/claude-opus-5");
		expect(loaded?.claudeSessionId).toBeNull();
	});
});
