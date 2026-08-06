/**
 * Codex account pool for opensession runs — the OpenAI-side sibling of
 * claude-accounts.ts.
 *
 * Two credential kinds:
 *  - "api_key": an OpenAI API key, injected via the SDK's `apiKey` option
 *    (usage billed to the platform org).
 *  - "home": a CODEX_HOME directory containing an auth.json from
 *    `codex login` on a ChatGPT plan. Runs get CODEX_HOME pointed at it, so
 *    each account keeps its own auth/refresh state. The VPS's own login at
 *    ~/.codex stays untouched unless no accounts are configured, in which
 *    case runs fall back to it.
 *
 * There's no public usage endpoint for Codex plans, so unlike the Claude pool
 * there's no utilization polling — rotation is least-recently-picked, with
 * accounts sidelined for a cool-off when a run hits a rate/usage limit.
 */

import { homeDir } from "./paths";
import { chmodSync, existsSync, readFileSync, readdirSync } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { userMatchesAny } from "./shared/user-mappings";

let HOME = homeDir();
let STORE_PATH = stateDir("codex-accounts.json");
const DEFAULT_EXHAUST_MS = 60 * 60 * 1000;
// Bridge-wedge sideline: much shorter than a usage-limit window — wedges
// usually clear once the account's proxy respawns.
const WEDGE_SIDELINE_MS = 5 * 60 * 1000;

/**
 * Test seam (bun tests only): repoint codexHomes()'s VPS-account entry
 * (`${HOME}/.codex`) AFTER this module has been evaluated — mirrors
 * paths.ts's __setSessionsDirForTest. ES module bindings are live, so
 * consumers that reference codexHomes() (including callers that bare-
 * imported this module before the test set process.env.HOME) pick the new
 * value up regardless of import order. Returns the previous value so
 * afterAll can restore it.
 */
export function __setCodexHomeForTest(dir: string): string {
  const prev = HOME;
  HOME = dir;
  return prev;
}

export interface CodexAccount {
  id: string;
  name: string;
  kind: "api_key" | "home";
  /** API key (kind=api_key) or CODEX_HOME directory path (kind=home). */
  value: string;
  /** Personal account: only this person's runs may use it (and their runs
   *  prefer it over the shared pool). Unset = shared pool account. Matched
   *  via userMatchesAny (same identity table as commit attribution). */
  owner?: string;
  createdAt: string;
}

export interface CodexAccountPublic {
  id: string;
  name: string;
  kind: "api_key" | "home";
  valueMasked: string;
  owner?: string;
  mode: "shared" | "personal";
  createdAt: string;
  exhaustedUntil: string | null;
  usable: boolean;
}

const exhaustedUntil = new Map<string, number>();
const lastPickedAt = new Map<string, number>();

// Sideline state is load-bearing for rotation (2026-07-17: a restart cleared
// the in-memory map and the picker immediately re-handed out an exhausted
// account), so it persists across restarts AND hot reloads (plain module
// maps reset on reload — the hydrate below restores them from disk).
let STATE_PATH = STORE_PATH.replace(/\.json$/, "-state.json");

/** Test seam: isolate the account and sideline stores from the live pool. */
export function __setCodexAccountsPathForTest(path: string): string {
  const previous = STORE_PATH;
  STORE_PATH = path;
  STATE_PATH = path.replace(/\.json$/, "-state.json");
  exhaustedUntil.clear();
  lastPickedAt.clear();
  return previous;
}

function persistExhausted(): void {
  try {
    const out: Record<string, number> = {};
    const now = Date.now();
    for (const [k, until] of exhaustedUntil) if (until > now) out[k] = until;
    writeFileAtomic(STATE_PATH, JSON.stringify({ exhaustedUntil: out }) + "\n");
    chmodSync(STATE_PATH, 0o600);
  } catch (e) {
    console.warn("[codex-accounts] sideline persist failed:", e);
  }
}

try {
  if (existsSync(STATE_PATH)) {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    const now = Date.now();
    for (const [k, until] of Object.entries(parsed?.exhaustedUntil || {})) {
      if (typeof until === "number" && until > now) exhaustedUntil.set(k, until);
    }
  }
} catch {}

/** Rendezvous (HRW) score — FNV-1a 32-bit over sessionKey + accountId.
 *  Deterministic and dependency-free, so session→account affinity survives
 *  restarts with NO stored map, and a sidelined account's sessions reassign
 *  automatically (highest-scoring remaining candidate) and return home when
 *  it recovers. Pin-tested: changing this function reshuffles every session's
 *  account and cold-starts their provider prompt caches — never change it
 *  casually. (Pattern from meridian PR #615.) */
