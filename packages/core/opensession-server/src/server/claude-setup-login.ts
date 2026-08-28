/** In-app wrapper around `claude setup-token`; the token never reaches the renderer. */
import { spawn, type ChildProcess } from "node:child_process";
import { addAccount, type ClaudeAccountPublic } from "./claude-accounts";
import { homeDir } from "./paths";

const TIMEOUT_MS = 16 * 60 * 1000;
type SetupState = "starting" | "authorizing" | "done" | "error" | "cancelled";

interface SetupLogin {
  id: string;
  name: string;
  owner?: string;
  state: SetupState;
  url?: string;
  error?: string;
  account?: ClaudeAccountPublic;
  output: string;
  proc: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  registering: boolean;
}

export interface SetupLoginPublic {
  id: string;
  state: SetupState;
  url?: string;
  error?: string;
  account?: ClaudeAccountPublic;
}

const logins: Map<string, SetupLogin> = ((globalThis as any).__claudeSetupLogins ??= new Map());

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function cleanOutput(value: string): string {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Z0-9]|[=>][0-9]?|[78])/g, "")
    .replace(/\r/g, "");
}

function safeOutput(value: string): string {
  return cleanOutput(value).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
}

export function extractSetupToken(value: string): string | undefined {
  return cleanOutput(value).match(/sk-ant-[A-Za-z0-9_-]{40,}/)?.[0];
}

export function redactSetupOutput(value: string): string {
  return safeOutput(value);
}

function toPublic(login: SetupLogin): SetupLoginPublic {
  return {
    id: login.id,
    state: login.state,
    ...(login.url ? { url: login.url } : {}),
    ...(login.error ? { error: login.error } : {}),
    ...(login.account ? { account: login.account } : {}),
  };
}

function finish(login: SetupLogin, state: SetupState, error?: string): void {
  if (["done", "error", "cancelled"].includes(login.state)) return;
  login.state = state;
  if (error) login.error = error;
  if (login.timer) clearTimeout(login.timer);
  login.timer = null;
  if (login.proc?.exitCode === null) login.proc.kill("SIGTERM");
  login.proc = null;
}

export function startClaudeSetupLogin(
  name: string,
  owner?: string,
): SetupLoginPublic | { error: string } {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Email is required" };
  const claude = Bun.which("claude");
  if (!claude) return { error: "Claude Code is not installed." };
  const script = Bun.which("script");
  if (!script) {
    return { error: "This system cannot create a secure Claude sign-in session." };
  }

  const login: SetupLogin = {
    id: crypto.randomUUID(),
    name: trimmedName,
    ...(owner?.trim() ? { owner: owner.trim() } : {}),
    state: "starting",
    output: "",
    proc: null,
    timer: null,
    registering: false,
  };
  logins.set(login.id, login);

  const args = process.platform === "darwin"
    ? ["-q", "/dev/null", claude, "setup-token"]
    : ["-q", "-c", `${shellQuote(claude)} setup-token`, "/dev/null"];
  const proc = spawn(script, args, {
    env: {
      HOME: homeDir(),
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      TERM: "xterm-256color",
      NODE_ENV: process.env.NODE_ENV || "production",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  login.proc = proc;
  login.timer = setTimeout(
    () => finish(login, "error", "Claude sign-in expired. Try again."),
    TIMEOUT_MS,
  );

  const onChunk = (chunk: Buffer) => {
    login.output = (login.output + chunk.toString()).slice(-40_000);
    const clean = cleanOutput(login.output);
    if (!login.url) login.url = clean.match(/https:\/\/[^\s]+/)?.[0];
    if (login.state === "starting" && (login.url || /oauth|browser|sign in/i.test(clean))) {
      login.state = "authorizing";
    }
    const token = extractSetupToken(login.output);
    if (!token || login.registering) return;
    login.registering = true;
    void addAccount(login.name, token, login.owner).then((result) => {
      if ("error" in result) finish(login, "error", result.error);
      else {
        login.account = result;
        finish(login, "done");
      }
    });
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  proc.on("error", (error) => finish(login, "error", error.message));
  proc.on("exit", (code) => {
    if (["done", "error", "cancelled"].includes(login.state)) return;
    if (login.registering) return;
    const tail = safeOutput(login.output).trim().split("\n").slice(-3).join(" ");
    finish(login, "error", tail || `Claude sign-in exited ${code ?? "unexpectedly"}.`);
  });
  return toPublic(login);
}

export function getClaudeSetupLogin(id: string): SetupLoginPublic | null {
  const login = logins.get(id);
  return login ? toPublic(login) : null;
}

export function cancelClaudeSetupLogin(id: string): boolean {
  const login = logins.get(id);
  if (!login) return false;
  finish(login, "cancelled");
  return true;
}
