import { afterEach, expect, test } from "bun:test";

const globals = globalThis as Record<string, any>;
if (!globals.window) globals.window = {};
if (typeof globals.window.dispatchEvent !== "function") {
	globals.window.dispatchEvent = () => true;
}
if (typeof globals.Event !== "function") {
	globals.Event = class {
		constructor(public type: string) {}
	};
}
if (!globals.localStorage) {
	globals.localStorage = {
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	};
}

const realFetch = globalThis.fetch;
const { registerRepoApi } = await import("./repos");

afterEach(() => {
	globalThis.fetch = realFetch;
});

test("registers a local repository through the setup route", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	globalThis.fetch = (async (input, init) => {
		request = { url: String(input), init };
		return Response.json({ id: "flow_db", defaultBranch: "main" }, { status: 201 });
	}) as typeof fetch;

	await registerRepoApi({ path: "/Users/randy/.opensession/imports/flow_db" });

	expect(request?.url).toBe("/api/setup/repos");
	expect(request?.init?.method).toBe("POST");
	expect(JSON.parse(String(request?.init?.body))).toEqual({
		source: "local",
		path: "/Users/randy/.opensession/imports/flow_db",
	});
});

test("normalizes a GitHub clone URL for the setup route", async () => {
	let body: unknown;
	globalThis.fetch = (async (_input, init) => {
		body = JSON.parse(String(init?.body));
		return Response.json({ id: "flow_db", defaultBranch: "main" }, { status: 201 });
	}) as typeof fetch;

	await registerRepoApi({ url: "https://github.com/rkendel1/flow_db.git" });

	expect(body).toEqual({ fullName: "rkendel1/flow_db" });
});
