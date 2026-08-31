/**
 * Team notes on a session — human-to-human messages that ride the session's
 * transcript but never reach the agent. Plain's "internal note", for our own
 * sessions: you leave one for a teammate reading the run, not for the model.
 *
 * This is a narrow re-implementation of a feature that shipped in July on the
 * native team-chat backend (`session:<id>` channels in the since-deleted
 * src/server/chat.ts) and was removed with it in 5c90eddc. What came back is
 * only the part that was in use: per-session notes with optional images. No
 * watercooler, threads or reactions.
 *
 * Notes persist per session in managed FeltDB. Realtime delivery rides the app
 * WebSocket from the route; an `@Name` mention web-pushes that teammate's
 * devices via src/server/push.ts and records a sidebar badge via
 * src/server/mentions.ts, which owns the mention scan for notes and prompts
 * alike.
 */

import { existsSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import type { StateFirstDB } from "@feltdb/core";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";
import { removeStagedImages } from "./uploads";

const NOTES_DIR = stateDir("session-notes");
const NOTES_COLLECTION = "opensession_session_notes";
const NOTES_MIGRATION = "session-notes-json-to-managed-feltdb-v1";

// Keep each session's store bounded — the UI only ever loads the recent tail.
const MAX_STORED = 2000;
const MAX_TEXT_LEN = 8000;

export interface SessionNote {
	id: string;
	/** Sender's display name, as resolved from the verified identity. */
	user: string;
	text: string;
	/** Media-route URLs for images attached to the note. */
	images?: string[];
	/** ms epoch */
	ts: number;
	/** ms epoch of the last edit; absent on notes never edited. */
	editedAt?: number;
}

interface StoredSessionNotes {
	id: string;
	sessionId: string;
	notes: SessionNote[];
	__version?: number;
}

let notesDb: StateFirstDB | undefined;
const noteStores = new Map<string, StoredSessionNotes>();
const notesId = (sessionId: string) => `session_notes_${createHash("sha256").update(sessionId).digest("hex")}`;

export async function initializeManagedSessionNotes(
	db: StateFirstDB = notesDb ?? managedFeltDb(),
): Promise<void> {
	notesDb = db;
	const migrations = db.collection<{ id: string }>("opensession_migrations");
	if (!await migrations.get(NOTES_MIGRATION)) {
		if (existsSync(NOTES_DIR)) {
			for (const entry of readdirSync(NOTES_DIR, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const sessionId = entry.name.slice(0, -5);
				const path = `${NOTES_DIR}/${entry.name}`;
				const raw = JSON.parse(readFileSync(path, "utf8")) as { notes?: SessionNote[] };
				const id = notesId(sessionId);
				await db.transaction((tx) => {
					tx.collection<StoredSessionNotes>(NOTES_COLLECTION).set(id, {
						id,
						sessionId,
						notes: Array.isArray(raw.notes) ? raw.notes.slice(-MAX_STORED) : [],
					});
				}, { transactionId: `opensession:session-notes:migrate:${id}` });
				unlinkSync(path);
			}
			try { rmdirSync(NOTES_DIR); } catch {}
		}
		await db.transaction((tx) => {
			tx.collection("opensession_migrations").set(NOTES_MIGRATION, { id: NOTES_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${NOTES_MIGRATION}` });
	}
	noteStores.clear();
	for (const record of await db.collection<StoredSessionNotes>(NOTES_COLLECTION).all())
		noteStores.set(record.sessionId, record);
}

/** Session ids are minted by us (`os-<uuidv7>`), but keep the filename mapping
 *  defensive: anything outside this charset can't become a path. */
export function isValidNoteSession(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(id);
}

function readAll(sessionId: string): SessionNote[] {
	return [...(noteStores.get(sessionId)?.notes || [])];
}

async function mutateNotes<T>(
	sessionId: string,
	mutate: (notes: SessionNote[]) => { notes: SessionNote[]; result: T; removedImages?: string[] },
): Promise<T> {
	const db = notesDb ?? managedFeltDb();
	const id = notesId(sessionId);
	const operationId = crypto.randomUUID();
	for (let attempt = 0; attempt < 5; attempt++) {
		const current = await db.collection<StoredSessionNotes>(NOTES_COLLECTION).get(id);
		if (current && !Number.isSafeInteger(current.__version))
			throw new Error(`Session notes ${id} have no FeltDB authority version`);
		const next = mutate([...(current?.notes || [])]);
		try {
			await db.transaction((tx) => {
				tx.collection<StoredSessionNotes>(NOTES_COLLECTION).set(id, {
					id, sessionId, notes: next.notes.slice(-MAX_STORED),
				}, current ? { ifVersion: current.__version } : { requireAbsent: true });
			}, { transactionId: `opensession:session-notes:mutate:${id}:${operationId}` });
			const saved = await db.collection<StoredSessionNotes>(NOTES_COLLECTION).get(id);
			if (!saved) throw new Error(`Session notes ${id} disappeared after mutation`);
			noteStores.set(sessionId, saved);
			removeStagedImages(next.removedImages);
			return next.result;
		} catch (error) {
			if (attempt === 4) throw error;
		}
	}
	throw new Error(`Session notes ${id} mutation did not complete`);
}

/** The session's most recent `limit` notes, oldest first. */
export function listSessionNotes(sessionId: string, limit = 200): SessionNote[] {
	const capped = Math.max(1, Math.min(limit, MAX_STORED));
	return readAll(sessionId).slice(-capped);
}

/** Append a note and return the stored record, or null when it is empty. */
export async function addSessionNote(
	sessionId: string,
	user: string,
	text: string,
	images: string[] = [],
): Promise<SessionNote | null> {
	const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
	if (!trimmed && images.length === 0) return null;
	const note: SessionNote = {
		id: crypto.randomUUID(),
		user: user.trim().slice(0, 64),
		text: trimmed,
		...(images.length ? { images } : {}),
		ts: Date.now(),
	};
	return mutateNotes(sessionId, (all) => {
		const existing = all.findIndex((candidate) => candidate.id === note.id);
		if (existing >= 0) all[existing] = note;
		else all.push(note);
		const removed = all.slice(0, -MAX_STORED).flatMap((old) => old.images || []);
		return { notes: all, result: note, removedImages: removed };
	});
}

/** Author check, used by both mutations. Display names are what a note
 *  carries, so the comparison is case-insensitive on the trimmed name — the
 *  same shape the rest of the app compares identities with. */
function isAuthor(note: SessionNote, user: string): boolean {
	return note.user.trim().toLowerCase() === user.trim().toLowerCase();
}

/** Outcome of a mutation, so the route can pick its status code: a missing
 *  note is a 404 and someone else's note is a 403, and the caller shouldn't
 *  have to re-read the store to tell them apart. */
export type NoteMutation =
	| { ok: true; note: SessionNote }
	| { ok: false; reason: "not_found" | "not_author" };

/**
 * Edit a note's text. Only its author may: a note is one person speaking, and
 * a teammate silently rewriting it would make the transcript a record of
 * something nobody said. `editedAt` is set so the UI can mark it.
 */
export async function editSessionNote(
	sessionId: string,
	noteId: string,
	text: string,
	user: string,
): Promise<NoteMutation> {
	const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
	if (!trimmed) return { ok: false, reason: "not_found" };
	return mutateNotes(sessionId, (all) => {
		const note = all.find((candidate) => candidate.id === noteId);
		if (!note) return { notes: all, result: { ok: false, reason: "not_found" } as NoteMutation };
		if (!isAuthor(note, user)) return { notes: all, result: { ok: false, reason: "not_author" } as NoteMutation };
		note.text = trimmed;
		note.editedAt = Date.now();
		return { notes: all, result: { ok: true, note } as NoteMutation };
	});
}

/** Delete a note. Author-only, for the same reason as editing. */
export async function deleteSessionNote(
	sessionId: string,
	noteId: string,
	user: string,
): Promise<NoteMutation> {
	return mutateNotes(sessionId, (all) => {
		const note = all.find((candidate) => candidate.id === noteId);
		if (!note) return { notes: all, result: { ok: false, reason: "not_found" } as NoteMutation };
		if (!isAuthor(note, user)) return { notes: all, result: { ok: false, reason: "not_author" } as NoteMutation };
		return {
			notes: all.filter((candidate) => candidate.id !== noteId),
			result: { ok: true, note } as NoteMutation,
			removedImages: note.images,
		};
	});
}

/**
 * Latest note per session — what an unread indicator would key off. One scan
 * over the notes dir; the files are small and team-scale, so no cache.
 */
export function sessionNoteActivity(): Array<{
	sessionId: string;
	lastTs: number;
	lastUser: string;
}> {
	const out: Array<{ sessionId: string; lastTs: number; lastUser: string }> = [];
	for (const [sessionId, store] of noteStores) {
		const last = store.notes[store.notes.length - 1];
		if (!last) continue;
		out.push({ sessionId, lastTs: last.ts, lastUser: last.user });
	}
	return out;
}
