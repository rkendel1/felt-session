/**
 * OpenAI / ChatGPT-subscription auth for the opencode engine's `openai`
 * provider — the OpenAI analog of the meridian bridge (opencode-runner.ts)
 * that serves opencode/anthropic/* on Claude-subscription capacity. This wires
 * opencode/openai/* to our EXISTING ChatGPT-subscription auth (the codex
 * accounts pool, codex-accounts.ts).
 *
 * MECHANISM (chosen empirically 2026-07-08 against opencode 1.17.15): NATIVE.
 * opencode ships first-class ChatGPT-plan OAuth for its `openai` provider
 * (`opencode auth login` → "ChatGPT Pro/Plus"). It stores the credential in
 * its XDG data dir at `$XDG_DATA_HOME/opencode/auth.json` (fallback
 * ~/.local/share/opencode/auth.json) as:
 *
 *   { "openai": { "type":"oauth", "access":"<jwt>", "refresh":"<rt>",
 *                 "expires":<ms epoch>, "accountId":"<chatgpt account id>" } }
 *
 * and — critically — authenticates with the SAME OAuth client_id as the Codex
 * CLI (app_EMoamEEZ73f0CkXaXp7hrann) against the SAME token endpoint
 * (auth.openai.com/oauth/token), routing gpt-5.x turns to the ChatGPT backend
 * (chatgpt.com/backend-api/codex/responses) with the ChatGPT-Account-Id header.
 * So a Codex account's CODEX_HOME/auth.json tokens are DIRECTLY usable by
 * opencode with no format translation of the credential itself — we just
 * reshape the JSON. No plugin, no vendored community artifact, no fingerprint
 * spoofing. Verified live: `opencode run --model openai/gpt-5.4-mini` returned
 * "OK" on the pool ChatGPT (prolite/Plus) account with cost=0 — i.e. served on
 * the subscription, not API billing.
 *
 * ── ROTATION HAZARD & RESOLUTION (the trickiest correctness point) ──────────
 * OpenAI rotates refresh tokens on every successful refresh: the /oauth/token
 * response carries a NEW refresh_token and invalidates the old one. Both
 * codex-runner (through the codex CLI) and opencode refresh through the SAME
 * endpoint with the SAME client_id, so the refresh token is ONE rotating family
 * shared across both engines. If opencode ever performed a refresh it would
 * rotate that family and write the new token only into ITS auth.json — silently
 * invalidating the copy the legacy codex-runner still reads from
 * CODEX_HOME/auth.json, whose next refresh then 400s (the exact HTTP-400 death
 * recorded in project memory: "a copied .credentials snapshot dies after
 * rotation").
 *
 * We make that IMPOSSIBLE, not merely unlikely, by making CODEX_HOME the single
 * source of truth for refresh and opencode a READ-ONLY consumer of access
 * tokens:
 *   1. Seed opencode with the current ACCESS token ONLY (access tokens live
 *      ~10 days and codex itself keeps them fresh), its real expiry parsed from
 *      the JWT `exp`, and a deliberately-INVALID placeholder refresh token.
 *   2. Because the seeded access token is unexpired, opencode uses it directly
 *      and never refreshes (its provider only refreshes when access is missing
 *      or expires < now). If it ever did try (only after the access token has
 *      expired), the placeholder guarantees a loud 400 rather than a successful
 *      rotation that would corrupt CODEX_HOME.
 *   3. Re-seed from CODEX_HOME on every server spawn, so opencode always sees
 *      codex's current access token.
 * Net: opencode can NEVER rotate/invalidate the codex refresh token, so the
 * live codex CLI accounts (used by the legacy codex-runner) keep working
 * untouched. Trade-off, fail-loud not fail-corrupt: if a codex account goes
 * unused for ~10 days its access token expires and an opencode/openai run fails
 * with a clear "expired — run a codex turn to refresh" error until codex
 * refreshes it. We refuse to seed an already-expired token for the same reason.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Each account gets its own XDG_DATA_HOME
 * (~/.opensession-opencode/openai-data/<accountId>) so its auth.json — and
 * opencode's own session db — never share mutable state across accounts. The
 * runner folds XDG_DATA_HOME into the server's config/env identity hash, so a
 * different account respawns the server (never reuses another account's auth).
 * Caveat (documented, mirrors meridian's resume caveats): because opencode's
 * session db lives under the per-account data dir, a bks session that switches
 * OpenAI accounts across runs starts a FRESH opencode session rather than
 * resuming the old one. With the current single-account pool this never fires.
 *
 * ── API-KEY accounts ────────────────────────────────────────────────────────
 * codex accounts of kind "api_key" are a raw OpenAI platform key billed to the
 * org, not a subscription. For those we skip seeding entirely and hand opencode
 * the key via provider.openai.options.apiKey (normal api.openai.com billing).
 *
 * ── REMOTE SANDBOXES (daytona/e2b) ──────────────────────────────────────────
 * Remote sandboxes never receive CODEX_HOME/auth.json — its refresh token is
 * the ONE rotating family shared with the host codex CLI, and third-party
 * compute must never be able to rotate (= kill) it. Instead the launcher
 * (sandbox/adapters/bootstrap.ts) uploads, per launch, (a) a scoped
 * codex-accounts store so the in-sandbox pick honors the same
 * pool/openaiAccounts rules, and (b) the SAME seeded artifact this module
 * builds locally — access-token-only + the invalid placeholder refresh,
 * rotation-proof by construction — into a seed dir named by the
 * OPENSESSION_OPENAI_SEED_DIR env (openaiRemoteSeedDir()). In-sandbox,
 * bindOpenaiAccount can't read the account's CODEX_HOME (a host path that
 * doesn't exist there) and falls back to that seed, mechanism
 * "oauth-subscription-seeded-remote". The reader re-stamps the placeholder
 * refresh defensively, so even a corrupted seed can never carry a live
 * refresh token into opencode.
 */

