/**
 * Injected prompt context vs. what the human typed.
 *
 * The model needs a lot of injected context on a turn — the system preamble
 * (especially for Codex, which has no separate system channel so it all rides
 * on the user turn), the repos note, and the engine-switch handoff transcript.
 * All of that is plumbing: it belongs in the model's input but NOT in the
 * rendered conversation, where it reads as a giant unexplained "You" message.
 *
 * We fence injected blocks with these sentinels. The runners keep them in the
 * prompt sent to the model; the transcript parser strips fenced blocks so the
 * UI shows only the human's actual message (the model-switch divider already
 * conveys that the engine changed). Sentinels are inert tag-like text the model
 * simply reads as context.
 */
export const CTX_OPEN = "<opensession:context>";
export const CTX_CLOSE = "</opensession:context>";
// Pre-rename fence pair. Old transcripts (and attached-session inlines of them)
// carry these forever: stripping and neutralization must keep handling both.
const LEGACY_CTX_OPEN = "<backstage:context>";
const LEGACY_CTX_CLOSE = "</backstage:context>";

/** Fence a block of injected context so it renders invisibly in the transcript. */
export function wrapContext(body: string): string {
  // Neutralize any fence sentinels inside the body: a nested
  // <opensession:context> marker in inlined content (e.g. an attached session's
  // transcript that literally contains the string) would otherwise let that
  // content break out of the fence and inject unfenced instructions into the
  // agent — a prompt-injection vector. A sentinel inside a fenced block is
  // never legitimate, so replacing the angle brackets is always safe.
  const safe = body
    .replaceAll(CTX_OPEN, "‹opensession:context›")
    .replaceAll(CTX_CLOSE, "‹/opensession:context›")
    .replaceAll(LEGACY_CTX_OPEN, "‹backstage:context›")
    .replaceAll(LEGACY_CTX_CLOSE, "‹/backstage:context›");
  return `${CTX_OPEN}\n${safe}\n${CTX_CLOSE}`;
}

const STRIP_RE = /<(?:opensession|backstage):context>[\s\S]*?<\/(?:opensession|backstage):context>\n*/g;
// A delivery attribution ("[Name] ", added when a prompt is handed to the
// engine) with nothing left after the fence is stripped: the whole turn was
// plumbing, so the prefix is all the transcript would carry. Left in, it
// rendered as an authored-but-empty bubble — a bare identity dot labelled
// "auto-continue" above the next message (2026-07-30).
const ATTRIBUTION_ONLY_RE = /^\[[^\]\n]{1,80}\]$/;

/** Remove fenced context blocks (and any trailing blank lines) for display. */
export function stripContext(text: string): string {
  if (!text || !(text.includes(CTX_OPEN) || text.includes(LEGACY_CTX_OPEN)))
    return text;
  const shown = text.replace(STRIP_RE, "").trimStart();
  return ATTRIBUTION_ONLY_RE.test(shown.trim()) ? "" : shown;
}

/** Is this prompt nothing but injected context — plumbing the human never
 *  typed (the auto-continue nudge, see auto-continue.ts)? Such a turn takes no
 *  delivery attribution: there'd be no message to attribute it to. */
export function isContextOnly(text: string): boolean {
  return !!text.trim() && !stripContext(text).trim();
}
