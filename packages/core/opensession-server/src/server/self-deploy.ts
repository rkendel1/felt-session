/**
 * opensession-self-deploy — agent-callable self-deploy of THIS Open Session
 * instance. One action tool (deploy_self) plus a read tool (deploy_status).
 *
 * The tool itself only pre-validates and LAUNCHES: the actual
 * fetch → ff-only merge → restart → health-gate → (opt-in) rollback sequence
 * lives in deploy/self-deploy.sh, spawned as a transient SYSTEM unit via the
 * root-owned validating runtime helper so it
 * survives the service restart it triggers — any of that logic living in this
 * process would die mid-deploy. Results land as JSON in the deploy state dir
 * (~/.opensession-deploy by default), which deploy_status reads back.
 *
 * Trust model: interactive-only + isAdmin, wired EXCLUSIVELY through
 * interactiveMcpServers (src/server/interactive-mcp.ts) like its siblings.
 * Automation runs never receive it — runSessionPrompt hands automations only
 * the papercuts server, and the run-rpc fallback builder fails closed for
 * automation-owned sessions — because a restart (and a git deploy) is a
 * control surface that untrusted event/ticket text must never reach.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { userInfo } from "os";
import { resolve as resolvePath } from "path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { RUN_HOST_HELPER } from "../executor/host-unit";
import { homeDir, stateDir } from "./paths";
import { isDevInstance } from "./dev-mode";

const REPO_ROOT = resolvePath(import.meta.dir, "../../../../..");

/** The checkout self-deploy operates on. Defaults to this running checkout;
 *  OPENSESSION_DEPLOY_CHECKOUT points it at a dedicated deploy-only checkout
 *  under the future split model (same env the script reads). */
export function deployCheckout(): string {
	return process.env.OPENSESSION_DEPLOY_CHECKOUT || REPO_ROOT;
}

/** Where the script keeps its pin/marker/result/log files. Must match the
 *  script's OPENSESSION_DEPLOY_STATE default. */
export function deployStateDir(): string {
	return process.env.OPENSESSION_DEPLOY_STATE || stateDir("deploy");
}

/** Shape written by deploy/self-deploy.sh's write_result — keep in sync. */
export interface SelfDeployResult {
	ok: boolean;
	action: "deploy" | "rollback" | "rollback-needed" | string;
	sha?: string;
	previousSha?: string;
	target?: string;
	startedAt?: string;
	finishedAt?: string;
	durationSecs?: number;
	message?: string;
}

/** Parse a result JSON written by the script; null on garbage (a half-written
 *  or foreign file must degrade to "no result", not throw). */
export function parseDeployResult(raw: string): SelfDeployResult | null {
	try {
		const v = JSON.parse(raw);
		if (!v || typeof v !== "object") return null;
		if (typeof v.ok !== "boolean" || typeof v.action !== "string") return null;
		return v as SelfDeployResult;
	} catch {
		return null;
	}
}

/** Age of the last-deploy-marker (epoch seconds as text) in ms; null when the
 *  content isn't a plain epoch (missing/corrupt marker = no deploy window). */
export function markerAgeMs(markerContent: string, nowMs: number = Date.now()): number | null {
	const trimmed = markerContent.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return nowMs - Number(trimmed) * 1000;
}

export interface DeployState {
	pin: string | null;
	markerAgeMs: number | null;
	result: SelfDeployResult | null;
}

/** Read the script's state files (best-effort — every file is optional). */
export function readDeployState(stateDir: string = deployStateDir(), nowMs: number = Date.now()): DeployState {
	const readText = (p: string): string | null => {
		try {
			return readFileSync(p, "utf-8");
		} catch {
			return null;
		}
	};
	const marker = readText(`${stateDir}/last-deploy-marker`);
	const resultRaw = readText(`${stateDir}/last-result.json`);
	return {
		pin: readText(`${stateDir}/last-known-good`)?.trim() || null,
		markerAgeMs: marker === null ? null : markerAgeMs(marker, nowMs),
		result: resultRaw === null ? null : parseDeployResult(resultRaw),
	};
}

