import { describe, expect, test, beforeEach } from "bun:test";
import {
	PROMPT_RECEIPT_MAX,
	clearPromptReceipts,
	promptReceipt,
	promptReceiptKey,
	rememberPromptReceipt,
} from "./prompt-receipts";

describe("prompt receipts", () => {
	beforeEach(() => clearPromptReceipts());

	test("a replayed client id returns the recorded answer", () => {
		const key = promptReceiptKey("os-1", "abc");
		expect(promptReceipt(key)).toBeUndefined();
		rememberPromptReceipt(key, { status: "queued", message: "Queued." });
		expect(promptReceipt(key)?.body).toEqual({
			status: "queued",
			message: "Queued.",
		});
	});

	test("ids are scoped per session — the same id in another session is new", () => {
		rememberPromptReceipt(promptReceiptKey("os-1", "abc"), { status: "started" });
		expect(promptReceipt(promptReceiptKey("os-2", "abc"))).toBeUndefined();
	});

	test("an expired receipt is forgotten, so a much later retry delivers", () => {
		const key = promptReceiptKey("os-1", "abc");
		rememberPromptReceipt(key, { status: "started" });
		// Backdate past the TTL rather than waiting an hour.
		const hit = promptReceipt(key)!;
		hit.at = Date.now() - 2 * 60 * 60 * 1000;
		expect(promptReceipt(key)).toBeUndefined();
	});

	test("the window is bounded, dropping the oldest ids first", () => {
		for (let i = 0; i < PROMPT_RECEIPT_MAX + 10; i++) {
			rememberPromptReceipt(promptReceiptKey("os-1", `id-${i}`), { status: "started" });
		}
		expect(promptReceipt(promptReceiptKey("os-1", "id-0"))).toBeUndefined();
		expect(
			promptReceipt(promptReceiptKey("os-1", `id-${PROMPT_RECEIPT_MAX + 9}`)),
		).toBeDefined();
	});
});
