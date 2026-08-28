#!/usr/bin/env bun
/** Trusted host half of the macOS setup UI. JSON arrives over stdin. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { onboard, type Answers } from "./lib/onboard";

type Request = { answers?: Partial<Answers>; installService?: boolean };

function required(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

try {
  const request = JSON.parse(await Bun.stdin.text()) as Request;
  const input = request.answers ?? {};
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }
  const repoPath = resolve(required(input.repoPath, "Repository path"));
  if (!existsSync(resolve(repoPath, ".git"))) {
    throw new Error("Repository path must be a Git checkout");
  }
  const answers: Answers = {
    productName: required(input.productName, "Product name"),
    host: required(input.host, "Bind address"),
    port,
    publicBaseUrl: required(input.publicBaseUrl, "Server URL"),
    repoId: required(input.repoId, "Repository id"),
    repoPath,
    repoBranch: required(input.repoBranch, "Default branch"),
    worktreesDir: resolve(required(input.worktreesDir, "Worktrees directory")),
    enabled: [],
  };
  const url = new URL(answers.publicBaseUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Server URL must use HTTP or HTTPS");
  process.env.NO_PROMPT = "1";
  process.exitCode = await onboard({
    answers,
    // Clicking the native confirmation is explicit replacement intent. This
    // also repairs a setup that wrote config but whose service never started.
    // onboard backs up both existing files before replacing them.
    force: true,
    installService: request.installService !== false,
    requireHealthy: true,
    healthTimeoutMs: 30_000,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
