import React, { useEffect, useEffectEvent, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { fetchSessionReports } from "../lib/api";
import type { ReportMeta, WSServerMessage } from "../lib/types";
import { type NewSessionPrefill } from "../lib/new-session-link";
import { OptionSelect } from "../ui/select";
import { ReportFrame } from "./ReportFrame";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	hFull: {
			height: "100%"
	},
	minH0: {
			minHeight: "0"
	},
	flexCol: {
			flexDirection: "column"
	},
	shrink0: {
			flexShrink: "0"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	px3: {
			paddingInline: "12px"
	},
	py25: {
			paddingBlock: "10px"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	gap2: {
			gap: "8px"
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
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt05: {
			marginTop: "2px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px15: {
			paddingInline: "6px"
	},
	py05: {
			paddingBlock: "2px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mt2: {
			marginTop: "8px"
	},
	m0: {
			margin: "0"
	},
	leading5: {
			lineHeight: "20px"
	},

	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
});

export function useSessionReports(
	sessionId: string,
	addHandler: (handler: (message: WSServerMessage) => void) => () => void,
) {
	const [reports, setReports] = useState<ReportMeta[]>([]);
	const refresh = useEffectEvent(() => {
		fetchSessionReports(sessionId)
			.then(setReports)
			.catch(() => {});
	});
	useEffect(() => {
		setReports([]);
		refresh();
	}, [sessionId]);
	useEffect(
		() =>
			addHandler((message) => {
				if (
					message.type === "reports_changed" &&
					message.sessionId === sessionId
				)
					refresh();
			}),
		[addHandler, sessionId],
	);
	return reports;
}

function formatDate(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

function reportKey(report: ReportMeta): string {
	return `${report.automationId}/${report.id}`;
}

export function SessionReportsPanel({
	reports,
	onOpenNewSession,
}: {
	reports: ReportMeta[];
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const selected =
		reports.find((report) => reportKey(report) === selectedKey) ||
		reports[0] ||
		null;

	useEffect(() => {
		if (
			!selectedKey ||
			!reports.some((report) => reportKey(report) === selectedKey)
		)
			setSelectedKey(reports[0] ? reportKey(reports[0]) : null);
	}, [reports, selectedKey]);

	if (!selected) return null;
	const fullReportUrl =
		`${BASE_PATH}/reports/${encodeURIComponent(selected.automationId)}` +
		`/${encodeURIComponent(selected.id)}`;

	return (
		<div {...stylex.props(sx.flex, sx.hFull, sx.minH0, sx.flexCol)}>
			<div {...stylex.props(sx.shrink0, sx.borderB, sx.borderDivider, sx.px3, sx.py25)}>
				<div {...stylex.props(sx.flex, sx.itemsStart, sx.gap2)}>
					<div {...stylex.props(sx.minW0, sx.flex1)}>
						<div {...stylex.props(sx.truncate, sx.fontSemibold, sx.textFg, typography.label)}>
							{selected.title}
						</div>
						<div {...stylex.props(sx.mt05, sx.textFaint, typography.meta)}>
							{formatDate(selected.createdAt)}
						</div>
					</div>
					<a {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.shrink0, sx.roundedSm, sx.px15, sx.py05, sx.textDim, typography.meta)}
						href={fullReportUrl}
					>
						Open full report
					</a>
				</div>
				{reports.length > 1 && (
					<OptionSelect
						size="sm"
						label="Report from this session"
						className={mergeStylexOverrideClassName("", sx.mt2)}
						value={reportKey(selected)}
						options={reports.map((report) => ({
							value: reportKey(report),
							label: `${report.title} · ${formatDate(report.createdAt)}`,
						}))}
						onChange={setSelectedKey}
					/>
				)}
				{selected.summary && (
					<p {...stylex.props(sx.m0, sx.mt2, sx.leading5, sx.textDim, typography.label)}>
						{selected.summary}
					</p>
				)}
			</div>
			<ReportFrame
				automationId={selected.automationId}
				reportId={selected.id}
				title={selected.title}
				onOpenNewSession={onOpenNewSession}
			/>
		</div>
	);
}
