/** Durable, server-owned snapshot of Sandbox Portal metadata.
 *
 * A volume-mode Sandbox cannot be inspected while sleeping, but the session
 * sidebar must remain useful and must never wake compute merely to render.
 * Keep only presentation metadata here. Live URLs are deliberately discarded
 * from the sleeping view, and reopening requires an explicit wake.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { statePath } from "./paths";
import { managedFeltDb } from "./managed-feltdb";
import type { PreviewService, PreviewStatus } from "./preview";

/** `state` is optional on the wire of this durable store: entries written
 *  before it became a required PreviewService field have none. */
type CachedPortal = Pick<PreviewService, "name" | "key" | "port" | "description" | "defaultPath" | "managed"> & { state?: PreviewService["state"] };
type CachedPortalInput = Pick<CachedPortal, "name" | "key" | "port"> & Partial<Pick<CachedPortal, "description" | "defaultPath" | "managed" | "state">>;
type CachedEntry = { sessionId: string; sandboxId: string; services: CachedPortal[]; updatedAt: string };
type Store = { portals: CachedEntry[]; __version?: number };
const COLLECTION = "opensession_sandbox_portals";
const STORE_ID = "portals";
const MIGRATION = "sandbox-portals-json-to-managed-feltdb-v1";
let portalsDb: StateFirstDB | undefined;
let portalStore: Store = { portals: [] };

function storePath(): string { return statePath(".opensession-sandbox-portals.json"); }
function load(): Store {
	return structuredClone(portalStore);
}
async function save(store: Store): Promise<void> {
	const db = portalsDb ?? managedFeltDb();
	const previous = portalStore;
	delete store.__version;
	await db.transaction((tx) => {
		tx.collection<Store>(COLLECTION).set(STORE_ID, store,
			previous.__version ? { ifVersion: previous.__version } : { requireAbsent: true });
	}, { transactionId: `opensession:sandbox-portals:put:${crypto.randomUUID()}` });
	portalStore = { ...store, __version: (previous.__version ?? 0) + 1 };
}

export async function initializeManagedSandboxPortals(db: StateFirstDB = portalsDb ?? managedFeltDb()): Promise<void> {
	portalsDb = db;
	if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
		let legacy: Store | null = null;
		try { if (existsSync(storePath())) legacy = JSON.parse(readFileSync(storePath(), "utf8")); } catch {}
		if (Array.isArray(legacy?.portals)) await db.transaction((tx) => {
			tx.collection<Store>(COLLECTION).set(STORE_ID, legacy!);
		}, { transactionId: "opensession:sandbox-portals:migrate" });
		await db.transaction((tx) => {
			tx.collection("opensession_migrations").set(MIGRATION,
				{ id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${MIGRATION}` });
	}
	if (existsSync(storePath())) unlinkSync(storePath());
	portalStore = await db.collection<Store>(COLLECTION).get(STORE_ID) ?? { portals: [] };
}

async function cacheSandboxPortalMetadata(sessionId: string, sandboxId: string, services: CachedPortalInput[]): Promise<void> {
	const entry: CachedEntry = {
		sessionId,
		sandboxId,
		updatedAt: new Date().toISOString(),
		services: services.map(({ name, key, port, description, defaultPath, state, managed }) => ({ name, key, port, ...(description ? { description } : {}), ...(defaultPath ? { defaultPath } : {}), ...(state ? { state } : {}), ...(managed ? { managed } : {}) })),
	};
	const store = load();
	const index = store.portals.findIndex((item) => item.sessionId === sessionId);
	if (index < 0) store.portals.push(entry); else store.portals[index] = entry;
	await save(store);
}

export async function cacheSandboxPortals(sessionId: string, sandboxId: string, services: PreviewService[]): Promise<void> {
	await cacheSandboxPortalMetadata(sessionId, sandboxId, services);
}

/** Persist supervisor state at each transition, before a later status probe.
 * This keeps newly starting, failed, and stopped Portals visible even when a
 * remote provider cannot currently be inspected. */
export async function cacheSandboxPortalRecords(sessionId: string, sandboxId: string, records: CachedPortalInput[]): Promise<void> {
	await cacheSandboxPortalMetadata(sessionId, sandboxId, records.map((record) => ({ ...record, managed: true })));
}

/** A non-waking status for the sidebar. There is intentionally no live URL. */
export function sleepingSandboxPortalStatus(sessionId: string, sandboxId?: string): PreviewStatus | null {
	const entry = load().portals.find((item) => item.sessionId === sessionId && (!sandboxId || item.sandboxId === sandboxId));
	if (!entry) return null;
	const services: PreviewService[] = entry.services.map((service) => {
		const cached = service.state ?? "stopped";
		return {
			...service,
			running: false,
			previewUrl: null,
			state: cached === "failed" || cached === "stopped" ? cached : "sleeping",
			pids: [],
		};
	});
	const webapp = services.find((service) => service.key === "WEBAPP_PORT") ?? services[0];
	return {
		hasPortsConf: services.length > 0,
		webappPort: webapp?.port ?? null,
		running: false,
		starting: false,
		previewUrl: null,
		bootable: true,
		services,
		portalRecipes: [],
	};
}

/** Find the session that last registered this sandbox service. The caller
 * still verifies the live session and sandbox before restoring authority. */
export function cachedSandboxPortalOwner(
	sandboxId: string,
	port: number,
): string | null {
	const entry = load().portals.find(
		(item) =>
			item.sandboxId === sandboxId &&
			item.services.some((service) => service.port === port),
	);
	return entry?.sessionId ?? null;
}

export async function dropCachedSandboxPortals(sandboxId: string): Promise<void> {
	const store = load();
	const portals = store.portals.filter((entry) => entry.sandboxId !== sandboxId);
	if (portals.length !== store.portals.length) await save({ portals });
}
