import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewSessionPrompt, type NewSessionPromptHandle } from "./NewSessionPrompt";

function field(overrides: Partial<Parameters<typeof NewSessionPrompt>[0]> = {}) {
	const props: Parameters<typeof NewSessionPrompt>[0] = {
		initialText: "",
		textareaRef: { current: null },
		valueRef: { current: "" },
		handle: { current: null as NewSessionPromptHandle | null },
		repo: "opensession",
		placeholder: "What do you want to work on?",
		disabled: false,
		images: [],
		files: [],
		staging: { images: 0, files: 0 },
		onRemoveImage: () => {},
		onRemoveFile: () => {},
		onRemovePendingImage: () => {},
		onRemovePendingFile: () => {},
		onAddAttachments: () => {},
		sendKey: "enter",
		canCreate: false,
		onCreate: () => {},
		onHasTextChange: () => {},
		onDraftSettled: () => {},
		onEdgesChange: () => {},
		onMentionOpenChange: () => {},
		...overrides,
	};
	return { props, html: renderToStaticMarkup(<NewSessionPrompt {...props} />) };
}

test("the restored draft is what the field shows", () => {
	const { html } = field({ initialText: "Fix the flaky test" });

	expect(html).toContain("<textarea");
	expect(html).toContain("Fix the flaky test");
	expect(html).toContain('placeholder="What do you want to work on?"');
});

// Rendering can be abandoned under concurrent React, so the external ref is
// updated by a layout effect only after the draft commits.
test("a server render does not publish an uncommitted draft", () => {
	const valueRef = { current: "" };
	field({ initialText: "Ship the palette split", valueRef });

	expect(valueRef.current).toBe("");
});

test("attachments share the prompt's scroller", () => {
	const { html } = field({
		images: ["data:image/png;base64,iVBORw0KGgo="],
		files: [
			{
				name: "notes.txt",
				type: "text/plain",
				dataUrl: "data:text/plain;base64,aGk=",
			},
		],
	});

	expect(html).toContain('aria-label="Open image preview"');
	expect(html).toContain("notes.txt");
	expect(html.indexOf('aria-label="Open image preview"')).toBeGreaterThan(
		html.indexOf("<textarea"),
	);
});

// A pasted screenshot is uploaded before it is attached, and during a slow
// load that takes seconds. Without something standing in for it the card
// looks like it ignored the paste, and the second paste leaves you with two
// of the same picture.
test("an image still being staged holds its place", () => {
	const { html } = field({ staging: { images: 1, files: 0 } });

	// The tile itself, in the row the picture will land in.
	expect(html).toContain("animation-duration:2s");
	expect(html).toContain('aria-label="Cancel image upload"');
	// And the same news for a reader who cannot see it.
	expect(html).toContain("Attaching 1 image…");
	expect(html).toContain('role="status"');
});

test("a staged file holds its place too", () => {
	const { html } = field({ staging: { images: 0, files: 1 } });

	expect(html).toContain("background-color:var(--hover)");
	expect(html).toContain('aria-label="Cancel file upload"');
	expect(html).toContain("Attaching 1 file…");
});

test("a staged image's ghost does not survive its arrival", () => {
	const { html } = field({
		images: ["data:image/png;base64,iVBORw0KGgo="],
		staging: { images: 0, files: 0 },
	});

	expect(html).not.toContain("animate-pulse");
	expect(html).not.toContain("Attaching");
});

test("a busy create disables the field", () => {
	const { html } = field({ disabled: true });

	expect(html).toContain("disabled");
});
