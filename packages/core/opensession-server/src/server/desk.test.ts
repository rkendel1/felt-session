import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "opensession-desk-"));
const sessionsDir = join(scratch, "sessions");
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_SESSIONS_DIR = sessionsDir;

let ensureDeskSession: typeof import("./desk").ensureDeskSession;

beforeAll(async () => {
	const desk = await import("./desk");
	ensureDeskSession = desk.ensureDeskSession;
	await desk.initializeManagedDesks(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
});

function readSession(sessionId: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(sessionsDir, `${sessionId}.json`), "utf8"));
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Desk session", () => {
	test("creates a repo-less scratch session", async () => {
		const { sessionId } = await ensureDeskSession("Desk Test");
		const session = readSession(sessionId);
		expect(session).toMatchObject({
			id: sessionId, title: "Desk", mode: "ask", desk: true,
			repoLess: true, branch: "", worktreeDir: "",
		});
		expect(session).not.toHaveProperty("repo");
		expect(session).not.toHaveProperty("workspaceId");
	});

	test("migrates an existing Desk away from workspace metadata", async () => {
		const { sessionId } = await ensureDeskSession("Desk Migration Test");
		const { updateSessionFile } = await import("./session-cache");
		await updateSessionFile(sessionId, (session) => ({
			...session, repoLess: false, repo: "opensession", branch: "main",
			worktreeDir: "/tmp/opensession", workspaceId: "workspace-1",
			attachedRepos: [{ repo: "other", branch: "main", dir: "/tmp/other" }],
		}));
		await ensureDeskSession("Desk Migration Test");
		const session = readSession(sessionId);
		expect(session).toMatchObject({
			repoLess: true, branch: "", worktreeDir: "", workspaceId: null, attachedRepos: [],
		});
		expect(session).not.toHaveProperty("repo");
	});
});
