import { beforeEach, describe, expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { initializeManagedUserStores, NAME_KEYED_STORES, renameUserState } from "./shared/user-store";
import { getPins, setPins } from "./pins";
import { getLanes, setLanes } from "./lanes";
import {
	getPersonalOutputStyle,
	personalOutputStyleNoteFor,
	setPersonalOutputStyle,
} from "./personal-output-style";
import { getPersonalPrompt, setPersonalPrompt } from "./personal-prompts";

describe("per-user FeltDB stores", () => {
	beforeEach(async () => {
		await initializeManagedUserStores(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
	});

	test("round-trips one user's state", async () => {
		await setPins("Kent", ["os-1", "os-2"]);
		expect(getPins("Kent")).toEqual(["os-1", "os-2"]);
		expect(getPins("Michiel")).toEqual([]);
	});

	test("lossy key characters cannot merge two users", async () => {
		await setPins("a/b", ["os-1"]);
		await setPins("a_b", ["os-2"]);
		expect(getPins("a/b")).toEqual(["os-1"]);
		expect(getPins("a_b")).toEqual(["os-2"]);
	});

	test("personal output styles are identity-keyed and fail closed", async () => {
		expect(getPersonalOutputStyle("Kentaro")).toBe("default");
		expect(await setPersonalOutputStyle("Kentaro", "concise")).toBe("concise");
		expect(getPersonalOutputStyle("kentaro")).toBe("concise");
		expect(personalOutputStyleNoteFor("Kentaro")).toContain(
			"Lead with the result",
		);
		expect(await setPersonalOutputStyle("Kentaro", "unknown")).toBe("default");
		expect(personalOutputStyleNoteFor("Kentaro")).toBe("");
	});

	test("a nameless user stores nothing", async () => {
		expect(await setPersonalPrompt("", "ignored")).toBe("");
		expect(getPersonalPrompt("")).toBe("");
		expect(await setPersonalOutputStyle("", "concise")).toBe("default");
		expect(getPersonalOutputStyle("")).toBe("default");
	});

	test("a missing store reads as empty", () => {
		expect(getPins("Nobody")).toEqual([]);
		expect(getLanes("Nobody")).toEqual({});
		expect(getPersonalPrompt("Nobody")).toBe("");
	});
});

// Renaming yourself on Settings > Personal > Account changes the display name
// these stores file people under, so the state has to travel with the person.
describe("renameUserState", () => {
	beforeEach(async () => {
		await initializeManagedUserStores(createFeltDB({ namespace: crypto.randomUUID(), memory: true }));
	});

	test("carries a renamed person's state to the new name", async () => {
		await setPins("Kent", ["os-1"]);
		await setLanes("Kent", { "os-1": "review" });
		const carried = await renameUserState("Kent", "Kentaro");
		expect(carried).toContain("pins");
		expect(carried).toContain("lanes");
		expect(getPins("Kentaro")).toEqual(["os-1"]);
		expect(getLanes("Kentaro")).toEqual({ "os-1": "review" });
	});

	// A copy, not a move: the old FeltDB record remains if the rename was wrong.
	test("leaves the old name's state in place", async () => {
		await setPins("Kent", ["os-1"]);
		await renameUserState("Kent", "Kentaro");
		expect(getPins("Kent")).toEqual(["os-1"]);
	});

	test("never overwrites state the new name already has", async () => {
		await setPins("Kent", ["os-old"]);
		await setPins("Kentaro", ["os-existing"]);
		expect(await renameUserState("Kent", "Kentaro")).not.toContain("pins");
		expect(getPins("Kentaro")).toEqual(["os-existing"]);
	});

	// canonicalName hashes the lowercased name but keeps the original case in
	// the key, so a capitalization fix still has to carry.
	test("carries a capitalization fix", async () => {
		await setPins("kent", ["os-1"]);
		expect(await renameUserState("kent", "Kent")).toContain("pins");
		expect(getPins("Kent")).toEqual(["os-1"]);
	});

	test("renaming to the same name does nothing", async () => {
		await setPins("Kent", ["os-1"]);
		expect(await renameUserState("Kent", "Kent ")).toEqual([]);
	});

	// Personal run preferences key on the resolved teammate, so they already
	// follow a person through a rename. Copying one would write a file nothing reads.
	test("skips the stores that key on the person rather than the name", () => {
		expect(NAME_KEYED_STORES).not.toContain("personal-prompts" as never);
		expect(NAME_KEYED_STORES).not.toContain(
			"personal-output-styles" as never,
		);
	});

	// The list is hand-maintained, so check it against the real call sites: a
	// store added without a line here would orphan silently on every rename.
	test("covers every name-keyed store in the codebase", async () => {
		const { Glob } = await import("bun");
		const declared = new Set<string>(NAME_KEYED_STORES);
		// Personal run preferences key on the resolved person rather than the
		// display name, so a rename already carries them. Profiles are external.
		declared.add("personal-prompts");
		declared.add("personal-output-styles");
		declared.add("profiles");
		const missing: string[] = [];
		for await (const file of new Glob("src/server/**/*.ts").scan(".")) {
			const source = await Bun.file(file).text();
			if (!source.includes("userStore<")) continue;
			for (const m of source.matchAll(/name:\s*"([a-z-]+)"/g)) {
				if (!declared.has(m[1])) missing.push(`${m[1]} (${file})`);
			}
		}
		expect(missing).toEqual([]);
	});
});
