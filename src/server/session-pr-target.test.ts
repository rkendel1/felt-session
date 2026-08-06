import { describe, expect, test } from "bun:test";
import { sessionPrBranch } from "./session-pr-target";
import type { UnifiedSession } from "./types";
import type { Workspace } from "./workspaces";

const session = {
	id: "bks-ghpr-5286-review",
	branch: "add-lottie-primitive-os-review",
	automation: "github-pr-review",
} as UnifiedSession;

const workspace = {
	id: "ws-review",
	name: "#5286 Add Lottie timeline primitive",
	createdBy: "GitHub (automation)",
	createdAt: "2026-07-28T00:00:00.000Z",
	prNumber: 5286,
	branch: "add-lottie-primitive",
} as Workspace;

describe("sessionPrBranch", () => {
	test("uses the PR workspace branch for a GitHub review checkout", () => {
		expect(sessionPrBranch(session, workspace)).toBe("add-lottie-primitive");
	});

	test("does not rewrite ordinary session branches", () => {
		expect(
			sessionPrBranch(
				{ ...session, automation: undefined } as UnifiedSession,
				workspace,
			),
		).toBe("add-lottie-primitive-os-review");
	});

	test("requires a structurally PR-backed workspace", () => {
		expect(
			sessionPrBranch(session, { ...workspace, prNumber: undefined }),
		).toBe("add-lottie-primitive-os-review");
	});

	// An ask-style session shares its workspace's checkout but stores no branch of
	// its own, so without the fallback it showed "Create PR" beside a sibling
	// tab on the same workspace's connected PR.
	test("a branchless session inherits its workspace's branch", () => {
		expect(
			sessionPrBranch(
				{ id: "bks-ask", branch: null } as unknown as UnifiedSession,
				workspace,
			),
		).toBe("add-lottie-primitive");
	});

	test("inherits from a workspace with no PR of its own yet", () => {
		expect(
			sessionPrBranch({ id: "bks-ask" } as UnifiedSession, {
				...workspace,
				prNumber: undefined,
			}),
		).toBe("add-lottie-primitive");
	});

	test("stays branchless when the workspace owns no branch", () => {
		expect(
			sessionPrBranch({ id: "bks-ask" } as UnifiedSession, {
				...workspace,
				branch: undefined,
			}),
		).toBeNull();
	});

	test("an explicit null workspace opts out of inheriting", () => {
		expect(
			sessionPrBranch({ id: "bks-ask" } as UnifiedSession, null),
		).toBeNull();
	});

	// A workspace can hold sessions from several repos; the branch belongs to one.
	test("never inherits a branch from another repo", () => {
		expect(
			sessionPrBranch({ id: "bks-ask", repo: "opensession" } as UnifiedSession, {
				...workspace,
				repo: "tella-fusion",
			}),
		).toBeNull();
	});

	test("inherits when both sides name the same repo", () => {
		expect(
			sessionPrBranch({ id: "bks-ask", repo: "tella-fusion" } as UnifiedSession, {
				...workspace,
				repo: "tella-fusion",
			}),
		).toBe("add-lottie-primitive");
	});
});
