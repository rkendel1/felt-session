import { describe, expect, test } from "bun:test";

import { DESKTOP_MQ, PHONE_MQ, PHONE_QUERY } from "./breakpoints";

/** The number inside `(max-width: 720px)`, whatever it has been moved to. */
const boundary = Number(PHONE_QUERY.match(/(\d+)px/)?.[1]);

describe("the phone breakpoint is one boundary", () => {
	test("matchMedia and StyleX use the same inclusive phone query", () => {
		expect(PHONE_QUERY).toMatch(/^\(max-width: \d+px\)$/);
		expect(boundary).toBeGreaterThan(0);
		expect(PHONE_MQ).toBe(`@media ${PHONE_QUERY}`);
	});

	test("desktop is the exact complement, so no width wears neither value", () => {
		expect(String(DESKTOP_MQ)).toBe(`@media (min-width: ${boundary + 1}px)`);
	});

	test("base.css's global phone blocks agree with StyleX", async () => {
		const css = await Bun.file(new URL("../styles/base.css", import.meta.url)).text();
		const widths = [...css.matchAll(/@media[^{]*\(max-width:\s*(\d+)px\)/g)].map(
			(match) => Number(match[1]),
		);
		expect(widths.length).toBeGreaterThan(0);
		expect([...new Set(widths)]).toEqual([boundary]);
	});
});
