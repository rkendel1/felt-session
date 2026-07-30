#!/usr/bin/env bun
/**
 * `os` — the OpenSession terminal client.
 *
 * A client and nothing else: HTTP + one WebSocket per watched session. It never
 * imports the server, never spawns an agent, never touches a worktree. That's
 * what keeps the compiled binary small enough to drop on a laptop and what makes
 * `os --host os.tella.dev` the whole setup story.
 *
 * Subcommands stay deliberately few (login/logout/whoami/sessions/help) —
 * everything else is the TUI.
 */

import { Api, ApiError } from "./client/api";
import { pollDeviceFlow, startDeviceFlow } from "./client/auth";
import { normalizeHost, readConfig, resolve, writeConfig } from "./client/config";
import { WatchPool } from "./client/pool";
import { SessionsPoller } from "./client/sessions-poller";
import { sessionStatus, sessionTitle } from "./client/types";

const VERSION = "0.1.0";

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]!;
	if (arg.startsWith("--")) {
		const [name, inline] = arg.slice(2).split("=", 2);
		if (inline !== undefined) {
			flags.set(name!, inline);
		} else if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
			flags.set(name!, argv[++i]!);
		} else {
			flags.set(name!, true);
		}
	} else if (arg.startsWith("-") && arg.length > 1) {
		flags.set(arg.slice(1), true);
	} else {
		positional.push(arg);
	}
}

const hostFlag = typeof flags.get("host") === "string" ? (flags.get("host") as string) : undefined;

function usage(): void {
	console.log(`
os — OpenSession in your terminal (v${VERSION})

  os                        open the TUI against the configured server
  os --host os.tella.dev    …against a specific server (and remember it)
  os <session-id>           open the TUI focused on one session

  os login                  sign in (GitHub device flow)
  os logout                 forget this box's token
  os whoami                 who am I, and where
  os sessions               one-shot list, no TUI (scripts, ssh one-liners)
  os help · os version

Keys inside: ^b ? shows them all. tmux muscle memory works —
ctrl+←/→ switches tabs, ^b c starts a session, ^b d detaches.
`);
}

async function login(): Promise<number> {
	const { host } = await resolve(hostFlag);
	console.log(`Signing in to ${host}…`);
	const start = await startDeviceFlow(host);
	if ("status" in start) {
		if (start.status === "not-required") {
			await writeConfig({ host });
			console.log("This server has no sign-in gate — nothing to do. Host saved.");
			return 0;
		}
		console.error(`✗ ${start.error}`);
		return 1;
	}
	console.log(`\n  Open ${start.verificationUri}`);
	console.log(`  Enter code: ${start.userCode}\n`);
	const result = await pollDeviceFlow(host, start, {
		onPending: () => process.stdout.write("."),
	});
	process.stdout.write("\n");
	if (result.status !== "ok") {
		console.error(`✗ ${result.status === "error" ? result.error : "sign-in failed"}`);
		return 1;
	}
	await writeConfig({ host, token: result.token, login: result.login, user: result.name });
	console.log(`✓ Signed in as @${result.login}`);
	return 0;
}

async function logout(): Promise<number> {
	const { host, token } = await resolve(hostFlag);
	if (token) {
		// Best-effort server-side revoke before dropping the local copy.
		await new Api(host, token).logout().catch(() => {});
	}
	await writeConfig({ token: undefined, login: undefined });
	console.log("✓ Token removed");
	return 0;
}

async function whoami(): Promise<number> {
	const { host, token, user } = await resolve(hostFlag);
	console.log(`host   ${host}`);
	console.log(`user   ${user}`);
	console.log(`token  ${token ? "present" : "none"}`);
	const api = new Api(host, token);
	try {
		const status = await api.authStatus();
		console.log(
			`server ${status.authenticated ? `authenticated as @${status.login}` : "no sign-in gate"}`,
		);
	} catch (e) {
		console.log(`server ${e instanceof ApiError ? e.message : String(e)}`);
		return 1;
	}
	return 0;
}

