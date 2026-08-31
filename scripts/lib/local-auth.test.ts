import { describe, expect, test } from "bun:test";
import { selectManagedWebSessionToken } from "./local-auth";

const now = 1_800_000_000_000;

describe("selectManagedWebSessionToken", () => {
	test("selects the newest matching human session", () => {
		const sessions = [
			{ token: "old", login: "randy", name: "Randy", lastSeenAt: now - 2_000 },
			{ token: "new", login: "randy", name: "Randy", lastSeenAt: now - 1_000 },
			{ token: "other", login: "other", name: "Other", lastSeenAt: now },
		];
		expect(selectManagedWebSessionToken(sessions, { login: "randy" }, now)).toBe("new");
	});

	test("automation lookup never borrows a human session", () => {
		const sessions = [
			{ token: "human", login: "randy", name: "Randy", lastSeenAt: now },
			{ token: "machine", login: "automation", name: "Automation", lastSeenAt: now - 1, kind: "automation" as const },
		];
		expect(selectManagedWebSessionToken(sessions, { automation: true }, now)).toBe("machine");
	});

	test("rejects expired sessions", () => {
		const expired = now - 91 * 24 * 60 * 60 * 1_000;
		expect(selectManagedWebSessionToken([
			{ token: "expired", login: "randy", name: "Randy", lastSeenAt: expired },
		], { login: "randy" }, now)).toBeNull();
	});
});
