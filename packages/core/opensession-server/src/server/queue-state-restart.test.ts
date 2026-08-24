import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	beginNextPromptDispatch,
	deleteQueuedPrompt,
	hydratePersistedQueueState,
	persistQueues,
	promptDispatches,
	promptQueues,
	preparePromptInterrupt,
	requeueSteerReceipts,
	restorePersistedQueueState,
	steeredReceipts,
	settlePromptInterrupt,
	undeliveredSteers,
} from "./queue-state";
import { sessionKernelStore } from "./session-kernel";
import { sessionWatchers } from "./ws-hub";

const SESSION = "os-steer-restart-test";
let scratch = "";

afterEach(() => {
	promptQueues.clear();
	promptDispatches.clear();
	steeredReceipts.clear();
	sessionWatchers.delete(SESSION);
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = "";
});

describe("steer receipt restart persistence", () => {
	test("hydrates every durable map before a new write", async () => {
		scratch = mkdtempSync(join(tmpdir(), "os-queue-hydrate-"));
		const storePath = join(scratch, "prompt-queues.json");
		writeFileSync(
			storePath,
			JSON.stringify({
				queued: { [SESSION]: [{ id: "queued", content: "later" }] },
				steered: { [SESSION]: [{ id: "steered", content: "in flight" }] },
				dispatching: {
					[SESSION]: {
						promptEntryId: "prompt-entry",
						items: [{ id: "dispatch", content: "starting" }],
					},
				},
			}),
		);

		expect(hydratePersistedQueueState(storePath)).toBe(3);
		expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual(["queued"]);
		expect(steeredReceipts.get(SESSION)?.map((item) => item.id)).toEqual([
			"steered",
		]);
		expect(promptDispatches.get(SESSION)?.promptEntryId).toBe("prompt-entry");

		const queue = promptQueues.get(SESSION) || [];
		queue.push({ id: "new", content: "after boot" });
		promptQueues.set(SESSION, queue);
		persistQueues(storePath);
		const persisted = JSON.parse(await Bun.file(storePath).text());
		expect(persisted.queued[SESSION].map((item: { id: string }) => item.id)).toEqual([
			"queued",
			"new",
		]);
		expect(persisted.steered[SESSION][0].id).toBe("steered");
		expect(persisted.dispatching[SESSION].promptEntryId).toBe("prompt-entry");
	});

	test("restores undelivered receipts without turning them into queued prompts", () => {
		scratch = mkdtempSync(join(tmpdir(), "os-steer-restart-"));
		const storePath = join(scratch, "prompt-queues.json");
		writeFileSync(
			storePath,
			JSON.stringify({
				queued: { [SESSION]: [{ id: "queued", content: "later", user: "Kent" }] },
				steered: {
					[SESSION]: [
						{ id: "pending", content: "keep me", user: "Kent" },
						{ id: "landed", content: "already there", user: "Kent" },
					],
					"os-deleted": [{ id: "gone", content: "stale" }],
				},
			}),
		);
		const sent: unknown[] = [];
		sessionWatchers.set(
			SESSION,
			new Set([
				{
					data: { watchingSessionId: SESSION, user: "Test" },
					send: (payload: string) => sent.push(JSON.parse(payload)),
				} as never,
			]),
		);

		const restored = restorePersistedQueueState({
			storePath,
			sessionExists: (id) => id === SESSION,
			journalOwnsPrompt: () => false,
			runOwnsSteers: () => true,
			deliveredUserTexts: () => ["[Kent] already there"],
		});

		expect(restored).toEqual({
			queuedSessionIds: [SESSION],
			queuedCount: 1,
			steeredCount: 1,
		});
		expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual(["queued"]);
		expect(steeredReceipts.get(SESSION)?.map((item) => item.id)).toEqual([
			"pending",
		]);
		expect(sent.at(-1)).toMatchObject({
			type: "queue_update",
			sessionId: SESSION,
			queued: [{ id: "queued" }],
			steered: [{ id: "pending" }],
		});

		expect(requeueSteerReceipts(SESSION, [], false)).toBe(1);
		expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual([
			"pending",
			"queued",
		]);
		expect(steeredReceipts.has(SESSION)).toBe(false);
	});

	test("requeues a receipt when no recovered run owns its delivery", () => {
		scratch = mkdtempSync(join(tmpdir(), "os-steer-orphan-"));
		const storePath = join(scratch, "prompt-queues.json");
		writeFileSync(
			storePath,
			JSON.stringify({
				steered: {
					[SESSION]: [{ id: "orphan", content: "do not lose me", user: "Kent" }],
				},
			}),
		);

		const restored = restorePersistedQueueState({
			storePath,
			sessionExists: () => true,
			journalOwnsPrompt: () => false,
			runOwnsSteers: () => false,
			deliveredUserTexts: () => [],
			effects: false,
		});

		expect(restored).toEqual({
			queuedSessionIds: [SESSION],
			queuedCount: 1,
			steeredCount: 0,
		});
		expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual(["orphan"]);
		expect(steeredReceipts.has(SESSION)).toBe(false);
	});

	test("an ordinary multi-item dispatch keeps its identity after a crash", () => {
		scratch = mkdtempSync(join(tmpdir(), "os-ordinary-dispatch-"));
		const storePath = join(scratch, "prompt-queues.json");
		writeFileSync(
			storePath,
			JSON.stringify({
				dispatching: {
					[SESSION]: {
						promptEntryId: "ordinary-entry",
						items: [
							{ id: "ordinary-one", content: "retry me" },
							{ id: "ordinary-two", content: "and me" },
						],
					},
				},
			}),
		);
		const restored = restorePersistedQueueState({
			storePath,
			sessionExists: () => true,
			journalOwnsPrompt: () => false,
			runOwnsSteers: () => false,
			deliveredUserTexts: () => [],
			effects: false,
		});
		expect(restored.queuedCount).toBe(2);
		expect(promptQueues.get(SESSION)?.[0]?.promptEntryId).toBe("ordinary-entry");
		expect(promptDispatches.has(SESSION)).toBe(false);
		expect(deleteQueuedPrompt(SESSION, "ordinary-one", undefined, false)).toBe(
			true,
		);
		const interruptId = preparePromptInterrupt(
			SESSION,
			"ordinary-two",
			SESSION,
			"ordinary-two",
		);
		settlePromptInterrupt(SESSION, interruptId, "confirmed");
		expect(
			beginNextPromptDispatch(SESSION, {}, false),
		).toMatchObject({
			kind: "deliver",
			promptEntryId: "ordinary-entry",
			batch: [
				{ id: "ordinary-two", retryDispatchId: "ordinary-entry" },
			],
		});
	});

	test("production boot restores an unjournaled interrupt with its dispatch", () => {
		sessionKernelStore().markDeliveryMigrationComplete();
		promptQueues.set(SESSION, [
			{ id: "interrupt", content: "send now", hold: true },
		]);
		promptQueues.set(`${SESSION}-unrelated`, [
			{ id: "unrelated", content: "must never be globally cleared" },
		]);
		const interruptId = preparePromptInterrupt(
			SESSION,
			"interrupt",
			SESSION,
			"interrupt",
		);
		settlePromptInterrupt(SESSION, interruptId, "confirmed");
		expect(
			beginNextPromptDispatch(SESSION, { stillWorking: true }, false),
		).toMatchObject({ kind: "deliver", interrupted: true });

		const restored = restorePersistedQueueState({
			sessionExists: () => true,
			journalOwnsPrompt: () => false,
			runOwnsSteers: () => false,
			deliveredUserTexts: () => [],
			effects: false,
		});
		expect(restored.queuedCount).toBe(2);
		expect(promptQueues.get(`${SESSION}-unrelated`)).toMatchObject([
			{ id: "unrelated" },
		]);
		expect(
			beginNextPromptDispatch(SESSION, { stillWorking: true }, false),
		).toMatchObject({
			kind: "deliver",
			interrupted: true,
			batch: [{ id: "interrupt" }],
		});
	});

	test("a cold restart preserves an actor-owned create dispatch even after journaling", () => {
		scratch = mkdtempSync(join(tmpdir(), "os-create-dispatch-adopt-"));
		const storePath = join(scratch, "prompt-queues.json");
		writeFileSync(
			storePath,
			JSON.stringify({
				dispatching: {
					[SESSION]: {
						promptEntryId: "create-request-1",
						items: [{ id: "opening", content: "start" }],
						kind: "create",
					},
				},
			}),
		);
		const restored = restorePersistedQueueState({
			storePath,
			sessionExists: () => true,
			journalOwnsPrompt: () => true,
			creationOwnsPrompt: (_sessionId, promptEntryId) =>
				promptEntryId === "create-request-1",
			runOwnsSteers: () => false,
			deliveredUserTexts: () => [],
			effects: false,
		});
		expect(restored.queuedCount).toBe(0);
		expect(promptQueues.has(SESSION)).toBe(false);
		expect(promptDispatches.get(SESSION)).toMatchObject({
			promptEntryId: "create-request-1",
			kind: "create",
		});
	});

	test("matches duplicate and substring receipts one-for-one", () => {
		const receipts = [
			{ id: "first", content: "same", user: "Kent" },
			{ id: "second", content: "same", user: "Kent" },
			{ id: "short", content: "hi", user: "Kent" },
		];
		expect(undeliveredSteers(receipts, ["[Kent] same", "[Kent] history"])).toEqual([
			receipts[1],
			receipts[2],
		]);
		expect(
			undeliveredSteers(receipts, ["[Kent] same\n\n[Kent] same", "[Kent] history"]),
		).toEqual([receipts[2]]);
	});

});
