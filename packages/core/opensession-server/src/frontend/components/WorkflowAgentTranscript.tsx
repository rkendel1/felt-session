import React, { useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";
import type { TranscriptEntry } from "../lib/types";
import type { WorkflowAgentSnapshot } from "../../server/workflow-types";
import { TranscriptBlocks } from "./TranscriptBlocks";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName } from "../ui/cn";
import { motionStyles } from "../styles/animations.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minH0: {
			minHeight: "0"
	},
	flexCol: {
			flexDirection: "column"
	},
	sticky: {
			position: "sticky"
	},
	top0: {
			top: "0"
	},
	z10: {
			zIndex: "10"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	px2: {
			paddingInline: "8px"
	},
	py2: {
			paddingBlock: "8px"
	},
	wFull: {
			width: "100%"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap15: {
			gap: "6px"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px1: {
			paddingInline: "4px"
	},
	py05: {
			paddingBlock: "2px"
	},
	textLeft: {
			textAlign: "left"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	size3: {
			width: "12px",
			height: "12px"
	},
	shrink0: {
			flexShrink: "0"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-sm--line-height))"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	size15: {
			width: "6px",
			height: "6px"
	},
	animatePulse: {
			animation: "var(--animate-pulse)"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgYellow: {
			backgroundColor: "var(--yellow)"
	},
	mt05: {
			marginTop: "2px"
	},
	pl18px: {
			paddingLeft: "18px"
	},
	py3: { paddingBlock: "12px" },
	leadingRelaxed: { lineHeight: "var(--leading-relaxed)" },
	textRed: { color: "var(--red)" },

	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
});

/**
 * The workflow-agent drill-in: one workflow agent's FULL conversation — every
 * tool call it made, not just its final text — rendered with the same
 * TranscriptBlocks the main thread and SubagentPane use, behind a
 * breadcrumb-back header (mirrors SubagentPane's pattern).
 *
 * Source: GET /api/workflows/:runId/agents/:seq/transcript →
 * { entries: TranscriptEntry[] }, read off the agent's pi session
 * (outcome.engineSessionId). While the agent is running we poll every 2s so you
 * watch it work live; once it terminates the transcript is final and polling
 * stops. A 404 means the agent has no engine session yet (it hasn't started, or
 * the run predates engineSessionId capture) — that's a placeholder, not an
 * error.
 *
 * Scrolling is deliberately NOT auto-followed: the scroll container is the
 * shared right-panel body owned by SessionViewer, and yanking it is exactly the
 * reader-intent hijack we removed elsewhere.
 */

interface Props {
	runId: string;
	/** Live snapshot from the WS-fed run list — status/duration keep updating. */
	agent: WorkflowAgentSnapshot;
	onBack: () => void;
}

type Load =
	| { kind: "loading" }
	| { kind: "ready"; entries: TranscriptEntry[] }
	/** No engine session (yet) — the agent hasn't started, or it's an old run. */
	| { kind: "none" }
	| { kind: "error"; message: string };

const POLL_MS = 2000;

export function WorkflowAgentTranscript({ runId, agent, onBack }: Props) {
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const running = agent.status === "running" || agent.status === "pending";

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		async function poll(initial: boolean) {
			if (initial) setLoad({ kind: "loading" });
			await (async () => {
const res = await fetch(
					`${BASE_PATH}/api/workflows/${encodeURIComponent(runId)}/agents/${agent.seq}/transcript`,
				);
				if (cancelled) return;
				if (res.status === 404) setLoad({ kind: "none" });
				else if (!res.ok) throw new Error(`HTTP ${res.status}`);
				else {
					const data = (await res.json()) as {
						entries?: TranscriptEntry[];
					} | null;
					if (cancelled) return;
					setLoad({ kind: "ready", entries: data?.entries ?? [] });
				}
})().catch(async (e) => {
if (cancelled) return;
				// A transient miss on a live agent just retries on the next tick.
				if (initial || !running)
					setLoad({
						kind: "error",
						message:
							e instanceof Error ? e.message : "Failed to load the transcript",
					});
});
			// Keep watching only while the agent is still working.
			if (!cancelled && running)
				timer = setTimeout(() => poll(false), POLL_MS);
		}

		poll(true);
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [runId, agent.seq, running]);

	const entries = load.kind === "ready" ? load.entries : [];

	return (
		<div {...stylex.props(sx.flex, sx.minH0, sx.flexCol)}>
			<div {...stylex.props(sx.sticky, sx.top0, sx.z10, sx.borderB, sx.borderDivider, sx.bgPanel, sx.px2, sx.py2)}>
				<button {...mergeStylexProps("", sx.hoverBgHover, sx.flex, sx.wFull, sx.itemsCenter, sx.gap15, sx.roundedControl, sx.px1, sx.py05, sx.textLeft, sx.transitionColors)}
					onClick={onBack}
				>
					<svg
						viewBox="0 0 12 12"
						{...stylex.props(sx.size3, sx.shrink0, sx.textFaint)}
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden
					>
						<path d="M7.5 2 3.5 6l4 4" />
					</svg>
					<span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.textSm, sx.fontMedium, sx.textFg)}>
						{agent.label}
					</span>
					{agent.status === "running" && (
						<span {...stylex.props(sx.size15, sx.shrink0, motionStyles.pulse, sx.roundedFull, sx.bgYellow)} />
					)}
				</button>
				<div {...mergeStylexProps("", sx.tabularNums, sx.mt05, sx.pl18px, sx.textFaint, typography.meta)}>
					{[
						`agent ${agent.seq}`,
						agent.status,
						agent.write ? "write" : undefined,
						agent.phase,
					]
						.filter(Boolean)
						.join(" · ")}
				</div>
			</div>
			<div {...stylex.props(sx.minW0, sx.px2, sx.py2)}>
				{load.kind === "loading" ? (
					<Placeholder>Loading the agent&rsquo;s conversation…</Placeholder>
				) : load.kind === "error" ? (
					<Placeholder tone="error">{load.message}</Placeholder>
				) : load.kind === "none" ? (
					<Placeholder>
						{running
							? "This agent hasn’t started yet."
							: "No conversation recorded for this agent."}
					</Placeholder>
				) : entries.length === 0 ? (
					<Placeholder>
						{running ? "Waiting for the first step…" : "Nothing to show."}
					</Placeholder>
				) : (
					<TranscriptBlocks entries={entries} live={running} />
				)}
			</div>
		</div>
	);
}

function Placeholder({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone?: "error";
}) {
	return (
		<div {...stylex.props(sx.px1, sx.py3, sx.leadingRelaxed, typography.label, tone === "error" ? sx.textRed : sx.textFaint)}>
			{children}
		</div>
	);
}
