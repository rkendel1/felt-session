import type { UnifiedSession } from "./types";

export type SessionPrRef = NonNullable<UnifiedSession["prs"]>[number];

/** Bare attached branches are targets, not PRs; every explicit PR still counts. */
function pullRequests(session: UnifiedSession) {
	return (session.prs || []).filter(
		(ref) =>
			ref.source !== "attached" ||
			ref.number != null ||
			ref.url != null ||
			ref.state != null,
	);
}

/**
 * Pick the PR that owns the normal single-PR surface. A branch-derived PR is
 * always primary; when there is no such PR, a sole linked/discovered PR fills
 * that role instead of rendering as a one-item multi-PR stack.
 */
export function sessionPrPresentation(prs?: SessionPrRef[]): {
	primary?: SessionPrRef;
	additional: SessionPrRef[];
} {
	const actual = (prs || []).filter((ref) => ref.number != null);
	const primary = actual.find((ref) => ref.source === "primary");
	if (primary)
		return {
			primary,
			additional: actual.filter((ref) => ref !== primary),
		};
	if (actual.length === 1) return { primary: actual[0], additional: [] };
	return { additional: actual };
}

/** A multi-PR session has landed once every actual PR is terminal and one merged. */
export function sessionPrMerged(session: UnifiedSession): boolean {
	const refs = pullRequests(session);
	if (refs.length > 0)
		return (
			refs.every((ref) => ref.state === "MERGED" || ref.state === "CLOSED") &&
			refs.some((ref) => ref.state === "MERGED")
		);
	return session.prState === "MERGED";
}

/** A multi-PR session is reviewed once no actual PR is still awaiting review. */
export function sessionPrApproved(session: UnifiedSession): boolean {
	const refs = pullRequests(session);
	if (refs.length > 0)
		return refs.every(
			(ref) =>
				ref.state === "MERGED" ||
				ref.state === "CLOSED" ||
				ref.reviewDecision === "APPROVED",
		);
	return session.prReviewDecision === "APPROVED";
}
