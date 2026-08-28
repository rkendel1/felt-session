import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type ManagedFeltDbProjectConfig = {
	namespace: string;
	runtime: "managed";
	storage: "managed";
	distributed: true;
};

export type ManagedFeltDbConnectionConfig = ManagedFeltDbProjectConfig & {
	url: string;
	apiKey: string;
};

const PROJECT_CONFIG_PATH = resolve(import.meta.dir, "../../../../../feltdb.config.json");

function required(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`Managed FeltDB requires ${name}`);
	return normalized;
}

/** Resolve the one canonical persistence authority. Credentials are accepted
 * only from the process environment and are never returned by status APIs or
 * included in errors. The generic FELTDB_* names match the managed runtime
 * environment emitted by @feltdb/core; OPENSESSION_* names are explicit
 * server aliases for operators who do not expose Vite variables to Node. */
export function managedFeltDbConfig(
	env: Record<string, string | undefined> = process.env,
	projectConfigPath = PROJECT_CONFIG_PATH,
): ManagedFeltDbConnectionConfig {
	if (!existsSync(projectConfigPath))
		throw new Error(`Managed FeltDB project configuration is missing: ${projectConfigPath}`);
	let project: Partial<ManagedFeltDbProjectConfig>;
	try {
		project = JSON.parse(readFileSync(projectConfigPath, "utf8"));
	} catch {
		throw new Error(`Managed FeltDB project configuration is invalid: ${projectConfigPath}`);
	}
	if (project.runtime !== "managed" || project.storage !== "managed" || project.distributed !== true)
		throw new Error("Managed FeltDB project configuration must use managed, distributed storage");
	const namespace = required(
		env.OPENSESSION_FELTDB_NAMESPACE
			|| env.FELTDB_MANAGED_NAMESPACE
			|| env.VITE_FELTDB_MANAGED_NAMESPACE
			|| env.FELTDB_NAMESPACE
			|| project.namespace,
		"a namespace",
	);
	const url = required(
		env.OPENSESSION_FELTDB_URL
			|| env.FELTDB_MANAGED_URL
			|| env.VITE_FELTDB_MANAGED_URL
			|| env.FELTDB_URL,
		"a managed URL",
	).replace(/\/$/, "");
	const apiKey = required(
		env.OPENSESSION_FELTDB_API_KEY
			|| env.FELTDB_MANAGED_API_KEY
			|| env.VITE_FELTDB_MANAGED_API_KEY
			|| env.FELTDB_TOKEN,
		"an API key",
	);
	return { namespace, runtime: "managed", storage: "managed", distributed: true, url, apiKey };
}

type ManagedState = {
	db?: StateFirstDB;
	identity?: string;
};

const globalState = globalThis as typeof globalThis & {
	__opensessionManagedFeltDb?: ManagedState;
};
const state = (globalState.__opensessionManagedFeltDb ??= {});

/** Initialize and verify the sole Open Session persistence authority. No file,
 * memory, browser, or SQLite backend is constructed here. */
export async function initializeManagedFeltDb(
	config = managedFeltDbConfig(),
	create: typeof createFeltDB = createFeltDB,
): Promise<StateFirstDB> {
	const identity = `${config.url}\n${config.namespace}`;
	if (state.db && state.identity === identity) return state.db;
	const db = create({
		namespace: config.namespace,
		server: { url: config.url, token: config.apiKey },
	});
	if (db.runtime().storage !== "remote")
		throw new Error("Managed FeltDB initialized with a non-remote storage backend");
	// An actual collection read verifies reachability and credentials. Runtime
	// metadata alone is derived from constructor options and proves neither.
	await db.collection("opensession_system").all();
	state.db = db;
	state.identity = identity;
	return db;
}

export function managedFeltDb(): StateFirstDB {
	if (!state.db)
		throw new Error("Managed FeltDB has not been initialized");
	return state.db;
}

export function managedFeltDbStatus(): {
	configured: boolean;
	connected: boolean;
	namespace?: string;
	url?: string;
	error?: string;
} {
	try {
		const config = managedFeltDbConfig();
		return {
			configured: true,
			connected: !!state.db && state.identity === `${config.url}\n${config.namespace}`,
			namespace: config.namespace,
			url: config.url,
		};
	} catch (error) {
		return {
			configured: false,
			connected: false,
			error: error instanceof Error ? error.message : "Managed FeltDB is not configured",
		};
	}
}

export function __resetManagedFeltDbForTest(): void {
	delete state.db;
	delete state.identity;
}
