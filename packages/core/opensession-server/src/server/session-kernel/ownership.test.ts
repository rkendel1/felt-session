import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const serverDir = resolve(import.meta.dir, "..");
const read = (relative: string) => readFileSync(join(serverDir, relative), "utf8");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
	}
	return out;
}

describe("single session ownership", () => {
	test("run, queue, ask and session-file state delegate to SessionKernel", () => {
		expect(read("run-state.ts")).toContain("sessionKernel(sessionId)");
		expect(read("queue-state.ts")).toContain("new SessionOwnedMap");
		expect(read("queue-state.ts")).toContain("new SessionOwnedSet");
		expect(read("asks.ts")).toContain("new SessionOwnedMap");
		expect(read("session-cache.ts")).toContain(
			'runExclusive("session_file_updated"',
		);
	});

	test("run-state decisions execute atomically inside the actor", () => {
		const facade = read("run-state.ts");
		const actor = read("session-kernel/actor-worker.ts");
		expect(facade).toContain(".applyRunEvent({");
		expect(actor).toContain('request.t === "decide_run_event"');
		expect(actor).toContain("store.applyRunEvent(request.decision)");
		expect(read("session-kernel/run-state-machine.ts")).toContain(
			"export function nextRunState",
		);
	});

	test("every transcript mutation enters the session owner", () => {
		const source = read("transcript-store.ts");
		for (const operation of [
			"transcript_append",
			"transcript_import",
			"transcript_replace",
			"transcript_delete",
		]) {
			expect(source).toContain(`applySync("${operation}"`);
		}
	});

	test("all shared prompt delivery uses the durable command mailbox", () => {
		const control = read("session-control-wiring.ts");
		expect(control).toContain('type: "submit_prompt"');
		expect(control).toContain("sessionKernel(id).dispatch");
		expect(read("routes/sessions.ts")).not.toContain("promptReceipt(");
		expect(existsSync(join(serverDir, "prompt-receipts.ts"))).toBe(false);
	});

	test("no server module writes session JSON outside the owner facade", () => {
		const offenders: string[] = [];
		for (const path of sourceFiles(serverDir)) {
			const relative = path.slice(serverDir.length + 1);
			if (relative === "session-cache.ts") continue;
			const source = readFileSync(path, "utf8");
			if (
				/writeJsonAtomic\(`\$\{(?:OPENSESSION_)?SESSIONS_DIR\}/.test(source) ||
        /writeFileSync\(`\$\{(?:OPENSESSION_)?SESSIONS_DIR\}/.test(source)
			) {
				offenders.push(relative);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the gateway boots an IPC actor before hydrating session projections", () => {
		const entry = read("../../opensession.ts");
		expect(entry.indexOf("await startSessionKernelActor()")).toBeLessThan(
			entry.indexOf("initHumanAsks()"),
		);
		const actor = read("session-kernel/actor-worker.ts");
		expect(actor).toContain("const store = new SessionKernelStore()");
		expect(read("session-kernel/actor-client.ts")).toContain(
			"SharedArrayBuffer",
		);
	});

	test("Slack ask delivery is a durable production outbox effect", () => {
		const source = read("human-asks.ts");
		expect(source).toContain(
			'registerSessionEffectHandler("human_ask_deliver"',
		);
		expect(source).toContain('"human_ask_deliver",');
		expect(source.match(/deliverAsk\(/g)?.length).toBe(2);
	});

	test("create and cancel retries keep stable ownership targets", () => {
		const ws = read("ws-handlers.ts");
		expect(ws).toContain('"create_session",');
		expect(ws).toContain("sessionIdForRequest");
		expect(ws).toContain('typeof msg.sessionId === "string"');
		const routes = read("routes/sessions.ts");
		expect(routes).toContain('type: "create_session"');
		expect(routes).toContain("id: targetId");
		expect(read("../../../protocol/src/session.ts")).toContain(
			'type: "cancel"; sessionId?: string; requestId?: string',
		);
	});

	test("interrupted creates resume their environment setup, not only their prompt", () => {
		const create = read("session-create.ts");
		expect(create).toContain("const recoveringSession = findSession(bksId)");
		expect(create).toContain("fromPr\n\t\t\t\t\t\t\t? createWorktreeForExistingBranch");
		expect(create.indexOf("openingPromptEntryId = beginPromptDispatch"))
			.toBeLessThan(create.indexOf("await persist()"));
		expect(create).not.toContain("if (requeuePromptDispatch(bksId))");
		const routes = read("routes/sessions.ts");
		expect(routes).not.toContain("requeuePromptDispatch(targetId)");
	});

	test("create plans and MCP controls retain stable request identity", () => {
		const wiring = read("session-control-wiring.ts");
		expect(wiring).toContain("updateCreatePlan(bksId, createIdentity)");
		expect(wiring).toContain("createPlan.resolved");
		const create = read("session-create.ts");
		expect(create).toContain("createPlan.resolved");
		expect(create).toContain("spec.openingPromptEntryId");
		expect(wiring).toContain('type: "cancel_session"');
		expect(wiring).toContain('type: "answer_question"');
		const tools = read("../agents/slack/sessions-tools.ts");
		expect(tools).toContain("durableToolRequestId");
		expect(tools).toContain('durableToolRequestId(ctx, "create_session", extra)');
		const native = readFileSync(
			resolve(serverDir, "../../../../clients/ios/OS1/Networking/SessionCreateIntent.swift"),
			"utf8",
		);
		expect(native).toContain('identityBody.removeValue(forKey: "requestId")');
	});

	test("unresolved client and automation intents are never silently replaced", () => {
		const web = read("../frontend/lib/ws-command-outbox.ts");
		expect(web).not.toContain("RETENTION_MS");
		expect(web).not.toContain("MAX_ITEMS");
		const chrome = readFileSync(
			resolve(serverDir, "../../../../clients/chrome/sidepanel.js"),
			"utf8",
		);
		expect(chrome).toContain("version: 3, id");
		const workflow = read("workflow-runner.ts");
		expect(workflow).toContain("`workflow:${snap.runId}:${snap.status}`");
	});

	test("durable client replay is negotiated before commands are resent", () => {
		expect(read("ws-handlers.ts")).toContain("capabilities: { commandResults: true }");
		const hook = read("../frontend/hooks/useWebSocket.ts");
		expect(hook).toContain("commandResultsRef.current = false");
		expect(hook).toContain("msg.capabilities?.commandResults === true");
	});

	test("taking back a steer is receipt-idempotent on every client", () => {
		expect(read("ws-handlers.ts")).toContain('"take_steered_prompt",');
		expect(read("../frontend/lib/ws-request-id.ts")).toContain(
			'"take_steered_prompt",',
		);
		const native = readFileSync(
			resolve(serverDir, "../../../../clients/ios/OS1/Networking/SocketMutationOutbox.swift"),
			"utf8",
		);
		expect(native).toContain('"take_steered_prompt",');
	});

	test("run-targeting retries and deletion cannot cross generations", () => {
		const ws = read("ws-handlers.ts");
		expect(ws).toContain("const targetRunId =");
		expect(ws).toContain("The run targeted by this command has already changed");
		expect(ws).toContain("sessionId: commandSessionId");
		expect(ws).toContain('`stop-${msg.requestId}`');
		const routes = read("routes/sessions.ts");
		expect(routes).toContain("await cancelAgentRunAndWait(runIds)");
		expect(routes).toContain('.runExclusive(\n\t\t\t"delete_session"');
	});

	test("create and sandbox recovery establish one execution owner", () => {
		const queue = read("queue-state.ts");
		expect(queue).toContain('kind?: "create"');
		expect(read("run-session.ts")).toContain("resumePlannedCreate(sessionId)");
		for (const relative of [
			"sandbox/docker.ts",
			"sandbox/adapters/bootstrap.ts",
		]) {
			const source = read(relative);
			const eager = source.indexOf("launchRunEager");
			const record = source.indexOf("journalSet(record);", eager);
			const specWrite = relative === "sandbox/docker.ts"
				? source.indexOf("writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec)", eager)
				: source.indexOf("launcher.writeSpec!(dir, spec)", eager);
			const launch = source.indexOf("launcher.launch", record);
			const launching = source.indexOf('record.launchPhase = "launching"', launch);
			const connect = source.indexOf("new HostHandle", launching);
			const dispatchCallback = source.indexOf("onDispatching?.()");
			const processDispatch = relative === "sandbox/docker.ts"
				? source.indexOf("await docker(args)", dispatchCallback)
				: source.indexOf("driver.execBackground(", dispatchCallback);
			expect(specWrite).toBeGreaterThan(0);
			expect(specWrite).toBeLessThan(record);
			expect(record).toBeGreaterThan(0);
			expect(record).toBeLessThan(launch);
			expect(launch).toBeLessThan(launching);
			expect(launching).toBeLessThan(connect);
			expect(dispatchCallback).toBeGreaterThan(0);
			expect(dispatchCallback).toBeLessThan(processDispatch);
			expect(source).toContain("decideSandboxHostRecovery");
			expect(source).toContain("uncertainLaunch");
			expect(source).toContain("reconcileUncertainHostEvents");
			expect(source).not.toContain("pgrep -f");
			expect(source).toContain("evidence(dir)");
			if (relative.includes("bootstrap"))
				expect(source).toContain("if (!dispatchAttempted) unregisterRunWsHost(hostId)");
			expect(source).toContain('recovery.kind === "replay"');
			expect(source).toContain("...(oldSpec as RunHostSpec)");
		}
	});

	test("opening runs settle session-file writes before continuing", () => {
		const create = read("session-create.ts");
		const writes = create
			.split("\n")
			.filter((line) => line.includes("touchNativeSession("));
		expect(writes.length).toBeGreaterThan(0);
		for (const line of writes) expect(line).toContain("await touchNativeSession(");

		const cache = read("session-cache.ts");
		const outcome = cache.indexOf("if (errorMessage) {");
		const transcript = cache.indexOf("persistRunFailureNotice(", outcome);
		const sessionFile = cache.indexOf("void touchNativeSession(id", outcome);
		expect(transcript).toBeGreaterThan(outcome);
		expect(sessionFile).toBeGreaterThan(transcript);
	});

	test("WebSocket session mutations enter the mailbox before dispatch", () => {
		const source = read("ws-handlers.ts");
		expect(source).toContain("kernelCommands.has(msg.type)");
		expect(source).toContain("kernelDispatchTokens.delete");
		expect(source).toContain("__sessionKernelToken");
		expect(source).not.toContain("__sessionKernelOwned");
		expect(source).toContain('source: "websocket"');
	});
});
