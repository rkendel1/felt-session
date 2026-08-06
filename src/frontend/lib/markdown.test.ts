import { afterEach, describe, expect, it } from "bun:test";
import {
  renderMarkdown,
  renderPrCommentMarkdown,
  setSessionTitles,
} from "./markdown";

afterEach(() => setSessionTitles([]));

describe("renderMarkdown session links", () => {
  it("turns a session-id codespan into a link", () => {
    const html = renderMarkdown(
      "Delegated to `bks-019f24b5-f31d-7000-a48f-31a9e829c4ae` reporting back.",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f24b5-f31d-7000-a48f-31a9e829c4ae"',
    );
    // not rendered as a plain <code> chip
    expect(html).not.toContain(
      "<code>bks-019f24b5-f31d-7000-a48f-31a9e829c4ae</code>",
    );
  });

  it("links a bare (un-backticked) uuidv7 session id in prose", () => {
    const html = renderMarkdown(
      "Started session bks-019f24b5-daa6-7000-8231-6c7ff13672ae as a worker.",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f24b5-daa6-7000-8231-6c7ff13672ae"',
    );
  });

  it("links an `os-` id — the prefix minted since the rename", () => {
    const codespan = renderMarkdown(
      "Delegated to `os-019fd30a-785b-7000-ad89-9c2fb5b74a19` reporting back.",
    );
    expect(codespan).toContain(
      'data-session-id="os-019fd30a-785b-7000-ad89-9c2fb5b74a19"',
    );
    const bare = renderMarkdown(
      "Started session os-019fd30a-785b-7000-ad89-9c2fb5b74a19 as a worker.",
    );
    expect(bare).toContain(
      'data-session-id="os-019fd30a-785b-7000-ad89-9c2fb5b74a19"',
    );
    const url = renderMarkdown(
      "See [it](http://127.0.0.1:3850/session/os-019fd30a-785b-7000-ad89-9c2fb5b74a19).",
    );
    expect(url).toContain(
      'data-session-id="os-019fd30a-785b-7000-ad89-9c2fb5b74a19"',
    );
    expect(url).not.toContain("target=");
  });

  it("keeps `os-` strict: only a uuid-shaped id, never a codespan that starts with it", () => {
    // `bks-` was distinctive enough for the loose slug shape; `os-` is two
    // letters, so anything but the minted `os-<uuidv7>` stays a code chip.
    const html = renderMarkdown("Tagged `os-release-2026` for the cut.");
    expect(html).toContain("<code>os-release-2026</code>");
    expect(html).not.toContain("session-link");
  });

  it("still resolves a legacy /backstage-prefixed session URL in-app", () => {
    // Pre-rename links live on in old transcripts; the server 301s them, but
    // the chip has to recognize the path to keep the click client-side.
    const html = renderMarkdown(
      "See [this](http://127.0.0.1:3850/backstage/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436).",
    );
    expect(html).toContain(
      'data-session-id="bks-019f9608-ab20-7000-b98e-4de52d5fe436"',
    );
    expect(html).not.toContain("target=");
  });

  it("leaves ordinary codespans as code", () => {
    const html = renderMarkdown("Run `bun test` to check.");
    expect(html).toContain("<code>bun test</code>");
    expect(html).not.toContain("session-link");
  });

  it("does not misfire on non-session text", () => {
    const html = renderMarkdown("The bks-abbreviation is fine here.");
    expect(html).not.toContain("session-link");
  });

  it("renders an OS1 session URL as an in-app session link (no new tab)", () => {
    const html = renderMarkdown(
      "See [this session](http://127.0.0.1:3850/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436).",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f9608-ab20-7000-b98e-4de52d5fe436"',
    );
    expect(html).toContain(">this session</a>");
    expect(html).not.toContain("target=");
  });

  it("labels a pasted (auto-linked) session URL with just the session id", () => {
    const url =
      "http://127.0.0.1:3850/workspace/ws-28712580-a369-4d58-996b-f8c23e523ed1/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436";
    const html = renderMarkdown(`${url} shows no right sidebar.`);
    expect(html).toContain(
      'data-session-id="bks-019f9608-ab20-7000-b98e-4de52d5fe436"',
    );
    // the ~90-char URL is the href, never the chip's (nowrap) label
    expect(html).toContain(">bks-019f9608…</a>");
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain(`>${url}</a>`);
  });

  it("keeps an explicit link label on a session URL", () => {
    const html = renderMarkdown(
      "See [the worker](http://127.0.0.1:3850/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436).",
    );
    expect(html).toContain(">the worker</a>");
  });

  it("keeps other internal OS1 links same-tab without a chip", () => {
    const html = renderMarkdown(
      "Open [automations](http://127.0.0.1:3850/automations).",
    );
    expect(html).not.toContain("target=");
    expect(html).not.toContain("session-link");
  });

  it("still opens external links in a new tab", () => {
    const html = renderMarkdown("See [GitHub](https://github.com/tella/x).");
    expect(html).toContain('target="_blank"');
  });
});

