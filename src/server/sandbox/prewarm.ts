/**
 * Warm-on-typing sandbox PREWARM pool for sandbox providers (Daytona and the
 * local Firecracker MicroVM today) — the background-agents pattern from
 * the sandbox rollout plan's backlog: "sandbox provisioning starts when the
 * user begins typing".
 *
 * Preparation is provider-specific. Daytona warms its sandbox runner; the
 * local MicroVM restores the credential-free workspace golden and pre-clones
 * the selected repo without installing dependencies. The branch need not
 * exist yet: adoption moves the default-branch clone into the session cwd,
 * refreshes it, then creates the requested branch. The frontend POSTs
 * /api/sandbox/prewarm on first input; session creation atomically adopts the
 * prepared sandbox instead of creating a racing sibling.
 *
 * Paid-compute discipline (this pool creates real remote sandboxes):
 *  - keyed by `provider:repoId`; a live prewarm per key is reused, never
 *    doubled (repeat POSTs while typing just extend the TTL)
 *  - caps: at most ONE bootstrap in flight and `maxLive` (default 2) live
 *    prewarms total — excess requests answer "at-capacity" and stay cold
 *  - TTL (default 10 min) from the last touch; the sweep destroys expired
 *    prewarms PROVIDER-side (adapter.destroy), never just locally
 *  - provider-side backstop: prewarms are created with autoStop/autoDelete
 *    intervals so even a crashed opensession can't leak one forever, and the
 *    sweep periodically audits the provider BY LABEL for orphans this
 *    process doesn't know about
 *  - state lives on globalThis (hot-reload safe) plus one JSON file per
 *    entry under <sessions>/sandbox-prewarm/ so a restarted process can reap
 *    (a restart can't resume the bootstrap promise, so on-disk entries that
 *    aren't in memory are destroyed, not adopted)
 *
 * Claiming is atomic: the in-process Map flip is synchronous (single-threaded
 * — no await between check and set) and the state file is renameSync'd to
 * `*.claimed` as the on-disk arbiter, so two simultaneous session creates
 * can never adopt the same sandbox. A claim whose bootstrap signature
 * (runnerSha/runnerBundleUrl) no longer matches the current config is
 * refused and the stale sandbox destroyed — the caller cold-creates.
 *
 * Docker is deliberately NOT pooled here: its mounts (workspace bind/volume,
 * per-session state volumes) are fixed at `docker create` time so a
 * pre-session container couldn't get them, and a cold docker ensure is
 * ~2-3s anyway. See the note in docker.ts.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { isDevInstance } from "../dev-mode";
import { isLocalProfile } from "../profile";
import { REPOS } from "../worktree";
import { writeJsonAtomic } from "../shared/atomic-write";
import {
  sandboxConfig,
  sandboxesEnabled,
  sandboxPrewarmConfig,
  sandboxProviderConfigured,
  isRemoteSandboxProvider,
} from "./config";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  bootstrapSignature,
  type RemoteDriver,
} from "./adapters/bootstrap";

/** Marks a sandbox as pool-owned (no session yet). Adoption REPLACES the
 *  whole label map with the session labels, so an adopted sandbox stops
 *  matching this immediately — the orphan audit only ever sees unclaimed
 *  pool sandboxes. */
export const PREWARM_LABEL = "opensession.prewarm";
export const PREWARM_KEY_LABEL = "opensession.prewarm.key";

export type PrewarmEntryState = "bootstrapping" | "ready" | "claimed" | "failed";

export interface PrewarmEntry {
  key: string; // `${provider}:${repoId}`
  provider: string;
  repoId: string;
  state: PrewarmEntryState;
  /** prewarmSignature() at prewarm time (runner pin + the provider's
   *  create-shape, e.g. daytona.snapshot); a claim with a different current
   *  signature is refused — stale payload or wrong-sized sandbox. */
  signature: string;
  sandboxId?: string;
  user?: string;
  error?: string;
  createdAt: string;
  lastTouchedAt: string;
  claimedAt?: string;
  claimedBy?: string;
}

