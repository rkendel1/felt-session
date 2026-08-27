import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	PhoneTopBar,
	PhoneTopBarAction,
	PhoneTopBarTitle,
	TopBar,
	TopBarAction,
	TopBarActions,
	TopBarBack,
	TopBarLeading,
	TopBarTitle,
} from "./top-bar";

test("top bars share structure while keeping feature layout classes", () => {
	const html = renderToStaticMarkup(
		<TopBar as="header" className="sticky">
			<TopBarLeading>Leading</TopBarLeading>
			<TopBarTitle>Title</TopBarTitle>
			<TopBarActions>Actions</TopBarActions>
		</TopBar>,
	);

	expect(html).toContain("<header");
	expect(html).toContain('data-top-bar=""');
	expect(html).toContain("sticky");
	expect(html).toContain("Leading");
	expect(html).toContain("Title");
	expect(html).toContain("Actions");
});

test("column hosts can stretch portaled top-bar rows", () => {
	const html = renderToStaticMarkup(
		<TopBar className="flex-col items-stretch">Hosted row</TopBar>,
	);

	expect(html).toContain("items-stretch");
	expect(html).not.toContain("items-center");
});

test("phone pages and sheets share one bar and action rhythm", () => {
	const html = renderToStaticMarkup(
		<PhoneTopBar>
			<PhoneTopBarAction aria-label="Close" icon={<span>Close</span>} />
			<PhoneTopBarTitle>Settings</PhoneTopBarTitle>
		</PhoneTopBar>,
	);

	expect(html).toContain("width:44px");
	expect(html).toContain("height:44px");
	expect(html).toContain("border-radius:calc(infinity * 1px)");
	expect(html).toContain("Settings");
});

test("floating controls reuse application mobile chrome", () => {
	const html = renderToStaticMarkup(
		<>
			<TopBarBack floating aria-label="Back" />
			<TopBarAction floating aria-label="More" icon={<span>Icon</span>} />
		</>,
	);

	expect(html).toContain("pwa-header-back");
	// Visual glass is verified from compiled StyleX in mobile-chrome.test.ts.
	expect(html).toContain('aria-label="Back"');
	expect(html).toContain('aria-label="More"');
});
