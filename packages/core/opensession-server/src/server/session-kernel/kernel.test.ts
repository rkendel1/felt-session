import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	SESSION_KERNEL_SCHEMA_VERSION,
	SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS,
	SessionKernelStore,
	__setSessionKernelStoreForTest,
	activeSessionKernels,
	clearSessionKernel,
	durableSessionCommand,
	passivateIdleSessionKernels,
	DeliveryOwnedMap,
	sessionKernel,
	tombstoneSessionKernel,
	legacyGatewayEffect,
	type LegacyGatewayEffect,
	type LegacyGatewayEffectInput,
} from ".";

function testEffect(
	input: LegacyGatewayEffectInput & { type?: string },
): LegacyGatewayEffect {
	const { type: _legacyTestLabel, ...effect } = input;
	return legacyGatewayEffect("submit_prompt", effect);
}

let store: SessionKernelStore;
let previous: SessionKernelStore | undefined;

beforeEach(() => {
	store = new SessionKernelStore(":memory:");
	previous = __setSessionKernelStoreForTest(store);
});

afterEach(() => {
	__setSessionKernelStoreForTest(previous);
	store.close();
});

test("tracked schema version matches the store reader", () => {
	expect(
		Number(
			readFileSync(join(import.meta.dir, "schema-version"), "utf8").trim(),
		),
	).toBe(SESSION_KERNEL_SCHEMA_VERSION);
});

