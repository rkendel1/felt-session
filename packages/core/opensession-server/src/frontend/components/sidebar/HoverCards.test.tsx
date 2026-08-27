import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { newStylexCollector, stylexCss, stylexTransform } from "../../../server/stylex-build";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	CardOverview,
	SessionCardBody,
	WsCardBody,
	WsPrStatusMark,
	WsStatusMark,
} from "./HoverCards";
import type { WorkspaceOverview } from "../../lib/api";
import type { WsCardRow } from "../../lib/sidebar-hover";
import type { UnifiedSession } from "../../lib/types";

// A sibling test may already have installed a partial `window`. Fill in this
// file's browser surface without replacing it.
Object.assign(
	((globalThis as unknown as { window?: Record<string, unknown> }).window ??= {}),
	{ addEventListener: () => {}, matchMedia: () => ({ matches: false }) },
);

const AGO = new Date(Date.now() - 8 * 60_000).toISOString();
const HOVER_SOURCE = new URL("./HoverCards.tsx", import.meta.url).pathname;
const hoverSource = readFileSync(HOVER_SOURCE, "utf8");
const statusSource =
	readFileSync(new URL("../../lib/sidebar-classes.ts", import.meta.url), "utf8") +
	readFileSync(new URL("../../styles/utility-compat.stylex.ts", import.meta.url), "utf8");
const toneSource = new URL("../../lib/pr-tone-classes.ts", import.meta.url).pathname;
const toneCollector = newStylexCollector();
stylexTransform(toneSource, readFileSync(toneSource, "utf8"), toneCollector);
const toneCss = stylexCss(toneCollector);

function session(extra: Partial<UnifiedSession> = {}): UnifiedSession {
	return {
		id: "os-test",
		title: "Modernize UI design",
		repo: "opensession",
		lastActivity: AGO,
		...extra,
	} as unknown as UnifiedSession;
}

function row(sessions: UnifiedSession[]): WsCardRow {
	return {
		key: "ws-test",
		workspace: null,
		name: "Modernize UI design",
		sessions,
		status: "pending",
		lastActivity: AGO,
		running: false,
	};
}

