import type { AnsweredAskData } from "@tellahq/opensession-protocol/notices";
import {
	ANSWER_OPTION_LETTERS,
	answeredAskState,
} from "../lib/answered-ask";
import { renderMarkdown } from "../lib/markdown";
import { msgRow } from "../lib/msg-classes";
import { IconCheck } from "./icons";
import { useMarkdownRepo } from "./MarkdownBody";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	w35: {
			width: "14px"
	},
	shrink0: {
			flexShrink: "0"
	},
	ptPx: {
			paddingTop: "1px"
	},
	leading5: {
			lineHeight: "20px"
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
	selfEnd: {
			alignSelf: "flex-end"
	},
	rounded2xl: {
			borderRadius: "calc(22px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	p4: {
			padding: "16px"
	},
	CornerShapeVarCs: {
			cornerShape: "var(--cs)"
	},
	flex: {
			display: "flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gapX15: {
			columnGap: "6px"
	},
	gapY05: {
			rowGap: "2px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	h4: {
			height: "16px"
	},
	w4: {
			width: "16px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	bgGreenSoft: {
			backgroundColor: "var(--green-soft)"
	},
	textGreen: {
			color: "var(--green)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mt3: {
			marginTop: "12px"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap4: {
			gap: "16px"
	},
	mb1: {
			marginBottom: "4px"
	},
	OverflowWrapAnywhere: {
			overflowWrap: "anywhere"
	},
	TextWrapPretty: {
			textWrap: "pretty"
	},
	mt2: {
			marginTop: "8px"
	},
	gap05: { gap: "2px" },
	minH9: { minHeight: "36px" },
	itemsStart: { alignItems: "flex-start" },
	gap25: { gap: "10px" },
	roundedMd: { borderRadius: "calc(7px * var(--rf))" ,
		cornerShape: "var(--cs)"},
	px25: { paddingInline: "10px" },
	py2: { paddingBlock: "8px" },
	bgControl: { backgroundColor: "var(--control-surface)" },
	block: { display: "block" },
	fontMedium: { fontWeight: "var(--font-weight-medium)" },
	textFg: { color: "var(--text)" },
	leading145: { lineHeight: 1.45 },
	textTransparent: { color: "transparent" },
	mt05: { marginTop: "2px" },
	h5: { height: "20px" },
	w5: { width: "20px" },

	maxWMin600px90: {
		"maxWidth": "min(600px,90%)"
	},
});

function ChoiceRow({
	letter,
	label,
	description,
	selected,
}: {
	letter: string;
	label: string;
	description?: string;
	selected: boolean;
}) {
	return (
		<div
			role="listitem"
			aria-label={`${label}${selected ? ", selected" : ""}`}
			data-selected={selected ? "" : undefined}
			{...mergeStylexProps("", sx.CornerShapeVarCs, sx.flex, sx.minH9, sx.itemsStart, sx.gap25, sx.roundedMd, sx.px25, sx.py2, selected ? sx.bgControl : sx.textDim)}
		>
			<span {...stylex.props(sx.w35, sx.shrink0, sx.ptPx, sx.leading5, sx.textFaint, typography.meta)}>
				{letter}
			</span>
			<span {...stylex.props(sx.minW0, sx.flex1)}>
				<span
					{...mergeStylexProps("", sx.OverflowWrapAnywhere, sx.block, typography.controlLabel, sx.leading5, selected ? sx.fontSemibold : sx.fontMedium, selected && sx.textFg)}
				>
					{label}
				</span>
				{description && (
					<span
						{...mergeStylexProps("", sx.OverflowWrapAnywhere, sx.mt05, sx.block, typography.supporting, sx.leading145, selected ? sx.textDim : sx.textFaint)}
					>
						{description}
					</span>
				)}
			</span>
			<span
				aria-hidden="true"
				{...stylex.props(sx.flex, sx.h5, sx.w5, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, selected ? sx.bgGreenSoft : sx.textTransparent, selected && sx.textGreen)}
			>
				<IconCheck size={16} />
			</span>
		</div>
	);
}

/** A durable receipt for an answer sent through AskCard. It sits on the
 * sender side of the transcript, while its quiet surface and status label
 * distinguish it from an ordinary message. Every offered option stays for
 * context, with the exact choice marked as selected. */
export function AnsweredAskCard({
	record,
	entryId,
}: {
	record: AnsweredAskData;
	entryId: string;
}) {
	const repo = useMarkdownRepo();
	const count = record.questions.length;
	const lone = count === 1 ? record.questions[0] : undefined;

	return (
		<div className={msgRow} data-eid={entryId} data-answered-ask="">
			<div {...mergeStylexProps("", sx.maxWMin600px90, sx.selfEnd, sx.rounded2xl, sx.bgPanel, sx.p4, sx.CornerShapeVarCs)}>
				<div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gapX15, sx.gapY05, sx.fontSemibold, typography.label)}>
					<span
						aria-hidden="true"
						{...stylex.props(sx.flex, sx.h4, sx.w4, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgGreenSoft, sx.textGreen)}
					>
						<IconCheck size={14} />
					</span>
					<span {...stylex.props(sx.textDim)}>
						{count === 1 ? "Answer sent" : `${count} answers sent`}
					</span>
					{lone?.header && (
						<>
							<span aria-hidden="true" {...stylex.props(sx.textFaint)}>
								·
							</span>
							<span {...stylex.props(sx.textFaint)}>{lone.header}</span>
						</>
					)}
				</div>

				<div {...stylex.props(sx.mt3, sx.flex, sx.flexCol, sx.gap4)}>
					{record.questions.map((question, index) => {
						const { selected, typed } = answeredAskState(question);
						const options = question.options ?? [];
						return (
							<section key={`${question.question}:${index}`}>
								{question.header && !lone && (
									<div {...stylex.props(sx.mb1, sx.fontSemibold, sx.textFaint, typography.meta)}>
										{question.header}
									</div>
								)}
								<div {...mergeStylexProps("markdown", sx.leading5, sx.textDim, sx.OverflowWrapAnywhere, sx.TextWrapPretty, typography.controlLabel)}
									dangerouslySetInnerHTML={{
										__html: renderMarkdown(question.question, { repo }),
									}}
								/>
								<div
									{...stylex.props(sx.mt2, sx.flex, sx.flexCol, sx.gap05)}
									role="list"
									aria-label="Answer choices"
								>
									{options.map((option, optionIndex) => (
										<ChoiceRow
											key={`${option.label}:${optionIndex}`}
											letter={ANSWER_OPTION_LETTERS[optionIndex] ?? "–"}
											label={option.label}
											description={option.description}
											selected={selected.has(option.label)}
										/>
									))}
									{typed.map((answer, typedIndex) => (
										<ChoiceRow
											key={`${answer}:${typedIndex}`}
											letter="–"
											label={answer}
											description={options.length ? "Custom answer" : undefined}
											selected
										/>
									))}
									{!question.answer.trim() && (
										<ChoiceRow letter="–" label="No answer" selected />
									)}
								</div>
							</section>
						);
					})}
				</div>
			</div>
		</div>
	);
}
