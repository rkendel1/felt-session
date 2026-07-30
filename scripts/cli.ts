#!/usr/bin/env bun
/**
 * The `opensession` command.
 *
 * Reachable as `opensession` once install.sh has put the shim on PATH, and as
 * `bun run scripts/cli.ts` from a checkout. The surface mirrors what the
 * reference self-hosted tools (opencode, openclaw) expose, because that is the
 * bar this install experience is being measured against: onboard, update,
 * start/stop, doctor.
 *
 * Everything heavy lives in scripts/lib/ — this file is argument parsing and
 * dispatch, so `opensession --help` stays fast even on a box where nothing is
 * configured yet.
 */

import { existsSync } from "fs";
import { doctor } from "./lib/doctor";
import { onboard } from "./lib/onboard";
import { ENV_PATH, REPO_ROOT, STAGED_UNIT_PATH } from "./lib/paths";
import * as service from "./lib/service";
import { update } from "./lib/update";
import { bold, dim, fail, green, heading, info, ok, run, runInherit, warn } from "./lib/ui";
import { INTEGRATIONS, findIntegration } from "../src/server/integrations/registry";
import { findRecipe, installRecipe, installedKeys, listRecipes, removeRecipe } from "./lib/recipes";
import { connect, nodeRun, nodeStatus, nodesList, nodesPair, nodesRemove } from "./lib/connect";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positional = argv.slice(1).filter((a) => !a.startsWith("-"));

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage(): void {
  console.log(`
${bold("opensession")} — self-hosted agent infrastructure

${bold("Setup")}
  onboard [--force]        configure this box (writes config + env + unit)
  doctor                   check tooling, config, integrations and the server
  service install          install and enable the systemd unit

${bold("Running")}
  start [--foreground]     start the server
  stop                     stop the service
  restart                  restart the service
  status                   is it running?
  logs [-f] [-n N]         tail the service journal

${bold("Client")}
  tui [--host <url>]       open the terminal client (the 'os' binary)

${bold("Maintenance")}
  update [--channel <ref>] fast-forward, reinstall deps, restart
         [--check]         show what an update would pull, change nothing
         [--no-restart]    skip the restart
  integrations             list integrations and whether they are on
  integrations enable <id>
  integrations disable <id>
  automations              list bundled automation recipes
  automations add <id>     install one (takes effect on restart)
  automations remove <id>
  version

${bold("Execution nodes")}   ${dim("run sessions on another machine (macOS/Linux)")}
  nodes                    list attached nodes
  nodes pair               mint a one-time pairing code
  nodes remove <id>        revoke a node
  connect --server <url> --code <code>
                           attach THIS machine to a server
  node run                 stay attached (heartbeat)
  node status              is this machine attached?

Docs: docs/setup/README.md
`);
}

async function version(): Promise<number> {
  const pkg = JSON.parse(await Bun.file(`${REPO_ROOT}/package.json`).text());
  const { stdout: sha } = await run(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT });
  const { stdout: branch } = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: REPO_ROOT,
  });
  console.log(`opensession ${pkg.version}${sha ? ` (${branch} ${sha})` : ""}`);
  console.log(dim(`  ${REPO_ROOT}`));
  return 0;
}

async function start(): Promise<number> {
  if (flags.has("--foreground") || flags.has("-f") || !(await service.isInstalled())) {
    info(dim(`starting in the foreground — ${REPO_ROOT}`));
    return await runInherit(["bun", "run", "opensession.ts"], REPO_ROOT);
  }
  return await service.control("start");
}

/**
 * `opensession tui` — hand off to the `os` client (os1-tui).
 *
 * A thin alias, not a reimplementation: `os` is a separate binary because it's a
 * *client* (fetch + WebSocket, runs on your laptop) while this CLI is a
 * *server-admin* tool that imports server modules and manages the unit. Prefer
 * `os` directly; this exists for discoverability from `opensession --help`.
 */
async function tui(): Promise<number> {
  const onPath = Bun.which("os");
  if (onPath) return await runInherit([onPath, ...argv.slice(1)], process.cwd());
  const entry = `${REPO_ROOT}/os1-tui/src/index.ts`;
  if (!existsSync(entry)) {
    fail("no TUI found", "expected the `os` binary on PATH or os1-tui/ in this checkout");
    return 1;
  }
  return await runInherit(["bun", entry, ...argv.slice(1)], REPO_ROOT);
}

async function status(): Promise<number> {
  heading("Status");
  const kind = service.supervisor();
  if (kind === "none") {
    info(dim("no service manager here"));
  } else if (!(await service.isInstalled())) {
    warn(`no ${kind} service installed`, "run `opensession service install`");
  } else {
    const state = await service.state();
    if (state === "active") ok(`${kind} service active`);
    else if (state === "inactive") fail(`${kind} service not running`);
    else warn(`could not query ${kind}`, "no permission or no session bus");
  }
  return 0;
}

/** Flip an ENABLE_* flag in the env file, creating the line if absent. */
async function setIntegration(id: string, on: boolean): Promise<number> {
  const spec = findIntegration(id);
  if (!spec) {
    fail(`unknown integration '${id}'`, `known: ${INTEGRATIONS.map((i) => i.id).join(", ")}`);
    return 1;
  }
  if (!existsSync(ENV_PATH)) {
    fail(`no env file at ${ENV_PATH}`, "run `opensession onboard` first");
    return 1;
  }

  const text = await Bun.file(ENV_PATH).text();
  const line = `${spec.enableFlag}=${on}`;
  const pattern = new RegExp(`^${spec.enableFlag}=.*$`, "m");
  await Bun.write(ENV_PATH, pattern.test(text) ? text.replace(pattern, line) : `${text}\n${line}\n`);

  ok(`${spec.label} ${on ? "enabled" : "disabled"}`, ENV_PATH);
  if (on) {
    const missing = spec.env.filter((e) => e.required);
    if (missing.length) {
      info(dim(`  needs: ${missing.map((m) => m.name).join(", ")} — see ${spec.doc}`));
    }
  }
  warn("restart to apply", "opensession restart");
  return 0;
}

