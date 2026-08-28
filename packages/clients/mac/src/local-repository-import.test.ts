import { expect, test } from "bun:test";

test("the shell imports a user-picked Git root into managed storage", async () => {
	const main = await Bun.file(new URL("./main.js", import.meta.url)).text();
	const preload = await Bun.file(new URL("./preload.js", import.meta.url)).text();

	expect(main).toContain('properties: ["openDirectory"]');
	expect(main).toContain('path.join(app.getPath("home"), ".opensession", "imports")');
	expect(main).toContain('gitOutput(["clone", "--local", "--", source, destination])');
	expect(main).toContain('remote", "set-url", "origin", origin');
	expect(main).toContain('root !== source');
	expect(main).toContain('ipcMain.handle("os1:local-repository-import"');
	expect(preload).toContain('importLocal: () => ipcRenderer.invoke("os1:local-repository-import")');
});