describe("session chip labels", () => {
  const id = "bks-019f24b5-f31d-7000-a48f-31a9e829c4ae";

  it("labels a chip with the session's title once registered", () => {
    setSessionTitles([[id, "Fix the sidebar hover states"]]);
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(">Fix the sidebar hover states</a>");
    expect(html).toContain(`data-session-id="${id}"`);
    // the full id stays reachable in the tooltip
    expect(html).toContain(`title="Open Fix the sidebar hover states (${id})"`);
    expect(html).not.toContain("data-session-label");
  });

  it("falls back to a shortened id, marked for monospace", () => {
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(">bks-019f24b5…</a>");
    expect(html).toContain('data-session-label="id"');
    expect(html).toContain(`title="Open session ${id}"`);
  });

  it("cuts an `os-` id on a segment boundary, not mid-separator", () => {
    const html = renderMarkdown(
      "Delegated to `os-019fd30a-785b-7000-ad89-9c2fb5b74a19`.",
    );
    expect(html).toContain(">os-019fd30a…</a>");
  });

  it("keeps short legacy slug ids whole", () => {
    const html = renderMarkdown("Delegated to `bks-worker-two`.");
    expect(html).toContain(">bks-worker-two</a>");
  });

  it("truncates a long title", () => {
    setSessionTitles([
      [id, "A very long session title that would eat the whole sentence"],
    ]);
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(">A very long session title that would…</a>");
  });

  it("re-labels already-rendered markdown when titles arrive", () => {
    const src = `Delegated to \`${id}\`.`;
    expect(renderMarkdown(src)).toContain(">bks-019f24b5…</a>");
    setSessionTitles([[id, "Late title"]]);
    expect(renderMarkdown(src)).toContain(">Late title</a>");
  });

  it("ignores blank titles and unrelated sessions", () => {
    setSessionTitles([
      [id, "   "],
      ["bks-someone-else", "Other"],
    ]);
    expect(renderMarkdown(`Delegated to \`${id}\`.`)).toContain(
      ">bks-019f24b5…</a>",
    );
  });
});

describe("renderMarkdown strikethrough (double-tilde only)", () => {
  it("does not strike through single tildes in code-ish content", () => {
    // ReScript labeled args, approximate numbers, home paths — all bare tildes.
    for (const src of [
      "updateUpdatedAt(~storyID=query.id, ~sceneID=scene.id)",
      "call foo(~storyID) then bar(~sceneID) next",
      "That leaves ~352 across ~165 files",
      "edit ~/.config and ~/.bashrc",
    ]) {
      expect(renderMarkdown(src)).not.toContain("<del>");
    }
  });

  it("still renders real ~~strikethrough~~", () => {
    expect(renderMarkdown("this is ~~struck~~ text")).toContain("<del>struck</del>");
  });
});

describe("renderPrCommentMarkdown GitHub details", () => {
  it("renders collapsible reviews and subtext", () => {
    const html = renderPrCommentMarkdown(`<details> <summary>Outdated review</summary>
**Ada review** · request changes

<sub>Reviewed 3147253 · open session</sub>
</details>`);

    expect(html).toContain('<details class="md-details">');
    expect(html).toContain("<summary>Outdated review</summary>");
    expect(html).toContain("<strong>Ada review</strong>");
    expect(html).toContain("<sub>Reviewed 3147253 · open session</sub>");
  });

  it("continues to escape untrusted HTML", () => {
    const html = renderPrCommentMarkdown(
      "<details><summary>Safe</summary><script>alert(1)</script></details>",
    );
    expect(html).toContain('<details class="md-details">');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("does not allow attributes on whitelisted tags", () => {
    const html = renderPrCommentMarkdown(
      '<details open onclick="alert(1)"><summary>Unsafe</summary>Body</details>',
    );
    expect(html).toContain("&lt;details open onclick=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain('<details open onclick="alert(1)">');
  });
});
