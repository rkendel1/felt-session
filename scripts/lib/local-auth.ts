import { createFeltDB } from "@feltdb/core";
import { existsSync, readFileSync } from "node:fs";
import { managedFeltDbConfig } from "../../packages/core/opensession-server/src/server/managed-feltdb";
import { ENV_PATH } from "./paths";

interface StoredWebSession {
	token: string;
	login: string;
	name: string;
	lastSeenAt: number;
	kind?: "automation";
}

export function selectManagedWebSessionToken(
	sessions: StoredWebSession[],
	opts: { login?: string; automation?: boolean },
	now = Date.now(),
): string | null {
	const match = sessions
		.filter((session) => now - session.lastSeenAt <= 90 * 24 * 60 * 60 * 1000)
		.filter((session) => opts.automation ? session.kind === "automation" : session.login === opts.login)
		.sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
	return match?.token || null;
}

function serviceEnvironment(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	if (!existsSync(ENV_PATH)) return env;
	for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
		const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (!match || env[match[1]!]) continue;
		let value = match[2]!.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
			value = value.slice(1, -1);
		env[match[1]!] = value;
	}
	return env;
}

/** Read a server-local web identity directly from the sole managed authority. */
export async function managedWebSessionToken(opts: {
	login?: string;
	automation?: boolean;
}): Promise<string | null> {
	const config = managedFeltDbConfig(serviceEnvironment());
	const db = createFeltDB({
		namespace: config.namespace,
		server: { url: config.url, token: config.apiKey },
	});
	const sessions = await db.collection<StoredWebSession>("opensession_web_sessions").all();
	return selectManagedWebSessionToken(sessions, opts);
}

/** Machine identity for server-local CLI/CDP work. Never borrows a human row. */
export async function localAutomationToken(): Promise<string | null> {
	return managedWebSessionToken({ automation: true });
}
