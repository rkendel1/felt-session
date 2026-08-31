/** Organization artwork stored beside the instance's other durable state. */

import {
	existsSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { createHash } from "crypto";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";

export const MAX_ORGANIZATION_ICON_BYTES = 4 * 1024 * 1024;
const MAX_ICON_SIDE = 2048;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const COLLECTION = "opensession_organization_assets";
const MIGRATION = "organization-icon-file-to-managed-feltdb-v1";
const ICON_ID = "icon";
interface StoredIcon { id: string; base64: string; __version?: number }
let organizationDb: StateFirstDB | undefined;
let icon: StoredIcon | undefined;

export class OrganizationIconError extends Error {}

export function organizationIconPath(): string {
	return `${stateDir("organization")}/icon.png`;
}

export function organizationIconRevision(): string | null {
	return icon ? createHash("sha256").update(icon.base64).digest("hex").slice(0, 12) : null;
}

export function organizationIconBytes(): Uint8Array | null {
	return icon ? new Uint8Array(Buffer.from(icon.base64, "base64")) : null;
}

export async function initializeManagedOrganizationIcon(db: StateFirstDB = organizationDb ?? managedFeltDb()): Promise<void> {
	organizationDb = db;
	const path = organizationIconPath();
	if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
		if (existsSync(path) && !await db.collection(COLLECTION).get(ICON_ID)) {
			const base64 = readFileSync(path).toString("base64");
			await db.transaction((tx) => {
				tx.collection<StoredIcon>(COLLECTION).set(ICON_ID, { id: ICON_ID, base64 }, { requireAbsent: true });
			}, { transactionId: "opensession:organization-icon:migrate" });
		}
		await db.transaction((tx) => {
			tx.collection("opensession_migrations").set(MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${MIGRATION}` });
	}
	if (existsSync(path)) unlinkSync(path);
	icon = await db.collection<StoredIcon>(COLLECTION).get(ICON_ID) ?? undefined;
}

function pngDimension(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] * 0x1000000 +
		bytes[offset + 1] * 0x10000 +
		bytes[offset + 2] * 0x100 +
		bytes[offset + 3]
	);
}

/** Store the square PNG prepared by the web or native image picker. */
export async function saveOrganizationIcon(bytes: Uint8Array): Promise<void> {
	if (!bytes.length) throw new OrganizationIconError("The upload was empty");
	if (bytes.length > MAX_ORGANIZATION_ICON_BYTES) {
		throw new OrganizationIconError("That image is too large. Icons cap at 4 MB.");
	}
	if (
		bytes.length < 24 ||
		PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) ||
		String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
	) {
		throw new OrganizationIconError("An organization icon has to be a PNG");
	}
	const width = pngDimension(bytes, 16);
	const height = pngDimension(bytes, 20);
	if (!width || width !== height || width > MAX_ICON_SIDE) {
		throw new OrganizationIconError(
			`Use a square icon up to ${MAX_ICON_SIDE} × ${MAX_ICON_SIDE} pixels`,
		);
	}
	const db = organizationDb ?? managedFeltDb();
	const next: StoredIcon = { id: ICON_ID, base64: Buffer.from(bytes).toString("base64") };
	await db.transaction((tx) => {
		tx.collection<StoredIcon>(COLLECTION).set(ICON_ID, next,
			icon && Number.isSafeInteger(icon.__version) ? { ifVersion: icon.__version } : { requireAbsent: true });
	}, { transactionId: `opensession:organization-icon:save:${crypto.randomUUID()}` });
	icon = { ...next, __version: (icon?.__version ?? 0) + 1 };
}

export async function removeOrganizationIcon(): Promise<void> {
	if (!icon || !Number.isSafeInteger(icon.__version)) return;
	const db = organizationDb ?? managedFeltDb();
	await db.transaction((tx) => {
		tx.collection<StoredIcon>(COLLECTION).delete(ICON_ID, { ifVersion: icon!.__version });
	}, { transactionId: `opensession:organization-icon:remove:${crypto.randomUUID()}` });
	icon = undefined;
}
