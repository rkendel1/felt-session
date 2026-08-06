/**
 * Certify the "brain on host, hands in sandbox" boundary through the real
 * Open Session WebSocket/session path.
 *
 * Examples:
 *   bun run deploy/sandbox/verify-external-engine.ts --provider microvm
 *   bun run deploy/sandbox/verify-external-engine.ts --provider daytona --provider modal
 *   bun run deploy/sandbox/verify-external-engine.ts --provider microvm --restart
 *
 * The suite creates one disposable code session per provider, requires all six
 * opensession-workspace tools, verifies the files only exist in the sandbox,
 * optionally restarts Open Session and proves a second turn keeps the same
 * boundary after model fallback, then deletes the session and provider
 * resource in a finally block.
 *
 * This intentionally targets a LIVE Open Session instance. It never commits,
 * pushes, or opens a PR. Branches use `sbxtest/external-*` and workspace test
 * files use `.opensession-boundary-*`; both are unique per run.
 */

import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getSandboxProvider } from "../../src/server/sandbox";
import {
  isRunnableSandboxProvider,
  sandboxEnginePlacement,
  sandboxModelFamilyFor,
  sandboxModelSupport,
  sandboxProviderConfigured,
  type RunnableSandboxProviderId,
} from "../../src/server/sandbox/config";
import type { Sandbox } from "../../src/server/sandbox/provider";
import { OPENSESSION_SESSIONS_DIR } from "../../src/server/paths";

const HOME = process.env.HOME || homedir();
const DEFAULT_SERVER = "http://127.0.0.1:3850";
// This suite certifies the sandbox boundary, not model-specific tool-calling.
// Keep the default on a model that reliably emits OpenCode tool calls; use
// --model when deliberately certifying another provider/model combination.
const DEFAULT_MODEL = "opencode/openai/gpt-5.6-sol";
const DEFAULT_REPO = "opensession";
const REQUIRED_TOOLS = [
  "opensession-workspace_execute",
  "opensession-workspace_write_file",
  "opensession-workspace_read_file",
  "opensession-workspace_edit_file",
  "opensession-workspace_grep",
  "opensession-workspace_glob",
] as const;

interface Options {
  providers: RunnableSandboxProviderId[];
  model: string;
  repo: string;
  user?: string;
  server: string;
  restart: boolean;
  keep: boolean;
  timeoutMs: number;
  service: string;
}

interface WebSession {
  token?: string;
  login?: string;
  name?: string;
  lastSeenAt?: string;
}

interface TurnResult {
  sessionId: string;
  tools: Set<string>;
  text: string;
  errors: string[];
}

interface SessionFile {
  id: string;
  model?: string;
  branch?: string;
  worktreeDir?: string;
  sandbox?: {
    provider?: string;
    sandboxId?: string;
    workspace?: string;
    engine?: string;
  };
}