export function hrwScore(sessionKey: string, accountId: string): number {
  let h = 0x811c9dc5;
  const s = `${sessionKey}\0${accountId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function readStore(): CodexAccount[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (e) {
    console.error("[codex-accounts] Failed to read store:", e);
    return [];
  }
}

function writeStore(accounts: CodexAccount[]): void {
  writeFileAtomic(STORE_PATH, JSON.stringify({ accounts }, null, 2) + "\n");
  chmodSync(STORE_PATH, 0o600);
}

function maskValue(account: CodexAccount): string {
  if (account.kind === "home") return account.value; // a path, not a secret
  const v = account.value;
  if (v.length <= 12) return "…";
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
}

function exhaustionKey(id: string, model?: string): string {
  return model ? `${id}:${model}` : id;
}

function isExhaustionKeyActive(key: string): boolean {
  const until = exhaustedUntil.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    exhaustedUntil.delete(key);
    return false;
  }
  return true;
}

function isExhausted(id: string, model?: string): boolean {
  return (
    isExhaustionKeyActive(exhaustionKey(id)) ||
    (model ? isExhaustionKeyActive(exhaustionKey(id, model)) : false)
  );
}

function toPublic(a: CodexAccount): CodexAccountPublic {
  const until = exhaustedUntil.get(a.id);
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    valueMasked: maskValue(a),
    owner: a.owner,
    mode: a.owner ? "personal" : "shared",
    createdAt: a.createdAt,
    exhaustedUntil: until !== undefined && until > Date.now() ? new Date(until).toISOString() : null,
    usable: !isExhausted(a.id),
  };
}

export function listCodexAccountsPublic(): CodexAccountPublic[] {
  return readStore().map(toPublic);
}

export function getCodexAccountById(id: string): CodexAccount | undefined {
  return readStore().find((account) => account.id === id);
}

export function getUsableCodexAccountById(
  id: string,
  model?: string
): CodexAccount | undefined {
  const account = getCodexAccountById(id);
  return account && !isExhausted(account.id, model) ? account : undefined;
}

export function hasCodexAccounts(): boolean {
  return readStore().length > 0;
}

export function addCodexAccount(
  name: string,
  kind: "api_key" | "home",
  value: string,
  owner?: string
): CodexAccountPublic | { error: string } {
  const trimmedName = name.trim();
  const trimmedValue = value.trim();
  if (!trimmedName) return { error: "Name is required" };
  if (!trimmedValue) return { error: "Value is required" };

  if (kind === "api_key" && !/^sk-/.test(trimmedValue)) {
    return { error: "API key doesn't look like an OpenAI key (expected sk-…)." };
  }
  if (kind === "home") {
    if (!existsSync(`${trimmedValue}/auth.json`)) {
      return {
        error:
          `No auth.json found in "${trimmedValue}". Run \`CODEX_HOME=${trimmedValue} codex login\` ` +
          "on the VPS first (or copy an existing ~/.codex/auth.json into it).",
      };
    }
  }

  const accounts = readStore();
  if (accounts.some((a) => a.name === trimmedName)) {
    return { error: `An account named "${trimmedName}" already exists` };
  }
  if (accounts.some((a) => a.value === trimmedValue)) {
    return { error: "This credential is already registered" };
  }

  const account: CodexAccount = {
    id: crypto.randomUUID(),
    name: trimmedName,
    kind,
    value: trimmedValue,
    ...(owner?.trim() ? { owner: owner.trim() } : {}),
    createdAt: new Date().toISOString(),
  };
  writeStore([...accounts, account]);
  console.log(`[codex-accounts] Added ${kind} account ${trimmedName}`);
  return toPublic(account);
}

export function removeCodexAccount(id: string): boolean {
  const accounts = readStore();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  writeStore(next);
  exhaustedUntil.delete(id);
  lastPickedAt.delete(id);
  return true;
}

/** Set or clear (empty/undefined) an account's personal owner. */
export function setCodexAccountOwner(
  id: string,
  owner: string | undefined
): CodexAccountPublic | null {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const next = { ...accounts[idx] };
  const trimmed = owner?.trim() || undefined;
  if (trimmed) next.owner = trimmed;
  else delete next.owner;
  accounts[idx] = next;
  writeStore(accounts);
  return toPublic(next);
}

/**
 * Pick an account for a run. With a `sessionKey`: rendezvous-hash affinity —
 * the same session keeps landing on the same account (per-account provider
 * prompt caches stay warm) until that account is sidelined, then reassigns
 * deterministically. Without one: least-recently-picked among the
 * non-sidelined (one-shots, account-less callers). With a `user`: the run
 * user's own personal (owner-matching) accounts are preferred whenever one is
 * usable, and other users' personal accounts are never eligible; no user
 * (automations, one-shots) means shared-pool (owner-less) accounts only —
 * fail-closed, mirroring claude-accounts.pickAccount. Returns undefined when
 * none are usable — the run then falls back to the VPS's own ~/.codex login.
 */
