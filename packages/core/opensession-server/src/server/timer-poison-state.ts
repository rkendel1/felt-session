import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";

type TimerPoisonRecord = { id: "guard"; exits: string[] };
const COLLECTION = "opensession_timer_poison_state";
const WINDOW_MS = 30 * 60_000;
let dbAuthority: StateFirstDB | undefined;
let exits: string[] = [];
let persistTail: Promise<void> = Promise.resolve();

export async function initializeManagedTimerPoisonState(
  db: StateFirstDB = dbAuthority ?? managedFeltDb(),
): Promise<void> {
  await persistTail;
  dbAuthority = db;
  const stored = await db.collection<TimerPoisonRecord>(COLLECTION).get("guard");
  exits = stored?.exits ?? [];
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
