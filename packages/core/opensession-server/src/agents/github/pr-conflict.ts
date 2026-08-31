/**
 * "Your PR now conflicts" as a system event, delivered to the one session that
 * owns the PR.
 *
 * GitHub has no webhook for this. The `pull_request` action list has nothing
 * for a mergeability change; the `mergeable` field in a delivery is computed
 * lazily, so it arrives null or stale; and the usual cause of a conflict is
 * SOMEONE ELSE's PR landing on the base branch, which fires no event carrying
 * the affected PR's number at all. So the event is synthesized here, off the
 * 60s bulk sweep (pr-cache.ts) that already tracks `mergeable` per PR. No new
 * GitHub subscription and no extra API calls.
 *
 * The transition that matters is MERGEABLE → CONFLICTING. Two properties of the
 * tracking are deliberate:
 *  - UNKNOWN is ignored rather than recorded. GitHub reports it whenever the
 *    background merge test hasn't finished, so a flicker through UNKNOWN must
 *    not hide a real transition or manufacture a fake one.
 *  - Last-known mergeability is in memory, so a PR first seen as CONFLICTING
 *    stays quiet. Once a real transition is observed, its delivery intent is
 *    persisted until SessionControl durably admits it, including across restarts.
 *
 * Delivery goes to exactly ONE session, and only tells it what happened. The
 * session decides when (and whether) to resolve. Nothing here touches git.
 */
import type { PrInfo } from "../../server/pr-cache";
import { stateDir } from "../../server/paths";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "../../server/managed-feltdb";

export interface PrConflictEvent {
  repoId: string;
  branch: string;
  number: number;
  title: string;
  url: string;
  /** Unique transition identity; a later re-conflict gets another receipt. */
  conflictId: string;
  /** Session id from the PR body's attribution footer, when it carried one. */
  sessionRef?: string;
}

const lastKnown = new Map<string, string>();
const delivering = new Set<string>();
const pending = new Map<string, PrConflictEvent>();
let conflictSequence = 0;
let persistenceSequence = 0;
let pendingGeneration = 0;
let persistedGeneration = 0;
let conflictDb: StateFirstDB | undefined;
let persistenceChain = Promise.resolve();
const COLLECTION = "opensession_github_conflict_intents";
const MIGRATION = "github-conflict-intents-json-to-managed-feltdb-v1";

function prKeyOf(repoId: string, number: number): string {
  return `${repoId}#${number}`;
}

function pendingPath(): string {
  return `${stateDir("github")}/conflict-intents.json`;
}

type StoredConflictIntent = PrConflictEvent & { id: string; prKey: string };
const recordId = (key: string) => `github_conflict_${createHash("sha256").update(key).digest("hex")}`;

