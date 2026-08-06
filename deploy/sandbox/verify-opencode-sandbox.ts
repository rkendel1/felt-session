/**
 * OpenCode-in-sandbox verify (octest): proves the opencode engine runs INSIDE
 * a docker sandbox end-to-end, the same way verify.ts proves the claude path.
 *
 *   bun run deploy/sandbox/verify-opencode-sandbox.ts
 *
 * What it exercises (all against the REAL DockerProvider + opensession-runner
 * image — rebuild the image after changing opencode-runner/host.ts, the
 * container runs the BAKED src, not this checkout):
 *
 *  1. Container mounts: the host ~/.claude/projects/-opencode-engine dir
 *     (persisted opencode transcripts, host-visible) and the ro
 *     ~/.opensession-opencode.json bridge config are mounted.
 *  2. Binary resolution: `opencode` resolves in-container (baked at
 *     /usr/bin/opencode; resolveOpencodeBin's Bun.which finds it via PATH).
 *  3. A REAL two-turn opencode/anthropic run (meridian bridge, haiku) through
 *     sandbox.launchRun: codeword stored on turn 1, recalled on turn 2 —
 *     proving the second run resumes the same opencode session in-container.
 *  4. The run journal carries sandboxId bks-sbx-* while the run is live.
 *  5. `opencode serve` runs INSIDE the container during the turn, never on
 *     the host — and the run-host reaps it at exit (no orphan accumulation).
 *  6. The persisted JSONL transcript is host-visible with both turns.
 *  7. opencode_meridian_run start/end audit events land in the shared
 *     host audit log (the rw audit-dir mount, `stateDir("audit")`).
 *  8. destroy() tears everything down.
 *
 * Costs two claude-haiku turns on the meridian bridge (subscription quota);
 * skipped (dry-run) when the account pool or bridge config is absent/disabled.
 * Uses octest-* sessions + scratch journal/config — never touches live state
 * except the shared audit log and the octest transcript file (removed after).
 */

const SCRATCH = `${process.env.HOME || homedir()}/.octest-verify-scratch`;
// Before any src/server import (journal + sandbox config resolve at load).
process.env.OPENSESSION_RUN_JOURNAL = `${SCRATCH}/active-runs.json`;
process.env.OPENSESSION_SANDBOX_CONFIG = `${SCRATCH}/sandbox-config.json`;

import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";

const { DockerProvider, containerNameFor } = await import("../../src/server/sandbox/docker");
const { OPENCODE_TRANSCRIPTS_DIR, getOpencodeTranscriptPath } = await import(
  "../../src/server/opencode-transcript"
);
const { readOpencodeBridgeConfig } = await import("../../src/server/opencode-config");
const { OPENSESSION_SESSIONS_DIR } = await import("../../src/server/paths");
const { stateDir, statePath } = await import("../../src/server/paths");
type RunHostSpec = import("../../src/runner-host/protocol").RunHostSpec;
type StreamEvent = import("../../src/server/run-events").StreamEvent;

const HOME = process.env.HOME || homedir();
const SESSION_ID = `octest-${Date.now().toString(36)}`;
const CONTAINER = containerNameFor(SESSION_ID);
const MAIN = `${SCRATCH}/main-repo`;
const WT = `${SCRATCH}/wt-octest`;
const MODEL = "opencode/anthropic/claude-haiku-4-5";
const CODEWORD = "PLUM-TANGO-42";

