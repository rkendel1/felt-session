/** Workspace-owned sandbox connections.
 *
 * Normalized records live in managed FeltDB. Account secrets live behind opaque
 * references in workspace-secrets.ts; raw provider blocks and environment
 * credentials are intentionally not part of this product surface.
 */

import { existsSync, readFileSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { audit } from "../audit";
import { managedFeltDb } from "../managed-feltdb";
import { stateDir } from "../paths";
import {
  deleteWorkspaceSecret,
  putWorkspaceSecret,
  resolveWorkspaceSecret,
  workspaceSecretExists,
} from "../workspace-secrets";
export const WORKSPACE_SANDBOX_PROVIDERS = [
  "docker",
  "daytona",
  "box",
  "modal",
  "microvm",
] as const;
export type WorkspaceSandboxProvider = (typeof WORKSPACE_SANDBOX_PROVIDERS)[number];

export type SandboxQualificationStatus = "checking" | "ready" | "failed";

export interface SandboxConnectionSettings {
  region?: string;
  cpu?: number;
  memoryMb?: number;
  snapshot?: string;
  apiUrl?: string;
  target?: string;
  profile?: string;
  app?: string;
  image?: string;
  environment?: string;
  endpoint?: string;
  cloud?: string;
  publicPreviews?: boolean;
}

export interface SandboxConnectionQualification {
  status: SandboxQualificationStatus;
  adapterSignature: string;
  checkedAt?: string;
  failureCode?: string;
  failureSummary?: string;
}

export interface SandboxConnection {
  id: string;
  provider: WorkspaceSandboxProvider;
  enabled: boolean;
  credentialRef?: string;
  settings: SandboxConnectionSettings;
  qualification?: SandboxConnectionQualification;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

export interface SafeSandboxConnection extends Omit<SandboxConnection, "credentialRef"> {
  hasCredentials: boolean;
  state:
    | "not_configured"
    | "checking"
    | "ready"
    | "needs_attention"
    | "disabled";
}

interface RawSandboxConfig extends Record<string, unknown> {
  connections?: unknown;
}

function configPath(): string {
  return process.env.OPENSESSION_SANDBOX_CONFIG || stateDir("sandbox.json");
}

const COLLECTION = "opensession_sandbox_connections";
const MIGRATION = "sandbox-connections-json-to-managed-feltdb-v1";
let connectionsDb: StateFirstDB | undefined;
const connections = new Map<WorkspaceSandboxProvider, SandboxConnection>();

export function isWorkspaceSandboxProvider(value: unknown): value is WorkspaceSandboxProvider {
  return (
    typeof value === "string" &&
    (WORKSPACE_SANDBOX_PROVIDERS as readonly string[]).includes(value)
  );
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function settings(value: unknown): SandboxConnectionSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...(string(raw.region) ? { region: string(raw.region) } : {}),
    ...(number(raw.cpu) ? { cpu: number(raw.cpu) } : {}),
    ...(number(raw.memoryMb) ? { memoryMb: number(raw.memoryMb) } : {}),
    ...(string(raw.snapshot) ? { snapshot: string(raw.snapshot) } : {}),
    ...(string(raw.apiUrl) ? { apiUrl: string(raw.apiUrl) } : {}),
    ...(string(raw.target) ? { target: string(raw.target) } : {}),
    ...(string(raw.profile) ? { profile: string(raw.profile) } : {}),
    ...(string(raw.app) ? { app: string(raw.app) } : {}),
    ...(string(raw.image) ? { image: string(raw.image) } : {}),
    ...(string(raw.environment) ? { environment: string(raw.environment) } : {}),
    ...(string(raw.endpoint) ? { endpoint: string(raw.endpoint) } : {}),
    ...(string(raw.cloud) ? { cloud: string(raw.cloud) } : {}),
    ...(typeof raw.publicPreviews === "boolean"
      ? { publicPreviews: raw.publicPreviews }
      : {}),
  };
}

function qualification(value: unknown): SandboxConnectionQualification | undefined {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (
    !raw ||
    (raw.status !== "checking" && raw.status !== "ready" && raw.status !== "failed") ||
    !string(raw.adapterSignature)
  ) {
    return undefined;
  }
  return {
    status: raw.status,
    adapterSignature: string(raw.adapterSignature)!,
    ...(string(raw.checkedAt) ? { checkedAt: string(raw.checkedAt) } : {}),
    ...(string(raw.failureCode) ? { failureCode: string(raw.failureCode) } : {}),
    ...(string(raw.failureSummary)
      ? { failureSummary: string(raw.failureSummary) }
      : {}),
  };
}

function parseConnection(value: unknown): SandboxConnection | undefined {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const provider = raw?.provider;
  if (!raw || !string(raw.id) || !isWorkspaceSandboxProvider(provider)) return undefined;
  const now = new Date(0).toISOString();
  return {
    id: string(raw.id)!,
    provider,
    enabled: raw.enabled !== false,
    ...(string(raw.credentialRef) ? { credentialRef: string(raw.credentialRef) } : {}),
    settings: settings(raw.settings),
    ...(qualification(raw.qualification)
      ? { qualification: qualification(raw.qualification) }
      : {}),
    createdAt: string(raw.createdAt) || now,
    updatedAt: string(raw.updatedAt) || string(raw.createdAt) || now,
  };
}

export function listStoredSandboxConnections(): SandboxConnection[] {
  return [...connections.values()];
}

export async function initializeManagedSandboxConnections(db: StateFirstDB = connectionsDb ?? managedFeltDb()): Promise<void> {
  connectionsDb = db;
  if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
    let legacy: RawSandboxConfig = {};
    try { if (existsSync(configPath())) legacy = JSON.parse(readFileSync(configPath(), "utf8")); } catch {}
    const values = Array.isArray(legacy.connections) ? legacy.connections :
      legacy.connections && typeof legacy.connections === "object" ? Object.values(legacy.connections) : [];
    for (const value of values) {
      const connection = parseConnection(value);
      if (!connection) continue;
      await db.transaction((tx) => { tx.collection<SandboxConnection>(COLLECTION).set(connection.provider, connection); },
        { transactionId: `opensession:sandbox-connection:migrate:${connection.provider}` });
    }
    await db.transaction((tx) => { tx.collection("opensession_migrations").set(
      MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true }); },
    { transactionId: `opensession:migration:${MIGRATION}` });
  }
  connections.clear();
  for (const value of await db.collection<SandboxConnection>(COLLECTION).all()) {
    const connection = parseConnection(value);
    if (connection) connections.set(connection.provider, { ...connection, __version: value.__version });
  }
}

