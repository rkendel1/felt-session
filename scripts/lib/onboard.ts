/**
 * `opensession onboard` — first-run configuration.
 *
 * Writes the two files the server actually reads (`config.json` and the env
 * file) plus a systemd unit templated for this box, and can install the
 * service. Safe to re-run: existing files are backed up to `.bak-<n>` and an
 * existing config needs explicit confirmation.
 *
 * The load-bearing part is the env file. Integration flags default OFF and
 * only the literal string "true" enables them, so anything unrecognised means
 * off. Onboarding writes an explicit value for every integration rather than
 * leaning on that, so the file says what is running instead of implying it.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { INTEGRATIONS } from "../../src/server/integrations/registry";
import { CONFIG_PATH, ENV_PATH, HOME, OPENSESSION_HOME, REPO_ROOT, STAGED_UNIT_PATH } from "./paths";
import { installRecipe, listRecipes } from "./recipes";
import * as service from "./service";
import { ask, askYesNo, bold, canPrompt, dim, heading, info, warn, wrote, yellow } from "./ui";

export type OnboardOptions = { force?: boolean };

/** Back up rather than clobber, so a re-run can never lose a working config. */
function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let n = 1;
  while (existsSync(`${path}.bak-${n}`)) n++;
  const dest = `${path}.bak-${n}`;
  copyFileSync(path, dest);
  return dest;
}

/**
 * This box's tailnet address, if it is on one.
 *
 * Worth asking Tailscale rather than inferring from the interface list: it is
 * the only thing that knows whether the daemon is actually up and logged in,
 * and a stale 100.x address on a logged-out box is a bind that never works.
 */
