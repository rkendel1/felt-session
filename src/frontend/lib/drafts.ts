/**
 * Per-composer draft persistence, so typed text and staged attachments survive
 * navigating away (session → other session / workspace / home) instead of dying with
 * the unmounted component.
 *
 * The module-level Map is the source of truth while the app is open — every
 * SessionViewer remounts on session switch (key=session.id in App), so component
 * state can't carry a draft across. sessionStorage is a best-effort mirror so a
 * tab reload keeps the draft too; writes are debounced because images ride
 * along as multi-MB `data:` URLs and drafts are saved on every keystroke.
 */
import type { FileAttachment } from "./images";

export interface ComposerDraft {
  text: string;
  images: string[];
  files: FileAttachment[];
}

const EMPTY: ComposerDraft = { text: "", images: [], files: [] };
const drafts = new Map<string, ComposerDraft>();

// Fired only when a draft appears or disappears (never per keystroke — that
// would re-render every subscriber, e.g. the whole sidebar, while typing).
// Drives the "unsent draft" pencil indicators.
const CHANGE_EVENT = "backstage-drafts-changed";

function emit() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Subscribe to drafts appearing/disappearing; returns the unsubscribe. */
export function onDraftsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

/** Whether a non-empty draft (text or attachments) is stored under this key. */
export function hasDraft(key: string): boolean {
  return !isEmpty(loadDraft(key));
}

const SS_PREFIX = "backstage-draft:";
// Stay well under the ~5MB sessionStorage quota; an oversized draft (big
// screenshots) just stays memory-only instead of throwing.
const MAX_PERSIST_BYTES = 3_000_000;
const PERSIST_DEBOUNCE_MS = 400;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function isEmpty(d: ComposerDraft): boolean {
  return !d.text.trim() && d.images.length === 0 && d.files.length === 0;
}

function persistNow(key: string) {
  timers.delete(key);
  const d = drafts.get(key);
  try {
    if (!d || isEmpty(d)) {
      sessionStorage.removeItem(SS_PREFIX + key);
      return;
    }
    const json = JSON.stringify(d);
    if (json.length > MAX_PERSIST_BYTES) sessionStorage.removeItem(SS_PREFIX + key);
    else sessionStorage.setItem(SS_PREFIX + key, json);
  } catch {
    // Quota or private-mode failure — the in-memory copy still holds the draft.
  }
}

function schedulePersist(key: string) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => persistNow(key), PERSIST_DEBOUNCE_MS));
}

// Flush pending mirrors when the page is going away, so the debounce window
// can't eat the last keystrokes before a reload.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const key of [...timers.keys()]) {
      clearTimeout(timers.get(key));
      persistNow(key);
    }
  });
}

/** Current draft for a key ("" / empty arrays when none). Treat as immutable. */
export function loadDraft(key: string): ComposerDraft {
  const mem = drafts.get(key);
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const d: ComposerDraft = {
        text: typeof parsed?.text === "string" ? parsed.text : "",
        images: Array.isArray(parsed?.images) ? parsed.images : [],
        files: Array.isArray(parsed?.files) ? parsed.files : [],
      };
      drafts.set(key, d);
      return d;
    }
  } catch {}
  return EMPTY;
}

/** Merge a partial update into the stored draft; an all-empty result deletes it. */
export function saveDraft(key: string, patch: Partial<ComposerDraft>): void {
  const had = !isEmpty(loadDraft(key));
  const next = { ...loadDraft(key), ...patch };
  const has = !isEmpty(next);
  if (has) {
    drafts.set(key, next);
    schedulePersist(key);
  } else {
    // Delete synchronously, never debounced: subscribers react to the change
    // event by calling hasDraft/loadDraft, and with the sessionStorage entry
    // still present a Map miss would re-cache the stale draft — resurrecting
    // what was just cleared (drafts reappearing after send).
    drafts.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    try {
      sessionStorage.removeItem(SS_PREFIX + key);
    } catch {}
  }
  if (had !== has) emit();
}

export function clearDraft(key: string): void {
  const had = hasDraft(key);
  drafts.delete(key);
  clearTimeout(timers.get(key));
  timers.delete(key);
  try {
    sessionStorage.removeItem(SS_PREFIX + key);
  } catch {}
  if (had) emit();
}