/** Human-readable deploy_status body. */
export function formatDeployStatus(state: DeployState, stateDir: string = deployStateDir()): string {
	const lines: string[] = [];
	const r = state.result;
	if (!r) {
		lines.push(`No self-deploy result recorded yet (state dir: ${stateDir}).`);
	} else {
		lines.push(
			`Last self-deploy: ${r.ok ? "OK" : "FAILED"} (${r.action})` +
				(r.sha ? ` — now at ${r.sha.slice(0, 10)}` : ""),
		);
		if (r.message) lines.push(`  ${r.message}`);
		if (r.finishedAt) lines.push(`  finished ${r.finishedAt} (took ${r.durationSecs ?? "?"}s, target ${r.target ?? "?"})`);
		if (!r.ok && r.action === "rollback-needed" && r.previousSha)
			lines.push(`  ACTION NEEDED: roll back to pin ${r.previousSha.slice(0, 10)} manually.`);
	}
	lines.push(
		state.pin
			? `Last-known-good pin: ${state.pin.slice(0, 10)}`
			: "Last-known-good pin: none recorded",
	);
	if (state.markerAgeMs !== null && state.markerAgeMs >= 0) {
		const mins = Math.round(state.markerAgeMs / 60000);
		lines.push(`Watchdog window: OPEN (last deploy restart ~${mins} min ago; auto-rollback armed for 15 min)`);
	} else {
		lines.push("Watchdog window: closed (no recent self-deploy restart)");
	}
	lines.push(`Log: ${stateDir}/self-deploy.log`);
	return lines.join("\n");
}

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: out.trim(), err: err.trim() };
}

/**
 * Launch deploy/self-deploy.sh as a transient SYSTEM unit via the root-owned
 * fixed helper. A system unit (not
 * a --user scope) because the sequence must outlive opensession.service's
 * restart AND not depend on the user manager surviving it.
 */
