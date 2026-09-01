/**
 * Storage-authority tripwires.
 *
 * FeltDB is the durable application-state authority (AGENTS.md, and the
 * file-and-line audit in docs/architecture/storage-authority-audit.md). The
 * migration is not finished: a small, known set of modules still uses SQLite or
 * writes JSON state. These tests pin that set so it can shrink but never grow
 * silently.
 *
 * A failure here is not "fix the test". It means a new non-FeltDB store was
 * added, or one was migrated. Migrating: delete the entry. Adding: don't —
 * or, if there is a real reason FeltDB cannot hold it, add the entry AND record
 * the capability gap in the audit's "requirements" section, so the gap stays
 * visible as something FeltDB should cover rather than being absorbed silently.
 *
 * These are tripwires, not proofs. They match on imports and write calls, so
 * they catch the ordinary way a store gets added, not every conceivable one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../../../../../", import.meta.url).pathname.replace(/\/$/, "");

function sourceFiles(): string[] {
  const roots = [
    join(REPO_ROOT, "packages/core/opensession-server/src"),
    join(REPO_ROOT, "scripts"),
  ];
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(abs.slice(REPO_ROOT.length + 1));
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

const FILES = sourceFiles().map((path) => ({
  path,
  text: readFileSync(join(REPO_ROOT, path), "utf8"),
}));

test("the source sweep actually found the tree", () => {
  expect(FILES.length).toBeGreaterThan(300);
});

describe("no PostgreSQL", () => {
  test("no Postgres or SQL-ORM dependency is declared", () => {
    const manifests = [
      "package.json",
      "packages/core/opensession-server/package.json",
      "packages/core/protocol/package.json",
    ];
    const banned = [
      "pg", "pg-native", "postgres", "postgres.js", "@vercel/postgres",
      "prisma", "@prisma/client", "drizzle-orm", "knex", "typeorm", "sequelize",
    ];
    for (const manifest of manifests) {
      let raw: string;
      try { raw = readFileSync(join(REPO_ROOT, manifest), "utf8"); } catch { continue; }
      const declared = Object.keys({
        ...(JSON.parse(raw).dependencies ?? {}),
        ...(JSON.parse(raw).devDependencies ?? {}),
      });
      expect({ manifest, hits: declared.filter((d) => banned.includes(d)) })
        .toEqual({ manifest, hits: [] });
    }
  });
});

describe("SQLite is confined to the documented residue", () => {
  // Two live stores plus three offline operator migration tools. AGENTS.md
  // sanctions the offline tools; the live pair is audit item §2.3 and is the
  // work that retires SQLite entirely.
  const ALLOWED = [
    // Live: production transcripts route through the actor to FeltDB
    // (actor-transcript.ts), so this is the NODE_ENV==="test" backend.
    "packages/core/opensession-server/src/server/transcript-store.ts",
    // Live: still backs central kernel bookkeeping (quarantine, dead letters,
    // outbox id allocation, stats, maintenance).
    "packages/core/opensession-server/src/server/session-kernel/store.ts",
    // Offline operator migration tools: read legacy SQLite into FeltDB.
    "packages/core/opensession-server/src/server/session-kernel/transcript-offline-migration.ts",
    "packages/core/opensession-server/src/server/session-kernel/feltdb-offline-migration.ts",
    "scripts/migrate-session-kernel-to-feltdb.ts",
  ].sort();

  test("no module outside the allowlist imports a SQLite driver", () => {
    const importers = FILES
      .filter(({ text }) => /from\s+["'](bun:sqlite|better-sqlite3|node:sqlite)["']/.test(text))
      .map(({ path }) => path)
      .sort();
    expect(importers).toEqual(ALLOWED);
  });
});

describe("JSON state stores do not multiply", () => {
  // Modules that write a .json file and have no FeltDB import. Most are
  // legitimately not application state (build artifacts, operator config, a
  // foreign tool's file format); four are unmigrated durable state and are
  // tracked as audit items #1-#4 with the FeltDB gap each is blocked on.
  const ALLOWED = [
    // -- unmigrated durable application state (audit §3) --
    "packages/core/opensession-server/src/server/claude-accounts.ts",   // #1 blocked on R2/R4
    "packages/core/opensession-server/src/server/codex-accounts.ts",    // #2 blocked on R2/R4
    "packages/core/opensession-server/src/server/plugins.ts",           // #3 blocked on R1/R7
    "packages/core/opensession-server/src/server/session-assets.ts",    // #4 unblocked: use ArtifactClient
    // -- not application state --
    "packages/core/opensession-server/src/server/config.ts",            // hand-edited operator config
    "packages/core/opensession-server/src/server/demo/generate.ts",     // demo fixture generator
    "packages/core/opensession-server/src/server/frontend-build.ts",    // build artifacts
    "packages/core/opensession-server/src/server/mcp-relay.ts",         // relay spec handed to a subprocess
    "packages/core/opensession-server/src/server/preview.ts",           // preview scratch
    "packages/core/opensession-server/src/server/reports.ts",           // rendered report bundles
    "packages/core/opensession-server/src/server/testing/snapshot-harness.ts",
    "packages/core/opensession-server/src/server/web-fetch.ts",         // fetch response cache
    "scripts/build-compile.ts",
    "scripts/build-release.ts",
    "scripts/frontend-dev.ts",
    "scripts/gen-catalogs.ts",
    "scripts/generate-release-metadata.ts",
    "scripts/lib/connect.ts",
    "scripts/lib/onboard.ts",
    "scripts/memory-bench.ts",
    "scripts/ui-audit.ts",
  ].sort();

  test("no new module writes JSON without a FeltDB authority", () => {
    const writers = FILES
      .filter(({ text }) =>
        /writeFileAtomic\(|writeFileSync\(/.test(text) &&
        /\.json"/.test(text) &&
        !/managedFeltDb|@feltdb\/core/.test(text))
      .map(({ path }) => path)
      .sort();
    expect(writers).toEqual(ALLOWED);
  });
});

describe("the FeltDB migration flag stays dead", () => {
  test("no persistence backend-selection flag exists in code", () => {
    // The dual-write flag described in FELTDB_MIGRATION.md was never shipped.
    // Reintroducing one would mean a silent persistence downgrade is possible.
    const banned = /ENABLE_FELTDB_RUN_RECORDS|PERSISTENCE_KIND|FELT_DB_ENABLED|READ_FROM_FELTDB|DUAL_WRITE/;
    const offenders = FILES.filter(({ text }) => banned.test(text)).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
