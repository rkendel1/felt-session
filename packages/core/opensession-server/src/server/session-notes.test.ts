import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeltDB } from "@feltdb/core";

// The store's directory is resolved at module load (stateDir), so the scratch
// namespace has to be in place BEFORE session-notes is imported — hence the
// dynamic import below rather than a static one. `bun test` shares one process
// across files, so the env is restored immediately afterwards.
const SCRATCH = mkdtempSync(join(tmpdir(), "session-notes-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const {
	addSessionNote,
	deleteSessionNote,
	editSessionNote,
	initializeManagedSessionNotes,
	isValidNoteSession,
	listSessionNotes,
	sessionNoteActivity,
} = await import("./session-notes");
const notesDb = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
await initializeManagedSessionNotes(notesDb);
const { stageInlineImages } = await import("./uploads");
if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = saved;

describe("session notes", () => {
	test("appends and lists in order, per session", async () => {
		await addSessionNote("os-a", "Kent", "first");
		await addSessionNote("os-a", "Michiel", "second");
		await addSessionNote("os-b", "Kent", "elsewhere");
		await initializeManagedSessionNotes(notesDb);
		expect(listSessionNotes("os-a").map((n) => n.text)).toEqual([
			"first",
			"second",
		]);
		expect(listSessionNotes("os-b").map((n) => n.text)).toEqual(["elsewhere"]);
		expect(listSessionNotes("os-never-written")).toEqual([]);
	});

	test("an empty note is not stored", async () => {
		expect(await addSessionNote("os-empty", "Kent", "   ")).toBeNull();
		expect(listSessionNotes("os-empty")).toEqual([]);
	});

	test("stores images with text and allows image-only notes", async () => {
		const image = "/media?path=%2Ftmp%2Fnote.png";
		const withText = await addSessionNote("os-images", "Kent", "look", [image]);
		const imageOnly = await addSessionNote("os-images", "Kent", "", [image]);
		expect(withText?.images).toEqual([image]);
		expect(imageOnly?.text).toBe("");
		expect(imageOnly?.images).toEqual([image]);
	});

	test("stages inline image bytes outside the note store and removes them with the note", async () => {
		const urls = stageInlineImages(
			"os-staged-image",
			["data:image/png;base64,iVBORw0KGgo="],
			"session-notes",
		);
		const path = new URL(urls[0]!, "http://local").searchParams.get("path")!;
		expect(existsSync(path)).toBe(true);
		const note = (await addSessionNote("os-staged-image", "Kent", "", urls))!;
		expect(note.images?.[0]).toStartWith("/media?path=");
		expect((await deleteSessionNote("os-staged-image", note.id, "Kent")).ok).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	test("rejects unsupported and excessive inline images", () => {
		expect(() =>
			stageInlineImages("os-bad-image", ["data:image/svg+xml;base64,PHN2Zz4="]),
		).toThrow("unsupported image type");
		expect(() =>
			stageInlineImages(
				"os-too-many-images",
				Array(7).fill("data:image/png;base64,iVBORw0KGgo="),
			),
		).toThrow("too many images");
	});

	test("activity reports the latest note per session", () => {
		const activity = sessionNoteActivity();
		const a = activity.find((s) => s.sessionId === "os-a");
		expect(a?.lastUser).toBe("Michiel");
		expect(a?.lastTs).toBeGreaterThan(0);
	});

	test("only path-safe session ids are accepted", () => {
		expect(isValidNoteSession("os-019ff497-a325-7000")).toBe(true);
		expect(isValidNoteSession("../../etc/passwd")).toBe(false);
		expect(isValidNoteSession("os a")).toBe(false);
		expect(isValidNoteSession("")).toBe(false);
		expect(isValidNoteSession(42)).toBe(false);
	});

	test("only the author can edit a note", async () => {
		const note = (await addSessionNote("os-owned", "Kent", "mine"))!;
		expect(await editSessionNote("os-owned", note.id, "changed", "Michiel")).toEqual({
			ok: false,
			reason: "not_author",
		});
		expect(listSessionNotes("os-owned")[0]!.text).toBe("mine");
		// Case and surrounding space don't decide authorship.
		const ok = await editSessionNote("os-owned", note.id, "changed", " kent ");
		expect(ok.ok).toBe(true);
		expect(listSessionNotes("os-owned")[0]!.text).toBe("changed");
		expect(listSessionNotes("os-owned")[0]!.editedAt).toBeGreaterThan(0);
	});

	test("only the author can delete a note", async () => {
		const note = (await addSessionNote("os-del", "Kent", "mine"))!;
		expect(await deleteSessionNote("os-del", note.id, "Michiel")).toEqual({
			ok: false,
			reason: "not_author",
		});
		expect(listSessionNotes("os-del")).toHaveLength(1);
		expect((await deleteSessionNote("os-del", note.id, "Kent")).ok).toBe(true);
		expect(listSessionNotes("os-del")).toEqual([]);
	});

	test("a missing note is not_found, not not_author", async () => {
		expect(await deleteSessionNote("os-del", "nope", "Kent")).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await editSessionNote("os-del", "nope", "x", "Kent")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

});
