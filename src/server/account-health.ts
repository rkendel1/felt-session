/**
 * Account-auth health monitor — Slack notifications for credential expiry.
 *
 * The Claude subscription pool and the codex (OpenAI) pool both authenticate
 * runs with credentials a human must occasionally renew, and until now they
 * rotted silently: the codex `tella-dev` auth.json sat expired for 10+ days
 * (2026-07-12) and only surfaced when the model-fallback chain dead-ended on
 * it mid-outage. This module sweeps both pools hourly and DMs the person who
 * can fix each problem:
 *
 *  - Claude account with an `owner` (personal sub) → DM that teammate
 *    (resolved through the same identity table as commit attribution).
 *  - Pool Claude accounts and all codex accounts → DM the instance owner.
 *
 * Detected issues: unreadable/expired Claude OAuth credential files, revoked
 * setup-tokens (401 from the usage endpoint), Claude refresh tokens within a
 * week of expiry, and codex ChatGPT access tokens expired or within a day of
 * expiry. The sweep first runs refreshIdleCodexTokens (codex-token-refresh.ts)
 * so a codex expiry alert only ever fires when the in-process refresh itself
 * failed (dead refresh token, endpoint trouble).
 *
 * Alerts dedupe through a state file: a standing issue re-alerts daily, and
 * clears silently once fixed. Transient poller noise (rate-limit cooldowns)
 * is never alerted.
 */

import { existsSync, readFileSync } from "fs";
import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { refreshIdleCodexTokens } from "./codex-token-refresh";
import { stateDir } from "./paths";
import { resolveTeammate } from "./shared/user-mappings";
import { writeFileAtomic } from "./shared/atomic-write";
import { openDirectMessage, sendSlackMessage } from "../agents/slack/slack-api";
import { audit } from "./audit";
import {
  configuredIdentity,
  configuredIntegration,
  githubBotLogins,
  githubWriteOwners,
  personaName,
} from "./config";

const STATE_PATH = stateDir("account-health.json");
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Let the usage poller populate its cache before the first sweep reads it.
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;
const REALERT_MS = 24 * 60 * 60 * 1000;
const CLAUDE_REFRESH_WARN_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_ACCESS_WARN_MS = 24 * 60 * 60 * 1000;
const configuredHealthOwner = configuredIntegration("accountHealth").notifyUser;
// Pool-wide alerts go to the configured owner, then the first directory entry.
const FALLBACK_TEAMMATE =
  (typeof configuredHealthOwner === "string" ? configuredHealthOwner : "") ||
  configuredIdentity().team[0]?.aliases?.[0] ||
  configuredIdentity().team[0]?.name ||
  "";

interface Issue {
  /** Stable dedupe key: pool:accountId:kind. */
  key: string;
  /** Slack-DM body (already prefixed with the configured persona). */
  message: string;
  /** Teammate ref to DM (name/alias/Slack id); pool issues use the fallback. */
  notify: string;
}

interface HealthState {
  alerts: Record<string, { lastSentAt: string }>;
}

function readState(): HealthState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return { alerts: parsed?.alerts && typeof parsed.alerts === "object" ? parsed.alerts : {} };
  } catch {
    return { alerts: {} };
  }
}

