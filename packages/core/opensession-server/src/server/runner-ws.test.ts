import { beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { createRunnerPairing, initializeManagedRunners, registerRunner, updateRunner } from "./runners";
import { execOnRunner, runnerWsClose, runnerWsMessage, runnerWsOpen } from "./runner-ws";

beforeEach(async () => {
	await initializeManagedRunners(
		createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
		`/tmp/missing-runners-${crypto.randomUUID()}.json`,
	);
});

describe("Runner WebSocket policy", () => {
	test("blocks exec when maintenance is enabled after connection", async () => {
		const { code } = createRunnerPairing("tester");
		const registered = await registerRunner({ code, name: "connected-runner", platform: "linux", arch: "x64", address: "100.101.102.103" });
		if (!registered.ok) throw new Error(registered.error);

		const sent: string[] = [];
		const ws = {
			data: { kind: "runner", runnerId: registered.runner.id },
			send: (frame: string) => sent.push(frame),
			close: () => {},
		};
		expect(runnerWsOpen(ws)).toBe(true);
		expect(await runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 }))).toBe(true);
		await updateRunner(registered.runner.id, { maintenance: true });

		await expect(execOnRunner(registered.runner.id, "echo stale-policy")).rejects.toThrow("not permitted");
		expect(sent).toEqual([]);
		runnerWsClose(ws);
	});
});
