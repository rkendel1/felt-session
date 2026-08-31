import { beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, writeFileSync } from "fs";
import {
	authenticateRunner,
	createRunnerPairing,
	bindRunnerPairingMigration,
	isTailnetAddress,
	listRunners,
	normalizeAddress,
	registerRunner,
	releaseRunnerReservation,
	removeRunner,
	reserveRunner,
	runnerAllowed,
	runnerAllowsLocalInference,
	updateRunner,
	initializeManagedRunners,
} from "./runners";

beforeEach(async () => {
	await initializeManagedRunners(
		createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
		`/tmp/missing-runners-${crypto.randomUUID()}.json`,
	);
});

async function register(overrides: Partial<Parameters<typeof registerRunner>[0]> = {}) {
	const { code } = createRunnerPairing("tester");
	return registerRunner({ code, name: "mac-mini", platform: "darwin", arch: "arm64", capabilities: { toolchains: ["xcode", "swift"], tags: ["ios"] }, resources: { memoryGb: 64, gpu: { kind: "apple", model: "M4 Max", metal: true } }, address: "100.101.102.103", ...overrides });
}

describe("Runner registry security", () => {
	test("imports the legacy registry once and removes its file", async () => {
		const legacyPath = `/tmp/legacy-runners-${crypto.randomUUID()}.json`;
		writeFileSync(legacyPath, JSON.stringify({ runners: [{
			id: "runner-legacy",
			name: "legacy",
			platform: "linux",
			arch: "x64",
			address: "100.101.102.103",
			tokenHash: "0".repeat(64),
			createdAt: new Date().toISOString(),
			capabilities: { platform: "linux", toolchains: [], tags: [] },
			permissions: { commands: true, fullSessions: false, terminals: false, portals: false },
			allowedUsers: [],
			allowedRepos: [],
			workspaceRoots: [],
		}] }));
		await initializeManagedRunners(
			createFeltDB({ namespace: crypto.randomUUID(), memory: true }),
			legacyPath,
		);
		expect(listRunners().map((runner) => runner.id)).toEqual(["runner-legacy"]);
		expect(existsSync(legacyPath)).toBe(false);
	});

	test("accepts only tailnet and loopback addresses", async () => {
		for (const address of ["100.64.0.1", "100.127.255.254", "127.0.0.1", "::1"]) expect(isTailnetAddress(address)).toBe(true);
		for (const address of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.1", ""]) expect(isTailnetAddress(address)).toBe(false);
		expect(normalizeAddress("::ffff:100.64.0.1")).toBe("100.64.0.1");
	});

	test("pairing is one-time and stored credentials are hashed", async () => {
		const first = await register();
		if (!first.ok) throw new Error(first.error);
		expect(first.token).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(listRunners()[0])).not.toContain(first.token);
		expect(authenticateRunner(first.runner.id, first.token)?.id).toBe(first.runner.id);
		expect(authenticateRunner(first.runner.id, "wrong")).toBeUndefined();
		const reused = await registerRunner({ code: "ZZZZ-ZZZZ", name: "other", platform: "linux", arch: "x64", address: "100.101.102.103" });
		expect(reused.ok).toBe(false);
	});

	test("re-pairing retains policy but rotates the credential", async () => {
		const first = await register();
		if (!first.ok) throw new Error(first.error);
		await updateRunner(first.runner.id, { allowedRepos: ["opensession"] });
		const second = await register();
		if (!second.ok) throw new Error(second.error);
		expect(second.runner.id).toBe(first.runner.id);
		expect(second.runner.permissions.fullSessions).toBe(false);
		expect(second.runner.allowedRepos).toEqual(["opensession"]);
		expect(authenticateRunner(first.runner.id, first.token)).toBeUndefined();
	});

	test("keeps non-secret Kubernetes migration diagnostics with the paired Runner", async () => {
		const { code } = createRunnerPairing("tester");
		expect(bindRunnerPairingMigration(code, { kind: "kubernetes", label: "GPU devbox", context: "production", namespace: "runners", workload: "gpu-runner" })).toBe(true);
		const result = await registerRunner({ code, name: "gpu-devbox", platform: "linux", arch: "x64", address: "100.101.102.103" });
		if (!result.ok) throw new Error(result.error);
		expect(result.runner.migration).toEqual({ kind: "kubernetes", label: "GPU devbox", context: "production", namespace: "runners", workload: "gpu-runner" });
	});
});

describe("Runner policy and reservations", () => {
	test("enforces explicit user, repository, and execution permission policy", async () => {
		const result = await register();
		if (!result.ok) throw new Error(result.error);
		const runner = (await updateRunner(result.runner.id, { allowedUsers: ["alex"], allowedRepos: ["ios-app"], permissions: { commands: true, fullSessions: true, terminals: true, portals: true } }))!;
		expect(runnerAllowed(runner, { user: "alex", repo: "ios-app", permission: "commands" })).toBe(true);
		expect(runnerAllowed(runner, { user: "sam", repo: "ios-app", permission: "commands" })).toBe(false);
		expect(runnerAllowed(runner, { user: "alex", repo: "web", permission: "commands" })).toBe(false);
		expect(runner.permissions.fullSessions).toBe(false);
		expect(runnerAllowed(runner, { user: "alex", repo: "ios-app", permission: "portals" })).toBe(false);
	});

	test("prevents competing reservations and lets the owner release one", async () => {
		const result = await register();
		if (!result.ok) throw new Error(result.error);
		expect((await reserveRunner(result.runner.id, { reason: "iOS release", reservedBy: "alex", durationMinutes: 30 }))?.reservation?.reservedBy).toBe("alex");
		expect(await reserveRunner(result.runner.id, { reason: "other", reservedBy: "sam" })).toBeUndefined();
		expect(await releaseRunnerReservation(result.runner.id, "sam")).toBeUndefined();
		expect((await releaseRunnerReservation(result.runner.id, "alex"))?.reservation).toBeUndefined();
	});

	test("requires an explicit, user- and model-scoped local inference policy", async () => {
		const result = await register({ resources: { localInference: [{ runtime: "ollama", models: ["llama3"] }] } });
		if (!result.ok) throw new Error(result.error);
		let runner = listRunners()[0];
		expect(runnerAllowsLocalInference(runner, { user: "alex", model: "llama3", task: "chat" })).toBe(false);
		await updateRunner(runner.id, { localInferencePolicy: { enabled: true, allowedUsers: ["alex"], allowedModels: ["llama3"], allowedTasks: ["chat"] } });
		runner = listRunners()[0];
		expect(runnerAllowsLocalInference(runner, { user: "alex", model: "llama3", task: "chat" })).toBe(true);
		expect(runnerAllowsLocalInference(runner, { user: "sam", model: "llama3", task: "chat" })).toBe(false);
		expect(runnerAllowsLocalInference(runner, { user: "alex", model: "other", task: "chat" })).toBe(false);
	});
});