export function getSandboxConnection(
  provider: WorkspaceSandboxProvider,
): SandboxConnection | undefined {
  return listStoredSandboxConnections().find((connection) => connection.provider === provider);
}

export function sandboxAdapterSignature(provider: WorkspaceSandboxProvider): string {
  const version = provider === "box" ? "connection-v4" : "connection-v1";
  return `${provider}:${version}`;
}

/** Connection qualification proves provider credentials and control-plane
 * semantics. Runner pins and remote bootstrap revisions have their own
 * re-bootstrap lifecycle and must not make a healthy connection disappear
 * after every deploy. Accept the previous signature shape once so existing
 * qualified connections migrate without another destructive provider test. */
function sandboxAdapterSignatureCurrent(
  provider: WorkspaceSandboxProvider,
  stored: string | undefined,
): boolean {
  const current = sandboxAdapterSignature(provider);
  return stored === current || stored?.startsWith(`${current}:`) === true;
}

export function safeSandboxConnections(): SafeSandboxConnection[] {
  return WORKSPACE_SANDBOX_PROVIDERS.map((provider) => {
    const connection = getSandboxConnection(provider);
    if (!connection) {
      return {
        id: `unconfigured-${provider}`,
        provider,
        enabled: false,
        settings: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        hasCredentials: false,
        state: "not_configured" as const,
      };
    }
    const hasCredentials = connection.credentialRef
      ? workspaceSecretExists(connection.credentialRef)
      : provider === "docker" || provider === "microvm";
    const signatureCurrent = sandboxAdapterSignatureCurrent(
      provider,
      connection.qualification?.adapterSignature,
    );
    const state: SafeSandboxConnection["state"] = !connection.enabled
      ? "disabled"
      : connection.qualification?.status === "checking"
        ? "checking"
        : connection.qualification?.status === "ready" && hasCredentials && signatureCurrent
          ? "ready"
          : "needs_attention";
    const { credentialRef: _credentialRef, ...safe } = connection;
    return { ...safe, hasCredentials, state };
  });
}

async function replaceConnection(connection: SandboxConnection): Promise<void> {
  const previous = connections.get(connection.provider);
  const db = connectionsDb ?? managedFeltDb();
  await db.transaction((tx) => { tx.collection<SandboxConnection>(COLLECTION).set(
    connection.provider, connection, previous ? { ifVersion: previous.__version } : { requireAbsent: true }); },
  { transactionId: `opensession:sandbox-connection:put:${connection.provider}:${crypto.randomUUID()}` });
  connections.set(connection.provider, { ...connection, __version: (previous?.__version ?? 0) + 1 });
}

export interface ConnectSandboxInput {
  secret?: string;
  tokenId?: string;
  tokenSecret?: string;
  settings?: SandboxConnectionSettings;
}

