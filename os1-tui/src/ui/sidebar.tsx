/**
 * Workspace-grouped session list — the pane that answers "what needs me?".
 *
 * Status glyphs carry the herdr read (blocked / working / done / idle) and the
 * groups that need a human float to the top (see groupSessions).
 */

import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import type { WorkspaceGroup } from "../client/sessions-poller";
import { type Session, sessionStatus, sessionTitle } from "../client/types";
import { relativeTime } from "./format";
import { SPINNER, statusStyle, theme } from "./theme";

export type SidebarProps = {
	groups: WorkspaceGroup[];
	/** Cursor position in the flattened session list. */
	cursor: number;
	/** Session ids with an open tab, for the tab marker. */
	openTabs: string[];
	activeSessionId?: string;
	focused: boolean;
	width: number;
	spinnerFrame: number;
	loaded: boolean;
	error?: string;
};

function statusGlyph(session: Session, spinnerFrame: number): { glyph: string; color: string } {
	const status = sessionStatus(session);
	const style = statusStyle[status];
	return {
		glyph: status === "running" ? SPINNER[spinnerFrame % SPINNER.length]! : style.glyph,
		color: style.color,
	};
}

export function Sidebar({
	groups,
	cursor,
	openTabs,
	activeSessionId,
	focused,
	width,
	spinnerFrame,
	loaded,
	error,
}: SidebarProps) {
	// One flat index across groups so ↑/↓ walks the list the way it looks.
	let flatIndex = -1;
	const rows: ReactNode[] = [];

	for (const group of groups) {
		const attention = group.waiting
			? { text: `${group.waiting}`, color: theme.yellow }
			: group.running
				? { text: `${group.running}`, color: theme.blue }
				: { text: "", color: theme.faint };
		rows.push(
			<box key={`g:${group.id}`} flexDirection="row" paddingLeft={1} paddingRight={1}>
				<text fg={theme.dim} attributes={TextAttributes.BOLD} flexGrow={1}>
					{group.name.slice(0, Math.max(4, width - 6))}
				</text>
				{attention.text ? <text fg={attention.color}>{attention.text}</text> : null}
			</box>,
		);

		for (const session of group.sessions) {
			flatIndex += 1;
			const selected = focused && flatIndex === cursor;
			const active = session.id === activeSessionId;
			const tabIndex = openTabs.indexOf(session.id);
			const { glyph, color } = statusGlyph(session, spinnerFrame);
			const age = relativeTime(session.lastActivity);
			// 2 padding + glyph + space + " " + age, plus the tab number when shown.
			const titleRoom = Math.max(6, width - 7 - age.length - (tabIndex >= 0 ? 2 : 0));
			const title = sessionTitle(session);
			rows.push(
				<box
					key={session.id}
					flexDirection="row"
					paddingLeft={1}
					paddingRight={1}
					backgroundColor={selected ? theme.active : active ? theme.raised : undefined}
				>
					<text fg={color}>{glyph} </text>
					<text
						fg={active || selected ? theme.fg : theme.dim}
						flexGrow={1}
						truncate
					>
						{title.length > titleRoom ? `${title.slice(0, titleRoom - 1)}…` : title}
					</text>
					{tabIndex >= 0 ? <text fg={theme.purple}>{tabIndex + 1} </text> : null}
					{session.queuedCount ? <text fg={theme.yellow}>+{session.queuedCount} </text> : null}
					<text fg={theme.faint}> {age}</text>
				</box>,
			);
		}
	}

	if (!loaded) {
		rows.push(
			<text key="loading" fg={theme.faint} paddingLeft={1}>
				connecting…
			</text>,
		);
	} else if (!groups.length) {
		rows.push(
			<text key="empty" fg={theme.faint} paddingLeft={1}>
				{error ? "" : "no sessions yet — ^b c to start one"}
			</text>,
		);
	}
	if (error) {
		rows.push(
			<text key="error" fg={theme.red} paddingLeft={1} wrapMode="word">
				{error}
			</text>,
		);
	}

	return (
		<box
			width={width}
			flexDirection="column"
			border={["right"]}
			borderColor={focused ? theme.borderStrong : theme.border}
			flexShrink={0}
		>
			<scrollbox
				flexGrow={1}
				verticalScrollbarOptions={{ visible: false }}
				contentOptions={{ flexDirection: "column" }}
			>
				{rows}
			</scrollbox>
		</box>
	);
}
