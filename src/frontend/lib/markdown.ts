import { Marked } from "marked";
import { PUBLIC_BASE_URL } from "./brand";

// Dedicated marked instance for session messages so this config doesn't leak
// into other markdown (wiki, etc.). Two customisations:
//  - external links open in a new tab (target=_blank + safe rel); links into
//    OS1 itself navigate in place — session URLs become session-link
//    chips handled client-side, other internal paths load in the same tab
//  - images/videos render inline, capped in size; clicks open the media
//    lightbox (see MediaLightbox.tsx)
const md = new Marked({ async: false, breaks: true });

function attr(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Open Session session ids (`os-<uuidv7>`, and the pre-rename `bks-<uuidv7>` +
// legacy `bks-<slug>`), as they appear in agent output — usually in a codespan,
// e.g. a create_session result or an orchestrator saying "delegated to `os-…`".
// Rendered as a clickable link so you can jump from an orchestrator into the
// worker it spawned (and back). A container-level click handler (SessionViewer)
// navigates on data-session-id, since dangerouslySetInnerHTML can't carry React
// handlers.
const UUIDV7 = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Every minted id is `<prefix>-<uuidv7>`; only the pre-rename `bks-` prefix also
// covers hand-made slug ids (`bks-ghpr-5099-review`), so it alone keeps the
// looser shape — `os-` is short enough that a loose form would turn ordinary
// codespans like `os-release` into session links.
const SESSION_ID_EXACT = new RegExp(
  `^(?:os-${UUIDV7}|bks-[a-z0-9][a-z0-9-]{5,})$`,
  "i",
);
// Bare (non-code) uuidv7-shaped ids in prose — strict so it can't misfire on
// ordinary text.
const SESSION_ID_BARE = new RegExp(`(?:os|bks)-${UUIDV7}`, "i");

// Chip labels. A raw `bks-<uuid>` is 40 characters of noise in the middle of a
// sentence, so a chip shows the referenced session's own title when we know it.
// The app shell registers the titles it already polls (App.tsx); anything not in
// that list — archived, deleted, not yet polled — falls back to a shortened id.
let sessionTitles = new Map<string, string>();
const SESSION_TITLE_MAX = 38;
const SESSION_ID_SHORT = 12; // `os-019fb3ad2` / `bks-019fb3ad`

/** Register id → title for session chips. Cheap no-op when nothing changed. */
export function setSessionTitles(
  entries: Iterable<readonly [string, string | null | undefined]>,
): void {
  const next = new Map<string, string>();
  for (const [id, title] of entries) {
    const t = String(title ?? "").trim();
    if (id && t) next.set(id, t);
  }
  if (next.size === sessionTitles.size) {
    let same = true;
    for (const [id, t] of next) {
      if (sessionTitles.get(id) !== t) {
        same = false;
        break;
      }
    }
    if (same) return; // the common case: a poll that only moved lastActivity
  }
  sessionTitles = next;
  // Labels are baked into the cached HTML, so it has to go when they change.
  mdCache.clear();
}

function shortSessionId(id: string): string {
  // Legacy `bks-<slug>` ids are already short and cutting them mid-word reads
  // worse than showing the whole thing; only uuid-shaped ids get abbreviated.
  // The trailing-dash trim keeps the cut off a segment boundary — the two
  // prefixes differ in length, so a fixed cut lands mid-separator for one.
  return id.length <= 20
    ? id
    : `${id.slice(0, SESSION_ID_SHORT).replace(/-+$/, "")}…`;
}

function sessionLink(id: string, href?: string): string {
  const title = sessionTitles.get(id);
  const label = title
    ? title.length > SESSION_TITLE_MAX
      ? `${title.slice(0, SESSION_TITLE_MAX - 1).trimEnd()}…`
      : title
    : shortSessionId(id);
  // The label is lossy either way (truncated title, abbreviated id), so the
  // full id always stays in the tooltip. data-session-label marks the id
  // fallback for the monospace treatment.
  const tip = title ? `Open ${title} (${id})` : `Open session ${id}`;
  // With an href it's a real link (cmd/middle-click open a tab); without one
  // the delegated click handler is the only way in, so it needs the button role
  // and a tab stop.
  const anchor = href
    ? `href="${attr(href)}" `
    : `role="button" tabindex="0" `;
  return (
    `<a ${anchor}class="session-link" data-session-id="${attr(id)}"` +
    `${title ? "" : ' data-session-label="id"'} title="${attr(tip)}">` +
    `${attr(label)}</a>`
  );
}

// Links into OS1 itself must not open a new window — it's the same app. Known
// public hosts cover links pasted as absolute URLs viewed from another origin
// (e.g. the ts.net entry); same-origin covers everything else, prefix included
// (stripBasePath-style legacy /opensession + /backstage forms).
const INTERNAL_HOSTS = new Set(
  [
    typeof location === "undefined" ? "" : location.hostname,
    (() => {
      try {
        return new URL(PUBLIC_BASE_URL).hostname;
      } catch {
        return "";
      }
    })(),
  ].filter(Boolean),
);

// An auto-linked (or <bracketed>) bare URL: marked hands the raw URL over as
// the link text. Trailing-slash tolerant so `…/session/bks-x/` still counts.
function isBareUrlLink(token: any): boolean {
  const strip = (v: string) => String(v ?? "").replace(/\/+$/, "");
  const text = strip(token.text);
  return text.length > 0 && text === strip(token.href);
}

function internalHref(href: string | null | undefined): {
  sessionId?: string;
} | null {
  if (!href) return null;
  const loc =
    typeof location !== "undefined" ? location.href : "http://127.0.0.1:3850/";
  let url: URL;
  try {
    url = new URL(String(href), loc);
  } catch {
    return null;
  }
  const sameOrigin =
    typeof location !== "undefined" && url.origin === location.origin;
  if (!sameOrigin && !INTERNAL_HOSTS.has(url.hostname)) return null;
  const path = url.pathname.replace(/^\/(?:opensession|backstage)(?=\/)/, "");
  // The path already says "session", so both prefixes take the loose shape here.
  const m =
    path.match(/^\/session\/((?:os|bks)-[a-z0-9][a-z0-9-]{5,})\/?$/i) ??
    path.match(
      /^\/workspace\/[^/]+\/session\/((?:os|bks)-[a-z0-9][a-z0-9-]{5,})\/?$/i,
    );
  return { sessionId: m ? decodeURIComponent(m[1]) : undefined };
}

md.use({
  tokenizer: {
    // Strikethrough requires DOUBLE tildes (~~text~~). GFM also accepts a
    // single ~, but session content is full of bare tildes that are NOT
    // strikethrough — ReScript labeled args (`foo(~storyID=…, ~error)`),
    // approximate numbers (`~350 files`), home paths (`~/.config`) — and two of
    // them on a line struck everything between. Returning undefined on a
    // single tilde lets marked fall through to plain text.
    del(this: any, src: string) {
      const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
      if (!m) return undefined;
      return {
        type: "del",
        raw: m[0],
        text: m[1],
        tokens: this.lexer.inlineTokens(m[1]),
      };
    },
  },
  renderer: {
    // Session content is untrusted (assistant output, tool results, pasted
    // text). marked passes raw HTML through verbatim by default, and we inject
    // the result with dangerouslySetInnerHTML — so an embedded <script> or
    // <img onerror=…> would execute. Escape every raw-HTML token (this method
    // handles both block- and inline-level HTML) so it renders as literal text.
    // All the formatting we actually want (links, images, code) is generated by
    // marked from markdown syntax, not from raw tags, so nothing is lost.
    html(token: any) {
      return attr(token.text ?? token.raw ?? "");
    },
    link(token: any) {
      const text = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      const internal = internalHref(token.href);
      if (internal) {
        // A pasted session URL auto-links with the whole ~90-char URL as
        // its text, which ran straight past the message bubble's edge inside
        // the nowrap chip. Label it like a bare `bks-…` in prose instead.
        if (internal.sessionId && isBareUrlLink(token)) {
          return sessionLink(internal.sessionId, token.href);
        }
        // Same app: navigate in place. Session URLs get the session-link
        // chip + data-session-id so the delegated handler (SessionViewer)
        // navigates client-side; href stays for middle/cmd-click and for
        // surfaces without the handler (full-page load, same tab).
        const chip = internal.sessionId
          ? ` class="session-link" data-session-id="${attr(internal.sessionId)}"`
          : "";
        return `<a href="${attr(token.href)}"${title}${chip}>${text}</a>`;
      }
      return `<a href="${attr(token.href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    codespan(token: any) {
      const t = token.text ?? "";
      // A codespan that is exactly a session id becomes a link into that session.
      if (SESSION_ID_EXACT.test(t)) return sessionLink(t);
      return `<code>${attr(t)}</code>`;
    },
    image(token: any) {
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      // Video files pasted with image syntax would render as a broken <img>
      // linking to a new tab — play them inline instead. Clicks on .md-image
      // open the media lightbox (delegated handler in MediaLightbox.tsx); the
      // wrapping <a> stays for cmd/middle-click open-in-tab.
      if (/\.(mp4|webm|mov|m4v)([?#]|$)/i.test(token.href ?? "")) {
        return `<video class="md-video" src="${attr(token.href)}"${title} controls playsinline preload="metadata"></video>`;
      }
      return (
        `<a href="${attr(token.href)}" target="_blank" rel="noopener noreferrer" class="md-image-link">` +
        `<img class="md-image" src="${attr(token.href)}" alt="${attr(token.text)}"${title} loading="lazy" />` +
        `</a>`
      );
    },
  },
  // Bare session ids in prose (not wrapped in backticks) also link. Strict
  // uuidv7 shape so it only fires on real ids.
  extensions: [
    {
      name: "sessionId",
      level: "inline",
      start(src: string) {
        const m = SESSION_ID_BARE.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        const m = new RegExp(`^(?:os|bks)-${UUIDV7}`, "i").exec(src);
        if (m) return { type: "sessionId", raw: m[0], id: m[0] };
      },
      renderer(token: any) {
        return sessionLink(token.id);
      },
    },
  ],
});

// Rendered-HTML cache: every session open/switch re-renders all visible
// bubbles, and marked is the dominant cost of showing a transcript
// (superlinear on input size). Keyed by the source string, LRU-bounded, and
// only for small-to-medium inputs so a day of big transcripts can't pin
// unbounded HTML in memory (callers clamp giant contents before rendering).
const mdCache = new Map<string, string>();
const MD_CACHE_MAX = 500;
const MD_CACHE_INPUT_MAX = 32 * 1024;

/** Render session markdown to HTML (links open in a new tab, images inline). */
export function renderMarkdown(src: string): string {
  const cacheable = src.length <= MD_CACHE_INPUT_MAX;
  if (cacheable) {
    const hit = mdCache.get(src);
    if (hit !== undefined) {
      // Refresh LRU position
      mdCache.delete(src);
      mdCache.set(src, hit);
      return hit;
    }
  }
  let out: string;
  try {
    out = md.parse(src) as string;
  } catch {
    out = src;
  }
  if (cacheable) {
    mdCache.set(src, out);
    if (mdCache.size > MD_CACHE_MAX) {
      const oldest = mdCache.keys().next().value;
      if (oldest !== undefined) mdCache.delete(oldest);
    }
  }
  return out;
}

function withoutSingleParagraph(html: string): string {
  const trimmed = html.trim();
  const match = /^<p>([\s\S]*)<\/p>$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

function renderPrMarkdownWithSub(src: string): string {
  const subs: string[] = [];
  const prepared = src.replace(/<sub>([\s\S]*?)<\/sub>/gi, (_match, content) => {
    const token = `OPENSESSIONSUBTOKEN${subs.length}END`;
    subs.push(content);
    return token;
  });
  let html = renderMarkdown(prepared);
  subs.forEach((content, index) => {
    const token = `OPENSESSIONSUBTOKEN${index}END`;
    html = html.replaceAll(
      token,
      `<sub>${withoutSingleParagraph(renderMarkdown(content))}</sub>`,
    );
  });
  return html;
}

/**
 * Render GitHub PR prose while preserving its common collapsible-review markup.
 * The whitelist is deliberately exact and attribute-free; all other HTML still
 * goes through renderMarkdown's escaping renderer.
 */
export function renderPrCommentMarkdown(src: string): string {
  const details: Array<{ summary: string; body: string }> = [];
  const prepared = src.replace(
    /<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/gi,
    (_match, summary, body) => {
      const token = `OPENSESSIONDETAILSTOKEN${details.length}END`;
      details.push({ summary, body });
      return `\n\n${token}\n\n`;
    },
  );
  let html = renderPrMarkdownWithSub(prepared);
  details.forEach(({ summary, body }, index) => {
    const token = `OPENSESSIONDETAILSTOKEN${index}END`;
    const rendered =
      `<details class="md-details">` +
      `<summary>${withoutSingleParagraph(renderPrMarkdownWithSub(summary))}</summary>` +
      `<div class="md-details-body">${renderPrMarkdownWithSub(body)}</div>` +
      `</details>`;
    html = html
      .replace(`<p>${token}</p>`, rendered)
      .replace(token, rendered);
  });
  return html;
}
