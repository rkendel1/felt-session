/**
 * Locating the OpenCode binary — one implementation, because two disagreed.
 *
 * The runner owned this logic, including an nvm scan for the case that
 * actually happens in production: systemd hands the service a trimmed PATH
 * that does not include the node bin dir the engine was installed into. A
 * second, simpler copy in the status check therefore reported "the engine
 * isn't installed" on an instance that was running turns perfectly well —
 * exactly the kind of confidently wrong diagnosis the status check exists to
 * prevent.
 */

import { existsSync, readdirSync } from "fs";
import { homeDir } from "./paths";

const HOME = homeDir();

/** Parse "v20.20.0" / "1.17.15" into a comparable tuple. */
export function versionTuple(value: string): [number, number, number] | undefined {
  const match = value.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/i);
  if (!match) return;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Last resort when PATH has no opencode (systemd's trimmed env): scan the
 *  nvm installs, newest node first, instead of hardcoding one node version —
 *  the pinned v20.20.0 literal goes stale on any node upgrade, and the
 *  Health Monitor's codex fallback died on posix_spawn ENOENT for exactly
 *  that path (2026-07-25). */
function nvmOpencodeScan(): string | undefined {
  const root = `${HOME}/.nvm/versions/node`;
  try {
    const versions = readdirSync(root)
      .map((v) => ({ v, t: versionTuple(v) }))
      .filter((x): x is { v: string; t: [number, number, number] } => !!x.t)
      .sort((a, b) => b.t[0] - a.t[0] || b.t[1] - a.t[1] || b.t[2] - a.t[2]);
    for (const { v } of versions) {
      const p = `${root}/${v}/bin/opencode`;
      if (existsSync(p)) return p;
    }
  } catch {}
  return undefined;
}

/** Where opencode.ai's own installer (and ours) puts it. */
const INSTALLER_PATH = `${HOME}/.opencode/bin/opencode`;

/**
 * The path the runner should exec. Always returns something: when nothing is
 * found it returns the installer's path so the eventual failure names a
 * plausible location rather than an empty string.
 */
export function resolveOpencodeBin(): string {
  return (
    process.env.OPENSESSION_OPENCODE_BIN ||
    Bun.which("opencode") ||
    nvmOpencodeScan() ||
    INSTALLER_PATH
  );
}

/**
 * Same search, but honest about failure: null when no binary exists anywhere
 * we look. This is the one status checks must use — `resolveOpencodeBin`'s
 * hopeful fallback would read as "installed" to a caller testing for null.
 */
export function findOpencodeBin(): string | null {
  const explicit = process.env.OPENSESSION_OPENCODE_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  return Bun.which("opencode") || nvmOpencodeScan() || (existsSync(INSTALLER_PATH) ? INSTALLER_PATH : null);
}
