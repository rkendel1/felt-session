import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "fs";
import { basename } from "path";
import { configPath, configuredRepos, type RepoSection } from "../config";
import { rawConfig, withConfigMutationLock } from "../config-mutation";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { isLocalProfile, localProfileRoot } from "../profile";
import { writeJsonAtomic } from "../shared/atomic-write";
import type { RouteContext } from "./context";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function git(
  args: string[],
  cwd?: string,
  options?: { clone?: boolean },
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    ...(options?.clone
      ? {
          env: {
            ...process.env,
            GIT_ALLOW_PROTOCOL: "file:https:ssh",
            GIT_SSH_COMMAND:
              process.env.GIT_SSH_COMMAND ||
              "ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 -o ServerAliveCountMax=3",
          },
        }
      : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(9), options?.clone ? 5 * 60_000 : 30_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timeout)),
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

const CLONE_URL = /^(?:https:\/\/|ssh:\/\/|file:\/\/|[^/@\s]+@[^/:\s]+:).+/i;

export function localCloneUrlAllowed(url: string): boolean {
  return CLONE_URL.test(url);
}

// The config mutation lock + raw read moved to ../config-mutation so the
// /api/setup routes serialize against these repo writes (same globalThis
// chain — behavior here is unchanged).
const withRepoMutationLock = withConfigMutationLock;

function persistRepos(repos: Record<string, RepoSection>): void {
  const config = rawConfig();
  config.repos = repos;
  writeJsonAtomic(configPath(), config);
}

function repoName(input: string): string {
  const trimmed = input.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  return basename(trimmed.replace(/^.*:/, "")) || "repo";
}

export function localRepoId(input: string): string {
  const id = repoName(input)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return id || "repo";
}

export function githubRepoFromRemote(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/i, "");
  const match = normalized.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i,
  );
  return match?.[1];
}

export async function inspectRepo(repoPath: string): Promise<{
  path: string;
  defaultBranch: string;
  ghRepo?: string;
}> {
  const root = await git(["rev-parse", "--show-toplevel"], repoPath);
  if (root.exitCode !== 0 || !root.stdout) {
    throw new Error("Path is not a Git repository");
  }
  const path = realpathSync(root.stdout);
  const remoteHead = await git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    path,
  );
  const current = await git(["branch", "--show-current"], path);
  const defaultBranch = remoteHead.stdout.replace(/^origin\//, "") || current.stdout;
  if (!defaultBranch) throw new Error("Repository must have a checked-out branch");
  const origin = await git(["remote", "get-url", "origin"], path);
  return {
    path,
    defaultBranch,
    ...(origin.exitCode === 0
      ? { ghRepo: githubRepoFromRemote(origin.stdout) }
      : {}),
  };
}

async function registerRepo(input: { url?: string; path?: string }) {
  if (!!input.url === !!input.path) {
    throw new Error("Provide exactly one of url or path");
  }

  let requestedName: string;
  let checkoutPath: string;
  let clonedCheckout = false;
  if (input.url) {
    if (!localCloneUrlAllowed(input.url)) {
      throw new Error("Clone URL must use HTTPS, SSH, or file://");
    }
    requestedName = repoName(input.url);
    const id = localRepoId(requestedName);
    if (configuredRepos()[id]) throw new Error(`Repository id already registered: ${id}`);
    checkoutPath = `${localProfileRoot()}/repos/${id}`;
    if (existsSync(checkoutPath)) {
      throw new Error(`Clone destination already exists: ${checkoutPath}`);
    }
    mkdirSync(`${localProfileRoot()}/repos`, { recursive: true });
    try {
      const cloned = await git(["clone", "--", input.url, checkoutPath], undefined, {
        clone: true,
      });
      if (cloned.exitCode !== 0) {
        throw new Error(cloned.stderr || "git clone failed");
      }
      clonedCheckout = true;
    } catch (error) {
      rmSync(checkoutPath, { recursive: true, force: true });
      throw error;
    }
  } else {
    checkoutPath = realpathSync(input.path!);
    requestedName = basename(checkoutPath);
    const id = localRepoId(requestedName);
    if (configuredRepos()[id]) throw new Error(`Repository id already registered: ${id}`);
  }

  try {
    const inspected = await inspectRepo(checkoutPath);
    const id = localRepoId(requestedName);
    const current = configuredRepos();
    const config = rawConfig();
    const repos = {
      ...((config.repos && typeof config.repos === "object" && !Array.isArray(config.repos)
        ? config.repos
        : {}) as Record<string, RepoSection>),
      [id]: {
        repo: inspected.path,
        wtPrefix: id,
        defaultBranch: inspected.defaultBranch,
        ...(inspected.ghRepo ? { ghRepo: inspected.ghRepo } : {}),
        ...(Object.keys(current).length === 0 ? { default: true } : {}),
      },
    };
    persistRepos(repos);
    return configuredRepos()[id];
  } catch (error) {
    if (clonedCheckout) rmSync(checkoutPath, { recursive: true, force: true });
    throw error;
  }
}