test("refuses an unsafe schema downgrade", () => {
	const dir = mkdtempSync(join(tmpdir(), "session-kernel-newer-schema-"));
	const path = join(dir, "kernel.sqlite");
	const newer = new Database(path);
	newer.exec(`PRAGMA user_version = ${SESSION_KERNEL_SCHEMA_VERSION + 1}`);
	newer.close();
	try {
		expect(() => new SessionKernelStore(path)).toThrow("newer than supported");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("schema 6 upgrades create autonomous creation, delivery and ask state", () => {
	const dir = mkdtempSync(join(tmpdir(), "session-kernel-schema-"));
	const path = join(dir, "kernel.sqlite");
	const legacy = new Database(path);
	legacy.exec("PRAGMA user_version = 6");
	legacy.close();
	const upgraded = new SessionKernelStore(path);
	try {
		expect(upgraded.stats().schemaVersion).toBe(SESSION_KERNEL_SCHEMA_VERSION);
		upgraded.setDeliverySlot("upgrade", "queued", [
			{ id: "queued", content: "kept" },
		]);
		upgraded.setAskRecord("upgrade", {
			questionId: "ask",
			questions: [],
		});
		expect(upgraded.deliverySnapshot("upgrade").queued).toHaveLength(1);
		expect(upgraded.askSnapshot("upgrade")).toMatchObject({
			questionId: "ask",
		});
		expect(upgraded.applyCreationEvent({
			sessionId: "upgrade",
			identity: "create-request",
			event: "plan",
		})).toMatchObject({ accepted: true, to: "planned" });
	} finally {
		upgraded.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionKernel", () => {
	test("serializes commands for one session", async () => {
		const order: string[] = [];
		const kernel = sessionKernel("s1");
		const first = kernel.dispatchLegacy(
			testEffect({ requestId: "a", type: "test" }),
			async () => {
				order.push("a:start");
				await Bun.sleep(5);
				order.push("a:end");
				return "a";
			},
		);
		const second = kernel.dispatchLegacy(
			testEffect({ requestId: "b", type: "test" }),
			() => {
				order.push("b");
				return "b";
			}
		);
		expect((await first).result).toBe("a");
		expect((await second).result).toBe("b");
		expect(order).toEqual(["a:start", "a:end", "b"]);
	});

	test("rejects a nested same-session dispatch instead of deadlocking", async () => {
		const kernel = sessionKernel("nested");
		await expect(
			kernel.dispatchLegacy(testEffect({ requestId: "outer", type: "outer" }), async () =>
				kernel.dispatchLegacy(testEffect({ requestId: "inner", type: "inner" }), () => "inner"),
			),
		).rejects.toThrow("Nested SessionKernel dispatch");
	});

	test("session-file style mutations share the durable command mailbox", async () => {
		const kernel = sessionKernel("lanes");
		const order: string[] = [];
		const command = kernel.dispatchLegacy(
			testEffect({ requestId: "command", type: "command" }),
			async () => {
				order.push("command:start");
				await Bun.sleep(5);
				order.push("command:end");
			},
		);
		const write = kernel.runExclusive("session_file_updated", () => order.push("file"));
		await Promise.all([command, write]);
		expect(order).toEqual(["command:start", "command:end", "file"]);
	});

	test("deduplicates a completed command durably", async () => {
		let calls = 0;
		const command = testEffect({ requestId: "stable", type: "deliver", payload: { text: "hi" }, });
		const first = await sessionKernel("s1").dispatchLegacy(command, () => {
			calls += 1;
			return { status: "queued" };
		});
		expect(first.duplicate).toBe(false);
		clearSessionKernel("unrelated");
		const second = await sessionKernel("s1").dispatchLegacy(command, () => {
			calls += 1;
			return { status: "started" };
		});
		expect(second).toEqual({ result: { status: "queued" }, duplicate: true });
		expect(calls).toBe(1);
		expect(durableSessionCommand("s1", "stable")?.status).toBe("completed");
	});

	test("keeps completed receipts for clients that reconnect after compaction", async () => {
		let calls = 0;
		const command = testEffect({ requestId: "forever", type: "deliver", payload: { n: 1 } });
		await sessionKernel("retained").dispatchLegacy(command, () => {
			calls += 1;
			return "done";
		});
		store.compact(Date.now() + 365 * 24 * 60 * 60_000);
		const replay = await sessionKernel("retained").dispatchLegacy(command, () => {
			calls += 1;
			return "duplicate";
		});
		expect(replay).toEqual({ result: "done", duplicate: true });
		expect(calls).toBe(1);
	});

	test("compacts large permanent results without forgetting the receipt", async () => {
		let calls = 0;
		const command = testEffect({ requestId: "large", type: "take" });
		await sessionKernel("large-result").dispatchLegacy(command, () => {
			calls += 1;
			return { item: "x".repeat(128 * 1024) };
		});
		let receipt = store.command("large-result", "large");
		expect(receipt?.payload).toBeNull();
		expect(receipt?.payloadHash).toHaveLength(64);
		expect((receipt?.result as { item: string }).item).toHaveLength(128 * 1024);
		expect(store.acknowledgeCommand("large-result", "large")).toBe(true);
		store.compact(Date.now() + 31 * 24 * 60 * 60_000);
		receipt = store.command("large-result", "large");
		expect(receipt?.result).toMatchObject({
			__sessionKernelResultReleased: true,
			sha256: receipt?.resultHash,
		});
		const replay = await sessionKernel("large-result").dispatchLegacy(command, () => {
			calls += 1;
		});
		expect(replay.duplicate).toBe(true);
		expect(calls).toBe(1);
	});

	test("keeps terminal failures sticky", async () => {
		let calls = 0;
		const command = testEffect({ requestId: "terminal", type: "delete" });
		await expect(
			sessionKernel("failed").dispatchLegacy(command, () => {
				calls += 1;
				throw new Error("not allowed");
			}),
		).rejects.toThrow("not allowed");
		await expect(
			sessionKernel("failed").dispatchLegacy(command, () => {
				calls += 1;
			}),
		).rejects.toThrow("not allowed");
		expect(calls).toBe(1);
	});

	test("rejects request id reuse with another payload", async () => {
		await sessionKernel("s1").dispatchLegacy(
			testEffect({ requestId: "same", type: "deliver", payload: { text: "one" } }),
			() => "ok",
		);
		await expect(
			sessionKernel("s1").dispatchLegacy(
				testEffect({ requestId: "same", type: "deliver", payload: { text: "two" } }),
				() => "bad",
			),
		).rejects.toThrow("reused with another payload");
	});

	test("deduplication and run ownership survive a process replacement", async () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-restart-"));
		const path = join(dir, "kernel.sqlite");
		const firstStore = new SessionKernelStore(path);
		__setSessionKernelStoreForTest(firstStore);
		try {
			await sessionKernel("restart").dispatchLegacy(
				testEffect({ requestId: "request-1", type: "submit", payload: { text: "once" } }),
				() => ({ status: "queued" }),
			);
			sessionKernel("restart").registerRun(
				"run-1",
				"running",
				"run_registered",
			);
			firstStore.close();

			const secondStore = new SessionKernelStore(path);
			__setSessionKernelStoreForTest(secondStore);
			let calls = 0;
			const replay = await sessionKernel("restart").dispatchLegacy(
				testEffect({ requestId: "request-1", type: "submit", payload: { text: "once" } }),
				() => {
					calls += 1;
					return { status: "started" };
				},
			);
			expect(replay).toEqual({
				result: { status: "queued" },
				duplicate: true,
			});
			expect(calls).toBe(0);
			expect(sessionKernel("restart").runState()).toMatchObject({
				state: "running",
				currentRunId: "run-1",
				generation: 1,
			});
			secondStore.close();
		} finally {
			__setSessionKernelStoreForTest(store);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("re-admits an interrupted command under the same durable request id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-interrupted-"));
		const path = join(dir, "kernel.sqlite");
		const firstStore = new SessionKernelStore(path);
		firstStore.acceptCommand({
			sessionId: "restart",
			requestId: "accepted",
			type: "submit_prompt",
			payload: { text: "once" },
			replaySafe: true,
		});
		firstStore.markProcessing("restart", "accepted");
		firstStore.close();
		const secondStore = new SessionKernelStore(path);
		__setSessionKernelStoreForTest(secondStore);
		try {
			expect(secondStore.command("restart", "accepted")).toMatchObject({
				status: "failed",
				replaySafe: true,
				retryable: true,
				error: "actor restarted before execution admission",
			});
			let calls = 0;
			const accepted = await sessionKernel("restart").dispatchLegacy(
				testEffect({
					requestId: "accepted",
					type: "submit",
					payload: { text: "once" },
					replaySafe: true,
				}),
				() => {
					calls += 1;
					return { queued: true };
				},
			);
			expect(accepted).toEqual({ result: { queued: true }, duplicate: false });
			expect(calls).toBe(1);
		} finally {
			secondStore.close();
			__setSessionKernelStoreForTest(store);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("turns pre-execution pending admission into a durable retry receipt", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-pending-restart-"));
		const path = join(dir, "kernel.sqlite");
		const firstStore = new SessionKernelStore(path);
		firstStore.acceptCommand({
			sessionId: "pending-restart",
			requestId: "accepted-not-started",
			type: "session_file_updated",
			payload: { value: 1 },
		});
		firstStore.close();
		const recovered = new SessionKernelStore(path);
		try {
			expect(recovered.command("pending-restart", "accepted-not-started")).toMatchObject({
				status: "failed",
				replaySafe: true,
				retryable: true,
				error: "actor restarted before execution admission",
			});
			expect(recovered.stats()).toMatchObject({
				pendingCommands: 0,
				indeterminateCommands: 0,
				oldestPendingCommandAt: undefined,
			});
		} finally {
			recovered.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("backfills pre-policy processing receipts as replay-safe", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-policy-migration-"));
		const path = join(dir, "kernel.sqlite");
		const db = new Database(path);
		db.exec(`
			CREATE TABLE session_kernel_commands (
				session_id TEXT NOT NULL, request_id TEXT NOT NULL, type TEXT NOT NULL,
				payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, request_id)
			);
		`);
		db.run(
			`INSERT INTO session_kernel_commands
			 (session_id, request_id, type, payload, status, created_at, updated_at)
			 VALUES ('legacy', 'request', 'submit_prompt', '{}', 'processing', 1, 1)`,
		);
		db.close();
		const migrated = new SessionKernelStore(path);
		try {
			expect(migrated.command("legacy", "request")).toMatchObject({
				status: "failed",
				replaySafe: true,
				retryable: true,
			});
		} finally {
			migrated.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("promotes replay policy without changing request identity", () => {
		store.acceptCommand({
			sessionId: "promote",
			requestId: "same",
			type: "submit",
			payload: { value: 1 },
		});
		const promoted = store.acceptCommand({
			sessionId: "promote",
			requestId: "same",
			type: "submit",
			payload: { value: 1 },
			replaySafe: true,
		});
		expect(promoted.replaySafe).toBe(true);
	});

	test("never retries a non-replay-safe timeout", async () => {
		let calls = 0;
		const command = testEffect({ requestId: "unsafe-timeout", type: "physical" });
		for (let attempt = 0; attempt < 2; attempt++)
			await expect(
				sessionKernel("unsafe-timeout").dispatchLegacy(command, () => {
					calls += 1;
					throw new Error("operation timed out");
				}),
			).rejects.toThrow("timed out");
		expect(calls).toBe(1);
	});

	test("fails closed on interrupted work that was not declared replay-safe", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-indeterminate-"));
		const path = join(dir, "kernel.sqlite");
		const firstStore = new SessionKernelStore(path);
		firstStore.acceptCommand({
			sessionId: "uncertain",
			requestId: "physical",
			type: "physical_write",
		});
		firstStore.markProcessing("uncertain", "physical");
		firstStore.close();
		const secondStore = new SessionKernelStore(path);
		try {
			expect(secondStore.command("uncertain", "physical")).toMatchObject({
				status: "indeterminate",
				retryable: false,
			});
			expect(secondStore.stats()).toMatchObject({
				pendingCommands: 0,
				indeterminateCommands: 1,
				oldestPendingCommandAt: undefined,
			});
			expect(secondStore.stats().oldestIndeterminateCommandAt).toBeNumber();
		} finally {
			secondStore.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a stale run cannot retake ownership from the current generation", async () => {
		const { transitionRunState } = await import("../run-state");
		const id = `fence-${crypto.randomUUID()}`;
		try {
			transitionRunState(id, "prompt");
			transitionRunState(id, "run_registered", { run_key: "run-new" });
			const generation = sessionKernel(id).runState().generation;
			transitionRunState(id, "run_registered", { run_key: "run-old" });
			expect(sessionKernel(id).runState()).toMatchObject({
				state: "running",
				currentRunId: "run-new",
				generation,
			});
		} finally {
			clearSessionKernel(id);
		}
	});

	test("a deletion tombstone fences late writers", async () => {
		const id = `deleted-${crypto.randomUUID()}`;
		store.setDeliverySlot(id, "queued", [{ content: "pending" }]);
		tombstoneSessionKernel(id);
		expect(store.isTombstoned(id)).toBe(true);
		expect(() => sessionKernel(id).applySync("late", () => {})).toThrow(
			"was deleted",
		);
		await expect(
			sessionKernel(id).dispatchLegacy(testEffect({ requestId: "late", type: "prompt" }), () => {},),
		).rejects.toThrow("was deleted");
	});

	test("keeps deletion tombstones permanent", () => {
		store.tombstoneSession("deleted-forever");
		expect(
			store.isTombstoned(
				"deleted-forever",
				Date.now() + 365 * 24 * 60 * 60_000,
			),
		).toBe(true);
	});

	test("persists run state and monotonic change sequence", () => {
		const kernel = sessionKernel("s1");
		expect(kernel.runState().state).toBe("idle");
		expect(kernel.setRunState({ state: "starting", event: "prompt" }).changeSeq,).toBe(1);
		const running = kernel.setRunState({
			state: "running",
			event: "run_registered",
			generation: 1,
			currentRunId: "run-1",
		});
		expect(running).toMatchObject({
			state: "running",
			generation: 1,
			currentRunId: "run-1",
			changeSeq: 2,
		});
	});

	test("reduces and fences run events in one actor-store transaction", () => {
		expect(store.applyRunEvent({ sessionId: "fsm", event: "prompt" })).toMatchObject({
			accepted: true,
			from: "idle",
			to: "starting",
		});
		expect(store.applyRunEvent({
			sessionId: "fsm",
			event: "run_registered",
			runKey: "run-1",
		})).toMatchObject({
			accepted: true,
			state: { state: "running", currentRunId: "run-1", generation: 1 },
		});
		expect(store.applyRunEvent({
			sessionId: "fsm",
			event: "run_registered",
			runKey: "stale",
		})).toMatchObject({
			accepted: false,
			reason: "stale_run",
			state: { currentRunId: "run-1", generation: 1, changeSeq: 2 },
		});
		expect(store.changesSince("fsm", 0)).toHaveLength(2);
	});

	test("owns creation transitions and rejects stale effect results", () => {
		store.applyCreationEvent({
			sessionId: "create-opening-requires-effect",
			identity: "request-direct",
			event: "plan",
		});
		store.applyCreationEvent({
			sessionId: "create-opening-requires-effect",
			identity: "request-direct",
			event: "preparation_started",
		});
		expect(store.applyCreationEvent({
			sessionId: "create-opening-requires-effect",
			identity: "request-direct",
			event: "opening_dispatched",
		})).toMatchObject({ accepted: false, reason: "invalid_effect" });

		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "plan",
		})).toMatchObject({
			accepted: true,
			to: "planned",
			state: { generation: 1, changeSeq: 1 },
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "preparation_started",
			nextEffectId: "wrong-fence",
			effect: {
				kind: "creation_workspace_prepare",
				effectKey: "wrong-fence",
				payload: {
					creationIdentity: "another-request",
					creationGeneration: 1,
					workspaceId: "workspace-one",
					dedupeKey: "creation:workspace-one",
					name: "Workspace one",
					createdBy: "Alice",
					mode: "adopt_or_create",
				},
			},
		})).toMatchObject({
			accepted: false,
			reason: "invalid_effect",
			state: { state: "planned", changeSeq: 1 },
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "preparation_started",
			nextEffectId: "prepare-one",
			effect: {
				kind: "creation_workspace_prepare",
				effectKey: "prepare-one",
				payload: {
					creationIdentity: "request-one",
					creationGeneration: 1,
					workspaceId: "workspace-one",
					dedupeKey: "creation:workspace-one",
					name: "Workspace one",
					createdBy: "Alice",
					mode: "adopt_or_create",
				},
			},
		})).toMatchObject({
			accepted: true,
			from: "planned",
			to: "preparing",
			state: { currentEffectId: "prepare-one", changeSeq: 2 },
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "opening_dispatched",
			nextEffectId: "opening-one",
		})).toMatchObject({
			accepted: false,
			reason: "stale_effect",
			state: { state: "preparing", currentEffectId: "prepare-one" },
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "opening_dispatched",
			effectId: "stale-prepare",
			nextEffectId: "opening-one",
		})).toMatchObject({
			accepted: false,
			reason: "stale_effect",
			state: { state: "preparing", currentEffectId: "prepare-one" },
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "opening_dispatched",
			effectId: "prepare-one",
			nextEffectId: "opening-one",
			effect: {
				kind: "creation_opening_turn",
				effectKey: "opening-one",
				payload: {
					creationIdentity: "request-one",
					creationGeneration: 1,
					openingPromptEntryId: "entry-one",
					runId: "run-one",
					runGeneration: 1,
					mode: "adopt_or_launch",
				},
			},
		})).toMatchObject({
			accepted: false,
			reason: "invalid_opening_plan",
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "opening_dispatched",
			effectId: "prepare-one",
			openingPlan: { id: "create-fsm", openingPrompt: "durable" },
			nextEffectId: "opening-one",
			effect: {
				kind: "creation_opening_turn",
				effectKey: "opening-one",
				payload: {
					creationIdentity: "request-one",
					creationGeneration: 1,
					openingPromptEntryId: "entry-one",
					runId: "run-one",
					runGeneration: 1,
					mode: "adopt_or_launch",
				},
			},
		})).toMatchObject({
			accepted: true,
			to: "opening_dispatched",
			state: {
				currentEffectId: "opening-one",
				openingPlan: { id: "create-fsm", openingPrompt: "durable" },
				changeSeq: 3,
			},
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-one",
			event: "succeeded",
			effectId: "opening-one",
		})).toMatchObject({
			accepted: true,
			to: "ready",
			state: {
				currentEffectId: undefined,
				openingPlan: undefined,
				changeSeq: 4,
			},
		});
		expect(store.applyCreationEvent({
			sessionId: "create-fsm",
			identity: "request-two",
			event: "plan",
		})).toMatchObject({
			accepted: false,
			reason: "identity_mismatch",
		});
		expect(store.changesSince("create-fsm", 0)).toHaveLength(4);
		expect(store.pendingOutbox()).toMatchObject([
			{ kind: "creation_workspace_prepare", effectKey: "prepare-one" },
			{ kind: "creation_opening_turn", effectKey: "opening-one" },
		]);
	});

	test("settles an actor opening from an exactly journaled local recovery", async () => {
		const sessionId = "local-opening-recovery";
		const identity = "local-opening-request";
		const promptEntryId = "local-opening-prompt";
		const effectId = `opening:${promptEntryId}`;
		expect(
			store.applyCreationEvent({ sessionId, identity, event: "plan" }).accepted,
		).toBe(true);
		const preparationEffectId = "local-opening-preparation";
		expect(
			store.applyCreationEvent({
				sessionId,
				identity,
				event: "preparation_started",
				nextEffectId: preparationEffectId,
				effect: {
					kind: "creation_workspace_prepare",
					effectKey: preparationEffectId,
					payload: {
						creationIdentity: identity,
						creationGeneration: 1,
						workspaceId: "local-opening-workspace",
						dedupeKey: "local-opening-dedupe",
						name: "Local opening",
						createdBy: "Alice",
						mode: "adopt_or_create",
					},
				},
			}).accepted,
		).toBe(true);
		expect(
			store.applyCreationEvent({
				sessionId,
				identity,
				event: "opening_dispatched",
				effectId: preparationEffectId,
				openingPlan: { id: sessionId, openingPrompt: "durable" },
				nextEffectId: effectId,
				effect: {
					kind: "creation_opening_turn",
					effectKey: effectId,
					payload: {
						creationIdentity: identity,
						creationGeneration: 1,
						openingPromptEntryId: promptEntryId,
						runId: `opening:${sessionId}:${promptEntryId}`,
						runGeneration: 1,
						mode: "adopt_or_launch",
					},
				},
			}).accepted,
		).toBe(true);
		const { settleRecoveredCreationOpening } = await import("../run-session");
		expect(
			settleRecoveredCreationOpening(sessionId, promptEntryId),
		).toBe(true);
		const settled = store.creationState(sessionId);
		expect(settled?.state).toBe("ready");
		expect(settled?.completedEffectIds).toContain(effectId);
	});

	test("clears an accepted creation effect so replay is a stale no-op", () => {
		const sessionId = "create-result-replay";
		const identity = "request-result-replay";
		expect(store.applyCreationEvent({ sessionId, identity, event: "plan" }).accepted).toBe(true);
		expect(store.applyCreationEvent({
			sessionId,
			identity,
			event: "preparation_started",
			nextEffectId: "workspace-result-replay",
			effect: {
				kind: "creation_workspace_prepare",
				effectKey: "workspace-result-replay",
				payload: {
					creationIdentity: identity,
					creationGeneration: 1,
					workspaceId: "ws-result-replay",
					dedupeKey: "creation:result-replay",
					name: "Result replay",
					createdBy: "Alice",
					mode: "adopt_or_create",
				},
			},
		}).accepted).toBe(true);
		expect(store.applyCreationEvent({
			sessionId,
			identity,
			event: "preparation_started",
			effectId: "workspace-result-replay",
		})).toMatchObject({
			accepted: true,
			state: {
				state: "preparing",
				currentEffectId: undefined,
				completedEffectIds: ["workspace-result-replay"],
			},
		});
		expect(store.applyCreationEvent({
			sessionId,
			identity,
			event: "preparation_started",
			effectId: "workspace-result-replay",
		})).toMatchObject({ accepted: false, reason: "stale_effect" });
		const [settledEffect] = store.pendingOutbox();
		store.ackOutbox(settledEffect.id);
		expect(store.applyCreationEvent({
			sessionId,
			identity,
			event: "preparation_started",
			nextEffectId: "workspace-result-replay",
			effect: {
				kind: "creation_workspace_prepare",
				effectKey: "workspace-result-replay",
				payload: {
					creationIdentity: identity,
					creationGeneration: 1,
					workspaceId: "ws-result-replay",
					dedupeKey: "creation:result-replay",
					name: "Result replay",
					createdBy: "Alice",
					mode: "adopt_or_create",
				},
			},
		})).toMatchObject({ accepted: false, reason: "invalid_effect" });
		expect(store.pendingOutbox()).toHaveLength(0);
	});

	test("persists completed creation effect receipts across actor-store restart", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-create-receipt-"));
		const path = join(dir, "kernel.sqlite");
		let durableStore = new SessionKernelStore(path);
		try {
			const sessionId = "create-receipt-restart";
			const identity = "request-receipt-restart";
			durableStore.applyCreationEvent({ sessionId, identity, event: "plan" });
			durableStore.applyCreationEvent({
				sessionId,
				identity,
				event: "preparation_started",
				nextEffectId: "workspace-receipt-restart",
				effect: {
					kind: "creation_workspace_prepare",
					effectKey: "workspace-receipt-restart",
					payload: {
						creationIdentity: identity,
						creationGeneration: 1,
						workspaceId: "ws-receipt-restart",
						dedupeKey: "creation:receipt-restart",
						name: "Receipt restart",
						createdBy: "Alice",
						mode: "adopt_or_create",
					},
				},
			});
			durableStore.applyCreationEvent({
				sessionId,
				identity,
				event: "preparation_started",
				effectId: "workspace-receipt-restart",
			});
			durableStore.close();
			durableStore = new SessionKernelStore(path);
			expect(durableStore.creationState(sessionId)).toMatchObject({
				state: "preparing",
				currentEffectId: undefined,
				completedEffectIds: ["workspace-receipt-restart"],
			});
		} finally {
			durableStore.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("persists opening recovery input with its effect and clears it terminally", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-opening-plan-"));
		const path = join(dir, "kernel.sqlite");
		let durableStore = new SessionKernelStore(path);
		try {
			const sessionId = "create-opening-plan-restart";
			const identity = "request-opening-plan-restart";
			const effectId = "opening:entry-restart";
			const openingPlan = {
				id: sessionId,
				openingPrompt: "survives actor restart",
				openingPromptEntryId: "entry-restart",
			};
			durableStore.applyCreationEvent({ sessionId, identity, event: "plan" });
			durableStore.applyCreationEvent({
				sessionId,
				identity,
				event: "preparation_started",
			});
			durableStore.applyCreationEvent({
				sessionId,
				identity,
				event: "plan",
				planPatch: { resolved: openingPlan },
			});
			expect(durableStore.creationState(sessionId)?.setupPlan).toEqual({
				resolved: openingPlan,
			});
			expect(durableStore.applyCreationEvent({
				sessionId,
				identity,
				event: "opening_dispatched",
				openingPlan,
				nextEffectId: effectId,
				effect: {
					kind: "creation_opening_turn",
					effectKey: effectId,
					payload: {
						creationIdentity: identity,
						creationGeneration: 1,
						openingPromptEntryId: "entry-restart",
						runId: `opening:${sessionId}:entry-restart`,
						runGeneration: 1,
						mode: "adopt_or_launch",
					},
				},
			})).toMatchObject({ accepted: true });
			durableStore.close();
			durableStore = new SessionKernelStore(path);
			expect(durableStore.creationState(sessionId)).toMatchObject({
				setupPlan: undefined,
				openingPlan,
			});
			durableStore.applyCreationEvent({
				sessionId,
				identity,
				event: "succeeded",
				effectId,
			});
			expect(durableStore.creationState(sessionId)?.openingPlan).toBeUndefined();
		} finally {
			durableStore.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects creation effect capacity before accepting more work", () => {
		const sessionId = "create-receipt-capacity";
		const identity = "request-receipt-capacity";
		store.applyCreationEvent({ sessionId, identity, event: "plan" });
		for (let index = 0; index < SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS; index += 1) {
			const effectId = `workspace-capacity-${index}`;
			expect(store.applyCreationEvent({
				sessionId,
				identity,
				event: "preparation_started",
				nextEffectId: effectId,
				effect: {
					kind: "creation_workspace_prepare",
					effectKey: effectId,
					payload: {
						creationIdentity: identity,
						creationGeneration: 1,
						workspaceId: `ws-capacity-${index}`,
						dedupeKey: `creation:capacity-${index}`,
						name: "Capacity",
						createdBy: "Alice",
						mode: "adopt_or_create",
					},
				},
			}).accepted).toBe(true);
			expect(store.applyCreationEvent({
				sessionId,
				identity,
				event: "preparation_started",
				effectId,
			}).accepted).toBe(true);
		}
		const outboxBefore = store.pendingOutbox(Date.now(), 10_000).length;
		expect(store.applyCreationEvent({
			sessionId,
			identity,
			event: "preparation_started",
			nextEffectId: "workspace-over-capacity",
			effect: {
				kind: "creation_workspace_prepare",
				effectKey: "workspace-over-capacity",
				payload: {
					creationIdentity: identity,
					creationGeneration: 1,
					workspaceId: "ws-over-capacity",
					dedupeKey: "creation:over-capacity",
					name: "Over capacity",
					createdBy: "Alice",
					mode: "adopt_or_create",
				},
			},
		})).toMatchObject({
			accepted: false,
			reason: "effect_receipt_capacity",
		});
		expect(store.pendingOutbox(Date.now(), 10_000)).toHaveLength(outboxBefore);
	});

	test("rolls creation state back when its durable effect cannot commit", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-kernel-create-crash-"));
		const path = join(dir, "kernel.sqlite");
		const crashStore = new SessionKernelStore(path);
		try {
			expect(crashStore.applyCreationEvent({
				sessionId: "create-crash",
				identity: "request-crash",
				event: "plan",
			}).accepted).toBe(true);
			const injector = new Database(path);
			injector.exec(`CREATE TRIGGER inject_creation_effect_crash
				BEFORE INSERT ON session_kernel_outbox
				WHEN NEW.kind = 'creation_workspace_prepare'
				BEGIN SELECT RAISE(ABORT, 'injected effect commit crash'); END`);
			injector.close();
			expect(() => crashStore.applyCreationEvent({
				sessionId: "create-crash",
				identity: "request-crash",
				event: "preparation_started",
				nextEffectId: "workspace-crash",
				effect: {
					kind: "creation_workspace_prepare",
					effectKey: "workspace-crash",
					payload: {
						creationIdentity: "request-crash",
						creationGeneration: 1,
						workspaceId: "workspace-crash",
						dedupeKey: "creation:workspace-crash",
						name: "Workspace crash",
						createdBy: "Alice",
						mode: "adopt_or_create",
					},
				},
			})).toThrow("injected effect commit crash");
			expect(crashStore.creationState("create-crash")).toMatchObject({
				state: "planned",
				changeSeq: 1,
			});
			expect(crashStore.pendingOutbox()).toHaveLength(0);
			expect(crashStore.changesSince("create-crash", 0)).toHaveLength(1);
		} finally {
			crashStore.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("claims and restores a delivery batch atomically", () => {
		store.setDeliverySlot("delivery", "queued", [
			{ id: "one", content: "first" },
			{ id: "two", content: "second" },
		]);
		const claimed = store.claimDeliveryDispatch({
			sessionId: "delivery",
			items: [{ id: "one", content: "first" }],
			promptEntryId: "entry-one",
			requireQueued: true,
		});
		expect(claimed.promptEntryId).toBe("entry-one");
		expect(store.deliverySnapshot("delivery")).toMatchObject({
			queued: [{ id: "two", content: "second" }],
			dispatch: {
				promptEntryId: "entry-one",
				items: [{ id: "one", content: "first" }],
			},
		});
		expect(store.failDeliveryDispatch("delivery", "stale-entry")).toBe(false);
		expect(store.failDeliveryDispatch("delivery", "entry-one")).toBe(true);
		expect(store.deliverySnapshot("delivery")).toMatchObject({
			queued: [
				{ id: "one", content: "first" },
				{ id: "two", content: "second" },
			],
		});
		expect(store.deliverySnapshot("delivery").dispatch).toBeUndefined();
	});

	test("selects and claims the next queue batch in one actor transaction", () => {
		store.setDeliverySlot("next-delivery", "queued", [
			{ id: "held", content: "wait", hold: true },
			{
				id: "solo",
				promptEntryId: "stable-solo-entry",
				content: "send now",
				hold: true,
			},
		]);
		expect(store.claimNextDeliveryDispatch({
			sessionId: "next-delivery",
			promptEntryId: "unused-entry",
			stillWorking: true,
		})).toMatchObject({ kind: "hold", heldCount: 2 });
		expect(store.deliverySnapshot("next-delivery").queued).toHaveLength(2);
		expect(store.claimNextDeliveryDispatch({
			sessionId: "next-delivery",
			promptEntryId: "solo-entry",
			soloId: "solo",
			interruptMark: true,
			stillWorking: true,
		})).toMatchObject({
			kind: "deliver",
			promptEntryId: "stable-solo-entry",
			items: [
				{
					id: "solo",
					promptEntryId: "stable-solo-entry",
					content: "send now",
					hold: true,
				},
			],
		});
		expect(store.deliverySnapshot("next-delivery")).toMatchObject({
			queued: [{ id: "held", content: "wait", hold: true }],
			dispatch: {
				promptEntryId: "stable-solo-entry",
				items: [
					{
						id: "solo",
						promptEntryId: "stable-solo-entry",
						content: "send now",
						hold: true,
					},
				],
			},
		});
	});

	test("reuses a failed multi-item dispatch identity", () => {
		store.setDeliverySlot("failed-multi-dispatch", "queued", [
			{ id: "one", content: "first" },
			{ id: "two", content: "second" },
		]);
		expect(store.claimNextDeliveryDispatch({
			sessionId: "failed-multi-dispatch",
			promptEntryId: "stable-batch-entry",
		})).toMatchObject({
			kind: "deliver",
			promptEntryId: "stable-batch-entry",
			items: [{ id: "one" }, { id: "two" }],
		});
		expect(
			store.failDeliveryDispatch(
				"failed-multi-dispatch",
				"stable-batch-entry",
			),
		).toBe(true);
		const restored = store.deliverySnapshot("failed-multi-dispatch").queued;
		store.setDeliverySlot("failed-multi-dispatch", "queued", [
			...restored,
			{ id: "later", content: "must stay later" },
		]);
		expect(store.claimNextDeliveryDispatch({
			sessionId: "failed-multi-dispatch",
			promptEntryId: "replacement-must-not-win",
			soloId: "two",
			interruptMark: true,
		})).toMatchObject({
			kind: "deliver",
			promptEntryId: "stable-batch-entry",
			items: [
				{
					id: "one",
					promptEntryId: "stable-batch-entry",
					retryDispatchId: "stable-batch-entry",
				},
				{ id: "two", retryDispatchId: "stable-batch-entry" },
			],
		});
		expect(store.deliverySnapshot("failed-multi-dispatch").queued).toEqual([
			{ id: "later", content: "must stay later" },
		]);

		expect(
			store.failDeliveryDispatch(
				"failed-multi-dispatch",
				"stable-batch-entry",
			),
		).toBe(true);
		store.setDeliverySlot(
			"failed-multi-dispatch",
			"queued",
			store
				.deliverySnapshot("failed-multi-dispatch")
				.queued.filter((item) => (item as { id?: string }).id !== "one"),
		);
		expect(store.claimNextDeliveryDispatch({
			sessionId: "failed-multi-dispatch",
			promptEntryId: "replacement-still-must-not-win",
			soloId: "two",
			interruptMark: true,
		})).toMatchObject({
			kind: "deliver",
			promptEntryId: "stable-batch-entry",
			items: [{ id: "two", retryDispatchId: "stable-batch-entry" }],
		});
	});

	test("recovers an ambiguous prepared steer without duplicate queue delivery", () => {
		store.setDeliverySlot("steer-recovery", "queued", [
			{ id: "steer-one", content: "fold me in" },
		]);
		expect(
			store.prepareSteerDelivery("steer-recovery", "steer-one"),
		).toMatchObject({ id: "steer-one" });
		expect(store.deliverySnapshot("steer-recovery")).toMatchObject({
			queued: [],
			pendingSteers: [{ item: { id: "steer-one" }, index: 0 }],
		});
		expect(store.settlePendingSteers()).toBe(1);
		expect(store.deliverySnapshot("steer-recovery")).toMatchObject({
			queued: [],
			pendingSteers: [],
			steered: [{ id: "steer-one", content: "fold me in" }],
		});
		expect(
			store.requeueSteerDeliveries("steer-recovery", [
				{ id: "steer-one", content: "fold me in" },
			]),
		).toBe(1);
		expect(store.deliverySnapshot("steer-recovery")).toMatchObject({
			queued: [{ id: "steer-one", content: "fold me in" }],
			steered: [],
		});
	});

	test("commits command completion and its effects in one decision transaction", async () => {
		await sessionKernel("decision").dispatchLegacy(
			testEffect({ requestId: "request", type: "notify" }),
			(kernel) => {
				kernel.enqueueEffect(
					"human_ask_deliver",
					{ askId: "ask-one", skipUi: false },
					"message-1",
				);
				return { accepted: true };
			},
		);
		expect(store.command("decision", "request")).toMatchObject({
			status: "completed",
			result: { accepted: true },
		});
		expect(store.pendingOutbox()).toEqual([
			expect.objectContaining({
				effectId: "decision:human_ask_deliver:message-1",
				effectKey: "message-1",
				payload: { askId: "ask-one", skipUi: false },
			}),
		]);
	});

	test("batches compatibility effects in one store transaction", () => {
		expect(store.enqueueOutboxMany("compatibility", [
			{ kind: "one", payload: { n: 1 }, effectKey: "a" },
			{ kind: "two", payload: { n: 2 }, effectKey: "b" },
		])).toHaveLength(2);
		expect(store.pendingOutbox().map((effect) => effect.effectKey)).toEqual(["a", "b"]);
	});

	test("does not publish staged effects when a command fails", async () => {
		await expect(
			sessionKernel("decision-failed").dispatchLegacy(
				testEffect({ requestId: "request", type: "notify" }),
				(kernel) => {
					kernel.enqueueEffect(
						"human_ask_deliver",
						{ askId: "ask-one", skipUi: false },
						"message-1",
					);
					throw new Error("decision rejected");
				},
			),
		).rejects.toThrow("decision rejected");
		expect(store.pendingOutbox()).toHaveLength(0);
	});

	test("actor-owned delivery maps isolate nested mutable values", () => {
		const map = new DeliveryOwnedMap<Array<{ nested: { values: string[] } }>>("queued");
		const source = [{ nested: { values: ["a"] } }];
		map.set("nested-session", source);
		source[0].nested.values.push("source");
		const read = map.get("nested-session")!;
		read[0].nested.values.push("reader");
		expect(map.get("nested-session")?.[0].nested.values).toEqual(["a"]);
	});

	test("read projections do not activate dormant sessions", () => {
		const projection = new DeliveryOwnedMap<string>("queued");
		expect(projection.get("dormant")).toBeUndefined();
		expect(activeSessionKernels()).toHaveLength(0);
	});

});

describe("SessionKernel durable runtime", () => {
	test("fires a durable timer once and removes it after acknowledgement", async () => {
		const { drainSessionKernelRuntime, registerSessionTimerHandler, waitForSessionKernelRuntimeIdle, } = await import("./runtime");
		let calls = 0;
		const unregister = registerSessionTimerHandler("test_timer", () => {
			calls += 1;
		});
		try {
			sessionKernel("timer-session").scheduleTimer({
				timerId: "wake",
				kind: "test_timer",
				dueAt: Date.now() - 1,
				payload: { value: 1 },
			});
			await drainSessionKernelRuntime();
			await waitForSessionKernelRuntimeIdle();
			await drainSessionKernelRuntime();
			expect(calls).toBe(1);
			expect(store.timer("timer-session", "wake")).toBeUndefined();
		} finally {
			unregister();
		}
	});

	test("same-id same-time replacement gets a distinct firing receipt", async () => {
		const { fireSessionTimer, registerSessionTimerHandler } = await import("./runtime");
		const sessionId = "timer-replacement";
		const dueAt = Date.now() - 1;
		let calls = 0;
		const unregister = registerSessionTimerHandler("replace_timer", () => { calls += 1; });
		try {
			sessionKernel(sessionId).scheduleTimer({ timerId: "wake", kind: "replace_timer", dueAt, payload: 1 });
			const first = store.timer(sessionId, "wake")!;
			await fireSessionTimer(first);
			sessionKernel(sessionId).scheduleTimer({ timerId: "wake", kind: "replace_timer", dueAt, payload: 1 });
			const second = store.timer(sessionId, "wake")!;
			expect(second.token).not.toBe(first.token);
			await fireSessionTimer(second);
			expect(calls).toBe(2);
		} finally { unregister(); }
	});

	test("stale timer failure cannot back off a replacement generation", () => {
		store.scheduleTimer({ sessionId: "stale-failure", timerId: "same", kind: "test", dueAt: 1, payload: 1 });
		const stale = store.timer("stale-failure", "same")!;
		store.scheduleTimer({ sessionId: "stale-failure", timerId: "same", kind: "test", dueAt: 1, payload: 2 });
		expect(store.noteTimerFailure("stale-failure", "same", "old", 20, stale.token)).toEqual({ updated: false, deadLetteredNow: false });
		expect(store.timer("stale-failure", "same")).toMatchObject({ payload: 2, attempts: 0 });
	});

	test("re-enters replay-safe timer handlers after ordinary failures", async () => {
		const { drainSessionKernelRuntime, registerSessionTimerHandler, waitForSessionKernelRuntimeIdle, } = await import("./runtime");
		let calls = 0;
		const unregister = registerSessionTimerHandler("retry_timer", () => {
			calls += 1;
			if (calls === 1) throw new Error("ordinary delivery failure");
		});
		try {
			sessionKernel("retry-timer").scheduleTimer({
				timerId: "wake",
				kind: "retry_timer",
				dueAt: Date.now() - 1,
				payload: null,
			});
			await drainSessionKernelRuntime();
			await waitForSessionKernelRuntimeIdle();
			await Bun.sleep(1_050);
			await drainSessionKernelRuntime();
			await waitForSessionKernelRuntimeIdle();
			expect(calls).toBe(2);
			expect(store.timer("retry-timer", "wake")).toBeUndefined();
		} finally {
			unregister();
		}
	});

	test("backs off failed timers instead of refiring every runtime tick", () => {
		sessionKernel("timer-backoff").scheduleTimer({
			timerId: "wake",
			kind: "missing",
			dueAt: Date.now() - 1,
			payload: null,
		});
		store.noteTimerFailure("timer-backoff", "wake", "temporary");
		expect(store.dueTimers()).toHaveLength(0);
		expect(store.timer("timer-backoff", "wake")).toMatchObject({
			attempts: 1,
			lastError: "temporary",
		});
	});

	test("dead-letters poison timers after bounded attempts", () => {
		sessionKernel("timer-poison").scheduleTimer({
			timerId: "wake",
			kind: "broken",
			dueAt: Date.now() - 1,
			payload: null,
		});
		for (let attempt = 0; attempt < 20; attempt++)
			store.noteTimerFailure("timer-poison", "wake", "still broken", 20);
		expect(store.dueTimers(Date.now() + 60 * 60_000)).toHaveLength(0);
		expect(store.stats().deadLetteredTimers).toBe(1);
		expect(store.retryDeadTimer("timer-poison", "wake")).toBe(true);
		expect(store.dueTimers(Date.now() + 60 * 60_000)).toHaveLength(1);
	});

	test("unknown durable kinds cannot starve registered work", async () => {
		const { drainSessionKernelRuntime, registerSessionTimerHandler, waitForSessionKernelRuntimeIdle, } = await import("./runtime");
		const { replaceSessionEffectExecutorForTest } = await import("./effect-executors");
		for (let i = 0; i < 120; i++) {
			store.enqueueOutbox(`unknown-${i}`, "future_effect", null, String(i));
			store.scheduleTimer({ sessionId: `unknown-${i}`, timerId: "future", kind: "future_timer", dueAt: Date.now() - 1, payload: null, });
		}
		store.enqueueOutbox(
			"known",
			"human_ask_deliver",
			{ askId: "known", skipUi: false },
			"known",
		);
		store.scheduleTimer({ sessionId: "known", timerId: "known", kind: "known_timer", dueAt: Date.now() - 1, payload: null, });
		let effects = 0;
		let timers = 0;
		const unregisterEffect = replaceSessionEffectExecutorForTest(
			"human_ask_deliver",
			() => { effects += 1; },
		);
		const unregisterTimer = registerSessionTimerHandler("known_timer", () => { timers += 1; });
		try {
			await drainSessionKernelRuntime();
			await waitForSessionKernelRuntimeIdle();
			expect(effects).toBe(1);
			expect(timers).toBe(1);
		} finally {
			unregisterEffect();
			unregisterTimer();
		}
	});

	test("dead-letters a poison outbox effect after its bounded attempts", () => {
		const id = store.enqueueOutbox("poison", "notify", null, "one");
		for (let attempt = 0; attempt < 20; attempt++)
			store.noteOutboxFailure(id, "still broken", 20);
		expect(store.pendingOutbox(Date.now() + 60 * 60_000)).toHaveLength(0);
		expect(store.stats().pendingOutbox).toBe(0);
		expect(store.stats().deadLetteredOutbox).toBe(1);
		expect(store.discardDeadOutbox(id)).toBe(true);
		expect(store.stats().deadLetteredOutbox).toBe(0);
	});

	test("dead-lettered creation effects fail their actor lifecycle", async () => {
		const {
			CreationEffectIndeterminateError,
			ensureCreationEffectExecutors,
		} = await import("./creation-effect-executors");
		const {
			drainSessionKernelRuntime,
			waitForSessionKernelRuntimeIdle,
		} = await import("./runtime");
		const { replaceSessionEffectExecutorForTest } = await import("./effect-executors");
		ensureCreationEffectExecutors();
		store.applyCreationEvent({
			sessionId: "creation-dead",
			identity: "identity-dead",
			event: "plan",
		});
		store.applyCreationEvent({
			sessionId: "creation-dead",
			identity: "identity-dead",
			event: "preparation_started",
			nextEffectId: "sandbox:dead",
			effect: {
				kind: "creation_sandbox_prepare",
				effectKey: "sandbox:dead",
				payload: {
					creationIdentity: "identity-dead",
					creationGeneration: 1,
					provider: "modal",
					sandboxKey: "creation-dead",
					mode: "adopt_or_create",
				},
			},
		});
		const unregister = replaceSessionEffectExecutorForTest(
			"creation_sandbox_prepare",
			() => {
				throw new CreationEffectIndeterminateError("ambiguous sandbox");
			},
		);
		try {
			await drainSessionKernelRuntime();
			await waitForSessionKernelRuntimeIdle();
			expect(store.creationState("creation-dead")).toMatchObject({
				state: "failed",
				currentEffectId: undefined,
				completedEffectIds: ["sandbox:dead"],
			});
			expect(store.stats().deadLetteredOutbox).toBe(1);
		} finally {
			unregister();
		}
	});

	test("re-admits only pre-execution branch compatibility false positives", () => {
		const sharedPayload = {
			creationIdentity: "creation-one",
			creationGeneration: 1,
			project: "opensession",
			branch: "feature",
			worktreePath: "/srv/opensession",
			isolated: false,
			mode: "adopt_or_create",
		};
		const matching = store.enqueueOutbox(
			"shared-session",
			"creation_branch_prepare",
			sharedPayload,
			"shared-branch",
		);
		const ordinary = store.enqueueOutbox(
			"ordinary-session",
			"creation_branch_prepare",
			{ ...sharedPayload, worktreePath: "/srv/ordinary" },
			"ordinary-branch",
		);
		const legacyEmptyBase = store.enqueueOutbox(
			"legacy-session",
			"creation_branch_prepare",
			{
				...sharedPayload,
				project: "tella-fusion",
				worktreePath: "/srv/tella-fusion-feature",
				baseBranch: "",
			},
			"legacy-empty-base",
		);
		const differentFailure = store.enqueueOutbox(
			"different-session",
			"creation_branch_prepare",
			sharedPayload,
			"different-failure",
		);
		const ownEffect = (
			sessionId: string,
			effectKey: string,
			payload: Record<string, unknown>,
		) => {
			store.applyCreationEvent({
				sessionId,
				identity: String(payload.creationIdentity),
				event: "plan",
			});
			store.applyCreationEvent({
				sessionId,
				identity: String(payload.creationIdentity),
				event: "preparation_started",
				nextEffectId: effectKey,
				effect: {
					kind: "creation_branch_prepare",
					effectKey,
					payload: payload as any,
				},
			});
		};
		ownEffect("shared-session", "shared-branch", sharedPayload);
		ownEffect("ordinary-session", "ordinary-branch", {
			...sharedPayload,
			worktreePath: "/srv/ordinary",
		});
		ownEffect("legacy-session", "legacy-empty-base", {
			...sharedPayload,
			project: "tella-fusion",
			worktreePath: "/srv/tella-fusion-feature",
			baseBranch: "",
		});
		ownEffect("different-session", "different-failure", sharedPayload);
		store.noteOutboxFailure(
			matching,
			"Worktree destination /srv/opensession exists without a registered branch",
			1,
		);
		store.noteOutboxFailure(
			ordinary,
			"Worktree destination /srv/ordinary exists without a registered branch",
			1,
		);
		store.noteOutboxFailure(
			legacyEmptyBase,
			"Invalid creation_branch_prepare effect payload: baseBranch",
			1,
		);
		store.noteOutboxFailure(differentFailure, "credential unavailable", 1);

		expect(
			store.retryCompatibleCreationBranchDeadLetters([
				{ project: "opensession", worktreePath: "/srv/opensession" },
			]),
		).toEqual([
			{
				id: matching,
				sessionId: "shared-session",
				reason: "shared_checkout_destination_adoptable",
			},
			{
				id: legacyEmptyBase,
				sessionId: "legacy-session",
				reason: "legacy_empty_base_branch",
			},
		]);
		expect(store.pendingOutbox(Date.now() + 1_000).map((item) => item.id)).toEqual([
			matching,
			legacyEmptyBase,
		]);
		expect(store.stats().deadLetteredOutbox).toBe(2);
	});

	test("retries an outbox effect until it succeeds", async () => {
		const { drainSessionKernelRuntime, waitForSessionKernelRuntimeIdle, } = await import("./runtime");
		const { replaceSessionEffectExecutorForTest } = await import("./effect-executors");
		let calls = 0;
		const unregister = replaceSessionEffectExecutorForTest("human_ask_deliver", () => {
			calls += 1;
			if (calls === 1) throw new Error("temporary");
		});
		try {
			sessionKernel("outbox-session").enqueueEffect(
				"human_ask_deliver",
				{ askId: "retry", skipUi: false },
			);
			await drainSessionKernelRuntime();
			await waitForSessionKernelRuntimeIdle();
			expect(store.pendingOutbox(Date.now() + 2_000)).toHaveLength(1);
			await Bun.sleep(1_050);
			await drainSessionKernelRuntime();
			await waitForSessionKernelRuntimeIdle();
			expect(calls).toBe(2);
			expect(store.pendingOutbox()).toHaveLength(0);
		} finally {
			unregister();
		}
	});
});
