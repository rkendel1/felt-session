/**
 * Durable state for the session actor boundary.
 *
 * The SQLite file is a journal for decisions, not a second transcript store.
 * A SessionKernel is the only writer. Read projections may consume changes,
 * but they never participate in admission or recovery decisions.
 */
import { Database } from "bun:sqlite";
import { nextRunState, type RunEvent, type RunState } from "./run-state-machine";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname } from "path";
import { sessionsDir } from "../paths";

export type DurableCommandStatus = "pending" | "processing" | "completed" | "failed" | "indeterminate";

export interface DurableCommandRecord {
	sessionId: string;
	requestId: string;
	type: string;
	payload: unknown;
	payloadHash: string;
	status: DurableCommandStatus;
	result?: unknown;
	error?: string;
	createdAt: number;
	updatedAt: number;
	replaySafe: boolean;
	retryable?: boolean;
	acknowledgedAt?: number;
	resultHash?: string;
	terminalFailure: boolean;
}

export interface DurableRunState {
	state: string;
	since: string;
	lastEvent?: string;
	generation: number;
	currentRunId?: string;
	changeSeq: number;
}

export interface DurableTimer {
	sessionId: string;
	timerId: string;
	kind: string;
	dueAt: number;
	token: string;
	payload: unknown;
	attempts: number;
	nextAttemptAt: number;
	lastError?: string;
	deadLetteredAt?: number;
	createdAt: number;
}

export interface DurableOutboxItem {
	id: number;
	effectId: string;
	effectKey: string;
	sessionId: string;
	kind: string;
	payload: unknown;
	attempts: number;
	nextAttemptAt: number;
	lastError?: string;
	deadLetteredAt?: number;
	createdAt: number;
}

const json = (value: unknown): string => JSON.stringify(value ?? null);
const digest = (text: string): string =>
	new Bun.CryptoHasher("sha256").update(text).digest("hex");
const resultRecord = (value: unknown) => {
	const text = json(value);
	return {
		text,
		hash: digest(text),
		terminalFailure:
			!!value &&
			typeof value === "object" &&
			(value as Record<string, unknown>).__sessionKernelFailure === true,
	};
};
const parsed = <T>(value: string | null | undefined): T | undefined => {
	if (value == null) return undefined;
	return JSON.parse(value) as T;
};
type ProcessOwnerIdentity = { token: string; bootId?: string; start?: string };
function linuxBootId(): string | undefined {
	try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
	catch { return undefined; }
}
function linuxProcessStart(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		return fields[19];
	} catch { return undefined; }
}
function parseOwnerIdentity(value: string): ProcessOwnerIdentity | undefined {
	try {
		const parsed = JSON.parse(value) as ProcessOwnerIdentity;
		return typeof parsed?.token === "string" ? parsed : undefined;
	} catch { return undefined; }
}
function plausibleLegacyOwner(pid: number): boolean {
	try {
		const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
		if (!command.includes("opensession.ts")) return false;
		const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
		const stateDir = environment.find((entry) => entry.startsWith("OPENSESSION_STATE_DIR="))?.slice("OPENSESSION_STATE_DIR=".length);
		const sessionOverride = environment.find((entry) => entry.startsWith("OPENSESSION_SESSIONS_DIR="))?.slice("OPENSESSION_SESSIONS_DIR=".length);
		if (sessionOverride && sessionOverride !== sessionsDir()) return false;
		if (stateDir && !sessionsDir().startsWith(stateDir)) return false;
		return true;
	} catch {
		// Non-Linux and unreadable process evidence fail closed during the one-time
		// migration from pre-identity owner rows.
		return true;
	}
}
const ownerGlobal = globalThis as typeof globalThis & {
	__opensessionSessionKernelOwnerId?: string;
};
const PROCESS_OWNER_ID = (ownerGlobal.__opensessionSessionKernelOwnerId ??=
	JSON.stringify({
		token: crypto.randomUUID(),
		bootId: linuxBootId(),
		start: linuxProcessStart(process.pid),
	} satisfies ProcessOwnerIdentity));
export const SESSION_KERNEL_SCHEMA_VERSION = 6;


export function sessionKernelDbPath(): string {
	// Test processes must never open the live instance state. Tests that need
	// restart persistence construct a store at an explicit temporary path.
	if (process.env.NODE_ENV === "test") return ":memory:";
	return `${sessionsDir()}/session-kernel.sqlite`;
}

export type RunEventDecision = {
	sessionId: string;
	event: RunEvent;
	detail?: Record<string, unknown>;
	runKey?: string;
};

export type RunEventDecisionResult = {
	accepted: boolean;
	from: RunState;
	to: RunState;
	reason?: "invalid_transition" | "stale_run";
	currentRunId?: string;
	rejectedRunId?: string;
	state: DurableRunState;
};

export class SessionKernelStore {
	private readonly db: Database;
	private readonly closeable: boolean;
	private readonly runStateCache = new Map<string, DurableRunState>();
	private readonly dirtyChangeSessions = new Set<string>();
	private readonly path: string;

