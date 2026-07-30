/**
 * Transcript entries → the one or few lines a terminal should show.
 *
 * Pure string work, kept out of the components so it's testable: the tool-call
 * summary in particular is the difference between a readable transcript and a
 * screenful of JSON.
 */

import type { Session, TranscriptEntry } from "../client/types";

/** Compact relative age: "now", "4m", "3h", "2d". */
export function relativeTime(stamp?: string | null, now = Date.now()): string {
	if (!stamp) return "";
	const then = Date.parse(stamp);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 45) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** First meaningful path/command-ish value in a tool's input, for the one-liner. */
function toolArgument(input: unknown): string {
	if (!input || typeof input !== "object") {
		return typeof input === "string" ? input : "";
	}
	const record = input as Record<string, unknown>;
	for (const key of [
		"file_path",
		"path",
		"command",
		"pattern",
		"query",
		"prompt",
		"description",
		"url",
		"notebook_path",
	]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	// Nothing recognisable — show the keys so the line still says something.
	const keys = Object.keys(record);
	return keys.length ? `{${keys.slice(0, 3).join(", ")}}` : "";
}

/** Collapse a home-anchored path so the interesting tail survives narrow panes. */
export function shortenPath(value: string, max = 60): string {
	let text = value.replace(/^\/home\/[^/]+\//, "~/");
	if (text.length <= max) return text;
	const parts = text.split("/");
	while (parts.length > 2 && parts.join("/").length > max) parts.splice(1, 1);
	text = parts.join("/…/").replace("/…//", "/…/");
	return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

export type DisplayEntry = {
	id: string;
	kind: "user" | "assistant" | "tool" | "system";
	/** Leading glyph + label, e.g. "▸ read". */
	prefix: string;
	/** The body — may be multi-line for user/assistant text. */
	body: string;
	error?: boolean;
	/** Server clamped the body; the full one is a fetch away. */
	clamped?: boolean;
};

const TOOL_RESULT_PREVIEW = 240;

export function formatEntry(entry: TranscriptEntry): DisplayEntry | null {
	const content = (entry.content ?? "").replace(/\s+$/, "");

	switch (entry.type) {
		case "user":
			return {
				id: entry.id,
				kind: "user",
				prefix: "›",
				body: content,
				clamped: entry.contentClamped,
			};

		case "assistant":
			if (!content) return null;
			return {
				id: entry.id,
				kind: "assistant",
				prefix: "",
				body: content,
				clamped: entry.contentClamped,
			};

		case "tool_use": {
			const argument = toolArgument(entry.toolInput);
			return {
				id: entry.id,
				kind: "tool",
				prefix: `▸ ${entry.toolName ?? "tool"}`,
				body: argument ? shortenPath(argument.split("\n")[0] ?? "") : "",
			};
		}

		case "tool_result": {
			// Results are noise by default; one truncated line is enough to see
			// that it came back, and errors get the full first lines.
			const firstLines = content.split("\n").slice(0, entry.isError ? 4 : 1).join(" ⏎ ");
			const body =
				firstLines.length > TOOL_RESULT_PREVIEW
					? `${firstLines.slice(0, TOOL_RESULT_PREVIEW)}…`
					: firstLines;
			if (!body) return null;
			return {
				id: entry.id,
				kind: "tool",
				prefix: entry.isError ? "◂ error" : "◂",
				body,
				error: entry.isError,
			};
		}

		default:
			if (!content) return null;
			return { id: entry.id, kind: "system", prefix: "•", body: content };
	}
}

export function formatEntries(entries: TranscriptEntry[]): DisplayEntry[] {
	const out: DisplayEntry[] = [];
	for (const entry of entries) {
		const display = formatEntry(entry);
		if (display) out.push(display);
	}
	return out;
}

/** The session line in the status bar: repo · branch · model. */
export function sessionSubtitle(session: Session | undefined): string {
	if (!session) return "";
	const parts = [session.repo, session.branch, session.model, session.mode].filter(
		(p): p is string => typeof p === "string" && p.length > 0,
	);
	return parts.join(" · ");
}
