import { expect, test } from "bun:test";

const popoverSource = await Bun.file(
	new URL("./PrChecksPopover.tsx", import.meta.url),
).text();
const statusBarSource = await Bun.file(
	new URL("./PrStatusBar.tsx", import.meta.url),
).text();
const summarySource = await Bun.file(
	new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const popupClassesSource = await Bun.file(
	new URL("../ui/popup-classes.ts", import.meta.url),
).text();
const tooltipSource = await Bun.file(
	new URL("../ui/tooltip.tsx", import.meta.url),
).text();
const floatingPrimitiveSources = await Promise.all([
	...["menu.tsx", "popover.tsx", "select.tsx"].map((file) =>
		Bun.file(new URL(`../ui/${file}`, import.meta.url)).text(),
	),
	tooltipSource,
	Bun.file(new URL("./useFileMentions.tsx", import.meta.url)).text(),
]);

test("shared floating interactions paint above the workspace summary", () => {
	expect(summarySource).toContain('positionerClassName={utilityClassName("z-[2147483646]")}');
	expect(popupClassesSource).toContain(
		'"zIndex": "2147483647"',
	);
	for (const source of floatingPrimitiveSources) {
		expect(source).toContain("FLOATING_OVERLAY_LAYER");
	}
});

test("tooltips escape nested popup portal containers", () => {
	expect(tooltipSource).toContain("document.body");
});

test("the summary's checks preview stays open with its parent", () => {
	const summaryStart = statusBarSource.indexOf('if (variant === "summary")');
	const summaryEnd = statusBarSource.indexOf('if (variant === "header")');
	const summary = statusBarSource.slice(summaryStart, summaryEnd);

	expect(summaryStart).toBeGreaterThan(-1);
	expect(summary).toContain("<PrChecksPopover");
	expect(summary).toContain("nested");
	expect(popoverSource).toContain("<Popover.Root exclusive={!nested}>");
	expect(popoverSource).toContain("document.body");
});