function usage(): never {
  console.log(`Usage:
  bun run deploy/sandbox/verify-external-engine.ts --provider <id> [options]

Options:
  --provider <id>   Repeat for microvm/daytona/e2b/box/modal/lambda-microvm
  --model <id>      Opening OpenCode OpenAI/Claude model (default ${DEFAULT_MODEL})
  --repo <id>       Registered repo id (default ${DEFAULT_REPO})
  --user <name>     Web-session login/name to use
  --server <url>    Live Open Session base URL (default ${DEFAULT_SERVER})
  --restart         Restart the systemd service between turn one and turn two
  --service <name>  systemd unit for --restart (default opensession)
  --timeout <sec>   Per-turn timeout (default 300)
  --keep            Keep disposable sessions/resources for debugging
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    providers: [],
    model: DEFAULT_MODEL,
    repo: DEFAULT_REPO,
    server: DEFAULT_SERVER,
    restart: false,
    keep: false,
    timeoutMs: 300_000,
    service: "opensession",
  };
  const value = (index: number, flag: string) => {
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      console.error(`${flag} requires a value`);
      usage();
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--provider") {
      const id = value(i, arg);
      if (!isRunnableSandboxProvider(id) || id === "docker") {
        throw new Error(
          `external-engine certification needs a volume-style provider, got "${id}"`,
        );
      }
      opts.providers.push(id);
      i++;
    } else if (arg === "--model") {
      opts.model = value(i, arg);
      i++;
    } else if (arg === "--repo") {
      opts.repo = value(i, arg);
      i++;
    } else if (arg === "--user") {
      opts.user = value(i, arg);
      i++;
    } else if (arg === "--server") {
      opts.server = value(i, arg).replace(/\/+$/, "");
      i++;
    } else if (arg === "--service") {
      opts.service = value(i, arg);
      i++;
    } else if (arg === "--timeout") {
      const seconds = Number(value(i, arg));
      if (!Number.isFinite(seconds) || seconds < 10) {
        throw new Error("--timeout must be at least 10 seconds");
      }
      opts.timeoutMs = seconds * 1000;
      i++;
    } else if (arg === "--restart") {
      opts.restart = true;
    } else if (arg === "--keep") {
      opts.keep = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (!opts.providers.length) {
    throw new Error("pass at least one --provider");
  }
  opts.providers = [...new Set(opts.providers)];
  return opts;
}

function apiUrl(server: string, path: string): string {
  return `${server}${path.startsWith("/") ? path : `/${path}`}`;
}

function wsUrl(server: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  return url.toString();
}

function webSessions(): WebSession[] {
  try {
    const store = JSON.parse(
      readFileSync(
        process.env.OPENSESSION_WEB_SESSIONS_STORE ||
          `${HOME}/.opensession-web-sessions.json`,
        "utf-8",
      ),
    ) as { sessions?: WebSession[] };
    return Array.isArray(store.sessions) ? store.sessions : [];
  } catch {
    return [];
  }
}

function authFor(user?: string): { token?: string; user: string } {
  const envToken = process.env.OPENSESSION_TEST_BEARER;
  const sessions = webSessions().sort(
    (a, b) =>
      Date.parse(b.lastSeenAt || "1970-01-01") -
      Date.parse(a.lastSeenAt || "1970-01-01"),
  );
  const query = user?.toLowerCase();
  const selected =
    (query
      ? sessions.find(
          (entry) =>
            entry.login?.toLowerCase() === query ||
            entry.name?.toLowerCase() === query ||
            entry.name?.split(/\s+/)[0]?.toLowerCase() === query,
        )
      : sessions[0]) || null;
  if (query && !selected && !envToken) {
    throw new Error(
      `no web-auth session found for "${user}" (use a stored login/full name, omit --user for the newest session, or set OPENSESSION_TEST_BEARER)`,
    );
  }
  return {
    token: envToken || selected?.token,
    user: user || selected?.name?.split(" ")[0] || selected?.login || "sbxtest",
  };
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function entryToolName(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const value = entry as Record<string, unknown>;
  for (const key of ["name", "tool", "toolName"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
}

function unwrappedMessage(raw: string): Record<string, any> {
  const outer = JSON.parse(raw) as Record<string, any>;
  return outer.type === "session_feed" && outer.event ? outer.event : outer;
}

function boundaryPrompt(token: string, path: string): string {
  return [
    "Certify the external-engine sandbox boundary.",
    "Use ONLY opensession-workspace tools for every workspace operation. Never use local shell/read/write/edit/grep/glob/patch/apply_patch tools.",
    `1. execute: print pwd and run git status --short.`,
    `2. write_file ${path}/input.txt with exactly:\\ntoken=${token}\\nstate=before\\n`,
    `3. read_file that file.`,
    `4. edit_file: replace the single occurrence state=before with state=after.`,
    `5. grep for ${token} under ${path}.`,
    `6. glob ${path}/**/*.txt.`,
    `7. execute a shell check that the file contains token=${token} and state=after.`,
    `8. read_file the final file.`,
    `Finish with exactly: BOUNDARY_OK ${token}`,
    "Do not commit or push.",
  ].join("\n");
}

async function runTurn(args: {
  opts: Options;
  auth: { token?: string; user: string };
  provider: RunnableSandboxProviderId;
  prompt: string;
  sessionId?: string;
}): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const tools = new Set<string>();
    const errors: string[] = [];
    let text = "";
    let sessionId = args.sessionId || "";
    let turnStarted = false;
    let settled = false;
    const headers = authHeaders(args.auth.token);
    const socket = new WebSocket(
      wsUrl(args.opts.server),
      Object.keys(headers).length ? ({ headers } as any) : undefined,
    );
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve({ sessionId, tools, text, errors });
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `turn timed out after ${args.opts.timeoutMs / 1000}s${
              sessionId ? ` (${sessionId})` : ""
            }`,
          ),
        ),
      args.opts.timeoutMs,
    );
    socket.onerror = (event) =>
      finish(new Error(`WebSocket failed: ${String((event as any)?.message || event)}`));
    socket.onopen = () => {
      if (args.sessionId) {
        socket.send(
          JSON.stringify({
            type: "watch",
            sessionId: args.sessionId,
            user: args.auth.user,
            supportsFeed: true,
          }),
        );
        setTimeout(() => {
          turnStarted = true;
          socket.send(
            JSON.stringify({
              type: "prompt",
              sessionId: args.sessionId,
              content: args.prompt,
              user: args.auth.user,
            }),
          );
        }, 250);
      } else {
        turnStarted = true;
        socket.send(
          JSON.stringify({
            type: "create_session",
            branch: `sbxtest/external-${args.provider}-${Date.now().toString(36)}`,
            prompt: args.prompt,
            user: args.auth.user,
            mode: "code",
            repo: args.opts.repo,
            createWorkspace: {
              name: `Disposable external-engine ${args.provider} certification`,
            },
            model: args.opts.model,
            mcpServers: [],
            sandbox: args.provider,
          }),
        );
      }
    };
    socket.onmessage = (event) => {
      let message: Record<string, any>;
      try {
        message = unwrappedMessage(String(event.data));
      } catch {
        return;
      }
      if (message.type === "session_created" && typeof message.id === "string") {
        sessionId = message.id;
        socket.send(
          JSON.stringify({
            type: "watch",
            sessionId,
            user: args.auth.user,
            supportsFeed: true,
          }),
        );
      } else if (message.type === "stream_tool_use" && turnStarted) {
        const name = entryToolName(message.entry);
        if (name) tools.add(name);
      } else if (message.type === "stream_text" && turnStarted) {
        text += String(message.text || "");
      } else if (message.type === "error" && turnStarted) {
        errors.push(String(message.message || message.content || "unknown error"));
      } else if (message.type === "stream_done" && turnStarted && sessionId) {
        finish();
      }
    };
  });
}

async function readSessionFile(sessionId: string): Promise<SessionFile> {
  const path = join(OPENSESSION_SESSIONS_DIR, `${sessionId}.json`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SessionFile;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`session file did not appear: ${path}`);
}

async function deleteSession(
  opts: Options,
  auth: { token?: string },
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    apiUrl(opts.server, `/api/sessions/${encodeURIComponent(sessionId)}`),
    {
      method: "DELETE",
      headers: authHeaders(auth.token),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `session cleanup failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
}

async function restartService(opts: Options): Promise<void> {
  const process = Bun.spawn(["sudo", "-n", "systemctl", "restart", opts.service], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `restart ${opts.service} failed: ${(stderr || stdout).trim().slice(0, 500)}`,
    );
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(apiUrl(opts.server, "/api/health"));
      if (response.ok && (await response.json() as { ok?: boolean }).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`${opts.service} did not become healthy within 60 seconds`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

async function assertSandboxState(args: {
  providerId: RunnableSandboxProviderId;
  session: SessionFile;
  sandbox: Sandbox;
  token: string;
  relativePath: string;
}): Promise<void> {
  const { providerId, session, sandbox, token, relativePath } = args;
  assert(session.sandbox?.provider === providerId, `session provider is ${providerId}`);
  assert(session.sandbox?.engine === "host", "session engine is recorded on host");
  assert(session.sandbox?.workspace === "volume", "workspace is sandbox-volume style");
  assert(Boolean(session.sandbox?.sandboxId), "session records a sandbox id");
  assert((await sandbox.status()) === "running", "sandbox is running");

  const final = await sandbox.exec(["cat", `${relativePath}/input.txt`]);
  assert(final.exitCode === 0, "boundary file exists inside the sandbox");
  assert(final.stdout.includes(`token=${token}`), "sandbox file contains the unique token");
  assert(final.stdout.includes("state=after"), "sandbox edit persisted");

  const noRunner = await sandbox.exec([
    "sh",
    "-lc",
    "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$f\" 2>/dev/null; echo; done | grep -E 'runner-host|opencode.* [s]erve' | grep -v grep || true",
  ]);
  assert(
    !/runner-host|opencode.* serve/.test(noRunner.stdout),
    "no model runner is executing inside the workspace sandbox",
  );

  const authFiles = await sandbox.exec([
    "sh",
    "-lc",
    "for p in ~/.opensession-claude-accounts.json ~/.opensession-claude-accounts.json ~/.opensession-codex-accounts.json ~/.opensession-codex-accounts.json ~/.codex/auth.json; do test ! -e \"$p\" || echo \"$p\"; done",
  ]);
  assert(
    !authFiles.stdout.trim(),
    "no model-provider account files entered the sandbox",
  );

  if (providerId === "microvm") {
    const workspaceTools = await sandbox.exec([
      "sh",
      "-lc",
      "for c in jq sqlite3 ip git rg bun node python3; do command -v \"$c\" >/dev/null 2>&1 || echo \"$c\"; done",
    ]);
    assert(
      !workspaceTools.stdout.trim(),
      `minimal MicroVM has the practical workspace tool contract${workspaceTools.stdout.trim() ? ` (missing: ${workspaceTools.stdout.trim().replaceAll("\n", ", ")})` : ""}`,
    );
    const forbiddenPayload = await sandbox.exec([
      "sh",
      "-lc",
      "for p in \"$(command -v opencode 2>/dev/null)\" \"$(command -v claude 2>/dev/null)\" /home/ubuntu/projects/opensession/package.json /home/ubuntu/projects/opensession/src/runner-host/host.ts; do test -z \"$p\" || test ! -e \"$p\" || echo \"$p\"; done",
    ]);
    assert(
      !forbiddenPayload.stdout.trim(),
      `minimal MicroVM contains no model CLI or runner payload${forbiddenPayload.stdout.trim() ? ` (found: ${forbiddenPayload.stdout.trim().replaceAll("\n", ", ")})` : ""}`,
    );
  }

  if (session.worktreeDir) {
    assert(
      !existsSync(join(session.worktreeDir, relativePath)),
      "boundary directory is absent from the host checkout",
    );
  }
  assert(
    !existsSync(
      join(
        OPENSESSION_SESSIONS_DIR,
        "opencode",
        "remote-cwd",
        session.id,
        relativePath,
      ),
    ),
    "boundary directory is absent from the host engine cwd",
  );
}

async function waitForDestroyed(
  providerId: RunnableSandboxProviderId,
  sandboxId: string,
): Promise<void> {
  const provider = getSandboxProvider(providerId);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const sandbox = await provider.get(sandboxId).catch(() => null);
    if (!sandbox || (await sandbox.status().catch(() => "gone")) === "gone") return;
    await Bun.sleep(1000);
  }
  throw new Error(`sandbox ${sandboxId} still exists after cleanup`);
}

async function certify(
  opts: Options,
  auth: { token?: string; user: string },
  providerId: RunnableSandboxProviderId,
): Promise<void> {
  console.log(`\n── ${providerId}: external-engine certification ──`);
  assert(sandboxProviderConfigured(providerId), `${providerId} is configured`);
  const modelFamily = sandboxModelFamilyFor(opts.model).id;
  assert(
    modelFamily === "opencode-openai" || modelFamily === "opencode-anthropic",
    "opening model is OpenCode OpenAI or Claude",
  );
  assert(
    sandboxEnginePlacement(opts.model, providerId) === "host",
    "opening model uses host-engine placement for this provider",
  );
  const support = sandboxModelSupport(opts.model, providerId);
  assert(support.ok, support.ok ? "opening model is supported" : support.error);

  const token = `BOUNDARY-${providerId.toUpperCase()}-${Date.now().toString(36)}`;
  const relativePath = `.opensession-boundary-${token}`;
  let sessionId = "";
  let sandboxId = "";
  try {
    const first = await runTurn({
      opts,
      auth,
      provider: providerId,
      prompt: boundaryPrompt(token, relativePath),
    });
    sessionId = first.sessionId;
    assert(Boolean(sessionId), "real WebSocket create returned a session id");
    assert(!first.errors.length, `opening turn completed without errors${first.errors.length ? `: ${first.errors.join("; ")}` : ""}`);
    for (const tool of REQUIRED_TOOLS) {
      assert(first.tools.has(tool), `opening turn used ${tool}`);
    }
    assert(
      first.text.includes(`BOUNDARY_OK ${token}`),
      "model reported the expected boundary token",
    );

    let session = await readSessionFile(sessionId);
    sandboxId = session.sandbox?.sandboxId || "";
    assert(Boolean(sandboxId), "sandbox id was persisted");
    let sandbox = await getSandboxProvider(providerId).get(sandboxId);
    assert(Boolean(sandbox), "provider.get reattached to the workspace");
    await assertSandboxState({
      providerId,
      session,
      sandbox: sandbox!,
      token,
      relativePath,
    });

    if (opts.restart) {
      console.log(`  ↻ restarting ${opts.service}…`);
      await restartService(opts);
      assert(true, `${opts.service} returned healthy`);
      const secondToken = `${token}-STICKY`;
      const second = await runTurn({
        opts,
        auth,
        provider: providerId,
        sessionId,
        prompt: [
          "This is the post-restart/fallback boundary check.",
          "Use only opensession-workspace tools.",
          `Read ${relativePath}/input.txt.`,
          `Write ${relativePath}/second.txt containing exactly ${secondToken}.`,
          `Read ${relativePath}/second.txt and finish with exactly: STICKY_OK ${secondToken}`,
        ].join("\n"),
      });
      assert(!second.errors.length, `second turn completed without errors${second.errors.length ? `: ${second.errors.join("; ")}` : ""}`);
      assert(
        second.tools.has("opensession-workspace_read_file"),
        "second turn used sandbox read_file",
      );
      assert(
        second.tools.has("opensession-workspace_write_file"),
        "second turn used sandbox write_file",
      );
      assert(
        second.text.includes(`STICKY_OK ${secondToken}`),
        "second turn preserved the boundary after restart/fallback",
      );
      session = await readSessionFile(sessionId);
      sandbox = await getSandboxProvider(providerId).get(sandboxId);
      assert(Boolean(sandbox), "provider.get reattached after service restart");
      const secondFile = await sandbox!.exec(["cat", `${relativePath}/second.txt`]);
      assert(
        secondFile.exitCode === 0,
        `post-restart file exists in the sandbox workspace${secondFile.stderr ? ` (${secondFile.stderr.trim().slice(0, 200)})` : ""}`,
      );
      assert(
        secondFile.stdout.trim() === secondToken,
        `post-restart file has the expected content (got ${JSON.stringify(secondFile.stdout.trim())})`,
      );
      if (session.worktreeDir) {
        assert(
          !existsSync(join(session.worktreeDir, relativePath, "second.txt")),
          "post-restart file is absent from the host checkout",
        );
      }
      assert(
        !existsSync(
          join(
            OPENSESSION_SESSIONS_DIR,
            "opencode",
            "remote-cwd",
            session.id,
            relativePath,
            "second.txt",
          ),
        ),
        "post-restart file is absent from the host engine cwd",
      );
      assert(
        session.sandbox?.engine === "host",
        "host-engine placement stayed sticky after model fallback",
      );
    }
  } finally {
    if (sessionId && !opts.keep) {
      console.log(`  ⌫ deleting disposable session ${sessionId}…`);
      await deleteSession(opts, auth, sessionId);
      if (sandboxId) {
        await waitForDestroyed(providerId, sandboxId);
        assert(true, "provider resource was destroyed");
      }
    } else if (sessionId) {
      console.log(`  kept ${sessionId} (--keep)`);
    }
  }
}

const opts = parseArgs(Bun.argv.slice(2));
const auth = authFor(opts.user);
let failures = 0;

for (const provider of opts.providers) {
  try {
    await certify(opts, auth, provider);
  } catch (error) {
    failures++;
    console.error(
      `\n  ✗ ${provider}: ${String((error as Error)?.message || error)}`,
    );
  }
}

console.log(
  `\nExternal-engine certification: ${opts.providers.length - failures}/${opts.providers.length} provider(s) passed.`,
);
process.exit(failures ? 1 : 0);
