/**
 * Wire types for the Open Session client protocol.
 *
 * Deliberately a narrow, hand-written mirror of what the server actually sends
 * — not a shared import from src/server. This package must stay compilable and
 * `bun build --compile`-able with nothing but its own node_modules, so the
 * coupling is a documented copy (same choice os1-ios makes in its Codable
 * models). Fields are all optional-tolerant: a server ahead of this client adds
 * keys, it never breaks us.
 */

/** A session as `GET /api/sessions` returns it. */
export type Session = {
	id: string;
	title?: string | null;
	source?: string | null;
	repo?: string | null;
	branch?: string | null;
	worktreeDir?: string | null;
	workspaceId?: string | null;
	mode?: string | null;
	model?: string | null;
	effort?: string | null;
	isRunning?: boolean;
	runState?: string | null;
	waitingForInput?: boolean;
	queuedCount?: number;
	archived?: boolean;
	desk?: boolean;
	createdAt?: string | null;
	lastActivity?: string | null;
	prUrl?: string | null;
	prState?: string | null;
	prNumber?: number | null;
	startedBy?: string | null;
	lastRunError?: string | null;
	workspacePreparing?: boolean;
	automation?: unknown;
};

export type TranscriptEntry = {
	id: string;
	/** "user" | "assistant" | "tool_use" | "tool_result" | "system" */
	type: string;
	content?: string | null;
	timestamp?: string | null;
	toolName?: string | null;
	toolInput?: unknown;
	toolUseId?: string | null;
	isError?: boolean;
	model?: string | null;
	agentId?: string | null;
	/** Server clamped `content` for the wire; the full body is one GET away. */
	contentClamped?: boolean;
	contentLength?: number;
	images?: string[] | null;
};

export type QueueItem = { id: string; content: string; user?: string | null };

export type AskOption = { label: string; description?: string | null };
export type AskQuestion = {
	questionId: string;
	questions: {
		question: string;
		header?: string | null;
		multiSelect?: boolean;
		options?: AskOption[];
	}[];
};

/** Byte cursor into the transcript mirror file — our reconnect resume point. */
export type TranscriptCursor = { endOffset: number; rev: string } | null;

/**
 * Inbound frames, as a discriminated union on `type`. Only the ones this client
 * acts on are modelled; anything else lands in `{ type: string }` and is
 * ignored by the reducer.
 */
export type ServerFrame =
	| { type: "hello"; bootId?: string }
	| { type: "pong" }
	| {
			type: "transcript_init";
			sessionId?: string;
			entries?: TranscriptEntry[];
			truncated?: boolean;
			startOffset?: number;
			endOffset?: number;
			rev?: string;
	  }
	| {
			type: "transcript_history";
			sessionId?: string;
			entries?: TranscriptEntry[];
			truncated?: boolean;
			startOffset?: number;
	  }
	| {
			type: "transcript_append";
			sessionId?: string;
			entries?: TranscriptEntry[];
			endOffset?: number;
			rev?: string;
	  }
	| { type: "stream_start"; sessionId?: string }
	| { type: "stream_text"; sessionId?: string; text?: string }
	| { type: "stream_tool_use"; sessionId?: string; entry?: TranscriptEntry }
	| { type: "stream_tool_result"; sessionId?: string; entry?: TranscriptEntry }
	| { type: "stream_done"; sessionId?: string }
	| { type: "session_status"; sessionId?: string; isRunning?: boolean }
	| {
			type: "queue_update";
			sessionId?: string;
			queued?: QueueItem[];
			steered?: QueueItem[];
	  }
	| {
			type: "ask_question";
			sessionId?: string;
			questionId?: string;
			questions?: AskQuestion["questions"];
	  }
	| { type: "ask_resolved"; sessionId?: string; questionId?: string }
	| { type: "notice"; message?: string }
	| { type: "error"; message?: string }
	| { type: string };

/** Status glyph classes — herdr's blocked/working/done/idle read. */
export type SessionStatus =
	| "waiting"
	| "running"
	| "error"
	| "done"
	| "idle"
	| "preparing";

/**
 * One session's at-a-glance state. `waitingForInput` outranks `isRunning`
 * because a blocked run is the thing a human has to act on — that's the whole
 * point of the sidebar.
 */
export function sessionStatus(session: Session): SessionStatus {
	if (session.waitingForInput) return "waiting";
	if (session.workspacePreparing) return "preparing";
	if (session.isRunning) return "running";
	if (session.lastRunError) return "error";
	if (session.runState === "done" || session.lastActivity) return "done";
	return "idle";
}

export function sessionTitle(session: Session): string {
	const title = session.title?.trim();
	if (title) return title;
	if (session.branch) return session.branch;
	return session.id.slice(0, 12);
}