import { homeDir } from "./paths";
import { stateDir } from "./paths";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import {
  getCodexAccountById,
  getUsableCodexAccountById,
  pickCodexAccount,
  listCodexAccounts,
  type CodexAccount,
} from "./codex-accounts";
import { isLocalProfile } from "./profile";
import { userMatchesAny } from "./shared/user-mappings";
import { localCodexAccount, localOpencodeDataRoot } from "./local-engine-auth";

const HOME = homeDir();
export const OPENAI_DATA_ROOT = isLocalProfile()
  ? localOpencodeDataRoot("openai")
  : `${stateDir("opencode")}/openai-data`;

/**
 * Point `$XDG_DATA_HOME/gh` at the real one so the gh CLI keeps finding its
 * extensions inside an isolated data root.
 *
 * gh resolves extensions under the XDG *data* dir, and the isolation above
 * repoints XDG_DATA_HOME at a per-account directory — which silently hid every
 * installed extension from every agent run (`unknown command "stack" for
 * "gh"`, caught 2026-07-30 when an agent tried to register a stacked PR). The
 * link exposes only gh's own data dir, owned by the same user; opencode reads
 * `$XDG_DATA_HOME/opencode`, which stays per-account.
 *
 * Best-effort: a missing source or a lost race just means gh behaves as it did
 * before, so no auth path should fail over it.
 */
export function linkGhDataDir(dataHome: string): void {
  try {
    const real = `${HOME}/.local/share/gh`;
    const link = `${dataHome}/gh`;
    if (!existsSync(real) || existsSync(link)) return;
    symlinkSync(real, link);
  } catch {}
}

/** Deliberately invalid refresh token seeded into opencode's auth.json: it
 *  MUST never hold a usable refresh token (see module header — a successful
 *  refresh would rotate the shared token family and kill CODEX_HOME). */
export const OPENCODE_OPENAI_PLACEHOLDER_REFRESH = "codex-managed-no-refresh";

/** Where a remote sandbox's pre-uploaded seed material lives — set by the
 *  remote launcher's launch env, read in-sandbox by bindOpenaiAccount's
 *  fallback. Unset (host / docker) = no seed dir, CODEX_HOME is the source. */
export function openaiRemoteSeedDir(): string | undefined {
  return process.env.OPENSESSION_OPENAI_SEED_DIR;
}

/** The one path shape both sides of the seed contract use: the launcher
 *  writes here (host-side), bindOpenaiAccount reads here (in-sandbox). */
