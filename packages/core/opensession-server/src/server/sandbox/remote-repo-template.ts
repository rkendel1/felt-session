/**
 * Durable post-setup repo templates for remote sandbox providers.
 *
 * Daytona stores templates as provider snapshots, Box as named snapshots,
 * and Modal as Image ids returned by Sandbox.snapshotFilesystem(). This file owns only the
 * small local index that maps (provider, repo, runtime/create signature and
 * project preparation inputs) to the provider artifact. The artifact itself
 * is credential-free and durable; adapters replace it only when an input that
 * affects setup changes.
 */

import { createHash, randomUUID } from "crypto";
import { spawnSync } from "child_process";
import type { StateFirstDB } from "@feltdb/core";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { managedFeltDb } from "../managed-feltdb";
import { sandboxConfig } from "./config";
import {
  bootstrapSignature,
  remoteWarmWorkspaceDir,
  shellQuoteWord,
  type RemoteDriver,
} from "./adapters/bootstrap";
import { getSandboxConnection } from "./connections";
import { configuredRepos } from "../config";

export type RemoteTemplateProvider = "daytona" | "box" | "modal";

export interface RemoteRepoTemplate {
  provider: RemoteTemplateProvider;
  repoId: string;
  artifactId: string;
  signature: string;
  createdAt: string;
  /** Legacy informational field. Expiry no longer invalidates stopped storage. */
  expiresAt?: string;
  projectSignature?: string;
}

/** Ramp-style source-image cadence. Compute runs only while replacing an image. */
export const REMOTE_REPO_TEMPLATE_REFRESH_MS = 30 * 60 * 1_000;
/** Box counts every create, fork, and resume against a 150 starts/day quota.
 * Since session adoption fetches the current branch anyway, spending 48 of
 * those starts per repo/day only to shorten the git delta harms availability
 * more than it helps latency. Setup-input changes still invalidate instantly. */
export const BOX_REPO_TEMPLATE_REFRESH_MS = 6 * 60 * 60 * 1_000;
/** Provider storage backstop where an API requires a finite snapshot TTL. */
export const REMOTE_REPO_TEMPLATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function remoteRepoTemplateNeedsRefresh(
  template: Pick<RemoteRepoTemplate, "provider" | "createdAt">,
  now = Date.now(),
): boolean {
  const refreshMs =
    template.provider === "box"
      ? BOX_REPO_TEMPLATE_REFRESH_MS
      : REMOTE_REPO_TEMPLATE_REFRESH_MS;
  return now - Date.parse(template.createdAt) >= refreshMs;
}

export function remoteRepoTemplateProofPath(repoId: string): string {
  return `/home/ubuntu/.opensession/repo-template-${clean(repoId)}.json`;
}

/** Fail closed before a provider snapshot is published, then write a nonce
 * into the filesystem. Certification restores a second sandbox and requires
 * the exact nonce, proving it used the artifact rather than merely repeating
 * setup in another cold sandbox. */
export async function sealRemoteRepoTemplate(
  driver: RemoteDriver,
  provider: RemoteTemplateProvider,
  repo: { id: string },
): Promise<string> {
  const warmDir = remoteWarmWorkspaceDir(repo.id);
  const origin = await driver.exec("git remote get-url origin", { cwd: warmDir });
  if (origin.exitCode !== 0 || /https?:\/\/[^/\s]+@/i.test(origin.stdout)) {
    throw new Error(`refusing to snapshot ${repo.id}: clone authority was not scrubbed`);
  }
  const dirty = await driver.exec("git status --porcelain --untracked-files=no", {
    cwd: warmDir,
  });
  if (dirty.exitCode !== 0 || dirty.stdout.trim()) {
    throw new Error(
      `refusing to snapshot ${repo.id}: setup changed tracked project files` +
        (dirty.stdout.trim() ? ` (${dirty.stdout.trim().split("\\n").slice(0, 5).join(", ")})` : ""),
    );
  }
  const sensitive = await driver.exec(
    "for f in " +
      [
        "/home/ubuntu/.claude/.credentials.json",
        "/home/ubuntu/.codex/auth.json",
        "/home/ubuntu/.config/pi/auth.json",
        "/home/ubuntu/.opensession-claude-accounts.json",
        "/home/ubuntu/.opensession-pi.json",
        "/home/ubuntu/.opensession-pi.json",
      ]
        .map(shellQuoteWord)
        .join(" ") +
      '; do [ ! -s "$f" ] || echo "$f"; done',
  );
  if (sensitive.exitCode !== 0 || sensitive.stdout.trim()) {
    throw new Error(
      `refusing to snapshot ${repo.id}: launch credentials are present (${sensitive.stdout.trim()})`,
    );
  }
  const nonce = randomUUID();
  const proof = JSON.stringify({
    provider,
    repoId: repo.id,
    signature: remoteRepoTemplateSignature(provider),
    projectSignature: projectPreparationSignature(repo.id),
    nonce,
    sealedAt: new Date().toISOString(),
  });
  const path = remoteRepoTemplateProofPath(repo.id);
  const written = await driver.exec(
    `mkdir -p ${shellQuoteWord(path.slice(0, path.lastIndexOf("/")))} && printf %s ${shellQuoteWord(proof)} > ${shellQuoteWord(path)}`,
  );
  if (written.exitCode !== 0) {
    throw new Error(`could not seal ${provider} repo template: ${written.stderr.trim()}`);
  }
  return nonce;
}

