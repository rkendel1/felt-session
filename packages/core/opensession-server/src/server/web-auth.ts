/**
 * GitHub-backed web sign-in for the UI — active exactly when per-user GitHub
 * auth is opted in (github-auth.ts, config integrations.github.userPrAuth).
 *
 * Off (default): the UI keeps today's localStorage name picker and nothing
 * here runs. On: loading the app requires signing in with GitHub (the same
 * device flow that connects the PR token — one authorize covers both), the
 * server mints an opaque session token in an HttpOnly cookie, and every
 * /api/* request plus the UI WebSocket is 401-gated on it
 * (opensession.ts fetch preamble). The cookie's verified identity also
 * OVERRIDES any client-claimed `user` on the WebSocket (ws-handlers.ts), so
 * attribution/gating stop trusting self-declared names.
 *
 * Only GitHub logins that resolve to a configured team member
 * (identity.team[].github) may sign in — an arbitrary GitHub account bounces
 * even if it completed the OAuth flow (its token is also discarded).
 *
 * Sessions: managed FeltDB records with sliding 90-day expiry,
 * loaded into a globalThis map so hot reloads keep everyone signed in. Human
 * sessions re-resolve their roster row on every request, so a rename follows
 * them immediately and removing the row revokes access. The same store carries
 * one explicitly-labelled Automation identity for local CDP/CLI work; machine
 * callers must never borrow a teammate's session.
 *
 * No `Secure` cookie attribute: TLS terminates at Caddy (the app itself
 * serves plain HTTP on 127.0.0.1, which is also how headless-Chrome test
 * recipes reach it), and the origin is tailnet-only.
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";
import { audit } from "./audit";
import { configuredIdentity } from "./config";
import { githubUserAuthActive } from "./github-auth";
import { OPENSESSION_SESSIONS_DIR, stateDir } from "./paths";
import { githubLoginFor } from "./shared/user-mappings";
import {
  nativeSessionMetadataEntries,
  updateNativeSessionMetadata,
} from "./managed-native-sessions";

/** Env override is for tests; read once at first use (the map loads lazily). */
function sessionsPath(): string {
  return process.env.OPENSESSION_WEB_SESSIONS_STORE || stateDir("web-sessions.json");
}
const COOKIE_NAME = "opensession_auth";
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // sliding
/** lastSeenAt writes are throttled to this so per-request auth stays cheap. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const WEB_SESSIONS_COLLECTION = "opensession_web_sessions";
const WEB_SESSIONS_MIGRATION = "web-sessions-json-to-managed-feltdb-v1";

export interface WebSession {
  token: string;
  /** GitHub login, verified via GET /user at sign-in. */
  login: string;
  /** Team display name (identity.team) — what runs see as `user`. */
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** Omitted for human GitHub sessions; machine auth is explicit and auditable. */
  kind?: "automation";
}

interface StoredWebSession extends WebSession {
  id: string;
  __version?: number;
}

export interface WebIdentity {
  login: string;
  name: string;
  automation?: boolean;
}

/** Whether this request supplied its web session as a bearer credential.
 * Loopback automation must use the machine principal, while a browser on the
 * same Mac still needs to use its human HttpOnly cookie. */
export function webAuthUsesBearer(req: Request): boolean {
  return req.headers.get("authorization")?.startsWith("Bearer ") === true;
}

const g = globalThis as any;
let webSessionsDb: StateFirstDB | undefined;
let webSessionWrites = Promise.resolve();
const sessionId = (token: string) => `web_session_${createHash("sha256").update(token).digest("hex")}`;

function queueWebSessionWrite(work: () => Promise<void>, label: string): void {
  webSessionWrites = webSessionWrites.then(work).catch((error) => {
    console.error(`[web-auth] ${label} failed:`, error);
  });
}

export async function flushWebAuthSessionWrites(): Promise<void> {
  await webSessionWrites;
}

function sessions(): Map<string, WebSession> {
  if (!g.__webAuthSessions) g.__webAuthSessions = new Map<string, WebSession>();
  return g.__webAuthSessions;
}

