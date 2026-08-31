/**
 * Per-resource GitHub rate-limit gates.
 *
 * GitHub meters REST (`core`) and GraphQL independently. App installation and
 * App user tokens share those installation buckets, so exhausting GraphQL must
 * pause GraphQL consumers without suppressing healthy REST acknowledgements,
 * metadata reads, comments, or writes. Backoffs survive process restarts.
 */
import { existsSync, readFileSync, unlinkSync } from "fs";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";

const PERSIST_PATH = stateDir("github-limit.json");
export type GithubRateResource = "graphql" | "rest";

interface GhLimitState {
  backoffUntil: Record<GithubRateResource, number>;
  probe: Record<GithubRateResource, Promise<void> | null>;
}

const state: GhLimitState = ((globalThis as any).__osGhLimitStateV2 ||= {
    backoffUntil: { graphql: 0, rest: 0 },
    probe: { graphql: null, rest: null },
  });

interface PersistedGhLimit {
  id: string;
  backoffUntil: Record<GithubRateResource, number>;
  __version?: number;
}
const GH_LIMIT_COLLECTION = "opensession_github_limits";
const GH_LIMIT_ID = "rate-limits";
const GH_LIMIT_MIGRATION = "github-limit-file-to-managed-feltdb-v1";
let githubLimitDb: StateFirstDB | undefined;
let persistedVersion: number | undefined;
let persistTail: Promise<void> = Promise.resolve();

export async function initializeManagedGithubLimits(
  db: StateFirstDB = githubLimitDb ?? managedFeltDb(),
): Promise<void> {
  githubLimitDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(GH_LIMIT_MIGRATION)) {
    const backoffUntil: PersistedGhLimit["backoffUntil"] = { graphql: 0, rest: 0 };
    if (existsSync(PERSIST_PATH)) {
      const parsed = JSON.parse(readFileSync(PERSIST_PATH, "utf8"));
      const saved = parsed?.resources || { graphql: parsed?.backoffUntil };
      for (const resource of ["graphql", "rest"] as const) {
        if (typeof saved?.[resource] === "number") backoffUntil[resource] = saved[resource];
      }
    }
    await db.transaction((tx) => {
      tx.collection<PersistedGhLimit>(GH_LIMIT_COLLECTION).set(GH_LIMIT_ID,
        { id: GH_LIMIT_ID, backoffUntil }, { requireAbsent: true });
      tx.collection("opensession_migrations").set(GH_LIMIT_MIGRATION,
        { id: GH_LIMIT_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${GH_LIMIT_MIGRATION}` });
  }
  if (existsSync(PERSIST_PATH)) unlinkSync(PERSIST_PATH);
  const saved = await db.collection<PersistedGhLimit>(GH_LIMIT_COLLECTION).get(GH_LIMIT_ID);
  if (!saved) throw new Error("Managed GitHub rate-limit state is missing");
  persistedVersion = saved.__version;
  for (const resource of ["graphql", "rest"] as const) {
    const until = saved.backoffUntil[resource];
    state.backoffUntil[resource] = typeof until === "number" ? until : 0;
    if (state.backoffUntil[resource] > Date.now()) console.error(
      `[github-limit] resuming persisted ${resource} backoff until ${new Date(state.backoffUntil[resource]).toISOString()}`,
    );
  }
}

function persistBackoff(): void {
  const write = persistTail.then(async () => {
    const db = githubLimitDb ?? managedFeltDb();
    const record: PersistedGhLimit = {
      id: GH_LIMIT_ID,
      backoffUntil: { ...state.backoffUntil },
      ...(persistedVersion ? { __version: persistedVersion } : {}),
    };
    await db.transaction((tx) => {
      tx.collection<PersistedGhLimit>(GH_LIMIT_COLLECTION).set(GH_LIMIT_ID, record,
        persistedVersion ? { ifVersion: persistedVersion } : { requireAbsent: true });
    }, { transactionId: `opensession:github-limit:${crypto.randomUUID()}` });
    const saved = await db.collection<PersistedGhLimit>(GH_LIMIT_COLLECTION).get(GH_LIMIT_ID);
    if (!saved) throw new Error("Managed GitHub rate-limit state disappeared after save");
    persistedVersion = saved.__version;
  });
  persistTail = write.catch((error) =>
    console.error("[github-limit] Failed to persist managed backoff:", error));
}

/** Defaults to GraphQL for existing gh-pr callers. REST callers must opt in. */
export function ghRateLimited(resource: GithubRateResource = "graphql"): boolean {
  return Date.now() < state.backoffUntil[resource];
}

export function ghBackoffUntil(resource: GithubRateResource = "graphql"): number {
  return ghRateLimited(resource) ? state.backoffUntil[resource] : 0;
}

export function __setGhBackoffForTest(
  untilEpochMs: number,
  resource: GithubRateResource = "graphql",
): number {
  const prev = state.backoffUntil[resource];
  state.backoffUntil[resource] = untilEpochMs;
  return prev;
}

export function isGhRateLimitMsg(msg: string): boolean {
  return /rate limit|secondary limit|abuse detection/i.test(msg);
}

/** Record a rejection against only the resource that rejected the request. */
export function noteGhRateLimited(
  source: string,
  resetEpochMs?: number,
  resource: GithubRateResource = "graphql",
): void {
  if (resetEpochMs && resetEpochMs > Date.now()) {
    const until = Math.min(resetEpochMs + 30_000, Date.now() + 2 * 3600_000);
    if (until > state.backoffUntil[resource]) {
      state.backoffUntil[resource] = until;
      persistBackoff();
      console.error(
        `[github-limit] ${source}: ${resource} rate-limited; pausing ${resource} calls until ${new Date(until).toISOString()}`,
      );
    }
    return;
  }
  if (ghRateLimited(resource) || state.probe[resource]) return;
  state.backoffUntil[resource] = Date.now() + 15 * 60_000;
  persistBackoff();
  state.probe[resource] = (async () => {
    try {
      const { githubToken } = await import("./github-app");
      const token = await githubToken();
      if (token) {
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "opensession",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const data = await response.json().catch(() => null) as any;
        const key = resource === "rest" ? "core" : "graphql";
        const reset = Number(data?.resources?.[key]?.reset) * 1000;
        if (response.ok && reset > Date.now()) {
          state.backoffUntil[resource] = reset + 30_000;
          persistBackoff();
        }
      }
    } catch {}
    console.error(
      `[github-limit] ${source}: ${resource} rate-limited; pausing ${resource} calls until ${new Date(state.backoffUntil[resource]).toISOString()}`,
    );
    state.probe[resource] = null;
  })();
}

/** Service token for direct REST calls. Missing App authority fails closed. */
export async function botGhToken(
  opts: { write?: boolean } = {},
): Promise<string | null> {
  const { githubToken } = await import("./github-app");
  return githubToken(opts);
}