export function sessionDataReferencesRepo(data: unknown, id: string): boolean {
  if (!data || typeof data !== "object") return false;
  const session = data as {
    id?: unknown;
    repo?: unknown;
    project?: unknown;
    attachedRepos?: Array<{ repo?: unknown }>;
    linkedPrs?: Array<{ repo?: unknown }>;
  };
  if (!session.id) return false;
  return (
    (session.repo ?? session.project) === id ||
    session.attachedRepos?.some((repo) => repo.repo === id) === true ||
    session.linkedPrs?.some((repo) => repo.repo === id) === true
  );
}

function repoIsInUse(id: string): boolean {
  if (!existsSync(OPENSESSION_SESSIONS_DIR)) return false;
  for (const file of readdirSync(OPENSESSION_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(`${OPENSESSION_SESSIONS_DIR}/${file}`, "utf-8"));
      if (sessionDataReferencesRepo(data, id)) return true;
    } catch {}
  }
  return false;
}

function removeRepo(id: string): "removed" | "missing" | "in-use" {
  const config = rawConfig();
  const repos = {
    ...((config.repos && typeof config.repos === "object" && !Array.isArray(config.repos)
      ? config.repos
      : {}) as Record<string, RepoSection>),
  };
  if (!repos[id]) return "missing";
  if (repoIsInUse(id)) return "in-use";
  const wasDefault = repos[id].default === true;
  delete repos[id];
  if (wasDefault) {
    const next = Object.keys(repos)[0];
    if (next) repos[next] = { ...repos[next], default: true };
  }
  persistRepos(repos);
  return "removed";
}

export async function handleLocalReposRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (!isLocalProfile()) return undefined;
  const { req, path } = ctx;

  if (path === "/api/repos" && req.method === "GET") {
    return Response.json({ repos: Object.values(configuredRepos()) });
  }

  if (path === "/api/repos" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      url?: unknown;
      path?: unknown;
    } | null;
    try {
      const repo = await withRepoMutationLock(() =>
        registerRepo({
          ...(typeof body?.url === "string" && body.url.trim()
            ? { url: body.url.trim() }
            : {}),
          ...(typeof body?.path === "string" && body.path.trim()
            ? { path: body.path.trim() }
            : {}),
        }),
      );
      return Response.json(repo, { status: 201 });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  const removeMatch = path.match(/^\/api\/repos\/([^/]+)\/remove$/);
  if (removeMatch && req.method === "POST") {
    const id = decodeURIComponent(removeMatch[1]);
    const result = await withRepoMutationLock(async () => removeRepo(id));
    if (result === "removed") return Response.json({ ok: true });
    if (result === "in-use") {
      return Response.json(
        { error: "Repository is still referenced by a session" },
        { status: 409 },
      );
    }
    return Response.json({ error: "Repository not found" }, { status: 404 });
  }

  return undefined;
}
