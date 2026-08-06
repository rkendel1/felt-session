/**
 * The PR glyph's color language, shared by every surface that paints a pull
 * request's state: purple = merged, faint = closed or draft, red = blocked
 * (conflict / failing checks / changes requested), yellow = checks running,
 * green = open and healthy.
 *
 * Callers normalize their own row shape into `PrStatusInput` — the sidebar's
 * `WsPrStatusMark` still carries its own copy for session-shaped input, since it
 * additionally paints "no PR" rows.
 */
export interface PrStatusInput {
	state?: "OPEN" | "MERGED" | "CLOSED" | null;
	isDraft?: boolean | null;
	/** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "" */
	reviewDecision?: string | null;
	/** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
	mergeable?: string | null;
	checks?: { failed?: number; pending?: number } | null;
}

export function prStatusMark(pr: PrStatusInput): {
	className: string;
	label: string;
} {
	if (pr.state === "MERGED") return { className: "text-purple", label: "PR merged" };
	if (pr.state === "CLOSED") return { className: "text-faint", label: "PR closed" };

	const conflicting = pr.mergeable === "CONFLICTING";
	const failed = (pr.checks?.failed || 0) > 0;
	const pending = (pr.checks?.pending || 0) > 0;
	const decision = (pr.reviewDecision || "").toUpperCase();
	const changesRequested = decision === "CHANGES_REQUESTED";

	if (conflicting) return { className: "text-red", label: "PR has conflicts" };
	if (changesRequested) return { className: "text-red", label: "PR changes requested" };
	if (failed) return { className: "text-red", label: "PR checks failing" };
	if (pending) return { className: "text-yellow", label: "PR checks running" };
	if (pr.isDraft) return { className: "text-faint", label: "Draft PR" };
	if (decision === "APPROVED") return { className: "text-green", label: "PR approved" };
	return { className: "text-green", label: "PR open" };
}
