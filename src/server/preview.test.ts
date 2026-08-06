import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoLifecycle, resolvePreviewBoot } from "./preview";

// The resolver is the ONE bring-up chain shared by host and sandbox previews:
// repo-committed .opensession/start.sh (.backstage/ pre-rename fallback) →
// configured previewCommand.
// `exists` abstracts host-fs vs in-container checks, so these tests drive it
// with plain sets of paths.

const WT = "/srv/worktrees/widget-some-branch";
const PREVIEW_COMMAND = "/srv/opensession/bin/start-widget-preview";

function existsIn(paths: string[]) {
  return (p: string) => paths.includes(p);
}

describe("resolvePreviewBoot", () => {
  test("repo-committed .opensession/start.sh wins over previewCommand", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget", previewCommand: PREVIEW_COMMAND },
      existsIn([`${WT}/.opensession/start.sh`, PREVIEW_COMMAND]),
    );
    expect(boot).toEqual({
      kind: "repo-script",
      cmd: `bash ${WT}/.opensession/start.sh`,
      setupScript: undefined,
    });
  });

  test("start.sh resolution picks up the sibling setup.sh one-shot hook", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget" },
      existsIn([`${WT}/.opensession/start.sh`, `${WT}/.opensession/setup.sh`]),
    );
    expect(boot?.kind).toBe("repo-script");
    expect(boot?.setupScript).toBe(`${WT}/.opensession/setup.sh`);
  });

  test("previewCommand runs with the worktree as $1", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget", previewCommand: PREVIEW_COMMAND },
      existsIn([PREVIEW_COMMAND]),
    );
    expect(boot).toEqual({ kind: "preview-command", cmd: `${PREVIEW_COMMAND} ${WT}` });
  });

  test("non-absolute previewCommand is trusted without an existence check", async () => {
    const boot = await resolvePreviewBoot(
      "/srv/worktrees/docs-some-branch",
      { id: "docs", previewCommand: "npm run dev --" },
      existsIn([]),
    );
    expect(boot).toEqual({
      kind: "preview-command",
      cmd: "npm run dev -- /srv/worktrees/docs-some-branch",
    });
  });

  test("missing absolute previewCommand leaves the repo unbootable", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget", previewCommand: "/nonexistent/bring-up.sh" },
      existsIn([PREVIEW_COMMAND]),
    );
    expect(boot).toBeNull();
  });

  test(".backstage/ (pre-rename) still resolves, .opensession/ wins when both exist", async () => {
    const legacy = await resolvePreviewBoot(
      WT,
      { id: "widget" },
      existsIn([`${WT}/.backstage/start.sh`, `${WT}/.backstage/setup.sh`]),
    );
    expect(legacy?.cmd).toBe(`bash ${WT}/.backstage/start.sh`);
    expect(legacy?.setupScript).toBe(`${WT}/.backstage/setup.sh`);

    const both = await resolvePreviewBoot(
      WT,
      { id: "widget" },
      // Only .backstage/ carries a setup.sh — the sibling must come from the
      // SAME dir as the resolved start.sh, so it stays undefined here.
      existsIn([
        `${WT}/.opensession/start.sh`,
        `${WT}/.backstage/start.sh`,
        `${WT}/.backstage/setup.sh`,
      ]),
    );
    expect(both?.cmd).toBe(`bash ${WT}/.opensession/start.sh`);
    expect(both?.setupScript).toBeUndefined();
  });

  test("no mechanism at all resolves to null (UI: disabled Start)", async () => {
    const boot = await resolvePreviewBoot(WT, { id: "widget" }, existsIn([]));
    expect(boot).toBeNull();
  });
});

// repoLifecycle reads a real checkout (Settings → Setup asks "can sessions in
// this repo boot themselves?"), so these drive it against temp trees.
describe("repoLifecycle", () => {
  function repoWith(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "");
    }
    return root;
  }

  test("reports each committed lifecycle file", () => {
    expect(
      repoLifecycle(
        repoWith([
          ".opensession/setup.sh",
          ".opensession/start.sh",
          ".opensession/preview.json",
        ]),
      ),
    ).toEqual({
      dir: ".opensession",
      setup: true,
      start: true,
      previewJson: true,
    });
  });

  test("a repo with no lifecycle dir reports nothing", () => {
    expect(repoLifecycle(repoWith(["package.json"]))).toEqual({
      dir: null,
      setup: false,
      start: false,
      previewJson: false,
    });
  });

  test("the winning dir is exclusive — .backstage/ never fills gaps in .opensession/", () => {
    // Same rule as resolvePreviewBoot: mixing dirs would pair files that
    // never shipped together.
    expect(
      repoLifecycle(repoWith([".opensession/start.sh", ".backstage/setup.sh"])),
    ).toEqual({
      dir: ".opensession",
      setup: false,
      start: true,
      previewJson: false,
    });
  });

  test("falls back to the pre-rename .backstage/ dir", () => {
    expect(repoLifecycle(repoWith([".backstage/start.sh"]))).toMatchObject({
      dir: ".backstage",
      start: true,
      setup: false,
    });
  });
});