export async function initializeManagedWebAuthSessions(
  db: StateFirstDB = webSessionsDb ?? managedFeltDb(),
): Promise<void> {
  webSessionsDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(WEB_SESSIONS_MIGRATION)) {
    let legacy: WebSession[] = [];
    if (existsSync(sessionsPath())) {
      const raw = JSON.parse(readFileSync(sessionsPath(), "utf8"));
      legacy = Array.isArray(raw?.sessions) ? raw.sessions : [];
    }
    for (const session of legacy) {
      if (!session?.token || !session.login || !session.name) continue;
      const id = sessionId(session.token);
      await db.transaction((tx) => {
        tx.collection<StoredWebSession>(WEB_SESSIONS_COLLECTION).set(id, { ...session, id, __version: 1 });
      }, { transactionId: `opensession:web-session:migrate:${id}` });
    }
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(WEB_SESSIONS_MIGRATION, { id: WEB_SESSIONS_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${WEB_SESSIONS_MIGRATION}` });
  }
  // Always retry cleanup: the migration receipt can commit just before a
  // process exit, and the legacy file must never survive as hidden authority.
  if (existsSync(sessionsPath())) unlinkSync(sessionsPath());
  const now = Date.now();
  const map = sessions();
  map.clear();
  for (const session of await db.collection<StoredWebSession>(WEB_SESSIONS_COLLECTION).all())
    if (now - session.lastSeenAt <= TTL_MS) map.set(session.token, session);
}

async function upsertWebSession(session: WebSession): Promise<void> {
  const db = webSessionsDb ?? managedFeltDb();
  const id = sessionId(session.token);
  const current = await db.collection<StoredWebSession>(WEB_SESSIONS_COLLECTION).get(id);
  if (current && !Number.isSafeInteger(current.__version))
    throw new Error(`Web session ${id} has no FeltDB authority version`);
  await db.transaction((tx) => {
    tx.collection<StoredWebSession>(WEB_SESSIONS_COLLECTION).set(id, { ...session, id },
      current ? { ifVersion: current.__version } : { requireAbsent: true });
  }, { transactionId: `opensession:web-session:upsert:${id}:${crypto.randomUUID()}` });
}

async function deleteWebSessionRecord(token: string): Promise<void> {
  const db = webSessionsDb ?? managedFeltDb();
  const id = sessionId(token);
  const current = await db.collection<StoredWebSession>(WEB_SESSIONS_COLLECTION).get(id);
  if (!current || !Number.isSafeInteger(current.__version)) return;
  await db.transaction((tx) => {
    tx.collection<StoredWebSession>(WEB_SESSIONS_COLLECTION).delete(id, { ifVersion: current.__version });
  }, { transactionId: `opensession:web-session:delete:${id}:${current.__version}` });
}

/** Sign-in is required exactly when per-user GitHub auth is opted in. */
export function webAuthRequired(): boolean {
  return githubUserAuthActive();
}

/**
 * Ensure local tooling has a machine principal of its own.
 *
 * It deliberately lives in the existing 0600 session store so CDP scripts can
 * read it without another secret-distribution mechanism. Unlike a human web
 * session it has no team/GitHub identity, so per-user credentials fail closed
 * and attribution says Automation. Hosted loopback requests enforce this kind
 * in opensession.ts; possessing a human cookie is not enough there.
 */
export async function ensureAutomationWebSession(): Promise<{ token: string } | null> {
  if (!webAuthRequired()) return null;
  const map = sessions();
  const now = Date.now();
  for (const [token, session] of map) {
    if (session.kind !== "automation") continue;
    if (now - session.lastSeenAt <= TTL_MS) {
      session.lastSeenAt = now;
      await upsertWebSession(session);
      return { token };
    }
    map.delete(token);
    await deleteWebSessionRecord(token);
  }
  const token = randomBytes(32).toString("hex");
  const session: WebSession = {
    token,
    login: "opensession-automation",
    name: "Automation",
    createdAt: now,
    lastSeenAt: now,
    kind: "automation",
  };
  await upsertWebSession(session);
  map.set(token, session);
  return { token };
}

/** Route-scoped machine auth for the headless macropad bridge. */
export function keypadBearerAuthorized(req: Request): boolean {
  const expected = process.env.KEYPAD_TOKEN;
  if (!expected) return false;

  const match = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const presented = Buffer.from(match[1]);
  const configured = Buffer.from(expected);
  return presented.length === configured.length && timingSafeEqual(presented, configured);
}

/** The configured team member a GitHub login belongs to, or null. */
export function teamMemberForLogin(login: string): { name: string } | null {
  const lower = login.toLowerCase();
  const m = configuredIdentity().team.find(
    (t) => t.github?.toLowerCase() === lower,
  );
  return m ? { name: m.name } : null;
}

/** Re-resolve a verified identity against the live roster. Human membership
 *  can change while an HTTP session or WebSocket is still open. */
export function refreshWebIdentity(identity: WebIdentity): WebIdentity | null {
  if (identity.automation || !webAuthRequired()) return identity;
  const member = teamMemberForLogin(identity.login);
  return member ? { login: identity.login, name: member.name } : null;
}

/** Mint a session for a VERIFIED login. Returns null for non-team logins
 *  (fail-closed — the caller should also discard the OAuth token). */
export async function createWebSession(login: string): Promise<{ token: string; name: string } | null> {
  const member = teamMemberForLogin(login);
  if (!member) return null;
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const session: WebSession = {
    token,
    login,
    name: member.name,
    createdAt: now,
    lastSeenAt: now,
  };
  await upsertWebSession(session);
  sessions().set(token, session);
  audit({ kind: "web_auth_signin", login, user: member.name });
  return { token, name: member.name };
}

export async function destroyWebSession(token: string): Promise<void> {
  const s = sessions().get(token);
  if (!s) return;
  sessions().delete(token);
  await flushWebAuthSessionWrites();
  await deleteWebSessionRecord(token);
  audit({ kind: "web_auth_signout", login: s.login, user: s.name });
}

function tokenFromRequest(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE_NAME && v.length) return v.join("=");
    }
  }
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
}

/** The verified identity on a request, or null. Sliding expiry. */
export function resolveWebAuth(req: Request): WebIdentity | null {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const s = sessions().get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeenAt > TTL_MS) {
    sessions().delete(token);
    queueWebSessionWrite(() => deleteWebSessionRecord(token), "expiry cleanup");
    return null;
  }
  let changed = false;
  const refreshed = refreshWebIdentity({
    login: s.login,
    name: s.name,
    ...(s.kind === "automation" ? { automation: true } : {}),
  });
  if (!refreshed) {
    sessions().delete(token);
    queueWebSessionWrite(() => deleteWebSessionRecord(token), "revocation cleanup");
    audit({
      kind: "web_auth_signout",
      login: s.login,
      user: s.name,
      reason: "removed_from_roster",
    });
    return null;
  }
  if (s.name !== refreshed.name) {
    const previousName = s.name;
    s.name = refreshed.name;
    changed = true;
    audit({
      kind: "web_auth_identity_refresh",
      login: s.login,
      user: refreshed.name,
      previousName,
    });
  }
  if (now - s.lastSeenAt > TOUCH_INTERVAL_MS) {
    s.lastSeenAt = now;
    changed = true;
  }
  if (changed) queueWebSessionWrite(() => upsertWebSession(s), "session touch");
  return {
    ...refreshed,
    name: s.name,
  };
}

export function webAuthSetCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`;
}

export function webAuthClearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** The request's own session token (for logout). */
export function webAuthToken(req: Request): string | null {
  return tokenFromRequest(req);
}

// ── Cross-site request rejection (CSRF belt-and-braces) ──────────────────────

/**
 * Reject browser-originated cross-site requests: state-changing API calls and
 * the UI WebSocket upgrade must come from our own origin. SameSite=Lax on the
 * auth cookie already blocks most CSRF, but (a) deployments without sign-in
 * (webAuthRequired() false) have no cookie gating at all — any page in a
 * tailnet user's browser could fire POSTs at us — and (b) an explicit origin
 * check also covers same-site-but-different-origin callers and future cookie
 * regressions. Fail-open for non-browser callers: curl/CDP/server-to-server
 * requests carry neither Sec-Fetch-Site nor Origin and pass through (Bearer
 * auth still applies to them separately).
 *
 * Rules, in order:
 *  - Sec-Fetch-Site: "cross-site" → reject; "same-origin"/"none" → allow.
 *  - Otherwise, if an Origin header is present its host must equal the
 *    request's Host (scheme-insensitive: Caddy terminates TLS, so the origin
 *    is the public HTTPS origin while we see plain HTTP with that Host).
 */
export function crossSiteViolation(req: Request): string | null {
  // Explicit-Authorization requests cannot be CSRF — a browser never attaches
  // that header on another site's behalf; whoever sent it holds the token.
  // This is how the Chrome extension (os1-chrome) and other native clients
  // mutate state: their fetches carry a chrome-extension:// (or app) Origin
  // that would fail the host check below.
  if (req.headers.get("authorization")?.startsWith("Bearer ")) return null;
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return "cross-site request";
  if (fetchSite === "same-origin" || fetchSite === "none") return null;
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") {
    // "null" Origin (sandboxed iframe / data: page) never legitimately calls
    // us; absent Origin = non-browser caller.
    return origin === "null" ? "null origin" : null;
  }
  // Extension pages, pre-token: os1-chrome's device-flow start/poll POSTs
  // happen before it has a Bearer token. Chrome only lets an extension reach
  // us at all when it holds host permissions for this host, and the auth
  // endpoints those calls hit don't act on the cookie — the residual risk
  // (a cookie-riding mutation from a rogue extension the user installed with
  // access to the instance host) is inside the trust boundary of this
  // tailnet-only deployment.
  if (origin.startsWith("chrome-extension://")) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return "malformed origin";
  }
  const host = req.headers.get("host");
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) {
    return `origin host ${originHost} != ${host || "(no host)"}`;
  }
  return null;
}

