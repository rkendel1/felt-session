import type { UnifiedSession } from "./types";
import type { OpenPr } from "./api";
import { GITHUB_BOT_LOGINS } from "./brand";

export type ReviewBucket = "ready" | "attention" | "waiting";
export type ReviewSource = "mine" | "requested" | "automation" | "other";

export type ReviewQueuePr = OpenPr & {
	mergeable?: string;
};

export interface ReviewQueueItem {
	pr: ReviewQueuePr;
	sessionId: string | null;
	source: ReviewSource;
	bucket: ReviewBucket;
	status: string;
}

export function reviewRowMatchesPersonFilter(
	owner: string,
	requests: Array<UnifiedSession["reviewRequest"]>,
	person: string,
	currentUser: string,
): boolean {
	if (person === "unassigned") return false;
	if (person === "everyone") return true;
	if (person !== "me") return owner === person;

	const me = currentUser.toLowerCase();
	return (
		owner === me ||
		requests.some(
			(request) =>
				request?.to.toLowerCase() === me || request?.by.toLowerCase() === me,
		)
	);
}

export function prReviewCompletion(
	request: NonNullable<UnifiedSession["reviewRequest"]>,
	session: UnifiedSession,
): { by: string; at: string } | null {
	if (request.accepted || !session.prUpdatedAt) return null;
	const reviewer = request.to.trim().toLowerCase();
	const reviewedAt = Date.parse(session.prUpdatedAt);
	const requestedAt = Date.parse(request.at);
	if (!reviewer || !Number.isFinite(reviewedAt) || reviewedAt <= requestedAt)
		return null;
	const hasReviewer = (people?: string[]) =>
		(people || []).some((person) => person.toLowerCase() === reviewer);
	if (!hasReviewer(session.prReviewedBy) || hasReviewer(session.prReviewRequested))
		return null;
	return { by: request.to, at: session.prUpdatedAt };
}

function sessionRepo(session: UnifiedSession): string {
	return session.repo || "repository";
}

function sessionMatchesPr(
	session: UnifiedSession,
	pr: ReviewQueuePr,
	primaryOnly = false,
): boolean {
	if (sessionRepo(session) === pr.repo && session.branch === pr.branch) return true;
	// A `github-pr-review` session checks the PR out on a derived `<head>-os-review`
	// branch, so its own branch never equals the PR's head and the comparison
	// above can't see it. The server resolves the real head (sessionPrBranch) and
	// records it as this session's `primary` PR ref — so that ref, and only that
	// ref, still counts as owning the PR's branch. Attached/linked/discovered
	// refs stay secondary and fall through to the check below.
	if (
		(session.prs || []).some(
			(ref) =>
				ref.source === "primary" &&
				ref.repo === pr.repo &&
				ref.branch === pr.branch,
		)
	)
		return true;
	if (primaryOnly) return false;
	return (
		(session.prs || []).some(
			(ref) => ref.repo === pr.repo && ref.branch === pr.branch,
		) ||
		(session.attachedRepos || []).some(
			(ref) => ref.repo === pr.repo && ref.branch === pr.branch,
		) ||
		(session.linkedPrs || []).some(
			(ref) => ref.repo === pr.repo && ref.branch === pr.branch,
		)
	);
}

function newest(sessions: UnifiedSession[]): UnifiedSession | null {
	return (
		[...sessions].sort((a, b) =>
			(b.lastActivity || "").localeCompare(a.lastActivity || ""),
		)[0] || null
	);
}

function classify(
	pr: ReviewQueuePr,
	source: ReviewSource,
): Pick<ReviewQueueItem, "bucket" | "status"> {
	const checks = pr.checks;
	const decision = (pr.reviewDecision || "").toUpperCase();
	const conflicting = pr.mergeable === "CONFLICTING";
	// No reported checks means no known CI blocker. This matches the merge action
	// elsewhere in the sidebar and avoids parking PRs outside the rollup window.
	const green = checks.failed === 0 && checks.pending === 0;

	if (pr.isDraft) return { bucket: "waiting", status: "Draft" };
	if (conflicting)
		return { bucket: "attention", status: "Merge conflict" };
	if (checks.failed > 0)
		return {
			bucket: "attention",
			status: `${checks.failed} failing`,
		};
	if (decision === "CHANGES_REQUESTED")
		return { bucket: "attention", status: "Changes requested" };
	if (pr.reviewActive)
		return { bucket: "waiting", status: "Review running" };
	if (source === "requested")
		return { bucket: "attention", status: "Review requested" };
	if (source === "automation" && decision !== "APPROVED") {
		return green
			? { bucket: "attention", status: "Review needed" }
			: checks.pending > 0
				? { bucket: "waiting", status: `${checks.pending} running` }
				: { bucket: "waiting", status: "Checks unknown" };
	}
	if (green && (source === "mine" || decision === "APPROVED")) {
		return {
			bucket: "ready",
			status: decision === "APPROVED" ? "Approved" : "Green",
		};
	}
	if (checks.pending > 0)
		return { bucket: "waiting", status: `${checks.pending} running` };
	if (checks.total === 0)
		return { bucket: "waiting", status: "Checks unknown" };
	return { bucket: "waiting", status: "Awaiting review" };
}

/**
 * The person key a display name maps to ("Kent de Bruin" → "kent") — the same
 * normalization the server applies when it turns GitHub logins into the person
 * keys carried by `prReviewRequested` / `prReviewedBy`.
 */
export function personKey(name: string): string {
	return name.trim().split(/\s+/)[0]?.toLowerCase() || "";
}

/**
 * Build one actionable row per open PR. Source is about why the PR belongs in
 * this person's inbox; bucket is about what they can do with it right now.
 */
export function buildReviewQueue(
	prs: ReviewQueuePr[],
	sessions: UnifiedSession[],
	currentUser: string,
	githubLogin: string | null,
): ReviewQueueItem[] {
	const me = personKey(currentUser);
	const github = githubLogin?.toLowerCase() || "";
	const seen = new Set<string>();
	const items: ReviewQueueItem[] = [];

	for (const pr of prs) {
		if (!pr.url || seen.has(pr.url)) continue;
		seen.add(pr.url);

		const related = sessions.filter((session) => sessionMatchesPr(session, pr));
		const primary = related.filter(
			(session) =>
				!session.archived && sessionMatchesPr(session, pr, true),
		);
		const author = pr.author.toLowerCase();
		const automation =
			GITHUB_BOT_LOGINS.has(author) ||
			author.endsWith("-bot") ||
			author.endsWith("[bot]");
		const requested = (pr.reviewRequested || []).some(
			(person) => person.toLowerCase() === me,
		);
		const mine =
			!automation &&
			!!github &&
			pr.author.toLowerCase() === github;
		const source: ReviewSource = requested
			? "requested"
			: automation
				? "automation"
				: mine
					? "mine"
					: "other";
		const state = classify(pr, source);

		items.push({
			pr,
			sessionId: newest(primary)?.id || null,
			source,
			...state,
		});
	}

	return items.sort((a, b) =>
		(b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""),
	);
}
