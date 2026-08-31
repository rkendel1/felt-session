import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import type { StateFirstDB } from "@feltdb/core";
import { join } from "path";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { managedFeltDb } from "./managed-feltdb";
import type { SessionKernelStoreApi } from "./session-kernel/store";
import type { CreationAttachmentSource } from "./uploads";

export interface DurableCreatePlan {
  version: 1;
  sessionId: string;
  identity: string;
  createdAt: string;
  branch?: string;
  workspaceId?: string;
  /** Durable source identities only. Attachment bodies remain in the upload spool. */
  attachments?: CreationAttachmentSource[];
  /** Serializable ResolvedCreate decisions; attachment bodies and functions stay external. */
  resolved?: Record<string, unknown>;
}

function planDir(): string {
  return join(OPENSESSION_SESSIONS_DIR, "create-plans");
}

type StoredCreatePlan = DurableCreatePlan & { id: string };
const COLLECTION = "opensession_legacy_session_create_plans";
const MIGRATION = "session-create-plan-json-to-managed-feltdb-v1";
let createPlanDb: StateFirstDB | undefined;
const managedCreatePlans = ((globalThis as typeof globalThis & {
  __opensessionManagedCreatePlans?: {
    plans: Map<string, DurableCreatePlan>;
    persistTail: Promise<void>;
  };
}).__opensessionManagedCreatePlans ??= {
  plans: new Map<string, DurableCreatePlan>(),
  persistTail: Promise.resolve(),
});
const recordId = (sessionId: string) => `plan_${Buffer.from(sessionId).toString("base64url")}`;

export async function initializeManagedCreatePlans(
  db: StateFirstDB = createPlanDb ?? managedFeltDb(),
  legacyDir = planDir(),
): Promise<void> {
  await managedCreatePlans.persistTail;
  createPlanDb = db;
  const legacy: Array<{ path: string; plan: DurableCreatePlan }> = [];
  if (existsSync(legacyDir)) for (const entry of readdirSync(legacyDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(legacyDir, entry);
    const plan = JSON.parse(readFileSync(path, "utf8")) as DurableCreatePlan;
    if (plan.version !== 1 || !plan.sessionId || !plan.identity)
      throw new Error(`Invalid durable create plan at ${path}`);
    legacy.push({ path, plan });
  }
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  const migrationComplete = !!await migrations.get(MIGRATION);
  if (legacy.length || !migrationComplete) await db.transaction((tx) => {
    const plans = tx.collection<StoredCreatePlan>(COLLECTION);
    for (const { plan } of legacy) {
      const id = recordId(plan.sessionId);
      plans.set(id, { id, ...plan });
    }
    if (!migrationComplete) tx.collection("opensession_migrations").set(MIGRATION,
      { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
  }, { transactionId: `opensession:migration:${MIGRATION}:${crypto.randomUUID()}` });
  managedCreatePlans.plans.clear();
  for (const { id: _, ...plan } of await db.collection<StoredCreatePlan>(COLLECTION).all())
    managedCreatePlans.plans.set(plan.sessionId, plan);
  for (const { path } of legacy) rmSync(path, { force: true });
}

export function readCreatePlanForRecovery(
  sessionId: string,
): DurableCreatePlan | undefined {
  const plan = managedCreatePlans.plans.get(sessionId);
  if (!plan) return undefined;
  if (plan.version !== 1 || plan.sessionId !== sessionId)
    throw new Error(`Invalid durable create plan for ${sessionId}`);
  return structuredClone(plan);
}

export function readCreatePlan(
  sessionId: string,
  identity: string,
): DurableCreatePlan | undefined {
  const plan = readCreatePlanForRecovery(sessionId);
  if (!plan) return undefined;
  if (plan.identity !== identity) {
    throw new Error(`Create request id for ${sessionId} was reused with another payload`);
  }
  return plan;
}

export function clearCreatePlan(sessionId: string): void {
  managedCreatePlans.plans.delete(sessionId);
  const db = createPlanDb ?? managedFeltDb();
  managedCreatePlans.persistTail = managedCreatePlans.persistTail.catch(() => {}).then(async () => {
    await db.transaction((tx) => {
      tx.collection(COLLECTION).delete(recordId(sessionId));
    }, { transactionId: `opensession:create-plan:delete:${crypto.randomUUID()}` });
  });
}

export function pruneCreatePlans(
  store: SessionKernelStoreApi,
  now = Date.now(),
  terminalRetentionMs = 24 * 60 * 60_000,
): number {
  let removed = 0;
  for (const plan of managedCreatePlans.plans.values()) {
    try {
      const age = now - Date.parse(plan.createdAt);
      const receipt = store.command(plan.sessionId, plan.identity);
      const terminal =
        receipt?.status === "completed" ||
        receipt?.status === "indeterminate" ||
        (receipt?.status === "failed" && !receipt.retryable);
      if (terminal && age >= terminalRetentionMs) {
        clearCreatePlan(plan.sessionId);
        removed += 1;
      }
    } catch {
      // Invalid plans remain forensic evidence; recovery reports them explicitly.
    }
  }
  return removed;
}

export async function flushCreatePlanWrites(): Promise<void> {
  await managedCreatePlans.persistTail;
}

export function createPlanWorkspaceId(sessionId: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
  return `ws-${digest.slice(0, 32)}`;
}

const UNDEFINED_VALUE = { __opensessionCreateUndefined: true } as const;

function snapshotValue(value: unknown): unknown {
  if (value === undefined) return UNDEFINED_VALUE;
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        snapshotValue(item),
      ]),
    );
  return value;
}

function restoreValue(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__opensessionCreateUndefined === true
  )
    return undefined;
  if (Array.isArray(value)) return value.map(restoreValue);
  if (value && typeof value === "object") {
    const restored: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      restored[key] = restoreValue(item);
    return restored;
  }
  return value;
}

/** Preserve present and absent decisions without copying attachments/functions. */
export function snapshotResolvedCreate(
  value: Record<string, unknown>,
): Record<string, unknown> {
  // gitEnv carries short-lived bearer tokens. A durable plan keeps only the
  // non-secret gitPrincipal and resolves its current token during recovery.
  const { gitEnv: _ephemeralGitEnv, ...durable } = value;
  return snapshotValue(durable) as Record<string, unknown>;
}

export function snapshotOpeningCreate(value: object): Record<string, unknown> {
  const {
    images: _images,
    materializeWorktree: _materializeWorktree,
    autoNameWorkspace,
    ...durable
  } = value as Record<string, unknown>;
  const renameTarget =
    autoNameWorkspace &&
    typeof autoNameWorkspace === "object" &&
    !Array.isArray(autoNameWorkspace) &&
    typeof (autoNameWorkspace as Record<string, unknown>).id === "string"
      ? {
          id: (autoNameWorkspace as Record<string, unknown>).id,
          name: (autoNameWorkspace as Record<string, unknown>).name,
        }
      : autoNameWorkspace;
  return snapshotResolvedCreate({
    ...durable,
    autoNameWorkspace: renameTarget,
  });
}

export function restoreResolvedCreate<T>(
  value: Record<string, unknown>,
): Partial<T> {
  return restoreValue(value) as Partial<T>;
}