	constructor(path = sessionKernelDbPath()) {
		this.path = path;
		if (path !== ":memory:") {
			const dir = dirname(path);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}
		this.db = new Database(path);
		this.closeable = true;
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = FULL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_kernel_owner (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				owner_id TEXT NOT NULL,
				pid INTEGER NOT NULL,
				claimed_at INTEGER NOT NULL
			);
		`);
		// Claim before inspecting or mutating any durable schema. A concurrent old
		// actor must never observe migrations performed by a losing process.
		this.claimWriter();
		const schemaVersion = Number(
			(this.db.query("PRAGMA user_version").get() as { user_version: number })
				.user_version,
		);
		if (schemaVersion > SESSION_KERNEL_SCHEMA_VERSION)
			throw new Error(
				`Session kernel schema ${schemaVersion} is newer than supported ${SESSION_KERNEL_SCHEMA_VERSION}`,
			);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_kernel_owner (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				owner_id TEXT NOT NULL,
				pid INTEGER NOT NULL,
				claimed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_tombstones (
				session_id TEXT PRIMARY KEY,
				deleted_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_state (
				session_id TEXT PRIMARY KEY,
				run_state TEXT NOT NULL DEFAULT 'idle',
				run_since TEXT NOT NULL,
				last_event TEXT,
				generation INTEGER NOT NULL DEFAULT 0,
				current_run_id TEXT,
				change_seq INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_commands (
				session_id TEXT NOT NULL,
				request_id TEXT NOT NULL,
				type TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT,
				status TEXT NOT NULL,
				replay_safe INTEGER NOT NULL DEFAULT 0,
				retryable INTEGER,
				result TEXT,
				result_hash TEXT,
				terminal_failure INTEGER NOT NULL DEFAULT 0,
				acknowledged_at INTEGER,
				error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, request_id)
			);
			CREATE TABLE IF NOT EXISTS session_kernel_changes (
				session_id TEXT NOT NULL,
				change_seq INTEGER NOT NULL,
				kind TEXT NOT NULL,
				payload TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, change_seq)
			);
			CREATE TABLE IF NOT EXISTS session_kernel_timers (
				session_id TEXT NOT NULL,
				timer_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				due_at INTEGER NOT NULL,
				token TEXT,
				payload TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				dead_lettered_at INTEGER,
				created_at INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (session_id, timer_id)
			);
			CREATE INDEX IF NOT EXISTS idx_skt_due
				ON session_kernel_timers(due_at);
			CREATE TABLE IF NOT EXISTS session_kernel_outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				effect_id TEXT NOT NULL,
				effect_key TEXT NOT NULL,
				session_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				payload TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				dead_lettered_at INTEGER,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_sko_session
				ON session_kernel_outbox(session_id, id);
		`);
		const commandColumns = new Set(
			(
				this.db.query("PRAGMA table_info(session_kernel_commands)").all() as Array<{ name: string }>
			).map((column) => column.name),
		);
		if (!commandColumns.has("payload_hash"))
			this.db.exec("ALTER TABLE session_kernel_commands ADD COLUMN payload_hash TEXT");
		if (!commandColumns.has("replay_safe")) {
			this.db.exec("ALTER TABLE session_kernel_commands ADD COLUMN replay_safe INTEGER NOT NULL DEFAULT 0");
			// Pre-policy releases re-admitted every interrupted command. Preserve that
			// contract across the upgrade instead of turning live receipts indeterminate.
			this.db.run("UPDATE session_kernel_commands SET replay_safe = 1");
		}
		if (!commandColumns.has("retryable"))
			this.db.exec("ALTER TABLE session_kernel_commands ADD COLUMN retryable INTEGER");
		if (!commandColumns.has("result_hash"))
			this.db.exec("ALTER TABLE session_kernel_commands ADD COLUMN result_hash TEXT");
		if (!commandColumns.has("result_released"))
			this.db.exec("ALTER TABLE session_kernel_commands ADD COLUMN result_released INTEGER NOT NULL DEFAULT 0");
		if (schemaVersion < 6) {
			this.db.exec("DROP INDEX IF EXISTS idx_skc_compact");
			this.db.run(
				`UPDATE session_kernel_commands SET result_released = 1
				 WHERE result LIKE '%"__sessionKernelResultReleased":true%'`,
			);
		}
		if (!commandColumns.has("terminal_failure")) {
			this.db.exec("ALTER TABLE session_kernel_commands ADD COLUMN terminal_failure INTEGER NOT NULL DEFAULT 0");
			this.db.run(
				`UPDATE session_kernel_commands SET terminal_failure = 1
				 WHERE result LIKE '%"__sessionKernelFailure":true%'`,
			);
		}
		if (!commandColumns.has("acknowledged_at"))
			this.db.exec("ALTER TABLE session_kernel_commands ADD COLUMN acknowledged_at INTEGER");
		if (schemaVersion < 4) {
		const unhashedCommands = this.db
				.query("SELECT session_id, request_id, payload FROM session_kernel_commands WHERE payload_hash IS NULL")
				.all() as Array<{ session_id: string; request_id: string; payload: string }>;
			const setPayloadHash = this.db.query(
				"UPDATE session_kernel_commands SET payload_hash = ? WHERE session_id = ? AND request_id = ?",
			);
			for (const command of unhashedCommands)
				setPayloadHash.run(
					digest(command.payload),
					command.session_id,
					command.request_id,
				);
			const unhashedResults = this.db
				.query("SELECT session_id, request_id, result FROM session_kernel_commands WHERE result IS NOT NULL AND result_hash IS NULL")
				.all() as Array<{ session_id: string; request_id: string; result: string }>;
			const setResultHash = this.db.query(
				"UPDATE session_kernel_commands SET result_hash = ? WHERE session_id = ? AND request_id = ?",
			);
			for (const command of unhashedResults)
				setResultHash.run(digest(command.result), command.session_id, command.request_id);
		}

