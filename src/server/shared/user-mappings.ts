/**
 * Consolidated user/email/ID mappings across GitHub, Slack, and Linear.
 *
 * The tables are DERIVED from `configuredIdentity()` (identity.team +
 * identity.slackNames in ~/.opensession/config.json). Derivation happens once
 * at module load. An empty configured team means
 * empty tables: attribution/gating/ask-routing become no-ops, never throws.
 */
import { configuredIdentity, type TeamMember } from "../config";

/** Moved to the protocol package; re-exported for existing import sites. */
export type { GitIdentity } from "@tellahq/opensession-protocol/identity";
import type { GitIdentity } from "@tellahq/opensession-protocol/identity";

type TeamGitIdentityEntry = GitIdentity & {
  aliases: string[];
  slackId?: string;
  github?: string;
};

export interface DerivedIdentityTables {
  githubToSlack: Record<string, string>;
  linearEmailToGithub: Record<string, string>;
  slackIdToName: Record<string, string>;
  teamGitIdentity: TeamGitIdentityEntry[];
}

/**
 * Build the four mapping tables from an identity roster. Exported for the
 * derivation test; runtime code uses the module-level tables below.
 * - githubToSlack: members with both ids, unless `githubToSlack: false`.
 * - linearEmailToGithub: each member's linearEmails → their GitHub login.
 * - slackIdToName: members' slackId → name, plus the extra slackNames map.
 * - teamGitIdentity: members with a git email (aliases default to the
 *   lowercased first name).
 */
export function deriveIdentityTables(
  team: TeamMember[],
  slackNames: Record<string, string> = {},
): DerivedIdentityTables {
  const githubToSlack: Record<string, string> = {};
  const linearEmailToGithub: Record<string, string> = {};
  const slackIdToName: Record<string, string> = {};
  const teamGitIdentity: TeamGitIdentityEntry[] = [];

  for (const m of team) {
    if (m.github && m.slackId && m.githubToSlack !== false) {
      githubToSlack[m.github] = m.slackId;
    }
    if (m.github) {
      for (const email of m.linearEmails ?? []) {
        linearEmailToGithub[email.toLowerCase()] = m.github;
      }
    }
    if (m.slackId) slackIdToName[m.slackId] = m.name;
    if (m.email) {
      teamGitIdentity.push({
        name: m.name,
        email: m.email,
        aliases: m.aliases?.length
          ? m.aliases.map((a) => a.toLowerCase())
          : [m.name.split(" ")[0].toLowerCase()],
        ...(m.slackId ? { slackId: m.slackId } : {}),
        ...(m.github ? { github: m.github } : {}),
      });
    }
  }
  Object.assign(slackIdToName, slackNames);

  return { githubToSlack, linearEmailToGithub, slackIdToName, teamGitIdentity };
}

const identity = configuredIdentity();
const tables = deriveIdentityTables(identity.team, identity.slackNames);

/** GitHub username → Slack user ID */
export const GITHUB_TO_SLACK: Record<string, string> = tables.githubToSlack;

/** Linear email → GitHub username (for PR reviewer assignment) */
export const LINEAR_EMAIL_TO_GITHUB: Record<string, string> = tables.linearEmailToGithub;

/** Slack user ID → full display name (single source of truth) */
export const SLACK_ID_TO_NAME: Record<string, string> = tables.slackIdToName;

export function slackIdToFirstName(id: string): string | null {
  const name = SLACK_ID_TO_NAME[id];
  return name ? name.split(" ")[0] : null;
}

/**
 * Resolve a teammate reference — a Slack user id, a first name / alias, a full
 * name, or a GitHub login — to their Slack id + display name, for the
 * human-in-the-loop asks (src/server/human-asks.ts). Reuses the same identity
 * table as commit attribution so a name / alias / GitHub login / raw U-id
 * all land on the same person. Returns null for unknown references.
 */
export function resolveTeammate(ref?: string | null): { slackId: string; name: string } | null {
  if (!ref) return null;
  const key = ref.trim().replace(/^@/, "");
  if (!key) return null;

  // Raw Slack id.
  if (/^U[A-Z0-9]{6,}$/.test(key)) {
    const name = SLACK_ID_TO_NAME[key];
    return name ? { slackId: key, name } : null;
  }
  // Name / alias / GitHub login → identity → slackId.
  const id = gitIdentityFor(key);
  if (id) {
    const member = TEAM_GIT_IDENTITY.find((p) => p.name === id.name);
    if (member?.slackId) {
      return { slackId: member.slackId, name: SLACK_ID_TO_NAME[member.slackId] || member.name };
    }
  }
  return null;
}

export function githubUsernameToSlackId(username: string): string | null {
  return GITHUB_TO_SLACK[username] || null;
}

/**
 * GitHub login → the web user-picker key (the lowercased first name, e.g.
 * "kentdebruin" → "kent"). Lets the UI attribute a PR to a teammate: the
 * sidebar's Open PRs section shows a person's PRs whether they authored them
 * from their own account or the bot opened them from a session they started.
 */
export function githubLoginToPersonKeyFromTeam(
  login: string | null | undefined,
  team: TeamMember[],
): string | null {
  if (!login) return null;
  const lower = login.toLowerCase();
  const member = team.find((m) => m.github?.toLowerCase() === lower);
  if (!member) return null;
  return member.aliases?.[0]?.toLowerCase() || member.name.split(" ")[0].toLowerCase();
}

export function githubLoginToPersonKey(login?: string | null): string | null {
  return githubLoginToPersonKeyFromTeam(login, identity.team);
}

/** Resolve a web-picker person key to the canonical first name used by push
 * subscriptions. This intentionally covers configured members without a git
 * email; receiving notifications should not depend on commit attribution. */
