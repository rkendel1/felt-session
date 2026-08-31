import type { StateFirstDB } from "@feltdb/core";
import { existsSync, readFileSync, rmSync } from "fs";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";

type RestartRecord = {
  id: "latest";
  by: string;
  at: string;
  signal: string;
};

const COLLECTION = "opensession_restart_state";
const MIGRATION = "restart-state-json-to-managed-feltdb-v1";
let restartDb: StateFirstDB | undefined;
let latestRestart: RestartRecord | undefined;

export async function initializeManagedRestartState(
  db: StateFirstDB = restartDb ?? managedFeltDb(),
  legacyPath = stateDir("last-restart.json"),
): Promise<void> {
  restartDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(MIGRATION)) {
    let legacy: Omit<RestartRecord, "id"> | undefined;
    try {
      if (existsSync(legacyPath)) {
        const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
        if (parsed && typeof parsed.at === "string") legacy = {
          by: typeof parsed.by === "string" ? parsed.by : "",
          at: parsed.at,
          signal: typeof parsed.signal === "string" ? parsed.signal : "",
        };
      }
    } catch {}
    await db.transaction((tx) => {
      if (legacy) tx.collection<RestartRecord>(COLLECTION).set(
        "latest", { id: "latest", ...legacy }, { requireAbsent: true });
      tx.collection("opensession_migrations").set(
        MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
  }
  latestRestart = await db.collection<RestartRecord>(COLLECTION).get("latest") ?? undefined;
  rmSync(legacyPath, { force: true });
}

export function lastRestartBy(): string {
  if (!latestRestart?.by) return "";
  return Date.now() - Date.parse(latestRestart.at) < 10 * 60_000
    ? latestRestart.by
    : "";
}

export async function recordRestart(by: string, signal: string): Promise<void> {
  const record: RestartRecord = {
    id: "latest",
    by,
    at: new Date().toISOString(),
    signal,
  };
  await (restartDb ?? managedFeltDb()).transaction((tx) => {
    tx.collection<RestartRecord>(COLLECTION).set("latest", record);
  }, { transactionId: `opensession:restart:${crypto.randomUUID()}` });
  latestRestart = record;
}
