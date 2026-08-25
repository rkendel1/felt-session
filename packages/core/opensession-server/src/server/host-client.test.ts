import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  HostHandle,
  localRunHostsSupported,
  reconcileUncertainHostEvents,
  resolveInactiveHostRecovery,
  type HostLauncher,
} from "./host-client";
import type { RunHostMeta, RunHostSpec } from "../runner-host/protocol";
import {
  TranscriptStore,
  __setTranscriptStoreForTest,
} from "./transcript-store";
import { transcriptLineUser } from "./transcript-persistence";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  sessionKernelStore,
} from "./session-kernel";
import { hostRunBusy } from "./host-registry";
import {
  __setActiveRunsPathForTest,
  takeInterruptedRuns,
  type ActiveRunRecord,
} from "./run-journal";

const roots: string[] = [];

function registerTestRun(sessionId: string, runId: string): void {
  const store = sessionKernelStore();
  const prior = store.runState(sessionId);
  store.setRunState({
    sessionId,
    state: "running",
    event: "run_registered",
    currentRunId: runId,
    generation: prior.currentRunId === runId ? prior.generation : prior.generation + 1,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHandle(spec: RunHostSpec) {
  const root = mkdtempSync(join(tmpdir(), "host-client-test-"));
  roots.push(root);
  const dir = join(root, spec.hostId);
  mkdirSync(dir);
  const launcher: HostLauncher = {
    alive: () => true,
    newRunDir: (hostId) => join(root, hostId),
    launch: async () => {},
  };
  return new HostHandle(dir, spec, {}, launcher);
}

describe("uncertain host reconciliation", () => {
  test("delivers an offline terminal result before destructive stop", async () => {
    let preserved = false;
    const fake = {
      ended: false,
      connectWithWait: async () => { throw new Error("not connectable"); },
      events: async function* () {},
      executionEvidence: async () => ({
        started: true,
        done: { type: "done", result: "offline complete" },
      }),
      stopAndWait: async (_timeout: number, preserve: boolean) => {
        preserved = preserve;
        fake.ended = true;
        return true;
      },
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "offline complete",
    });
    expect((await events.next()).done).toBe(true);
    expect(preserved).toBe(true);
  });

  test("re-reads terminal evidence after stop settlement", async () => {
    let reads = 0;
    const fake = {
      ended: false,
      connectWithWait: async () => { throw new Error("not connectable"); },
      events: async function* () {},
      executionEvidence: async () =>
        ++reads === 1
          ? { started: true }
          : { started: true, done: { type: "done", result: "finished while stopping" } },
      stopAndWait: async () => true,
      takeObservedTerminal: () => undefined,
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "finished while stopping",
    });
    expect((await events.next()).done).toBe(true);
  });

  test("prefers a terminal observed live while stop is settling", async () => {
    let terminal: any;
    const fake = {
      ended: false,
      connectWithWait: async () => { throw new Error("not connectable"); },
      events: async function* () {},
      executionEvidence: async () => ({ started: false }),
      stopAndWait: async () => {
        terminal = { type: "done", result: "live finish" };
        return true;
      },
      takeObservedTerminal: () => {
        const value = terminal;
        terminal = undefined;
        return value;
      },
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "live finish",
    });
    expect((await events.next()).done).toBe(true);
  });

  test("retained uncertainty is a nonterminal notice", async () => {
    const fake = {
      ended: false,
      connectWithWait: async () => { throw new Error("not connectable"); },
      events: async function* () {},
      executionEvidence: async () => ({ started: false }),
      stopAndWait: async () => false,
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({ type: "runner_notice" });
    fake.ended = true;
    expect((await events.next()).done).toBe(true);
  });
});

describe("local run-host capability", () => {
  test("requires Linux, a booted systemd, systemctl, and sudo", () => {
    const commands = (command: string) =>
      ["systemctl", "sudo"].includes(command) ? `/usr/bin/${command}` : null;
    expect(localRunHostsSupported("linux", true, commands)).toBe(true);
    expect(localRunHostsSupported("darwin", true, commands)).toBe(false);
    expect(localRunHostsSupported("linux", false, commands)).toBe(false);
    expect(localRunHostsSupported("linux", true, () => null)).toBe(false);
  });

  test("keeps a fresh host out of the boot recovery claim", () => {
    const hostId = `rh-${crypto.randomUUID()}`;
    const osSessionId = `os-${crypto.randomUUID()}`;
    const spec: RunHostSpec = {
      hostId,
      osSessionId,
      prompt: "run once",
      cwd: "/tmp",
    };
    const handle = makeHandle(spec);
    const journalRoot = mkdtempSync(join(tmpdir(), "host-claim-test-"));
    roots.push(journalRoot);
    const journalPath = join(journalRoot, "active-runs.json");
    const previousJournal = __setActiveRunsPathForTest(journalPath);
    const record: ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId,
      prompt: spec.prompt,
      cwd: spec.cwd,
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    writeFileSync(journalPath, JSON.stringify({ [hostId]: record }));

    try {
      expect(hostRunBusy(hostId)).toBe(true);
      expect(takeInterruptedRuns()).toEqual([]);
    } finally {
      handle.abandon();
      __setActiveRunsPathForTest(previousJournal);
    }
  });
});

describe("inactive local host recovery", () => {
  test("does not replay execution evidence without an engine session", () => {
    expect(
      resolveInactiveHostRecovery(
        {
          hostId: "rh-test",
          pid: 123,
          osSessionId: "session-test",
          startedAt: new Date().toISOString(),
        },
        null,
      ),
    ).toEqual({ kind: "uncertain" });
  });

  test("recovers an engine session from metadata or the private journal", () => {
    expect(
      resolveInactiveHostRecovery(
        {
          hostId: "rh-test",
          pid: 123,
          osSessionId: "session-test",
          startedAt: new Date().toISOString(),
          engineSessionId: "engine-meta",
        },
        null,
      ),
    ).toEqual({ kind: "resume", engineSessionId: "engine-meta" });
    expect(
      resolveInactiveHostRecovery(null, {
        runKey: "run-1",
        osSessionId: "session-1",
        claudeSessionId: "engine-journal",
        cwd: "/tmp",
        kind: "prompt",
        startedAt: new Date().toISOString(),
      }),
    ).toEqual({ kind: "resume", engineSessionId: "engine-journal" });
  });

  test("allows replay only when no execution evidence exists", () => {
    expect(resolveInactiveHostRecovery(null, null)).toEqual({ kind: "replay" });
  });
});

function hello(spec: RunHostSpec, selectedModel: string) {
  return {
    t: "hello" as const,
    hostId: spec.hostId,
    pid: 1,
    osSessionId: spec.osSessionId,
    state: "running" as const,
    pendingAsks: [],
    selectedModel,
    effectiveModel: selectedModel,
    transientFallback: false,
  };
}

describe("HostHandle model recovery", () => {
	test("waits for the host to confirm an exact steer retraction", async () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-retract-test-"));
		roots.push(root);
		const dir = join(root, "rh-retract");
		mkdirSync(dir);
		const sent: any[] = [];
		let handlers: { onMsg(msg: any): void; onClose(): void } | undefined;
		const launcher: HostLauncher = {
			alive: () => true,
			newRunDir: (hostId) => join(root, hostId),
			launch: async () => {},
			connector: () => ({
				connect: async (nextHandlers) => {
					handlers = nextHandlers;
					return {
						send: (message) => {
							sent.push(message);
							return true;
						},
						close: () => {},
					};
				},
			}),
		};
		const spec: RunHostSpec = {
			hostId: "rh-retract",
			osSessionId: "os-retract",
			prompt: "keep working",
			cwd: "/tmp",
			model: "pi/anthropic/claude-sonnet-5",
		};
		const handle = new HostHandle(dir, spec, {}, launcher);
		await handle.connectWithWait(100);

		const retraction = (handle as any).ctl.retractSteer("steer-2");
		const request = sent.find((message) => message.t === "retract_steer");
		expect(request).toMatchObject({ t: "retract_steer", steerId: "steer-2" });
		handlers!.onMsg({
			t: "steer_retracted",
			requestId: request.requestId,
			steerId: "steer-2",
			retracted: true,
		});
		expect(await retraction).toBe(true);
		(handle as any).finish();
	});

	test("acknowledges a terminal event so the detached host can exit", async () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-terminal-test-"));
		roots.push(root);
		const dir = join(root, "rh-terminal");
		mkdirSync(dir);
		const sent: unknown[] = [];
		let handlers: { onMsg(msg: any): void; onClose(): void } | undefined;
		const launcher: HostLauncher = {
			alive: () => true,
			newRunDir: (hostId) => join(root, hostId),
			launch: async () => {},
			connector: () => ({
				connect: async (nextHandlers) => {
					handlers = nextHandlers;
					return {
						send: (message) => {
							sent.push(message);
							return true;
						},
						close: () => {},
					};
				},
			}),
		};
		const spec: RunHostSpec = {
			hostId: "rh-terminal",
			osSessionId: "os-terminal",
			prompt: "finish once",
			cwd: "/tmp",
		};
		const handle = new HostHandle(dir, spec, {}, launcher);
		await handle.connectWithWait(100);
		const events = handle.events();
		handlers!.onMsg({
			t: "event",
			event: { type: "done", result: "PI_SURVIVED_RESTART" },
		});
		handlers!.onMsg({
			t: "end",
			done: { type: "done", result: "PI_SURVIVED_RESTART" },
		});

		expect((await events.next()).value).toMatchObject({
			type: "done",
			result: "PI_SURVIVED_RESTART",
		});
		expect((await events.next()).done).toBe(true);
		expect(sent).toContainEqual({ t: "shutdown" });
		expect(handle.ended).toBe(true);
	});

	test("applies proxied transcript frames in the server store", () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-transcript-test-"));
		roots.push(root);
		const store = new TranscriptStore(join(root, "transcripts.db"));
		const previous = __setTranscriptStoreForTest(store);
		const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
		const previousKernel = __setSessionKernelStoreForTest(kernelStore);
		const spec: RunHostSpec = {
			hostId: "rh-transcript",
			osSessionId: "os-transcript",
			prompt: "test",
			cwd: "/tmp",
		};
		registerTestRun(spec.osSessionId, spec.hostId);
		const handle = makeHandle(spec);
		try {
			(handle as any).handleMsg({
				t: "transcript",
				engineSessionId: spec.osSessionId,
				lines: [transcriptLineUser("hello", "prompt-1")],
			});

			expect(store.readTail(spec.osSessionId, 10).entries).toMatchObject([
				{ id: "prompt-1", type: "user", content: "hello" },
			]);
		} finally {
			(handle as any).finish();
			__setTranscriptStoreForTest(previous);
			__setSessionKernelStoreForTest(previousKernel);
			kernelStore.close();
		}
	});

	test("applies transcript frames after the run settled (reattach backfill)", () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-settled-transcript-test-"));
		roots.push(root);
		const store = new TranscriptStore(join(root, "transcripts.db"));
		const previous = __setTranscriptStoreForTest(store);
		const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
		const previousKernel = __setSessionKernelStoreForTest(kernelStore);
		const spec: RunHostSpec = {
			hostId: "rh-settled",
			osSessionId: "os-settled-transcript",
			prompt: "test",
			cwd: "/tmp",
		};
		registerTestRun(spec.osSessionId, spec.hostId);
		// The restart/settle race: the run goes idle BEFORE the host's
		// reattach hello replays its transcript history (2026-08-21
		// os-01a02469 — the turn's closing summary was lost this way).
		kernelStore.setRunState({ sessionId: spec.osSessionId, state: "idle", event: "turn_end" });
		const handle = makeHandle(spec);
		try {
			(handle as any).handleMsg({
				t: "transcript",
				engineSessionId: spec.osSessionId,
				lines: [transcriptLineUser("late summary", "prompt-late")],
			});
			expect(store.readTail(spec.osSessionId, 10).entries).toMatchObject([
				{ id: "prompt-late", type: "user", content: "late summary" },
			]);
		} finally {
			(handle as any).finish();
			__setTranscriptStoreForTest(previous);
			__setSessionKernelStoreForTest(previousKernel);
			kernelStore.close();
		}
	});

	test("rejects transcript frames while a different live run owns the session", () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-superseded-transcript-test-"));
		roots.push(root);
		const store = new TranscriptStore(join(root, "transcripts.db"));
		const previous = __setTranscriptStoreForTest(store);
		const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
		const previousKernel = __setSessionKernelStoreForTest(kernelStore);
		const spec: RunHostSpec = {
			hostId: "rh-zombie",
			osSessionId: "os-superseded-transcript",
			prompt: "test",
			cwd: "/tmp",
		};
		registerTestRun(spec.osSessionId, "rh-newer");
		const handle = makeHandle(spec);
		try {
			(handle as any).handleMsg({
				t: "transcript",
				engineSessionId: spec.osSessionId,
				lines: [transcriptLineUser("zombie", "prompt-zombie")],
			});
			expect(store.readTail(spec.osSessionId, 10).entries).toEqual([]);
		} finally {
			(handle as any).finish();
			__setTranscriptStoreForTest(previous);
			__setSessionKernelStoreForTest(previousKernel);
			kernelStore.close();
		}
	});

	test("rejects transcript frames from a stale host generation", () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-stale-transcript-test-"));
		roots.push(root);
		const store = new TranscriptStore(join(root, "transcripts.db"));
		const previous = __setTranscriptStoreForTest(store);
		const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
		const previousKernel = __setSessionKernelStoreForTest(kernelStore);
		const spec: RunHostSpec = {
			hostId: "rh-stale",
			osSessionId: "os-stale-transcript",
			prompt: "test",
			cwd: "/tmp",
		};
		registerTestRun(spec.osSessionId, "rh-current");
		let asks = 0;
		let steerFailures = 0;
		const handle = makeHandle(spec);
		(handle as any).cb = {
			onAskUser: async () => { asks += 1; return null; },
			onSteerFailed: () => { steerFailures += 1; },
		};
		try {
			(handle as any).handleMsg({
				t: "transcript",
				engineSessionId: spec.osSessionId,
				lines: [transcriptLineUser("stale", "prompt-stale")],
			});
			(handle as any).handleMsg({ t: "ask", askId: "stale-ask", input: {} });
			(handle as any).handleMsg({ t: "steer_failed", text: "stale steer" });
			(handle as any).handleMsg({
				t: "event",
				event: { type: "init", sessionId: "engine-stale" },
			});
			(handle as any).handleMsg({
				...hello(spec, "model-a"),
				pendingAsks: [{ askId: "stale-hello-ask", input: {} }],
			});
			expect(store.readTail(spec.osSessionId, 10).entries).toEqual([]);
			expect(asks).toBe(0);
			expect(steerFailures).toBe(0);
			expect((handle as any).engineSessionId).toBeUndefined();
		} finally {
			(handle as any).finish();
			__setTranscriptStoreForTest(previous);
			__setSessionKernelStoreForTest(previousKernel);
			kernelStore.close();
		}
	});

	test("drops an ask answer when ownership changes during the human wait", async () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-ask-generation-test-"));
		roots.push(root);
		const dir = join(root, "rh-ask");
		mkdirSync(dir);
		const sent: any[] = [];
		let handlers: { onMsg(msg: any): void; onClose(): void } | undefined;
		const launcher: HostLauncher = {
			alive: () => true,
			newRunDir: (hostId) => join(root, hostId),
			launch: async () => {},
			connector: () => ({
				connect: async (nextHandlers) => {
					handlers = nextHandlers;
					return { send: (message) => { sent.push(message); return true; }, close: () => {} };
				},
			}),
		};
		const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
		const previousKernel = __setSessionKernelStoreForTest(kernelStore);
		const answer = Promise.withResolvers<any>();
		const spec: RunHostSpec = {
			hostId: "rh-ask",
			osSessionId: "os-ask-generation",
			prompt: "test",
			cwd: "/tmp",
		};
		registerTestRun(spec.osSessionId, spec.hostId);
		const handle = new HostHandle(
			dir,
			spec,
			{ onAskUser: () => answer.promise },
			launcher,
		);
		try {
			await handle.connectWithWait(100);
			handlers!.onMsg({ t: "ask", askId: "ask-1", input: {} });
			registerTestRun(spec.osSessionId, "rh-successor");
			answer.resolve({ behavior: "allow", updatedInput: {} });
			await Bun.sleep(0);
			expect(sent.some((message) => message.t === "ask_answer")).toBe(false);
		} finally {
			(handle as any).finish();
			__setSessionKernelStoreForTest(previousKernel);
			kernelStore.close();
		}
	});

  test("reconciles unix reconnects without duplicating reported switches", async () => {
    const spec: RunHostSpec = {
      hostId: "rh-test",
      osSessionId: "bks-test",
      prompt: "test",
      cwd: "/tmp",
      model: "model-a",
      selectedModel: "model-a",
    };
    const kernelRoot = mkdtempSync(join(tmpdir(), "host-client-reconnect-kernel-"));
    roots.push(kernelRoot);
    const kernelStore = new SessionKernelStore(join(kernelRoot, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = makeHandle(spec);
    const events = handle.events();

    (handle as any).handleMsg(hello(spec, "model-a"));
    (handle as any).handleMsg({
      t: "event",
      event: {
        type: "model_switch",
        fromModel: "model-a",
        toModel: "model-b",
        switchReason: "out of credits",
        temporaryFallback: false,
      },
    });
    (handle as any).handleMsg(hello(spec, "model-b"));
    (handle as any).handleMsg(hello(spec, "model-c"));
    (handle as any).handleMsg({ t: "event", event: { type: "done", result: "ok" } });

    expect((await events.next()).value?.toModel).toBe("model-b");
    expect((await events.next()).value?.toModel).toBe("model-c");
    expect((await events.next()).value?.type).toBe("done");
    (handle as any).finish();
    __setSessionKernelStoreForTest(previousKernel);
    kernelStore.close();
  });

  test("hard-stops a host whose cooperative cancel never settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-cancel-test-"));
    roots.push(root);
    const dir = join(root, "rh-cancel");
    mkdirSync(dir);
    const sent: any[] = [];
    let stopped = 0;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (hostId) => join(root, hostId),
      launch: async () => {},
      stop: async () => { stopped += 1; },
      connector: () => ({
        connect: async () => ({
          send: (message) => { sent.push(message); return true; },
          close: () => {},
        }),
      }),
    };
    const spec: RunHostSpec = {
      hostId: "rh-cancel",
      osSessionId: "os-cancel",
      prompt: "test",
      cwd: "/tmp",
    };
    const handle = new HostHandle(dir, spec, {}, launcher, spec.hostId, 1);

    await handle.connectWithWait(100);
    expect(handle.requestCancel()).toBe(true);
    await Bun.sleep(10);

    expect(sent.map((message) => message.t)).toEqual(["cancel", "shutdown"]);
    expect(stopped).toBe(1);
    expect(handle.ended).toBe(true);
  });

  test("respawns with the host's latest fallback state", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-respawn-test-"));
    roots.push(root);
    const oldDir = join(root, "rh-old");
    mkdirSync(oldDir);
    const spec: RunHostSpec = {
      hostId: "rh-old",
      osSessionId: "bks-test",
      prompt: "test",
      cwd: "/tmp",
      model: "model-a",
      selectedModel: "model-a",
    };
    let writtenSpec: RunHostSpec | undefined;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (hostId) => join(root, hostId),
      writeSpec: async (_dir, nextSpec) => {
        writtenSpec = nextSpec;
      },
      launch: async () => {},
      connector: (_dir, nextSpec) => ({
        connect: async (handlers) => {
          handlers.onMsg(hello(nextSpec, nextSpec.selectedModel!));
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const transcriptStore = new TranscriptStore(join(root, "transcripts.db"));
    const previousTranscript = __setTranscriptStoreForTest(transcriptStore);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = new HostHandle(oldDir, spec, {}, launcher);
    const meta: RunHostMeta = {
      hostId: spec.hostId,
      pid: 1,
      osSessionId: spec.osSessionId,
      startedAt: new Date().toISOString(),
      selectedModel: "model-b",
      effectiveModel: "model-c",
      transientFallback: true,
    };

    await (handle as any).respawn("engine-1", meta);

    expect(writtenSpec?.selectedModel).toBe("model-b");
    expect(writtenSpec?.model).toBe("model-c");
    expect(writtenSpec?.transientFallback).toBe(true);
    (handle as any).handleMsg({
      t: "transcript",
      engineSessionId: spec.osSessionId,
      lines: [transcriptLineUser("after respawn", "prompt-respawn")],
    });
    expect(transcriptStore.readTail(spec.osSessionId, 10).entries).toMatchObject([
      { id: "prompt-respawn", content: "after respawn" },
    ]);
    (handle as any).finish();
    __setTranscriptStoreForTest(previousTranscript);
    __setSessionKernelStoreForTest(previousKernel);
    kernelStore.close();
  });
});
