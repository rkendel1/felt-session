import { expect, test } from "bun:test";

test("the desktop app chooses and imports local repositories natively", async () => {
	const source = await Bun.file(new URL("./AddRepoDialog.tsx", import.meta.url)).text();

	expect(source).toContain("nativeLocal.importLocal()");
	expect(source).toContain('registerRepoApi({ path: imported.path })');
	expect(source).toContain("Choose folder…");
	expect(source).toContain("imports a lightweight managed clone");
});
