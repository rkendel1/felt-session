import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Segmented, SegmentedOption } from "./segmented";

describe("Segmented", () => {
	test("centers every option label", () => {
		const html = renderToStaticMarkup(
			<Segmented label="Layout" value={null} onValueChange={() => {}}>
				<SegmentedOption value="compact">Compact</SegmentedOption>
				<SegmentedOption value="default">Default</SegmentedOption>
			</Segmented>,
		);

		expect(html.match(/<button[^>]+>/g)).toHaveLength(2);
		// StyleX compiles the centring utilities into declarations, so assert the
		// rendered semantics rather than the Tailwind class spellings.
		expect(html.match(/<button[^>]+justify-content:center[^>]*text-align:center/g)).toHaveLength(2);
	});
});