// The card answers "what is this, and what does it need?". The repo is the
// band the row is already filed under, and an idle "updated 8m ago" is a fact
// the Info tab carries exactly — neither changes what you do next, and on a
// 300px card they were the first and last thing you read.
describe("hover cards drop the repo and the idle timestamp", () => {
	test("the session card leads with neither the repo nor a timestamp", () => {
		const html = renderToStaticMarkup(
			<SessionCardBody session={session()} />,
		);
		expect(html).toContain("Modernize UI design");
		expect(html).not.toContain("opensession");
		expect(html).not.toContain("Updated");
	});

	test("the workspace card leads with neither the repo nor a timestamp", () => {
		const html = renderToStaticMarkup(
			<WsCardBody
				row={row([session()])}
				snoozed={false}
				onToggleSnooze={() => {}}
				onOpen={() => {}}
			/>,
		);
		expect(html).toContain("Modernize UI design");
		expect(html).not.toContain("opensession");
		expect(html).not.toContain("Updated");
	});

	test("a card with nothing left to show ends on its content, not an empty strip", () => {
		const html = renderToStaticMarkup(<SessionCardBody session={session()} />);
		expect(html).not.toContain("mt-3.5");
	});

	test("only running cards show a dot, beside their title", () => {
		const sessionIdle = renderToStaticMarkup(
			<SessionCardBody session={session()} />,
		);
		const sessionRunning = renderToStaticMarkup(
			<SessionCardBody session={session({ isRunning: true })} />,
		);
		const workspaceIdle = renderToStaticMarkup(
			<WsCardBody
				row={row([session()])}
				snoozed={false}
				onToggleSnooze={() => {}}
				onOpen={() => {}}
			/>,
		);
		const workspaceRunning = renderToStaticMarkup(
			<WsCardBody
				row={{ ...row([session({ isRunning: true })]), running: true }}
				snoozed={false}
				onToggleSnooze={() => {}}
				onOpen={() => {}}
			/>,
		);
		for (const idle of [sessionIdle, workspaceIdle]) {
			expect(idle).not.toContain("Running");
		}
		for (const running of [sessionRunning, workspaceRunning]) {
			expect(running).toContain("bg-yellow");
		}
		expect(hoverSource).toContain("sx.size2, sx.shrink0, sx.roundedFull");
	});

	// Snoozed work always offers the immediate way back from the card.
	test("a snoozed workspace gets Unsnooze", () => {
		const html = renderToStaticMarkup(
			<WsCardBody
				row={{ ...row([session()]), status: "merged" }}
				snoozed
				onToggleSnooze={() => {}}
				onOpen={() => {}}
			/>,
		);
		expect(html).toContain(">Unsnooze<");
		expect(html).not.toContain(">Settle<");
	});

	test("the PR chip centres its number the same way", () => {
		const html = renderToStaticMarkup(
			<SessionCardBody
				session={session({
					prUrl: "https://github.com/tellahq/example/pull/1",
					prNumber: 1,
					prState: "OPEN",
				})}
			/>,
		);
		expect(html).toMatch(
			new RegExp(`<span class="[^"]*text-box[^"]*">#1</span>`),
		);
	});

	test("a diff still holds the head line it shares with the repo's old slot", () => {
		const withPr = session({
			prAdditions: 25,
			prDeletions: 1,
			// Not the fixture's own repo name: the assertion below is about the
			// head line, and a PR link would spell "opensession" out for it.
			prUrl: "https://github.com/tellahq/example/pull/1",
			prNumber: 1,
			prState: "OPEN",
		});
		for (const html of [
			renderToStaticMarkup(<SessionCardBody session={withPr} />),
			renderToStaticMarkup(
				<WsCardBody
					row={row([withPr])}
					snoozed={false}
					onToggleSnooze={() => {}}
					onOpen={() => {}}
				/>,
			),
		]) {
			expect(html).toContain("+25");
			expect(html).toContain("-1");
			expect(html).not.toContain("opensession");
		}
	});

	test("message previews and callouts use the compact metadata size", () => {
		const preview = renderToStaticMarkup(
			<CardOverview
				ov={
					{
						lastMessage: { content: "A compact latest message" },
					} as WorkspaceOverview
				}
			/>,
		);
		const callout = renderToStaticMarkup(
			<SessionCardBody
				session={session({
					lastRunError: {
						message: "The model is unavailable. Send the prompt again.",
						at: AGO,
					},
				})}
			/>,
		);
		for (const html of [preview, callout]) {
			expect(html).toContain("font-size:var(--type-meta)");
			expect(html).not.toContain("text-supporting");
			expect(html).not.toContain("text-xs");
		}
		expect(callout).toContain(
			'title="The model is unavailable. Send the prompt again.">The model is unavailable.</div>',
		);
		expect(callout).toContain("-webkit-line-clamp:2");
		expect(callout).not.toContain("Last run failed");

		const retrying = renderToStaticMarkup(
			<SessionCardBody
				session={session({
					isRunning: true,
					lastRunError: { message: "Stale failure", at: AGO },
				})}
			/>,
		);
		expect(retrying).not.toContain("Stale failure");
	});

	test("a safety pause shows its explanation without requiring a run error", () => {
		const explanation =
			"Open Session paused because it couldn't verify the last action. It won't retry automatically.";
		const paused = session({
			safety: {
				status: "paused_for_safety",
				explanation,
				automaticReconciliationRunning: false,
				pausedAt: AGO,
				operation: "finishing the current turn",
				repairAvailable: false,
			},
		});

		for (const html of [
			renderToStaticMarkup(<SessionCardBody session={paused} />),
			renderToStaticMarkup(
				<WsCardBody
					row={{ ...row([paused]), status: "needsinput" }}
					snoozed={false}
					onToggleSnooze={() => {}}
					onOpen={() => {}}
				/>,
			),
		]) {
			expect(html).toContain(`title="${explanation.replaceAll("'", "&#x27;")}"`);
			expect(html).toContain("Open Session paused because it couldn&#x27;t verify the last action.");
			expect(html).not.toContain("Needs attention.");
		}
	});
});

