/** Opaque workspace-owned secrets.
 *
 * This is deliberately separate from keychain.ts: keychain credentials are
 * person-owned, lendable to agents, and broker-addressable. Workspace secrets
 * are instance configuration. They can only be resolved by server code and
 * are never listed or projected into a run/sandbox.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";

interface WorkspaceSecretRecord {
  id: string;
  purpose: string;
  value: string;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

interface WorkspaceSecretStore {
  version: 1;
  secrets: WorkspaceSecretRecord[];
}

function storePath(): string {
  return process.env.OPENSESSION_WORKSPACE_SECRETS_STORE || stateDir("workspace-secrets.json");
}

const COLLECTION = "opensession_workspace_secrets";
const MIGRATION = "workspace-secrets-json-to-managed-feltdb-v1";
let secretsDb: StateFirstDB | undefined;
const secrets = new Map<string, WorkspaceSecretRecord>();

export async function initializeManagedWorkspaceSecrets(db: StateFirstDB = secretsDb ?? managedFeltDb()): Promise<void> {
  secretsDb = db;
  if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
    let legacy: WorkspaceSecretStore = { version: 1, secrets: [] };
    try { if (existsSync(storePath())) legacy = JSON.parse(readFileSync(storePath(), "utf8")); } catch {}
    for (const secret of legacy.secrets ?? []) {
      if (!secret?.id || !secret.purpose || typeof secret.value !== "string") continue;
      await db.transaction((tx) => {
        tx.collection<WorkspaceSecretRecord>(COLLECTION).set(secret.id, { ...secret, __version: 1 });
      }, { transactionId: `opensession:workspace-secret:migrate:${secret.id}` });
    }
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
  }
  if (existsSync(storePath())) unlinkSync(storePath());
  secrets.clear();
  for (const secret of await db.collection<WorkspaceSecretRecord>(COLLECTION).all()) secrets.set(secret.id, secret);
}

export async function putWorkspaceSecret(purpose: string, value: string, ref?: string): Promise<string> {
  if (!purpose.trim()) throw new Error("workspace secret purpose is required");
  if (!value) throw new Error("workspace secret is empty");
  const now = new Date().toISOString();
  const id = ref || `wssec-${crypto.randomUUID()}`;
  const existing = secrets.get(id);
  if (existing && !Number.isSafeInteger(existing.__version))
    throw new Error(`Workspace secret ${id} has no FeltDB authority version`);
  const next: WorkspaceSecretRecord = {
    id, purpose: purpose.trim(), value,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
  const db = secretsDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<WorkspaceSecretRecord>(COLLECTION).set(id, next,
      existing ? { ifVersion: existing.__version } : { requireAbsent: true });
  }, { transactionId: `opensession:workspace-secret:put:${id}:${crypto.randomUUID()}` });
  secrets.set(id, { ...next, __version: (existing?.__version ?? 0) + 1 });
  return id;
}

export function resolveWorkspaceSecret(ref: string): string | undefined {
  return secrets.get(ref)?.value;
}

export async function deleteWorkspaceSecret(ref: string): Promise<boolean> {
  const existing = secrets.get(ref);
  if (!existing || !Number.isSafeInteger(existing.__version)) return false;
  const db = secretsDb ?? managedFeltDb();
  await db.transaction((tx) => {
    tx.collection<WorkspaceSecretRecord>(COLLECTION).delete(ref, { ifVersion: existing.__version });
  }, { transactionId: `opensession:workspace-secret:delete:${ref}:${existing.__version}` });
  secrets.delete(ref);
  return true;
}

export function workspaceSecretExists(ref: string): boolean {
  return secrets.has(ref);
}