export async function validateRemoteRepoTemplate(
  driver: RemoteDriver,
  provider: RemoteTemplateProvider,
  repo: { id: string },
): Promise<string> {
  const proof = await driver.exec(
    `cat ${shellQuoteWord(remoteRepoTemplateProofPath(repo.id))}`,
  );
  if (proof.exitCode !== 0) {
    throw new Error(`restored ${provider} template has no seal for ${repo.id}`);
  }
  let parsed: {
    provider?: string;
    repoId?: string;
    signature?: string;
    projectSignature?: string;
    nonce?: string;
  };
  try {
    parsed = JSON.parse(proof.stdout);
  } catch {
    throw new Error(`restored ${provider} template has a malformed seal for ${repo.id}`);
  }
  if (
    parsed.provider !== provider ||
    parsed.repoId !== repo.id ||
    parsed.signature !== remoteRepoTemplateSignature(provider) ||
    parsed.projectSignature !== projectPreparationSignature(repo.id) ||
    !parsed.nonce
  ) {
    throw new Error(`restored ${provider} template seal does not match ${repo.id}`);
  }
  const warm = await driver.exec(
    `test -d ${shellQuoteWord(remoteWarmWorkspaceDir(repo.id))}/.git && git remote get-url origin`,
    { cwd: remoteWarmWorkspaceDir(repo.id) },
  );
  if (warm.exitCode !== 0 || /https?:\/\/[^/\s]+@/i.test(warm.stdout)) {
    throw new Error(`restored ${provider} template is missing or retained clone authority`);
  }
  return parsed.nonce;
}

