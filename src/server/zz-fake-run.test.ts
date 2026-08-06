/**
 * End-to-end consumer-loop test on the fake engine: runSessionPromptAndDrain
 * driving a real session file through runAgent → the event loop → persistence,
 * run-state FSM, busy lifecycle, and queue drain — with zero model spend.
 *
 * zz- prefix + dynamic imports in beforeAll (the zz-run-ws pattern): the
 * dangerous modules (run-session → interactive-mcp → startRunRpcServer) load
 * only after NODE_ENV=test is in effect and the sessions dir is redirected.
 * __opensessionBooted is set BEFORE those imports so module-scope tickers (the
 * /loop ticker etc.) never arm in the test process.
 *
 * Full-suite caveat: earlier test files may have already loaded sessions.ts /
 * session-cache.ts, freezing their SESSIONS_DIR consts on a different sessions
 * dir — then our temp-dir session files are invisible to findSession. The
 * beforeAll detects that (probe session lookup) and the tests skip loudly
 * rather than touching the real store. Run this file directly for full
 * coverage: bun test src/server/zz-fake-run.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const tmp = mkdtempSync(`${tmpdir()}/zz-fake-run-`);

// Loaded dynamically in beforeAll — see header.
let runSession: typeof import("./run-session");
let agentRunner: typeof import("./agent-runner");
let sessionCache: typeof import("./session-cache");
let runState: typeof import("./run-state");
let queueState: typeof import("./queue-state");
let fakeEngineMod: typeof import("./testing/fake-engine");
let ocTranscript: typeof import("./opencode-transcript");
let transcriptStoreMod: typeof import("./transcript-store");
let restoreSessionsDir: (() => void) | null = null;
let restoreJournal: (() => void) | null = null;
let redirected = false;

function writeSessionFile(id: string, extra: Record<string, unknown> = {}) {
	writeFileSync(
		`${tmp}/${id}.json`,
		JSON.stringify({
			id,
			title: `Fake run ${id}`,
			model: "claude-sonnet-5",
			createdBy: "Test",
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			...extra,
		}),
	);
}

beforeAll(async () => {
	(globalThis as any).__opensessionBooted = true;
	const paths = await import("./paths");
	const prevDir = paths.__setSessionsDirForTest(tmp);
	restoreSessionsDir = () => paths.__setSessionsDirForTest(prevDir);
	const runJournal = await import("./run-journal");
	const prevJournal = runJournal.__setActiveRunsPathForTest(
		`${tmp}/active-runs.json`,
	);
	restoreJournal = () => runJournal.__setActiveRunsPathForTest(prevJournal);

	runSession = await import("./run-session");
	agentRunner = await import("./agent-runner");
	sessionCache = await import("./session-cache");
	runState = await import("./run-state");
	queueState = await import("./queue-state");
	fakeEngineMod = await import("./testing/fake-engine");
	ocTranscript = await import("./opencode-transcript");
	transcriptStoreMod = await import("./transcript-store");

	// Redirect probe: a session file written to our temp dir must be visible
	// through findSession, or earlier suite files froze the store elsewhere.
	writeSessionFile("bks-zz-probe");
	sessionCache.invalidateSessionsCache();
	redirected = !!sessionCache.findSession("bks-zz-probe");
	if (!redirected) {
		console.warn(
			"[zz-fake-run] sessions-dir redirect didn't take (module cache already " +
				"warm from earlier test files) — skipping; run this file directly.",
		);
	}
});

afterAll(() => {
	agentRunner?.__setEngineForTest(null);
	restoreJournal?.();
	restoreSessionsDir?.();
	sessionCache?.invalidateSessionsCache();
});

const sessionJson = (id: string) =>
	JSON.parse(readFileSync(`${tmp}/${id}.json`, "utf-8"));

describe("fake-engine session runs (consumer loop end-to-end)", () => {
	test("clean run: engine id + usage persisted, FSM idle, settled", async () => {
		if (!redirected) return;
		const sid = "bks-zz-clean";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			{
				kind: "clean",
				engineSessionId: "ses_zz_clean",
				text: ["all done"],
				tools: [{ name: "bash", input: { command: "true" }, result: "ok" }],
			},
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "do the thing", "Test");

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].prompt).toContain("do the thing");
		const data = sessionJson(sid);
		// engineSessionPatch persisted the fake engine session for later resumes.
		expect(
			data.opencodeSessionId === "ses_zz_clean" ||
				data.claudeSessionId === "ses_zz_clean",
		).toBe(true);
		expect(data.lastEngineProvider).toBe("opencode");
		expect(data.usage?.inputTokens).toBe(100);
		expect(data.lastRunError).toBeUndefined();
		// Lifecycle fully settled: FSM at rest, engine not busy, queue empty.
		expect(runState.getRunState(sid)).toBe("idle");
		expect(
			agentRunner.isAgentSessionBusy("ses_zz_clean", undefined, sid),
		).toBe(false);
		expect(sessionCache.isRunSettled(sid)).toBe(true);
	});

	test("failed run: lastRunError recorded, FSM failed (still settled)", async () => {
		if (!redirected) return;
		const sid = "bks-zz-error";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			// Non-transient, non-usage error: surfaces directly (no fallback walk).
			{ kind: "error", content: "boom: unrecoverable test failure" },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "explode please", "Test");

		expect(fake.calls).toHaveLength(1);
		expect(sessionJson(sid).lastRunError?.message).toContain("boom");
		expect(runState.getRunState(sid)).toBe("failed");
		expect(sessionCache.isRunSettled(sid)).toBe(true);
		// The enriched list surfaces the FSM state.
		sessionCache.invalidateSessionsCache();
		const listed = sessionCache.findSession(sid);
		expect(listed?.runState).toBe("failed");
		expect(listed?.lastRunError?.message).toContain("boom");
	});

	// The failure has to reach the TRANSCRIPT, not just the session card: every
	// path that records an outcome (opening runs, resumed runs, setup failures)
	// funnels through recordRunOutcome, so the chip is written there. Before
	// that centralization only runSessionPromptInner wrote it, and a resumed
	// run's death left the conversation ending mid-turn with no explanation
	// (bks-019fb757, 2026-07-31).
	test("failed run: the failure lands in the transcript as a system chip", () => {
		if (!redirected) return;
		// The store is a globalThis singleton — if an earlier suite file opened
		// it against the real sessions dir, skip rather than write to it.
		const store = transcriptStoreMod.transcriptStore();
		if (!store.dbPath.startsWith(tmp)) return;

		const sid = "bks-zz-error-chip";
		const engineId = "ses_zz_error_chip";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		ocTranscript.recordBksSessionFor(engineId, sid);

		sessionCache.recordRunOutcome(sid, "boom: unrecoverable test failure", {
			engineSessionId: engineId,
		});

		const chip = store
			.readTail(sid, 50)
			.entries.find((e) => e.type === "system");
		expect(chip?.content).toBe("Run failed: boom: unrecoverable test failure");
	});

	test("usage-limit stop is worded as a stop, and a runner-written notice wins", () => {
		if (!redirected) return;
		const store = transcriptStoreMod.transcriptStore();
		if (!store.dbPath.startsWith(tmp)) return;

		const sid = "bks-zz-stop-chip";
		const engineId = "ses_zz_stop_chip";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		ocTranscript.recordBksSessionFor(engineId, sid);

		sessionCache.recordRunOutcome(sid, "Usage limit reached on every account", {
			engineSessionId: engineId,
			noticeLabel: "Run stopped",
		});
		// noticePersisted: the runner already wrote its own friendlier line, so
		// this must not add a second one.
		sessionCache.recordRunOutcome(sid, "timed out after 60m", {
			engineSessionId: engineId,
			noticePersisted: true,
		});

		const chips = store
			.readTail(sid, 50)
			.entries.filter((e) => e.type === "system");
		expect(chips).toHaveLength(1);
		expect(chips[0].content).toBe(
			"Run stopped: Usage limit reached on every account",
		);
	});

	test("transient fallback does not replace the selected Dial preset", async () => {
		if (!redirected) return;
		const sid = "bks-zz-transient-fallback";
		writeSessionFile(sid, { model: "dial/medium" });
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			{ kind: "error", content: "Our servers are currently overloaded" },
			{ kind: "clean", engineSessionId: "ses_zz_terra", text: ["recovered"] },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "keep going", "Test");

		const data = sessionJson(sid);
		expect(fake.calls.map((call) => call.model)).toEqual([
			"opencode/openai/gpt-5.6-sol",
			"opencode/openai/gpt-5.6-terra",
		]);
		expect(data.model).toBe("dial/medium");
		expect(data.lastEngineModel).toBe("opencode/openai/gpt-5.6-terra");
		expect(data.modelHistory).toBeUndefined();
	});

	test("transient fallback does not replace a directly selected model", async () => {
		if (!redirected) return;
		const sid = "bks-zz-transient-direct";
		writeSessionFile(sid, { model: "gpt-5.6-sol" });
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			{ kind: "error", content: "Our servers are currently overloaded" },
			{ kind: "clean", engineSessionId: "ses_zz_terra_direct", text: ["recovered"] },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "keep going", "Test");

		const data = sessionJson(sid);
		expect(data.model).toBe("gpt-5.6-sol");
		expect(data.lastEngineModel).toBe("opencode/openai/gpt-5.6-terra");
		expect(data.modelHistory).toBeUndefined();
	});

	test("usage fallback still replaces an unavailable selected model", async () => {
		if (!redirected) return;
		const sid = "bks-zz-usage-fallback";
		writeSessionFile(sid, { model: "dial/medium" });
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			{ kind: "usage_exhausted" },
			{ kind: "clean", engineSessionId: "ses_zz_terra_usage", text: ["recovered"] },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "keep going", "Test");

		const data = sessionJson(sid);
		expect(data.model).toBe("opencode/openai/gpt-5.6-terra");
		expect(data.modelHistory).toHaveLength(1);
		expect(data.modelHistory[0].by).toContain("out of credits");
	});

	test("usage exhaustion on a temporary fallback does not replace the viable selection", async () => {
		if (!redirected) return;
		const sid = "bks-zz-transient-then-usage";
		writeSessionFile(sid, { model: "dial/medium" });
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			{ kind: "error", content: "Our servers are currently overloaded" },
			{ kind: "usage_exhausted" },
			{ kind: "clean", engineSessionId: "ses_zz_luna", text: ["recovered"] },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "keep going", "Test");

		const data = sessionJson(sid);
		expect(data.model).toBe("dial/medium");
		expect(data.lastEngineModel).toBe("opencode/openai/gpt-5.6-luna");
		expect(data.modelHistory).toBeUndefined();
	});

	test("prompt queued mid-turn drains as the next turn on the same engine session", async () => {
		if (!redirected) return;
		const sid = "bks-zz-queue";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		let releaseTurn1!: () => void;
		const gate = new Promise<void>((r) => (releaseTurn1 = r));
		const fake = fakeEngineMod.makeFakeEngine([
			{ kind: "clean", engineSessionId: "ses_zz_queue", text: ["turn 1"], gate },
			{ kind: "clean", text: ["turn 2"] },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		const run = runSession.runSessionPromptAndDrain(sid, "first", "Test");
		// Wait for the engine to actually be inside turn 1, then queue while busy.
		while (fake.calls.length < 1) await Bun.sleep(5);
		// The session must be un-settled mid-turn — the don't-trust-turn_end rule.
		expect(sessionCache.isRunSettled(sid)).toBe(false);
		runSession.enqueuePrompt(sid, queueState.queueItem({ content: "second", user: "Test" }));
		releaseTurn1();
		await run;

		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1].prompt).toContain("second");
		// Turn 2 resumed the engine session turn 1 established.
		expect(fake.calls[1].sessionId).toBe("ses_zz_queue");
		expect(queueState.promptQueues.get(sid)?.length ?? 0).toBe(0);
		expect(runState.getRunState(sid)).toBe("idle");
		expect(sessionCache.isRunSettled(sid)).toBe(true);
	});
});