function tailnetIp(): string | undefined {
  try {
    const proc = Bun.spawnSync(["tailscale", "ip", "-4"]);
    if (proc.exitCode !== 0) return undefined;
    return proc.stdout.toString().trim().split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** "OpenSession" -> "OS". Falls back to the first two characters. */
function deriveMark(name: string): string {
  const caps = name.replace(/[^A-Z]/g, "");
  return caps.length >= 2 ? caps.slice(0, 2) : name.slice(0, 2).toUpperCase();
}

type Answers = {
  productName: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  repoId: string;
  repoPath: string;
  repoBranch: string;
  worktreesDir: string;
  enabled: string[];
};

function collect(): Answers {
  heading("Instance configuration");
  info(
    dim(
      "Every field is optional; precedence is env var -> config.json -> built-in\n" +
        "  default. config.json is re-read on change, so none of this needs a restart.",
    ),
  );

  const productName = ask("Product name", "OpenSession");

  // Defaulting to the tailnet address when there is one is the whole point of
  // installing Tailscale up front: the alternative default, 127.0.0.1, works
  // until someone else needs to reach it and then gets "fixed" with 0.0.0.0.
  const tailnet = tailnetIp();
  const host = tailnet
    ? ask(`Bind address (${tailnet} is this box's tailnet address)`, tailnet)
    : ask("Bind address (a Tailscale IP shares it with your team)", "127.0.0.1");
  const port = Number(ask("Port", "3850")) || 3850;
  const publicBaseUrl = ask(
    "Public base URL",
    `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
  );

  heading("Your first repository");
  info(dim("Sessions run in git worktrees cut from the repos you register here."));
  const repoPath = ask("Repo checkout path", REPO_ROOT);
  const repoId = ask(
    "Repo id",
    repoPath === REPO_ROOT ? "opensession" : repoPath.split("/").pop() || "app",
  );
  const repoBranch = ask("Default branch", "main");
  const worktreesDir = ask("Worktrees directory", join(HOME, "worktrees"));

  heading("Integrations");
  info(
    dim(
      "All optional, all off by default. Each needs credentials before it will do\n" +
        "  anything — turn them on later with `opensession integrations enable <id>`.",
    ),
  );
  const enabled: string[] = [];
  if (canPrompt()) {
    // `always` modules self-gate and ignore their flag entirely — asking about
    // them offers a choice that does nothing.
    for (const integration of INTEGRATIONS.filter((i) => !i.always)) {
      if (askYesNo(`Enable ${integration.label}?`, false)) enabled.push(integration.id);
    }
  }

  return {
    productName,
    host,
    port,
    publicBaseUrl,
    repoId,
    repoPath,
    repoBranch,
    worktreesDir,
    enabled,
  };
}

function buildConfig(a: Answers): Record<string, unknown> {
  return {
    server: {
      host: a.host,
      port: a.port,
      webhookPort: 3848,
      publicBaseUrl: a.publicBaseUrl,
    },
    paths: {
      worktreesDir: a.worktreesDir,
      mcpConfig: join(REPO_ROOT, "mcp-config.json"),
    },
    branding: {
      productName: a.productName,
      productMark: deriveMark(a.productName),
    },
    repos: {
      [a.repoId]: {
        label: a.productName,
        repo: a.repoPath,
        wtPrefix: a.repoId,
        defaultBranch: a.repoBranch,
        default: true,
      },
    },
    integrations: Object.fromEntries(
      INTEGRATIONS.filter((i) => !i.always).map((i) => [
        i.id,
        { enabled: a.enabled.includes(i.id) },
      ]),
    ),
    // Populate with teammates to enable commit attribution, per-user MCP
    // `allowedUsers` gating and human-ask routing. An empty roster makes every
    // identity-dependent feature a no-op.
    identity: { team: [] },
  };
}

function buildEnv(a: Answers): string {
  const lines = [
    "# OpenSession environment and secrets.",
    "# Loaded by the systemd unit (EnvironmentFile) and by Bun for manual runs.",
    "# Generated by `opensession onboard`.",
    "",
    "# --- core server ---",
    `HOST=${a.host}`,
    `PORT=${a.port}`,
    "WEBHOOK_PORT=3848",
    `OPENSESSION_UI_BASE=${a.publicBaseUrl}`,
    `OPENSESSION_WORKTREES_DIR=${a.worktreesDir}`,
    "",
    "# --- integrations ---",
    "# Flags default ON in code and only the literal string `false` disables them,",
    "# so every integration is disabled explicitly here. Enable one only once its",
    "# credentials are filled in below.",
  ];

  for (const integration of INTEGRATIONS.filter((i) => !i.always)) {
    const on = a.enabled.includes(integration.id);
    lines.push("", `# ${integration.label} — ${integration.doc}`);
    lines.push(`${integration.enableFlag}=${on}`);
    for (const secret of integration.env) {
      lines.push(`${on ? "" : "# "}${secret.name}=${secret.example ?? ""}`);
    }
  }

  lines.push(
    "",
    "# Agent subprocesses do NOT inherit this file: runs get a minimal env",
    "# (PATH, HOME, LANG, OPENSESSION_MODEL) by design, and MCP servers carry",
    "# their own credentials.",
    "",
  );

  return lines.join("\n");
}

export async function onboard(opts: OnboardOptions = {}): Promise<number> {
  // Re-running against a live install would replace a working config with
  // defaults. Backups make that recoverable, not harmless.
  if (existsSync(CONFIG_PATH) && !opts.force) {
    warn(`${CONFIG_PATH} already exists — this box is already onboarded.`);
    if (!canPrompt()) {
      info(`Re-run with ${bold("--force")} to overwrite it (the old file is backed up first).`);
      return 1;
    }
    if (!askYesNo("Overwrite it? The current file is backed up first.", false)) {
      info(dim("Left untouched. Nothing written."));
      return 0;
    }
  }

  const answers = collect();

  heading("Writing configuration");
  mkdirSync(OPENSESSION_HOME, { recursive: true });
  mkdirSync(answers.worktreesDir, { recursive: true });

  // 0600 on both: config.json carries the team identity table (emails, Slack
  // ids, GitHub logins), not just ports.
  for (const [path, contents] of [
    [CONFIG_PATH, JSON.stringify(buildConfig(answers), null, 2) + "\n"],
    [ENV_PATH, buildEnv(answers)],
  ] as const) {
    const backedUp = backup(path);
    await Bun.write(path, contents);
    chmodSync(path, 0o600);
    wrote(path, backedUp ? `(backed up to ${backedUp})` : undefined);
  }

  // Offered after the config exists, since installing one appends to it.
  // A fresh install otherwise boots healthy and does nothing, which gives a new
  // operator no sense of what this is for.
  const recommended = listRecipes().filter((r) => r.recommended);
  if (recommended.length && canPrompt()) {
    heading("Suggested automations");
    info(dim("Off by default; you enable them in the UI once you have looked at them."));
    for (const recipe of recommended) {
      info(dim(`  ${recipe.description}`));
      if (askYesNo(`Add ${recipe.label}?`, false)) {
        await installRecipe(recipe);
        wrote(CONFIG_PATH, `+ ${recipe.id}`);
      }
    }
    info(dim("\n  More: `opensession automations`"));
  }

  try {
    const kind = service.supervisor();
    if (kind === "systemd") {
      // Staged rather than installed: putting it in /etc needs root, so that
      // stays an explicit choice.
      await Bun.write(STAGED_UNIT_PATH, await service.renderUnit());
      wrote(STAGED_UNIT_PATH, "(templated for this box)");
    }
    if (kind !== "none") {
      const what = kind === "launchd" ? "LaunchAgent" : "systemd service";
      const needsRoot = kind === "systemd" ? " (needs sudo)" : "";
      if (askYesNo(`\n  Install and start it as a ${what} now?${needsRoot}`, false)) {
        await service.install(STAGED_UNIT_PATH);
      }
    }
  } catch (err) {
    warn(`could not prepare the service definition: ${(err as Error).message}`);
  }

  heading("Next steps");
  info(`1. ${bold("opensession start")}      start the server`);
  info(`2. ${bold("opensession doctor")}     check everything is wired up`);
  info(`   ${dim(`then open ${answers.publicBaseUrl}`)}`);
  info(`3. ${bold("opencode auth login")}    give the engine model capacity`);
  if (answers.enabled.length) {
    info(`4. ${dim(`add credentials for ${answers.enabled.join(", ")} in ${ENV_PATH}`)}`);
  }

  console.log(
    yellow(
      `\n  OpenSession has no built-in authentication. It trusts everyone who can\n` +
        `  reach ${answers.host}:${answers.port} — keep it on Tailscale or an equivalent private\n` +
        `  network. See docs/setup/README.md#trust-model.\n`,
    ),
  );

  return 0;
}
