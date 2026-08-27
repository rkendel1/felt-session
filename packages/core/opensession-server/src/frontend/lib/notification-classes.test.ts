import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	newStylexCollector,
	stylexCss,
	stylexTransform,
} from "../../server/stylex-build";

const SOURCE = new URL("./notification-classes.ts", import.meta.url).pathname;
const UTILITY_COMPAT = new URL("../styles/utility-compat.stylex.ts", import.meta.url).pathname;
const collector = newStylexCollector();
stylexTransform(SOURCE, readFileSync(SOURCE, "utf8"), collector);
stylexTransform(UTILITY_COMPAT, readFileSync(UTILITY_COMPAT, "utf8"), collector);
const css = stylexCss(collector);
describe("notification lanes", () => {
	test("keeps live status clear of the reading column", () => {
		expect(css).toContain("right:calc(4px * 4)");
		expect(css).toContain("top:calc(var(--desktop-header-h) + 8px)");
		expect(css).toContain("@media (max-width: 720px)");
		expect(css).toContain("inset-inline:0");
		expect(css).toContain("right:0");
		expect(css).toContain("top:calc(var(--header-h) + 8px)");
	});

	test("centres toast receipts above the composer", () => {
		expect(css).toContain("inset-inline:0");
		expect(css).toContain("bottom:124px");
	});

	test("moves ongoing phone status below the header and tab strip", () => {
		expect(css).toContain(
			"top:calc(var(--pane-header-h) + var(--strip-clearance,0px) + 8px)",
		);
		expect(css).toContain("position:fixed");
		expect(css).toContain("bottom:auto");
	});

	test("keeps durable desktop prompts in a separate shelf", () => {
		expect(css).toContain("bottom:calc(4px * 2)");
		expect(css).toContain("left:calc(4px * 2)");
		expect(css).toContain("z-index:9500");
	});
});
