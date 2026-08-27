import type { ActiveWorkspaceSubagent } from "../../lib/sidebar-workspaces";
import {
	SIDEBAR_HOVER_LAYER,
	SIDEBAR_RAIL,
	SIDEBAR_RAIL_GAP,
	SIDEBAR_RAIL_PAD,
	SIDEBAR_STATUS_DOT,
} from "../../lib/sidebar-classes";
import type { UnifiedSession } from "../../lib/types";
import { cn, mergeStylexClassName } from "../../ui/cn";
import { IconArrowDownRight } from "../icons";
import { SIDEBAR_ROW_TITLE } from "./SidebarItem";
import type { CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";

const sx = stylex.create({	relative: {
		"position": "relative"
	},
	mt05: {
		"marginTop": "2px"
	},
	flex: {
		"display": "flex"
	},
	wFull: {
		"width": "100%"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	roundedRow: {
		"borderRadius": "calc(12px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border0: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "0"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	pyVarSidebarRowPad: {
		"paddingBlock": "var(--sidebar-row-pad)"
	},
	pr2: {
		"paddingRight": "8px"
	},
	textLeft: {
		"textAlign": "left"
	},
	textFg: {
		"color": "var(--text)"
	},
	phonePy13px: {
		"@media (max-width: 720px)": {
			"paddingBlock": "13px"
		}
	},
	bgSelected: {
		"backgroundColor": "var(--selected)"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
	size15: {
		"width": "6px",
		"height": "6px"
	},
	shrink0: {
		"flexShrink": "0"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	,
		cornerShape: "round"},
	bgYellow: {
		"backgroundColor": "var(--yellow)"
	},
});

function stateLabel(session: UnifiedSession): string {
	if (session.waitingForInput) return "Waiting for input";
	if (session.isRunning) return "Running";
	return "Queued";
}

/** Active workers nested directly under their selected workspace row. */
export function ActiveSubagentRows({
	items,
	selectedId,
	onSelect,
}: {
	items: ActiveWorkspaceSubagent[];
	selectedId: string | null;
	onSelect: (session: UnifiedSession) => void;
}) {
	if (items.length === 0) return null;
	return (
		<div data-active-subagents="">
			{items.map(({ session, depth }) => {
				const selected = session.id === selectedId;
				const label = stateLabel(session);
				return (
					<button
						type="button"
						key={session.id}
						className={cn(
							mergeStylexClassName("group", sx.relative, sx.mt05, sx.flex, sx.wFull, sx.itemsCenter, sx.roundedRow, sx.border0, sx.bgTransparent, sx.pyVarSidebarRowPad, sx.pr2, sx.textLeft, sx.textFg, sx.phonePy13px),
							SIDEBAR_RAIL_GAP,
							SIDEBAR_RAIL_PAD,
							SIDEBAR_HOVER_LAYER,
							selected && mergeStylexClassName("", sx.bgSelected),
						)}
						// The rail a child indents to, and it is derived rather than
						// picked: the workspace row above opens with the 22px rail at
						// --sidebar-icon-left (16), then the 7px rail gap, then its
						// 14px repo tile, so that tile's centre sits at 52 and a 22px
						// rail centres there from 41. At the 28 this was, the arrow
						// landed in the gap in front of the tile and the child's title
						// came out to the LEFT of its parent's, which read as a sibling
						// rather than a child. Deeper levels step 12 and stop at the
						// third, so a long chain keeps room for a title.
						style={
							{
								"--sidebar-icon-left": `${41 + Math.min(depth - 1, 2) * 12}px`,
							} as CSSProperties
						}
						data-active-subagent-row=""
						data-parent-session-id={session.parentSessionId}
						data-selected={selected || undefined}
						aria-current={selected ? "page" : undefined}
						aria-label={`${session.title}, subagent, ${label}`}
						onClick={() => onSelect(session)}
					>
						<span className={cn(SIDEBAR_RAIL, mergeStylexClassName("", sx.textFaint))} aria-hidden="true">
							<IconArrowDownRight size={16} />
						</span>
						<span className={SIDEBAR_ROW_TITLE}>{session.title}</span>
						<span
							className={cn(
								mergeStylexClassName("", sx.size15, sx.shrink0, sx.roundedFull),
								session.waitingForInput
									? SIDEBAR_STATUS_DOT.waiting
									: session.isRunning
										? SIDEBAR_STATUS_DOT.running
										: mergeStylexClassName("", sx.bgYellow),
							)}
							aria-hidden="true"
							title={label}
						/>
					</button>
				);
			})}
		</div>
	);
}
