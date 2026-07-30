/**
 * Sign-in for a terminal client: the GitHub **device flow**, which is the one
 * OAuth shape that works when the client has no browser of its own.
 *
 * `POST /api/auth/device` → show the user code → poll
 * `POST /api/auth/device/poll` with `native: true`, which returns the session
 * token in the body (the HttpOnly cookie is useless to us). Same path the iOS
 * app takes. Servers with the gate off answer 400 "Sign-in is not enabled",
 * which we report as "no sign-in needed" rather than an error.
 */

import { Api, ApiError } from "./api";

export type DeviceStart = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	interval: number;
};

export type LoginResult =
	| { status: "ok"; token: string; login: string; name?: string }
	| { status: "not-required" }
	| { status: "error"; error: string };

export async function startDeviceFlow(
	host: string,
	fetcher = fetch,
): Promise<DeviceStart | { status: "not-required" } | { status: "error"; error: string }> {
	let response: Response;
	try {
		response = await fetcher(`${host}/api/auth/device`, { method: "POST" });
	} catch (e) {
		return { status: "error", error: `${host} unreachable: ${(e as Error).message}` };
	}
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		if (/not enabled/i.test(String(body.error ?? ""))) return { status: "not-required" };
		return { status: "error", error: String(body.error ?? response.statusText) };
	}
	return {
		deviceCode: String(body.deviceCode ?? ""),
		userCode: String(body.userCode ?? ""),
		verificationUri: String(body.verificationUri ?? "https://github.com/login/device"),
		interval: typeof body.interval === "number" ? body.interval : 5,
	};
}

/**
 * Poll until the person finishes in their browser. `interval` is the server's
 * advice; `slow_down` bumps it, per the device-flow spec.
 */
export async function pollDeviceFlow(
	host: string,
	start: DeviceStart,
	opts: {
		fetcher?: Fetcher;
		sleep?: (ms: number) => Promise<void>;
		timeoutMs?: number;
		onPending?: () => void;
	} = {},
): Promise<LoginResult> {
	const fetcher = opts.fetcher ?? fetch;
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
	let interval = Math.max(1, start.interval);

	while (Date.now() < deadline) {
		await sleep(interval * 1000);
		let body: Record<string, unknown>;
		try {
			const response = await fetcher(`${host}/api/auth/device/poll`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deviceCode: start.deviceCode, native: true }),
			});
			body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		} catch (e) {
			// Transient network blip mid-flow: keep polling, the code is still valid.
			opts.onPending?.();
			continue;
		}
		const status = String(body.status ?? "");
		if (status === "ok") {
			const token = typeof body.token === "string" ? body.token : "";
			if (!token) {
				return {
					status: "error",
					error: "server authorized the code but returned no token",
				};
			}
			return {
				status: "ok",
				token,
				login: String(body.login ?? ""),
				name: typeof body.name === "string" ? body.name : undefined,
			};
		}
		if (status === "slow_down") {
			interval = typeof body.interval === "number" ? body.interval : interval + 5;
			continue;
		}
		if (status === "error" || body.error) {
			return { status: "error", error: String(body.error ?? "device flow failed") };
		}
		opts.onPending?.();
	}
	return { status: "error", error: "timed out waiting for authorization" };
}

type Fetcher = typeof fetch;

/** Does this host need a token we don't have? */
export async function needsLogin(api: Api): Promise<boolean> {
	try {
		await api.sessions();
		return false;
	} catch (e) {
		return e instanceof ApiError && e.needsAuth;
	}
}