export async function initializeManagedGithubConflictIntents(
  db: StateFirstDB = conflictDb ?? managedFeltDb(),
): Promise<void> {
  conflictDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (!await migrations.get(MIGRATION)) {
    let intents: PrConflictEvent[] = [];
    try {
      if (existsSync(pendingPath())) {
        const stored = JSON.parse(readFileSync(pendingPath(), "utf8")) as { intents?: PrConflictEvent[] };
        intents = stored.intents || [];
      }
    } catch {}
    for (const event of intents) {
      const prKey = prKeyOf(event.repoId, event.number);
      const id = recordId(prKey);
      await db.transaction((tx) => {
        tx.collection<StoredConflictIntent>(COLLECTION).set(id, { ...event, id, prKey });
      }, { transactionId: `opensession:github-conflict:migrate:${id}` });
    }
    await db.transaction((tx) => {
      tx.collection("opensession_migrations").set(MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
    }, { transactionId: `opensession:migration:${MIGRATION}` });
    if (existsSync(pendingPath())) unlinkSync(pendingPath());
  }
  pending.clear();
  for (const record of await db.collection<StoredConflictIntent>(COLLECTION).all())
    pending.set(record.prKey, record);
  pendingGeneration = 0;
  persistedGeneration = 0;
}

/** Test seam: forget remembered transition state. */
export function resetConflictWatch(): void {
  lastKnown.clear();
  delivering.clear();
  pending.clear();
  conflictSequence = 0;
  pendingGeneration = 0;
  persistedGeneration = 0;
}

/** Flush the current intent snapshot before attempting any delivery. */
export function persistConflictIntents(): Promise<void> {
  if (pendingGeneration === persistedGeneration) return persistenceChain;
  const snapshot = new Map(pending);
  const generation = pendingGeneration;
  const db = conflictDb ?? managedFeltDb();
  persistenceChain = persistenceChain.then(async () => {
    const stored = await db.collection<StoredConflictIntent>(COLLECTION).all();
    if (stored.length !== 0 || snapshot.size !== 0) {
      await db.transaction((tx) => {
        const collection = tx.collection<StoredConflictIntent>(COLLECTION);
        for (const record of stored) if (!snapshot.has(record.prKey)) collection.delete(record.id);
        for (const [prKey, event] of snapshot) {
          const id = recordId(prKey);
          collection.set(id, { ...event, id, prKey });
        }
      }, { transactionId: `opensession:github-conflict:persist:${Date.now()}:${++persistenceSequence}` });
    }
    persistedGeneration = Math.max(persistedGeneration, generation);
  });
  return persistenceChain;
}

export function scanConflictTransitions(
  data: Map<string, Map<string, PrInfo>>,
  freshRepos: Set<string>,
): PrConflictEvent[] {
  const events: PrConflictEvent[] = [];
  let pendingChanged = false;
  const seen = new Set<string>();
  for (const repoId of freshRepos) {
    for (const [branch, pr] of data.get(repoId) || []) {
      if (pr.state !== "OPEN") continue;
      const key = prKeyOf(repoId, pr.number);
      seen.add(key);
      if (pr.mergeable !== "MERGEABLE" && pr.mergeable !== "CONFLICTING") continue;
      const prev = lastKnown.get(key);
      lastKnown.set(key, pr.mergeable);
      if (pr.mergeable === "MERGEABLE" && pending.delete(key))
        pendingChanged = true;
      if (prev === "MERGEABLE" && pr.mergeable === "CONFLICTING") {
        const event: PrConflictEvent = {
          repoId,
          branch,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          conflictId: `${pr.headRefOid || "unknown"}:${Date.now().toString(36)}:${++conflictSequence}`,
          ...(pr.sessionRef ? { sessionRef: pr.sessionRef } : {}),
        };
        pending.set(key, event);
        pendingChanged = true;
        events.push(event);
      }
    }
  }
  for (const key of [...lastKnown.keys()]) {
    const repoId = key.slice(0, key.lastIndexOf("#"));
    if (freshRepos.has(repoId) && !seen.has(key)) {
      lastKnown.delete(key);
      if (pending.delete(key)) pendingChanged = true;
    }
  }
  const emitted = new Set(events.map((event) => prKeyOf(event.repoId, event.number)));
  for (const [key, event] of pending) {
    if (
      !emitted.has(key) &&
      freshRepos.has(event.repoId) &&
      lastKnown.get(key) === "CONFLICTING"
    )
      events.push(event);
  }
  if (pendingChanged) pendingGeneration++;
  return events;
}

export function conflictMessage(event: PrConflictEvent): string {
  return `PR #${event.number} “${event.title}” now has merge conflicts with its base branch. ${event.url}`;
}

export function isCurrentConflictIntent(event: PrConflictEvent): boolean {
  return (
    pending.get(prKeyOf(event.repoId, event.number))?.conflictId ===
    event.conflictId
  );
}

export async function settleConflictIntent(event: PrConflictEvent): Promise<void> {
  const key = prKeyOf(event.repoId, event.number);
  if (pending.get(key)?.conflictId !== event.conflictId) return;
  pending.delete(key);
  pendingGeneration++;
  await persistConflictIntents();
}

export async function notifyConflictedPrSession(event: PrConflictEvent): Promise<void> {
  const key = `${prKeyOf(event.repoId, event.number)}:${event.conflictId}`;
  if (delivering.has(key)) return;
  delivering.add(key);
  try {
    const { tryGetSessionControl } = await import("../../server/session-control");
    const control = tryGetSessionControl();
    if (!control) return;

    let target = event.sessionRef ? control.getSession(event.sessionRef) : undefined;
    if (target?.state === "archived") target = undefined;
    if (!target) {
      const { matchSessions } = await import("./session-notify");
      target = [...matchSessions(control, event.repoId, event.branch)].sort(
        (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
      )[0];
    }
    if (!target) return;

    const { audit } = await import("../../server/audit");
    const res = await control.deliverToSession(
      target.id,
      conflictMessage(event),
      "GitHub",
      {
        deliveryId: `github-conflict:${event.repoId}:${event.number}:${event.conflictId}`,
        admissionKey: event.conflictId,
        admit: () => isCurrentConflictIntent(event),
      },
    );
    console.log(
      `[github] PR #${event.number} now conflicting → ${target.id}: ${res.status}`,
    );
    audit({
      msg: "github_pr_conflict_notified",
      pr_number: event.number,
      repo_id: event.repoId,
      head_ref: event.branch,
      session_id: target.id,
      matched_by: event.sessionRef === target.id ? "pr_footer" : "head_branch",
      delivery: res.status,
    });
    if (res.status !== "error") await settleConflictIntent(event);
  } catch (error) {
    console.error(`[github] conflict notification failed for PR #${event.number}:`, error);
  } finally {
    delivering.delete(key);
  }
}
