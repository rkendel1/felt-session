/**
 * Shared on-disk paths for the session store.
 *
 * The active dir resolves once at load, so every module — and every read and
 * write — stays on the same one for the life of the process.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { randomUUIDv7 } from "bun";
import { isLocalProfile, localProfileRoot } from "./profile";

/** The current user's home directory ($HOME wins so tests can repoint it). */
export function homeDir(): string {
  return process.env.HOME || homedir();
}

/**
 * Resolve a state path relative to the state root. A non-empty
 * OPENSESSION_STATE_DIR is an isolated namespace (dev/demo instances,
 * src/server/dev-mode.ts) — every state name resolves strictly under it, so
 * a second instance can never read or write the live instance's home-dir
 * state. Unset ⇒ $HOME. Read at call time so tests can repoint either env.
 */
export function statePath(rel: string): string {
  const root = process.env.OPENSESSION_STATE_DIR || process.env.HOME || homedir();
  return `${root}/${rel}`;
}

/** Sugar for the standard state-dir naming: `stateDir("audit")` →
 *  `~/.opensession-audit`. Works for files too (`stateDir("pins.json")`). */
export function stateDir(base: string): string {
  return statePath(`.opensession-${base}`);
}

function resolveSessionsDir(): string {
  // Env override first (test/verify/conformance suites point it at a scratch
  // dir so sbxtest state files, run dirs and kill-switch checks never touch
  // the live store — set it BEFORE importing any src/server module).
  const fromEnv = process.env.OPENSESSION_SESSIONS_DIR;
  if (fromEnv) return fromEnv;
  // Isolated state namespace (dev/demo instances — see statePath):
  // everything lives under OPENSESSION_STATE_DIR. The run-rpc unix socket
  // derives from this dir, so the isolation also keeps a second instance off
  // the live instance's socket.
  const stateRoot = process.env.OPENSESSION_STATE_DIR;
  if (stateRoot) return `${stateRoot}/.opensession-sessions`;
  if (isLocalProfile()) return `${localProfileRoot()}/sessions`;
  return stateDir("sessions");
}

/** The active session-store dir. */
export let OPENSESSION_SESSIONS_DIR = resolveSessionsDir();

/**
 * Test seam (bun tests only): repoint the session store AFTER this module has
 * been evaluated. ES module bindings are live, so consumers that read
 * `OPENSESSION_SESSIONS_DIR` at THEIR load time (e.g. sessions.ts, which the
 * tests re-import cache-busted) pick the new value up — the env override above
 * only works when it's set before the first import of this module, which a bun
 * test file can't guarantee (file execution order is not alphabetical, and
 * any earlier test file importing the server graph evaluates this module).
 * Returns the previous value so afterAll can restore it.
 */
export function __setSessionsDirForTest(dir: string): string {
  const prev = OPENSESSION_SESSIONS_DIR;
  OPENSESSION_SESSIONS_DIR = dir;
  return prev;
}

/**
 * Names the session store has had. Absolute paths were persisted verbatim by
 * whatever the store was called at the time — walkthrough stills and demo
 * videos, staged composer uploads, `OPENSESSION_VIDEO:` markers in transcripts,
 * media links spliced into PR descriptions — so each rename orphaned every one
 * of them: the path is still in the record, the directory it names is gone.
 */
const LEGACY_SESSIONS_DIR_NAMES = [".opensession-chats", ".backstage-chats"];

/**
 * Map a stored absolute path under a former session-store dir onto the active
 * one. Only rewrites when the stored path is genuinely gone and the remapped
 * one exists, so a legacy dir that still has its own contents keeps winning,
 * and a path outside the store is returned untouched. Callers keep doing their
 * own scoping checks — this resolves a name, it does not grant access.
 */
export function resolveLegacySessionsPath(p: string): string {
  if (!p.startsWith("/")) return p;
  const roots = [process.env.OPENSESSION_STATE_DIR, homeDir()];
  for (const name of LEGACY_SESSIONS_DIR_NAMES) {
    for (const root of roots) {
      if (!root) continue;
      const prefix = `${root}/${name}/`;
      if (!p.startsWith(prefix)) continue;
      const remapped = `${OPENSESSION_SESSIONS_DIR}/${p.slice(prefix.length)}`;
      if (remapped !== p && !existsSync(p) && existsSync(remapped))
        return remapped;
      return p;
    }
  }
  return p;
}

/**
 * Native Open Session session ids are minted as `os-<uuidv7>`. Sessions
 * created before the 2026-08-05 rename carry the original `bks-` prefix —
 * ids are opaque keys into persisted state and external links, so they are
 * never rewritten. This is the ONLY place code may care about the prefix;
 * everything else treats session ids as opaque strings.
 */
export function isNativeSessionId(id: string): boolean {
  return id.startsWith("os-") || id.startsWith("bks-");
}

/** Mint a native session id. */
export function newSessionId(): string {
  return `os-${randomUUIDv7()}`;
}
