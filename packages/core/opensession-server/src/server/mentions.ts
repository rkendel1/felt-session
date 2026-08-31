/**
 * @-mentions of a teammate, kept per person so their sidebar can show which
 * sessions are waiting on them. A mention already pushed to their devices
 * (src/server/push.ts); this is the part that survives a closed notification:
 * a durable "you were tagged here" flag that clears when they open the session.
 *
 * One record per (person, session) — the badge is per row, so a second mention
 * in the same session updates the record rather than stacking. Storage is the
 * flat-file pattern of session-notes.ts/pins.ts, keyed on the picker first
 * name, which is also what push subscriptions and the identity table use.
 *
 * The store is append/clear only. It is never replaced wholesale, so a client
 * that writes before it has read cannot wipe anything (the hazard the
 * whole-map PUT in reads.ts carries).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { stateDir } from "./paths";
import { mentionedUsers } from "./people";
import { managedFeltDb } from "./managed-feltdb";
import type { StateFirstDB } from "@feltdb/core";

const MENTIONS_DIR = stateDir("mentions");
const COLLECTION = "opensession_mentions";
const MIGRATION = "mentions-json-to-managed-feltdb-v1";

/** Plenty for a badge list, and a hard bound on an unattended file. */
const MAX_STORED = 200;
const PREVIEW_LEN = 140;

export interface Mention {
	sessionId: string;
	/** Display name of whoever wrote the mention. */
	by: string;
	/** Where it was written: a prompt in the transcript, or a team note. */
	source: "prompt" | "note";
	/** First line or so of the text, for a hover card or a mentions list. */
	preview: string;
	/** ms epoch */
	ts: number;
}

