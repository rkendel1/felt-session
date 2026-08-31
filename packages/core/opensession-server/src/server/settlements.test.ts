import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { getSettlements, setSettlements } from "./settlements";
import { createFeltDB } from "@feltdb/core";
import { initializeManagedUserStores } from "./shared/user-store";

const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const root = `/tmp/opensession-settlements-test-${process.pid}`;
process.env.OPENSESSION_STATE_DIR = root;

beforeEach(async () => {
	rmSync(`${root}/.opensession-settlements`, { recursive: true, force: true });
	await initializeManagedUserStores(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
	else process.env.OPENSESSION_STATE_DIR = previousStateDir;
});

describe("per-user settlements", () => {
	test("stores explicit settle and unsettle actions independently per person", async () => {
		const at = "2026-08-20T10:00:00.000Z";
		expect(
			await setSettlements("Michiel", {
				"workspace:one": { state: "settled", at },
				"workspace:two": { state: "active", at },
			}),
		).toEqual({
			"workspace:one": { state: "settled", at },
			"workspace:two": { state: "active", at },
		});
		expect(getSettlements("Kent")).toEqual({});
	});

	test("drops malformed row keys and records", async () => {
		expect(
			await setSettlements("Michiel", {
				"workspace:valid": {
					state: "settled",
					at: "2026-08-20T10:00:00.000Z",
				},
				"workspace:bad-state": {
					state: "archived",
					at: "2026-08-20T10:00:00.000Z",
				},
				"workspace:bad-date": { state: "active", at: "soon" },
				"": { state: "active", at: "2026-08-20T10:00:00.000Z" },
			}),
		).toEqual({
			"workspace:valid": {
				state: "settled",
				at: "2026-08-20T10:00:00.000Z",
			},
		});
	});
});
