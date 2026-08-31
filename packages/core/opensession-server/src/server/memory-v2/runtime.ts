import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "../managed-feltdb";
import { ManagedMemoryStore } from "./managed-store";

export type MemoryRolloutMode = "v2";

interface RuntimeStore {
	store: ManagedMemoryStore;
	initialized: Promise<void>;
}

export interface MemoryReadyResult {
	files: number;
	discovered: number;
	imported: number;
	alreadyImported: number;
	mapped: number;
	skipped: number;
	complete: true;
	sourceDigest: string;
	errors: [];
}

let runtime: RuntimeStore | undefined;
let configuredDb: StateFirstDB | undefined;

export function memoryRolloutMode(): MemoryRolloutMode {
	return "v2";
}

export async function memoryStore(): Promise<ManagedMemoryStore> {
	if (runtime) {
		await runtime.initialized;
		return runtime.store;
	}
	const store = new ManagedMemoryStore(configuredDb ?? managedFeltDb());
	runtime = { store, initialized: store.initialize() };
	await runtime.initialized;
	return store;
}

export async function initializeManagedMemory(
	db: StateFirstDB = configuredDb ?? managedFeltDb(),
): Promise<void> {
	closeMemoryRuntime();
	configuredDb = db;
	await memoryStore();
}

/** Managed FeltDB is already authoritative; there is no runtime import path. */
export async function ensureMemoryV2Ready(): Promise<{
	store: ManagedMemoryStore;
	migration: MemoryReadyResult;
}> {
	return {
		store: await memoryStore(),
		migration: {
			files: 0,
			discovered: 0,
			imported: 0,
			alreadyImported: 0,
			mapped: 0,
			skipped: 0,
			complete: true,
			sourceDigest: "managed-feltdb",
			errors: [],
		},
	};
}

export function closeMemoryRuntime(): void {
	runtime?.store.close();
	runtime = undefined;
}
