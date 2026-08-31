/**
 * Desk — the per-user standing concierge session behind the summonable Desk
 * overlay (⌘J / the floating button). One durable ask-mode session per user
 * (session file flag `desk: true`, fixed title, hidden from the normal
 * regular session lists) that the user can open on top of whatever
 * they're doing: manage their todo list (todos.ts), ask quick questions, and
 * delegate real work to worker sessions via the opensession-sessions tools
 * every interactive run carries.
 *
 * Deliberately NOT an event feed — the deleted HQ feature (84f8bbfa) showed
 * that a passive event digest gets skipped. The Desk only ever speaks when
 * spoken to; the pull is the persistent todo list.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { StateFirstDB } from "@feltdb/core";
import { newSessionId, stateDir } from "./paths";
import { managedFeltDb } from "./managed-feltdb";
import {
	findSession,
	touchNativeSession,
	updateSessionFile,
} from "./session-cache";
import type { NativeSessionFile } from "./types";

interface DeskStore {
	users: Record<string, { sessionId?: string; clearedAt?: string }>;
}

interface StoredDesk {
	id: string;
	user: string;
	sessionId?: string;
	clearedAt?: string;
	__version?: number;
}

const CONFIG_DIR = stateDir("desk");
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const COLLECTION = "opensession_desks";
const MIGRATION = "desk-config-json-to-managed-feltdb-v1";
let deskDb: StateFirstDB | undefined;
const desks = new Map<string, StoredDesk>();
const deskId = (user: string) => `desk_${createHash("sha256").update(user).digest("hex")}`;

export async function initializeManagedDesks(db: StateFirstDB = deskDb ?? managedFeltDb()): Promise<void> {
	deskDb = db;
	if (!await db.collection<{ id: string }>("opensession_migrations").get(MIGRATION)) {
		let legacy: DeskStore = { users: {} };
		try { if (existsSync(CONFIG_PATH)) legacy = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
		for (const [user, state] of Object.entries(legacy.users ?? {})) {
			const id = deskId(user);
			await db.transaction((tx) => {
				tx.collection<StoredDesk>(COLLECTION).set(id, { id, user, ...state, __version: 1 });
			}, { transactionId: `opensession:desk:migrate:${id}` });
		}
		await db.transaction((tx) => {
			tx.collection("opensession_migrations").set(MIGRATION, { id: MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
		}, { transactionId: `opensession:migration:${MIGRATION}` });
	}
	if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
	desks.clear();
	for (const record of await db.collection<StoredDesk>(COLLECTION).all()) desks.set(record.id, record);
}

async function saveDesk(record: StoredDesk): Promise<void> {
	const db = deskDb ?? managedFeltDb();
	if (record.__version !== undefined && !Number.isSafeInteger(record.__version))
		throw new Error(`Desk ${record.id} has no FeltDB authority version`);
	await db.transaction((tx) => {
		tx.collection<StoredDesk>(COLLECTION).set(record.id, record,
			record.__version === undefined ? { requireAbsent: true } : { ifVersion: record.__version });
	}, { transactionId: `opensession:desk:save:${record.id}:${crypto.randomUUID()}` });
	record.__version = (record.__version ?? 0) + 1;
	desks.set(record.id, record);
}

/** Desk turns should feel instant: quick capture / list ops / delegation,
 *  not deep reasoning — so the session defaults to Sonnet on low effort
 *  rather than the interactive dial. /model in the expanded view overrides. */
const DESK_MODEL = "pi/anthropic/claude-sonnet-5";
const DESK_EFFORT = "low";

/** Get or create the user's repo-less Desk session. */
export async function ensureDeskSession(user: string): Promise<{
	sessionId: string;
	clearedAt?: string;
}> {
	const recordId = deskId(user);
	const st = desks.get(recordId) ?? { id: recordId, user };
	const existing = st.sessionId ? findSession(st.sessionId) : undefined;
	if (st.sessionId && existing) {
		const patch: Partial<NativeSessionFile> = {};
		// Backfill the fast-model default onto Desks minted before it existed —
		// but never clobber a deliberate /model choice.
		if (!existing.model) {
			patch.model = DESK_MODEL;
			patch.effort = DESK_EFFORT;
		}
		// A Desk is a standing scratch session, never a project workspace. Older
		// Desks were stamped with the instance repo, which leaked into the expanded
		// viewer's breadcrumb and offered sibling tabs that do not belong here.
		if (
			!existing.repoLess ||
			existing.repo ||
			existing.worktreeDir ||
			existing.branch ||
			existing.workspaceId ||
			existing.attachedRepos?.length
		) {
			patch.repo = undefined;
			patch.repoLess = true;
			patch.worktreeDir = "";
			patch.branch = "";
			patch.workspaceId = null;
			patch.attachedRepos = [];
		}
		if (Object.keys(patch).length > 0) await touchNativeSession(st.sessionId, patch);
		return { sessionId: st.sessionId, clearedAt: st.clearedAt };
	}
	const id = newSessionId();
	const now = new Date().toISOString();
	// Field-scoped create via the serialized session-file writer — this site
	// owns every creation field (the fresh id means the file never pre-exists,
	// so the create-if-absent overlay is just belt-and-braces). Uncontended
	// writes run synchronously, so the caller can open the session immediately.
	updateSessionFile(id, (data) => {
		const existing: Partial<NativeSessionFile> = data;
		return {
			id,
			claudeSessionId: "",
			branch: "",
			worktreeDir: "",
			mode: "ask" as const,
			desk: true,
			repoLess: true,
			createdBy: user,
			createdAt: now,
			lastActivity: now,
			title: "Desk",
			model: DESK_MODEL,
			effort: DESK_EFFORT,
			...existing,
		};
	}).catch((e) =>
		console.error(`[desk] failed to write Desk session ${id}:`, e),
	);
	st.sessionId = id;
	await saveDesk(st);
	console.log(`[desk] created Desk session ${id} for ${user}`);
	return { sessionId: id, clearedAt: st.clearedAt };
}

/** "Clear" in the Desk overlay: hide everything before now from the modal's
 *  transcript view. A display marker only — the transcript itself is untouched and
 *  fully visible in the expanded session view. */
export async function clearDesk(user: string): Promise<{ clearedAt: string }> {
	const id = deskId(user);
	const st = desks.get(id) ?? { id, user };
	st.clearedAt = new Date().toISOString();
	await saveDesk(st);
	return { clearedAt: st.clearedAt };
}

/** The role charter prepended to every Desk-session prompt (run-session.ts). */
export const DESK_NOTE = `## Your role: the Desk

This session is the user's Desk — their standing concierge, summoned as a quick overlay on top of whatever they're doing. Discipline:

- Keep answers short and immediate; the user is mid-task and will close this overlay in seconds.
- Manage their todo list with the opensession-todos tools: capture items the moment they mention wanting/needing to do something ("I want to finish X today" → add_todo), mark things done when they say so, and use list_todos before answering "what's on my plate?".
- Ask mode only makes the repository checkout read-only; it does not prevent updating todos through their tools. If earlier messages in this Desk conversation claim otherwise, those refusals are outdated: correct them and use the requested Desk tool directly.
- You are an orchestrator, not the worker: for anything beyond a quick answer or a list edit, spawn a scoped worker session via opensession-sessions create_session and tell the user you did — never start long implementation work inside this session.
- Never drop a todo without the user asking; when in doubt, ask.`;