// The PR is the one place a card leads, so it takes the chip every other PR
// surface draws rather than a dim text link: the number says which PR, the
// colour says how it stands. Both come off the derivation the header uses
// (lib/pr-refs), so the two surfaces cannot disagree about one PR.
describe("workspace PR status marks", () => {
	test("shows merged for a discovered PR without legacy flat PR fields", async () => {
		const html = renderToStaticMarkup(
			<WsPrStatusMark
				sessions={[
					session({
						prs: [
							{
								repo: "tella-fusion",
								branch: "retry-workflow-support-mcp",
								source: "discovered",
								state: "MERGED",
								number: 5883,
							},
						],
					}),
				]}
				size={18}
			/>,
		);
		expect(html).toContain('title="PR merged"');
		expect(
			await Bun.file(new URL("./HoverCards.tsx", import.meta.url)).text(),
		).toContain('mergeStylexOverrideClassName("", sx.textPurple)');
		expect(html).not.toContain("text-faint");
	});

	test("uses an idle dot when the repo ships directly to main", () => {
		const html = renderToStaticMarkup(
			<WsPrStatusMark
				sessions={[session({ branch: "main" })]}
				size={18}
				shipsDirectlyToMain
			/>,
		);
		expect(statusSource).toContain('backgroundColor: "var(--text-faint)"');
		expect(html).not.toContain("No pull request");
	});
});

describe("workspace run status marks", () => {
	test("a failed subagent does not override its running parent", () => {
		const html = renderToStaticMarkup(
			<WsStatusMark
				row={{
					...row([
						session({ isRunning: true }),
						session({
							id: "os-child",
							parentSessionId: "os-test",
							lastRunError: { message: "Worker failed", at: AGO },
						}),
					]),
					status: "inprogress",
					running: true,
				}}
				size={18}
			/>,
		);
		expect(statusSource).toContain('backgroundColor: "var(--yellow)"');
		expect(html).toContain("width:18px;height:18px");
	});

	test("a failed top-level session stays red", () => {
		const html = renderToStaticMarkup(
			<WsStatusMark
				row={{
					...row([
						session({
							lastRunError: { message: "Run failed", at: AGO },
						}),
					]),
					status: "needsinput",
				}}
				size={18}
			/>,
		);
		expect(statusSource).toContain('backgroundColor: "var(--red)"');
		expect(html).toContain("width:18px;height:18px");
	});
});

describe("the card's PR is the chip the rest of the app draws", () => {
	// The anchor's own tag, so a colour on the status line above it cannot be
	// mistaken for a colour on the chip.
	const chip = (html: string) =>
		html.match(/<a[^>]*href="https:\/\/github[^"]*"[^>]*>/)?.[0] ?? "";

	const cardWithPr = (extra: Partial<UnifiedSession>) =>
		renderToStaticMarkup(
			<SessionCardBody
				session={session({
					prUrl: "https://github.com/tellahq/example/pull/1",
					prNumber: 1,
					prState: "OPEN",
					...extra,
				})}
			/>,
		);

	test("it is a control, and it still leaves for the provider", () => {
		const tag = chip(cardWithPr({}));
		expect(tag).toContain('target="_blank"');
		expect(toneCss).toContain("min-height:26px");
		expect(tag).not.toContain("text-dim");
	});

	test("its colour is the PR's state, not one fixed link colour", () => {
		expect(toneCss).toContain("color:var(--green)");
		expect(toneCss).toContain("color:var(--purple)");
		expect(toneCss).toContain("color:var(--red)");
	});
});
