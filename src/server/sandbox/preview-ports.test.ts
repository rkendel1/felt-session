import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setSessionsDirForTest } from "../paths";
import {
  SANDBOX_HTTPS_BASE,
  SANDBOX_HTTPS_RANGE,
  lookupSandboxHttpsPort,
  releaseSandboxPreviewPorts,
  sandboxHttpsPortFor,
} from "./preview-ports";

let scratch: string;
let prevDir: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bks-preview-ports-"));
  prevDir = __setSessionsDirForTest(scratch);
});

afterAll(() => {
  __setSessionsDirForTest(prevDir);
  rmSync(scratch, { recursive: true, force: true });
});

describe("sandbox preview https-port allocator", () => {
  test("allocates inside the sandbox range, disjoint from the host scheme", () => {
    const p = sandboxHttpsPortFor("bks-sbx-a", 3300);
    expect(p).toBeGreaterThanOrEqual(SANDBOX_HTTPS_BASE);
    expect(p).toBeLessThan(SANDBOX_HTTPS_BASE + SANDBOX_HTTPS_RANGE);
    // The host scheme (webappPort + 6000) tops out at 9999 — structurally
    // below the sandbox range, so a host preview can never compute p.
    expect(p).toBeGreaterThan(3999 + 6000);
  });

  test("stable per (sandboxId, containerPort), persisted across reads", () => {
    const p1 = sandboxHttpsPortFor("bks-sbx-a", 3300);
    const p2 = sandboxHttpsPortFor("bks-sbx-a", 3300);
    expect(p2).toBe(p1);
    expect(lookupSandboxHttpsPort("bks-sbx-a", 3300)).toBe(p1);
  });

  test("two sandboxes with the SAME container port never collide", () => {
    const a = sandboxHttpsPortFor("bks-sbx-a", 3300);
    const b = sandboxHttpsPortFor("bks-sbx-b", 3300);
    expect(b).not.toBe(a);
  });

  test("probing walks past occupied slots (forced hash collision)", () => {
    // Allocate many keys; every allocation must be unique regardless of hash
    // collisions in the deterministic first guess.
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const p = sandboxHttpsPortFor(`bks-sbx-many-${i}`, 3300);
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
  });

  test("lookup never allocates", () => {
    expect(lookupSandboxHttpsPort("bks-sbx-never-started", 3300)).toBeNull();
  });

  test("release drops all of a sandbox's allocations and returns the ports", () => {
    const p1 = sandboxHttpsPortFor("bks-sbx-rel", 3300);
    const p2 = sandboxHttpsPortFor("bks-sbx-rel", 3301);
    const released = releaseSandboxPreviewPorts("bks-sbx-rel").sort();
    expect(released).toEqual([p1, p2].sort());
    expect(lookupSandboxHttpsPort("bks-sbx-rel", 3300)).toBeNull();
    // Other sandboxes' allocations survive.
    expect(lookupSandboxHttpsPort("bks-sbx-a", 3300)).not.toBeNull();
  });
});
