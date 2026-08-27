import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { newStylexCollector, stylexCss, stylexTransform } from "../../server/stylex-build";
import {
	APP_HEADER_ACTIONS,
	ARCHIVED_SEARCH_HEADER,
	HEADER_TITLE_PILL,
	MOBILE_BACK,
	MOBILE_CONTROL_GLASS,
	MOBILE_SEARCH_BTN,
	MOBILE_TOP_BAR_CONTROL,
	appHeader,
	mobileFilterBtn,
} from "../lib/app-header-classes";
import {
	TAB_STRIP,
	tabClass,
} from "../lib/session-tab-classes";
import { REPORTS_COLUMN_HEADER } from "../lib/reports-classes";
import { infoTopbarClass } from "../lib/session-viewer-classes";

const CSS = new URL("./base.css", import.meta.url);
const HEADER_SOURCE = new URL("../lib/app-header-classes.ts", import.meta.url).pathname;
const headerCollector = newStylexCollector();
stylexTransform(HEADER_SOURCE, readFileSync(HEADER_SOURCE, "utf8"), headerCollector);
const headerCss = stylexCss(headerCollector);
const TAB_SOURCE = new URL("../lib/session-tab-classes.ts", import.meta.url).pathname;
const tabCollector = newStylexCollector();
stylexTransform(TAB_SOURCE, readFileSync(TAB_SOURCE, "utf8"), tabCollector);
const tabCss = stylexCss(tabCollector);

test("floating phone navigation stays pinned while chat chrome collapses", () => {
	const floatingHeader = appHeader({ detail: true, floating: true });

	expect(headerCss).toContain("@media (max-width: 720px)");
	expect(headerCss).toContain("position:fixed");
	expect(floatingHeader).not.toContain("chrome-collapsed");
});

test("phone top-bar actions use neutral ink", () => {
	expect(MOBILE_TOP_BAR_CONTROL).toContain("phone:[&_svg]:size-[26px]");
	expect(MOBILE_BACK).toContain(MOBILE_TOP_BAR_CONTROL);
	expect(MOBILE_BACK).toContain("phone:[&_svg]:size-[34px]");
	for (const control of [MOBILE_BACK, MOBILE_SEARCH_BTN, mobileFilterBtn(true)]) {
		expect(control).not.toContain("phone:text-accent");
	}
	expect(headerCss).toContain("color:var(--text)");
	expect(headerCss).toContain("color:var(--text-dim)");
});

test("phone navigation chrome has no hard divider bars", async () => {
	const css = await Bun.file(CSS).text();

	expect(css).not.toMatch(
		/@media \(display-mode: standalone\)\s*\{\s*\.app\s*\{\s*border-top:/,
	);
	expect(TAB_STRIP).not.toContain("phone:border-b");
	expect(TAB_STRIP).not.toContain("phone:shadow-[");
	expect(tabCss).toContain("background-color:transparent");
	expect(tabCss).toContain("::after{display:none}");
	expect(infoTopbarClass(true)).not.toContain("border-b");
	expect(infoTopbarClass(false)).not.toContain("border-b");
	expect(REPORTS_COLUMN_HEADER).not.toMatch(/(?<!desktop:)border-b/);
});

test("archived search focus collapses the phone header without clipping its shadow", () => {
	expect(ARCHIVED_SEARCH_HEADER).not.toContain("overflow-hidden");
	expect(ARCHIVED_SEARCH_HEADER).toContain("safe-area-inset-top,0px),16px");
	expect(ARCHIVED_SEARCH_HEADER).toContain("+60px");
	expect(ARCHIVED_SEARCH_HEADER).toContain("phone:[body.kb-open_&]:h-0!");
	expect(ARCHIVED_SEARCH_HEADER).toContain("phone:[body.kb-open_&]:opacity-0");
	expect(readFileSync(HEADER_SOURCE, "utf8")).toContain(
		"sharedClassStyles.phoneTransitionHeightPaddingTopOpacityTransform",
	);
	expect(headerCss).toContain("@media (prefers-reduced-motion: reduce)");
	expect(headerCss).toContain("transition-property:none");
});

test("every floating phone header control is made of the same glass", async () => {
	const css = await Bun.file(CSS).text();

	// The prefixed spelling is the whole point on iOS Safari and the installed
	// PWA, which still ship backdrop-filter only under `-webkit-`.
	expect(headerCss).toContain(
		"-webkit-backdrop-filter:var(--mobile-header-control-blur)",
	);
	expect(headerCss).toContain("background-color:var(--mobile-header-control-surface)");
	for (const control of [MOBILE_BACK, HEADER_TITLE_PILL, APP_HEADER_ACTIONS]) {
		// A page-coloured fill is what made these read as paper stickers.
		expect(control).not.toContain("phone:bg-surface");
	}

	const inactiveTab = tabClass({
		active: false,
		waiting: false,
		colored: false,
	});
	const activeTab = tabClass({ active: true, waiting: false, colored: false });
	// Both phone states are blurred pills, and both fills are OPAQUE: the
	// selected tab is the bright plate, the rest the grey a step under it.
	// A thinned fill here let the transcript read through the tab labels.
	expect(inactiveTab).not.toContain("phone:bg-surface");
	expect(activeTab).not.toContain("phone:bg-surface");
	expect(headerCss).toContain("backdrop-filter:var(--mobile-header-control-blur)");
	expect(tabCss).toContain("background-color:var(--mobile-tab-surface)");
	expect(tabCss).toContain("background-color:var(--mobile-tab-surface-selected)");
	expect(css).toContain("--mobile-tab-surface-selected: var(--bg-hover);");
	expect(css).toContain("--mobile-tab-surface-selected: var(--bg);");
	expect(css).toContain("--mobile-tab-surface: var(--bg-raised);");
	expect(css).toContain("--mobile-tab-surface: var(--bg-hover);");
	expect(css).not.toContain("--mobile-tab-surface: color-mix(");

	const floatingHeader = appHeader({ detail: false, floating: true });
	expect(floatingHeader).not.toContain("]:bg-surface");
	expect(floatingHeader).toContain(
		"phone:[.app:has(.session-tabs)_&]:before:h-full",
	);

	// Glass is an enhancement: both opt-outs collapse the fill back to opaque.
	const optOuts = css.match(
		/--mobile-header-control-surface: var\(--bg\);/g,
	);
	expect(optOuts?.length).toBe(2);
});
