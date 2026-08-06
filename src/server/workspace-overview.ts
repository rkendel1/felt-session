/**
 * Workspace overview — the data behind the floating "what is this workspace
 * about" panel in the session viewer: the opening prompt (the first thing a
 * human typed into the workspace's oldest session) plus every piece of media
 * (screenshots from tool results, pasted images, recorded videos) across all
 * member sessions.
 *
 * Media is returned as *references*, not bytes: transcript images are base64
 * data URLs that would balloon the JSON to many MB, so each one becomes a
 * `/api/sessions/<id>/transcript-image/<entryId>/<idx>` URL the
 * browser loads (and caches) lazily. Videos already stream via
 * /media, and http(s) image URLs pass through as-is.
 */

import { parseTranscriptAsync } from "./jsonl-parser";
import type { TranscriptEntry } from "./types";

export interface OverviewSession {
  id: string;
  title?: string;
  createdAt?: string;
  transcriptPath?: string | null;
}

export interface WorkspaceMediaItem {
  kind: "image" | "video";
  src: string;
  sessionId: string;
  sessionTitle?: string;
  at: string;
}

export interface WorkspaceOverview {
  prompt: { content: string; sessionId: string; at: string } | null;
  /** Latest assistant text across all member sessions — the "where things stand"
   *  one-liner for the sidebar hover card. */
  lastMessage: { content: string; sessionId: string; at: string } | null;
  media: WorkspaceMediaItem[];
}

/** Newest-first cap — the panel is a glance, not an archive. */
const MEDIA_CAP = 100;

/** First human-typed turn: skip slash commands (/model, /goal) and empty
 *  image-only sends so the panel shows the actual ask. */
function isOpeningPrompt(e: TranscriptEntry): boolean {
  const t = e.content?.trim() || "";
  return e.type === "user" && t.length > 0 && !t.startsWith("/");
}

function imageSrcFor(sessionId: string, entry: TranscriptEntry, idx: number, raw: string): string {
  // Only data URLs need the indirection; a real URL renders directly.
  if (!raw.startsWith("data:")) return raw;
  return `/api/sessions/${encodeURIComponent(sessionId)}/transcript-image/${encodeURIComponent(entry.id)}/${idx}`;
}

export async function buildWorkspaceOverview(
  sessions: OverviewSession[],
): Promise<WorkspaceOverview> {
  const ordered = [...sessions].sort((a, b) =>
    (a.createdAt || "").localeCompare(b.createdAt || ""),
  );

  let prompt: WorkspaceOverview["prompt"] = null;
  let lastMessage: WorkspaceOverview["lastMessage"] = null;
  const media: WorkspaceMediaItem[] = [];

  for (const session of ordered) {
    if (!session.transcriptPath) continue;
    // Async: this loops over EVERY session in the workspace — back-to-back sync
    // parses of fat transcripts wedged the event loop for the whole sweep.
    const entries = await parseTranscriptAsync(session.transcriptPath);
    if (!prompt) {
      const first = entries.find(isOpeningPrompt);
      if (first)
        prompt = { content: first.content, sessionId: session.id, at: first.timestamp };
    }
    for (const e of entries) {
      if (
        e.type === "assistant" &&
        (e.content?.trim().length || 0) > 0 &&
        (!lastMessage || e.timestamp > lastMessage.at)
      )
        lastMessage = { content: e.content, sessionId: session.id, at: e.timestamp };
    }
    for (const e of entries) {
      for (let i = 0; i < (e.images?.length || 0); i++) {
        media.push({
          kind: "image",
          src: imageSrcFor(session.id, e, i, e.images![i]),
          sessionId: session.id,
          sessionTitle: session.title,
          at: e.timestamp,
        });
      }
      for (const v of e.videos || []) {
        media.push({
          kind: "video",
          src: v,
          sessionId: session.id,
          sessionTitle: session.title,
          at: e.timestamp,
        });
      }
    }
  }

  media.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return { prompt, lastMessage, media: media.slice(0, MEDIA_CAP) };
}

/**
 * Resolve one transcript image back to servable bytes. Returns null when the
 * entry/index doesn't exist, or a redirect target when the image is already a
 * plain URL.
 */
export async function resolveTranscriptImage(
  transcriptPath: string,
  entryId: string,
  idx: number,
): Promise<{ bytes: ArrayBuffer; contentType: string } | { redirect: string } | null> {
  const entry = (await parseTranscriptAsync(transcriptPath)).find(
    (e) => e.id === entryId,
  );
  const src = entry?.images?.[idx];
  if (!src) return null;
  if (!src.startsWith("data:")) return { redirect: src };
  const m = src.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2], "base64");
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      contentType: m[1],
    };
  } catch {
    return null;
  }
}
