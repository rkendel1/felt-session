import React, { useCallback, useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import type { TodoItem, WSServerMessage } from "../lib/types";
import { Button } from "../ui/button";
import { Card, CardList } from "../ui/card";
import { PageDescription, PageHeader, PageTitle } from "../ui/page-header";
import { EmptyState } from "../ui/state";
import { getCurrentUser } from "./UserPicker";
import { IconCheck, IconListCircles, IconPlus, IconX } from "./icons";
import { Input } from "../ui/input";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minH11: {
			minHeight: "44px"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap3: {
			gap: "12px"
	},
	px3: {
			paddingInline: "12px"
	},
	py25: {
			paddingBlock: "10px"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	mt05: {
			marginTop: "2px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	mt1: {
			marginTop: "4px"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	gapX25: {
			columnGap: "10px"
	},
	gapY1: {
			rowGap: "4px"
	},
	underline: {
			textDecorationLine: "underline"
	},
	decorationDotted: {
			textDecorationStyle: "dotted"
	},
	underlineOffset2: {
			textUnderlineOffset: "2px"
	},
	shrink0: {
			flexShrink: "0"
	},
	hFull: {
			height: "100%"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	px4: {
			paddingInline: "16px"
	},
	py5: {
			paddingBlock: "20px"
	},
	mxAuto: {
			marginInline: "auto"
	},
	maxW760px: {
			maxWidth: "760px"
	},
	mb5: {
			marginBottom: "20px"
	},
	gap2: {
			gap: "8px"
	},
	mb3: {
			marginBottom: "12px"
	},
	textRed: {
			color: "var(--red)"
	},
	py8: {
			paddingBlock: "32px"
	},
	textCenter: {
			textAlign: "center"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	roundedXl: {
			borderRadius: "calc(18px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgRaised: {
			backgroundColor: "var(--bg-raised)"
	},
	mt5: {
			marginTop: "20px"
	},
	mb2: {
			marginBottom: "8px"
	},
	minH10: {
			minHeight: "40px"
	},
  fontMedium: { fontWeight: "var(--font-weight-medium)" },
  check: {
    display: "flex",
    width: "24px",
    height: "24px",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    borderStyle: "solid",
    borderWidth: "1px",
    transitionProperty: "color, background-color, border-color",
    ":active": { scale: 0.96 },

		cornerShape: "var(--cs)",},
  checkDone: {
    borderColor: "var(--green)",
    backgroundColor: "var(--green)",
    color: "var(--bg-panel)",
  },
  checkPending: {
    borderColor: "var(--border-strong)",
    color: "transparent",
    ":hover": { "@media (hover: hover)": {
      borderColor: "color-mix(in srgb, var(--text) 50%, transparent)",
    } },
  },
  taskTitle: { fontWeight: "var(--font-weight-medium)", color: "var(--text)" },
  done: { color: "var(--text-dim)", textDecorationLine: "line-through" },
  lineThrough: { textDecorationLine: "line-through" },

	smPx4: {
		"@media (min-width: 40rem)": {
			"paddingInline": "16px"
		}
	},
	hoverTextDim: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text-dim)"
			}
		}
	},
	smPx7: {
		"@media (min-width: 40rem)": {
			"paddingInline": "28px"
		}
	},
	smPy7: {
		"@media (min-width: 40rem)": {
			"paddingBlock": "28px"
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

interface TasksProps {
	addHandler: (handler: (message: WSServerMessage) => void) => () => void;
	onOpenSession: (sessionId: string) => void;
}

function formatReminder(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const now = new Date();
	const time = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	if (date.toDateString() === now.toDateString()) return time;
	if (Math.abs(date.getTime() - now.getTime()) < 6 * 86_400_000)
		return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function TaskRow({
	task,
	onToggle,
	onDrop,
	onOpenSession,
}: {
	task: TodoItem;
	onToggle: (task: TodoItem) => void;
	onDrop: (task: TodoItem) => void;
	onOpenSession: (sessionId: string) => void;
}) {
	const done = task.status === "done";
	return (
    <li
      {...mergeStylexProps("group", sx.smPx4, sx.flex, sx.minH11, sx.itemsCenter, sx.gap3, sx.px3, sx.py25)}
    >
			<button
				type="button"
        {...stylex.props(sx.check, done ? sx.checkDone : sx.checkPending)}
				onClick={() => onToggle(task)}
				aria-label={done ? `Reopen ${task.text}` : `Mark ${task.text} done`}
			>
				<IconCheck size={14} />
			</button>
			<div {...stylex.props(sx.minW0, sx.flex1)}>
				<div
          {...stylex.props(sx.taskTitle, done && sx.done, typography.itemTitle)}
				>
					{task.text}
				</div>
				{task.note && (
          <div {...stylex.props(sx.mt05, sx.textFaint, typography.label)}>
            {task.note}
          </div>
				)}
				{(task.due || (task.remindAt && !done) || task.source.sessionId) && (
          <div
            {...stylex.props(
              sx.mt1,
              sx.flex,
              sx.flexWrap,
              sx.itemsCenter,
              sx.gapX25,
              sx.gapY1,
              sx.textFaint,
              typography.label,
            )}
          >
						{task.due && <span>Due {task.due}</span>}
						{task.remindAt && !done && (
              <span
                {...stylex.props(Boolean(task.remindedAt) && sx.lineThrough)}
              >
								{task.remindedAt ? "Reminded" : "Reminder"}{" "}
								{formatReminder(task.remindAt)}
							</span>
						)}
						{task.source.sessionId && (
							<button
								type="button"
                {...mergeStylexProps("", sx.hoverTextDim, sx.underline, sx.decorationDotted, sx.underlineOffset2)}
								onClick={() => onOpenSession(task.source.sessionId!)}
							>
								Open source
							</button>
						)}
					</div>
				)}
			</div>
			{!done && (
				<Button
					variant="ghost"
					size="md"
					className={mergeStylexOverrideClassName("", sx.shrink0, sx.textFaint)}
					onClick={() => onDrop(task)}
					aria-label={`Drop ${task.text}`}
					title="Drop task"
					icon={<IconX size={16} />}
				/>
			)}
		</li>
	);
}

export function Tasks({ addHandler, onOpenSession }: TasksProps) {
	const user = getCurrentUser();
	const [tasks, setTasks] = useState<TodoItem[] | null>(null);
	const [draft, setDraft] = useState("");
	const [showDone, setShowDone] = useState(false);
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		await (async () => {
const response = await fetch(
				`${BASE_PATH}/api/todos?status=all&user=${encodeURIComponent(user)}`,
			);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = (await response.json()) as { todos?: TodoItem[] };
			setTasks(data.todos || []);
			setError(null);
})().catch(async () => {
setTasks((current) => current ?? []);
			setError("Tasks could not be loaded.");
});
	}, [user]);

	useEffect(() => {
		document.title = docTitle("Tasks");
		void load();
		return () => {
			document.title = DEFAULT_DOC_TITLE;
		};
	}, [load]);

	useEffect(
		() =>
			addHandler((message) => {
				if (message.type === "todos_changed") void load();
			}),
		[addHandler, load],
	);

	async function patchTask(id: string, patch: Record<string, unknown>) {
		await (async () => {
const response = await fetch(
				`${BASE_PATH}/api/todos/${encodeURIComponent(id)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...patch, user }),
				},
			);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			setError(null);
    })()
      .catch(async () => {
setError("The task could not be updated.");
      })
      .finally(async () => {
void load();
});
	}

	function toggle(task: TodoItem) {
		const status = task.status === "done" ? "open" : "done";
    setTasks(
      (current) =>
			current?.map((item) =>
				item.id === task.id ? { ...item, status } : item,
			) ?? current,
		);
		void patchTask(task.id, { status });
	}

	function drop(task: TodoItem) {
		setTasks(
			(current) => current?.filter((item) => item.id !== task.id) ?? current,
		);
		void patchTask(task.id, { status: "dropped" });
	}

	async function addTask() {
		const text = draft.trim();
		if (!text || adding) return;
		setAdding(true);
		await (async () => {
const response = await fetch(`${BASE_PATH}/api/todos`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, user }),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			setDraft("");
			setError(null);
    })()
      .catch(async () => {
setError("The task could not be added.");
      })
      .finally(async () => {
setAdding(false);
			void load();
});
	}

	const open = (tasks || []).filter((task) => task.status === "open");
	const done = (tasks || []).filter((task) => task.status === "done");

	return (
    <div
      data-page-scroll
      {...mergeStylexProps("", sx.smPx7, sx.smPy7, sx.hFull, sx.overflowYAuto, sx.px4, sx.py5)}
    >
			<div {...stylex.props(sx.mxAuto, sx.maxW760px)}>
				<PageHeader>
					<div>
						<PageTitle>Tasks</PageTitle>
						<PageDescription>
							{open.length} open task{open.length === 1 ? "" : "s"}
						</PageDescription>
					</div>
				</PageHeader>

				<form
					{...stylex.props(sx.mb5, sx.flex, sx.gap2)}
					onSubmit={(event) => {
						event.preventDefault();
						void addTask();
					}}
				>
					<Input
						size="lg"
						className={mergeStylexOverrideClassName("", sx.minW0, sx.flex1)}
						value={draft}
						placeholder="Add a task"
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button
						type="submit"
						size="lg"
						variant="primary"
						icon={<IconPlus size={20} />}
						disabled={!draft.trim() || adding}
					>
						{adding ? "Adding…" : "Add task"}
					</Button>
				</form>

        {error && (
          <div {...stylex.props(sx.mb3, sx.textRed, typography.body)}>
            {error}
          </div>
        )}

				{tasks === null ? (
					<Card>
            <div
              {...stylex.props(
                sx.px4,
                sx.py8,
                sx.textCenter,
                sx.textDim,
                typography.body,
              )}
            >
							Loading…
						</div>
					</Card>
				) : open.length ? (
					<CardList as="ul">
						{open.map((task) => (
							<TaskRow
								key={task.id}
								task={task}
								onToggle={toggle}
								onDrop={drop}
								onOpenSession={onOpenSession}
							/>
						))}
					</CardList>
				) : (
					<div
						// Empty reads as a soft, borderless well rather than a card with
						// nothing in it: rounder, one step lighter, no outline.
            {...stylex.props(
              sx.overflowHidden,
              sx.roundedXl,
              sx.bgRaised,
              sx.px4,
            )}
					>
						<EmptyState
							icon={<IconListCircles size={22} />}
							title="Nothing on your list"
						>
							Add a task when something needs your attention.
						</EmptyState>
					</div>
				)}

				{done.length > 0 && (
					<div {...stylex.props(sx.mt5)}>
						<button
							type="button"
              {...mergeStylexProps("", sx.hoverTextFg, sx.mb2, sx.flex, sx.minH10, sx.itemsCenter, sx.gap2, sx.fontMedium, sx.textDim, typography.controlLabel)}
							onClick={() => setShowDone((current) => !current)}
							aria-expanded={showDone}
						>
							<span>{showDone ? "Hide" : "Show"} completed</span>
							<span {...stylex.props(sx.textFaint)}>{done.length}</span>
						</button>
						{showDone && (
							<CardList as="ul">
								{done.map((task) => (
									<TaskRow
										key={task.id}
										task={task}
										onToggle={toggle}
										onDrop={drop}
										onOpenSession={onOpenSession}
									/>
								))}
							</CardList>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
