/**
 * Where `os` keeps its host + token.
 *
 * `~/.opensession/tui.json`, mode 0600, next to the `node.json` that
 * scripts/lib/connect.ts writes for execution nodes. Same directory on purpose:
 * one place to look for "credentials this box holds for an OpenSession server".
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENSESSION_HOME = join(homedir(), ".opensession");
export const TUI_CONFIG_PATH = join(OPENSESSION_HOME, "tui.json");

export type TuiConfig = {
	host?: string;
	token?: string;
	/** GitHub login the token was minted for; display only. */
	login?: string;
	/** Display name attached to prompts on servers with no auth gate. */
	user?: string;
	/** tmux prefix key name, e.g. "b" for ctrl+b. */
	prefix?: string;
};

const DEFAULT_HOST = "http://127.0.0.1:3850";

/**
 * Accept what people actually type: `os.company.dev`, `os.company.dev/`,
 * `https://os.company.dev`, `localhost:3850`. Bare hosts get https, except
 * loopback/`.local`, which never has a cert.
 */
export function normalizeHost(raw: string): string {
	let host = raw.trim();
	while (host.endsWith("/")) host = host.slice(0, -1);
	if (!host) return DEFAULT_HOST;
	if (!host.includes("://")) {
		const loopback =
			/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host) ||
			host.endsWith(".local");
		host = `${loopback ? "http" : "https"}://${host}`;
	}
	return host;
}

/** ws(s) URL for the UI WebSocket — same host, `/ws`. */
export function wsUrl(host: string): string {
	return `${host.replace(/^http/, "ws")}/ws`;
}

export async function readConfig(): Promise<TuiConfig> {
	if (!existsSync(TUI_CONFIG_PATH)) return {};
	try {
		const parsed = JSON.parse(await Bun.file(TUI_CONFIG_PATH).text());
		return typeof parsed === "object" && parsed ? (parsed as TuiConfig) : {};
	} catch {
		// A corrupt config must not brick the binary — `os --host …` still works.
		return {};
	}
}

export async function writeConfig(patch: TuiConfig): Promise<TuiConfig> {
	const merged = { ...(await readConfig()), ...patch };
	mkdirSync(OPENSESSION_HOME, { recursive: true });
	await Bun.write(TUI_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
	try {
		chmodSync(TUI_CONFIG_PATH, 0o600);
	} catch {}
	return merged;
}

export type Resolved = { host: string; token?: string; user: string; config: TuiConfig };

/**
 * Host resolution order: `--host` flag → OPENSESSION_HOST → config → loopback.
 * The token is only read from the config (and OPENSESSION_TOKEN for dev runs) —
 * never from a flag, so it can't land in shell history or a process list.
 */
export async function resolve(hostFlag?: string): Promise<Resolved> {
	const config = await readConfig();
	const host = normalizeHost(
		hostFlag || process.env.OPENSESSION_HOST || config.host || DEFAULT_HOST,
	);
	// A token minted for a different host is worse than none: it would be sent
	// to a server it doesn't belong to. Only reuse it when the host matches.
	const sameHost = !config.host || normalizeHost(config.host) === host;
	return {
		host,
		token: process.env.OPENSESSION_TOKEN || (sameHost ? config.token : undefined),
		user: config.user || process.env.USER || "tui",
		config,
	};
}
