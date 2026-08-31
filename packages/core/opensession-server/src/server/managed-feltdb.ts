import { createFeltDB, type StateFirstDB } from "@feltdb/core";
import { readFileSync } from "node:fs";

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

const DEFAULT_NAMESPACE = "open-session";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Managed FeltDB requires ${name}`);
  return normalized;
}

function managedCredential(env: Record<string, string | undefined>): string | undefined {
  const directory = env.CREDENTIALS_DIRECTORY?.trim();
  if (!directory) return undefined;
  try {
    return readFileSync(`${directory}/managed-feltdb-token`, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Resolve the one canonical persistence authority. Credentials are accepted
 * only from the process environment and are never returned by status APIs or
 * included in errors. The generic FELTDB_* names match the managed runtime
 * environment emitted by @feltdb/core; OPENSESSION_* names are explicit
 * server aliases for operators who do not expose Vite variables to Node. */
export function managedFeltDbConfig(
  env: Record<string, string | undefined> = process.env,
): ManagedFeltDbConnectionConfig {
  const namespace = required(
    env.OPENSESSION_FELTDB_NAMESPACE ||
      env.OPENSESSION_FELTDB_SERVER_NAMESPACE ||
      env.FELTDB_MANAGED_NAMESPACE ||
      env.VITE_FELTDB_MANAGED_NAMESPACE ||
      env.FELTDB_NAMESPACE ||
      DEFAULT_NAMESPACE,
    "a namespace",
  );
  const url = required(
    env.OPENSESSION_FELTDB_URL ||
      env.OPENSESSION_FELTDB_SERVER_URL ||
      env.FELTDB_MANAGED_URL ||
      env.VITE_FELTDB_MANAGED_URL ||
      env.FELTDB_URL,
    "a managed URL",
  ).replace(/\/$/, "");
  const apiKey = required(
    env.OPENSESSION_FELTDB_API_KEY ||
      env.OPENSESSION_FELTDB_SERVER_TOKEN ||
      env.FELTDB_MANAGED_API_KEY ||
      env.VITE_FELTDB_MANAGED_API_KEY ||
      env.FELTDB_TOKEN ||
      managedCredential(env),
    "an API key",
  );
  return {
    namespace,
    runtime: "managed",
    storage: "managed",
    distributed: true,
    url,
    apiKey,
  };
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
    throw new Error(
      "Managed FeltDB initialized with a non-remote storage backend",
    );
  // An actual collection read verifies reachability and credentials. Runtime
  // metadata alone is derived from constructor options and proves neither.
  await db.collection("opensession_system").all();
  state.db = db;
  state.identity = identity;
  return db;
}

export function managedFeltDb(): StateFirstDB {
  if (!state.db) throw new Error("Managed FeltDB has not been initialized");
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
      connected:
        !!state.db && state.identity === `${config.url}\n${config.namespace}`,
      namespace: config.namespace,
      url: config.url,
    };
  } catch (error) {
    return {
      configured: false,
      connected: false,
      error:
        error instanceof Error
          ? error.message
          : "Managed FeltDB is not configured",
    };
  }
}

export function __resetManagedFeltDbForTest(): void {
  delete state.db;
  delete state.identity;
}
