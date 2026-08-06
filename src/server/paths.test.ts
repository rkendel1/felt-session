import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { __setSessionsDirForTest, resolveLegacySessionsPath } from "./paths";

/**
 * The store has been ~/.backstage-chats, then ~/.opensession-chats, and is now
 * ~/.opensession-sessions. Absolute paths under it were persisted verbatim
 * (walkthrough stills, staged uploads, media links already spliced into PR
 * bodies), so a rename orphans records that are otherwise perfectly intact.
 */
describe("resolveLegacySessionsPath", () => {
  let home = "";
  let sessions = "";
  let prevHome: string | undefined;
  let prevSessionsDir = "";

  beforeAll(() => {
    home = mkdtempSync(`${tmpdir()}/os-paths-`);
    sessions = `${home}/.opensession-sessions`;
    mkdirSync(`${sessions}/uploads/walkthrough/os-1`, { recursive: true });
    writeFileSync(`${sessions}/uploads/walkthrough/os-1/after.png`, "png");
    prevHome = process.env.HOME;
    process.env.HOME = home;
    prevSessionsDir = __setSessionsDirForTest(sessions);
  });

  afterAll(() => {
    __setSessionsDirForTest(prevSessionsDir);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("remaps a path under a former store name onto the active store", () => {
    const stored = `${home}/.opensession-chats/uploads/walkthrough/os-1/after.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(
      `${sessions}/uploads/walkthrough/os-1/after.png`,
    );
  });

  it("remaps the older backstage name too", () => {
    const stored = `${home}/.backstage-chats/uploads/walkthrough/os-1/after.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(
      `${sessions}/uploads/walkthrough/os-1/after.png`,
    );
  });

  it("leaves a legacy path alone when the file isn't in the active store", () => {
    const stored = `${home}/.opensession-chats/uploads/walkthrough/os-1/gone.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(stored);
  });

  it("prefers a legacy dir that still has the file itself", () => {
    mkdirSync(`${home}/.opensession-chats/uploads/walkthrough/os-1`, {
      recursive: true,
    });
    const stored = `${home}/.opensession-chats/uploads/walkthrough/os-1/live.png`;
    writeFileSync(stored, "png");
    writeFileSync(`${sessions}/uploads/walkthrough/os-1/live.png`, "other");
    expect(resolveLegacySessionsPath(stored)).toBe(stored);
  });

  it("passes through paths that are not under the store", () => {
    expect(resolveLegacySessionsPath("/tmp/demo.mp4")).toBe("/tmp/demo.mp4");
    expect(resolveLegacySessionsPath(`${sessions}/uploads/a.png`)).toBe(
      `${sessions}/uploads/a.png`,
    );
    expect(resolveLegacySessionsPath("")).toBe("");
  });

  it("keeps traversal segments in the path for the caller to reject", () => {
    const stored = `${home}/.opensession-chats/uploads/../../etc/passwd`;
    expect(resolveLegacySessionsPath(stored)).toContain("..");
  });
});