// ── One-time migration: link existing sessions to GitHub logins ──────────────

/**
 * Backfill `createdByLogin` on existing session files by resolving their
 * `createdBy` (historical picker first names) through the SAME
 * identity table the sign-in uses — so sessions created before GitHub auth
 * belong to the same verified person afterwards. Runs once at boot when
 * sign-in is active (FeltDB migration receipt), atomic per-file, and only ADDS the login
 * field: automation sessions and unresolvable creators are left untouched.
 */
export async function migrateSessionsToGithubUser(): Promise<void> {
  if (!webAuthRequired()) return;
  const db = webSessionsDb ?? managedFeltDb();
  const migrationId = "session-created-by-github-login-v1";
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (await migrations.get(migrationId)) return;
  const marker = `${OPENSESSION_SESSIONS_DIR}/.github-user-migration.json`;
  if (existsSync(marker)) {
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(migrationId, { id: migrationId, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${migrationId}` });
    unlinkSync(marker);
    return;
  }
  let scanned = 0;
  let stamped = 0;
  try {
    for (const [id, data] of nativeSessionMetadataEntries()) {
      if (!data.id || data.id !== id) continue;
      scanned++;
      if (data.createdByLogin) continue;
      const createdBy: unknown = data.createdBy;
      if (typeof createdBy !== "string" || !createdBy) continue;
      if (createdBy.endsWith(" (automation)")) continue;
      const login = githubLoginFor(createdBy);
      if (!login) continue;
      let applied = false;
      await updateNativeSessionMetadata(id, (current) => {
        if (current.createdByLogin) return current;
        applied = true;
        return { ...current, createdByLogin: login };
      });
      if (applied) stamped++;
    }
  } catch (e) {
    console.error("[web-auth] session→github-user migration failed:", e);
    return; // no migration receipt, so retry next boot
  }
  await db.transaction((tx) => {
    tx.collection("opensession_migrations").set(migrationId, {
      id: migrationId,
      completedAt: Date.now(),
      scanned,
      stamped,
    }, { requireAbsent: true });
  }, { transactionId: `opensession:migration:${migrationId}` });
  // Lazy: session-cache statically imports runner internals, which test
  // processes must never load (the bun-test rpc-socket trap).
  import("./session-cache")
    .then((m) => m.invalidateSessionsCache())
    .catch(() => {});
  audit({ kind: "web_auth_session_migration", scanned, stamped });
  console.log(
    `[web-auth] linked ${stamped}/${scanned} existing sessions to GitHub logins`,
  );
}
