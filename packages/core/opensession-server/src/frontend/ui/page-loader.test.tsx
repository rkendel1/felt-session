import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { newStylexCollector, stylexCss, stylexTransform } from "../../server/stylex-build";
import { PageLoader } from "./page-loader";

const source = new URL("./spinner.tsx", import.meta.url).pathname;
const motionSource = new URL("../styles/animations.stylex.ts", import.meta.url).pathname;
const collector = newStylexCollector();
stylexTransform(motionSource, readFileSync(motionSource, "utf8"), collector);
stylexTransform(source, readFileSync(source, "utf8"), collector);
const css = stylexCss(collector);

test("page loading uses the larger round spinner", () => {
	const html = renderToStaticMarkup(<PageLoader className="loader-hook" />);
	expect(css).toContain("width:20px");
	expect(css).toContain("height:20px");
	expect(css).toContain("border-radius:calc(infinity * 1px)");
	expect(css).toContain("animation-duration:1s");
	expect(css).toContain("animation-timing-function:linear");
	expect(html).toContain("loader-hook");
	expect(html.match(/<span/g)).toHaveLength(1);
});
