/**
 * Todos — the Desk's per-user todo list. AI-native: any interactive session
 * carries the opensession-todos in-process MCP server (todos-tools.ts), so
 * "put X on my list" works from every conversation and each item remembers
 * which session added it. The Desk overlay (DeskOverlay.tsx) is the human
 * management surface; routes/todos.ts is the HTTP surface.
 *
 * Storage: one managed FeltDB record per todo. Mutations broadcast
 * `todos_changed` to every UI client and mirror into the audit log so a future
 * daily-digest automation sees todo activity with no extra plumbing.
 */
import { randomUUIDv7 } from "bun";
import type { StateFirstDB } from "@feltdb/core";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { audit } from "./audit";
import { sendPushToUser } from "./push";
import { managedFeltDb } from "./managed-feltdb";
import { stateDir } from "./paths";
import { resolveTeammate } from "./shared/user-mappings";
import { broadcastToAll } from "./ws-hub";
import { openDirectMessage, sendSlackMessage } from "../agents/slack/slack-api";
import { personaName } from "./config";

export type TodoStatus = "open" | "done" | "dropped";

export interface TodoSource {
	kind: "session" | "manual";
	/** Session that added the item (deep-linkable provenance). */
	sessionId?: string;
	/** Who was driving: a user name, for display. */
	by?: string;
}

export interface TodoItem {
	id: string;
	/** Owner (first-name convention, same as session createdBy). */
	user: string;
	text: string;
	status: TodoStatus;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	/** Optional provenance/context line ("boss-requested", a PR link, …). */
	note?: string;
	/** Optional ISO due date (YYYY-MM-DD). */
	due?: string;
	/** Optional reminder: ISO datetime; the reminder ticker pushes + Slack-DMs
	 *  the owner once this passes (while the item is still open). */
	remindAt?: string;
	/** Set once the reminder fired, so it fires exactly once. */
	remindedAt?: string;
	source: TodoSource;
}

const MAX_TEXT_CHARS = 500;
const MAX_NOTE_CHARS = 500;
const TODOS_COLLECTION = "opensession_todos";
const TODOS_MIGRATIONS_COLLECTION = "opensession_migrations";
const TODOS_MIGRATION_ID = "todos-json-to-managed-feltdb-v1";
type StoredTodo = TodoItem & {
	reminderPending: boolean;
	__version?: number;
};

function collection() {
	return managedFeltDb().collection<StoredTodo>(TODOS_COLLECTION);
}

/** One-way boot migration for the former JSON authority. The legacy file is
 * removed only after every item and the completion receipt are durable in the
 * managed authority. A completed receipt makes repeated boots no-ops. */
export async function initializeManagedTodos(db: StateFirstDB = managedFeltDb()): Promise<void> {
	const legacyPath = `${stateDir("todos")}/todos.json`;
	const migration = db.collection<{ id: string; completedAt: number }>(TODOS_MIGRATIONS_COLLECTION);
	const completed = await migration.get(TODOS_MIGRATION_ID);
	if (completed) {
		if (existsSync(legacyPath)) unlinkSync(legacyPath);
		return;
	}
	let items: TodoItem[] = [];
	if (existsSync(legacyPath)) {
		const parsed = JSON.parse(readFileSync(legacyPath, "utf8")) as { items?: unknown };
		if (!Array.isArray(parsed.items)) throw new Error("Legacy todo store is invalid");
		items = parsed.items as TodoItem[];
	}
	for (const item of items) {
		if (!item?.id || !item.user || !item.createdAt)
			throw new Error("Legacy todo store contains an invalid item");
		const stored: StoredTodo = {
			...item,
			reminderPending: item.status === "open" && !!item.remindAt && !item.remindedAt,
		};
		const existing = await db.collection<StoredTodo>(TODOS_COLLECTION).get(item.id);
		if (existing) {
			const { __version: _, ...current } = existing;
			if (JSON.stringify(current) !== JSON.stringify(stored))
				throw new Error(`Managed todo ${item.id} conflicts with the legacy migration`);
			continue;
		}
		await db.transaction((tx) => {
			tx.collection<StoredTodo>(TODOS_COLLECTION).set(item.id, stored, { requireAbsent: true });
		}, { transactionId: `opensession:todo:migrate:${item.id}` });
	}
	await db.transaction((tx) => {
		tx.collection(TODOS_MIGRATIONS_COLLECTION).set(TODOS_MIGRATION_ID, {
			id: TODOS_MIGRATION_ID,
			completedAt: Date.now(),
		}, { requireAbsent: true });
	}, { transactionId: `opensession:migration:${TODOS_MIGRATION_ID}` });
	if (existsSync(legacyPath)) unlinkSync(legacyPath);
}

