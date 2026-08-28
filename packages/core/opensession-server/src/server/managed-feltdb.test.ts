import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	__resetManagedFeltDbForTest,
	initializeManagedFeltDb,
	managedFeltDbConfig,
} from "./managed-feltdb";

const project = {
	namespace: "open-session",
	runtime: "managed",
	storage: "managed",
	distributed: true,
} as const;

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "opensession-managed-feltdb-"));
	const path = join(dir, "feltdb.config.json");
	writeFileSync(path, JSON.stringify(project));
	return { dir, path };
}

afterEach(() => __resetManagedFeltDbForTest());

describe("managed FeltDB boundary", () => {
	test("requires managed authority configuration", () => {
		const { path } = fixture();
		expect(() => managedFeltDbConfig({}, path)).toThrow("Managed FeltDB requires a managed URL");
	});

	test("resolves namespace and credentials without putting secrets in project config", () => {
		const { path } = fixture();
		const config = managedFeltDbConfig({
			FELTDB_MANAGED_URL: "https://api.feltdb.test/",
			FELTDB_MANAGED_API_KEY: "secret-value",
			FELTDB_MANAGED_NAMESPACE: "shared-development",
		}, path);
		expect(config).toEqual({
			...project,
			url: "https://api.feltdb.test",
			apiKey: "secret-value",
			namespace: "shared-development",
		});
		expect(readFileSync(path, "utf8")).not.toContain("secret-value");
	});

	test("constructs only a remote database and creates no local FeltDB", async () => {
		const { dir, path } = fixture();
		const before = readdirSync(dir);
		let options: unknown;
		const fake = ((value: unknown) => {
			options = value;
			return {
				runtime: () => ({ storage: "remote" }),
				collection: () => ({ all: async () => [] }),
			};
		}) as never;
		await initializeManagedFeltDb(managedFeltDbConfig({
			FELTDB_URL: "https://managed.example",
			FELTDB_TOKEN: "token",
		}, path), fake);
		expect(options).toEqual({
			namespace: "open-session",
			server: { url: "https://managed.example", token: "token" },
		});
		expect(readdirSync(dir)).toEqual(before);
	});

	test("fails instead of falling back when the managed read fails", async () => {
		const { path } = fixture();
		const fake = (() => ({
			runtime: () => ({ storage: "remote" }),
			collection: () => ({ all: async () => { throw new Error("authority unavailable"); } }),
		})) as never;
		await expect(initializeManagedFeltDb(managedFeltDbConfig({
			FELTDB_URL: "https://managed.example",
			FELTDB_TOKEN: "token",
		}, path), fake)).rejects.toThrow("authority unavailable");
	});
});