export function personKeyToDisplayName(
  ref?: string | null,
  team: TeamMember[] = identity.team,
): string | null {
  if (!ref) return null;
  const key = ref.trim().toLowerCase();
  const member = team.find((m) => {
    const aliases = m.aliases?.length
      ? m.aliases.map((alias) => alias.toLowerCase())
      : [m.name.split(" ")[0].toLowerCase()];
    return aliases.includes(key) || m.name.toLowerCase() === key;
  });
  return member?.name.split(" ")[0] || null;
}

export function linearEmailToGithubUsername(email: string | null): string | null {
  if (!email) return null;
  return LINEAR_EMAIL_TO_GITHUB[email] || null;
}

/**
 * Resolve a teammate reference (a web-picker first name like "Kent", a full
 * name, an alias, a Slack id, or an email) to their GitHub login — for turning
 * an Open Session review request into a real GitHub reviewer assignment. Reuses the
 * same identity table as commit attribution. Returns null for anyone without a
 * known GitHub account.
 */
export function githubLoginFor(ref?: string | null): string | null {
  const id = gitIdentityFor(ref);
  if (!id) return null;
  return TEAM_GIT_IDENTITY.find((p) => p.name === id.name)?.github ?? null;
}

/**
 * Ground-truth git identities — the exact (name, email) each teammate's
 * commits already use, so GitHub attributes commits we author on their behalf
 * to the right account (`noreply` addresses where the person commits with
 * one). Derived from the configured roster.
 *
 * `aliases` covers the web user-picker first names (UserPicker TEAM) and is matched
 * case-insensitively; `slackId`/`github` let us resolve Slack senders and Linear
 * issue creators to the same identity.
 */
const TEAM_GIT_IDENTITY: TeamGitIdentityEntry[] = tables.teamGitIdentity;

/**
 * Resolve a prompt author — a web user-picker name, a Slack user id, or an email
 * (e.g. a Linear issue creator) — to a git identity for commit attribution.
 * Returns null for unknown/anonymous/bot authors so their commits keep the
 * machine's default git identity rather than being mis-attributed.
 */
export function gitIdentityFor(user?: string | null): GitIdentity | null {
  if (!user) return null;
  // Drop a trailing parenthetical like " (loop)" the queue/loop paths append.
  const key = user.trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!key || key.toLowerCase() === "anonymous") return null;

  const found = ((): (typeof TEAM_GIT_IDENTITY)[number] | undefined => {
    // Slack user id (e.g. "U08S8B3P83X")
    if (/^U[A-Z0-9]{6,}$/.test(key)) {
      const bySlack = TEAM_GIT_IDENTITY.find((p) => p.slackId === key);
      if (bySlack) return bySlack;
      const name = SLACK_ID_TO_NAME[key]?.toLowerCase();
      return name ? TEAM_GIT_IDENTITY.find((p) => p.name.toLowerCase() === name) : undefined;
    }
    // Email — match the git email directly, or map a Linear account email → github.
    if (key.includes("@")) {
      const lower = key.toLowerCase();
      const byEmail = TEAM_GIT_IDENTITY.find((p) => p.email.toLowerCase() === lower);
      if (byEmail) return byEmail;
      const gh = LINEAR_EMAIL_TO_GITHUB[lower];
      return gh ? TEAM_GIT_IDENTITY.find((p) => p.github === gh) : undefined;
    }
    // A GitHub login (e.g. a PR author / label applier), a web-picker name, an
    // alias (first name), or the first token of the full name.
    const lower = key.toLowerCase();
    return TEAM_GIT_IDENTITY.find(
      (p) =>
        p.github?.toLowerCase() === lower ||
        p.name.toLowerCase() === lower ||
        p.aliases.includes(lower) ||
        p.name.toLowerCase().split(" ")[0] === lower
    );
  })();

  return found ? { name: found.name, email: found.email } : null;
}

/**
 * Does `user` resolve to one of the identities in `allowed`? Used to gate
 * per-user MCP servers (mcp-config.json `allowedUsers`): both sides are run
 * through the same identity table as commit attribution, so a configured name
 * matches a run whose user is an alias / GitHub login / email /
 * their Slack id. Falls back to a case-insensitive raw-string match so an
 * arbitrary label that doesn't map to a known teammate still works if it's an
 * exact match. Returns false for an anonymous/unknown user against a non-empty
 * list (fail-closed: unidentified callers don't get restricted servers).
 */
/** IANA timezone for a teammate ref (name/alias/Slack id/email/login),
 * falling back to the instance's configured timezone and then UTC. */
export function timezoneForUser(ref?: string | null): string {
  const id = gitIdentityFor(ref);
  const member = id ? identity.team.find((m) => m.name === id.name) : undefined;
  return member?.timezone || identity.defaultTimezone;
}

export function userMatchesAny(
  user: string | null | undefined,
  allowed: string[]
): boolean {
  if (!allowed?.length) return true; // no restriction
  if (!user) return false;
  const userId = gitIdentityFor(user);
  const userNorm = user.trim().toLowerCase();
  return allowed.some((a) => {
    if (!a) return false;
    if (a.trim().toLowerCase() === userNorm) return true;
    const allowedId = gitIdentityFor(a);
    return !!(allowedId && userId && allowedId.email === userId.email);
  });
}

/**
 * Build the git author/committer env vars for an agent's child process. Setting
 * these on the process attributes every commit it makes during the run, without
 * mutating repo config (so parallel runs in different worktrees never race).
 * Empty when there's no resolved author — the run keeps the default identity.
 */
export function gitIdentityEnv(author?: GitIdentity | null): Record<string, string> {
  if (!author) return {};
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}