async function listIntegrations(): Promise<number> {
  const envText = existsSync(ENV_PATH) ? await Bun.file(ENV_PATH).text() : "";
  heading("Integrations");
  for (const spec of INTEGRATIONS) {
    if (spec.always) {
      info(`${dim("always")}  ${spec.label}`);
      continue;
    }
    const on = new RegExp(`^${spec.enableFlag}=true$`, "m").test(envText);
    info(`${on ? green("on ") : dim("off")}     ${spec.label}  ${dim(spec.id)}`);
  }
  info(dim(`\n  opensession integrations enable <id>`));
  return 0;
}

/**
 * Bundled recipes are opt-in: installing one writes it into the config seed
 * list, and the server creates it (create-if-absent) on the next boot.
 */
async function listAutomations(): Promise<number> {
  const recipes = listRecipes();
  if (!recipes.length) {
    warn("no bundled recipes found", RECIPES_HINT);
    return 0;
  }
  const installed = await installedKeys();
  heading("Automation recipes");
  for (const recipe of recipes) {
    const key = recipe.automation.eventKey || recipe.automation.name;
    const mark = installed.has(key) ? green("added") : dim("  -  ");
    info(`${mark}  ${recipe.id.padEnd(24)} ${dim(recipe.description)}`);
    if (recipe.requires?.length) {
      info(`         ${dim(`needs the ${recipe.requires.join(", ")} integration`)}`);
    }
  }
  info(dim("\n  opensession automations add <id>"));
  return 0;
}

async function addAutomation(id: string): Promise<number> {
  const recipe = findRecipe(id);
  if (!recipe) {
    fail(`unknown recipe '${id}'`, `known: ${listRecipes().map((r) => r.id).join(", ")}`);
    return 1;
  }
  const result = await installRecipe(recipe);
  if (result === "already-present") {
    info(dim(`${recipe.id} is already installed`));
    return 0;
  }
  ok(`added ${recipe.label}`, "disabled until you enable it in the UI");
  if (recipe.requires?.length) {
    info(dim(`  needs: ${recipe.requires.join(", ")} — opensession integrations enable <id>`));
  }
  if (recipe.notes) info(dim(`  ${recipe.notes}`));
  warn("restart to create it", "opensession restart");
  return 0;
}

async function removeAutomation(id: string): Promise<number> {
  const recipe = findRecipe(id);
  if (!recipe) {
    fail(`unknown recipe '${id}'`);
    return 1;
  }
  if (!(await removeRecipe(recipe))) {
    info(dim(`${recipe.id} was not in the seed list`));
    return 0;
  }
  ok(`removed ${recipe.label} from the seed list`);
  // Seeding is create-if-absent, so an already-created automation stays put.
  info(dim("  an automation already created from it is untouched — delete it in the UI"));
  return 0;
}

const RECIPES_HINT = "expected them in recipes/automations/";

async function main(): Promise<number> {
  switch (command) {
    case "onboard":
    case "setup":
      return await onboard({ force: flags.has("--force") });

    case "doctor":
      return await doctor();

    case "start":
      return await start();
    case "stop":
      return await service.control("stop");
    case "restart":
      return await service.control("restart");
    case "status":
      return await status();

    case "logs":
      return await service.logs(
        flags.has("-f") || flags.has("--follow"),
        Number(flagValue("-n") ?? flagValue("--lines") ?? 100),
      );

    case "service":
      if (positional[0] === "install") {
        if (service.supervisor() === "systemd") {
          await Bun.write(STAGED_UNIT_PATH, await service.renderUnit());
        }
        return (await service.install(STAGED_UNIT_PATH)) ? 0 : 1;
      }
      fail("usage: opensession service install");
      return 1;

    case "update":
      return await update({
        channel: flagValue("--channel"),
        check: flags.has("--check"),
        restart: !flags.has("--no-restart"),
      });

    case "integrations":
      if (positional[0] === "enable") return await setIntegration(positional[1] ?? "", true);
      if (positional[0] === "disable") return await setIntegration(positional[1] ?? "", false);
      return await listIntegrations();

    case "automations":
      if (positional[0] === "add") return await addAutomation(positional[1] ?? "");
      if (positional[0] === "remove") return await removeAutomation(positional[1] ?? "");
      return await listAutomations();

    case "connect":
      return await connect({
        server: flagValue("--server"),
        code: flagValue("--code"),
        name: flagValue("--name"),
        label: flagValue("--label"),
      });

    case "node":
      if (positional[0] === "run") return await nodeRun();
      if (positional[0] === "status" || !positional[0]) return await nodeStatus();
      fail("usage: opensession node run|status");
      return 1;

    case "nodes":
      if (positional[0] === "pair") return await nodesPair();
      if (positional[0] === "remove") return await nodesRemove(positional[1] ?? "");
      return await nodesList();

    case "tui":
      return await tui();

    case "version":
    case "--version":
    case "-v":
      return await version();

    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;

    default:
      fail(`unknown command '${command}'`);
      usage();
      return 1;
  }
}

process.exit(await main());
