// Build shareable Open Session links and copy them to the clipboard. The app is
// served over plain HTTP on the Tailscale IP, so `navigator.clipboard` is often
// absent (it needs a secure context) — every copy path falls back to a hidden
// textarea + execCommand, the same trick the viewer's share button uses.

import { BASE_PATH } from "./base";

/** Canonical session/workspace URL path — workspace-scoped when the session has one. */
export function sessionPath(session: {
  id: string;
  workspaceId?: string | null;
}): string {
  return session.workspaceId
    ? `${BASE_PATH}/workspace/${encodeURIComponent(session.workspaceId)}/session/${encodeURIComponent(session.id)}`
    : `${BASE_PATH}/session/${encodeURIComponent(session.id)}`;
}

/** Session-less PR preview URL path. */
export function prPath(repo: string, branch: string): string {
  return `${BASE_PATH}/pr/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`;
}

/** Absolute link for a path built above. */
export function absoluteLink(path: string): string {
  return `${location.origin}${path}`;
}

/**
 * True when the native share sheet is the better affordance for a share
 * button: the Web Share API exists (secure context) and the device is
 * touch-first. On desktop the button's real job is "give me the link", so
 * copying stays the behavior there even though macOS Safari has the API.
 */
export function canNativeShare(): boolean {
  return (
    typeof navigator.share === "function" &&
    !!window.matchMedia?.("(pointer: coarse)").matches
  );
}

/**
 * Share a link through the native sheet when that's the better affordance,
 * else copy it. `onCopied` fires only on the copy path — the sheet is its own
 * feedback, and a dismissed sheet (AbortError) is a non-event, not a fallback.
 */
export function shareOrCopyLink(
  link: string,
  opts: { title?: string; onCopied?: () => void } = {},
): void {
  if (canNativeShare()) {
    navigator.share({ url: link, title: opts.title }).catch((err) => {
      if ((err as Error | undefined)?.name === "AbortError") return;
      copyToClipboard(link, opts.onCopied);
    });
    return;
  }
  copyToClipboard(link, opts.onCopied);
}

/** Copy text to the clipboard, secure-context or not; `onDone` fires either way. */
export function copyToClipboard(text: string, onDone?: () => void): void {
  const done = onDone || (() => {});
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, onDone: () => void): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    // Best-effort — a failed copy shouldn't throw into the caller.
  }
  onDone();
}
