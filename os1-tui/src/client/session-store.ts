/**
 * The watched-session reducer: server frames in, renderable state out.
 *
 * Pure on purpose. Everything interesting about this client — transcript
 * ordering, mid-stream text, queue chips, blocked-on-a-question — lives here,
 * where a test can drive it with recorded frames and no terminal and no server.
 * The renderer above it is a dumb projection of this state.
 */

import type {
	AskQuestion,
	QueueItem,
	ServerFrame,
	TranscriptCursor,
	TranscriptEntry,
} from "./types";

export type SessionState = {
	/** Ordered oldest → newest, id-keyed upsert (the server may re-send). */
	entries: TranscriptEntry[];
	/** Earlier history exists before `startOffset`. */
	truncated: boolean;
	/** Byte cursor for "load earlier"; undefined when the server sent none. */
	startOffset?: number;
	/** Resume cursor for reconnect (endOffset + rev of the last frame). */
	cursor: TranscriptCursor;
	/** A turn is mid-stream: `streamText` is the assistant text so far. */
	streaming: boolean;
	streamText: string;
	isRunning: boolean;
	queued: QueueItem[];
	steered: QueueItem[];
	ask: AskQuestion | null;
	notice?: string;
	error?: string;
	/** Server boot id; a change means the server restarted under us. */
	bootId?: string;
	/** True once a transcript_init has landed — drives "loading…" vs "empty". */
	loaded: boolean;
};

export const initialSessionState: SessionState = {
	entries: [],
	truncated: false,
	cursor: null,
	streaming: false,
	streamText: "",
	isRunning: false,
	queued: [],
	steered: [],
	ask: null,
	loaded: false,
};

/**
 * Merge entries by id, preserving arrival order for new ones. The server
 * re-sends entries in overlap windows (reconnect gap-fill, history paging), and
 * a provisional streamed tool entry is later replaced by its committed form —
 * upsert absorbs all three without duplicating bubbles.
 */
function upsert(
	existing: TranscriptEntry[],
	incoming: TranscriptEntry[],
	where: "append" | "prepend",
): TranscriptEntry[] {
	if (!incoming.length) return existing;
	const index = new Map(existing.map((e, i) => [e.id, i]));
	const merged = existing.slice();
	const fresh: TranscriptEntry[] = [];
	for (const entry of incoming) {
		const at = index.get(entry.id);
		if (at === undefined) {
			fresh.push(entry);
			index.set(entry.id, -1);
		} else if (at >= 0) {
			// The newer frame wins on every field EXCEPT content, where a clamped
			// re-send must not overwrite a body we already hold in full. Merging
			// whole objects by "whichever content is longer" would let stale
			// fields ride along — that's how a committed tool_result got
			// downgraded back to tool_use.
			const prev = merged[at]!;
			const next = { ...prev, ...entry };
			const prevLen = prev.content?.length ?? 0;
			const nextLen = entry.content?.length ?? 0;
			if (prevLen > nextLen) {
				next.content = prev.content;
				next.contentClamped = prev.contentClamped;
				next.contentLength = prev.contentLength;
			}
			merged[at] = next;
		}
	}
	if (!fresh.length) return merged;
	return where === "append" ? [...merged, ...fresh] : [...fresh, ...merged];
}

function cursorFrom(
	frame: { endOffset?: number; rev?: string },
	fallback: TranscriptCursor,
): TranscriptCursor {
	if (typeof frame.endOffset === "number" && typeof frame.rev === "string") {
		return { endOffset: frame.endOffset, rev: frame.rev };
	}
	return fallback;
}

/** One frame → next state. Returns the same object when nothing changed. */
export function applyFrame(state: SessionState, frame: ServerFrame): SessionState {
	switch (frame.type) {
		case "hello": {
			const bootId = (frame as { bootId?: string }).bootId;
			return bootId === state.bootId ? state : { ...state, bootId };
		}

		case "transcript_init": {
			const f = frame as Extract<ServerFrame, { type: "transcript_init" }>;
			return {
				...state,
				// init is a REPLACE, not a merge: it's the authoritative tail (and
				// arrives fresh after an engine-id rotation, where old ids are gone).
				entries: f.entries ?? [],
				truncated: f.truncated === true,
				startOffset: f.startOffset,
				cursor: cursorFrom(f, state.cursor),
				loaded: true,
				// A new snapshot supersedes any half-streamed text.
				streaming: false,
				streamText: "",
			};
		}

		case "transcript_history": {
			const f = frame as Extract<ServerFrame, { type: "transcript_history" }>;
			return {
				...state,
				entries: upsert(state.entries, f.entries ?? [], "prepend"),
				truncated: f.truncated === true,
				startOffset: f.startOffset ?? state.startOffset,
			};
		}

		case "transcript_append": {
			const f = frame as Extract<ServerFrame, { type: "transcript_append" }>;
			const entries = upsert(state.entries, f.entries ?? [], "append");
			// The committed entry has landed; drop the streaming shadow so the text
			// isn't on screen twice.
			const assistantLanded = (f.entries ?? []).some((e) => e.type === "assistant");
			return {
				...state,
				entries,
				cursor: cursorFrom(f, state.cursor),
				loaded: true,
				...(assistantLanded ? { streaming: false, streamText: "" } : {}),
			};
		}

		case "stream_start":
			return { ...state, streaming: true, streamText: "", isRunning: true };

		case "stream_text": {
			const text = (frame as { text?: string }).text ?? "";
			if (!text) return state;
			return {
				...state,
				streaming: true,
				streamText: state.streamText + text,
				isRunning: true,
			};
		}

		case "stream_tool_use":
		case "stream_tool_result": {
			const entry = (frame as { entry?: TranscriptEntry }).entry;
			if (!entry) return state;
			return {
				...state,
				entries: upsert(state.entries, [entry], "append"),
				isRunning: true,
			};
		}

		case "stream_done":
			// Keep `streamText` until the committed entry arrives: clearing here
			// would blank the just-written answer for a beat.
			return { ...state, streaming: false };

		case "session_status": {
			const isRunning = (frame as { isRunning?: boolean }).isRunning === true;
			if (isRunning === state.isRunning) return state;
			return {
				...state,
				isRunning,
				...(isRunning ? {} : { streaming: false }),
			};
		}

		case "queue_update": {
			const f = frame as Extract<ServerFrame, { type: "queue_update" }>;
			return { ...state, queued: f.queued ?? [], steered: f.steered ?? [] };
		}

		case "ask_question": {
			const f = frame as Extract<ServerFrame, { type: "ask_question" }>;
			if (!f.questionId || !f.questions?.length) return state;
			return {
				...state,
				ask: { questionId: f.questionId, questions: f.questions },
			};
		}

		case "ask_resolved": {
			const questionId = (frame as { questionId?: string }).questionId;
			if (!state.ask || (questionId && state.ask.questionId !== questionId)) {
				return state;
			}
			return { ...state, ask: null };
		}

		case "notice":
			return { ...state, notice: (frame as { message?: string }).message };

		case "error":
			return { ...state, error: (frame as { message?: string }).message };

		default:
			return state;
	}
}

/** Fold a batch of frames — the shape recorded fixtures replay through. */
export function applyFrames(state: SessionState, frames: ServerFrame[]): SessionState {
	return frames.reduce(applyFrame, state);
}
