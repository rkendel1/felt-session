import React, { useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";
import type {
	WorkflowAgentSnapshot,
	WorkflowJournalEntry,
	WorkflowRunSnapshot,
} from "../../server/workflow-types";
import type { SessionSubagentSnapshot } from "../lib/api";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { Button } from "../ui/button";
import { CardList } from "../ui/card";
import { EmptyState } from "../ui/state";
import { IconStack } from "./icons";
import { PanelPageHeader } from "./PanelPageHeader";
import { formatDuration } from "../lib/time";
import {
	INFO_LABEL_CLASS,
	INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import { friendlyModelSlug, routedModelParts } from "./ModelEffortSelect";
import { WorkflowAgentTranscript } from "./WorkflowAgentTranscript";
import { Badge } from "../ui/badge";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { motionStyles } from "../styles/animations.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	size3: {
			width: "12px",
			height: "12px"
	},
	shrink0: {
			flexShrink: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	maxW120px: {
			maxWidth: "120px"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	minW0: {
			minWidth: "0"
	},
	gap15: {
			gap: "6px"
	},
	pl5: {
			paddingLeft: "20px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	textGreen: {
			color: "var(--green)"
	},
	textRed: {
			color: "var(--red)"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	maxW84px: {
			maxWidth: "84px"
	},
	shrink: {
			flexShrink: "1"
	},
	w46px: {
			width: "46px"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	textRight: {
			textAlign: "right"
	},
	w11: {
			width: "44px"
	},
	maxH56: {
			maxHeight: "224px"
	},
	overflowAuto: {
			overflow: "auto"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	breakWords: {
			overflowWrap: "break-word"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgHover: {
			backgroundColor: "var(--hover)"
	},
	p2: {
			padding: "8px"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mr1: {
			marginRight: "4px"
	},
	animatePulse: {
			animation: "var(--animate-pulse)"
	},
	grid: {
			display: "grid"
	},
	gap4: {
			gap: "16px"
	},
	px2: {
			paddingInline: "8px"
	},
	pt1: {
			paddingTop: "4px"
	},
	pb22px: {
			paddingBottom: "22px"
	},
	gap3: {
			gap: "12px"
	},
	inlineFlex: {
			display: "inline-flex"
	},
	textYellow: {
			color: "var(--yellow)"
	},
	size15: {
			width: "6px",
			height: "6px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgCurrent: {
			backgroundColor: "currentColor"
	},
	pb25: {
			paddingBottom: "10px"
	},
	gap2: {
			gap: "8px"
	},
	flex1: {
			flex: "1"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt05: {
			marginTop: "2px"
	},
	flexCol: {
			flexDirection: "column"
	},
	py7: {
			paddingBlock: "28px"
	},
	gap5px: {
			gap: "5px"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px3: {
			paddingInline: "12px"
	},
	py25: {
			paddingBlock: "10px"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	pbPx: {
			paddingBottom: "1px"
	},
	pt2: {
			paddingTop: "8px"
	},
	mx2: {
			marginInline: "8px"
	},
	mt1: {
			marginTop: "4px"
	},
	borderT: {
			borderTopStyle: "solid",
			borderTopWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	gap05: {
			gap: "2px"
	},
	pb15: {
			paddingBottom: "6px"
	},
	pt05: {
			paddingTop: "2px"
	},
	py15: {
			paddingBlock: "6px"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	minH0: {
			minHeight: "0"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	mx1: {
			marginInline: "4px"
	},
	mb15: {
			marginBottom: "6px"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	selfStart: {
			alignSelf: "flex-start"
	},
	textLink: {
			color: "var(--link)"
	},

	size2: {
		"width": "8px",
		"height": "8px"
	},
	bgYellow: {
		"backgroundColor": "var(--yellow)"
	},
	bgLineStrong: {
		"backgroundColor": "var(--border-strong)"
	},
	itemsStretch: {
		"alignItems": "stretch"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	cursorDefault: {
		"cursor": "default"
	},
	lineThrough: {
		"textDecorationLine": "line-through"
	},
	transitionGridTemplateRows: {
		"transitionProperty": "grid-template-rows",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	duration200: {
		"--tw-duration": ".2s",
		"transitionDuration": ".2s"
	},
	easeOut: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	GridTemplateRows1fr: {
		"gridTemplateRows": "1fr"
	},
	GridTemplateRows0fr: {
		"gridTemplateRows": "0fr"
	},

	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	bgPanel: {
		"backgroundColor": "var(--bg-panel)"
	},
	p1: {
		"padding": "4px"
	},
	wFull: {
		"width": "100%"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	textLeft: {
		"textAlign": "left"
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	hoverUnderline: {
		"@media (hover: hover)": {
			":hover": {
				"textDecorationLine": "underline"
			}
		}
	},
});

/**
 * Agents tab: live view of a session's dynamic workflow runs (the
 * opensession-workflows MCP). Renders WorkflowRunSnapshot cards — newest run
 * first — with agents grouped by phase, a narrator log feed, and a per-agent
 * drill-in that lazily fetches the full journal entry
 * (/api/workflows/:runId/agents/:seq). Snapshots arrive via the
 * workflow_update WS broadcast; this component is a pure renderer plus the
 * drill-in fetch. Never mounted with zero runs (the tab itself hides).
 *
 * Two levels of drill-in:
 *  - the row expands in place to the full prompt/result (journal entry), and
 *  - "View conversation" swaps the whole panel for WorkflowAgentTranscript —
 *    the agent's real conversation (its tool calls / steps), live while it
 *    runs. The selected agent is re-resolved from `runs` every render so the
 *    WS snapshot keeps its header status/duration honest.
 *
 * Write agents (opts.write — code mode in their own isolated worktree) carry a
 * branch chip + diffstat + merge badge on their row.
 */

interface Props {
	sessionId: string;
	runs: WorkflowRunSnapshot[];
	onCancel: (runId: string) => void;
	/** Sub-agents the session spawned directly (task tool) — rendered as their
	 *  own card above the workflow runs. */
	subagents?: SessionSubagentSnapshot[];
	/** Opens a sub-agent's conversation in its own view tab. */
	onOpenSubagent?: (agentId: string, label: string) => void;
	/** Set when this renders as a page pushed on top of the workspace panel
	 *  (the Agents item in its tab strip). Page mode shows the empty state and
	 *  can carry a back header; without it this is a section of the phone info
	 *  page, which renders nothing until a run exists. */
	onBack?: () => void;
	/** The desktop panel's standing tab strip already names this page. */
	hideHeader?: boolean;
}

/** A finished run says so with its green marks and its totals, so `done` gets
 *  no badge. The badge is for a run that still wants your attention. */
const RUN_TONE: Record<
	WorkflowRunSnapshot["status"],
	"warning" | "danger" | "neutral" | null
> = {
	running: "warning",
	done: null,
	error: "danger",
	cancelled: "neutral",
	interrupted: "warning",
};

/** The card's plate and the rows inside it: the Info panel's list grammar
 *  (INFO_LIST_CLASS), so an agent row lines up with a portal or a changed
 *  file rather than inventing a third row shape. */
const CARD_CLASS = mergeStylexClassName("", sx.overflowHidden, sx.roundedLg, sx.bgPanel, sx.p1);
const ROW_CLASS =
	mergeStylexClassName("", sx.flex, sx.wFull, sx.itemsCenter, sx.gap2, sx.roundedControl, sx.px2, sx.py15, sx.textLeft, sx.transitionColors);
/** A toggle under the agent rows (tool calls, the result): the same row, in
 *  the quieter ink a reading gets. */
const FOOTER_ROW =
	mergeStylexClassName("", sx.flex, sx.wFull, sx.itemsCenter, sx.gap2, sx.roundedControl, sx.px2, sx.py15, sx.textLeft, typography.meta) +
	" " + mergeStylexClassName("", sx.fontMedium, sx.textDim, sx.transitionColors, sx.hoverBgHover, sx.hoverTextFg);

/** Status mark: glyphs for the terminal states (✓/✕ stay legible at a glance
 *  — a red accent dot and an error dot would read the same), pulsing yellow
 *  dot = running (matches the run pill, and the "In progress" lane), dim dot =
 *  pending/cancelled. */
function StatusMark({ status }: { status: WorkflowAgentSnapshot["status"] }) {
	if (status === "done" || status === "error") {
		const ok = status === "done";
		return (
			<svg
				viewBox="0 0 12 12"
				className={cn(mergeStylexClassName("", sx.size3, sx.shrink0), ok ? mergeStylexClassName("", sx.textGreen) : mergeStylexClassName("", sx.textRed))}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				{ok ? (
					<path d="M2.5 6.5 5 9l4.5-6" />
				) : (
					<path d="M3 3l6 6M9 3l-6 6" />
				)}
			</svg>
		);
	}
	return (
		<span {...stylex.props(sx.flex, sx.size3, sx.shrink0, sx.itemsCenter, sx.justifyCenter)}>
			<span
				className={cn(
					mergeStylexClassName("", sx.size2, sx.roundedFull),
					status === "running" ? mergeStylexClassName("", sx.bgYellow, motionStyles.pulse) : mergeStylexClassName("", sx.bgLineStrong),
				)}
			/>
		</span>
	);
}

function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	return formatDuration(ms) ?? "0s";
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** "pi/anthropic/claude-sonnet-5" → "Sonnet 5", and
 *  "…/claude-haiku-4-5-20251001" → "Haiku 4.5": the trailing release date is
 *  version noise that doubles the width of every row's model readout. */
function shortModel(id: string): string {
	const oc = routedModelParts(id);
	return friendlyModelSlug((oc ? oc.model : id).replace(/-\d{8}$/, ""));
}

function agentDuration(a: WorkflowAgentSnapshot, now: number): string {
	if (!a.startedAt) return "";
	const end = a.endedAt
		? new Date(a.endedAt).getTime()
		: a.status === "running"
			? now
			: undefined;
	if (end === undefined) return "";
	return fmtDuration(end - new Date(a.startedAt).getTime());
}

/** Row chips report an outcome worth a second look: a branch, a merge, a cache
 *  hit. Everything a row always carries (its model, its tokens, its duration)
 *  is plain text in the rail instead, because a chip on every row in every
 *  column made this list read as a table of boxes. */
function Chip({
	children,
	tone,
	title,
}: {
	children: React.ReactNode;
	/** Merge outcome tints; default is the neutral outlined chip. */
	tone?: "green" | "red";
	title?: string;
}) {
	return (
		<Badge
			title={title}
			tone={tone === "green" ? "success" : tone === "red" ? "danger" : "neutral"}
			variant={tone ? "soft" : "outline"}
			className={mergeStylexOverrideClassName("", sx.maxW120px, sx.truncate)}
		>
			{children}
		</Badge>
	);
}

/** Write-agent readout: branch, diffstat (or "no changes") and merge outcome.
 *  Its own line under the label rather than more cargo on the row, because a
 *  branch name and a diffstat beside a model and two numbers left nothing of
 *  the filename in a panel this narrow. */
function WriteLine({ a }: { a: WorkflowAgentSnapshot }) {
	const files = a.filesChanged ?? 0;
	return (
		<div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap15, sx.pl5, sx.textFaint, typography.meta)}>
			{a.branch && (
				<span {...stylex.props(sx.minW0, sx.truncate)} title={a.branch}>
					⑂ {a.branch}
				</span>
			)}
			{a.changed ? (
				<span {...mergeStylexProps("", sx.tabularNums, sx.shrink0)}>
					<span {...stylex.props(sx.textGreen)}>+{a.insertions ?? 0}</span>{" "}
					<span {...stylex.props(sx.textRed)}>−{a.deletions ?? 0}</span>
					{files > 0 && (
						<span>
							{" "}
							· {files} file{files === 1 ? "" : "s"}
						</span>
					)}
				</span>
			) : (
				a.status === "done" && <span {...stylex.props(sx.shrink0)}>no changes</span>
			)}
			{a.merged === "merged" && (
				<span {...stylex.props(sx.shrink0, sx.fontMedium, sx.textGreen)}>merged</span>
			)}
			{a.merged === "conflict" && (
				<span {...stylex.props(sx.shrink0, sx.fontMedium, sx.textRed)}>conflict</span>
			)}
		</div>
	);
}

/** The readout every agent row ends with: model, tokens, duration. The two
 *  numbers keep fixed columns so a list of rows reads down as well as across,
 *  and they hold their width when a row has nothing to report. */
function AgentRail({
	model,
	tokens,
	duration,
}: {
	model?: string;
	tokens?: number;
	duration: string;
}) {
	return (
		<>
			{model && (
				<span {...stylex.props(sx.minW0, sx.maxW84px, sx.shrink, sx.truncate, sx.textFaint, typography.meta)}>
					{shortModel(model)}
				</span>
			)}
			<span {...mergeStylexProps("", sx.tabularNums, sx.w46px, sx.shrink0, sx.whitespaceNowrap, sx.textRight, sx.textFaint, typography.meta)}>
				{tokens ? `${fmtTokens(tokens)} tok` : ""}
			</span>
			<span {...mergeStylexProps("", sx.tabularNums, sx.w11, sx.shrink0, sx.whitespaceNowrap, sx.textRight, sx.textFaint, typography.meta)}>
				{duration}
			</span>
		</>
	);
}

function DetailPre({ text }: { text: string }) {
	return (
		<pre {...stylex.props(sx.maxH56, sx.overflowAuto, sx.whitespacePreWrap, sx.breakWords, sx.roundedSm, sx.bgHover, sx.p2, sx.fontMono, sx.leadingRelaxed, sx.textDim, typography.meta)}>
			{text}
		</pre>
	);
}

export function WorkflowPanel({
	sessionId: _sessionId,
	runs,
	onCancel,
	subagents,
	onOpenSubagent,
	onBack,
	hideHeader = false,
}: Props) {
	// Server list + WS prepends both keep newest-first; re-sorting is cheap
	// insurance against an out-of-order upsert.
	const ordered = ([...runs].sort(
				(a, b) =>
					new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
			));
	const subs = subagents ?? [];
	const anyRunning =
		ordered.some((r) => r.status === "running") ||
		subs.some((s) => s.status === "running");
	// 1s heartbeat for elapsed/duration readouts, only while something is live.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!anyRunning) return;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [anyRunning]);

	// The open agent conversation, if any. Held as ids (not the snapshot) so the
	// drilled-in view tracks the live WS snapshot rather than a frozen copy.
	const [openConvo, setOpenConvo] = useState<{
		runId: string;
		seq: number;
	} | null>(null);
	const onOpenAgent = (runId: string, seq: number) => setOpenConvo({ runId, seq });
	const closeConvo = () => setOpenConvo(null);
	const convoAgent = (() => {
		if (!openConvo) return undefined;
		return ordered
			.find((r) => r.runId === openConvo.runId)
			?.agents.find((a) => a.seq === openConvo.seq);
	})();

	if (openConvo && convoAgent)
		return (
			<WorkflowAgentTranscript
				runId={openConvo.runId}
				agent={convoAgent}
				onBack={closeConvo}
			/>
		);

	const empty = ordered.length === 0 && subs.length === 0;
	const cards = (
		<>
			{subs.length > 0 && (
				<SubagentsCard subagents={subs} now={now} onOpen={onOpenSubagent} />
			)}
			{ordered.map((run) => (
				<RunCard
					key={run.runId}
					run={run}
					now={now}
					onCancel={onCancel}
					onOpenAgent={onOpenAgent}
				/>
			))}
		</>
	);

	// Page mode: selected in the workspace panel's tab strip, the same level
	// that Portals opens to. It owns the whole column, so
	// it carries the back header and can afford the empty state.
	if (onBack)
		return (
			<>
				{!hideHeader && (
					<PanelPageHeader
						title="Agents"
						onBack={onBack}
						trailing={
							anyRunning && (
								<Badge tone="warning" dot className={mergeStylexOverrideClassName("", sx.mr1, motionStyles.pulse)}>
									running
								</Badge>
							)
						}
					/>
				)}
				<div {...stylex.props(sx.grid, sx.gap4, sx.px2, sx.pt1, sx.pb22px)}>
					{empty ? (
						<WorkflowsEmptyState />
					) : (
						<div {...stylex.props(sx.grid, sx.gap3)}>{cards}</div>
					)}
				</div>
			</>
		);

	if (empty) return null;
	// Section mode (the phone info page): a faint label over a stack of plates,
	// like Git status or the changed-files list. No padding of its own, because
	// the page owns the inset.
	return (
		<div className={INFO_SECTION_CLASS}>
			<div className={cn(INFO_LABEL_CLASS, mergeStylexClassName("", sx.flex, sx.itemsCenter, sx.justifyBetween, sx.gap2))}>
				<span>Agents</span>
				{anyRunning && (
					<span {...stylex.props(sx.inlineFlex, sx.shrink0, sx.itemsCenter, sx.gap15, sx.textYellow)}>
						<span {...stylex.props(sx.size15, motionStyles.pulse, sx.roundedFull, sx.bgCurrent)} />
						running
					</span>
				)}
			</div>
			{cards}
		</div>
	);
}

/** Sub-agents the session spawned directly with the task tool (pi child
 *  sessions / Claude-SDK Task agents) — one card in the same visual grammar as
 *  a workflow run: StatusMark rows with agent-type/model chips, tokens and
 *  duration. Clicking a row opens the sub-agent's real conversation in the
 *  sub-agent view tab (the id doubles as the fetchSubagent key). */
function SubagentsCard({
	subagents,
	now,
	onOpen,
}: {
	subagents: SessionSubagentSnapshot[];
	now: number;
	onOpen?: (agentId: string, label: string) => void;
}) {
	const runningN = subagents.filter((s) => s.status === "running").length;
	const errorN = subagents.filter((s) => s.status === "error").length;
	const tokens = subagents.reduce((n, s) => n + (s.tokensOut ?? 0), 0);
	const meta: string[] = [
		`${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}`,
	];
	if (runningN) meta.push(`${runningN} running`);
	if (errorN) meta.push(`${errorN} failed`);
	if (tokens) meta.push(`${fmtTokens(tokens)} tok`);
	return (
		<div className={CARD_CLASS}>
			<div {...stylex.props(sx.px2, sx.pb25, sx.pt1)}>
				<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
					<span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.fontSemibold, sx.textFg, typography.label)}>
						Sub-agents
					</span>
					{runningN > 0 && (
						<Badge tone="warning" dot className={mergeStylexOverrideClassName("", motionStyles.pulse)}>
							running
						</Badge>
					)}
				</div>
				<div {...mergeStylexProps("", sx.tabularNums, sx.mt05, sx.truncate, sx.textFaint, typography.meta)}>
					{meta.join(" · ")}
				</div>
			</div>
			<div {...stylex.props(sx.flex, sx.flexCol)}>
				{subagents.map((s, i) => {
					const openable = Boolean(s.id && onOpen);
					const durMs =
						s.startedAt !== undefined
							? (s.endedAt ?? (s.status === "running" ? now : undefined)) !==
								undefined
								? (s.endedAt ?? now) - s.startedAt
								: undefined
							: undefined;
					return (
						<button
							key={s.id ?? `pending-${i}`}
							className={cn(
								ROW_CLASS,
								mergeStylexClassName("", sx.flexCol, sx.itemsStretch, sx.gap05),
								openable ? mergeStylexClassName("", sx.hoverBgHover) : mergeStylexClassName("", sx.cursorDefault),
							)}
							onClick={() => {
								if (s.id && onOpen) onOpen(s.id, s.label);
							}}
							title={openable ? "Open this sub-agent's conversation" : undefined}
						>
							<span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
								<StatusMark status={s.status} />
								<span {...stylex.props(sx.minW0, sx.flex1, sx.truncate, sx.textFg, typography.label)}>
									{s.label}
								</span>
								<AgentRail
									tokens={s.tokensOut}
									duration={durMs !== undefined ? fmtDuration(durMs) : ""}
								/>
							</span>
							{/* A sub-agent is asked for in a sentence, so its label wants
							    the whole line. What kind it is and what it runs on go
							    under it, the same second line a write agent gets. */}
							{(s.agentType || s.model) && (
								<span {...stylex.props(sx.truncate, sx.pl5, sx.textFaint, typography.meta)}>
									{[s.agentType, s.model && shortModel(s.model)]
										.filter(Boolean)
										.join(" · ")}
								</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** The discovery surface: with nothing running, this page is the only place
 *  that says workflows exist and how to start one. Same shape as every other
 *  empty surface, the EmptyState block over one card of rows, and short enough
 *  to read in a panel column. */
function WorkflowsEmptyState() {
	return (
		<div {...stylex.props(sx.grid, sx.gap4)}>
			<EmptyState
				icon={<IconStack size={22} />}
				title="No agents yet"
				className={mergeStylexOverrideClassName("", sx.px2, sx.py7)}
			>
				Ask this session to <span {...stylex.props(sx.textFg)}>use a workflow</span> and
				it fans out many small agents at once, then combines what they find.
			</EmptyState>
			<div {...stylex.props(sx.grid, sx.gap5px)}>
				<div className={INFO_LABEL_CLASS}>Try</div>
				<CardList as="ul" className={mergeStylexOverrideClassName("", sx.roundedLg)}>
					{[
						"Use a workflow to audit every route for missing auth checks.",
						"Use a workflow to compare 3 approaches and pick a winner.",
						"Use a workflow with write agents: one per file, then merge.",
					].map((s) => (
						<li key={s} {...stylex.props(sx.px3, sx.py25, sx.leadingSnug, sx.textDim, typography.label)}>
							{s}
						</li>
					))}
				</CardList>
			</div>
			<p {...stylex.props(sx.px2, sx.leadingSnug, sx.textFaint, typography.supporting)}>
				Agents read this worktree. Write agents each get their own branch, and
				merging back is explicit.
			</p>
		</div>
	);
}

function RunCard({
	run,
	now,
	onCancel,
	onOpenAgent,
}: {
	run: WorkflowRunSnapshot;
	now: number;
	onCancel: (runId: string) => void;
	onOpenAgent: (runId: string, seq: number) => void;
}) {
	// Expanded agent rows (by seq) + their lazily-fetched journal entries.
	const [openAgents, setOpenAgents] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	const [details, setDetails] = useState<
		Record<number, WorkflowJournalEntry | "loading" | "missing">
	>({});
	const [allLogs, setAllLogs] = useState(false);
	const [showResult, setShowResult] = useState(false);
	const [showMcp, setShowMcp] = useState(false);

	// Phase order: meta-seeded titles first, then first-seen agent phases;
	// agents without a phase render as a leading ungrouped block.
	const groups = (() => {
		const order: string[] = [];
		const seen = new Set<string>();
		for (const t of run.phases)
			if (!seen.has(t)) {
				seen.add(t);
				order.push(t);
			}
		for (const a of run.agents)
			if (a.phase && !seen.has(a.phase)) {
				seen.add(a.phase);
				order.push(a.phase);
			}
		const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
		for (const t of order) byPhase.set(t, []);
		const loose: WorkflowAgentSnapshot[] = [];
		for (const a of run.agents) {
			if (a.phase && byPhase.has(a.phase)) byPhase.get(a.phase)!.push(a);
			else loose.push(a);
		}
		return { order, byPhase, loose };
	})();

	const toggleAgent = (seq: number) => {
		setOpenAgents((prev) => {
			const next = new Set(prev);
			if (next.has(seq)) next.delete(seq);
			else next.add(seq);
			return next;
		});
	};

	const loadDetail = async (seq: number) => {
			setDetails((prev) => ({ ...prev, [seq]: "loading" }));
			await (async () => {
const res = await fetch(
					`${BASE_PATH}/api/workflows/${encodeURIComponent(run.runId)}/agents/${seq}`,
				);
				if (!res.ok) throw new Error(String(res.status));
				const data = (await res.json()) as
					| WorkflowJournalEntry
					| { entry?: WorkflowJournalEntry }
					| null;
				// Tolerate both a bare journal entry and an { entry } envelope.
				const entry =
					data && typeof data === "object" && "entry" in data
						? (data as { entry?: WorkflowJournalEntry }).entry
						: (data as WorkflowJournalEntry | null);
				if (!entry || typeof entry.prompt !== "string")
					throw new Error("bad shape");
				setDetails((prev) => ({ ...prev, [seq]: entry }));
})().catch(async () => {
setDetails((prev) => ({ ...prev, [seq]: "missing" }));
});
		};

	const startMs = new Date(run.startedAt).getTime();
	const elapsedMs =
		(run.endedAt
			? new Date(run.endedAt).getTime()
			: run.status === "running"
				? now
				: startMs) - startMs;
	const runningN = run.agents.filter((a) => a.status === "running").length;
	const errorN = run.agents.filter((a) => a.status === "error").length;
	const meta: string[] = [
		`${run.totals.agents} agent${run.totals.agents === 1 ? "" : "s"}`,
	];
	if (runningN) meta.push(`${runningN} running`);
	if (errorN) meta.push(`${errorN} failed`);
	// Direct mcp.* calls the script made — cheap work that never became an
	// agent row, so without this the panel understates what the run did.
	if (run.totals.mcpCalls) {
		const failed = run.totals.mcpErrors
			? `, ${run.totals.mcpErrors} failed`
			: "";
		meta.push(
			`${run.totals.mcpCalls} tool call${run.totals.mcpCalls === 1 ? "" : "s"}${failed}`,
		);
	}
	if (run.totals.tokensOut) meta.push(`${fmtTokens(run.totals.tokensOut)} tok`);
	if (elapsedMs > 0 || run.status === "running")
		meta.push(fmtDuration(elapsedMs));

	const openConversation = (seq: number) => onOpenAgent(run.runId, seq);

	function agentRow(a: WorkflowAgentSnapshot) {
		return (
			<AgentRow
				key={a.seq}
				a={a}
				open={openAgents.has(a.seq)}
				detail={details[a.seq]}
				// Precomputed string so the 1s ticker only re-renders rows whose
				// readout actually changes (running rows) — done rows memo-bail.
				duration={agentDuration(a, now)}
				onToggle={toggleAgent}
				onLoadDetail={loadDetail}
				onOpenConversation={openConversation}
			/>
		);
	}

	const tone = RUN_TONE[run.status];
	return (
		<div className={CARD_CLASS}>
			{/* The Stop button centres on the whole name + totals block rather
			    than aligning to the title, and the header keeps real air above
			    it: aligned to the first line it sat hard against the card's top
			    edge with the second line hanging below it, which read as
			    unbalanced. */}
			<div {...stylex.props(sx.flex, sx.itemsCenter, sx.justifyBetween, sx.gap2, sx.px2, sx.pb25, sx.pt1)}>
				<div {...stylex.props(sx.minW0)}>
					<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
						<span {...stylex.props(sx.truncate, sx.fontSemibold, sx.textFg, typography.label)}>
							{run.name}
						</span>
						{tone && (
							<Badge
								tone={tone}
								dot={run.status === "running"}
								className={cn(run.status === "running" && mergeStylexClassName("", motionStyles.pulse))}
							>
								{run.status}
							</Badge>
						)}
					</div>
					<div {...mergeStylexProps("", sx.tabularNums, sx.mt05, sx.truncate, sx.textFaint, typography.meta)}>
						{meta.join(" · ")}
					</div>
				</div>
				{run.status === "running" && (
					// The app's raised control, not the outlined red one: at this size
					// an outline chip is the same shape as the "running" badge beside
					// it, so the one thing on the card you can press read as another
					// state readout. Stopping a run is recoverable, so it does not
					// take the destructive weight either.
					<Button
						variant="default"
						size="sm"
						className={mergeStylexOverrideClassName("", sx.shrink0)}
						onClick={() => onCancel(run.runId)}
					>
						Stop
					</Button>
				)}
			</div>
			{(run.agents.length > 0 ||
				(run.status === "running" && groups.order.length > 0)) && (
				<div {...stylex.props(sx.flex, sx.flexCol)}>
					{groups.loose.map(agentRow)}
					{groups.order.map((title) => {
						const agents = groups.byPhase.get(title)!;
						// Empty phases only preview upcoming work on a live run.
						if (agents.length === 0 && run.status !== "running") return null;
						const doneN = agents.filter((a) => a.status === "done").length;
						return (
							<div key={title}>
								{/* The phase label sits quieter than the agent names under
								    it, and its count holds the rail's right edge, so a
								    group reads as a heading over rows. */}
								<div {...mergeStylexProps("first:pt-0.5", sx.flex, sx.itemsBaseline, sx.gap2, sx.px2, sx.pbPx, sx.pt2)}>
									<span
										className={cn(
											mergeStylexClassName("", sx.minW0, sx.flex1, sx.truncate, typography.meta, sx.fontMedium),
											run.status === "running" && title === run.currentPhase
												? mergeStylexClassName("", sx.textDim)
												: mergeStylexClassName("", sx.textFaint),
										)}
									>
										{title}
									</span>
									<span {...mergeStylexProps("", sx.tabularNums, sx.shrink0, sx.textFaint, typography.meta)}>
										{agents.length ? `${doneN}/${agents.length}` : "queued"}
									</span>
								</div>
								{agents.map(agentRow)}
							</div>
						);
					})}
				</div>
			)}
			{/* What the run left behind: its tool calls, its narration, its result.
			    One rule under the agent rows separates the readings from the work,
			    and each toggle is a row in the same shape as an agent above it
			    rather than a band of its own. */}
			{(!!run.mcpCalls?.length ||
				run.logs.length > 0 ||
				(run.status === "error" && run.error) ||
				(run.status === "done" && run.result !== undefined)) && (
				<div {...stylex.props(sx.mx2, sx.mt1, sx.borderT, sx.borderDivider)} />
			)}
			{!!run.mcpCalls?.length && (
				<div>
					<button className={FOOTER_ROW} onClick={() => setShowMcp((v) => !v)}>
						{showMcp ? "Hide" : "Show"} tool calls
						<span {...mergeStylexProps("", sx.tabularNums, sx.mlAuto, sx.shrink0, sx.textFaint)}>
							{run.totals.mcpCalls ?? run.mcpCalls.length}
						</span>
					</button>
					{showMcp && (
						<div {...stylex.props(sx.flex, sx.flexCol, sx.gap05, sx.px2, sx.pb15, sx.pt05)}>
							{run.mcpCalls.map((c, i) => (
								<div
									key={`${c.seq}-${i}`}
									{...stylex.props(sx.flex, sx.itemsBaseline, sx.gap2, sx.leadingSnug, typography.meta)}
								>
									<span
										className={cn(mergeStylexClassName("", sx.shrink0), c.ok ? mergeStylexClassName("", sx.textFaint) : mergeStylexClassName("", sx.textRed))}
									>
										{c.ok ? "·" : "✗"}
									</span>
									<span {...stylex.props(sx.truncate, sx.textDim)}>
										{c.server}.{c.tool}
									</span>
									<span {...mergeStylexProps("", sx.tabularNums, sx.mlAuto, sx.shrink0, sx.textFaint, typography.meta)}>
										{c.cached ? "cached" : `${c.ms}ms`}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{run.logs.length > 0 && (
				<div {...stylex.props(sx.px2, sx.py15)}>
					<div {...stylex.props(sx.flex, sx.flexCol, sx.gap05)}>
						{(allLogs ? run.logs : run.logs.slice(-20)).map((l, i) => (
							<div
								key={`${l.ts}-${i}`}
								{...stylex.props(sx.leadingSnug, sx.textFaint, typography.meta)}
							>
								{l.message}
							</div>
						))}
					</div>
					{run.logs.length > 20 && (
						<button {...mergeStylexProps("", sx.hoverTextFg, sx.mt1, sx.fontMedium, sx.textDim, sx.transitionColors, typography.meta)}
							onClick={() => setAllLogs((v) => !v)}
						>
							{allLogs ? "Show recent" : `Show all ${run.logs.length}`}
						</button>
					)}
				</div>
			)}
			{run.status === "error" && run.error && (
				<div {...stylex.props(sx.px2, sx.py15, sx.leadingSnug, sx.textRed, typography.meta)}>
					{run.error}
				</div>
			)}
			{run.status === "done" && run.result !== undefined && (
				<div>
					<button
						className={FOOTER_ROW}
						onClick={() => setShowResult((v) => !v)}
					>
						{showResult ? "Hide result" : "Show result"}
					</button>
					{showResult && (
						<div {...stylex.props(sx.px2, sx.pb15, sx.pt05)}>
							<DetailPre
								text={
									typeof run.result === "string"
										? run.result
										: JSON.stringify(run.result, null, 2)
								}
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** One agent row + its lazy drill-in. Memoized so the 1s elapsed ticker only
 *  re-renders rows whose props change (running rows get a new `duration`
 *  string; settled rows bail) — a 200-agent run must not re-render thousands
 *  of nodes per second. The drill-in body mounts only while expanded: the 0fr
 *  grid wrapper stays mounted so the expand still animates (enter-only —
 *  collapse unmounts the content immediately). */
const AgentRow = function AgentRow({
	a,
	open,
	detail,
	duration,
	onToggle,
	onLoadDetail,
	onOpenConversation,
}: {
	a: WorkflowAgentSnapshot;
	open: boolean;
	detail: WorkflowJournalEntry | "loading" | "missing" | undefined;
	duration: string;
	onToggle: (seq: number) => void;
	onLoadDetail: (seq: number) => void;
	onOpenConversation: (seq: number) => void;
}) {
	const full = typeof detail === "object" ? detail : undefined;
	const promptText = full?.prompt ?? a.promptPreview;
	const resultText = full
		? (full.outcome.error ??
			(full.outcome.structured !== undefined
				? JSON.stringify(full.outcome.structured, null, 2)
				: full.outcome.text))
		: (a.error ?? a.resultPreview);
	return (
		<>
			<button
				className={cn(ROW_CLASS, mergeStylexClassName("", sx.flexCol, sx.itemsStretch, sx.gap05, sx.hoverBgHover))}
				aria-expanded={open}
				onClick={() => onToggle(a.seq)}
			>
				<span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
					<StatusMark status={a.status} />
					<span
						className={cn(
							mergeStylexClassName("", sx.minW0, sx.flex1, sx.truncate, typography.label),
							a.status === "cancelled" ? mergeStylexClassName("", sx.textFaint, sx.lineThrough) : mergeStylexClassName("", sx.textFg),
						)}
					>
						{a.label}
					</span>
					{a.cached && <Chip>cached</Chip>}
					<AgentRail
						model={a.model}
						tokens={a.tokens?.output}
						duration={duration}
					/>
				</span>
				{a.write && <WriteLine a={a} />}
			</button>
			<div
				className={cn(
					mergeStylexClassName("", sx.grid, sx.transitionGridTemplateRows, sx.duration200, sx.easeOut),
					open
						? mergeStylexClassName("", sx.GridTemplateRows1fr)
						: mergeStylexClassName("", sx.GridTemplateRows0fr),
				)}
			>
				<div {...stylex.props(sx.minH0, sx.overflowHidden)}>
					{open && (
						<div {...stylex.props(sx.mx1, sx.mb15, sx.mt05, sx.flex, sx.flexCol, sx.gap15, sx.roundedMd, sx.bgHover, sx.p2)}>
							{/* The headline affordance: what the agent actually DID, not
							    just what it said at the end. Available even while it runs
							    (the transcript view polls). */}
							{a.status !== "pending" && (
								<Button
									size="sm"
									className={mergeStylexOverrideClassName("", sx.selfStart)}
									onClick={() => onOpenConversation(a.seq)}
								>
									View conversation
									<span {...stylex.props(sx.textFaint)}>→</span>
								</Button>
							)}
							<div {...stylex.props(sx.fontMedium, sx.textFaint, typography.meta)}>Prompt</div>
							<DetailPre text={promptText} />
							{(resultText || a.status === "error") && (
								<>
									<div
										className={cn(
											mergeStylexClassName("", typography.meta, sx.fontMedium),
											a.status === "error" || full?.outcome.error
												? mergeStylexClassName("", sx.textRed)
												: mergeStylexClassName("", sx.textFaint),
										)}
									>
										{a.status === "error" || full?.outcome.error
											? "Error"
											: "Result"}
									</div>
									<DetailPre text={resultText || "(no output)"} />
								</>
							)}
							{detail === undefined &&
								(a.status === "done" || a.status === "error") && (
									<button {...mergeStylexProps("", sx.hoverUnderline, sx.selfStart, sx.fontMedium, sx.textLink, typography.meta)}
										onClick={() => onLoadDetail(a.seq)}
									>
										Show full prompt & result
									</button>
								)}
							{detail === "loading" && (
								<span {...stylex.props(sx.textFaint, typography.meta)}>Loading…</span>
							)}
							{detail === "missing" && (
								// Transient failures happen (the snapshot flips done before
								// the journal entry lands) — keep the miss retryable.
								<button {...mergeStylexProps("", sx.hoverUnderline, sx.selfStart, sx.fontMedium, sx.textLink, typography.meta)}
									onClick={() => onLoadDetail(a.seq)}
								>
									Couldn't load the full record. Retry
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</>
	);
};
