/**
 * Config for the pi engine (pi.dev's coding agent, served by pi-runner.ts).
 *
 * Managed FeltDB config — missing or `enabled: false` means the pi
 * engine is OFF everywhere at once: the Engine choice is hidden and the
 * runner refuses to start a turn with a clear config error. Deliberately
 * config-driven, never an env flag; the
 * OPENSESSION_PI_CONFIG override is a TEST SEAM (like
 * OPENSESSION_MODEL_PROVIDERS_CONFIG — verify scripts point it at a temp file), not
 * the feature switch.
 *
 * Shape:
 *   {
 *     "enabled": true,
 *     "pickerModels": []
 *         // Retired compatibility field. The picker has one shared model
 *         // catalog and the chosen engine is encoded only in the session id.
 *     "anthropicTransport": "inprocess"
 *         // Optional: how pi/anthropic/* turns reach the Claude Agent SDK.
 *         // "inprocess" (the default; absent normalizes to it) registers
 *         // the native in-process provider (pi-anthropic-provider.ts) —
 *         // token-level streaming, no loopback HTTP hop. "bridge" keeps the
 *         // pre-2026-08 loopback Anthropic bridge path as rollback. Only
 *         // the literal "bridge" survives normalization; anything else is
 *         // the default.
 *   }
 *
 * Read fresh per call (tiny file) so edits apply without a restart. The write
 * path (Settings → Accounts "Pi engine" card via routes/connections.ts) is a
 * raw-JSON read-modify-write clone of pi-config.ts's — unknown fields
 * survive, atomic rename + 0600 (no secrets today; the mode keeps the
 * invariant if the file ever grows one).
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { stateDir } from "./paths";
import { managedFeltDb } from "./managed-feltdb";

const COLLECTION = "opensession_pi_engine_settings";
const CONFIG_ID = "settings";
const MIGRATION = "pi-engine-json-to-managed-feltdb-v1";
let piDb: StateFirstDB | undefined;
let rawConfig: (Record<string, unknown> & { __version?: number }) | null = null;

/** Pi-config file path (env override is a test seam, not the feature flag). */
export function piConfigPath(): string {
  return process.env.OPENSESSION_PI_CONFIG || stateDir("pi.json");
}

/** Transport for pi/anthropic/* turns: the in-process native provider
 *  (default) or the loopback HTTP bridge (rollback). */
export type PiAnthropicTransport = "inprocess" | "bridge";

export interface PiEngineConfig {
  enabled: boolean;
  /** Retired compatibility field. Model selection is engine-neutral. */
  pickerModels: string[];
  /** Present only as the non-default "bridge" (absent = "inprocess"). Read it
   *  through piAnthropicTransport(), which resolves the default. */
  anthropicTransport?: PiAnthropicTransport;
}

/** Pure normalization (exported for tests): raw JSON → typed config. Tolerant
 *  — anything that isn't a JSON object normalizes to the disabled config, and
 *  pickerModels entries that aren't full `pi/<provider>/<model>` ids are
 *  dropped (a bare "pi/foo" would otherwise mint a bogus pi passthrough
 *  downstream). Unknown fields (e.g. the retired bridgeAccounts designation —
 *  pi picks from the account pool like pi since 2026-08-06) are simply
 *  ignored. */
/** Whether `id` is a full `pi/<provider>/<model>` model id — the shape the
 *  picker, the write API, and normalizePiConfig's drop rule all agree on (a
 *  bare "pi/foo" would mint a bogus pi passthrough downstream). */
export function isPiModelId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.startsWith("pi/") &&
    id.slice("pi/".length).includes("/")
  );
}

export function normalizePiConfig(raw: unknown): PiEngineConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, pickerModels: [] };
  }
  const r = raw as Record<string, unknown>;
  const pickerModels = Array.isArray(r.pickerModels)
    ? r.pickerModels.filter(isPiModelId)
    : [];
  return {
    enabled: r.enabled === true,
    pickerModels,
    // Only the literal non-default survives; junk/absent = "inprocess".
    ...(r.anthropicTransport === "bridge"
      ? { anthropicTransport: "bridge" as const }
      : {}),
  };
}

export function readPiEngineConfig(): PiEngineConfig | null {
  const projected = process.env.OPENSESSION_PI_CONFIG_JSON;
  if (projected) {
    try { return normalizePiConfig(JSON.parse(projected)); }
    catch { return null; }
  }
  return rawConfig ? normalizePiConfig(rawConfig) : null;
}

export function piConfigProjection(): string | undefined {
  if (!rawConfig) return undefined;
  const { __version: _version, ...raw } = rawConfig;
  return JSON.stringify(raw);
}

