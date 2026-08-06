import React, { useMemo, useState } from "react";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import type { SessionSubagentSnapshot } from "../lib/api";
import { currentPlanItem, planDoneCount, type PlanItem } from "../lib/todo-plan";
import { cn } from "../ui/cn";
import { IconChevronDown, IconChevronRight } from "./icons";
import { PlanChecklist } from "./PlanChecklist";

/**
 * The run-status flap above the composer: what this session is doing right
 * now, as a three-step progression.
 *
 *   collapsed pill  →  expanded mini-card  →  full Agents panel
 *
 * It carries two things the transcript hides:
 *
 * - **Plan** — the model's own `todowrite` checklist (lib/todo-plan.ts).
 *   Otherwise it exists only as one dim row inside a collapsed turn fold, so
 *   this is its only glance. Shown at every width, and only while the run is
 *   live (the caller gates that) — a finished turn's plan belongs to the
 *   transcript.
 * - **Agents** — running workflow runs and task-tool sub-agents. Phone-only,
 *   because on desktop the Agents panel tab is always visible with its own
 *   pulsing dot; on a phone that panel is behind a closed overlay.
 *
 * Either half can be absent: with no agents the card is just the plan, and the
 * "Open full panel" hand-off (which is agent-scoped) drops out with them. The
 * parent unmounts us when both are empty.
 *
 * The queue flap next door is deliberately separate: that one is pending user
 * input with destructive/drag actions, this one is read-only run status.
 */
interface Props {
	runs: WorkflowRunSnapshot[];
	subagents?: SessionSubagentSnapshot[];
	plan?: readonly PlanItem[];
	onOpenPanel: () => void;
}

/** The tally/label subset both agent flavors share. */
interface GlanceAgent {
	key: string;
	label: string;
	status: string;
	phase?: string;
}

// Expanded/collapsed sticks across turns: the flap unmounts whenever the run
// ends, so without this someone watching a long plan re-expands every turn.
const OPEN_KEY = "opensession-composer-status-open";

export function ComposerAgents({ runs, subagents, plan, onOpenPanel }: Props) {
	const [open, setOpen] = useState(
		() => localStorage.getItem(OPEN_KEY) === "1",
	);
	function toggle() {
		setOpen((v) => {
			const next = !v;
			if (next) localStorage.setItem(OPEN_KEY, "1");
			else localStorage.removeItem(OPEN_KEY);
			return next;
		});
	}

	const stats = useMemo(() => {
		const agents: GlanceAgent[] = [
			...runs.flatMap((r) =>
				r.agents.map((a) => ({
					key: `wf-${r.runId}-${a.seq}`,
					label: a.label,
					status: a.status,
					phase: a.phase,
				})),
			),
			...(subagents ?? []).map((s, i) => ({
				key: s.id ?? `sub-${i}`,
				label: s.label,
				status: s.status,
			})),
		];
		const running = agents.filter((a) => a.status === "running");
		const done = agents.filter((a) => a.status === "done").length;
		const pending = agents.filter((a) => a.status === "pending").length;
		const error = agents.filter((a) => a.status === "error").length;
		const single = runs.length === 1 ? runs[0] : null;
		const steps = single?.phases ?? [];
		// currentPhase is a title; its index in the ordered phases list is the
		// step number. -1 (unknown/absent) → treat as the first step.
		const curIdx = single?.currentPhase
			? Math.max(0, steps.indexOf(single.currentPhase))
			: 0;
		return {
			total: agents.length,
			running,
			runningCount: running.length,
			done,
			pending,
			error,
			single,
			steps,
			curIdx,
			phase: single?.currentPhase,
		};
	}, [runs, subagents]);

	const {
		total,
		running,
		runningCount,
		done,
		pending,
		error,
		single,
		steps,
		curIdx,
		phase,
	} = stats;

	const planItems = plan ?? [];
	const planTotal = planItems.length;
	const planDone = planDoneCount(planItems);
	const planStep = currentPlanItem(planItems);

	return (
		<div className="composer-agents" data-open={open ? "" : undefined}>
			{open && (
				<div className="composer-agents-detail">
					{planTotal > 0 && (
						<div className="composer-agents-plan">
							{/* The pill right below already reads "Plan · 2/5"; the title
							    only earns its line when there's an agents section under
							    it to be told apart from. */}
							{total > 0 && (
								<div className="composer-agents-name">
									Plan · {planDone}/{planTotal}
								</div>
							)}
							<PlanChecklist items={planItems} max={6} />
						</div>
					)}

					{total > 0 && (
						<div
							className={cn(
								"composer-agents-section",
								planTotal > 0 && "has-divider",
							)}
						>
							<div className="composer-agents-name">
								{single
									? single.name
									: runs.length > 0
										? `${runs.length} workflows running`
										: "Sub-agents"}
							</div>

							{steps.length > 1 && (
								<ol className="composer-agents-steps">
									{steps.map((s, i) => (
										<li
											key={s}
											className={cn(
												"composer-agents-step",
												i < curIdx && "is-done",
												i === curIdx && "is-current",
											)}
										>
											<span className="composer-agents-step-mark">
												{i < curIdx ? "✓" : i + 1}
											</span>
											<span className="composer-agents-step-label">{s}</span>
										</li>
									))}
								</ol>
							)}

							<div className="composer-agents-tallies">
								<span>
									<i className="composer-agents-dot" />
									{runningCount} running
								</span>
								{done > 0 && (
									<span className="is-done">
										{done}/{total} done
									</span>
								)}
								{pending > 0 && <span className="is-dim">{pending} queued</span>}
								{error > 0 && <span className="is-error">{error} failed</span>}
							</div>

							{running.length > 0 && (
								<ul className="composer-agents-list">
									{running.slice(0, 4).map((a) => (
										<li key={a.key}>
											<i className="composer-agents-dot sm" />
											<span className="composer-agents-list-label">
												{a.label}
											</span>
											{a.phase && single?.phases?.length !== 1 ? (
												<span className="is-dim"> · {a.phase}</span>
											) : null}
										</li>
									))}
									{running.length > 4 && (
										<li className="is-dim">+{running.length - 4} more</li>
									)}
								</ul>
							)}

							<button
								type="button"
								className="composer-agents-open"
								onClick={onOpenPanel}
							>
								Open full panel
								<IconChevronRight size={15} />
							</button>
						</div>
					)}
				</div>
			)}

			<button
				type="button"
				className="composer-agents-summary"
				aria-expanded={open}
				aria-label={open ? "Collapse run status" : "Show run status"}
				onClick={toggle}
			>
				<span className="composer-agents-dot" />
				<span className="composer-agents-label">
					{total > 0 ? (
						<>
							<strong>{runningCount} running</strong>
							{total > runningCount ? (
								<span className="is-dim">
									{" "}
									· {done}/{total} done
								</span>
							) : null}
							{planTotal > 0 ? (
								<span className="is-dim">
									{" "}
									· Plan {planDone}/{planTotal}
								</span>
							) : !open && phase ? (
								<span className="is-dim"> · {phase}</span>
							) : null}
						</>
					) : (
						<>
							<strong>
								Plan · {planDone}/{planTotal}
							</strong>
							{!open && planStep ? (
								<span className="is-dim"> · {planStep}</span>
							) : null}
						</>
					)}
				</span>
				<IconChevronDown
					size={16}
					className={cn("composer-agents-caret", open && "is-open")}
				/>
			</button>
		</div>
	);
}
