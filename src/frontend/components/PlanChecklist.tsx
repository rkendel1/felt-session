import type { PlanItem } from "../lib/todo-plan";
import { cn } from "../ui/cn";
import { IconCheck } from "./icons";

/**
 * The model's plan rendered as a checklist — shared by the status flap above
 * the composer and the expanded TodoWrite row in the transcript, so the same
 * list reads the same way in both places. See lib/todo-plan.ts for why this is
 * "Plan" and not "todos".
 */
interface Props {
	items: readonly PlanItem[];
	/** Cap the rendered rows; the remainder folds into a "+N more" line. */
	max?: number;
	className?: string;
}

export function PlanChecklist({ items, max, className }: Props) {
	const shown = max && items.length > max ? items.slice(0, max) : items;
	const hidden = items.length - shown.length;
	return (
		<ol
			className={cn(
				"m-0 flex list-none flex-col gap-1.5 p-0 text-label leading-4",
				className,
			)}
		>
			{shown.map((item, i) => (
				<li
					key={`${i}-${item.content}`}
					className={cn(
						"flex min-w-0 items-baseline gap-2",
						item.status === "in_progress" && "font-medium text-fg",
						item.status === "completed" && "text-dim",
						item.status === "pending" && "text-faint",
					)}
				>
					<PlanMark status={item.status} />
					<span className="min-w-0 flex-1">{item.content}</span>
				</li>
			))}
			{hidden > 0 && <li className="pl-[22px] text-faint">+{hidden} more</li>}
		</ol>
	);
}

/** 14px status mark: a green check when done, a filled dot for the current
 *  step, an empty ring for what's still ahead. Self-centred because the row
 *  aligns on the text baseline. */
function PlanMark({ status }: { status: PlanItem["status"] }) {
	if (status === "completed") {
		return (
			<span className="flex size-[14px] flex-none translate-y-[2px] items-center justify-center rounded-full bg-green-soft text-green">
				<IconCheck size={12} />
			</span>
		);
	}
	return (
		<span
			className={cn(
				"flex size-[14px] flex-none translate-y-[2px] items-center justify-center rounded-full border",
				status === "in_progress" ? "border-green" : "border-line",
			)}
		>
			{status === "in_progress" && (
				<span className="size-[6px] rounded-full bg-green" />
			)}
		</span>
	);
}
