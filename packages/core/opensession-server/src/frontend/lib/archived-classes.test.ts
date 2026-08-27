import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import {
	newStylexCollector,
	stylexCss,
	stylexTransform,
} from "../../server/stylex-build";
import {
	ARCHIVED_PHONE_SEARCH_DOCK,
	ARCHIVED_SWIPE_ACTION,
} from "./archived-classes";

const SOURCE = new URL("./archived-classes.ts", import.meta.url).pathname;
const collector = newStylexCollector();
stylexTransform(SOURCE, readFileSync(SOURCE, "utf8"), collector);
const css = stylexCss(collector);

test("archived phone search stays at the thumb edge", () => {
	expect(css).toContain("position:fixed");
	expect(css).toContain("bottom:0");
	expect(css).toContain("@media (max-width: 720px)");
	expect(css).toContain("display:block");
	expect(css).toContain("safe-area-inset-bottom");
});

test("archived phone rows reveal Restore instead of reserving a button", () => {
	expect(css).toContain("padding-inline:18px");
	expect(css).toContain("padding-block:16px");
	expect(css).toContain("--swipe-action-w:0px");
	expect(css).toContain("display:flex");
	expect(ARCHIVED_SWIPE_ACTION).toContain("data-[open]:opacity-100");
});
