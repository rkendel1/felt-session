import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { newStylexCollector, stylexCss, stylexTransform } from "../../server/stylex-build";
import {
	VIEWER_HEADER_ACTIONS,
	VIEWER_INPUT,
	VIEWER_MESSAGES,
} from "./session-viewer-classes";

const SOURCE = new URL("./session-viewer-classes.ts", import.meta.url).pathname;
const UTILITY_COMPAT = new URL("../styles/utility-compat.stylex.ts", import.meta.url).pathname;
const collector = newStylexCollector();
stylexTransform(SOURCE, readFileSync(SOURCE, "utf8"), collector);
stylexTransform(UTILITY_COMPAT, readFileSync(UTILITY_COMPAT, "utf8"), collector);
const css = stylexCss(collector);

test("the desktop tab strip cannot cover the header actions", () => {
	expect(css).toContain("position:relative");
	expect(css).toContain("z-index:1");
});

test("the focused phone composer is fixed close to the keyboard edge", () => {
	// Do not leave placement to Safari's focus pan: anchor the input to the
	// viewport. Fixed bottom already follows the visible keyboard edge, so adding
	// the measured keyboard height again would lift the composer far above it.
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:fixed");
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:bottom-0");
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:pb-2");
	expect(VIEWER_INPUT).not.toContain("var(--kb-inset");
});

test("the focused phone transcript clears the keyboard and complete composer", async () => {
	expect(VIEWER_MESSAGES).toContain("var(--kb-inset,0px)");
	expect(VIEWER_MESSAGES).toContain("var(--viewer-input-height,64px)");

	const viewer = await Bun.file(
		new URL("../components/SessionViewer.tsx", import.meta.url),
	).text();
	expect(viewer).toContain('"--viewer-input-height"');
	expect(viewer).toContain("new ResizeObserver(measure)");
	expect(viewer).toContain('observe(viewerInput, { box: "border-box" })');
});