export function pickCodexAccount(
  exclude?: Set<string>,
  model?: string,
  sessionKey?: string,
  out?: { reason?: string },
  user?: string
): CodexAccount | undefined {
  const usable = readStore().filter((a) => !exclude?.has(a.id) && !isExhausted(a.id, model));
  const personal = user
    ? usable.filter((a) => a.owner && userMatchesAny(user, [a.owner]))
    : [];
  const candidates = personal.length ? personal : usable.filter((a) => !a.owner);
  if (candidates.length === 0) return undefined;
  let picked: CodexAccount;
  if (sessionKey) {
    picked = candidates
      .map((a) => ({ a, s: hrwScore(sessionKey, a.id) }))
      .sort((x, y) => y.s - x.s || (x.a.id < y.a.id ? -1 : 1))[0].a;
    if (out) out.reason = picked.owner ? "personal-hrw" : "sticky-hrw";
  } else {
    picked = candidates
      .map((a) => ({ a, picked: lastPickedAt.get(a.id) ?? 0 }))
      .sort((x, y) => x.picked - y.picked)[0].a;
    if (out) out.reason = picked.owner ? "personal-lru" : "pool-lru";
  }
  lastPickedAt.set(picked.id, Date.now());
  return picked;
}

/** All configured accounts (with secrets — server-side use only). */
export function listCodexAccounts(): CodexAccount[] {
  return readStore();
}

/**
 * Every CODEX_HOME where threads may live: the VPS's own ~/.codex (used by
 * api_key accounts and account-less runs) plus each home-kind account dir.
 */
export function codexHomes(): Array<{ home: string; account?: CodexAccount }> {
  const out: Array<{ home: string; account?: CodexAccount }> = [
    { home: `${HOME}/.codex` },
  ];
  for (const a of readStore()) {
    if (a.kind === "home") out.push({ home: a.value, account: a });
  }
  return out;
}

/** uuidv7 thread ids encode their creation time in the first 48 bits. */
function uuidv7Ms(id: string): number | null {
  const hex = id.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  return parseInt(hex, 16);
}

/**
 * Locate a thread's rollout jsonl (sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl)
 * across all CODEX_HOMEs, and which account owns it. Checks the uuidv7-derived
 * day ± 1 to be safe around midnight.
 */
export function findCodexRollout(
  threadId: string
): { path: string; account?: CodexAccount } | null {
  const ms = uuidv7Ms(threadId);
  if (!ms) return null;
  const days: string[] = [];
  for (const delta of [0, -1, 1]) {
    const d = new Date(ms + delta * 86_400_000);
    days.push(
      `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`
    );
  }
  for (const { home, account } of codexHomes()) {
    for (const day of days) {
      const dir = `${home}/sessions/${day}`;
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(`-${threadId}.jsonl`)) return { path: `${dir}/${f}`, account };
        }
      } catch {}
    }
  }
  return null;
}

/** Sideline an account after a run hit a rate/usage limit. */
export function markCodexExhausted(id: string, model?: string): void {
  const account = readStore().find((a) => a.id === id);
  const until = Date.now() + DEFAULT_EXHAUST_MS;
  exhaustedUntil.set(exhaustionKey(id, model), until);
  persistExhausted();
  console.warn(
    `[codex-accounts] ${account?.name || id}${model ? ` (${model})` : ""} marked exhausted until ${new Date(until).toISOString()}`
  );
}

/**
 * Briefly sideline an account whose engine bridge wedged (new provider
 * requests hang while established streams keep flowing). The wedge is
 * account-scoped — every model through the same bridge hangs — so retries and
 * other sessions' picks must land elsewhere. Account-level key: no model
 * scoping. Returns false without touching an existing longer sideline, so the
 * caller's clearCodexWedge rollback can never shorten a usage-limit sideline.
 */
export function markCodexWedged(id: string): boolean {
  const until = Date.now() + WEDGE_SIDELINE_MS;
  const existing = exhaustedUntil.get(exhaustionKey(id));
  if (existing !== undefined && existing >= until) return false;
  const account = readStore().find((a) => a.id === id);
  exhaustedUntil.set(exhaustionKey(id), until);
  persistExhausted();
  console.warn(
    `[codex-accounts] ${account?.name || id} sidelined until ${new Date(until).toISOString()} after a bridge wedge`
  );
  return true;
}

/** Rollback partner of markCodexWedged for the no-alternative case: with no
 *  other account to rotate to, a same-account respawn retry beats a dry pool.
 *  Only call after markCodexWedged returned true. */
export function clearCodexWedge(id: string): void {
  exhaustedUntil.delete(exhaustionKey(id));
  persistExhausted();
}