/** What the adapters implement so the pool stays provider-agnostic (e2b
 *  registers here later). Loaded lazily — a static import of an adapter
 *  would cycle (daytona.ts imports claimPrewarm from this module). */
export interface PrewarmAdapter {
  /** Create a remote sandbox carrying `labels`, with provider-side
   *  autoStop/autoDelete backstops so a crashed opensession can't leak it. */
  create(
    labels: Record<string, string>,
    opts: { autoStopMinutes: number; autoDeleteMinutes: number },
  ): Promise<{ sandboxId: string; driver: RemoteDriver }>;
  destroy(sandboxId: string): Promise<void>;
  /** Provider-side sandboxes still carrying PREWARM_LABEL, with their
   *  PREWARM_KEY_LABEL (orphan audit — the key scopes who may reap). */
  listPrewarmed(): Promise<Array<{ id: string; key: string }>>;
  /** Provider-specific preparation. Omitted means the legacy full-runner
   * bootstrap, followed by the optional warm-preview workspace clone. */
  prepare?(
    driver: RemoteDriver,
    repo: (typeof REPOS)[string],
    label: string,
  ): Promise<void>;
}

const SWEEP_INTERVAL_MS = 60_000;
/** Don't hammer a broken provider while the user keeps typing. */
const FAILED_RETRY_MS = 90_000;
/** How long a claimed tombstone protects the adopted sandbox from the orphan
 *  audit (covers the claim→relabel window in the adopting ensure()). */
const CLAIMED_GRACE_MS = 15 * 60_000;
const ORPHAN_AUDIT_INTERVAL_MS = 10 * 60_000;
/** Provider-side backstops relative to the pool TTL (crash insurance only —
 *  the sweep normally destroys expired prewarms well before these fire). */
const BACKSTOP_STOP_EXTRA_MIN = 5;
const BACKSTOP_DELETE_MIN = 60;

// ── State (globalThis for --hot survival; files for restart reaping) ────────

function pool(): Map<string, PrewarmEntry> {
  const g = globalThis as unknown as { __sandboxPrewarmPool?: Map<string, PrewarmEntry> };
  return (g.__sandboxPrewarmPool ??= new Map());
}

/** key → the in-flight bootstrap's completion promise (never rejects — the
 *  bootstrap catches into entry.state). Lets an ensure() WAIT for a warming
 *  sandbox instead of cold-creating a racing sibling (claimPrewarmOrWait).
 *  In-memory only: a restarted process can't await it and must cold-create. */
function bootstrapDone(): Map<string, Promise<void>> {
  const g = globalThis as unknown as { __sandboxPrewarmDone?: Map<string, Promise<void>> };
  return (g.__sandboxPrewarmDone ??= new Map());
}

