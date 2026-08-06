/**
 * "Can this instance actually run an agent turn?" — one answer, shared by the
 * web Setup checklist (`/api/setup/status`) and `opensession doctor`.
 *
 * This exists because both surfaces used to report a healthy instance that
 * could not run a single turn. Setup checked repos, team, GitHub and
 * integrations — everything except the engine. Doctor listed `opencode` as an
 * optional binary. Neither looked at the bridge flag or the account pools, so
 * the first prompt died on a config file the operator had never seen named
 * anywhere in the product.
 *
 * The rule encoded here: a turn needs the engine BINARY, model CAPACITY for
 * whichever provider the default model resolves to, and — for Anthropic — the
 * bridge switched on plus the `claude` CLI the bundled bridge shells out to.
 * Everything is read fresh; nothing is cached.
 */

import { existsSync } from "fs";
import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { configuredPaths } from "./config";
import { accountProviderForModel, interactiveDefaultModel } from "./models";
import { findOpencodeBin } from "./opencode-bin";
import { bridgeEnabled, configPath, readOpencodeBridgeConfig } from "./opencode-config";
import { homeDir } from "./paths";

/** The engine config file as a person would type it — the path is
 *  env/state-dir overridable, so naming a literal ~/… would sometimes lie. */
function engineConfigLabel(): string {
  const home = homeDir();
  const path = configPath();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export interface EngineStatus {
  /** Resolved opencode binary path, or null when nothing is installed. */
  opencodeBin: string | null;
  /** Resolved `claude` CLI path — the bundled Anthropic bridge execs it. */
  claudeBin: string | null;
  /** The `enabled` flag in the engine config file. */
  bridgeEnabled: boolean;
  claudeAccounts: number;
  codexAccounts: number;
  /** Default model for new interactive sessions, as the picker resolves it. */
  defaultModel: string;
  /** Which account pool that model draws on, if any. */
  provider: "claude" | "codex" | undefined;
  /** True when a turn on `defaultModel` should work. */
  ready: boolean;
  /** One sentence naming the first thing that would break. Null when ready. */
  blocker: string | null;
  /** What to do about `blocker`, phrased as an instruction. Null when ready. */
  fix: string | null;
  /** True when `blocker` is resolved by PUT /api/settings/opencode-engine —
   *  i.e. the UI can offer a button rather than a copy-pasteable command. */
  fixableInApp: boolean;
}

function findClaudeBin(): string | null {
  const configured = configuredPaths().claudeBin;
  // configuredPaths falls back to the bare name when nothing resolves; a bare
  // name is not evidence the CLI exists.
  if (configured && configured !== "claude") {
    return existsSync(configured) ? configured : null;
  }
  return Bun.which("claude");
}

export function engineStatus(): EngineStatus {
  const opencodeBin = findOpencodeBin();
  const claudeBin = findClaudeBin();
  const enabled = bridgeEnabled();
  const claudeAccounts = listAccountsPublic().length;
  const codexAccounts = listCodexAccountsPublic().length;
  const defaultModel = interactiveDefaultModel();
  const provider = accountProviderForModel(defaultModel);

  const base = {
    opencodeBin,
    claudeBin,
    bridgeEnabled: enabled,
    claudeAccounts,
    codexAccounts,
    defaultModel,
    provider,
  };
  const blocked = (blocker: string, fix: string, fixableInApp = false) => ({
    ...base,
    ready: false,
    blocker,
    fix,
    fixableInApp,
  });

  if (!opencodeBin) {
    return blocked(
      "The OpenCode engine isn't installed — no agent turn can run.",
      "Install it with `npm i -g opencode-ai` (or re-run the Open Session installer), then restart.",
    );
  }

  // Anthropic is the default provider, and the one with a switch in front of
  // it. Report the switch before the accounts: enabling it is a click, and a
  // user who fixes accounts first still can't run a turn.
  if (provider === "claude") {
    if (!enabled) {
      return blocked(
        "The Anthropic engine is switched off, so the default model can't run.",
        `Turn it on here — it writes \`enabled: true\` to ${engineConfigLabel()}.`,
        true,
      );
    }
    if (!claudeAccounts) {
      return blocked(
        "No Claude accounts in the pool — the default model has nothing to run on.",
        "On a machine logged into a Claude Max account run `claude setup-token`, then add the token under Settings → Accounts.",
      );
    }
    if (!claudeBin) {
      return blocked(
        "The `claude` CLI isn't installed — the bundled Anthropic bridge shells out to it.",
        "Install it with `curl -fsSL https://claude.ai/install.sh | bash`, or switch the default model to a provider that doesn't need it.",
      );
    }
  }

  if (provider === "codex" && !codexAccounts) {
    return blocked(
      "No ChatGPT accounts in the pool — the default model has nothing to run on.",
      "Add one under Settings → Accounts with the ChatGPT device-code sign-in.",
    );
  }

  // A third-party provider (no subscription pool). Its models only reach the
  // picker when the engine config is enabled, so the flag still gates it.
  if (!provider && !enabled) {
    return blocked(
      "The engine config is off, so provider models never reach the model picker.",
      `Turn it on here — it writes \`enabled: true\` to ${engineConfigLabel()}.`,
      true,
    );
  }

  // No resolved provider means a preset (dial/orchestrator) or a third-party
  // id — both of which run on *something* in the pools or a provider key. Only
  // call it blocked when there is no capacity of any kind; a preset backed by a
  // subscription account is fine, and must not be reported as misconfigured.
  const providerKeys = Object.keys(readOpencodeBridgeConfig()?.providers || {});
  if (!provider && !claudeAccounts && !codexAccounts && !providerKeys.length) {
    return blocked(
      `No model capacity configured for "${defaultModel}".`,
      "Add a Claude or ChatGPT account under Settings → Accounts, or a provider API key under Settings → Model providers.",
    );
  }

  return { ...base, ready: true, blocker: null, fix: null, fixableInApp: false };
}
