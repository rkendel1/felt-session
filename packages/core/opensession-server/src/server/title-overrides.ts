/**
 * Manual display titles for sessions of ALL sources. Slack/Linear session files
 * are owned by their agents (read-only for opensession) and opensession titles are
 * derived at scan time, so a user rename can't live in the session file. It
 * lives in a server-owned registry keyed by unified session id, applied over
 * the derived title in getAllSessions — exactly like the archive registry.
 */
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { ManagedValueRegistry } from "./managed-value-registry";
import type { StateFirstDB } from "@feltdb/core";

const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/title-overrides.json`;
const registry = new ManagedValueRegistry<string>(
	"opensession_title_overrides",
	"title-overrides-json-to-managed-feltdb-v1",
	REGISTRY_PATH,
);

export function initializeManagedTitleOverrides(db?: StateFirstDB): Promise<void> {
	return registry.initialize(db);
}

export function getTitleOverride(id: string): string | undefined {
	return registry.get(id);
}

/** Set (non-empty) or clear (empty/null) the manual title for a session id. */
export async function setTitleOverride(id: string, title: string | null): Promise<void> {
	const trimmed = title?.trim();
	await registry.set(id, trimmed || undefined);
}
