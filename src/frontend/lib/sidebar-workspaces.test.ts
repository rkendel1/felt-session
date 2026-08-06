import { describe, expect, test } from "bun:test";
import { isScratchWorkspace } from "./sidebar-workspaces";

describe("isScratchWorkspace", () => {
	test("recognizes a workspace containing scratch sessions", () => {
		expect(isScratchWorkspace([{ mode: "scratch" }, { mode: "scratch" }])).toBe(
			true,
		);
	});

	test("does not treat repo-backed or empty workspaces as scratch", () => {
		expect(isScratchWorkspace([{ mode: "scratch" }, { mode: "code" }])).toBe(
			false,
		);
		expect(isScratchWorkspace([])).toBe(false);
	});
});
