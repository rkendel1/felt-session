#!/usr/bin/env bun
/** Launch the existing macOS app as the interactive self-host setup surface. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`${command[0]} failed`);
}

if (process.platform !== "darwin") {
  const child = Bun.spawn([process.execPath, join(root, "scripts/cli.ts"), "onboard"], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} else {
  const macRoot = join(root, "packages/clients/mac");
  // LaunchAgents are denied background access to Desktop/Documents/Downloads
  // by macOS privacy controls. Keep the runtime checkout in the instance
  // directory, while this checkout remains the bootstrap source.
  const runtimeRoot = join(homedir(), ".opensession", "src");
  if (!existsSync(join(runtimeRoot, ".git"))) {
    console.log("Preparing the local server runtime…");
    await run(["git", "clone", "--local", root, runtimeRoot], root);
    const origin = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    }).stdout.toString().trim();
    if (origin) await run(["git", "remote", "set-url", "origin", origin], runtimeRoot);
    await run([process.execPath, "install", "--frozen-lockfile"], runtimeRoot);
  }
  if (!existsSync(join(macRoot, "node_modules/electron/package.json"))) {
    console.log("Installing the Open Session app…");
    const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
      cwd: macRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await install.exited) !== 0) throw new Error("Could not install the macOS app dependencies");
  }
  const label = JSON.parse(readFileSync(join(macRoot, "package.json"), "utf8")).productName;
  const executable = join(macRoot, `dist/mac-arm64/${label}.app/Contents/MacOS/${label}`);
  console.log("Preparing the Open Session app…");
  const build = Bun.spawn(
    [process.execPath, "x", "electron-builder", "--mac", "--dir", "--publish", "never"],
    {
      cwd: macRoot,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await build.exited) !== 0 || !existsSync(executable)) {
    throw new Error("Could not prepare the macOS app");
  }
  console.log("Opening interactive setup…");
  const appEnv = { ...process.env };
  // Electron treats this as an instruction to become a Node REPL. Some coding
  // environments set it for their own helpers, so never pass it to the app.
  delete appEnv.ELECTRON_RUN_AS_NODE;
  const app = Bun.spawn([executable], {
    cwd: macRoot,
    env: {
      ...appEnv,
      OPENSESSION_NATIVE_SETUP_ROOT: runtimeRoot,
      OPENSESSION_NATIVE_SETUP_BUN: process.execPath,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await app.exited;
}
