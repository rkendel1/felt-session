import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	deployCheckout,
	deployStateDir,
	formatDeployStatus,
	markerAgeMs,
	parseDeployResult,
	readDeployState,
} from "./self-deploy";

const savedState = process.env.OPENSESSION_DEPLOY_STATE;
const savedCheckout = process.env.OPENSESSION_DEPLOY_CHECKOUT;
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "os-self-deploy-"));
});

afterEach(() => {
	if (savedState === undefined) delete process.env.OPENSESSION_DEPLOY_STATE;
	else process.env.OPENSESSION_DEPLOY_STATE = savedState;
	if (savedCheckout === undefined) delete process.env.OPENSESSION_DEPLOY_CHECKOUT;
	else process.env.OPENSESSION_DEPLOY_CHECKOUT = savedCheckout;
	rmSync(dir, { recursive: true, force: true });
});

describe("parseDeployResult", () => {
	test("parses a script-written result", () => {
		const raw =
			'{"ok":true,"action":"deploy","sha":"abc123","previousSha":"def456","target":"origin/main","startedAt":"2026-08-04T10:00:00Z","finishedAt":"2026-08-04T10:01:00Z","durationSecs":60,"message":"deployed and healthy"}';
		const r = parseDeployResult(raw);
		expect(r).not.toBeNull();
		expect(r!.ok).toBe(true);
		expect(r!.action).toBe("deploy");
		expect(r!.sha).toBe("abc123");
		expect(r!.durationSecs).toBe(60);
	});

	test("rejects garbage, half-written and shape-less JSON", () => {
		expect(parseDeployResult("")).toBeNull();
		expect(parseDeployResult('{"ok":true,"action"')).toBeNull();
		expect(parseDeployResult("null")).toBeNull();
		expect(parseDeployResult('"a string"')).toBeNull();
		expect(parseDeployResult('{"ok":"yes","action":"deploy"}')).toBeNull();
		expect(parseDeployResult('{"ok":true}')).toBeNull();
	});
});

describe("markerAgeMs", () => {
	test("computes age from an epoch-seconds marker", () => {
		const now = 1_700_000_100_000;
		expect(markerAgeMs("1700000000\n", now)).toBe(100_000);
	});

	test("returns null for a missing/corrupt marker", () => {
		expect(markerAgeMs("", Date.now())).toBeNull();
		expect(markerAgeMs("not-a-number", Date.now())).toBeNull();
		expect(markerAgeMs("17000e3", Date.now())).toBeNull();
	});
});

describe("deployStateDir / deployCheckout", () => {
	test("env overrides win; defaults otherwise", () => {
		process.env.OPENSESSION_DEPLOY_STATE = "/tmp/x-state";
		process.env.OPENSESSION_DEPLOY_CHECKOUT = "/tmp/x-checkout";
		expect(deployStateDir()).toBe("/tmp/x-state");
		expect(deployCheckout()).toBe("/tmp/x-checkout");
		delete process.env.OPENSESSION_DEPLOY_STATE;
		delete process.env.OPENSESSION_DEPLOY_CHECKOUT;
		expect(deployStateDir().endsWith("/.opensession-deploy")).toBe(true);
		// Default checkout is this repo (the running instance's own tree).
		expect(deployCheckout()).toBe(resolve(import.meta.dir, "../../../../.."));
	});
});

describe("readDeployState", () => {
	test("empty state dir degrades to nulls", () => {
		const s = readDeployState(dir);
		expect(s.pin).toBeNull();
		expect(s.markerAgeMs).toBeNull();
		expect(s.result).toBeNull();
	});

	test("reads pin + marker + result together", () => {
		const now = 1_700_000_600_000;
		writeFileSync(join(dir, "last-known-good"), "abc123def456\n");
		writeFileSync(join(dir, "last-deploy-marker"), "1700000000\n");
		writeFileSync(
			join(dir, "last-result.json"),
			'{"ok":false,"action":"rollback-needed","sha":"badbadbad1","previousSha":"abc123def456","message":"unhealthy; tree left"}',
		);
		const s = readDeployState(dir, now);
		expect(s.pin).toBe("abc123def456");
		expect(s.markerAgeMs).toBe(600_000);
		expect(s.result!.action).toBe("rollback-needed");
	});
});

describe("formatDeployStatus", () => {
	test("no result yet", () => {
		const out = formatDeployStatus({ pin: null, markerAgeMs: null, result: null }, dir);
		expect(out).toContain("No self-deploy result recorded yet");
		expect(out).toContain("pin: none recorded");
		expect(out).toContain("Watchdog window: closed");
	});

	test("healthy deploy with open watchdog window", () => {
		const out = formatDeployStatus(
			{
				pin: "abc123def456",
				markerAgeMs: 2 * 60_000,
				result: {
					ok: true,
					action: "deploy",
					sha: "feedfacefeed",
					target: "origin/main",
					finishedAt: "2026-08-04T10:01:00Z",
					durationSecs: 45,
					message: "deployed and healthy",
				},
			},
			dir,
		);
		expect(out).toContain("Last self-deploy: OK (deploy)");
		expect(out).toContain("feedfacefe");
		expect(out).toContain("pin: abc123def4");
		expect(out).toContain("Watchdog window: OPEN");
	});

	test("rollback-needed surfaces the manual action", () => {
		const out = formatDeployStatus(
			{
				pin: "abc123def456",
				markerAgeMs: null,
				result: {
					ok: false,
					action: "rollback-needed",
					sha: "badbadbad111",
					previousSha: "abc123def456",
					message: "unhealthy after deploy; tree left",
				},
			},
			dir,
		);
		expect(out).toContain("FAILED (rollback-needed)");
		expect(out).toContain("ACTION NEEDED");
		expect(out).toContain("abc123def4");
	});
});

describe("deploy/self-deploy.sh", () => {
	test("passes bash -n (syntax)", () => {
		const script = resolve(import.meta.dir, "../../../../../deploy/self-deploy.sh");
		const proc = Bun.spawnSync(["bash", "-n", script]);
		expect(proc.exitCode).toBe(0);
	});

	test("passes configured storage paths to the offline actor migration", async () => {
		const script = await Bun.file(
			resolve(import.meta.dir, "../../../../../deploy/self-deploy.sh"),
		).text();
		expect(script).toContain("read_env_value OPENSESSION_STATE_DIR");
		expect(script).toContain("read_env_value OPENSESSION_SESSIONS_DIR");
		expect(script).toContain('migration_env+=("OPENSESSION_STATE_DIR=');
		expect(script).toContain('migration_env+=("OPENSESSION_SESSIONS_DIR=');
		expect(script).toContain("migrate-session-kernel-storage.ts");
	});

	test("the server launches through the fixed privileged helper", async () => {
		const source = await Bun.file(resolve(import.meta.dir, "self-deploy.ts")).text();
		expect(source).toContain('RUN_HOST_HELPER, "self-deploy"');
		expect(source).toContain("Migration path for instances upgrading");
		expect(source).toContain("Environment=OPENSESSION_BUN_BIN=${process.execPath}");
		expect(source).toContain("Environment=OPENSESSION_STATE_DIR=");
		expect(source).toContain("Environment=OPENSESSION_SESSIONS_DIR=");
		const helper = await Bun.file(
			resolve(import.meta.dir, "../../../../../deploy/opensession-run-host"),
		).text();
		expect(helper).toContain('-p "EnvironmentFile=$env_file"');
		expect(helper).toContain('-p "Environment=OPENSESSION_BUN_BIN=$bun_bin"');
	});
});
