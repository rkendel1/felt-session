import { describe, expect, it } from "bun:test";
import {
	isGitHubAttribution,
	parseAttribution,
	parseRecoveryNotice,
	parseReviewHandoff,
	parseSessionNotice,
	parseWorkerReport,
	parseWorkflowNotice,
} from "./humanReply";

describe("human reply attribution", () => {
	it("parses bracketed attributions", () => {
		expect(parseAttribution("[Kent] Please check this")).toEqual({
			name: "Kent",
			body: "Please check this",
		});
	});

	it("identifies GitHub automation attributions", () => {
		expect(isGitHubAttribution("GitHub")).toBe(true);
		expect(isGitHubAttribution("GitHub (automation)")).toBe(true);
		expect(isGitHubAttribution("Kent")).toBe(false);
	});
});

describe("review handoff detection", () => {
	it("detects the sentinel form and strips it", () => {
		const parsed = parseReviewHandoff(
			"<!--os:review-handoff-->\n🔍 This session's PR #5109 “Fix previews” (branch `x`) was just reviewed…",
		);
		expect(parsed?.prNumber).toBe(5109);
		expect(parsed?.body.startsWith("🔍 This session's")).toBe(true);
	});

	it("detects pre-sentinel handoffs by their opener", () => {
		const parsed = parseReviewHandoff("🔍 This session's PR #42 “t” was just reviewed…");
		expect(parsed?.prNumber).toBe(42);
	});

	it("ignores other GitHub FYIs", () => {
		expect(parseReviewHandoff("🔀 PR #42 was merged")).toBeNull();
		expect(parseReviewHandoff("plain message")).toBeNull();
	});
});

describe("worker report detection", () => {
	const id = "bks-019fa49c-71bb-7000-85d4-c8cc61d0ca85";

	it("detects the delivered sentinel form and strips both markers", () => {
		const parsed = parseWorkerReport(
			`[worker ${id}] <!--os:worker-report-->\nInspection complete.`,
		);
		expect(parsed).toEqual({ sessionId: id, body: "Inspection complete." });
	});

	it("detects pre-sentinel reports by their worker attribution", () => {
		// parseAttribution can't: "worker <id>" is 47 chars, over its 40 cap —
		// which is why these used to render as raw text in the human's bubble.
		expect(parseAttribution(`[worker ${id}] Done.`)).toBeNull();
		expect(parseWorkerReport(`[worker ${id}] Done.`)).toEqual({
			sessionId: id,
			body: "Done.",
		});
	});

	it("carries the worker's id so the card can link back to it", () => {
		expect(parseWorkerReport(`<!--os:worker-report:${id}-->\nDone.`)?.sessionId).toBe(id);
	});

	it("drops a stacked notice sentinel the card would render as raw HTML", () => {
		// A worker whose whole job was a workflow reports the workflow's own
		// nudge back, so the turn carries both sentinels.
		const parsed = parseWorkerReport(
			`<!--os:worker-report:${id}--><!--os:workflow-notice:wf-1-->\n✅ Workflow "crop-modal-review" finished`,
		);
		expect(parsed).toEqual({
			sessionId: id,
			body: '✅ Workflow "crop-modal-review" finished',
		});
	});

	it("leaves ordinary turns alone", () => {
		expect(parseWorkerReport("Please review the worker output")).toBeNull();
		expect(parseWorkerReport("[Kent] worker bks-1 looks stuck")).toBeNull();
	});
});

describe("workflow notice detection", () => {
	const run = "wf-019fadb0-1b1a-7000-bb6f-4e889643002f";

	it("detects the sentinel through the human attribution it's delivered under", () => {
		const parsed = parseWorkflowNotice(
			`[Alex Rivera] <!--os:workflow-notice:${run}-->\n✅ Workflow "perspective-review" finished (${run}) — 2 agents: 2 done.`,
		);
		expect(parsed?.runId).toBe(run);
		expect(parsed?.body.startsWith("✅ Workflow")).toBe(true);
	});

	it("detects pre-sentinel notices by their status opener", () => {
		expect(parseWorkflowNotice(`⚠️ Workflow "audit" failed (${run}) — 3 agents.`)?.runId).toBe(
			run,
		);
	});

	it("keeps the error tail with the notice", () => {
		const parsed = parseWorkflowNotice(`⚠️ Workflow "audit" failed (${run}).\nError: boom`);
		expect(parsed?.body.endsWith("Error: boom")).toBe(true);
	});

	it("leaves a turn the human typed into alone", () => {
		// Typing while the notice lands merges both into one turn — dimming that
		// into the system pill would hide the question they actually asked.
		expect(
			parseWorkflowNotice(
				`✅ Workflow "perspective-review" finished (${run}) — 2 agents: 2 done.\n\nshould also be rendered as a different card`,
			),
		).toBeNull();
	});

	it("leaves ordinary turns alone", () => {
		expect(parseWorkflowNotice("Workflow finished, what now?")).toBeNull();
		expect(parseWorkflowNotice("✅ done")).toBeNull();
	});
});

describe("service restart recovery detection", () => {
	it("detects synthetic continuation prompts across persona names", () => {
		const content =
			"This session was interrupted by an Ada service restart mid-run. Review what you had already done.";
		expect(parseRecoveryNotice(content)).toEqual({ body: content });
		expect(
			parseRecoveryNotice(
				"This session was interrupted by an OS1 service restart mid-run. Pick up where you left off.",
			),
		).not.toBeNull();
	});

	it("leaves human messages that merely quote a recovery prompt alone", () => {
		expect(
			parseRecoveryNotice(
				"Can we collapse this?\n\nThis session was interrupted by an Ada service restart mid-run.",
			),
		).toBeNull();
	});
});

describe("cross-session notice detection", () => {
	const headsUp =
		"Heads-up from another session (Ada, working on the sidebar): a shared-checkout commit picked up your changes.\n\nNothing was lost.";

	it("detects an existing unmarked heads-up", () => {
		expect(parseSessionNotice(headsUp)).toEqual({ body: headsUp });
	});

	it("strips the marker and delivery attribution from new notices", () => {
		expect(
			parseSessionNotice(`[Alex] <!--os:session-notice-->\n${headsUp}`),
		).toEqual({ body: headsUp });
	});

	it("leaves ordinary cross-session prompts as user turns", () => {
		expect(parseSessionNotice("Please keep editing and commit the fix.")).toBeNull();
	});

	it("does not hide a separately attributed prompt merged into the entry", () => {
		expect(
			parseSessionNotice(
				`<!--os:session-notice-->\n${headsUp}\n\n[Kent] Please also run the tests.`,
			),
		).toBeNull();
	});
});