		const outboxColumns = new Set(
			(
				this.db
					.query("PRAGMA table_info(session_kernel_outbox)")
					.all() as Array<{ name: string }>
			).map((column) => column.name),
		);
		if (!outboxColumns.has("effect_id"))
			this.db.exec(
				"ALTER TABLE session_kernel_outbox ADD COLUMN effect_id TEXT",
			);
		if (!outboxColumns.has("effect_key"))
			this.db.exec(
				"ALTER TABLE session_kernel_outbox ADD COLUMN effect_key TEXT",
			);
		if (!outboxColumns.has("next_attempt_at"))
			this.db.exec(
				"ALTER TABLE session_kernel_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
			);
		if (!outboxColumns.has("last_error"))
			this.db.exec(
				"ALTER TABLE session_kernel_outbox ADD COLUMN last_error TEXT",
			);
		if (!outboxColumns.has("dead_lettered_at"))
			this.db.exec(
				"ALTER TABLE session_kernel_outbox ADD COLUMN dead_lettered_at INTEGER",
			);
		const timerColumns = new Set(
			(
				this.db
					.query("PRAGMA table_info(session_kernel_timers)")
					.all() as Array<{ name: string }>
			).map((column) => column.name),
		);
		if (!timerColumns.has("token")) {
			this.db.exec("ALTER TABLE session_kernel_timers ADD COLUMN token TEXT");
			this.db.run("UPDATE session_kernel_timers SET token = lower(hex(randomblob(16))) WHERE token IS NULL");
		}
		if (!timerColumns.has("attempts"))
			this.db.exec(
				"ALTER TABLE session_kernel_timers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
			);
		if (!timerColumns.has("next_attempt_at"))
			this.db.exec(
				"ALTER TABLE session_kernel_timers ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
			);
		if (!timerColumns.has("last_error"))
			this.db.exec(
				"ALTER TABLE session_kernel_timers ADD COLUMN last_error TEXT",
			);
		if (!timerColumns.has("dead_lettered_at"))
			this.db.exec(
				"ALTER TABLE session_kernel_timers ADD COLUMN dead_lettered_at INTEGER",
			);
		if (!timerColumns.has("created_at")) {
			this.db.exec(
				"ALTER TABLE session_kernel_timers ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
			);
			this.db.run("UPDATE session_kernel_timers SET created_at = due_at WHERE created_at = 0");
		}
		if (schemaVersion < 4)
			this.db.run(
				"UPDATE session_kernel_outbox SET effect_id = COALESCE(effect_id, 'legacy:' || id), effect_key = COALESCE(effect_key, 'legacy:' || id)",
			);
		this.db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_sko_effect ON session_kernel_outbox(session_id, kind, effect_key)",);
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_skc_active_created
				ON session_kernel_commands(created_at)
				WHERE status IN ('pending', 'processing', 'indeterminate');
			CREATE INDEX IF NOT EXISTS idx_skc_compact
				ON session_kernel_commands(acknowledged_at)
				WHERE status = 'completed' AND terminal_failure = 0
				  AND acknowledged_at IS NOT NULL AND result_hash IS NOT NULL
				  AND result_released = 0 AND length(result) > 65536;
			CREATE INDEX IF NOT EXISTS idx_skt_pending
				ON session_kernel_timers(next_attempt_at, due_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_skt_kind_pending
				ON session_kernel_timers(kind, next_attempt_at, due_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_skt_live_created
				ON session_kernel_timers(created_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_skt_dead
				ON session_kernel_timers(dead_lettered_at DESC)
				WHERE dead_lettered_at IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_pending
				ON session_kernel_outbox(next_attempt_at, id)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_kind_pending
				ON session_kernel_outbox(kind, next_attempt_at, id)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_live_created
				ON session_kernel_outbox(created_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_dead
				ON session_kernel_outbox(dead_lettered_at DESC)
				WHERE dead_lettered_at IS NOT NULL;
		`);
		this.db.exec("DROP INDEX IF EXISTS idx_skc_updated; DROP INDEX IF EXISTS idx_skc_status_created;");
		this.db.exec(`PRAGMA user_version = ${SESSION_KERNEL_SCHEMA_VERSION}`);
		if (path !== ":memory:") {
			try {
				chmodSync(path, 0o600);
			} catch {}
		}
		// A processing lease dies with its actor. Keep the durable intent pending so
		// the client's receipt outbox can re-admit the exact same command id.
		this.db.run(
			"UPDATE session_kernel_commands SET status = 'pending', error = 'actor restarted before acknowledgement', updated_at = ? WHERE status = 'processing' AND replay_safe = 1",
			[Date.now()],
		);
		this.db.run(
			"UPDATE session_kernel_commands SET status = 'indeterminate', error = 'actor restarted after execution began', retryable = 0, updated_at = ? WHERE status = 'processing'",
			[Date.now()],
		);
		const stateRows = this.db
			.query(`SELECT session_id, run_state, run_since, last_event, generation,
				current_run_id, change_seq FROM session_kernel_state`,)
			.all() as Record<string, unknown>[];
		for (const row of stateRows) {
			this.dirtyChangeSessions.add(String(row.session_id));
			this.runStateCache.set(String(row.session_id), {
				state: String(row.run_state),
				since: String(row.run_since),
				lastEvent: row.last_event == null ? undefined : String(row.last_event),
				generation: Number(row.generation),
				currentRunId:
					row.current_run_id == null ? undefined : String(row.current_run_id),
				changeSeq: Number(row.change_seq),
			});
		}
	}

	private claimWriter(): void {
		const transaction = this.db.transaction(() => {
			const current = this.db
				.query("SELECT owner_id, pid FROM session_kernel_owner WHERE singleton = 1",)
				.get() as { owner_id: string; pid: number } | null;
			if (current && current.owner_id !== PROCESS_OWNER_ID) {
				let alive = false;
				try {
					process.kill(current.pid, 0);
					alive = true;
				} catch {}
				if (alive) {
					const recorded = parseOwnerIdentity(current.owner_id);
					const bootId = linuxBootId();
					const start = linuxProcessStart(current.pid);
					if (
						recorded?.bootId && recorded.start &&
						bootId && start &&
						(recorded.bootId !== bootId || recorded.start !== start)
					) alive = false;
					else if (!recorded && !plausibleLegacyOwner(current.pid)) alive = false;
				}
				if (alive)
					throw new Error(
						`Session kernel already owned by live process ${current.pid}`,
					);
			}
			this.db.run(
				`INSERT INTO session_kernel_owner (singleton, owner_id, pid, claimed_at)
				 VALUES (1, ?, ?, ?)
				 ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id,
					pid = excluded.pid, claimed_at = excluded.claimed_at`,
				[PROCESS_OWNER_ID, process.pid, Date.now()],
			);
		});
		transaction.immediate();
	}

	close(): void {
		if (this.closeable) this.db.close();
	}

	command(sessionId: string, requestId: string,): DurableCommandRecord | undefined {
		const row = this.db
			.query(`SELECT session_id, request_id, type, payload, payload_hash, status, replay_safe, retryable, result, result_hash, terminal_failure, acknowledged_at, error,
				created_at, updated_at FROM session_kernel_commands
				WHERE session_id = ? AND request_id = ?`,)
			.get(sessionId, requestId) as Record<string, unknown> | null;
		if (!row) return undefined;
		return {
			sessionId: String(row.session_id),
			requestId: String(row.request_id),
			type: String(row.type),
			payload: parsed(row.payload as string),
			payloadHash: String(row.payload_hash),
			status: row.status as DurableCommandStatus,
			result: parsed(row.result as string | null),
			error: row.error == null ? undefined : String(row.error),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
			replaySafe: Number(row.replay_safe) === 1,
			retryable: row.retryable == null ? undefined : Number(row.retryable) === 1,
			acknowledgedAt:
				row.acknowledged_at == null ? undefined : Number(row.acknowledged_at),
			resultHash: row.result_hash == null ? undefined : String(row.result_hash),
			terminalFailure: Number(row.terminal_failure) === 1,
		};
	}

	acceptCommand(input: {
		sessionId: string;
		requestId: string;
		type: string;
		payload?: unknown;
		replaySafe?: boolean;
	}): DurableCommandRecord {
		const now = Date.now();
		const payloadText = json(input.payload);
		const payloadHash = digest(payloadText);
		this.db.run(
			`INSERT INTO session_kernel_commands
				(session_id, request_id, type, payload, payload_hash, status, replay_safe, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
			 ON CONFLICT(session_id, request_id) DO NOTHING`,
			[input.sessionId, input.requestId, input.type, payloadText, payloadHash, input.replaySafe ? 1 : 0, now, now,],
		);
		let record = this.command(input.sessionId, input.requestId);
		if (!record) throw new Error("Session command was not persisted");
		if (
			record.type !== input.type ||
			record.payloadHash !== payloadHash
		) {
			throw new Error(
				`Session command id ${input.requestId} was reused with another payload`,
			);
		}
		if (input.replaySafe && !record.replaySafe && record.status !== "indeterminate") {
			this.db.run(
				"UPDATE session_kernel_commands SET replay_safe = 1 WHERE session_id = ? AND request_id = ?",
				[input.sessionId, input.requestId],
			);
			record = this.command(input.sessionId, input.requestId)!;
		}
		return record;
	}

	markProcessing(sessionId: string, requestId: string): void {
		this.db.run(
			`UPDATE session_kernel_commands SET status = 'processing', payload = 'null', error = NULL, retryable = NULL,
				updated_at = ? WHERE session_id = ? AND request_id = ?`,
			[Date.now(), sessionId, requestId],
		);
	}

	completeCommand(sessionId: string, requestId: string, result: unknown): void {
		const stored = resultRecord(result);
		this.db.run(
			`UPDATE session_kernel_commands SET status = 'completed', payload = 'null',
				result = ?, result_hash = ?, result_released = 0, terminal_failure = ?, error = NULL,
				retryable = NULL, updated_at = ? WHERE session_id = ? AND request_id = ?`,
			[stored.text, stored.hash, stored.terminalFailure ? 1 : 0, Date.now(), sessionId, requestId],
		);
	}

	failCommand(
		sessionId: string,
		requestId: string,
		error: string,
		retryable = false,
	): void {
		this.db.run(
			`UPDATE session_kernel_commands SET status = 'failed', payload = 'null', error = ?, retryable = ?,
				updated_at = ? WHERE session_id = ? AND request_id = ?`,
			[error.slice(0, 2_000), retryable ? 1 : 0, Date.now(), sessionId, requestId],
		);
	}

	runState(sessionId: string): DurableRunState {
		const state = this.runStateCache.get(sessionId);
		return state
			? { ...state }
			: {
					state: "idle",
					since: new Date(0).toISOString(),
					generation: 0,
					changeSeq: 0,
				};
	}

	runStates(): Array<DurableRunState & { sessionId: string }> {
		return [...this.runStateCache].map(([sessionId, state]) => ({
			sessionId,
			...state,
		}));
	}

	appendChange(sessionId: string, kind: string, payload?: unknown): number {
		const now = Date.now();
		let changeSeq = 0;
		const tx = this.db.transaction(() => {
			const prior = this.runState(sessionId);
			changeSeq = prior.changeSeq + 1;
			this.db.run(
				`INSERT INTO session_kernel_state
					(session_id, run_state, run_since, last_event, generation,
					 current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					change_seq = excluded.change_seq,
					updated_at = excluded.updated_at`,
				[
					sessionId,
					prior.state,
					prior.since === new Date(0).toISOString()
						? new Date(now).toISOString()
						: prior.since,
					prior.lastEvent ?? null,
					prior.generation,
					prior.currentRunId ?? null,
					changeSeq,
					now,
				],
			);
			this.db.run(
				`INSERT INTO session_kernel_changes
					(session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[sessionId, changeSeq, kind, json(payload), now],
			);
		});
		tx.immediate();
		const prior = this.runState(sessionId);
		this.runStateCache.set(sessionId, { ...prior, changeSeq });
		this.dirtyChangeSessions.add(sessionId);
		return changeSeq;
	}

	changesSince(
		sessionId: string,
		afterChangeSeq: number,
		limit = 500,
	): Array<{ changeSeq: number; kind: string; payload: unknown; createdAt: number; }> {
		const rows = this.db
			.query(`SELECT change_seq, kind, payload, created_at
				FROM session_kernel_changes
				WHERE session_id = ? AND change_seq > ?
				ORDER BY change_seq LIMIT ?`,)
			.all(sessionId, afterChangeSeq, limit) as Record<string, unknown>[];
		return rows.map((row) => ({
			changeSeq: Number(row.change_seq),
			kind: String(row.kind),
			payload: parsed(row.payload as string),
			createdAt: Number(row.created_at),
		}));
	}

	applyRunEvent(input: RunEventDecision): RunEventDecisionResult {
		const now = Date.now();
		const since = new Date(now).toISOString();
		let result!: RunEventDecisionResult;
		const tx = this.db.transaction(() => {
			const prior = this.runState(input.sessionId);
			const from = prior.state as RunState;
			const to = nextRunState(from, input.event);
			if (!to) {
				result = { accepted: false, from, to: from, reason: "invalid_transition", state: prior };
				return;
			}
			if (
				input.event === "run_registered" &&
				input.runKey &&
				prior.currentRunId &&
				prior.currentRunId !== input.runKey &&
				["running", "ask_blocked", "interrupted", "reattaching"].includes(from)
			) {
				result = {
					accepted: false,
					from,
					to: from,
					reason: "stale_run",
					currentRunId: prior.currentRunId,
					rejectedRunId: input.runKey,
					state: prior,
				};
				return;
			}
			const registers =
				!!input.runKey &&
				(input.event === "run_registered" || input.event === "boot_journal_found");
			const generation = registers && prior.currentRunId !== input.runKey
				? prior.generation + 1
				: prior.generation;
			const currentRunId = ["idle", "stopped", "failed"].includes(to)
				? undefined
				: (registers ? input.runKey : prior.currentRunId);
			const changeSeq = prior.changeSeq + 1;
			this.db.run(
				`INSERT INTO session_kernel_state
					(session_id, run_state, run_since, last_event, generation,
					 current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					run_state = excluded.run_state,
					run_since = excluded.run_since,
					last_event = excluded.last_event,
					generation = excluded.generation,
					current_run_id = excluded.current_run_id,
					change_seq = excluded.change_seq,
					updated_at = excluded.updated_at`,
				[input.sessionId, to, since, input.event, generation, currentRunId ?? null, changeSeq, now],
			);
			this.db.run(
				`INSERT INTO session_kernel_changes
					(session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, 'run_state', ?, ?)`,
				[input.sessionId, changeSeq, json({ state: to, event: input.event, detail: input.detail }), now],
			);
			const state: DurableRunState = {
				state: to,
				since,
				lastEvent: input.event,
				generation,
				currentRunId,
				changeSeq,
			};
			result = { accepted: true, from, to, state };
		});
		tx.immediate();
		if (result.accepted) {
			this.runStateCache.set(input.sessionId, result.state);
			this.dirtyChangeSessions.add(input.sessionId);
		}
		return result;
	}

	setRunState(input: {
		sessionId: string;
		state: string;
		event: string;
		detail?: unknown;
		generation?: number;
		currentRunId?: string | null;
	}): DurableRunState {
		const now = Date.now();
		const since = new Date(now).toISOString();
		const tx = this.db.transaction(() => {
			const prior = this.runState(input.sessionId);
			const changeSeq = prior.changeSeq + 1;
			this.db.run(
				`INSERT INTO session_kernel_state
					(session_id, run_state, run_since, last_event, generation,
					 current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					run_state = excluded.run_state,
					run_since = excluded.run_since,
					last_event = excluded.last_event,
					generation = excluded.generation,
					current_run_id = excluded.current_run_id,
					change_seq = excluded.change_seq,
					updated_at = excluded.updated_at`,
				[
					input.sessionId,
					input.state,
					since,
					input.event,
					input.generation ?? prior.generation,
					["idle", "stopped", "failed"].includes(input.state)
						? null
						: ( input.currentRunId ?? prior.currentRunId ?? null),
					changeSeq,
					now,
				],
			);
			this.db.run(
				`INSERT INTO session_kernel_changes
					(session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, 'run_state', ?, ?)`,
				[
					input.sessionId,
					changeSeq,
					json({ state: input.state, event: input.event, detail: input.detail, }),
					now,
				],
			);
		});
		tx.immediate();
		const next: DurableRunState = {
			state: input.state,
			since,
			lastEvent: input.event,
			generation: input.generation ?? this.runState(input.sessionId).generation,
			currentRunId: ["idle", "stopped", "failed"].includes(input.state)
				? undefined
				: ( input.currentRunId ?? this.runState(input.sessionId).currentRunId),
			changeSeq: this.runState(input.sessionId).changeSeq + 1,
		};
		this.runStateCache.set(input.sessionId, next);
		this.dirtyChangeSessions.add(input.sessionId);
		return next;
	}

	isTombstoned(sessionId: string, now = Date.now()): boolean {
		const row = this.db
			.query("SELECT deleted_at FROM session_kernel_tombstones WHERE session_id = ?",)
			.get(sessionId) as { deleted_at: number } | null;
		if (!row) return false;
		void now;
		return true;
	}

	tombstoneSession(sessionId: string): void {
		const tx = this.db.transaction(() => {
			for (const table of [
				"session_kernel_state",
				"session_kernel_commands",
				"session_kernel_changes",
				"session_kernel_timers",
				"session_kernel_outbox",
			])
				this.db.run(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
			this.db.run(
				`INSERT INTO session_kernel_tombstones (session_id, deleted_at) VALUES (?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
				[sessionId, Date.now()],
			);
		});
		tx.immediate();
		this.runStateCache.delete(sessionId);
		this.dirtyChangeSessions.delete(sessionId);
	}

	clearSession(sessionId: string): void {
		const tx = this.db.transaction(() => {
			for (const table of [
				"session_kernel_state",
				"session_kernel_commands",
				"session_kernel_changes",
				"session_kernel_timers",
				"session_kernel_outbox",
			]) {
				this.db.run(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
			}
		});
		tx.immediate();
		this.runStateCache.delete(sessionId);
		this.dirtyChangeSessions.delete(sessionId);
	}

	scheduleTimer(
		timer: Omit<DurableTimer, "token" | "attempts" | "nextAttemptAt" | "lastError" | "deadLetteredAt" | "createdAt">,
	): void {
		const token = crypto.randomUUID();
		this.db.run(
			`INSERT INTO session_kernel_timers
			 (session_id, timer_id, kind, due_at, token, payload, attempts, next_attempt_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(session_id, timer_id) DO UPDATE SET
			 kind = excluded.kind, due_at = excluded.due_at, token = excluded.token,
			 payload = excluded.payload, attempts = 0,
			 next_attempt_at = excluded.next_attempt_at, last_error = NULL,
			 dead_lettered_at = NULL, created_at = excluded.created_at`,
			[timer.sessionId, timer.timerId, timer.kind, timer.dueAt, token,
				json(timer.payload), timer.dueAt, Date.now()],
		);
	}

	timer(sessionId: string, timerId: string): DurableTimer | undefined {
		const row = this.db
			.query(
				`SELECT session_id, timer_id, kind, due_at, token, payload, attempts, next_attempt_at, last_error, dead_lettered_at, created_at
         FROM session_kernel_timers WHERE session_id = ? AND timer_id = ?`,)
			.get(sessionId, timerId) as Record<string, unknown> | null;
		return row
			? {
				sessionId: String(row.session_id),
				timerId: String(row.timer_id),
				kind: String(row.kind),
				dueAt: Number(row.due_at),
				token: String(row.token),
				payload: parsed(row.payload as string),
					attempts: Number(row.attempts),
					nextAttemptAt: Number(row.next_attempt_at),
					lastError:
						row.last_error == null ? undefined : String(row.last_error),
					deadLetteredAt: row.dead_lettered_at == null ? undefined : Number(row.dead_lettered_at),
					createdAt: Number(row.created_at),
			}
			: undefined;
	}

	cancelTimer(sessionId: string, timerId: string): void {
		this.db.run(
			"DELETE FROM session_kernel_timers WHERE session_id = ? AND timer_id = ?",
			[sessionId, timerId],
		);
	}

	settleTimerSuccess(sessionId: string, timerId: string, token: string): boolean {
		return this.db.run(
			"DELETE FROM session_kernel_timers WHERE session_id = ? AND timer_id = ? AND token = ?",
			[sessionId, timerId, token],
		).changes > 0;
	}

	dueTimers(
		now = Date.now(),
		limit = 100,
		kinds?: readonly string[],
	): DurableTimer[] {
		if (kinds && kinds.length === 0) return [];
		const kindFilter = kinds?.length
			? ` AND kind IN (${kinds.map(() => "?").join(",")})`
			: "";
		const rows = this.db
			.query(
				`SELECT session_id, timer_id, kind, due_at, token, payload, attempts, next_attempt_at,
					last_error, dead_lettered_at, created_at
				 FROM session_kernel_timers
				 WHERE due_at <= ? AND next_attempt_at <= ? AND dead_lettered_at IS NULL${kindFilter}
				 ORDER BY next_attempt_at, due_at LIMIT ?`,
			)
			.all(now, now, ...(kinds || []), limit) as Record<string, unknown>[];
		return rows.map((row) => ({
			sessionId: String(row.session_id),
			timerId: String(row.timer_id),
			kind: String(row.kind),
			dueAt: Number(row.due_at),
			token: String(row.token),
			payload: parsed(row.payload as string),
			attempts: Number(row.attempts),
			nextAttemptAt: Number(row.next_attempt_at),
			lastError: row.last_error == null ? undefined : String(row.last_error),
			deadLetteredAt:
				row.dead_lettered_at == null ? undefined : Number(row.dead_lettered_at),
			createdAt: Number(row.created_at),
		}));
	}

	noteTimerFailure(
		sessionId: string,
		timerId: string,
		error: string,
		maxAttempts = 20,
		expectedToken?: string,
	): { updated: boolean; deadLetteredNow: boolean } {
		const row = this.timer(sessionId, timerId);
		if (!row || (expectedToken !== undefined && row.token !== expectedToken))
			return { updated: false, deadLetteredNow: false };
		const attempts = row.attempts + 1;
		const deadLetteredAt = attempts >= maxAttempts ? Date.now() : null;
		const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
		this.db.run(
			`UPDATE session_kernel_timers SET attempts = ?, next_attempt_at = ?, last_error = ?,
				dead_lettered_at = ? WHERE session_id = ? AND timer_id = ? AND token = ?`,
			[
				attempts,
				Date.now() + delay,
				error.slice(0, 2_000),
				deadLetteredAt,
				sessionId,
				timerId,
				row.token,
			],
		);
		return { updated: true, deadLetteredNow: deadLetteredAt !== null };
	}

	enqueueOutbox(sessionId: string, kind: string, payload: unknown,
		effectKey: string = crypto.randomUUID(),): number {
		const effectId = `${sessionId}:${kind}:${effectKey}`;
		this.db.run(
			`INSERT INTO session_kernel_outbox
				(effect_id, effect_key, session_id, kind, payload, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_id, kind, effect_key) DO NOTHING`,
			[effectId, effectKey,sessionId, kind, json(payload), Date.now()],
		);
		const row = this.db.query(
				"SELECT id FROM session_kernel_outbox WHERE session_id = ? AND kind = ? AND effect_key = ?",).get(sessionId, kind, effectKey) as { id: number } | null;
		if (!row) throw new Error("Outbox effect was not persisted");
		return Number(row.id);
	}

	enqueueOutboxMany(
		sessionId: string,
		effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
	): number[] {
		if (effects.length === 0) return [];
		const ids: number[] = [];
		const tx = this.db.transaction(() => {
			for (const effect of effects)
				ids.push(this.enqueueOutbox(sessionId, effect.kind, effect.payload, effect.effectKey));
		});
		tx.immediate();
		return ids;
	}

	completeCommandDecision(input: {
		sessionId: string;
		requestId: string;
		type: string;
		result: unknown;
		effects: Array<{ kind: string; payload: unknown; effectKey: string }>;
	}): void {
		const now = Date.now();
		const stored = resultRecord(input.result);
		let changeSeq = 0;
		const tx = this.db.transaction(() => {
			this.db.run(
				`UPDATE session_kernel_commands SET status = 'completed', payload = 'null',
				 result = ?, result_hash = ?, result_released = 0, terminal_failure = ?, error = NULL,
				 retryable = NULL, updated_at = ? WHERE session_id = ? AND request_id = ?`,
				[
					stored.text,
					stored.hash,
					stored.terminalFailure ? 1 : 0,
					now,
					input.sessionId,
					input.requestId,
				],
			);
			const prior = this.runState(input.sessionId);
			changeSeq = prior.changeSeq + 1;
			this.db.run(
				`INSERT INTO session_kernel_state
				 (session_id, run_state, run_since, last_event, generation, current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET change_seq = excluded.change_seq, updated_at = excluded.updated_at`,
				[
					input.sessionId,
					prior.state,
					prior.since === new Date(0).toISOString()
						? new Date(now).toISOString()
						: prior.since,
					prior.lastEvent ?? null,
					prior.generation,
					prior.currentRunId ?? null,
					changeSeq,
					now,
				],
			);
			this.db.run(
				`INSERT INTO session_kernel_changes (session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					input.sessionId,
					changeSeq,
					`command:${input.type}`,
					json({ requestId: input.requestId }),
					now,
				],
			);
			for (const effect of input.effects)
				this.enqueueOutbox(
					input.sessionId,
					effect.kind,
					effect.payload,
					effect.effectKey,
				);
		});
		tx.immediate();
		const prior = this.runState(input.sessionId);
		this.runStateCache.set(input.sessionId, { ...prior, changeSeq });
		this.dirtyChangeSessions.add(input.sessionId);
	}

	pendingOutbox(
		now = Date.now(),
		limit = 100,
		kinds?: readonly string[],
	): DurableOutboxItem[] {
		if (kinds && kinds.length === 0) return [];
		const kindFilter = kinds?.length
			? ` AND kind IN (${kinds.map(() => "?").join(",")})`
			: "";
		const rows = this.db
			.query(
				`SELECT id, effect_id, effect_key, session_id, kind, payload, attempts,
         next_attempt_at, last_error, dead_lettered_at, created_at
         FROM session_kernel_outbox
         WHERE dead_lettered_at IS NULL AND next_attempt_at <= ?${kindFilter}
         ORDER BY next_attempt_at, id LIMIT ?`,)
			.all(now, ...(kinds || []), limit) as Record<string, unknown>[];
		return rows.map((row) => ({
			id: Number(row.id),
			effectId: String(row.effect_id),
			effectKey: String(row.effect_key),
			sessionId: String(row.session_id),
			kind: String(row.kind),
			payload: parsed(row.payload as string),
			attempts: Number(row.attempts),
			nextAttemptAt: Number(row.next_attempt_at),
			lastError: row.last_error == null ? undefined : String(row.last_error),
			deadLetteredAt:
				row.dead_lettered_at == null ? undefined : Number(row.dead_lettered_at),
			createdAt: Number(row.created_at),
		}));
	}

	stats(): {
		sessions: number;
		pendingCommands: number;
		pendingTimers: number;
		pendingOutbox: number;
		deadLetteredOutbox: number;
		deadLetteredTimers: number;
		oldestPendingCommandAt?: number;
		oldestPendingTimerAt?: number;
		oldestPendingOutboxAt?: number;
		dbBytes: number;
		walBytes: number;
		pageCount: number;
		freePages: number;
		schemaVersion: number;
	} {
		const count = (table: string, where = "") =>
			Number(
				(
					this.db.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as {
						n: number;
					}
				).n,
			);
		const oldest = (table: string, column: string, where = ""): number | undefined => {
			const row = this.db
				.query(`SELECT MIN(${column}) AS oldest FROM ${table} ${where}`)
				.get() as { oldest: number | null };
			return row.oldest == null ? undefined : Number(row.oldest);
		};
		const pragma = (name: string) => Number(
			Object.values(this.db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0] ?? 0,
		);
		const fileBytes = (path: string) => {
			try { return statSync(path).size; } catch { return 0; }
		};
		return {
			sessions: count("session_kernel_state"),
			pendingCommands: count(
				"session_kernel_commands",
				"WHERE status IN ('pending', 'processing')",
			),
			pendingTimers: count("session_kernel_timers"),
			pendingOutbox: count("session_kernel_outbox",
				"WHERE dead_lettered_at IS NULL",
			),
			deadLetteredOutbox: count(
				"session_kernel_outbox",
				"WHERE dead_lettered_at IS NOT NULL",),
			deadLetteredTimers: count(
				"session_kernel_timers",
				"WHERE dead_lettered_at IS NOT NULL",
			),
			oldestPendingCommandAt: oldest(
				"session_kernel_commands",
				"created_at",
				"WHERE status IN ('pending', 'processing', 'indeterminate')",
			),
			oldestPendingTimerAt: oldest(
				"session_kernel_timers",
				"created_at",
				"WHERE dead_lettered_at IS NULL",
			),
			oldestPendingOutboxAt: oldest(
				"session_kernel_outbox",
				"created_at",
				"WHERE dead_lettered_at IS NULL",
			),
			dbBytes: this.path === ":memory:" ? 0 : fileBytes(this.path),
			walBytes: this.path === ":memory:" ? 0 : fileBytes(`${this.path}-wal`),
			pageCount: pragma("page_count"),
			freePages: pragma("freelist_count"),
			schemaVersion: pragma("user_version"),
		};
	}

	acknowledgeCommand(sessionId: string, requestId: string): boolean {
		const result = this.db.run(
			`UPDATE session_kernel_commands SET acknowledged_at = COALESCE(acknowledged_at, ?)
			 WHERE session_id = ? AND request_id = ? AND status = 'completed'`,
			[Date.now(), sessionId, requestId],
		);
		return result.changes > 0;
	}

	compact(
		now = Date.now(),
		commandRetentionMs = 30 * 24 * 60 * 60_000,
		changesPerSession = 5_000,
	): void {
		// Request fingerprints and completion state are permanent. Large semantic
		// results stay replayable until the client confirms local receipt, then age
		// into a bounded digest marker. Terminal failures always keep their message.
		this.db.run(
			`UPDATE session_kernel_commands
			 SET result = '{"__sessionKernelResultReleased":true,"sha256":"' || result_hash || '"}',
			     result_released = 1
			 WHERE rowid IN (
				SELECT rowid FROM session_kernel_commands
				WHERE status = 'completed' AND terminal_failure = 0
				  AND acknowledged_at IS NOT NULL AND acknowledged_at < ?
				  AND result_hash IS NOT NULL AND result_released = 0 AND length(result) > ?
				LIMIT 500
			 )`,
			[now - commandRetentionMs, 64 * 1024],
		);
		for (const sessionId of [...this.dirtyChangeSessions].slice(0, 100)) {
			const result = this.db.run(
				`DELETE FROM session_kernel_changes WHERE rowid IN (
					SELECT rowid FROM session_kernel_changes
					WHERE session_id = ? AND change_seq <= (
						SELECT MAX(change_seq) - ? FROM session_kernel_changes WHERE session_id = ?
					)
					LIMIT 5000
				 )`,
				[sessionId, changesPerSession, sessionId],
			);
			if (result.changes < 5000) this.dirtyChangeSessions.delete(sessionId);
		}
	}

	maintain(): void {
		// Bounded semantic compaction only. VACUUM/optimize/checkpoint are offline
		// operator work because this actor also serves synchronous compatibility RPCs.
		this.compact();
	}

	deadLetters(limit = 100, offset = 0) {
		const timers = this.db.query(
			`SELECT session_id, timer_id, kind, due_at, attempts, next_attempt_at, last_error, dead_lettered_at, created_at
			 FROM session_kernel_timers WHERE dead_lettered_at IS NOT NULL
			 ORDER BY dead_lettered_at DESC LIMIT ? OFFSET ?`,
		).all(limit, offset) as Record<string, unknown>[];
		const outbox = this.db.query(
			`SELECT id, effect_id, effect_key, session_id, kind, attempts, next_attempt_at, last_error, dead_lettered_at, created_at
			 FROM session_kernel_outbox WHERE dead_lettered_at IS NOT NULL
			 ORDER BY dead_lettered_at DESC LIMIT ? OFFSET ?`,
		).all(limit, offset) as Record<string, unknown>[];
		return {
			timers: timers.map((row) => ({
				sessionId: String(row.session_id),
				timerId: String(row.timer_id),
				kind: String(row.kind),
				dueAt: Number(row.due_at),
				nextAttemptAt: Number(row.next_attempt_at),
				createdAt: Number(row.created_at),
				attempts: Number(row.attempts),
				lastError: row.last_error == null ? undefined : String(row.last_error),
				deadLetteredAt: Number(row.dead_lettered_at),
			})),
			outbox: outbox.map((row) => ({
				id: Number(row.id),
				effectId: String(row.effect_id),
				effectKey: String(row.effect_key),
				nextAttemptAt: Number(row.next_attempt_at),
				createdAt: Number(row.created_at),
				sessionId: String(row.session_id),
				kind: String(row.kind),
				attempts: Number(row.attempts),
				lastError: row.last_error == null ? undefined : String(row.last_error),
				deadLetteredAt: Number(row.dead_lettered_at),
			})),
			totals: {
				timers: Number((this.db.query("SELECT COUNT(*) AS n FROM session_kernel_timers WHERE dead_lettered_at IS NOT NULL").get() as { n: number }).n),
				outbox: Number((this.db.query("SELECT COUNT(*) AS n FROM session_kernel_outbox WHERE dead_lettered_at IS NOT NULL").get() as { n: number }).n),
			},
			nextOffset:
				timers.length === limit || outbox.length === limit
					? offset + limit
					: undefined,
		};
	}

	discardDeadTimer(sessionId: string, timerId: string): boolean {
		const result = this.db.run(
			"DELETE FROM session_kernel_timers WHERE session_id = ? AND timer_id = ? AND dead_lettered_at IS NOT NULL",
			[sessionId, timerId],
		);
		return result.changes > 0;
	}

	discardDeadOutbox(id: number): boolean {
		const result = this.db.run(
			"DELETE FROM session_kernel_outbox WHERE id = ? AND dead_lettered_at IS NOT NULL",
			[id],
		);
		return result.changes > 0;
	}

	retryDeadTimer(sessionId: string, timerId: string): boolean {
		const result = this.db.run(
			`UPDATE session_kernel_timers SET attempts = 0, next_attempt_at = ?,
			 last_error = NULL, dead_lettered_at = NULL
			 WHERE session_id = ? AND timer_id = ? AND dead_lettered_at IS NOT NULL`,
			[Date.now(), sessionId, timerId],
		);
		return result.changes > 0;
	}

	retryDeadOutbox(id: number): boolean {
		const result = this.db.run(
			`UPDATE session_kernel_outbox SET attempts = 0, next_attempt_at = ?,
			 last_error = NULL, dead_lettered_at = NULL
			 WHERE id = ? AND dead_lettered_at IS NOT NULL`,
			[Date.now(), id],
		);
		return result.changes > 0;
	}

	ackOutbox(id: number): void {
		this.db.run("DELETE FROM session_kernel_outbox WHERE id = ?", [id]);
	}

	noteOutboxFailure(id: number, error: string, maxAttempts = 20): { updated: boolean; deadLetteredNow: boolean } {
		const row = this.db
			.query("SELECT attempts FROM session_kernel_outbox WHERE id = ?")
			.get(id) as { attempts: number } | null;
		if (!row) return { updated: false, deadLetteredNow: false };
		const attempts = Number(row.attempts) + 1;
		const deadLetteredAt = attempts >= maxAttempts ? Date.now() : null;
		const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
		this.db.run(
			`UPDATE session_kernel_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?,
       dead_lettered_at = ? WHERE id = ?`,
			[attempts, Date.now() + delay, error.slice(0, 2_000), deadLetteredAt,id],
		);
		return { updated: true, deadLetteredNow: deadLetteredAt !== null };
	}
}

/** Structural store surface implemented locally in tests and by the actor proxy in production. */
export type SessionKernelStoreApi = Pick<
	SessionKernelStore,
	keyof SessionKernelStore
>;
