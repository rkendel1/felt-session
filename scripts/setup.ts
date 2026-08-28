#!/usr/bin/env bun
/** Launch the existing macOS app as the interactive self-host setup surface. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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
      OPENSESSION_NATIVE_SETUP_ROOT: root,
      OPENSESSION_NATIVE_SETUP_BUN: process.execPath,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await app.exited;
}
