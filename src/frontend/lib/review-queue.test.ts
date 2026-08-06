import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import {
	buildReviewQueue,
	prReviewCompletion,
	reviewRowMatchesPersonFilter,
	type ReviewQueuePr,
} from "./review-queue";

const checks = (passed: number, failed = 0, pending = 0) => ({
	total: passed + failed + pending,
	passed,
	failed,
	pending,
});

function pr(
	patch: Partial<ReviewQueuePr> & Pick<ReviewQueuePr, "number" | "branch">,
): ReviewQueuePr {
	return {
		repo: "tella-fusion",
		url: `https://github.com/tellahq/tella/pull/${patch.number}`,
		title: `PR ${patch.number}`,
		isDraft: false,
		reviewDecision: "",
		author: "happylinks",
		person: "alex",
		createdAt: "2026-07-20T10:00:00Z",
		updatedAt: "2026-07-20T12:00:00Z",
		checks: checks(3),
		reviewRequested: [],
		mergeable: "MERGEABLE",
		...patch,
	};
}

function session(
	patch: Partial<UnifiedSession> & Pick<UnifiedSession, "id" | "branch">,
): UnifiedSession {
	return {
		claudeSessionId: null,
		source: "opensession",
		worktreeDir: "/tmp/worktree",
		startedBy: "Alex",
		title: patch.id,
		lastActivity: "2026-07-20T12:00:00Z",
		createdAt: "2026-07-20T10:00:00Z",
		isRunning: false,
		transcriptPath: null,
		repo: "tella-fusion",
		...patch,
	};
}

describe("reviewRowMatchesPersonFilter", () => {
	const request = { to: "Kent", by: "Louise", at: "2026-07-23T14:10:00Z" };

	test("shows cross-owner review requests in the default Me view", () => {
		expect(
			reviewRowMatchesPersonFilter("louise", [request], "me", "Kent"),
		).toBe(true);
	});

	test("keeps explicit teammate filters owner-scoped", () => {
		expect(
			reviewRowMatchesPersonFilter("louise", [request], "kent", "Kent"),
		).toBe(false);
		expect(
			reviewRowMatchesPersonFilter("louise", [request], "louise", "Kent"),
		).toBe(true);
	});

	test("does not pull unrelated teammates' work into the Me view", () => {
		expect(
			reviewRowMatchesPersonFilter(
				"louise",
				[{ ...request, to: "Alex" }],
				"me",
				"Kent",
			),
		).toBe(false);
	});
});

describe("prReviewCompletion", () => {
	const request = {
		to: "Alex",
		by: "Kent",
		at: "2026-07-23T10:22:13Z",
	};

	test("completes a request when its reviewer submitted a newer review", () => {
		expect(
			prReviewCompletion(
				request,
				session({
					id: "reviewed",
					branch: "please-fix",
					prReviewedBy: ["alex"],
					prReviewRequested: [],
					prUpdatedAt: "2026-07-23T10:23:34Z",
				}),
			),
		).toEqual({ by: "Alex", at: "2026-07-23T10:23:34Z" });
	});

	test("does not reuse an old review or override a pending re-request", () => {
		const reviewed = {
			prReviewedBy: ["alex"],
			prReviewRequested: [],
		};
		expect(
			prReviewCompletion(
				request,
				session({
					id: "old-review",
					branch: "old-review",
					...reviewed,
					prUpdatedAt: "2026-07-23T10:20:00Z",
				}),
			),
		).toBeNull();
		expect(
			prReviewCompletion(
				request,
				session({
					id: "rerequested",
					branch: "rerequested",
					...reviewed,
					prReviewRequested: ["alex"],
					prUpdatedAt: "2026-07-23T10:23:34Z",
				}),
			),
		).toBeNull();
	});
});