async function launchDeployUnit(unit: string, targetSha: string): Promise<void> {
	const checkout = deployCheckout();
	const stateDir = deployStateDir();
	mkdirSync(stateDir, { recursive: true });
	if (!existsSync(RUN_HOST_HELPER) && userInfo().uid === 0) {
		throw new Error("legacy self-deploy refuses to launch from a root service");
	}
	const args = existsSync(RUN_HOST_HELPER)
		? ["sudo", "-n", RUN_HOST_HELPER, "self-deploy", unit, targetSha]
		: [
				// Migration path for instances upgrading through the old in-product
				// deploy flow. Those boxes already grant this exact capability; a
				// subsequent `opensession service install` replaces it with the helper.
				"sudo", "-n", "systemd-run", "--collect", "--quiet",
				`--unit=${unit}`,
				`--description=Open Session self-deploy to ${targetSha.slice(0, 10)}`,
				`--uid=${userInfo().username}`,
				`--gid=${userInfo().username}`,
				"-p", `WorkingDirectory=${checkout}`,
				"-p", `Environment=HOME=${homeDir()}`,
				"-p", `Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
				"-p", `Environment=OPENSESSION_BUN_BIN=${process.execPath}`,
				"-p", `Environment=OPENSESSION_DEPLOY_CHECKOUT=${checkout}`,
				"-p", `Environment=OPENSESSION_DEPLOY_STATE=${stateDir}`,
				...(process.env.OPENSESSION_STATE_DIR
					? ["-p", `Environment=OPENSESSION_STATE_DIR=${process.env.OPENSESSION_STATE_DIR}`]
					: []),
				...(process.env.OPENSESSION_SESSIONS_DIR
					? ["-p", `Environment=OPENSESSION_SESSIONS_DIR=${process.env.OPENSESSION_SESSIONS_DIR}`]
					: []),
				...(process.env.OPENSESSION_DEPLOY_ALLOW_RESET === "1"
					? ["-p", "Environment=OPENSESSION_DEPLOY_ALLOW_RESET=1"]
					: []),
				...(process.env.OPENSESSION_HEALTH_URL
					? ["-p", `Environment=OPENSESSION_HEALTH_URL=${process.env.OPENSESSION_HEALTH_URL}`]
					: []),
				"-p", "StandardOutput=journal",
				"-p", "StandardError=journal",
				"/bin/bash", `${checkout}/deploy/self-deploy.sh`, "--sha", targetSha,
			];
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) {
		throw new Error(`self-deploy launcher exited ${code}: ${err.trim().slice(0, 400)}`);
	}
}

export interface SelfDeployToolContext {
	/** Who asked — recorded in the launch acknowledgement only. */
	user?: string;
}

export function createSelfDeployMcpServer(ctx: SelfDeployToolContext) {
	const tools = [
		tool(
			"deploy_self",
			"Deploy THIS Open Session instance to a git sha and RESTART THE LIVE SERVER. Fetches origin, fast-forwards the deploy checkout (ff-only — aborts on a dirty/diverged tree), restarts opensession.service, health-gates the restart, and auto-records a last-known-good pin for rollback. The restart is graceful: detached engine turns survive and sessions reattach, but the UI blips. Requires confirm: true.",
			{
				sha: z
					.string()
					.optional()
					.describe(
						"Target commit-ish to deploy (sha, branch, origin/main…). Default: origin/main after a fetch. Must be a fast-forward of the current HEAD.",
					),
				confirm: z
					.boolean()
					.describe(
						"Must be exactly true. This restarts the live Open Session instance for everyone — confirm deliberately, never as a default.",
					),
			},
			async (args: { sha?: string; confirm: boolean }) => {
				if (isDevInstance()) {
					// Belt-and-braces behind the interactive-mcp.ts wiring gate: the
					// script targets the production service + deploy state, so a dev
					// instance must never execute it even if the server got wired in.
					return text(
						"Refusing: this is a dev instance (OPENSESSION_DEV=1); deploy_self targets the production service and is disabled here.",
					);
				}
				if (args.confirm !== true) {
					return text(
						"Refusing: deploy_self restarts the live Open Session instance. Call again with confirm: true once you actually mean to deploy.",
					);
				}
				const checkout = deployCheckout();
				const script = `${checkout}/deploy/self-deploy.sh`;
				if (!existsSync(script)) {
					return text(`Refusing: ${script} not found — is the deploy checkout at ${checkout}?`);
				}
				try {
					const fetch = await git(checkout, ["fetch", "--prune", "origin"]);
					if (fetch.code !== 0) {
						return text(`Refusing: git fetch failed in ${checkout}: ${fetch.err.slice(0, 300)}`);
					}
					const targetRef = args.sha?.trim() || "origin/main";
					const rev = await git(checkout, ["rev-parse", `${targetRef}^{commit}`]);
					if (rev.code !== 0) {
						return text(`Refusing: cannot resolve '${targetRef}': ${rev.err.slice(0, 300)}`);
					}
					const targetSha = rev.out;
					const head = (await git(checkout, ["rev-parse", "HEAD"])).out;
					// Cheap pre-validation only — the script re-checks with the
					// authoritative ff-only merge (which also catches dirty trees).
					if (targetSha !== head) {
						const anc = await git(checkout, ["merge-base", "--is-ancestor", head, targetSha]);
						if (anc.code !== 0) {
							return text(
								`Refusing: ${targetRef} (${targetSha.slice(0, 10)}) is not fast-forwardable from HEAD (${head.slice(0, 10)}) — the checkout has local commits or the target is on another line of history. The deploy script would abort; reconcile the checkout first.`,
							);
						}
					}
					const unit = `opensession-self-deploy-${Date.now()}`;
					await launchDeployUnit(unit, targetSha);
					const stateDir = deployStateDir();
					return text(
						`Deploy launched${ctx.user ? ` by ${ctx.user}` : ""}: unit ${unit} → ${targetSha.slice(0, 10)}${targetSha === head ? " (same sha as HEAD — restart only)" : ""}.\n` +
							`Result will land in ${stateDir}/last-result.json (log: ${stateDir}/self-deploy.log).\n` +
							`This instance will RESTART shortly — your session survives via the detached engine + reattach. Check deploy_status in a couple of minutes; if the deploy is unhealthy the unit rolls back per its clean-tree + OPENSESSION_DEPLOY_ALLOW_RESET rules, and the watchdog covers wedges for 15 min.`,
					);
				} catch (e: any) {
					return text(`deploy_self failed to launch: ${e?.message || String(e)}`);
				}
			},
		),
		tool(
			"deploy_status",
			"Read the most recent self-deploy result, the last-known-good pin, and whether the watchdog auto-rollback window is open. Read-only.",
			{},
			async () => {
				try {
					const stateDir = deployStateDir();
					return text(formatDeployStatus(readDeployState(stateDir), stateDir));
				} catch (e: any) {
					return text(`deploy_status failed: ${e?.message || String(e)}`);
				}
			},
		),
	];

	return createSdkMcpServer({ name: "opensession-self-deploy", version: "1.0.0", tools });
}