function publicTodo(stored: StoredTodo): TodoItem {
	const { reminderPending: _, __version: __, ...item } = stored;
	return item;
}

function changed(user: string): void {
	broadcastToAll({ type: "todos_changed", user });
}

export async function addTodo(input: {
	user: string;
	text: string;
	note?: string;
	due?: string;
	remindAt?: string;
	source: TodoSource;
}): Promise<TodoItem> {
	const text = (input.text || "").trim().slice(0, MAX_TEXT_CHARS);
	if (!text) throw new Error("todo text is empty");
	const user = (input.user || "").trim();
	if (!user) throw new Error("todo user is empty");
	const now = new Date().toISOString();
	const item: StoredTodo = {
		id: `todo-${randomUUIDv7()}`,
		user,
		text,
		status: "open",
		createdAt: now,
		updatedAt: now,
		...(input.note ? { note: input.note.trim().slice(0, MAX_NOTE_CHARS) } : {}),
		...(input.due ? { due: input.due } : {}),
		...(input.remindAt ? { remindAt: input.remindAt } : {}),
		reminderPending: !!input.remindAt,
		source: input.source,
	};
	await managedFeltDb().transaction((tx) => {
		tx.collection<StoredTodo>(TODOS_COLLECTION).set(item.id, item, { requireAbsent: true });
	}, { transactionId: `opensession:todo:add:${item.id}` });
	audit({
		kind: "todo_added",
		session_id: input.source.sessionId,
		by: input.source.by || user,
		user,
		message: text,
	});
	changed(user);
	return publicTodo(item);
}

/** Newest first within a status; open items before done/dropped. */
export async function listTodos(opts?: {
	user?: string;
	status?: TodoStatus | "all";
	limit?: number;
}): Promise<TodoItem[]> {
	const limit = Math.min(500, Math.max(1, opts?.limit || 200));
	const status = opts?.status || "open";
	const rank: Record<TodoStatus, number> = { open: 0, done: 1, dropped: 2 };
	const page = await managedFeltDb().query<StoredTodo>({
		collection: TODOS_COLLECTION,
		where: [
			...(opts?.user ? [{ field: "user" as const, eq: opts.user }] : []),
			...(status === "all" ? [] : [{ field: "status" as const, eq: status }]),
		],
		orderBy: [{ field: "createdAt", direction: "desc" }],
		limit: status === "all" ? 500 : limit,
	});
	return page.records
		.filter(
			(t) =>
				(!opts?.user || t.user === opts.user) &&
				(status === "all" || t.status === status),
		)
		.sort(
			(a, b) =>
				rank[a.status] - rank[b.status] ||
				(a.createdAt < b.createdAt ? 1 : -1),
		)
		.slice(0, limit)
		.map(publicTodo);
}

export async function getTodo(id: string): Promise<TodoItem | undefined> {
	const item = await collection().get(id);
	return item ? publicTodo(item) : undefined;
}

