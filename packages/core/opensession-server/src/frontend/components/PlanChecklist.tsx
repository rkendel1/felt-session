import type { PlanItem } from "@tellahq/opensession-protocol/todo-plan";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	pl22px: {
			paddingLeft: "22px"
	},
  textFaint: { color: "var(--text-faint)" },
  list: {
    margin: 0,
    display: "flex",
    listStyle: "none",
    flexDirection: "column",
    gap: "6px",
    padding: 0,
    lineHeight: "16px",
  },
  row: { display: "flex", minWidth: 0, alignItems: "flex-start", gap: "8px" },
  fontMedium: { fontWeight: "var(--font-weight-medium)" },
  textFg: { color: "var(--text)" },
  textDim: { color: "var(--text-dim)" },
  mark: {
    marginTop: "4px",
    width: "8px",
    height: "8px",
    flex: "none",
    borderRadius: "50%",

		cornerShape: "var(--cs)",},
  bgGreen: { backgroundColor: "var(--green)" },
  bgYellow: { backgroundColor: "var(--yellow)" },
  live: { animation: "composer-agents-pulse 1.4s ease-in-out infinite" },
  pending: {
    borderColor: "var(--border)",
    borderStyle: "solid",
    borderWidth: "1px",
	},
});

/**
 * The model's plan rendered as a checklist — shared by the status flap above
 * the composer and the expanded TodoWrite row in the transcript, so the same
 * list reads the same way in both places. See packages/core/protocol/src/todo-plan.ts for why this is
 * "Plan" and not "todos".
 */
interface Props {
	items: readonly PlanItem[];
	/** Cap the rendered rows; the remainder folds into a "+N more" line. */
	max?: number;
	/** Pulse the current step when this checklist represents a live run. */
	live?: boolean;
	className?: string;
}

export function PlanChecklist({ items, max, live = false, className }: Props) {
	const shown = max && items.length > max ? items.slice(0, max) : items;
	const hidden = items.length - shown.length;
	return (
    <ol {...mergeStylexProps(className, sx.list, typography.label)}>
			{shown.map((item, i) => (
				<li
					key={`${i}-${item.content}`}
          {...stylex.props(
            sx.row,
            item.status === "in_progress" && sx.fontMedium,
            item.status === "in_progress" && sx.textFg,
            item.status === "completed" && sx.textDim,
            item.status === "pending" && sx.textFaint,
					)}
				>
					<PlanMark status={item.status} live={live} />
					<span {...stylex.props(sx.minW0, sx.flex1)}>{item.content}</span>
				</li>
			))}
      {hidden > 0 && (
        <li {...stylex.props(sx.pl22px, sx.textFaint)}>+{hidden} more</li>
      )}
		</ol>
	);
}

/** One quiet marker language: green when done, amber while active, and an
 *  empty ring for what's still ahead. */
function PlanMark({
  status,
  live,
}: {
  status: PlanItem["status"];
  live: boolean;
}) {
	return (
		<span
      {...stylex.props(
        sx.mark,
        status === "completed" && sx.bgGreen,
        status === "in_progress" && sx.bgYellow,
        status === "in_progress" && live && sx.live,
        status === "pending" && sx.pending,
			)}
		/>
	);
}
