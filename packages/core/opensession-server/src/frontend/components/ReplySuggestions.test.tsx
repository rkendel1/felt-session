import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { newStylexCollector, stylexCss, stylexTransform } from "../../server/stylex-build";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ReplySuggestion } from "../lib/reply-suggestions";
import {
	ACTION_CLEARANCE,
	ACTION_WITH_REPLIES_CLEARANCE,
	SCROLL_ACTION_CLEARANCE,
	SUGGESTIONS_CLEARANCE,
	VIEWER_ACTION_ROW,
	VIEWER_ACTION_ROW_WITH_SCROLL,
	VIEWER_SUGGESTIONS,
	VIEWER_SUGGESTIONS_ROW,
	VIEWER_SUGGESTIONS_ROW_INLINE,
} from "../lib/session-viewer-classes";

const { ReplySuggestions } = await import("./ReplySuggestions");
const COMPOSER_SOURCE = new URL("../lib/composer-classes.ts", import.meta.url).pathname;
const composerSource = readFileSync(COMPOSER_SOURCE, "utf8");
const composerCollector = newStylexCollector();
stylexTransform(
	COMPOSER_SOURCE,
	readFileSync(COMPOSER_SOURCE, "utf8"),
	composerCollector,
);
const UTILITY_COMPAT = new URL("../styles/utility-compat.stylex.ts", import.meta.url).pathname;
stylexTransform(UTILITY_COMPAT, readFileSync(UTILITY_COMPAT, "utf8"), composerCollector);
const composerCss = stylexCss(composerCollector);
const VIEWER_SOURCE = new URL("../lib/session-viewer-classes.ts", import.meta.url).pathname;
const viewerSource = readFileSync(VIEWER_SOURCE, "utf8");
const replySource = new URL("./ReplySuggestions.tsx", import.meta.url).pathname;
const replyCollector = newStylexCollector();
stylexTransform(replySource, readFileSync(replySource, "utf8"), replyCollector);
const replyCss = stylexCss(replyCollector);

const suggestions: ReplySuggestion[] = [
	{
		label: "Fix both",
		text: "Fix both the queue race and the stale cache read, then run bun test.",
	},
	{ label: "Only step 1", text: "Only fix step 1 for now and stop there." },
];

describe("ReplySuggestions", () => {
	test("shows the short label and carries the full text as the accessible name", () => {
		const html = renderToStaticMarkup(
			<ReplySuggestions suggestions={suggestions} onPick={() => {}} />,
		);

		expect(html).toContain(">Fix both<");
		expect(html).toContain(">Only step 1<");
		// The sentence is what actually lands in the draft, so a screen reader
		// hears it rather than the two-word shorthand.
		expect(html).toContain(
			'aria-label="Fix both the queue race and the stale cache read, then run bun test."',
		);
	});

	test("renders one scrolling row rather than wrapping above the composer", () => {
		const html = renderToStaticMarkup(
			<ReplySuggestions suggestions={suggestions} onPick={() => {}} />,
		);
		expect(replyCss).toContain("overflow-x:auto");
		expect(replyCss).toContain("white-space:nowrap");
		expect(html).toContain("data-[overflow-end]:[--reply-fade-end:transparent]");
		expect(replySource).not.toContain("flexWrap");
	});

	test("the pills start on the composer's own content rail", () => {
		expect(composerSource).toContain("[--composer-inset-left:15px]");
		expect(composerSource).toContain("phone:[--composer-inset-left:13px]");
		expect(viewerSource).toContain("pl-[19px]");
		expect(viewerSource).toContain("phone:pl-[17px]");
	});

	test("the transcript keeps clear of whatever the band is carrying", () => {
		for (const value of [34, 38, 46, 54, 90]) {
			expect(viewerSource).toContain(`[--suggestions-under:${value}px]`);
		}
		expect(viewerSource).toContain("phone:[body.kb-open_&]:[--suggestions-under:0px]");
	});

	test("desktop keeps Next on the input's right edge", () => {
		expect(viewerSource).toContain("justify-end");
	});

	test("desktop centers the reading action between replies and Next", () => {
		expect(viewerSource).toContain("desktop:grid");
		expect(viewerSource).toContain("desktop:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]");
	});

	test("phone stacks chips above the centered action bar", () => {
		expect(viewerSource).toContain("phone:flex-col");
		expect(viewerSource).toContain("phone:gap-2");
		expect(viewerSource).toContain("phone:pr-0");
		expect(viewerSource).toContain("export const VIEWER_SUGGESTIONS_ROW_INLINE");
		expect(viewerSource).toContain("min-w-0");
	});

	test("renders nothing at all when there is nothing to suggest", () => {
		expect(
			renderToStaticMarkup(
				<ReplySuggestions suggestions={[]} onPick={() => {}} />,
			),
		).toBe("");
	});
});