function clean(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

const PROJECT_PREPARATION_INPUTS = [
  ".agents/setup",
  ".agents/sandbox-environment.json",
  "bun.lock",
] as const;

/** Hash only committed files whose bytes affect the reusable prepared
 * filesystem. Shared project images are built from repository commits, never
 * from an operator's dirty worktree. Reading working-tree bytes here made an
 * unrelated local bun.lock edit invalidate every provider artifact. */
export function projectPreparationSignature(repoId: string): string {
  const repo = configuredRepos()[repoId];
  const hash = createHash("sha256");
  hash.update(`project-preparation-v2\0${repoId}\0`);
  if (!repo) return hash.update("<unregistered>").digest("hex");
  const hasHead = spawnSync("git", ["-C", repo.repo, "rev-parse", "--verify", "HEAD"], {
    stdio: "ignore",
  }).status === 0;
  for (const relative of PROJECT_PREPARATION_INPUTS) {
    hash.update(`${relative}\0`);
    if (hasHead) {
      const committed = spawnSync("git", ["-C", repo.repo, "show", `HEAD:${relative}`], {
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
      });
      if (committed.status === 0 && committed.stdout) hash.update(committed.stdout);
      else hash.update("<absent>");
    } else {
      try {
        hash.update(readFileSync(join(repo.repo, relative)));
      } catch {
        hash.update("<absent>");
      }
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function dir(): string {
  return `${process.env.OPENSESSION_SESSIONS_DIR || OPENSESSION_SESSIONS_DIR}/sandbox-repo-templates`;
}

type StoredRemoteRepoTemplate = RemoteRepoTemplate & { id: string };
const TEMPLATE_COLLECTION = "opensession_remote_repo_templates";
const TEMPLATE_MIGRATION = "remote-repo-template-json-to-managed-feltdb-v1";
let templateDb: StateFirstDB | undefined;
const templateState = ((globalThis as typeof globalThis & {
  __opensessionRemoteRepoTemplates?: Map<string, RemoteRepoTemplate>;
}).__opensessionRemoteRepoTemplates ??= new Map<string, RemoteRepoTemplate>());
const templateKey = (provider: RemoteTemplateProvider, repoId: string) => `${provider}:${repoId}`;
const templateId = (provider: RemoteTemplateProvider, repoId: string) =>
  `template_${Buffer.from(templateKey(provider, repoId)).toString("base64url")}`;

export async function initializeManagedRemoteRepoTemplates(
  db: StateFirstDB = templateDb ?? managedFeltDb(),
  legacyDir = dir(),
): Promise<void> {
  templateDb = db;
  const legacy: Array<{ path: string; value: RemoteRepoTemplate }> = [];
  if (existsSync(legacyDir)) for (const name of readdirSync(legacyDir)) {
    if (!name.endsWith(".json")) continue;
    const path = `${legacyDir}/${name}`;
    const value = JSON.parse(readFileSync(path, "utf8")) as RemoteRepoTemplate;
    if (value.provider && value.repoId && value.artifactId) legacy.push({ path, value });
  }
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  const migrationComplete = !!await migrations.get(TEMPLATE_MIGRATION);
  const existing = await db.collection<StoredRemoteRepoTemplate>(TEMPLATE_COLLECTION).all();
  const byKey = new Map(existing.map((value) => [templateKey(value.provider, value.repoId), value]));
  const imports = legacy.map(({ value }) => value).filter((value) => {
    if (!migrationComplete) return true;
    const current = byKey.get(templateKey(value.provider, value.repoId));
    return !current || Date.parse(value.createdAt) > Date.parse(current.createdAt);
  });
  for (let offset = 0; offset < imports.length; offset += 100) {
    await db.transaction((tx) => {
      for (const value of imports.slice(offset, offset + 100)) {
        const id = templateId(value.provider, value.repoId);
        tx.collection<StoredRemoteRepoTemplate>(TEMPLATE_COLLECTION).set(id, { id, ...value });
      }
    }, { transactionId: `opensession:remote-repo-template:import:${crypto.randomUUID()}` });
  }
  if (!migrationComplete) await db.transaction((tx) => {
    tx.collection("opensession_migrations").set(TEMPLATE_MIGRATION,
      { id: TEMPLATE_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
  }, { transactionId: `opensession:migration:${TEMPLATE_MIGRATION}` });
  templateState.clear();
  for (const { id: _, ...value } of await db.collection<StoredRemoteRepoTemplate>(TEMPLATE_COLLECTION).all())
    templateState.set(templateKey(value.provider, value.repoId), value);
  for (const { path } of legacy) rmSync(path, { force: true });
}

/** Includes every create-time input whose change makes an artifact unsafe to
 * reuse. Source freshness is handled by adoption's fetch; dependency/setup
 * freshness is handled separately by projectPreparationSignature. */
export function remoteRepoTemplateSignature(
  provider: RemoteTemplateProvider,
): string {
  const cfg = sandboxConfig();
  const settings = getSandboxConnection(provider)?.settings || {};
  const shape =
    provider === "daytona"
      ? { baseSnapshot: settings.snapshot || "default" }
      : provider === "box"
        ? { machineProfile: settings.profile || "default" }
      : {
          image: settings.image || "daytonaio/sandbox:0.8.0",
          cpu: settings.cpu || null,
          memory: settings.memoryMb || null,
          region: settings.region || null,
          cloud: settings.cloud || null,
        };
  return createHash("sha256")
    .update(`repo-template-v2|${bootstrapSignature()}|${JSON.stringify(shape)}`)
    .digest("hex");
}

/** Deterministic, provider-safe name used by Daytona and Box snapshot APIs. */
export function remoteRepoTemplateName(
  provider: RemoteTemplateProvider,
  repoId: string,
): string {
  const suffix = createHash("sha256")
    .update(`${remoteRepoTemplateSignature(provider)}|${projectPreparationSignature(repoId)}`)
    .digest("hex")
    .slice(0, 16);
  return `opensession-${clean(repoId).slice(0, 36)}-${suffix}`;
}

export function readRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  _now = Date.now(),
): RemoteRepoTemplate | null {
  try {
    const stored = templateState.get(templateKey(provider, repoId));
    if (!stored) return null;
    const entry = structuredClone(stored);
    const projectSignature = projectPreparationSignature(repoId);
    if (
      entry.provider !== provider ||
      entry.repoId !== repoId ||
      !entry.artifactId ||
      entry.signature !== remoteRepoTemplateSignature(provider) ||
      (entry.projectSignature != null && entry.projectSignature !== projectSignature)
    ) {
      return null;
    }
    if (!entry.projectSignature) {
      entry.projectSignature = projectSignature;
    }
    return entry;
  } catch {
    return null;
  }
}

export async function writeRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  artifactId: string,
  now = Date.now(),
): Promise<{ current: RemoteRepoTemplate; previous: RemoteRepoTemplate | null }> {
  const previous = templateState.get(templateKey(provider, repoId)) ?? null;
  const current: RemoteRepoTemplate = {
    provider,
    repoId,
    artifactId,
    signature: remoteRepoTemplateSignature(provider),
    projectSignature: projectPreparationSignature(repoId),
    createdAt: new Date(now).toISOString(),
  };
  const db = templateDb ?? managedFeltDb();
  const id = templateId(provider, repoId);
  await db.transaction((tx) => {
    tx.collection<StoredRemoteRepoTemplate>(TEMPLATE_COLLECTION).set(id, { id, ...current });
  }, { transactionId: `opensession:remote-repo-template:write:${crypto.randomUUID()}` });
  templateState.set(templateKey(provider, repoId), structuredClone(current));
  return { current, previous };
}

export async function invalidateRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
): Promise<RemoteRepoTemplate | null> {
  const key = templateKey(provider, repoId);
  const previous = templateState.get(key) ?? null;
  if (!previous) return null;
  const db = templateDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection(TEMPLATE_COLLECTION).delete(templateId(provider, repoId));
  }, { transactionId: `opensession:remote-repo-template:delete:${crypto.randomUUID()}` });
  templateState.delete(key);
  return previous;
}
