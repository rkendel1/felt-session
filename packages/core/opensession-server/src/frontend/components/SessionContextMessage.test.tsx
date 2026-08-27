import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContextMessage } from "./SessionContextMessage";

test("reserves the session context row before metadata arrives", () => {
	const html = renderToStaticMarkup(
		<SessionContextMessage sessionId="os-context-loading" />,
	);

	expect(html).toContain("data-session-context");
	expect(html).toContain('aria-label="Loading session context"');
	// StyleX emits the spacing scale as calc(4px * N): 5 → 20px, 44 → 176px.
	expect(html).toContain("height:calc(4px * 5)");
	expect(html).toContain("width:calc(4px * 44)");
});
