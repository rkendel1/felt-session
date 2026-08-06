/**
 * How loudly a system chip in the transcript should read.
 *
 * Everything operational the server and runner write lands in the transcript
 * as the same faint grey pill: "switched account and retried", "message
 * queued", and "your run died 40 minutes ago" are typographically identical,
 * so the one line that actually needs a human is the easiest to scroll past.
 *
 * These lines are free text on the wire — the `<runner-notice>` marker carries
 * no metadata, and the thousands already persisted in transcripts never will —
 * so the tone is derived from the stable phrasings the writing call sites use.
 * Anything unrecognised stays neutral: a miss costs a grey pill where a red one
 * belonged, never a false alarm on a routine notice.
 */
export type NoticeTone = "error" | "warn" | "info";

/** The run is over and it did not do what was asked — a human has to act. */
const ERROR_PATTERNS: RegExp[] = [
	// run-session.ts, both terminal-failure choke points.
	/^run (failed|stopped):/,
	// The per-turn time limit (turnTimeoutNotice in opencode-config.ts). The
	// second form is the wording used before 2026-07-31 — transcripts keep it
	// forever, so it keeps its colour.
	/^stopped after \d/,
	/^turn stopped after \d+ minutes?\b/,
	// A sandbox workspace that has no host checkout to fall back to.
	/\bno host fallback\b/,
	// Legacy frontend build wording, retained for older persisted notices.
	/^frontend rebuild failed\b/,
];

/** Something went sideways, but the work continued — worth noticing, not alarming. */
const WARN_PATTERNS: RegExp[] = [
	/^sandbox unavailable\b/,
	/^couldn't\b/,
	/^this session's worktree\b/,
	// A recoverable background rebuild: clients keep using the prior bundle.
	/^app update paused\b/,
];

/** Leading glyph some notices already carry; the tone supplies its own. */
const LEADING_GLYPH_RE = /^[\s⚠️❌🚨]+/u;

export function stripNoticeGlyph(content: string): string {
	return content.replace(LEADING_GLYPH_RE, "");
}

export function noticeTone(content: string): NoticeTone {
	const text = stripNoticeGlyph(content || "").toLowerCase();
	if (!text) return "info";
	if (ERROR_PATTERNS.some((re) => re.test(text))) return "error";
	if (WARN_PATTERNS.some((re) => re.test(text))) return "warn";
	return "info";
}
