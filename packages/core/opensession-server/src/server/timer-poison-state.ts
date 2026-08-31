import type { StateFirstDB } from "@feltdb/core";
import { existsSync, readFileSync, rmSync } from "fs";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";

type TimerPoisonRecord = { id: "guard"; exits: string[] };
const COLLECTION = "opensession_timer_poison_state";
const MIGRATION = "timer-poison-json-to-managed-feltdb-v1";
const WINDOW_MS = 30 * 60_000;
let dbAuthority: StateFirstDB | undefined;
let exits: string[] = [];
let persistTail: Promise<void> = Promise.resolve();

export async function initializeManagedTimerPoisonState(
  db: StateFirstDB = dbAuthority ?? managedFeltDb(),
  legacyPath = stateDir("timer-poison.json"),
): Promise<void> {
  await persistTail;
  dbAuthority = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  const migrationComplete = !!await migrations.get(MIGRATION);
  let legacy: string[] = [];
  try {
    if (existsSync(legacyPath)) {
      const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (Array.isArray(parsed?.exits)) legacy = parsed.exits.filter((value: unknown) => typeof value === "string");
    }
  } catch {}
  const stored = await db.collection<TimerPoisonRecord>(COLLECTION).get("guard");
  if (!migrationComplete || legacy.length > 0) {
    const merged = [...new Set([...(stored?.exits ?? []), ...legacy])];
    await db.transaction((tx) => {
      tx.collection<TimerPoisonRecord>(COLLECTION).set("guard", { id: "guard", exits: merged });
      if (!migrationComplete) tx.collection("opensession_migrations").set(
        MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
  }
  exits = (await db.collection<TimerPoisonRecord>(COLLECTION).get("guard"))?.exits ?? [];
  rmSync(legacyPath, { force: true });
}

export function noteTimerPoisonExit(now = new Date()): { halted: boolean; exits: string[] } {
  const cutoff = now.getTime() - WINDOW_MS;
  exits = exits.filter((timestamp) => Date.parse(timestamp) > cutoff);
  if (exits.length >= 3) return { halted: true, exits: [...exits] };
  exits.push(now.toISOString());
  const record: TimerPoisonRecord = { id: "guard", exits: [...exits] };
  const db = dbAuthority ?? managedFeltDb();
  const write = persistTail.then(async () => {
    await db.transaction((tx) => {
      tx.collection<TimerPoisonRecord>(COLLECTION).set("guard", record);
    }, { transactionId: `opensession:timer-poison:${crypto.randomUUID()}` });
  });
  persistTail = write.catch((error) => console.error("[run-ws] failed to persist timer poison guard:", error));
  return { halted: false, exits: [...exits] };
}

export async function flushTimerPoisonWrites(): Promise<void> {
  await persistTail;
}
