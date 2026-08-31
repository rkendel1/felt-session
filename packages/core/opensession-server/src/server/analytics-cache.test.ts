import { expect, test } from "bun:test";
import { createFeltDB } from "@feltdb/core";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeManagedAnalyticsCache } from "./analytics";

test("managed analytics cache removes retired disk cache files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "analytics-cache-legacy-"));
	for (const name of ["gh-prs-repo-2026-01-01.json", "summary-v1.json", "day-2026-01-01.json"])
		writeFileSync(join(dir, name), "{}");
	const unrelated = join(dir, "pi-day-v1-2026-01-01.json");
	writeFileSync(unrelated, "{}");

	const db = createFeltDB({ namespace: crypto.randomUUID(), memory: true });
	await db.transaction((tx) => {
		tx.collection("opensession_analytics_cache").set("recent", {
			id: "recent", at: Date.now(), data: { ok: true },
		});
		tx.collection("opensession_analytics_cache").set("stale", {
			id: "stale", at: Date.now() - 8 * 86_400_000, data: { old: true },
		});
	});
	await initializeManagedAnalyticsCache(db, dir);

	expect(readdir(dir)).toEqual(["pi-day-v1-2026-01-01.json"]);
	expect(existsSync(unrelated)).toBe(true);
	expect((await db.collection<{ id: string }>("opensession_analytics_cache").all()).map((record) => record.id))
		.toEqual(["recent"]);
});

function readdir(dir: string): string[] {
	return Array.from(new Bun.Glob("*.json").scanSync(dir)).sort();
}