describe("buildReviewQueue", () => {
	test("puts a green personal PR in ready", () => {
		const [item] = buildReviewQueue(
			[pr({ number: 1, branch: "mine" })],
			[],
			"Alex",
			"happylinks",
		);
		expect(item.source).toBe("mine");
		expect(item.bucket).toBe("ready");
	});

	test("waits while an automated Open Session review is running", () => {
		const [item] = buildReviewQueue(
			[pr({ number: 14, branch: "under-review", reviewActive: true })],
			[],
			"Alex",
			"happylinks",
		);
		expect(item.bucket).toBe("waiting");
		expect(item.status).toBe("Review running");
	});

	test("keeps an unreviewed automation PR in attention", () => {
		const auto = pr({
			number: 2,
			branch: "automation",
			author: "opensession-bot",
		});
		const [item] = buildReviewQueue(
			[auto],
			[],
			"Alex",
			"happylinks",
		);
		expect(item.source).toBe("automation");
		expect(item.bucket).toBe("attention");
		expect(item.status).toBe("Review needed");
	});

	test("keeps a bot-authored PR opt-in despite a human-owned session", () => {
		const botPr = pr({
			number: 9,
			branch: "human-session",
			author: "opensession-bot",
			person: null,
		});
		const [item] = buildReviewQueue(
			[botPr],
			[session({ id: "human", branch: "human-session", startedBy: "Alex" })],
			"Alex",
			"happylinks",
		);
		expect(item.source).toBe("automation");
		expect(item.bucket).toBe("attention");
	});

	test("direct review requests take precedence over bot authorship", () => {
		const [item] = buildReviewQueue(
			[
				pr({
					number: 10,
					branch: "bot-request",
					author: "tella-butler",
					person: null,
					reviewRequested: ["alex"],
				}),
			],
			[],
			"Alex",
			"happylinks",
		);
		expect(item.source).toBe("requested");
		expect(item.bucket).toBe("attention");
	});

	test("puts direct review requests in attention", () => {
		const [item] = buildReviewQueue(
			[
				pr({
					number: 3,
					branch: "teammate",
					author: "jfrolich",
					person: "jaap",
					reviewRequested: ["alex"],
				}),
			],
			[],
			"Alex",
			"happylinks",
		);
		expect(item.source).toBe("requested");
		expect(item.bucket).toBe("attention");
	});

	test("prioritizes failures and conflicts over readiness", () => {
		const items = buildReviewQueue(
			[
				pr({ number: 4, branch: "failed", checks: checks(2, 1) }),
				pr({ number: 5, branch: "conflict", mergeable: "CONFLICTING" }),
			],
			[],
			"Alex",
			"happylinks",
		);
		expect(items.map((item) => item.bucket)).toEqual([
			"attention",
			"attention",
		]);
	});

	test("waits for running checks but treats no reported checks as unblocked", () => {
		const items = buildReviewQueue(
			[
				pr({ number: 6, branch: "running", checks: checks(2, 0, 1) }),
				pr({ number: 7, branch: "unknown", checks: checks(0) }),
			],
			[],
			"Alex",
			"happylinks",
		);
		expect(items.map((item) => item.bucket)).toEqual(["waiting", "ready"]);
	});

	test("links only a primary-branch session to the detail route", () => {
		const target = pr({ number: 8, branch: "target" });
		const [item] = buildReviewQueue(
			[target],
			[
				session({
					id: "attached-only",
					branch: "another",
					attachedRepos: [
						{ repo: "tella-fusion", branch: "target", dir: "/tmp/target" },
					],
				}),
				session({ id: "primary", branch: "target" }),
			],
			"Alex",
			"happylinks",
		);
		expect(item.sessionId).toBe("primary");
	});

	test("links a review session parked on its derived -os-review branch", () => {
		const target = pr({ number: 15, branch: "add-timeline-range" });
		const [item] = buildReviewQueue(
			[target],
			[
				session({
					id: "bks-ghpr-15-review",
					branch: "add-timeline-range-os-review",
					automation: "github-pr-review",
					prs: [
						{
							repo: "tella-fusion",
							branch: "add-timeline-range",
							source: "primary",
						},
					],
				}),
			],
			"Alex",
			"happylinks",
		);
		expect(item.sessionId).toBe("bks-ghpr-15-review");
	});

	test("keeps a secondary PR ref out of the primary link", () => {
		const target = pr({ number: 16, branch: "linked-elsewhere" });
		const [item] = buildReviewQueue(
			[target],
			[
				session({
					id: "linked-only",
					branch: "something-else",
					prs: [
						{
							repo: "tella-fusion",
							branch: "linked-elsewhere",
							source: "linked",
						},
					],
				}),
			],
			"Alex",
			"happylinks",
		);
		expect(item.sessionId).toBeNull();
	});

	test("does not route an open PR through an archived session", () => {
		const [item] = buildReviewQueue(
			[pr({ number: 11, branch: "archived" })],
			[session({ id: "archived", branch: "archived", archived: true })],
			"Alex",
			"happylinks",
		);
		expect(item.sessionId).toBeNull();
	});

	test("uses the active user's GitHub login and reviewer key", () => {
		const items = buildReviewQueue(
			[
				pr({
					number: 12,
					branch: "kent-authored",
					author: "kentdebruin",
					person: "kent",
				}),
				pr({
					number: 13,
					branch: "kent-requested",
					author: "jfrolich",
					person: "jaap",
					reviewRequested: ["kent"],
				}),
			],
			[],
			"Kent",
			"kentdebruin",
		);
		expect(items.map((item) => item.source).sort()).toEqual([
			"mine",
			"requested",
		]);
	});
});
