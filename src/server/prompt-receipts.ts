/**
 * Delivery receipts for REST prompt sends (`POST /api/sessions/:id/prompt`).
 *
 * The native clients hold unsent messages in a local outbox and retry until
 * the server acknowledges — which means a reply lost on the way back (request
 * timeout, wifi flap after the server already delivered) would otherwise post
 * the same message twice. Each send carries a client-minted `clientId`: the
 * first delivery records its result here and every replay returns that same
 * result instead of delivering again.
 *
 * Errors are deliberately NOT recorded — those are the ones meant to be
 * retried. State is parked on globalThis so a hot reload keeps the window; a
 * full restart drops it, which leaves a small window where a retry that
 * straddles the restart can duplicate. That's the accepted residual risk.
 */

export interface PromptReceipt {
	at: number;
	body: Record<string, unknown>;
}

const receipts: Map<string, PromptReceipt> = ((
	globalThis as unknown as { __promptReceipts?: Map<string, PromptReceipt> }
).__promptReceipts ??= new Map());

/** Long enough to cover an outage the outbox waited out, short enough that a
 *  client id can't pin memory forever. */
export const PROMPT_RECEIPT_TTL_MS = 60 * 60 * 1000;
export const PROMPT_RECEIPT_MAX = 500;

export function promptReceiptKey(sessionId: string, clientId: string): string {
	return `${sessionId}:${clientId}`;
}

/** The recorded answer for a client id, or undefined if it's new or expired. */
export function promptReceipt(key: string): PromptReceipt | undefined {
	const hit = receipts.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.at > PROMPT_RECEIPT_TTL_MS) {
		receipts.delete(key);
		return undefined;
	}
	return hit;
}

export function rememberPromptReceipt(
	key: string,
	body: Record<string, unknown>,
): void {
	receipts.set(key, { at: Date.now(), body });
	// Map iterates in insertion order, so the oldest keys drop first.
	const excess = receipts.size - PROMPT_RECEIPT_MAX;
	if (excess > 0) {
		for (const stale of [...receipts.keys()].slice(0, excess))
			receipts.delete(stale);
	}
}

/** Test seam — drops the whole window. */
export function clearPromptReceipts(): void {
	receipts.clear();
}