export async function updateTodo(
	id: string,
	patch: {
		status?: TodoStatus;
		text?: string;
		note?: string | null;
		due?: string | null;
		remindAt?: string | null;
	},
	by?: string,
): Promise<TodoItem> {
	let item = await collection().get(id);
	if (!item) throw new Error(`unknown todo "${id}"`);
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!Number.isSafeInteger(item.__version))
			throw new Error(`Todo ${id} has no FeltDB authority version`);
		const next: StoredTodo = { ...item };
		delete next.__version;
		const now = new Date().toISOString();
		if (patch.status && patch.status !== next.status) {
			next.status = patch.status;
			if (patch.status === "open") delete next.completedAt;
			else next.completedAt = now;
		}
		if (typeof patch.text === "string" && patch.text.trim())
			next.text = patch.text.trim().slice(0, MAX_TEXT_CHARS);
		if (patch.note === null) delete next.note;
		else if (typeof patch.note === "string")
			next.note = patch.note.trim().slice(0, MAX_NOTE_CHARS);
		if (patch.due === null) delete next.due;
		else if (typeof patch.due === "string") next.due = patch.due;
		if (patch.remindAt === null) {
			delete next.remindAt;
			delete next.remindedAt;
			next.reminderPending = false;
		} else if (typeof patch.remindAt === "string") {
			next.remindAt = patch.remindAt;
			delete next.remindedAt;
			next.reminderPending = true;
		}
		next.updatedAt = now;
		const result = await collection().updateIfVersion(id, item.__version!, next);
		if (result.updated) {
			item = next;
			break;
		}
		const refreshed = await collection().get(id);
		if (!refreshed) throw new Error(`Todo ${id} disappeared during update`);
		item = refreshed;
		if (attempt === 4) throw new Error(`Todo ${id} remained contended`);
	}
	audit({
		kind: "todo_updated",
		by: by || item.user,
		user: item.user,
		status: item.status,
		message: item.text,
	});
	changed(item.user);
	return publicTodo(item);
}

// ── Reminders ────────────────────────────────────────────────────────────────
// A 30s sweep fires each open todo's remindAt exactly once: Web Push to the
// owner's devices + a Slack DM (prefixed with the agent's name, per the messaging rule).
// Started once from opensession.ts's __opensessionBooted block.

const SWEEP_MS = 30_000;

async function sweepReminders(): Promise<void> {
	const now = new Date().toISOString();
	const due = (await managedFeltDb().query<StoredTodo>({
		collection: TODOS_COLLECTION,
		where: [
			{ field: "status", eq: "open" },
			{ field: "reminderPending", eq: true },
			{ field: "remindAt", lte: now },
		],
		orderBy: [{ field: "remindAt", direction: "asc" }],
		limit: 100,
	})).records;
	if (!due.length) return;
	for (const t of due) {
		if (!Number.isSafeInteger(t.__version)) continue;
		const claimed = await collection().updateIfVersion(t.id, t.__version!, {
			remindedAt: now,
			reminderPending: false,
			updatedAt: now,
		});
		if (!claimed.updated) continue;
		audit({ kind: "todo_reminder", user: t.user, message: t.text });
		try {
			await sendPushToUser(
				t.user,
				{
					title: "Reminder",
					body: t.text,
					url: "/",
					tag: `todo-reminder-${t.id}`,
				},
				{ dedupeKey: `todo-reminder-${t.id}` },
			);
		} catch (e) {
			console.error("[todos] reminder push failed:", e);
		}
		try {
			const teammate = resolveTeammate(t.user);
			if (teammate) {
				const channel = await openDirectMessage(teammate.slackId);
				if (channel)
					await sendSlackMessage(
						channel,
						`It's ${personaName()} — reminder from your Desk: ${t.text}`,
					);
			}
		} catch (e) {
			console.error("[todos] reminder Slack DM failed:", e);
		}
		changed(t.user);
	}
}

let reminderTimer: ReturnType<typeof setInterval> | null = null;

/** Start the reminder sweep. Call once from the __opensessionBooted block. */
export function startTodoReminderTicker(): void {
	if (reminderTimer) return;
	reminderTimer = setInterval(() => {
		sweepReminders().catch((e) =>
			console.error("[todos] reminder sweep failed:", e),
		);
	}, SWEEP_MS);
	console.log("[todos] reminder ticker started");
}
