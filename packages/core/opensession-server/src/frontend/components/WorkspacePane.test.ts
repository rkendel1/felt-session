import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./WorkspacePane.tsx", import.meta.url)).text();
const viewerSource = await Bun.file(
	new URL("./SessionViewer.tsx", import.meta.url),
).text();
const prPanelSource = await Bun.file(
	new URL("./PrPanel.tsx", import.meta.url),
).text();
const diffPanelSource = await Bun.file(
	new URL("./DiffPanel.tsx", import.meta.url),
).text();
const codeDisplaySource = await Bun.file(
	new URL("./CodeDisplaySettings.tsx", import.meta.url),
).text();
const commentableDiffSource = await Bun.file(
	new URL("./CommentableDiff.tsx", import.meta.url),
).text();
const reviewToolbarSource = await Bun.file(
	new URL("./pr/ReviewToolbar.tsx", import.meta.url),
).text();
const summarySource = await Bun.file(
	new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();

test("workspace draft composers accept and persist attachments", () => {
	const composerStart = source.lastIndexOf("<Composer");
	const composerEnd = source.indexOf("/>", composerStart);
	const composer = source.slice(composerStart, composerEnd);

	expect(composerStart).toBeGreaterThan(-1);
	expect(composer).toContain("images={images}");
	expect(composer).toContain("onImagesChange={setImages}");
	expect(composer).toContain("files={files}");
	expect(composer).toContain("onFilesChange={setFiles}");
	expect(composer).toContain("onAddAttachments={addWorkspaceAttachments}");
	expect(source).toContain('window.addEventListener("drop", handleDrop, true)');
	expect(source).toContain("saveDraft(draftKey, { text: prompt, images, files })");
});

test("the first workspace session receives its draft attachments", () => {
	const sendStart = source.indexOf('type: "create_session"');
	const sendEnd = source.indexOf("// App navigates", sendStart);
	const payload = source.slice(sendStart, sendEnd);

	expect(sendStart).toBeGreaterThan(-1);
	expect(payload).toContain("...(images.length ? { images } : {})");
	expect(payload).toContain("files: files.map");
	expect(source).toContain("dropStagingAttachments(draftKey)");
});

test("workspace Review keeps the implementation summary beside the PR canvas", () => {
	expect(source).toContain("sessionCarriesPr(s, reviewTarget)");
	expect(source).toContain("s.workspaceId === workspace.id");
	expect(source).toContain("fetchWorkspaceOverview(workspace.id)");
	expect(source).toContain("<WorkspaceSummary");
	expect(source).toContain("session={presentationSession}");
	expect(source).toContain("onOpenChange={setReviewSummaryOpen}");
	expect(source).toContain("compactToolbar={reviewSummaryVisible}");
	expect(viewerSource).toContain("compactToolbar={summaryVisible}");
	expect(viewerSource).not.toContain("WS_SUMMARY_REVIEW_CLEARANCE");
	expect(source).toContain("walkthrough={presentationSession?.walkthrough}");
});

test("reviews with and without a PR share the floating toolbar", () => {
	expect(prPanelSource.match(/<ReviewToolbar compact=\{compactToolbar\}>/g)?.length).toBe(2);
	expect(reviewToolbarSource).toContain("sx.desktopPt25");
	expect(reviewToolbarSource).toContain("sx.desktopRoundedLg");
	expect(reviewToolbarSource).toContain("sx.desktopBorderLine");
	expect(reviewToolbarSource).toContain("sx.desktopOverflowHidden");
	expect(prPanelSource).toContain('label="Code view"');
	expect(prPanelSource).toContain('<SegmentedOption value="all">Changes</SegmentedOption>');
});

test("a review without a PR combines and aligns its controls", () => {
	expect(prPanelSource).toContain("ref={setWorktreeToolbarTarget}");
	expect(prPanelSource).toContain("toolbarTarget={worktreeToolbarTarget}");
	expect(prPanelSource.match(/compactToolbar && sx.overflowYAuto/g)?.length).toBe(2);
	expect(prPanelSource).toContain("compactToolbar ? sx.overflowYVisible : sx.overflowYAuto");
	expect(diffPanelSource).toContain("toolbarTarget === undefined");
	expect(diffPanelSource).toContain("createPortal(toolbarContents, toolbarTarget)");
});

test("sidebar Changes shares Review's code display options", () => {
	expect(prPanelSource).toContain("<CodeDisplaySettings {...codeDisplaySettings} />");
	expect(diffPanelSource).toContain("<CodeDisplaySettings {...codeDisplaySettings} />");
	expect(diffPanelSource).toContain("<CodeOrganizationSettings");
	expect(prPanelSource).toContain("<CodeOrganizationSettings");
	expect(commentableDiffSource).toContain("z-[6] bg-surface");
	expect(commentableDiffSource).toContain("rounded-t-lg bg-bg");
	expect(viewerSource).toContain("--diff-panel-top");
	expect(codeDisplaySource).toContain('label="Wrap lines"');
});

test("wide Review keeps its controls stable while page navigation moves", () => {
	expect(source).toContain("reviewPage={reviewPage}");
	expect(source).toContain("onReviewPageChange={setReviewPage}");
	expect(prPanelSource).toContain("const reviewBar = !compactToolbar");
	expect(prPanelSource).toContain("sx.desktopPt12");
	expect(summarySource).toContain('aria-label="Pull request pages"');
	expect(reviewToolbarSource).toContain("WS_SUMMARY_REVIEW_BAR_CLEARANCE");
	expect(prPanelSource).toContain("sx.summaryCanvasClearance");
});

test("Review loading and errors stay centered beside the summary", () => {
	expect(prPanelSource).toContain("const reviewStateClass = stylex.props(");
	expect(prPanelSource).toContain("compactToolbar && sx.summaryCanvasClearance");
	expect(prPanelSource).toContain("sx.translateYMinus5");
	expect(prPanelSource).toContain('title="Couldn’t load pull request"');
	expect(prPanelSource).toContain('className={reviewStateClass}');
});

test("a lone Review hides the tab strip, closes the toolbar gap, and keeps New tab in the header", () => {
	expect(source).toContain("tabStripVisible: boolean");
	expect(source).toContain("!tabStripVisible && onNewSession");
	expect(source).toContain("tabStripVisible={tabStripVisible}");
	expect(source).toContain("flushToolbarTop={!tabStripVisible}");
	expect(viewerSource).toContain("flushToolbarTop={!tabStripVisible}");
	expect(source).toContain('aria-label="New tab"');
});

test("the PR top bar leaves merge to the summary and actions menu", () => {
	const headerStart = prPanelSource.indexOf('<TopBar as="header"');
	const menuStart = prPanelSource.indexOf("<Menu.Root>", headerStart);
	const menuEnd = prPanelSource.indexOf("</Menu.Root>", menuStart);

	expect(headerStart).toBeGreaterThan(-1);
	expect(menuStart).toBeGreaterThan(headerStart);
	expect(prPanelSource.slice(headerStart, menuStart)).not.toContain(
		"Squash and merge",
	);
	expect(prPanelSource.slice(menuStart, menuEnd)).toContain("Squash and merge");
});
