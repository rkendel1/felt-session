/**
 * Review requests for sessions of ALL sources: "please look at this" pointed at
 * a specific teammate, set from the session info panel's Reviewer picker. The
 * flagged session surfaces in a "Needs review" band at the top of the chosen
 * reviewer's sidebar (plus a push/alert), until the request is cleared.
 *
 * Same shape as the archive / title / status-override registries: a
 * FeltDB collection keyed by unified session id, applied over every
 * session in getAllSessions. Slack/Linear session files are read-only for
 * opensession, so the request can't live in the session file.
 */
import { ManagedValueRegistry } from "./managed-value-registry";
import type { StateFirstDB } from "@feltdb/core";

export interface ReviewRequest {
	/** Reviewer's display name (the `backstage-user` value, e.g. "Kent"). */
	to: string;
	/** Individual sidebar identities covered by a configured review team. */
	recipients?: string[];
	/** Who asked for the review. */
	by: string;
	/** ISO timestamp of the request. */
	at: string;
	/** Set once the reviewer signs off. The request stays in place (so the asker
	 * still sees who reviewed it) but flips to an accepted/green state and moves
	 * into the sidebar's "Reviewed" band. Cleared on reopen or a re-assign. */
	accepted?: { by: string; at: string };
}

const registry = new ManagedValueRegistry<ReviewRequest>("opensession_review_requests");
export function initializeManagedReviewRequests(db?: StateFirstDB): Promise<void> {
	return registry.initialize(db);
}

export function getReviewRequest(id: string): ReviewRequest | undefined {
	return registry.get(id);
}

/** Set (a reviewer) or clear (null) the review request for a session id. */
export async function setReviewRequest(id: string, req: ReviewRequest | null): Promise<void> {
	await registry.set(id, req || undefined);
}

/** Mark the current request accepted (reviewer signed off) or reopen it (null),
 * preserving the original `to`/`by`/`at`. No-op if there's no request for `id`. */
export async function setReviewAccepted(
	id: string,
	accepted: { by: string; at: string } | null,
): Promise<void> {
	const existing = registry.get(id);
	if (!existing) return;
	const next: ReviewRequest = { ...existing };
	if (accepted) next.accepted = accepted;
	else delete next.accepted;
	await registry.set(id, next);
}