function prewarmDir(): string {
  return `${OPENSESSION_SESSIONS_DIR}/sandbox-prewarm`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function fileFor(entry: Pick<PrewarmEntry, "provider" | "repoId">): string {
  return `${prewarmDir()}/${sanitize(entry.provider)}-${sanitize(entry.repoId)}.json`;
}

function persist(entry: PrewarmEntry): void {
  try {
    mkdirSync(prewarmDir(), { recursive: true });
    writeJsonAtomic(fileFor(entry), entry);
  } catch (e) {
    console.warn(`[sandbox-prewarm] persist(${entry.key}) failed:`, e);
  }
}

function removeFile(entry: Pick<PrewarmEntry, "provider" | "repoId">): void {
  try {
    unlinkSync(fileFor(entry));
  } catch {}
}

/** What must match between prewarm time and claim time for adoption to be
 *  safe: the runner-payload pin (bootstrapSignature) PLUS the provider's
 *  create-shape — daytona's org snapshot decides the sandbox's cpu/mem/disk
 *  and e2b's template its image, neither changeable after create. */
function prewarmSignature(provider: string): string {
  const cfg = sandboxConfig();
  const shape =
    provider === "daytona"
      ? cfg.daytona?.snapshot || "default"
      : provider === "e2b"
        ? cfg.e2b?.template || "base"
        : "";
  return `${bootstrapSignature()}|${shape}`;
}

// ── Adapters (lazy; test-injectable) ────────────────────────────────────────

const testAdapters = new Map<string, PrewarmAdapter | null>();

async function adapterFor(provider: string): Promise<PrewarmAdapter | null> {
  if (testAdapters.has(provider)) return testAdapters.get(provider) ?? null;
  if (provider === "daytona") {
    const { daytonaPrewarmAdapter } = await import("./adapters/daytona");
    return daytonaPrewarmAdapter;
  }
  if (provider === "microvm") {
    const { microvmPrewarmAdapter } = await import("./adapters/microvm");
    return microvmPrewarmAdapter;
  }
  // e2b: no prewarm adapter yet — requests answer "unsupported" until one
  // registers here (the pool itself is already provider-agnostic).
  return null;
}

function destroyLater(provider: string, sandboxId: string, why: string): void {
  void (async () => {
    try {
      const adapter = await adapterFor(provider);
      await adapter?.destroy(sandboxId);
      console.log(`[sandbox-prewarm] destroyed ${provider} prewarm ${sandboxId} (${why})`);
    } catch (e) {
      console.warn(`[sandbox-prewarm] destroy of ${sandboxId} (${why}) failed:`, e);
    }
  })();
}

// ── Requesting (the typing-driven entry point) ──────────────────────────────

export type PrewarmRequestState =
  | "disabled"
  | "unsupported"
  | "bootstrapping"
  | "ready"
  | "failed"
  | "at-capacity";

/**
 * Idempotent + cheap: called on the first keystroke and every ~60s while
 * typing continues. Reuses (and TTL-touches) a live prewarm for the key,
 * starts one when capacity allows, and NEVER awaits the bootstrap — the
 * response is immediate, the work detached.
 */
export async function requestPrewarm(
  provider: string,
  repoId: string,
  user?: string,
): Promise<{ state: PrewarmRequestState; sandboxId?: string }> {
  if (!isRemoteSandboxProvider(provider) || !(repoId in REPOS)) {
    return { state: "unsupported" };
  }
  if (!sandboxesEnabled()) return { state: "disabled" };
  const cfg = sandboxPrewarmConfig();
  if (!cfg.enabled || !sandboxProviderConfigured(provider)) return { state: "disabled" };
  ensurePrewarmSweep();

  const key = `${provider}:${repoId}`;
  const p = pool();
  const entry = p.get(key);
  if (entry && (entry.state === "bootstrapping" || entry.state === "ready")) {
    touchPrewarm(provider, repoId);
    return { state: entry.state, sandboxId: entry.sandboxId };
  }
  if (entry?.state === "failed") {
    if (Date.now() - Date.parse(entry.lastTouchedAt) < FAILED_RETRY_MS) {
      return { state: "failed" };
    }
    p.delete(key);
    removeFile(entry);
  }

  // Caps — this is paid compute.
  const live = [...p.values()].filter(
    (e) => e.state === "bootstrapping" || e.state === "ready",
  );
  if (live.length >= cfg.maxLive) return { state: "at-capacity" };
  if (live.some((e) => e.state === "bootstrapping")) return { state: "at-capacity" };

  const adapter = await adapterFor(provider);
  if (!adapter) return { state: "unsupported" };

  const now = new Date().toISOString();
  const fresh: PrewarmEntry = {
    key,
    provider,
    repoId,
    state: "bootstrapping",
    signature: prewarmSignature(provider),
    user,
    createdAt: now,
    lastTouchedAt: now,
  };
  p.set(key, fresh);
  persist(fresh);
  const done = runPrewarmBootstrap(fresh, adapter);
  bootstrapDone().set(key, done);
  void done.finally(() => {
    if (bootstrapDone().get(key) === done) bootstrapDone().delete(key);
  });
  return { state: "bootstrapping" };
}

/** Extend a live prewarm's TTL (requestPrewarm calls it; exported for
 *  callers that only want to keep an existing prewarm alive). */
export function touchPrewarm(provider: string, repoId: string): void {
  const entry = pool().get(`${provider}:${repoId}`);
  if (!entry || (entry.state !== "bootstrapping" && entry.state !== "ready")) return;
  entry.lastTouchedAt = new Date().toISOString();
  persist(entry);
}

async function runPrewarmBootstrap(entry: PrewarmEntry, adapter: PrewarmAdapter): Promise<void> {
  const current = () => pool().get(entry.key) === entry;
  try {
    const ttl = sandboxPrewarmConfig().ttlMinutes;
    console.log(`[sandbox-prewarm] starting ${entry.key} prewarm (user ${entry.user || "?"})`);
    const { sandboxId, driver } = await adapter.create(
      { [PREWARM_LABEL]: "1", [PREWARM_KEY_LABEL]: entry.key, "opensession.sandbox": "1" },
      {
        autoStopMinutes: ttl + BACKSTOP_STOP_EXTRA_MIN,
        autoDeleteMinutes: BACKSTOP_DELETE_MIN,
      },
    );
    entry.sandboxId = sandboxId;
    if (!current()) {
      // Reaped (TTL) or reset while creating — don't leak the sandbox.
      destroyLater(entry.provider, sandboxId, "superseded mid-create");
      return;
    }
    persist(entry);
    const repo = REPOS[entry.repoId];
    if (!repo) throw new Error(`unknown prewarm repo ${entry.repoId}`);
    if (adapter.prepare) {
      await adapter.prepare(driver, repo, `${entry.provider}-prewarm`);
    } else {
      await assertDialbackReachable(driver, `${entry.provider}-prewarm`);
      await bootstrapRemoteSandbox(driver, `${entry.provider}-prewarm`);
      if (!current()) {
        destroyLater(entry.provider, sandboxId, "superseded mid-bootstrap");
        return;
      }
      // Warm-previews repos ALSO get their workspace pre-cloned at the default
      // branch (+ deps) — the adopting session then just mv's it into place and
      // branches (setupRemoteWorkspace). Non-fatal: a failure leaves a normal
      // runner-only prewarm.
      try {
        const { warmTemplateConfig } = await import("../warm-template");
        if (warmTemplateConfig(entry.repoId).enabled) {
          const { warmRemoteWorkspace } = await import("./adapters/bootstrap");
          await warmRemoteWorkspace(driver, repo, `${entry.provider}-prewarm`);
        }
      } catch (e) {
        console.warn(`[sandbox-prewarm] ${entry.key} warm workspace failed (non-fatal):`, e);
      }
    }
    if (!current()) {
      destroyLater(entry.provider, sandboxId, "superseded mid-warm");
      return;
    }
    entry.state = "ready";
    entry.lastTouchedAt = new Date().toISOString();
    persist(entry);
    console.log(`[sandbox-prewarm] ${entry.key} ready (${sandboxId})`);
  } catch (e) {
    console.warn(`[sandbox-prewarm] ${entry.key} bootstrap failed:`, e);
    if (entry.sandboxId) destroyLater(entry.provider, entry.sandboxId, "bootstrap failed");
    if (current()) {
      entry.state = "failed";
      entry.error = String((e as any)?.message || e).slice(0, 300);
      entry.sandboxId = undefined;
      entry.lastTouchedAt = new Date().toISOString();
      persist(entry);
    }
  }
}

// ── Claiming (adoption — called from the provider's ensure()) ───────────────

/**
 * Atomically claim the ready prewarm for (provider, repoId), or null when
 * there isn't one worth adopting. On success the caller OWNS the sandbox:
 * relabel it to the session and continue with the workspace clone. A stale
 * bootstrap signature refuses the claim and destroys the sandbox (the
 * caller cold-creates). Synchronous — the Map flip plus a state-file rename
 * are the whole arbitration, so two concurrent ensures can't both win.
 */
export function claimPrewarm(
  provider: string,
  repoId: string,
  sessionId: string,
): { sandboxId: string } | null {
  const key = `${provider}:${repoId}`;
  const p = pool();
  const entry = p.get(key);
  if (!entry || entry.state !== "ready" || !entry.sandboxId) return null;
  if (entry.signature !== prewarmSignature(provider)) {
    // Runner pin or provider create-shape changed since this was warmed —
    // never adopt (stale payload / wrong-sized sandbox).
    p.delete(key);
    removeFile(entry);
    destroyLater(provider, entry.sandboxId, "stale bootstrap signature");
    return null;
  }
  // On-disk arbiter: the rename fails for everyone but the first claimant
  // (and for a process whose in-memory state is somehow ahead of disk).
  try {
    renameSync(fileFor(entry), `${fileFor(entry)}.claimed`);
  } catch {
    p.delete(key);
    return null;
  }
  entry.state = "claimed";
  entry.claimedAt = new Date().toISOString();
  entry.claimedBy = sessionId;
  // Tombstone key: frees `key` for a fresh prewarm while still protecting
  // the adopted sandbox from the orphan audit until the grace passes.
  p.delete(key);
  p.set(`${key}#${entry.sandboxId}`, entry);
  return { sandboxId: entry.sandboxId };
}

/**
 * Claim a ready prewarm, or — when one for this key is MID-BOOTSTRAP and
 * young — WAIT for it to finish and then claim. Warm-on-typing reality: the
 * typing→send gap is seconds while the bootstrap is ~20-60s, so a plain
 * claimPrewarm at send time virtually never adopts — ensure() cold-created a
 * RACING SIBLING next to the warming sandbox (2× paid compute, zero benefit;
 * bks-019f4729, 2026-07-09). Waiting the remaining ~15-40s is both faster
 * than a fresh cold create and halves the sandbox count.
 *
 *  - Only waits for entries younger than `maxAgeMs` (default 60s): an older
 *    bootstrapping entry means a pathological cold bun-install — don't hold
 *    the user's prompt hostage on it, cold-create in parallel as before.
 *  - The wait itself is bounded by `maxWaitMs` (default 120s) as a backstop;
 *    a finished-but-failed bootstrap resolves immediately and claims null.
 *  - Two concurrent ensures can both wait; claimPrewarm's atomic arbitration
 *    still lets exactly one adopt — the loser cold-creates.
 */
export async function claimPrewarmOrWait(
  provider: string,
  repoId: string,
  sessionId: string,
  opts?: { maxAgeMs?: number; maxWaitMs?: number },
): Promise<{ sandboxId: string } | null> {
  const claimed = claimPrewarm(provider, repoId, sessionId);
  if (claimed) return claimed;
  const key = `${provider}:${repoId}`;
  const entry = pool().get(key);
  if (!entry || entry.state !== "bootstrapping") return null;
  const age = Date.now() - Date.parse(entry.createdAt);
  if (!Number.isFinite(age) || age > (opts?.maxAgeMs ?? 60_000)) return null;
  const done = bootstrapDone().get(key);
  if (!done) return null; // not ours to await (restarted process)
  console.log(
    `[sandbox-prewarm] ensure(${sessionId.slice(0, 20)}…) waiting for in-flight ${key} prewarm (${Math.round(age / 1000)}s old)…`,
  );
  await Promise.race([
    done,
    new Promise<void>((r) => {
      const t = setTimeout(r, opts?.maxWaitMs ?? 120_000);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
  return claimPrewarm(provider, repoId, sessionId);
}

/** Fire-and-forget destroy for a claimed sandbox the adopter found unusable
 *  (gone/broken on inspection) — keeps paid compute at zero either way. */
export function discardClaimedPrewarm(provider: string, sandboxId: string): void {
  destroyLater(provider, sandboxId, "claimed but unusable");
}

// ── Sweep (TTL + restart reaping + provider-side orphan audit) ──────────────

function knownSandboxIds(provider: string): Set<string> {
  const known = new Set<string>();
  for (const e of pool().values()) {
    if (e.provider === provider && e.sandboxId) known.add(e.sandboxId);
  }
  try {
    const dir = prewarmDir();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(`${sanitize(provider)}-`)) continue;
        try {
          const s = JSON.parse(readFileSync(`${dir}/${f}`, "utf-8"));
          if (s?.sandboxId) known.add(String(s.sandboxId));
        } catch {}
      }
    }
  } catch {}
  return known;
}

/** One sweep pass; exported for tests (inject `now`) and armed on an
 *  interval by ensurePrewarmSweep. Reaps: TTL-expired live prewarms
 *  (provider-side destroy), stale failed/claimed bookkeeping, on-disk
 *  entries a restart orphaned, and — throttled — provider-side sandboxes
 *  still labeled as prewarms that nothing tracks. */
export async function sweepPrewarms(now = Date.now()): Promise<void> {
  const cfg = sandboxPrewarmConfig();
  const ttlMs = cfg.ttlMinutes * 60_000;
  const p = pool();

  for (const [key, entry] of [...p.entries()]) {
    if (entry.state === "bootstrapping" || entry.state === "ready") {
      if (now - Date.parse(entry.lastTouchedAt) > ttlMs) {
        p.delete(key);
        removeFile(entry);
        if (entry.sandboxId) destroyLater(entry.provider, entry.sandboxId, "ttl expired");
        else console.log(`[sandbox-prewarm] dropped ${key} (ttl expired before create)`);
      }
    } else if (entry.state === "failed") {
      if (now - Date.parse(entry.lastTouchedAt) > FAILED_RETRY_MS) {
        p.delete(key);
        removeFile(entry);
      }
    } else if (entry.state === "claimed") {
      // Adopted — session-owned now; never destroy. Just retire the tombstone.
      if (now - Date.parse(entry.claimedAt || entry.lastTouchedAt) > CLAIMED_GRACE_MS) {
        p.delete(key);
        try {
          unlinkSync(`${fileFor(entry)}.claimed`);
        } catch {}
      }
    }
  }

  // Restart reaping: on-disk entries with no in-memory owner. A restarted
  // process can't resume the bootstrap promise or trust the TTL bookkeeping,
  // so these are destroyed, not adopted.
  try {
    const dir = prewarmDir();
    if (existsSync(dir)) {
      const owned = new Set(
        [...p.values()].map((e) => fileFor(e).split("/").pop()!),
      );
      for (const f of readdirSync(dir)) {
        const full = `${dir}/${f}`;
        if (f.endsWith(".json.claimed")) {
          // Adopted before a restart — the session owns the sandbox. Unlink
          // the tombstone once its orphan-audit protection window passed.
          try {
            if (now - statSync(full).mtimeMs > CLAIMED_GRACE_MS) unlinkSync(full);
          } catch {}
          continue;
        }
        if (!f.endsWith(".json") || owned.has(f)) continue;
        try {
          const s = JSON.parse(readFileSync(full, "utf-8"));
          if (s?.sandboxId && typeof s.provider === "string") {
            destroyLater(String(s.provider), String(s.sandboxId), "orphaned by restart");
          }
        } catch {}
        try {
          unlinkSync(full);
        } catch {}
      }
    }
  } catch {}

  await auditProviderOrphans(now);
}

/** Throttled provider-side audit: list sandboxes still carrying
 *  PREWARM_LABEL and destroy any this process doesn't track — closes the
 *  crash window between `create` returning and the id being persisted. */
async function auditProviderOrphans(now: number): Promise<void> {
  const g = globalThis as unknown as { __prewarmOrphanAuditAt?: number };
  if (now - (g.__prewarmOrphanAuditAt || 0) < ORPHAN_AUDIT_INTERVAL_MS) return;
  g.__prewarmOrphanAuditAt = now;
  for (const provider of ["daytona", "e2b", "microvm"]) {
    if (!sandboxProviderConfigured(provider as "daytona" | "e2b" | "microvm")) continue;
    // A create in flight has a live sandbox with no recorded id yet — skip
    // this provider's audit round rather than destroy it mid-bootstrap.
    const creating = [...pool().values()].some(
      (e) => e.provider === provider && e.state === "bootstrapping" && !e.sandboxId,
    );
    if (creating) continue;
    const adapter = await adapterFor(provider);
    if (!adapter) continue;
    let listed: Array<{ id: string; key: string }> = [];
    try {
      listed = await adapter.listPrewarmed();
    } catch {
      continue;
    }
    if (!listed.length) continue;
    const known = knownSandboxIds(provider);
    for (const { id, key } of listed) {
      if (known.has(id)) continue;
      // Only reap keys whose repo THIS process's registry knows: a
      // conformance/verify run (scratch registry) can never destroy the live
      // server's prewarms, and the live server never touches sbxtest ones —
      // each side's own audit cleans its own. Unlabeled/malformed keys have
      // no owner and are fair game.
      const repoId = key.includes(":") ? key.slice(key.indexOf(":") + 1) : "";
      if (repoId && !(repoId in REPOS)) continue;
      console.warn(`[sandbox-prewarm] destroying untracked ${provider} prewarm ${id} (${key || "no key"})`);
      try {
        await adapter.destroy(id);
      } catch (e) {
        console.warn(`[sandbox-prewarm] orphan destroy of ${id} failed:`, e);
      }
    }
  }
}

/** Arm the sweep once per process (globalThis-parked like the other
 *  schedulers, so --hot reloads don't stack timers). Unref'd — it must
 *  never keep a test/CLI process alive on its own. */
export function ensurePrewarmSweep(): void {
  // Dev instances: the sweep destroys sandboxes via live providers shared
  // with production, so it never arms there (same reason as local profile).
  if (isLocalProfile() || isDevInstance()) return;
  const g = globalThis as unknown as { __sandboxPrewarmSweepTimer?: ReturnType<typeof setInterval> };
  if (g.__sandboxPrewarmSweepTimer) return;
  const t = setInterval(() => {
    sweepPrewarms().catch((e) => console.warn("[sandbox-prewarm] sweep failed:", e));
  }, SWEEP_INTERVAL_MS);
  (t as { unref?: () => void }).unref?.();
  g.__sandboxPrewarmSweepTimer = t;
}

// ── Per-user rate limit for the POST route (typing events are client-side
//    debounced, but the server enforces its own ceiling) ────────────────────

export function prewarmRateLimited(user: string, limit = 6, windowMs = 60_000): boolean {
  const g = globalThis as unknown as { __sandboxPrewarmRate?: Map<string, number[]> };
  const m = (g.__sandboxPrewarmRate ??= new Map<string, number[]>());
  const now = Date.now();
  const recent = (m.get(user) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    m.set(user, recent);
    return true;
  }
  recent.push(now);
  m.set(user, recent);
  return false;
}

// ── Test seams ───────────────────────────────────────────────────────────────

export function _setPrewarmAdapterForTest(provider: string, adapter: PrewarmAdapter | null): void {
  testAdapters.set(provider, adapter);
}

export function _resetPrewarmForTest(): void {
  testAdapters.clear();
  pool().clear();
  bootstrapDone().clear();
  const g = globalThis as unknown as {
    __prewarmOrphanAuditAt?: number;
    __sandboxPrewarmRate?: Map<string, number[]>;
  };
  g.__prewarmOrphanAuditAt = 0;
  g.__sandboxPrewarmRate?.clear();
}

export function _prewarmPoolForTest(): Map<string, PrewarmEntry> {
  return pool();
}

/** Stop the sweep interval (test teardown — a leaked timer in a test process
 *  could otherwise run the provider orphan audit against live config). */
export function _stopPrewarmSweepForTest(): void {
  const g = globalThis as unknown as { __sandboxPrewarmSweepTimer?: ReturnType<typeof setInterval> };
  if (g.__sandboxPrewarmSweepTimer) {
    clearInterval(g.__sandboxPrewarmSweepTimer);
    g.__sandboxPrewarmSweepTimer = undefined;
  }
}

// A previous process may have left prewarms behind (state files survive a
// restart) — arm the sweep at load so they're reaped even if nobody types.
try {
  if (existsSync(prewarmDir()) && readdirSync(prewarmDir()).length > 0) {
    ensurePrewarmSweep();
  }
} catch {}