function writeState(state: HealthState): void {
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/** ms-epoch expiry from a JWT's `exp` claim, or null if unparseable. */
function jwtExpMs(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function days(ms: number): string {
  const d = ms / (24 * 60 * 60 * 1000);
  return d >= 2 ? `${Math.floor(d)} days` : `${Math.max(1, Math.round(ms / (60 * 60 * 1000)))}h`;
}

function claudeIssues(): Issue[] {
  const issues: Issue[] = [];
  for (const a of listAccountsPublic()) {
    const who = a.owner || FALLBACK_TEAMMATE;
    const label = a.owner ? `your personal Claude sub "${a.name}"` : `pool Claude account "${a.name}"`;
    const err = a.usage?.error || "";
    const relogin = a.credentialsPath?.includes(".opensession-claude-oauth")
      ? `Reconnect it in Settings → Models → account menu → "Sign in with Claude".`
      : a.credentialsPath
        ? `Re-login on the VPS: \`CLAUDE_CONFIG_DIR=${a.credentialsPath.replace(/\/credentials\.json$/, "")} claude login\` — or switch it to the web flow: Settings → Models → account menu → "Sign in with Claude".`
        : "Generate a fresh token with `claude setup-token` and update it in Settings → Models.";

    if (a.usage?.errorStatus === 401) {
      issues.push({
        key: `claude:${a.id}:revoked`,
        message: `It's ${personaName()} — ${label} has a revoked/invalid token (401 from Anthropic). Runs on it will fail. ${relogin}`,
        notify: who,
      });
      continue;
    }
    if (err.includes("Couldn't read OAuth credentials")) {
      issues.push({
        key: `claude:${a.id}:creds-missing`,
        message: `It's ${personaName()} — ${label} points at an OAuth credentials file I can't read (${a.credentialsPath}). Usage tracking is blind for it. ${relogin}`,
        notify: who,
      });
      continue;
    }
    if (err.includes("expired and refresh failed")) {
      issues.push({
        key: `claude:${a.id}:creds-expired`,
        message: `It's ${personaName()} — ${label}: its OAuth credentials expired and the refresh failed. ${relogin}`,
        notify: who,
      });
      continue;
    }
    // Look-ahead: a refresh token near expiry means a forced re-login soon.
    if (a.credentialsPath && existsSync(a.credentialsPath)) {
      try {
        const creds = JSON.parse(readFileSync(a.credentialsPath, "utf-8"))?.claudeAiOauth;
        const refreshExp = Number(creds?.refreshTokenExpiresAt) || 0;
        if (refreshExp > 0) {
          const left = refreshExp - Date.now();
          if (left <= 0) {
            issues.push({
              key: `claude:${a.id}:refresh-expired`,
              message: `It's ${personaName()} — ${label}: its OAuth refresh token has expired; the next access-token refresh will fail. ${relogin}`,
              notify: who,
            });
          } else if (left < CLAUDE_REFRESH_WARN_MS) {
            issues.push({
              key: `claude:${a.id}:refresh-expiring`,
              message: `It's ${personaName()} — heads-up: ${label}'s OAuth refresh token expires in ${days(left)}. ${relogin}`,
              notify: who,
            });
          }
        }
      } catch {
        // Unreadable file is caught by the poller error branch above next sweep.
      }
    }
  }
  return issues;
}

function codexIssues(): Issue[] {
  const issues: Issue[] = [];
  for (const a of listCodexAccountsPublic()) {
    if (a.kind !== "home") continue; // API keys don't expire on a clock.
    const home = a.valueMasked; // for kind=home this is the CODEX_HOME path
    const fix = `Fix on the VPS: \`CODEX_HOME=${home} codex login\` (or copy a fresh ~/.codex/auth.json into ${home}/).`;
    const authPath = `${home}/auth.json`;
    if (!existsSync(authPath)) {
      issues.push({
        key: `codex:${a.id}:auth-missing`,
        message: `It's ${personaName()} — codex account "${a.name}" has no auth.json at ${authPath}; OpenAI-model runs on it will fail. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
      continue;
    }
    let access: string | undefined;
    try {
      access = JSON.parse(readFileSync(authPath, "utf-8"))?.tokens?.access_token;
    } catch {
      issues.push({
        key: `codex:${a.id}:auth-unreadable`,
        message: `It's ${personaName()} — codex account "${a.name}": ${authPath} isn't valid JSON; OpenAI-model runs on it will fail. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
      continue;
    }
    if (!access) continue; // API-key style login; nothing to expire.
    const exp = jwtExpMs(access);
    if (exp === null) continue;
    const left = exp - Date.now();
    if (left <= 0) {
      issues.push({
        key: `codex:${a.id}:access-expired`,
        message: `It's ${personaName()} — codex account "${a.name}"'s ChatGPT access token is expired, so OpenAI-model runs (and the Fable→Sol fallback) fail on it. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
    } else if (left < CODEX_ACCESS_WARN_MS) {
      issues.push({
        key: `codex:${a.id}:access-expiring`,
        message: `It's ${personaName()} — heads-up: codex account "${a.name}"'s ChatGPT access token expires in ${days(left)} and only refreshes when a codex turn runs. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
    }
  }
  return issues;
}

async function dmTeammate(teammateRef: string, message: string): Promise<boolean> {
  const teammate = resolveTeammate(teammateRef) ?? resolveTeammate(FALLBACK_TEAMMATE);
  if (!teammate) return false;
  const channel = await openDirectMessage(teammate.slackId);
  if (!channel) return false;
  const res = await sendSlackMessage(channel, message);
  return !!res?.ok;
}

/** Detection only, no DMs/state — for dry runs and tests. */
export function detectAccountIssues(): Issue[] {
  return [...claudeIssues(), ...codexIssues()];
}

// The bot's GitHub fine-grained PAT is the credential every gh/PR flow rides;
// renewal needs a human
// AND an org approval round-trip, so warn well ahead. Expiry comes from the
// `github-authentication-token-expiration` header GitHub sets on any
// authenticated call; a 401 means it's already dead.
const GITHUB_PAT_WARN_MS = 21 * 24 * 60 * 60 * 1000;

async function githubPatIssues(): Promise<Issue[]> {
  const token = process.env.GITHUB_API_TOKEN;
  if (!token) return [];
  let res: globalThis.Response;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "opensession" },
    });
  } catch {
    return []; // transient network — never alert
  }
  if (res.status === 401) {
    const agent = personaName();
    const bot = githubBotLogins()[0] || "configured bot";
    const owner = githubWriteOwners()[0] || "configured repository owner";
    return [
      {
        key: "github:pat:dead",
        message:
          `${agent} here — the ${bot} GitHub PAT (GITHUB_API_TOKEN) is revoked or ` +
          "expired: every bot gh/PR flow is down. Mint a new fine-grained PAT (resource " +
          `owner ${owner}, with access to the required repositories) and get it approved if needed.`,
        notify: FALLBACK_TEAMMATE,
      },
    ];
  }
  const raw = res.headers.get("github-authentication-token-expiration");
  if (!raw) return [];
  // Header format: "2027-07-27 19:19:35 UTC".
  const expiresAt = Date.parse(raw.replace(" UTC", "Z").replace(" ", "T"));
  if (!Number.isFinite(expiresAt)) return [];
  const left = expiresAt - Date.now();
  if (left > GITHUB_PAT_WARN_MS) return [];
  const days = Math.max(0, Math.floor(left / 86_400_000));
  const agent = personaName();
  const bot = githubBotLogins()[0] || "configured bot";
  const owner = githubWriteOwners()[0] || "configured repository owner";
  return [
    {
      key: "github:pat:expiring",
      message:
        `${agent} here — the ${bot} GitHub PAT expires in ${days} day(s) ` +
        `(${new Date(expiresAt).toISOString().slice(0, 10)}). Regenerate it at ` +
        `github.com/settings/personal-access-tokens (resource owner ${owner}), approve it ` +
        `if asked, then tell ${agent} to swap it into the configured credential stores.`,
      notify: FALLBACK_TEAMMATE,
    },
  ];
}

/** One sweep: detect, dedupe against state, DM, persist. Exported for tests/manual runs. */
export async function sweepAccountHealth(): Promise<Issue[]> {
  // Repair before detecting: refresh idle codex accounts' ChatGPT tokens so
  // an expiry that a refresh can fix never becomes an alert.
  await refreshIdleCodexTokens().catch((e) =>
    console.warn("[account-health] codex token refresh failed:", e)
  );
  const issues = [...detectAccountIssues(), ...(await githubPatIssues())];
  const state = readState();
  const now = Date.now();
  const live = new Set(issues.map((i) => i.key));
  // Drop cleared issues so a relapse re-alerts immediately.
  for (const key of Object.keys(state.alerts)) {
    if (!live.has(key)) delete state.alerts[key];
  }
  for (const issue of issues) {
    const last = Date.parse(state.alerts[issue.key]?.lastSentAt || "") || 0;
    if (now - last < REALERT_MS) continue;
    const sent = await dmTeammate(issue.notify, issue.message);
    audit({
      msg: "account_health_alert",
      issue: issue.key,
      notify: issue.notify,
      delivered: sent,
    });
    if (sent) state.alerts[issue.key] = { lastSentAt: new Date(now).toISOString() };
    else console.warn(`[account-health] failed to DM ${issue.notify} about ${issue.key}`);
  }
  writeState(state);
  return issues;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the hourly sweep. Call once from the __opensessionBooted block. */
export function startAccountHealthMonitor(): void {
  if (sweepTimer) return;
  setTimeout(() => {
    void sweepAccountHealth().catch((e) => console.error("[account-health] sweep failed:", e));
  }, FIRST_SWEEP_DELAY_MS);
  sweepTimer = setInterval(() => {
    void sweepAccountHealth().catch((e) => console.error("[account-health] sweep failed:", e));
  }, SWEEP_INTERVAL_MS);
  console.log(`[account-health] monitor started (hourly sweep, first in ${FIRST_SWEEP_DELAY_MS / 60000}m)`);
}
