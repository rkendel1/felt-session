/**
 * The bottom line: where you're connected, the tab strip, global counts, and
 * whatever the last action said. Also the only place the armed prefix is
 * visible, which matters — a silently armed prefix eats the next keystroke.
 */

import { TextAttributes } from "@opentui/core";
import { sessionTitle, type Session } from "../client/types";
import { SPINNER, theme } from "./theme";

export type StatusBarProps = {
	host: string;
	user: string;
	tabs: Session[];
	activeIndex: number;
	waiting: number;
	running: number;
	prefixArmed: boolean;
	mode: string;
	message?: string;
	messageKind?: "info" | "error";
	spinnerFrame: number;
	width: number;
};

export function StatusBar({
	host,
	user,
	tabs,
	activeIndex,
	waiting,
	running,
	prefixArmed,
	mode,
	message,
	messageKind = "info",
	spinnerFrame,
	width,
}: StatusBarProps) {
	const hostLabel = host.replace(/^https?:\/\//, "");

	return (
		<box flexDirection="column" flexShrink={0}>
			{/* Tab strip — only when more than one tab is open, so a single-session
			    session doesn't pay a line for it. */}
			{tabs.length > 1 ? (
				<box flexDirection="row" backgroundColor={theme.panel} paddingLeft={1}>
					{tabs.map((session, index) => (
						<text
							key={session.id}
							fg={index === activeIndex ? theme.fg : theme.faint}
							attributes={index === activeIndex ? TextAttributes.BOLD : undefined}
							bg={index === activeIndex ? theme.active : undefined}
						>
							{` ${index + 1}:${sessionTitle(session).slice(0, 18)}${
								session.isRunning ? ` ${SPINNER[spinnerFrame % SPINNER.length]}` : ""
							}${session.waitingForInput ? " ?" : ""} `}
						</text>
					))}
				</box>
			) : null}

			<box flexDirection="row" backgroundColor={theme.panel} paddingLeft={1} paddingRight={1}>
				<text fg={theme.accent} attributes={TextAttributes.BOLD}>
					os{" "}
				</text>
				<text fg={theme.dim}>{hostLabel} </text>
				<text fg={theme.faint}>{user} </text>
				<box flexGrow={1} flexDirection="row">
					{message ? (
						<text fg={messageKind === "error" ? theme.red : theme.dim} truncate>
							{message}
						</text>
					) : null}
				</box>
				{running ? (
					<text fg={theme.blue}>
						{SPINNER[spinnerFrame % SPINNER.length]}
						{running}{" "}
					</text>
				) : null}
				{waiting ? <text fg={theme.yellow}>?{waiting} </text> : null}
				{prefixArmed ? (
					<text fg={theme.accent} attributes={TextAttributes.BOLD}>
						^b{" "}
					</text>
				) : null}
				{mode !== "nav" && mode !== "composer" ? (
					<text fg={theme.purple}>{mode.toUpperCase()} </text>
				) : null}
				{width > 60 ? <text fg={theme.faint}>^b ?</text> : null}
			</box>
		</box>
	);
}