mkdirSync(SCRATCH, { recursive: true });
await Bun.write(process.env.OPENSESSION_SANDBOX_CONFIG!, JSON.stringify({ provider: "docker" }));

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sh(cmd: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

/** In-container `opencode serve` process count (no procps in the image). */
async function containerOpencodeServes(): Promise<number> {
  // [s]erve: the bracket trick keeps this probe's own cmdline from matching.
  const r = await sh(["docker", "exec", CONTAINER, "sh", "-c",
    `for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$f" 2>/dev/null; echo; done | grep -c 'opencode.* [s]erve' || true`]);
  return parseInt(r.out.trim(), 10) || 0;
}

/** Host-NATIVE `opencode serve` count. Container processes share the host
 *  kernel and show up in the host process table — exclude docker cgroups so
 *  the in-container server doesn't read as a host spawn. */
async function hostOpencodeServes(): Promise<number> {
  const r = await sh(["sh", "-c",
    `for pid in $(pgrep -f 'opencode.* [s]erve'); do grep -q docker /proc/$pid/cgroup 2>/dev/null || echo $pid; done | wc -l`]);
  return parseInt(r.out.trim(), 10) || 0;
}

let ocSessionId = "";

async function cleanup(): Promise<void> {
  console.log("\n── cleanup ──");
  await sh(["docker", "rm", "-f", CONTAINER]);
  await sh(["docker", "volume", "rm", "-f", `${CONTAINER}-claude`, `${CONTAINER}-codex`, `${CONTAINER}-ws`]);
  try {
    rmSync(`${OPENSESSION_SESSIONS_DIR}/sandboxes/${CONTAINER}.json`, { force: true });
    rmSync(`${OPENSESSION_SESSIONS_DIR}/sandbox-runs/${SESSION_ID}`, { recursive: true, force: true });
    // The octest transcript lands in the REAL -opencode-engine dir (that's the
    // point — host visibility); remove only our file.
    if (ocSessionId) rmSync(getOpencodeTranscriptPath(ocSessionId), { force: true });
    const munged = `-${WT.replaceAll("/", "-").replace(/^-/, "")}`;
    rmSync(`${HOME}/.claude/projects/${munged}`, { recursive: true, force: true });
  } catch {}
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log("  removed container, volumes, state, scratch, octest transcript");
}

// ── scratch repo + worktree (bind mode) ──────────────────────────────────────
console.log("── setup: scratch repo + worktree ──");
for (const p of [MAIN, WT]) rmSync(p, { recursive: true, force: true });
mkdirSync(MAIN, { recursive: true });
for (const c of [
  ["git", "init", "-q", "-b", "main"],
  ["git", "config", "user.email", "octest@opensession.local"],
  ["git", "config", "user.name", "Opencode Sandbox Verify"],
]) await sh(c, MAIN);
await Bun.write(`${MAIN}/README.md`, "octest scratch repo\n");
await sh(["git", "add", "README.md"], MAIN);
await sh(["git", "commit", "-q", "-m", "init"], MAIN);
const wtAdd = await sh(["git", "worktree", "add", "-q", WT, "-b", "octest-branch"], MAIN);
ok("scratch worktree created", wtAdd.code === 0 && existsSync(`${WT}/.git`), WT);

const provider = new DockerProvider();

try {
  // ── ensure + mount assertions ─────────────────────────────────────────────
  console.log("\n── ensure / mounts ──");
  const sandbox = await provider.ensure({ sessionId: SESSION_ID, cwd: WT });
  ok("ensure() created + started container", sandbox.id === CONTAINER, sandbox.id);
  const mounts = await sh(["docker", "inspect", "-f",
    "{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}\n{{end}}", CONTAINER]);
  ok("opencode transcripts dir mounted rw",
    mounts.out.includes(`${OPENCODE_TRANSCRIPTS_DIR} -> ${OPENCODE_TRANSCRIPTS_DIR} rw=true`),
    OPENCODE_TRANSCRIPTS_DIR);
  ok("opencode bridge config mounted ro",
    mounts.out.includes(`-> ${HOME}/.opensession-opencode.json rw=false`));

  // ── binary resolution in-container ────────────────────────────────────────
  const ver = await sandbox.exec(["opencode", "--version"]);
  ok("opencode binary resolves in-container", ver.exitCode === 0, ver.stdout.trim() || ver.stderr.trim());

  // ── live two-turn run (gated on accounts + bridge config) ─────────────────
  const accountsPath =
    process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH ||
    statePath(".opensession-claude-accounts.json");
  let hasAccounts = false;
  try {
    const store = JSON.parse(readFileSync(accountsPath, "utf-8"));
    hasAccounts = Array.isArray(store.accounts) && store.accounts.length > 0;
  } catch {}
  const bridge = readOpencodeBridgeConfig();
  if (!hasAccounts || bridge?.bridgeMode !== "meridian") {
    console.log(`  (dry-run: accounts=${hasAccounts} bridgeMode=${bridge?.bridgeMode} — skipping live runs)`);
  } else {
    console.log("\n── opencode run 1 (store codeword) ──");
    const hostServesBefore = await hostOpencodeServes();
    let inContainerDuring = 0;
    let hostServesDuring = -1;

    const runTurn = async (
      prompt: string,
      engineSessionId: string | undefined,
      probeMidRun: boolean,
    ): Promise<{ result: StreamEvent | null; text: string; init: string }> => {
      const spec: RunHostSpec = {
        hostId: `rh-octest-${Date.now().toString(36)}`,
        osSessionId: SESSION_ID,
        prompt,
        engineSessionId,
        cwd: WT,
        mode: "ask",
        model: MODEL,
        mcpServers: [],
        journalKind: "prompt", // opencode gate: interactive kinds only
      };
      const handle = sandbox.launchRun(spec, {});
      let text = "";
      let init = "";
      const consume = (async () => {
        for await (const ev of handle.events()) {
          if (ev.type === "init" && ev.sessionId) {
            init = ev.sessionId;
            if (probeMidRun) {
              // (a) journal names the sandbox while the run is live
              let journaled: any;
              try {
                const journal = JSON.parse(readFileSync(process.env.OPENSESSION_RUN_JOURNAL!, "utf-8"));
                journaled = Object.values(journal).find((r: any) => r?.osSessionId === SESSION_ID);
              } catch {}
              ok("journal shows the run in bks-sbx-*",
                journaled?.sandboxId === CONTAINER && journaled?.model === MODEL,
                `sandboxId=${journaled?.sandboxId} model=${journaled?.model}`);
              // (b) opencode serve runs INSIDE the container, not on the host
              inContainerDuring = await containerOpencodeServes();
              hostServesDuring = await hostOpencodeServes();
            }
          }
          if (ev.type === "text_chunk") text += ev.text || "";
          if (ev.type === "done" || ev.type === "error") return ev;
        }
        return null;
      })();
      const result = await Promise.race([
        consume,
        new Promise<null>((r) => setTimeout(() => r(null), 300_000)),
      ]);
      if (!result) handle.cancel();
      return { result, text, init };
    };

    const t1 = await runTurn(
      `Remember this codeword: ${CODEWORD}. Reply with exactly: STORED`,
      undefined,
      true,
    );
    ocSessionId = t1.init;
    ok("run 1 emitted init with an opencode session id", t1.init.startsWith("ses_"), t1.init);
    ok("run 1 finished with done", t1.result?.type === "done",
      t1.result ? `${t1.result.type}: ${(t1.result.result || t1.result.content || "").slice(0, 120)}` : "timed out");
    ok("opencode serve ran inside the container", inContainerDuring > 0, `count=${inContainerDuring}`);
    ok("no opencode serve spawned on the host",
      hostServesDuring >= 0 && hostServesDuring <= hostServesBefore,
      `before=${hostServesBefore} during=${hostServesDuring}`);

    console.log("\n── opencode run 2 (recall codeword — session resume) ──");
    const t2 = await runTurn(
      "What is the codeword I gave you earlier? Reply with just the codeword.",
      ocSessionId,
      false,
    );
    ok("run 2 resumed the same opencode session", t2.init === ocSessionId, t2.init);
    ok("run 2 recalled the codeword",
      t2.text.includes(CODEWORD) || (t2.result?.result || "").includes(CODEWORD),
      JSON.stringify((t2.text || t2.result?.result || "").slice(0, 120)));

    // (c) host-visible transcript with BOTH turns (what a fresh WS watch tails)
    console.log("\n── host-visible transcript ──");
    const tPath = getOpencodeTranscriptPath(ocSessionId);
    ok("persisted JSONL exists host-side", existsSync(tPath), tPath);
    const jsonl = existsSync(tPath) ? readFileSync(tPath, "utf-8") : "";
    ok("transcript has turn-1 prompt + reply",
      jsonl.includes(CODEWORD) && /STORED/.test(jsonl));
    ok("transcript has turn-2 prompt",
      jsonl.includes("What is the codeword"));

    // (d) meridian audit events in the shared host audit log
    const auditPath = `${stateDir("audit")}/audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf-8") : "";
    const lines = audit.split("\n").filter((l) => l.includes("opencode_meridian_run") && l.includes(SESSION_ID));
    ok("audit has opencode_meridian_run start events", lines.some((l) => l.includes('"phase":"start"')),
      `${lines.length} events`);
    ok("audit has opencode_meridian_run end events", lines.some((l) => l.includes('"phase":"end"')));

    // run-host reaps its opencode serve at exit (allow the shutdown grace)
    let after = -1;
    for (let i = 0; i < 30; i++) {
      after = await containerOpencodeServes();
      if (after === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    ok("in-container opencode serve reaped after the runs", after === 0, `count=${after}`);
  }

  // ── (e) destroy ───────────────────────────────────────────────────────────
  console.log("\n── destroy ──");
  await provider.destroy(CONTAINER);
  ok("container removed", (await sh(["docker", "inspect", CONTAINER])).code !== 0);
  ok("volumes removed", (await sh(["docker", "volume", "inspect", `${CONTAINER}-claude`])).code !== 0);
  ok("transcripts dir survives destroy (shared, host-owned)", existsSync(OPENCODE_TRANSCRIPTS_DIR));
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed${fail ? `: ${failures.join("; ")}` : ""}`);
process.exit(fail ? 1 : 0);