/** Person keys become filenames, so keep the mapping defensive. */
function isValidPerson(name: string): boolean {
	return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

type StoredMention = Mention & { id: string; person: string; state: "active" | "deleted"; updatedAt: number };
const records = new Map<string, StoredMention>();
let mentionDb: StateFirstDB | undefined;
const personKey = (person: string) => person.toLocaleLowerCase();
const recordId = (person: string, sessionId: string) =>
	`mention_${createHash("sha256").update(`${personKey(person)}:${sessionId}`).digest("hex")}`;

function readAll(person: string): Mention[] {
	if (!isValidPerson(person)) return [];
	return [...records.values()]
		.filter((record) => record.person === personKey(person) && record.state === "active")
		.sort((a, b) => a.ts - b.ts)
		.slice(-MAX_STORED);
}

export async function initializeManagedMentions(
	authority: StateFirstDB = managedFeltDb(),
): Promise<void> {
	mentionDb = authority;
	const migrations = authority.collection<{ id: string }>("opensession_migrations");
	if (!await migrations.get(MIGRATION)) {
		const files = existsSync(MENTIONS_DIR) ? readdirSync(MENTIONS_DIR).filter((file) => file.endsWith(".json")) : [];
		for (const file of files) {
			let legacy: unknown[] = [];
			try {
				const raw = JSON.parse(readFileSync(`${MENTIONS_DIR}/${file}`, "utf8"));
				if (Array.isArray(raw?.mentions)) legacy = raw.mentions;
			} catch { continue; }
			const person = file.slice(0, -5).toLocaleLowerCase();
			for (const value of legacy) {
				const mention = value as Mention;
				if (!mention?.sessionId || typeof mention.by !== "string" || typeof mention.ts !== "number") continue;
				const id = recordId(person, mention.sessionId);
				const stored: StoredMention = { ...mention, id, person, state: "active", updatedAt: Date.now() };
				await authority.transaction((tx) => {
					tx.collection<StoredMention>(COLLECTION).set(id, stored);
				}, { transactionId: `opensession:mention:migrate:${id}` });
			}
			unlinkSync(`${MENTIONS_DIR}/${file}`);
		}
		await authority.transaction((tx) => {
			tx.collection("opensession_migrations").set(MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${MIGRATION}` });
	}
	const loaded = authority.runtime().runtime === "remote"
		? await queryMentions(authority)
		: await authority.collection<StoredMention>(COLLECTION).all();
	records.clear();
	for (const record of loaded) records.set(record.id, record);
}

async function queryMentions(authority: StateFirstDB): Promise<StoredMention[]> {
	const loaded: StoredMention[] = [];
	let cursor: string | undefined;
	do {
		const page = await authority.query<StoredMention>({
			collection: COLLECTION,
			orderBy: [{ field: "updatedAt", direction: "desc" }],
			limit: 500,
			...(cursor ? { cursor } : {}),
		});
		loaded.push(...page.records);
		cursor = page.exhausted ? undefined : page.nextCursor;
		if (!page.exhausted && !cursor) throw new Error("FeltDB mentions cursor is missing");
	} while (cursor);
	return loaded;
}

/** This person's outstanding mentions, oldest first. */
export function listMentions(person: string): Mention[] {
	return readAll(person);
}

/**
 * Record that `by` mentioned `person` in `sessionId`. Returns the stored
 * record so the caller can broadcast exactly what it wrote.
 */
export async function addMention(
	person: string,
	mention: Omit<Mention, "ts"> & { ts?: number },
): Promise<Mention | null> {
	if (!isValidPerson(person)) return null;
	const record: Mention = {
		sessionId: mention.sessionId,
		by: mention.by.trim().slice(0, 64),
		source: mention.source,
		preview: mention.preview.trim().slice(0, PREVIEW_LEN),
		ts: mention.ts ?? Date.now(),
	};
	const id = recordId(person, record.sessionId);
	const stored: StoredMention = { ...record, id, person: personKey(person), state: "active", updatedAt: Date.now() };
	const authority = mentionDb ?? managedFeltDb();
	await authority.transaction((tx) => {
		tx.collection<StoredMention>(COLLECTION).set(id, stored);
	}, {
		transactionId: `opensession:mention:${id}:${crypto.randomUUID()}`,
	});
	records.set(id, stored);
	return record;
}

/** Clear this person's mention for one session — what opening it does. */
export async function clearMention(person: string, sessionId: string): Promise<boolean> {
	const id = recordId(person, sessionId);
	const current = records.get(id);
	if (!current || current.state !== "active") return false;
	const deleted = { ...current, state: "deleted" as const, updatedAt: Date.now() };
	await (mentionDb ?? managedFeltDb()).transaction((tx) => {
		tx.collection<StoredMention>(COLLECTION).set(id, deleted);
	}, {
		transactionId: `opensession:mention:clear:${id}:${crypto.randomUUID()}`,
	});
	records.set(id, deleted);
	return true;
}

/** Clear every mention for a person. */
export async function clearAllMentions(person: string): Promise<void> {
	if (!isValidPerson(person)) return;
	for (const mention of readAll(person)) await clearMention(person, mention.sessionId);
}

/**
 * Scan `text` for teammates and record a mention for each. The one place that
 * knows what a mention means, called from all three surfaces that can carry
 * one (a prompt over HTTP, a prompt over the WebSocket, a team note), so the
 * badge and the push can never disagree about who was tagged.
 *
 * Returns the people recorded, for the caller's push loop.
 */
export async function recordMentions(
	text: string,
	sender: string,
	sessionId: string,
	source: Mention["source"],
	onRecorded?: (person: string, mention: Mention) => void,
): Promise<string[]> {
	if (!text.includes("@")) return [];
	const people = mentionedUsers(text, sender);
	for (const person of people) {
		const mention = await addMention(person, {
			sessionId,
			by: sender || "Someone",
			source,
			preview: text,
		});
		if (mention) onRecorded?.(person, mention);
	}
	return people;
}

/**
 * Record a mention and announce it: the durable badge, the live socket frame
 * that marks the row on every device the person has open, and the web push
 * that reaches them with the app closed. Every surface that can carry a
 * mention calls this rather than assembling the three itself, so a new
 * surface cannot ship two of them and forget the third.
 *
 * `where` is the tail of the push title ("… mentioned you in <where>") — the
 * session's title for a message, "a session note" for a note.
 */
export async function notifyMentions(
	text: string,
	sender: string,
	sessionId: string,
	source: Mention["source"],
	where: string,
): Promise<string[]> {
	const { broadcastToAll } = await import("./ws-hub");
	const mentioned = await recordMentions(text, sender, sessionId, source, (person, mention) =>
		broadcastToAll({ type: "mention", user: person, mention }),
	);
	if (!mentioned.length) return mentioned;
	const { sendPushToUser } = await import("./push");
	const body = mentionPreview(text);
	for (const name of mentioned)
		void sendPushToUser(name, {
			title: `${sender || "Someone"} mentioned you in ${where}`,
			body,
			url: `/session/${encodeURIComponent(sessionId)}`,
			// One tag per session per kind: a second mention replaces the
			// notification instead of stacking, and a note never collapses a
			// message (or the other way round).
			tag: `opensession-${source === "note" ? "note" : "mention"}-${sessionId}`,
		});
	return mentioned;
}

/** The push body shares the mention's preview rule. */
export function mentionPreview(text: string): string {
	return text.length > PREVIEW_LEN
		? `${text.slice(0, PREVIEW_LEN - 1)}…`
		: text;
}
