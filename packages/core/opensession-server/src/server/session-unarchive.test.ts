import { describe, expect, test } from "bun:test";
import {
	type HumanTurnUnarchiveDeps,
	unarchiveForHumanTurn,
} from "./session-unarchive";

function recorder(registryIds: string[] = []) {
	const archived: Array<[string, boolean]> = [];
	const files: string[] = [];
	const registry = new Set(registryIds);
	let invalidations = 0;
	const deps: HumanTurnUnarchiveDeps = {
		isArchivedId(id) {
			return registry.has(id);
		},
		async setArchived(id, value) {
			archived.push([id, value]);
		},
		async clearSessionFileArchive(id) {
			files.push(id);
			return true;
		},
		invalidateSessionsCache() {
			invalidations++;
		},
	};
	return { archived, files, deps, invalidations: () => invalidations };
}

describe("unarchiveForHumanTurn", () => {
	test("clears every archive identity before accepting a turn", async () => {
		const calls = recorder();
		expect(
			await unarchiveForHumanTurn(
				{
					id: "os-current",
					aliasIds: ["os-old", "os-current"],
					archived: true,
				},
				calls.deps,
			),
		).toBe(true);
		expect(calls.archived).toEqual([
			["os-current", false],
			["os-old", false],
		]);
		expect(calls.files).toEqual(["os-current"]);
		expect(calls.invalidations()).toBe(1);
	});

	test("catches archive registry state newer than the session cache", async () => {
		const calls = recorder(["os-stale"]);
		expect(
			await unarchiveForHumanTurn({ id: "os-stale", archived: false }, calls.deps),
		).toBe(true);
		expect(calls.archived).toEqual([["os-stale", false]]);
		expect(calls.files).toEqual(["os-stale"]);
		expect(calls.invalidations()).toBe(1);
	});

	test("leaves an active session untouched", async () => {
		const calls = recorder();
		expect(
			await unarchiveForHumanTurn({ id: "os-live", archived: false }, calls.deps),
		).toBe(false);
		expect(calls.archived).toEqual([]);
		expect(calls.files).toEqual([]);
		expect(calls.invalidations()).toBe(0);
	});
});