export async function initializeManagedPiConfig(db: StateFirstDB = piDb ?? managedFeltDb()): Promise<void> {
  piDb = db;
  if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
    let legacy: Record<string, unknown> | null = null;
    try {
      if (existsSync(piConfigPath())) {
        const parsed = JSON.parse(readFileSync(piConfigPath(), "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) legacy = parsed;
      }
    } catch (error) { throw new Error(`Cannot migrate ${piConfigPath()}: ${String(error)}`); }
    if (legacy) await db.transaction((tx) => {
      tx.collection<Record<string, unknown>>(COLLECTION).set(CONFIG_ID, legacy!);
    }, { transactionId: "opensession:pi-config:migrate" });
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(MIGRATION,
        { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
  }
  if (existsSync(piConfigPath())) unlinkSync(piConfigPath());
  rawConfig = await db.collection<Record<string, unknown> & { __version?: number }>(COLLECTION).get(CONFIG_ID);
}

/** Whether the pi engine may run at all. */
export function piEngineEnabled(): boolean {
  return readPiEngineConfig()?.enabled === true;
}

/** Pi model ids to surface in the UI picker (empty when disabled). */
export function piPickerModels(): string[] {
  const cfg = readPiEngineConfig();
  if (!cfg?.enabled) return [];
  return cfg.pickerModels;
}

/** Resolved transport for pi/anthropic/* turns — "inprocess" unless the
 *  config explicitly says "bridge" (missing/disabled/malformed config all
 *  default; the engine-enabled gate is separate and comes first). */
export function piAnthropicTransport(): PiAnthropicTransport {
  return readPiEngineConfig()?.anthropicTransport === "bridge"
    ? "bridge"
    : "inprocess";
}

// ── Write path (Settings → Accounts "Pi engine" card) ───────────────────────
//
// Raw-JSON read-modify-write, cloned from pi-config.ts: normalization
// drops/renames fields, so writes always go through the raw object to preserve
// everything we don't own. Atomic rename + 0600.

function readRawPiConfig(): Record<string, unknown> {
  return rawConfig ? structuredClone(rawConfig) : {};
}

async function writeRawPiConfig(raw: Record<string, unknown>): Promise<void> {
  delete raw.__version;
  const db = piDb ?? managedFeltDb();
  const previous = rawConfig;
  await db.transaction((tx) => {
    tx.collection<Record<string, unknown>>(COLLECTION).set(CONFIG_ID, raw,
      previous ? { ifVersion: previous.__version } : { requireAbsent: true });
  }, { transactionId: `opensession:pi-config:put:${crypto.randomUUID()}` });
  rawConfig = { ...raw, __version: (previous?.__version ?? 0) + 1 };
}

function rawPiPickerModels(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.pickerModels)
    ? raw.pickerModels.filter((x: unknown): x is string => typeof x === "string" && !!x)
    : [];
}

/** Turn the pi engine on or off. */
export async function setPiEnabled(enabled: boolean): Promise<void> {
  const raw = readRawPiConfig();
  raw.enabled = enabled;
  await writeRawPiConfig(raw);
}

/** Add a `pi/<provider>/<model>` id to pickerModels (idempotent). Throws on a
 *  malformed id — matching normalizePiConfig's drop rule, so a UI add can't
 *  write an id the reader would silently discard. Returns the stored list. */
export async function addPiPickerModel(id: string): Promise<string[]> {
  if (!isPiModelId(id)) {
    throw new Error(`Invalid pi model id "${id}" (expected pi/<provider>/<model>)`);
  }
  const raw = readRawPiConfig();
  const list = rawPiPickerModels(raw);
  if (!list.includes(id)) list.push(id);
  raw.pickerModels = list;
  await writeRawPiConfig(raw);
  return list;
}

/** Remove an id from pickerModels. Returns the stored list. */
export async function removePiPickerModel(id: string): Promise<string[]> {
  const raw = readRawPiConfig();
  const list = rawPiPickerModels(raw).filter((x) => x !== id);
  raw.pickerModels = list;
  await writeRawPiConfig(raw);
  return list;
}

/** Replace pickerModels wholesale in one read-modify-write. Validates every
 *  id up front (throws before touching the file), and — unlike a
 *  remove-then-add loop over the NORMALIZED view — assigns the raw field
 *  directly, so malformed entries hand-written into the file are swept out
 *  by a save instead of surviving invisibly. */
export async function setPiPickerModels(ids: string[]): Promise<string[]> {
  for (const id of ids) {
    if (!isPiModelId(id)) {
      throw new Error(`Invalid pi model id "${id}" (expected pi/<provider>/<model>)`);
    }
  }
  const raw = readRawPiConfig();
  raw.pickerModels = [...new Set(ids)];
  await writeRawPiConfig(raw);
  return raw.pickerModels as string[];
}
