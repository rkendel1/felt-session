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
 * Sessions: ~/.opensession-web-sessions.json (0600), sliding 90-day expiry,
 * loaded into a globalThis map so hot reloads keep everyone signed in.
 * Non-browser callers (CDP recipes, curl) authenticate with
 * `Authorization: Bearer <token>` using a token from that file.
 *
 * No `Secure` cookie attribute: TLS terminates at Caddy (the app itself
 * serves plain HTTP on 127.0.0.1, which is also how headless-Chrome test
 * recipes reach it), and the origin is tailnet-only.
 */

import { chmodSync, existsSync, readdirSync, readFileSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import { audit } from "./audit";
import { configuredIdentity } from "./config";
import { githubUserAuthActive } from "./github-auth";
import { homeDir, isNativeSessionId, OPENSESSION_SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { githubLoginFor } from "./shared/user-mappings";
import { isLocalProfile } from "./profile";

const HOME = homeDir();
/** Env override is for tests; read once at first use (the map loads lazily). */
function sessionsPath(): string {
  return process.env.OPENSESSION_WEB_SESSIONS_STORE || `${HOME}/.opensession-web-sessions.json`;
}
const COOKIE_NAME = "opensession_auth";
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // sliding
/** lastSeenAt writes are throttled to this so per-request auth stays cheap. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface WebSession {
  token: string;
  /** GitHub login, verified via GET /user at sign-in. */
  login: string;
  /** Team display name (identity.team) — what runs see as `user`. */
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface WebIdentity {
  login: string;
  name: string;
}

const g = globalThis as any;

function sessions(): Map<string, WebSession> {
  if (!g.__webAuthSessions) {
    const map = new Map<string, WebSession>();
    try {
      const raw = JSON.parse(readFileSync(sessionsPath(), "utf-8"));
      for (const s of raw?.sessions || []) {
        if (s?.token && s?.login && s?.name) map.set(s.token, s);
      }
    } catch {}
    g.__webAuthSessions = map;
  }
  return g.__webAuthSessions;
}

function persist(): void {
  const now = Date.now();
  const map = sessions();
  for (const [token, s] of map) {
    if (now - s.lastSeenAt > TTL_MS) map.delete(token);
  }
  writeJsonAtomic(sessionsPath(), { sessions: [...map.values()] });
  try {
    chmodSync(sessionsPath(), 0o600);
  } catch {}
}

/** Sign-in is required exactly when per-user GitHub auth is opted in. */
export function webAuthRequired(): boolean {
  return !isLocalProfile() && githubUserAuthActive();
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

/** Mint a session for a VERIFIED login. Returns null for non-team logins
 *  (fail-closed — the caller should also discard the OAuth token). */
export function createWebSession(login: string): { token: string; name: string } | null {
  const member = teamMemberForLogin(login);
  if (!member) return null;
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  sessions().set(token, {
    token,
    login,
    name: member.name,
    createdAt: now,
    lastSeenAt: now,
  });
  persist();
  audit({ kind: "web_auth_signin", login, user: member.name });
  return { token, name: member.name };
}

export function destroyWebSession(token: string): void {
  const s = sessions().get(token);
  if (!s) return;
  sessions().delete(token);
  persist();
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
    persist();
    return null;
  }
  if (now - s.lastSeenAt > TOUCH_INTERVAL_MS) {
    s.lastSeenAt = now;
    persist();
  }
  return { login: s.login, name: s.name };
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
 *    is https://os.tella.dev while we see plain HTTP with that Host).
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
  // os.tella.dev host access) is inside the trust boundary of this
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
 * sign-in is active (marker file), atomic per-file, and only ADDS the login
 * field: automation sessions and unresolvable creators are left untouched.
 */
export function migrateSessionsToGithubUser(): void {
  if (!webAuthRequired()) return;
  const marker = `${OPENSESSION_SESSIONS_DIR}/.github-user-migration.json`;
  if (existsSync(marker)) return;
  let scanned = 0;
  let stamped = 0;
  try {
    for (const file of readdirSync(OPENSESSION_SESSIONS_DIR)) {
      // Both id prefixes: `os-` is minted today, `bks-` predates the rename.
      if (!file.endsWith(".json") || !isNativeSessionId(file)) continue;
      const path = `${OPENSESSION_SESSIONS_DIR}/${file}`;
      scanned++;
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (!data || typeof data !== "object") continue;
        if (data.createdByLogin) continue;
        const createdBy: unknown = data.createdBy;
        if (typeof createdBy !== "string" || !createdBy) continue;
        if (createdBy.endsWith(" (automation)")) continue;
        const login = githubLoginFor(createdBy);
        if (!login) continue;
        data.createdByLogin = login;
        writeJsonAtomic(path, data);
        stamped++;
      } catch {}
    }
  } catch (e) {
    console.error("[web-auth] session→github-user migration failed:", e);
    return; // no marker — retry next boot
  }
  writeJsonAtomic(marker, {
    migratedAt: new Date().toISOString(),
    scanned,
    stamped,
  });
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