export function openaiSeedAuthPath(seedRoot: string, accountId: string): string {
  return `${seedRoot}/${accountId}/auth.json`;
}

export type OpenaiAuthMechanism =
  | "oauth-subscription"
  | "oauth-subscription-seeded-remote"
  | "api-key";

export interface OpenaiAccountBinding {
  account: CodexAccount;
  mechanism: OpenaiAuthMechanism;
  /** Extra env for the opencode serve process (XDG_DATA_HOME for oauth). */
  extraEnv: Record<string, string>;
  /** opencode `provider` config override (apiKey for api-key accounts). */
  providerOverride?: Record<string, unknown>;
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

/** Masked account label for audit events (never the raw token/path secret). */
export function maskOpenaiAccount(account: CodexAccount): string {
  return `${account.name} (${account.id.slice(0, 8)}, ${account.kind})`;
}

/**
 * Pick a codex account to serve an opencode/openai/* run. Mirrors
 * pickMeridianAccount's structure: an explicit override id list
 * (bridge.openaiAccounts in ~/.opensession-opencode.json) restricts to designated
 * accounts in list order; otherwise the normal codex pool pick
 * (least-recently-used, exhaustion-aware).
 *
 * Owner rule (mirrors pickMeridianAccount, fail-closed): a personal codex
 * account (`owner` set) is only ever returned for its owner's runs — including
 * when it is named in the designated list — and the pool pick prefers the run
 * user's own personal accounts over the shared pool. Runs with no `user`
 * (automations, one-shots) only ever see owner-less pool accounts.
 */
export function pickOpenaiAccount(
  model: string,
  ids?: string[],
  sessionKey?: string,
  out?: { reason?: string },
  user?: string,
  pinnedId?: string,
  strict?: boolean,
  /** Account ids to skip entirely (caller-side ineligibility, e.g. the pi
   *  engine excluding api_key accounts it cannot seed). Absent = no change
   *  to the existing pick behavior. */
  exclude?: ReadonlySet<string>
): CodexAccount | { error: string } {
  if (isLocalProfile()) return localCodexAccount();
  const all = listCodexAccounts();
  if (!all.length) {
    return {
      error:
        "no codex accounts configured — opencode/openai/* needs a ChatGPT-subscription " +
        "(kind: home) or API-key codex account (add one in Connections)",
    };
  }
  const allowedOwner = (a: CodexAccount) => !a.owner || (!!user && userMatchesAny(user, [a.owner]));
  const designated = (id: string) => !ids?.length || ids.includes(id);
  const eligible = (id: string) => !exclude?.has(id);
  if (pinnedId && eligible(pinnedId)) {
    const pinned = getUsableCodexAccountById(pinnedId, model);
    if (pinned && allowedOwner(pinned) && designated(pinnedId)) {
      if (out) out.reason = "pinned";
      return pinned;
    }
    if (strict) {
      const name = getCodexAccountById(pinnedId)?.name || pinnedId;
      return {
        error: `pinned account ${name} is not currently usable (hard pin — not falling back to the pool)`,
      };
    }
  }
  if (ids?.length) {
    for (const id of ids) {
      if (!eligible(id)) continue;
      const a = getUsableCodexAccountById(id, model);
      if (a && allowedOwner(a)) {
        if (out) out.reason = "designated";
        return a;
      }
    }
    const known = ids.join(", ");
    return { error: `no designated openai account is configured (bridge.openaiAccounts: ${known})` };
  }
  const picked = pickCodexAccount(exclude ? new Set(exclude) : undefined, model, sessionKey, out, user);
  if (picked) return picked;
  return { error: "no usable codex account for opencode/openai (all currently sidelined)" };
}

/**
 * Does opencode itself hold a native `opencode auth login` openai credential
 * (the fallthrough the runner uses when no codex account is picked)? Checked
 * at the same XDG path opencode's server process will read, so a sandboxed
 * run — no host auth mounted — can fail with an honest named error instead
 * of opencode's bare "model not found" (the provider is simply omitted from
 * the generated config when there is no credential).
 */
export function opencodeHasNativeOpenaiAuth(): boolean {
  const base = process.env.XDG_DATA_HOME || `${HOME}/.local/share`;
  try {
    const j = JSON.parse(readFileSync(`${base}/opencode/auth.json`, "utf-8"));
    return !!j?.openai;
  } catch {
    return false;
  }
}

/** The seeded opencode auth.json shape (module header): access-token-only,
 *  real expiry, deliberately-invalid placeholder refresh. */
export interface SeededOpenaiAuth {
  openai: {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
  };
}

/**
 * Build the rotation-proof seeded auth object for a "home" codex account from
 * its CODEX_HOME/auth.json (host-side — never runs where CODEX_HOME is
 * absent). This is the ONLY artifact that may leave the host for a remote
 * sandbox: the live refresh token never appears in it. Returns {error}
 * (unexpired-access is a hard requirement — see module header's fail-loud
 * trade-off).
 */
export function buildSeededOpenaiAuth(
  account: CodexAccount
): { seeded: SeededOpenaiAuth } | { error: string } {
  const srcPath = `${account.value}/auth.json`;
  if (!existsSync(srcPath)) {
    return {
      error: `codex account "${account.name}" has no auth.json at ${srcPath} — run \`CODEX_HOME=${account.value} codex login\` with a ChatGPT plan`,
    };
  }
  let src: any;
  try {
    src = JSON.parse(readFileSync(srcPath, "utf-8"));
  } catch (e: any) {
    return { error: `failed to read ${srcPath}: ${e?.message || e}` };
  }
  const access = src?.tokens?.access_token;
  const accountId = src?.tokens?.account_id;
  if (!access || typeof access !== "string") {
    return {
      error: `codex account "${account.name}" auth.json has no ChatGPT access_token (an API-key login? run \`codex login\` on a ChatGPT plan)`,
    };
  }
  const expMs = jwtExpMs(access);
  if (isLocalProfile() && expMs === null) {
    return {
      error: `codex account "${account.name}" ChatGPT access token is malformed — run \`codex login\`, then retry`,
    };
  }
  if (expMs !== null && expMs <= Date.now()) {
    return {
      error: `codex account "${account.name}" ChatGPT access token is expired — run a codex turn (or \`codex login\`) to refresh it, then retry`,
    };
  }
  return {
    seeded: {
      openai: {
        type: "oauth",
        access,
        // Placeholder, deliberately invalid — see module header.
        refresh: OPENCODE_OPENAI_PLACEHOLDER_REFRESH,
        expires: expMs ?? Date.now() + 3_600_000,
        ...(accountId ? { accountId } : {}),
      },
    },
  };
}

/**
 * Host-side helper for the remote launcher: which codex accounts may serve
 * THIS run's opencode/openai/* traffic, and the seed file for each "home"
 * account. Mirrors pickOpenaiAccount's eligibility exactly — an explicit
 * bridge.openaiAccounts list restricts to those ids; otherwise the whole pool.
 * `user` scopes the slice fail-closed exactly like the Claude
 * accountsForRemoteUpload: another user's personal (`owner`-carrying) account
 * never leaves the box — runs with no user get pool (owner-less) accounts
 * only.
 *
 * "home" accounts whose seed can't be built (expired access token, unreadable
 * auth.json) are EXCLUDED from the upload — an unusable-remotely account must
 * not be picked in-sandbox just to die there — and reported in `skipped`.
 */
export function buildOpenaiRemoteSeedUpload(
  accounts: CodexAccount[],
  restrictIds?: string[],
  user?: string
): {
  accounts: CodexAccount[];
  seeds: Array<{ accountId: string; content: string }>;
  skipped: Array<{ account: CodexAccount; reason: string }>;
} {
  const allowedOwner = (a: CodexAccount) => !a.owner || (!!user && userMatchesAny(user, [a.owner]));
  const eligible = (
    restrictIds?.length
      ? restrictIds
          .map((id) => accounts.find((a) => a.id === id))
          .filter((a): a is CodexAccount => !!a)
      : accounts
  ).filter(allowedOwner);
  const out: CodexAccount[] = [];
  const seeds: Array<{ accountId: string; content: string }> = [];
  const skipped: Array<{ account: CodexAccount; reason: string }> = [];
  for (const account of eligible) {
    if (account.kind === "api_key") {
      // The key itself travels in the scoped store — no seed file needed.
      out.push(account);
      continue;
    }
    const built = buildSeededOpenaiAuth(account);
    if ("error" in built) {
      skipped.push({ account, reason: built.error });
      continue;
    }
    out.push(account);
    seeds.push({ accountId: account.id, content: JSON.stringify(built.seeded) });
  }
  return { accounts: out, seeds, skipped };
}

/**
 * Bind a picked codex account into opencode-serve env + provider config. For
 * "home" (ChatGPT subscription) accounts this seeds a per-account opencode
 * auth.json — from CODEX_HOME/auth.json when it exists (host/docker, where
 * the auth material is local or ro-mounted), else from the launcher-uploaded
 * remote seed (openaiRemoteSeedDir(); mechanism
 * "oauth-subscription-seeded-remote") — access-token-only with a placeholder
 * refresh — and returns XDG_DATA_HOME isolation env. For "api_key" accounts it
 * returns a provider apiKey override and no seeding. Returns {error} (never
 * throws) so the runner can surface a clean error event.
 */
/** opencode's openai provider defaults `headerTimeout` to 10s (1.17.15 dist:
 *  `var Ry=1e4`), which gpt-5.x reasoning turns on big contexts routinely
 *  exceed before the first response byte — every such call then burns a 10s
 *  abort + retry and re-pays the prompt (14 retries in one 11-minute turn,
 *  2026-07-17). 60s lets slow time-to-first-byte responses through while
 *  keeping genuine wedges bounded; opencode still retries on expiry. */
const OPENAI_HEADER_TIMEOUT_MS = 60_000;

/** Real context windows of the ChatGPT-Codex backend, which are smaller than
 *  the API models' models.dev entries (gpt-5.6: 1.05M context / 922k input).
 *
 *  Important: `limit.input` is the actual accepted INPUT ceiling, not
 *  `context - limit.output`. OpenCode 1.17.15 caps each request's output at
 *  32k unless explicitly overridden, and the backend dynamically fits output
 *  into the remaining window. An isolated live probe on 2026-07-28 using the
 *  same ChatGPT OAuth + OpenCode path accepted 367,394 input tokens and
 *  rejected a ~372k request with `context_length_exceeded`. The previous
 *  `input = 372k - 128k` declaration therefore made autocompact fire at ~224k
 *  for no backend reason. Declaring the measured 372k input ceiling retains
 *  OpenCode's own 20k reserve, so it compacts around 352k instead.
 *
 *  Retired pre-5.6 slugs keep their conservative old limits; dispatch reroutes
 *  them before use (RETIRED_CODEX_REROUTE in models.ts). Models not listed
 *  (unknown/new slugs) keep models.dev limits — probe them before adding them.
 */
const CODEX_BACKEND_LIMITS: Record<string, { context: number; input: number; output: number }> = (() => {
  const lim = (context: number, input = context - 128_000) => ({
    context,
    input,
    output: 128_000,
  });
  return {
    "gpt-5.6-sol": lim(372_000, 372_000),
    "gpt-5.6-terra": lim(372_000, 372_000),
    "gpt-5.6-luna": lim(372_000, 372_000),
    "gpt-5.5": lim(272_000),
    "gpt-5.4": lim(272_000),
    "gpt-5.4-mini": lim(272_000),
    // Not in the codex CLI catalog — conservative small-family default.
    "gpt-5.3-codex-spark": lim(272_000),
  };
})();

/** `provider.openai.models` config block carrying the real backend limits —
 *  opencode deep-merges these over its models.dev catalog, which re-arms
 *  autocompact at the true window instead of the API models' fictional one. */
const OPENAI_MODELS_OVERRIDE: Record<string, unknown> = Object.fromEntries(
  Object.entries(CODEX_BACKEND_LIMITS).map(([id, limit]) => [
    id,
    {
      limit,
      variants: {
        fast: {
          serviceTier: "priority",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
        ...Object.fromEntries(
          ["none", "low", "medium", "high", "xhigh"].map((effort) => [
            `${effort}-fast`,
            {
              reasoningEffort: effort,
              serviceTier: "priority",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        ),
      },
    },
  ])
);

export function supportsOpenaiFastMode(model?: string): boolean {
  if (!model) return false;
  const id = model.replace(/^opencode\/openai\//, "").replace(/^openai\//, "");
  return id in CODEX_BACKEND_LIMITS;
}

export function openaiPromptVariant(
  effort: string | undefined,
  fastMode: boolean,
): string | undefined {
  if (!fastMode) return effort;
  return effort ? `${effort}-fast` : "fast";
}

export function bindOpenaiAccount(account: CodexAccount): OpenaiAccountBinding | { error: string } {
  if (account.kind === "api_key") {
    return {
      account,
      mechanism: "api-key",
      extraEnv: {},
      // NOTE: no models override here — api-key accounts hit the real OpenAI
      // API, where the models.dev limits (1.05M context) are correct. The
      // CODEX_BACKEND_LIMITS clamp is subscription-backend-only below.
      providerOverride: {
        openai: { options: { apiKey: account.value, headerTimeout: OPENAI_HEADER_TIMEOUT_MS } },
      },
    };
  }

  // kind === "home": seed opencode's per-account auth.json from CODEX_HOME,
  // or — in a remote sandbox, where account.value is a host path that doesn't
  // exist — from the launcher-uploaded seed artifact.
  let seeded: SeededOpenaiAuth;
  let mechanism: OpenaiAuthMechanism = "oauth-subscription";
  const srcPath = `${account.value}/auth.json`;
  const seedDir = openaiRemoteSeedDir();
  if (existsSync(srcPath)) {
    const built = buildSeededOpenaiAuth(account);
    if ("error" in built) return built;
    seeded = built.seeded;
  } else if (seedDir) {
    const seedPath = openaiSeedAuthPath(seedDir, account.id);
    if (!existsSync(seedPath)) {
      return {
        error: `codex account "${account.name}" has no uploaded seed at ${seedPath} — its access token was likely expired at launch (run a codex turn on the host to refresh it, then relaunch)`,
      };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(seedPath, "utf-8"));
    } catch (e: any) {
      return { error: `failed to read uploaded seed ${seedPath}: ${e?.message || e}` };
    }
    const access = parsed?.openai?.access;
    const expires = parsed?.openai?.expires;
    if (!access || typeof access !== "string" || typeof expires !== "number") {
      return { error: `uploaded seed ${seedPath} is malformed (no access token/expiry)` };
    }
    if (expires <= Date.now()) {
      return {
        error: `codex account "${account.name}" seeded ChatGPT access token has expired — start a fresh run (the launcher re-seeds per launch), or run a codex turn on the host to refresh it`,
      };
    }
    seeded = {
      openai: {
        type: "oauth",
        access,
        // Defensively re-stamped: no seed, however it was produced, may carry
        // a usable refresh token into opencode (see module header).
        refresh: OPENCODE_OPENAI_PLACEHOLDER_REFRESH,
        expires,
        ...(typeof parsed.openai.accountId === "string"
          ? { accountId: parsed.openai.accountId }
          : {}),
      },
    };
    mechanism = "oauth-subscription-seeded-remote";
  } else {
    return {
      error: `codex account "${account.name}" has no auth.json at ${srcPath} — run \`CODEX_HOME=${account.value} codex login\` with a ChatGPT plan`,
    };
  }

  const dataHome = `${OPENAI_DATA_ROOT}/${account.id}`;
  const authDir = `${dataHome}/opencode`;
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  linkGhDataDir(dataHome);
  const outPath = `${authDir}/auth.json`;
  writeFileSync(outPath, JSON.stringify(seeded));
  chmodSync(outPath, 0o600);

  return {
    account,
    mechanism,
    extraEnv: { XDG_DATA_HOME: dataHome },
    // Native OAuth needs no options for auth, but the headerTimeout raise
    // (constant above) must ride the provider config for oauth accounts too —
    // and the ChatGPT-Codex backend's real context windows, so opencode's
    // autocompact fires before the backend's wall instead of at models.dev's
    // API-sized limits (see CODEX_BACKEND_LIMITS).
    providerOverride: {
      openai: {
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_MS },
        models: OPENAI_MODELS_OVERRIDE,
      },
    },
  };
}
