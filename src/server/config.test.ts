import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getConfig,
  configuredRepos,
  configuredPaths,
  configuredServer,
  configuredIdentity,
  configuredCloud,
  configPath,
  defaultRepo,
  personaName,
  productName,
  productMark,
  updateIdentityConfig,
} from "./config";

// Each case writes its config to a fresh path (the loader caches by
// path+mtime) and points OPENSESSION_CONFIG at it.
const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_WORKTREES_DIR",
  "OPENSESSION_CLAUDE_BIN",
  "OPENSESSION_OPENCODE_BIN",
  "OPENSESSION_MCP_CONFIG",
  "OPENSESSION_PROFILE",
  "OPENSESSION_CLOUD_UPSTREAM",
  "OPENSESSION_CLOUD_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const dirs: string[] = [];
function withConfig(contents: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), "bks-config-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  if (contents !== null) writeFileSync(path, contents);
  process.env.OPENSESSION_CONFIG = path;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config loader", () => {
  test("no file → portable self-repo defaults", () => {
    withConfig(null); // path exists as a dir entry that was never written
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];

    expect(getConfig()).toEqual({});

    const repos = configuredRepos();
    expect(Object.keys(repos)).toEqual(["opensession"]);
    expect(repos.opensession).toMatchObject({
      id: "opensession",
      label: "Open Session",
      wtPrefix: "opensession",
      defaultBranch: "main",
      ghRepo: "",
      sharedCheckout: true,
      default: true,
    });
    expect(defaultRepo().id).toBe("opensession");

    const paths = configuredPaths();
    expect(paths.claudeBin).toBe(Bun.which("claude") || "claude");
    expect(paths.worktreesDir).toBe(`${process.env.HOME}/.opensession/worktrees`);

    const identity = configuredIdentity();
    expect(identity).toEqual({ team: [], slackNames: {}, defaultTimezone: "UTC" });

    expect(configuredServer().caddyAdmin).toBe("http://localhost:2019");
  });

  test("local profile starts with an empty registry and local paths", () => {
    delete process.env.OPENSESSION_CONFIG;
    delete process.env.OPENSESSION_CONFIG;
    delete process.env.OPENSESSION_WORKTREES_DIR;
    delete process.env.OPENSESSION_WORKTREES_DIR;
    delete process.env.OPENSESSION_CLAUDE_BIN;
    delete process.env.OPENSESSION_CLAUDE_BIN;
    process.env.OPENSESSION_PROFILE = "local";

    expect(configuredRepos()).toEqual({});
    expect(configuredPaths().worktreesDir).toBe(`${process.env.HOME}/os1/worktrees`);
    expect(configuredPaths().claudeBin).toBe(Bun.which("claude") || "claude");
    expect(configPath()).toBe(`${process.env.HOME}/os1/config.json`);
    expect(configuredIdentity()).toEqual({
      team: [],
      slackNames: {},
      defaultTimezone: "UTC",
    });
    expect(() => defaultRepo()).toThrow("No repositories are registered");
		expect(configuredCloud()).toEqual({
			upstream: "http://127.0.0.1:3850",
			token: null,
		});
  });

	test("cloud config uses environment overrides over the local config", () => {
		withConfig(JSON.stringify({ cloud: { upstream: "https://config.example", token: "config" } }));
		process.env.OPENSESSION_PROFILE = "local";
		process.env.OPENSESSION_CLOUD_UPSTREAM = "https://env.example";
		process.env.OPENSESSION_CLOUD_TOKEN = "env-token";
		expect(configuredCloud()).toEqual({
			upstream: "https://env.example",
			token: "env-token",
		});
	});

	test("cloud config is parsed from the local config file", () => {
		withConfig(JSON.stringify({ cloud: { upstream: "https://config.example", token: "config-token" } }));
		delete process.env.OPENSESSION_CLOUD_UPSTREAM;
		delete process.env.OPENSESSION_CLOUD_TOKEN;
		expect(configuredCloud()).toEqual({
			upstream: "https://config.example",
			token: "config-token",
		});
	});

  test("repos section is authoritative and applies id-derived defaults", () => {
    withConfig(
      JSON.stringify({
        paths: { worktreesDir: "/srv/worktrees" },
        repos: {
          "acme-app": {
            repo: "/srv/acme-app",
            default: true,
            label: "Acme App",
            deploymentTracking: true,
            warmCachePaths: ["dist/client.js"],
            previewAwsProfile: "acme-dev",
            securityInstructions: "Read SECURITY.md.",
          },
        },
      }),
    );
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];

    const repos = configuredRepos();
    expect(repos["acme-app"]).toEqual({
      id: "acme-app",
      label: "Acme App",
      repo: "/srv/acme-app",
      wtPrefix: "acme-app",
      defaultBranch: "main",
      ghRepo: "",
      default: true,
      deploymentTracking: true,
      warmCachePaths: ["dist/client.js"],
      previewAwsProfile: "acme-dev",
      securityInstructions: "Read SECURITY.md.",
    });
    expect(repos.opensession).toBeUndefined();
    expect(defaultRepo().id).toBe("acme-app");
    expect(configuredPaths().worktreesDir).toBe("/srv/worktrees");
  });

  test("repo entry without a checkout path is ignored", () => {
    withConfig(JSON.stringify({ repos: { phantom: { ghRepo: "acme/phantom" } } }));
    expect(configuredRepos()["phantom"]).toBeUndefined();
  });

  test("malformed file → defaults", () => {
    withConfig("{ this is not json");
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];
    expect(getConfig()).toEqual({});
    expect(defaultRepo().id).toBe("opensession");
    expect(configuredIdentity().team).toEqual([]);
  });

  test("non-object JSON → defaults", () => {
    withConfig(JSON.stringify(["not", "an", "object"]));
    expect(getConfig()).toEqual({});
  });

  test("env vars beat config.json per key", () => {
    withConfig(
      JSON.stringify({
        paths: { worktreesDir: "/from-config/worktrees", claudeBin: "/from-config/claude" },
        repos: { app: { repo: "/from-config/app" } },
      }),
    );
    process.env.OPENSESSION_WORKTREES_DIR = "/from-env/worktrees";
    process.env.OPENSESSION_CLAUDE_BIN = "/from-env/claude";

    expect(configuredPaths().worktreesDir).toBe("/from-env/worktrees");
    expect(configuredPaths().claudeBin).toBe("/from-env/claude");
    expect(configuredRepos().app.repo).toBe("/from-config/app");

    // …and the config value applies once the env var is gone.
    delete process.env.OPENSESSION_WORKTREES_DIR;
    expect(configuredPaths().worktreesDir).toBe("/from-config/worktrees");
    expect(configuredRepos().app.repo).toBe("/from-config/app");
  });

  test("identity: section present with empty team → empty tables, no throws", () => {
    withConfig(JSON.stringify({ identity: { team: [] } }));
    const identity = configuredIdentity();
    expect(identity.team).toEqual([]);
    expect(identity.slackNames).toEqual({});
  });

  test("persona/branding: defaults with no config file", () => {
    withConfig(null);
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
    expect(productMark()).toBe("Open Session");
  });

  test("persona/branding: config overrides apply", () => {
    withConfig(
      JSON.stringify({
        persona: { name: "Ava" },
        branding: { productName: "OpenSession", productMark: "OS" },
      }),
    );
    expect(personaName()).toBe("Ava");
    expect(productName()).toBe("OpenSession");
    expect(productMark()).toBe("OS");
  });

  test("branding: productMark falls back to productName", () => {
    withConfig(JSON.stringify({ branding: { productName: "OpenSession" } }));
    expect(productMark()).toBe("OpenSession");
    // Empty/whitespace strings are treated as unset, not honored.
    withConfig(JSON.stringify({ persona: { name: "  " }, branding: { productName: "" } }));
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
  });

  test("identity: custom roster is parsed and validated", () => {
    withConfig(
      JSON.stringify({
        identity: {
          team: [
            { name: "Ada Lovelace", email: "ada@acme.dev", github: "ada", slackId: "U111", aliases: ["ada"] },
            { notAName: true }, // invalid — dropped
          ],
          slackNames: { U222: "Bot", U333: 42 }, // non-string values dropped
        },
      }),
    );
    const identity = configuredIdentity();
    expect(identity.team).toEqual([
      { name: "Ada Lovelace", email: "ada@acme.dev", github: "ada", slackId: "U111", aliases: ["ada"] },
    ]);
    expect(identity.slackNames).toEqual({ U222: "Bot" });
  });

  test("updateIdentityConfig: writes names, preserves unknown keys, empty resets", () => {
    withConfig(
      JSON.stringify({
        server: { port: 4000 },
        persona: { name: "Old", company: "Acme" },
        futureSection: { keep: true },
      }),
    );
    updateIdentityConfig({ personaName: " Ava ", productName: "OS¹" });
    expect(personaName()).toBe("Ava");
    expect(productName()).toBe("OS¹");
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    // Untouched keys — modeled and unmodeled alike — survive the write.
    expect(raw.server).toEqual({ port: 4000 });
    expect(raw.persona.company).toBe("Acme");
    expect(raw.futureSection).toEqual({ keep: true });

    // Empty string deletes the key; an emptied section disappears entirely.
    updateIdentityConfig({ personaName: "", productName: "" });
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
    expect(JSON.parse(readFileSync(configPath(), "utf-8")).branding).toBeUndefined();
  });

  test("updateIdentityConfig: creates a missing file, refuses a corrupt one", () => {
    withConfig(null);
    updateIdentityConfig({ productName: "Fresh" });
    expect(productName()).toBe("Fresh");

    withConfig("{ not json");
    expect(() => updateIdentityConfig({ personaName: "X" })).toThrow();
    // The broken hand-edited file is left untouched.
    expect(readFileSync(configPath(), "utf-8")).toBe("{ not json");
  });
});