async function listSessions(): Promise<number> {
	const { host, token } = await resolve(hostFlag);
	const api = new Api(host, token);
	try {
		const sessions = (await api.sessions()).filter((s) => !s.archived && !s.sideChatOf);
		if (!sessions.length) {
			console.log("No sessions.");
			return 0;
		}
		for (const session of sessions) {
			const status = sessionStatus(session);
			const glyph =
				status === "waiting" ? "?" : status === "running" ? "*" : status === "error" ? "!" : " ";
			console.log(
				`${glyph} ${session.id.slice(0, 12).padEnd(13)} ${sessionTitle(session).slice(0, 48).padEnd(49)} ${session.repo ?? ""}`,
			);
		}
		return 0;
	} catch (e) {
		const error = e instanceof ApiError ? e : new ApiError(0, String(e));
		console.error(`✗ ${error.message}`);
		if (error.needsAuth) console.error("  run `os login` first");
		return 1;
	}
}

async function tui(): Promise<number> {
	const { host, token, user, config } = await resolve(hostFlag);

	// Remember an explicitly passed host so the next `os` needs no flag. Changing
	// hosts drops a token minted for the old one (resolve() already refuses to
	// send it across hosts).
	if (hostFlag && normalizeHost(hostFlag) !== normalizeHost(config.host ?? "")) {
		await writeConfig({ host, token: undefined, login: undefined });
	} else if (!config.host) {
		await writeConfig({ host });
	}

	const api = new Api(host, token);
	if (!(await api.reachable())) {
		console.error(`✗ Can't reach ${host}`);
		console.error("  Is the server up, and are you on its network (tailnet/VPN)?");
		return 1;
	}
	try {
		await api.sessions();
	} catch (e) {
		if (e instanceof ApiError && e.needsAuth) {
			console.error(`✗ ${host} requires sign-in — run \`os login\``);
			return 1;
		}
		throw e;
	}

	// Imported here, not at the top: the renderer pulls in a native module, and
	// `os login` / `os sessions` / `--help` must work on a box where that fails.
	const { createCliRenderer } = await import("@opentui/core");
	const { createRoot } = await import("@opentui/react");
	const { App } = await import("./ui/app");
	const { createElement } = await import("react");

	const poller = new SessionsPoller(api);
	const pool = new WatchPool({ host, token });
	void poller.start();

	const renderer = await createCliRenderer({
		exitOnCtrlC: false, // ctrl+c is a session-level interrupt here, not quit
		targetFps: 30,
		// Without the kitty keyboard protocol a terminal cannot express
		// ctrl+enter at all — it arrives as a bare CR, indistinguishable from
		// enter, so "steer" would be unreachable. Terminals that don't speak it
		// ignore the request, and alt+enter still works there.
		useKittyKeyboard: { allKeysAsEscapes: true },
	});
	const root = createRoot(renderer);

	let exiting = false;
	const shutdown = () => {
		if (exiting) return;
		exiting = true;
		poller.stop();
		pool.closeAll();
		root.unmount();
		renderer.destroy();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	root.render(
		createElement(App, {
			api,
			poller,
			pool,
			host,
			user,
			prefix: config.prefix,
			onExit: shutdown,
			initialSessionId: positional[0],
		}),
	);
	// The renderer owns the process from here.
	return new Promise<number>(() => {});
}

async function main(): Promise<number> {
	const command = positional[0];
	if (flags.has("help") || flags.has("h") || command === "help") {
		usage();
		return 0;
	}
	if (flags.has("version") || flags.has("v") || command === "version") {
		console.log(VERSION);
		return 0;
	}
	switch (command) {
		case "login":
			return login();
		case "logout":
			return logout();
		case "whoami":
			return whoami();
		case "sessions":
		case "ls":
			return listSessions();
		default:
			// No subcommand (or a bare session id) → the TUI.
			return tui();
	}
}

main()
	.then((code) => {
		if (code !== 0) process.exit(code);
	})
	.catch((e) => {
		console.error(`✗ ${e?.message ?? e}`);
		process.exit(1);
	});