export async function connectSandboxProvider(
  provider: WorkspaceSandboxProvider,
  input: ConnectSandboxInput,
): Promise<SandboxConnection> {
  const previous = getSandboxConnection(provider);
  let credentialRef = previous?.credentialRef;
  if (provider === "daytona" || provider === "box") {
    if (input.secret) {
      credentialRef = await putWorkspaceSecret(
        `sandbox.${provider}`,
        input.secret.trim(),
        credentialRef,
      );
    }
    if (!credentialRef) {
      throw new Error(`${provider === "box" ? "Box" : "Daytona"} API key is required`);
    }
  } else if (provider === "modal") {
    const tokenId = input.tokenId;
    const tokenSecret = input.tokenSecret;
    if (tokenId || tokenSecret) {
      if (!tokenId || !tokenSecret) {
        throw new Error("Modal token ID and token secret are both required");
      }
      credentialRef = await putWorkspaceSecret(
        "sandbox.modal",
        JSON.stringify({ tokenId: tokenId.trim(), tokenSecret: tokenSecret.trim() }),
        credentialRef,
      );
    }
    if (!credentialRef) throw new Error("Modal token ID and token secret are required");
  }
  const now = new Date().toISOString();
  const connection: SandboxConnection = {
    id: previous?.id || `sandbox-connection-${crypto.randomUUID()}`,
    provider,
    enabled: true,
    ...(credentialRef ? { credentialRef } : {}),
    settings: { ...previous?.settings, ...settings(input.settings) },
    qualification: {
      status: "checking",
      adapterSignature: sandboxAdapterSignature(provider),
    },
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  await replaceConnection(connection);
  audit({ kind: "sandbox_connection_connected", provider, connection_id: connection.id });
  return connection;
}

export async function updateSandboxConnection(
  provider: WorkspaceSandboxProvider,
  patch: { enabled?: boolean; settings?: SandboxConnectionSettings },
): Promise<SandboxConnection> {
  const previous = getSandboxConnection(provider);
  if (!previous) throw new Error(`${provider} is not connected`);
  const next: SandboxConnection = {
    ...previous,
    enabled: patch.enabled ?? previous.enabled,
    settings: { ...previous.settings, ...settings(patch.settings) },
    updatedAt: new Date().toISOString(),
  };
  await replaceConnection(next);
  audit({
    kind: next.enabled ? "sandbox_connection_updated" : "sandbox_connection_disabled",
    provider,
    connection_id: next.id,
  });
  return next;
}

export async function setSandboxConnectionQualification(
  provider: WorkspaceSandboxProvider,
  result: Omit<SandboxConnectionQualification, "adapterSignature">,
): Promise<SandboxConnection> {
  const previous = getSandboxConnection(provider);
  if (!previous) throw new Error(`${provider} is not connected`);
  const next: SandboxConnection = {
    ...previous,
    qualification: {
      ...result,
      adapterSignature: sandboxAdapterSignature(provider),
    },
    updatedAt: new Date().toISOString(),
  };
  await replaceConnection(next);
  return next;
}

export async function disconnectSandboxProvider(provider: WorkspaceSandboxProvider): Promise<boolean> {
  const connection = getSandboxConnection(provider);
  if (!connection) return false;
  const db = connectionsDb ?? managedFeltDb();
  await db.transaction((tx) => { tx.collection<SandboxConnection>(COLLECTION).delete(
    provider, { ifVersion: connection.__version }); },
  { transactionId: `opensession:sandbox-connection:delete:${provider}:${connection.__version}` });
  connections.delete(provider);
  if (connection.credentialRef) await deleteWorkspaceSecret(connection.credentialRef);
  audit({
    kind: "sandbox_connection_disconnected",
    provider,
    connection_id: connection.id,
  });
  return true;
}

export function sandboxConnectionReady(provider: WorkspaceSandboxProvider): boolean {
  const connection = getSandboxConnection(provider);
  if (!connection?.enabled || connection.qualification?.status !== "ready") return false;
  if (!sandboxAdapterSignatureCurrent(provider, connection.qualification.adapterSignature)) return false;
  if (provider === "daytona" || provider === "box" || provider === "modal") {
    return Boolean(connection.credentialRef && workspaceSecretExists(connection.credentialRef));
  }
  return true;
}

/** Internal-only account credential resolution for SDK construction. */
export function sandboxProviderCredential(
  provider: "daytona" | "box" | "modal",
): { apiKey: string } | { tokenId: string; tokenSecret: string } | undefined {
  const connection = getSandboxConnection(provider);
  const raw = connection?.credentialRef
    ? resolveWorkspaceSecret(connection.credentialRef)
    : undefined;
  if (!raw) return undefined;
  if (provider === "daytona" || provider === "box") return { apiKey: raw };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.tokenId === "string" && typeof parsed.tokenSecret === "string") {
      return { tokenId: parsed.tokenId, tokenSecret: parsed.tokenSecret };
    }
  } catch {}
  return undefined;
}
